# -*- coding: utf-8 -*-
"""51 单片机在线工作台后端（零第三方依赖，仅用 Python 标准库 + pyserial/stcgal）。

启动： python -m workbench.server   然后浏览器打开 http://127.0.0.1:8765
只绑 127.0.0.1：本机自用工具，无鉴权，请勿暴露到公网。
"""
import argparse
import json
import os
import queue
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from . import core, serial_mgr, toolchain

HOST = "127.0.0.1"
PORT = 8765
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.dirname(HERE))
STATIC_DIR = os.path.join(HERE, "static")
MAX_BODY = 1 << 20

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def now():
    return time.strftime("%H:%M:%S", time.localtime()) + ".%03d" % (int(time.time() * 1000) % 1000)


class Bus:
    """一条 SSE 通道多路复用所有推送；慢客户端丢事件，绝不阻塞生产者。"""

    def __init__(self):
        self._subs = []
        self._lock = threading.Lock()

    def subscribe(self):
        q = queue.Queue(maxsize=800)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def publish(self, topic, **payload):
        event = dict(payload, topic=topic, ts=now())
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass
        return event


class Job:
    def __init__(self, kind, label):
        self.id = "%s-%d" % (kind, int(time.time() * 1000))
        self.kind = kind
        self.label = label
        self.status = "running"
        self.started = time.time()
        self.finished = None
        self.result = None

    def snapshot(self):
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "status": self.status,
            "started": self.started,
            "finished": self.finished,
            "result": self.result,
            "elapsed": round((self.finished or time.time()) - self.started, 2),
        }


class Runner:
    """全局单作业槽：µVision 同工程并发编译会互踩，烧写更需独占串口。"""

    def __init__(self, bus):
        self.bus = bus
        self.job = None
        self.last = None
        self.lock = threading.Lock()

    def start(self, kind, label, fn):
        with self.lock:
            if self.job is not None and self.job.status == "running":
                return None
            job = Job(kind, label)
            self.job = job
        t = threading.Thread(target=self._wrap, args=(job, fn), daemon=True)
        t.start()
        return job

    def _wrap(self, job, fn):
        self.bus.publish("job", job=job.snapshot(), event="start")
        try:
            result = fn(job)
            job.result = result
            job.status = "ok" if (result is None or result.get("ok", True)) else "failed"
        except Exception as exc:
            job.status = "failed"
            job.result = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
            self.bus.publish("log", level="error", text="后端异常：%s" % exc)
        job.finished = time.time()
        self.bus.publish("job", job=job.snapshot(), event="end")
        with self.lock:
            self.last = job
            self.job = None

    def busy(self):
        with self.lock:
            return self.job if self.job and self.job.status == "running" else None

    def latest(self):
        with self.lock:
            job = self.job if (self.job and self.job.status == "running") else self.last
        return job.snapshot() if job else None


class State:
    def __init__(self, root):
        self.root = root
        self.bus = Bus()
        self.serial = serial_mgr.SerialHolder(self.bus)
        self.runner = Runner(self.bus)
        self.last_build = None
        self.last_flash = None


STATE = State(ROOT)


def _run_build_job(state, project, rebuild):
    result = toolchain.build_project(project, rebuild=rebuild, on_event=state.bus.publish)
    state.last_build = result
    return result


def _run_flash_job(state, hex_file, port, protocol, wait):
    state.last_flash = None
    if state.serial.close():
        state.bus.publish("log", level="warn", text="烧写前已释放串口（监视会话暂停）")
    result = toolchain.flash_hex(
        hex_file, port, protocol=protocol, wait=wait, on_event=state.bus.publish
    )
    state.last_flash = result
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "MCU-Forge/2.0"
    protocol_version = "HTTP/1.1"
    # Edge 睡眠标签页会停读 SSE，30s 写不出即释放死连接，避免线程挂死
    timeout = 30

    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("请求体太大")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            return {}

    def resolve_in_root(self, path):
        p = unquote(path or "")
        candidate = p if os.path.isabs(p) else os.path.join(STATE.root, p)
        real = os.path.realpath(os.path.abspath(candidate))
        root = os.path.realpath(STATE.root)
        if os.path.normcase(real) != os.path.normcase(root) and not os.path.normcase(real).startswith(
            os.path.normcase(root) + os.sep
        ):
            raise PermissionError("越界路径已被拒绝：%s" % p)
        return real

    def query(self, qs):
        return {k: v[0] for k, v in parse_qs(qs).items()}

    # ---- GET
    def do_GET(self):
        parsed = urlparse(self.path)
        route, qs = parsed.path, self.query(parsed.query)
        try:
            if route in ("/", "/index.html"):
                return self.serve_static(os.path.join(STATIC_DIR, "index.html"))
            if route.startswith("/static/"):
                return self.serve_static(os.path.join(STATIC_DIR, route[len("/static/"):]))
            if route == "/favicon.ico":
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if route == "/api/events":
                return self.sse()
            if route == "/api/state":
                return self.api_state()
            if route == "/api/projects":
                return self.api_projects()
            if route == "/api/ports":
                return self.send_json({"ports": toolchain.scan_ports()})
            if route == "/api/hex":
                path = self.resolve_in_root(qs.get("project", ""))
                info = core.project_info(path)
                if not info["hex_exists"]:
                    return self.send_json({"ok": False, "problems": ["hex 还没生成，先编译"], "info": info})
                with open(info["hex"], "r", encoding="ascii", errors="replace") as fh:
                    return self.send_json(dict(core.parse_hex(fh.read()), info=info))
            if route == "/api/files":
                return self.api_files(qs)
            if route == "/api/job":
                return self.send_json({"job": STATE.runner.latest()})
        except PermissionError as exc:
            return self.send_json({"ok": False, "error": str(exc)}, 403)
        except Exception as exc:
            return self.send_json({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}, 500)
        return self.send_json({"ok": False, "error": "no such route: %s" % route}, 404)

    # ---- POST
    def do_POST(self):
        route = urlparse(self.path).path
        try:
            body = self.read_body()
            if route == "/api/build":
                return self.api_build(body)
            if route == "/api/flash":
                return self.api_flash(body)
            if route == "/api/serial/open":
                info = STATE.serial.open(body["port"], body.get("baud", 9600))
                return self.send_json({"ok": True, **info})
            if route == "/api/serial/close":
                return self.send_json({"ok": STATE.serial.close()})
            if route == "/api/serial/write":
                STATE.serial.write(body.get("text", ""), body.get("newline", True))
                return self.send_json({"ok": True})
            if route == "/api/stop":
                return self.send_json({"ok": False, "error": "编译没法中途取消；烧写会在超时窗口结束后自动停止"})
        except PermissionError as exc:
            return self.send_json({"ok": False, "error": str(exc)}, 403)
        except (KeyError, ValueError) as exc:
            return self.send_json({"ok": False, "error": "参数不对：%s" % exc}, 400)
        except RuntimeError as exc:
            return self.send_json({"ok": False, "error": str(exc)}, 409)
        except Exception as exc:
            return self.send_json({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}, 500)
        return self.send_json({"ok": False, "error": "no such route: %s" % route}, 404)

    # ---- handlers
    def serve_static(self, path):
        real = os.path.realpath(path)
        static_root = os.path.realpath(STATIC_DIR)
        if not os.path.normcase(real).startswith(os.path.normcase(static_root) + os.sep) or not os.path.isfile(real):
            return self.send_json({"ok": False, "error": "找不到文件"}, 404)
        ext = os.path.splitext(real)[1].lower()
        ctype = MIME_TYPES.get(ext, "application/octet-stream")
        with open(real, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def api_state(self):
        job = STATE.runner.busy()
        return self.send_json({
            "root": STATE.root,
            "uv4": toolchain.find_uv4(),
            "stcgal_ok": toolchain.module_ok("stcgal"),
            "serial_ok": toolchain.module_ok("serial"),
            "serial": {
                "open": STATE.serial.is_open,
                "port": STATE.serial.port,
                "baud": STATE.serial.baud,
            },
            "running": job.snapshot() if job else None,
            "handshake_baud": int(toolchain.HANDSHAKE_BAUD),
            "transfer_baud": int(toolchain.TRANSFER_BAUD),
        })

    def api_projects(self):
        projects = core.scan_projects(STATE.root)
        for p in projects:
            p["hex_mtime_text"] = (
                time.strftime("%m-%d %H:%M", time.localtime(p["hex_mtime"])) if p["hex_mtime"] else None
            )
        return self.send_json({"projects": projects, "default": _pick_default(projects)})

    def api_files(self, qs):
        target = self.resolve_in_root(qs.get("dir", ""))
        if not os.path.isdir(target):
            return self.send_json({"ok": False, "error": "不是目录"}, 404)
        entries = []
        for name in sorted(os.listdir(target), key=str.lower):
            if name.startswith(".") or name == "__pycache__":
                continue
            full = os.path.join(target, name)
            if os.path.isdir(full):
                entries.append({"name": name, "type": "dir"})
            elif name.lower().endswith(
                (".c", ".h", ".a51", ".asm", ".uvproj", ".uvprojx", ".hex", ".m51", ".lst", ".md")
            ):
                entries.append({"name": name, "type": "file", "bytes": os.path.getsize(full)})
        return self.send_json({"dir": target, "entries": entries})

    def api_build(self, body):
        project = self.resolve_in_root(body.get("project", ""))
        if not os.path.isfile(project):
            return self.send_json({"ok": False, "error": "工程不存在"}, 404)
        if STATE.runner.busy():
            return self.send_json({"ok": False, "error": "有作业在跑，等它结束"}, 409)
        rebuild = bool(body.get("rebuild"))
        job = STATE.runner.start(
            "build", os.path.basename(project), lambda _j: _run_build_job(STATE, project, rebuild)
        )
        return self.send_json({"ok": True, "job": job.snapshot()})

    def api_flash(self, body):
        if body.get("hex"):
            hex_file = self.resolve_in_root(body["hex"])
        else:
            project = self.resolve_in_root(body.get("project", ""))
            info = core.project_info(project)
            if not info["hex"]:
                return self.send_json({"ok": False, "error": "读不出 hex 路径"}, 400)
            hex_file = info["hex"]
        if STATE.runner.busy():
            return self.send_json({"ok": False, "error": "有作业在跑（多半是串口被占着）"}, 409)
        port = body.get("port") or STATE.serial.port or toolchain.detect_default_port()
        wait = int(body.get("wait", 90))
        protocol = body.get("protocol") or toolchain.DEFAULT_PROTOCOL
        job = STATE.runner.start(
            "flash",
            "%s -> %s" % (os.path.basename(hex_file), port),
            lambda _j: _run_flash_job(STATE, hex_file, port, protocol, wait),
        )
        return self.send_json({"ok": True, "job": job.snapshot()})

    # ---- SSE
    def sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = STATE.bus.subscribe()
        try:
            self._sse_send({"topic": "hello", "ts": now()})
            while True:
                try:
                    event = q.get(timeout=15)
                except queue.Empty:
                    self._sse_send({"topic": "ping"})
                    continue
                self._sse_send(event)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            STATE.bus.unsubscribe(q)

    def _sse_send(self, event):
        self.wfile.write(("data: %s\n\n" % json.dumps(event, ensure_ascii=False, default=str)).encode("utf-8"))
        self.wfile.flush()


def _pick_default(projects):
    for p in projects:
        if p.get("rel_dir") == "templates/mcu51":
            return p["project"]
    for p in projects:
        if p["name"] == "template51":
            return p["project"]
    return projects[0]["project"] if projects else None


class SingleInstanceServer(ThreadingHTTPServer):
    """Windows 下关闭 SO_REUSEADDR，防止重复启动影子实例抢占 8765。"""

    allow_reuse_address = 0
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser(description="51 单片机在线工作台")
    ap.add_argument("--root", default=ROOT, help="工作区根目录（默认仓库根）")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    STATE.root = os.path.abspath(args.root)
    url = "http://%s:%d" % (HOST, args.port)
    try:
        httpd = SingleInstanceServer((HOST, args.port), Handler)
    except OSError as exc:
        print("端口 %d 起不来：%s（多半已有一个工作台实例在运行）" % (args.port, exc))
        return 1

    print("工作台就绪：%s" % url)
    print("工作区：%s" % STATE.root)
    if not toolchain.module_ok("serial"):
        print("警告：pyserial 未安装，串口监视和烧写不可用")
    if not toolchain.module_ok("stcgal"):
        print("警告：stcgal 未安装，烧写不可用")
    if not args.no_browser:
        threading.Timer(0.6, webbrowser.open, args=[url]).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n工作台已停止。")
    finally:
        STATE.serial.close()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
