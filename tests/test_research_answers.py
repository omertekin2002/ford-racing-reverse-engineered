"""Synthetic tests for the entrance page's answered questions; these use no game data."""
import copy
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dossier_common import routine_labels
import research_answers
from text_database import REPO_ROOT, ZERO_FILLED

from test_tyre_dossier import TYRES, tyres_json

EVIDENCE = json.loads((REPO_ROOT / "analysis/selected/field-evidence.json").read_text())
LABELS = routine_labels(REPO_ROOT / "analysis/annotated/status.json")
HREFS = {"evidence": "evidence/selected/field-evidence.json"}


def section(tyres=None):
    return research_answers.tyre_tables_section(tyres_json() if tyres is None else tyres, EVIDENCE, LABELS, HREFS)


def text_of(markup):
    return " ".join(re.sub(r"<[^>]+>", " ", markup).split())


class SelectionTests(unittest.TestCase):
    def test_worked_example_is_the_first_pure_inheritor_with_mixed_sources(self):
        # ROOT declares every table and MID declares VERTICAL_LOAD, so CHILD is the first tyre that declares none;
        # its vertical load comes from MID, its longitudinal table from ROOT.
        self.assertEqual(research_answers.worked_example(tyres_json()), ("CHILD", "VERTICAL_LOAD"))

    def test_worked_example_follows_file_order(self):
        text = TYRES.replace(":END", ":TYPE EARLIER\n:INHERIT_TYPE MID\n:END")
        self.assertEqual(research_answers.worked_example(tyres_json(text)), ("CHILD", "VERTICAL_LOAD"))
        text = TYRES.replace(":TYPE CHILD", ":TYPE FIRST\n:INHERIT_TYPE MID\n:TYPE CHILD")
        self.assertEqual(research_answers.worked_example(tyres_json(text)), ("FIRST", "VERTICAL_LOAD"))

    def test_no_worked_example_is_refused(self):
        # Without MID's own VERTICAL_LOAD every tyre reads every table from ROOT.
        text = TYRES.replace(":VERTICAL_LOAD\n0 2.0\n", "")
        with self.assertRaisesRegex(ValueError, "no worked example to trace"):
            section(tyres_json(text))

    def test_same_tables_pair_lists_the_differing_fields(self):
        self.assertEqual(research_answers.same_tables_pair(tyres_json()), ("MID", "CHILD", ["WIDTH"]))

    def test_pair_needs_identical_table_sources(self):
        # CHILD declares its own camber thrust table, so it no longer shares MID's five sources.
        text = TYRES.replace(":WIDTH 0.125", ":WIDTH 0.125\n:CAMBER_THRUST\n0 3.0")
        with self.assertRaisesRegex(ValueError, "cannot show where the comparison ends"):
            research_answers.same_tables_pair(tyres_json(text))

    def test_pair_compares_values_not_sources(self):
        # CHILD declares MID's WIDTH again: same values from a different source line is not a difference.
        text = TYRES.replace(":WIDTH 0.125", ":WIDTH 0.25")
        with self.assertRaisesRegex(ValueError, "cannot show where the comparison ends"):
            section(tyres_json(text))

    def test_zero_filled_differs_from_a_declaration(self):
        tyres = tyres_json(TYRES.replace(":WIDTH 0.125", ":WIDTH 0.25"))
        tyres = copy.deepcopy(tyres)
        tyres["effective_scalars"]["CHILD"]["fields"]["MASS"] = {"status": ZERO_FILLED, "path": ["CHILD"],
                                                                 "offsets": ["0x34", "0x38"]}
        tyres["effective_scalars"]["MID"]["fields"]["MASS"] = {
            "status": "declared", "values": [9], "source": "MID", "source_line": 18, "path": ["MID"],
            "offsets": ["0x34", "0x38"]}
        self.assertEqual(research_answers.same_tables_pair(tyres), ("MID", "CHILD", ["MASS"]))
        self.assertIn(f'<span class="label">{ZERO_FILLED}</span>', section(tyres))


class SectionTests(unittest.TestCase):
    def test_counts_come_from_resolved_tables(self):
        markup = section()
        self.assertTrue(markup.startswith('<section id="tyre-tables"><h2>Do road, offroad and track tyres use '
                                          "different tables?</h2>"))
        text = text_of(markup)
        self.assertIn("For the longitudinal, lateral, camber thrust and sound info tables, all 3 tyres read the table "
                      "declared by ROOT .", text)
        self.assertIn("For the vertical load table, the 3 tyres split across 2 records: 1 from ROOT and 2 from MID .",
                      text)
        self.assertIn("Vertical load 0x00523e50 + 0x4c 1 2", text)
        self.assertIn("Longitudinal 0x00523e90 + 0x44 3 0", text)
        # One more tyre inheriting MID moves the vertical load split; nothing in the section is fixed.
        text = text_of(section(tyres_json(TYRES.replace(":END", ":TYPE MORE\n:INHERIT_TYPE MID\n:END"))))
        self.assertIn("the 4 tyres split across 2 records: 1 from ROOT and 3 from MID", text)
        self.assertIn("Vertical load 0x00523e50 + 0x4c 1 3", text)

    def test_names_the_source_records_as_record_names_only(self):
        text = text_of(section())
        self.assertIn("ROOT and MID are the names of records declared by :TYPE lines in "
                      "DATA/ASCII/CARS/TYREDATA.DAT", text)
        self.assertIn("They are record names in that file. These pages do not establish that the game uses them as a "
                      "vehicle, surface or tyre classification.", text)

    def test_trace_links_path_line_accessor_and_sites(self):
        markup = section()
        links = re.findall(r'href="([^"]+)"', markup)
        for href in ("tyres.html#tyre-CHILD", "tyres.html#tyre-CHILD-VERTICAL_LOAD", "tyres.html#tyre-CHILD-line-25",
                     "tyres.html#tyre-MID", "tyres.html#tyre-MID-line-21", "routines.html#fr3_get_tyre_vertical_load",
                     "routines.html#site-00523e52", "routines.html#site-00523e60", "routines.html#site-005239a9",
                     "evidence/selected/field-evidence.json"):
            self.assertIn(href, links)
        text = text_of(markup)
        self.assertIn("CHILD declares no vertical load table of its own; its :INHERIT_TYPE on line 25 names MID .", text)
        self.assertIn("MID declares the vertical load table on line 21 of DATA/ASCII/CARS/TYREDATA.DAT .", text)
        self.assertIn("accessor 0x00523e52 , 0x00523e60 ; loader 0x005239a9", text)

    def test_pair_shows_where_the_comparison_ends(self):
        text = text_of(section())
        self.assertIn("MID and CHILD read all five tables from the same records ( ROOT and MID ), yet their scalar "
                      "fields hold different declarations", text)
        self.assertIn("WIDTH 0.25 (declared, MID line 20 ) 0.125 (declared, CHILD line 26 )", text)
        self.assertIn("So a shared table source does not mean identical handling.", text)
        self.assertIn("what a table or a scalar value does in the game, and in what units, is not interpreted here.",
                      text)

    def test_wording_makes_no_classification_or_physics_claim(self):
        # Past the heading, which asks the readers' question in their words.
        markup = section()
        text = text_of(markup[markup.index("</h2>"):]).lower()
        for phrase in ("determines", "means the tyre", "offroad tyres", "road tyres", "track tyres", "is a road",
                       "newton", "metre", "grip level", "classified as"):
            self.assertNotIn(phrase, text)

    def test_names_are_escaped(self):
        # parse() only accepts names of letters, digits and underscores, so escaping is checked on a hand-made input.
        tyres = tyres_json()
        markup = research_answers.tyre_link('<b>"x"</b>')
        self.assertNotIn("<b>", markup)
        self.assertIn("&lt;b&gt;&quot;x&quot;", markup)
        self.assertIn('id="tyre-tables"', section(tyres))


if __name__ == "__main__":
    unittest.main()
