"""Synthetic tests for the entrance page's answered questions; these use no game data."""
import copy
import hashlib
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from unittest import mock

import car_page
from dossier_common import routine_labels
import research_answers
from text_database import (BYTE_CHECKED, CAR_REFERENCE_STORES, DECLARED, REPO_ROOT, SCALAR_COPY_CALL, ZERO_FILLED,
                           car_usage, load_known_tags, parse, parse_cars, resolve_car_references)

from test_record_dossier import TAGS, engines_json as dossier_engines_json, gearboxes_json, with_engine_fields
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


KNOWN_TAGS = load_known_tags(REPO_ROOT / "analysis/tags.json")
CAR_BASES = {tag: BYTE_CHECKED for tag in CAR_REFERENCE_STORES}
# ALPHA names the engine CHILD in lower case and MID as both tyres; BETA names CHILD, MID as its back tyre only, and
# CHILD as its front tyre; GAMMA names its own records. So CHILD (engine), TRACK (gearbox) and MID (back tyre) are each
# named by ALPHA and BETA, no front tyre is shared, and no car names BASE, which CHILD inherits, or ROOT, which MID
# inherits. ALPHA writes 0.50, which cars.json holds as 0.5.
CARS = """:CAR_TYPE ALPHA
:CAR_ENGINE_TYPE child
:CAR_GEARBOX_TYPE TRACK
:CAR_BRAKE_TYPE DISC
:CAR_FRONT_TYRE_TYPE MID
:CAR_BACK_TYRE_TYPE MID
:CAR_PERFORMANCE AGILITY 0.50
:CAR_PERFORMANCE SPEED 0.2
:CAR_TYPE BETA
:CAR_ENGINE_TYPE CHILD
:CAR_GEARBOX_TYPE TRACK
:CAR_FRONT_TYRE_TYPE CHILD
:CAR_BACK_TYRE_TYPE MID
:CAR_PERFORMANCE AGILITY 0.7
:CAR_TYPE GAMMA
:CAR_ENGINE_TYPE LONER
:CAR_GEARBOX_TYPE ROAD_OLD
:CAR_FRONT_TYRE_TYPE ROOT
:CAR_BACK_TYRE_TYPE CHILD
:END
"""


def cars_json(text=CARS, bases=CAR_BASES):
    """(cars.json, written declarations) for `text`, resolved against the dossier tests' engines, gearboxes, tyres."""
    data = text.encode("ascii")
    records = parse_cars(text, KNOWN_TAGS)
    targets = {"engines": dossier_engines_json()["records"], "gearboxes": gearboxes_json()["records"],
               "tyres": tyres_json()["records"]}
    cars = {"source": "DATA/ASCII/CARS/CARDATA.DAT", "sha256": hashlib.sha256(data).hexdigest(), "records": records,
            "references": resolve_car_references(records, targets, bases)}
    return cars, car_page.check_cars(cars, data)


def car_section(text=CARS, evidence=EVIDENCE, bases=CAR_BASES):
    cars, written = cars_json(text, bases)
    return research_answers.car_sharing_section(cars, car_usage(cars["references"]), written, evidence)


def shared_block(markup, title):
    """The part of the section under one tag's heading, up to the next heading."""
    start = markup.index(f"<h3>{title} records named by more than one car</h3>")
    return markup[start:markup.index("<h3>", start + 1)]


class CarSharingSelectionTests(unittest.TestCase):
    def test_counts_come_from_the_reverse_index(self):
        cars, _ = cars_json()
        counts = research_answers.sharing_counts(cars, car_usage(cars["references"]))
        self.assertEqual(counts, {"CAR_ENGINE_TYPE": (2, 1, 2), "CAR_FRONT_TYRE_TYPE": (3, 0, 0),
                                  "CAR_GEARBOX_TYPE": (2, 1, 2), "CAR_BACK_TYRE_TYPE": (2, 1, 2)})

    def test_counts_that_disagree_with_check_car_usage_are_refused(self):
        with mock.patch.object(research_answers, "check_car_usage",
                               return_value={tag: 9 for tag in CAR_REFERENCE_STORES}):
            with self.assertRaisesRegex(ValueError, "#car-shared-records answer's distinct records per tag"):
                car_section()

    def test_parents_are_not_counted_through_their_children(self):
        cars, _ = cars_json()
        usage = car_usage(cars["references"])
        engines = dict(research_answers.tag_users(cars, usage, "CAR_ENGINE_TYPE"))
        tyres = dict(research_answers.tag_users(cars, usage, "CAR_FRONT_TYRE_TYPE"))
        self.assertNotIn("BASE", engines)
        self.assertEqual(engines["CHILD"], ["ALPHA", "BETA"])
        # GAMMA names ROOT itself, so ROOT is counted for its front tyre only, never through MID or CHILD.
        self.assertEqual(tyres, {"MID": ["ALPHA"], "CHILD": ["BETA"], "ROOT": ["GAMMA"]})
        text = text_of(car_section())
        self.assertNotIn("BASE", text)

    def test_front_and_back_are_kept_apart(self):
        cars, _ = cars_json()
        usage = car_usage(cars["references"])
        self.assertEqual(research_answers.tag_users(cars, usage, "CAR_BACK_TYRE_TYPE"),
                         [("MID", ["ALPHA", "BETA"]), ("CHILD", ["GAMMA"])])
        markup = car_section()
        front = text_of(shared_block(markup, "Front tyre"))
        self.assertIn("No two cars' CAR_FRONT_TYRE_TYPE name the same record.", front)
        back = shared_block(markup, "Back tyre")
        self.assertIn('href="tyres.html#tyre-MID"', back)
        self.assertEqual(re.findall(r'href="cars\.html#car-(\w+)"', back), ["ALPHA", "BETA"])
        text = text_of(markup)
        self.assertIn("1 car names the same tyre record through CAR_FRONT_TYRE_TYPE and CAR_BACK_TYRE_TYPE ; 2 cars "
                      "name different ones:", text)
        self.assertIn("BETA CHILD MID GAMMA ROOT CHILD", text)

    def test_records_and_cars_follow_file_order(self):
        # BETA moved before ALPHA: every list follows CARDATA.DAT.
        beta = CARS[CARS.index(":CAR_TYPE BETA"):CARS.index(":CAR_TYPE GAMMA")]
        text = beta + CARS.replace(beta, "")
        cars, _ = cars_json(text)
        usage = car_usage(cars["references"])
        self.assertEqual(research_answers.tag_users(cars, usage, "CAR_GEARBOX_TYPE"),
                         [("ROAD_OLD", ["GAMMA"]), ("TRACK", ["BETA", "ALPHA"])])
        self.assertEqual(research_answers.sharing_example(cars, usage), ("CAR_ENGINE_TYPE", "CHILD", ["BETA", "ALPHA"]))
        # Records follow their database file: ROAD_OLD is declared before TRACK in GEARDATA.DAT, whichever car
        # comes first.
        text = CARS.replace(":CAR_GEARBOX_TYPE ROAD_OLD", ":CAR_GEARBOX_TYPE TRACK").replace(
            ":CAR_TYPE BETA\n:CAR_ENGINE_TYPE CHILD\n:CAR_GEARBOX_TYPE TRACK",
            ":CAR_TYPE BETA\n:CAR_ENGINE_TYPE CHILD\n:CAR_GEARBOX_TYPE ROAD_OLD")
        text = text.replace(":CAR_TYPE GAMMA\n:CAR_ENGINE_TYPE LONER\n:CAR_GEARBOX_TYPE TRACK",
                            ":CAR_TYPE GAMMA\n:CAR_ENGINE_TYPE LONER\n:CAR_GEARBOX_TYPE ROAD_OLD")
        cars, _ = cars_json(text)
        self.assertEqual(research_answers.tag_users(cars, car_usage(cars["references"]), "CAR_GEARBOX_TYPE"),
                         [("ROAD_OLD", ["BETA", "GAMMA"]), ("TRACK", ["ALPHA"])])

    def test_example_follows_the_loader_tag_order(self):
        cars, _ = cars_json()
        self.assertEqual(research_answers.sharing_example(cars, car_usage(cars["references"])),
                         ("CAR_ENGINE_TYPE", "CHILD", ["ALPHA", "BETA"]))
        # Without a shared engine, the front tyre comes before the gearbox in CAR_REFERENCE_STORES order.
        text = CARS.replace(":CAR_ENGINE_TYPE CHILD", ":CAR_ENGINE_TYPE BASE").replace(
            ":CAR_FRONT_TYRE_TYPE CHILD", ":CAR_FRONT_TYRE_TYPE MID")
        cars, _ = cars_json(text)
        self.assertEqual(research_answers.sharing_example(cars, car_usage(cars["references"])),
                         ("CAR_FRONT_TYRE_TYPE", "MID", ["ALPHA", "BETA"]))
        text = CARS.replace(":CAR_ENGINE_TYPE CHILD", ":CAR_ENGINE_TYPE BASE")
        cars, _ = cars_json(text)
        self.assertEqual(research_answers.sharing_example(cars, car_usage(cars["references"])),
                         ("CAR_GEARBOX_TYPE", "TRACK", ["ALPHA", "BETA"]))

    def test_no_shared_record_is_refused(self):
        text = CARS[:CARS.index(":CAR_TYPE BETA")] + CARS[CARS.index(":CAR_TYPE GAMMA"):]
        with self.assertRaisesRegex(ValueError, "#car-shared-records answer has no shared record to show"):
            car_section(text)

    def test_a_linked_site_missing_from_the_evidence_is_refused(self):
        store = int(CAR_REFERENCE_STORES["CAR_ENGINE_TYPE"]["store"], 16)
        evidence = [site for site in EVIDENCE if site["va"] != store]
        with self.assertRaisesRegex(ValueError, "#car-shared-records answer links sites that are not in "
                                                "field-evidence.json: 0x00520ece"):
            car_section(evidence=evidence)


class CarSharingSectionTests(unittest.TestCase):
    def test_summary_and_tables(self):
        markup = car_section()
        self.assertTrue(markup.startswith('<section id="car-shared-records"><h2>Which cars share an engine, gearbox or '
                                          "tyre record?</h2>"))
        text = text_of(markup)
        self.assertIn("The 3 cars in DATA/ASCII/CARS/CARDATA.DAT name 2 engines, 2 gearboxes, 3 front tyres and 2 back "
                      "tyres. Of those records, 1 engine named by 2 cars, 1 gearbox named by 2 cars, 0 front tyres "
                      "named by 0 cars and 1 back tyre named by 2 cars are shared", text)
        self.assertIn("Engine ( CAR_ENGINE_TYPE ) 2 1 2", text)
        self.assertIn("Front tyre ( CAR_FRONT_TYRE_TYPE ) 3 0 0", text)
        engine = shared_block(markup, "Engine")
        self.assertIn('<a href="engines.html#engine-CHILD">CHILD</a> (line 9 of <code>ENGDATA.DAT</code>; '
                      '<a href="engines.html#engine-CHILD-used-by">its Used by cars block</a>)', engine)
        self.assertIn('<td><a href="cars.html#car-ALPHA">ALPHA</a></td><td><a href="cars.html#car-ALPHA-line-2">line 2'
                      "</a>: <code>:CAR_ENGINE_TYPE child</code> (matches ignoring case, as the lookup compares)</td>",
                      engine)
        self.assertIn('<a href="cars.html#car-BETA-line-10">line 10</a>: <code>:CAR_ENGINE_TYPE CHILD</code></td>', engine)
        self.assertIn('href="gearboxes.html#gearbox-TRACK-used-by"', shared_block(markup, "Gearbox"))

    def test_each_row_carries_its_reference_basis(self):
        bases = {**CAR_BASES, "CAR_BACK_TYRE_TYPE": DECLARED}
        markup = car_section(bases=bases)
        back = shared_block(markup, "Back tyre")
        self.assertEqual(back.count(f'<span class="label">{DECLARED}</span>'), 2)
        self.assertNotIn("byte-checked", back)
        self.assertEqual(shared_block(markup, "Engine").count("byte-checked)</span>"), 2)

    def test_trace_links_lines_store_row_sites_and_record(self):
        markup = car_section()
        trace = markup[markup.index("<h3>Traced example: CHILD</h3>"):markup.index("<h3>Where the comparison ends")]
        links = re.findall(r'href="([^"]+)"', trace)
        for href in ("cars.html#car-ALPHA", "cars.html#car-ALPHA-line-2", "cars.html#car-BETA",
                     "cars.html#car-BETA-line-10", "cars.html#car-store-CAR_ENGINE_TYPE", "engines.html#engine-CHILD",
                     "engines.html#engine-CHILD-used-by"):
            self.assertIn(href, links)
        sites = {f"routines.html#site-{va:08x}" for va in research_answers.store_site_vas("CAR_ENGINE_TYPE")}
        self.assertEqual({href for href in links if href.startswith("routines.html")}, sites)
        self.assertIn("routines.html#site-00520ece", sites)
        text = text_of(trace)
        self.assertIn("ALPHA names it on line 2 : :CAR_ENGINE_TYPE child (matches ignoring case, as the lookup "
                      "compares), and BETA on line 10 : :CAR_ENGINE_TYPE CHILD", text)
        self.assertIn("stores the record it returns at car payload + 0x1a8 ( 0x00520ece )", text)
        self.assertIn("both names resolve to CHILD , declared at line 9 of ENGDATA.DAT", text)

    def test_comparison_ends_with_the_other_references_and_performance_as_written(self):
        markup = car_section()
        ends = markup[markup.index("<h3>Where the comparison ends"):]
        text = text_of(ends)
        self.assertIn("ALPHA and BETA both name CHILD through CAR_ENGINE_TYPE .", text)
        self.assertIn("CAR_GEARBOX_TYPE TRACK ( line 3 ) TRACK ( line 11 )", text)
        self.assertIn("CAR_FRONT_TYRE_TYPE MID ( line 5 ) CHILD ( line 12 )", text)
        # As written: ALPHA's 0.50 stays 0.50; BETA has one line fewer.
        self.assertIn(":CAR_PERFORMANCE AGILITY 0.50 ( line 7 ) AGILITY 0.7 ( line 14 )", text)
        self.assertIn(":CAR_PERFORMANCE SPEED 0.2 ( line 8 ) none", text)
        self.assertIn('href="cars.html#car-ALPHA-line-7"', ends)
        self.assertIn("Naming the same record does not establish that two cars have the same performance or handling",
                      text)
        self.assertIn("CAR_BRAKE_TYPE , CAR_BODY_TYPE , CAR_SETUP_TYPE and CAR_CONTROL_TYPE also name records, but "
                      "their databases are not parsed, so they are not compared.", text)
        # The brake record ALPHA names is not shown.
        self.assertNotIn("DISC", text)

    def test_wording_makes_no_unit_or_physics_claim(self):
        markup = car_section()
        text = text_of(markup[markup.index("</h2>"):]).lower()
        for word in ("faster", "slower", "quicker", "mph", "km/h", "horsepower", "newton", "kilogram", "same handling "
                     "as", "performs", "is heavier", "is lighter"):
            self.assertNotIn(word, text)
        # The only performance and handling words are in the statement that none is established.
        self.assertEqual(text.count("performance or handling"), 1)
        self.assertEqual(text.count("handling"), 1)

    def test_names_and_values_are_escaped(self):
        markup = research_answers.car_link('<b>"x"</b>') + research_answers.car_line_link('<b>"x"</b>', 3)
        self.assertNotIn("<b>", markup)
        self.assertIn("&lt;b&gt;&quot;x&quot;&lt;/b&gt;", markup)
        cars, written = cars_json()
        written = copy.deepcopy(written)
        written["ALPHA"] = [(line, tag, ["<i>", '"0.5"'] if tag == "CAR_PERFORMANCE" else tokens)
                            for line, tag, tokens in written["ALPHA"]]
        cars["references"]["ALPHA"]["CAR_ENGINE_TYPE"]["name"] = "<u>child</u>"
        markup = research_answers.car_sharing_section(cars, car_usage(cars["references"]), written, EVIDENCE)
        self.assertNotIn("<i>", markup)
        self.assertNotIn("<u>", markup)
        self.assertIn("&lt;i&gt; &quot;0.5&quot;", markup)
        self.assertIn("&lt;u&gt;child&lt;/u&gt;", markup)



# OTHER is a second root, declared after CHILD with every table of its own.
OTHER_TYRE = TYRES[:TYRES.index(":TYPE MID")].replace(":TYPE ROOT", ":TYPE OTHER")
TYRES_WITH_OTHER = TYRES.replace(":END", OTHER_TYRE + ":END")


def roots_data(text=CARS, tyre_text=TYRES, bases=CAR_BASES):
    """(cars.json, tyres.json) for car text `text` resolved against the tyres in `tyre_text`."""
    tyres = tyres_json(tyre_text)
    records = parse_cars(text, KNOWN_TAGS)
    targets = {"engines": dossier_engines_json()["records"], "gearboxes": gearboxes_json()["records"],
               "tyres": tyres["records"]}
    cars = {"source": "DATA/ASCII/CARS/CARDATA.DAT", "sha256": hashlib.sha256(text.encode()).hexdigest(),
            "records": records, "references": resolve_car_references(records, targets, bases)}
    return cars, tyres


def roots_section(text=CARS, tyre_text=TYRES, bases=CAR_BASES, evidence=EVIDENCE):
    cars, tyres = roots_data(text, tyre_text, bases)
    return research_answers.car_tyre_roots_section(cars, tyres, evidence, LABELS)


def roots_block(markup, title):
    """The part of the #car-tyre-roots section under one heading, up to the next heading or the section's end."""
    start = markup.index(f"<h3>{title}")
    following = markup.find("<h3>", start + 1)
    return markup[start:following if following != -1 else len(markup)]


def lineage_of(lineages, car, tag):
    return dict(lineages)[car][tag]


class CarTyreRootsSelectionTests(unittest.TestCase):
    # In CARS, ALPHA names MID front and back, BETA names CHILD front and MID back and GAMMA names ROOT front and CHILD
    # back. MID inherits ROOT and declares its own VERTICAL_LOAD; CHILD inherits MID.
    def test_per_root_counts(self):
        cars, tyres = roots_data()
        lineages = research_answers.car_tyre_lineages(cars, tyres)
        self.assertEqual(research_answers.root_counts(cars, tyres, lineages),
                         {"CAR_FRONT_TYRE_TYPE": {"ROOT": 3}, "CAR_BACK_TYRE_TYPE": {"ROOT": 3}})
        # A second root is counted apart, after ROOT in TYREDATA.DAT order, whichever car comes first.
        cars, tyres = roots_data(CARS.replace(":CAR_FRONT_TYRE_TYPE MID", ":CAR_FRONT_TYRE_TYPE OTHER"),
                                 TYRES_WITH_OTHER)
        lineages = research_answers.car_tyre_lineages(cars, tyres)
        self.assertEqual(research_answers.root_counts(cars, tyres, lineages),
                         {"CAR_FRONT_TYRE_TYPE": {"ROOT": 2, "OTHER": 1}, "CAR_BACK_TYRE_TYPE": {"ROOT": 3}})
        self.assertEqual(list(research_answers.root_counts(cars, tyres, lineages)["CAR_FRONT_TYRE_TYPE"]),
                         ["ROOT", "OTHER"])

    def test_a_two_step_chain_ends_at_its_root(self):
        cars, tyres = roots_data()
        lineages = research_answers.car_tyre_lineages(cars, tyres)
        beta = lineage_of(lineages, "BETA", "CAR_FRONT_TYRE_TYPE")
        self.assertEqual((beta["tyre"], beta["chain"], beta["root"]), ("CHILD", ["CHILD", "MID", "ROOT"], "ROOT"))
        self.assertEqual(lineage_of(lineages, "GAMMA", "CAR_FRONT_TYRE_TYPE")["chain"], ["ROOT"])
        # With ALPHA on ROOT, BETA's two-step chain is the traced example, each :INHERIT_TYPE line linked.
        text = CARS.replace(":CAR_FRONT_TYRE_TYPE MID\n:CAR_BACK_TYRE_TYPE MID",
                            ":CAR_FRONT_TYRE_TYPE ROOT\n:CAR_BACK_TYRE_TYPE ROOT")
        cars, tyres = roots_data(text)
        self.assertEqual(research_answers.car_tyre_example(research_answers.car_tyre_lineages(cars, tyres)),
                         ("BETA", "CAR_FRONT_TYRE_TYPE"))
        trace = roots_block(roots_section(text), "Traced example")
        self.assertIn('<a href="tyres.html#tyre-CHILD">CHILD</a>\'s <code>:INHERIT_TYPE</code> on '
                      '<a href="tyres.html#tyre-CHILD-line-25">line 25</a> names '
                      '<a href="tyres.html#tyre-MID">MID</a>', trace)
        self.assertIn('<a href="tyres.html#tyre-MID">MID</a>\'s <code>:INHERIT_TYPE</code> on '
                      '<a href="tyres.html#tyre-MID-line-19">line 19</a> names '
                      '<a href="tyres.html#tyre-ROOT">ROOT</a>', trace)

    def test_a_table_source_that_differs_from_its_root_is_listed_with_its_cars(self):
        cars, tyres = roots_data()
        lineages = research_answers.car_tyre_lineages(cars, tyres)
        self.assertEqual(research_answers.below_root(lineage_of(lineages, "ALPHA", "CAR_FRONT_TYRE_TYPE")),
                         {"MID": ["VERTICAL_LOAD"]})
        self.assertEqual(research_answers.below_root(lineage_of(lineages, "GAMMA", "CAR_FRONT_TYRE_TYPE")), {})
        self.assertEqual(research_answers.source_groups(tyres, lineages),
                         [("ROOT", ("ROOT", "ROOT", "ROOT"), {"CAR_FRONT_TYRE_TYPE": ["GAMMA"],
                                                              "CAR_BACK_TYRE_TYPE": []}),
                          ("ROOT", ("MID", "ROOT", "ROOT"), {"CAR_FRONT_TYRE_TYPE": ["ALPHA", "BETA"],
                                                             "CAR_BACK_TYRE_TYPE": ["ALPHA", "BETA", "GAMMA"]})])
        below = roots_block(roots_section(), "Tables declared below the root")
        front, back = below.split("CAR_BACK_TYRE_TYPE</code></a>: ")
        self.assertEqual(re.findall(r'<td><a href="cars\.html#car-(\w+)">', front), ["ALPHA", "BETA"])
        self.assertEqual(re.findall(r'<td><a href="cars\.html#car-(\w+)">', back), ["ALPHA", "BETA", "GAMMA"])
        self.assertIn('<a href="tyres.html#tyre-MID-VERTICAL_LOAD">vertical load</a> from '
                      '<a href="tyres.html#tyre-MID">MID</a>', front)
        self.assertIn(" &rarr; ".join(f'<a href="tyres.html#tyre-{name}">{name}</a>' for name in ("CHILD", "MID", "ROOT")),
                      front)
        self.assertIn("2 cars of 3 read at least one of these tables from a record on the chain other than the root",
                      text_of(front))

    def test_none_below_the_root_is_stated(self):
        text = CARS.replace(":CAR_FRONT_TYRE_TYPE MID", ":CAR_FRONT_TYRE_TYPE ROOT").replace(
            ":CAR_FRONT_TYRE_TYPE CHILD", ":CAR_FRONT_TYRE_TYPE ROOT")
        below = text_of(roots_block(roots_section(text), "Tables declared below the root"))
        self.assertIn("CAR_FRONT_TYRE_TYPE : every car's tyre reads the vertical load, camber thrust and sound info "
                      "tables from its root.", below)

    def test_mixed_front_and_back_roots_are_listed(self):
        mixed = text_of(roots_block(roots_section(), "Front and back on different roots"))
        self.assertIn("None of the 3 cars: each car's front and back tyre chains end at the same root.", mixed)
        # GAMMA reads ROOT's vertical load at the front and MID's at the back.
        self.assertIn("1 car of 3 reads at least one of the vertical load, camber thrust and sound info tables from "
                      "different records front and back: Car Vertical load (front / back) Camber thrust (front / back) "
                      "Sound info (front / back) GAMMA ROOT / MID ROOT / ROOT ROOT / ROOT", mixed)
        text = CARS.replace(":CAR_BACK_TYRE_TYPE MID\n:CAR_PERFORMANCE AGILITY 0.7",
                            ":CAR_BACK_TYRE_TYPE OTHER\n:CAR_PERFORMANCE AGILITY 0.7")
        markup = roots_block(roots_section(text, TYRES_WITH_OTHER), "Front and back on different roots")
        self.assertIn("1 car of 3 names a front and a back tyre whose chains end at different roots:", text_of(markup))
        self.assertIn('<tr><td><a href="cars.html#car-BETA">BETA</a></td><td><a href="cars.html#car-BETA-line-12">'
                      "line 12</a>: <code>:CAR_FRONT_TYRE_TYPE CHILD</code>", markup)
        self.assertIn('<td><a href="tyres.html#tyre-ROOT">ROOT</a></td><td><a href="cars.html#car-BETA-line-13">'
                      "line 13</a>: <code>:CAR_BACK_TYRE_TYPE OTHER</code>", markup)
        self.assertIn('<td><a href="tyres.html#tyre-OTHER">OTHER</a></td></tr>', markup)

    def test_no_inheriting_tyre_is_refused(self):
        text = re.sub(r":CAR_(FRONT|BACK)_TYRE_TYPE \w+", r":CAR_\1_TYRE_TYPE ROOT", CARS)
        with self.assertRaisesRegex(ValueError, "#car-tyre-roots answer has no traced example"):
            roots_section(text)

    def test_a_missing_tyre_reference_is_refused(self):
        cars, tyres = roots_data()
        missing = copy.deepcopy(cars)
        missing["references"]["BETA"]["CAR_BACK_TYRE_TYPE"]["target"] = "NOPE"
        with self.assertRaisesRegex(ValueError, "Car 'BETA'\\'s CAR_BACK_TYRE_TYPE names 'NOPE', which is not a tyre "
                                                "record in tyres.json"):
            research_answers.car_tyre_roots_section(missing, tyres, EVIDENCE, LABELS)
        missing = copy.deepcopy(cars)
        del missing["references"]["GAMMA"]["CAR_FRONT_TYRE_TYPE"]
        with self.assertRaisesRegex(ValueError, "Car 'GAMMA' has no CAR_FRONT_TYRE_TYPE reference in cars.json"):
            research_answers.car_tyre_roots_section(missing, tyres, EVIDENCE, LABELS)

    def test_a_count_mismatch_is_refused(self):
        cars, tyres = roots_data()
        del cars["references"]["BETA"]
        with self.assertRaisesRegex(ValueError, "#car-tyre-roots answer counts 2 cars' CAR_FRONT_TYRE_TYPE by root, "
                                                "not the 3 cars in cars.json"):
            research_answers.car_tyre_roots_section(cars, tyres, EVIDENCE, LABELS)

    def test_a_chain_inherit_chain_refuses_is_refused(self):
        # MID inheriting CHILD, a later record, is what inherit_chain() refuses (and how a cycle would start).
        cars, tyres = roots_data()
        tyres = copy.deepcopy(tyres)
        next(record for record in tyres["records"] if record["type"] == "MID")["fields"]["INHERIT_TYPE"]["values"] = [
            "CHILD"]
        with self.assertRaisesRegex(ValueError, "'MID' inherits 'CHILD', which is not an earlier record"):
            research_answers.car_tyre_roots_section(cars, tyres, EVIDENCE, LABELS)

    def test_a_linked_site_missing_from_the_evidence_is_refused(self):
        evidence = [site for site in EVIDENCE if site["va"] != SCALAR_COPY_CALL]
        with self.assertRaisesRegex(ValueError, "#car-tyre-roots answer links sites that are not in "
                                                "field-evidence.json: 0x00523b3a"):
            roots_section(evidence=evidence)


class CarTyreRootsSectionTests(unittest.TestCase):
    def test_summary_and_tables(self):
        markup = roots_section()
        self.assertTrue(markup.startswith('<section id="car-tyre-roots"><h2>Which cars run road, offroad or track '
                                          "tyres?</h2>"))
        text = text_of(markup)
        self.assertIn("The 3 cars in DATA/ASCII/CARS/CARDATA.DAT each name a front and a back tyre record. Following "
                      "each named record's :INHERIT_TYPE chain to the record that declares none, its root: for the "
                      "front tyres ( CAR_FRONT_TYRE_TYPE ), 3 cars end at ROOT ; for the back tyres "
                      "( CAR_BACK_TYRE_TYPE ), 3 cars end at ROOT .", text)
        # The front tyres split the vertical load table only, so the tables are named; the back tyres all read MID's.
        self.assertIn("The cars read the vertical load, camber thrust and sound info tables from these records: the "
                      "front tyres (vertical load) 1 from ROOT and 2 from MID ; the front tyres (camber thrust and "
                      "sound info) 3 from ROOT ; the back tyres (vertical load) 3 from MID ; the back tyres (camber "
                      "thrust and sound info) 3 from ROOT .", text)
        self.assertIn("All 6 front and back tyre references read the longitudinal and lateral tables from ROOT .", text)
        self.assertIn("Root (no :INHERIT_TYPE ) Cars, CAR_FRONT_TYRE_TYPE Cars, CAR_BACK_TYRE_TYPE ROOT 3 3 All roots "
                      "3 3", text)
        self.assertIn("ROOT ROOT ROOT ROOT 1: GAMMA resolved by the loader&#x27;s lookup (byte-checked) 0 "
                      "ROOT MID ROOT ROOT 2: ALPHA , BETA resolved by the loader&#x27;s lookup (byte-checked) "
                      "3: ALPHA , BETA , GAMMA resolved by the loader&#x27;s lookup (byte-checked)", text)
        self.assertIn('<a href="cars.html#car-GAMMA">GAMMA</a>', markup)
        self.assertIn('href="#tyre-tables"', markup)

    def test_trace_links_declaration_store_row_inherit_lines_and_tables(self):
        markup = roots_section()
        trace = roots_block(markup, "Traced example")
        self.assertIn("<h3>Traced example: ALPHA's front tyre</h3>", trace)
        links = re.findall(r'href="([^"]+)"', trace)
        for href in ("cars.html#car-ALPHA", "cars.html#car-ALPHA-line-5", "cars.html#car-store-CAR_FRONT_TYRE_TYPE",
                     "tyres.html#tyre-MID", "tyres.html#tyre-MID-line-19", "tyres.html#tyre-ROOT",
                     "tyres.html#tyre-MID-line-21", "tyres.html#tyre-ROOT-line-10", "tyres.html#tyre-ROOT-line-12",
                     "tyres.html#tyre-MID-VERTICAL_LOAD", "tyres.html#tyre-MID-CAMBER_THRUST",
                     "tyres.html#tyre-MID-sound_info", "routines.html#fr3_copy_tyre_scalar_fields",
                     "routines.html#site-00523b3a", "routines.html#fr3_get_tyre_vertical_load",
                     "routines.html#fr3_get_tyre_camber_thrust", "routines.html#fr3_get_tyre_sound_info"):
            self.assertIn(href, links)
        # The only byte-checked site it links is the INHERIT_TYPE call; the car loader's sites are on the store row.
        self.assertEqual([href for href in links if "#site-" in href], ["routines.html#site-00523b3a"])
        text = text_of(trace)
        self.assertIn("ALPHA declares its front tyre on line 5 : :CAR_FRONT_TYRE_TYPE MID ; the reference is labelled "
                      "resolved by the loader&#x27;s lookup (byte-checked) .", text)
        self.assertIn("The name matches MID , declared at line 18.", text)
        self.assertIn("ROOT declares no :INHERIT_TYPE , so the chain ends there", text)
        self.assertIn("Vertical load: read through 0x00523e50 at + 0x4c from MID (not the root ROOT ), which "
                      "declares it on line 21 ; the table-source row of MID .", text)
        self.assertIn("Camber thrust: read through 0x00523e70 at + 0x50 from ROOT (the root), which declares it on "
                      "line 10 ;", text)

    def test_each_car_carries_its_reference_basis(self):
        bases = {**CAR_BASES, "CAR_BACK_TYRE_TYPE": DECLARED}
        markup = roots_section(bases=bases)
        sources = markup[markup.index("and the cars in each group"):markup.index("<h3>Tables declared below the root</h3>")]
        self.assertIn(f'<a href="cars.html#car-GAMMA">GAMMA</a> <span class="label">'
                      f'{BYTE_CHECKED.replace(chr(39), "&#x27;")}</span>', sources)
        self.assertIn(f'<a href="cars.html#car-ALPHA">ALPHA</a>, <a href="cars.html#car-BETA">BETA</a>, '
                      f'<a href="cars.html#car-GAMMA">GAMMA</a> <span class="label">{DECLARED}</span>', sources)
        below = roots_block(markup, "Tables declared below the root")
        front, back = below.split("CAR_BACK_TYRE_TYPE</code></a>: ")
        self.assertEqual(front.count("byte-checked)</span>"), 2)
        self.assertEqual(back.count(f'<span class="label">{DECLARED}</span>'), 3)
        self.assertNotIn("byte-checked", back)

    def test_names_are_record_names_and_the_answer_says_where_it_ends(self):
        markup = roots_section()
        ends = text_of(roots_block(markup, "Where the answer ends"))
        self.assertIn("ROOT and MID are the names of records declared by :TYPE lines in DATA/ASCII/CARS/TYREDATA.DAT , "
                      "and this answer groups the cars by those record names only. These pages do not establish that "
                      "the game treats them as road, offroad or track tyres", ends)
        self.assertIn("Sharing a root or a table source does not establish that two cars handle alike", ends)
        self.assertIn("CAR_BRAKE_TYPE , CAR_BODY_TYPE , CAR_SETUP_TYPE and CAR_CONTROL_TYPE name records whose "
                      "databases are not parsed", ends)
        self.assertIn("No units, surface meaning or physics are claimed.", ends)
        text = text_of(markup[markup.index("</h2>"):]).lower()
        for word in ("faster", "slower", "grippier", "mph", "km/h", "newton", "kilogram", "asphalt", "gravel", "dirt",
                     "performs", "handles better"):
            self.assertNotIn(word, text)
        self.assertEqual(text.count("handle"), 1)

    def test_names_are_escaped(self):
        cars, tyres = roots_data()
        cars["references"]["ALPHA"]["CAR_FRONT_TYRE_TYPE"]["name"] = "<u>mid</u>"
        markup = research_answers.car_tyre_roots_section(cars, tyres, EVIDENCE, LABELS)
        self.assertNotIn("<u>", markup)
        self.assertIn("&lt;u&gt;mid&lt;/u&gt;", markup)


if __name__ == "__main__":
    unittest.main()
