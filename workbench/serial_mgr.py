# -*- coding: utf-8 -*-
"""串口独占管理器：读取行日志、解析 `v: ...` 曲线点并通过事件总线推送。"""
import threading
from collections import deque

from . import core


class SerialHolder:
    """串口唯一主人。烧写前必须 close()，否则 stcgal 会报 could not open port。"""

    def __init__(self, bus):
        self.bus = bus
        self.lock = threading.Lock()
        self.ser = None
        self.port = None
        self.baud = None
        self.thread = None
        self._stop = None
        self._gen = 0
        self._buf = b""
        self.tail = deque(maxlen=80)

    @property
    def is_open(self):
        return self.ser is not None

    def open(self, port, baud=9600):
        import serial  # 只有真要用串口时才依赖 pyserial

        with self.lock:
            if self.ser:
                self._close_locked()
            self._gen += 1
            gen = self._gen
            self.ser = serial.Serial(port, int(baud), timeout=0.05)
            self.port, self.baud = port, int(baud)
            self._stop = threading.Event()
            self.thread = threading.Thread(target=self._reader, args=(gen,), daemon=True)
            self.thread.start()
        self.bus.publish("serial_state", open=True, port=port, baud=int(baud))
        return {"port": port, "baud": int(baud)}

    def close(self):
        with self.lock:
            if not self.ser:
                return False
            self._gen += 1  # 让旧 reader 知道自己已被取代，避免误关新句柄
            self._close_locked()
        self.bus.publish("serial_state", open=False, port=None, baud=None)
        return True

    def _close_locked(self):
        if self._stop:
            self._stop.set()
        try:
            self.ser.close()
        except Exception:
            pass
        self.ser = None
        self.port = None
        self.baud = None

    def write(self, text, newline=True):
        with self.lock:
            if not self.ser:
                raise RuntimeError("串口没打开，请先打开串口会话")
            payload = text + ("\r\n" if newline else "")
            self.ser.write(payload.encode("utf-8", "replace"))
        self.bus.publish("serial", data=payload.replace("\r\n", "\n"), direction="out")

    def _reader(self, gen):
        while not self._stop.is_set():
            try:
                n = self.ser.in_waiting
            except Exception as exc:
                self.bus.publish("log", level="error", text="串口读不到：%s（可能被拔掉了）" % exc)
                break
            if not n:
                self._stop.wait(0.01)
                continue
            try:
                chunk = self.ser.read(n)
            except Exception as exc:
                self.bus.publish("log", level="error", text="串口读失败：%s" % exc)
                break
            self._feed(chunk)
        with self.lock:
            mine = self.ser is not None and self._gen == gen
            if mine:
                self._close_locked()
        if mine:
            self.bus.publish("serial_state", open=False, port=None, baud=None)

    def _feed(self, chunk):
        self._buf += chunk
        while True:
            idx = self._buf.find(b"\n")
            if idx < 0:
                if len(self._buf) > 512:
                    self.bus.publish("serial", data=core.decode_log(self._buf[:512]) + "\n")
                    self._buf = self._buf[512:]
                return
            line, self._buf = self._buf[:idx], self._buf[idx + 1:]
            text = core.decode_log(line).replace("\r", "").strip()
            self.tail.append(text)
            self.bus.publish("serial", data=text + "\n")
            point = core.parse_curve_line(text)
            if point:
                self.bus.publish("curve", values=point["values"])
