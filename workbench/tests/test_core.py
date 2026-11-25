# -*- coding: utf-8 -*-
"""workbench.core 单测（全部夹具来自本机 UV4 / stcgal 真实输出）。

运行： py -m unittest discover -s workbench/tests -v
"""
import os
import tempfile
import unittest

from workbench import core

C51_ERRORS = """Rebuild target 'Target 1'
assembling STARTUP.A51...
compiling main.c...
main.c(7): error C141: syntax error near 'undeclared_var'
main.c(7): error C202: 'undeclared_var': undefined identifier
Target not created.
Build Time Elapsed:  00:00:01
"""

A51_ERRORS = """Rebuild target 'Target 1'
assembling P2.a51...
P2.a51(5): error A45: UNDEFINED SYMBOL (PASS-2)
P2.a51(7): error A9: SYNTAX ERROR
Target not created.
Build Time Elapsed:  00:00:00
"""

LINK_DANGER = """Rebuild target 'Target 1'
assembling STARTUP.A51...
compiling main.c...
main.c(5): warning C280: 'unused_local': unreferenced local variable
linking...
*** WARNING L1: UNRESOLVED EXTERNAL SYMBOL
    SYMBOL:  NEVER_DEFINED
    MODULE:  .\\Objects\\main.obj (MAIN)

*** WARNING L2: REFERENCE MADE TO UNRESOLVED EXTERNAL
    SYMBOL:  NEVER_DEFINED
    MODULE:  .\\Objects\\main.obj (MAIN)
    ADDRESS: 002CH

Program Size: data=12.0 xdata=0 code=67
creating hex file from ".\\Objects\\blink"...
".\\Objects\\blink" - 0 Error(s), 3 Warning(s).
Build Time Elapsed:  00:00:00
"""

CLEAN_BUILD = """Build target 'Target 1'
compiling main.c...
linking...
Program Size: data=9.0 xdata=0 code=76
creating hex file from ".\\Objects\\blink"...
".\\Objects\\blink" - 0 Error(s), 0 Warning(s).
Build Time Elapsed:  00:00:02
"""

GOOD_HEX = """:03000000020040BB
:0C004000787FE4F6D8FD758107020023EC
:00000001FF
"""

NO_RESET_HEX = """:10000300E4E4E4E4E4E4E4E4E4E4E4E4E4E4E4E4AD
:00000001FF
"""

MINIMAL_UVPROJ = """<?xml version="1.0" encoding="UTF-8"?>
<Project>
  <Targets>
    <Target>
      <TargetOption>
        <TargetCommonOption>
          <Device>AT89C52</Device>
          <Cpu>IRAM(0-0xFF) CLOCK(11059200)</Cpu>
          <OutputDirectory>.\\Objects\\</OutputDirectory>
          <OutputName>blink</OutputName>
          <CreateHexFile>1</CreateHexFile>
        </TargetCommonOption>
      </TargetOption>
    </Target>
  </Targets>
</Project>
"""


class TestBuildLog(unittest.TestCase):
    def test_c51_errors_are_located(self):
        r = core.parse_build_log(C51_ERRORS)
        self.assertFalse(r["ok"])
        self.assertEqual(len(r["errors"]), 2)
        self.assertEqual(r["errors"][0]["file"], "main.c")
        self.assertEqual(r["errors"][0]["line"], 7)
        self.assertEqual(r["errors"][0]["code"], "C141")
        self.assertEqual(r["totals"]["errors"], 2)

    def test_a51_errors_are_located(self):
        r = core.parse_build_log(A51_ERRORS)
        self.assertFalse(r["ok"])
        self.assertEqual(r["errors"][0]["file"], "P2.a51")
        self.assertEqual(r["errors"][0]["line"], 5)
        self.assertEqual(r["errors"][0]["code"], "A45")

    def test_linker_warning_block_is_aggregated(self):
        r = core.parse_build_log(LINK_DANGER)
        l1 = [d for d in r["warnings"] if d["code"] == "L1"]
        self.assertEqual(len(l1), 1)
        self.assertIn("NEVER_DEFINED", l1[0]["detail"])
        self.assertEqual(l1[0]["file"], "main.c")

    def test_unresolved_external_is_flagged_as_danger(self):
        r = core.parse_build_log(LINK_DANGER)
        self.assertTrue(r["ok"])
        self.assertEqual(len(r["danger_warnings"]), 2)
        self.assertEqual(r["program_size"], {"data": 12, "data_bits": 0, "xdata": 0, "code": 67})

    def test_clean_build(self):
        r = core.parse_build_log(CLEAN_BUILD)
        self.assertTrue(r["ok"])
        self.assertEqual(r["diagnostics"], [])
        self.assertEqual(r["program_size"]["code"], 76)


class TestHex(unittest.TestCase):
    def test_good_hex(self):
        h = core.parse_hex(GOOD_HEX)
        self.assertTrue(h["ok"], h["problems"])
        self.assertTrue(h["has_reset_vector"])
        self.assertEqual(h["entry"], 0x0040)
        self.assertEqual(h["bytes"], 15)

    def test_missing_reset_vector_is_reported(self):
        h = core.parse_hex(NO_RESET_HEX)
        self.assertFalse(h["ok"])
        self.assertFalse(h["has_reset_vector"])
        self.assertTrue(any("复位向量" in p for p in h["problems"]))

    def test_bad_checksum(self):
        h = core.parse_hex(":03000000020040FF\n:00000001FF\n")
        self.assertFalse(h["ok"])
        self.assertTrue(any("校验和" in p for p in h["problems"]))

    def test_missing_eof(self):
        h = core.parse_hex(":03000000020040BB\n")
        self.assertTrue(any("结束记录" in p for p in h["problems"]))

    def test_empty_hex(self):
        h = core.parse_hex(":00000001FF\n")
        self.assertTrue(any("空的" in p for p in h["problems"]))


class TestCurve(unittest.TestCase):
    def test_single_value(self):
        self.assertEqual(core.parse_curve_line("v: 42"), {"values": [42.0]})

    def test_multi_channel(self):
        self.assertEqual(core.parse_curve_line("v: 1.5,-2"), {"values": [1.5, -2.0]})

    def test_plain_text_is_not_a_curve(self):
        self.assertIsNone(core.parse_curve_line("hello world"))
        self.assertIsNone(core.parse_curve_line(""))
        self.assertIsNone(core.parse_curve_line("# comment"))
        self.assertIsNone(core.parse_curve_line("v: abc"))


class TestFlashFailure(unittest.TestCase):
    def test_port_unavailable(self):
        cause, _ = core.classify_flash_failure(1, "could not open port 'COM7': FileNotFoundError")
        self.assertEqual(cause, "port_unavailable")

    def test_no_handshake(self):
        cause, hint = core.classify_flash_failure(124, "Waiting for MCU, please cycle power: ")
        self.assertEqual(cause, "no_handshake")
        self.assertIn("断", hint)

    def test_dtr_is_never_the_answer(self):
        for rc, text in [(124, "Waiting for MCU, please cycle power:"), (1, "programmer is not responding")]:
            _, hint = core.classify_flash_failure(rc, text)
            self.assertNotIn("-a", hint)


class TestProjectScan(unittest.TestCase):
    def test_scan_uses_unique_relative_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            for sub in ("templates/mcu51", "experiments/01-demo"):
                d = os.path.join(tmp, *sub.split("/"))
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, "template51.uvproj"), "w", encoding="utf-8") as fh:
                    fh.write(MINIMAL_UVPROJ)
            found = core.scan_projects(tmp)
            labels = sorted(p["label"] for p in found)
            self.assertEqual(labels, ["experiments/01-demo / template51", "templates/mcu51 / template51"])
            self.assertEqual(found[0]["device"], "AT89C52")
            self.assertEqual(found[0]["clock"], 11059200)
            self.assertTrue(found[0]["create_hex"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
