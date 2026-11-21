"""Synthetic engine and gearbox dossier tests; these use no game data."""
import copy
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dossier_common import NOTICE_LINKS, rights_notice
import record_dossier
from text_database import (ENGINE_FIELD_STORES, GEARBOX_FIELD_STORES, GEARBOX_TAGS, REPO_ROOT, effective_engine_fields, parse,
                           untagged_inherit_consequences)

TAGS = {"CAPACITY", "LOCATION_TYPE", "MAX_RPM", "TORQUE_ARRAY", "INHERIT_TYPE", *GEARBOX_TAGS}
# BASE declares everything, CHILD and GRANDCHILD inherit, LONER has a colon-less INHERIT_TYPE line.
ENGINES = """:TYPE BASE
:CAPACITY 777.25
:LOCATION_TYPE FRONT
:MAX_RPM 6500
:TORQUE_ARRAY
0 100.5
1000 200.5
2000 150.5
:TYPE CHILD
:INHERIT_TYPE BASE
:CAPACITY 1.5
:TYPE GRANDCHILD
:INHERIT_TYPE CHILD
:MAX_RPM 9100
:TYPE LONER
INHERIT_TYPE BASE
:CAPACITY 2.25
:END
"""
GEARBOXES = """:TYPE ROAD_OLD
:CLUTCH_SPEED 0.3
:DRIVE_TYPE FRONT_WHEELS
:TYPE TRACK
:CLUTCH_SPEED 0.45
:END
"""
ENGINE_NAMES = ["BASE", "CHILD", "GRANDCHILD", "LONER"]
PE = json.loads((REPO_ROOT / "analysis/pe-metadata.json").read_text())
BASE_VALUES = ("777.25", "FRONT", "6500", "100.5", "200.5", "150.5")
STATUS = json.loads((REPO_ROOT / "analysis/annotated/status.json").read_text())
EVIDENCE = json.loads((REPO_ROOT / "analysis/selected/field-evidence.json").read_text())
# Each page's load and copy routines: entry VA and status.json label.
ROUTINES = {"engine": {"load": ("005227f0", "fr3_load_engine_database"), "copy": ("00522c80", "fr3_copy_engine_record")},
            "gearbox": {"load": ("00523220", "fr3_load_gearbox_database"),
                        "copy": ("00523470", "fr3_copy_gearbox_record")}}


def status_with(entry_va, label=None):
    """The committed status.json with the routine at entry_va relabelled, or removed when label is None."""
    status = copy.deepcopy(STATUS)
    if label is None:
        return [item for item in status if item["entry_va"] != entry_va]
    for item in status:
        if item["entry_va"] == entry_va:
            item["label"] = label
    return status


def database(text, source):
    return {"source": source, "sha256": hashlib.sha256(text.encode()).hexdigest(), "records": parse(text, TAGS)}


def with_engine_fields(engines):
    """engines.json as text_database.py writes it: the records plus their effective fields and consequences."""
    return {**engines, "effective_fields": effective_engine_fields(engines["records"]),
            "untagged_inherit_consequences": untagged_inherit_consequences(engines["records"])}


def engines_json(text=ENGINES):
    return with_engine_fields(database(text, "DATA/ASCII/CARS/ENGDATA.DAT"))


def gearboxes_json(text=GEARBOXES):
    return database(text, "DATA/ASCII/CARS/GEARDATA.DAT")


def section(page, prefix, name):
    start = page.index(f'<section class="record" id="{prefix}-{name}">')
    return page[start:page.index("</section>", start)]


def summary_row(page, prefix, name):
    summary = page[page.index("<h2>Summary</h2>"):page.index('<section class="record"')]
    start = summary.index(f'<tr><td><a href="#{prefix}-{name}">')
    return summary[start:summary.index("</tr>", start)]


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


class RecordDossierTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.output = self.root / "dossier"
        self.pages = [self.output / "engines.html", self.output / "gearboxes.html"]

    def write(self, name, data):
        path = self.root / name
        path.write_text(data if isinstance(data, str) else json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path

    def build(self, engines=None, gearboxes=None, pe=PE, status=STATUS, evidence=EVIDENCE):
        engines = engines_json() if engines is None else engines
        gearboxes = gearboxes_json() if gearboxes is None else gearboxes
        counts = record_dossier.build(self.write("engines.json", engines), self.write("gearboxes.json", gearboxes),
                                      self.write("pe.json", pe), self.output, revision="0123abcd",
                                      status_path=self.write("status.json", status),
                                      evidence_path=self.write("evidence.json", evidence))
        self.assertEqual(counts, {"engines": len(engines["records"]), "gearboxes": len(gearboxes["records"])})
        return tuple(page.read_text(encoding="utf-8") for page in self.pages)

    def reject(self, fragment, engines=None, gearboxes=None, pe=PE, status=STATUS, evidence=EVIDENCE):
        with self.assertRaises(ValueError) as caught:
            self.build(engines, gearboxes, pe, status, evidence)
        self.assertIn(fragment, str(caught.exception))
        for page in self.pages:
            self.assertFalse(page.exists(), page)


class RecordDossierPageTests(RecordDossierTestCase):
    def test_anchors_are_unique_and_every_link_resolves(self):
        for page, prefix, names in zip(self.build(), ("engine", "gearbox"), (ENGINE_NAMES, ["ROAD_OLD", "TRACK"]),
                                       strict=True):
            with self.subTest(prefix=prefix):
                links = Links(page)
                self.assertEqual(len(links.ids), len(set(links.ids)))
                # Each inheriting engine's effective TORQUE_ARRAY row has an id, which the entrance page links.
                torque = {"CHILD", "GRANDCHILD"} if prefix == "engine" else set()
                # Each declaration row has an id, which the engine page's effective fields and the Compare records page
                # link; so does each row of the gearbox store table.
                lines = [anchor for anchor in links.ids if "-line-" in anchor]
                self.assertTrue(lines)
                self.assertTrue(all(re.fullmatch(rf"{prefix}-({'|'.join(names)})-line-\d+", anchor) for anchor in lines))
                stores = ([f"gearbox-store-{tag}" for tag in record_dossier.gearbox_tags()] if prefix == "gearbox"
                          else [f"engine-store-{tag}" for tag in record_dossier.engine_tags()])
                self.assertEqual([anchor for anchor in links.ids if "-line-" not in anchor],
                                 ["rights-notice", "rights-title", "field-stores", *stores,
                                  *(anchor for name in names for anchor in (f"{prefix}-{name}",
                                                                           f"{prefix}-{name}-torque-array")
                                    if not anchor.endswith("-torque-array") or name in torque)])
                internal = [href[1:] for href in links.hrefs if href.startswith("#")]
                self.assertTrue(internal)
                self.assertEqual([href for href in internal if href not in links.ids], [])
                routines = {f"routines.html#{label}" for _, label in ROUTINES[prefix].values()}
                external = {href for href in links.hrefs if not href.startswith("#")}
                sites = {href for href in external if href.startswith("routines.html#site-")}
                self.assertEqual(external - sites,
                                 {"engines.html", "gearboxes.html", "compare.html", "tyres.html", "pcg.html", "routines.html", "questions.html",
                                  *routines, *NOTICE_LINKS}
                                 - {self.pages[prefix == "gearbox"].name})
                evidence = {f"routines.html#site-{site['va']:08x}" for site in EVIDENCE}
                self.assertEqual(sites - evidence, set())
                self.assertTrue(sites)

    def test_loaded_by_links_the_load_and_copy_routines(self):
        for page, prefix in zip(self.build(), ("engine", "gearbox"), strict=True):
            with self.subTest(prefix=prefix):
                header = page[:page.index("<h2>")]
                (load_va, load), (copy_va, copied) = ROUTINES[prefix]["load"], ROUTINES[prefix]["copy"]
                self.assertIn(f'<dt>Loaded by</dt><dd><a href="routines.html#{load}"><code>{load}</code></a> '
                              f'(<code>0x{load_va}</code>); record copy <a href="routines.html#{copied}"><code>{copied}'
                              f"</code></a> (<code>0x{copy_va}</code>); on the routines page.", header)
                labels = {item["label"] for item in STATUS}
                for fragment in re.findall(r'href="routines\.html#([^"]+)"', page):
                    if not fragment.startswith("site-"):
                        self.assertIn(fragment, labels)

    def test_effective_fields_link_the_copy_routine_and_replace_the_unresolved_note(self):
        engines, _ = self.build()
        for name, parent, line in (("CHILD", "BASE", 10), ("GRANDCHILD", "CHILD", 13)):
            with self.subTest(name=name):
                fields = section(engines, "engine", name)
                self.assertNotIn('<div class="unresolved">', fields)
                self.assertNotIn("unresolved", fields)
                self.assertIn(f'<h3>Effective fields</h3><p><code>:INHERIT_TYPE</code> <a href="#engine-{parent}">'
                              f'{parent}</a> is on line {line}. When the loader parses it, it calls the record copy '
                              '<a href="routines.html#fr3_copy_engine_record"><code>fr3_copy_engine_record</code></a> '
                              '(<a href="routines.html#site-00522b47"><code>0x00522b47</code></a>)', fields)
                self.assertIn('(<a href="routines.html#site-00522926"><code>0x00522926</code></a>)', fields)
                self.assertIn("Values are the declarations as written, not physical quantities.", fields)

    def test_inherit_type_links_to_the_parent(self):
        engines, _ = self.build()
        child = section(engines, "engine", "CHILD")
        self.assertIn('<code>:INHERIT_TYPE</code></td><td>parent <a href="#engine-BASE">BASE</a>; the loader copies its '
                      "effective fields over this record's here (see Effective fields)", child)
        grandchild = section(engines, "engine", "GRANDCHILD")
        self.assertIn('parent <a href="#engine-CHILD">CHILD</a>', grandchild)

    def test_gearbox_inheritance_stays_unresolved(self):
        gearboxes = gearboxes_json(GEARBOXES.replace(":TYPE TRACK\n", ":TYPE TRACK\n:INHERIT_TYPE ROAD_OLD\n"))
        _, page = self.build(gearboxes=gearboxes)
        track = section(page, "gearbox", "TRACK")
        self.assertIn('parent <a href="#gearbox-ROAD_OLD">ROAD_OLD</a> <span class="label">unresolved</span>', track)
        self.assertIn('<span class="label">unresolved</span>: <code>:INHERIT_TYPE</code> '
                      '<a href="#gearbox-ROAD_OLD">ROAD_OLD</a> on line 5.', track)
        self.assertNotIn("Effective fields", page)
        self.assertIn("<th>Parent (unresolved)</th>", page)

    def test_gearbox_store_table_links_each_tag_to_its_sites(self):
        engines, gearboxes = self.build()
        self.assertNotIn("gearbox-store-", engines)
        table = gearboxes[gearboxes.index('<h2 id="field-stores">'):gearboxes.index("<h2>Summary</h2>")]
        rows = re.findall(r'<tr id="gearbox-store-(\w+)"><td><code>(\w+)</code></td><td><code>\+ (0x[0-9a-f]+)</code></td><td>(\w+)</td>'
                          r"<td><code>(\w+)</code></td><td>(.*?)</td><td>(.*?)</td><td>(.*?)</td></tr>", table)
        self.assertEqual([row_id for row_id, tag, *_ in rows], [tag for _, tag, *_ in rows])
        self.assertEqual([row_id for row_id, *_ in rows], record_dossier.gearbox_tags())
        rows = [row[1:] for row in rows]
        self.assertEqual([(tag, offset, width) for tag, offset, width, *_ in rows],
                         [("CLUTCH_SPEED", "0x14", "dword"), ("CLUTCH_MAX_POWER", "0x18", "dword"),
                          ("TORQUE_SHIFT", "0x1c", "dword"), ("DRIVE_SPLIT", "0x20", "dword"),
                          ("TRANSMISSION_TYPE", "0x24", "dword"), ("DIFF_TYPE", "0x28", "dword"),
                          ("DRIVE_TYPE", "0x2c", "dword"), ("ANTI_WHEELSPIN", "0x30", "byte"),
                          ("ANTI_WHEELSKID", "0x31", "byte")])
        by_tag = {row[0]: row for row in rows}
        for tag, entry in GEARBOX_FIELD_STORES.items():
            with self.subTest(tag=tag):
                _, offset, _, field, read, compare, store = by_tag[tag]
                self.assertEqual(field, entry["offsets"][offset]["field"])
                self.assertIn(f'<code>cmp eax, 0x{entry["id"]:x}</code> <a href="routines.html#site-'
                              f'{int(entry["compare"], 16):08x}">', compare)
                self.assertEqual("then <code>jg</code>" in compare, "after_range" in entry)
                self.assertEqual(store, f'<a href="routines.html#site-{int(entry["offsets"][offset]["sites"][0], 16):08x}">'
                                        f'<code>{entry["offsets"][offset]["sites"][0]}</code></a>')
                self.assertIn(f'routines.html#site-{int(entry["read"]["call"], 16):08x}', read)
                kind = entry["read"]["kind"]
                self.assertEqual(read.startswith("enum word"), kind == "enum")
                self.assertEqual("low byte" in read, kind == "float_to_byte")
                if kind == "enum":
                    self.assertIn(f'<code>{entry["enum_table"]["va"]}</code>', read)
        self.assertIn('<code>:INHERIT_TYPE</code> calls the record copy <a href="routines.html#fr3_copy_gearbox_record">'
                      '<code>fr3_copy_gearbox_record</code></a> (<a href="routines.html#site-00523339">', table)
        self.assertIn("No demo gearbox declares <code>:INHERIT_TYPE</code>, so this page resolves none.", table)

    def test_engine_store_table_links_each_tag_to_its_sites(self):
        engines, gearboxes = self.build()
        self.assertNotIn("engine-store-", gearboxes)
        table = engines[engines.index('<h2 id="field-stores">'):engines.index("<h2>Summary</h2>")]
        rows = dict(re.findall(r'<tr id="engine-store-(\w+)">(.*?)</tr>', table))
        # One row per mapped tag, in payload order of its lowest offset.
        self.assertEqual(list(rows), record_dossier.engine_tags())
        self.assertEqual(len(rows), len(ENGINE_FIELD_STORES))
        lowest = [min(int(offset, 16) for offset in ENGINE_FIELD_STORES[tag]["offsets"]) for tag in rows]
        self.assertEqual(lowest, sorted(lowest))
        self.assertEqual(lowest[0], 0x14)
        for tag, entry in ENGINE_FIELD_STORES.items():
            with self.subTest(tag=tag):
                cells = re.findall(r"<td>(.*?)</td>", rows[tag])
                self.assertEqual(cells[0], f"<code>{tag}</code>")
                where, widths, fields, compare, stores, notes = cells[1:]
                self.assertEqual(widths.split("<br>"), [store["width"] for store in entry["offsets"].values()])
                self.assertEqual(fields.split("<br>"), [f'<code>{store["field"]}</code>'
                                                        for store in entry["offsets"].values()])
                self.assertEqual(compare, f'<code>cmp eax, 0x{entry["id"]:x}</code> <a href="routines.html#site-'
                                          f'{int(entry["compare"], 16):08x}"><code>{entry["compare"]}</code></a>')
                for offset, store in entry["offsets"].items():
                    self.assertIn(f"<code>+ {offset}</code>", where)
                    for va in store["sites"]:
                        self.assertIn(f'<a href="routines.html#site-{int(va, 16):08x}"><code>{va}</code></a>', stores)
                    # A derived offset is labelled and given no value.
                    self.assertEqual(f"<code>+ {offset}</code> <span class=\"label\">derived</span>" in where,
                                     bool(store.get("derived")))
                    for va in store.get("conditional", []):
                        self.assertIn(f"routines.html#site-{int(va, 16):08x}", notes)
                self.assertEqual("enum word" in notes, "enum_table" in entry)
                if "enum_table" in entry:
                    self.assertIn(f'<code>{entry["enum_table"]["va"]}</code> (<a href="routines.html#site-'
                                  f'{int(entry["enum_table"]["site"], 16):08x}">', notes)
        torque = ENGINE_FIELD_STORES["TORQUE_ARRAY"]
        cells = re.findall(r"<td>(.*?)</td>", rows["TORQUE_ARRAY"])
        self.assertEqual(cells[1], '<code>+ 0x2c</code> <span class="label">derived</span>, '
                                   '<span class="label">conditional</span>, no value<br><code>+ 0x3c</code>, 18 slots')
        for va in (torque["zero_fill"]["call"], torque["row_count"]["site"]):
            self.assertIn(f"routines.html#site-{int(va, 16):08x}", cells[6])
        self.assertIn("zero-fills all 18 slots at <code>+ 0x3c</code> first", cells[6])
        self.assertIn("row count is read from the <code>MAX_RPM</code> value at <code>+ 0x30</code>", cells[6])
        self.assertIn('<code>+ 0xa4</code> <span class="label">derived</span>, no value',
                      re.findall(r"<td>(.*?)</td>", rows["TURBO_MASS"])[1])
        self.assertIn('<code>:INHERIT_TYPE</code> calls the record copy <a href="routines.html#fr3_copy_engine_record">'
                      '<code>fr3_copy_engine_record</code></a> (<a href="routines.html#site-00522b47">', table)
        self.assertIn('stores the parent\'s address at <code>+ 0x18</code> (<a href="routines.html#site-00522b4c">', table)

    def test_declarations_table_shows_only_the_record_own_declarations(self):
        engines, _ = self.build()
        for name in ("CHILD", "GRANDCHILD"):
            declared = section(engines, "engine", name).split("<h3>Declarations, as written</h3>")[1]
            for value in BASE_VALUES:
                self.assertNotIn(value, declared)
            self.assertNotIn(":TORQUE_ARRAY", declared)
        child = section(engines, "engine", "CHILD").split("<h3>Declarations, as written</h3>")[1]
        self.assertIn('<tr id="engine-CHILD-line-11"><td>11</td><td><code>:CAPACITY</code></td><td><span class="num">1.5'
                      '</span></td>', child)
        grandchild = section(engines, "engine", "GRANDCHILD").split("<h3>Declarations, as written</h3>")[1]
        self.assertIn('<td>14</td><td><code>:MAX_RPM</code></td><td><span class="num">9100</span></td>', grandchild)

    def test_effective_fields_resolve_a_two_level_chain(self):
        engines, _ = self.build()
        grandchild = section(engines, "engine", "GRANDCHILD").split("<h3>Declarations, as written</h3>")[0]
        rows = dict(re.findall(r'<tr(?: id="engine-GRANDCHILD-torque-array")?><td><code>(\w+)</code></td>(.*?)</tr>',
                               grandchild))
        self.assertEqual(grandchild.count('<tr id="engine-GRANDCHILD-torque-array"><td><code>TORQUE_ARRAY</code>'), 1)
        self.assertEqual(set(rows), set(ENGINE_FIELD_STORES))
        # CAPACITY comes from CHILD, one level up; LOCATION_TYPE from BASE, two levels up.
        self.assertIn('<td><span class="num">1.5</span></td><td>inherited</td><td><a href="#engine-CHILD-line-11">CHILD '
                      'line 11</a></td><td><a href="#engine-GRANDCHILD">GRANDCHILD</a> &rarr; <a href="#engine-CHILD">CHILD'
                      '</a></td><td><a href="routines.html#site-00522be0"><code>0x00522be0</code></a></td>',
                      rows["CAPACITY"])
        self.assertIn('<td><span class="num">FRONT</span></td><td>inherited</td><td><a href="#engine-BASE-line-3">BASE line '
                      '3</a></td><td><a href="#engine-GRANDCHILD">GRANDCHILD</a> &rarr; <a href="#engine-CHILD">CHILD</a> '
                      '&rarr; <a href="#engine-BASE">BASE</a></td>', rows["LOCATION_TYPE"])
        self.assertIn('<td><span class="num">9100</span></td><td>declared</td><td><a href="#engine-GRANDCHILD-line-14">'
                      "GRANDCHILD line 14</a></td>", rows["MAX_RPM"])
        # The torque table is BASE's, parsed with BASE's own MAX_RPM, not GRANDCHILD's later one.
        self.assertIn('3 rows &times; 2 columns<br>row count read from <code>+ 0x30</code> (<a href="routines.html#site-'
                      '0052292b"><code>0x0052292b</code></a>) when parsed: <code>MAX_RPM</code> from <a href="#engine-BASE-'
                      'line-4">BASE line 4</a> (declared; path <a href="#engine-BASE">BASE</a>)</td><td>inherited</td>'
                      '<td><a href="#engine-BASE-line-5">BASE line 5</a></td>', rows["TORQUE_ARRAY"])
        self.assertIn('<span class="label">zero-filled</span>, no value</td><td>zero-filled</td><td>none along the path'
                      '</td>', rows["FUEL_CUTOFF"])

    def test_derived_offsets_are_labelled_without_a_value(self):
        engines, _ = self.build()
        child = section(engines, "engine", "CHILD")
        torque = child[child.index("<tr><td><code>+ 0x2c</code> from <code>TORQUE_ARRAY</code>"):]
        torque = torque[:torque.index("</tr>")]
        self.assertIn('<span class="label">derived</span>, <span class="label">conditional</span>: stored only past the '
                      'jumps at <a href="routines.html#site-00522980"><code>0x00522980</code></a>', torque)
        self.assertIn("not computed", torque)
        self.assertIn('possible origins:<ol><li><a href="#engine-BASE-line-5">BASE line 5</a> (inherited; path '
                      '<a href="#engine-CHILD">CHILD</a> &rarr; <a href="#engine-BASE">BASE</a>)</li><li><span '
                      'class="label">zero-filled</span>', torque)
        turbo = child[child.index("<tr><td><code>+ 0xa4</code> from <code>TURBO_MASS</code>"):]
        turbo = turbo[:turbo.index("</tr>")]
        self.assertIn('<span class="label">derived</span>; not computed', turbo)
        self.assertNotIn("conditional", turbo)
        # Every row of the TORQUE_ARRAY table is still shown only on BASE.
        self.assertNotIn("100.5", child)

    def test_untagged_line_is_verbatim_unresolved_and_not_inheritance(self):
        engines, _ = self.build()
        loner = section(engines, "engine", "LONER")
        declared = loner.split("<h3>Declarations, as written</h3>")[1]
        self.assertIn('<td>16</td><td><code>(untagged)</code></td><td><code>INHERIT_TYPE BASE</code> kept verbatim, '
                      'not applied <div class="unresolved"><span class="label">unresolved</span>', declared)
        self.assertIn("whether the game honours it is not established", declared)
        self.assertNotIn("href=", declared)
        self.assertNotIn(":INHERIT_TYPE", declared)
        self.assertNotIn("Effective fields", loner)
        self.assertNotIn("href=", summary_row(engines, "engine", "LONER").split("</td>", 1)[1])
        self.assertIn('<span class="num">2.25</span>', loner)

    def test_colon_less_line_lists_both_readings_without_choosing(self):
        engines, _ = self.build()
        loner = section(engines, "engine", "LONER").split("<h3>Declarations, as written</h3>")[0]
        self.assertIn('<div class="unresolved"><p><span class="label">unresolved</span>: LONER is a root as parsed, because '
                      "line 16, <code>INHERIT_TYPE BASE</code>, has no colon. The 19 mapped tags it does not declare "
                      'depend on that line: zero-filled if the game ignores it, or <a href="#engine-BASE">BASE</a>\'s '
                      "effective value if the game applies it as inheritance. Neither reading is chosen here.</p>", loner)
        self.assertIn('<tr><td><code>MAX_RPM</code></td><td><span class="label">zero-filled</span></td><td><span class="num">'
                      '6500</span>, <a href="#engine-BASE-line-4">BASE line 4</a>, path <a href="#engine-LONER">LONER</a> '
                      '&rarr; <a href="#engine-BASE">BASE</a></td></tr>', loner)
        self.assertNotIn("<code>CAPACITY</code>", loner)
        # LONER is not the demo's INDIGO, so there is no open question to link.
        self.assertNotIn("questions.html", loner)

    def test_multi_row_fields_render_as_row_tables_with_dimensions(self):
        engines, _ = self.build()
        base = section(engines, "engine", "BASE")
        self.assertIn('<td>5</td><td><code>:TORQUE_ARRAY</code></td><td>3 rows &times; 2 columns<table class="rows">'
                      '<tr><td class="num">0</td><td class="num">100.5</td></tr>', base)
        self.assertIn("<td>3 &times; 2</td>", summary_row(engines, "engine", "BASE"))
        self.assertIn("units and physics of the values, including the torque arrays, are not established", engines)

    def test_declarations_are_sorted_by_line(self):
        engines, _ = self.build()
        lines = [int(line) for line in re.findall(r"<tr[^>]*><td>(\d+)</td><td><code>", section(engines, "engine", "BASE"))]
        self.assertEqual(lines, [2, 3, 4, 5])

    def test_summary_lists_records_in_file_order_with_parents(self):
        engines, gearboxes = self.build()
        summary = engines[engines.index("<h2>Summary</h2>"):engines.index('<section class="record"')]
        self.assertEqual(re.findall(r'<tr><td><a href="#engine-(\w+)">', summary), ENGINE_NAMES)
        self.assertIn("<th>Parent</th>", summary)
        self.assertIn('<td>9</td><td><a href="#engine-BASE">BASE</a></td>', summary_row(engines, "engine", "CHILD"))
        self.assertIn('<td>12</td><td><a href="#engine-CHILD">CHILD</a></td>', summary_row(engines, "engine", "GRANDCHILD"))
        self.assertIn("<td>1</td><td></td><td>3 &times; 2</td>", summary_row(engines, "engine", "BASE"))
        gear_summary = gearboxes[gearboxes.index("<h2>Summary</h2>"):gearboxes.index('<section class="record"')]
        self.assertEqual(re.findall(r'<tr><td><a href="#gearbox-(\w+)">', gear_summary), ["ROAD_OLD", "TRACK"])
        self.assertNotIn("Parent", gear_summary)
        self.assertNotIn("TORQUE_ARRAY", gear_summary)

    def test_header_identity(self):
        for page, text, source, count in zip(self.build(), (ENGINES, GEARBOXES), ("ENGDATA.DAT", "GEARDATA.DAT"),
                                             (4, 2), strict=True):
            with self.subTest(source=source):
                header = page[:page.index("<h2>")]
                self.assertIn(PE["sha256"], header)
                self.assertIn(PE["timestamp_header_utc"], header)
                self.assertIn(f"<code>DATA/ASCII/CARS/{source}</code> SHA-256 "
                              f"<code>{hashlib.sha256(text.encode()).hexdigest()}</code>", header)
                self.assertIn("<code>0123abcd</code>", header)
                self.assertIn(f"<dt>Records</dt><dd>{count}</dd>", header)
                self.assertIn('<p class="scope">', header)
        engines, gearboxes = self.build()
        self.assertIn("Gearbox inheritance (<code>:INHERIT_TYPE</code>) is unresolved", gearboxes)
        self.assertIn("A shared parent does not make two engines behave identically", engines)
        self.assertIn("The meaning, units and physics of the values, including the torque arrays, are not established",
                      engines)
        self.assertNotIn("no parent value is copied", engines)
        scope = engines[engines.index('<p class="scope">'):]
        self.assertNotIn("unresolved", scope[:scope.index("</p>")])

    def test_nav_bar(self):
        engines, gearboxes = self.build()
        self.assertIn('<nav>Research: <strong>Engines</strong> | <a href="gearboxes.html">Gearboxes</a> | <a href="compare.html">Compare records</a> | '
                      '<a href="tyres.html">Tyres</a> | <a href="pcg.html">PCG catalogue</a> | '
                      '<a href="routines.html">Routines</a> | '
                      '<a href="questions.html">Open questions</a></nav>', engines)
        self.assertIn('<nav>Research: <a href="engines.html">Engines</a> | <strong>Gearboxes</strong> | <a href="compare.html">Compare records</a> | '
                      '<a href="tyres.html">Tyres</a> | <a href="pcg.html">PCG catalogue</a> | '
                      '<a href="routines.html">Routines</a> | '
                      '<a href="questions.html">Open questions</a></nav>', gearboxes)

    def test_no_scripts_or_remote_resources(self):
        for page in self.build():
            self.assertNotIn("<script", page.lower())
            self.assertNotRegex(page.replace(rights_notice(), ""), r"https?://")

    def test_rights_notice_comes_before_the_main_content(self):
        for page in self.build():
            self.assertEqual(page.count(rights_notice()), 1)
            self.assertLess(page.index(rights_notice()), page.index("<h1>"))

    def test_input_text_is_escaped(self):
        engines = json.loads(json.dumps(engines_json()).replace("BASE", 'A<&\\"B').replace("FRONT", 'x<&\\"y'))
        engines["records"][3]["untagged"][0]["tokens"].append("<b>")
        engines["source"] = "<i>ENG</i>"
        page, _ = self.build(with_engine_fields(engines))
        for raw in ('A<&"B', 'x<&"y', "<b>", "<i>"):
            self.assertNotIn(raw, page)
        self.assertIn('id="engine-A&lt;&amp;&quot;B"', page)
        self.assertIn('href="#engine-A&lt;&amp;&quot;B"', page)
        self.assertIn("x&lt;&amp;&quot;y", page)
        self.assertIn("<code>INHERIT_TYPE A&lt;&amp;&quot;B &lt;b&gt;</code>", page)
        self.assertIn("&lt;i&gt;ENG&lt;/i&gt;", page)


class RecordDossierRejectTests(RecordDossierTestCase):
    def mutate(self, path, value, which="engines"):
        data = engines_json() if which == "engines" else gearboxes_json()
        target = data
        for key in path[:-1]:
            target = target[key]
        if value is KeyError:
            del target[path[-1]]
        else:
            target[path[-1]] = value
        return {which: data}

    def test_malformed_containers(self):
        cases = [
            (("records",), {}, "engines.json.records has the wrong type"),
            (("records",), [], "engines.json has no records"),
            (("source",), KeyError, "engines.json has no 'source'"),
            (("sha256",), None, "engines.json.sha256 has the wrong type"),
            (("records", 0), [], "engines.json.records[0] must be an object"),
            (("records", 0, "type"), KeyError, "records[0] has no 'type'"),
            (("records", 0, "line"), KeyError, "records[0] has no 'line'"),
            (("records", 0, "line"), "1", "records[0].line has the wrong type"),
            (("records", 0, "fields"), KeyError, "records[0] has no 'fields'"),
            (("records", 0, "fields"), [], "records[0].fields has the wrong type"),
            (("records", 0, "fields", "CAPACITY"), [], "fields.CAPACITY must be an object"),
            (("records", 0, "fields", "CAPACITY", "values"), [{}], "fields.CAPACITY.values must be scalars"),
            (("records", 0, "fields", "TORQUE_ARRAY", "rows"), [[0, 1], [2]], "TORQUE_ARRAY.rows differ in column count"),
            (("records", 0, "fields", "TORQUE_ARRAY", "rows"), [[]], "TORQUE_ARRAY.rows must be non-empty lists"),
            (("records", 1, "fields", "INHERIT_TYPE", "values"), ["BASE", "X"], "INHERIT_TYPE.values must name one parent"),
            (("records", 3, "untagged"), {}, "records[3].untagged must be a list"),
            (("records", 3, "untagged", 0, "tokens"), [1], "untagged[0].tokens must be strings"),
        ]
        for path, value, message in cases:
            with self.subTest(path=path, value=value):
                self.reject(message, **self.mutate(path, value))
        self.reject("engines.json must be an object", engines=[])

    def test_malformed_gearboxes_block_both_pages(self):
        self.reject("gearboxes.json.records[1] has no 'type'", **self.mutate(("records", 1, "type"), KeyError, "gearboxes"))

    def test_inherit_type_must_name_an_earlier_record(self):
        for parent in ("GRANDCHILD", "CHILD", "NOWHERE"):
            with self.subTest(parent=parent):
                engines = engines_json()
                engines["records"][1]["fields"]["INHERIT_TYPE"]["values"] = [parent]
                self.reject(f"engines.json: 'CHILD' inherits {parent!r}, which is not an earlier record", engines)

    def test_inherit_type_must_stay_within_the_file(self):
        gearboxes = gearboxes_json()
        gearboxes["records"][1]["fields"]["INHERIT_TYPE"] = {"line": 5, "values": ["BASE"], "rows": []}
        self.reject("gearboxes.json: 'TRACK' inherits 'BASE', which is not an earlier record", gearboxes=gearboxes)

    def test_duplicate_record_names(self):
        engines = engines_json()
        engines["records"][2]["type"] = "BASE"
        self.reject("engines.json has duplicate record name 'BASE'", engines)

    def test_effective_fields_must_match_the_records(self):
        engines = engines_json()
        del engines["effective_fields"]
        self.reject("engines.json has no 'effective_fields'", engines)
        engines = engines_json()
        engines["effective_fields"]["GRANDCHILD"]["fields"]["CAPACITY"]["values"] = [777.25]
        self.reject("engines.json effective_fields disagrees with the record declarations", engines)
        engines = engines_json()
        engines["untagged_inherit_consequences"] = {}
        self.reject("engines.json untagged_inherit_consequences disagrees with the record declarations", engines)
        # A rebuilt engines.json from edited records is accepted only with matching effective fields.
        stale = engines_json()
        stale["records"][2]["fields"]["MAX_RPM"]["values"] = [1]
        self.reject("engines.json effective_fields disagrees", stale)
        self.build(with_engine_fields(stale))

    def test_linked_sites_must_be_byte_checked(self):
        # The engine table's dispatch compare, enum word table and parent store are linked sites too.
        for va in (0x00522b47, 0x005229b6, 0x00522be0, 0x00523289, 0x005232c1, 0x005233c3, 0x00523364, 0x00523399,
                   0x00523339, 0x00522b54, 0x00522bb9, 0x00522b4c):
            with self.subTest(va=hex(va)):
                self.reject(f"These linked sites are not in field-evidence.json: 0x{va:08x}",
                            evidence=[site for site in EVIDENCE if site["va"] != va])
        self.reject("field-evidence.json must be a list of sites", evidence={})

    def test_pe_metadata_without_sha256(self):
        for pe in ({k: v for k, v in PE.items() if k != "sha256"}, {**PE, "sha256": ""}, []):
            with self.subTest(pe=type(pe).__name__):
                self.reject("PE metadata has no sha256", pe=pe)

    def test_routine_missing_from_status_json(self):
        for prefix, roles in ROUTINES.items():
            for role, (entry_va, _) in roles.items():
                with self.subTest(prefix=prefix, role=role):
                    self.reject(f"status.json has no routine at entry VA 0x{entry_va}, the {prefix} {role} routine "
                                "this page links to", status=status_with(entry_va))

    def test_routine_renamed_in_status_json(self):
        for prefix, roles in ROUTINES.items():
            for role, (entry_va, label) in roles.items():
                with self.subTest(prefix=prefix, role=role):
                    self.reject(f"status.json labels entry VA 0x{entry_va}, the {prefix} {role} routine this page "
                                f"links to, 'fr3_renamed', not '{label}'", status=status_with(entry_va, "fr3_renamed"))

    def test_malformed_status_json(self):
        self.reject("status.json must be a non-empty list", status=[])
        status = copy.deepcopy(STATUS)
        status[1]["label"] = status[0]["label"]
        self.reject(f"status.json lists label {status[0]['label']!r} twice", status=status)

    def test_missing_input(self):
        with self.assertRaises(ValueError) as caught:
            record_dossier.build(self.root / "absent.json", self.write("gearboxes.json", gearboxes_json()),
                                 REPO_ROOT / "analysis/pe-metadata.json", self.output)
        self.assertIn("run scripts/text_database.py first", str(caught.exception))
        self.assertFalse(self.output.exists())


class RecordDossierCommandTests(RecordDossierTestCase):
    SCRIPT = REPO_ROOT / "scripts/record_dossier.py"

    def run_script(self, engines, gearboxes=None, env=None, extra=()):
        gearboxes = gearboxes_json() if gearboxes is None else gearboxes
        engines_path = self.write("engines.json", engines) if not isinstance(engines, Path) else engines
        return subprocess.run([sys.executable, str(self.SCRIPT), "--engines", str(engines_path),
                               "--gearboxes", str(self.write("gearboxes.json", gearboxes)),
                               "--output-dir", str(self.output), *extra], capture_output=True, text=True, check=False,
                              env=env)

    def test_cli_refuses_a_missing_linked_routine(self):
        result = self.run_script(engines_json(), extra=("--status", str(self.write("status.json",
                                                                                   status_with("00523470")))))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("record_dossier.py: status.json has no routine at entry VA 0x00523470", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        for page in self.pages:
            self.assertFalse(page.exists())

    def test_cli_writes_both_pages(self):
        result = self.run_script(engines_json())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Wrote 4 engine and 2 gearbox records", result.stdout)
        self.assertIn('id="engine-LONER"', self.pages[0].read_text(encoding="utf-8"))
        self.assertIn('id="gearbox-TRACK"', self.pages[1].read_text(encoding="utf-8"))

    def test_cli_uses_utf8_even_with_an_ascii_locale(self):
        engines = engines_json()
        engines["source"] = "Veri/Türkçe.DAT"
        result = self.run_script(engines, env={**os.environ, "LC_ALL": "C", "PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Veri/Türkçe.DAT", self.pages[0].read_bytes().decode("utf-8"))

    def test_cli_fails_loudly_without_writing(self):
        engines = engines_json()
        engines["records"][1]["fields"]["INHERIT_TYPE"]["values"] = ["LONER"]
        for bad in (engines, self.write("broken.json", "{not json")):
            with self.subTest(bad=type(bad).__name__):
                result = self.run_script(bad)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("record_dossier.py: ", result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                for page in self.pages:
                    self.assertFalse(page.exists())

    def test_help_documents_flags_and_defaults(self):
        result = subprocess.run([sys.executable, str(self.SCRIPT), "--help"], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0)
        text = " ".join(result.stdout.split()).replace("- ", "-")
        for flag in ("--engines", "--gearboxes", "--pe", "--evidence", "--status", "--output-dir"):
            self.assertIn(flag, text)
        for default in ("artifacts/text-databases/engines.json", "artifacts/text-databases/gearboxes.json",
                        "pe-metadata.json", "analysis/selected/field-evidence.json", "analysis/annotated/status.json",
                        "artifacts/dossier"):
            self.assertRegex(text, rf"default: [^)]*{re.escape(default)}\)")


if __name__ == "__main__":
    unittest.main()
