"""Open questions page tests: synthetic engines, tyres and PCG index, plus the committed analysis/ files."""
import copy
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dossier_common import NOTICE_LINKS, rights_notice
import open_questions
import pcg_catalogue
import record_dossier
from text_database import REPO_ROOT
import tyre_dossier

from test_pcg_catalogue import collection, entry
from test_record_dossier import ENGINES, database
from test_tyre_dossier import tyres_json

SCRIPT = REPO_ROOT / "scripts/open_questions.py"
PE = json.loads((REPO_ROOT / "analysis/pe-metadata.json").read_text())
EVIDENCE = json.loads((REPO_ROOT / "analysis/selected/field-evidence.json").read_text())
# ENGINES plus a DEFAULT_TRACK parent, a child that names it with :INHERIT_TYPE and INDIGO's colon-less line.
QUESTION_ENGINES = ENGINES.removesuffix(":END\n") + """:TYPE DEFAULT_TRACK
:CAPACITY 3.5
:MAX_RPM 7000
:LOCATION_TYPE REAR
:TYPE TRACK_CHILD
:INHERIT_TYPE DEFAULT_TRACK
:TYPE INDIGO
INHERIT_TYPE DEFAULT_TRACK
:MAX_RPM 8000
:END
"""
INDIGO_LINE = QUESTION_ENGINES.splitlines().index("INHERIT_TYPE DEFAULT_TRACK") + 1
SECTIONS = ("indigo", "sound-words", "pcg-extra-bytes")
PARTS = ("observed", "matters", "readings", "decide")


def engines_json(text=QUESTION_ENGINES):
    return database(text, "DATA/ASCII/CARS/ENGDATA.DAT")


def loading_entry(index, name, offset, width, height, extra=0, words=None):
    item = entry(index, name, offset, width, height, extra)
    for i, word in (words or {}).items():
        item["header_words"][i] = word
    return item


def question_pcg_index():
    """Two collections; only _loadbar and _loadbr2 in the loading collection have extra bytes."""
    return [collection("GRAPHICS/A/graphics.pcg", [entry(0, "first", 128, 4, 2), entry(1, "bar", 272, 2, 2)]),
            collection("GRAPHICS/LOADING/graphics.pcg",
                       [loading_entry(0, "Load", 128, 8, 8, words={4: 640, 5: 480}),
                        loading_entry(1, "_loadbar", 400, 4, 4, 1024, words={1: 0, 4: 13, 5: 6, 9: 1}),
                        loading_entry(2, "_loadbr2", 1584, 4, 4, 1024, words={1: 0, 4: 13, 5: 6, 9: 1})])]


def question_manifest():
    return [{"path": item["path"], "input_size": 100 + i, "decoded_size": 1000 + i, "input_sha256": f"{i:x}" * 64,
             "decoded_sha256": f"{i + 5:x}" * 64} for i, item in enumerate(question_pcg_index())]


def question_verification():
    index = question_pcg_index()
    return {"pcg_collections_verified": len(index),
            "pcg_entries_verified": sum(len(item["entries"]) for item in index)}


class Page(HTMLParser):
    """Collects ids, hrefs, <script> tags and the ids of sections."""

    def __init__(self, text):
        super().__init__()
        self.ids, self.hrefs, self.scripts, self.sections = [], [], 0, []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag == "a" and "href" in attrs:
            self.hrefs.append(attrs["href"])
        if tag == "script":
            self.scripts += 1
        if tag == "section":
            self.sections.append(attrs.get("id"))


def part(page, section, name):
    """Return one part of one section, from its <h3> to the next <h3> or the end of the section."""
    body = page[page.index(f'<section class="question" id="{section}">'):]
    body = body[:body.index("</section>")]
    start = body.index(f'<h3 id="{section}-{name}">')
    following = body.find("<h3", start + 1)
    return body[start:following if following >= 0 else len(body)]


class QuestionsTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.selected = self.root / "selected"
        self.selected.mkdir()
        for name in open_questions.ASM.values():
            shutil.copyfile(REPO_ROOT / "analysis/selected" / name, self.selected / name)
        self.output = self.root / "dossier/questions.html"

    def write(self, name, data):
        path = self.root / name
        path.write_text(data if isinstance(data, str) else json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path

    def paths(self, engines=None, tyres=None, evidence=None, index=None, pe=PE):
        return (self.write("engines.json", engines_json() if engines is None else engines),
                self.write("tyres.json", tyres_json() if tyres is None else tyres),
                self.write("field-evidence.json", EVIDENCE if evidence is None else evidence),
                self.write("pcg-index.json", question_pcg_index() if index is None else index),
                self.write("pe.json", pe))

    def build(self, **inputs):
        count = open_questions.build(*self.paths(**inputs), self.output, revision="0123abcd", selected=self.selected)
        self.assertEqual(count, 3)
        return self.output.read_text(encoding="utf-8")

    def reject(self, fragment, **inputs):
        with self.assertRaises(ValueError) as caught:
            self.build(**inputs)
        self.assertIn(fragment, str(caught.exception))
        self.assertFalse(self.output.exists())

    def edit_asm(self, name, old, new):
        path = self.selected / name
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new), encoding="utf-8")


class QuestionsPageTests(QuestionsTestCase):
    def test_three_anchored_sections_with_four_parts(self):
        page = self.build()
        parsed = Page(page)
        self.assertEqual(parsed.sections, list(SECTIONS))
        for section in SECTIONS:
            for name in PARTS:
                self.assertIn(f"{section}-{name}", parsed.ids)
        self.assertEqual(len(parsed.ids), len(set(parsed.ids)))
        contents = page[page.index("<h2>Questions</h2>"):page.index('<section class="question"')]
        self.assertEqual(re.findall(r'href="#([^"]+)"', contents), list(SECTIONS))

    def test_notice_nav_no_scripts_and_only_local_links(self):
        page = self.build()
        parsed = Page(page)
        self.assertEqual(parsed.scripts, 0)
        self.assertEqual(page.count(rights_notice()), 1)
        self.assertLess(page.index(rights_notice()), page.index("<h1>"))
        self.assertIn("<strong>Open questions</strong>", page)
        external = {href for href in parsed.hrefs if re.match(r"[a-z]+:|//", href)}
        self.assertEqual(external, set(NOTICE_LINKS))
        # Every input link points at the file that was read.
        for href in {href for href in parsed.hrefs if href.startswith("../")}:
            self.assertTrue((self.output.parent / href).resolve().is_file(), href)

    def test_indigo_observations_come_from_the_parsed_database(self):
        engines = engines_json()
        observed = part(self.build(engines=engines), "indigo", "observed")
        self.assertIn(f'<code>{engines["sha256"]}</code>', observed)
        self.assertIn(f"line {INDIGO_LINE}: <code>INHERIT_TYPE DEFAULT_TRACK</code>", observed)
        self.assertIn('<a href="engines.html#engine-INDIGO">INDIGO</a>, declared on line', observed)
        self.assertIn('<a href="engines.html#engine-TRACK_CHILD">TRACK_CHILD</a> (line', observed)
        self.assertIn("<dd>none</dd>", observed)  # INDIGO has no :INHERIT_TYPE of its own
        matters = part(self.build(engines=engines), "indigo", "matters")
        self.assertIn("DEFAULT_TRACK declares 2 tags that INDIGO does not: <code>CAPACITY</code>, "
                      "<code>LOCATION_TYPE</code>", matters)

    def test_indigo_line_number_follows_the_input(self):
        moved = QUESTION_ENGINES.replace(":TYPE INDIGO\n", ":TYPE INDIGO\n:CAPACITY 9.5\n")
        engines = engines_json(moved)
        observed = part(self.build(engines=engines), "indigo", "observed")
        self.assertIn(f"line {INDIGO_LINE + 1}: <code>INHERIT_TYPE DEFAULT_TRACK</code>", observed)
        self.assertIn(f'<code>{engines["sha256"]}</code>', observed)

    def test_sound_observations_come_from_evidence_and_disassembly(self):
        observed = part(self.build(), "sound-words", "observed")
        for va in ("0x00523a67", "0x00523a89"):
            self.assertIn(f"<code>{va}</code>", observed)
        for va, offset in (("0x00523b10", "+0x3c"), ("0x00523d81", "+0x78"), ("0x00523da5", "+0x3c")):
            self.assertRegex(observed, rf"<code>{va}</code>.*?<code>{re.escape(offset)}</code></td></tr>")
        self.assertIn("<code>+0x00</code>&ndash;<code>+0x38</code></td><td>"
                      '<span class="num">15</span></td><td><span class="label">unresolved</span>', observed)
        self.assertIn("<code>+0x78</code>&ndash;<code>+0x2cc</code></td><td>"
                      '<span class="num">150</span></td><td><span class="num">15</span> rows of '
                      '<span class="num">10</span> values', observed)
        self.assertIn('<a href="tyres.html#tyre-ROOT">ROOT</a></td><td>12</td><td><span class="num">1</span>', observed)

    def test_sound_layout_follows_the_allocation_size(self):
        evidence = copy.deepcopy(EVIDENCE)
        site = next(site for site in evidence if site["va"] == 0x00523A67)
        site["bytes"] = "ba0c030000"  # 0x30c: 0x78 + 15 rows of 11 words
        observed = part(self.build(evidence=evidence), "sound-words", "observed")
        self.assertIn("<code>+0x78</code>&ndash;<code>+0x308</code>", observed)
        self.assertIn('<span class="num">11</span> values', observed)
        self.assertIn("<code>ba0c030000</code>", observed)

    def test_sound_matters_counts_table_sources(self):
        matters = part(self.build(), "sound-words", "matters")
        self.assertIn('All <span class="num">3</span> tyre records', matters)
        self.assertIn('<a href="tyres.html#tyre-ROOT-sound_info">ROOT</a> <span class="num">3</span>', matters)
        self.assertIn('href="tyres.html#sound-table-words"', matters)

    def test_pcg_observations_mark_differing_header_words(self):
        observed = part(self.build(), "pcg-extra-bytes", "observed")
        self.assertIn("<code>GRAPHICS/LOADING/graphics.pcg</code>", observed)
        self.assertIn('<a href="pcg.html#pcg-GRAPHICS-LOADING-graphics.pcg-e1">_loadbar</a></td>'
                      '<td><span class="num">400</span>', observed)
        self.assertIn("<code>_loadbar</code>: <code>+0x04</code>, <code>+0x08</code>, <code>+0x0c</code>, "
                      "<code>+0x10</code>, <code>+0x14</code>, <code>+0x24</code>, <code>+0x28</code>, ", observed)
        self.assertEqual(observed.count('class="num differs"'), 14)
        self.assertEqual(observed.count("<tr><td class=\"num\">+0x"), 32)

    def test_pcg_values_follow_the_index(self):
        index = question_pcg_index()
        index[1]["entries"][2]["file_offset"] = 987654
        index[1]["entries"][2]["header_words"][20] = 77
        observed = part(self.build(index=index), "pcg-extra-bytes", "observed")
        self.assertIn('<span class="num">987654</span>', observed)
        self.assertIn('<td class="num differs">77 &ne;</td>', observed)
        self.assertIn("<code>_loadbr2</code>: <code>+0x04</code>, <code>+0x08</code>, <code>+0x0c</code>, "
                      "<code>+0x10</code>, <code>+0x14</code>, <code>+0x24</code>, <code>+0x28</code>, <code>+0x50</code>", observed)

    def test_readings_are_all_untested_and_nothing_is_resolved(self):
        page = self.build()
        for section in SECTIONS:
            readings = part(page, section, "readings")
            items = re.findall(r"<li>(.*?)</li>", readings)
            self.assertGreaterEqual(len(items), 2, section)
            for item in items:
                self.assertTrue(item.startswith('<span class="label">untested</span>: '), item)
        text = re.sub(r"<[^>]+>", " ", re.sub(r"(?s)<style>.*?</style>", "", page)).lower()
        self.assertIsNone(re.search(r"\b(likely|probably|resolved|confirmed|means that|padding)\b", text))

    def test_decide_links_the_committed_disassembly(self):
        page = self.build()
        self.assertIn("load_engine_database.asm", part(page, "indigo", "decide"))
        self.assertIn("<code>0x00522b47</code>", part(page, "indigo", "decide"))
        self.assertIn("load_tyre_database.asm", part(page, "sound-words", "decide"))
        self.assertIn("build_pcg_view.asm", part(page, "pcg-extra-bytes", "decide"))

    def test_hostile_text_is_escaped(self):
        engines = engines_json()
        engines["source"] = "<script>alert(1)</script>"
        index = question_pcg_index()
        index[1]["path"] = 'GRAPHICS/<b>"&/graphics.pcg'
        page = self.build(engines=engines, index=index)
        self.assertNotIn("<script>alert", page)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", page)
        self.assertIn("GRAPHICS/&lt;b&gt;&quot;&amp;/graphics.pcg", page)
        self.assertEqual(Page(page).scripts, 0)

    def test_runs_on_the_committed_pcg_index_and_evidence(self):
        case = open_questions.check_pcg(json.loads((REPO_ROOT / "analysis/pcg-index.json").read_text()))
        self.assertEqual(case["collection"]["path"], "GRAPHICS/LOADING/graphics.pcg")
        self.assertEqual([item["name"] for item in case["entries"]], ["_loadbar", "_loadbr2"])
        sound = open_questions.check_sound(tyres_json(), EVIDENCE, open_questions.disassembly(
            REPO_ROOT / "analysis/selected/load_tyre_database.asm"))
        self.assertEqual((sound["size"], sound["rpm"], sound["values"], sound["words"], sound["per_type"]),
                         (0x2D0, 0x3C, 0x78, 15, 10))


class RefusalTests(QuestionsTestCase):
    def test_no_indigo_record(self):
        self.reject("engines.json has no INDIGO record", engines=engines_json(ENGINES))

    def test_indigo_without_its_untagged_line(self):
        self.reject("INDIGO has no untagged line",
                    engines=engines_json(QUESTION_ENGINES.replace("INHERIT_TYPE DEFAULT_TRACK\n:MAX_RPM", ":MAX_RPM")))

    def test_indigo_tokens_differ(self):
        self.reject("is not 'INHERIT_TYPE DEFAULT_TRACK'",
                    engines=engines_json(QUESTION_ENGINES.replace("INHERIT_TYPE DEFAULT_TRACK\n:MAX_RPM",
                                                                  "INHERIT_TYPE BASE\n:MAX_RPM")))

    def test_indigo_with_two_untagged_lines(self):
        self.reject("INDIGO has 2 untagged lines", engines=engines_json(
            QUESTION_ENGINES.replace("INHERIT_TYPE DEFAULT_TRACK\n:MAX_RPM",
                                     "INHERIT_TYPE DEFAULT_TRACK\nINHERIT_TYPE BASE\n:MAX_RPM")))

    def test_named_parent_is_not_a_record(self):
        text = QUESTION_ENGINES.replace(":TYPE TRACK_CHILD\n:INHERIT_TYPE DEFAULT_TRACK\n", "")
        text = text.replace(":TYPE DEFAULT_TRACK\n", ":TYPE OTHER_TRACK\n")
        self.reject("names 'DEFAULT_TRACK', which is not an engine record", engines=engines_json(text))

    def test_allocation_site_missing(self):
        evidence = [site for site in EVIDENCE if site["va"] != 0x00523A67]
        self.reject("no byte-checked `mov r32, imm32` sound table allocation size at 0x00523a67", evidence=evidence)

    def test_table_store_missing(self):
        evidence = [site for site in EVIDENCE if site["va"] != 0x00523A89]
        self.reject("no byte-checked tyre loader store of the sound table address at + 0x54", evidence=evidence)

    def test_loader_stores_change(self):
        self.edit_asm("load_tyre_database.asm", "fstp dword ptr [ebx + ecx*4 + 0x78]", "fstp dword ptr [ebx + ecx*4 + 0x7c]")
        self.reject("do not split the 0x2d0-byte allocation")

    def test_loader_stores_missing(self):
        self.edit_asm("load_tyre_database.asm", "fstp dword ptr [ebx + ecx*4 + 0x78]", "fstp dword ptr [ebx]")
        self.reject("stores into the sound table at 1 indexed offsets (+0x3c), not two")

    def test_no_tyre_declares_sound_info(self):
        tyres = tyres_json()
        for record in tyres["records"]:
            record["sound_info"] = []
        self.reject("No tyre record declares :SOUND_INFO", tyres=tyres)

    def test_extra_bytes_on_another_graphic(self):
        index = question_pcg_index()
        index[0]["entries"][1] = entry(1, "bar", 272, 2, 2, extra=1024)
        self.reject("The graphics with extra bytes are 'bar'", index=index)

    def test_extra_bytes_question_gone(self):
        index = question_pcg_index()
        index[1]["entries"][1:] = [loading_entry(1, "_loadbar", 400, 4, 4), loading_entry(2, "_loadbr2", 1584, 4, 4)]
        self.reject("The graphics with extra bytes are none, not _loadbar and _loadbr2", index=index)

    def test_extra_bytes_size_differs(self):
        index = question_pcg_index()
        index[1]["entries"][2] = loading_entry(2, "_loadbr2", 1584, 4, 4, 512)
        self.reject("not 1024 bytes each", index=index)

    def test_extra_bytes_in_two_collections(self):
        index = question_pcg_index()
        moved = index[1]["entries"].pop()
        moved["index"] = 2
        index[0]["entries"].append(moved)
        index[0]["count"], index[1]["count"] = 3, 2
        self.reject("not in one collection", index=index)

    def test_malformed_pcg_entry(self):
        index = question_pcg_index()
        index[1]["entries"][1]["width"] = 99
        self.reject("width is 99 but header word 2", index=index)

    def test_asm_without_span_header(self):
        self.edit_asm("build_pcg_view.asm", "; Analyst label: build_pcg_view;", "; label: build_pcg_view;")
        self.reject("build_pcg_view.asm does not start with")

    def test_engine_loader_without_copy_call(self):
        self.edit_asm("load_engine_database.asm", "call 0x522c80", "call 0x522c84")
        self.reject("load_engine_database.asm has no call of copy_engine_record at 0x00522c80")

    def test_pe_without_sha256(self):
        self.reject("PE metadata has no sha256", pe={"file": "fr3.exe"})

    def test_cli_exits_non_zero_with_a_message(self):
        engines, tyres, evidence, index, pe = self.paths(engines=engines_json(ENGINES))
        result = subprocess.run([sys.executable, str(SCRIPT), "--engines", str(engines), "--tyres", str(tyres),
                                 "--evidence", str(evidence), "--index", str(index), "--pe", str(pe),
                                 "--output", str(self.output)],
                                capture_output=True, text=True, check=False, cwd=REPO_ROOT,
                                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("open_questions.py: engines.json has no INDIGO record", result.stderr)
        self.assertFalse(self.output.exists())


class BackLinkTests(unittest.TestCase):
    """The engine, tyre and PCG pages link their unresolved label for each case to its question."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def write(self, name, data):
        path = self.root / name
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def test_engine_page_links_only_indigo_line(self):
        engines = engines_json()
        record_dossier.build(self.write("engines.json", engines),
                             self.write("gearboxes.json", database(":TYPE G\n:CLUTCH_SPEED 1\n:END\n",
                                                                   "DATA/ASCII/CARS/GEARDATA.DAT")),
                             self.write("pe.json", PE), self.root, revision="0123abcd")
        page = (self.root / "engines.html").read_text(encoding="utf-8")
        self.assertEqual(page.count('href="questions.html#indigo"'), 1)
        indigo = page[page.index('id="engine-INDIGO"'):]
        self.assertIn('(<a href="questions.html#indigo">open question</a>)', indigo[:indigo.index("</section>")])
        loner = page[page.index('id="engine-LONER"'):]
        self.assertNotIn("questions.html", loner[:loner.index("</section>")])
        self.assertIn('<a href="questions.html">Open questions</a>', page)

    def test_tyre_page_links_the_sound_note(self):
        evidence = self.root / "field-evidence.json"
        shutil.copyfile(REPO_ROOT / "analysis/selected/field-evidence.json", evidence)
        tyre_dossier.build(self.write("tyres.json", tyres_json()), evidence, self.write("pe.json", PE),
                           self.root / "tyres.html", revision="0123abcd")
        page = (self.root / "tyres.html").read_text(encoding="utf-8")
        note = page[page.index('<div class="unresolved" id="sound-table-words">'):]
        self.assertIn('(<a href="questions.html#sound-words">open question</a>)', note[:note.index("</div>")])

    def test_pcg_page_links_only_the_question_entries(self):
        index = question_pcg_index()
        index[0]["entries"][1] = entry(1, "bar", 272, 2, 2, extra=1024)
        pcg_catalogue.build(self.write("pcg-index.json", index), self.write("manifest.json", question_manifest()),
                            self.write("pe.json", PE), self.write("verification.json", question_verification()),
                            self.root / "pcg.html", revision="0123abcd")
        page = (self.root / "pcg.html").read_text(encoding="utf-8")
        self.assertEqual(page.count('href="questions.html#pcg-extra-bytes"'), 2)
        for row_id in ("pcg-GRAPHICS-LOADING-graphics.pcg-e1", "pcg-GRAPHICS-LOADING-graphics.pcg-e2"):
            row = page[page.index(f'<tr id="{row_id}">'):]
            self.assertIn("questions.html#pcg-extra-bytes", row[:row.index("</tr>")])
        bar = page[page.index('<tr id="pcg-GRAPHICS-A-graphics.pcg-e1">'):]
        bar = bar[:bar.index("</tr>")]
        self.assertIn('<span class="label">unresolved</span>', bar)
        self.assertNotIn("questions.html", bar)


if __name__ == "__main__":
    unittest.main()
