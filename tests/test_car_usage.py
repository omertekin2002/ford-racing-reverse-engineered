"""Synthetic tests of the cars' reverse index and the "Used by cars" blocks and columns; these use no game data."""
import copy
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import record_compare
import record_dossier
from text_database import (BYTE_CHECKED, CAR_REFERENCE_STORES, DECLARED, REPO_ROOT, car_reference_targets, car_usage,
                           check_car_usage, load_known_tags, parse_cars, resolve_car_references)
import tyre_dossier

from test_record_compare import CompareTestCase
from test_record_dossier import EVIDENCE, PE, STATUS, RecordDossierTestCase, engines_json, gearboxes_json
from test_tyre_dossier import DossierTestCase, tyres_json

KNOWN_TAGS = load_known_tags(REPO_ROOT / "analysis/tags.json")
BASES = {tag: BYTE_CHECKED for tag in CAR_REFERENCE_STORES}
CHECKED = BYTE_CHECKED.replace("'", "&#x27;")
# ALPHA names its engine in lower case, which resolves to CHILD, and both its tyres MID; BETA's front tyre is CHILD and
# its back tyre MID. No car names the engine BASE, which CHILD inherits, or the tyre ROOT, which MID inherits, or the
# gearbox ROAD_OLD.
CARS = """:CAR_TYPE ALPHA
:CAR_ENGINE_TYPE child
:CAR_GEARBOX_TYPE TRACK
:CAR_FRONT_TYRE_TYPE MID
:CAR_BACK_TYRE_TYPE MID
:CAR_TYPE BETA
:CAR_ENGINE_TYPE CHILD
:CAR_GEARBOX_TYPE TRACK
:CAR_FRONT_TYRE_TYPE CHILD
:CAR_BACK_TYRE_TYPE MID
:END
"""


def references(bases=BASES, engines=None, gearboxes=None, tyres=None):
    """The cars' references, resolved against the dossier tests' engines, gearboxes and tyres."""
    targets = {"engines": (engines or engines_json())["records"], "gearboxes": (gearboxes or gearboxes_json())["records"],
               "tyres": (tyres or tyres_json())["records"]}
    return resolve_car_references(parse_cars(CARS, KNOWN_TAGS), targets, bases)


def used_by(page, prefix, name):
    """Record `name`'s "Used by cars" block, up to the next heading of its section."""
    start = page.index(f'<h3 id="{prefix}-{name}-used-by">')
    return page[start:page.index("<h3>", start + 1)]


def car_rows(block):
    """(car, tag, basis) for each car row of a "Used by cars" block."""
    return re.findall(r'<tr><td><a href="cars\.html#car-(\w+)">\1</a></td><td><a href="cars\.html#car-store-(\w+)">'
                      r'<code>\2</code></a></td><td><span class="label">([^<]+)</span></td></tr>', block)


class CarUsageTests(unittest.TestCase):
    def test_index_lists_cars_in_file_order_per_record_and_tag(self):
        usage = car_usage(references())
        self.assertEqual(usage, {
            "engines": {"CHILD": [("ALPHA", "CAR_ENGINE_TYPE", BYTE_CHECKED), ("BETA", "CAR_ENGINE_TYPE", BYTE_CHECKED)]},
            "gearboxes": {"TRACK": [("ALPHA", "CAR_GEARBOX_TYPE", BYTE_CHECKED),
                                    ("BETA", "CAR_GEARBOX_TYPE", BYTE_CHECKED)]},
            # A car whose front and back tyre are one record is listed once per tag.
            "tyres": {"MID": [("ALPHA", "CAR_FRONT_TYRE_TYPE", BYTE_CHECKED), ("ALPHA", "CAR_BACK_TYRE_TYPE", BYTE_CHECKED),
                              ("BETA", "CAR_BACK_TYRE_TYPE", BYTE_CHECKED)],
                      "CHILD": [("BETA", "CAR_FRONT_TYRE_TYPE", BYTE_CHECKED)]}})

    def test_index_agrees_with_the_forward_references(self):
        forward = references()
        usage = car_usage(forward)
        self.assertEqual(check_car_usage(usage, forward), car_reference_targets(forward))
        # One link per car per tag: none dropped, none duplicated.
        for tag in CAR_REFERENCE_STORES:
            listed = [car for records in usage.values() for users in records.values() for car, user_tag, _ in users
                      if user_tag == tag]
            self.assertEqual(listed, list(forward), tag)

    def test_parents_are_not_counted_through_their_children(self):
        usage = car_usage(references())
        self.assertNotIn("BASE", usage["engines"])
        self.assertNotIn("ROOT", usage["tyres"])
        self.assertNotIn("ROAD_OLD", usage["gearboxes"])

    def test_basis_comes_from_each_reference(self):
        bases = {**BASES, "CAR_BACK_TYRE_TYPE": DECLARED}
        usage = car_usage(references(bases))
        self.assertEqual([basis for _, tag, basis in usage["tyres"]["MID"]], [BYTE_CHECKED, DECLARED, DECLARED])

    def test_refuses_an_index_that_drops_duplicates_or_moves_a_car(self):
        forward = references()
        for label, change, message in (
                ("dropped", lambda usage: usage["tyres"]["MID"].pop(), "missing BETA CAR_BACK_TYRE_TYPE -> tyres MID"),
                ("duplicated", lambda usage: usage["engines"]["CHILD"].append(usage["engines"]["CHILD"][0]),
                 "unexpected ALPHA CAR_ENGINE_TYPE -> engines CHILD"),
                ("moved", lambda usage: usage["engines"].setdefault("BASE", []).append(usage["engines"]["CHILD"].pop()),
                 "unexpected BETA CAR_ENGINE_TYPE -> engines BASE"),
                ("relabelled", lambda usage: usage["gearboxes"]["TRACK"].__setitem__(
                    0, ("ALPHA", "CAR_GEARBOX_TYPE", DECLARED)), "missing ALPHA CAR_GEARBOX_TYPE -> gearboxes TRACK")):
            with self.subTest(label):
                usage = copy.deepcopy(car_usage(forward))
                change(usage)
                with self.assertRaisesRegex(ValueError, re.escape(message)):
                    check_car_usage(usage, forward)


class RecordDossierUsageTests(RecordDossierTestCase):
    def build_with(self, usage, engines=None, gearboxes=None):
        engines = engines_json() if engines is None else engines
        gearboxes = gearboxes_json() if gearboxes is None else gearboxes
        record_dossier.build(self.write("engines.json", engines), self.write("gearboxes.json", gearboxes),
                             self.write("pe.json", PE), self.output, revision="0123abcd",
                             status_path=self.write("status.json", STATUS),
                             evidence_path=self.write("evidence.json", EVIDENCE), car_usage=usage)
        return tuple(page.read_text(encoding="utf-8") for page in self.pages)

    def test_each_record_lists_the_cars_that_name_it(self):
        engines, gearboxes = self.build_with(car_usage(references()))
        self.assertEqual(car_rows(used_by(engines, "engine", "CHILD")),
                         [("ALPHA", "CAR_ENGINE_TYPE", CHECKED), ("BETA", "CAR_ENGINE_TYPE", CHECKED)])
        self.assertEqual(car_rows(used_by(gearboxes, "gearbox", "TRACK")),
                         [("ALPHA", "CAR_GEARBOX_TYPE", CHECKED), ("BETA", "CAR_GEARBOX_TYPE", CHECKED)])
        for page, prefix, names in ((engines, "engine", ("BASE", "CHILD", "GRANDCHILD", "LONER")),
                                    (gearboxes, "gearbox", ("ROAD_OLD", "TRACK"))):
            for name in names:
                section = page[page.index(f'id="{prefix}-{name}"'):]
                self.assertLess(section.index(f'id="{prefix}-{name}-used-by"'), section.index("</section>"), name)
            self.assertIn('<p class="scope">Used by cars:', page)

    def test_a_parent_no_car_names_says_so_and_is_never_used_through_inheritance(self):
        engines, gearboxes = self.build_with(car_usage(references()))
        for page, prefix, name in ((engines, "engine", "BASE"), (engines, "engine", "GRANDCHILD"),
                                   (gearboxes, "gearbox", "ROAD_OLD")):
            block = used_by(page, prefix, name)
            self.assertIn("Not named by any car in <code>CARDATA.DAT</code>.", block)
            self.assertEqual(car_rows(block), [])
        # BASE's section names no car anywhere, though CHILD, which the cars name, inherits it.
        base = engines[engines.index('id="engine-BASE"'):]
        self.assertNotIn("cars.html#car-", base[:base.index("</section>")])

    def test_declared_by_name_when_the_loader_evidence_does_not_check(self):
        bases = {**BASES, "CAR_ENGINE_TYPE": DECLARED}
        engines, gearboxes = self.build_with(car_usage(references(bases)))
        self.assertEqual(car_rows(used_by(engines, "engine", "CHILD")),
                         [("ALPHA", "CAR_ENGINE_TYPE", DECLARED), ("BETA", "CAR_ENGINE_TYPE", DECLARED)])
        self.assertNotIn(CHECKED, used_by(engines, "engine", "CHILD"))
        self.assertEqual({basis for _, _, basis in car_rows(used_by(gearboxes, "gearbox", "TRACK"))}, {CHECKED})

    def test_without_car_data_the_pages_are_unchanged(self):
        before = self.build()
        self.assertEqual(self.build_with(None), before)
        for page in before:
            self.assertNotIn("Used by cars", page)
            self.assertNotIn("cars.html#", page)

    def test_refuses_usage_that_does_not_fit_the_records(self):
        usage = car_usage(references())
        for change, message in ((lambda usage: usage.pop("gearboxes"), "has no gearboxes entry"),
                                (lambda usage: usage["engines"].__setitem__("GONE", []),
                                 "name engines records that are not in the database: GONE")):
            with self.subTest(message):
                broken = copy.deepcopy(usage)
                change(broken)
                with self.assertRaisesRegex(ValueError, message):
                    self.build_with(broken)
                for page in self.pages:
                    self.assertFalse(page.exists())


class TyreDossierUsageTests(DossierTestCase):
    def build_with(self, usage):
        tyre_dossier.build(self.write("tyres.json", tyres_json()), self.write("evidence.json", EVIDENCE),
                           self.write("pe.json", PE), self.output, revision="0123abcd",
                           status_path=self.write("status.json", STATUS), car_usage=usage)
        return self.output.read_text(encoding="utf-8")

    def test_front_and_back_are_listed_apart(self):
        page = self.build_with(car_usage(references()))
        mid = used_by(page, "tyre", "MID")
        self.assertEqual(car_rows(mid), [("ALPHA", "CAR_FRONT_TYRE_TYPE", CHECKED), ("ALPHA", "CAR_BACK_TYRE_TYPE", CHECKED),
                                         ("BETA", "CAR_BACK_TYRE_TYPE", CHECKED)])
        self.assertLess(mid.index("CAR_FRONT_TYRE_TYPE</code></a>: 1 car."),
                        mid.index("CAR_BACK_TYRE_TYPE</code></a>: 2 cars."))
        child = used_by(page, "tyre", "CHILD")
        self.assertEqual(car_rows(child), [("BETA", "CAR_FRONT_TYRE_TYPE", CHECKED)])
        self.assertIn('<code>CAR_BACK_TYRE_TYPE</code></a>: not named by any car in <code>CARDATA.DAT</code>.', child)
        root = used_by(page, "tyre", "ROOT")
        self.assertIn("Not named by any car in <code>CARDATA.DAT</code>.", root)
        self.assertEqual(car_rows(root), [])

    def test_declared_by_name_back_tyre(self):
        page = self.build_with(car_usage(references({**BASES, "CAR_BACK_TYRE_TYPE": DECLARED})))
        self.assertEqual([(tag, basis) for _, tag, basis in car_rows(used_by(page, "tyre", "MID"))],
                         [("CAR_FRONT_TYRE_TYPE", CHECKED), ("CAR_BACK_TYRE_TYPE", DECLARED),
                          ("CAR_BACK_TYRE_TYPE", DECLARED)])

    def test_without_car_data_the_page_is_unchanged(self):
        before = self.build()
        self.assertEqual(self.build_with(None), before)
        self.assertNotIn("Used by cars", before)
        self.assertNotIn("cars.html#", before)


class CompareUsageTests(CompareTestCase):
    def build_with(self, usage):
        database, engines, tyres = self.database(), self.engines(), self.tyres()
        paths = {}
        for stem, data in (("gearboxes", database), ("engines", engines), ("tyres", tyres), ("status", STATUS)):
            paths[stem] = self.root / f"{stem}.json"
            paths[stem].write_text(json.dumps(data), encoding="utf-8")
        record_compare.build(paths["gearboxes"], paths["engines"], paths["tyres"], self.game, self.pe, self.output,
                             revision="0123abcd", status_path=paths["status"], car_usage=usage)
        return self.output.read_text(encoding="utf-8")

    def usage(self):
        """Cars naming the compare tests' records: two name the gearbox TRACK, the engine CHILD and the tyre OFFROAD
        (one as both front and back), one the tyre CHILD as its front tyre."""
        return {"engines": {"CHILD": [("A", "CAR_ENGINE_TYPE", BYTE_CHECKED), ("B", "CAR_ENGINE_TYPE", BYTE_CHECKED)]},
                 "gearboxes": {"TRACK": [("A", "CAR_GEARBOX_TYPE", BYTE_CHECKED),
                                         ("B", "CAR_GEARBOX_TYPE", BYTE_CHECKED)]},
                 "tyres": {"OFFROAD": [("A", "CAR_FRONT_TYRE_TYPE", BYTE_CHECKED), ("A", "CAR_BACK_TYRE_TYPE", BYTE_CHECKED),
                                       ("B", "CAR_BACK_TYRE_TYPE", BYTE_CHECKED)],
                           "CHILD": [("B", "CAR_FRONT_TYRE_TYPE", BYTE_CHECKED)]}}

    def test_each_matrix_counts_the_cars_and_links_the_record_block(self):
        page = self.build_with(self.usage())
        self.assertEqual(page.count("<th>Used by cars"), 3)
        self.assertIn("<th>Used by cars<br><small><code>CAR_GEARBOX_TYPE</code></small></th>", page)
        self.assertIn("<th>Used by cars<br><small><code>CAR_ENGINE_TYPE</code></small></th>", page)
        self.assertIn("<th>Used by cars<br><small>front, back</small></th>", page)
        gearboxes = dict(re.findall(r'<tr id="compare-gearbox-(\w+)"><td>.*?</td><td class="num">'
                                    r'<a href="gearboxes\.html#gearbox-\1-used-by">(\d+)</a></td>', page))
        self.assertEqual(gearboxes, {"ROAD": "0", "TRACK": "2", "RALLY": "0"})
        engines = dict(re.findall(r'<tr id="compare-engine-(\w+)"><td>.*?</td><td class="num">'
                                  r'<a href="engines\.html#engine-\1-used-by">(\d+)</a></td>', page))
        self.assertEqual(engines, {"DEFAULT_TRACK": "0", "CHILD": "2", "GRANDCHILD": "0", "INDIGO": "0",
                                   "INDIGO_CHILD": "0", "LONER": "0"})
        tyres = {name: (front, back) for name, front, back in re.findall(
            r'<tr id="compare-tyre-(\w+)"><td>.*?</td><td>front <a href="tyres\.html#tyre-\1-used-by">(\d+)</a><br>'
            r'back <a href="tyres\.html#tyre-\1-used-by">(\d+)</a></td>', page)}
        self.assertEqual(tyres, {"ROOT": ("0", "0"), "OFFROAD": ("1", "2"), "CHILD": ("1", "0")})
        self.assertEqual(page.count('<p>The "Used by cars" column counts'), 3)

    def test_without_car_data_the_page_is_unchanged(self):
        before = self.build()
        self.assertEqual(self.build_with(None), before)
        self.assertNotIn("Used by cars", before)

    def test_refuses_usage_naming_a_record_the_page_lacks(self):
        usage = self.usage()
        usage["tyres"]["GONE"] = [("A", "CAR_FRONT_TYRE_TYPE", BYTE_CHECKED)]
        with self.assertRaisesRegex(ValueError, "name tyres records that are not in the database: GONE"):
            self.build_with(usage)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
