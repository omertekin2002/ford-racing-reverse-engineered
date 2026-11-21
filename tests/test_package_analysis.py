"""Synthetic analysis-bundle tests: a fixture Git checkout, stub verification checks, no demo or Ghidra needed."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_research
import package_analysis
from package_analysis import GHIDRA_C, GHIDRA_FILES, GHIDRA_SNAPSHOT, GHIDRA_STATUS
from text_database import REPO_ROOT, load_known_tags, write_databases
import verify_findings
from verify_findings import CHECKS, CheckFailed

from test_build_research import write_analysis, write_game
from test_open_questions import question_verification
from test_package_research import git

SCRIPT = REPO_ROOT / "scripts/package_analysis.py"
PE = json.loads((REPO_ROOT / "analysis/pe-metadata.json").read_text())
SOURCE = {"README.md": b"# Fixture\n", "ruff.toml": b"target-version = \"py312\"\n",
          "scripts/tool.py": b"print('tool')\n", "tests/test_tool.py": b"# test\n",
          "recovered/layout.h": b"struct layout { int x; };\n", "docs/notes.md": b"Notes\n"}
# Tracked, but outside the packaged source paths.
OUTSIDE = {".gitignore": b"inputs/\nartifacts/\n__pycache__/\n", "web/index.html": b"<p>site</p>\n"}
GHIDRA = {"artifacts/ghidra/calls.tsv": b"caller\tcallee\n", GHIDRA_C: b"/* 00401000 FUN */\nvoid f(void) {}\n",
          "artifacts/ghidra/disassembly.txt": b"00401000 RET\n", "artifacts/ghidra/functions.tsv": b"00401000\tf\n",
          GHIDRA_STATUS: b'{"functions": 1}\n', GHIDRA_SNAPSHOT: b"packed annotated program"}
VERIFIED_UTC = "2026-10-10T11:41:11.997030+00:00"
DATABASES = ("text-databases/engines.json", "text-databases/gearboxes.json", "text-databases/tyres.json")
EPOCH = 1_700_000_000


def stub_checks(calls=None, fail=None):
    """Stand-in verification checks; the one named fail raises ValueError."""
    calls = [] if calls is None else calls

    def make(name):
        def check(ctx):
            calls.append(name)
            if name == fail:
                raise ValueError(f"planted mismatch in {name}")
            return {"items": 1}
        return check
    return {name: make(name) for name in CHECKS}


def write_checkout(root):
    """A Git checkout with fixture source, committed analysis/, stand-in demo inputs and stray artifacts."""
    for name, data in {**SOURCE, **OUTSIDE}.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes(data)
    analysis = write_analysis(root / "analysis")
    record = {**question_verification(), "verified_utc": VERIFIED_UTC,
              "annotated_snapshot_sha256": hashlib.sha256(GHIDRA[GHIDRA_SNAPSHOT]).hexdigest(),
              "baseline_c_sha256": hashlib.sha256(GHIDRA[GHIDRA_C]).hexdigest()}
    (analysis / "verification.json").write_text(json.dumps(record), encoding="utf-8")
    (analysis / "baseline-status.json").write_bytes(GHIDRA[GHIDRA_STATUS])
    git(root, "init", "-q")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "fixture")
    for path in ("inputs/fordracing3demo.zip", "inputs/fr3.exe"):
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_bytes(b"MZ stand-in")
    write_game(root / "inputs/extracted/Program_Executable_Files")
    # Things a real run leaves under artifacts/ that must never be packaged.
    for path, data in (("artifacts/pe/metadata.json", b"{}"), ("artifacts/logs/baseline.log", b"/home/x/log"),
                       ("artifacts/project/FordRacing3.gpr", b"project")):
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_bytes(data)
    return git(root, "rev-parse", "HEAD")


def read_zip(path):
    with zipfile.ZipFile(path) as archive:
        return {info.filename: archive.read(info) for info in archive.infolist()}, archive.infolist()


class BundleTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.template = Path(cls.directory.name) / "checkout"
        cls.revision = write_checkout(cls.template)
        cls.edition = f"fr3-analysis-{cls.revision[:12]}"
        build_research.build(cls.template / "inputs/extracted/Program_Executable_Files",
                             cls.template / "artifacts/research", cls.template / "analysis", revision=cls.revision)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / "checkout"
        shutil.copytree(self.template, self.root, symlinks=True)
        self.artifacts = self.root / "artifacts"
        self.default = self.artifacts / f"{self.edition}.zip"

    def package(self, output=None, epoch=EPOCH, checks=None, **kwargs):
        return package_analysis.package(self.root, output=output, epoch=epoch,
                                        checks=stub_checks() if checks is None else checks, **kwargs)

    def bundle(self, **kwargs):
        destination, _, _, _ = self.package(**kwargs)
        entries, infos = read_zip(destination)
        prefix = f"{self.edition}/"
        self.assertTrue(all(name.startswith(prefix) for name in entries))
        files = {name.removeprefix(prefix): data for name, data in entries.items()}
        return files, json.loads(files["MANIFEST.json"]), infos

    def add_ghidra(self, names=GHIDRA_FILES, changes=None):
        for name in names:
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / name).write_bytes((changes or {}).get(name, GHIDRA[name]))

    def refuse(self, fragment, error=ValueError, **kwargs):
        self.default.write_bytes(b"previous bundle")
        before = sorted(path.name for path in self.artifacts.iterdir())
        with self.assertRaises(error) as caught:
            self.package(**kwargs)
        self.assertIn(fragment, str(caught.exception))
        # The previous bundle stays and no temporary file is left beside it.
        self.assertEqual(self.default.read_bytes(), b"previous bundle")
        self.assertEqual(sorted(path.name for path in self.artifacts.iterdir()), before)
        return caught.exception


def research_files(root):
    research = root / "artifacts/research"
    return {f"research/{path.relative_to(research).as_posix()}": path.read_bytes()
            for path in sorted(research.rglob("*")) if path.is_file()}


def source_files(root, revision):
    names = git(root, "ls-tree", "-r", "--name-only", revision, "--", *package_analysis.SOURCE_PATHS).splitlines()
    return {name: git_bytes(root, revision, name) for name in names}


def git_bytes(root, revision, name):
    return subprocess.run(["git", "-C", str(root), "show", f"{revision}:{name}"], capture_output=True, check=True,
                          timeout=60).stdout


class BundleTests(BundleTestCase):
    def test_without_ghidra_packages_source_databases_and_research(self):
        calls = []
        destination, count, size, levels = self.package(checks=stub_checks(calls))
        self.assertEqual(destination, self.default)
        self.assertEqual(size, destination.stat().st_size)
        files, manifest, _ = self.bundle()
        source = source_files(self.root, self.revision)
        self.assertIn("scripts/tool.py", source)
        self.assertIn("analysis/verification.json", source)
        expected = {**source, **research_files(self.root), **{name: None for name in DATABASES}}
        self.assertEqual(sorted(files), sorted((*expected, "MANIFEST.json", "SHA256SUMS")))
        self.assertEqual(count, len(files))
        for name, data in {**source, **research_files(self.root)}.items():
            self.assertEqual(files[name], data, name)
        self.assertEqual(calls, [*verify_findings.DATA_CHECKS, *verify_findings.INSTRUCTION_CHECKS])
        self.assertEqual(manifest["levels"], levels)
        self.assertEqual({name: level["status"] for name, level in levels.items()},
                         {"read": "performed", "data": "performed", "instructions": "performed",
                          "full": "unavailable"})

    def test_never_packages_inputs_executables_logs_or_snapshots(self):
        files, _, _ = self.bundle()
        for name in files:
            self.assertFalse(name.startswith(("inputs/", "artifacts/", "web/", ".git")), name)
            self.assertFalse(name.endswith((".exe", ".gzf", ".log", ".gpr")), name)
            self.assertNotEqual(files[name][:2], b"MZ", name)

    def test_one_top_level_folder_with_fixed_metadata(self):
        destination, _, _, _ = self.package()
        entries, infos = read_zip(destination)
        self.assertEqual({name.split("/", 1)[0] for name in entries}, {self.edition})
        self.assertEqual([info.filename for info in infos], sorted(entries))
        for info in infos:
            self.assertEqual(info.date_time, (2023, 11, 14, 22, 13, 20))
            self.assertEqual(info.external_attr >> 16, 0o100644)

    def test_text_databases_match_a_fresh_parse(self):
        files, manifest, _ = self.bundle()
        with tempfile.TemporaryDirectory() as scratch:
            counts = write_databases(self.root / "inputs/extracted/Program_Executable_Files", scratch,
                                     load_known_tags(self.root / "analysis/tags.json"))
            for name in DATABASES:
                self.assertEqual(files[name], (Path(scratch) / Path(name).name).read_bytes(), name)
        self.assertEqual(manifest["layers"]["text-databases"]["records"], counts)

    def test_manifest_names_input_revision_tools_levels_and_files(self):
        files, manifest, _ = self.bundle()
        self.assertEqual(manifest["edition"], self.edition)
        self.assertEqual(manifest["producer_revision"], self.revision)
        self.assertEqual(manifest["input"]["fr3_exe"],
                         {"sha256": PE["sha256"], "pe_timestamp_utc": PE["timestamp_header_utc"]})
        self.assertEqual(manifest["input"]["demo_archive"]["sha256"], verify_findings.ARCHIVE_SHA256)
        self.assertEqual(set(manifest["tools"]), {"python", "zlib", "pefile", "capstone"})
        self.assertEqual(manifest["tools"]["python"], sys.version.split()[0])
        levels = manifest["levels"]
        self.assertEqual([check["name"] for check in levels["data"]["checks"]], list(verify_findings.DATA_CHECKS))
        self.assertEqual([check["name"] for check in levels["instructions"]["checks"]],
                         list(verify_findings.INSTRUCTION_CHECKS))
        self.assertEqual(levels["data"]["checks"][0]["counts"], {"items": 1})
        self.assertIn("pages_match_fresh_build", [check["name"] for check in levels["read"]["checks"]])
        full = levels["full"]
        self.assertEqual(full["missing"], list(GHIDRA_FILES))
        recovery = " ".join(full["recovery"])
        for command in ("scripts/setup_tools.py", "scripts/run_analysis.py", "scripts/verify_findings.py",
                        "git add analysis && git commit", "scripts/build_research.py", "scripts/package_analysis.py"):
            self.assertIn(command, recovery)
        # Commit the rewritten verification record before rebuilding the pages that name the commit.
        self.assertLess(recovery.index("git commit"), recovery.index("build_research.py"))
        self.assertIn("not re-run", full["summary"])
        listed = [entry["path"] for entry in manifest["files"]]
        self.assertEqual(listed, sorted(set(files) - {"MANIFEST.json", "SHA256SUMS"}))
        for entry in manifest["files"]:
            data = files[entry["path"]]
            self.assertEqual((entry["size"], entry["sha256"]), (len(data), hashlib.sha256(data).hexdigest()))

    @unittest.skipUnless(shutil.which("sha256sum"), "sha256sum is not installed")
    def test_sha256sum_check_passes_after_extraction(self):
        destination, _, _, _ = self.package()
        extracted = self.root.parent / "extracted"
        with zipfile.ZipFile(destination) as archive:
            archive.extractall(extracted)
        self.assertEqual([path.name for path in extracted.iterdir()], [self.edition])
        result = subprocess.run(["sha256sum", "-c", "--strict", "SHA256SUMS"], cwd=extracted / self.edition,
                                capture_output=True, text=True, check=False, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_same_revision_gives_a_byte_identical_zip(self):
        first, _, _, _ = self.package(self.artifacts / "fr3-analysis-a.zip")
        second, _, _, _ = self.package(self.artifacts / "fr3-analysis-b.zip")
        self.assertEqual(first.read_bytes(), second.read_bytes())
        third, _, _, _ = self.package(self.artifacts / "fr3-analysis-c.zip", epoch=EPOCH + 2)
        self.assertNotEqual(first.read_bytes(), third.read_bytes())

    def test_replaces_a_previous_bundle_only(self):
        self.default.write_bytes(b"previous bundle")
        self.package()
        self.assertTrue(zipfile.is_zipfile(self.default))
        other = self.artifacts / "notes.zip"
        other.write_bytes(b"keep me")
        with self.assertRaisesRegex(ValueError, r"only a previous fr3-analysis-\*\.zip bundle is overwritten"):
            self.package(other)
        self.assertEqual(other.read_bytes(), b"keep me")
        with self.assertRaisesRegex(ValueError, "inside the research directory"):
            self.package(self.artifacts / "research/fr3-analysis-x.zip")

    def test_ignored_files_under_source_paths_are_not_packaged(self):
        cache = self.root / "scripts/__pycache__/tool.cpython-312.pyc"
        cache.parent.mkdir()
        cache.write_bytes(b"bytecode")
        files, _, _ = self.bundle()
        self.assertNotIn("scripts/__pycache__/tool.cpython-312.pyc", files)


class GhidraLayerTests(BundleTestCase):
    def test_matching_outputs_are_packaged_and_full_is_recorded_not_rerun(self):
        self.add_ghidra()
        files, manifest, _ = self.bundle()
        for name, data in GHIDRA.items():
            self.assertEqual(files[name], data, name)
        full = manifest["levels"]["full"]
        self.assertEqual(full["status"], "performed")
        self.assertEqual(full["note"], f"artifacts match the committed verification record of {VERIFIED_UTC}; "
                                       "not re-run")
        self.assertEqual([check["name"] for check in full["checks"]],
                         ["baseline_c_sha256", "baseline_status", "annotated_snapshot_sha256"])
        self.assertEqual(manifest["layers"]["ghidra"]["files"], sorted(GHIDRA))
        self.assertFalse(any(name.startswith(("artifacts/logs/", "artifacts/pe/", "artifacts/project/"))
                             for name in files))

    def test_partial_outputs_leave_full_unavailable_and_unpackaged(self):
        self.add_ghidra([GHIDRA_C, GHIDRA_STATUS])
        files, manifest, _ = self.bundle()
        self.assertFalse(any(name.startswith("artifacts/") for name in files))
        full = manifest["levels"]["full"]
        self.assertEqual(full["status"], "unavailable")
        self.assertEqual(full["missing"], [name for name in GHIDRA_FILES if name not in (GHIDRA_C, GHIDRA_STATUS)])
        self.assertEqual([check["name"] for check in full["checks"]], ["baseline_c_sha256", "baseline_status"])

    def test_mismatching_snapshot_is_refused_not_dropped(self):
        self.add_ghidra(changes={GHIDRA_SNAPSHOT: b"rebuilt snapshot"})
        self.refuse("differs from the annotated_snapshot_sha256")

    def test_mismatching_snapshot_alone_is_refused(self):
        self.add_ghidra([GHIDRA_SNAPSHOT], changes={GHIDRA_SNAPSHOT: b"rebuilt snapshot"})
        self.refuse(f"{GHIDRA_SNAPSHOT} differs from the annotated_snapshot_sha256")

    def test_mismatching_baseline_c_or_status_is_refused(self):
        for name, fragment in ((GHIDRA_C, "baseline_c_sha256"), (GHIDRA_STATUS, "analysis/baseline-status.json")):
            with self.subTest(name=name):
                self.add_ghidra(changes={name: b"changed"})
                self.refuse(fragment)

    def test_symlinked_output_is_refused(self):
        self.add_ghidra([GHIDRA_C, GHIDRA_STATUS])
        target = self.root.parent / "snapshot.gzf"
        target.write_bytes(GHIDRA[GHIDRA_SNAPSHOT])
        (self.root / GHIDRA_SNAPSHOT).symlink_to(target)
        self.refuse("symlinked Ghidra output")


class RefusalTests(BundleTestCase):
    def commit(self, message="later"):
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", message)

    def test_uncommitted_source_changes_are_refused(self):
        cases = {"scripts/tool.py": "edit", "analysis/tags.json": "edit", "docs/notes.md": "delete",
                 "recovered/new.h": "untracked", "README.md": "staged"}
        for name, change in cases.items():
            with self.subTest(name=name, change=change):
                path = self.root / name
                original = path.read_bytes() if path.exists() else None
                if change == "delete":
                    path.unlink()
                else:
                    path.write_bytes((original or b"") + b"\n# local edit\n")
                if change == "staged":
                    git(self.root, "add", name)
                self.refuse(f"Uncommitted changes under the packaged source paths ({', '.join(package_analysis.SOURCE_PATHS)}): {name}")
                if change == "staged":
                    git(self.root, "reset", "-q", "--", name)
                if original is None:
                    path.unlink()
                else:
                    path.write_bytes(original)

    def test_changes_outside_source_paths_are_allowed(self):
        (self.root / "web/index.html").write_text("local edit", encoding="utf-8")
        files, _, _ = self.bundle()
        self.assertNotIn("web/index.html", files)

    def test_research_page_that_differs_from_a_fresh_build(self):
        page = self.root / "artifacts/research/tyres.html"
        page.write_text(page.read_text(encoding="utf-8").replace("</body>", "<p>Invented</p></body>"),
                        encoding="utf-8")
        self.refuse("fresh build with committed analysis inputs: tyres.html")

    def test_research_built_at_another_revision(self):
        (self.root / "docs/notes.md").write_text("later\n", encoding="utf-8")
        self.commit()
        self.refuse("was not built at revision")

    def test_failing_level_check_names_the_check(self):
        for level, name in (("data", "pcg_index"), ("instructions", "field_instruction_sites")):
            with self.subTest(level=level):
                failure = self.refuse(f"{name}: planted mismatch in {name}", error=CheckFailed,
                                      checks=stub_checks(fail=name))
                self.assertEqual((failure.level, failure.check), (level, name))

    def test_revision_that_is_not_a_commit(self):
        tree = git(self.root, "rev-parse", "HEAD^{tree}")
        self.refuse("is a Git tree, not a commit", revision=tree)

    def test_failed_self_check_keeps_the_previous_bundle(self):
        with mock.patch.object(package_analysis.package_research, "check_zip",
                               side_effect=ValueError("self-check failed")):
            self.refuse("self-check failed")

    def test_exclusion_guard(self):
        package_analysis.check_exclusions({"research/index.html": b"<p>", GHIDRA_SNAPSHOT: b"x"}, True)
        for files, full in (({"inputs/fr3.exe": b"x"}, False), ({"scripts/x.exe": b"x"}, False),
                            ({"artifacts/logs/a.log": b"x"}, False), ({"artifacts/pe/m.json": b"x"}, False),
                            ({GHIDRA_SNAPSHOT: b"x"}, False), ({"docs/a.bin": b"MZ\x90\x00"}, False)):
            with self.subTest(files=sorted(files)), self.assertRaisesRegex(ValueError, "must not hold"):
                package_analysis.check_exclusions(files, full)


class CommandTests(BundleTestCase):
    def run_main(self, *argv, checks=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = package_analysis.main(["--root", str(self.root), *argv],
                                         checks=stub_checks() if checks is None else checks)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_success_prints_the_level_table(self):
        code, out, err = self.run_main()
        self.assertEqual(code, 0, err)
        self.assertRegex(out, r"(?m)^data +performed ")
        self.assertRegex(out, r"(?m)^full +unavailable +missing artifacts/ghidra/calls\.tsv.*scripts/run_analysis\.py")
        self.assertIn(f"{self.default} ({self.default.stat().st_size} bytes)", out)

    def test_missing_demo_exits_3_with_the_acquire_hint(self):
        shutil.rmtree(self.root / "inputs")
        code, _, err = self.run_main()
        self.assertEqual(code, package_analysis.EXIT_UNAVAILABLE)
        self.assertIn("inputs/fr3.exe: run `python3 scripts/acquire_demo.py inputs`", err)
        self.assertFalse(self.default.exists())

    def test_missing_research_exits_3(self):
        shutil.rmtree(self.root / "artifacts/research")
        code, _, err = self.run_main()
        self.assertEqual(code, package_analysis.EXIT_UNAVAILABLE)
        self.assertIn("scripts/build_research.py", err)

    def test_failing_check_exits_1_naming_level_and_check(self):
        code, _, err = self.run_main(checks=stub_checks(fail="selected_disassembly"))
        self.assertEqual(code, package_analysis.EXIT_FAILED)
        self.assertIn("verification level 'instructions' failed in check selected_disassembly", err)
        self.assertNotIn("Traceback", err)
        self.assertFalse(self.default.exists())

    def test_refusal_exits_1(self):
        (self.root / "scripts/tool.py").write_text("edited", encoding="utf-8")
        code, _, err = self.run_main()
        self.assertEqual(code, package_analysis.EXIT_FAILED)
        self.assertIn("refused: Uncommitted changes", err)

    def test_script_without_a_demo_exits_3(self):
        empty = self.root.parent / "empty"
        empty.mkdir()
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(empty)], capture_output=True, text=True,
                                check=False, timeout=120)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("acquire_demo.py", result.stderr)
        self.assertEqual(list(empty.iterdir()), [])

    def test_help_documents_flags_and_defaults(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True, check=False,
                                timeout=120)
        self.assertEqual(result.returncode, 0)
        text = " ".join(result.stdout.split())
        self.assertIn("fr3-analysis-<short revision>.zip", text)
        self.assertIn("--research", text)

    def test_bundles_stay_out_of_git(self):
        result = subprocess.run(["git", "-C", str(REPO_ROOT), "check-ignore", "-q",
                                 "artifacts/fr3-analysis-0123456789ab.zip"], check=False, timeout=30)
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
