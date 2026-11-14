"""Check static assets, original game identity and project-page URL compatibility."""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path, PurePosixPath
import re
import urllib.parse
import zipfile
import zlib

from fr3_common import DEMO_PAGE
from setup_web_tools import BOXEDWINE_REVISION, WINE_WEB_SHA256

ISSUES_PAGE = "https://github.com/omertekin2002/ford-racing-reverse-engineered/issues"
RIGHTS_CREDIT = "Ford Racing 3 demo © 2004 Empire Interactive Europe Ltd."
MANIFEST = Path(__file__).resolve().parents[1] / "analysis/game-file-manifest.json"
# The research pages from scripts/build_research.py, published under this directory of the site (decision #46).
RESEARCH_DIR = "research"
SUM_LINE = re.compile(r"([0-9a-f]{64})  (.+)")
WASM_HEADER = b"\0asm\x01\0\0\0"


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ("src", "href") and value:
                self.paths.append(value)


class Notice(HTMLParser):
    """Collect the text and links of the rights notice and whether it precedes the player."""

    def __init__(self):
        super().__init__()
        self.tag = None
        self.depth = 0
        self.found = False
        self.after_player = False
        self.text = []
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if self.depth:
            if tag == self.tag:
                self.depth += 1
            if tag == "a" and attrs.get("href"):
                self.links.append(attrs["href"])
        elif attrs.get("id") == "rights-notice" and not self.found:
            self.tag, self.depth, self.found = tag, 1, True
        elif "player" in (attrs.get("class") or "").split() and not self.found:
            self.after_player = True

    def handle_endtag(self, tag):
        if self.depth and tag == self.tag:
            self.depth -= 1

    def handle_data(self, data):
        if self.depth:
            self.text.append(data)


def verify_notice(html):
    """Require the visible rights-holder notice above the player in index.html."""
    notice = Notice()
    notice.feed(html)
    if not notice.found:
        raise ValueError("index.html lacks the rights-holder notice (#rights-notice)")
    if notice.after_player:
        raise ValueError("The rights-holder notice must appear above the player")
    text = " ".join(" ".join(notice.text).split())
    if RIGHTS_CREDIT not in text:
        raise ValueError(f"The rights-holder notice lacks the credit: {RIGHTS_CREDIT}")
    for url in (DEMO_PAGE, ISSUES_PAGE):
        if url not in notice.links:
            raise ValueError(f"The rights-holder notice lacks a link to {url}")


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_build_record(root, record):
    """Check build.json's pins and runtime asset identities, plus the static-site markers."""
    for key, expected in (("boxedwine_revision", BOXEDWINE_REVISION), ("wine_filesystem_sha256", WINE_WEB_SHA256)):
        if record.get(key) != expected:
            raise ValueError(f"build.json {key} is {record.get(key)!r}, expected {expected}")
    assets = record.get("assets")
    if not isinstance(assets, dict) or not assets:
        raise ValueError("build.json lacks the runtime asset identities (assets)")
    for name, identity in assets.items():
        path = root / "runtime" / name
        if not path.is_file():
            raise ValueError(f"build.json lists a missing runtime asset: runtime/{name}")
        if path.stat().st_size != identity["bytes"]:
            raise ValueError(f"runtime/{name} is {path.stat().st_size} bytes, build.json says {identity['bytes']}")
        if sha256(path) != identity["sha256"]:
            raise ValueError(f"runtime/{name} does not match its SHA-256 in build.json")
    wasm = root / "runtime/boxedwine.wasm"
    if not wasm.is_file() or wasm.read_bytes()[:8] != WASM_HEADER:
        raise ValueError("runtime/boxedwine.wasm is missing or is not a WebAssembly module")
    if not (root / ".nojekyll").exists():
        raise ValueError("The site lacks .nojekyll, so GitHub Pages would run Jekyll on it")


def verify_sums(root):
    """Check every SHA256SUMS entry: strict format, a path inside the site and a matching digest.

    Return the set of listed paths, as written in SHA256SUMS.
    """
    lines = (root / "SHA256SUMS").read_text(encoding="utf-8").rstrip("\n").split("\n")
    if lines == [""]:
        raise ValueError("SHA256SUMS lists no files")
    site = root.resolve()
    listed = set()
    for number, line in enumerate(lines, 1):
        match = SUM_LINE.fullmatch(line)
        if not match:
            raise ValueError(f"SHA256SUMS line {number} is not '<64 lowercase hex>  <path>': {line!r}")
        expected, relative = match.groups()
        path = (root / relative).resolve()
        if not path.is_relative_to(site):
            raise ValueError(f"SHA256SUMS path escapes the site: {relative}")
        if not path.is_file():
            raise ValueError(f"SHA256SUMS lists a missing file: {relative}")
        if sha256(path) != expected:
            raise ValueError(f"SHA256SUMS digest does not match: {relative}")
        listed.add(relative)
    return listed


def verify_relative_urls(root, html_path):
    """Require every local src/href in a page to be relative and to resolve to a file inside the site."""
    page = html_path.relative_to(root).as_posix()
    site = root.resolve()
    parser = References()
    parser.feed(html_path.read_text(encoding="utf-8"))
    for reference in parser.paths:
        url = urllib.parse.urlsplit(reference)
        if url.scheme or url.netloc or not url.path:
            continue
        if url.path.startswith("/"):
            raise ValueError(f"Root URL breaks project Pages in {page}: {reference}")
        path = (html_path.parent / url.path).resolve()
        if not path.is_relative_to(site):
            raise ValueError(f"URL in {page} escapes the site: {reference}")
        if not path.exists():
            raise ValueError(f"URL in {page} points to a missing file: {reference}")


def links_to_research(html):
    """Return whether a page links to the research directory (research/, or a file under it)."""
    parser = References()
    parser.feed(html)
    for reference in parser.paths:
        url = urllib.parse.urlsplit(reference)
        if url.scheme or url.netloc:
            continue
        parts = [part for part in PurePosixPath(urllib.parse.unquote(url.path)).parts if part != "."]
        if parts and parts[0] == RESEARCH_DIR:
            return True
    return False


def verify_research_site(root, listed):
    """Check the published research directory when index.html links to it or it exists.

    It must hold research/index.html, pass build_research.verify_research() (the notice on every page, no
    scripts or external resources, local links resolving inside research/), and every file under it must be
    listed in SHA256SUMS (`listed`, from verify_sums). Return the number of research files, 0 when there is none.
    """
    research = root / RESEARCH_DIR
    linked = links_to_research((root / "index.html").read_text(encoding="utf-8"))
    if not linked and not research.exists():
        return 0
    if not (research / "index.html").is_file():
        raise ValueError(f"index.html links to {RESEARCH_DIR}/ but the site has no {RESEARCH_DIR}/index.html; "
                         f"run scripts/build_research.py --output <site>/{RESEARCH_DIR} before build_web.py")
    # Imported here: build_research imports this module for the rights-notice wording.
    from build_research import verify_research
    try:
        verify_research(research)
    except ValueError as error:
        raise ValueError(f"{RESEARCH_DIR}/: {error}") from error
    verify_relative_urls(root, research / "index.html")
    files = sorted(path.relative_to(root).as_posix() for path in research.rglob("*") if path.is_file())
    unlisted = [name for name in files if name not in listed]
    if unlisted:
        shown = ", ".join(unlisted[:5]) + (f" and {len(unlisted) - 5} more" if len(unlisted) > 5 else "")
        raise ValueError(f"SHA256SUMS does not list these research files: {shown}")
    return len(files)


def verify_script_order(html):
    """Require game.html to load the runtime bridge before the emulator."""
    for script in ("runtime-bridge.js", "boxedwine.js"):
        if script not in html:
            raise ValueError(f"runtime/game.html does not load {script}")
    if html.index("runtime-bridge.js") > html.index("boxedwine.js"):
        raise ValueError("runtime/game.html must load runtime-bridge.js before boxedwine.js")


def verify_archive(zip_path, manifest):
    """Require the game archive to hold exactly the manifest's files, byte for byte."""
    for item in manifest:
        path = PurePosixPath(item["path"])
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"Manifest path escapes the archive root: {item['path']}")
    name = zip_path.name
    try:
        with zipfile.ZipFile(zip_path) as archive:
            corrupt = archive.testzip()
            if corrupt is not None:
                raise ValueError(f"{name} has a corrupt member: {corrupt}")
            names, expected = set(archive.namelist()), {item["path"] for item in manifest}
            for label, paths in (("lacks manifest files", expected - names), ("has files outside the manifest", names - expected)):
                if paths:
                    listed = ", ".join(sorted(paths)[:5]) + (f" and {len(paths) - 5} more" if len(paths) > 5 else "")
                    raise ValueError(f"{name} {label}: {listed}")
            for item in manifest:
                data = archive.read(item["path"])
                if len(data) != item["size"]:
                    raise ValueError(f"{name} member {item['path']} is {len(data)} bytes, the manifest says {item['size']}")
                if hashlib.sha256(data).hexdigest() != item["sha256"]:
                    raise ValueError(f"{name} member {item['path']} does not match its manifest SHA-256")
    except (zipfile.BadZipFile, zlib.error, EOFError) as error:
        raise ValueError(f"{name} is not a readable ZIP archive: {error}") from error


def verify(root, manifest=None):
    """Run every check on a built site; the manifest defaults to analysis/game-file-manifest.json."""
    if manifest is None:
        manifest = json.loads(MANIFEST.read_text())
    verify_build_record(root, json.loads((root / "build.json").read_text()))
    verify_notice((root / "index.html").read_text(encoding="utf-8"))
    # Before the relative-URL checks, so a missing research/ fails with its own message.
    research = verify_research_site(root, verify_sums(root))
    for html in (root / "index.html", root / "runtime/game.html"):
        verify_relative_urls(root, html)
    verify_script_order((root / "runtime/game.html").read_text(encoding="utf-8"))
    verify_archive(root / "runtime/fr3.zip", manifest)
    pages = f" and {research} research files" if research else ""
    print(f"Verified static Pages build, rights notice, relative URLs, manifests{pages} "
          f"and all {len(manifest)} original demo files")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", type=Path)
    verify(parser.parse_args().site.resolve())
