"""Synthetic release-archive tests: small fake package trees, no downloads, no Wine and no demo files."""
import ast
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import warnings
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from build_releases import manifest, package_metadata, source_identity, tar_tree, verify_archive, write_results, zip_tree

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
GIT = ("git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
       "-c", "init.defaultBranch=main")
LINUX = "ford-racing-3-demo-test-linux-x86_64"
MACOS = "ford-racing-3-demo-test-macos"
BUNDLE = "Ford Racing 3 Demo.app"


def git(repo, *args):
    return subprocess.run([*GIT, "-C", str(repo), *args], capture_output=True, text=True, check=True,
                          timeout=60).stdout.strip()


def write(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    path.chmod(mode)
    return path


def fill_resources(resources):
    """The files launch.sh, game/ and runtime/ hold in a real package, in miniature."""
    write(resources / "launch.sh", "#!/bin/bash\nexit 0\n", 0o755)
    write(resources / "game/fr3.exe", b"MZ fixture executable")
    write(resources / "game/DATA/track.bin", bytes(range(256)))
    write(resources / "runtime/bin/wine", "#!/bin/sh\n", 0o755)
    write(resources / "runtime/lib/libwine.so.1.0", b"\x7fELF fixture")
    (resources / "runtime/lib/libwine.so.1").symlink_to("libwine.so.1.0")
    write(resources / "BUILD.json", json.dumps({"version": "test"}) + "\n")


def linux_package(root, name=LINUX):
    package = root / name
    fill_resources(package)
    write(package / "README.md", "readme\n")
    return package, package


def macos_package(root, executable="ford-racing-3"):
    package = root / MACOS
    contents = package / BUNDLE / "Contents"
    write(contents / "MacOS/ford-racing-3", "#!/bin/bash\nexit 0\n", 0o755)
    write(contents / "Info.plist", plistlib.dumps({"CFBundleExecutable": executable}))
    write(contents / "PkgInfo", b"APPL????")
    fill_resources(contents / "Resources")
    write(package / "README.md", "readme\n")
    return package, contents / "Resources"


class TemporaryDirectoryTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)


class ManifestTests(TemporaryDirectoryTestCase):
    def test_lists_every_regular_file_except_itself(self):
        package, resources = linux_package(self.root)
        expected = sorted(p.relative_to(resources).as_posix() for p in resources.rglob("*")
                          if p.is_file() and not p.is_symlink())
        self.assertEqual(manifest(resources), len(expected))
        # Running it again over a tree that already holds MANIFEST.sha256 must not list the manifest.
        self.assertEqual(manifest(resources), len(expected))
        lines = (resources / "MANIFEST.sha256").read_text().splitlines()
        self.assertEqual([line.split("  ", 1)[1] for line in lines], expected)
        for line in lines:
            digest, relative = line.split("  ", 1)
            self.assertEqual(digest, hashlib.sha256((resources / relative).read_bytes()).hexdigest())

    def test_records_in_tree_symlink_without_hashing_it_as_a_file(self):
        package, resources = linux_package(self.root)
        manifest(resources)
        listed = [line.split("  ", 1)[1] for line in (resources / "MANIFEST.sha256").read_text().splitlines()]
        self.assertTrue((resources / "runtime/lib/libwine.so.1").is_symlink())
        self.assertNotIn("runtime/lib/libwine.so.1", listed)
        self.assertEqual(listed.count("runtime/lib/libwine.so.1.0"), 1)

    def test_refuses_symlink_that_escapes_the_tree(self):
        package, resources = linux_package(self.root)
        write(self.root / "outside.txt", "outside\n")
        (resources / "runtime/escape").symlink_to("../../outside.txt")
        self.assertTrue((resources / "runtime/escape").exists())
        with self.assertRaisesRegex(ValueError, "Invalid runtime symlink"):
            manifest(resources)

    def test_refuses_absolute_symlink_out_of_the_tree(self):
        package, resources = linux_package(self.root)
        outside = write(self.root / "outside.txt", "outside\n")
        (resources / "runtime/escape").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "Invalid runtime symlink"):
            manifest(resources)

    def test_refuses_dangling_symlink(self):
        package, resources = linux_package(self.root)
        (resources / "runtime/lib/missing.so").symlink_to("not-there.so")
        with self.assertRaisesRegex(ValueError, "Invalid runtime symlink"):
            manifest(resources)


class DeterminismTests(TemporaryDirectoryTestCase):
    def identical_trees(self, build):
        (first, first_resources), (second, second_resources) = build(self.root / "one"), build(self.root / "two")
        manifest(first_resources)
        manifest(second_resources)
        # Different modification times must not reach the archive.
        for path in second.rglob("*"):
            os.utime(path, (1_000_000_000, 1_000_000_000), follow_symlinks=False)
        return first, second

    def test_tar_tree_is_byte_identical_across_runs(self):
        first, second = self.identical_trees(linux_package)
        tar_tree(first, self.root / "one.tar.gz")
        tar_tree(second, self.root / "two.tar.gz")
        tar_tree(first, self.root / "again.tar.gz")
        data = (self.root / "one.tar.gz").read_bytes()
        self.assertEqual(data, (self.root / "two.tar.gz").read_bytes())
        self.assertEqual(data, (self.root / "again.tar.gz").read_bytes())
        with tarfile.open(self.root / "one.tar.gz") as archive:
            for entry in archive.getmembers():
                self.assertEqual((entry.mtime, entry.uid, entry.gid, entry.uname, entry.gname), (0, 0, 0, "", ""))

    def test_zip_tree_is_byte_identical_across_runs(self):
        first, second = self.identical_trees(macos_package)
        zip_tree(first, self.root / "one.zip")
        zip_tree(second, self.root / "two.zip")
        zip_tree(first, self.root / "again.zip")
        data = (self.root / "one.zip").read_bytes()
        self.assertEqual(data, (self.root / "two.zip").read_bytes())
        self.assertEqual(data, (self.root / "again.zip").read_bytes())

    def test_archives_keep_launch_modes_and_symlinks(self):
        package, resources = linux_package(self.root / "linux")
        manifest(resources)
        tar_tree(package, self.root / "linux.tar.gz")
        with tarfile.open(self.root / "linux.tar.gz") as archive:
            self.assertEqual(archive.getmember(f"{LINUX}/launch.sh").mode & 0o777, 0o755)
            link = archive.getmember(f"{LINUX}/runtime/lib/libwine.so.1")
            self.assertTrue(link.issym())
            self.assertEqual(link.linkname, "libwine.so.1.0")
        package, resources = macos_package(self.root / "macos")
        manifest(resources)
        zip_tree(package, self.root / "macos.zip")
        with zipfile.ZipFile(self.root / "macos.zip") as archive:
            mode = archive.getinfo(f"{MACOS}/{BUNDLE}/Contents/MacOS/ford-racing-3").external_attr >> 16
            self.assertEqual(stat.S_IMODE(mode), 0o755)
            name = f"{MACOS}/{BUNDLE}/Contents/Resources/runtime/lib/libwine.so.1"
            self.assertTrue(stat.S_ISLNK(archive.getinfo(name).external_attr >> 16))
            self.assertEqual(archive.read(name), b"libwine.so.1.0")


class VerifyArchiveTests(TemporaryDirectoryTestCase):
    """Each rejection builds an archive that is good except for one defect, and expects that defect's error."""

    def linux(self, change=None):
        package, resources = linux_package(self.root / "linux")
        manifest(resources)
        if change:
            change(package, resources)
        output = self.root / "linux.tar.gz"
        tar_tree(package, output)
        return output

    def macos(self, change=None, executable="ford-racing-3"):
        package, resources = macos_package(self.root / "macos", executable)
        manifest(resources)
        if change:
            change(package, resources)
        output = self.root / "macos.zip"
        zip_tree(package, output)
        return output

    def both(self, change=None):
        return [self.linux(change), self.macos(change)]

    def assertRejected(self, archive, message):
        with self.assertRaisesRegex(ValueError, message):
            verify_archive(archive)

    def test_accepts_good_tar_and_zip(self):
        for archive in self.both():
            with self.subTest(archive=archive.name):
                verify_archive(archive)

    def test_rejects_payload_changed_after_manifest(self):
        def change(package, resources):
            data = bytearray((resources / "game/DATA/track.bin").read_bytes())
            data[7] ^= 1
            (resources / "game/DATA/track.bin").write_bytes(bytes(data))
        for archive in self.both(change):
            with self.subTest(archive=archive.name):
                self.assertRejected(archive, "Archive payload mismatch: game/DATA/track.bin")

    def test_rejects_missing_manifest(self):
        for archive in self.both(lambda package, resources: (resources / "MANIFEST.sha256").unlink()):
            with self.subTest(archive=archive.name):
                self.assertRejected(archive, "Expected one payload manifest, found 0")

    def test_rejects_second_manifest_in_the_package(self):
        def change(package, resources):
            shutil.copyfile(resources / "MANIFEST.sha256", resources / "game/MANIFEST.sha256")
        for archive in self.both(change):
            with self.subTest(archive=archive.name):
                self.assertRejected(archive, "Expected one payload manifest, found 2")

    def test_rejects_repeated_manifest_member_in_tar(self):
        archive = self.linux()
        name = f"{LINUX}/MANIFEST.sha256"
        with tarfile.open(archive) as source:
            entries = [(entry, source.extractfile(entry).read() if entry.isreg() else None)
                       for entry in source.getmembers()]
        manifest_entry, data = next((e, d) for e, d in entries if e.name == name)
        with tarfile.open(archive, "w:gz") as target:
            for entry, content in [*entries, (manifest_entry, data)]:
                target.addfile(entry, io.BytesIO(content) if content is not None else None)
        self.assertRejected(archive, "Archive repeats member names: " + name)

    def test_rejects_repeated_manifest_member_in_zip(self):
        archive = self.macos()
        name = f"{MACOS}/{BUNDLE}/Contents/Resources/MANIFEST.sha256"
        with zipfile.ZipFile(archive) as source:
            info, data = source.getinfo(name), source.read(name)
        with warnings.catch_warnings(), zipfile.ZipFile(archive, "a") as target:
            warnings.simplefilter("ignore")
            target.writestr(info, data)
        self.assertRejected(archive, "Archive repeats member names: " + name)

    def test_rejects_manifest_file_missing_from_archive(self):
        for archive in self.both(lambda package, resources: (resources / "game/fr3.exe").unlink()):
            with self.subTest(archive=archive.name):
                self.assertRejected(archive, "Archive is missing a manifest file: game/fr3.exe")

    def test_rejects_malformed_manifest_line(self):
        def change(package, resources):
            with (resources / "MANIFEST.sha256").open("a") as stream:
                stream.write("not-a-digest game/fr3.exe\n")
        for archive in self.both(change):
            with self.subTest(archive=archive.name):
                self.assertRejected(archive, "Malformed payload manifest line")

    def test_rejects_launch_sh_without_execute_bit(self):
        for archive in self.both(lambda package, resources: (resources / "launch.sh").chmod(0o644)):
            with self.subTest(archive=archive.name):
                self.assertRejected(archive, "Launcher lost execute permission: .*/launch.sh")

    def test_rejects_macos_launcher_without_execute_bit(self):
        def change(package, resources):
            (resources.parent / "MacOS/ford-racing-3").chmod(0o644)
        self.assertRejected(self.macos(change), "Launcher lost execute permission: .*/MacOS/ford-racing-3")

    def test_rejects_archive_without_launch_sh(self):
        def change(package, resources):
            (resources / "launch.sh").unlink()
            manifest(resources)
        for archive in self.both(change):
            with self.subTest(archive=archive.name):
                self.assertRejected(archive, "Archive has no launch.sh")

    def test_rejects_absolute_zip_symlink(self):
        def change(package, resources):
            (resources / "runtime/lib/absolute.so").symlink_to("/usr/lib/absolute.so")
        self.assertRejected(self.macos(change), "Absolute ZIP symlink")

    def test_rejects_bundle_executable_missing_from_bundle(self):
        self.assertRejected(self.macos(executable="not-in-bundle"), "macOS bundle executable missing: not-in-bundle")

    def test_rejects_info_plist_without_bundle_executable(self):
        def change(package, resources):
            (resources.parent / "Info.plist").write_bytes(plistlib.dumps({"CFBundleName": "Ford Racing 3 Demo"}))
        self.assertRejected(self.macos(change), "macOS Info.plist names no CFBundleExecutable")

    def test_ignores_bundles_inside_the_wine_runtime(self):
        def change(package, resources):
            inner = resources / "runtime/share/Helper.app/Contents/Info.plist"
            write(inner, plistlib.dumps({"CFBundleName": "upstream helper"}))
            manifest(resources)
        verify_archive(self.macos(change))

    def test_checks_are_not_asserts(self):
        # python -O drops assert statements; every archive check must raise on its own.
        tree = ast.parse((SCRIPTS / "build_releases.py").read_text())
        self.assertEqual([node.lineno for node in ast.walk(tree) if isinstance(node, ast.Assert)], [])


class SourceIdentityTests(TemporaryDirectoryTestCase):
    def setUp(self):
        super().setUp()
        self.repo = self.root / "repo"
        write(self.repo / "scripts/build.py", "print('build')\n")
        write(self.repo / ".gitignore", "inputs/\nartifacts/\n")
        git(self.repo, "init", "-q")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "fixture")
        self.revision = git(self.repo, "rev-parse", "HEAD")

    def test_clean_checkout_names_its_commit(self):
        self.assertEqual(source_identity(self.repo), (self.revision, False))
        self.assertRegex(self.revision, r"^[0-9a-f]{40,64}$")

    def test_ignored_files_leave_the_tree_clean(self):
        write(self.repo / "inputs/fr3.exe", b"demo")
        write(self.repo / "artifacts/releases/SHA256SUMS", "")
        self.assertEqual(source_identity(self.repo), (self.revision, False))

    def test_refuses_modified_tracked_file(self):
        write(self.repo / "scripts/build.py", "print('changed')\n")
        with self.assertRaisesRegex(ValueError, "uncommitted changes.*--allow-dirty"):
            source_identity(self.repo)
        self.assertEqual(source_identity(self.repo, allow_dirty=True), (self.revision, True))

    def test_refuses_untracked_file(self):
        write(self.repo / "scripts/extra.py", "")
        with self.assertRaisesRegex(ValueError, "uncommitted changes"):
            source_identity(self.repo)
        self.assertEqual(source_identity(self.repo, allow_dirty=True), (self.revision, True))

    def test_refuses_tree_that_is_not_a_git_checkout(self):
        plain = self.root / "plain"
        write(plain / "scripts/build.py", "")
        with self.assertRaisesRegex(ValueError, "not a Git checkout"):
            source_identity(plain)
        self.assertEqual(source_identity(plain, allow_dirty=True), (None, True))

    def test_refuses_subdirectory_of_another_checkout(self):
        with self.assertRaisesRegex(ValueError, "not a Git checkout"):
            source_identity(self.repo / "scripts")

    def test_refuses_checkout_without_commits(self):
        empty = self.root / "empty"
        empty.mkdir()
        git(empty, "init", "-q")
        with self.assertRaisesRegex(ValueError, "not a Git checkout with a commit"):
            source_identity(empty)
        self.assertEqual(source_identity(empty, allow_dirty=True), (None, True))


class BuildCommandTests(TemporaryDirectoryTestCase):
    """Run build_releases.py from a fixture checkout; it stops at the missing demo, after the revision check."""

    def setUp(self):
        super().setUp()
        self.repo = self.root / "repo"
        for name in ("build_releases.py", "fr3_common.py", "setup_release_tools.py", "setup_tools.py"):
            write(self.repo / "scripts" / name, (SCRIPTS / name).read_bytes())
        write(self.repo / ".gitignore", "__pycache__/\nartifacts/\n")
        git(self.repo, "init", "-q")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "fixture")

    def run_build(self, *args):
        return subprocess.run([sys.executable, "scripts/build_releases.py", "--cache", str(self.root / "cache"),
                               "--runtime-root", str(self.root / "runtime"), *args],
                              cwd=self.repo, capture_output=True, text=True, timeout=60, check=False)

    def test_dirty_checkout_is_refused_before_anything_is_written(self):
        with (self.repo / "scripts/build_releases.py").open("a") as stream:
            stream.write("# local edit\n")
        result = self.run_build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("uncommitted changes", result.stderr)
        self.assertFalse((self.repo / "artifacts").exists())
        self.assertFalse((self.root / "cache").exists())

    def test_clean_or_allowed_checkout_reaches_the_demo_check(self):
        for args in ((), ("--allow-dirty",)):
            with self.subTest(args=args):
                if args:
                    write(self.repo / "scripts/untracked.py", "")
                result = self.run_build(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("uncommitted changes", result.stderr)
                self.assertIn("fr3.exe", result.stderr)
                self.assertTrue((self.repo / "artifacts/releases").is_dir())


class ResultsTests(TemporaryDirectoryTestCase):
    def result(self, platform, revision="a" * 40, dirty=False):
        metadata = package_metadata(platform, 773, f"https://example.invalid/{platform}.tar.xz", "0" * 64,
                                    revision, dirty)
        name = f"package-{platform}.bin"
        return {"path": name, "sha256": hashlib.sha256(name.encode()).hexdigest(), "bytes": 1, "manifest_files": 5,
                **metadata}

    def test_package_metadata_names_the_source(self):
        metadata = package_metadata("linux", 773, "https://example.invalid/wine.tar.xz", "0" * 64, "b" * 40, False)
        self.assertEqual((metadata["source_revision"], metadata["dirty"]), ("b" * 40, False))
        self.assertIs(package_metadata("macos", 773, "u", "0" * 64, None, True)["dirty"], True)
        self.assertEqual(metadata["package_type"], "Wine compatibility preview")
        self.assertIs(metadata["native_source_port"], False)

    def test_builds_json_and_sha256sums_cover_every_package(self):
        results = write_results(self.root, [self.result("macos"), self.result("linux")])
        recorded = json.loads((self.root / "builds.json").read_text())
        self.assertEqual(recorded, results)
        self.assertEqual([r["platform"] for r in recorded], ["linux", "macos"])
        for entry in recorded:
            self.assertEqual(entry["source_revision"], "a" * 40)
            self.assertIs(entry["dirty"], False)
        self.assertEqual((self.root / "SHA256SUMS").read_text(),
                         "".join(f'{r["sha256"]}  {r["path"]}\n' for r in recorded))

    def test_single_platform_rebuild_keeps_other_entry_only_if_it_names_a_source(self):
        write_results(self.root, [self.result("macos", revision="c" * 40)])
        recorded = write_results(self.root, [self.result("linux")])
        self.assertEqual([(r["platform"], r["source_revision"]) for r in recorded],
                         [("linux", "a" * 40), ("macos", "c" * 40)])
        legacy = {key: value for key, value in self.result("macos").items() if key not in ("source_revision", "dirty")}
        (self.root / "builds.json").write_text(json.dumps([legacy]))
        recorded = write_results(self.root, [self.result("linux")])
        self.assertEqual([r["platform"] for r in recorded], ["linux"])
        self.assertEqual(len((self.root / "SHA256SUMS").read_text().splitlines()), 1)


if __name__ == "__main__":
    unittest.main()
