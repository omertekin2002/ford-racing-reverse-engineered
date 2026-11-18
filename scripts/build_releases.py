"""Build Linux/macOS Wine compatibility packages from the verified public demo."""
import argparse
import collections
import gzip
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile

from fr3_common import download_cache, runtime_root, verified_exe
from setup_release_tools import RUNTIMES
from setup_tools import download

VERSION = "0.1.0-preview"
WINE_LICENSE = (
    "https://raw.githubusercontent.com/wine-mirror/wine/wine-11.0/COPYING.LIB",
    "wine-11.0-COPYING.LIB",
    "e237fa56668030e928551ddd60f05df5fe957f75eab874bbd017e085ed722e7c",
)


def git_output(repository, *args):
    """Return Git's stdout for args run in repository, or None if Git is missing or fails."""
    try:
        result = subprocess.run(["git", "-C", str(repository), *args], capture_output=True, text=True,
                                check=False, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout if result.returncode == 0 else None


def source_identity(repository, allow_dirty=False):
    """Return (source_revision, dirty) for the checkout that builds the packages.

    source_revision is the full commit ID of HEAD, as package_research.py records its producer revision.
    A tree with uncommitted or untracked (non-ignored) changes, or one that is not the top of a Git
    checkout, is refused unless allow_dirty is set; the packages then record dirty: true, and
    source_revision is None when there is no commit to name.
    """
    repository = Path(repository).resolve()
    top = git_output(repository, "rev-parse", "--show-toplevel")
    revision = (git_output(repository, "rev-parse", "--verify", "--quiet", "HEAD^{commit}") or "").strip()
    status = git_output(repository, "status", "--porcelain")
    if top is None or Path(top.strip()).resolve() != repository or status is None \
            or not re.fullmatch(r"[0-9a-f]{40,64}", revision):
        if not allow_dirty:
            raise ValueError(f"{repository} is not a Git checkout with a commit; the packages could not name "
                             "their source revision. Build from a clone, or pass --allow-dirty to record "
                             "dirty: true")
        return (revision if re.fullmatch(r"[0-9a-f]{40,64}", revision) else None), True
    if status.strip():
        if not allow_dirty:
            changed = ", ".join(line[3:] for line in status.splitlines()[:5])
            raise ValueError(f"The checkout has uncommitted changes ({changed}); commit them so source_revision "
                             "names what was built, or pass --allow-dirty to record dirty: true")
        return revision, True
    return revision, False


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def check_game(repository, game):
    verified_exe(game / "fr3.exe")
    recorded = json.loads((repository / "analysis/game-file-manifest.json").read_text())
    expected = {entry["path"] for entry in recorded}
    actual = {p.relative_to(game).as_posix() for p in game.rglob("*") if p.is_file()}
    if actual != expected:
        raise ValueError("Game payload file list differs from the verified extraction")
    for entry in recorded:
        path = game / entry["path"]
        if path.stat().st_size != entry["size"] or sha256(path) != entry["sha256"]:
            raise ValueError("Game payload changed: " + entry["path"])
    return len(recorded)


def manifest(root):
    lines = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            if not path.resolve().is_relative_to(root.resolve()) or not path.exists():
                raise ValueError("Invalid runtime symlink: " + str(path))
        elif path.is_file() and path.name != "MANIFEST.sha256":
            lines.append(f"{sha256(path)}  {path.relative_to(root).as_posix()}")
    (root / "MANIFEST.sha256").write_text("\n".join(lines) + "\n")
    return len(lines)


def zip_tree(source, output):
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(source.rglob("*")):
            name = path.relative_to(source.parent).as_posix()
            info = zipfile.ZipInfo(name + ("/" if path.is_dir() and not path.is_symlink() else ""), (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = path.lstat().st_mode << 16
            if path.is_symlink():
                archive.writestr(info, os.readlink(path))
            elif path.is_dir():
                archive.writestr(info, b"")
            else:
                info.compress_type = zipfile.ZIP_DEFLATED
                with path.open("rb") as stream, archive.open(info, "w", force_zip64=True) as destination:
                    shutil.copyfileobj(stream, destination)


def tar_tree(source, output):
    def normalize(info):
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        info.mtime = 0
        return info
    with output.open("wb") as file, gzip.GzipFile(filename="", mode="wb", fileobj=file, mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode="w|") as archive:
            archive.add(source, arcname=source.name, filter=normalize)


def tar_mode(entry):
    """st_mode for a tar member: TarInfo.mode holds only the permission bits. A hard link reads as its file."""
    kind = stat.S_IFLNK if entry.issym() else stat.S_IFDIR if entry.isdir() else \
        stat.S_IFREG if entry.isreg() or entry.islnk() else 0
    return kind | entry.mode


def verify_archive(path):
    """Check payload hashes, Unix launch permissions and macOS symlink encoding."""
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as archive:
            if archive.testzip() is not None:
                raise ValueError("ZIP CRC check failed")
            names = archive.namelist()
            read = archive.read
            modes = {entry.filename: entry.external_attr >> 16 for entry in archive.infolist()}
            for name in names:
                if stat.S_ISLNK(modes[name]):
                    target = read(name).decode()
                    if target.startswith("/"):
                        raise ValueError("Absolute ZIP symlink")
            verify_members(names, read, modes)
    else:
        with tarfile.open(path) as archive:
            entries = archive.getmembers()
            members = {entry.name: entry for entry in entries}

            def read(name):
                stream = archive.extractfile(members[name])
                if stream is None:
                    raise ValueError("Archive member is not a file: " + name)
                with stream:
                    return stream.read()
            modes = {entry.name: tar_mode(entry) for entry in entries}
            verify_members([entry.name for entry in entries], read, modes)


def verify_members(names, read, modes):
    """Check one archive's members: names in archive order, read(name) -> bytes, modes[name] -> st_mode."""
    duplicates = sorted(name for name, count in collections.Counter(names).items() if count > 1)
    if duplicates:
        raise ValueError("Archive repeats member names: " + ", ".join(duplicates))
    members = set(names)
    manifests = [name for name in names if name.endswith("/MANIFEST.sha256")]
    if len(manifests) != 1:
        raise ValueError(f"Expected one payload manifest, found {len(manifests)}")
    prefix = manifests[0].rsplit("/", 1)[0] + "/"
    for line in read(manifests[0]).decode().splitlines():
        expected, separator, relative = line.partition("  ")
        if not separator or not re.fullmatch(r"[0-9a-f]{64}", expected) or not relative:
            raise ValueError("Malformed payload manifest line: " + line)
        name = prefix + relative
        if name not in members or not stat.S_ISREG(modes[name]):
            raise ValueError("Archive is missing a manifest file: " + relative)
        if hashlib.sha256(read(name)).hexdigest() != expected:
            raise ValueError("Archive payload mismatch: " + relative)
    launchers = [name for name in names if name.endswith(("/launch.sh", "/MacOS/ford-racing-3"))]
    if not any(name.endswith("/launch.sh") for name in launchers):
        raise ValueError("Archive has no launch.sh")
    for name in launchers:
        if not modes[name] & 0o111:
            raise ValueError("Launcher lost execute permission: " + name)
    # The package's own bundle sits at <package>/<name>.app; bundles inside the Wine runtime are upstream's.
    for plist in [name for name in names if name.endswith(".app/Contents/Info.plist") and name.count("/") == 3]:
        info = plistlib.loads(read(plist))
        executable = info.get("CFBundleExecutable") if isinstance(info, dict) else None
        if not isinstance(executable, str) or not executable or "/" in executable:
            raise ValueError("macOS Info.plist names no CFBundleExecutable")
        if plist.rsplit("/", 1)[0] + "/MacOS/" + executable not in members:
            raise ValueError("macOS bundle executable missing: " + executable)


def package_metadata(platform, game_count, url, digest, revision, dirty):
    """BUILD.json for one package; builds.json repeats it beside the archive's hash and size."""
    return {
        "version": VERSION, "platform": platform, "package_type": "Wine compatibility preview",
        "game_file_count": game_count, "runtime_url": url, "runtime_archive_sha256": digest,
        "native_source_port": False, "macos_signed": False if platform == "macos" else None,
        "source_revision": revision, "dirty": dirty,
    }


def write_results(output, results):
    """Write builds.json and SHA256SUMS for the packages just built.

    A platform not rebuilt this time keeps its previous entry, unless that entry predates source_revision.
    """
    result_path = output / "builds.json"
    previous = json.loads(result_path.read_text()) if result_path.exists() else []
    built = {r["platform"] for r in results}
    retained = [r for r in previous if r["platform"] not in built and "source_revision" in r]
    results = sorted(retained + results, key=lambda r: r["platform"])
    result_path.write_text(json.dumps(results, indent=2) + "\n")
    (output / "SHA256SUMS").write_text("".join(f'{r["sha256"]}  {r["path"]}\n' for r in results))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path, default=runtime_root(),
                        help="Runtime root from setup_release_tools.py (default: <FR3_TOOLS>/runtime, %(default)s)")
    parser.add_argument("--cache", type=Path, default=download_cache(), help="Download cache (env FR3_CACHE; default: %(default)s)")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--platform", choices=["linux", "macos", "both"], default="both")
    parser.add_argument("--allow-dirty", action="store_true",
                        help="Build from uncommitted changes or a non-Git tree; the packages record dirty: true")
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[1]
    revision, dirty = source_identity(repository, args.allow_dirty)
    output = (args.output or repository / "artifacts/releases").resolve()
    output.mkdir(parents=True, exist_ok=True)
    args.cache.mkdir(parents=True, exist_ok=True)
    game = repository / "inputs/extracted/Program_Executable_Files"
    game_count = check_game(repository, game)
    license_file = download(args.cache, *WINE_LICENSE)
    results = []
    for platform, (url, name, digest, directory) in RUNTIMES.items():
        if args.platform not in (platform, "both"):
            continue
        download(args.cache, url, name, digest)
        runtime = args.runtime_root / directory
        if not (runtime / "bin/wine").exists():
            raise ValueError("Run setup_release_tools.py before building releases")
        # Extract again from the verified archive. Never package a modified tool install.
        with tempfile.TemporaryDirectory(prefix="fr3-build-", dir=output) as work:
            work = Path(work)
            fresh = work / "verified-runtime"
            fresh.mkdir()
            with tarfile.open(args.cache / name) as upstream:
                upstream.extractall(fresh, filter="data")
            runtime = fresh / ("Wine Stable.app/Contents/Resources/wine" if platform == "macos" else directory)
            package_name = f"ford-racing-3-demo-{VERSION}-" + ("macos" if platform == "macos" else "linux-x86_64")
            package = work / package_name
            package.mkdir()
            resources = package
            if platform == "macos":
                contents = package / "Ford Racing 3 Demo.app/Contents"
                resources = contents / "Resources"
                (contents / "MacOS").mkdir(parents=True)
                resources.mkdir()
                launcher = contents / "MacOS/ford-racing-3"
                shutil.copyfile(repository / "release/macos-launch.sh", launcher)
                launcher.chmod(0o755)
                info = {
                    "CFBundleExecutable": "ford-racing-3",
                    "CFBundleIdentifier": "org.fordracing3.demo.compatibility",
                    "CFBundleName": "Ford Racing 3 Demo",
                    "CFBundleDisplayName": "Ford Racing 3 Demo",
                    "CFBundlePackageType": "APPL",
                    "CFBundleInfoDictionaryVersion": "6.0",
                    "CFBundleVersion": "1",
                    "CFBundleShortVersionString": "0.1.0",
                    "LSMinimumSystemVersion": "10.15",
                    "NSHighResolutionCapable": True,
                }
                (contents / "Info.plist").write_bytes(plistlib.dumps(info))
                (contents / "PkgInfo").write_bytes(b"APPL????")
            shutil.copytree(game, resources / "game")
            shutil.copytree(runtime, resources / "runtime", symlinks=True)
            shutil.copyfile(repository / "release/launch.sh", resources / "launch.sh")
            (resources / "launch.sh").chmod(0o755)
            shutil.copyfile(license_file, resources / "COPYING.Wine.LIB")
            shutil.copyfile(repository / "release/THIRD_PARTY.md", resources / "THIRD_PARTY.md")
            shutil.copyfile(repository / "docs/releases.md", package / "README.md")
            shutil.copyfile(repository / "docs/release-validation.md", package / "VALIDATION.md")
            metadata = package_metadata(platform, game_count, url, digest, revision, dirty)
            (resources / "BUILD.json").write_text(json.dumps(metadata, indent=2) + "\n")
            file_count = manifest(resources)
            subprocess.run(["bash", "-n", str(resources / "launch.sh")], check=True)
            archive = output / (package_name + (".zip" if platform == "macos" else ".tar.gz"))
            temporary = work / archive.name
            (zip_tree if platform == "macos" else tar_tree)(package, temporary)
            verify_archive(temporary)
            temporary.replace(archive)
            results.append({"path": archive.name, "sha256": sha256(archive), "bytes": archive.stat().st_size,
                            "manifest_files": file_count, **metadata})
            print(f"Built and verified: {archive} ({archive.stat().st_size:,} bytes)", flush=True)
    write_results(output, results)


if __name__ == "__main__":
    main()
