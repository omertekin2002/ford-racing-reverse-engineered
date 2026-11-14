"""Synthetic tests for the browser preview's site checks; no network, no demo files."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fr3_common import DEMO_PAGE
from setup_web_tools import BOXEDWINE_REVISION, WINE_WEB_SHA256
import verify_web
from verify_web import (ISSUES_PAGE, RIGHTS_CREDIT, WASM_HEADER, links_to_research, verify, verify_archive,
                        verify_build_record, verify_notice, verify_relative_urls, verify_research_site,
                        verify_script_order, verify_sums)

import build_research
from test_build_research import write_analysis, write_game

ROOT = Path(__file__).resolve().parents[1]

NOTICE = f"""<aside id="rights-notice" aria-label="Rights notice"><p>Unofficial preview.
  {RIGHTS_CREDIT}</p><p><a href="{DEMO_PAGE}" rel="noopener">Official demo</a>
  <a href="{ISSUES_PAGE}" rel="noopener">Request removal</a></p></aside>"""
PLAYER = '<section class="player" aria-label="Game player"><div id="screen"></div></section>'


def page(*parts):
    return "<!doctype html><html><body><main>" + "".join(parts) + "</main></body></html>"


class VerifyNoticeTests(unittest.TestCase):
    def test_accept_notice_above_player(self):
        verify_notice(page('<section class="intro">', NOTICE, "</section>", PLAYER))

    def test_accept_repository_page(self):
        verify_notice((ROOT / "web/index.html").read_text(encoding="utf-8"))

    def test_repository_page_links_to_research(self):
        html = (ROOT / "web/index.html").read_text(encoding="utf-8")
        self.assertIn('<a href="research/">Explore findings</a>', html)
        self.assertTrue(links_to_research(html))

    def test_reject_missing_notice(self):
        with self.assertRaisesRegex(ValueError, "lacks the rights-holder notice"):
            verify_notice(page(PLAYER))

    def test_reject_notice_below_player(self):
        with self.assertRaisesRegex(ValueError, "above the player"):
            verify_notice(page(PLAYER, NOTICE))

    def test_reject_missing_credit(self):
        with self.assertRaisesRegex(ValueError, "credit"):
            verify_notice(page(NOTICE.replace(RIGHTS_CREDIT, "Ford Racing 3 demo"), PLAYER))

    def test_reject_credit_outside_notice(self):
        notice = NOTICE.replace(RIGHTS_CREDIT, "")
        with self.assertRaisesRegex(ValueError, "credit"):
            verify_notice(page(notice, PLAYER, f"<footer>{RIGHTS_CREDIT}</footer>"))

    def test_reject_missing_links(self):
        for url in (DEMO_PAGE, ISSUES_PAGE):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "lacks a link"):
                verify_notice(page(NOTICE.replace(url, "https://example.com/"), PLAYER))

    def test_reject_link_outside_notice(self):
        notice = NOTICE.replace(DEMO_PAGE, "https://example.com/")
        with self.assertRaisesRegex(ValueError, "lacks a link"):
            verify_notice(page(notice, f'<p><a href="{DEMO_PAGE}">Demo</a></p>', PLAYER))

    def test_nested_same_tag_stays_inside_notice(self):
        notice = NOTICE.replace("<p>Unofficial", "<aside>Nested</aside><p>Unofficial")
        verify_notice(page(notice, PLAYER))


FILES = {"DATA/one.txt": b"first synthetic game file", "DATA/SUB/two.bin": bytes(range(64))}
GAME_HTML = ('<!doctype html><html><head><link rel="stylesheet" href="../emulator.css"></head><body>'
             '<script src="../runtime-bridge.js"></script><script async src="boxedwine.js"></script></body></html>')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def manifest_for(files):
    return [{"path": path, "size": len(data), "sha256": digest(data)} for path, data in files.items()]


def write_zip(path, files):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)


def write_sums(root):
    """Write SHA256SUMS the way build_web.py does."""
    (root / "SHA256SUMS").write_text("".join(f"{digest(p.read_bytes())}  {p.relative_to(root).as_posix()}\n"
                                             for p in sorted(root.rglob("*")) if p.is_file() and p.name != "SHA256SUMS"))


def build_site(root):
    """Lay out a small site shaped like build_web.py's output and return its game-file manifest."""
    runtime = root / "runtime"
    runtime.mkdir(parents=True)
    (root / "index.html").write_text(page(NOTICE, PLAYER, '<a href="runtime/game.html#play">Play</a>',
                                          '<link href="site.css"><a href="https://example.com/">x</a><a href="#top">top</a>'),
                                     encoding="utf-8")
    for name in ("site.css", "emulator.css", "runtime-bridge.js"):
        (root / name).write_text(f"/* {name} */\n")
    (runtime / "game.html").write_text(GAME_HTML, encoding="utf-8")
    (runtime / "boxedwine.js").write_text("// synthetic emulator\n")
    (runtime / "boxedwine.wasm").write_bytes(WASM_HEADER + b"synthetic module")
    (runtime / "wine11.zip").write_bytes(b"synthetic wine filesystem")
    write_zip(runtime / "fr3.zip", FILES)
    assets = {name: {"bytes": (runtime / name).stat().st_size, "sha256": digest((runtime / name).read_bytes())}
              for name in ("boxedwine.js", "boxedwine.wasm", "wine11.zip", "fr3.zip")}
    record = {"boxedwine_revision": BOXEDWINE_REVISION, "wine_filesystem_sha256": WINE_WEB_SHA256, "assets": assets}
    (root / "build.json").write_text(json.dumps(record))
    (root / ".nojekyll").touch()
    write_sums(root)
    return manifest_for(FILES)


class SiteTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / "site"
        self.manifest = build_site(self.root)

    def record(self):
        return json.loads((self.root / "build.json").read_text())


class VerifyBuildRecordTests(SiteTestCase):
    def test_accept_valid_record(self):
        verify_build_record(self.root, self.record())

    def test_reject_wrong_pins(self):
        for key in ("boxedwine_revision", "wine_filesystem_sha256"):
            record = self.record()
            record[key] = "0" * 40
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                verify_build_record(self.root, record)

    def test_reject_wrong_asset_size(self):
        record = self.record()
        record["assets"]["wine11.zip"]["bytes"] += 1
        with self.assertRaisesRegex(ValueError, r"runtime/wine11\.zip is \d+ bytes"):
            verify_build_record(self.root, record)

    def test_reject_wrong_asset_hash(self):
        record = self.record()
        record["assets"]["boxedwine.js"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, r"runtime/boxedwine\.js does not match its SHA-256"):
            verify_build_record(self.root, record)

    def test_reject_missing_asset(self):
        record = self.record()
        record["assets"]["absent.js"] = {"bytes": 0, "sha256": digest(b"")}
        with self.assertRaisesRegex(ValueError, "missing runtime asset: runtime/absent.js"):
            verify_build_record(self.root, record)

    def test_reject_missing_assets(self):
        for assets in (None, {}, []):
            record = self.record()
            if assets is None:
                del record["assets"]
            else:
                record["assets"] = assets
            with self.subTest(assets=assets), self.assertRaisesRegex(ValueError, r"lacks the runtime asset identities"):
                verify_build_record(self.root, record)

    def test_reject_missing_nojekyll(self):
        (self.root / ".nojekyll").unlink()
        with self.assertRaisesRegex(ValueError, r"\.nojekyll"):
            verify_build_record(self.root, self.record())

    def test_reject_non_wasm_module(self):
        wasm = self.root / "runtime/boxedwine.wasm"
        wasm.write_bytes(b"<!doctype html>not found")
        record = self.record()
        record["assets"]["boxedwine.wasm"] = {"bytes": wasm.stat().st_size, "sha256": digest(wasm.read_bytes())}
        with self.assertRaisesRegex(ValueError, r"boxedwine\.wasm .* not a WebAssembly module"):
            verify_build_record(self.root, record)


class VerifySumsTests(SiteTestCase):
    def test_accept_valid_sums(self):
        verify_sums(self.root)

    def test_accept_blank_trailing_line(self):
        sums = self.root / "SHA256SUMS"
        sums.write_text(sums.read_text() + "\n")
        verify_sums(self.root)

    def test_reject_hash_mismatch(self):
        (self.root / "site.css").write_text("/* changed after hashing */\n")
        with self.assertRaisesRegex(ValueError, "digest does not match: site.css"):
            verify_sums(self.root)

    def test_reject_path_escaping_site(self):
        outside = self.root.parent / "x"
        outside.write_bytes(b"outside the site")
        (self.root / "SHA256SUMS").write_text(f"{digest(outside.read_bytes())}  ../x\n")
        with self.assertRaisesRegex(ValueError, r"escapes the site: \.\./x"):
            verify_sums(self.root)

    def test_reject_missing_file(self):
        (self.root / "SHA256SUMS").write_text(f"{digest(b'')}  gone.txt\n")
        with self.assertRaisesRegex(ValueError, "missing file: gone.txt"):
            verify_sums(self.root)

    def test_reject_malformed_lines(self):
        good = digest((self.root / "site.css").read_bytes())
        for line in (f"{good} site.css", f"{good}\tsite.css", good, f"{good.upper()}  site.css",
                     f"{good[:-1]}  site.css", f"{good}  "):
            with self.subTest(line=line), self.assertRaisesRegex(ValueError, "SHA256SUMS line 1 is not"):
                (self.root / "SHA256SUMS").write_text(line + "\n")
                verify_sums(self.root)

    def test_reject_blank_line_between_entries(self):
        sums = self.root / "SHA256SUMS"
        lines = sums.read_text().splitlines()
        sums.write_text("\n".join([lines[0], "", *lines[1:]]) + "\n")
        with self.assertRaisesRegex(ValueError, "SHA256SUMS line 2 is not"):
            verify_sums(self.root)

    def test_reject_empty_sums(self):
        (self.root / "SHA256SUMS").write_text("")
        with self.assertRaisesRegex(ValueError, "lists no files"):
            verify_sums(self.root)


class VerifyRelativeUrlsTests(SiteTestCase):
    def check(self, *references):
        html = self.root / "runtime/game.html"
        html.write_text("".join(f'<script src="{reference}"></script>' for reference in references), encoding="utf-8")
        verify_relative_urls(self.root, html)

    def test_accept_site_pages(self):
        for html in ("index.html", "runtime/game.html"):
            verify_relative_urls(self.root, self.root / html)

    def test_skip_external_and_fragment_references(self):
        self.check("https://example.com/x.js", "//cdn.example/x.js", "#fragment", "data:text/javascript,0",
                   "boxedwine.js?v=1#top")

    def test_reject_root_relative_url(self):
        with self.assertRaisesRegex(ValueError, r"Root URL breaks project Pages in runtime/game\.html: /x\.js"):
            self.check("/x.js")

    def test_reject_missing_target(self):
        with self.assertRaisesRegex(ValueError, r"missing file: \.\./absent\.js"):
            self.check("../absent.js")

    def test_reject_path_escaping_site(self):
        (self.root.parent / "outside.js").write_text("// outside the site\n")
        with self.assertRaisesRegex(ValueError, r"escapes the site: \.\./\.\./outside\.js"):
            self.check("../../outside.js")


class VerifyScriptOrderTests(unittest.TestCase):
    def test_accept_bridge_first(self):
        verify_script_order(GAME_HTML)

    def test_reject_bridge_after_emulator(self):
        html = '<script async src="boxedwine.js"></script><script src="../runtime-bridge.js"></script>'
        with self.assertRaisesRegex(ValueError, "runtime-bridge.js before boxedwine.js"):
            verify_script_order(html)

    def test_reject_missing_script(self):
        for script in ("runtime-bridge.js", "boxedwine.js"):
            with self.subTest(script=script), self.assertRaisesRegex(ValueError, f"does not load {script}"):
                verify_script_order(GAME_HTML.replace(script, "other.js"))


class VerifyArchiveTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.zip = Path(directory.name) / "fr3.zip"
        self.manifest = manifest_for(FILES)
        write_zip(self.zip, FILES)

    def test_accept_matching_archive(self):
        verify_archive(self.zip, self.manifest)

    def test_reject_missing_manifest_file(self):
        write_zip(self.zip, {"DATA/one.txt": FILES["DATA/one.txt"]})
        with self.assertRaisesRegex(ValueError, "lacks manifest files: DATA/SUB/two.bin"):
            verify_archive(self.zip, self.manifest)

    def test_reject_extra_file(self):
        write_zip(self.zip, {**FILES, "DATA/extra.txt": b"extra"})
        with self.assertRaisesRegex(ValueError, "outside the manifest: DATA/extra.txt"):
            verify_archive(self.zip, self.manifest)

    def test_reject_wrong_size(self):
        self.manifest[0]["size"] += 1
        with self.assertRaisesRegex(ValueError, r"member DATA/one\.txt is \d+ bytes"):
            verify_archive(self.zip, self.manifest)

    def test_reject_wrong_hash(self):
        self.manifest[1]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "member DATA/SUB/two.bin does not match"):
            verify_archive(self.zip, self.manifest)

    def test_reject_corrupt_member(self):
        data = self.zip.read_bytes()
        where = data.index(FILES["DATA/one.txt"])
        self.zip.write_bytes(data[:where] + b"X" + data[where + 1:])
        with self.assertRaisesRegex(ValueError, "corrupt member: DATA/one.txt"):
            verify_archive(self.zip, self.manifest)

    def test_reject_unreadable_archive(self):
        self.zip.write_bytes(b"not a zip archive")
        with self.assertRaisesRegex(ValueError, "not a readable ZIP archive"):
            verify_archive(self.zip, self.manifest)

    def test_reject_escaping_manifest_paths(self):
        for path in ("/DATA/one.txt", "DATA/../../one.txt"):
            manifest = [*self.manifest, {"path": path, "size": 0, "sha256": digest(b"")}]
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "escapes the archive root"):
                verify_archive(self.zip, manifest)


class VerifySiteTests(SiteTestCase):
    def test_verify_complete_site(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            verify(self.root, self.manifest)
        self.assertEqual(output.getvalue(), "Verified static Pages build, rights notice, relative URLs, manifests "
                                            "and all 2 original demo files\n")

    def test_default_manifest_is_the_repository_manifest(self):
        self.assertEqual(verify_web.MANIFEST, ROOT / "analysis/game-file-manifest.json")
        self.assertTrue(verify_web.MANIFEST.is_file())

    def test_reject_site_with_unlisted_game_file(self):
        with self.assertRaisesRegex(ValueError, "lacks manifest files"):
            verify(self.root, [*self.manifest, {"path": "DATA/three.txt", "size": 1, "sha256": digest(b"3")}])

    def test_bad_site_still_fails_under_optimize(self):
        # A file changed after hashing used to pass under -O, which stripped the bare asserts.
        # The subprocess's own assert False proves -O is in effect before the verifier runs.
        (self.root / "site.css").write_text("/* changed after hashing */\n")
        manifest = self.root.parent / "manifest.json"
        manifest.write_text(json.dumps(self.manifest))
        code = ("import json, sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); "
                "assert False, 'assert statements still run'; import verify_web; "
                "verify_web.verify(Path(sys.argv[2]), json.loads(Path(sys.argv[3]).read_text()))")
        result = subprocess.run([sys.executable, "-O", "-c", code, str(ROOT / "scripts"), str(self.root), str(manifest)],
                                capture_output=True, text=True, timeout=60)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ValueError: SHA256SUMS digest does not match: site.css", result.stderr)
        self.assertEqual(result.stdout, "")


RESEARCH_LINK = '<a href="research/">Explore findings</a>'


class ResearchSiteTests(unittest.TestCase):
    """A site with research/ built by build_research.py from fixture game files, as the Pages workflow lays it out."""

    @classmethod
    def setUpClass(cls):
        directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(directory.cleanup)
        work = Path(directory.name)
        cls.research = work / "research"
        build_research.build(write_game(work / "game"), cls.research, write_analysis(work / "analysis"),
                             revision="0123abcd")

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / "site"
        self.manifest = build_site(self.root)
        shutil.copytree(self.research, self.root / "research")
        index = self.root / "index.html"
        index.write_text(index.read_text(encoding="utf-8").replace("</main>", RESEARCH_LINK + "</main>"),
                         encoding="utf-8")
        write_sums(self.root)

    def research_files(self):
        return sorted(p.relative_to(self.root).as_posix() for p in (self.root / "research").rglob("*") if p.is_file())

    def verify(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            verify(self.root, self.manifest)
        return output.getvalue()

    def test_accept_site_with_research(self):
        files = self.research_files()
        self.assertIn("research/index.html", files)
        self.assertIn("research/evidence/pcg-index.json", files)
        self.assertEqual(self.verify(), f"Verified static Pages build, rights notice, relative URLs, manifests and "
                                        f"{len(files)} research files and all 2 original demo files\n")

    def test_sums_list_every_research_file(self):
        listed = verify_sums(self.root)
        self.assertTrue(set(self.research_files()) <= listed)
        self.assertEqual(verify_research_site(self.root, listed), len(self.research_files()))

    def test_reject_link_to_missing_research(self):
        shutil.rmtree(self.root / "research")
        write_sums(self.root)
        with self.assertRaisesRegex(ValueError, r"index\.html links to research/ but the site has no "
                                                r"research/index\.html"):
            self.verify()

    def test_reject_research_page_without_notice(self):
        page = self.root / "research/tyres.html"
        html = page.read_text(encoding="utf-8")
        start, end = html.index('<aside id="rights-notice"'), html.index("</aside>") + len("</aside>")
        page.write_text(html[:start] + html[end:], encoding="utf-8")
        write_sums(self.root)
        with self.assertRaisesRegex(ValueError, r"(?s)research/: .*tyres\.html lacks the rights-holder notice"):
            self.verify()

    def test_reject_research_page_with_broken_local_link(self):
        page = self.root / "research/engines.html"
        page.write_text(page.read_text(encoding="utf-8").replace("</body>", '<a href="evidence/gone.json">x</a></body>'),
                        encoding="utf-8")
        write_sums(self.root)
        with self.assertRaisesRegex(ValueError, r"(?s)research/: .*engines\.html has a broken local link: "
                                                r"'evidence/gone\.json'"):
            self.verify()

    def test_reject_research_file_the_build_does_not_write(self):
        # Listed in SHA256SUMS, so only the research check can stop it from being published.
        (self.root / "research/engines.json").write_text("{}", encoding="utf-8")
        write_sums(self.root)
        with self.assertRaisesRegex(ValueError, r"(?s)research/: .*engines\.json is not a file build_research\.py "
                                                r"writes"):
            self.verify()

    def test_reject_research_file_missing_from_sums(self):
        sums = self.root / "SHA256SUMS"
        sums.write_text("".join(line + "\n" for line in sums.read_text().splitlines()
                                if not line.endswith("  research/pcg.html")))
        with self.assertRaisesRegex(ValueError, "SHA256SUMS does not list these research files: research/pcg.html"):
            self.verify()

    def test_reject_unlinked_research_directory_that_fails(self):
        # research/ is checked whenever it exists, even if index.html does not link to it.
        index = self.root / "index.html"
        index.write_text(index.read_text(encoding="utf-8").replace(RESEARCH_LINK, ""), encoding="utf-8")
        (self.root / "research/pcg.html").unlink()
        write_sums(self.root)
        with self.assertRaisesRegex(ValueError, r"(?s)research/: .*pcg\.html is missing"):
            self.verify()

    def test_links_to_research(self):
        for html, expected in ((RESEARCH_LINK, True), ('<a href="./research/index.html">x</a>', True),
                               ('<a href="research">x</a>', True), ('<a href="research-notes.html">x</a>', False),
                               ('<a href="https://example.com/research/">x</a>', False),
                               ('<a href="runtime/research/">x</a>', False), ("<p>research/</p>", False)):
            with self.subTest(html=html):
                self.assertEqual(links_to_research(html), expected)


if __name__ == "__main__":
    unittest.main()
