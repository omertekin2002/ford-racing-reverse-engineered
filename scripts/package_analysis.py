"""Package a layered, deterministic reproduction bundle of the analysis, recording the verification levels performed.

Run it after scripts/acquire_demo.py and scripts/build_research.py, at a clean commit. It writes one ZIP, default
artifacts/fr3-analysis-<short revision>.zip, holding a single folder fr3-analysis-<short revision>/ with:

  source          README.md, ruff.toml and the tracked files under scripts/, tests/, recovered/, docs/ and
                  analysis/, read from Git at the producer revision; any uncommitted or untracked change under
                  those paths refuses the build
  text-databases/ engines.json, gearboxes.json, tyres.json, cars.json and brakes.json, regenerated with
                  text_database.write_databases() from the extracted demo
  research/       the research directory from build_research.py, unchanged, after package_research.read_research()
                  has checked it against a fresh build at the producer revision
  artifacts/      only when the Ghidra outputs exist and match the committed analysis/verification.json:
                  artifacts/ghidra/ (the baseline export) and artifacts/fr3-demo-annotated.gzf
  MANIFEST.json   the input build, producer revision, Python, zlib, pefile and capstone versions, each verification
                  level (read, data, instructions, full) as performed or unavailable with the checks run and their
                  counts, and each packaged file's path, size and SHA-256
  SHA256SUMS      every other file, so `sha256sum -c SHA256SUMS` passes inside the extracted folder

Levels:
  read          the research pages: package_research.read_research()
  data          verify_findings.py --level data, run in-process on the acquired demo
  instructions  verify_findings.py --level instructions, run in-process on inputs/fr3.exe
  full          performed only in the sense that the Ghidra outputs' hashes match the committed verification
                record; Ghidra is not re-run. Missing outputs leave the level unavailable, naming the missing paths
                and the recovery commands. A present output whose hash differs from the record refuses the build.

Never packaged: inputs/ (demo archive, extraction, fr3.exe), decoded resources, artifacts/pe/, artifacts/logs/ and
Ghidra project directories. The ZIP is deterministic: sorted entries, mode 0644, one timestamp (SOURCE_DATE_EPOCH if
set, otherwise 1980-01-01). It is written to a temporary file, reopened and re-hashed against both manifests, then
renamed into place; only a previous fr3-analysis-*.zip is overwritten. It holds game data: keep it out of Git.

Exit codes: 0 packaged; 1 a check failed or the build was refused; 3 the demo or research directory is missing.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile
import zlib

import build_research
from fr3_common import ARCHIVE_SHA256, ARCHIVE_SIZE
import package_research
from package_research import MANIFEST, SUMS, check_destination, sha256
from text_database import REPO_ROOT, load_known_tags, require, write_databases
import verify_findings
from verify_findings import CheckFailed

EXIT_FAILED = verify_findings.EXIT_FAILED
EXIT_UNAVAILABLE = verify_findings.EXIT_UNAVAILABLE
# Tracked paths packaged from Git at the producer revision.
SOURCE_PATHS = ("README.md", "ruff.toml", "scripts", "tests", "recovered", "docs", "analysis")
DATABASES_DIR = "text-databases"
RESEARCH_DIR = "research"
BUNDLE_NAME = re.compile(r"fr3-analysis-.+\.zip")
BUNDLE_KIND = "fr3-analysis-*.zip bundle"
GHIDRA_SNAPSHOT = verify_findings.GHIDRA_SNAPSHOT.path
GHIDRA_C = verify_findings.GHIDRA_C.path
GHIDRA_STATUS = verify_findings.GHIDRA_STATUS.path
# Every file ExportFord.java writes into artifacts/ghidra/; nothing else under artifacts/ is packaged.
GHIDRA_EXPORTS = ("artifacts/ghidra/calls.tsv", GHIDRA_C, "artifacts/ghidra/disassembly.txt",
                  "artifacts/ghidra/functions.tsv", GHIDRA_STATUS)
GHIDRA_FILES = (*GHIDRA_EXPORTS, GHIDRA_SNAPSHOT)
TOOLS_PYTHON = '"${FR3_TOOLS:-${XDG_DATA_HOME:-$HOME/.local/share}/fr3-tools}"/venv/bin/python'
# The full verification rewrites analysis/verification.json, which the bundle refuses uncommitted, and the research
# pages name the commit they were built at: commit analysis/ before rebuilding them.
FULL_RECOVERY = ("python3 scripts/setup_tools.py", f"{TOOLS_PYTHON} scripts/run_analysis.py",
                 f"{TOOLS_PYTHON} scripts/verify_findings.py .", "git add analysis && git commit",
                 "python3 scripts/build_research.py", "python3 scripts/package_analysis.py")
# Paths and names that must never be packaged, whatever produced them.
EXCLUDED_PREFIXES = ("inputs/", "artifacts/pe/", "artifacts/logs/", "artifacts/unpacked/", "artifacts/project/",
                     "artifacts/verification-project/")
EXCLUDED_SUFFIXES = (".exe", ".dll", ".gpr", ".rep", ".lock")
LEVEL_SUMMARIES = {
    "read": "research pages checked by package_research.read_research(): only build_research.py's files, the "
            "rights-holder notice, no script or external resource, links resolving, evidence identical to the "
            "committed analysis/ files, and every page identical to a fresh build at the producer revision",
    "data": "verify_findings.py --level data, run in-process on the acquired demo",
    "instructions": "verify_findings.py --level instructions, run in-process on inputs/fr3.exe",
    "full": "the packaged Ghidra outputs match the committed analysis/verification.json and "
            "analysis/baseline-status.json; Ghidra and the full level's checks are not re-run",
}


class Unavailable(Exception):
    """An input the bundle needs is missing; the message says how to get it."""


def git(root, *args, stdin=None):
    try:
        result = subprocess.run(["git", "-C", str(root), *args], input=stdin, capture_output=True, check=False,
                                timeout=120)
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError(f"git {args[0]} failed: {error}") from None
    require(result.returncode == 0,
            f"git {' '.join(args)} failed: {result.stderr.decode('utf-8', 'replace').strip()}")
    return result.stdout


def head_revision(root):
    """The checkout's HEAD commit, refusing anything but the top of a Git work tree."""
    try:
        top = git(root, "rev-parse", "--show-toplevel").decode("utf-8").strip()
    except ValueError:
        raise ValueError(f"{root} is not a Git checkout: the bundle reads its source from Git") from None
    require(Path(top).resolve() == Path(root).resolve(), f"{root} is not the top of its Git work tree ({top})")
    return git(root, "rev-parse", "HEAD").decode("utf-8").strip()


def edition_name(revision):
    name = f"fr3-analysis-{package_research.short_revision(revision)}"
    require(re.fullmatch(r"fr3-analysis-[A-Za-z0-9._-]+", name), f"Revision cannot name a bundle: {revision!r}")
    return name


def check_prerequisites(root, research):
    """Raise Unavailable naming the demo files or research directory that are missing."""
    missing = [need for level in ("data", "instructions") for need in verify_findings.missing_prerequisites(root, level)]
    if missing:
        unique = list(dict.fromkeys(missing))
        raise Unavailable("The bundle runs the data and instructions levels; they need:\n"
                          + "\n".join(f"  {need.path}: {need.hint}" for need in unique))
    if not research.is_dir() or research.is_symlink():
        raise Unavailable(f"Research directory does not exist: {research} "
                          "(run `python3 scripts/build_research.py` first)")


def check_clean(root, revision):
    """Refuse when a source path differs from revision in the work tree, index or untracked files."""
    changed = git(root, "diff", "--name-only", "-z", revision, "--", *SOURCE_PATHS).decode("utf-8").split("\0")
    untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z", "--",
                    *SOURCE_PATHS).decode("utf-8").split("\0")
    dirty = sorted({name for name in (*changed, *untracked) if name})
    require(not dirty, f"Uncommitted changes under the packaged source paths ({', '.join(SOURCE_PATHS)}): "
                       + ", ".join(dirty) + f"; commit or remove them so the bundle matches {revision}")


def read_source(root, revision):
    """Return {path: bytes} for every tracked file under SOURCE_PATHS as committed at revision."""
    listing = git(root, "ls-tree", "-r", "-z", "--full-tree", revision, "--", *SOURCE_PATHS).decode("utf-8")
    objects = {}
    for entry in filter(None, listing.split("\0")):
        meta, path = entry.split("\t", 1)
        mode, kind, oid = meta.split()
        require(kind == "blob" and mode in ("100644", "100755"),
                f"Source path is not a regular file at {revision}: {path} (mode {mode}, {kind})")
        objects[path] = oid
    require(objects, f"No source files are committed at {revision}")
    output = git(root, "cat-file", "--batch", stdin="".join(f"{oid}\n" for oid in objects.values()).encode())
    files, offset = {}, 0
    for path, oid in objects.items():
        end = output.index(b"\n", offset)
        header = output[offset:end].decode("ascii").split()
        require(header[:2] == [oid, "blob"], f"git cat-file returned {header} for {path}")
        size = int(header[2])
        files[path] = output[end + 1:end + 1 + size]
        offset = end + 2 + size
    return files


def run_level(ctx, level, checks):
    try:
        performed = verify_findings.run_checks(ctx, level, checks)
    except CheckFailed as failure:
        failure.level = level
        raise
    return {"status": "performed", "summary": LEVEL_SUMMARIES[level],
            "checks": [{"name": name, "counts": counts} for name, counts in performed]}


def read_level(research_files):
    pages = len(build_research.RESEARCH_PAGES)
    evidence = sum(name.startswith(f"{build_research.EVIDENCE_DIR}/") for name in research_files)
    return {"status": "performed", "summary": LEVEL_SUMMARIES["read"],
            "checks": [{"name": "check_output", "counts": {"files": len(research_files)}},
                       {"name": "verify_research", "counts": {"pages": pages}},
                       {"name": "evidence_matches_committed_analysis", "counts": {"files": evidence}},
                       {"name": "entrance_names_revision_and_executable", "counts": {"pages": 1}},
                       {"name": "pages_match_fresh_build", "counts": {"pages": pages}}]}


def regenerate_databases(root, game):
    with tempfile.TemporaryDirectory(prefix="fr3-text-databases-") as scratch:
        counts = write_databases(game, scratch, load_known_tags(root / "analysis/tags.json"))
        files = {f"{DATABASES_DIR}/{path.name}": path.read_bytes() for path in sorted(Path(scratch).iterdir())}
    return files, counts


def ghidra_layer(root, revision):
    """Return (files to package, the full level's manifest entry); refuse an output that differs from the record."""
    analysis = root / "analysis"
    record_data = package_research.committed(analysis, revision, "verification.json")
    record = json.loads(record_data) if record_data is not None else {}
    for path in GHIDRA_FILES:
        require(not (root / path).is_symlink(), f"Refusing to package a symlinked Ghidra output: {path}")
    present = [path for path in GHIDRA_FILES if (root / path).is_file()]
    expected = {GHIDRA_SNAPSHOT: ("annotated_snapshot_sha256", record.get("annotated_snapshot_sha256")),
                GHIDRA_C: ("baseline_c_sha256", record.get("baseline_c_sha256"))}
    status = package_research.committed(analysis, revision, "baseline-status.json")
    data, checks = {}, []
    for path in present:
        data[path] = (root / path).read_bytes()
        if path in expected:
            key, digest = expected[path]
            require(digest, f"{path} exists but the analysis/verification.json committed at {revision} has no {key}"
                            " to match it against; remove it or re-run the full analysis")
            require(sha256(data[path]) == digest,
                    f"{path} differs from the {key} in the analysis/verification.json committed at {revision}: it "
                    "is not the verified output; re-run the full analysis or remove it")
            checks.append({"name": key, "counts": {"bytes": len(data[path])}})
        elif path == GHIDRA_STATUS:
            require(status is not None and data[path] == status,
                    f"{path} differs from the analysis/baseline-status.json committed at {revision}")
            checks.append({"name": "baseline_status", "counts": {"bytes": len(data[path])}})
    missing = [path for path in GHIDRA_FILES if path not in data]
    if missing:
        return {}, {"status": "unavailable", "summary": LEVEL_SUMMARIES["full"],
                    "missing": missing, "recovery": list(FULL_RECOVERY),
                    "checks": checks}
    verified = record.get("verified_utc", "unknown")
    return data, {"status": "performed", "summary": LEVEL_SUMMARIES["full"],
                  "note": f"artifacts match the committed verification record of {verified}; not re-run",
                  "verified_utc": verified, "checks": checks}


def check_exclusions(files, full_performed):
    """Refuse any file the bundle must never hold."""
    bad = [name for name in files
           if name.startswith(EXCLUDED_PREFIXES) or name.lower().endswith(EXCLUDED_SUFFIXES)
           or (name.lower().endswith(".gzf") and not full_performed)
           or files[name][:2] == b"MZ"]
    require(not bad, "Refusing to package files the bundle must not hold: " + ", ".join(sorted(bad)))


def render_manifest(edition, revision, pe, levels, layers, files):
    manifest = {
        "edition": edition,
        "producer_revision": revision,
        "producer": "scripts/package_analysis.py",
        "input": {
            "fr3_exe": {"sha256": pe["sha256"], "pe_timestamp_utc": pe.get("timestamp_header_utc", "unknown")},
            "demo_archive": {"sha256": ARCHIVE_SHA256, "size": ARCHIVE_SIZE},
            "verified_by": "the data level's archive_identity and executable_identity checks"
                           if levels["data"]["status"] == "performed" else "not verified",
        },
        "tools": {**verify_findings.tool_versions(), "zlib": zlib.ZLIB_RUNTIME_VERSION},
        "layers": layers,
        "levels": levels,
        "files": [{"path": name, "size": len(data), "sha256": sha256(data)} for name, data in sorted(files.items())],
    }
    return (json.dumps(manifest, indent=2) + "\n").encode("utf-8")


def package(root=REPO_ROOT, research=None, output=None, revision=None, epoch=None, checks=None):
    """Check every layer, write and self-check the bundle; return (path, entry count, size, levels)."""
    root = Path(root).resolve()
    research = Path(research) if research is not None else root / "artifacts/research"
    check_prerequisites(root, research)
    revision = revision or head_revision(root)
    pe = package_research.committed_pe(root / "analysis", revision)
    edition = edition_name(revision)
    destination = Path(output) if output is not None else root / "artifacts" / f"{edition}.zip"
    epoch = package_research.source_date_epoch() if epoch is None else epoch
    check_destination(destination, research, BUNDLE_NAME, BUNDLE_KIND)
    check_clean(root, revision)
    source = read_source(root, revision)

    ctx = verify_findings.Context(root)
    research_files = package_research.read_research(research, root / "analysis", revision, pe, ctx.game)
    levels = {"read": read_level(research_files)}
    levels["data"] = run_level(ctx, "data", checks)
    databases, database_counts = regenerate_databases(root, ctx.game)
    levels["instructions"] = run_level(ctx, "instructions", checks)
    ghidra, levels["full"] = ghidra_layer(root, revision)

    files = {**source, **databases, **{f"{RESEARCH_DIR}/{name}": data for name, data in research_files.items()},
             **ghidra}
    require(len(files) == len(source) + len(databases) + len(research_files) + len(ghidra),
            "Two bundle layers write the same path")
    check_exclusions(files, levels["full"]["status"] == "performed")
    layers = {
        "source": {"paths": list(SOURCE_PATHS), "files": len(source),
                   "from": f"Git at {revision}, refused with uncommitted changes"},
        "text-databases": {"directory": f"{DATABASES_DIR}/", "records": database_counts,
                           "from": "text_database.write_databases() on the extracted demo"},
        "research": {"directory": f"{RESEARCH_DIR}/", "files": len(research_files),
                     "from": "the research directory, checked by the read level"},
        "ghidra": {"files": sorted(ghidra),
                   "from": "artifacts/ matching the committed verification record" if ghidra
                   else "not packaged: the full level is unavailable"},
    }
    entries = dict(files)
    entries[MANIFEST] = render_manifest(edition, revision, pe, levels, layers, files)
    entries[SUMS] = package_research.render_sums(entries)
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{destination.name}-", suffix=".tmp", dir=destination.parent)
    os.close(handle)
    temporary = Path(temporary)
    try:
        package_research.write_zip(temporary, edition, entries, epoch)
        count = package_research.check_zip(temporary, edition, files, "Analysis bundle", "packaged files")
        temporary.chmod(0o644)
        check_destination(destination, research, BUNDLE_NAME, BUNDLE_KIND)
        os.replace(temporary, destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return destination, count, destination.stat().st_size, levels


def main(argv=None, checks=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=REPO_ROOT,
                        help="Git checkout to package, holding inputs/ and artifacts/ (default: %(default)s)")
    parser.add_argument("--research", type=Path,
                        help="Research directory built by scripts/build_research.py (default: <root>/artifacts/research)")
    parser.add_argument("--output", type=Path,
                        help="ZIP to write; an existing file is replaced only if it is named fr3-analysis-*.zip "
                             "(default: <root>/artifacts/fr3-analysis-<short revision>.zip)")
    args = parser.parse_args(argv)
    try:
        destination, count, size, levels = package(args.root, args.research, args.output, checks=checks)
    except Unavailable as error:
        print(f"package_analysis.py: {error}", file=sys.stderr)
        return EXIT_UNAVAILABLE
    except CheckFailed as failure:
        print(f"package_analysis.py: refused: verification level '{failure.level}' failed in check {failure.check}: "
              f"{failure.message}", file=sys.stderr)
        return EXIT_FAILED
    except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile) as error:
        print(f"package_analysis.py: refused: {error}", file=sys.stderr)
        return EXIT_FAILED
    for level, entry in levels.items():
        detail = entry.get("note") or ", ".join(check["name"] for check in entry["checks"])
        if entry["status"] == "unavailable":
            detail = "missing " + ", ".join(entry["missing"]) + "; recover with: " + " && ".join(entry["recovery"])
        print(f"{level:<13} {entry['status']:<12} {detail}")
    print(f"Packaged and verified {count} files ({count - 2} bundle files plus {MANIFEST} and {SUMS}): "
          f"{destination} ({size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
