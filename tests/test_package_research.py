"""Synthetic research-packet tests: build a research directory from fixture files and package it, no demo needed."""
import hashlib
import json
import os
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
from dossier_common import rights_notice
from fr3_common import ARCHIVE_SHA256, ARCHIVE_SIZE
import package_research
from text_database import REPO_ROOT

from test_build_research import EVIDENCE, PAGES, files_under, write_analysis, write_game

SCRIPT = REPO_ROOT / "scripts/package_research.py"
BUILD_SCRIPT = REPO_ROOT / "scripts/build_research.py"
PE = json.loads((REPO_ROOT / "analysis/pe-metadata.json").read_text())
REVISION = "0123456789abcdef0123456789abcdef01234567"
EDITION = "fr3-research-0123456789ab"
RESEARCH_FILES = sorted((*PAGES, *EVIDENCE))


class PackageTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        root = Path(cls.directory.name)
        cls.analysis = write_analysis(root / "analysis")
        cls.built = root / "research"
        build_research.build(write_game(root / "game"), cls.built, cls.analysis, revision=REVISION)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.research = self.root / "research"
        shutil.copytree(self.built, self.research)
        self.out = self.root / "out"
        self.out.mkdir()

    def package(self, output=None, epoch=1_700_000_000, **kwargs):
        kwargs.setdefault("analysis", self.analysis)
        kwargs.setdefault("revision", REVISION)
        return package_research.package(self.research, output or self.out / f"{EDITION}.zip", epoch=epoch, **kwargs)

    def refuse(self, fragment, output=None, **kwargs):
        before = sorted(path.name for path in self.out.iterdir())
        with self.assertRaises(ValueError) as caught:
            self.package(output, **kwargs)
        self.assertIn(fragment, str(caught.exception))
        # Nothing written: no ZIP and no temporary file beside the destination.
        self.assertEqual(sorted(path.name for path in self.out.iterdir()), before)


def read_zip(path):
    with zipfile.ZipFile(path) as archive:
        return {info.filename: archive.read(info) for info in archive.infolist()}, archive.infolist()


class PackageTests(PackageTestCase):
    def test_packages_every_research_file_unchanged_in_one_folder(self):
        destination, count, size = self.package()
        self.assertEqual(destination, self.out / f"{EDITION}.zip")
        self.assertEqual(count, len(RESEARCH_FILES) + 2)
        self.assertEqual(size, destination.stat().st_size)
        entries, infos = read_zip(destination)
        self.assertEqual(sorted(entries), sorted(f"{EDITION}/{name}"
                                                 for name in (*RESEARCH_FILES, "MANIFEST.json", "SHA256SUMS")))
        for name in RESEARCH_FILES:
            self.assertEqual(entries[f"{EDITION}/{name}"], (self.research / name).read_bytes(), name)
        for info in infos:
            self.assertEqual(info.date_time, (2023, 11, 14, 22, 13, 20))
            self.assertEqual(info.external_attr >> 16, 0o100644)
            self.assertEqual(info.compress_type, zipfile.ZIP_DEFLATED)
        self.assertEqual(sorted(path.name for path in self.out.iterdir()), [f"{EDITION}.zip"])

    def test_manifest_names_the_build_revision_tools_checks_and_files(self):
        destination, _, _ = self.package()
        entries, _ = read_zip(destination)
        manifest = json.loads(entries[f"{EDITION}/MANIFEST.json"])
        self.assertEqual(manifest["edition"], EDITION)
        self.assertEqual(manifest["producer_revision"], REVISION)
        self.assertEqual(manifest["input"], {
            "fr3_exe": {"sha256": PE["sha256"], "pe_timestamp_utc": PE["timestamp_header_utc"]},
            "demo_archive": {"sha256": ARCHIVE_SHA256, "size": ARCHIVE_SIZE}})
        self.assertEqual(manifest["tools"]["python"], sys.version.split()[0])
        self.assertEqual(manifest["verification"], list(package_research.VERIFICATION))
        self.assertEqual([entry["path"] for entry in manifest["files"]], RESEARCH_FILES)
        for entry in manifest["files"]:
            data = (self.research / entry["path"]).read_bytes()
            self.assertEqual((entry["size"], entry["sha256"]), (len(data), hashlib.sha256(data).hexdigest()))

    def test_verification_claims_only_checks_it_runs(self):
        text = " ".join(package_research.VERIFICATION)
        for claim in ("verify_research()", "check_output()", "byte-identical to the committed analysis/ files",
                      "instruction evidence not re-derived; full Ghidra analysis not re-run"):
            self.assertIn(claim, text)
        for line in package_research.VERIFICATION:
            if "Ghidra" in line or "instruction" in line or "re-hashed:" in line:
                self.assertIn(" not ", line)

    def test_sha256sums_covers_every_other_file(self):
        destination, _, _ = self.package()
        entries, _ = read_zip(destination)
        lines = entries[f"{EDITION}/SHA256SUMS"].decode("utf-8").splitlines()
        self.assertEqual([line.split("  ", 1)[1] for line in lines], sorted((*RESEARCH_FILES, "MANIFEST.json")))
        for line in lines:
            digest, name = line.split("  ", 1)
            self.assertEqual(hashlib.sha256(entries[f"{EDITION}/{name}"]).hexdigest(), digest)

    @unittest.skipUnless(shutil.which("sha256sum"), "sha256sum is not installed")
    def test_sha256sum_check_passes_after_extraction(self):
        destination, _, _ = self.package()
        extracted = self.root / "extracted"
        with zipfile.ZipFile(destination) as archive:
            archive.extractall(extracted)
        self.assertEqual([path.name for path in extracted.iterdir()], [EDITION])
        result = subprocess.run(["sha256sum", "-c", "--strict", "SHA256SUMS"], cwd=extracted / EDITION,
                                capture_output=True, text=True, check=False, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.count(": OK"), len(RESEARCH_FILES) + 1)

    def test_same_inputs_give_a_byte_identical_zip(self):
        first, _, _ = self.package(self.out / "fr3-research-a.zip")
        second, _, _ = self.package(self.out / "fr3-research-b.zip")
        self.assertEqual(first.read_bytes(), second.read_bytes())
        third, _, _ = self.package(self.out / "fr3-research-c.zip", epoch=1_700_000_002)
        self.assertNotEqual(first.read_bytes(), third.read_bytes())

    def test_timestamp_comes_from_source_date_epoch(self):
        self.assertEqual(package_research.source_date_epoch({}), package_research.DEFAULT_EPOCH)
        self.assertEqual(package_research.source_date_epoch({"SOURCE_DATE_EPOCH": "1700000000"}), 1_700_000_000)
        self.assertEqual(package_research.source_date_epoch({"SOURCE_DATE_EPOCH": "0"}),
                         package_research.DEFAULT_EPOCH)
        with self.assertRaisesRegex(ValueError, "SOURCE_DATE_EPOCH is not a whole number"):
            package_research.source_date_epoch({"SOURCE_DATE_EPOCH": "yesterday"})
        with mock.patch.dict(os.environ, {"SOURCE_DATE_EPOCH": "1700000000"}):
            destination, _, _ = self.package(epoch=None)
        self.assertEqual(read_zip(destination)[1][0].date_time, (2023, 11, 14, 22, 13, 20))
        with mock.patch.dict(os.environ, {}, clear=True):
            destination, _, _ = self.package(epoch=None)
        self.assertEqual(read_zip(destination)[1][0].date_time, (1980, 1, 1, 0, 0, 0))

    def test_replaces_a_previous_packet(self):
        destination = self.out / f"{EDITION}.zip"
        destination.write_bytes(b"old packet")
        self.package()
        self.assertTrue(zipfile.is_zipfile(destination))

    def test_short_revision_names_the_folder(self):
        self.assertEqual(package_research.edition_name(REVISION), EDITION)
        self.assertEqual(package_research.edition_name("unknown"), "fr3-research-unknown")
        with self.assertRaisesRegex(ValueError, "cannot name a packet"):
            package_research.edition_name("../x")


class RefusalTests(PackageTestCase):
    def test_missing_research_directory(self):
        shutil.rmtree(self.research)
        self.refuse("Research directory does not exist")

    def test_page_without_the_notice(self):
        page = self.research / "tyres.html"
        page.write_text(page.read_text(encoding="utf-8").replace(rights_notice(), ""), encoding="utf-8")
        self.refuse("tyres.html lacks the rights-holder notice")

    def test_file_the_build_does_not_write(self):
        (self.research / "evidence/notes.txt").write_text("extra", encoding="utf-8")
        self.refuse("holds files build_research.py does not write: evidence/notes.txt")

    def test_evidence_that_differs_from_analysis(self):
        path = self.research / "evidence/selected/field-evidence.json"
        path.write_bytes(path.read_bytes() + b" ")
        self.refuse("Evidence files differ from the committed analysis/ files: evidence/selected/field-evidence.json")

    def test_pages_built_at_another_revision(self):
        self.refuse("index.html was not built at revision fedcba", revision="fedcba9876543210")

    def test_pages_built_from_another_executable(self):
        analysis = self.root / "analysis"
        shutil.copytree(self.analysis, analysis)
        (analysis / "pe-metadata.json").write_text(json.dumps({**PE, "sha256": "0" * 64}), encoding="utf-8")
        self.refuse("index.html does not name the fr3.exe SHA-256", analysis=analysis)

    def test_destination_is_a_directory(self):
        destination = self.out / f"{EDITION}.zip"
        destination.mkdir()
        self.refuse("not a file", output=destination)
        self.assertTrue(destination.is_dir())

    def test_destination_is_a_symlink(self):
        target = self.root / "target.zip"
        target.write_bytes(b"keep me")
        destination = self.out / f"{EDITION}.zip"
        destination.symlink_to(target)
        self.refuse("through a symlink", output=destination)
        self.assertEqual(target.read_bytes(), b"keep me")
        dangling = self.out / "fr3-research-dangling.zip"
        dangling.symlink_to(self.root / "absent.zip")
        self.refuse("through a symlink", output=dangling)
        self.assertFalse((self.root / "absent.zip").exists())

    def test_destination_is_some_other_file(self):
        destination = self.out / "notes.zip"
        destination.write_bytes(b"keep me")
        self.refuse("only a previous fr3-research-*.zip packet is overwritten", output=destination)
        self.assertEqual(destination.read_bytes(), b"keep me")

    def test_destination_inside_the_research_directory(self):
        before = files_under(self.research)
        with self.assertRaisesRegex(ValueError, "inside the research directory"):
            self.package(self.research / "fr3-research-x.zip")
        self.assertEqual(files_under(self.research), before)

    def test_failed_self_check_leaves_no_zip_or_temporary_file(self):
        with mock.patch.object(package_research, "check_zip", side_effect=ValueError("self-check failed")):
            self.refuse("self-check failed")
        destination = self.out / f"{EDITION}.zip"
        destination.write_bytes(b"old packet")
        with mock.patch.object(package_research, "check_zip", side_effect=ValueError("self-check failed")):
            self.refuse("self-check failed")
        self.assertEqual(destination.read_bytes(), b"old packet")

    def test_self_check_rejects_a_tampered_zip(self):
        destination, _, _ = self.package()
        files = {name: (self.research / name).read_bytes() for name in RESEARCH_FILES}
        entries, _ = read_zip(destination)
        tampered = self.root / "tampered.zip"
        cases = {"changed file": (f"{EDITION}/tyres.html", b"changed"),
                 "extra file": (f"{EDITION}/extra.txt", b"extra"),
                 "outside folder": ("elsewhere/tyres.html", b"x")}
        for label, (name, data) in cases.items():
            with self.subTest(label=label):
                with zipfile.ZipFile(tampered, "w") as archive:
                    for entry, content in {**entries, name: data}.items():
                        archive.writestr(entry, content)
                with self.assertRaises(ValueError):
                    package_research.check_zip(tampered, EDITION, files)
        package_research.check_zip(destination, EDITION, files)


class CommandTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def run_script(self, script, *args, env=None):
        return subprocess.run([sys.executable, str(script), *args], capture_output=True, text=True, check=False,
                              timeout=180, env=env)

    def test_packages_a_directory_build_research_built(self):
        research = self.root / "research"
        built = self.run_script(BUILD_SCRIPT, "--game", str(write_game(self.root / "game")), "--output", str(research))
        self.assertEqual(built.returncode, 0, built.stderr)
        env = {**os.environ, "SOURCE_DATE_EPOCH": "1700000000"}
        outputs = []
        for name in ("fr3-research-a.zip", "fr3-research-b.zip"):
            output = self.root / name
            result = self.run_script(SCRIPT, "--research", str(research), "--output", str(output), env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"Packaged and verified {len(RESEARCH_FILES) + 2} files", result.stdout)
            self.assertIn(f"{output} ({output.stat().st_size} bytes)", result.stdout)
            outputs.append(output.read_bytes())
        self.assertEqual(outputs[0], outputs[1])

    def test_fails_loudly_without_a_research_directory(self):
        output = self.root / "fr3-research-x.zip"
        result = self.run_script(SCRIPT, "--research", str(self.root / "absent"), "--output", str(output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("package_research.py: Research directory does not exist", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_help_documents_flags_and_defaults(self):
        result = self.run_script(SCRIPT, "--help")
        self.assertEqual(result.returncode, 0)
        text = " ".join(result.stdout.split())
        self.assertRegex(text, r"--research .*default: [^)]*artifacts/research\)")
        self.assertRegex(text, r"--output .*fr3-research-<short revision>\.zip\)")

    def test_packets_stay_out_of_git(self):
        result = subprocess.run(["git", "-C", str(REPO_ROOT), "check-ignore", "-q",
                                 "artifacts/fr3-research-0123456789ab.zip"], check=False, timeout=30)
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
