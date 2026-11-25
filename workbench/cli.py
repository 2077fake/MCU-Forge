# -*- coding: utf-8 -*-
"""Keil 编译 + stcgal ISP 烧写命令行工具（网页未开时的 CLI 入口）。

用法：
    py -m workbench.cli                                     # 编译并烧写默认模板工程
    py -m workbench.cli experiments/01-折返跑马灯/template51.uvproj
    py -m workbench.cli --build-only                        # 只编译
    py -m workbench.cli --flash-only                        # 只烧录已有 hex
    py -m workbench.cli --erase                             # 只擦除 flash
    py -m workbench.cli --port COM10 --wait 90
"""
import argparse
import os
import sys

from . import core, toolchain

ROOT = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
DEFAULT_PROJECT = os.path.join(ROOT, "templates", "mcu51", "template51.uvproj")


def _say(text):
    try:
        print(text)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        print(text.encode(enc, "replace").decode(enc, "replace"))


def _cli_event(topic, **payload):
    if topic == "log":
        prefix = "!! " if payload.get("level") in ("error", "danger") else "   "
        _say(prefix + payload.get("text", ""))
    elif topic == "build_diag":
        _say("   [%s] %s %s %s" % (
            payload.get("severity", ""),
            payload.get("where", ""),
            payload.get("code", ""),
            payload.get("message", ""),
        ))
    elif topic == "flash_phase":
        _say(">> %s" % payload.get("text", ""))
    elif topic == "flash_fail_reason":
        _say("   第 %s 次未握手：%s" % (payload.get("attempt", "?"), payload.get("hint", "")))


def main():
    ap = argparse.ArgumentParser(description="51 单片机 Keil 编译 + stcgal 烧写 CLI")
    ap.add_argument("project", nargs="?", default=DEFAULT_PROJECT, help=".uvproj/.uvprojx 路径")
    ap.add_argument("--hex", help="直接指定 hex 文件，跳过编译")
    ap.add_argument("--target", help="µVision Target 名，默认用工程第一个")
    ap.add_argument("--port", help="串口号（默认自动探测 CH340/USB-SERIAL）")
    ap.add_argument("--protocol", default=toolchain.DEFAULT_PROTOCOL, help="stcgal 协议：stc89/stc12/stc15/stc8")
    ap.add_argument("--rebuild", action="store_true", help="全量重建（-r）")
    ap.add_argument("--build-only", action="store_true")
    ap.add_argument("--flash-only", action="store_true")
    ap.add_argument("--erase", action="store_true", help="只擦除 flash")
    ap.add_argument("--wait", type=int, default=60, help="等待冷启动的秒数")
    args = ap.parse_args()

    project = os.path.abspath(args.project)
    if not args.hex and not args.flash_only and not args.erase and not os.path.isfile(project):
        _say("!! 找不到工程文件：%s" % project)
        return 3

    hex_file = os.path.abspath(args.hex) if args.hex else (core.hex_path_of(project) if os.path.isfile(project) else "")

    if not args.flash_only and not args.erase:
        res = toolchain.build_project(project, rebuild=args.rebuild, target=args.target, on_event=_cli_event)
        if not res.get("ok"):
            return 1
        if not os.path.isfile(hex_file):
            _say("!! 编译成功但未生成 %s（请检查 Keil Output 页 'Create HEX File'）" % hex_file)
            return 1
        _say("   hex: %s (%d bytes)" % (hex_file, os.path.getsize(hex_file)))

    if args.build_only:
        return 0

    if not args.erase and not os.path.isfile(hex_file):
        _say("!! 找不到 hex：%s" % hex_file)
        return 3

    port = args.port or toolchain.detect_default_port()
    if not toolchain.port_exists(port):
        _say("!! 串口 %s 不存在，请检查 USB 和 CH340 驱动（可用 --port 指定）" % port)
        return 3

    res = toolchain.flash_hex(
        hex_file, port, protocol=args.protocol, wait=args.wait, erase=args.erase, on_event=_cli_event
    )
    return 0 if res.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
