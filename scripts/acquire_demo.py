"""Acquire the public demo; extract ZIP/CAB without running game code."""
import argparse
import hashlib
import html.parser
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
import zipfile

from fr3_common import ARCHIVE_SHA256, ARCHIVE_SIZE, DEFAULT_GAME_DIR, DEMO_PAGE, verified_bytes, verified_exe
from setup_tools import HTTPSRedirect


def verify_repo_game(game_dir=DEFAULT_GAME_DIR, manifest_path=None):
    """Verify the in-repository Ford Racing 3 Shuffle game directory against analysis/game-file-manifest.json."""
    game = Path(game_dir).resolve()
    manifest_file = Path(manifest_path) if manifest_path is not None else Path(__file__).resolve().parents[1] / "analysis/game-file-manifest.json"
    if not game.is_dir():
        raise ValueError(f"Game directory not found: {game}")
    verified_exe(game / "fr3.exe")
    recorded = json.loads(manifest_file.read_text(encoding="utf-8"))
    expected = {entry["path"] for entry in recorded}
    actual = {p.relative_to(game).as_posix() for p in game.rglob("*") if p.is_file()}
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise ValueError(f"Game files differ from manifest (missing: {len(missing)}, extra: {len(extra)})")
    for entry in recorded:
        path = game / entry["path"]
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if path.stat().st_size != entry["size"] or digest != entry["sha256"]:
            raise ValueError(f"Game file changed: {entry['path']}")
    return len(recorded)


class Links(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a" and attrs.get("href"):
            self.hrefs.append(attrs["href"])


def download_links(html_text, base_url):
    """Yield the absolute ModDB download-start and mirror links in a page, in order.

    A generator, so links before a malformed href that makes urljoin raise
    still reach the caller's queue.
    """
    parser = Links()
    parser.feed(html_text)
    for href in parser.hrefs:
        candidate = urllib.parse.urljoin(base_url, href)
        parts = urllib.parse.urlsplit(candidate)
        if parts.scheme == "https" and parts.hostname == "www.moddb.com" and parts.path.startswith(("/downloads/start/", "/downloads/mirror/")):
            yield candidate


def fetch(url):
    if urllib.parse.urlsplit(url).scheme != "https":
        raise ValueError("Acquisition requires HTTPS")
    request = urllib.request.Request(url, headers={"User-Agent": "FR3-public-demo-research/1.0"})
    opener = urllib.request.build_opener(HTTPSRedirect())
    with opener.open(request, timeout=45) as response:
        if urllib.parse.urlsplit(response.url).scheme != "https":
            raise ValueError("Refusing a redirect away from HTTPS")
        data = response.read(ARCHIVE_SIZE + 1)
        if len(data) > ARCHIVE_SIZE:
            raise ValueError("Response exceeds expected demo archive size")
        return data, response.url


def acquire(destination, explicit_url=None):
    if destination.exists():
        verified_bytes(destination, ARCHIVE_SIZE, ARCHIVE_SHA256)
        return {"mode": "verified_local_archive", "source_page": DEMO_PAGE}
    queue = [explicit_url or DEMO_PAGE]
    seen = set()
    errors = []
    while queue and len(seen) < 12:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        try:
            data, final_url = fetch(url)
            if len(data) == ARCHIVE_SIZE and hashlib.sha256(data).hexdigest() == ARCHIVE_SHA256:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as stream:
                    stream.write(data)
                    staged = Path(stream.name)
                os.replace(staged, destination)
                return {"mode": "download", "source_page": DEMO_PAGE, "download_url": final_url}
            queue.extend(download_links(data.decode("utf-8", errors="replace"), final_url))
            if not queue:
                errors.append(f"{url}: no matching demo archive or download links")
        except (OSError, ValueError) as error:
            errors.append(f"{url}: {error}")
    raise RuntimeError("Demo acquisition failed:\n" + "\n".join(errors))


def extract_zip(archive, destination):
    verified_bytes(archive, ARCHIVE_SIZE, ARCHIVE_SHA256)
    with zipfile.ZipFile(archive) as zipped:
        total = 0
        for member in zipped.infolist():
            name = PurePosixPath(member.filename.replace("\\", "/"))
            if name.is_absolute() or ".." in name.parts or any(":" in p for p in name.parts):
                raise ValueError(f"Unsafe ZIP path: {member.filename}")
            if (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("ZIP symlinks are not supported")
            total += member.file_size
            if total > 200_000_000:
                raise ValueError("Installer ZIP exceeds extraction limit")
        for member in zipped.infolist():
            target = destination.joinpath(*PurePosixPath(member.filename.replace("\\", "/")).parts)
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    if not target.is_file() or target.read_bytes() != zipped.read(member):
                        raise ValueError(f"Existing installer file differs; preserve it and use a new destination: {target}")
                    continue
                with zipped.open(member) as source, target.open("wb") as out:
                    shutil.copyfileobj(source, out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, nargs="?", default=DEFAULT_GAME_DIR,
                        help="Game directory to verify (default: %(default)s) or legacy demo destination")
    parser.add_argument("--url", help="Explicit HTTPS demo mirror; exact archive hash still required")
    parser.add_argument("--archive", type=Path, help="Reuse a locally supplied demo ZIP")
    parser.add_argument("--unshield", default="unshield")
    parser.add_argument("--legacy-demo", action="store_true",
                        help="Acquire and extract the legacy 2004 ModDB demo ZIP/CAB instead of verifying game/")
    args = parser.parse_args()
    root = args.destination.resolve()
    if not args.legacy_demo and not args.url and not args.archive and (root / "fr3.exe").is_file():
        count = verify_repo_game(root)
        print(f"Verified Ford Racing 3 Shuffle in {root} ({count} files)")
        return
    root.mkdir(parents=True, exist_ok=True)
    archive = root / "fordracing3demo.zip"
    if args.archive and args.archive.resolve() != archive:
        verified_bytes(args.archive, ARCHIVE_SIZE, ARCHIVE_SHA256)
        if archive.exists():
            verified_bytes(archive, ARCHIVE_SIZE, ARCHIVE_SHA256)
        else:
            shutil.copyfile(args.archive, archive)
    provenance = acquire(archive, args.url)
    extract_zip(archive, root / "installer")
    cabs = [p for p in (root / "installer").rglob("*") if p.name.lower() == "data1.cab"]
    if len(cabs) != 1:
        raise ValueError(f"Expected one data1.cab; found {len(cabs)}")
    extracted = root / "extracted"
    if extracted.exists() and any(extracted.iterdir()):
        existing = [p for p in extracted.rglob("*") if p.name.lower() == "fr3.exe"]
        if len(existing) != 1:
            raise ValueError("Existing extraction is incomplete; preserve it and choose a new destination")
        verified_exe(existing[0])
        print("Reusing existing extraction; verify_findings checks the complete game-file manifest")
    else:
        subprocess.run([args.unshield, "-d", str(extracted), "x", str(cabs[0])], check=True)
    exes = [p for p in (root / "extracted").rglob("*") if p.name.lower() == "fr3.exe"]
    if len(exes) != 1:
        raise ValueError(f"Expected one fr3.exe; found {len(exes)}")
    verified_exe(exes[0])
    if (root / "fr3.exe").exists():
        verified_exe(root / "fr3.exe")
    else:
        shutil.copyfile(exes[0], root / "fr3.exe")
    provenance.update(archive_sha256=ARCHIVE_SHA256, archive_size=ARCHIVE_SIZE)
    record = root / "provenance.json"
    if record.exists():
        if json.loads(record.read_text()).get("archive_sha256") != ARCHIVE_SHA256:
            raise ValueError("Existing provenance belongs to a different archive")
    else:
        record.write_text(json.dumps(provenance, indent=2) + "\n")
    print(f"Verified and extracted {root / 'fr3.exe'}")


if __name__ == "__main__":
    main()

