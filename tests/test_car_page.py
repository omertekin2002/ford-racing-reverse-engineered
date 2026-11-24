"""Synthetic "Cars" page tests; these use no game data."""
from collections import Counter
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import car_page
from dossier_common import NOTICE_LINKS, rights_notice
from text_database import (BYTE_CHECKED, DATABASES, DECLARED, REPO_ROOT, car_reference_bases, car_reference_targets,
                           load_known_tags, load_tag_ids, write_databases)

from test_build_research import write_game

SCRIPT = REPO_ROOT / "scripts/car_page.py"
KNOWN_TAGS = load_known_tags(REPO_ROOT / "analysis/tags.json")
TAG_IDS = load_tag_ids(REPO_ROOT / "analysis/tags.json")
EVIDENCE = json.loads((REPO_ROOT / "analysis/selected/field-evidence.json").read_text())
PE = REPO_ROOT / "analysis/pe-metadata.json"
# BASE shares its name with the engine BASE. Its CAR_PERFORMANCE lines repeat SPEED, are interleaved with another tag
# and write 0.20 and 1.0, which the page must keep as written. RALLY_CAR names its engine in lower case, which the
# lookup's compare matches ignoring case.
CARS = """// Cars for the car page
:CAR_TYPE BASE
:CAR_SETUP_TYPE BASE
:CAR_BODY_TYPE 46_CONVERTIBLE
:CAR_ENGINE_TYPE BASE
:CAR_GEARBOX_TYPE ROAD
:CAR_FRONT_TYRE_TYPE ROOT
:CAR_BACK_TYRE_TYPE MID
:CAR_PERFORMANCE SPEED 0.20
:CAR_APPROXIMATE_TOP_SPEED 80
:CAR_PERFORMANCE AGILITY 0.5
:CAR_PERFORMANCE SPEED 1.0
:VALID_LIVERY DEFAULT BASED

:CAR_TYPE RALLY_CAR
:CAR_ENGINE_TYPE child
:CAR_GEARBOX_TYPE RALLY
:CAR_FRONT_TYRE_TYPE CHILD
:CAR_BACK_TYRE_TYPE CHILD
:END
"""
BACK_TYRE_STORE = 0x005210AC


def ids_and_links(text):
    class Collect(HTMLParser):
        def __init__(self):
            super().__init__()
            self.ids, self.hrefs, self.scripts = [], [], 0

        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            if "id" in attrs:
                self.ids.append(attrs["id"])
            if "href" in attrs:
                self.hrefs.append(attrs["href"])
            self.scripts += tag == "script"

    parsed = Collect()
    parsed.feed(text)
    return parsed


def section(page, name):
    start = page.index(f'<section class="car" id="car-{name}">')
    return page[start:page.index("</section>", start)]


class CarPageTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.game = write_game(self.root / "game")
        self.write_cars(CARS)
        self.work = self.root / "work"
        self.output = self.root / "research/cars.html"

    def write_cars(self, text):
        (self.game / DATABASES["cars"]).write_bytes(text.replace("\n", "\r\n").encode("ascii"))

    def parse(self, evidence=None):
        bases = None if evidence is None else car_reference_bases(evidence, TAG_IDS)
        write_databases(self.game, self.work, KNOWN_TAGS, bases=bases)

    def build(self, evidence=EVIDENCE, parse=True, **kwargs):
        if parse:
            self.parse(evidence)
        evidence_path = self.root / "field-evidence.json"
        evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
        count = car_page.build(*(self.work / f"{stem}.json" for stem in ("cars", "engines", "gearboxes", "tyres")),
                               self.game, PE, self.output, revision="0123abcd", evidence_path=evidence_path, **kwargs)
        self.assertEqual(count, 2)
        return self.output.read_text(encoding="utf-8")

    def edit_cars_json(self, change):
        path = self.work / "cars.json"
        data = json.loads(path.read_text())
        change(data)
        path.write_text(json.dumps(data))


class PageTests(CarPageTestCase):
    def test_one_section_per_car_with_family_namespaced_unique_ids(self):
        page = self.build()
        parsed = ids_and_links(page)
        self.assertEqual([name for name, count in Counter(parsed.ids).items() if count > 1], [])
        self.assertEqual(page.count('<section class="car"'), 2)
        # The car BASE and the engine BASE have different ids: car-BASE here, engine-BASE on engines.html.
        self.assertIn("car-BASE", parsed.ids)
        self.assertNotIn("engine-BASE", parsed.ids)
        self.assertIn("engines.html#engine-BASE", parsed.hrefs)
        self.assertIn('<a href="#car-BASE">BASE</a>', page)
        for line in (3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13):
            self.assertIn(f"car-BASE-line-{line}", parsed.ids)

    def test_references_link_their_records_with_the_basis_from_cars_json(self):
        page = self.build()
        base, rally = section(page, "BASE"), section(page, "RALLY_CAR")
        for href in ("engines.html#engine-BASE", "gearboxes.html#gearbox-ROAD", "tyres.html#tyre-ROOT",
                     "tyres.html#tyre-MID"):
            self.assertIn(f'href="{href}"', base)
        for href in ("engines.html#engine-CHILD", "gearboxes.html#gearbox-RALLY", "tyres.html#tyre-CHILD"):
            self.assertIn(f'href="{href}"', rally)
        # The engine is declared in lower case, shown as written, and linked to the record the lookup finds.
        self.assertIn("<code>child</code>", rally)
        self.assertIn('<a href="engines.html#engine-CHILD">CHILD</a> (matches ignoring case, as the lookup compares)',
                      rally)
        label = f'<span class="label">{BYTE_CHECKED.replace(chr(39), "&#x27;")}</span>'
        self.assertEqual(base.count(label), 4)
        self.assertEqual(rally.count(label), 4)
        self.assertNotIn(DECLARED, base + rally)
        # The summary names each car's four records.
        summary = page[page.index('<h2 id="summary">'):page.index('<h2 id="how-loaded">')]
        self.assertIn('<td><a href="#car-RALLY_CAR">RALLY_CAR</a></td>', summary)
        self.assertEqual(summary.count('href="tyres.html#tyre-CHILD"'), 2)

    def test_a_reference_whose_sites_are_not_byte_checked_is_declared_by_name(self):
        evidence = [site for site in EVIDENCE if site["va"] != BACK_TYRE_STORE]
        page = self.build(evidence)
        base = section(page, "BASE")
        back = base[base.index("CAR_BACK_TYRE_TYPE</code></a>"):]
        back = back[:back.index("</tr>")]
        self.assertIn(f'<span class="label">{DECLARED}</span>', back)
        self.assertEqual(base.count(DECLARED), 1)
        store = page[page.index('id="car-store-CAR_BACK_TYRE_TYPE"'):]
        store = store[:store.index("</tr>")]
        self.assertIn('<code>0x005210ac</code> (<span class="label">not byte-checked</span>)', store)
        self.assertIn(DECLARED, store)
        self.assertNotIn("routines.html#site-005210ac", page)
        # Nothing else changes basis.
        engine = page[page.index('id="car-store-CAR_ENGINE_TYPE"'):]
        self.assertIn("byte-checked)", engine[:engine.index("</tr>")])

    def test_refuses_cars_json_that_calls_a_reference_byte_checked_without_its_sites(self):
        self.parse()
        evidence = [site for site in EVIDENCE if site["va"] != BACK_TYRE_STORE]
        with self.assertRaisesRegex(ValueError, "cars.json references differ .* for: BASE, RALLY_CAR"):
            self.build(evidence, parse=False)
        self.assertFalse(self.output.exists())

    def test_refuses_a_dangling_reference(self):
        self.parse()

        def dangle(data):
            data["references"]["BASE"]["CAR_ENGINE_TYPE"]["target"] = "NOPE"
        self.edit_cars_json(dangle)
        with self.assertRaisesRegex(ValueError, "cars.json references differ .* for: BASE "):
            self.build(parse=False)
        # A name that matches no record refuses already when the references are resolved.
        self.write_cars(CARS.replace(":CAR_GEARBOX_TYPE RALLY", ":CAR_GEARBOX_TYPE NOPE"))
        with self.assertRaisesRegex(ValueError, "'NOPE' matches no gearboxes record"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_car_performance_lines_in_file_order_as_written_without_units(self):
        page = self.build()
        rows = re.findall(r'<tr id="car-BASE-line-(\d+)"><td>\d+</td><td><code>:([A-Z_]+)</code></td>'
                          r"<td><code>([^<]*)</code></td></tr>", section(page, "BASE"))
        self.assertEqual(rows, [("3", "CAR_SETUP_TYPE", "BASE"), ("4", "CAR_BODY_TYPE", "46_CONVERTIBLE"),
                                ("5", "CAR_ENGINE_TYPE", "BASE"), ("6", "CAR_GEARBOX_TYPE", "ROAD"),
                                ("7", "CAR_FRONT_TYRE_TYPE", "ROOT"), ("8", "CAR_BACK_TYRE_TYPE", "MID"),
                                ("9", "CAR_PERFORMANCE", "SPEED 0.20"), ("10", "CAR_APPROXIMATE_TOP_SPEED", "80"),
                                ("11", "CAR_PERFORMANCE", "AGILITY 0.5"), ("12", "CAR_PERFORMANCE", "SPEED 1.0"),
                                ("13", "VALID_LIVERY", "DEFAULT BASED")])
        self.assertIn("no units, menu meaning or physics are claimed", page)
        self.assertIn("no units or menu meaning are claimed", section(page, "BASE"))
        # The tags of databases nobody parses are not linked.
        self.assertNotIn("46_CONVERTIBLE</a>", page)

    def test_refuses_cars_json_that_differs_from_cardata(self):
        self.parse()

        def change(data):
            data["records"][0]["repeated"]["CAR_PERFORMANCE"][0]["values"][1] = 0.3
        self.edit_cars_json(change)
        with self.assertRaisesRegex(ValueError, "cars.json records differ from parsing DATA/ASCII/CARS/CARDATA.DAT"):
            self.build(parse=False)

        self.parse()

        def drop_livery(data):
            data["records"][0]["repeated"]["VALID_LIVERY"].pop()
        self.edit_cars_json(drop_livery)
        with self.assertRaisesRegex(ValueError, "cars.json records differ from parsing DATA/ASCII/CARS/CARDATA.DAT"):
            self.build(parse=False)

        self.parse()
        self.write_cars(CARS.replace("0.20", "0.2"))
        with self.assertRaisesRegex(ValueError, "CARDATA.DAT does not match cars.json's SHA-256"):
            self.build(parse=False)

    def test_accepts_numeric_only_reference_name(self):
        engines = (self.game / DATABASES["engines"]).read_text(encoding="ascii")
        (self.game / DATABASES["engines"]).write_bytes(
            engines.replace(":TYPE BASE", ":TYPE 123").replace(":INHERIT_TYPE BASE", ":INHERIT_TYPE 123").encode("ascii"))
        self.write_cars(CARS.replace(":CAR_ENGINE_TYPE BASE", ":CAR_ENGINE_TYPE 123"))
        page = self.build()
        self.assertIn('href="engines.html#engine-123"', section(page, "BASE"))
        self.assertIn("<td><code>:CAR_ENGINE_TYPE</code></td><td><code>123</code></td>", section(page, "BASE"))

    def test_store_table_links_each_byte_checked_site_and_the_loader(self):
        page = self.build()
        for tag, offset, store, lookup in (("CAR_ENGINE_TYPE", "0x1a8", "00520ece", "engines"),
                                           ("CAR_GEARBOX_TYPE", "0x1ac", "00520f6f", "gearboxes"),
                                           ("CAR_FRONT_TYRE_TYPE", "0x1b4", "00520f20", "tyres"),
                                           ("CAR_BACK_TYRE_TYPE", "0x1b8", "005210ac", "tyres")):
            row = page[page.index(f'<tr id="car-store-{tag}">'):]
            row = row[:row.index("</tr>")]
            self.assertIn(f"<code>+ {offset}</code>, stored at "
                          f'<a href="routines.html#site-{store}"><code>0x{store}</code></a>', row)
            self.assertIn(f'href="#car-lookup-{lookup}"', row)
        self.assertNotIn("not byte-checked", page)
        lookups = page[page.index('id="lookups"'):page.index('<h2 id="cars">')]
        self.assertEqual(lookups.count('<tr id="car-lookup-'), 3)
        self.assertIn('<a href="routines.html#site-005240e4"><code>0x005240e4</code></a>', lookups)
        self.assertIn("<code>find_tyre_record.asm</code>", lookups)
        self.assertIn('href="routines.html#asm-load_car_database"', page)
        # Standalone, the evidence links point at the repository's analysis/ files.
        linked = {href for href in ids_and_links(page).hrefs if href.endswith(".asm")}
        self.assertEqual({Path(self.output.parent, href).resolve() for href in linked},
                         {REPO_ROOT / "analysis/selected" / name for name in
                          ("load_car_database.asm", "copy_engine_record.asm", "copy_gearbox_record.asm",
                           "find_tyre_record.asm")})

    def test_evidence_hrefs_are_used_when_given(self):
        hrefs = {path.name: f"evidence/selected/{path.name}" for path in (REPO_ROOT / "analysis/selected").glob("*.asm")}
        page = self.build(hrefs=hrefs)
        self.assertIn('<a href="evidence/selected/load_car_database.asm"><code>load_car_database.asm</code></a>', page)
        del hrefs["find_tyre_record.asm"]
        with self.assertRaisesRegex(ValueError, "No href for these disassembly files: find_tyre_record.asm"):
            self.build(hrefs=hrefs)

    def test_notice_revision_and_no_scripts_or_remote_resources(self):
        page = self.build()
        self.assertEqual(page.count(rights_notice()), 1)
        self.assertLess(page.index(rights_notice()), page.index("<h1>"))
        self.assertIn("<dt>Producer revision</dt><dd><code>0123abcd</code> (<code>scripts/car_page.py</code>)</dd>",
                      page)
        parsed = ids_and_links(page)
        self.assertEqual(parsed.scripts, 0)
        self.assertEqual({href for href in parsed.hrefs if "://" in href}, set(NOTICE_LINKS))
        self.assertIn('<nav>Research: <strong>Cars</strong> | <a href="engines.html">Engines</a>', page)
        self.assertNotIn("index.html", page)
        self.assertIn('<a href="index.html">Explore findings</a>', self.build(entrance=True))

    def test_demo_counts_are_checked_only_for_the_demo_or_when_given(self):
        page = self.build()
        self.assertIn("This is not the demo's <code>CARDATA.DAT</code>, so its counts are not checked.", page)
        self.assertIn("2 engines, 2 gearboxes, 2 front tyres, 2 back tyres", page)
        targets = car_reference_targets(json.loads((self.work / "cars.json").read_text())["references"])
        with self.assertRaisesRegex(ValueError, "Car record count mismatch: 2, the demo has 55"):
            self.build(targets=targets)
        with mock_demo_cars(2, 3):
            with self.assertRaisesRegex(ValueError, r"CAR_PERFORMANCE entries per car mismatch: \[0, 3\], the demo "
                                                    "has 3"):
                self.build(targets=targets)
            self.write_cars(CARS.replace(":END", ":CAR_PERFORMANCE A 1\n:CAR_PERFORMANCE B 2\n:CAR_PERFORMANCE C 3\n:END"))
            page = self.build(targets=targets)
            self.assertIn("These counts, the 2 cars and their 3 <code>:CAR_PERFORMANCE</code> lines each are checked",
                          page)
            with self.assertRaisesRegex(ValueError, "Car reference target counts mismatch: .*'CAR_ENGINE_TYPE': 2"):
                self.build(targets={**targets, "CAR_ENGINE_TYPE": 52}, parse=False)

    def test_refuses_repeated_ids(self):
        database = {"records": [{"type": "store-CAR_ENGINE_TYPE", "line": 1}]}
        with self.assertRaisesRegex(ValueError, "These page anchors are not unique: car-store-CAR_ENGINE_TYPE"):
            car_page.check_anchors(database, {"store-CAR_ENGINE_TYPE": []})


class mock_demo_cars:
    """Patch the demo's car count and CAR_PERFORMANCE lines per car to the synthetic cars'."""

    def __init__(self, cars, performance):
        self.values = {"DEMO_CARS": cars, "CAR_PERFORMANCE_ENTRIES": performance}

    def __enter__(self):
        self.saved = {name: getattr(car_page, name) for name in self.values}
        for name, value in self.values.items():
            setattr(car_page, name, value)

    def __exit__(self, *exc):
        for name, value in self.saved.items():
            setattr(car_page, name, value)


class CommandTests(CarPageTestCase):
    def run_script(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False,
                              timeout=120)

    def test_writes_the_page(self):
        self.parse()
        args = [arg for stem in ("cars", "engines", "gearboxes", "tyres")
                for arg in (f"--{stem}", str(self.work / f"{stem}.json"))]
        result = self.run_script(*args, "--game", str(self.game), "--output", str(self.output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"Wrote 2 cars to {self.output}", result.stdout)
        self.assertIn('<section class="car" id="car-RALLY_CAR">', self.output.read_text(encoding="utf-8"))

    def test_fails_loudly_without_its_inputs(self):
        result = self.run_script("--cars", str(self.root / "absent.json"), "--output", str(self.output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("car_page.py: Car database (run scripts/text_database.py first) not found", result.stderr)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
