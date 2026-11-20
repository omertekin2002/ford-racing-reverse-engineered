"""Synthetic verify_findings level tests; these use no game data and no Ghidra outputs."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import verify_findings
from verify_findings import (CHECKS, DATA_CHECKS, EXIT_FAILED, EXIT_UNAVAILABLE, GHIDRA_CHECKS, INSTRUCTION_CHECKS, LEVELS,
                             compare_directories, main)

DEMO_FILES = ("inputs/fordracing3demo.zip", "inputs/fr3.exe")
GHIDRA_FILES = ("artifacts/ghidra/status.json", "artifacts/ghidra/decompiled.c", "artifacts/fr3-demo-annotated.gzf")


def recording_checks(calls, fail=None):
    """Stand-in checks that record their names; the one named fail raises ValueError."""
    def make(name):
        def check(ctx):
            calls.append(name)
            if name == fail:
                raise ValueError(f"planted mismatch in {name}")
            return {"items": len(calls)}
        return check
    return {name: make(name) for name in CHECKS}


class Checkout:
    """A temporary root holding empty stand-ins for the files a level needs."""

    def __init__(self, testcase, demo=True, ghidra=False):
        directory = tempfile.TemporaryDirectory()
        testcase.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / "analysis").mkdir()
        if demo:
            (self.root / "inputs/extracted/Program_Executable_Files").mkdir(parents=True)
            for path in DEMO_FILES:
                (self.root / path).write_bytes(b"stand-in")
        if ghidra:
            for path in GHIDRA_FILES:
                (self.root / path).parent.mkdir(parents=True, exist_ok=True)
                (self.root / path).write_bytes(b"stand-in")

    def run(self, *argv, checks=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main([str(self.root), *argv], checks=checks)
        return code, stdout.getvalue(), stderr.getvalue()


class LevelDefinitionTests(unittest.TestCase):
    def test_full_is_the_union_of_the_other_levels_and_the_ghidra_checks(self):
        full = LEVELS["full"]["checks"]
        self.assertEqual(len(full), len(set(full)))
        self.assertEqual(set(full), set(DATA_CHECKS) | set(INSTRUCTION_CHECKS) | set(GHIDRA_CHECKS))
        self.assertEqual(set(full), set(CHECKS))

    def test_levels_keep_the_full_order(self):
        full = LEVELS["full"]["checks"]
        for level in ("data", "instructions"):
            checks = LEVELS[level]["checks"]
            self.assertEqual(list(checks), [name for name in full if name in checks], level)
        self.assertLess(full.index("text_databases"), full.index("tyre_table_dimensions"))

    def test_demo_levels_need_no_ghidra_output_or_compiler(self):
        for level in ("data", "instructions"):
            for need in LEVELS[level]["needs"]:
                self.assertTrue(need.path.startswith("inputs/"), (level, need.path))
                self.assertFalse(need.command)
                self.assertIn("acquire_demo.py", need.hint)
            self.assertFalse(set(LEVELS[level]["checks"]) & set(GHIDRA_CHECKS))

    def test_full_needs_everything_the_other_levels_need(self):
        full = set(LEVELS["full"]["needs"])
        self.assertLessEqual(set(LEVELS["data"]["needs"]) | set(LEVELS["instructions"]["needs"]), full)
        self.assertEqual({need.path for need in full if need.hint == verify_findings.GHIDRA_HINT}, set(GHIDRA_FILES))


class DispatchTests(unittest.TestCase):
    def test_each_level_runs_exactly_its_checks_in_order(self):
        for level in ("data", "instructions"):
            checkout, calls = Checkout(self), []
            code, stdout, _ = checkout.run("--level", level, checks=recording_checks(calls))
            self.assertEqual(code, 0)
            self.assertEqual(calls, list(LEVELS[level]["checks"]))
            self.assertIn(f"level '{level}' passed", stdout)
            self.assertEqual(list((checkout.root / "analysis").iterdir()), [], "a demo level wrote under analysis/")

    def test_full_runs_every_check_in_order(self):
        calls = []
        verify_findings.run_checks(verify_findings.Context(Path(".")), "full", recording_checks(calls))
        self.assertEqual(calls, list(LEVELS["full"]["checks"]))

    def test_full_is_the_default_level(self):
        checkout = Checkout(self)
        code, _, stderr = checkout.run()
        self.assertEqual(code, EXIT_UNAVAILABLE)
        self.assertIn("level 'full' is unavailable", stderr)

    def test_failed_check_stops_the_level_and_names_the_check(self):
        checkout, calls = Checkout(self), []
        report = checkout.root / "out/report.json"
        code, _, stderr = checkout.run("--level", "instructions", "--report", str(report),
                                       checks=recording_checks(calls, fail="field_instruction_sites"))
        self.assertEqual(code, EXIT_FAILED)
        self.assertEqual(calls, ["executable_identity", "pe_build_metadata", "field_instruction_sites"])
        self.assertIn("check field_instruction_sites: planted mismatch", stderr)
        data = json.loads(report.read_text())
        self.assertEqual(data["result"], "failed")
        self.assertEqual(data["failure"], {"check": "field_instruction_sites", "message": "planted mismatch in field_instruction_sites"})
        self.assertEqual([check["name"] for check in data["checks_performed"]], ["executable_identity", "pe_build_metadata"])

    def test_missing_committed_file_is_a_named_failure(self):
        checkout = Checkout(self)
        report = checkout.root / "report.json"
        checks = recording_checks([])
        checks["field_instruction_sites"] = verify_findings.check_field_instruction_sites
        with mock.patch.object(verify_findings.Context, "executable", b"stand-in"), \
                mock.patch.object(verify_findings.Context, "pe", object()):
            code, _, stderr = checkout.run("--level", "instructions", "--report", str(report), checks=checks)
        self.assertEqual(code, EXIT_FAILED)
        self.assertNotIn("Traceback", stderr)
        self.assertIn("check field_instruction_sites", stderr)
        self.assertIn("analysis/selected/field-evidence.json", stderr)
        data = json.loads(report.read_text())
        self.assertEqual((data["result"], data["failure"]["check"]), ("failed", "field_instruction_sites"))


class UnavailableLevelTests(unittest.TestCase):
    def assert_unavailable(self, checkout, level, *expected):
        calls = []
        code, stdout, stderr = checkout.run("--level", level, checks=recording_checks(calls))
        self.assertEqual(code, EXIT_UNAVAILABLE)
        self.assertNotEqual(EXIT_UNAVAILABLE, EXIT_FAILED)
        self.assertEqual(calls, [], "no check may run when a prerequisite is missing")
        self.assertIn(f"level '{level}' is unavailable", stderr)
        self.assertNotIn("Traceback", stderr)
        self.assertEqual(stdout, "")
        for text in expected:
            self.assertIn(text, stderr)
        return stderr

    def test_missing_demo_names_acquire_demo(self):
        for level in ("data", "instructions", "full"):
            stderr = self.assert_unavailable(Checkout(self, demo=False), level, "inputs/fr3.exe", "scripts/acquire_demo.py inputs")
            self.assertEqual("inputs/fordracing3demo.zip" in stderr, level != "instructions")

    def test_full_without_ghidra_outputs_names_run_analysis(self):
        stderr = self.assert_unavailable(Checkout(self), "full", "scripts/run_analysis.py", "--level data", "--level instructions",
                                         *GHIDRA_FILES)
        self.assertNotIn("inputs/", stderr)

    def test_full_without_gcc_names_gcc(self):
        checkout = Checkout(self, ghidra=True)
        with mock.patch.object(verify_findings.shutil, "which", return_value=None):
            self.assert_unavailable(checkout, "full", "program gcc")

    def test_unavailable_report(self):
        checkout = Checkout(self)
        report = checkout.root / "report.json"
        checkout.run("--level", "full", "--report", str(report), checks=recording_checks([]))
        data = json.loads(report.read_text())
        self.assertEqual((data["level"], data["result"], data["checks_performed"]), ("full", "unavailable", []))
        self.assertEqual([need["path"] for need in data["missing_prerequisites"]], list(GHIDRA_FILES))
        self.assertEqual(data["levels_not_performed"], ["data", "instructions", "full"])
        self.assertIsNone(data["archive_sha256"])


class ReportTests(unittest.TestCase):
    def report(self, level, checkout=None):
        checkout = checkout or Checkout(self)
        path = checkout.root / f"{level}.json"
        code, _, _ = checkout.run("--level", level, "--report", str(path), checks=recording_checks([]))
        self.assertEqual(code, 0)
        return json.loads(path.read_text())

    def test_data_report(self):
        data = self.report("data")
        self.assertEqual((data["level"], data["result"], data["failure"]), ("data", "passed", None))
        self.assertEqual([check["name"] for check in data["checks_performed"]], list(DATA_CHECKS))
        self.assertTrue(all(isinstance(check["counts"], dict) for check in data["checks_performed"]))
        self.assertEqual(data["archive_sha256"], verify_findings.ARCHIVE_SHA256)
        self.assertEqual(data["executable_sha256"], verify_findings.EXE_SHA256)
        self.assertEqual(data["levels_not_performed"], ["instructions", "full"])
        self.assertFalse(data["writes_analysis_verification"])
        self.assertEqual(set(data["tool_versions"]), {"python", "pefile", "capstone"})
        self.assertIsNone(data["producer_revision"], "the temporary root is not a git checkout")

    def test_instructions_report_lists_only_its_checks(self):
        data = self.report("instructions")
        self.assertEqual([check["name"] for check in data["checks_performed"]], list(INSTRUCTION_CHECKS))
        self.assertIsNone(data["archive_sha256"], "the instructions level never reads the archive")
        self.assertEqual(data["executable_sha256"], verify_findings.EXE_SHA256)
        self.assertEqual(data["levels_not_performed"], ["data", "full"])

    def test_producer_revision_records_commit_and_dirty_flag(self):
        checkout = Checkout(self)
        (checkout.root / ".gitignore").write_text("inputs/\n*.json\n")

        def git(*argv):
            return subprocess.run(["git", "-C", str(checkout.root), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *argv],
                                  check=True, capture_output=True, text=True).stdout.strip()
        git("init", "-q")
        git("add", ".gitignore")
        git("commit", "-q", "-m", "init")
        data = self.report("data", checkout)
        self.assertEqual(data["producer_revision"], {"commit": git("rev-parse", "HEAD"), "dirty": False})
        (checkout.root / "notes.txt").write_text("uncommitted")
        self.assertTrue(self.report("data", checkout)["producer_revision"]["dirty"])


class CompareDirectoriesTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.committed, self.regenerated = Path(directory.name) / "committed", Path(directory.name) / "regenerated"
        for root in (self.committed, self.regenerated):
            root.mkdir()
            (root / "a.asm").write_text("; header\n00401000 90 nop\n00401001 c3 ret\n")
            (root / "field-evidence.json").write_text('[{"va": 4198400, "bytes": "90"}]\n')

    def compare(self):
        return compare_directories(self.committed, self.regenerated, "analysis/selected")

    def test_identical_directories_match(self):
        self.assertEqual(self.compare(), [])

    def test_changed_line_is_named(self):
        (self.committed / "a.asm").write_text("; header\n00401000 90 nop\n00401001 c3 retn\n")
        self.assertEqual(self.compare(), ["analysis/selected/a.asm:3: committed '00401001 c3 retn', regenerated '00401001 c3 ret'"])

    def test_changed_evidence_bytes_are_named(self):
        (self.committed / "field-evidence.json").write_text('[{"va": 4198400, "bytes": "91"}]\n')
        [problem] = self.compare()
        self.assertTrue(problem.startswith("analysis/selected/field-evidence.json:1: committed"), problem)
        self.assertIn('"91"', problem)

    def test_truncated_file_is_named(self):
        (self.committed / "a.asm").write_text("; header\n00401000 90 nop\n")
        [problem] = self.compare()
        self.assertTrue(problem.startswith("analysis/selected/a.asm:3: committed ''"), problem)

    def test_missing_file_is_named(self):
        (self.committed / "a.asm").unlink()
        self.assertEqual(self.compare(), ["analysis/selected/a.asm: missing (the regeneration writes it)"])

    def test_extra_file_is_named(self):
        (self.committed / "b.asm").write_text("; stale\n")
        self.assertEqual(self.compare(), ["analysis/selected/b.asm: extra file (the regeneration does not write it)"])

    def test_every_difference_is_listed(self):
        (self.committed / "a.asm").unlink()
        (self.committed / "b.asm").write_text("; stale\n")
        (self.committed / "field-evidence.json").write_text("[]\n")
        self.assertEqual(len(self.compare()), 3)


if __name__ == "__main__":
    unittest.main()
