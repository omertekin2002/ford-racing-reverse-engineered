"""Tag checks and draft-release generation for releases.yml, from synthetic builds.json files. Nothing calls GitHub."""
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
import release_tag
from build_releases import VERSION, package_metadata
from release_tag import (check_revision, check_tag, create_command, is_prerelease, refuse_existing, release_assets,
                         release_notes, release_title)

SHA = "a" * 40
REPO = "owner/repo"
RUN = "https://github.com/owner/repo/actions/runs/1"
WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/releases.yml"


def builds(revision=SHA, dirty=False, version="1.2.0-preview"):
    entries = []
    for platform, suffix, size in (("macos", "macos.zip", 2_000_000), ("linux", "linux-x86_64.tar.gz", 1_234_567)):
        metadata = package_metadata(platform, 773, f"https://example.invalid/{platform}.tar.xz", "0" * 64,
                                    revision, dirty)
        entries.append({"path": f"ford-racing-3-demo-{version}-{suffix}", "sha256": "1" * 64, "bytes": size,
                        "manifest_files": 1500, **metadata})
    return entries


class TagTests(unittest.TestCase):
    def test_matching_tag_ref_or_name(self):
        self.assertEqual(check_tag("refs/tags/v1.2.0-preview", "1.2.0-preview"), "v1.2.0-preview")
        self.assertEqual(check_tag("v1.2.0", "1.2.0"), "v1.2.0")
        self.assertEqual(check_tag(f"refs/tags/v{VERSION}"), f"v{VERSION}")

    def test_mismatch_names_both_values(self):
        with self.assertRaises(ValueError) as caught:
            check_tag("refs/tags/v0.2.0", "0.1.0-preview")
        self.assertIn("v0.2.0", str(caught.exception))
        self.assertIn("0.1.0-preview", str(caught.exception))
        self.assertIn("v0.1.0-preview", str(caught.exception))

    def test_tag_without_v(self):
        for ref in ("refs/tags/0.1.0-preview", "0.1.0-preview", "wine-web-fs-v14"):
            with self.subTest(ref=ref), self.assertRaisesRegex(ValueError, "does not start with v.*0.1.0-preview"):
                check_tag(ref, "0.1.0-preview")

    def test_non_tag_refs(self):
        for ref in ("refs/heads/main", "refs/heads/v0.1.0-preview", "refs/pull/7/merge"):
            with self.subTest(ref=ref), self.assertRaisesRegex(ValueError, "is not a tag.*v0.1.0-preview"):
                check_tag(ref, "0.1.0-preview")

    def test_cli_exits_nonzero_naming_both(self):
        result = subprocess.run([sys.executable, str(Path(release_tag.__file__)), "check-tag", "refs/tags/v9.9.9"],
                                capture_output=True, text=True, timeout=60)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("v9.9.9", result.stderr)
        self.assertIn(VERSION, result.stderr)


class RevisionTests(unittest.TestCase):
    def test_matching_clean_build(self):
        check_revision(builds(), SHA)

    def test_other_commit_dirty_or_empty(self):
        with self.assertRaisesRegex(ValueError, "not the tagged commit " + SHA):
            check_revision(builds(revision="b" * 40), SHA)
        with self.assertRaisesRegex(ValueError, "not the tagged commit"):
            check_revision(builds(revision=None), SHA)
        with self.assertRaisesRegex(ValueError, "uncommitted"):
            check_revision(builds(dirty=True), SHA)
        with self.assertRaisesRegex(ValueError, "no packages"):
            check_revision([], SHA)


class ReleaseTextTests(unittest.TestCase):
    def test_title_follows_the_existing_release(self):
        self.assertEqual(release_title("0.1.0-preview"), "Ford Racing 3 Demo 0.1.0 preview (Wine packages)")
        self.assertEqual(release_title("1.0.0"), "Ford Racing 3 Demo 1.0.0 (Wine packages)")

    def test_prerelease_only_with_a_suffix(self):
        self.assertTrue(is_prerelease("0.1.0-preview"))
        self.assertFalse(is_prerelease("1.0.0"))

    def test_notes_from_builds_json(self):
        notes = release_notes(builds(), "v1.2.0-preview", REPO, RUN)
        self.assertIn("| `ford-racing-3-demo-1.2.0-preview-linux-x86_64.tar.gz` | linux | 1,234,567 | 1,500 |", notes)
        self.assertIn("| `ford-racing-3-demo-1.2.0-preview-macos.zip` | macos | 2,000,000 | 1,500 |", notes)
        self.assertLess(notes.index("linux-x86_64"), notes.index("macos.zip"))
        self.assertIn(f"commit `{SHA}`", notes)
        self.assertIn(f"]({RUN})", notes)
        self.assertIn(f"https://github.com/{REPO}/blob/v1.2.0-preview/docs/releases.md", notes)
        self.assertIn("unsigned and not notarized", notes)


class AssetTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.builds = builds()
        for name in [*(entry["path"] for entry in self.builds), "SHA256SUMS", "builds.json"]:
            (self.root / name).write_text("x")

    def test_exactly_the_archives_sums_and_builds_json(self):
        assets = [path.name for path in release_assets(self.root, self.builds)]
        self.assertEqual(assets, ["ford-racing-3-demo-1.2.0-preview-linux-x86_64.tar.gz",
                                  "ford-racing-3-demo-1.2.0-preview-macos.zip", "SHA256SUMS", "builds.json"])

    def test_extra_or_missing_files_are_refused(self):
        (self.root / "notes.md").write_text("x")
        with self.assertRaisesRegex(ValueError, "Expected exactly"):
            release_assets(self.root, self.builds)
        (self.root / "notes.md").unlink()
        (self.root / "SHA256SUMS").unlink()
        with self.assertRaisesRegex(ValueError, "Expected exactly"):
            release_assets(self.root, self.builds)

    def test_both_platforms_required(self):
        with self.assertRaisesRegex(ValueError, "one linux and one macos"):
            release_assets(self.root, self.builds[:1])

    def test_create_command_is_a_draft_that_needs_the_tag(self):
        assets = release_assets(self.root, self.builds)
        command = create_command("v1.2.0-preview", assets, "notes.md", REPO, "1.2.0-preview")
        self.assertEqual(command[:4], ["gh", "release", "create", "v1.2.0-preview"])
        self.assertIn("--draft", command)
        self.assertIn("--verify-tag", command)
        self.assertIn("--prerelease", command)
        self.assertEqual(command[command.index("--title") + 1], "Ford Racing 3 Demo 1.2.0 preview (Wine packages)")
        self.assertEqual(command[-4:], [str(path) for path in assets])
        self.assertNotIn("--prerelease", create_command("v1.0.0", assets, "notes.md", REPO, "1.0.0"))
        self.assertFalse(any(arg.startswith("--draft=") for arg in command))

    def test_existing_release_is_refused(self):
        refuse_existing("v1.2.0-preview", {"v0.1.0-preview", "wine-web-fs-v14"})
        with self.assertRaisesRegex(ValueError, "already exists.*left unchanged"):
            refuse_existing("v0.1.0-preview", {"v0.1.0-preview", "wine-web-fs-v14"})

    def draft(self, *extra):
        (self.root / "builds.json").write_text(json.dumps(self.builds))
        argv = ["draft", str(self.root), "--tag", "v1.2.0-preview", "--sha", SHA, "--repo", REPO, "--run-url", RUN,
                *extra]
        output = io.StringIO()
        with mock.patch.object(release_tag, "VERSION", "1.2.0-preview"), contextlib.redirect_stdout(output):
            release_tag.main(argv)
        return output.getvalue()

    def test_dry_run_prints_the_command_and_runs_nothing(self):
        with mock.patch.object(release_tag.subprocess, "run") as run:
            output = self.draft("--dry-run")
        run.assert_not_called()
        self.assertIn("Would run: gh release create v1.2.0-preview --repo owner/repo --draft --verify-tag", output)
        self.assertIn("--prerelease", output)
        self.assertIn("--- notes ---", output)

    def test_draft_lists_releases_first_and_stops_on_an_existing_one(self):
        listing = subprocess.CompletedProcess([], 0, stdout="v0.1.0-preview\nv1.2.0-preview\n")
        with mock.patch.object(release_tag.subprocess, "run", return_value=listing) as run, \
                self.assertRaises(SystemExit) as caught:
            self.draft()
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][:2], ["gh", "api"])
        self.assertIn("already exists", str(caught.exception.code))

    def test_draft_creates_when_the_tag_is_free(self):
        listing = subprocess.CompletedProcess([], 0, stdout="v0.1.0-preview\nwine-web-fs-v14\n")
        with mock.patch.object(release_tag.subprocess, "run", return_value=listing) as run:
            self.draft()
        self.assertEqual(run.call_count, 2)
        create = run.call_args.args[0]
        self.assertEqual(create[:4], ["gh", "release", "create", "v1.2.0-preview"])
        self.assertIn("--draft", create)


class WorkflowTests(unittest.TestCase):
    """Static checks on releases.yml: write access and publishing stay out of every other path."""

    def setUp(self):
        self.text = WORKFLOW.read_text()

    def test_only_the_draft_job_can_write(self):
        self.assertEqual(self.text.count("contents: write"), 1)
        draft = self.text[self.text.index("  draft-release:"):]
        self.assertIn("contents: write", draft)
        self.assertIn("if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')", draft)
        self.assertIn("needs: build", draft)

    def test_nothing_publishes_or_pushes(self):
        for forbidden in ("--draft=false", "release edit", "git push", "git tag", "release upload", "release delete"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, self.text)


if __name__ == "__main__":
    unittest.main()
