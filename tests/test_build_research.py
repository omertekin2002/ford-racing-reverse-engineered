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
import record_dossier
from dossier_common import INDEX_PAGE, NOTICE_LINKS, rights_notice
from fr3_common import DEMO_PAGE
from text_database import DATABASES, REPO_ROOT, SCALAR_COPY_CALL, SCALAR_COPY_SPAN, TYRE_SCALAR_STORES
from verify_web import ISSUES_PAGE, RIGHTS_CREDIT

from test_open_questions import QUESTION_ENGINES, question_manifest, question_pcg_index, question_verification
from test_record_compare import COMPARE_GEARBOXES
from test_tyre_dossier import ACCESSOR_SITES, LOADER_SITES, TYRES

SCRIPT = REPO_ROOT / "scripts/build_research.py"
PE = json.loads((REPO_ROOT / "analysis/pe-metadata.json").read_text())
PAGES = ("index.html", "engines.html", "gearboxes.html", "compare.html", "tyres.html", "pcg.html", "routines.html",
         "questions.html")
ASM = tuple(sorted(f"evidence/selected/{path.name}" for path in (REPO_ROOT / "analysis/selected").glob("*.asm")))
EVIDENCE = ("evidence/annotated/selected.c", "evidence/annotated/status.json", "evidence/pcg-index.json", *ASM,
            "evidence/selected/field-evidence.json", "evidence/unpacked-manifest.json")
COUNTS = {"engines": 7, "gearboxes": 3, "compared_gearboxes": 3, "compared_engines": 7, "tyres": 3, "pcg_collections": 2, "pcg_graphics": 5, "routines": 25,
          "questions": 3}


def write_game(root):
    """Write the three text databases, with the demo's CRLF line ends, under root; return root.

    The engines include INDIGO's colon-less line, which the Open questions page requires, and every gearbox declares
    the nine mapped tags, which the Compare records page requires.
    """
    for stem, text in (("engines", QUESTION_ENGINES), ("gearboxes", COMPARE_GEARBOXES), ("tyres", TYRES)):
        path = root / DATABASES[stem]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.replace("\n", "\r\n").encode("ascii"))
    return root


def write_analysis(root):
    """Copy the committed analysis inputs the pages need, with a synthetic PCG index; return root.

    The PCG index holds _loadbar and _loadbr2 with 1,024 extra bytes each, which the Open questions page requires.
    """
    shutil.copytree(REPO_ROOT / "analysis/selected", root / "selected")
    shutil.copytree(REPO_ROOT / "analysis/annotated", root / "annotated")
    for name in ("pe-metadata.json", "tags.json", "game-file-manifest.json"):
        shutil.copyfile(REPO_ROOT / "analysis" / name, root / name)
    for name, data in (("pcg-index.json", question_pcg_index()), ("unpacked-manifest.json", question_manifest()),
                       ("verification.json", question_verification())):
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
        for text in ("7 engine records", "3 gearbox records", "3 gearboxes, 9 fields each; 7 engines, 20 fields each", "3 tyre records", "2 collections, 5 graphics",
                     "25 annotated routines", "3 open questions",
                     f'SHA-256 <code>{PE["sha256"]}</code>', "<code>0123abcd</code>",
                     "Values are shown exactly as declared", "stays labelled unresolved"):
            self.assertIn(text, index)
        links = re.findall(r'<a href="([^"]+)">', index)
        for page in PAGES[1:]:
            self.assertIn(page, links)
        for relative in EVIDENCE:
            self.assertIn(relative, links)

    def test_entrance_page_answers_the_tyre_tables_question(self):
        self.build()
        index = (self.output / INDEX_PAGE).read_text(encoding="utf-8")
        start = index.index('<section id="tyre-tables">')
        answer = index[start:index.index("</section>", start)]
        self.assertLess(index.index("Values are shown exactly as declared"), start)
        self.assertLess(start, index.index("<h2>Pages</h2>"))
        text = " ".join(re.sub(r"<[^>]+>", " ", answer).split())
        self.assertIn("the 3 tyres split across 2 records: 1 from ROOT and 2 from MID", text)
        self.assertIn("Traced example: CHILD", text)
        self.assertIn("MID and CHILD read all five tables from the same records", text)
        # Every link in the answer names a page and id the build wrote.
        links = re.findall(r'href="([^"#]+)#([^"]+)"', answer)
        self.assertTrue(links)
        for page, fragment in links:
            self.assertIn(f'id="{fragment}"', (self.output / page).read_text(encoding="utf-8"), (page, fragment))

    def test_tyre_tables_answer_follows_the_tyre_data(self):
        # One more tyre inheriting MID changes the vertical load split the entrance page states.
        (self.game / DATABASES["tyres"]).write_bytes(
            TYRES.replace(":END", ":TYPE MORE\n:INHERIT_TYPE MID\n:END").replace("\n", "\r\n").encode("ascii"))
        self.assertEqual(self.build(), {**COUNTS, "tyres": 4})
        text = " ".join(re.sub(r"<[^>]+>", " ", (self.output / INDEX_PAGE).read_text(encoding="utf-8")).split())
        self.assertIn("the 4 tyres split across 2 records: 1 from ROOT and 3 from MID", text)

    def test_tyre_data_without_an_example_or_pair_refuses_the_build(self):
        self.build()
        before = {name: (self.output / name).read_bytes() for name in files_under(self.output)}
        for old, new, message in ((":VERTICAL_LOAD\n0 2.0\n", "", "no worked example to trace"),
                                  (":WIDTH 0.125", ":WIDTH 0.25", "cannot show where the comparison ends")):
            with self.subTest(message=message):
                self.assertIn(old, TYRES)
                (self.game / DATABASES["tyres"]).write_bytes(
                    TYRES.replace(old, new).replace("\n", "\r\n").encode("ascii"))
                with self.assertRaisesRegex(ValueError, message):
                    self.build()
                self.assertEqual({name: (self.output / name).read_bytes() for name in files_under(self.output)},
                                 before)

    def test_entrance_page_answers_the_engine_torque_question(self):
        self.build()
        index = (self.output / INDEX_PAGE).read_text(encoding="utf-8")
        start = index.index('<section id="engine-torque-tables">')
        answer = index[start:index.index("</section>", start)]
        # It follows the tyre answer, before the page list, and leaves the tyre answer as it was.
        self.assertLess(index.index('<section id="tyre-tables">'), start)
        self.assertLess(start, index.index("<h2>Pages</h2>"))
        text = " ".join(re.sub(r"<[^>]+>", " ", answer).split())
        self.assertIn("Which engines share a torque table, and what do they declare differently?", text)
        self.assertIn("Of the 3 engines with :INHERIT_TYPE , 0 declare their own TORQUE_ARRAY and 2 inherit one; 1 has "
                      "no TORQUE_ARRAY along its :INHERIT_TYPE path and keeps the zero-filled slots.", text)
        self.assertIn("1 table is read by more than one engine, 3 engines in all", text)
        self.assertIn("BASE is counted among the readers of the shared tables", text)
        self.assertIn("Traced example: CHILD", text)
        self.assertIn("Where the comparison ends", text)
        # Every link in the answer names a page and id the build wrote: engine sections, declaration lines, the
        # torque-array row, routines, sites and INDIGO's open question.
        links = re.findall(r'href="([^"#]+)#([^"]+)"', answer)
        pages = {page for page, _ in links}
        self.assertEqual(pages, {"engines.html", "routines.html", "questions.html"})
        self.assertIn(("engines.html", "engine-CHILD-torque-array"), links)
        self.assertIn(("questions.html", "indigo"), links)
        for page, fragment in links:
            self.assertIn(f'id="{fragment}"', (self.output / page).read_text(encoding="utf-8"), (page, fragment))

    def test_removing_an_anchor_the_engine_answer_links_fails_verification(self):
        self.build()
        engines = self.output / "engines.html"
        engines.write_text(engines.read_text(encoding="utf-8").replace(' id="engine-CHILD-torque-array"', ""),
                           encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "engines.html#engine-CHILD-torque-array' names no id in engines.html"):
            build_research.verify_research(self.output)

    def test_engine_data_without_a_shared_torque_table_refuses_the_build(self):
        self.build()
        before = {name: (self.output / name).read_bytes() for name in files_under(self.output)}
        table = ":TORQUE_ARRAY\n0 100.5\n1000 200.5\n2000 150.5\n"
        self.assertIn(table, QUESTION_ENGINES)
        (self.game / DATABASES["engines"]).write_bytes(
            QUESTION_ENGINES.replace(table, "").replace("\n", "\r\n").encode("ascii"))
        with self.assertRaisesRegex(ValueError, "#engine-torque-tables answer has no shared torque table"):
            self.build()
        self.assertEqual({name: (self.output / name).read_bytes() for name in files_under(self.output)}, before)

    def test_routines_page_links_its_copied_evidence(self):
        self.build()
        routines = (self.output / "routines.html").read_text(encoding="utf-8")
        for href in ("evidence/annotated/status.json", "evidence/annotated/selected.c",
                     "evidence/selected/field-evidence.json", *ASM):
            self.assertIn(f'href="{href}"', routines)
        self.assertEqual(routines.count('<section class="routine"'), 25)
        self.assertEqual(routines.count('<tr class="site"'), 274)
        self.assertIn('<a href="index.html">Explore findings</a>', routines)
        # Each routine's anchor is a real id: verify_research() accepts a deep link to it from another page.
        index = self.output / INDEX_PAGE
        index.write_text(index.read_text(encoding="utf-8").replace(
            "</body>", '<a href="routines.html#fr3_load_tyre_database">x</a></body>'), encoding="utf-8")
        build_research.verify_research(self.output)

    def test_record_pages_link_routine_sections_and_site_rows(self):
        self.build()
        routines = (self.output / "routines.html").read_text(encoding="utf-8")
        ids = set(re.findall(r'id="([^"]+)"', routines))
        linked = {}
        for page in ("tyres.html", "engines.html", "gearboxes.html"):
            text = (self.output / page).read_text(encoding="utf-8")
            linked[page] = set(re.findall(r'href="routines\.html#([^"]+)"', text))
            self.assertTrue(linked[page], page)
            self.assertEqual(linked[page] - ids, set(), page)
        self.assertTrue({"fr3_load_tyre_database", "fr3_copy_tyre_scalar_fields", "fr3_get_tyre_longitudinal_table",
                         "fr3_get_tyre_lateral_table", "fr3_get_tyre_vertical_load", "fr3_get_tyre_camber_thrust",
                         "fr3_get_tyre_sound_info"} <= linked["tyres.html"])
        sites = {fragment for fragment in linked["tyres.html"] if fragment.startswith("site-")}
        # The tables' accessor and loader sites, and the scalar sections' store, INHERIT_TYPE call and copy sites.
        scalar = {int(site, 16) for entry in TYRE_SCALAR_STORES.values()
                  for site in [*(va for vas in entry["offsets"].values() for va in vas),
                               *entry.get("scale_sites", {}).values()]}
        copies = {site["va"] for site in json.loads((REPO_ROOT / "analysis/selected/field-evidence.json").read_text())
                  if SCALAR_COPY_SPAN[0] <= site["va"] < SCALAR_COPY_SPAN[1] and site["bytes"] != "c3"}
        self.assertEqual(len(copies), 22)
        self.assertEqual(sites, {f"site-{va:08x}" for group in (*ACCESSOR_SITES.values(), *LOADER_SITES.values(),
                                                                 scalar, {SCALAR_COPY_CALL}, copies)
                                 for va in group})
        # The engine page also links each effective-fields row's store sites, the conditions on +0x2c, the INHERIT_TYPE
        # copy call and the torque table's zero fill and MAX_RPM read.
        self.assertEqual(linked["engines.html"], {"fr3_load_engine_database", "fr3_copy_engine_record",
                                                  *(f"site-{va:08x}" for va in record_dossier.engine_site_vas())})
        # The gearbox page links each tag's compare, selecting jg, reader, table or conversion and store sites, and the
        # INHERIT_TYPE copy call.
        self.assertEqual(linked["gearboxes.html"], {"fr3_load_gearbox_database", "fr3_copy_gearbox_record",
                                                    *(f"site-{va:08x}" for va in record_dossier.gearbox_site_vas())})
        self.assertEqual(len(record_dossier.gearbox_site_vas()), 39)

    def test_renamed_linked_routine_refuses_the_build_and_keeps_the_previous_output(self):
        self.build()
        before = {name: (self.output / name).read_bytes() for name in files_under(self.output)}
        # Renamed consistently in status.json and selected.c, so the routines page alone would still build.
        for relative, old, new in (("annotated/status.json", '"fr3_copy_engine_record"', '"fr3_renamed"'),
                                   ("annotated/selected.c", "/* 00522c80 fr3_copy_engine_record */",
                                    "/* 00522c80 fr3_renamed */")):
            path = self.analysis / relative
            text = path.read_text(encoding="utf-8")
            self.assertIn(old, text)
            path.write_text(text.replace(old, new), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "status.json labels entry VA 0x00522c80, the engine copy routine this "
                                                "page links to, 'fr3_renamed', not 'fr3_copy_engine_record'"):
            self.build()
        self.assertEqual({name: (self.output / name).read_bytes() for name in files_under(self.output)}, before)

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
            COMPARE_GEARBOXES.replace(":END", COMPARE_GEARBOXES[COMPARE_GEARBOXES.index(":TYPE TRACK"):
                                                                COMPARE_GEARBOXES.index("\n\n:TYPE RALLY")]
                                      .replace("TRACK", "EXTRA") + "\n:END").encode("ascii"))
        (self.analysis / "pcg-index.json").write_text(json.dumps(question_pcg_index()[1:]), encoding="utf-8")
        (self.analysis / "verification.json").write_text(
            json.dumps({"pcg_collections_verified": 1, "pcg_entries_verified": 3}), encoding="utf-8")
        self.assertEqual(self.build(), {**COUNTS, "gearboxes": 4, "compared_gearboxes": 4, "pcg_collections": 1,
                                        "pcg_graphics": 3})
        index = (self.output / INDEX_PAGE).read_text(encoding="utf-8")
        self.assertIn("4 gearbox records", index)
        self.assertIn("4 gearboxes, 9 fields each", index)
        self.assertIn("1 collections, 3 graphics", index)

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
        (self.analysis / "verification.json").write_text(json.dumps({**question_verification(), "pcg_entries_verified": 9}))
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

    def test_record_page_links_to_a_missing_routines_fragment(self):
        for page, old, new in (("engines.html", "routines.html#fr3_copy_engine_record", "routines.html#fr3_nope"),
                               ("gearboxes.html", "routines.html#fr3_load_gearbox_database", "routines.html#fr3_nope"),
                               ("tyres.html", "routines.html#fr3_get_tyre_sound_info", "routines.html#fr3_nope"),
                               ("tyres.html", "routines.html#site-00523f10", "routines.html#site-00000000")):
            with self.subTest(page=page, new=new):
                self.setUp()
                self.edit(page, f'href="{old}"', f'href="{new}"')
                self.reject(f"{page} has a broken local link: '{new}' names no id in routines.html")
        # The anchor goes missing on the routines page instead.
        self.setUp()
        self.edit("routines.html", 'id="site-00523f10"', 'id="site-gone"')
        self.reject("tyres.html has a broken local link: 'routines.html#site-00523f10' names no id in routines.html")

    def test_tyre_tables_answer_links_a_missing_anchor(self):
        for page, anchor in (("tyres.html", "tyre-MID-line-21"), ("tyres.html", "tyre-CHILD-VERTICAL_LOAD"),
                             ("routines.html", "site-005239a9"), ("routines.html", "fr3_get_tyre_vertical_load")):
            with self.subTest(anchor=anchor):
                self.setUp()
                self.edit(page, f'id="{anchor}"', 'id="gone"')
                self.reject(f"index.html has a broken local link: '{page}#{anchor}' names no id in {page}")

    def test_compare_page_links_a_missing_gearbox_page_anchor(self):
        # A declaration row and a store-table row on the gearbox page, each linked from the Compare records page.
        for anchor in ("gearbox-TRACK-line-14", "gearbox-store-ANTI_WHEELSKID"):
            with self.subTest(anchor=anchor):
                self.setUp()
                self.edit("gearboxes.html", f'id="{anchor}"', 'id="gone"')
                self.reject(f"compare.html has a broken local link: 'gearboxes.html#{anchor}' names no id in "
                            "gearboxes.html")

    def test_compare_page_links_a_missing_engine_page_anchor(self):
        # A declaration row, a store-table row and an effective TORQUE_ARRAY row on the engine page, each linked from
        # the Compare records page's engine section.
        for anchor in ("engine-BASE-line-2", "engine-store-TURBO_MASS", "engine-CHILD-torque-array"):
            with self.subTest(anchor=anchor):
                self.setUp()
                self.edit("engines.html", f'id="{anchor}"', 'id="gone"')
                self.reject(f"compare.html has a broken local link: 'engines.html#{anchor}' names no id in "
                            "engines.html")

    def test_every_page_names_the_entrance_page_producer_revision(self):
        revision = "<dt>Producer revision</dt><dd><code>0123abcd</code>"
        self.edit("compare.html", revision, "<dt>Producer revision</dt><dd><code>fedc9876</code>")
        self.reject("compare.html names producer revision 'fedc9876', not the entrance page's '0123abcd'")
        self.setUp()
        self.edit("compare.html", revision, "<dt>Producer</dt><dd><code>0123abcd</code>")
        self.reject("compare.html names 0 producer revisions, not one")
        self.setUp()
        self.edit("pcg.html", "</body>", f"{revision}</code></dd></body>")
        self.reject("pcg.html names 2 producer revisions, not one")

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

    def run_script(self, *args, script=SCRIPT):
        return subprocess.run([sys.executable, str(script), *args], capture_output=True, text=True, check=False,
                              timeout=120)

    def test_missing_committed_disassembly_file_is_refused(self):
        # A copy of the scripts and their inputs, run in a new process: a committed .asm file missing from the
        # working tree must stop the build, not drop out of the evidence and the routines page.
        copy_root = self.root / "copy"
        shutil.copytree(REPO_ROOT / "scripts", copy_root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        write_analysis(copy_root / "analysis")
        (copy_root / "analysis/selected/fill_memory_body.asm").unlink()
        output = self.root / "research"
        result = self.run_script("--game", str(write_game(self.root / "game")), "--output", str(output),
                                 script=copy_root / "scripts/build_research.py")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("build_research.py: ", result.stderr)
        self.assertIn("fill_memory_body.asm", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(output.exists())

    def test_builds_from_the_committed_analysis_files(self):
        output = self.root / "research"
        result = self.run_script("--game", str(write_game(self.root / "game")), "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Wrote 8 verified pages", result.stdout)
        self.assertIn("7 engines (7 compared), 3 gearboxes (3 compared), 3 tyres, 62 PCG collections, 654 graphics, 25 routines and "
                      "3 open questions", result.stdout)
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
