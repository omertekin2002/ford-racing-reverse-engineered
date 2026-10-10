"""Install pinned analysis tools outside the checkout (Linux amd64)."""
import argparse
import hashlib
from pathlib import Path
import shlex
import subprocess
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zipfile

GHIDRA_URL = "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_10.3.3_build/ghidra_10.3.3_PUBLIC_20230829.zip"
JAVA_URL = "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.12%2B7/OpenJDK17U-jdk_x64_linux_hotspot_17.0.12_7.tar.gz"
# Ghidra: official release bytes, also matching the supplied report.
# Java: verified against the official release's .sha256.txt.
# Debian packages: verified against the signed trixie InRelease + Packages.xz.
ARTIFACTS = [
    (GHIDRA_URL, "ghidra_10.3.3_PUBLIC_20230829.zip", "63833361bea8ef5ada1bc28cd2aa2ae4ab43204d2672b595500372582152eebe"),
    (JAVA_URL, "OpenJDK17U-jdk_x64_linux_hotspot_17.0.12_7.tar.gz", "9d4dd339bf7e6a9dcba8347661603b74c61ab2a5083ae67bf76da6285da8a778"),
    ("https://deb.debian.org/debian/pool/main/u/unshield/libunshield0_1.5.1-1+b2_amd64.deb", "libunshield0_1.5.1-1+b2_amd64.deb", "97b411fb339223d108a87b11f49a424cc960a710eab25e5be00add63bbf7d8b4"),
    ("https://deb.debian.org/debian/pool/main/u/unshield/unshield_1.5.1-1+b2_amd64.deb", "unshield_1.5.1-1+b2_amd64.deb", "1924071101e8f3aa7e2588c3f585436573138c7f65355c4e25f29c47b6c73231"),
]


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        if urllib.parse.urlsplit(new_url).scheme != "https":
            raise ValueError("Refusing non-HTTPS tool download redirect")
        return super().redirect_request(request, fp, code, message, headers, new_url)


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(cache, url, name, expected):
    path = cache / name
    if not path.exists():
        staged = None
        try:
            opener = urllib.request.build_opener(HTTPSRedirect())
            with opener.open(url, timeout=90) as response, tempfile.NamedTemporaryFile(dir=cache, delete=False) as out:
                staged = Path(out.name)
                while chunk := response.read(1024 * 1024):
                    out.write(chunk)
            if sha256(staged) != expected:
                raise ValueError(f"Checksum mismatch for {name}")
            staged.replace(path)
        finally:
            if staged and staged.exists():
                staged.unlink()
    if sha256(path) != expected:
        raise ValueError(f"Cached checksum mismatch for {name}; investigate without changing the expected checksum")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/workspace/toolchains/fr3"))
    parser.add_argument("--cache", type=Path, default=Path("/workspace/shared/downloads"))
    args = parser.parse_args()
    root, cache = args.root.resolve(), args.cache.resolve()
    root.mkdir(parents=True, exist_ok=True); cache.mkdir(parents=True, exist_ok=True)
    files = [download(cache, *item) for item in ARTIFACTS]
    ghidra, java = root / "ghidra_10.3.3_PUBLIC", root / "jdk-17.0.12+7"
    if not ghidra.exists():
        with zipfile.ZipFile(files[0]) as archive:
            archive.extractall(root)
        for shell in (ghidra / "support").glob("*"):
            if shell.suffix == ".sh" or shell.name == "analyzeHeadless":
                shell.chmod(shell.stat().st_mode | 0o111)
        # ZIP Unix permissions are needed for native decompiler executables.
        with zipfile.ZipFile(files[0]) as archive:
            for member in archive.infolist():
                permission = member.external_attr >> 16
                if permission and not member.is_dir():
                    (root / member.filename).chmod(permission & 0o777)
    if not java.exists():
        with tarfile.open(files[1]) as archive:
            archive.extractall(root, filter="data")
    for package in files[2:]:
        subprocess.run(["dpkg-deb", "-x", str(package), str(root / "unshield")], check=True)
    support = ghidra / "support" / "launch.properties"
    properties = support.read_text().splitlines()
    properties = [f"JAVA_HOME_OVERRIDE={java}" if line.startswith("JAVA_HOME_OVERRIDE=") else line for line in properties]
    support.write_text("\n".join(properties) + "\n")
    (root / "state").mkdir(exist_ok=True)
    (root / "bin").mkdir(exist_ok=True)
    wrapper = root / "bin" / "unshield"
    wrapper.write_text("#!/bin/sh\nexec env " + shlex.quote("LD_LIBRARY_PATH=" + str(root / "unshield/usr/lib/x86_64-linux-gnu")) + " " + shlex.quote(str(root / "unshield/usr/bin/unshield")) + ' "$@"\n')
    wrapper.chmod(0o755)
    subprocess.run(["python3", "-m", "venv", str(root / "venv")], check=True)
    python = root / "venv/bin/python"
    requirements = Path(__file__).resolve().parent / "requirements.txt"
    subprocess.run([str(python), "-m", "pip", "install", "--no-cache-dir", "--require-hashes", "-r", str(requirements)], check=True)
    subprocess.run([str(java / "bin/java"), "-version"], check=True)
    subprocess.run([str(wrapper), "-V"], check=True)
    print(f"Pinned tools prepared at {root}")


if __name__ == "__main__":
    main()
