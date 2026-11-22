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
from text_database import REPO_ROOT, ZERO_FILLED, parse

from test_record_dossier import TAGS, with_engine_fields
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


ENGINE_TAGS = {*TAGS, "TORQUE_MODIFIER"}
# ROOT declares a table nobody inherits. A declares its own table, which B (through A) and C (through B and A) read,
# so A's table is shared by three engines. LONE declares a table only it reads. ODD is a root with a colon-less line
# that is not allow-listed, so it is not applied.
ENGINES = """:TYPE ROOT
:MAX_RPM 6000
:TORQUE_MODIFIER 1.0
:TORQUE_ARRAY
0 10.5
1000 20.5
:TYPE A
:INHERIT_TYPE ROOT
:MAX_RPM 7000
:TORQUE_MODIFIER 3.9
:TORQUE_ARRAY
0 30.5
1000 40.5
:TYPE B
:INHERIT_TYPE A
:TORQUE_MODIFIER 3.0
:TYPE C
:INHERIT_TYPE B
:TORQUE_MODIFIER 3.5
:CAPACITY 2.5
:TYPE LONE
:INHERIT_TYPE ROOT
:MAX_RPM 8000
:TORQUE_MODIFIER 2.0
:TORQUE_ARRAY
0 1.5
:TYPE ODD
INHERIT_TYPE ROOT
:TORQUE_MODIFIER 1.5
:END
"""
# ENGINES plus DEFAULT_TRACK, a root with a table, INDIGO, whose colon-less line is padded onto line 1410 where
# text_database.APPLIED_UNTAGGED_INHERIT applies it, and INDIGO_KID, which inherits DEFAULT_TRACK's table through it.
INDIGO_HEAD = ENGINES.removesuffix(":END\n") + ":TYPE DEFAULT_TRACK\n:MAX_RPM 7500\n:TORQUE_ARRAY\n0 5.5\n"
INDIGO_ENGINES = (INDIGO_HEAD + "//\n" * (1408 - INDIGO_HEAD.count("\n")) + ":TYPE INDIGO\nINHERIT_TYPE DEFAULT_TRACK\n"
                  ":TORQUE_MODIFIER 1.5\n:TYPE INDIGO_KID\n:INHERIT_TYPE INDIGO\n:END\n")


def engines_json(text=ENGINES):
    return with_engine_fields({"source": "DATA/ASCII/CARS/ENGDATA.DAT", "sha256": "0" * 64,
                               "records": parse(text, ENGINE_TAGS)})


def engine_section(engines=None, evidence=EVIDENCE):
    return research_answers.engine_torque_section(engines_json() if engines is None else engines, evidence, LABELS)


class EngineSelectionTests(unittest.TestCase):
    def test_groups_readers_by_table_source_and_line(self):
        self.assertEqual(research_answers.torque_groups(engines_json()),
                         [{"source": "A", "source_line": 11, "readers": ["A", "B", "C"]},
                          {"source": "LONE", "source_line": 25, "readers": ["LONE"]}])
        self.assertEqual(research_answers.shared_groups(engines_json()),
                         [{"source": "A", "source_line": 11, "readers": ["A", "B", "C"]}])

    def test_a_root_whose_table_is_inherited_reads_it_too(self):
        engines = engines_json(ENGINES.replace(":END", ":TYPE D\n:INHERIT_TYPE ROOT\n:END"))
        self.assertEqual(research_answers.shared_groups(engines),
                         [{"source": "ROOT", "source_line": 4, "readers": ["ROOT", "D"]},
                          {"source": "A", "source_line": 11, "readers": ["A", "B", "C"]}])

    def test_zero_filled_tables_are_not_grouped(self):
        # NONE_ROOT declares no table, so its child keeps the zero fill and reads no table.
        text = ENGINES.replace(":END", ":TYPE NONE_ROOT\n:MAX_RPM 1\n:TYPE NONE_CHILD\n:INHERIT_TYPE NONE_ROOT\n:END")
        groups = research_answers.torque_groups(engines_json(text))
        self.assertNotIn("NONE_CHILD", [name for group in groups for name in group["readers"]])
        self.assertIn("1 has no TORQUE_ARRAY along its :INHERIT_TYPE path and keeps the zero-filled slots",
                      text_of(engine_section(engines_json(text))))

    def test_example_is_the_first_engine_that_inherits_its_table(self):
        self.assertEqual(research_answers.torque_example(engines_json()), "B")
        text = ENGINES.replace(":END", ":TYPE LATER\n:INHERIT_TYPE LONE\n:END")
        self.assertEqual(research_answers.torque_example(engines_json(text)), "B")
        text = ENGINES.replace(":TYPE B", ":TYPE EARLY\n:INHERIT_TYPE A\n:TYPE B")
        self.assertEqual(research_answers.torque_example(engines_json(text)), "EARLY")

    def test_no_shared_table_is_refused(self):
        # Without B and C, every table is read by one engine only.
        text = ENGINES.replace(":TYPE B\n:INHERIT_TYPE A\n:TORQUE_MODIFIER 3.0\n:TYPE C\n:INHERIT_TYPE B\n"
                               ":TORQUE_MODIFIER 3.5\n:CAPACITY 2.5\n", "")
        with self.assertRaisesRegex(ValueError, "#engine-torque-tables answer has no shared torque table"):
            engine_section(engines_json(text))

    def test_no_inheriting_table_is_refused(self):
        # Hand-made: B and C marked as declaring A's table, so it is shared yet no engine inherits a table.
        engines = copy.deepcopy(engines_json())
        for name in ("B", "C"):
            engines["effective_fields"][name]["fields"]["TORQUE_ARRAY"]["status"] = "declared"
        with self.assertRaisesRegex(ValueError, "#engine-torque-tables answer has no traced example"):
            engine_section(engines)

    def test_a_linked_site_missing_from_the_evidence_is_refused(self):
        evidence = [site for site in EVIDENCE if site["va"] != 0x00522ccd]
        with self.assertRaisesRegex(ValueError, "not in field-evidence.json: 0x00522ccd"):
            engine_section(evidence=evidence)


class EngineSectionTests(unittest.TestCase):
    def test_summary_and_table_come_from_effective_fields(self):
        markup = engine_section()
        self.assertTrue(markup.startswith('<section id="engine-torque-tables"><h2>Which engines share a torque table, '
                                          "and what do they declare differently?</h2>"))
        text = text_of(markup)
        self.assertIn("Of the 4 engines with :INHERIT_TYPE , 2 declare their own TORQUE_ARRAY and 2 inherit one. "
                      "1 table is read by more than one engine, 3 engines in all; the other 1 inheriting engine each "
                      "reads a table that no other engine reads.", text)
        self.assertIn("The 2 records that inherit nothing ( ROOT and ODD ) are not counted above. "
                      "No inheriting engine reads a table one of them declares.", text)
        self.assertIn("A line 11 A declares it ( line 11 ) MAX_RPM 7000 ( line 9 ); TORQUE_MODIFIER 3.9 ( line 10 ) "
                      "B inherits it: B &rarr; A TORQUE_MODIFIER 3.0 ( line 16 ) "
                      "C inherits it: C &rarr; B &rarr; A TORQUE_MODIFIER 3.5 ( line 19 ); CAPACITY 2.5 ( line 20 )",
                      text)
        self.assertNotIn("LONE line 25", text)
        # One more engine inheriting A moves every count; nothing in the section is fixed.
        text = text_of(engine_section(engines_json(ENGINES.replace(":END", ":TYPE MORE\n:INHERIT_TYPE C\n:END"))))
        self.assertIn("Of the 5 engines with :INHERIT_TYPE , 2 declare their own TORQUE_ARRAY and 3 inherit one. "
                      "1 table is read by more than one engine, 4 engines in all", text)
        self.assertIn("MORE inherits it: MORE &rarr; C &rarr; B &rarr; A", text)

    def test_shared_root_is_named_as_a_reader(self):
        text = text_of(engine_section(engines_json(ENGINES.replace(":END", ":TYPE D\n:INHERIT_TYPE ROOT\n:END"))))
        self.assertIn("2 tables are read by more than one engine, 5 engines in all", text)
        self.assertIn("ROOT is counted among the readers of the shared tables because inheriting engines read its "
                      "table.", text)
        self.assertIn("ROOT line 4 ROOT declares it ( line 4 ) MAX_RPM 6000 ( line 2 ); TORQUE_MODIFIER 1.0 ( line 3 ) "
                      "D inherits it: D &rarr; ROOT none", text)

    def test_trace_links_path_lines_row_count_copy_and_zero_fill(self):
        markup = engine_section()
        links = re.findall(r'href="([^"]+)"', markup)
        for href in ("engines.html#engine-B", "engines.html#engine-B-line-15", "engines.html#engine-A-line-11",
                     "engines.html#engine-A-line-9", "engines.html#engine-B-torque-array",
                     "routines.html#fr3_copy_engine_record", "routines.html#site-0052292b",
                     "routines.html#site-00522b47", "routines.html#site-00522ccd", "routines.html#site-00522cd4",
                     "routines.html#site-00522926", "routines.html#site-00522a0e", "routines.html#site-005229c1",
                     "routines.html#site-005229f8"):
            self.assertIn(href, links)
        for href in links:
            self.assertRegex(href, r"\A(engines\.html(#engine-[A-Za-z0-9_]+(-line-\d+|-torque-array)?)?|"
                                   r"routines\.html#(site-[0-9a-f]{8}|fr3_\w+))\Z")
        text = text_of(markup)
        self.assertIn("Traced example: B Chosen from the data: the first engine in file order that inherits its "
                      "TORQUE_ARRAY . B reads the table A declares on line 11 .", text)
        self.assertIn("B declares no TORQUE_ARRAY after its :INHERIT_TYPE on line 15 , which names A .", text)
        self.assertIn("A declares the TORQUE_ARRAY on line 11 of DATA/ASCII/CARS/ENGDATA.DAT , 2 rows &times; 2 "
                      "columns.", text)
        self.assertIn("When the loader parsed that table, it read the row count from + 0x30 ( 0x0052292b ), which held "
                      "the MAX_RPM 7000 that A declares on line 9 .", text)
        self.assertIn("calls the record copy fr3_copy_engine_record ( 0x00522b47 ). The copy moves the parent's 18 "
                      "torque slots at + 0x3c as one 0x48-byte block ( 0x00522ccd , 0x00522cd4 )", text)
        self.assertIn("first zero-fills all 18 slots ( 0x00522926 )", text)

    def test_trace_of_a_two_hop_path_and_an_inherited_max_rpm(self):
        # C reaches A's table through B; without its own MAX_RPM, A's table was parsed after A's INHERIT_TYPE gave it
        # ROOT's.
        text = ENGINES.replace(":TYPE A\n:INHERIT_TYPE ROOT\n:MAX_RPM 7000\n", ":TYPE A\n:INHERIT_TYPE ROOT\n")
        markup = text_of(research_answers.torque_trace(engines_json(text), "C", LABELS))
        self.assertIn("C declares no TORQUE_ARRAY after its :INHERIT_TYPE on line 17 , which names B .", markup)
        self.assertIn("B declares no TORQUE_ARRAY after its :INHERIT_TYPE on line 14 , which names A .", markup)
        self.assertIn("A declares the TORQUE_ARRAY on line 10 of", markup)
        self.assertIn("which held the MAX_RPM 6000 that ROOT declares on line 2 , which reached A through A &rarr; "
                      "ROOT .", markup)

    def test_comparison_ends_at_each_engine_own_modifier(self):
        text = text_of(engine_section())
        self.assertIn("A shared table does not make two engines' effective fields the same. All 3 engines that read a "
                      "shared table declare their own TORQUE_MODIFIER , which the loader stores at + 0x24 ( 0x00522a0e ). "
                      "For 1 of the 1 shared table, the engines that read the table hold different TORQUE_MODIFIER "
                      "declarations. For example (the first such table in file order), the engines reading the table "
                      "A declares on line 11 hold A 3.9 ( line 10 ), B 3.0 ( line 16 ) and C 3.5 ( line 19 ).", text)
        self.assertIn("How the game uses + 0x24 together with the table is not byte-checked here, so this answer "
                      "neither combines them nor computes anything from them.", text)
        self.assertIn("The + 0x2c that TORQUE_ARRAY may also write ( 0x005229c1 , 0x005229f8 ) is labelled derived and "
                      "conditional and is given no value", text)
        # C no longer declares its own modifier, so it holds B's, and B's table group still differs.
        text = text_of(engine_section(engines_json(ENGINES.replace(":TORQUE_MODIFIER 3.5\n", ""))))
        self.assertIn("2 of the 3 engines that read a shared table declare their own TORQUE_MODIFIER", text)
        self.assertIn("C 3.0 ( line 16 )", text)
        # Nobody re-declares the modifier: the readers all hold A's.
        text = ENGINES.replace(":TORQUE_MODIFIER 3.5\n", "").replace(":TORQUE_MODIFIER 3.0\n", "")
        self.assertIn("The engines reading each shared table hold the same TORQUE_MODIFIER .",
                      text_of(engine_section(engines_json(text))))

    def test_wording_makes_no_unit_or_performance_claim(self):
        markup = engine_section()
        text = text_of(markup[markup.index("</h2>"):]).lower()
        for word in ("unit", "horsepower", "power", "performance", "handling", "faster", "slower", "curve", "newton",
                     "kw", "nm "):
            self.assertNotIn(word, text)
        # Nothing is multiplied: no number appears that is not declared in the synthetic file or a site, line or
        # count.
        for product in ("119", "122", "117.0", "15.21"):
            self.assertNotIn(product, text)

    def test_indigo_links_its_open_question(self):
        self.assertEqual(research_answers.engine_ref("INDIGO"),
                         '<a href="engines.html#engine-INDIGO">INDIGO</a> '
                         '(<a href="questions.html#indigo">open question</a>)')
        self.assertEqual(research_answers.engine_ref("A"), '<a href="engines.html#engine-A">A</a>')
        self.assertIn('<a href="engines.html#engine-INDIGO">INDIGO</a> (<a href="questions.html#indigo">open question'
                      "</a>)", engine_section(engines_json(INDIGO_ENGINES)))
        self.assertNotIn("questions.html", engine_section())

    def test_indigo_inherits_through_its_applied_line_with_the_basis(self):
        engines = engines_json(INDIGO_ENGINES)
        self.assertFalse(engines["effective_fields"]["INDIGO"]["inherit_type"]["colon"])
        markup = engine_section(engines)
        basis = '<a href="questions.html#indigo"><span class="label">static instruction evidence</span></a>'
        self.assertIn(basis, markup)
        text = text_of(markup)
        self.assertIn("Of the 6 inheriting engines, 2 declare their own TORQUE_ARRAY and 4 inherit one. 5 of them "
                      "inherit through :INHERIT_TYPE , and INDIGO ( open question ) through its colon-less INHERIT_TYPE "
                      "line 1410 , applied on static instruction evidence : nothing has been run to confirm it.", text)
        self.assertIn("The 3 records that inherit nothing ( ROOT , ODD and DEFAULT_TRACK ) are not counted above.", text)
        self.assertIn("INDIGO_KID inherits it: INDIGO_KID &rarr; INDIGO ( open question ) &rarr; DEFAULT_TRACK", text)
        trace = research_answers.torque_trace(engines, "INDIGO_KID", LABELS)
        self.assertIn(basis, trace)
        trace = text_of(trace)
        self.assertIn("INDIGO_KID declares no TORQUE_ARRAY after its :INHERIT_TYPE on line 1413 , which names INDIGO "
                      "( open question ).", trace)
        self.assertIn("INDIGO ( open question ) declares no TORQUE_ARRAY after its colon-less INHERIT_TYPE line, "
                      "applied on static instruction evidence , on line 1410 , which names DEFAULT_TRACK .", trace)

    def test_names_are_escaped(self):
        markup = research_answers.engine_ref('<b>"x"</b>') + research_answers.engine_line_link('<b>"x"</b>', 3)
        self.assertNotIn("<b>", markup)
        self.assertIn("&lt;b&gt;&quot;x&quot;&lt;/b&gt;", markup)
        # parse() only accepts words and numbers, so escaping of declared values is checked on a hand-made input.
        engines = copy.deepcopy(engines_json())
        engines["effective_fields"]["B"]["fields"]["TORQUE_MODIFIER"]["values"] = ['<i>"3"</i>']
        markup = engine_section(engines)
        self.assertNotIn("<i>", markup)
        self.assertIn("&lt;i&gt;&quot;3&quot;&lt;/i&gt;", markup)


if __name__ == "__main__":
    unittest.main()
