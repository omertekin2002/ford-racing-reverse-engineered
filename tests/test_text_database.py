"""Synthetic text-database parser tests; these use no game data."""
import copy
import hashlib
import re
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import text_database
from text_database import (GEARBOX_TAGS, MAX_TEXT_BYTES, RESOLVED_TYRE_TABLES, SOUND_INFO_COUNTS,
                           TYRE_TABLE_ACCESSORS, TYRE_TABLE_SOURCES, TYRE_TABLES, TextDatabaseError,
                           check_table_provenance, parse, read_database, resolve_tyre_tables, scalar_inheritance,
                           sources_in_file_order, table_sources, tyre_table_provenance, verify_text_databases)

# Only the disassembly tests need capstone, and extract_selected also imports pefile.
try:
    import capstone
    from extract_selected import EVIDENCE, ROUTINES
except ImportError:
    capstone = None

TAGS = {"CAPACITY", "LOCATION_TYPE", "INHERIT_TYPE", "TORQUE_ARRAY", "MAX_RPM", "ENGINE_BRAKING", *GEARBOX_TAGS,
        "RADIUS", "WIDTH", "MASS", "ROLLING_RESISTANCE", "SOUND_INFO", "START_RPM", *TYRE_TABLES}
VALID = """//////////////////////
// Banner comment
//////////////////////

:TYPE BASE
:LOCATION_TYPE FRONT
:CAPACITY 6.0
//:ENGINE_BRAKING 0.5
:ENGINE_BRAKING 3   // trailing comment
:MAX_RPM\t7000.00\t\t
:TORQUE_ARRAY\t\t
\t0.0 177.1
\t1000.0\t209.0

\t2000.0 227.7
\t
:TYPE CHILD
:INHERIT_TYPE BASE
:CAPACITY -1.5
:END\t\t
// trailer
"""


class ParseValidTests(unittest.TestCase):
    def check(self, records):
        self.assertEqual([record["type"] for record in records], ["BASE", "CHILD"])
        base, child = records
        self.assertEqual(base["line"], 5)
        self.assertEqual(base["fields"]["LOCATION_TYPE"]["values"], ["FRONT"])
        self.assertEqual(base["fields"]["CAPACITY"]["values"], [6.0])
        self.assertEqual(base["fields"]["ENGINE_BRAKING"], {"line": 9, "values": [3], "rows": []})
        self.assertIsInstance(base["fields"]["ENGINE_BRAKING"]["values"][0], int)
        self.assertEqual(base["fields"]["MAX_RPM"]["values"], [7000.0])
        self.assertEqual(base["fields"]["TORQUE_ARRAY"],
                         {"line": 11, "values": [], "rows": [[0.0, 177.1], [1000.0, 209.0], [2000.0, 227.7]]})
        self.assertEqual(child["fields"]["INHERIT_TYPE"]["values"], ["BASE"])
        self.assertEqual(child["fields"]["CAPACITY"]["values"], [-1.5])
        self.assertEqual(base["untagged"], [])

    def test_lf(self):
        self.check(parse(VALID, TAGS))

    def test_crlf_bytes(self):
        self.check(parse(VALID.replace("\n", "\r\n").encode("ascii"), TAGS))

    def test_commented_out_tag_is_ignored(self):
        records = parse(":TYPE A\n//:CAPACITY 1\n:CAPACITY 2\n:END\n", TAGS)
        self.assertEqual(records[0]["fields"]["CAPACITY"]["values"], [2])

    def test_multiple_inline_values(self):
        records = parse(":TYPE A\n:CAPACITY 1 2.5 FRONT\n:END", TAGS)
        self.assertEqual(records[0]["fields"]["CAPACITY"]["values"], [1, 2.5, "FRONT"])

    def test_tag_written_without_colon_is_kept_unapplied(self):
        records = parse(":TYPE A\n:TYPE B\nINHERIT_TYPE A \n:CAPACITY 1\n:END\n", TAGS)
        self.assertNotIn("INHERIT_TYPE", records[1]["fields"])
        self.assertEqual(records[1]["untagged"], [{"line": 3, "tokens": ["INHERIT_TYPE", "A"]}])

    def test_name_of_nineteen_bytes(self):
        self.assertEqual(parse(":TYPE " + "N" * 19 + "\n:END\n", TAGS)[0]["type"], "N" * 19)


class ParseRejectTests(unittest.TestCase):
    def reject(self, text, line, fragment):
        with self.assertRaises(TextDatabaseError) as caught:
            parse(text, TAGS)
        self.assertEqual(caught.exception.line, line)
        self.assertIn(fragment, str(caught.exception))
        if line:
            self.assertIn(f"line {line}:", str(caught.exception))

    def test_non_ascii_bytes(self):
        self.reject(":TYPE A\n:CAPACITY 1 // caf\xc3\xa9\n:END\n".encode("latin-1"), 2, "non-ASCII")

    def test_non_ascii_text(self):
        self.reject(":TYPE A\n:END // café\n", 2, "non-ASCII")

    def test_control_character(self):
        self.reject(":TYPE A\n:CAPACITY\x001\n:END\n", 2, "control character")

    def test_bare_carriage_return(self):
        self.reject(":TYPE A\r:END\n", 1, "control character")

    def test_oversized_input(self):
        self.reject(b" " * (MAX_TEXT_BYTES + 1), None, "exceeds")
        self.reject(" " * (MAX_TEXT_BYTES + 1), None, "exceeds")

    def test_tag_before_first_type(self):
        self.reject("// banner\n:CAPACITY 1\n:TYPE A\n:END\n", 2, "before the first :TYPE")

    def test_row_before_first_type(self):
        self.reject("1.0 2.0\n:TYPE A\n:END\n", 1, "before the first :TYPE")

    def test_unknown_tag(self):
        self.reject(":TYPE A\n:NOT_A_TAG 1\n:END\n", 2, "unknown tag")

    def test_duplicate_record_name(self):
        self.reject(":TYPE A\n:TYPE B\n:TYPE A\n:END\n", 3, "duplicate record name")

    def test_name_of_twenty_bytes(self):
        self.reject(":TYPE " + "N" * 20 + "\n:END\n", 1, "char[20]")

    def test_type_without_exactly_one_name(self):
        self.reject(":TYPE\n:END\n", 1, "exactly one name")
        self.reject(":TYPE A B\n:END\n", 1, "exactly one name")

    def test_name_with_punctuation(self):
        self.reject(":TYPE A-B\n:END\n", 1, "characters other than")

    def test_name_may_start_with_digit(self):
        self.assertEqual(parse(":TYPE 46_CONVERTIBLE\n:END\n", TAGS)[0]["type"], "46_CONVERTIBLE")

    def test_inherit_missing_record(self):
        self.reject(":TYPE A\n:INHERIT_TYPE NOWHERE\n:END\n", 2, "not an earlier record")

    def test_inherit_later_record(self):
        self.reject(":TYPE A\n:INHERIT_TYPE B\n:TYPE B\n:END\n", 2, "not an earlier record")

    def test_inherit_self(self):
        self.reject(":TYPE A\n:INHERIT_TYPE A\n:END\n", 2, "not an earlier record")

    def test_inherit_without_exactly_one_name(self):
        self.reject(":TYPE A\n:TYPE B\n:INHERIT_TYPE A A\n:END\n", 3, "exactly one name")

    def test_duplicate_tag_in_record(self):
        self.reject(":TYPE A\n:CAPACITY 1\n\n:CAPACITY 2\n:END\n", 4, "duplicate tag")

    def test_same_tag_in_two_records_is_allowed(self):
        self.assertEqual(len(parse(":TYPE A\n:CAPACITY 1\n:TYPE B\n:CAPACITY 2\n:END\n", TAGS)), 2)

    def test_row_with_no_open_tag(self):
        self.reject(":TYPE A\n:CAPACITY 1\n2.0 3.0\n:END\n", 3, "no open tag")

    def test_row_directly_after_type(self):
        self.reject(":TYPE A\n2.0 3.0\n:END\n", 2, "no open tag")

    def test_unknown_word_without_colon(self):
        self.reject(":TYPE A\nNOT_A_TAG 1\n:END\n", 2, "no open tag")

    def test_missing_end(self):
        self.reject(":TYPE A\n:CAPACITY 1\n\n", 4, "missing :END")

    def test_end_with_values(self):
        self.reject(":TYPE A\n:END 1\n", 2, ":END takes no values")

    def test_content_after_end(self):
        self.reject(":TYPE A\n:END\n// fine\n:TYPE B\n", 4, "after :END on line 2")

    def test_second_end(self):
        self.reject(":TYPE A\n:END\n:END\n", 3, "after :END")

    def test_unparsable_row(self):
        self.reject(":TYPE A\n:TORQUE_ARRAY\n0.0 1.0\n1.0 FAST\n:END\n", 4, "unparsable number")

    def test_ragged_rows(self):
        self.reject(":TYPE A\n:TORQUE_ARRAY\n0.0 1.0\n1.0 2.0 3.0\n:END\n", 4, "3 columns, block has 2")

    def test_open_tag_without_rows(self):
        self.reject(":TYPE A\n:TORQUE_ARRAY\n:CAPACITY 1\n:END\n", 2, "neither values nor rows")
        self.reject(":TYPE A\n:TORQUE_ARRAY\n\n:END\n", 2, "neither values nor rows")

    def test_decimal_overflowing_to_infinity(self):
        self.reject(":TYPE A\n:CAPACITY " + "9" * 400 + ".0\n:END\n", 2, "unparsable number")
        self.reject(":TYPE A\n:TORQUE_ARRAY\n0.0 -" + "9" * 400 + ".0\n:END\n", 3, "unparsable number")

    def test_integer_beyond_digit_limit(self):
        self.reject(":TYPE A\n:CAPACITY " + "9" * 5000 + "\n:END\n", 2, "unparsable number")

    def test_unparsable_value(self):
        self.reject(":TYPE A\n:CAPACITY 1,5\n:END\n", 2, "unparsable value")

    def test_empty_tag_name(self):
        self.reject(":TYPE A\n: 1\n:END\n", 2, "unknown tag")


TYRES = """// Default tyres
:TYPE DEFAULT_ROAD
:RADIUS \t0.1
:CAMBER_THRUST\t\t
\t0  0.0000
\t1\t0.16900

:SOUND_INFO\t\t\t
\t:TYPE TYRE_SAMPLE_TYPE_SQUEAK\t\t
\t:VALUE 2\t\t
\t\t0\t0.00

\t\t1\t0.30   // comment
\t:START_RPM\t0.00\t
\t:SOUND_INFO\t\t
:TYPE TYRE_SAMPLE_TYPE_SQUEAL
:VALUE 1
0 0.80
:START_RPM 1500
:TYPE CHILD
:INHERIT_TYPE DEFAULT_ROAD
:SOUND_INFO
:TYPE TYRE_SAMPLE_TYPE_SQUEAK
:VALUE 1
0 0.5
:START_RPM 0.0
:RADIUS 0.2
:END
"""
SOUND = ":SOUND_INFO\n:TYPE S\n:VALUE 2\n0 0.0\n1 0.5\n:START_RPM 0.0\n"


class ParseSoundInfoTests(unittest.TestCase):
    def reject(self, text, line, fragment):
        with self.assertRaises(TextDatabaseError) as caught:
            parse(text, TAGS, sound_info=True)
        self.assertEqual(caught.exception.line, line)
        self.assertIn(fragment, str(caught.exception))

    def test_nested_entries(self):
        road, child = parse(TYRES.replace("\n", "\r\n").encode("ascii"), TAGS, sound_info=True)
        self.assertEqual(road["sound_info"], [
            {"line": 8, "type": "TYRE_SAMPLE_TYPE_SQUEAK", "value_count": 2, "rows": [[0, 0.0], [1, 0.3]], "start_rpm": 0.0},
            {"line": 15, "type": "TYRE_SAMPLE_TYPE_SQUEAL", "value_count": 1, "rows": [[0, 0.8]], "start_rpm": 1500}])
        self.assertEqual(road["fields"]["CAMBER_THRUST"]["rows"], [[0, 0.0], [1, 0.169]])
        self.assertNotIn("SOUND_INFO", road["fields"])
        self.assertEqual(child["fields"]["INHERIT_TYPE"]["values"], ["DEFAULT_ROAD"])
        self.assertEqual(child["fields"]["RADIUS"]["values"], [0.2])
        self.assertEqual([entry["type"] for entry in child["sound_info"]], ["TYRE_SAMPLE_TYPE_SQUEAK"])

    def test_record_without_entries(self):
        self.assertEqual(parse(":TYPE A\n:RADIUS 1\n:END\n", TAGS, sound_info=True)[0]["sound_info"], [])

    def test_flat_databases_ignore_the_nesting(self):
        records = parse(":TYPE A\n:START_RPM 1\n:END\n", TAGS)
        self.assertEqual(records[0]["fields"]["START_RPM"]["values"], [1])
        self.assertNotIn("sound_info", records[0])
        with self.assertRaisesRegex(TextDatabaseError, "unknown tag 'VALUE'"):
            parse(":TYPE A\n:VALUE 1\n:END\n", TAGS)

    def test_value_outside_entry(self):
        self.reject(":TYPE A\n:VALUE 1\n0 0.0\n:END\n", 2, ":VALUE outside a :SOUND_INFO entry")

    def test_sub_entry_type_outside_entry(self):
        # Without :SOUND_INFO, :TYPE starts a record, so its :VALUE is outside any entry.
        self.reject(":TYPE A\n:TYPE S\n:VALUE 1\n0 0.0\n:START_RPM 0\n:END\n", 3, ":VALUE outside")
        self.reject(":TYPE A\n:TYPE TYRE_SAMPLE_TYPE_SQUEAK\n:VALUE 1\n:END\n", 2, "char[20]")

    def test_start_rpm_outside_entry(self):
        self.reject(":TYPE A\n:START_RPM 0\n:END\n", 2, ":START_RPM outside a :SOUND_INFO entry")

    def test_fewer_rows_than_value(self):
        self.reject(":TYPE A\n" + SOUND.replace("1 0.5\n", "") + ":END\n", 6, "has 1 rows, :VALUE says 2")

    def test_more_rows_than_value(self):
        self.reject(":TYPE A\n" + SOUND.replace("1 0.5\n", "1 0.5\n2 0.5\n") + ":END\n", 7, "beyond its :VALUE 2")

    def test_missing_start_rpm(self):
        self.reject(":TYPE A\n" + SOUND.replace(":START_RPM 0.0\n", "") + SOUND + ":END\n", 7, "expects :START_RPM here")
        self.reject(":TYPE A\n" + SOUND.replace(":START_RPM 0.0\n", ":END\n"), 7, "expects :START_RPM here, not :END")

    def test_duplicate_start_rpm(self):
        self.reject(":TYPE A\n" + SOUND + "\n:START_RPM 1.0\n:END\n", 9, "duplicate :START_RPM")

    def test_unregistered_tag(self):
        self.reject(":TYPE A\n:NOT_A_TAG 1\n:END\n", 2, "unknown tag")
        self.reject(":TYPE A\n" + SOUND.replace(":VALUE", ":NOT_A_TAG") + ":END\n", 4, "expects :VALUE here, not :NOT_A_TAG")

    def test_record_name_of_twenty_bytes(self):
        self.reject(":TYPE " + "N" * 20 + "\n:END\n", 1, "char[20]")

    def test_content_after_end(self):
        self.reject(":TYPE A\n" + SOUND + ":END\n" + SOUND, 9, "after :END on line 8")

    def test_truncated_inside_entry(self):
        self.reject(":TYPE A\n" + SOUND.split(":START_RPM")[0], 7, "file ends inside the :SOUND_INFO entry from line 2")
        self.reject(":TYPE A\n:SOUND_INFO\n", 3, "file ends inside the :SOUND_INFO entry from line 2")

    def test_entry_order(self):
        self.reject(":TYPE A\n:SOUND_INFO\n:VALUE 1\n:END\n", 3, "expects :TYPE here, not :VALUE")
        self.reject(":TYPE A\n:SOUND_INFO\n:TYPE S\n:TYPE T\n:END\n", 4, "expects :VALUE here, not :TYPE")
        self.reject(":TYPE A\n:SOUND_INFO\n:TYPE S\n0 0.0\n:END\n", 4, "before :VALUE")

    def test_entry_values(self):
        self.reject(":TYPE A\n:SOUND_INFO 1\n:END\n", 2, ":SOUND_INFO takes no inline values")
        self.reject(":TYPE A\n" + SOUND.replace(":TYPE S", ":TYPE S T") + ":END\n", 3, "exactly one value")
        self.reject(":TYPE A\n" + SOUND.replace(":TYPE S", ":TYPE 5") + ":END\n", 3, "unparsable sample type")
        self.reject(":TYPE A\n" + SOUND.replace(":VALUE 2", ":VALUE 0") + ":END\n", 4, "positive integer")
        self.reject(":TYPE A\n" + SOUND.replace(":VALUE 2", ":VALUE 2.0") + ":END\n", 4, "positive integer")
        self.reject(":TYPE A\n" + SOUND.replace(":START_RPM 0.0", ":START_RPM FAST") + ":END\n", 7, "unparsable number")
        self.reject(":TYPE A\n" + SOUND.replace(":START_RPM 0.0", ":START_RPM") + ":END\n", 7, "exactly one value")

    def test_row_shape(self):
        self.reject(":TYPE A\n" + SOUND.replace("1 0.5", "1 0.5 2") + ":END\n", 6, "needs an index and a value")
        self.reject(":TYPE A\n" + SOUND.replace("1 0.5", "1 LOUD") + ":END\n", 6, "unparsable number")

    def test_duplicate_sample_type(self):
        self.reject(":TYPE A\n" + SOUND + SOUND + ":END\n", 9, "duplicate sample type 'S'")
        self.assertEqual(len(parse(":TYPE A\n" + SOUND + ":TYPE B\n" + SOUND + ":END\n", TAGS, sound_info=True)), 2)


def tyre_record(name, inherit=None, tables=(), sound=False):
    lines = [f":TYPE {name}"] + ([f":INHERIT_TYPE {inherit}"] if inherit else [])
    for table in tables:
        lines += [f":{table}", "0 1.0"]
    return "\n".join(lines + ([SOUND.rstrip("\n")] if sound else [])) + "\n"


def resolve(*records):
    return resolve_tyre_tables(parse("".join(records) + ":END\n", TAGS, sound_info=True))


ALL = {"tables": TYRE_TABLES, "sound": True}


class ResolveTyreTablesTests(unittest.TestCase):
    def test_local_tables_resolve_to_the_record(self):
        self.assertEqual(resolve(tyre_record("ROOT", **ALL)),
                         {"ROOT": dict.fromkeys([*TYRE_TABLES, "sound_info"], "ROOT")})

    def test_single_level_inheritance(self):
        resolved = resolve(tyre_record("ROOT", **ALL), tyre_record("CHILD", "ROOT"))
        self.assertEqual(resolved["CHILD"], dict.fromkeys([*TYRE_TABLES, "sound_info"], "ROOT"))

    def test_multi_level_inheritance(self):
        resolved = resolve(tyre_record("ROOT", **ALL), tyre_record("A", "ROOT"), tyre_record("B", "A"),
                           tyre_record("C", "B"))
        self.assertEqual(resolved["C"], dict.fromkeys([*TYRE_TABLES, "sound_info"], "ROOT"))

    def test_tables_resolve_to_different_ancestors(self):
        resolved = resolve(tyre_record("ROOT", tables=["LONGITUDINAL_COMBINED_VALUES", "LATERAL_COMBINED_VALUES",
                                                       "VERTICAL_LOAD", "CAMBER_THRUST"], sound=True),
                           tyre_record("MID", "ROOT", ["VERTICAL_LOAD"], sound=True),
                           tyre_record("LEAF", "MID", ["CAMBER_THRUST"]))
        self.assertEqual(resolved["LEAF"], {"LONGITUDINAL_COMBINED_VALUES": "ROOT", "LATERAL_COMBINED_VALUES": "ROOT",
                                            "VERTICAL_LOAD": "MID", "CAMBER_THRUST": "LEAF", "sound_info": "MID"})
        self.assertEqual(resolved["MID"]["CAMBER_THRUST"], "ROOT")
        self.assertEqual(table_sources(resolved)["VERTICAL_LOAD"], {"ROOT": 1, "MID": 2})

    def test_missing_table_at_chain_end(self):
        text = tyre_record("ROOT", tables=["VERTICAL_LOAD"]) + tyre_record("CHILD", "ROOT", ["CAMBER_THRUST"])
        with self.assertRaises(TextDatabaseError) as caught:
            resolve(text)
        self.assertEqual(caught.exception.line, 1)
        self.assertIn("tyre 'ROOT' has no LONGITUDINAL_COMBINED_VALUES table", str(caught.exception))
        self.assertIn("chain ends at 'ROOT'", str(caught.exception))

    def test_missing_sound_info_names_the_child(self):
        records = parse(tyre_record("ROOT", tables=TYRE_TABLES) + tyre_record("CHILD", "ROOT") + ":END\n", TAGS,
                        sound_info=True)
        with self.assertRaisesRegex(TextDatabaseError, "tyre 'ROOT' has no sound_info table"):
            resolve_tyre_tables(records)
        with self.assertRaisesRegex(TextDatabaseError, "tyre 'CHILD' has no sound_info table, .* ends at 'ROOT'"):
            resolve_tyre_tables(records[1:] + records[:1])

    def test_records_are_not_mutated(self):
        records = parse(tyre_record("ROOT", **ALL) + tyre_record("CHILD", "ROOT") + ":END\n", TAGS, sound_info=True)
        before = copy.deepcopy(records)
        resolve_tyre_tables(records)
        self.assertEqual(records, before)

    def test_defensive_bounds(self):
        records = parse(tyre_record("A", "") + tyre_record("B", "A") + ":END\n", TAGS, sound_info=True)
        records[0]["fields"]["INHERIT_TYPE"] = {"line": 1, "values": ["B"], "rows": []}
        with self.assertRaisesRegex(TextDatabaseError, "chain of tyre 'A' does not end within 2 records"):
            resolve_tyre_tables(records)
        records[0]["fields"]["INHERIT_TYPE"]["values"] = ["MISSING"]
        with self.assertRaisesRegex(TextDatabaseError, "'A' inherits unknown record 'MISSING'"):
            resolve_tyre_tables(records)


def parse_tyres(*records):
    return parse("".join(records) + ":END\n", TAGS, sound_info=True)


def provenance_paths(provenance, name):
    return {table: entry["path"] for table, entry in provenance[name].items()}


# ROOT declares its tables on lines 2, 4, 6 and 8 and its :SOUND_INFO on line 10.
ROOT_LINES = {"LONGITUDINAL_COMBINED_VALUES": 2, "LATERAL_COMBINED_VALUES": 4, "VERTICAL_LOAD": 6,
              "CAMBER_THRUST": 8, "sound_info": 10}


class TyreTableProvenanceTests(unittest.TestCase):
    def test_local_tables(self):
        provenance = tyre_table_provenance(parse_tyres(tyre_record("ROOT", **ALL)))
        self.assertEqual(provenance["ROOT"], {
            table: {"source": "ROOT", "path": ["ROOT"], "source_line": ROOT_LINES[table], **TYRE_TABLE_ACCESSORS[table]}
            for table in RESOLVED_TYRE_TABLES})

    def test_one_hop(self):
        provenance = tyre_table_provenance(parse_tyres(tyre_record("ROOT", **ALL), tyre_record("CHILD", "ROOT")))
        self.assertEqual(provenance_paths(provenance, "CHILD"), dict.fromkeys(RESOLVED_TYRE_TABLES, ["CHILD", "ROOT"]))
        self.assertEqual({table: entry["source_line"] for table, entry in provenance["CHILD"].items()}, ROOT_LINES)

    def test_multi_hop(self):
        provenance = tyre_table_provenance(parse_tyres(tyre_record("ROOT", **ALL), tyre_record("A", "ROOT"),
                                                       tyre_record("B", "A"), tyre_record("C", "B")))
        self.assertEqual(provenance_paths(provenance, "C"), dict.fromkeys(RESOLVED_TYRE_TABLES, ["C", "B", "A", "ROOT"]))
        self.assertEqual(provenance["C"]["VERTICAL_LOAD"]["source_line"], 6)

    def test_tables_from_different_ancestors(self):
        records = parse_tyres(tyre_record("ROOT", **ALL), tyre_record("MID", "ROOT", ["VERTICAL_LOAD"], sound=True),
                              tyre_record("LEAF", "MID", ["CAMBER_THRUST"]))
        provenance = tyre_table_provenance(records)
        self.assertEqual(provenance_paths(provenance, "LEAF"), {
            "LONGITUDINAL_COMBINED_VALUES": ["LEAF", "MID", "ROOT"], "LATERAL_COMBINED_VALUES": ["LEAF", "MID", "ROOT"],
            "VERTICAL_LOAD": ["LEAF", "MID"], "CAMBER_THRUST": ["LEAF"], "sound_info": ["LEAF", "MID"]})
        self.assertEqual({table: entry["source_line"] for table, entry in provenance["LEAF"].items()},
                         {"LONGITUDINAL_COMBINED_VALUES": 2, "LATERAL_COMBINED_VALUES": 4, "VERTICAL_LOAD": 18,
                          "CAMBER_THRUST": 28, "sound_info": 20})
        resolved = resolve_tyre_tables(records)
        self.assertEqual({name: {table: entry["source"] for table, entry in tables.items()}
                          for name, tables in provenance.items()}, resolved)
        check_table_provenance(records, provenance)

    def test_sound_info_line_is_the_first_entry(self):
        sound = SOUND + SOUND.replace(":TYPE S", ":TYPE T")
        records = parse_tyres(tyre_record("ROOT", tables=TYRE_TABLES) + "\n// gap\n" + sound,
                              tyre_record("CHILD", "ROOT"))
        self.assertEqual([entry["line"] for entry in records[0]["sound_info"]], [12, 18])
        self.assertEqual(tyre_table_provenance(records)["CHILD"]["sound_info"]["source_line"], 12)

    def test_sources_in_file_order_match_resolve_tyre_tables(self):
        records = parse_tyres(tyre_record("ROOT", **ALL), tyre_record("A", "ROOT"),
                              tyre_record("B", "A", ["VERTICAL_LOAD"]), tyre_record("C", "B"))
        self.assertEqual(sources_in_file_order(records), resolve_tyre_tables(records))
        self.assertEqual(sources_in_file_order(records)["C"]["VERTICAL_LOAD"], "B")

    def test_errors_match_resolve_tyre_tables(self):
        records = parse(tyre_record("ROOT", tables=TYRE_TABLES) + tyre_record("CHILD", "ROOT") + ":END\n", TAGS,
                        sound_info=True)
        with self.assertRaisesRegex(TextDatabaseError, "tyre 'ROOT' has no sound_info table"):
            tyre_table_provenance(records)

    def test_records_are_not_mutated(self):
        records = parse_tyres(tyre_record("ROOT", **ALL), tyre_record("CHILD", "ROOT"))
        before = copy.deepcopy(records)
        tyre_table_provenance(records)
        scalar_inheritance(records)
        self.assertEqual(records, before)


class CheckTableProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.records = parse_tyres(tyre_record("ROOT", **ALL), tyre_record("MID", "ROOT", ["VERTICAL_LOAD"]),
                                   tyre_record("LEAF", "MID"))
        self.provenance = tyre_table_provenance(self.records)

    def reject(self, fragment, edit):
        provenance = copy.deepcopy(self.provenance)
        edit(provenance)
        with self.assertRaisesRegex(ValueError, fragment):
            check_table_provenance(self.records, provenance)

    def test_valid(self):
        check_table_provenance(self.records, self.provenance)

    def test_path_must_start_at_its_record(self):
        self.reject("does not start at its record",
                    lambda p: p["LEAF"]["VERTICAL_LOAD"].update(path=["MID"], source="MID"))

    def test_hops_must_follow_inherit_type(self):
        self.reject("hop LEAF -> ROOT does not follow INHERIT_TYPE",
                    lambda p: p["LEAF"]["LATERAL_COMBINED_VALUES"].update(path=["LEAF", "ROOT"]))

    def test_path_must_not_skip_a_local_table(self):
        self.reject("hop MID -> ROOT does not follow INHERIT_TYPE", lambda p: p["LEAF"]["VERTICAL_LOAD"].update(
            path=["LEAF", "MID", "ROOT"], source="ROOT", source_line=6))

    def test_source_must_declare_the_table_on_source_line(self):
        self.reject("does not declare the table on source_line",
                    lambda p: p["LEAF"]["VERTICAL_LOAD"].update(source_line=6))
        self.reject("does not declare the table on source_line",
                    lambda p: p["LEAF"]["CAMBER_THRUST"].update(path=["LEAF", "MID"], source="MID"))

    def test_source_must_be_the_path_end(self):
        self.reject("source is not the path end", lambda p: p["LEAF"]["VERTICAL_LOAD"].update(source="ROOT"))

    def test_accessor_must_match(self):
        self.reject("accessor mismatch", lambda p: p["MID"]["sound_info"].update(record_offset="0x50"))

    def test_every_record_and_table(self):
        self.reject("record set mismatch", lambda p: p.pop("MID"))
        self.reject("table set mismatch", lambda p: p["MID"].pop("sound_info"))


class ScalarInheritanceTests(unittest.TestCase):
    def test_tags_before_and_after_inherit_type(self):
        records = parse_tyres(tyre_record("ROOT", **ALL),
                              ":TYPE CHILD\n:WIDTH 0.2\n:RADIUS 0.3\n:VERTICAL_LOAD\n0 1.0\n:INHERIT_TYPE ROOT\n"
                              + SOUND + ":MASS 9\n:CAMBER_THRUST\n0 1.0\n:ROLLING_RESISTANCE 0.01\n")
        self.assertEqual(scalar_inheritance(records), {"CHILD": {
            "status": "unresolved", "inherit_type": {"line": 21, "parent": "ROOT"},
            "scalars_before": [{"tag": "WIDTH", "line": 17}, {"tag": "RADIUS", "line": 18}],
            "scalars_after": [{"tag": "MASS", "line": 28}, {"tag": "ROLLING_RESISTANCE", "line": 31}]}})

    def test_record_without_inherit_type_has_no_entry(self):
        records = parse_tyres(":TYPE ROOT\n:RADIUS 0.3\n", tyre_record("CHILD", "ROOT"))
        self.assertEqual(scalar_inheritance(records), {"CHILD": {
            "status": "unresolved", "inherit_type": {"line": 4, "parent": "ROOT"},
            "scalars_before": [], "scalars_after": []}})


ASM_LINE = re.compile(r"([0-9a-f]{8}) [0-9a-f]+ +(.*?) *\Z")
FIELD_OFFSET = re.compile(r"dword ptr \[eax \+ (0x[0-9a-f]+)\]")


def accessor_routines():
    lines = (text_database.REPO_ROOT / "analysis/selected/tyre_table_accessors.asm").read_text().splitlines()
    return [(int(match[1], 16), match[2]) for match in map(ASM_LINE.match, lines) if match]


class TyreTableAccessorEvidenceTests(unittest.TestCase):
    def test_accessors_test_the_recorded_offset_and_hop_through_0x14(self):
        instructions = accessor_routines()
        by_address = dict(instructions)
        for table, evidence in TYRE_TABLE_ACCESSORS.items():
            with self.subTest(table=table):
                start = [address for address, _ in instructions].index(int(evidence["accessor"], 16))
                routine = []
                for address, text in instructions[start:]:
                    routine.append((address, text))
                    if text == "ret":
                        break
                loads = [FIELD_OFFSET.search(text) for _, text in routine]
                self.assertEqual(next(load[1] for load in loads if load), evidence["record_offset"])
                texts = [text for _, text in routine]
                hop = texts.index("mov eax, dword ptr [eax + 0x14]")
                # The hop jumps back to a re-test of the same offset, so the accessor follows any depth.
                jump = re.fullmatch(r"jmp (0x[0-9a-f]+)", texts[hop + 1])
                self.assertIsNotNone(jump)
                retest = FIELD_OFFSET.search(by_address[int(jump[1], 16)])
                self.assertEqual(retest[1], evidence["record_offset"])

    def test_offsets_match_the_recovered_layout(self):
        header = (text_database.REPO_ROOT / "recovered/fr3_database_layouts.h").read_text()
        body = header[:header.index("} Fr3TyreRecord;")].rsplit("typedef struct {", 1)[1]
        offsets, offset = {}, 0
        for kind, name, count in re.findall(r"(char|uint32_t|float) (\w+)(?:\[(\d+)\])?;", body):
            offsets[name] = offset
            offset += (1 if kind == "char" else 4) * int(count or 1)
        self.assertEqual(offset, 0x58)
        self.assertEqual(offsets["inherited_address"], 0x14)
        fields = {"LONGITUDINAL_COMBINED_VALUES": "longitudinal_table_address",
                  "LATERAL_COMBINED_VALUES": "lateral_table_address", "VERTICAL_LOAD": "vertical_load_address",
                  "CAMBER_THRUST": "camber_thrust_address", "sound_info": "sound_info_address"}
        self.assertEqual({table: hex(offsets[field]) for table, field in fields.items()},
                         {table: evidence["record_offset"] for table, evidence in TYRE_TABLE_ACCESSORS.items()})

    def test_offsets_match_the_analysis_table(self):
        analysis = (text_database.REPO_ROOT / "docs/analysis.md").read_text()
        rows = re.findall(r"^\| `(0x[0-9a-f]{8})` \| `(0x[0-9a-f]+)` \| `:?(\w+)`", analysis, re.M)
        documented = {("sound_info" if table == "SOUND_INFO" else table): {"accessor": accessor, "record_offset": offset}
                      for accessor, offset, table in rows}
        self.assertEqual(documented, TYRE_TABLE_ACCESSORS)


# Each table accessor ends before the next routine starts 0x20 bytes later (tyre_table_accessors.asm).
ACCESSOR_SPAN = 0x20
HOP = "mov eax, dword ptr [eax + 0x14]"


def decoded_evidence():
    """Decode every byte-checked instruction site in extract_selected.EVIDENCE."""
    decoder = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    sites = []
    for va, expected, _ in EVIDENCE:
        raw = bytes.fromhex(expected)
        instructions = list(decoder.disasm(raw, va))
        if len(instructions) != 1 or instructions[0].size != len(raw):
            raise AssertionError(f"0x{va:08x}: evidence bytes are not exactly one instruction")
        sites.append((va, f"{instructions[0].mnemonic} {instructions[0].op_str}"))
    return sites


def unevidenced_accessors(accessors, sites):
    """List each table whose accessor has no evidence site reading its offset, or none loading + 0x14."""
    problems = []
    for table, entry in accessors.items():
        start, offset = int(entry["accessor"], 16), re.escape(entry["record_offset"])
        texts = [text for va, text in sites if start <= va < start + ACCESSOR_SPAN]
        read = re.compile(rf"mov \w+, dword ptr \[eax \+ {offset}\]|cmp dword ptr \[eax \+ {offset}\], 0")
        if not any(read.fullmatch(text) for text in texts):
            problems.append(f"{table}: no evidence that {entry['accessor']} reads + {entry['record_offset']}")
        if HOP not in texts:
            problems.append(f"{table}: no evidence that {entry['accessor']} loads + 0x14")
    return problems


@unittest.skipIf(capstone is None, "needs capstone and pefile from scripts/requirements.txt")
class TyreTableAccessorByteEvidenceTests(unittest.TestCase):
    def test_field_evidence_matches_extract_selected(self):
        recorded = json.loads((text_database.REPO_ROOT / "analysis/selected/field-evidence.json").read_text())
        self.assertEqual(recorded, [{"va": va, "bytes": expected, "claim": claim} for va, expected, claim in EVIDENCE])

    def test_every_accessor_read_and_fallback_is_byte_checked(self):
        self.assertEqual(unevidenced_accessors(TYRE_TABLE_ACCESSORS, decoded_evidence()), [])

    def test_drifted_accessor_or_offset_has_no_evidence(self):
        sites = decoded_evidence()
        for table in TYRE_TABLE_ACCESSORS:
            for key, wrong in (("accessor", "0x00523ed0"), ("record_offset", "0x40")):
                with self.subTest(table=table, key=key):
                    drifted = copy.deepcopy(TYRE_TABLE_ACCESSORS)
                    drifted[table][key] = wrong
                    self.assertTrue(unevidenced_accessors(drifted, sites))
        swapped = copy.deepcopy(TYRE_TABLE_ACCESSORS)
        swapped["VERTICAL_LOAD"]["accessor"], swapped["CAMBER_THRUST"]["accessor"] = "0x00523e70", "0x00523e50"
        self.assertEqual(len(unevidenced_accessors(swapped, sites)), 2)

    def test_loader_stores_every_table_offset(self):
        start, end = next((start, end) for start, end, name in ROUTINES if name == "load_tyre_database")
        texts = [text for va, text in decoded_evidence() if start <= va < end]
        for table, entry in TYRE_TABLE_ACCESSORS.items():
            with self.subTest(table=table):
                store = re.compile(rf"mov dword ptr \[\w+ \+ {re.escape(entry['record_offset'])}\], \w+")
                self.assertTrue(any(store.fullmatch(text) for text in texts))


def engine_file():
    lines = [":TYPE BASE0"]
    for i in range(5):
        if i:
            lines.append(f":TYPE BASE{i}")
        lines += [":TORQUE_ARRAY"] + [f"{rpm}.0 100.0" for rpm in range(5 + i)]
    for i in range(51):
        lines += [f":TYPE {'INDIGO' if i == 50 else f'CHILD{i}'}", f":INHERIT_TYPE BASE{i % 5}"]
        if i < 38:
            lines += [":TORQUE_ARRAY"] + [f"{rpm}.0 100.0" for rpm in range(10)]
    # Mirror the demo's single colon-less tag line, which sits on line 1410 inside INDIGO.
    lines += ["//"] * (1409 - len(lines)) + ["INHERIT_TYPE DEFAULT_TRACK", ":END"]
    return "\r\n".join(lines) + "\r\n"


def gearbox_file(tags=GEARBOX_TAGS):
    lines = []
    for i in range(14):
        lines += [f":TYPE GEAR{i}"] + [f":{tag} 0" for tag in sorted(tags)]
    return "\n".join(lines + [":END"]) + "\n"


# Mirror the demo: 72 further tyres inherit DEFAULT_ROAD, 22 DEFAULT_OFFROAD and 12 DEFAULT_TRACK.
DEMO_PARENTS = ["DEFAULT_ROAD"] * 72 + ["DEFAULT_OFFROAD"] * 22 + ["DEFAULT_TRACK"] * 12


def tyre_file(sounds=SOUND_INFO_COUNTS, parents=DEMO_PARENTS, scalar_first=()):
    lines = []
    names = ["DEFAULT_ROAD", "DEFAULT_OFFROAD", "DEFAULT_TRACK"] + [f"TYRE{i}" for i in range(len(parents))]
    parents = [None, "DEFAULT_ROAD", "DEFAULT_ROAD", *parents]
    for i, name in enumerate(names):
        # Like the demo, scalars follow INHERIT_TYPE unless scalar_first names the record.
        inherit = [f":INHERIT_TYPE {parents[i]}"] if parents[i] else []
        lines += [f":TYPE {name}"] + ([":RADIUS 0.3", *inherit] if name in scalar_first else [*inherit, ":RADIUS 0.3"])
        if i == 0:
            lines += [":LONGITUDINAL_COMBINED_VALUES"] + ["\t".join(["0.5"] * 11)] * 9
            lines += [":LATERAL_COMBINED_VALUES"] + ["\t".join(["0.5"] * 21)] * 10
        if i < 3:
            lines += [":VERTICAL_LOAD"] + [f"{j} 1.0" for j in range(10)]
            lines += [":CAMBER_THRUST"] + [f"{j} 0.5" for j in range(10)]
        for j in range(sounds.get(name, 0)):
            lines += ["\t:SOUND_INFO", f"\t:TYPE TYRE_SAMPLE_TYPE_{j}", "\t:VALUE 10"]
            lines += [f"\t\t{k}\t0.00" for k in range(10)] + ["\t:START_RPM\t0.00"]
    return "\r\n".join(lines + [":END"]) + "\r\n"


class VerifyTextDatabaseTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.game = Path(directory.name)
        (self.game / "DATA/ASCII/CARS").mkdir(parents=True)
        self.write("engines", engine_file())
        self.write("gearboxes", gearbox_file())
        self.write("tyres", tyre_file())

    def write(self, stem, text):
        (self.game / text_database.DATABASES[stem]).write_text(text, newline="")

    def test_synthetic_counts_pass(self):
        summary = verify_text_databases(self.game, TAGS)
        self.assertEqual(summary["engine_records"], 56)
        self.assertEqual(summary["gearbox_records"], 14)
        self.assertEqual(summary["torque_arrays"], 43)
        self.assertEqual(summary["torque_rows"], [5, 10])
        self.assertEqual(summary["engine_inheritances"], 51)
        self.assertEqual(summary["untagged_lines"], [{"record": "INDIGO", "line": 1410, "tokens": ["INHERIT_TYPE", "DEFAULT_TRACK"]}])
        self.assertEqual(summary["tyre_records"], 109)
        self.assertEqual(summary["tyre_inheritances"], 108)
        self.assertEqual(summary["tyre_tables"], TYRE_TABLES)
        self.assertEqual(summary["tyre_table_sources"], TYRE_TABLE_SOURCES)
        self.assertEqual(summary["tyre_scalar_inheritance_records"], 108)
        self.assertEqual(summary["sound_info_entries"], 40)
        self.assertEqual(summary["sound_info_per_record"], SOUND_INFO_COUNTS)

    def test_read_database_records_sound_info(self):
        records = read_database(self.game, text_database.DATABASES["tyres"], TAGS, sound_info=True)["records"]
        entry = records[0]["sound_info"][0]
        self.assertEqual((entry["type"], entry["value_count"], len(entry["rows"]), entry["start_rpm"]),
                         ("TYRE_SAMPLE_TYPE_0", 10, 10, 0.0))

    def test_read_database_records_identity(self):
        database = read_database(self.game, text_database.DATABASES["gearboxes"], TAGS)
        data = (self.game / text_database.DATABASES["gearboxes"]).read_bytes()
        self.assertEqual(database["source"], "DATA/ASCII/CARS/GEARDATA.DAT")
        self.assertEqual(database["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(len(database["records"]), 14)

    def test_reject_missing_gearbox_tag(self):
        self.write("gearboxes", gearbox_file(GEARBOX_TAGS - {"DIFF_TYPE"}))
        with self.assertRaisesRegex(ValueError, "Gearbox tag set mismatch"):
            verify_text_databases(self.game, TAGS)

    def test_reject_wrong_sound_entry_count(self):
        self.write("tyres", tyre_file({**SOUND_INFO_COUNTS, "DEFAULT_TRACK": 11}))
        with self.assertRaisesRegex(ValueError, "Sound entry count mismatch"):
            verify_text_databases(self.game, TAGS)

    def test_reject_wrong_tyre_table_shape(self):
        self.write("tyres", tyre_file().replace("\t".join(["0.5"] * 11) + "\r\n", "", 1))
        with self.assertRaisesRegex(ValueError, "Tyre table dimensions mismatch"):
            verify_text_databases(self.game, TAGS)

    def test_reject_wrong_tyre_table_source(self):
        self.write("tyres", tyre_file(parents=["DEFAULT_ROAD"] * 73 + ["DEFAULT_OFFROAD"] * 21 + ["DEFAULT_TRACK"] * 12))
        with self.assertRaisesRegex(ValueError, "Tyre table source mismatch"):
            verify_text_databases(self.game, TAGS)

    def test_main_writes_resolved_tables(self):
        output = self.game / "out"
        argv = ["text_database.py", str(self.game), "--output", str(output),
                "--tags", str(text_database.REPO_ROOT / "analysis/tags.json")]
        with mock.patch.object(sys, "argv", argv), mock.patch("builtins.print"):
            text_database.main()
        tyres = json.loads((output / "tyres.json").read_text())
        expected = read_database(self.game, text_database.DATABASES["tyres"], TAGS, sound_info=True)
        self.assertEqual(list(tyres), ["source", "sha256", "records", "resolved_tables", "table_provenance",
                                       "scalar_inheritance"])
        self.assertEqual(tyres["records"], expected["records"])
        self.assertEqual(tyres["resolved_tables"], resolve_tyre_tables(expected["records"]))
        self.assertEqual(tyres["resolved_tables"]["TYRE100"]["VERTICAL_LOAD"], "DEFAULT_TRACK")
        # The keys written before table_provenance existed keep their exact bytes.
        text = (output / "tyres.json").read_text()
        legacy = {key: tyres[key] for key in ("source", "sha256", "records", "resolved_tables")}
        self.assertTrue(text.startswith(json.dumps(legacy, indent=2, allow_nan=False)[:-2] + ",\n"))
        self.assertEqual(tyres["table_provenance"], tyre_table_provenance(expected["records"]))
        self.assertEqual(tyres["table_provenance"]["TYRE100"]["VERTICAL_LOAD"],
                         {"source": "DEFAULT_TRACK", "path": ["TYRE100", "DEFAULT_TRACK"], "source_line": 466,
                          "accessor": "0x00523e50", "record_offset": "0x4c"})
        self.assertEqual(len(tyres["table_provenance"]), 109)
        self.assertTrue(all(len(tables) == 5 for tables in tyres["table_provenance"].values()))
        self.assertEqual(tyres["scalar_inheritance"], scalar_inheritance(expected["records"]))
        self.assertEqual(len(tyres["scalar_inheritance"]), 108)
        self.assertNotIn("DEFAULT_ROAD", tyres["scalar_inheritance"])
        self.assertNotIn("resolved_tables", json.loads((output / "engines.json").read_text()))

    def test_reject_bad_table_provenance(self):
        def tampered(records):
            provenance = tyre_table_provenance(records)
            provenance["TYRE100"]["VERTICAL_LOAD"]["source_line"] += 1
            return provenance
        with mock.patch.object(text_database, "tyre_table_provenance", tampered), \
                self.assertRaisesRegex(ValueError, "does not declare the table on source_line: TYRE100 VERTICAL_LOAD"):
            verify_text_databases(self.game, TAGS)

    def test_reject_sources_that_disagree_with_inherit_type(self):
        # Swapping two sources keeps the per-table counts, so only the independent resolution catches it.
        def tampered(records):
            resolved = resolve_tyre_tables(records)
            resolved["TYRE0"]["VERTICAL_LOAD"], resolved["TYRE100"]["VERTICAL_LOAD"] = "DEFAULT_TRACK", "DEFAULT_ROAD"
            return resolved
        with mock.patch.object(text_database, "resolve_tyre_tables", tampered), \
                self.assertRaisesRegex(ValueError, "resolved_tables disagrees with INHERIT_TYPE resolved in file order"):
            verify_text_databases(self.game, TAGS)

    def test_reject_scalar_before_inherit_type(self):
        self.write("tyres", tyre_file(scalar_first={"TYRE5"}))
        with self.assertRaisesRegex(ValueError, "Tyre scalars declared before INHERIT_TYPE: TYRE5"):
            verify_text_databases(self.game, TAGS)

    def test_reject_wrong_scalar_inheritance_records(self):
        def tampered(records):
            entries = scalar_inheritance(records)
            del entries["TYRE5"]
            return entries
        with mock.patch.object(text_database, "scalar_inheritance", tampered), \
                self.assertRaisesRegex(ValueError, "Tyre scalar inheritance record set mismatch"):
            verify_text_databases(self.game, TAGS)

    def test_reject_wrong_engine_count(self):
        self.write("engines", engine_file().replace(":TYPE CHILD49\r\n:INHERIT_TYPE BASE4\r\n", ""))
        with self.assertRaisesRegex(ValueError, "Engine record count mismatch"):
            verify_text_databases(self.game, TAGS)


if __name__ == "__main__":
    unittest.main()
