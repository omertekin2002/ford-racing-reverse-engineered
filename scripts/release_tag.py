"""Check a pushed v<VERSION> tag and draft its GitHub release from the CI-built Wine packages.

Used by .github/workflows/releases.yml. A draft is only ever created, never published or edited:
publishing stays the owner's click on the Releases page.

    release_tag.py check-tag REF              REF is $GITHUB_REF or a tag name
    release_tag.py check-revision BUILDS SHA  every builds.json entry names commit SHA and is clean
    release_tag.py draft DIR --tag T --sha S --run-url U --repo O/R [--dry-run]

draft checks DIR holds exactly the two archives, SHA256SUMS and builds.json, refuses a tag that already
has any release (draft or published), writes the notes and runs `gh release create --draft --verify-tag`.
--dry-run prints the gh commands and notes instead of running them.
"""
import argparse
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

from build_releases import VERSION

DOCS = ("releases.md", "release-validation.md")


def check_tag(ref, version=None):
    """Return the tag name for a v<version> tag ref or name; raise ValueError naming both values otherwise."""
    version = version or VERSION
    expected = "v" + version
    if ref.startswith("refs/tags/"):
        tag = ref.removeprefix("refs/tags/")
    elif ref.startswith("refs/"):
        raise ValueError(f"{ref} is not a tag; a release needs tag {expected} (VERSION {version} in "
                         "scripts/build_releases.py)")
    else:
        tag = ref
    if not tag.startswith("v"):
        raise ValueError(f"Tag {tag} does not start with v; expected tag {expected} for VERSION {version} in "
                         "scripts/build_releases.py")
    if tag != expected:
        raise ValueError(f"Tag {tag} does not match VERSION {version} in scripts/build_releases.py; expected tag "
                         f"{expected}. Bump VERSION or push the matching tag")
    return tag


def check_revision(builds, sha):
    """Raise ValueError unless every builds.json entry names commit sha and was built from a clean checkout."""
    if not builds:
        raise ValueError("builds.json lists no packages")
    for entry in builds:
        if entry.get("source_revision") != sha:
            raise ValueError(f"{entry.get('path')} was built from {entry.get('source_revision')}, not the tagged "
                             f"commit {sha}")
        if entry.get("dirty") is not False:
            raise ValueError(f"{entry.get('path')} was built from a checkout with uncommitted changes")


def is_prerelease(version=None):
    """A version with a pre-release suffix, such as 0.1.0-preview."""
    return "-" in (version or VERSION)


def release_title(version=None):
    """The release name, as v0.1.0-preview was titled: 0.1.0-preview -> 0.1.0 preview."""
    return f"Ford Racing 3 Demo {(version or VERSION).replace('-', ' ', 1)} (Wine packages)"


def release_assets(directory, builds):
    """The files to attach, in upload order; raise ValueError unless directory holds exactly these."""
    archives = sorted(entry["path"] for entry in builds)
    if sorted(entry.get("platform") for entry in builds) != ["linux", "macos"]:
        raise ValueError("builds.json must list exactly one linux and one macos package")
    assets = [*archives, "SHA256SUMS", "builds.json"]
    present = sorted(path.name for path in Path(directory).iterdir())
    if present != sorted(assets):
        raise ValueError(f"Expected exactly {sorted(assets)} in {directory}, found {present}")
    return [Path(directory) / name for name in assets]


def release_notes(builds, tag, repository, run_url):
    """Markdown notes for the draft, generated from builds.json."""
    lines = [
        "Wine compatibility packages that run the original, unchanged **public Windows demo** of Ford Racing 3 "
        "on Linux and macOS. They are not a native port, and the retail game is not included.",
        "",
        "| Package | Platform | Bytes | Manifest files |",
        "|---|---|---:|---:|",
    ]
    for entry in sorted(builds, key=lambda e: e["platform"]):
        lines.append(f"| `{entry['path']}` | {entry['platform']} | {entry['bytes']:,} | {entry['manifest_files']:,} |")
    revisions = sorted({entry["source_revision"] for entry in builds})
    lines += [
        "",
        f"Built from commit `{', '.join(revisions)}` by [this workflow run]({run_url}), which checked "
        "`sha256sum -c SHA256SUMS`, re-verified both archives against their manifests and ran the Linux "
        "package's `./launch.sh --verify` before upload. `SHA256SUMS` holds the archive checksums and "
        "`builds.json` each package's build metadata.",
    ]
    if any(entry.get("macos_signed") is False for entry in builds):
        lines += ["", "The macOS package is unsigned and not notarized."]
    base = f"https://github.com/{repository}/blob/{tag}/docs"
    lines += ["", f"Install, requirements and troubleshooting: [`docs/{DOCS[0]}`]({base}/{DOCS[0]}). "
                  f"What was tested: [`docs/{DOCS[1]}`]({base}/{DOCS[1]})."]
    return "\n".join(lines) + "\n"


def refuse_existing(tag, existing_tags):
    """Raise ValueError if any release, draft or published, already uses tag."""
    if tag in existing_tags:
        raise ValueError(f"A release for {tag} already exists (draft or published); it was left unchanged. "
                         "Delete it on the Releases page, or bump VERSION and push a new tag")


def list_command(repository):
    """Every release's tag name, drafts included (they are visible to a token with contents: write)."""
    return ["gh", "api", "--paginate", f"repos/{repository}/releases", "--jq", ".[].tag_name"]


def create_command(tag, assets, notes_file, repository, version=None):
    """The gh release create argv. It always creates a draft and never publishes."""
    command = ["gh", "release", "create", tag, "--repo", repository, "--draft", "--verify-tag",
               "--title", release_title(version), "--notes-file", str(notes_file)]
    if is_prerelease(version):
        command.append("--prerelease")
    return [*command, *(str(asset) for asset in assets)]


def draft(args):
    tag = check_tag(args.tag)
    builds = json.loads((args.directory / "builds.json").read_text())
    check_revision(builds, args.sha)
    assets = release_assets(args.directory, builds)
    notes = release_notes(builds, tag, args.repo, args.run_url)
    listing = list_command(args.repo)
    if args.dry_run:
        print("Would refuse an existing release for", tag, "found by:", shlex.join(listing))
    else:
        found = subprocess.run(listing, capture_output=True, text=True, check=True, timeout=120).stdout
        refuse_existing(tag, set(found.split()))
    with tempfile.TemporaryDirectory(prefix="fr3-release-notes-") as work:
        notes_file = Path(work) / "notes.md"
        notes_file.write_text(notes)
        command = create_command(tag, assets, notes_file, args.repo)
        if args.dry_run:
            print("Would run:", shlex.join(command))
            print("--- notes ---")
            print(notes, end="")
            return
        subprocess.run(command, check=True, timeout=1800)
    print(f"Created draft release {tag}; review it and press Publish on the Releases page.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    tag_parser = commands.add_parser("check-tag", help="Check a tag ref or name against VERSION")
    tag_parser.add_argument("ref")
    revision_parser = commands.add_parser("check-revision", help="Check builds.json names the given commit")
    revision_parser.add_argument("builds", type=Path)
    revision_parser.add_argument("sha")
    draft_parser = commands.add_parser("draft", help="Create a draft release from a verified package directory")
    draft_parser.add_argument("directory", type=Path)
    draft_parser.add_argument("--tag", required=True)
    draft_parser.add_argument("--sha", required=True)
    draft_parser.add_argument("--run-url", required=True)
    draft_parser.add_argument("--repo", required=True, help="owner/name")
    draft_parser.add_argument("--dry-run", action="store_true", help="Print the gh commands and notes; run nothing")
    args = parser.parse_args(argv)
    try:
        if args.command == "check-tag":
            print(f"Tag {check_tag(args.ref)} matches VERSION {VERSION}")
        elif args.command == "check-revision":
            check_revision(json.loads(args.builds.read_text()), args.sha)
            print(f"builds.json names the tagged commit {args.sha}")
        else:
            draft(args)
    except ValueError as error:
        sys.exit(f"error: {error}")


if __name__ == "__main__":
    main()
