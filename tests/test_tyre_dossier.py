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
import tyre_dossier
from text_database import (REPO_ROOT, RESOLVED_TYRE_TABLES, TYRE_TABLES, parse, resolve_tyre_tables,
                           scalar_inheritance, tyre_table_provenance)

TAGS = {"INHERIT_TYPE", "RADIUS", "WIDTH", "LOCATION_TYPE", "SOUND_INFO", "START_RPM", *TYRE_TABLES}
# ROOT declares every table, MID overrides VERTICAL_LOAD, CHILD declares a scalar on each side of INHERIT_TYPE.
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
SITE_ROW = re.compile(r"<tr><td>(accessor|loader)</td><td><code>0x([0-9a-f]{8})</code></td>"
                      r"<td><code>([0-9a-f]+)</code></td><td>(.*?)</td></tr>")


def tyres_json(text=TYRES):
    records = parse(text, TAGS, sound_info=True)
    return {"source": "DATA/ASCII/CARS/TYREDATA.DAT", "sha256": hashlib.sha256(text.encode()).hexdigest(),
            "records": records, "resolved_tables": resolve_tyre_tables(records),
            "table_provenance": tyre_table_provenance(records), "scalar_inheritance": scalar_inheritance(records)}


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
        path.write_text(json.dumps(data))
        return path

    def build(self, tyres=None, evidence=EVIDENCE, pe=PE):
        tyres = tyres_json() if tyres is None else tyres
        tyre_dossier.build(self.write("tyres.json", tyres), self.write("evidence.json", evidence),
                           self.write("pe.json", pe), self.output, revision="0123abcd")
        return self.output.read_text()

    def reject(self, fragment, tyres=None, evidence=EVIDENCE):
        with self.assertRaises(ValueError) as caught:
            self.build(tyres, evidence)
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

    def test_matching_uses_addresses_not_claim_text(self):
        evidence = [{**site, "claim": f"reworded {index}"} for index, site in enumerate(EVIDENCE)]
        rows = SITE_ROW.findall(why(self.build(evidence=evidence), "CHILD", "VERTICAL_LOAD"))
        self.assertEqual([int(va, 16) for role, va, _, _ in rows if role == "accessor"], ACCESSOR_SITES["VERTICAL_LOAD"])

    def test_scalar_inheritance_is_unresolved_and_shows_no_parent_values(self):
        page = self.build()
        self.assertNotIn("Scalar inheritance", section(page, "ROOT"))
        self.assertIn("777.25", section(page, "ROOT"))
        child = section(page, "CHILD")
        scalars = child[child.index("<h3>Scalar inheritance</h3>"):]
        self.assertIn('<span class="label">unresolved</span>', scalars)
        self.assertIn('href="#tyre-MID">MID</a> on line 25', scalars)
        self.assertIn("<code>RADIUS</code> (line 24)</td>", scalars)
        self.assertIn("<code>WIDTH</code> (line 26)</td>", scalars)
        for parent_value in ("777.25", "0.25", "FRONT", "1500"):
            self.assertNotIn(parent_value, child)
        self.assertIn("0.5", child)

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
        self.assertNotRegex(page, r"https?://")

    def test_repository_links_resolve_from_the_output(self):
        page = self.build()
        targets = set(re.findall(r'href="([^"#][^"]*)"', page))
        self.assertEqual({Path(os.path.normpath(self.output.parent / target)) for target in targets},
                         {tyre_dossier.ACCESSORS_ASM, tyre_dossier.LOADER_ASM, (self.root / "evidence.json").resolve()})
        self.assertIn('evidence.json</a>).</p>', page)

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

    def test_scalar_inheritance_must_stay_unresolved(self):
        tyres = tyres_json()
        tyres["scalar_inheritance"]["CHILD"]["status"] = "resolved"
        self.reject("not labelled unresolved", tyres)
        tyres = tyres_json()
        del tyres["scalar_inheritance"]["MID"]
        self.reject("scalar_inheritance does not list exactly", tyres)

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

    def run_script(self, *args):
        return subprocess.run([sys.executable, str(self.SCRIPT), *args], capture_output=True, text=True, check=False)

    def test_help_documents_flags_and_defaults(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0)
        text = " ".join(result.stdout.split())
        for flag in ("--tyres", "--evidence", "--pe", "--output"):
            self.assertIn(flag, text)
        for default in ("tyres.json", "field-evidence.json", "pe-metadata.json", "tyres.html"):
            self.assertRegex(text.replace("- ", "-"), rf"default: [^)]*{re.escape(default)}\)")

    def test_cli_writes_the_page(self):
        result = self.run_script("--tyres", str(self.write("tyres.json", tyres_json())), "--output", str(self.output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Wrote 3 tyre records", result.stdout)
        self.assertIn('id="tyre-CHILD"', self.output.read_text())

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
