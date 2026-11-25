# -*- coding: utf-8 -*-
"""Keil UV4 编译与 stcgal ISP 烧写执行层（Web 后端与 CLI 共用）。"""
import os
import re
import shutil
import subprocess
import sys
import threading
import time

from . import core

DEFAULT_PROTOCOL = "stc89"
HANDSHAKE_BAUD = "2400"
TRANSFER_BAUD = "9600"
BUILD_TIMEOUT = 180

BUSY_PCT_RE = re.compile(r"(\d+)%")


def module_ok(name):
    try:
        __import__(name)
        return True
    except ImportError:
        return False


def find_uv4():
    for cand in (
        os.environ.get("KEIL_UV4"),
        os.environ.get("KEIL_ROOT") and os.path.join(os.environ["KEIL_ROOT"], "UV4", "UV4.exe"),
        shutil.which("UV4.exe"),
        shutil.which("UV4"),
        r"C:\Keil_v5\UV4\UV4.exe",
        r"C:\Keil\UV4\UV4.exe",
    ):
        if cand and os.path.isfile(cand):
            return cand
    return None


def scan_ports():
    try:
        from serial.tools import list_ports
    except ImportError:
        return []
    return [{"device": p.device, "desc": p.description} for p in list_ports.comports()]


def detect_default_port(fallback="COM7"):
    """优先挑选 CH340 / USB-SERIAL 串口；查不到时回退默认值。"""
    ports = scan_ports()
    for p in ports:
        desc = (p.get("desc") or "").lower()
        if "ch340" in desc or "usb-serial" in desc or "cp210" in desc or "ftdi" in desc:
            return p["device"]
    return ports[0]["device"] if ports else fallback


def port_exists(port):
    try:
        from serial.tools import list_ports
    except ImportError:
        return True
    return any(p.device.upper() == port.upper() for p in list_ports.comports())


def _emit(on_event, topic, **payload):
    if on_event:
        on_event(topic, **payload)


def build_project(project, rebuild=False, target=None, log_dir=None, on_event=None):
    """调用 UV4.exe 编译 Keil 工程并返回结构化结果。"""
    uv4 = find_uv4()
    if not uv4:
        _emit(on_event, "log", level="error", text="没找到 UV4.exe，设 KEIL_UV4 或 KEIL_ROOT")
        return {"ok": False, "error": "uv4_not_found"}

    project = os.path.abspath(project)
    log_dir = log_dir or os.path.join(os.path.dirname(project), ".build_logs")
    os.makedirs(log_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(project))[0]
    stamp = time.strftime("%H-%M-%S", time.localtime()) + "-%03d" % (int(time.time() * 1000) % 1000)
    log_file = os.path.join(log_dir, "%s-%s.log" % (stem, stamp))

    cmd = [uv4, "-r" if rebuild else "-b", project, "-j0", "-o", log_file]
    if target:
        cmd += ["-t", target]

    _emit(
        on_event,
        "log",
        level="info",
        text="开始编译：%s（%s）" % (os.path.basename(project), "全量重建" if rebuild else "增量"),
    )
    try:
        rc = subprocess.call(cmd, timeout=BUILD_TIMEOUT)
    except subprocess.TimeoutExpired:
        _emit(on_event, "log", level="error", text="编译超过 %ds：µVision 可能弹了对话框卡住命令行" % BUILD_TIMEOUT)
        return {
            "ok": False,
            "error": "timeout",
            "diagnostics": [],
            "totals": None,
            "program_size": None,
            "project": project,
        }

    text = core.decode_log(open(log_file, "rb").read()) if os.path.isfile(log_file) else ""
    parsed = core.parse_build_log(text)
    parsed["project"] = project
    parsed["uv4_rc"] = rc
    parsed["log_file"] = log_file

    for d in parsed["diagnostics"]:
        where = "%s:%s" % (d["file"], d["line"]) if d["line"] else (d["file"] or d["code"])
        _emit(
            on_event,
            "build_diag",
            severity=d["severity"],
            code=d["code"],
            where=where,
            message=d["message"],
            detail=d["detail"],
            project=project,
        )

    info = core.project_info(project)
    parsed["project_info"] = info
    if parsed["ok"] and not info["hex_exists"]:
        parsed["hex_missing"] = True
        _emit(on_event, "log", level="error", text="编译过了但没生成 hex：去 Keil 的 Output 页勾 Create HEX File")

    ps = parsed["program_size"]
    if ps:
        _emit(
            on_event,
            "log",
            level="info",
            text="Program Size: data=%d.%d xdata=%d code=%d"
                 % (ps["data"], ps["data_bits"], ps["xdata"], ps["code"]),
        )
    totals = parsed["totals"]
    _emit(
        on_event,
        "log",
        level="error" if totals["errors"] else "info",
        text="结果：%d Error(s), %d Warning(s)" % (totals["errors"], totals["warnings"]),
    )
    for d in parsed["danger_warnings"]:
        _emit(
            on_event,
            "log",
            level="danger",
            text="%s %s —— 链接器有没解决的外部符号，0 Error 也会跑飞：%s"
                 % (d["code"], d["message"], d["detail"]),
        )
    return parsed


def flash_hex(hex_file, port, protocol=DEFAULT_PROTOCOL, wait=90, erase=False, extra=None, on_event=None):
    """循环重试 stcgal 握手烧写（STC89 仅认冷启动断电重上电）。"""
    if not erase and not os.path.isfile(hex_file):
        _emit(on_event, "log", level="error", text="hex 不存在：%s" % hex_file)
        return {"ok": False, "error": "hex_missing"}

    cmd = [
        sys.executable,
        "-m",
        "stcgal",
        "-p",
        port,
        "-P",
        protocol,
        "-l",
        HANDSHAKE_BAUD,
        "-b",
        TRANSFER_BAUD,
    ]
    if erase:
        cmd.append("-e")
    if extra:
        cmd += list(extra)
    if not erase:
        cmd.append(hex_file)

    deadline = time.time() + wait
    attempts = 0
    last_err = ""
    last_cause = None
    last_hint = ""

    _emit(
        on_event,
        "flash_phase",
        phase="waiting_power",
        attempt=0,
        pct=0,
        text="接下来请把板子断电 3 秒再上电，脚本会自动接住冷启动窗口",
    )

    while time.time() < deadline:
        attempts += 1
        _emit(
            on_event,
            "flash_phase",
            phase="handshaking",
            attempt=attempts,
            pct=0,
            text="第 %d 次等待冷启动握手…" % attempts,
        )
        rc, text = _spawn_stcgal(cmd, max(5, deadline - time.time()), on_event)
        last_err = text
        if rc == 0:
            _emit(
                on_event,
                "flash_phase",
                phase="done",
                attempt=attempts,
                pct=100,
                text="烧写成功，芯片自动启动新程序（无需二次冷启动）",
            )
            return {"ok": True, "attempts": attempts, "log": text, "port": port, "hex": hex_file}
        last_cause, last_hint = core.classify_flash_failure(rc, text)
        _emit(on_event, "flash_fail_reason", cause=last_cause, hint=last_hint, attempt=attempts)
        time.sleep(0.5)

    _emit(
        on_event,
        "flash_phase",
        phase="failed",
        attempt=attempts,
        pct=0,
        text="%d 秒内没抓到冷启动窗口（共 %d 次）" % (wait, attempts),
    )
    return {
        "ok": False,
        "error": last_cause or "no_handshake",
        "hint": last_hint,
        "attempts": attempts,
        "log": last_err,
        "port": port,
        "hex": hex_file,
    }


def _spawn_stcgal(cmd, seconds, on_event):
    """块读 stcgal 输出：进度条使用 \\r，readline 会憋到行尾才吐出。"""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
    timer = threading.Timer(seconds, _kill_proc, args=[proc, on_event])
    timer.daemon = True
    timer.start()
    collected = []
    tail = b""
    try:
        while True:
            chunk = proc.stdout.read(256)
            if not chunk:
                break
            tail += chunk
            parts = re.split(rb"[\r\n]+", tail)
            tail = parts.pop()
            for piece in parts:
                _emit_stcgal_line(piece, collected, on_event)
        _emit_stcgal_line(tail, collected, on_event)
        rc = proc.wait()
    finally:
        timer.cancel()
        try:
            proc.stdout.close()
        except Exception:
            pass
    return rc, "\n".join(collected)


def _emit_stcgal_line(piece, collected, on_event):
    text = core.decode_log(piece).strip()
    if not text:
        return
    collected.append(text)
    phase = None
    low = text.lower()
    if "loading flash" in low:
        phase = "loading"
    elif "erasing" in low:
        phase = "erasing"
    elif "writing flash" in low:
        phase = "writing"
    elif "setting options" in low:
        phase = "options"
    elif "target model" in low or "name:" in low:
        phase = "identified"
    elif "disconnect" in low:
        phase = "done"
    m = BUSY_PCT_RE.search(text)
    pct = int(m.group(1)) if m and phase == "writing" else None
    _emit(on_event, "flash_line", text=text, phase=phase, pct=pct)


def _kill_proc(proc, on_event):
    if proc.poll() is None:
        proc.kill()
        _emit(on_event, "log", level="warn", text="stcgal 这一轮超时被终止，继续下一轮")
