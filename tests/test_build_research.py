"""Synthetic research-directory tests: fixture game files and analysis inputs, no demo needed."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_research
from dossier_common import INDEX_PAGE, NOTICE_LINKS, rights_notice
from fr3_common import DEMO_PAGE
from text_database import DATABASES, REPO_ROOT
from verify_web import ISSUES_PAGE, RIGHTS_CREDIT

from test_pcg_catalogue import manifest, pcg_index, verification
from test_record_dossier import ENGINES, GEARBOXES
from test_tyre_dossier import TYRES

SCRIPT = REPO_ROOT / "scripts/build_research.py"
PE = json.loads((REPO_ROOT / "analysis/pe-metadata.json").read_text())
PAGES = ("index.html", "engines.html", "gearboxes.html", "tyres.html", "pcg.html", "routines.html")
ASM = tuple(sorted(f"evidence/selected/{path.name}" for path in (REPO_ROOT / "analysis/selected").glob("*.asm")))
EVIDENCE = ("evidence/annotated/selected.c", "evidence/annotated/status.json", "evidence/pcg-index.json", *ASM,
            "evidence/selected/field-evidence.json", "evidence/unpacked-manifest.json")
COUNTS = {"engines": 4, "gearboxes": 2, "tyres": 3, "pcg_collections": 2, "pcg_graphics": 3, "routines": 25}


def write_game(root):
    """Write the three text databases, with the demo's CRLF line ends, under root; return root."""
    for stem, text in (("engines", ENGINES), ("gearboxes", GEARBOXES), ("tyres", TYRES)):
        path = root / DATABASES[stem]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.replace("\n", "\r\n").encode("ascii"))
    return root


def write_analysis(root):
    """Copy the committed analysis inputs the pages need, with a synthetic PCG index; return root."""
    shutil.copytree(REPO_ROOT / "analysis/selected", root / "selected")
    shutil.copytree(REPO_ROOT / "analysis/annotated", root / "annotated")
    for name in ("pe-metadata.json", "tags.json"):
        shutil.copyfile(REPO_ROOT / "analysis" / name, root / name)
    for name, data in (("pcg-index.json", pcg_index()), ("unpacked-manifest.json", manifest()),
                       ("verification.json", verification())):
        (root / name).write_text(json.dumps(data), encoding="utf-8")
    return root


def files_under(root):
    return sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file())


class ResearchTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.game = write_game(self.root / "game")
        self.analysis = write_analysis(self.root / "analysis")
        self.output = self.root / "site/research"

    def build(self, **kwargs):
        return build_research.build(self.game, self.output, self.analysis, revision="0123abcd", **kwargs)


class BuildTests(ResearchTestCase):
    def test_builds_a_self_contained_directory(self):
        self.assertEqual(self.build(), COUNTS)
        self.assertEqual(files_under(self.output), sorted((*PAGES, *EVIDENCE)))
        for relative in EVIDENCE:
            source = self.analysis / relative.removeprefix("evidence/")
            self.assertEqual((self.output / relative).read_bytes(), source.read_bytes(), relative)
        self.assertEqual(build_research.verify_research(self.output), sorted(PAGES))
        # Only the build's own directory is left beside the output: no staging directory, no parsed JSON.
        self.assertEqual([path.name for path in self.output.parent.iterdir()], ["research"])

    def test_every_page_has_the_notice_and_the_nav_bar(self):
        self.build()
        for page in PAGES:
            with self.subTest(page=page):
                text = (self.output / page).read_text(encoding="utf-8")
                self.assertEqual(text.count(rights_notice()), 1)
                self.assertLess(text.index("<nav>"), text.index(rights_notice()))
                self.assertLess(text.index(rights_notice()), text.index("<h1>"))
                nav = text[text.index("<nav>"):text.index("</nav>")]
                for other in PAGES:
                    self.assertIn("<strong>" if other == page else f'<a href="{other}">', nav)

    def test_evidence_links_point_inside_the_output(self):
        self.build()
        tyres = (self.output / "tyres.html").read_text(encoding="utf-8")
        for href in ("evidence/selected/tyre_table_accessors.asm", "evidence/selected/load_tyre_database.asm",
                     "evidence/selected/field-evidence.json"):
            self.assertIn(f'href="{href}"', tyres)
        pcg = (self.output / "pcg.html").read_text(encoding="utf-8")
        for href in ("evidence/pcg-index.json", "evidence/unpacked-manifest.json", "evidence/selected/build_pcg_view.asm"):
            self.assertIn(f'href="{href}"', pcg)
        for page in PAGES:
            self.assertNotIn('href="../', (self.output / page).read_text(encoding="utf-8"), page)

    def test_entrance_page_shows_counts_identity_and_scope(self):
        self.build()
        index = (self.output / INDEX_PAGE).read_text(encoding="utf-8")
        for text in ("4 engine records", "2 gearbox records", "3 tyre records", "2 collections, 3 graphics",
                     "25 annotated routines",
                     f'SHA-256 <code>{PE["sha256"]}</code>', "<code>0123abcd</code>",
                     "Values are shown exactly as declared", "stays labelled unresolved"):
            self.assertIn(text, index)
        links = re.findall(r'<a href="([^"]+)">', index)
        for page in PAGES[1:]:
            self.assertIn(page, links)
        for relative in EVIDENCE:
            self.assertIn(relative, links)

    def test_routines_page_links_its_copied_evidence(self):
        self.build()
        routines = (self.output / "routines.html").read_text(encoding="utf-8")
        for href in ("evidence/annotated/status.json", "evidence/annotated/selected.c",
                     "evidence/selected/field-evidence.json", *ASM):
            self.assertIn(f'href="{href}"', routines)
        self.assertEqual(routines.count('<section class="routine"'), 25)
        self.assertEqual(routines.count('<tr class="site"'), 32)
        self.assertIn('<a href="index.html">Explore findings</a>', routines)
        # Each routine's anchor is a real id: verify_research() accepts a deep link to it from another page.
        index = self.output / INDEX_PAGE
        index.write_text(index.read_text(encoding="utf-8").replace(
            "</body>", '<a href="routines.html#fr3_load_tyre_database">x</a></body>'), encoding="utf-8")
        build_research.verify_research(self.output)

    def test_routine_refusal_keeps_the_previous_output(self):
        self.build()
        before = {name: (self.output / name).read_bytes() for name in files_under(self.output)}
        selected_c = self.analysis / "annotated/selected.c"
        selected_c.write_text(selected_c.read_text(encoding="utf-8").replace(
            "/* 00523820 fr3_load_tyre_database */", "/* 00523820 fr3_renamed */"), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "fr3_load_tyre_database in status.json but fr3_renamed in selected.c"):
            self.build()
        self.assertEqual({name: (self.output / name).read_bytes() for name in files_under(self.output)}, before)

    def test_counts_come_from_the_inputs(self):
        (self.game / DATABASES["gearboxes"]).write_bytes(
            (GEARBOXES.replace(":END", ":TYPE EXTRA\n:CLUTCH_SPEED 0.5\n:END")).encode("ascii"))
        (self.analysis / "pcg-index.json").write_text(json.dumps(pcg_index()[:1]), encoding="utf-8")
        (self.analysis / "verification.json").write_text(
            json.dumps({"pcg_collections_verified": 1, "pcg_entries_verified": 2}), encoding="utf-8")
        self.assertEqual(self.build(), {**COUNTS, "gearboxes": 3, "pcg_collections": 1, "pcg_graphics": 2})
        index = (self.output / INDEX_PAGE).read_text(encoding="utf-8")
        self.assertIn("3 gearbox records", index)
        self.assertIn("1 collections, 2 graphics", index)

    def test_replaces_a_previous_build(self):
        self.build()
        (self.output / "tyres.html").write_text("stale", encoding="utf-8")
        self.build()
        self.assertIn(rights_notice(), (self.output / "tyres.html").read_text(encoding="utf-8"))

    def test_refuses_to_replace_a_directory_it_did_not_write(self):
        self.output.mkdir(parents=True)
        (self.output / "notes.txt").write_text("keep me", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "holds files build_research.py does not write: notes.txt"):
            self.build()
        self.assertEqual(files_under(self.output), ["notes.txt"])

    def test_refuses_to_replace_unknown_files_below_the_top_level(self):
        self.build()
        cases = (("evidence/notes.txt", "file"), ("evidence/selected/extra", "dir"), ("tyres.html", "dir"),
                 ("evidence/pcg-index.json", "dir"), ("index.html", "symlink"))
        for relative, kind in cases:
            with self.subTest(relative=relative, kind=kind):
                self.build()
                path = self.output / relative
                if path.exists():
                    path.unlink()
                if kind == "file":
                    path.write_text("keep me", encoding="utf-8")
                elif kind == "dir":
                    path.mkdir()
                else:
                    path.symlink_to(self.output / "tyres.html")
                with self.assertRaisesRegex(ValueError, f"does not write: {re.escape(relative)}"):
                    self.build()
                self.assertTrue(path.exists() or path.is_symlink())
                shutil.rmtree(self.output)

    def test_failed_build_leaves_no_output_or_staging(self):
        (self.game / DATABASES["tyres"]).unlink()
        with self.assertRaises(OSError):
            self.build()
        self.assertEqual(list(self.output.parent.iterdir()), [])

    def test_failed_build_keeps_the_previous_output(self):
        self.build()
        before = {name: (self.output / name).read_bytes() for name in files_under(self.output)}
        (self.analysis / "verification.json").write_text(json.dumps({**verification(), "pcg_entries_verified": 9}))
        with self.assertRaisesRegex(ValueError, "verification.json verified 9"):
            self.build()
        self.assertEqual({name: (self.output / name).read_bytes() for name in files_under(self.output)}, before)
        self.assertEqual([path.name for path in self.output.parent.iterdir()], ["research"])

    def test_missing_game_directory(self):
        with self.assertRaisesRegex(ValueError, "Game directory does not exist: .*acquire_demo.py"):
            build_research.build(self.root / "absent", self.output, self.analysis)
        self.assertFalse(self.output.parent.exists())


class VerifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        root = Path(cls.directory.name)
        cls.built = root / "research"
        build_research.build(write_game(root / "game"), cls.built, write_analysis(root / "analysis"), revision="0123abcd")

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / "research"
        shutil.copytree(self.built, self.root)

    def edit(self, page, old, new):
        path = self.root / page
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def reject(self, fragment):
        with self.assertRaises(ValueError) as caught:
            build_research.verify_research(self.root)
        self.assertIn(fragment, str(caught.exception))

    def test_accepts_the_built_directory(self):
        self.assertEqual(build_research.verify_research(self.root), sorted(PAGES))

    def test_missing_page(self):
        (self.root / "pcg.html").unlink()
        self.reject("pcg.html is missing")

    def test_missing_notice(self):
        for page in PAGES:
            with self.subTest(page=page):
                self.setUp()
                self.edit(page, rights_notice(), "")
                self.reject(f"{page} lacks the rights-holder notice")

    def test_notice_without_its_credit_or_links(self):
        self.edit("tyres.html", RIGHTS_CREDIT, "Ford Racing 3 demo")
        self.edit("engines.html", f'href="{DEMO_PAGE}"', 'href="#"')
        self.edit("pcg.html", f'href="{ISSUES_PAGE}"', 'href="#"')
        self.reject(f"tyres.html: the rights-holder notice lacks the credit: {RIGHTS_CREDIT}")
        self.reject(f"engines.html: the rights-holder notice lacks a link to {DEMO_PAGE}")
        self.reject(f"pcg.html: the rights-holder notice lacks a link to {ISSUES_PAGE}")

    def test_notice_after_the_main_content(self):
        self.edit("gearboxes.html", rights_notice(), "")
        self.edit("gearboxes.html", "</body>", rights_notice() + "</body>")
        self.reject("gearboxes.html: the rights-holder notice must come before the main content")

    def test_script(self):
        self.edit("index.html", "</body>", "<script>alert(1)</script></body>")
        self.reject("index.html contains a <script>")
        self.setUp()
        self.edit("tyres.html", "</body>", '<SCRIPT src="evidence/pcg-index.json"></SCRIPT></body>')
        self.reject("tyres.html contains a <script>")

    def test_broken_local_links(self):
        (self.root / "evidence/selected/field-evidence.json").unlink()
        self.reject("tyres.html has a broken local link: 'evidence/selected/field-evidence.json'")
        self.setUp()
        # A link that leaves the output fails even when its target exists.
        self.edit("pcg.html", 'href="evidence/pcg-index.json"', f'href="../{self.root.name}2/x.json"')
        (self.root.parent / f"{self.root.name}2").mkdir()
        (self.root.parent / f"{self.root.name}2/x.json").write_text("{}")
        self.reject(f"pcg.html has a broken local link: '../{self.root.name}2/x.json'")
        self.setUp()
        self.edit("engines.html", 'href="#engine-BASE"', 'href="#engine-NOPE"')
        self.reject("engines.html has a broken local link: '#engine-NOPE' names no id in engines.html")
        self.setUp()
        self.edit("index.html", 'href="tyres.html"', 'href="tyres.html#tyre-NOPE"')
        self.reject("index.html has a broken local link: 'tyres.html#tyre-NOPE' names no id in tyres.html")
        self.setUp()
        (self.root / "evidence/selected/fill_memory.asm").unlink()
        self.reject("routines.html has a broken local link: 'evidence/selected/fill_memory.asm'")
        self.setUp()
        self.edit("routines.html", 'href="#fr3_read_float"', 'href="#fr3_nope"')
        self.reject("routines.html has a broken local link: '#fr3_nope' names no id in routines.html")

    def test_external_resources(self):
        cases = (('<img src="https://example.com/x.png">', "links to an external resource: <img src="),
                 ('<link rel="stylesheet" href="//example.com/x.css">', "links to an external resource: <link href="),
                 ('<a href="https://example.com/">x</a>', "links to an external resource: <a href="),
                 (f'<a href="{DEMO_PAGE}">outside the notice</a>', "links to an external resource: <a href="),
                 ('<a href="javascript:alert(1)">x</a>', "links to an external resource: <a href="),
                 ('<img src="evidence/pcg-index.json">', "loads a resource: <img src="),
                 ('<div style="background: url(https://example.com/x.png)"></div>', "loads a resource from its CSS"))
        for markup, fragment in cases:
            with self.subTest(markup=markup):
                self.setUp()
                self.edit("pcg.html", "</body>", markup + "</body>")
                self.reject(f"pcg.html {fragment}")
        self.setUp()
        self.edit("tyres.html", "</style>", "@import 'https://example.com/x.css';</style>")
        self.reject("tyres.html loads a resource from its CSS")

    def test_files_the_build_does_not_write(self):
        # A page outside the five is never checked for the notice, so no extra file may sit in the directory.
        (self.root / "notes.html").write_text("<h1>no notice</h1>", encoding="utf-8")
        (self.root / "evidence/tyres.json").write_text("{}", encoding="utf-8")
        (self.root / "evidence/selected/link.asm").symlink_to(self.root / "evidence/selected/build_pcg_view.asm")
        self.reject("notes.html is not a file build_research.py writes")
        self.reject("evidence/tyres.json is not a file build_research.py writes")
        self.reject("evidence/selected/link.asm is not a file build_research.py writes")

    def test_a_written_file_replaced_by_a_symlink(self):
        target = self.root.parent / "outside.json"
        target.write_text("{}", encoding="utf-8")
        (self.root / "evidence/pcg-index.json").unlink()
        (self.root / "evidence/pcg-index.json").symlink_to(target)
        self.reject("evidence/pcg-index.json is not a file build_research.py writes")

    def test_reports_every_problem_at_once(self):
        self.edit("index.html", "</body>", "<script></script></body>")
        self.edit("tyres.html", rights_notice(), "")
        with self.assertRaises(ValueError) as caught:
            build_research.verify_research(self.root)
        self.assertIn("index.html contains a <script>", str(caught.exception))
        self.assertIn("tyres.html lacks the rights-holder notice", str(caught.exception))


class CommandTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def run_script(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False,
                              timeout=120)

    def test_builds_from_the_committed_analysis_files(self):
        output = self.root / "research"
        result = self.run_script("--game", str(write_game(self.root / "game")), "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Wrote 6 verified pages", result.stdout)
        self.assertIn("4 engines, 2 gearboxes, 3 tyres, 62 PCG collections, 654 graphics and 25 routines",
                      result.stdout)
        self.assertEqual(files_under(output), sorted((*PAGES, *EVIDENCE)))
        self.assertIn("62 collections, 654 graphics", (output / INDEX_PAGE).read_text(encoding="utf-8"))

    def test_fails_loudly_without_the_demo(self):
        output = self.root / "research"
        result = self.run_script("--game", str(self.root / "absent"), "--output", str(output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("build_research.py: Game directory does not exist", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(output.exists())

    def test_help_documents_flags_and_defaults(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0)
        text = " ".join(result.stdout.split())
        self.assertRegex(text, r"--game .*default: [^)]*inputs/extracted/Program_Executable_Files\)")
        self.assertRegex(text, r"--output .*default: [^)]*artifacts/research\)")

    def test_notice_links_are_the_only_external_links(self):
        self.assertEqual(NOTICE_LINKS, (DEMO_PAGE, ISSUES_PAGE))


if __name__ == "__main__":
    unittest.main()
