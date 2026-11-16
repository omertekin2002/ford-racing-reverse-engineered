"""Package a verified research directory as a deterministic, citable ZIP with a SHA-256 manifest.

Run it after scripts/build_research.py, at the same commit. It:
  1. checks the research directory (default artifacts/research) with build_research.check_output()
     and build_research.verify_research(), so a hand-edited directory, or one holding a file
     build_research.py does not write, is never packaged;
  2. checks every evidence/ file byte for byte against the analysis/ file it was copied from, as committed
     at the producer revision (read with `git show`, so an uncommitted edit is refused, not packaged), and
     checks that the entrance page names that revision and the fr3.exe SHA-256 in its analysis/pe-metadata.json;
  3. writes one ZIP, default artifacts/fr3-research-<short revision>.zip, holding a single folder
     fr3-research-<short revision>/ with every research file unchanged, a MANIFEST.json naming the input
     build, producer revision, Python version, the checks above and each file's size and SHA-256, and a
     SHA256SUMS file that `sha256sum -c` accepts from inside the folder;
  4. reopens the ZIP, runs its integrity check and re-hashes every entry against both manifests before
     renaming it into place.

The ZIP is deterministic: sorted entries, fixed permissions, a fixed compression level and one timestamp,
SOURCE_DATE_EPOCH if set, otherwise 1980-01-01. The same research directory, revision, Python and zlib give a
byte-identical ZIP. It holds game data: keep it out of Git (artifacts/ is ignored).

The manifest records what this script checked and nothing more. It does not re-hash fr3.exe or the demo
archive (it copies their pinned hashes), re-derive instruction evidence or re-run Ghidra.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import tempfile
import time
import zipfile
import zlib

import build_research
from dossier_common import INDEX_PAGE, e, producer_revision
from fr3_common import ARCHIVE_SHA256, ARCHIVE_SIZE
from text_database import REPO_ROOT, require

ANALYSIS = build_research.ANALYSIS
DEFAULT_RESEARCH = build_research.DEFAULT_OUTPUT
DEFAULT_DIR = REPO_ROOT / "artifacts"
MANIFEST = "MANIFEST.json"
SUMS = "SHA256SUMS"
PACKET_NAME = re.compile(r"fr3-research-.+\.zip")
SHORT_REVISION = 12
# 1980-01-01T00:00:00Z, the earliest time a ZIP entry can carry, when SOURCE_DATE_EPOCH is not set.
DEFAULT_EPOCH = 315_532_800
# The latest time a ZIP entry can carry: 2107-12-31T23:59:58Z.
MAX_EPOCH = 4_354_819_198
COMPRESSION_LEVEL = 9
FILE_MODE = 0o100644
# What this script checks, in the order it checks it; MANIFEST.json lists exactly these.
VERIFICATION = (
    "research directory holds only files build_research.py writes, checked by check_output()",
    "research pages verified by verify_research(): all six present, each with the rights-holder notice before "
    "its content, no <script>, no external resource, every local link resolving inside the directory",
    "evidence files byte-identical to the committed analysis/ files at the producer revision",
    "entrance page names this manifest's producer revision and the fr3.exe SHA-256 in analysis/pe-metadata.json "
    "at that revision",
    "every packaged file re-hashed from the written ZIP against MANIFEST.json and SHA256SUMS",
    "fr3.exe and the demo archive not re-hashed: their hashes are copied from analysis/pe-metadata.json and "
    "scripts/fr3_common.py",
    "instruction evidence not re-derived; full Ghidra analysis not re-run",
)


def short_revision(revision):
    return revision[:SHORT_REVISION] if re.fullmatch(r"[0-9a-f]{40,64}", revision) else revision


def edition_name(revision):
    name = f"fr3-research-{short_revision(revision)}"
    require(re.fullmatch(r"fr3-research-[A-Za-z0-9._-]+", name), f"Revision cannot name a packet: {revision!r}")
    return name


def source_date_epoch(environ=None):
    """Return the ZIP timestamp: SOURCE_DATE_EPOCH if set, otherwise 1980-01-01, clamped to what a ZIP holds."""
    environ = os.environ if environ is None else environ
    value = environ.get("SOURCE_DATE_EPOCH", "").strip()
    if not value:
        return DEFAULT_EPOCH
    require(value.isdigit(), f"SOURCE_DATE_EPOCH is not a whole number of seconds: {value!r}")
    return min(max(int(value), DEFAULT_EPOCH), MAX_EPOCH)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def check_destination(destination, research):
    """Refuse to write over anything but a previous packet, or inside the research directory."""
    if destination.exists() or destination.is_symlink():
        require(not destination.is_symlink(), f"Refusing to write the packet through a symlink: {destination}")
        require(destination.is_file(), f"Refusing to replace something that is not a file: {destination}")
        require(PACKET_NAME.fullmatch(destination.name),
                f"Refusing to replace {destination}: only a previous fr3-research-*.zip packet is overwritten")
    require(not destination.resolve().is_relative_to(research.resolve()),
            f"Refusing to write the packet inside the research directory: {destination}")


def committed(analysis, revision, relative):
    """Return analysis/<relative> as committed at revision, or None if Git has no such file there."""
    try:
        result = subprocess.run(["git", "-C", str(analysis), "show", f"{revision}:./{relative}"],
                                capture_output=True, check=False, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout if result.returncode == 0 else None


def committed_pe(analysis, revision):
    """Return analysis/pe-metadata.json as committed at revision."""
    require(re.fullmatch(r"[0-9a-f]{40,64}", revision),
            f"Producer revision is {revision!r}, not a Git commit: the packet can only cite committed analysis/ "
            "files, so run it from a Git checkout")
    data = committed(analysis, revision, "pe-metadata.json")
    require(data is not None, f"analysis/pe-metadata.json is not committed at revision {revision}")
    pe = json.loads(data)
    require(isinstance(pe, dict) and pe.get("sha256"), "PE metadata has no sha256")
    return pe


def read_research(research, analysis, revision, pe):
    """Run every pre-packaging check; return {path under the research directory: bytes}."""
    build_research.check_output(research)
    build_research.verify_research(research)
    files = {path.relative_to(research).as_posix(): path.read_bytes()
             for path in sorted(research.rglob("*")) if path.is_file()}
    changed = []
    for name, data in files.items():
        if name.startswith(f"{build_research.EVIDENCE_DIR}/"):
            if committed(analysis, revision, name.removeprefix(f"{build_research.EVIDENCE_DIR}/")) != data:
                changed.append(name)
    require(not changed, f"Evidence files differ from the analysis/ files committed at {revision}: "
                         + ", ".join(changed))
    index = files[INDEX_PAGE].decode("utf-8")
    require(f"<dt>Producer revision</dt><dd><code>{e(revision)}</code>" in index,
            f"{INDEX_PAGE} was not built at revision {revision}: rebuild with scripts/build_research.py")
    require(f"SHA-256 <code>{e(pe['sha256'])}</code>" in index,
            f"{INDEX_PAGE} does not name the fr3.exe SHA-256 in analysis/pe-metadata.json: {pe['sha256']}")
    return files


def render_manifest(edition, revision, pe, files):
    manifest = {
        "edition": edition,
        "producer_revision": revision,
        "producer": "scripts/package_research.py",
        "input": {
            "fr3_exe": {"sha256": pe["sha256"], "pe_timestamp_utc": pe.get("timestamp_header_utc", "unknown")},
            "demo_archive": {"sha256": ARCHIVE_SHA256, "size": ARCHIVE_SIZE},
        },
        "tools": {"python": platform.python_version(), "zlib": zlib.ZLIB_RUNTIME_VERSION},
        "verification": list(VERIFICATION),
        "files": [{"path": name, "size": len(data), "sha256": sha256(data)} for name, data in sorted(files.items())],
    }
    return (json.dumps(manifest, indent=2) + "\n").encode("utf-8")


def render_sums(files):
    return "".join(f"{sha256(data)}  {name}\n" for name, data in sorted(files.items())).encode("utf-8")


def write_zip(path, edition, entries, epoch):
    stamp = time.gmtime(epoch)[:6]
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(f"{edition}/{name}", date_time=stamp)
            info.create_system = 3
            info.external_attr = FILE_MODE << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data, compresslevel=COMPRESSION_LEVEL)


def check_zip(path, edition, files):
    """Reopen the written ZIP and check it against the research files and both manifests."""
    with zipfile.ZipFile(path) as archive:
        require(archive.testzip() is None, "Research packet failed its ZIP integrity check")
        names = archive.namelist()
        require(len(names) == len(set(names)), "Research packet holds a duplicate entry")
        archived = {name.removeprefix(f"{edition}/"): archive.read(name) for name in names
                    if name.startswith(f"{edition}/")}
        require(len(archived) == len(names), f"Research packet holds an entry outside {edition}/")
    manifest = json.loads(archived[MANIFEST])
    listed = {entry["path"]: entry for entry in manifest["files"]}
    require(set(archived) == {*listed, MANIFEST, SUMS},
            "Research packet does not hold exactly the manifest's files plus MANIFEST.json and SHA256SUMS")
    require(set(listed) == set(files), "MANIFEST.json does not list exactly the research files")
    for name, entry in listed.items():
        data = archived[name]
        require(data == files[name] and len(data) == entry["size"] and sha256(data) == entry["sha256"],
                f"Packet content does not match MANIFEST.json: {name}")
    sums = {}
    for line in archived[SUMS].decode("utf-8").splitlines():
        digest, name = line.split("  ", 1)
        sums[name] = digest
    require(set(sums) == set(archived) - {SUMS}, "SHA256SUMS does not cover every other file in the packet")
    for name, digest in sums.items():
        require(sha256(archived[name]) == digest, f"Packet content does not match SHA256SUMS: {name}")
    return len(archived)


def package(research=DEFAULT_RESEARCH, output=None, analysis=ANALYSIS, revision=None, epoch=None):
    """Check the research directory, write and self-check the packet; return (path, entry count, size)."""
    research, analysis = Path(research), Path(analysis)
    revision = revision or producer_revision()
    edition = edition_name(revision)
    destination = Path(output) if output is not None else DEFAULT_DIR / f"{edition}.zip"
    epoch = source_date_epoch() if epoch is None else epoch
    check_destination(destination, research)
    require(research.is_dir() and not research.is_symlink(),
            f"Research directory does not exist: {research} (run scripts/build_research.py first)")
    pe = committed_pe(analysis, revision)
    files = read_research(research, analysis, revision, pe)
    entries = dict(files)
    entries[MANIFEST] = render_manifest(edition, revision, pe, files)
    entries[SUMS] = render_sums(entries)
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{destination.name}-", suffix=".tmp", dir=destination.parent)
    os.close(handle)
    temporary = Path(temporary)
    try:
        write_zip(temporary, edition, entries, epoch)
        count = check_zip(temporary, edition, files)
        temporary.chmod(0o644)
        check_destination(destination, research)
        os.replace(temporary, destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return destination, count, destination.stat().st_size


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--research", type=Path, default=DEFAULT_RESEARCH,
                        help="Research directory built by scripts/build_research.py (default: %(default)s)")
    parser.add_argument("--output", type=Path,
                        help="ZIP to write; an existing file is replaced only if it is named fr3-research-*.zip "
                             f"(default: {DEFAULT_DIR}/fr3-research-<short revision>.zip)")
    args = parser.parse_args()
    try:
        destination, count, size = package(args.research, args.output)
    except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile) as error:
        raise SystemExit(f"package_research.py: {error}") from None
    print(f"Packaged and verified {count} files ({count - 2} research files plus {MANIFEST} and {SUMS}): "
          f"{destination} ({size} bytes)")


if __name__ == "__main__":
    main()
