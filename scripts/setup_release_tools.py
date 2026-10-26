"""Download checksum-pinned Wine runtimes for the compatibility releases."""
import argparse
from pathlib import Path
import subprocess
import tarfile

from fr3_common import download_cache, runtime_root
from setup_tools import download

RUNTIMES = {
    "linux": (
        "https://github.com/Kron4ek/Wine-Builds/releases/download/11.0/wine-11.0-amd64-wow64.tar.xz",
        "wine-11.0-amd64-wow64.tar.xz",
        "39574efa1132c3ca0d5c77dd2eddbe4a49cca0d6cc2c290ff4924493a1c40314",
        "wine-11.0-amd64-wow64",
    ),
    "macos": (
        "https://github.com/Gcenx/macOS_Wine_builds/releases/download/11.0_1/wine-stable-11.0_1-osx64.tar.xz",
        "wine-stable-11.0_1-osx64.tar.xz",
        "b50dc50ec7f41d58b115a6b685d4d1315ba3c797bd3aa0f49213f2703cb82388",
        "macos/Wine Stable.app/Contents/Resources/wine",
    ),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=runtime_root(), help="Runtime root (default: <FR3_TOOLS>/runtime, %(default)s)")
    parser.add_argument("--cache", type=Path, default=download_cache(), help="Download cache (env FR3_CACHE; default: %(default)s)")
    parser.add_argument("--platform", choices=["linux", "macos", "both"], default="both")
    args = parser.parse_args()
    root, cache = args.root.resolve(), args.cache.resolve()
    root.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    for platform, (url, name, digest, directory) in RUNTIMES.items():
        if args.platform not in (platform, "both"):
            continue
        archive = download(cache, url, name, digest)
        destination = root / ("macos" if platform == "macos" else "")
        destination.mkdir(parents=True, exist_ok=True)
        if not (root / directory / "bin/wine").exists():
            with tarfile.open(archive) as source:
                source.extractall(destination, filter="data")
        if platform == "linux":
            subprocess.run([str(root / directory / "bin/wine"), "--version"], check=True)
        print(f"Verified {platform} runtime: {root / directory}")


if __name__ == "__main__":
    main()
