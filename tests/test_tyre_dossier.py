"""Synthetic tyre dossier tests; these use no game data."""
import copy
import hashlib
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
import tyre_dossier
from text_database import (REPO_ROOT, RESOLVED_TYRE_TABLES, TYRE_SCALAR_STORES, TYRE_TABLE_ACCESSORS, TYRE_TABLES, parse,
                           ZERO_FILLED, effective_scalars, resolve_tyre_tables, tyre_table_provenance)

TAGS = {"INHERIT_TYPE", "RADIUS", "WIDTH", "LOCATION_TYPE", "SOUND_INFO", "START_RPM", *TYRE_TABLES}
# ROOT declares every table, MID overrides VERTICAL_LOAD, CHILD declares a scalar on each side of INHERIT_TYPE
# (so the copy overwrites its RADIUS with the one MID inherits from ROOT) and an unmapped LOCATION_TYPE.
TYRES = """:TYPE ROOT
:RADIUS 777.25
:LOCATION_TYPE FRONT
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
:TYPE MID
:INHERIT_TYPE ROOT
:WIDTH 0.25
:VERTICAL_LOAD
0 2.0
:TYPE CHILD
:RADIUS 0.5
:INHERIT_TYPE MID
:WIDTH 0.125
:LOCATION_TYPE REAR
:END
"""
NAMES = ["ROOT", "MID", "CHILD"]
EVIDENCE = json.loads((REPO_ROOT / "analysis/selected/field-evidence.json").read_text())
PE = json.loads((REPO_ROOT / "analysis/pe-metadata.json").read_text())
# The byte-checked sites inside each accessor and the loader sites for each table, by address.
ACCESSOR_SITES = {"LONGITUDINAL_COMBINED_VALUES": [0x00523e92, 0x00523ea0],
                  "LATERAL_COMBINED_VALUES": [0x00523eb2, 0x00523ec0],
                  "VERTICAL_LOAD": [0x00523e52, 0x00523e60],
                  "CAMBER_THRUST": [0x00523e72, 0x00523e80],
                  "sound_info": [0x00523f10, 0x00523f1c, 0x00523f27]}
LOADER_SITES = {"LONGITUDINAL_COMBINED_VALUES": [0x00523be2, 0x00523bfb],
                "LATERAL_COMBINED_VALUES": [0x00523b60, 0x00523b7d],
                "VERTICAL_LOAD": [0x005239a9], "CAMBER_THRUST": [0x00523ce6],
                "sound_info": [0x00523a67, 0x00523a89]}
# Each site row's VA links its own row on the routines page.
SITE_ROW = re.compile(r'<tr><td>(accessor|loader)</td><td><a href="routines\.html#site-([0-9a-f]{8})"><code>0x\2</code>'
                      r"</a></td><td><code>([0-9a-f]+)</code></td><td>(.*?)</td></tr>")
STATUS = json.loads((REPO_ROOT / "analysis/annotated/status.json").read_text())
# The routine each table's accessor is, by its status.json label.
ACCESSOR_LABELS = {"LONGITUDINAL_COMBINED_VALUES": "fr3_get_tyre_longitudinal_table",
                   "LATERAL_COMBINED_VALUES": "fr3_get_tyre_lateral_table",
                   "VERTICAL_LOAD": "fr3_get_tyre_vertical_load", "CAMBER_THRUST": "fr3_get_tyre_camber_thrust",
                   "sound_info": "fr3_get_tyre_sound_info"}


def status_with(entry_va, label=None):
    """The committed status.json with the routine at entry_va relabelled, or removed when label is None."""
    status = copy.deepcopy(STATUS)
    if label is None:
        return [item for item in status if item["entry_va"] != entry_va]
    for item in status:
        if item["entry_va"] == entry_va:
            item["label"] = label
    return status


def tyres_json(text=TYRES):
    records = parse(text, TAGS, sound_info=True)
    return {"source": "DATA/ASCII/CARS/TYREDATA.DAT", "sha256": hashlib.sha256(text.encode()).hexdigest(),
            "records": records, "resolved_tables": resolve_tyre_tables(records),
            "table_provenance": tyre_table_provenance(records), "effective_scalars": effective_scalars(records)}


def section(page, name):
    start = page.index(f'<section class="tyre" id="tyre-{name}">')
    return page[start:page.index("</section>", start)]


def why(page, name, table):
    body = section(page, name)
    start = body.index(f"<summary>Why does {name} read {tyre_dossier.TABLE_LABELS[table]} from ")
    return body[start:body.index("</details>", start)]


class DossierTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.output = self.root / "dossier/tyres.html"

    def write(self, name, data):
        path = self.root / name
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path

    def build(self, tyres=None, evidence=EVIDENCE, pe=PE, status=STATUS):
        tyres = tyres_json() if tyres is None else tyres
        tyre_dossier.build(self.write("tyres.json", tyres), self.write("evidence.json", evidence),
                           self.write("pe.json", pe), self.output, revision="0123abcd",
                           status_path=self.write("status.json", status))
        return self.output.read_text(encoding="utf-8")

    def reject(self, fragment, tyres=None, evidence=EVIDENCE, status=STATUS):
        with self.assertRaises(ValueError) as caught:
            self.build(tyres, evidence, status=status)
        self.assertIn(fragment, str(caught.exception))
        self.assertFalse(self.output.exists())


class DossierPageTests(DossierTestCase):
    def test_anchors_and_links(self):
        page = self.build()
        ids = re.findall(r'id="([^"]+)"', page)
        self.assertEqual(len(ids), len(set(ids)))
        for name in NAMES:
            self.assertIn(f"tyre-{name}", ids)
            for table in RESOLVED_TYRE_TABLES:
                self.assertIn(f"tyre-{name}-{table}", ids)
        links = re.findall(r'href="#([^"]+)"', page)
        self.assertTrue(links)
        self.assertEqual([link for link in links if link not in ids], [])

    def test_sources_and_path_hops_link_to_their_records(self):
        child = section(self.build(), "CHILD")
        row = child[child.index('<tr id="tyre-CHILD-LONGITUDINAL_COMBINED_VALUES">'):]
        row = row[:row.index("</tr>")]
        self.assertEqual(re.findall(r'href="#([^"]+)"', row),
                         ["tyre-ROOT-LONGITUDINAL_COMBINED_VALUES", "tyre-CHILD-LONGITUDINAL_COMBINED_VALUES",
                          "tyre-MID-LONGITUDINAL_COMBINED_VALUES", "tyre-ROOT-LONGITUDINAL_COMBINED_VALUES"])
        row = child[child.index('<tr id="tyre-CHILD-VERTICAL_LOAD">'):]
        self.assertIn('href="#tyre-MID-VERTICAL_LOAD">MID</a></td>', row[:row.index("</tr>")])

    def test_summary_lists_records_in_file_order_with_sources(self):
        page = self.build()
        summary = page[page.index("<h2>Summary</h2>"):page.index('<section class="tyre"')]
        rows = re.findall(r"<tr><td><a href=\"#tyre-(\w+)\">\w+</a></td>(.*?)</tr>", summary)
        self.assertEqual([name for name, _ in rows], NAMES)
        self.assertEqual(re.findall(r'href="#tyre-(\w+)"', dict(rows)["CHILD"]),
                         ["ROOT", "ROOT", "MID", "ROOT", "ROOT"])

    def test_why_trail_lists_exactly_the_sites_of_each_accessor(self):
        page = self.build()
        by_va = {site["va"]: site for site in EVIDENCE}
        for table in RESOLVED_TYRE_TABLES:
            with self.subTest(table=table):
                rows = SITE_ROW.findall(why(page, "CHILD", table))
                self.assertEqual([int(va, 16) for role, va, _, _ in rows if role == "accessor"], ACCESSOR_SITES[table])
                self.assertEqual([int(va, 16) for role, va, _, _ in rows if role == "loader"], LOADER_SITES[table])
                for _, va, raw, claim in rows:
                    self.assertEqual((raw, claim), (by_va[int(va, 16)]["bytes"], by_va[int(va, 16)]["claim"]))
                claim_table = "SOUND_INFO" if table == "sound_info" else table
                self.assertTrue(all(claim.startswith(claim_table + " accessor")
                                    for role, _, _, claim in rows if role == "accessor"))

    def test_why_trail_follows_the_inheritance_path(self):
        trail = why(self.build(), "CHILD", "CAMBER_THRUST")
        self.assertIn("<code>:INHERIT_TYPE</code> on line 25 names", trail)
        self.assertIn("<code>:INHERIT_TYPE</code> on line 19 names", trail)
        self.assertIn('ROOT</a> declares CAMBER_THRUST on line 10.', trail)
        self.assertIn("<code>0x00523e70</code>", trail)
        self.assertIn(PE["sha256"], trail)

    def test_why_trail_links_its_accessor_and_sites_to_the_routines_page(self):
        page = self.build()
        labels = {item["label"] for item in STATUS}
        evidence = {site["va"] for site in EVIDENCE}
        for name in NAMES:
            for table in RESOLVED_TYRE_TABLES:
                with self.subTest(name=name, table=table):
                    trail = why(page, name, table)
                    accessor = TYRE_TABLE_ACCESSORS[table]["accessor"]
                    self.assertIn(f'The accessor at <a href="routines.html#{ACCESSOR_LABELS[table]}"><code>{accessor}'
                                  "</code></a> returns", trail)
                    rows = SITE_ROW.findall(trail)
                    self.assertTrue(rows)
                    self.assertTrue({int(va, 16) for _, va, _, _ in rows} <= evidence)
                    # Every routines-page link in the trail is a site row or a status.json label.
                    for fragment in re.findall(r'href="routines\.html#([^"]+)"', trail):
                        self.assertTrue(fragment in labels or re.fullmatch(r"site-[0-9a-f]{8}", fragment), fragment)

    def test_loaded_by_and_scalar_copy_link_their_routines(self):
        page = self.build()
        header = page[:page.index("<h2>")]
        self.assertIn('<dt>Loaded by</dt><dd><a href="routines.html#fr3_load_tyre_database">'
                      "<code>fr3_load_tyre_database</code></a> (<code>0x00523820</code>); on the routines page.", header)
        scalars = section(page, "CHILD")[section(page, "CHILD").index("<h3>Scalar fields</h3>"):]
        self.assertIn('it calls the scalar copy at <a href="routines.html#fr3_copy_tyre_scalar_fields"><code>0x00524090'
                      '</code></a> (<a href="routines.html#site-00523b3a"><code>0x00523b3a</code></a>)', scalars)

    def test_accessor_labels_come_from_status_json(self):
        page = self.build(status=status_with("00523e70", "fr3_relabelled_accessor"))
        trail = why(page, "CHILD", "CAMBER_THRUST")
        self.assertIn('<a href="routines.html#fr3_relabelled_accessor"><code>0x00523e70</code></a>', trail)
        self.assertNotIn("fr3_get_tyre_camber_thrust", page)

    def test_matching_uses_addresses_not_claim_text(self):
        evidence = [{**site, "claim": f"reworded {index}"} for index, site in enumerate(EVIDENCE)]
        rows = SITE_ROW.findall(why(self.build(evidence=evidence), "CHILD", "VERTICAL_LOAD"))
        self.assertEqual([int(va, 16) for role, va, _, _ in rows if role == "accessor"], ACCESSOR_SITES["VERTICAL_LOAD"])

    def scalar_rows(self, page, name):
        body = section(page, name)
        table = body[body.index("<h3>Scalar fields</h3>"):]
        table = table[:table.index("</table>")]
        return {match[1]: match[0] for match in re.finditer(r"<tr><td><code>(\w+)</code>.*?</tr>", table)}

    def test_scalar_fields_show_each_effective_declaration_and_its_source(self):
        page = self.build()
        self.assertNotIn("Scalar fields", section(page, "ROOT"))
        rows = self.scalar_rows(page, "CHILD")
        self.assertEqual(list(rows), list(TYRE_SCALAR_STORES))
        # CHILD's own RADIUS (line 24) comes before INHERIT_TYPE, so the copy replaces it with ROOT's via MID.
        self.assertIn('<td><span class="num">777.25</span></td><td>inherited</td><td><a href="#tyre-ROOT-line-2">ROOT '
                      'line 2</a></td><td><a href="#tyre-CHILD">CHILD</a> &rarr; <a href="#tyre-MID">MID</a> &rarr; '
                      '<a href="#tyre-ROOT">ROOT</a></td>', rows["RADIUS"])
        self.assertIn("<td><code>+ 0x28</code>, <code>+ 0x3c</code></td>", rows["RADIUS"])
        self.assertIn('<td><span class="num">0.125</span></td><td>declared</td><td><a href="#tyre-CHILD-line-26">CHILD '
                      'line 26</a></td><td><a href="#tyre-CHILD">CHILD</a></td>', rows["WIDTH"])
        self.assertIn('<tr id="tyre-ROOT-line-2"><td>2</td><td><code>:RADIUS</code></td>', page)
        self.assertIn('<tr id="tyre-CHILD-line-26"><td>26</td><td><code>:WIDTH</code></td>', page)
        child = section(page, "CHILD")
        self.assertIn("overwritten by the copy: <code>RADIUS</code> (line 24).", child)
        self.assertIn("is on line 25", child)
        mid = self.scalar_rows(page, "MID")
        self.assertIn('<a href="#tyre-ROOT-line-2">ROOT line 2</a>', mid["RADIUS"])

    def test_zero_filled_and_unmapped_fields_get_no_value(self):
        page = self.build()
        rows = self.scalar_rows(page, "CHILD")
        for tag in set(TYRE_SCALAR_STORES) - {"RADIUS", "WIDTH"}:
            with self.subTest(tag=tag):
                self.assertIn(f'<td><span class="label">{ZERO_FILLED}</span></td><td>{ZERO_FILLED}</td>'
                              "<td>none along the path</td>", rows[tag])
                self.assertNotIn('class="num"', rows[tag])
        child = section(page, "CHILD")
        self.assertIn('<div class="unresolved"><p><span class="label">unmapped</span>: no byte-checked store is known '
                      "for <code>LOCATION_TYPE</code> (line 27), so no effective value is given.</p></div>", child)
        self.assertNotIn("LOCATION_TYPE", self.scalar_rows(page, "CHILD"))

    def test_scalar_rows_link_their_store_and_copy_sites(self):
        page = self.build()
        evidence = {site["va"]: site["bytes"] for site in EVIDENCE}
        for tag, row in self.scalar_rows(page, "CHILD").items():
            with self.subTest(tag=tag):
                cells = re.findall(r"<td>(.*?)</td>", row)
                stores = [int(va, 16) for va in re.findall(r"site-([0-9a-f]{8})", cells[-2])]
                copies = [int(va, 16) for va in re.findall(r"site-([0-9a-f]{8})", cells[-1])]
                self.assertTrue(set(stores + copies) <= set(evidence))
                offsets = [int(offset, 16) for offset in TYRE_SCALAR_STORES[tag]["offsets"]]
                self.assertEqual(sorted(evidence[va] for va in copies),
                                 sorted([f"8948{offset:02x}" for offset in offsets]
                                        + [f"8b4a{offset:02x}" for offset in offsets]))
                self.assertTrue(all(evidence[va].startswith(("d9", "d8")) for va in stores))
        self.assertIn("(scaled by the float at <code>0x00597484</code> when stored)",
                      self.scalar_rows(page, "CHILD")["ROAD_MAGIC_GRIP_NUMBER"])

    def test_store_table_links_each_tag_to_its_byte_checked_sites(self):
        page = self.build()
        table = page[page.index('<h2 id="field-stores">'):page.index("<h2>Summary</h2>")]
        rows = dict(re.findall(r'<tr id="tyre-store-(\w+)">(.*?)</tr>', table))
        # One row per mapped tag, in payload order of its lowest offset.
        self.assertEqual(list(rows), tyre_dossier.tyre_tags())
        self.assertEqual(sorted(rows), sorted(TYRE_SCALAR_STORES))
        lowest = [min(int(offset, 16) for offset in TYRE_SCALAR_STORES[tag]["offsets"]) for tag in rows]
        self.assertEqual(lowest, sorted(lowest))
        self.assertEqual((lowest[0], lowest[-1]), (0x18, 0x40))
        evidence = {site["va"]: site["bytes"] for site in EVIDENCE}
        copies = tyre_dossier.copy_sites(EVIDENCE)
        for tag, entry in TYRE_SCALAR_STORES.items():
            with self.subTest(tag=tag):
                cells = re.findall(r"<td>(.*?)</td>", rows[tag])
                self.assertEqual(cells[0], f"<code>{tag}</code>")
                offsets, stores, scale, copied = cells[1:]
                self.assertEqual(offsets, "<br>".join(f"<code>+ {offset}</code>" for offset in entry["offsets"]))
                self.assertEqual(stores, "<br>".join(
                    f"<code>+ {offset}</code>: " + ", ".join(
                        f'<a href="routines.html#site-{int(va, 16):08x}"><code>{va}</code></a>' for va in sites)
                    for offset, sites in entry["offsets"].items()))
                if "scaled_by" in entry:
                    sites = entry["scale_sites"]
                    self.assertEqual(scale, f'stored, multiplied in place by the float at <code>{entry["scaled_by"]}'
                                            f'</code> and stored again: load <a href="routines.html#site-'
                                            f'{int(sites["load"], 16):08x}"><code>{sites["load"]}</code></a>, multiply '
                                            f'<a href="routines.html#site-{int(sites["multiply"], 16):08x}"><code>'
                                            f'{sites["multiply"]}</code></a>')
                else:
                    self.assertEqual(scale, "none")
                for offset in entry["offsets"]:
                    pair = copies[offset]
                    self.assertEqual(sorted(evidence[va] for va in pair),
                                     sorted([f"8948{offset[2:]}", f"8b4a{offset[2:]}"]))
                    self.assertIn(f"<code>+ {offset}</code>: " + ", ".join(
                        f'<a href="routines.html#site-{va:08x}"><code>0x{va:08x}</code></a>' for va in pair), copied)
                # Every site the row links is byte-checked, so the routines page anchors it.
                linked = {int(va, 16) for va in re.findall(r"site-([0-9a-f]{8})", rows[tag])}
                self.assertTrue(linked)
                self.assertTrue(linked <= set(evidence))
        self.assertIn('The loader <a href="routines.html#fr3_load_tyre_database"><code>fr3_load_tyre_database</code></a> '
                      "stores each scalar tag below as a float", table)
        self.assertIn('the scalar copy at <a href="routines.html#fr3_copy_tyre_scalar_fields"><code>0x00524090</code></a> '
                      '(called for <code>:INHERIT_TYPE</code> at <a href="routines.html#site-00523b3a">', table)
        self.assertIn("The scale global's runtime value is not shown or applied.", table)

    def test_declarations_as_written(self):
        root = section(self.build(), "ROOT")
        self.assertIn('<td>2</td><td><code>:RADIUS</code></td><td><span class="num">777.25</span></td>', root)
        self.assertIn("type <code>TYRE_SAMPLE_TYPE_SQUEAK</code>, 2 values, START_RPM", root)
        self.assertIn('<td>4</td><td><code>:LONGITUDINAL_COMBINED_VALUES</code></td><td>1 rows &times; 2 columns', root)
        mid = section(self.build(), "MID")
        self.assertIn('<code>:INHERIT_TYPE</code></td><td>parent <a href="#tyre-ROOT">ROOT</a>', mid)

    def test_header_identity(self):
        page = self.build()
        header = page[:page.index("<h2>")]
        self.assertIn(PE["sha256"], header)
        self.assertIn(PE["timestamp_header_utc"], header)
        self.assertIn(hashlib.sha256(TYRES.encode()).hexdigest(), header)
        self.assertIn("<code>0123abcd</code>", header)
        self.assertIn("<dt>Records</dt><dd>3</dd>", header)
        self.assertIn("unresolved", header)

    def test_no_scripts_or_remote_resources(self):
        page = self.build()
        self.assertNotIn("<script", page.lower())
        self.assertNotRegex(page.replace(rights_notice(), ""), r"https?://")

    def test_rights_notice_comes_before_the_main_content(self):
        page = self.build()
        self.assertEqual(page.count(rights_notice()), 1)
        self.assertLess(page.index(rights_notice()), page.index("<h1>"))

    def test_repository_links_resolve_from_the_output(self):
        page = self.build()
        targets = {target for target in re.findall(r'href="([^"#][^"]*)"', page)
                   if not target.startswith("routines.html#")} - {"cars.html", "engines.html", "gearboxes.html", "compare.html", "pcg.html",
                                                                   "routines.html", "questions.html",
                                                                   "questions.html#sound-words", *NOTICE_LINKS}
        self.assertEqual({Path(os.path.normpath(self.output.parent / target)) for target in targets},
                         {tyre_dossier.ACCESSORS_ASM, tyre_dossier.LOADER_ASM, (self.root / "evidence.json").resolve()})
        self.assertIn('evidence.json</a>).</p>', page)

    def test_nav_bar_links_the_sibling_dossiers(self):
        self.assertIn('<nav>Research: <a href="cars.html">Cars</a> | <a href="engines.html">Engines</a> | <a href="gearboxes.html">Gearboxes</a> | <a href="compare.html">Compare records</a> | '
                      '<strong>Tyres</strong> | <a href="pcg.html">PCG catalogue</a> | <a href="routines.html">Routines</a> | '
                      '<a href="questions.html">Open questions</a></nav>', self.build())

    def test_input_text_is_escaped(self):
        text = TYRES.replace("CHILD", "EVILNAME").replace("FRONT", "EVILVALUE")
        tyres = json.loads(json.dumps(tyres_json(text)).replace("EVILNAME", 'A<&\\"B').replace("EVILVALUE", 'x<&\\"y'))
        page = self.build(tyres)
        self.assertNotIn('A<&"B', page)
        self.assertNotIn('x<&"y', page)
        self.assertIn('id="tyre-A&lt;&amp;&quot;B"', page)
        self.assertIn('href="#tyre-A&lt;&amp;&quot;B-VERTICAL_LOAD"', page)
        self.assertIn("x&lt;&amp;&quot;y", page)


class DossierRejectTests(DossierTestCase):
    def test_missing_loader_store_even_with_allocation_evidence(self):
        for table, addresses in LOADER_SITES.items():
            with self.subTest(table=table):
                evidence = [site for site in EVIDENCE if site["va"] != addresses[-1]]
                self.reject(f"No byte-checked loader store in field-evidence.json shows the {table} table", evidence=evidence)

    def test_malformed_input_containers_and_nested_entries(self):
        self.reject("tyres.json must be an object", [])
        cases = [
            (("records",), {}, "records"),
            (("records", 0), [], "records[0]"),
            (("records", 0, "fields"), [], "records[0].fields"),
            (("records", 0, "fields", "RADIUS"), [], "fields.RADIUS"),
            (("records", 0, "sound_info"), {}, "records[0].sound_info"),
            (("resolved_tables",), [], "resolved_tables"),
            (("resolved_tables", "CHILD"), [], "resolved_tables.CHILD"),
            (("table_provenance",), [], "table_provenance"),
            (("table_provenance", "CHILD"), [], "table_provenance.CHILD"),
            (("table_provenance", "CHILD", "VERTICAL_LOAD"), [], "table_provenance.CHILD.VERTICAL_LOAD"),
            (("table_provenance", "CHILD", "VERTICAL_LOAD", "path"), [[]], "VERTICAL_LOAD.path"),
            (("effective_scalars", "CHILD"), {}, "effective_scalars.CHILD has no 'inherit_type'"),
            (("effective_scalars", "CHILD", "inherit_type"), {}, "inherit_type has no 'line'"),
            (("effective_scalars", "CHILD", "fields", "WIDTH"), {}, "fields.WIDTH has no 'status'"),
            (("effective_scalars", "CHILD", "fields", "WIDTH", "status"), "resolved", "is not one of declared"),
            (("effective_scalars", "CHILD", "fields", "WIDTH", "source"), 7, "fields.WIDTH"),
            (("effective_scalars", "CHILD", "overwritten"), [None], "overwritten[0]"),
            (("effective_scalars", "CHILD", "unmapped"), [{}], "unmapped[0]"),
        ]
        for path, value, message in cases:
            with self.subTest(path=path):
                tyres = tyres_json()
                target = tyres
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                self.reject(message, tyres)

    def test_missing_accessor_read(self):
        evidence = [site for site in EVIDENCE if site["va"] != 0x00523e52]
        self.reject("No byte-checked site in field-evidence.json shows the VERTICAL_LOAD accessor 0x00523e50 "
                    "at + 0x4c reading its record offset", evidence=evidence)

    def test_missing_fallback(self):
        evidence = [site for site in EVIDENCE if site["va"] != 0x00523f1c]
        self.reject("shows the sound_info accessor 0x00523f10 at + 0x54 loading + 0x14", evidence=evidence)

    def test_no_evidence_at_all(self):
        self.reject("No byte-checked site", evidence=[])

    def test_malformed_evidence(self):
        for site in ({"va": 1, "bytes": "", "claim": "x"}, {"va": 1, "bytes": "zz", "claim": "x"}, {"va": 1}):
            with self.subTest(site=site):
                self.reject("Malformed field-evidence", evidence=EVIDENCE + [site])

    def test_unexpected_site_inside_an_accessor(self):
        evidence = EVIDENCE + [{"va": 0x00523e55, "bytes": "85d2", "claim": "test edx, edx"}]
        self.reject("Byte-checked site 0x00523e55 inside VERTICAL_LOAD accessor", evidence=evidence)

    def test_provenance_cites_another_accessor(self):
        tyres = tyres_json()
        tyres["table_provenance"]["MID"]["VERTICAL_LOAD"]["accessor"] = "0x00523e70"
        self.reject("is neither a read of + 0x4c", tyres)

    def test_provenance_cites_another_offset(self):
        tyres = tyres_json()
        tyres["table_provenance"]["MID"]["CAMBER_THRUST"]["record_offset"] = "0x4c"
        self.reject("CAMBER_THRUST accessor 0x00523e70 at + 0x4c", tyres)

    def test_resolved_tables_disagree(self):
        tyres = tyres_json()
        tyres["resolved_tables"]["CHILD"]["VERTICAL_LOAD"] = "ROOT"
        self.reject("resolved_tables says 'CHILD' reads VERTICAL_LOAD from 'ROOT', table_provenance says 'MID'", tyres)

    def test_record_misses_a_table(self):
        for key in ("resolved_tables", "table_provenance"):
            with self.subTest(key=key):
                tyres = tyres_json()
                del tyres[key]["CHILD"]["sound_info"]
                self.reject(f"Tyre 'CHILD' lacks the sound_info table in {key}", tyres)
                tyres = tyres_json()
                del tyres[key]["MID"]
                self.reject(f"Tyre 'MID' lacks the LONGITUDINAL_COMBINED_VALUES table in {key}", tyres)

    def test_path_that_skips_inheritance(self):
        tyres = tyres_json()
        tyres["table_provenance"]["CHILD"]["CAMBER_THRUST"]["path"] = ["CHILD", "ROOT"]
        self.reject("does not follow INHERIT_TYPE", tyres)

    def test_effective_scalars_must_list_every_inheriting_record(self):
        tyres = tyres_json()
        del tyres["effective_scalars"]["MID"]
        self.reject("effective_scalars does not list exactly", tyres)

    def test_effective_scalars_must_match_the_declarations(self):
        mutations = {"value": lambda child: child["fields"]["WIDTH"].update(values=[0.25]),
                     "source": lambda child: child["fields"]["RADIUS"].update(source="MID", path=["CHILD", "MID"]),
                     "status": lambda child: child["fields"]["RADIUS"].update(status="declared"),
                     "zero-filled": lambda child: child["fields"]["MASS"].update(values=[1.0], source="CHILD",
                                                                                 source_line=24, status="declared"),
                     "overwritten": lambda child: child["overwritten"].clear(),
                     "unmapped": lambda child: child["unmapped"].clear(),
                     "parent": lambda child: child["inherit_type"].update(parent="ROOT")}
        for name, mutate in mutations.items():
            with self.subTest(mutation=name):
                tyres = tyres_json()
                mutate(tyres["effective_scalars"]["CHILD"])
                self.reject("effective_scalars disagrees with record declarations", tyres)

    def test_scalar_store_and_copy_evidence_are_required(self):
        for va, fragment in ((0x00523a35, "WIDTH + 0x30: no byte-checked tyre loader site at 0x00523a35"),
                             (0x00523b3a, "no byte-checked call from 0x00523b3a to 0x00524090"),
                             (0x005240c1, "copy store at 0x005240c4 has no byte-checked load of parent + 0x40")):
            with self.subTest(va=f"0x{va:08x}"):
                self.reject("Tyre scalar stores lack byte-checked evidence: ",
                            evidence=[site for site in EVIDENCE if site["va"] != va])
                with self.assertRaises(ValueError) as caught:
                    self.build(evidence=[site for site in EVIDENCE if site["va"] != va])
                self.assertIn(fragment, str(caught.exception))

    def test_linked_routine_missing_from_status_json(self):
        for entry_va, role in (("00523820", "tyre loader"), ("00524090", "tyre scalar copy"),
                               ("00523f10", "sound_info accessor 0x00523f10")):
            with self.subTest(role=role):
                self.reject(f"status.json has no routine at entry VA 0x{entry_va}, the {role} this page links to",
                            status=status_with(entry_va))

    def test_linked_routine_renamed_in_status_json(self):
        for entry_va, role, label in (("00523820", "tyre loader", "fr3_load_tyre_database"),
                                      ("00524090", "tyre scalar copy", "fr3_copy_tyre_scalar_fields")):
            with self.subTest(role=role):
                self.reject(f"status.json labels entry VA 0x{entry_va}, the {role} this page links to, "
                            f"'fr3_renamed', not '{label}'", status=status_with(entry_va, "fr3_renamed"))

    def test_malformed_status_json(self):
        self.reject("status.json must be a non-empty list", status={})
        status = copy.deepcopy(STATUS)
        status[0]["label"] = "not an anchor"
        self.reject("is not usable as an anchor", status=status)

    def test_linked_site_missing_from_field_evidence(self):
        labels = {int(item["entry_va"], 16): item["label"] for item in STATUS}
        sites = {("VERTICAL_LOAD", "0x00523e50", "0x4c"): {"accessor": [{"va": 0x00523e52}], "loader": [{"va": 0x1234}]}}
        with self.assertRaisesRegex(ValueError, "These linked sites are not in field-evidence.json: 0x00001234"):
            tyre_dossier.check_routines(labels, sites, EVIDENCE)
        sites[("VERTICAL_LOAD", "0x00523e50", "0x4c")]["loader"] = []
        self.assertEqual(tyre_dossier.check_routines(labels, sites, EVIDENCE)["0x00523e50"], "fr3_get_tyre_vertical_load")

    def test_missing_input(self):
        tyres = copy.deepcopy(tyres_json())
        del tyres["table_provenance"]
        self.reject("tyres.json has no 'table_provenance'", tyres)
        with self.assertRaises(ValueError) as caught:
            tyre_dossier.build(self.root / "absent.json", tyre_dossier.FIELD_EVIDENCE, REPO_ROOT / "analysis/pe-metadata.json",
                               self.output)
        self.assertIn("run scripts/text_database.py first", str(caught.exception))


class DossierCommandTests(DossierTestCase):
    SCRIPT = REPO_ROOT / "scripts/tyre_dossier.py"

    def run_script(self, *args, env=None):
        return subprocess.run([sys.executable, str(self.SCRIPT), *args], capture_output=True, text=True, check=False, env=env)

    def test_cli_uses_utf8_even_with_an_ascii_locale(self):
        tyres = tyres_json()
        tyres["source"] = "Veri/Türkçe.DAT"
        evidence = copy.deepcopy(EVIDENCE)
        evidence[0]["claim"] = "Türkçe — kanıt"
        result = self.run_script("--tyres", str(self.write("tyres.json", tyres)),
                                 "--evidence", str(self.write("evidence.json", evidence)), "--output", str(self.output),
                                 env={**os.environ, "LC_ALL": "C", "PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Veri/Türkçe.DAT", self.output.read_bytes().decode("utf-8"))

    def test_cli_reports_malformed_nested_input_without_a_traceback(self):
        tyres = tyres_json()
        tyres["table_provenance"]["CHILD"] = []
        result = self.run_script("--tyres", str(self.write("tyres.json", tyres)), "--output", str(self.output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tyre_dossier.py: tyres.json.table_provenance.CHILD must be an object", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(self.output.exists())

    def test_help_documents_flags_and_defaults(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0)
        text = " ".join(result.stdout.split())
        for flag in ("--tyres", "--evidence", "--pe", "--status", "--output"):
            self.assertIn(flag, text)
        for default in ("tyres.json", "field-evidence.json", "pe-metadata.json", "status.json", "tyres.html"):
            self.assertRegex(text.replace("- ", "-"), rf"default: [^)]*{re.escape(default)}\)")

    def test_cli_writes_the_page(self):
        result = self.run_script("--tyres", str(self.write("tyres.json", tyres_json())), "--output", str(self.output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Wrote 3 tyre records", result.stdout)
        self.assertIn('id="tyre-CHILD"', self.output.read_text())

    def test_cli_refuses_a_renamed_linked_routine(self):
        result = self.run_script("--tyres", str(self.write("tyres.json", tyres_json())), "--output", str(self.output),
                                 "--status", str(self.write("status.json", status_with("00524090", "fr3_renamed"))))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tyre_dossier.py: status.json labels entry VA 0x00524090", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(self.output.exists())

    def test_cli_fails_loudly(self):
        tyres = tyres_json()
        tyres["resolved_tables"]["CHILD"]["VERTICAL_LOAD"] = "ROOT"
        result = self.run_script("--tyres", str(self.write("tyres.json", tyres)), "--output", str(self.output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tyre_dossier.py: resolved_tables says 'CHILD' reads VERTICAL_LOAD", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
