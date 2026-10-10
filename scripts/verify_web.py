"""Check static assets, original game identity and project-page URL compatibility."""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path, PurePosixPath
import urllib.parse
import zipfile

from setup_web_tools import BOXEDWINE_REVISION, WINE_WEB_SHA256


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ("src", "href") and value:
                self.paths.append(value)


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify(root):
    record = json.loads((root / "build.json").read_text())
    assert record["boxedwine_revision"] == BOXEDWINE_REVISION
    assert record["wine_filesystem_sha256"] == WINE_WEB_SHA256
    for name, identity in record["assets"].items():
        path = root / "runtime" / name
        assert path.stat().st_size == identity["bytes"], name
        assert sha256(path) == identity["sha256"], name
    assert (root / "runtime/boxedwine.wasm").read_bytes()[:8] == b"\0asm\x01\0\0\0"
    assert (root / ".nojekyll").exists()
    for line in (root / "SHA256SUMS").read_text().splitlines():
        expected, relative = line.split("  ", 1)
        path = (root / relative).resolve()
        assert path.is_relative_to(root.resolve()), relative
        assert sha256(path) == expected, relative
    for html in (root / "index.html", root / "runtime/game.html"):
        parser = References()
        parser.feed(html.read_text())
        for reference in parser.paths:
            url = urllib.parse.urlsplit(reference)
            if url.scheme or url.netloc or not url.path:
                continue
            assert not url.path.startswith("/"), f"Root URL breaks project Pages: {reference}"
            path = (html.parent / url.path).resolve()
            assert path.is_relative_to(root.resolve()) and path.exists(), reference
    html = (root / "runtime/game.html").read_text()
    assert html.index("runtime-bridge.js") < html.index("boxedwine.js")
    manifest = json.loads((Path(__file__).resolve().parents[1] / "analysis/game-file-manifest.json").read_text())
    with zipfile.ZipFile(root / "runtime/fr3.zip") as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == {item["path"] for item in manifest}
        for item in manifest:
            data = archive.read(item["path"])
            assert len(data) == item["size"]
            assert hashlib.sha256(data).hexdigest() == item["sha256"], item["path"]
            path = PurePosixPath(item["path"])
            assert not path.is_absolute() and ".." not in path.parts
    print(f"Verified static Pages build, relative URLs, manifests and all {len(manifest)} original demo files")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", type=Path)
    verify(parser.parse_args().site.resolve())
