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
from unittest import mock
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fr3_common import DEMO_PAGE, SHUFFLE_PAGE
from setup_web_tools import BOXEDWINE_REVISION, WINE_WEB_SHA256
import verify_web
from verify_web import (ISSUES_PAGE, PACKET, RIGHTS_CREDIT, WASM_HEADER, links_to_packet, links_to_research, verify,
                        verify_archive, verify_build_record, verify_http_game, verify_native_notice, verify_notice,
                        verify_packet, verify_relative_urls, verify_research_site, verify_script_order, verify_sums)

import build_research
import build_web
import package_research
from test_build_research import write_analysis, write_game

ROOT = Path(__file__).resolve().parents[1]

NOTICE = f"""<aside id="rights-notice" aria-label="Rights notice"><p>Unofficial preview.
  {RIGHTS_CREDIT}</p><p><a href="{DEMO_PAGE}" rel="noopener">Official demo</a>
  <a href="{ISSUES_PAGE}" rel="noopener">Request removal</a></p></aside>"""
PLAYER = '<section class="player" aria-label="Game player"><div id="screen"></div></section>'
NATIVE_STAGE = ('<div id="stage"><canvas id="fr3-canvas"></canvas>'
                '<div id="overlay" role="status"><h1>Ford Racing 3</h1><p id="msg">Loading…</p></div></div>')


def native_page(*parts):
    return "<!doctype html><html><body>" + "".join(parts) + "</body></html>"


def page(*parts):
    return "<!doctype html><html><body><main>" + "".join(parts) + "</main></body></html>"


class VerifyNoticeTests(unittest.TestCase):
    def test_accept_notice_above_player(self):
        verify_notice(page('<section class="intro">', NOTICE, "</section>", PLAYER))

    def test_accept_repository_page(self):
        verify_notice((ROOT / "web/index.html").read_text(encoding="utf-8"))

    def test_repository_page_links_to_research(self):
        html = (ROOT / "web/index.html").read_text(encoding="utf-8")
        self.assertIn(SHUFFLE_PAGE, html)
        self.assertFalse(links_to_research(html))

    def test_repository_page_links_to_packet_in_intro_and_footer(self):
        html = (ROOT / "web/index.html").read_text(encoding="utf-8")
        self.assertFalse(links_to_packet(html))
        self.assertIn('<a href="build.json">Build details</a>', html)

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


class VerifyNativeNoticeTests(unittest.TestCase):
    def test_accept_notice_beside_stage(self):
        verify_native_notice(native_page(NATIVE_STAGE, NOTICE))

    def test_accept_repository_page(self):
        verify_native_notice((ROOT / "web/native.html").read_text(encoding="utf-8"))

    def test_repository_page_says_it_is_a_reimplementation(self):
        html = (ROOT / "web/native.html").read_text(encoding="utf-8")
        notice = html[html.index('id="rights-notice"'):html.index("</aside>")]
        self.assertIn("independent reimplementation", notice)
        self.assertIn("not the original executable", notice)
        self.assertIn("approximations", notice)

    def test_reject_missing_notice(self):
        with self.assertRaisesRegex(ValueError, r"^native.html lacks the rights-holder notice \(#rights-notice\)$"):
            verify_native_notice(native_page(NATIVE_STAGE))

    def test_reject_missing_credit(self):
        with self.assertRaisesRegex(ValueError, f"^The rights-holder notice in native.html lacks the credit: {RIGHTS_CREDIT}$"):
            verify_native_notice(native_page(NATIVE_STAGE, NOTICE.replace(RIGHTS_CREDIT, "Ford Racing 3 demo")))

    def test_reject_missing_links(self):
        for url, expected in ((DEMO_PAGE, SHUFFLE_PAGE), (ISSUES_PAGE, ISSUES_PAGE)):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, f"^The rights-holder notice in native.html lacks a link to {expected}$"):
                verify_native_notice(native_page(NATIVE_STAGE, NOTICE.replace(url, "https://example.com/")))

    def test_reject_notice_inside_loading_overlay(self):
        stage = NATIVE_STAGE.replace('<p id="msg">', NOTICE + '<p id="msg">')
        with self.assertRaisesRegex(ValueError, "must not be inside the loading overlay"):
            verify_native_notice(native_page(stage))

    def test_accept_notice_after_nested_overlay_closes(self):
        stage = NATIVE_STAGE.replace("<h1>", "<div><div>nested</div></div><h1>")
        verify_native_notice(native_page(stage, NOTICE))


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
    (root / "native.html").write_text(native_page(NATIVE_STAGE, NOTICE), encoding="utf-8")
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
                                            "and all 2 game files\n")

    def test_verify_http_game_site(self):
        for rel, data in FILES.items():
            target = self.root / "runtime/game" / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        manifest_json = {"version": 1, "baseUrl": "game", "files": sorted(FILES)}
        (self.root / "runtime/game-manifest.json").write_text(json.dumps(manifest_json), encoding="utf-8")
        verify_http_game(self.root, self.manifest)
        (self.root / "runtime/game/DATA/one.txt").write_bytes(b"corrupted")
        with self.assertRaisesRegex(ValueError, "bytes, the manifest says"):
            verify_http_game(self.root, self.manifest)

    def test_default_manifest_is_the_repository_manifest(self):
        self.assertEqual(verify_web.MANIFEST, ROOT / "analysis/game-file-manifest.json")
        self.assertTrue(verify_web.MANIFEST.is_file())

    def test_reject_site_with_unlisted_game_file(self):
        with self.assertRaisesRegex(ValueError, "lacks manifest files"):
            verify(self.root, [*self.manifest, {"path": "DATA/three.txt", "size": 1, "sha256": digest(b"3")}])

    def test_reject_site_without_native_page(self):
        (self.root / "native.html").unlink()
        write_sums(self.root)
        with self.assertRaisesRegex(ValueError, "lacks native.html"):
            verify(self.root, self.manifest)

    def test_reject_native_page_without_notice_parts(self):
        for missing in (RIGHTS_CREDIT, DEMO_PAGE, ISSUES_PAGE):
            with self.subTest(missing=missing):
                (self.root / "native.html").write_text(native_page(NATIVE_STAGE, NOTICE.replace(missing, "x")),
                                                      encoding="utf-8")
                write_sums(self.root)
                with self.assertRaisesRegex(ValueError, "rights-holder notice in native.html lacks"):
                    verify(self.root, self.manifest)

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


class ResearchSiteTestCase(unittest.TestCase):
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


class ResearchSiteTests(ResearchSiteTestCase):
    def test_accept_site_with_research(self):
        files = self.research_files()
        self.assertIn("research/index.html", files)
        self.assertIn("research/evidence/pcg-index.json", files)
        self.assertEqual(self.verify(), f"Verified static Pages build, rights notice, relative URLs, manifests and "
                                        f"{len(files)} research files and all 2 game files\n")

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


PACKET_LINK = f'<a href="{PACKET}">Research packet</a>'
PE = json.loads((ROOT / "analysis/pe-metadata.json").read_text())


def write_packet(path, research, revision, edition=None, change=None):
    """Write a packet of research/ the way package_research.py lays it out, without its Git checks.

    change(files) may edit the {path: bytes} research files before the manifests are written over them.
    """
    files = {p.relative_to(research).as_posix(): p.read_bytes() for p in sorted(research.rglob("*")) if p.is_file()}
    if change:
        change(files)
    edition = edition or package_research.edition_name(revision)
    entries = dict(files)
    entries[package_research.MANIFEST] = package_research.render_manifest(edition, revision, PE, files)
    entries[package_research.SUMS] = package_research.render_sums(entries)
    path.parent.mkdir(parents=True, exist_ok=True)
    package_research.write_zip(path, edition, entries, package_research.DEFAULT_EPOCH)


class PacketSiteTests(ResearchSiteTestCase):
    """The research site above, plus the packet of its research/ at downloads/, linked from index.html."""

    REVISION = "0123abcd"

    def setUp(self):
        super().setUp()
        self.packet = self.root / PACKET
        self.repack()
        index = self.root / "index.html"
        index.write_text(index.read_text(encoding="utf-8").replace("</main>", PACKET_LINK + "</main>"),
                         encoding="utf-8")
        write_sums(self.root)

    def repack(self, **kwargs):
        kwargs.setdefault("revision", self.REVISION)
        write_packet(self.packet, self.root / "research", **kwargs)
        write_sums(self.root)

    def refuse(self, pattern):
        with self.assertRaisesRegex(ValueError, pattern):
            self.verify()

    def test_accept_site_with_packet(self):
        files = self.research_files()
        self.assertEqual(self.verify(), f"Verified static Pages build, rights notice, relative URLs, manifests and "
                                        f"{len(files)} research files plus the research packet and all 2 "
                                        "game files\n")
        self.assertEqual(verify_packet(self.root, verify_sums(self.root)), len(files))

    def test_accept_packet_written_by_package_research(self):
        # The real packager's output, with its Git and fresh-build checks stubbed: only the layout matters here.
        self.packet.unlink()
        with mock.patch.object(package_research, "committed_pe", return_value=PE), \
             mock.patch.object(package_research, "read_research",
                               side_effect=lambda research, *_: {p.relative_to(research).as_posix(): p.read_bytes()
                                                                 for p in sorted(research.rglob("*")) if p.is_file()}):
            package_research.package(self.root / "research", self.packet, revision=self.REVISION,
                                     epoch=package_research.DEFAULT_EPOCH)
        write_sums(self.root)
        self.verify()

    def test_site_without_packet_or_link_still_passes(self):
        index = self.root / "index.html"
        index.write_text(index.read_text(encoding="utf-8").replace(PACKET_LINK, ""), encoding="utf-8")
        shutil.rmtree(self.root / "downloads")
        write_sums(self.root)
        self.assertEqual(verify_packet(self.root, verify_sums(self.root)), 0)
        self.assertNotIn("packet", self.verify())

    def test_reject_missing_linked_packet(self):
        self.packet.unlink()
        write_sums(self.root)
        self.refuse(r"index\.html links to downloads/fr3-research-latest\.zip but the site has no such file")

    def test_reject_unlinked_packet_that_fails(self):
        # The packet is checked whenever it exists, even if index.html does not link to it.
        index = self.root / "index.html"
        index.write_text(index.read_text(encoding="utf-8").replace(PACKET_LINK, ""), encoding="utf-8")
        self.repack(revision="4567cdef")
        self.refuse("was built at revision '4567cdef'")

    def test_reject_packet_missing_from_sums(self):
        sums = self.root / "SHA256SUMS"
        sums.write_text("".join(line + "\n" for line in sums.read_text().splitlines() if not line.endswith(PACKET)))
        self.refuse("SHA256SUMS does not list the research packet: downloads/fr3-research-latest.zip")

    def test_reject_packet_with_different_revision(self):
        self.repack(revision="4567cdef")
        self.refuse(r"was built at revision '4567cdef', but research/index\.html names '0123abcd'")

    def test_reject_packet_folder_not_named_for_revision(self):
        self.repack(edition="fr3-research-other")
        self.refuse(r"holds folder fr3-research-other/, expected fr3-research-0123abcd/")

    def test_reject_packet_page_that_differs_from_research(self):
        def change(files):
            files["tyres.html"] = files["tyres.html"].replace(b"</body>", b"<p>edited</p></body>")
        self.repack(change=change)
        self.refuse("differs from the published research files: tyres.html")

    def test_reject_packet_with_extra_file(self):
        self.repack(change=lambda files: files.update({"notes.txt": b"not published"}))
        self.refuse("holds files not published under research/: notes.txt")

    def test_reject_packet_missing_file(self):
        self.repack(change=lambda files: files.pop("pcg.html"))
        self.refuse("lacks these research files: pcg.html")

    def test_reject_packet_with_two_top_level_folders(self):
        with zipfile.ZipFile(self.packet, "a") as archive:
            archive.writestr("elsewhere/x.txt", b"x")
        write_sums(self.root)
        self.refuse("must hold exactly one top-level folder")

    def test_reject_packet_without_manifest(self):
        with zipfile.ZipFile(self.packet) as archive:
            entries = {info.filename: archive.read(info) for info in archive.infolist()}
        write_zip(self.packet, {name: data for name, data in entries.items() if not name.endswith("/MANIFEST.json")})
        write_sums(self.root)
        self.refuse(r"lacks fr3-research-0123abcd/MANIFEST\.json")

    def test_reject_packet_whose_sums_disagree(self):
        # Every research file matches, but the packet's own SHA256SUMS does not: check_zip catches it.
        with zipfile.ZipFile(self.packet) as archive:
            entries = {info.filename: archive.read(info) for info in archive.infolist()}
        sums = f"{package_research.edition_name(self.REVISION)}/SHA256SUMS"
        entries[sums] = entries[sums].replace(entries[sums][:64], b"0" * 64)
        write_zip(self.packet, entries)
        write_sums(self.root)
        self.refuse("Packet content does not match SHA256SUMS")

    def test_reject_corrupt_packet(self):
        data = self.packet.read_bytes()
        self.packet.write_bytes(data[:len(data) // 2])
        write_sums(self.root)
        self.refuse("is not a readable ZIP archive")

    def test_links_to_packet(self):
        for html, expected in ((PACKET_LINK, True), (f'<a href="./{PACKET}">x</a>', True),
                               ('<a href="downloads/">x</a>', False), ('<a href="research/">x</a>', False),
                               (f'<a href="https://example.com/{PACKET}">x</a>', False)):
            with self.subTest(html=html):
                self.assertEqual(links_to_packet(html), expected)


class CacheBustingTests(unittest.TestCase):
    def test_copy_web_assets_stamps_native_bundle_chain(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out1, out2 = root / "out1", root / "out2"
            out1.mkdir()
            out2.mkdir()
            bundle1 = root / "bundle1.js"
            bundle2 = root / "bundle2.js"
            bundle1.write_text("export const version = 1;\n", encoding="utf-8")
            bundle2.write_text("export const version = 2;\n", encoding="utf-8")

            dest1 = build_web.copy_native_bundle(out1, bundle1)
            build_web.copy_web_assets(out1, dest1)
            dest2 = build_web.copy_native_bundle(out2, bundle2)
            build_web.copy_web_assets(out2, dest2)

            hash1 = build_web.digest(dest1)[:12]
            hash2 = build_web.digest(dest2)[:12]
            self.assertNotEqual(hash1, hash2)

            native1 = (out1 / "native.html").read_text(encoding="utf-8")
            native2 = (out2 / "native.html").read_text(encoding="utf-8")
            self.assertIn(f"./native/fr3-engine.js?v={hash1}", native1)
            self.assertIn(f"./native/fr3-engine.js?v={hash2}", native2)

            native_hash1 = build_web.digest(out1 / "native.html")[:12]
            site_js1 = (out1 / "site.js").read_text(encoding="utf-8")
            self.assertIn(f"native.html?v={native_hash1}&sound=", site_js1)

            site_hash1 = build_web.digest(out1 / "site.js")[:12]
            css_hash1 = build_web.digest(out1 / "site.css")[:12]
            index1 = (out1 / "index.html").read_text(encoding="utf-8")
            self.assertIn(f'src="site.js?v={site_hash1}"', index1)
            self.assertIn(f'href="site.css?v={css_hash1}"', index1)

            # Stamped index.html still passes verify_notice and verify_relative_urls (for existing targets).
            verify_notice(index1)
            (out1 / "build.json").write_text("{}", encoding="utf-8")
            verify_relative_urls(out1, out1 / "index.html")


if __name__ == "__main__":
    unittest.main()
