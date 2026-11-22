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
from text_database import (DATABASES, ENGINE_FIELD_COUNTS, ENGINE_FIELD_STORES, GEARBOX_FIELD_STORES, REPO_ROOT,
                           RESOLVED_TYRE_TABLES, TYRE_SCALAR_STORES, ZERO_FILLED, effective_engine_fields,
                           effective_scalars, engine_field_counts, load_known_tags, read_database,
                           resolve_tyre_tables, scalar_counts, table_sources, tyre_table_provenance,
                           untagged_inherit_consequences)
import tyre_dossier

from test_record_dossier import EVIDENCE, PE, STATUS, with_engine_fields

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
# Engines for the compare page. DEFAULT_TRACK is a root that does not declare every tag. CHILD inherits it and
# declares its own MAX_RPM after INHERIT_TYPE, so the table it inherits was parsed with DEFAULT_TRACK's MAX_RPM;
# CAPACITY 6 and 6.0 are one number. GRANDCHILD inherits through CHILD (ASPIRATION_TYPE comes two steps away) and
# parses its own table with CHILD's MAX_RPM. INDIGO has the demo's colon-less line, and INDIGO_CHILD inherits its
# zero fill. LONER has a colon-less line too, a declaration before it and a table parsed before its MAX_RPM.
COMPARE_ENGINES = """// Engines for the compare page
:TYPE DEFAULT_TRACK
:LOCATION_TYPE MID
:CAPACITY 6.0
:ASPIRATION_TYPE NORMAL
:MAX_RPM 7000.00
:TORQUE_MODIFIER 1.5
:TORQUE_ARRAY
0.0 100.0
1000.0 200.0
7000.0 150.0

:TYPE CHILD
:INHERIT_TYPE DEFAULT_TRACK
:CAPACITY 6
:MAX_RPM 8000
:TORQUE_MODIFIER 1.8

:TYPE GRANDCHILD
:INHERIT_TYPE CHILD
:LOCATION_TYPE REAR
:TORQUE_ARRAY
0.0 50.0
:TORQUE_MODIFIER 2.0

:TYPE INDIGO
INHERIT_TYPE DEFAULT_TRACK
:ASPIRATION_TYPE TURBO
:MAX_RPM 7000.0
:TORQUE_ARRAY
0.0 1.0

:TYPE INDIGO_CHILD
:INHERIT_TYPE INDIGO
:TORQUE_MODIFIER 3.0

:TYPE LONER
:FUEL_CUTOFF 0.5
INHERIT_TYPE CHILD
:TORQUE_ARRAY
0.0 2.0
:MAX_RPM 5000
:END
"""
ENGINE_NAMES = ["DEFAULT_TRACK", "CHILD", "GRANDCHILD", "INDIGO", "INDIGO_CHILD", "LONER"]
# Tyres for the compare page. ROOT declares every table and no MASS, so every tyre's MASS is zero-filled. OFFROAD
# inherits ROOT and declares its own VERTICAL_LOAD and WIDTH 0.250 (0.25 written another way). CHILD inherits OFFROAD:
# its TYRE_GRIP_DEPTH and its LONGITUDINAL_COMBINED_VALUES come two steps away, from ROOT; it declares
# ROAD_MAGIC_GRIP_NUMBER 1 (ROOT's 1.0 written another way) and an unmapped LOCATION_TYPE.
COMPARE_TYRES = """// Tyres for the compare page
:TYPE ROOT
:RADIUS 0.5
:WIDTH 0.25
:TYRE_GRIP_DEPTH 0.100
:ROAD_MAGIC_GRIP_NUMBER 1.0
:LONGITUDINAL_COMBINED_VALUES
0 1.0
:LATERAL_COMBINED_VALUES
0 1.0
:VERTICAL_LOAD
0 1.0
:CAMBER_THRUST
0 1.0
:SOUND_INFO
:TYPE TYRE_SAMPLE_TYPE_SQUEAK
:VALUE 2
0 0.0
1 0.5
:START_RPM 1500

:TYPE OFFROAD
:INHERIT_TYPE ROOT
:WIDTH 0.250
:OFFROAD_MAGIC_GRIP_NUMBER 40
:VERTICAL_LOAD
0 2.0

:TYPE CHILD
:INHERIT_TYPE OFFROAD
:RADIUS 0.50
:ROAD_MAGIC_GRIP_NUMBER 1
:LOCATION_TYPE REAR
:END
"""
TYRE_NAMES = ["ROOT", "OFFROAD", "CHILD"]
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


def write_database(game, stem, text):
    path = game / DATABASES[stem]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.replace("\n", "\r\n").encode("ascii"))
    return path


def write_gearboxes(game, text):
    return write_database(game, "gearboxes", text)


def write_engines(game, text=COMPARE_ENGINES):
    """Write ENGDATA.DAT under game and return engines.json as text_database.py writes it."""
    write_database(game, "engines", text)
    return with_engine_fields(read_database(game, DATABASES["engines"], KNOWN_TAGS))


def with_tyre_fields(database):
    """tyres.json with the resolved tables, provenance and effective scalars text_database.py adds."""
    records = database["records"]
    return {**database, "resolved_tables": resolve_tyre_tables(records),
            "table_provenance": tyre_table_provenance(records), "effective_scalars": effective_scalars(records)}


def write_tyres(game, text=COMPARE_TYRES):
    """Write TYREDATA.DAT under game and return tyres.json as text_database.py writes it."""
    write_database(game, "tyres", text)
    return with_tyre_fields(read_database(game, DATABASES["tyres"], KNOWN_TAGS, sound_info=True))


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

    def engines(self, text=COMPARE_ENGINES):
        """Write ENGDATA.DAT under the game directory and return engines.json as text_database.py writes it."""
        return write_engines(self.game, text)

    def tyres(self, text=COMPARE_TYRES):
        """Write TYREDATA.DAT under the game directory and return tyres.json as text_database.py writes it."""
        return write_tyres(self.game, text)

    def build(self, database=None, engines=None, engine_counts=None, tyres=None, tyre_counts=None):
        database = self.database() if database is None else database
        engines = self.engines() if engines is None else engines
        tyres = self.tyres() if tyres is None else tyres
        path, engines_path = self.root / "gearboxes.json", self.root / "engines.json"
        tyres_path, status = self.root / "tyres.json", self.root / "status.json"
        path.write_text(json.dumps(database), encoding="utf-8")
        engines_path.write_text(json.dumps(engines), encoding="utf-8")
        tyres_path.write_text(json.dumps(tyres), encoding="utf-8")
        status.write_text(json.dumps(STATUS), encoding="utf-8")
        counts = record_compare.build(path, engines_path, tyres_path, self.game, self.pe, self.output,
                                      revision="0123abcd", engine_counts=engine_counts, tyre_counts=tyre_counts,
                                      status_path=status)
        self.assertEqual(counts, {"compared_gearboxes": len(database["records"]),
                                  "compared_engines": len(engines["records"]),
                                  "compared_tyres": len(tyres["records"])})
        return self.output.read_text(encoding="utf-8")

    def reject(self, fragment, text=None, database=None, engines=None, engine_counts=None, tyres=None,
               tyre_counts=None):
        if database is None:
            database = self.database(text)
        with self.assertRaises(ValueError) as caught:
            self.build(database, engines, engine_counts, tyres, tyre_counts)
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
                     "<dt>Compared</dt><dd>3 gearboxes, 9 fields each; 6 engines, 20 fields each; 3 tyres, 9 scalar "
                     "fields and 5 tables each</dd>", "claims no units",
                     "<dt>Tyre database</dt><dd><code>DATA/ASCII/CARS/TYREDATA.DAT</code> SHA-256 <code>"
                     f'{self.tyres()["sha256"]}</code></dd>',
                     "Gearboxes, engines and tyres are compared.</p>",
                     '<p>Jump to: <a href="#gearboxes">Gearboxes</a> | <a href="#engines">Engines</a> | '
                     '<a href="#tyres">Tyres</a></p>',
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
        self.assertEqual({href for href in Links(page).hrefs
                          if not href.startswith(("#", "gearboxes.html#", "engines.html#", "tyres.html#"))},
                         {"engines.html", "gearboxes.html", "tyres.html", "pcg.html", "routines.html", "questions.html",
                          "questions.html#indigo", *NOTICE_LINKS,
                          *(f"routines.html#{label}" for label in TYRE_ACCESSOR_LABELS.values())})


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


def engine_matrix_of(page):
    start = page.index('<table class="matrix engines">')
    return page[start:page.index("</table>", start)]


def engine_row(page, name):
    matrix = engine_matrix_of(page)
    start = matrix.index(f'<tr id="compare-engine-{name}">')
    return matrix[start:matrix.index("</tr>", start)]


def engine_cell(page, name, tag):
    """The matrix cell of engine `name` under `tag`."""
    cells = re.findall(r"<td>(.*?)</td>", engine_row(page, name))[1:]
    return cells[record_dossier.engine_tags().index(tag)]


def engine_differences_of(page):
    start = page.index('<h3 id="engine-differences">')
    return page[start:page.index("</table>", start)]


def recomputed(engines):
    """engines.json with its effective fields and consequences derived again from its (edited) records."""
    return {**engines, "effective_fields": effective_engine_fields(engines["records"]),
            "untagged_inherit_consequences": untagged_inherit_consequences(engines["records"])}


def line_link(name, line, text=None):
    return (f'<a href="engines.html#engine-{name}-line-{line}" title="{name} line {line}">'
            f'{text if text is not None else f"{name} line {line}"}</a>')


class EngineMatrixTests(CompareTestCase):
    def test_one_row_per_engine_in_file_order_and_one_column_per_mapped_tag(self):
        page = self.build()
        matrix = engine_matrix_of(page)
        rows = re.findall(r'<tr id="compare-engine-(\w+)"><td><a href="engines\.html#engine-(\w+)">\w+</a><br>'
                          r"<small>(root|inherits)</small></td>", matrix)
        self.assertEqual(rows, [(name, name, "inherits" if name in ("CHILD", "GRANDCHILD", "INDIGO_CHILD") else "root")
                                for name in ENGINE_NAMES])
        header = matrix.split("</tr>")[0]
        columns = re.findall(r'<th><a href="engines\.html#engine-store-(\w+)"><code>(\w+)</code></a>', header)
        self.assertEqual([tag for tag, _ in columns], record_dossier.engine_tags())
        self.assertEqual([tag for tag, _ in columns], [tag for _, tag in columns])
        self.assertEqual(len(columns), len(ENGINE_FIELD_STORES))
        self.assertIn('<th><a href="engines.html#engine-store-TORQUE_ARRAY"><code>TORQUE_ARRAY</code></a><br><small>'
                      "<code>+ 0x3c</code>, dword &times; 18<br>rows</small></th>", header)
        self.assertIn("<code>+ 0x14</code>, byte<br>enum word</small>", header)
        for name in ENGINE_NAMES:
            self.assertEqual(len(re.findall(r"<td>", engine_row(page, name))), 1 + len(ENGINE_FIELD_STORES), name)

    def test_declared_and_inherited_values_link_their_source_line(self):
        page = self.build()
        self.assertEqual(engine_cell(page, "DEFAULT_TRACK", "MAX_RPM"),
                         f'<span class="num">{line_link("DEFAULT_TRACK", 6, "7000.00")}</span><br><small>declared</small>')
        self.assertEqual(engine_cell(page, "CHILD", "CAPACITY"),
                         f'<span class="num">{line_link("CHILD", 15, "6")}</span><br><small>declared</small>')
        # One step: the source record, no path.
        self.assertEqual(engine_cell(page, "CHILD", "LOCATION_TYPE"),
                         f'<span class="num">{line_link("DEFAULT_TRACK", 3, "MID")}</span><br><small>inherited from '
                         '<a href="#compare-engine-DEFAULT_TRACK">DEFAULT_TRACK</a></small>')
        self.assertEqual(engine_cell(page, "GRANDCHILD", "CAPACITY"),
                         f'<span class="num">{line_link("CHILD", 15, "6")}</span><br><small>inherited from '
                         '<a href="#compare-engine-CHILD">CHILD</a></small>')

    def test_two_step_inheritance_shows_the_path(self):
        self.assertEqual(engine_cell(self.build(), "GRANDCHILD", "ASPIRATION_TYPE"),
                         f'<span class="num">{line_link("DEFAULT_TRACK", 5, "NORMAL")}</span><br><small>inherited from '
                         '<a href="#compare-engine-DEFAULT_TRACK">DEFAULT_TRACK</a>, path GRANDCHILD &rarr; CHILD '
                         "&rarr; DEFAULT_TRACK</small>")

    def test_inherited_torque_table_names_the_max_rpm_it_was_parsed_with(self):
        page = self.build()
        # CHILD declares MAX_RPM 8000 after its INHERIT_TYPE, but the table it inherits was parsed with
        # DEFAULT_TRACK's MAX_RPM on line 6.
        self.assertEqual(engine_cell(page, "CHILD", "MAX_RPM"),
                         f'<span class="num">{line_link("CHILD", 16, "8000")}</span><br><small>declared</small>')
        self.assertEqual(engine_cell(page, "CHILD", "TORQUE_ARRAY"),
                         f'{line_link("DEFAULT_TRACK", 8)}, <a href="engines.html#engine-CHILD-torque-array">3 rows</a>'
                         '<br><small>inherited from <a href="#compare-engine-DEFAULT_TRACK">DEFAULT_TRACK</a>; parsed '
                         f'with <code>MAX_RPM</code> {line_link("DEFAULT_TRACK", 6)}</small>')
        # GRANDCHILD's own table was parsed with the MAX_RPM it inherited from CHILD.
        self.assertEqual(engine_cell(page, "GRANDCHILD", "TORQUE_ARRAY"),
                         f'{line_link("GRANDCHILD", 22)}, <a href="engines.html#engine-GRANDCHILD-torque-array">1 row</a>'
                         f'<br><small>declared; parsed with <code>MAX_RPM</code> {line_link("CHILD", 16)}</small>')
        # A root has no effective TORQUE_ARRAY row on the engine page, so its cell links only the declaration.
        self.assertEqual(engine_cell(page, "DEFAULT_TRACK", "TORQUE_ARRAY"),
                         f'{line_link("DEFAULT_TRACK", 8)}, 3 rows<br><small>declared; parsed with <code>MAX_RPM</code> '
                         f'{line_link("DEFAULT_TRACK", 6)}</small>')
        self.assertNotIn("100.0", engine_matrix_of(page))

    def test_indigo_style_root_is_unresolved_never_zero(self):
        page = self.build()
        unresolved = ('<a href="questions.html#indigo"><span class="label">unresolved</span></a><br><small>no value; '
                      f'depends on {line_link("INDIGO", 27)}</small>')
        record = next(record for record in self.engines()["records"] if record["type"] == "INDIGO")
        for tag in record_dossier.engine_tags():
            with self.subTest(tag=tag):
                cell = engine_cell(page, "INDIGO", tag)
                if tag in record["fields"]:
                    self.assertIn("declared", cell)
                else:
                    self.assertEqual(cell, unresolved)
        # An engine inheriting INDIGO's zero fill depends on the same line; what INDIGO declares stays resolved.
        self.assertEqual(engine_cell(page, "INDIGO_CHILD", "CAPACITY"), unresolved)
        self.assertEqual(engine_cell(page, "INDIGO_CHILD", "ASPIRATION_TYPE"),
                         f'<span class="num">{line_link("INDIGO", 28, "TURBO")}</span><br><small>inherited from '
                         '<a href="#compare-engine-INDIGO">INDIGO</a></small>')
        self.assertIn(f'parsed with <code>MAX_RPM</code> {line_link("INDIGO", 29)}',
                      engine_cell(page, "INDIGO_CHILD", "TORQUE_ARRAY"))

    def test_other_colon_less_root_is_unresolved_without_the_indigo_question(self):
        page = self.build()
        unresolved = ('<span class="label">unresolved</span><br><small>no value; depends on '
                      f'{line_link("LONER", 39)}</small>')
        self.assertEqual(engine_cell(page, "LONER", "CAPACITY"), unresolved)
        # Declared before the line, so applying it would overwrite the declaration.
        self.assertEqual(engine_cell(page, "LONER", "FUEL_CUTOFF"), unresolved)
        # Parsed after the line and before LONER's own MAX_RPM: the row count depends on the line too.
        self.assertEqual(engine_cell(page, "LONER", "TORQUE_ARRAY"),
                         f'{line_link("LONER", 40)}, 1 row<br><small>declared; parsed with <code>MAX_RPM</code> '
                         f'<span class="label">unresolved</span> (depends on {line_link("LONER", 39)})</small>')
        self.assertNotIn("questions.html", engine_row(page, "LONER"))

    def test_root_without_a_colon_less_line_shows_its_zero_fill(self):
        page = self.build()
        self.assertEqual(engine_cell(page, "DEFAULT_TRACK", "FUEL_CUTOFF"),
                         '<span class="label">zero-filled</span><br><small>no value</small>')
        self.assertEqual(engine_cell(page, "GRANDCHILD", "FUEL_CUTOFF"),
                         '<span class="label">zero-filled</span><br><small>no value, path GRANDCHILD &rarr; CHILD '
                         "&rarr; DEFAULT_TRACK</small>")

    def test_every_link_names_an_id_on_its_page(self):
        page = self.build()
        engines, gearboxes = self.root / "engines.json", self.root / "gearboxes.json"
        evidence, status = self.root / "evidence.json", self.root / "status.json"
        evidence.write_text(json.dumps(EVIDENCE), encoding="utf-8")
        status.write_text(json.dumps(STATUS), encoding="utf-8")
        record_dossier.build(engines, gearboxes, self.pe, self.output.parent, revision="0123abcd",
                             status_path=status, evidence_path=evidence)
        ids = set(Links((self.output.parent / "engines.html").read_text(encoding="utf-8")).ids)
        links = Links(page)
        fragments = [href.removeprefix("engines.html#") for href in links.hrefs if href.startswith("engines.html#")]
        self.assertEqual([fragment for fragment in fragments if fragment not in ids], [])
        self.assertEqual(sorted({fragment for fragment in fragments if fragment.startswith("engine-store-")}),
                         sorted(f"engine-store-{tag}" for tag in ENGINE_FIELD_STORES))
        self.assertEqual({fragment for fragment in fragments if fragment.endswith("-torque-array")},
                         {"engine-CHILD-torque-array", "engine-GRANDCHILD-torque-array",
                          "engine-INDIGO_CHILD-torque-array"})
        self.assertEqual([href for href in links.hrefs if href.startswith("#") and href[1:] not in links.ids], [])
        self.assertEqual(len(links.ids), len(set(links.ids)))
        self.assertEqual({href for href in links.hrefs if href.startswith("questions.html")}, {"questions.html",
                                                                                                "questions.html#indigo"})


class EngineDifferencesTests(CompareTestCase):
    def differences(self, text=COMPARE_ENGINES):
        engines = self.engines(text)
        return record_compare.engine_differences(record_compare.check_engines(
            engines, (self.game / DATABASES["engines"]).read_bytes()))

    def test_numbers_words_and_tables_group_apart_from_unresolved_cells(self):
        groups = self.differences()
        self.assertEqual(list(groups), record_dossier.engine_tags())
        self.assertEqual(groups["CAPACITY"], {"groups": [{"forms": ["6.0", "6"],
                                                          "engines": ["DEFAULT_TRACK", "CHILD", "GRANDCHILD"]}],
                                              "zero_filled": [], "unresolved": ["INDIGO", "INDIGO_CHILD", "LONER"]})
        self.assertEqual(groups["LOCATION_TYPE"]["groups"], [{"forms": ["MID"], "engines": ["DEFAULT_TRACK", "CHILD"]},
                                                             {"forms": ["REAR"], "engines": ["GRANDCHILD"]}])
        self.assertEqual(groups["MAX_RPM"]["groups"],
                         [{"forms": ["5000"], "engines": ["LONER"]},
                          {"forms": ["7000.00", "7000.0"], "engines": ["DEFAULT_TRACK", "INDIGO", "INDIGO_CHILD"]},
                          {"forms": ["8000"], "engines": ["CHILD", "GRANDCHILD"]}])
        self.assertEqual(groups["TORQUE_ARRAY"]["groups"],
                         [{"source": "DEFAULT_TRACK", "source_line": 8, "engines": ["DEFAULT_TRACK", "CHILD"]},
                          {"source": "GRANDCHILD", "source_line": 22, "engines": ["GRANDCHILD"]},
                          {"source": "INDIGO", "source_line": 30, "engines": ["INDIGO", "INDIGO_CHILD"]},
                          {"source": "LONER", "source_line": 40, "engines": ["LONER"]}])
        self.assertEqual(groups["FUEL_CUTOFF"], {"groups": [], "zero_filled": ["DEFAULT_TRACK", "CHILD", "GRANDCHILD"],
                                                 "unresolved": ["INDIGO", "INDIGO_CHILD", "LONER"]})

    def test_table_counts_declared_inherited_and_unresolved(self):
        page = self.build()
        table = engine_differences_of(page)
        rows = dict(re.findall(r'<tr id="differs-engine-(\w+)">(.*?)</tr>', table))
        self.assertEqual(list(rows), record_dossier.engine_tags())
        self.assertIn("<td>1, by number</td><td><ul><li><code>6.0</code>, <code>6</code> (3): ", rows["CAPACITY"])
        self.assertIn("<td>3 inheriting, as parsed: 1 declared, 1 inherited, 1 zero-filled<br>unresolved: 3: "
                      '<a href="#compare-engine-INDIGO">INDIGO</a>, ', rows["CAPACITY"])
        self.assertIn("<td>4, by record and line</td><td><ul><li>"
                      f'{line_link("DEFAULT_TRACK", 8)} (2): <a href="#compare-engine-DEFAULT_TRACK">', rows["TORQUE_ARRAY"])
        self.assertIn("<td>3 inheriting, as parsed: 1 declared, 2 inherited<br>unresolved: 0</td>", rows["TORQUE_ARRAY"])
        self.assertIn('<li><span class="label">zero-filled</span>, no value (3): ', rows["FUEL_CUTOFF"])
        self.assertIn("<td>0, by number</td>", rows["FUEL_CUTOFF"])
        # The counts per tag are the inheriting engines' effective statuses.
        counts = engine_field_counts(self.engines()["effective_fields"])
        for tag, row in rows.items():
            shown = re.search(r"inheriting, as parsed: (.*?)<br>", row).group(1)
            self.assertEqual(shown, ", ".join(f'{counts[tag][status]} {status.replace("not declared (zero-filled)", "zero-filled")}'
                                              for status in ("declared", "inherited", "not declared (zero-filled)")
                                              if status in counts[tag]), tag)
        self.assertIn("is not the demo's, so these counts are not checked against <code>ENGINE_FIELD_COUNTS</code>",
                      page)

    def test_one_value_held_by_every_engine_is_same_in_all(self):
        # Every colon-less line gets its colon, and LONER drops the declaration the copy would overwrite.
        text = COMPARE_ENGINES.replace(":FUEL_CUTOFF 0.5\n", "").replace("\nINHERIT_TYPE", "\n:INHERIT_TYPE")
        page = self.build(engines=self.engines(text))
        rows = dict(re.findall(r'<tr id="differs-engine-(\w+)">(.*?)</tr>', engine_differences_of(page)))
        self.assertIn('<td>1, by number</td><td><span class="label">same in all 6</span>: <code>6.0</code>, <code>6</code>'
                      "</td>", rows["CAPACITY"])

    def test_counts_checked_against_the_demo_record(self):
        engines = self.engines()
        counts = engine_field_counts(engines["effective_fields"])
        page = self.build(engines=engines, engine_counts=counts)
        self.assertIn("these declared and inherited counts are the ones <code>scripts/text_database.py</code> records "
                      "in <code>ENGINE_FIELD_COUNTS</code>; the page is not written when they differ", page)

    def test_demo_counts_apply_only_to_the_demo_engdata(self):
        manifest = json.loads((REPO_ROOT / "analysis/game-file-manifest.json").read_text())
        demo = next(item["sha256"] for item in manifest if item["path"] == DATABASES["engines"])
        self.assertIs(record_compare.demo_engine_counts({"source": DATABASES["engines"], "sha256": demo}),
                      ENGINE_FIELD_COUNTS)
        self.assertIsNone(record_compare.demo_engine_counts({"source": DATABASES["engines"], "sha256": "0" * 64}))
        self.assertIsNone(record_compare.demo_engine_counts({"source": DATABASES["gearboxes"], "sha256": demo}))


class EngineRefusalTests(CompareTestCase):
    def reject_engines(self, fragment, text=COMPARE_ENGINES, engines=None, engine_counts=None):
        self.reject(fragment, database=self.database(), engines=self.engines(text) if engines is None else engines,
                    engine_counts=engine_counts)

    def test_engdata_that_does_not_match_engines_json(self):
        engines = self.engines()
        write_database(self.game, "engines", COMPARE_ENGINES.replace("7000.00", "7000.0"))
        self.reject_engines("DATA/ASCII/CARS/ENGDATA.DAT does not match engines.json's SHA-256", engines=engines)

    def test_missing_engdata(self):
        engines = self.engines()
        (self.game / DATABASES["engines"]).unlink()
        with self.assertRaisesRegex(ValueError, "ENGDATA.DAT not found under"):
            self.build(self.database(), engines)
        self.assertFalse(self.output.exists())

    def test_inheriting_engine_without_effective_fields(self):
        engines = self.engines()
        del engines["effective_fields"]["GRANDCHILD"]
        self.reject_engines("engine 'GRANDCHILD' (line 19) declares :INHERIT_TYPE, but engines.json gives it no "
                            "effective_fields", engines=engines)

    def test_effective_fields_that_disagree_with_the_records(self):
        engines = self.engines()
        engines["effective_fields"]["CHILD"]["fields"]["CAPACITY"]["source_line"] = 4
        self.reject_engines("engines.json effective_fields disagrees with the record declarations", engines=engines)

    def test_unmapped_tag(self):
        self.reject_engines("engine 'CHILD' (line 13) declares tags with no byte-checked store: CLUTCH_SPEED",
                            COMPARE_ENGINES.replace(":CAPACITY 6\n", ":CAPACITY 6\n:CLUTCH_SPEED 0.2\n"))

    def test_overwritten_declaration(self):
        self.reject_engines("engine 'CHILD' (line 13) declares :TICKOVER_RPM (line 14) before its :INHERIT_TYPE, which "
                            "overwrites them", COMPARE_ENGINES.replace(":TYPE CHILD\n", ":TYPE CHILD\n:TICKOVER_RPM 900\n"))

    def test_stray_untagged_line(self):
        self.reject_engines("engine 'CHILD' (line 13) has untagged lines (16) other than a root's colon-less "
                            "INHERIT_TYPE line", COMPARE_ENGINES.replace(":CAPACITY 6\n", ":CAPACITY 6\nINHERIT_TYPE INDIGO\n"))

    def test_written_token_that_does_not_parse_to_the_json_value(self):
        engines = self.engines()
        child = next(record for record in engines["records"] if record["type"] == "CHILD")
        child["fields"]["CAPACITY"]["values"] = [6.0]
        self.reject_engines("engine 'CHILD' (line 13): line 15 of DATA/ASCII/CARS/ENGDATA.DAT declares '6', but "
                            "engines.json holds 6.0", engines=recomputed(engines))
        engines = self.engines()
        child = next(record for record in engines["records"] if record["type"] == "CHILD")
        child["fields"]["CAPACITY"]["line"] = 16
        self.reject_engines("line 16 of DATA/ASCII/CARS/ENGDATA.DAT is not ':CAPACITY <value>'", engines=recomputed(engines))
        engines = self.engines()
        child = next(record for record in engines["records"] if record["type"] == "DEFAULT_TRACK")
        child["fields"]["TORQUE_ARRAY"]["line"] = 7
        self.reject_engines("line 7 of DATA/ASCII/CARS/ENGDATA.DAT is not ':TORQUE_ARRAY'", engines=recomputed(engines))

    def test_values_that_are_not_one_inline_value(self):
        self.reject_engines("engine 'CHILD' (line 13): :CAPACITY on line 15 is not a single inline value",
                            COMPARE_ENGINES.replace(":CAPACITY 6\n", ":CAPACITY 6 7\n"))
        self.reject_engines("engine 'CHILD' (line 13): :CAPACITY on line 15 reads no enum word, but 'BIG' is not a number",
                            COMPARE_ENGINES.replace(":CAPACITY 6\n", ":CAPACITY BIG\n"))
        self.reject_engines("engine 'CHILD' (line 13): :TORQUE_ARRAY on line 15 is not a block of rows",
                            COMPARE_ENGINES.replace(":CAPACITY 6\n", ":TORQUE_ARRAY 6\n"))

    def test_counts_that_differ_from_engine_field_counts(self):
        engines = self.engines()
        counts = engine_field_counts(engines["effective_fields"])
        self.reject_engines("The inheriting engines' effective field counts differ from ENGINE_FIELD_COUNTS: CAPACITY "
                            "{'declared': 1, 'inherited': 1, 'not declared (zero-filled)': 1}, not {'declared': 2}",
                            engines=engines, engine_counts={**counts, "CAPACITY": {"declared": 2}})
        self.reject_engines("ENGINE_FIELD_COUNTS: LOCATION_TYPE", engines=engines, engine_counts=ENGINE_FIELD_COUNTS)


# The routine each tyre table's accessor is, by its status.json label.
TYRE_ACCESSOR_LABELS = {"LONGITUDINAL_COMBINED_VALUES": "fr3_get_tyre_longitudinal_table",
                        "LATERAL_COMBINED_VALUES": "fr3_get_tyre_lateral_table",
                        "VERTICAL_LOAD": "fr3_get_tyre_vertical_load", "CAMBER_THRUST": "fr3_get_tyre_camber_thrust",
                        "sound_info": "fr3_get_tyre_sound_info"}


def tyre_matrix_of(page):
    start = page.index('<table class="matrix tyres">')
    return page[start:page.index("</table>", start)]


def tyre_cells(page, name):
    """The matrix cells of tyre `name`: {scalar tag or table: cell HTML}."""
    matrix = tyre_matrix_of(page)
    start = matrix.index(f'<tr id="compare-tyre-{name}">')
    cells = re.findall(r"<td>(.*?)</td>", matrix[start:matrix.index("</tr>", start)])[1:]
    columns = [*tyre_dossier.tyre_tags(), *RESOLVED_TYRE_TABLES]
    assert len(cells) == len(columns), cells
    return dict(zip(columns, cells, strict=True))


def tyre_differences_of(page):
    start = page.index('<h3 id="tyre-differences">')
    return page[start:page.index("</table>", start)]


def tyre_line_link(name, line, text):
    return (f'<span class="num"><a href="tyres.html#tyre-{name}-line-{line}" title="{name} line {line}">{text}</a>'
            "</span>")


def tyre_counts(tyres):
    return {"scalars": scalar_counts(tyres["effective_scalars"]), "tables": table_sources(tyres["resolved_tables"])}


class TyreMatrixTests(CompareTestCase):
    def test_one_row_per_tyre_and_scalar_then_table_columns(self):
        page = self.build()
        matrix = tyre_matrix_of(page)
        rows = re.findall(r'<tr id="compare-tyre-(\w+)"><td><a href="tyres\.html#tyre-(\w+)">\w+</a><br><small>(\w+)'
                          "</small></td>", matrix)
        self.assertEqual(rows, [("ROOT", "ROOT", "root"), ("OFFROAD", "OFFROAD", "inherits"),
                                ("CHILD", "CHILD", "inherits")])
        header = matrix.split("</tr>")[0]
        scalars = re.findall(r'<th><a href="tyres\.html#tyre-store-(\w+)"><code>(\w+)</code></a><br><small>(.*?)<br>'
                             r"([^<]+)</small></th>", header)
        self.assertEqual([tag for tag, *_ in scalars], [tag for _, tag, *_ in scalars])
        self.assertEqual([tag for tag, *_ in scalars], tyre_dossier.tyre_tags())
        self.assertEqual(len(scalars), len(TYRE_SCALAR_STORES))
        lowest = [min(int(offset, 16) for offset in TYRE_SCALAR_STORES[tag]["offsets"]) for tag, *_ in scalars]
        self.assertEqual(lowest, sorted(lowest))
        for tag, _, offsets, kind in scalars:
            with self.subTest(tag=tag):
                self.assertEqual(offsets, ", ".join(f"<code>+ {offset}</code>" for offset in TYRE_SCALAR_STORES[tag]["offsets"]))
                self.assertEqual(kind, "float, scaled when stored" if "scaled_by" in TYRE_SCALAR_STORES[tag] else "float")
        tables = re.findall(r"<th><code>(\w+)</code><br><small>record <code>\+ (0x[0-9a-f]+)</code><br>accessor "
                            r'<a href="routines\.html#(\w+)"><code>(0x[0-9a-f]+)</code></a></small></th>', header)
        self.assertEqual([table for table, *_ in tables], list(RESOLVED_TYRE_TABLES))
        for table, offset, label, accessor in tables:
            with self.subTest(table=table):
                self.assertEqual(label, TYRE_ACCESSOR_LABELS[table])
                self.assertEqual({"accessor": accessor, "record_offset": offset},
                                 record_compare.TYRE_TABLE_ACCESSORS[table])

    def test_scalar_cells_show_the_effective_value_as_written_and_its_source(self):
        page = self.build()
        root, offroad, child = (tyre_cells(page, name) for name in TYRE_NAMES)
        self.assertEqual(root["RADIUS"], f'{tyre_line_link("ROOT", 3, "0.5")}<br><small>declared</small>')
        self.assertEqual(offroad["WIDTH"], f'{tyre_line_link("OFFROAD", 24, "0.250")}<br><small>declared</small>')
        self.assertEqual(child["WIDTH"], f'{tyre_line_link("OFFROAD", 24, "0.250")}<br><small>inherited from '
                                         '<a href="#compare-tyre-OFFROAD">OFFROAD</a></small>')
        self.assertEqual(child["ROAD_MAGIC_GRIP_NUMBER"], f'{tyre_line_link("CHILD", 32, "1")}<br><small>declared</small>')
        self.assertEqual(offroad["ROAD_MAGIC_GRIP_NUMBER"], f'{tyre_line_link("ROOT", 6, "1.0")}<br><small>inherited '
                                                            'from <a href="#compare-tyre-ROOT">ROOT</a></small>')
        # Not declared by ROOT, so the root's own cell is zero-filled.
        self.assertEqual(root["OFFROAD_MAGIC_GRIP_NUMBER"], f'<span class="label">{ZERO_FILLED}</span><br><small>no value'
                                                            "</small>")

    def test_multi_step_paths_are_shown(self):
        child = tyre_cells(self.build(), "CHILD")
        self.assertEqual(child["TYRE_GRIP_DEPTH"], f'{tyre_line_link("ROOT", 5, "0.100")}<br><small>inherited from '
                                                   '<a href="#compare-tyre-ROOT">ROOT</a>, path CHILD &rarr; OFFROAD '
                                                   "&rarr; ROOT</small>")
        self.assertEqual(child["LONGITUDINAL_COMBINED_VALUES"],
                         '<a href="tyres.html#tyre-CHILD-LONGITUDINAL_COMBINED_VALUES" title="CHILD Longitudinal">ROOT</a>'
                         "<br><small>inherited, path CHILD &rarr; OFFROAD &rarr; ROOT</small>")
        self.assertEqual(child["VERTICAL_LOAD"], '<a href="tyres.html#tyre-CHILD-VERTICAL_LOAD" title="CHILD Vertical '
                                                 'load">OFFROAD</a><br><small>inherited</small>')
        self.assertEqual(tyre_cells(self.build(), "ROOT")["sound_info"],
                         '<a href="tyres.html#tyre-ROOT-sound_info" title="ROOT Sound info">ROOT</a><br><small>own table'
                         "</small>")

    def test_zero_filled_cells_have_no_value(self):
        page = self.build()
        for name in TYRE_NAMES:
            with self.subTest(name=name):
                cell = tyre_cells(page, name)["MASS"]
                self.assertTrue(cell.startswith(f'<span class="label">{ZERO_FILLED}</span><br><small>no value'), cell)
                self.assertNotIn("<a ", cell)
        self.assertEqual(tyre_cells(page, "CHILD")["MASS"], f'<span class="label">{ZERO_FILLED}</span><br><small>no '
                                                            "value, path CHILD &rarr; OFFROAD &rarr; ROOT</small>")

    def test_unmapped_declaration_is_listed_without_a_column(self):
        page = self.build()
        self.assertNotIn("LOCATION_TYPE", tyre_matrix_of(page))
        self.assertIn('<div class="unresolved" id="tyre-unmapped"><p><span class="label">unmapped</span>: no '
                      'byte-checked store is known for <a href="tyres.html#tyre-CHILD-line-33" title="CHILD line 33">'
                      "CHILD line 33</a> (<code>:LOCATION_TYPE</code>), so these get no column and no value.</p></div>",
                      page)
        page = self.build(tyres=self.tyres(COMPARE_TYRES.replace(":LOCATION_TYPE REAR\n", "")))
        self.assertNotIn("unmapped", page[page.index('<h2 id="tyres">'):])
        # tyres.json has no unmapped list for a root, which inherits nothing; its unmapped declarations are listed too.
        page = self.build(tyres=self.tyres(COMPARE_TYRES.replace(":ROAD_MAGIC_GRIP_NUMBER 1.0\n",
                                                                 ":ROAD_MAGIC_GRIP_NUMBER 1.0\n:LOCATION_TYPE FRONT\n")))
        self.assertIn('known for <a href="tyres.html#tyre-ROOT-line-7" title="ROOT line 7">ROOT line 7</a> '
                      '(<code>:LOCATION_TYPE</code>), <a href="tyres.html#tyre-CHILD-line-34"', page)

    def test_overwritten_declaration_is_listed_without_a_cell(self):
        page = self.build(tyres=self.tyres(COMPARE_TYRES.replace(":TYPE CHILD\n", ":TYPE CHILD\n:MASS 12.5\n")))
        self.assertIn("<p>Declared before <code>INHERIT_TYPE</code> and overwritten by the scalar copy, so shown in no "
                      'cell: <a href="tyres.html#tyre-CHILD-line-30" title="CHILD line 30">CHILD line 30</a> '
                      "(<code>:MASS</code>).</p>", page)
        self.assertIn(f'<span class="label">{ZERO_FILLED}</span>', tyre_cells(page, "CHILD")["MASS"])

    def test_every_link_names_an_id_on_its_page(self):
        tyres = self.tyres()
        page = self.build(tyres=tyres)
        tyres_page = self.root / "tyres.html"
        evidence, status = self.root / "evidence.json", self.root / "status.json"
        evidence.write_text(json.dumps(EVIDENCE), encoding="utf-8")
        tyre_dossier.build(self.root / "tyres.json", evidence, self.pe, tyres_page, revision="0123abcd",
                           status_path=status)
        ids = set(Links(tyres_page.read_text(encoding="utf-8")).ids)
        links = Links(page)
        fragments = [href.removeprefix("tyres.html#") for href in links.hrefs if href.startswith("tyres.html#")]
        self.assertTrue(fragments)
        self.assertEqual(sorted({fragment for fragment in fragments if fragment not in ids}), [])
        stores = {fragment for fragment in fragments if fragment.startswith("tyre-store-")}
        self.assertEqual(stores, {f"tyre-store-{tag}" for tag in TYRE_SCALAR_STORES})
        for name in TYRE_NAMES:
            for table in RESOLVED_TYRE_TABLES:
                self.assertIn(f"tyre-{name}-{table}", fragments)
        labels = {item["label"] for item in STATUS}
        routines = [href.removeprefix("routines.html#") for href in links.hrefs if href.startswith("routines.html#")]
        self.assertEqual(sorted(set(routines)), sorted(TYRE_ACCESSOR_LABELS.values()))
        self.assertTrue(set(routines) <= labels)
        self.assertEqual([href for href in links.hrefs if href.startswith("#") and href[1:] not in links.ids], [])
        self.assertEqual(len(links.ids), len(set(links.ids)))

    def test_scope_states_the_grip_scale_and_no_physics(self):
        page = self.build()
        section = page[page.index('<h2 id="tyres">'):]
        self.assertIn("Values are declarations as written, not physical quantities: this page claims no units, no "
                      "meaning for the compounds and no physics.", section)
        self.assertIn("by the global float at <code>0x00597484</code> when it stores them; that scale is not applied "
                      "here.", section)


class TyreDifferencesTests(CompareTestCase):
    def differences(self, text=COMPARE_TYRES):
        tyres = self.tyres(text)
        checked = record_compare.check_tyres(tyres, (self.game / DATABASES["tyres"]).read_bytes())
        return record_compare.tyre_differences(checked["tyres"])

    def test_written_forms_group_by_number(self):
        found = self.differences()
        scalars = found["scalars"]
        self.assertEqual(list(scalars), tyre_dossier.tyre_tags())
        self.assertEqual(scalars["WIDTH"], {"groups": [{"forms": ["0.25", "0.250"], "tyres": TYRE_NAMES}],
                                            "zero_filled": []})
        self.assertEqual(scalars["RADIUS"], {"groups": [{"forms": ["0.5", "0.50"], "tyres": TYRE_NAMES}],
                                             "zero_filled": []})
        self.assertEqual(scalars["ROAD_MAGIC_GRIP_NUMBER"]["groups"], [{"forms": ["1.0", "1"], "tyres": TYRE_NAMES}])
        self.assertEqual(scalars["OFFROAD_MAGIC_GRIP_NUMBER"], {"groups": [{"forms": ["40"], "tyres": ["OFFROAD", "CHILD"]}],
                                                                "zero_filled": ["ROOT"]})
        self.assertEqual(scalars["MASS"], {"groups": [], "zero_filled": TYRE_NAMES})
        self.assertEqual(found["tables"]["VERTICAL_LOAD"],
                         [{"source": "ROOT", "source_line": 11, "tyres": ["ROOT"]},
                          {"source": "OFFROAD", "source_line": 26, "tyres": ["OFFROAD", "CHILD"]}])
        self.assertEqual(found["tables"]["LONGITUDINAL_COMBINED_VALUES"],
                         [{"source": "ROOT", "source_line": 7, "tyres": TYRE_NAMES}])

    def test_table_rows_counts_and_same_in_all(self):
        page = self.build()
        # Long record names may break anywhere in this table, so that it fits a phone's width.
        self.assertIn('<table class="tyre-differences">', tyre_differences_of(page))
        self.assertIn("table.tyre-differences td { overflow-wrap: anywhere; }", page)
        rows = dict(re.findall(r'<tr id="differs-tyre-(\w+)">(.*?)</tr>', tyre_differences_of(page)))
        self.assertEqual(list(rows), [*tyre_dossier.tyre_tags(), *RESOLVED_TYRE_TABLES])
        self.assertIn('<td>1, by number</td><td><span class="label">same in all 3</span>: <code>0.25</code>, '
                      "<code>0.250</code></td><td>2 inheriting: 1 declared, 1 inherited</td>", rows["WIDTH"])
        self.assertIn('<td>0, by number</td><td><ul><li><span class="label">not declared (zero-filled)</span>, no value '
                      '(3): <a href="#compare-tyre-ROOT">ROOT</a>', rows["MASS"])
        self.assertIn("<td>2 inheriting: 2 zero-filled</td>", rows["MASS"])
        self.assertIn('<td>1, by source record</td><td><span class="label">same in all 3</span>: <a href="tyres.html#'
                      'tyre-ROOT-LATERAL_COMBINED_VALUES" title="ROOT line 9">ROOT</a> line 9</td><td>all 3: 3 ROOT</td>',
                      rows["LATERAL_COMBINED_VALUES"])
        self.assertIn('<td>2, by source record</td><td><ul><li><a href="tyres.html#tyre-ROOT-VERTICAL_LOAD" title="ROOT '
                      'line 11">ROOT</a> line 11 (1): <a href="#compare-tyre-ROOT">ROOT</a></li><li>', rows["VERTICAL_LOAD"])
        self.assertIn("<td>all 3: 1 ROOT, 2 OFFROAD</td>", rows["VERTICAL_LOAD"])
        counts = scalar_counts(self.tyres()["effective_scalars"])
        for tag in tyre_dossier.tyre_tags():
            shown = re.search(r"<td>2 inheriting: (.*?)</td>", rows[tag]).group(1)
            self.assertEqual(shown, ", ".join(f'{counts[tag][status]} {status.replace(ZERO_FILLED, "zero-filled")}'
                                              for status in ("declared", "inherited", ZERO_FILLED)
                                              if status in counts[tag]), tag)

    def test_counts_checked_only_for_the_demo_tyredata(self):
        page = self.build()
        self.assertIn("This <code>TYREDATA.DAT</code> is not the demo's, so these counts are not checked against "
                      "<code>TYRE_SCALAR_COUNTS</code> or <code>TYRE_TABLE_SOURCES</code>.", page)
        tyres = self.tyres()
        page = self.build(tyres=tyres, tyre_counts=tyre_counts(tyres))
        self.assertIn("the table source counts the ones in <code>TYRE_TABLE_SOURCES</code>; the page is not written "
                      "when they differ.", page)
        manifest = json.loads((REPO_ROOT / "analysis/game-file-manifest.json").read_text())
        demo = next(item["sha256"] for item in manifest if item["path"] == DATABASES["tyres"])
        self.assertIs(record_compare.demo_tyre_counts({"source": DATABASES["tyres"], "sha256": demo}),
                      record_compare.TYRE_COUNTS)
        self.assertIsNone(record_compare.demo_tyre_counts({"source": DATABASES["tyres"], "sha256": "0" * 64}))
        self.assertIsNone(record_compare.demo_tyre_counts({"source": DATABASES["engines"], "sha256": demo}))


class TyreRefusalTests(CompareTestCase):
    def reject_tyres(self, fragment, text=COMPARE_TYRES, tyres=None, tyre_counts=None):
        self.reject(fragment, database=self.database(), engines=self.engines(),
                    tyres=self.tyres(text) if tyres is None else tyres, tyre_counts=tyre_counts)

    def test_tyredata_that_does_not_match_tyres_json(self):
        tyres = self.tyres()
        write_database(self.game, "tyres", COMPARE_TYRES.replace("0.250", "0.25"))
        self.reject_tyres("DATA/ASCII/CARS/TYREDATA.DAT does not match tyres.json's SHA-256", tyres=tyres)

    def test_missing_tyredata(self):
        tyres = self.tyres()
        (self.game / DATABASES["tyres"]).unlink()
        with self.assertRaisesRegex(ValueError, "TYREDATA.DAT not found under"):
            self.build(self.database(), self.engines(), tyres=tyres)
        self.assertFalse(self.output.exists())

    def test_unmapped_declaration_tyres_json_does_not_list(self):
        tyres = self.tyres()
        tyres["effective_scalars"]["CHILD"]["unmapped"] = []
        self.reject_tyres("tyre 'CHILD' (line 29) declares :LOCATION_TYPE on line 33, which has no byte-checked store, "
                          "and tyres.json does not list it as unmapped", tyres=tyres)

    def test_derived_fields_that_differ_from_text_database(self):
        tyres = self.tyres()
        tyres["effective_scalars"]["CHILD"]["fields"]["WIDTH"]["source_line"] = 4
        self.reject_tyres("tyres.json effective_scalars disagrees with the record declarations", tyres=tyres)
        tyres = self.tyres()
        tyres["table_provenance"]["CHILD"]["VERTICAL_LOAD"]["source_line"] = 27
        self.reject_tyres("tyres.json table_provenance disagrees with what scripts/text_database.py derives", tyres=tyres)
        tyres = self.tyres()
        tyres["resolved_tables"]["CHILD"]["VERTICAL_LOAD"] = "ROOT"
        tyres["table_provenance"]["CHILD"]["VERTICAL_LOAD"]["source"] = "ROOT"
        self.reject_tyres("tyres.json resolved_tables disagrees with INHERIT_TYPE resolved", tyres=tyres)

    def test_written_token_that_does_not_parse_to_the_json_value(self):
        tyres = self.tyres()
        tyres["records"][1]["fields"]["WIDTH"]["values"] = [0.3]
        self.reject_tyres("tyre 'OFFROAD' (line 22): line 24 of DATA/ASCII/CARS/TYREDATA.DAT declares '0.250', but "
                          "tyres.json holds 0.3", tyres=tyres)
        tyres = self.tyres()
        tyres["records"][2]["fields"]["ROAD_MAGIC_GRIP_NUMBER"]["values"] = [1.0]
        self.reject_tyres("declares '1', but tyres.json holds 1.0", tyres=tyres)
        tyres = self.tyres()
        tyres["records"][2]["fields"]["RADIUS"]["line"] = 32
        self.reject_tyres("line 32 of DATA/ASCII/CARS/TYREDATA.DAT is not ':RADIUS <value>'", tyres=tyres)

    def test_values_that_are_not_one_inline_number(self):
        self.reject_tyres("tyre 'CHILD' (line 29): :RADIUS on line 31 is not a single inline value",
                          COMPARE_TYRES.replace(":RADIUS 0.50\n", ":RADIUS 0.5 0.6\n"))
        self.reject_tyres("tyre 'CHILD' (line 29): :RADIUS on line 31 is stored as a float, but 'BIG' is not a number",
                          COMPARE_TYRES.replace(":RADIUS 0.50\n", ":RADIUS BIG\n"))

    def test_counts_that_differ_from_the_demo_record(self):
        tyres = self.tyres()
        counts = tyre_counts(tyres)
        self.reject_tyres("The inheriting tyres' effective scalar counts differ from TYRE_SCALAR_COUNTS: WIDTH "
                          "{'declared': 1, 'inherited': 1}, not {'declared': 2}", tyres=tyres,
                          tyre_counts={**counts, "scalars": {**counts["scalars"], "WIDTH": {"declared": 2}}})
        self.reject_tyres("The tyres' table source counts differ from TYRE_TABLE_SOURCES: VERTICAL_LOAD "
                          "{'ROOT': 1, 'OFFROAD': 2}, not {'ROOT': 3}", tyres=tyres,
                          tyre_counts={**counts, "tables": {**counts["tables"], "VERTICAL_LOAD": {"ROOT": 3}}})
        self.reject_tyres("TYRE_SCALAR_COUNTS: ROAD_MAGIC_GRIP_NUMBER", tyres=tyres, tyre_counts=record_compare.TYRE_COUNTS)


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
            engines = root / "engines.json"
            engines.write_text(json.dumps(write_engines(game)), encoding="utf-8")
            tyres = root / "tyres.json"
            tyres.write_text(json.dumps(write_tyres(game)), encoding="utf-8")
            output = root / "compare.html"
            inputs = ("--gearboxes", str(gearboxes), "--engines", str(engines), "--tyres", str(tyres), "--game",
                      str(game))
            result = self.run_script(*inputs, "--output", str(output))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("record_compare.py: gearbox 'TRACK' (line 13) does not declare DIFF_TYPE", result.stderr)
            self.assertNotIn("Traceback", result.stderr)
            self.assertFalse(output.exists())
            write_gearboxes(game, COMPARE_GEARBOXES)
            gearboxes.write_text(json.dumps(read_database(game, DATABASES["gearboxes"], KNOWN_TAGS)), encoding="utf-8")
            result = self.run_script(*inputs, "--output", str(output))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Compared 3 gearboxes, 6 engines and 3 tyres field by field", result.stdout)
            self.assertTrue(output.is_file())
            output.unlink()
            # An engine refusal exits the same way.
            engines.write_text(json.dumps(write_engines(game, COMPARE_ENGINES.replace(":CAPACITY 6\n", ":CAPACITY 6 7\n"))),
                               encoding="utf-8")
            result = self.run_script(*inputs, "--output", str(output))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("record_compare.py: engine 'CHILD' (line 13): :CAPACITY on line 15 is not a single inline value",
                          result.stderr)
            self.assertNotIn("Traceback", result.stderr)
            self.assertFalse(output.exists())
            # And a tyre refusal.
            engines.write_text(json.dumps(write_engines(game)), encoding="utf-8")
            tyres.write_text(json.dumps(write_tyres(game, COMPARE_TYRES.replace(":RADIUS 0.50\n", ":RADIUS 0.5 0.6\n"))),
                             encoding="utf-8")
            result = self.run_script(*inputs, "--output", str(output))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("record_compare.py: tyre 'CHILD' (line 29): :RADIUS on line 31 is not a single inline value",
                          result.stderr)
            self.assertNotIn("Traceback", result.stderr)
            self.assertFalse(output.exists())

    def test_help_documents_flags_and_defaults(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0)
        text = " ".join(result.stdout.split())
        self.assertRegex(text, r"--game .*default: [^)]*inputs/extracted/Program_Executable_Files\)")
        self.assertRegex(text, r"--engines .*default: [^)]*engines\.json\)")
        self.assertRegex(text, r"--tyres .*default: [^)]*tyres\.json\)")
        self.assertRegex(text, r"--status .*default: [^)]*analysis/annotated/status\.json\)")
        self.assertRegex(text, r"--output .*default: [^)]*artifacts/dossier/compare\.html\)")


if __name__ == "__main__":
    unittest.main()
