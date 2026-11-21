"""Synthetic "Compare records" page tests; these use no game data."""
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dossier_common import NOTICE_LINKS, rights_notice
import record_compare
import record_dossier
from text_database import DATABASES, GEARBOX_FIELD_STORES, REPO_ROOT, load_known_tags, read_database

from test_record_dossier import EVIDENCE, PE, STATUS, engines_json

SCRIPT = REPO_ROOT / "scripts/record_compare.py"
KNOWN_TAGS = load_known_tags(REPO_ROOT / "analysis/tags.json")
# Three complete gearboxes. 0.2 and 0.20, 1 and 1.0, are one number written two ways; TORSON and torson are two words.
# RALLY declares its tags out of offset order, so the columns cannot follow the file's order.
COMPARE_GEARBOXES = """// Gearboxes for the compare page
:TYPE ROAD
:CLUTCH_SPEED 0.2
:CLUTCH_MAX_POWER 2000
:TRANSMISSION_TYPE MANUAL
:TORQUE_SHIFT 0.0
:DRIVE_TYPE FRONT_WHEELS
:DRIVE_SPLIT 0.5
:DIFF_TYPE TORSON
:ANTI_WHEELSPIN 1
:ANTI_WHEELSKID 0

:TYPE TRACK
:CLUTCH_SPEED 0.20
:CLUTCH_MAX_POWER 3000
:TRANSMISSION_TYPE MANUAL
:TORQUE_SHIFT 0.5
:DRIVE_TYPE REAR_WHEELS
:DRIVE_SPLIT 1
:DIFF_TYPE QUAIFE
:ANTI_WHEELSPIN 1.0
:ANTI_WHEELSKID 0

:TYPE RALLY
:ANTI_WHEELSKID 1
:DIFF_TYPE torson
:DRIVE_SPLIT 1.0
:DRIVE_TYPE REAR_WHEELS
:TORQUE_SHIFT 0.0
:TRANSMISSION_TYPE MANUAL
:CLUTCH_MAX_POWER 3000
:CLUTCH_SPEED 0.15
:ANTI_WHEELSPIN 0
:END
"""
NAMES = ["ROAD", "TRACK", "RALLY"]
# Each gearbox's declarations as written, in offset order, and the line each is on.
WRITTEN = {"ROAD": ["0.2", "2000", "0.0", "0.5", "MANUAL", "TORSON", "FRONT_WHEELS", "1", "0"],
           "TRACK": ["0.20", "3000", "0.5", "1", "MANUAL", "QUAIFE", "REAR_WHEELS", "1.0", "0"],
           "RALLY": ["0.15", "3000", "0.0", "1.0", "MANUAL", "torson", "REAR_WHEELS", "0", "1"]}
LINES = {"ROAD": [3, 4, 6, 8, 5, 9, 7, 10, 11], "TRACK": [14, 15, 17, 19, 16, 20, 18, 21, 22],
         "RALLY": [32, 31, 29, 27, 30, 26, 28, 33, 25]}


class Links(HTMLParser):
    def __init__(self, page):
        super().__init__()
        self.ids, self.hrefs = [], []
        self.feed(page)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag == "a":
            self.hrefs.append(attrs["href"])


def write_gearboxes(game, text):
    path = game / DATABASES["gearboxes"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.replace("\n", "\r\n").encode("ascii"))
    return path


class CompareTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.game = self.root / "game"
        self.output = self.root / "dossier" / record_compare.PAGE
        self.pe = self.root / "pe.json"
        self.pe.write_text(json.dumps(PE), encoding="utf-8")

    def database(self, text=COMPARE_GEARBOXES):
        """Write GEARDATA.DAT under the game directory and return gearboxes.json as text_database.py parses it."""
        write_gearboxes(self.game, text)
        return read_database(self.game, DATABASES["gearboxes"], KNOWN_TAGS)

    def build(self, database=None):
        database = self.database() if database is None else database
        path = self.root / "gearboxes.json"
        path.write_text(json.dumps(database), encoding="utf-8")
        count = record_compare.build(path, self.game, self.pe, self.output, revision="0123abcd")
        self.assertEqual(count, len(database["records"]))
        return self.output.read_text(encoding="utf-8")

    def reject(self, fragment, text=None, database=None):
        if database is None:
            database = self.database(text)
        with self.assertRaises(ValueError) as caught:
            self.build(database)
        self.assertIn(fragment, str(caught.exception))
        self.assertFalse(self.output.exists())


def matrix_of(page):
    start = page.index('<table class="matrix">')
    return page[start:page.index("</table>", start)]


def differences_of(page):
    start = page.index('<h3 id="gearbox-differences">')
    return page[start:page.index("</table>", start)]


class MatrixTests(CompareTestCase):
    def test_one_row_per_gearbox_in_file_order(self):
        rows = re.findall(r'<tr id="compare-gearbox-(\w+)"><td><a href="gearboxes\.html#gearbox-(\w+)">(\w+)</a></td>',
                          matrix_of(self.build()))
        self.assertEqual(rows, [(name, name, name) for name in NAMES])

    def test_columns_follow_the_payload_offset(self):
        header = matrix_of(self.build()).split("</tr>")[0]
        columns = re.findall(r'<th><a href="gearboxes\.html#gearbox-store-(\w+)"><code>(\w+)</code></a><br>'
                             r'<small><code>\+ (0x[0-9a-f]+)</code>, (\w+)<br>([^<]+)</small></th>', header)
        self.assertEqual([tag for tag, *_ in columns], [tag for _, tag, *_ in columns])
        self.assertEqual([tag for tag, *_ in columns], ["CLUTCH_SPEED", "CLUTCH_MAX_POWER", "TORQUE_SHIFT",
                                                        "DRIVE_SPLIT", "TRANSMISSION_TYPE", "DIFF_TYPE", "DRIVE_TYPE",
                                                        "ANTI_WHEELSPIN", "ANTI_WHEELSKID"])
        offsets = [int(offset, 16) for _, _, offset, *_ in columns]
        self.assertEqual(offsets, sorted(offsets))
        self.assertEqual(len(columns), len(GEARBOX_FIELD_STORES))
        for tag, _, offset, width, read in columns:
            with self.subTest(tag=tag):
                store = GEARBOX_FIELD_STORES[tag]["offsets"][offset]
                self.assertEqual(width, store["width"])
                self.assertEqual(read, {"float": "float", "enum": "enum word",
                                        "float_to_byte": "float stored as an integer&#x27;s low byte"}[
                    GEARBOX_FIELD_STORES[tag]["read"]["kind"]])

    def test_cells_show_the_value_as_written_and_link_its_declaration_row(self):
        page = matrix_of(self.build())
        for name in NAMES:
            with self.subTest(name=name):
                row = page[page.index(f'<tr id="compare-gearbox-{name}">'):]
                row = row[:row.index("</tr>")]
                cells = re.findall(r'<td class="num"><a href="gearboxes\.html#gearbox-(\w+)-line-(\d+)" '
                                   r'title="(\w+) line (\d+)">([^<]+)</a></td>', row)
                self.assertEqual([(owner, int(line), written) for owner, line, _, _, written in cells],
                                 [(name, line, written) for line, written in zip(LINES[name], WRITTEN[name],
                                                                                   strict=True)])

    def test_every_gearbox_page_link_names_an_id_on_the_gearbox_page(self):
        database = self.database()
        page = self.build(database)
        engines = self.root / "engines.json"
        engines.write_text(json.dumps(engines_json()), encoding="utf-8")
        gearboxes = self.root / "gearboxes.json"
        evidence, status = self.root / "evidence.json", self.root / "status.json"
        evidence.write_text(json.dumps(EVIDENCE), encoding="utf-8")
        status.write_text(json.dumps(STATUS), encoding="utf-8")
        record_dossier.build(engines, gearboxes, self.pe, self.output.parent, revision="0123abcd",
                             status_path=status, evidence_path=evidence)
        ids = set(Links((self.output.parent / "gearboxes.html").read_text(encoding="utf-8")).ids)
        links = Links(page)
        fragments = [href.removeprefix("gearboxes.html#") for href in links.hrefs
                     if href.startswith("gearboxes.html#")]
        self.assertEqual(len(fragments), len(NAMES) * (1 + len(GEARBOX_FIELD_STORES)) + len(GEARBOX_FIELD_STORES))
        self.assertEqual([fragment for fragment in fragments if fragment not in ids], [])
        self.assertEqual(sum("-line-" in fragment for fragment in fragments), len(NAMES) * len(GEARBOX_FIELD_STORES))
        self.assertEqual(sum(fragment.startswith("gearbox-store-") for fragment in fragments),
                         len(GEARBOX_FIELD_STORES))
        # Links within the page name ids on it.
        self.assertEqual([href for href in links.hrefs if href.startswith("#") and href[1:] not in links.ids], [])
        self.assertEqual(len(links.ids), len(set(links.ids)))


class DifferencesTests(CompareTestCase):
    def test_floats_group_by_number_and_enums_by_word(self):
        database = self.database()
        groups = record_compare.differences(record_compare.check_gearboxes(
            database, (self.game / DATABASES["gearboxes"]).read_bytes()))
        self.assertEqual(list(groups), record_dossier.gearbox_tags())
        shown = {tag: [(group["forms"], group["gearboxes"]) for group in value] for tag, value in groups.items()}
        self.assertEqual(shown["CLUTCH_SPEED"], [(["0.15"], ["RALLY"]), (["0.2", "0.20"], ["ROAD", "TRACK"])])
        self.assertEqual(shown["CLUTCH_MAX_POWER"], [(["2000"], ["ROAD"]), (["3000"], ["TRACK", "RALLY"])])
        self.assertEqual(shown["DRIVE_SPLIT"], [(["0.5"], ["ROAD"]), (["1", "1.0"], ["TRACK", "RALLY"])])
        self.assertEqual(shown["ANTI_WHEELSPIN"], [(["0"], ["RALLY"]), (["1", "1.0"], ["ROAD", "TRACK"])])
        self.assertEqual(shown["TRANSMISSION_TYPE"], [(["MANUAL"], NAMES)])
        # Enum words are compared exactly, so TORSON and torson are two values.
        self.assertEqual(shown["DIFF_TYPE"], [(["QUAIFE"], ["TRACK"]), (["TORSON"], ["ROAD"]), (["torson"], ["RALLY"])])
        self.assertEqual(shown["DRIVE_TYPE"], [(["FRONT_WHEELS"], ["ROAD"]), (["REAR_WHEELS"], ["TRACK", "RALLY"])])

    def test_table_has_one_row_per_tag_with_counts_and_gearboxes(self):
        table = differences_of(self.build())
        rows = dict(re.findall(r'<tr id="differs-(\w+)"><td><code>\w+</code></td>(.*?)</tr>', table))
        self.assertEqual(list(rows), record_dossier.gearbox_tags())
        counts = {tag: int(re.match(r"<td>(\d+)</td>", row).group(1)) for tag, row in rows.items()}
        self.assertEqual(counts, {"CLUTCH_SPEED": 2, "CLUTCH_MAX_POWER": 2, "TORQUE_SHIFT": 2, "DRIVE_SPLIT": 2,
                                  "TRANSMISSION_TYPE": 1, "DIFF_TYPE": 3, "DRIVE_TYPE": 2, "ANTI_WHEELSPIN": 2,
                                  "ANTI_WHEELSKID": 2})
        self.assertIn('<td>by word</td><td><span class="label">same in all 3</span>: <code>MANUAL</code></td>',
                      rows["TRANSMISSION_TYPE"])
        self.assertEqual(sum("same in all" in row for row in rows.values()), 1)
        self.assertIn('<td>by number</td><td><ul><li><code>0.15</code> (1): <a href="#compare-gearbox-RALLY">RALLY</a>'
                      '</li><li><code>0.2</code>, <code>0.20</code> (2): <a href="#compare-gearbox-ROAD">ROAD</a>, '
                      '<a href="#compare-gearbox-TRACK">TRACK</a></li></ul>', rows["CLUTCH_SPEED"])
        self.assertIn("<li><code>TORSON</code> (1): ", rows["DIFF_TYPE"])
        self.assertIn("<li><code>torson</code> (1): ", rows["DIFF_TYPE"])


class PageTests(CompareTestCase):
    def test_identity_scope_notice_and_revision(self):
        page = self.build()
        self.assertEqual(page.count(rights_notice()), 1)
        self.assertLess(page.index("<nav>"), page.index(rights_notice()))
        self.assertLess(page.index(rights_notice()), page.index("<h1>"))
        database = self.database()
        for text in (f'SHA-256 <code>{PE["sha256"]}</code>', f'SHA-256 <code>{database["sha256"]}</code>',
                     "<dt>Producer revision</dt><dd><code>0123abcd</code> (<code>scripts/record_compare.py</code>)",
                     "<dt>Compared</dt><dd>3 gearboxes, 9 fields each</dd>", "claims no units",
                     "stores that integer's low byte; this page does not compute it",
                     "No demo gearbox declares <code>:INHERIT_TYPE</code>", "nothing is inherited"):
            self.assertIn(text, page)

    def test_nav_bar(self):
        self.assertIn('<nav>Research: <a href="engines.html">Engines</a> | <a href="gearboxes.html">Gearboxes</a> | '
                      '<strong>Compare records</strong> | <a href="tyres.html">Tyres</a> | ', self.build())

    def test_no_scripts_or_remote_resources(self):
        page = self.build()
        self.assertNotIn("<script", page.lower())
        self.assertNotRegex(page.replace(rights_notice(), ""), r"https?://")
        self.assertEqual({href for href in Links(page).hrefs if not href.startswith(("#", "gearboxes.html#"))},
                         {"engines.html", "gearboxes.html", "tyres.html", "pcg.html", "routines.html", "questions.html",
                          *NOTICE_LINKS})


class RefusalTests(CompareTestCase):
    def test_missing_mapped_tag(self):
        self.reject("gearbox 'TRACK' (line 13) does not declare DIFF_TYPE",
                    COMPARE_GEARBOXES.replace(":DIFF_TYPE QUAIFE\n", ""))

    def test_unmapped_tag(self):
        self.reject("gearbox 'ROAD' (line 2) declares tags with no byte-checked store: CAPACITY",
                    COMPARE_GEARBOXES.replace(":ANTI_WHEELSKID 0\n", ":ANTI_WHEELSKID 0\n:CAPACITY 1.5\n", 1))

    def test_inherit_type(self):
        self.reject("gearbox 'TRACK' (line 13) declares :INHERIT_TYPE on line 14; gearbox inheritance is not resolved",
                    COMPARE_GEARBOXES.replace(":TYPE TRACK\n", ":TYPE TRACK\n:INHERIT_TYPE ROAD\n"))

    def test_untagged_line(self):
        self.reject("gearbox 'ROAD' (line 2) has untagged lines (12)",
                    COMPARE_GEARBOXES.replace(":ANTI_WHEELSKID 0\n", ":ANTI_WHEELSKID 0\nINHERIT_TYPE ROAD\n", 1))

    def test_rows(self):
        self.reject("gearbox 'RALLY' (line 24): :CLUTCH_SPEED on line 32 is not a single inline value",
                    COMPARE_GEARBOXES.replace(":CLUTCH_SPEED 0.15\n", ":CLUTCH_SPEED\n0.1 0.2\n"))

    def test_more_than_one_value(self):
        self.reject("gearbox 'RALLY' (line 24): :CLUTCH_SPEED on line 32 is not a single inline value",
                    COMPARE_GEARBOXES.replace(":CLUTCH_SPEED 0.15\n", ":CLUTCH_SPEED 0.15 0.2\n"))

    def test_float_tag_that_is_not_a_number(self):
        for tag in ("CLUTCH_SPEED", "ANTI_WHEELSPIN"):
            with self.subTest(tag=tag):
                text = re.sub(rf":{tag} \S+\n", f":{tag} FAST\n", COMPARE_GEARBOXES, count=1)
                self.reject(f"gearbox 'ROAD' (line 2): :{tag} on line", text)
                self.reject("is read as a float, but 'FAST' is not a number", text)

    def test_enum_tag_may_hold_a_number_word(self):
        # Enum tags are compared as written; only float tags must be numbers.
        page = self.build(self.database(COMPARE_GEARBOXES.replace(":DIFF_TYPE torson\n", ":DIFF_TYPE 3\n")))
        self.assertIn("<li><code>3</code> (1): ", differences_of(page))

    def test_geardata_that_does_not_match_gearboxes_json(self):
        database = self.database()
        write_gearboxes(self.game, COMPARE_GEARBOXES.replace("0.20", "0.2"))
        self.reject("DATA/ASCII/CARS/GEARDATA.DAT does not match gearboxes.json's SHA-256", database=database)

    def test_gearboxes_json_that_disagrees_with_its_line(self):
        database = self.database()
        database["records"][1]["fields"]["CLUTCH_SPEED"]["values"] = [0.25]
        self.reject("gearbox 'TRACK' (line 13): line 14 of DATA/ASCII/CARS/GEARDATA.DAT declares '0.20', but "
                    "gearboxes.json holds 0.25", database=database)
        database = self.database()
        database["records"][1]["fields"]["CLUTCH_SPEED"]["line"] = 15
        self.reject("line 15 of DATA/ASCII/CARS/GEARDATA.DAT is not ':CLUTCH_SPEED <value>'", database=database)
        database = self.database()
        database["records"][1]["fields"]["DRIVE_SPLIT"]["values"] = [1.0]
        self.reject("declares '1', but gearboxes.json holds 1.0", database=database)

    def test_missing_geardata(self):
        database = self.database()
        (self.game / DATABASES["gearboxes"]).unlink()
        with self.assertRaisesRegex(ValueError, "GEARDATA.DAT not found under"):
            self.build(database)
        self.assertFalse(self.output.exists())


class ScriptTests(unittest.TestCase):
    def run_script(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False,
                              timeout=60)

    def test_refusal_exits_non_zero_without_a_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            game = root / "game"
            write_gearboxes(game, COMPARE_GEARBOXES.replace(":DIFF_TYPE QUAIFE\n", ""))
            gearboxes = root / "gearboxes.json"
            gearboxes.write_text(json.dumps(read_database(game, DATABASES["gearboxes"], KNOWN_TAGS)), encoding="utf-8")
            output = root / "compare.html"
            result = self.run_script("--gearboxes", str(gearboxes), "--game", str(game), "--output", str(output))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("record_compare.py: gearbox 'TRACK' (line 13) does not declare DIFF_TYPE", result.stderr)
            self.assertNotIn("Traceback", result.stderr)
            self.assertFalse(output.exists())
            write_gearboxes(game, COMPARE_GEARBOXES)
            gearboxes.write_text(json.dumps(read_database(game, DATABASES["gearboxes"], KNOWN_TAGS)), encoding="utf-8")
            result = self.run_script("--gearboxes", str(gearboxes), "--game", str(game), "--output", str(output))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Compared 3 gearboxes field by field", result.stdout)
            self.assertTrue(output.is_file())

    def test_help_documents_flags_and_defaults(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0)
        text = " ".join(result.stdout.split())
        self.assertRegex(text, r"--game .*default: [^)]*inputs/extracted/Program_Executable_Files\)")
        self.assertRegex(text, r"--output .*default: [^)]*artifacts/dossier/compare\.html\)")


if __name__ == "__main__":
    unittest.main()
