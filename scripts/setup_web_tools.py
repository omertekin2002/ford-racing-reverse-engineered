"""Prepare the pinned WebAssembly compiler and Boxedwine source."""
import argparse
from pathlib import Path
import subprocess

from fr3_common import web_tools_root

BOXEDWINE_REVISION = "65467424603484756a73308412f40b906d28b650"
EMSDK_REVISION = "35ff8a6d150541276abbc6bae512ca90bcfbe220"
EMSCRIPTEN_VERSION = "5.0.7"
# Boxedwine filesystem 14 (manifest tools/buildWine/webgl_filesystems_v14.json, profile web-v14).
# boxedwine.org stopped serving it, so the build uses an unmodified mirror in this repository's releases.
WINE_WEB_URL = "https://github.com/omertekin2002/ford-racing-reverse-engineered/releases/download/wine-web-fs-v14/TinyCore15Wine11.0-web.zip"
WINE_WEB_SHA256 = "3365e31caaf6a1fc832a0a7c4812592d25410b9f5c9536277131388c8e103a49"


def require_clean_source(path):
    changes = subprocess.check_output([
        "git", "-C", str(path), "status", "--porcelain", "--untracked-files=all"
    ], text=True)
    if changes:
        raise RuntimeError(f"Preserving modified tool source: {path}\n{changes}")


def checkout(path, url, revision):
    if not (path / ".git").exists():
        path.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", "-q", str(path)], check=True)
        subprocess.run(["git", "-C", str(path), "remote", "add", "origin", url], check=True)
    require_clean_source(path)
    have = subprocess.run(["git", "-C", str(path), "cat-file", "-e", revision], capture_output=True)
    if have.returncode:
        subprocess.run(["git", "-C", str(path), "fetch", "--depth=1", "origin", revision], check=True)
    subprocess.run(["git", "-C", str(path), "checkout", "--detach", revision], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=web_tools_root(),
                        help="Browser tool root (env FR3_WEB_TOOLS, else <FR3_TOOLS>/web; default: %(default)s)")
    args = parser.parse_args()
    root = args.root.resolve()
    checkout(root / "emsdk", "https://github.com/emscripten-core/emsdk.git", EMSDK_REVISION)
    checkout(root / "Boxedwine", "https://github.com/danoon2/Boxedwine.git", BOXEDWINE_REVISION)
    subprocess.run([str(root / "emsdk/emsdk"), "install", EMSCRIPTEN_VERSION], check=True)
    subprocess.run([str(root / "emsdk/emsdk"), "activate", EMSCRIPTEN_VERSION], check=True)
    print(f"Browser tool sources pinned; Emscripten {EMSCRIPTEN_VERSION} ready in {root}")


if __name__ == "__main__":
    main()
