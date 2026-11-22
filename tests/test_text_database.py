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
from text_database import (ENGINE_COPY, ENGINE_FIELD_COUNTS, ENGINE_FIELD_STORES, ENGINE_LOADER_SPAN, byte_ranges,
                           check_effective_engine_fields, compare_immediate, effective_engine_fields,
                           engine_field_counts, engine_fields_by_recursion, torque_without_own_max_rpm,
                           untagged_inherit_consequences,
                           engine_evidence_problems, engine_layout_problems, load_layout_header, load_tag_ids,
                           memory_operand, unmapped_engine_tags)
from text_database import (GEARBOX_COPY, GEARBOX_FIELD_STORES, GEARBOX_LOADER_SPAN, GEARBOX_RECORD,
                           gearbox_evidence_problems, gearbox_layout_problems, unmapped_gearbox_tags)
from text_database import (GEARBOX_TAGS, MAX_TEXT_BYTES, RESOLVED_TYRE_TABLES, SCALAR_COPY_CALL, SCALAR_COPY_OFFSETS,
                           SCALAR_COPY_SPAN, SOUND_INFO_COUNTS, TYRE_SCALAR_COUNTS, TYRE_SCALAR_STORES,
                           TYRE_TABLE_ACCESSORS, TYRE_TABLE_SOURCES, TYRE_TABLES, UNMAPPED, ZERO_FILLED,
                           TextDatabaseError, check_effective_scalars, check_table_provenance, effective_scalars,
                           load_field_evidence, parse, read_database, resolve_tyre_tables, scalar_counts,
                           scalar_evidence_problems, scalars_by_recursion, sources_in_file_order, table_sources,
                           tyre_table_provenance, verify_text_databases)

# Only the disassembly tests need capstone, and extract_selected also imports pefile.
try:
    import capstone
    from extract_selected import DATA_EVIDENCE, EVIDENCE, ROUTINES, evidence_sites
except ImportError:
    capstone = None

TAGS = {"CAPACITY", "LOCATION_TYPE", "INHERIT_TYPE", "TORQUE_ARRAY", "MAX_RPM", "ENGINE_BRAKING", *GEARBOX_TAGS,
        *ENGINE_FIELD_STORES,
        *TYRE_SCALAR_STORES, "SOUND_INFO", "START_RPM", *TYRE_TABLES}
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
        effective_scalars(records)
        scalars_by_recursion(records)
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


def offsets(tag):
    return list(TYRE_SCALAR_STORES[tag]["offsets"])


def declared(tag, source, line, values, path):
    status = "declared" if path == [source] else "inherited"
    return {"status": status, "values": values, "source": source, "source_line": line, "path": path,
            "offsets": offsets(tag)}


class EffectiveScalarsTests(unittest.TestCase):
    def fields(self, records, name):
        effective = effective_scalars(records)
        # Every case also checks the independent derivation agrees with the file-order replay.
        check_effective_scalars(records, effective)
        return effective[name]["fields"]

    def test_declaration_before_inherit_type_is_overwritten_by_the_parent(self):
        records = parse_tyres(":TYPE ROOT\n:WIDTH 0.2\n", ":TYPE CHILD\n:WIDTH 0.9\n:RADIUS 0.4\n:INHERIT_TYPE ROOT\n")
        entry = effective_scalars(records)["CHILD"]
        self.assertEqual(entry["fields"]["WIDTH"], declared("WIDTH", "ROOT", 2, [0.2], ["CHILD", "ROOT"]))
        # ROOT never declares RADIUS, so the copy overwrites CHILD's with ROOT's zero.
        self.assertEqual(entry["fields"]["RADIUS"], {"status": ZERO_FILLED, "path": ["CHILD", "ROOT"],
                                                     "offsets": ["0x28", "0x3c"]})
        self.assertEqual(entry["overwritten"], [{"tag": "WIDTH", "line": 4, "values": [0.9]},
                                                {"tag": "RADIUS", "line": 5, "values": [0.4]}])
        check_effective_scalars(records, effective_scalars(records))

    def test_declaration_after_inherit_type_overrides_the_parent(self):
        records = parse_tyres(":TYPE ROOT\n:MASS 30\n:WIDTH 0.2\n", ":TYPE CHILD\n:INHERIT_TYPE ROOT\n:MASS 45.0\n")
        fields = self.fields(records, "CHILD")
        self.assertEqual(fields["MASS"], declared("MASS", "CHILD", 6, [45.0], ["CHILD"]))
        self.assertEqual(fields["WIDTH"], declared("WIDTH", "ROOT", 3, [0.2], ["CHILD", "ROOT"]))
        self.assertEqual(effective_scalars(records)["CHILD"]["overwritten"], [])

    def test_multi_level_chain(self):
        records = parse_tyres(":TYPE ROOT\n:RADIUS 0.3\n:WIDTH 0.2\n", ":TYPE MID\n:INHERIT_TYPE ROOT\n:WIDTH 0.25\n",
                              ":TYPE LEAF\n:INHERIT_TYPE MID\n:ROAD_MAGIC_GRIP_NUMBER 37.4\n")
        fields = self.fields(records, "LEAF")
        self.assertEqual(fields["RADIUS"], declared("RADIUS", "ROOT", 2, [0.3], ["LEAF", "MID", "ROOT"]))
        self.assertEqual(fields["WIDTH"], declared("WIDTH", "MID", 6, [0.25], ["LEAF", "MID"]))
        self.assertEqual(fields["ROAD_MAGIC_GRIP_NUMBER"],
                         declared("ROAD_MAGIC_GRIP_NUMBER", "LEAF", 9, [37.4], ["LEAF"]))

    def test_a_parent_declaration_the_copy_overwrote_is_not_inherited(self):
        records = parse_tyres(":TYPE ROOT\n", ":TYPE MID\n:RADIUS 0.5\n:INHERIT_TYPE ROOT\n",
                              ":TYPE LEAF\n:INHERIT_TYPE MID\n")
        self.assertEqual(self.fields(records, "LEAF")["RADIUS"]["status"], ZERO_FILLED)

    def test_field_nobody_declares_is_zero_filled_without_a_value(self):
        records = parse_tyres(":TYPE ROOT\n:RADIUS 0.3\n", ":TYPE MID\n:INHERIT_TYPE ROOT\n",
                              ":TYPE LEAF\n:INHERIT_TYPE MID\n")
        fields = self.fields(records, "LEAF")
        self.assertEqual(fields["TYRE_GRIP_DEPTH"], {"status": ZERO_FILLED, "path": ["LEAF", "MID", "ROOT"],
                                                     "offsets": ["0x24"]})
        self.assertEqual(list(fields), list(TYRE_SCALAR_STORES))
        self.assertTrue(all("values" not in field for tag, field in fields.items() if tag != "RADIUS"))

    def test_unmapped_tag_gets_no_value(self):
        records = parse_tyres(":TYPE ROOT\n:LOCATION_TYPE FRONT\n",
                              ":TYPE CHILD\n:INHERIT_TYPE ROOT\n:LOCATION_TYPE REAR\n:WIDTH 0.2\n")
        entry = effective_scalars(records)["CHILD"]
        self.assertEqual(entry["unmapped"], [{"tag": "LOCATION_TYPE", "line": 5, "status": UNMAPPED}])
        self.assertNotIn("LOCATION_TYPE", entry["fields"])
        self.assertNotIn("LOCATION_TYPE", TYRE_SCALAR_STORES)

    def test_tables_and_records_without_inherit_type_are_left_out(self):
        records = parse_tyres(tyre_record("ROOT", **ALL), tyre_record("CHILD", "ROOT", ["VERTICAL_LOAD"]))
        entry = effective_scalars(records)
        self.assertEqual(list(entry), ["CHILD"])
        self.assertEqual(entry["CHILD"]["inherit_type"], {"line": 17, "parent": "ROOT"})
        self.assertFalse(set(entry["CHILD"]["fields"]) & set(TYRE_TABLES))
        self.assertEqual((entry["CHILD"]["overwritten"], entry["CHILD"]["unmapped"]), ([], []))

    def test_inherit_type_naming_a_later_or_missing_record_is_refused(self):
        # parse() already refuses these; build the records by hand so the resolver's own checks run.
        def records(parent):
            return [{"type": "A", "line": 1, "fields": {"INHERIT_TYPE": {"line": 2, "values": [parent], "rows": []}}},
                    {"type": "B", "line": 3, "fields": {"RADIUS": {"line": 4, "values": [0.3], "rows": []}}}]
        for parent in ("B", "MISSING", "A"):
            for resolve in (effective_scalars, scalars_by_recursion):
                with self.subTest(parent=parent, resolve=resolve.__name__), \
                        self.assertRaisesRegex(TextDatabaseError, "which is not an earlier record"):
                    resolve(records(parent))

    def test_independent_derivation_catches_a_planted_mismatch(self):
        records = parse_tyres(":TYPE ROOT\n:RADIUS 0.3\n:WIDTH 0.2\n", ":TYPE MID\n:INHERIT_TYPE ROOT\n:WIDTH 0.25\n",
                              ":TYPE LEAF\n:INHERIT_TYPE MID\n")
        plants = {"value": lambda f: f["WIDTH"].update(values=[0.2]),
                  "source": lambda f: f["WIDTH"].update(source="ROOT", source_line=3, path=["LEAF", "MID", "ROOT"]),
                  "status": lambda f: f["RADIUS"].update(status="declared"),
                  "zero-filled": lambda f: f.update(MASS={**f["RADIUS"], "offsets": ["0x34", "0x38"]}),
                  "missing tag": lambda f: f.pop("MASS")}
        for name, plant in plants.items():
            with self.subTest(plant=name):
                effective = effective_scalars(records)
                plant(effective["LEAF"]["fields"])
                with self.assertRaisesRegex(ValueError, "disagrees with the parent-first derivation: LEAF"):
                    check_effective_scalars(records, effective)
        effective = effective_scalars(records)
        del effective["MID"]
        with self.assertRaisesRegex(ValueError, "Tyre effective scalar record set mismatch"):
            check_effective_scalars(records, effective)

    def test_scalar_counts(self):
        records = parse_tyres(":TYPE ROOT\n:RADIUS 0.3\n", ":TYPE A\n:INHERIT_TYPE ROOT\n:RADIUS 0.4\n",
                              ":TYPE B\n:INHERIT_TYPE ROOT\n")
        counts = scalar_counts(effective_scalars(records))
        self.assertEqual(counts["RADIUS"], {"declared": 1, "inherited": 1})
        self.assertEqual(counts["MASS"], {ZERO_FILLED: 2})


ENGINE_TAGS = {*ENGINE_FIELD_STORES, "INHERIT_TYPE", "ADDITIONAL_BRAKING"}


def parse_engines(*records):
    return parse("".join(records) + ":END\n", ENGINE_TAGS)


def engine_entry(tag, status, path, source=None, line=None, values=None, **extra):
    entry = {"status": status, "path": path, "offsets": list(ENGINE_FIELD_STORES[tag]["offsets"])}
    if status != ZERO_FILLED:
        entry = {"status": status, "values": values, "source": source, "source_line": line, "path": path,
                 "offsets": entry["offsets"]}
    return {**entry, **extra}


def origin(source, line, path):
    return {"status": "declared" if len(path) == 1 else "inherited", "source": source, "source_line": line, "path": path}


def zero(path):
    return {"status": ZERO_FILLED, "path": path}


# A depth-3 chain: ROOT declares MAX_RPM, a torque table and TURBO_MASS; MID and LEAF override one field each.
CHAIN = (":TYPE ROOT\n:CAPACITY 2.0\n:MAX_RPM 6000\n:TORQUE_ARRAY\n0 100\n1000 200\n:TURBO_MASS 0.5\n",
         ":TYPE MID\n:INHERIT_TYPE ROOT\n:ROUGHNESS 0.1\n",
         ":TYPE LEAF\n:INHERIT_TYPE MID\n:CAPACITY 3.5\n",
         ":TYPE TIP\n:INHERIT_TYPE LEAF\n:TORQUE_MODIFIER 1.2\n")


class EffectiveEngineFieldsTests(unittest.TestCase):
    def fields(self, records, name):
        effective = effective_engine_fields(records)
        # Every case also checks that the parent-first derivation agrees with the file-order replay.
        check_effective_engine_fields(records, effective)
        return effective[name]["fields"]

    def test_depth_three_chain_overrides_one_field_and_inherits_the_rest(self):
        records = parse_engines(*CHAIN)
        fields = self.fields(records, "TIP")
        self.assertEqual(list(fields), list(ENGINE_FIELD_STORES))
        self.assertEqual(fields["TORQUE_MODIFIER"], engine_entry("TORQUE_MODIFIER", "declared", ["TIP"], "TIP", 16, [1.2]))
        self.assertEqual(fields["CAPACITY"], engine_entry("CAPACITY", "inherited", ["TIP", "LEAF"], "LEAF", 13, [3.5]))
        self.assertEqual(fields["ROUGHNESS"],
                         engine_entry("ROUGHNESS", "inherited", ["TIP", "LEAF", "MID"], "MID", 10, [0.1]))
        self.assertEqual(fields["MAX_RPM"],
                         engine_entry("MAX_RPM", "inherited", ["TIP", "LEAF", "MID", "ROOT"], "ROOT", 3, [6000]))
        self.assertEqual(fields["FUEL_CUTOFF"], engine_entry("FUEL_CUTOFF", ZERO_FILLED, ["TIP", "LEAF", "MID", "ROOT"]))
        self.assertEqual(self.fields(records, "MID")["CAPACITY"],
                         engine_entry("CAPACITY", "inherited", ["MID", "ROOT"], "ROOT", 2, [2.0]))
        self.assertEqual(set(effective_engine_fields(records)), {"MID", "LEAF", "TIP"})

    def test_declaration_before_inherit_type_is_overwritten(self):
        records = parse_engines(":TYPE ROOT\n:CAPACITY 2.0\n",
                                ":TYPE CHILD\n:CAPACITY 9.0\n:FUEL_CUTOFF 0.7\n:INHERIT_TYPE ROOT\n:ROUGHNESS 0.2\n")
        entry = effective_engine_fields(records)["CHILD"]
        check_effective_engine_fields(records, effective_engine_fields(records))
        self.assertEqual(entry["overwritten"], [{"tag": "CAPACITY", "line": 4, "values": [9.0]},
                                                {"tag": "FUEL_CUTOFF", "line": 5, "values": [0.7]}])
        self.assertEqual(entry["fields"]["CAPACITY"], engine_entry("CAPACITY", "inherited", ["CHILD", "ROOT"], "ROOT", 2, [2.0]))
        # ROOT never declares FUEL_CUTOFF, so the copy overwrites CHILD's with ROOT's zero fill.
        self.assertEqual(entry["fields"]["FUEL_CUTOFF"], engine_entry("FUEL_CUTOFF", ZERO_FILLED, ["CHILD", "ROOT"]))
        self.assertEqual(entry["fields"]["ROUGHNESS"]["status"], "declared")
        self.assertEqual(entry["inherit_type"], {"line": 6, "parent": "ROOT"})

    def test_own_torque_array_replaces_the_whole_parent_table(self):
        records = parse_engines(":TYPE ROOT\n:MAX_RPM 6000\n:TORQUE_ARRAY\n0 1\n1 2\n2 3\n3 4\n",
                                ":TYPE OWN\n:INHERIT_TYPE ROOT\n:MAX_RPM 3000\n:TORQUE_ARRAY\n0 9\n1 8\n",
                                ":TYPE COPY\n:INHERIT_TYPE ROOT\n")
        own = self.fields(records, "OWN")["TORQUE_ARRAY"]
        # Only the child's two rows: the zero fill clears the parent's four before the child's rows are stored.
        self.assertEqual((own["source"], own["source_line"], own["rows"]), ("OWN", 11, [[0, 9], [1, 8]]))
        self.assertEqual(own["offsets"], ["0x2c", "0x3c"])
        copied = self.fields(records, "COPY")["TORQUE_ARRAY"]
        self.assertEqual((copied["status"], copied["source"], copied["source_line"], copied["path"], copied["rows"]),
                         ("inherited", "ROOT", 3, ["COPY", "ROOT"], [[0, 1], [1, 2], [2, 3], [3, 4]]))

    def test_torque_array_names_the_max_rpm_present_when_it_was_parsed(self):
        records = parse_engines(":TYPE ROOT\n:MAX_RPM 6000\n:TORQUE_ARRAY\n0 1\n",
                                ":TYPE OWN\n:INHERIT_TYPE ROOT\n:MAX_RPM 7000\n:TORQUE_ARRAY\n0 2\n",
                                ":TYPE LATE\n:INHERIT_TYPE ROOT\n:TORQUE_ARRAY\n0 3\n:MAX_RPM 8000\n",
                                ":TYPE BARE\n:TORQUE_ARRAY\n0 4\n:MAX_RPM 5000\n",
                                ":TYPE ZERO\n:INHERIT_TYPE BARE\n",
                                ":TYPE EARLY\n:MAX_RPM 1\n:INHERIT_TYPE BARE\n:TORQUE_ARRAY\n0 5\n")
        effective = effective_engine_fields(records)
        check_effective_engine_fields(records, effective)
        rpm = {name: effective[name]["fields"]["TORQUE_ARRAY"]["max_rpm"] for name in ("OWN", "LATE", "ZERO", "EARLY")}
        self.assertEqual(rpm["OWN"], origin("OWN", 7, ["OWN"]))
        # LATE's own MAX_RPM comes after its table, so the table was parsed with the MAX_RPM copied from ROOT.
        self.assertEqual(rpm["LATE"], origin("ROOT", 2, ["LATE", "ROOT"]))
        # BARE's table came before any MAX_RPM, so it was parsed with the zero fill; ZERO inherits that table.
        self.assertEqual(rpm["ZERO"], zero(["BARE"]))
        # EARLY's own MAX_RPM was overwritten by the copy, so its table was parsed with BARE's.
        self.assertEqual(rpm["EARLY"], origin("BARE", 18, ["EARLY", "BARE"]))
        self.assertEqual(torque_without_own_max_rpm(effective),
                         [("LATE", "LATE"), ("ZERO", "BARE"), ("EARLY", "EARLY")])

    def test_derived_offsets_name_their_producers_without_a_value(self):
        records = parse_engines(*CHAIN, ":TYPE TURBO\n:INHERIT_TYPE ROOT\n:TURBO_MASS 0.25\n:TORQUE_ARRAY\n0 7\n")
        tip = self.fields(records, "TIP")
        self.assertEqual(tip["TORQUE_ARRAY"]["derived"], {"0x2c": {
            "label": "derived", "conditional": True,
            "origins": [origin("ROOT", 4, ["TIP", "LEAF", "MID", "ROOT"]), zero(["TIP", "LEAF", "MID", "ROOT"])]}})
        self.assertEqual(tip["TURBO_MASS"]["derived"], {"0xa4": {
            "label": "derived", "conditional": False, "origins": [origin("ROOT", 7, ["TIP", "LEAF", "MID", "ROOT"])]}})
        turbo = self.fields(records, "TURBO")
        # +0x2c may come from TURBO's own table, or keep what the copy brought: ROOT's, or ROOT's zero fill.
        self.assertEqual(turbo["TORQUE_ARRAY"]["derived"]["0x2c"]["origins"],
                         [origin("TURBO", 20, ["TURBO"]), origin("ROOT", 4, ["TURBO", "ROOT"]), zero(["TURBO", "ROOT"])])
        # +0xa4 is always rewritten from TURBO's own TURBO_MASS.
        self.assertEqual(turbo["TURBO_MASS"]["derived"]["0xa4"]["origins"], [origin("TURBO", 19, ["TURBO"])])
        for fields in (tip, turbo):
            for field in fields.values():
                for derived in field.get("derived", {}).values():
                    self.assertTrue(all("values" not in item for item in derived["origins"]))
        self.assertEqual({tag for tag, field in tip.items() if "derived" in field}, {"TORQUE_ARRAY", "TURBO_MASS"})

    def test_unmapped_tag_gets_no_value(self):
        records = parse_engines(":TYPE ROOT\n", ":TYPE CHILD\n:INHERIT_TYPE ROOT\n:ADDITIONAL_BRAKING 1\n")
        entry = effective_engine_fields(records)["CHILD"]
        self.assertEqual(entry["unmapped"], [{"tag": "ADDITIONAL_BRAKING", "line": 4, "status": UNMAPPED}])
        self.assertNotIn("ADDITIONAL_BRAKING", entry["fields"])

    def test_inherit_type_naming_a_later_or_missing_record_is_refused(self):
        def records(parent):
            return [{"type": "A", "line": 1, "fields": {"INHERIT_TYPE": {"line": 2, "values": [parent], "rows": []}},
                     "untagged": []},
                    {"type": "B", "line": 3, "fields": {"CAPACITY": {"line": 4, "values": [1], "rows": []}}, "untagged": []}]
        for parent in ("B", "MISSING", "A"):
            for resolve in (effective_engine_fields, engine_fields_by_recursion):
                with self.subTest(parent=parent, resolve=resolve.__name__), \
                        self.assertRaisesRegex(TextDatabaseError, "which is not an earlier record"):
                    resolve(records(parent))

    def test_checker_refuses_a_tampered_entry(self):
        records = parse_engines(*CHAIN)
        plants = {"value": lambda f: f["CAPACITY"].update(values=[2.0]),
                  "source": lambda f: f["CAPACITY"].update(source="ROOT", source_line=2),
                  "status": lambda f: f["MAX_RPM"].update(status="declared"),
                  "max_rpm": lambda f: f["TORQUE_ARRAY"]["max_rpm"].update(status=ZERO_FILLED),
                  "derived": lambda f: f["TORQUE_ARRAY"]["derived"]["0x2c"]["origins"].pop(),
                  "missing tag": lambda f: f.pop("ROUGHNESS")}
        for name, plant in plants.items():
            with self.subTest(plant=name):
                effective = effective_engine_fields(records)
                plant(effective["TIP"]["fields"])
                with self.assertRaisesRegex(ValueError, "disagrees with the parent-first derivation: TIP"):
                    check_effective_engine_fields(records, effective)
        effective = effective_engine_fields(records)
        del effective["MID"]
        with self.assertRaisesRegex(ValueError, "Engine effective field record set mismatch"):
            check_effective_engine_fields(records, effective)

    def test_field_counts(self):
        counts = engine_field_counts(effective_engine_fields(parse_engines(*CHAIN)))
        self.assertEqual(counts["CAPACITY"], {"inherited": 2, "declared": 1})
        self.assertEqual(counts["FUEL_CUTOFF"], {ZERO_FILLED: 3})
        self.assertEqual(list(counts), list(ENGINE_FIELD_STORES))

    def test_records_are_not_mutated(self):
        records = parse_engines(*CHAIN, ":TYPE LONE\nINHERIT_TYPE ROOT\n:CAPACITY 1\n")
        before = copy.deepcopy(records)
        effective_engine_fields(records)
        engine_fields_by_recursion(records)
        untagged_inherit_consequences(records)
        self.assertEqual(records, before)


class UntaggedInheritConsequenceTests(unittest.TestCase):
    def test_lists_both_readings_for_each_undeclared_tag(self):
        records = parse_engines(*CHAIN, ":TYPE INDIGO\nINHERIT_TYPE LEAF\n:CAPACITY 4.0\n:MAX_RPM 9000\n")
        consequences = untagged_inherit_consequences(records)
        self.assertEqual(list(consequences), ["INDIGO"])
        entry = consequences["INDIGO"]
        self.assertEqual({key: entry[key] for key in ("line", "tokens", "parent", "status", "overwritten_if_applied")},
                         {"line": 18, "tokens": ["INHERIT_TYPE", "LEAF"], "parent": "LEAF", "status": "unresolved",
                          "overwritten_if_applied": []})
        self.assertEqual(set(entry["fields"]), set(ENGINE_FIELD_STORES) - {"CAPACITY", "MAX_RPM"})
        self.assertEqual(entry["fields"]["ROUGHNESS"], {
            "if_ignored": zero(["INDIGO"]),
            "if_applied": engine_entry("ROUGHNESS", "inherited", ["INDIGO", "LEAF", "MID"], "MID", 10, [0.1])})
        self.assertEqual(entry["fields"]["FUEL_CUTOFF"]["if_applied"]["status"], ZERO_FILLED)
        # INDIGO stays a root as parsed: it gets no effective entry.
        self.assertNotIn("INDIGO", effective_engine_fields(records))

    def test_declarations_before_the_line_would_be_overwritten(self):
        records = parse_engines(":TYPE ROOT\n:CAPACITY 1\n", ":TYPE LONE\n:CAPACITY 2\nINHERIT_TYPE ROOT\n")
        self.assertEqual(untagged_inherit_consequences(records)["LONE"]["overwritten_if_applied"],
                         [{"tag": "CAPACITY", "line": 4, "values": [2]}])

    def test_other_untagged_lines_have_no_consequence(self):
        for text in (":TYPE LONE\nINHERIT_TYPE LATER\n:TYPE LATER\n",  # names no earlier record
                     ":TYPE LONE\nINHERIT_TYPE ROOT ROOT\n",  # extra token
                     ":TYPE LONE\n:INHERIT_TYPE ROOT\nINHERIT_TYPE ROOT\n",  # already inherits
                     ":TYPE LONE\nCAPACITY 3\n"):  # another tag
            with self.subTest(text=text):
                self.assertEqual(untagged_inherit_consequences(parse_engines(":TYPE ROOT\n", text)), {})


def site_va(site):
    return int(site, 16)


@unittest.skipIf(capstone is None, "needs capstone and pefile from scripts/requirements.txt")
class TyreScalarStoreEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.evidence = load_field_evidence()

    def test_committed_evidence_agrees_with_the_store_table(self):
        self.assertEqual(scalar_evidence_problems(self.evidence), [])

    def test_cited_sites_decode_as_float_stores_at_their_offsets(self):
        decoded = dict(decoded_evidence())
        for tag, entry in TYRE_SCALAR_STORES.items():
            for offset, sites in entry["offsets"].items():
                for site in sites:
                    with self.subTest(tag=tag, site=site):
                        self.assertRegex(decoded[site_va(site)], rf"fstp? dword ptr \[eax \+ {offset}\]")
            if "scaled_by" in entry:
                self.assertEqual(decoded[site_va(entry["scale_sites"]["load"])],
                                 f"fld dword ptr [{entry['scaled_by'].replace('0x00', '0x')}]")
                offset, = entry["offsets"]
                self.assertEqual(decoded[site_va(entry["scale_sites"]["multiply"])], f"fmul dword ptr [eax + {offset}]")

    def test_call_and_copy_decode_as_documented(self):
        decoded = dict(decoded_evidence())
        self.assertEqual(decoded[SCALAR_COPY_CALL], f"call 0x{SCALAR_COPY_SPAN[0]:x}")
        self.assertEqual(decoded[SCALAR_COPY_CALL - 5], "mov edx, eax")
        self.assertEqual(decoded[SCALAR_COPY_CALL - 3], "mov eax, dword ptr [ebp - 0x18]")
        copy_sites = [(va, text) for va, text in decoded_evidence() if SCALAR_COPY_SPAN[0] <= va < SCALAR_COPY_SPAN[1]]
        # The pairs run without a gap from just after `push ecx` to the `ret` that follows `pop ecx`.
        self.assertEqual([va for va, _ in copy_sites], [*range(SCALAR_COPY_SPAN[0] + 1, SCALAR_COPY_SPAN[0] + 0x43, 3),
                                                         SCALAR_COPY_SPAN[0] + 0x44])
        self.assertEqual(copy_sites[-1][1], "ret ")
        pairs = list(zip(copy_sites[:-1:2], copy_sites[1:-1:2], strict=True))
        copied = []
        for (_, load), (_, store) in pairs:
            offset = re.fullmatch(r"mov ecx, dword ptr \[edx \+ (0x[0-9a-f]+)\]", load)[1]
            self.assertEqual(store, f"mov dword ptr [eax + {offset}], ecx")
            copied.append(int(offset, 16))
        self.assertEqual(sorted(copied), list(SCALAR_COPY_OFFSETS))

    def test_every_copied_dword_belongs_to_one_mapped_tag(self):
        mapped = [int(offset, 16) for entry in TYRE_SCALAR_STORES.values() for offset in entry["offsets"]]
        self.assertEqual(sorted(mapped), list(SCALAR_COPY_OFFSETS))

    def test_drifted_store_table_or_missing_sites_are_reported(self):
        def drift(tag, offsets):
            stores = copy.deepcopy(TYRE_SCALAR_STORES)
            stores[tag]["offsets"] = offsets
            return scalar_evidence_problems(self.evidence, stores)
        self.assertIn("RADIUS + 0x2c: site 0x00523900 (d95028) is not a float store at [eax + 0x2c]",
                      drift("RADIUS", {"0x2c": ["0x00523900"], "0x3c": ["0x00523907"]}))
        self.assertIn("WIDTH + 0x30: no byte-checked tyre loader site at 0x00523a36",
                      drift("WIDTH", {"0x30": ["0x00523a36"]}))
        self.assertIn("MASS + 0x44: site 0x00523c83 (d95034) is not a float store at [eax + 0x44]",
                      drift("MASS", {"0x44": ["0x00523c83"], "0x38": ["0x00523c8a"]}))
        removals = {0x00523b3a: "no byte-checked call from 0x00523b3a to 0x00524090",
                    0x005240c1: "copy store at 0x005240c4 has no byte-checked load of parent + 0x40",
                    0x005240c4: "are not exactly +0x18..+0x40",
                    0x00523ca8: "OFFROAD_MAGIC_GRIP_NUMBER: no byte-checked load of its scale global 0x00597484 at "
                                "0x00523ca8",
                    0x00523942: "ROAD_MAGIC_GRIP_NUMBER: no byte-checked fmul by its scale global at 0x00523942",
                    0x00523a4a: "ROLLING_RESISTANCE + 0x40: no byte-checked tyre loader site at 0x00523a4a"}
        for va, fragment in removals.items():
            with self.subTest(va=f"0x{va:08x}"):
                problems = scalar_evidence_problems([site for site in self.evidence if site["va"] != va])
                self.assertTrue(any(fragment in problem for problem in problems), problems)
        moved = [{**site, "va": site["va"] + 0x1000} if site["va"] == 0x00523a35 else site for site in self.evidence]
        self.assertIn("WIDTH + 0x30: no byte-checked tyre loader site at 0x00523a35", scalar_evidence_problems(moved))


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
        self.assertEqual(recorded, evidence_sites())
        instructions = [{"va": va, "bytes": expected, "claim": claim} for va, expected, claim in EVIDENCE]
        self.assertEqual([site for site in recorded if "kind" not in site], instructions)
        data = [{"va": va, "bytes": expected, "claim": claim, "kind": "data"} for va, expected, claim in DATA_EVIDENCE]
        self.assertEqual([site for site in recorded if site.get("kind") == "data"], data)
        self.assertEqual([site["va"] for site in recorded], sorted({site["va"] for site in recorded}))
        self.assertTrue(all(claim.startswith("Data: ") for _, _, claim in DATA_EVIDENCE))

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


# The engine loader's dispatch loop head, where it compares the next tag's ID, and its default (unknown tag) branch.
ENGINE_DISPATCH = 0x00522856
ENGINE_NEXT_TAG = 0x00522848
ENGINE_DEFAULT = 0x00522878
# Any instruction whose first operand is memory at [edi +/- n] or [edx +/- n] and that writes it.
RECORD_WRITE = re.compile(r"(?:mov|fstp?|fistp?|fbstp|inc|dec|add|sub|and|or|xor|neg|not) (byte|word|dword|qword) ptr "
                          r"\[(edi|edx) ([+-]) (0x[0-9a-f]+)\](?:, .*)?")
SIGNED_JUMPS = {"jl": lambda c: c < 0, "jle": lambda c: c <= 0, "jg": lambda c: c > 0, "jge": lambda c: c >= 0,
                "je": lambda c: c == 0, "jne": lambda c: c != 0}


def engine_loader_lines():
    lines = (text_database.REPO_ROOT / "analysis/selected/load_engine_database.asm").read_text().splitlines()
    return [(int(match[1], 16), match[2]) for match in map(ASM_LINE.match, lines) if match]


def immediate(text):
    return int(text, 0) if not text.startswith("-") else -int(text[1:], 0)


def engine_dispatch(lines, tag_id, head=ENGINE_DISPATCH, next_tag=ENGINE_NEXT_TAG, default=ENGINE_DEFAULT):
    """Follow a loader's compare tree for one tag ID from the committed disassembly (by default the engine loader's).

    Returns (the compares taken as [(va, immediate)], the VAs the handler can reach, or None when the tag reaches
    the default branch). The handler is every instruction reachable, through any branch, before it jumps back to
    the next-tag read.
    """
    order = [va for va, _ in lines]
    text = dict(lines)
    va, compared, compares = head, None, []
    while True:
        mnemonic, _, operands = text[va].partition(" ")
        if mnemonic == "cmp" and operands.startswith("eax, "):
            value = immediate(operands[5:])
            compared = (tag_id > value) - (tag_id < value)
            compares.append((va, value))
        elif mnemonic in SIGNED_JUMPS:
            if SIGNED_JUMPS[mnemonic](compared):
                va = int(operands, 16)
                continue
        else:
            break
        va = order[order.index(va) + 1]
    if va == default:
        return compares, None
    reached, pending = set(), [va]
    while pending:
        va = pending.pop()
        if va in reached or va in (next_tag, default):
            continue
        reached.add(va)
        mnemonic, _, operands = text[va].partition(" ")
        following = order[order.index(va) + 1]
        if mnemonic == "jmp":
            pending.append(int(operands, 16))
        elif mnemonic.startswith("j"):
            pending += [int(operands, 16), following]
        elif mnemonic != "ret":
            pending.append(following)
    return compares, reached


def record_writes(lines, reached):
    """Return {va: (width, base, offset)} for each write to [edi + n] or [edx + n] among the reached VAs."""
    writes = {}
    for va, text in lines:
        match = RECORD_WRITE.fullmatch(text) if va in reached else None
        if match:
            width, base, sign, offset = match.groups()
            writes[va] = (width, base, int(offset, 16) * (-1 if sign == "-" else 1))
    return writes


class EngineDispatchTests(unittest.TestCase):
    """Emulate the committed loader disassembly's compare tree; no game data needed."""

    def setUp(self):
        self.lines = engine_loader_lines()
        self.tags = load_tag_ids()

    def test_each_mapped_tag_reaches_its_handler_through_its_compare(self):
        for tag, entry in [*ENGINE_FIELD_STORES.items(), ("INHERIT_TYPE", ENGINE_COPY)]:
            with self.subTest(tag=tag):
                compares, reached = engine_dispatch(self.lines, self.tags[tag])
                self.assertIsNotNone(reached)
                self.assertEqual(compares[-1], (int(entry["compare"], 16), entry["id"]))

    def test_each_handler_writes_exactly_the_mapped_sites(self):
        for tag, entry in ENGINE_FIELD_STORES.items():
            with self.subTest(tag=tag):
                writes = record_writes(self.lines, engine_dispatch(self.lines, entry["id"])[1])
                expected = {}
                for offset, store in entry["offsets"].items():
                    base, disp = ("edx", int(offset, 16) - 4) if "slots" in store else ("edi", int(offset, 16))
                    expected.update({int(va, 16): (store["width"], base, disp) for va in store["sites"]})
                self.assertEqual(writes, expected)
        writes = record_writes(self.lines, engine_dispatch(self.lines, ENGINE_COPY["id"])[1])
        self.assertEqual(writes, {int(ENGINE_COPY["parent_store"]["site"], 16): ("dword", "edi", 0x18)})

    def test_every_other_registry_tag_reaches_the_default_branch(self):
        handled = {*ENGINE_FIELD_STORES, "INHERIT_TYPE"}
        for tag, tag_id in self.tags.items():
            if tag not in handled:
                with self.subTest(tag=tag):
                    self.assertIsNone(engine_dispatch(self.lines, tag_id)[1])

    def test_emulation_catches_a_wrong_compare_or_store(self):
        # A synthetic tree: 0x10 takes the jne-guarded handler, 0x11 falls to the default branch.
        lines = [(ENGINE_DISPATCH, "cmp eax, 0x10"), (ENGINE_DISPATCH + 5, f"jne 0x{ENGINE_DEFAULT:x}"),
                 (ENGINE_DISPATCH + 11, "fstp dword ptr [edi + 0x98]"),
                 (ENGINE_DISPATCH + 17, f"jmp 0x{ENGINE_NEXT_TAG:x}"), (ENGINE_DEFAULT, "mov edx, 0x1a0")]
        compares, reached = engine_dispatch(lines, 0x10)
        self.assertEqual(compares, [(ENGINE_DISPATCH, 0x10)])
        self.assertEqual(record_writes(lines, reached), {ENGINE_DISPATCH + 11: ("dword", "edi", 0x98)})
        self.assertIsNone(engine_dispatch(lines, 0x11)[1])

    def test_record_write_pattern_covers_every_write_form(self):
        lines = [(1, "fst dword ptr [edi + 0x2c]"), (2, "fistp dword ptr [edi - 0x4]"), (3, "inc byte ptr [edi + 0x94]"),
                 (4, "mov word ptr [edx + 0x38], ax"), (5, "mov eax, dword ptr [edi + 0x30]"),
                 (6, "fld dword ptr [edi + 0x30]"), (7, "fstp dword ptr [ebp - 0x2c]")]
        self.assertEqual(record_writes(lines, {va for va, _ in lines}),
                         {1: ("dword", "edi", 0x2c), 2: ("dword", "edi", -4), 3: ("byte", "edi", 0x94),
                          4: ("word", "edx", 0x38)})


def drifted(table, path, value):
    """Deep-copy a map and set one nested key; path is a tuple of keys."""
    result = copy.deepcopy(table)
    target = result
    for key in path[:-1]:
        target = target[key]
    if value is None:
        del target[path[-1]]
    else:
        target[path[-1]] = value
    return result


class EngineEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.evidence = load_field_evidence()
        self.tags = load_tag_ids()

    def problems(self, evidence=None, stores=None, engine_copy=None, tags=None):
        return engine_evidence_problems(self.evidence if evidence is None else evidence,
                                        self.tags if tags is None else tags, stores, engine_copy)

    def without(self, *vas):
        return [site for site in self.evidence if site["va"] not in vas]

    def assertReports(self, fragment, problems):
        self.assertTrue(any(fragment in problem for problem in problems), problems)

    def test_committed_evidence_agrees_with_the_map(self):
        self.assertEqual(self.problems(), [])

    def test_map_covers_nineteen_stored_tags_plus_torque_array(self):
        self.assertEqual(len(ENGINE_FIELD_STORES), 20)
        derived = {(tag, offset) for tag, entry in ENGINE_FIELD_STORES.items()
                   for offset, store in entry["offsets"].items() if store.get("derived")}
        self.assertEqual(derived, {("TORQUE_ARRAY", "0x2c"), ("TURBO_MASS", "0xa4")})
        self.assertEqual(ENGINE_FIELD_STORES["TORQUE_ARRAY"]["offsets"]["0x3c"]["slots"], 18)

    def test_conditional_store_sites_must_be_byte_checked_jumps_about_their_tag(self):
        self.assertReports("TORQUE_ARRAY + 0x2c condition: no byte-checked engine loader site at 0x005229b6",
                           self.problems(self.without(0x005229b6)))
        evidence = [{**site, "bytes": "90"} if site["va"] == 0x005229e9 else site for site in self.evidence]
        self.assertReports("TORQUE_ARRAY + 0x2c: condition site 0x005229e9 (90) is not a conditional jump",
                           self.problems(evidence))
        evidence = [{**site, "claim": "MAX_RPM jumps"} if site["va"] == 0x00522980 else site for site in self.evidence]
        self.assertReports("TORQUE_ARRAY + 0x2c: condition site 0x00522980 (7356) is not a conditional jump whose "
                           "claim is about TORQUE_ARRAY", self.problems(evidence))

    def test_wrong_id_is_reported(self):
        problems = self.problems(stores=drifted(ENGINE_FIELD_STORES, ("MAX_RPM", "id"), 0xb1))
        self.assertIn("MAX_RPM: analysis/tags.json gives registry ID 0xb0, the map says 0xb1", problems)
        self.assertIn("MAX_RPM: compare site 0x005228b1 (3db0000000) is not cmp eax, 0xb1", problems)
        self.assertIn("INHERIT_TYPE: analysis/tags.json gives registry ID 0x9d, the map says 0x9c",
                      self.problems(tags={**self.tags, "INHERIT_TYPE": 0x9d}))
        self.assertIn("CAPACITY: compare site 0x005228b1 (3db0000000) is not cmp eax, 0x37",
                      self.problems(stores=drifted(ENGINE_FIELD_STORES, ("CAPACITY", "compare"), "0x005228b1")))

    def test_missing_site_is_reported(self):
        removals = {
            0x00522b15: "FUEL_CUTOFF + 0x1c: no byte-checked engine loader site at 0x00522b15",
            0x00522be0: "CAPACITY + 0x34: no byte-checked engine loader site at 0x00522be0",
            0x00522bd0: "CAPACITY compare: no byte-checked engine loader site at 0x00522bd0",
            0x00522c4e: "TURBO_MASS + 0xa4: no byte-checked engine loader site at 0x00522c4e",
            0x00522926: "TORQUE_ARRAY zero-fill call: no byte-checked engine loader site at 0x00522926",
            0x0052295b: "TORQUE_ARRAY row pointer step: no byte-checked engine loader site at 0x0052295b",
            0x0052292b: "TORQUE_ARRAY row count: no byte-checked engine loader site at 0x0052292b",
            0x00522b64: "LOCATION_TYPE enum table: no byte-checked engine loader site at 0x00522b64",
            0x00522b43: "INHERIT_TYPE parent in edx: no byte-checked engine loader site at 0x00522b43",
            0x00522b47: "INHERIT_TYPE copy call: no byte-checked engine loader site at 0x00522b47",
            0x00522b4c: "INHERIT_TYPE + 0x18: no byte-checked engine loader site at 0x00522b4c",
            0x00522c97: "copy store at 0x00522c9a has no byte-checked load of parent + 0x1c into eax before it",
            0x00522d61: "ENGINE_COPY + 0xac: no byte-checked load/store pair in the copy",
            0x00522ccd: "Engine copy block movsd: no byte-checked engine copy site at 0x00522ccd",
        }
        for va, fragment in removals.items():
            with self.subTest(va=f"0x{va:08x}"):
                self.assertReports(fragment, self.problems(self.without(va)))

    def test_site_outside_its_routine_is_reported(self):
        moved = [{**site, "va": site["va"] + 0x1000} if site["va"] == 0x00522a76 else site for site in self.evidence]
        self.assertIn("MAX_RPM + 0x30: no byte-checked engine loader site at 0x00522a76", self.problems(moved))
        self.assertReports("Engine copy record register: no byte-checked engine copy site at 0x00522804",
                           self.problems(engine_copy=drifted(ENGINE_COPY, ("record_in_ebx",), "0x00522804")))

    def test_store_at_the_wrong_offset_or_width_is_reported(self):
        stores = drifted(ENGINE_FIELD_STORES, ("ROUGHNESS", "offsets"),
                         {"0x2c": {**ENGINE_FIELD_STORES["ROUGHNESS"]["offsets"]["0x28"]}})
        problems = self.problems(stores=stores)
        self.assertReports("ROUGHNESS + 0x2c: site 0x0052290e (d95f28) is not a kind store, width dword, base edi, "
                           "disp 0x2c instruction", problems)
        self.assertIn("the copy writes offsets no mapped tag stores: +0x28..+0x2b", problems)
        stores = drifted(ENGINE_FIELD_STORES, ("NUMBER_OF_TURBOS", "offsets", "0x94", "width"), "dword")
        self.assertReports("NUMBER_OF_TURBOS + 0x94: site 0x005228e4 (888794000000) is not a kind store, width dword",
                           self.problems(stores=stores))
        stores = drifted(ENGINE_FIELD_STORES, ("TORQUE_ARRAY", "offsets", "0x3c", "slots"), 17)
        problems = self.problems(stores=stores)
        self.assertReports("TORQUE_ARRAY zero-fill size: site 0x0052291c (bb48000000) is not bb44000000", problems)
        self.assertIn("the copy writes offsets no mapped tag stores: +0x80..+0x83", problems)

    def test_copy_offset_that_nothing_stores_is_reported(self):
        problems = self.problems(engine_copy=drifted(ENGINE_COPY, ("offsets", "0x18"), "dword"))
        self.assertIn("ENGINE_COPY + 0x18: no byte-checked load/store pair in the copy", problems)
        self.assertIn("the copy writes offsets no mapped tag stores: +0x18..+0x1b", problems)
        self.assertIn("the copy writes the name or the parent address: +0x18..+0x1b", problems)
        problems = self.problems(stores=drifted(ENGINE_FIELD_STORES, ("MAX_AIRFLOW",), None))
        self.assertEqual(problems, ["byte-checked record store at 0x005228a2 (d99f9c000000) is in no mapped tag",
                                    "the copy writes offsets no mapped tag stores: +0x9c..+0x9f"])

    def test_stored_offset_the_copy_misses_is_reported(self):
        problems = self.problems(engine_copy=drifted(ENGINE_COPY, ("offsets", "0xac"), None))
        self.assertIn("copy pair at + 0xac is not in ENGINE_COPY", problems)
        self.assertIn("mapped stores the copy misses: +0xac..+0xaf", problems)
        problems = self.problems(engine_copy=drifted(ENGINE_COPY, ("block", "size"), 0x44))
        self.assertIn("mapped stores the copy misses: +0x80..+0x83", problems)
        self.assertIn("Engine copy block size: site 0x00522c86 (b948000000) is not b944000000", problems)
        problems = self.problems(engine_copy=drifted(ENGINE_COPY, ("offsets", "0x94"), "dword"))
        self.assertIn("ENGINE_COPY + 0x94: the copy moves a byte, not a dword", problems)

    def test_copy_load_must_feed_the_same_register_and_offset(self):
        wrong = [{**site, "bytes": "8b4220"} if site["va"] == 0x00522c97 else site for site in self.evidence]
        self.assertReports("copy store at 0x00522c9a has no byte-checked load of parent + 0x1c into eax",
                           self.problems(wrong))
        # A lea into EAX between `mov al, [edx + 0x14]` and `mov [ebx + 0x14], al` overwrites AL.
        clobbered = [{**site, "bytes": "8d423c"} if site["va"] == 0x00522c8e else site for site in self.evidence]
        self.assertReports("copy store at 0x00522c91 has no byte-checked load of parent + 0x14 into al",
                           self.problems(clobbered))

    def test_store_sites_must_be_complete_and_belong_to_their_tag(self):
        stores = drifted(ENGINE_FIELD_STORES, ("CAPACITY", "offsets", "0x34", "sites"), [])
        problems = self.problems(stores=stores)
        self.assertIn("CAPACITY + 0x34: no store sites", problems)
        self.assertIn("byte-checked record store at 0x00522be0 (d95f34) is in no mapped tag", problems)
        stores = drifted(ENGINE_FIELD_STORES, ("TURBO_MASS", "offsets", "0xa4", "sites"), ["0x00522a48"])
        self.assertEqual(self.problems(stores=stores),
                         ["byte-checked record store at 0x00522c4e (c787a40000000000803f) is in no mapped tag"])
        # Swapping two tags' offsets, sites and fields keeps every offset consistent; only the claims tell them apart.
        stores = copy.deepcopy(ENGINE_FIELD_STORES)
        stores["FUEL_CUTOFF"]["offsets"], stores["ENGINE_BRAKING"]["offsets"] = (
            stores["ENGINE_BRAKING"]["offsets"], stores["FUEL_CUTOFF"]["offsets"])
        problems = self.problems(stores=stores)
        self.assertReports("FUEL_CUTOFF + 0x20: the claim at 0x00522ada is not about FUEL_CUTOFF", problems)
        self.assertReports("ENGINE_BRAKING + 0x1c: the claim at 0x00522b15 is not about ENGINE_BRAKING", problems)

    def test_copy_must_keep_ecx(self):
        self.assertReports("Engine copy saves ECX: no byte-checked engine copy site at 0x00522c81",
                           self.problems(self.without(0x00522c81)))
        self.assertReports("Engine copy restores ECX: no byte-checked engine copy site at 0x00522d69",
                           self.problems(self.without(0x00522d69)))

    def test_copied_bytes_equal_stored_bytes(self):
        stored = text_database.engine_stored_bytes(ENGINE_FIELD_STORES)
        copied = text_database.engine_copy_bytes(ENGINE_COPY)
        self.assertEqual(set(stored), copied)
        self.assertEqual(byte_ranges(set(range(0xb0)) - copied), "+0x00..+0x13, +0x15..+0x1b, +0x96..+0x97")


class EngineDecoderTests(unittest.TestCase):
    def test_memory_operand(self):
        cases = {"d99f9c000000": ("store", "dword", "edi", 0x9c, "st0"), "d95a38": ("store", "dword", "edx", 0x38, "st0"),
                 "888794000000": ("store", "byte", "edi", 0x94, "al"), "8b421c": ("load", "dword", "edx", 0x1c, "eax"),
                 "8a8295000000": ("load", "byte", "edx", 0x95, "al"), "8d723c": ("lea", None, "edx", 0x3c, "esi"),
                 "d94730": ("load", "dword", "edi", 0x30, "st0"), "894f18": ("store", "dword", "edi", 0x18, "ecx"),
                 "c787a40000000000803f": ("store", "dword", "edi", 0xa4, 0x3f800000),
                 "d95dd4": ("store", "dword", "ebp", -0x2c, "st0")}
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                decoded = memory_operand(raw)
                self.assertEqual(tuple(decoded[key] for key in ("kind", "width", "base", "disp", "register")), expected)
        for raw in ("f2a5", "89c3", "8b0424", "8b05a41c5800", "d9e8", "c7470000", "d97528", "8b421c00"):
            with self.subTest(raw=raw):
                self.assertIsNone(memory_operand(raw))

    def test_compare_immediate(self):
        self.assertEqual(compare_immediate("3d5b010000"), 0x15b)
        self.assertEqual(compare_immediate("83f801"), 1)
        self.assertEqual(compare_immediate("83f8f2"), -0xe)
        self.assertIsNone(compare_immediate("3c01"))
        self.assertIsNone(compare_immediate("83f901"))

    @unittest.skipIf(capstone is None, "needs capstone and pefile from scripts/requirements.txt")
    def test_decoder_agrees_with_capstone_on_every_engine_site(self):
        decoded = dict(decoded_evidence())
        engine = [(va, raw) for va, raw, _ in EVIDENCE if ENGINE_LOADER_SPAN[0] <= va < ENGINE_COPY["span"][1]]
        self.assertEqual(len(engine), 138)
        for va, raw in engine:
            mine = memory_operand(raw)
            if mine is None:
                continue
            with self.subTest(va=f"0x{va:08x}"):
                sign = "-" if mine["disp"] < 0 else "+"
                self.assertIn(f"[{mine['base']} {sign} 0x{abs(mine['disp']):x}]", decoded[va])
                if mine["width"]:
                    self.assertIn(f"{mine['width']} ptr", decoded[va])
        for tag, entry in [*ENGINE_FIELD_STORES.items(), ("INHERIT_TYPE", ENGINE_COPY)]:
            with self.subTest(tag=tag):
                self.assertEqual(decoded[int(entry["compare"], 16)], f"cmp eax, {entry['id'] if entry['id'] < 10 else hex(entry['id'])}")


ENGINE_HEADER = load_layout_header()


class EngineLayoutTests(unittest.TestCase):
    def test_committed_header_agrees_with_the_map(self):
        self.assertEqual(engine_layout_problems(ENGINE_HEADER), [])

    def test_offset_that_disagrees_with_the_header_is_reported(self):
        swapped = ENGINE_HEADER.replace("    float max_fuel_flow;\n    float max_delta_fuel_flow;\n",
                                        "    float max_delta_fuel_flow;\n    float max_fuel_flow;\n")
        self.assertNotEqual(swapped, ENGINE_HEADER)
        problems = engine_layout_problems(swapped)
        self.assertIn("MAX_FUELFLOW + 0xa8: Fr3EngineRecord.max_fuel_flow is at +0xac", problems)
        self.assertIn("MAX_DELTA_FUELFLOW + 0xac: Fr3EngineRecord.max_delta_fuel_flow is at +0xa8", problems)
        stores = drifted(ENGINE_FIELD_STORES, ("CAPACITY", "offsets"),
                         {"0x38": {**ENGINE_FIELD_STORES["CAPACITY"]["offsets"]["0x34"]}})
        self.assertIn("CAPACITY + 0x38: Fr3EngineRecord.capacity is at +0x34", engine_layout_problems(ENGINE_HEADER, stores))

    def test_width_name_size_and_assertions_are_checked(self):
        stores = drifted(ENGINE_FIELD_STORES, ("NUMBER_OF_TURBOS", "offsets", "0x94", "width"), "dword")
        self.assertIn("NUMBER_OF_TURBOS + 0x94: Fr3EngineRecord.turbo_count is 1 bytes, the map stores 4",
                      engine_layout_problems(ENGINE_HEADER, stores))
        stores = drifted(ENGINE_FIELD_STORES, ("TORQUE_ARRAY", "offsets", "0x3c", "field"), "torques")
        self.assertIn("TORQUE_ARRAY + 0x3c: Fr3EngineRecord has no field torques", engine_layout_problems(ENGINE_HEADER, stores))
        line = '_Static_assert(offsetof(Fr3EngineRecord, capacity) == 0x34, "CAPACITY");\n'
        self.assertIn(line, ENGINE_HEADER)
        self.assertEqual(engine_layout_problems(ENGINE_HEADER.replace(line, "")),
                         ["CAPACITY + 0x34: the header does not _Static_assert offsetof(Fr3EngineRecord, capacity) == 0x34"])
        grown = ENGINE_HEADER.replace("    float max_delta_fuel_flow;\n", "    float max_delta_fuel_flow;\n    float extra;\n")
        self.assertIn("Fr3EngineRecord is 0xb4 bytes, not 0xb0", engine_layout_problems(grown))
        engine_copy = drifted(ENGINE_COPY, ("parent_store", "field"), "parent_address")
        self.assertIn("INHERIT_TYPE + 0x18: Fr3EngineRecord has no field parent_address",
                      engine_layout_problems(ENGINE_HEADER, copy=engine_copy))

    def test_header_provenance_names_the_byte_checked_engine_offsets(self):
        self.assertNotIn("Engine/gearbox layouts use the supplied report", ENGINE_HEADER)
        self.assertIn("Every Fr3EngineRecord field from +0x14 on is byte-checked", ENGINE_HEADER)


# The gearbox loader's dispatch head, its next-tag read and its default (unknown tag) branch.
GEARBOX_DISPATCH = 0x00523289
GEARBOX_NEXT_TAG = 0x0052327B
GEARBOX_DEFAULT = 0x005232A0


def gearbox_loader_lines():
    lines = (text_database.REPO_ROOT / "analysis/selected/load_gearbox_database.asm").read_text().splitlines()
    return [(int(match[1], 16), match[2]) for match in map(ASM_LINE.match, lines) if match]


def gearbox_dispatch(lines, tag_id):
    return engine_dispatch(lines, tag_id, GEARBOX_DISPATCH, GEARBOX_NEXT_TAG, GEARBOX_DEFAULT)


class GearboxDispatchTests(unittest.TestCase):
    """Emulate the committed gearbox loader disassembly's compare tree; no game data needed."""

    def setUp(self):
        self.lines = gearbox_loader_lines()
        self.tags = load_tag_ids()

    def test_each_mapped_tag_reaches_its_handler_through_its_compare(self):
        for tag, entry in [*GEARBOX_FIELD_STORES.items(), ("INHERIT_TYPE", GEARBOX_COPY)]:
            with self.subTest(tag=tag):
                compares, reached = gearbox_dispatch(self.lines, self.tags[tag])
                self.assertIsNotNone(reached)
                self.assertEqual(compares[-1], (int(entry["compare"], 16), entry["id"]))
                if "after_range" in entry:
                    self.assertIn(int(entry["after_range"], 16) + 2, reached)

    def test_each_handler_reads_and_writes_exactly_the_mapped_sites(self):
        text = dict(self.lines)
        for tag, entry in GEARBOX_FIELD_STORES.items():
            with self.subTest(tag=tag):
                reached = gearbox_dispatch(self.lines, entry["id"])[1]
                expected = {int(va, 16): (store["width"], "edi", int(offset, 16))
                            for offset, store in entry["offsets"].items() for va in store["sites"]}
                self.assertEqual(record_writes(self.lines, reached), expected)
                calls = sorted(va for va in reached if text[va].startswith("call "))
                self.assertIn(int(entry["read"]["call"], 16), calls)
        writes = record_writes(self.lines, gearbox_dispatch(self.lines, GEARBOX_COPY["id"])[1])
        self.assertEqual(writes, {})

    def test_every_other_registry_tag_reaches_the_default_branch(self):
        handled = {*GEARBOX_FIELD_STORES, "INHERIT_TYPE"}
        for tag, tag_id in self.tags.items():
            if tag not in handled:
                with self.subTest(tag=tag):
                    self.assertIsNone(gearbox_dispatch(self.lines, tag_id)[1])

    def test_map_covers_exactly_the_gearbox_tags(self):
        self.assertEqual(set(GEARBOX_FIELD_STORES), GEARBOX_TAGS)
        self.assertEqual(unmapped_gearbox_tags(), ([], []))
        stores = {tag: entry for tag, entry in GEARBOX_FIELD_STORES.items() if tag != "DRIVE_SPLIT"}
        self.assertEqual(unmapped_gearbox_tags(stores), (["DRIVE_SPLIT"], []))
        self.assertEqual(unmapped_gearbox_tags({**GEARBOX_FIELD_STORES, "CAPACITY": {}}), ([], ["CAPACITY"]))


class GearboxEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.evidence = load_field_evidence()
        self.tags = load_tag_ids()

    def problems(self, evidence=None, stores=None, gearbox_copy=None, tags=None):
        return gearbox_evidence_problems(self.evidence if evidence is None else evidence,
                                         self.tags if tags is None else tags, stores, gearbox_copy)

    def without(self, *vas):
        return [site for site in self.evidence if site["va"] not in vas]

    def replaced(self, va, **fields):
        return [{**site, **fields} if site["va"] == va else site for site in self.evidence]

    def assertReports(self, fragment, problems):
        self.assertTrue(any(fragment in problem for problem in problems), problems)

    def test_committed_evidence_agrees_with_the_map(self):
        self.assertEqual(self.problems(), [])

    def test_wrong_id_is_reported(self):
        problems = self.problems(stores=drifted(GEARBOX_FIELD_STORES, ("DRIVE_SPLIT", "id"), 0x77))
        self.assertIn("DRIVE_SPLIT: analysis/tags.json gives registry ID 0x76, the map says 0x77", problems)
        self.assertIn("DRIVE_SPLIT: compare site 0x00523378 (83f876) is not cmp eax, 0x77", problems)
        self.assertIn("ANTI_WHEELSPIN: analysis/tags.json gives registry ID 0x10, the map says 0xf",
                      self.problems(tags={**self.tags, "ANTI_WHEELSPIN": 0x10}))
        self.assertIn("INHERIT_TYPE: compare site 0x00523310 (3d1a010000) is not cmp eax, 0x9c",
                      self.problems(gearbox_copy=drifted(GEARBOX_COPY, ("compare",), "0x00523310")))

    def test_missing_site_is_reported(self):
        removals = {
            0x00523289: "CLUTCH_SPEED compare: no byte-checked gearbox loader site at 0x00523289",
            0x005232c1: "CLUTCH_SPEED selecting jg: no byte-checked gearbox loader site at 0x005232c1",
            0x005232ca: "CLUTCH_SPEED + 0x14: no byte-checked gearbox loader site at 0x005232ca",
            0x005233d6: "CLUTCH_MAX_POWER reader call: no byte-checked gearbox loader site at 0x005233d6",
            0x00523364: "TRANSMISSION_TYPE enum table: no byte-checked gearbox loader site at 0x00523364",
            0x00523399: "ANTI_WHEELSKID float-to-integer call: no byte-checked gearbox loader site at 0x00523399",
            0x005233bd: "ANTI_WHEELSPIN fistp: no byte-checked gearbox loader site at 0x005233bd",
            0x00523234: "Gearbox allocation size: no byte-checked gearbox loader site at 0x00523234",
            0x00523411: "Gearbox name read: no byte-checked gearbox loader site at 0x00523411",
            0x00523317: "INHERIT_TYPE compare: no byte-checked gearbox loader site at 0x00523317",
            0x00523330: "INHERIT_TYPE parent lookup: no byte-checked gearbox loader site at 0x00523330",
            0x00523335: "INHERIT_TYPE parent in edx: no byte-checked gearbox loader site at 0x00523335",
            0x00523339: "INHERIT_TYPE copy call: no byte-checked gearbox loader site at 0x00523339",
            0x0052333e: "INHERIT_TYPE next tag: no byte-checked gearbox loader site at 0x0052333e",
            0x00523472: "copy store at 0x00523475 has no byte-checked load of parent + 0x1c into ecx before it",
            0x005234a5: "GEARBOX_COPY + 0x31: no byte-checked load/store pair in the copy",
            0x00523471: "Gearbox copy push ecx: no byte-checked gearbox copy site at 0x00523471",
        }
        for va, fragment in removals.items():
            with self.subTest(va=f"0x{va:08x}"):
                self.assertReports(fragment, self.problems(self.without(va)))

    def test_site_outside_its_routine_is_reported(self):
        stores = drifted(GEARBOX_FIELD_STORES, ("DRIVE_SPLIT", "offsets", "0x20", "sites"), ["0x00522a0e"])
        self.assertIn("DRIVE_SPLIT + 0x20: no byte-checked gearbox loader site at 0x00522a0e", self.problems(stores=stores))

    def test_wrong_bytes_are_reported(self):
        self.assertReports("Gearbox allocation size: site 0x00523234 (ba30000000) is not ba34000000",
                           self.problems(self.replaced(0x00523234, bytes="ba30000000")))
        self.assertReports("DIFF_TYPE enum table: site 0x005232e4 (ba60745900) is not ba4c745900",
                           self.problems(stores=drifted(GEARBOX_FIELD_STORES, ("DIFF_TYPE", "enum_table", "va"),
                                                        "0x0059744c")))
        # A float tag mapped as an enum read: the reader call and the stored register disagree.
        stores = drifted(GEARBOX_FIELD_STORES, ("DRIVE_SPLIT", "read", "kind"), "enum")
        problems = self.problems(stores=stores)
        self.assertReports("DRIVE_SPLIT reader call: site 0x00523383 (e8f8b2f0ff) is not", problems)
        self.assertIn("DRIVE_SPLIT: an enum read with no enum_table", problems)
        self.assertReports("DRIVE_SPLIT + 0x20: site 0x00523388 (d95f20) is not a kind store, width dword, base edi, "
                           "disp 0x20, register eax instruction", problems)
        self.assertReports("ANTI_WHEELSPIN: 0x005233bd (db5dec) and 0x005233c0 (8a45e8) are not a fistp",
                           self.problems(self.replaced(0x005233bd, bytes="db5dec")))
        self.assertReports("INHERIT_TYPE: the parent lookup at 0x00523330 is not passed the buffer the name was read",
                           self.problems(self.replaced(0x0052332d, bytes="8d45d4")))

    def test_selecting_jg_must_be_a_jg_about_its_tag(self):
        self.assertIn("DRIVE_TYPE: selecting site 0x005232f5 (7d19) is not a jg whose claim is about DRIVE_TYPE",
                      self.problems(self.replaced(0x005232f5, bytes="7d19")))
        self.assertIn("TORQUE_SHIFT: selecting site 0x00523343 (7f0f) is not a jg whose claim is about TORQUE_SHIFT",
                      self.problems(self.replaced(0x00523343, claim="DRIVE_TYPE is selected")))

    def test_store_at_the_wrong_offset_or_width_is_reported(self):
        stores = drifted(GEARBOX_FIELD_STORES, ("TORQUE_SHIFT", "offsets"),
                         {"0x20": {**GEARBOX_FIELD_STORES["TORQUE_SHIFT"]["offsets"]["0x1c"]}})
        problems = self.problems(stores=stores)
        self.assertReports("TORQUE_SHIFT + 0x20: site 0x0052334c (d95f1c) is not a kind store, width dword, base edi, "
                           "disp 0x20", problems)
        self.assertIn("the copy writes offsets no mapped tag stores: +0x1c..+0x1f", problems)
        stores = drifted(GEARBOX_FIELD_STORES, ("ANTI_WHEELSKID", "offsets", "0x31", "width"), "dword")
        self.assertReports("ANTI_WHEELSKID + 0x31: site 0x005233a4 (884731) is not a kind store, width dword",
                           self.problems(stores=stores))

    def test_unmapped_tag_or_store_is_reported(self):
        problems = self.problems(stores=drifted(GEARBOX_FIELD_STORES, ("DRIVE_SPLIT",), None))
        self.assertEqual(problems, ["byte-checked record store at 0x00523388 (d95f20) is in no mapped tag",
                                    "the copy writes offsets no mapped tag stores: +0x20..+0x23"])
        problems = self.problems(stores=drifted(GEARBOX_FIELD_STORES, ("CLUTCH_SPEED", "offsets", "0x14", "sites"), []))
        self.assertIn("CLUTCH_SPEED + 0x14: no store sites", problems)
        self.assertIn("byte-checked record store at 0x005232ca (d95f14) is in no mapped tag", problems)

    def test_copy_offset_that_nothing_stores_is_reported(self):
        problems = self.problems(gearbox_copy=drifted(GEARBOX_COPY, ("offsets", "0x32"), "byte"))
        self.assertIn("GEARBOX_COPY + 0x32: no byte-checked load/store pair in the copy", problems)
        self.assertIn("the copy writes offsets no mapped tag stores: +0x32", problems)
        self.assertIn("the copy writes the name or the padding: +0x32", problems)
        problems = self.problems(gearbox_copy=drifted(GEARBOX_COPY, ("offsets", "0x10"), "dword"))
        self.assertIn("the copy writes the name or the padding: +0x10..+0x13", problems)

    def test_stored_offset_the_copy_misses_is_reported(self):
        problems = self.problems(gearbox_copy=drifted(GEARBOX_COPY, ("offsets", "0x31"), None))
        self.assertIn("copy pair at + 0x31 is not in GEARBOX_COPY", problems)
        self.assertIn("mapped stores the copy misses: +0x31", problems)
        problems = self.problems(gearbox_copy=drifted(GEARBOX_COPY, ("offsets", "0x30"), "dword"))
        self.assertIn("GEARBOX_COPY + 0x30: the copy moves a byte, not a dword", problems)

    def test_copy_load_must_feed_the_same_register_and_offset(self):
        self.assertReports("copy store at 0x0052347b has no byte-checked load of parent + 0x14 into ecx",
                           self.problems(self.replaced(0x00523478, bytes="8b4a18")))
        self.assertReports("copy store at 0x0052349f has no byte-checked load of parent + 0x30 into bl",
                           self.problems(self.replaced(0x0052349c, bytes="8a5230")))

    def test_store_sites_must_belong_to_their_tag(self):
        stores = copy.deepcopy(GEARBOX_FIELD_STORES)
        stores["CLUTCH_SPEED"]["offsets"], stores["CLUTCH_MAX_POWER"]["offsets"] = (
            stores["CLUTCH_MAX_POWER"]["offsets"], stores["CLUTCH_SPEED"]["offsets"])
        problems = self.problems(stores=stores)
        self.assertReports("CLUTCH_SPEED + 0x18: the claim at 0x005233db is not about CLUTCH_SPEED", problems)
        self.assertReports("CLUTCH_MAX_POWER + 0x14: the claim at 0x005232ca is not about CLUTCH_MAX_POWER", problems)

    def test_copied_bytes_equal_stored_bytes(self):
        stored = text_database.engine_stored_bytes(GEARBOX_FIELD_STORES)
        copied = text_database.engine_copy_bytes(GEARBOX_COPY)
        self.assertEqual(set(stored), copied)
        self.assertEqual(byte_ranges(set(range(0x34)) - copied), "+0x00..+0x13, +0x32..+0x33")

    @unittest.skipIf(capstone is None, "needs capstone and pefile from scripts/requirements.txt")
    def test_decoder_agrees_with_capstone_on_every_gearbox_site(self):
        decoded = dict(decoded_evidence())
        gearbox = [(va, raw) for va, raw, _ in EVIDENCE if GEARBOX_LOADER_SPAN[0] <= va < GEARBOX_COPY["span"][1]]
        self.assertEqual(len(gearbox), 80)
        for va, raw in gearbox:
            mine = memory_operand(raw)
            if mine is None:
                continue
            with self.subTest(va=f"0x{va:08x}"):
                sign = "-" if mine["disp"] < 0 else "+"
                self.assertIn(f"[{mine['base']} {sign} 0x{abs(mine['disp']):x}]", decoded[va])
                if mine["width"]:
                    self.assertIn(f"{mine['width']} ptr", decoded[va])
        for tag, entry in [*GEARBOX_FIELD_STORES.items(), ("INHERIT_TYPE", GEARBOX_COPY)]:
            with self.subTest(tag=tag):
                self.assertEqual(decoded[int(entry["compare"], 16)],
                                 f"cmp eax, {entry['id'] if entry['id'] < 10 else hex(entry['id'])}")
                if "after_range" in entry:
                    self.assertTrue(decoded[int(entry["after_range"], 16)].startswith("jg "))
        for site in (GEARBOX_RECORD["allocation"]["call"], GEARBOX_COPY["call"]):
            self.assertTrue(decoded[int(site, 16)].startswith("call "))


class GearboxLayoutTests(unittest.TestCase):
    def test_committed_header_agrees_with_the_map(self):
        self.assertEqual(gearbox_layout_problems(ENGINE_HEADER), [])

    def test_offset_that_disagrees_with_the_header_is_reported(self):
        swapped = ENGINE_HEADER.replace("    float clutch_speed;\n    float clutch_max_power;\n",
                                        "    float clutch_max_power;\n    float clutch_speed;\n")
        self.assertNotEqual(swapped, ENGINE_HEADER)
        problems = gearbox_layout_problems(swapped)
        self.assertIn("CLUTCH_SPEED + 0x14: Fr3GearboxRecord.clutch_speed is at +0x18", problems)
        self.assertIn("CLUTCH_MAX_POWER + 0x18: Fr3GearboxRecord.clutch_max_power is at +0x14", problems)

    def test_width_name_size_and_assertions_are_checked(self):
        stores = drifted(GEARBOX_FIELD_STORES, ("ANTI_WHEELSPIN", "offsets", "0x30", "width"), "dword")
        self.assertIn("ANTI_WHEELSPIN + 0x30: Fr3GearboxRecord.anti_wheelspin is 1 bytes, the map stores 4",
                      gearbox_layout_problems(ENGINE_HEADER, stores))
        stores = drifted(GEARBOX_FIELD_STORES, ("DIFF_TYPE", "offsets", "0x28", "field"), "diff_type")
        self.assertIn("DIFF_TYPE + 0x28: Fr3GearboxRecord has no field diff_type",
                      gearbox_layout_problems(ENGINE_HEADER, stores))
        line = '_Static_assert(offsetof(Fr3GearboxRecord, drive_split) == 0x20, "DRIVE_SPLIT");\n'
        self.assertIn(line, ENGINE_HEADER)
        self.assertEqual(gearbox_layout_problems(ENGINE_HEADER.replace(line, "")),
                         ["DRIVE_SPLIT + 0x20: the header does not _Static_assert offsetof(Fr3GearboxRecord, "
                          "drive_split) == 0x20"])
        grown = ENGINE_HEADER.replace("    uint8_t padding_32[2];\n", "    uint8_t padding_32[6];\n")
        self.assertIn("Fr3GearboxRecord is 0x38 bytes, not 0x34", gearbox_layout_problems(grown))

    def test_header_provenance_names_the_byte_checked_gearbox_offsets(self):
        self.assertNotIn("Gearbox layout uses the supplied report", ENGINE_HEADER)
        self.assertIn("Every Fr3GearboxRecord field from +0x14 on is byte-checked", ENGINE_HEADER)


class UnmappedEngineTagTests(unittest.TestCase):
    def test_reports_each_unmapped_tag_once_with_its_first_use(self):
        records = parse(":TYPE A\n:ADDITIONAL_BRAKING 1\n:CAPACITY 2\n:TYPE B\n:INHERIT_TYPE A\n:ADDITIONAL_BRAKING 3\n"
                        ":AEROFOIL 1\n:END\n", {"ADDITIONAL_BRAKING", "CAPACITY", "INHERIT_TYPE", "AEROFOIL"})
        self.assertEqual(unmapped_engine_tags(records), {"ADDITIONAL_BRAKING": ("A", 2), "AEROFOIL": ("B", 7)})
        self.assertEqual(unmapped_engine_tags(records[:1], {**ENGINE_FIELD_STORES, "ADDITIONAL_BRAKING": {}}), {})


def engine_tags(tags, rows):
    """Declare each tag in ENGINE_FIELD_STORES order (MAX_RPM before TORQUE_ARRAY), the table with `rows` rows."""
    lines = []
    for tag in sorted(tags, key=lambda tag: (tag == "TORQUE_ARRAY", list(ENGINE_FIELD_STORES).index(tag))):
        lines += [f":{tag}"] + [f"{rpm}.0 100.0" for rpm in range(rows)] if tag == "TORQUE_ARRAY" else [f":{tag} 1"]
    return lines


def engine_file(parents=None):
    """Mirror the demo's engine database shape: four roots that declare every mapped tag, 51 inheriting engines
    (child i declares a tag after its INHERIT_TYPE when i is below the tag's declared count in ENGINE_FIELD_COUNTS),
    and the root INDIGO, whose colon-less `INHERIT_TYPE DEFAULT_TRACK` line sits on line 1410."""
    roots = ["DEFAULT_CLASSIC", "DEFAULT_MODERN", "DEFAULT_OFFROAD", "DEFAULT_TRACK"]
    parents = parents or [roots[i % 4] if i < 8 else f"CHILD{i - 8}" for i in range(51)]
    lines = []
    for i, name in enumerate(roots):
        lines += [f":TYPE {name}", *engine_tags(ENGINE_FIELD_STORES, 5 + i)]
    for i, parent in enumerate(parents):
        declared = [tag for tag, counts in ENGINE_FIELD_COUNTS.items() if i < counts.get("declared", 0)]
        lines += [f":TYPE CHILD{i}", f":INHERIT_TYPE {parent}", *engine_tags(declared, 10)]
    lines += [":TYPE INDIGO"]
    lines += ["//"] * (1409 - len(lines)) + ["INHERIT_TYPE DEFAULT_TRACK"]
    lines += [*engine_tags(["ASPIRATION_TYPE", "MAX_RPM", "TORQUE_MODIFIER", "TORQUE_ARRAY"], 9), ":END"]
    return "\r\n".join(lines) + "\r\n"


def gearbox_file(tags=GEARBOX_TAGS):
    lines = []
    for i in range(14):
        lines += [f":TYPE GEAR{i}"] + [f":{tag} 0" for tag in sorted(tags)]
    return "\n".join(lines + [":END"]) + "\n"


# Mirror the demo: 72 further tyres inherit DEFAULT_ROAD, 22 DEFAULT_OFFROAD and 12 DEFAULT_TRACK.
DEMO_PARENTS = ["DEFAULT_ROAD"] * 72 + ["DEFAULT_OFFROAD"] * 22 + ["DEFAULT_TRACK"] * 12
# Mirror the demo's scalar declarations: the three defaults declare every mapped tag, and each further tyre
# declares the road grip number, radius and width, plus these extra tags (by its index in DEMO_PARENTS).
COMMON_SCALARS = ("ROAD_MAGIC_GRIP_NUMBER", "RADIUS", "WIDTH")
EXTRA_SCALARS = {**{i: ("TYRE_PATCH_LENGTH",) for i in range(4)}, 4: ("OFFROAD_MAGIC_GRIP_NUMBER",),
                 5: ("OFFROAD_MAGIC_GRIP_NUMBER",),
                 **{72 + i: ("OFFROAD_MAGIC_GRIP_NUMBER",) + (("MASS",) if i < 2 else ()) for i in range(22)}}


def tyre_file(sounds=SOUND_INFO_COUNTS, parents=DEMO_PARENTS, scalar_first=()):
    lines = []
    names = ["DEFAULT_ROAD", "DEFAULT_OFFROAD", "DEFAULT_TRACK"] + [f"TYRE{i}" for i in range(len(parents))]
    parents = [None, "DEFAULT_ROAD", "DEFAULT_ROAD", *parents]
    for i, name in enumerate(names):
        # Like the demo, scalars follow INHERIT_TYPE unless scalar_first names the record.
        inherit = [f":INHERIT_TYPE {parents[i]}"] if parents[i] else []
        tags = TYRE_SCALAR_STORES if i < 3 else COMMON_SCALARS + EXTRA_SCALARS.get(i - 3, ())
        scalars = [f":{tag} 0.3" for tag in tags]
        lines += [f":TYPE {name}"] + ([*scalars, *inherit] if name in scalar_first else [*inherit, *scalars])
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
        self.assertEqual(summary["engine_effective_field_records"], 51)
        self.assertEqual(summary["gearbox_mapped_tags"], 9)
        self.assertEqual(summary["engine_effective_field_counts"], ENGINE_FIELD_COUNTS)
        self.assertEqual(summary["indigo_dependent_tags"],
                         sorted(set(ENGINE_FIELD_STORES) - {"ASPIRATION_TYPE", "MAX_RPM", "TORQUE_MODIFIER", "TORQUE_ARRAY"}))
        self.assertEqual(summary["tyre_effective_scalar_records"], 108)
        self.assertEqual(summary["tyre_effective_scalar_counts"], TYRE_SCALAR_COUNTS)
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
                                       "effective_scalars"])
        self.assertEqual(tyres["records"], expected["records"])
        self.assertEqual(tyres["resolved_tables"], resolve_tyre_tables(expected["records"]))
        self.assertEqual(tyres["resolved_tables"]["TYRE100"]["VERTICAL_LOAD"], "DEFAULT_TRACK")
        # The keys written before table_provenance existed keep their exact bytes.
        text = (output / "tyres.json").read_text()
        legacy = {key: tyres[key] for key in ("source", "sha256", "records", "resolved_tables")}
        self.assertTrue(text.startswith(json.dumps(legacy, indent=2, allow_nan=False)[:-2] + ",\n"))
        self.assertEqual(tyres["table_provenance"], tyre_table_provenance(expected["records"]))
        self.assertEqual(tyres["table_provenance"]["TYRE100"]["VERTICAL_LOAD"],
                         {"source": "DEFAULT_TRACK", "path": ["TYRE100", "DEFAULT_TRACK"], "source_line": 490,
                          "accessor": "0x00523e50", "record_offset": "0x4c"})
        self.assertEqual(len(tyres["table_provenance"]), 109)
        self.assertTrue(all(len(tables) == 5 for tables in tyres["table_provenance"].values()))
        self.assertEqual(tyres["effective_scalars"], effective_scalars(expected["records"]))
        self.assertEqual(len(tyres["effective_scalars"]), 108)
        self.assertNotIn("DEFAULT_ROAD", tyres["effective_scalars"])
        self.assertEqual(tyres["effective_scalars"]["TYRE100"]["fields"]["MASS"]["path"], ["TYRE100", "DEFAULT_TRACK"])
        engines = json.loads((output / "engines.json").read_text())
        self.assertNotIn("resolved_tables", engines)
        records = read_database(self.game, text_database.DATABASES["engines"], TAGS)["records"]
        self.assertEqual(list(engines), ["source", "sha256", "records", "effective_fields",
                                         "untagged_inherit_consequences"])
        self.assertEqual(engines["effective_fields"], effective_engine_fields(records))
        self.assertEqual(len(engines["effective_fields"]), 51)
        self.assertNotIn("INDIGO", engines["effective_fields"])
        self.assertEqual(engines["untagged_inherit_consequences"], untagged_inherit_consequences(records))
        self.assertEqual(list(engines["untagged_inherit_consequences"]), ["INDIGO"])
        self.assertEqual(engines["effective_fields"]["CHILD45"]["fields"]["TORQUE_ARRAY"]["path"],
                         ["CHILD45", "CHILD37"])

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

    def test_reject_wrong_effective_scalar_records(self):
        def tampered(records):
            entries = effective_scalars(records)
            del entries["TYRE5"]
            return entries
        with mock.patch.object(text_database, "effective_scalars", tampered), \
                self.assertRaisesRegex(ValueError, "Tyre effective scalar record set mismatch"):
            verify_text_databases(self.game, TAGS)

    def test_reject_effective_scalars_that_disagree_with_the_independent_derivation(self):
        # Pointing one field at another source keeps every status count, so only the derivation catches it.
        def tampered(records):
            entries = effective_scalars(records)
            entries["TYRE100"]["fields"]["MASS"].update(source="DEFAULT_ROAD", source_line=7)
            return entries
        with mock.patch.object(text_database, "effective_scalars", tampered), \
                self.assertRaisesRegex(ValueError, "disagrees with the parent-first derivation: TYRE100 MASS"):
            verify_text_databases(self.game, TAGS)

    def test_reject_wrong_effective_scalar_counts(self):
        self.write("tyres", tyre_file().replace(":TYPE TYRE0\r\n:INHERIT_TYPE DEFAULT_ROAD\r\n",
                                                ":TYPE TYRE0\r\n:INHERIT_TYPE DEFAULT_ROAD\r\n:MASS 1.0\r\n"))
        with self.assertRaisesRegex(ValueError, "Tyre effective scalar counts mismatch"):
            verify_text_databases(self.game, TAGS)

    def test_reject_unmapped_scalar_tag(self):
        self.write("tyres", tyre_file().replace(":TYPE TYRE7\r\n:INHERIT_TYPE DEFAULT_ROAD\r\n",
                                                ":TYPE TYRE7\r\n:INHERIT_TYPE DEFAULT_ROAD\r\n:LOCATION_TYPE FRONT\r\n"))
        with self.assertRaisesRegex(ValueError, "Tyre scalar tags without a byte-checked store: TYRE7"):
            verify_text_databases(self.game, TAGS)

    def test_reject_scalar_store_without_evidence(self):
        evidence = [site for site in load_field_evidence() if site["va"] != 0x00523a35]
        with self.assertRaisesRegex(ValueError, "Tyre scalar stores lack byte-checked evidence: WIDTH \\+ 0x30"):
            verify_text_databases(self.game, TAGS, evidence)

    def test_reads_the_committed_evidence_by_default(self):
        with mock.patch.object(text_database, "load_field_evidence", return_value=[]), \
                self.assertRaisesRegex(ValueError, "Engine stores lack byte-checked evidence"):
            verify_text_databases(self.game, TAGS)
        tyre_only = [site for site in load_field_evidence() if site["va"] >= text_database.TYRE_LOADER_SPAN[0]]
        with self.assertRaisesRegex(ValueError, "Engine stores lack byte-checked evidence: LOCATION_TYPE compare"):
            verify_text_databases(self.game, TAGS, tyre_only)
        engine_only = [site for site in load_field_evidence() if site["va"] < text_database.TYRE_LOADER_SPAN[0]]
        with self.assertRaisesRegex(ValueError, "Tyre scalar stores lack byte-checked evidence"):
            verify_text_databases(self.game, TAGS, engine_only)

    def test_reject_unmapped_engine_tag(self):
        self.write("engines", engine_file().replace(":TYPE DEFAULT_MODERN\r\n",
                                                    ":TYPE DEFAULT_MODERN\r\n:ADDITIONAL_BRAKING 0.5\r\n"))
        with self.assertRaisesRegex(ValueError, "Engine tags without a byte-checked store: ADDITIONAL_BRAKING "
                                                "\\(first in DEFAULT_MODERN, line 28\\)"):
            verify_text_databases(self.game, TAGS | {"ADDITIONAL_BRAKING"})

    def test_reject_engine_store_without_evidence(self):
        evidence = [site for site in load_field_evidence() if site["va"] != 0x00522a76]
        with self.assertRaisesRegex(ValueError, "Engine stores lack byte-checked evidence: MAX_RPM \\+ 0x30"):
            verify_text_databases(self.game, TAGS, evidence)

    def test_reject_engine_id_or_header_disagreement(self):
        with self.assertRaisesRegex(ValueError, "Engine stores lack byte-checked evidence: CAPACITY: analysis/tags.json"):
            verify_text_databases(self.game, TAGS, tag_ids={**load_tag_ids(), "CAPACITY": 0x38})
        header = load_layout_header().replace("    float max_fuel_flow;\n    float max_delta_fuel_flow;\n",
                                              "    float max_delta_fuel_flow;\n    float max_fuel_flow;\n")
        with self.assertRaisesRegex(ValueError, "disagree with recovered/fr3_database_layouts.h: MAX_FUELFLOW"):
            verify_text_databases(self.game, TAGS, header=header)

    def test_reject_gearbox_store_without_evidence(self):
        evidence = [site for site in load_field_evidence() if site["va"] != 0x00523388]
        with self.assertRaisesRegex(ValueError, "Gearbox stores lack byte-checked evidence: DRIVE_SPLIT \\+ 0x20"):
            verify_text_databases(self.game, TAGS, evidence)

    def test_reject_gearbox_id_or_header_disagreement(self):
        with self.assertRaisesRegex(ValueError, "Gearbox stores lack byte-checked evidence: DRIVE_TYPE: analysis/tags"):
            verify_text_databases(self.game, TAGS, tag_ids={**load_tag_ids(), "DRIVE_TYPE": 0x78})
        header = load_layout_header().replace("    uint32_t differential_type;\n    uint32_t drive_type;\n",
                                              "    uint32_t drive_type;\n    uint32_t differential_type;\n")
        with self.assertRaisesRegex(ValueError, "Gearbox stores disagree with recovered/fr3_database_layouts.h: DIFF_TYPE"):
            verify_text_databases(self.game, TAGS, header=header)

    def test_reject_gearbox_tag_without_a_mapping(self):
        stores = {tag: entry for tag, entry in GEARBOX_FIELD_STORES.items() if tag != "TORQUE_SHIFT"}
        with mock.patch.object(text_database, "GEARBOX_FIELD_STORES", stores):
            with self.assertRaisesRegex(ValueError, "GEARBOX_FIELD_STORES does not cover exactly GEARBOX_TAGS: "
                                                    "unmapped TORQUE_SHIFT"):
                verify_text_databases(self.game, TAGS)

    def test_reject_engine_field_before_inherit_type(self):
        self.write("engines", engine_file().replace(":TYPE CHILD40\r\n:INHERIT_TYPE CHILD32\r\n",
                                                    ":TYPE CHILD40\r\n:CAPACITY 2\r\n:INHERIT_TYPE CHILD32\r\n"))
        with self.assertRaisesRegex(ValueError, "Engine fields declared before INHERIT_TYPE: CHILD40"):
            verify_text_databases(self.game, TAGS)

    def test_reject_torque_array_without_its_own_max_rpm(self):
        # CHILD37's table now comes before its MAX_RPM, so it is parsed with the MAX_RPM copied from its parent;
        # CHILD45 inherits that table.
        text = engine_file()
        start = text.index(":TYPE CHILD37\r\n")
        record = text[start:text.index(":TYPE CHILD38\r\n")]
        moved = record.replace(":MAX_RPM 1\r\n", "") + ":MAX_RPM 1\r\n"
        self.write("engines", text.replace(record, moved))
        with self.assertRaisesRegex(ValueError, "TORQUE_ARRAY parsed without its record's own MAX_RPM: CHILD37 \\(from "
                                                "CHILD37\\), CHILD45 \\(from CHILD37\\)"):
            verify_text_databases(self.game, TAGS)

    def test_reject_wrong_engine_field_counts(self):
        self.write("engines", engine_file().replace(":TYPE CHILD50\r\n:INHERIT_TYPE CHILD42\r\n:TORQUE_MODIFIER 1\r\n",
                                                    ":TYPE CHILD50\r\n:INHERIT_TYPE CHILD42\r\n:TORQUE_MODIFIER 1\r\n"
                                                    ":CAPACITY 1\r\n"))
        with self.assertRaisesRegex(ValueError, "Engine effective field counts mismatch"):
            verify_text_databases(self.game, TAGS)

    def test_reject_engine_fields_that_disagree_with_the_independent_derivation(self):
        # Pointing one field at another source keeps every status count, so only the derivation catches it.
        def tampered(records):
            entries = effective_engine_fields(records)
            entries["CHILD45"]["fields"]["CAPACITY"].update(source="DEFAULT_MODERN", source_line=28)
            return entries
        with mock.patch.object(text_database, "effective_engine_fields", tampered), \
                self.assertRaisesRegex(ValueError, "disagrees with the parent-first derivation: CHILD45 CAPACITY"):
            verify_text_databases(self.game, TAGS)

    def test_reject_wrong_engine_effective_records(self):
        def tampered(records):
            entries = effective_engine_fields(records)
            del entries["CHILD7"]
            return entries
        with mock.patch.object(text_database, "effective_engine_fields", tampered), \
                self.assertRaisesRegex(ValueError, "Engine effective field record set mismatch"):
            verify_text_databases(self.game, TAGS)

    def test_reject_missing_indigo_consequence(self):
        self.write("engines", engine_file().replace("//\r\nINHERIT_TYPE DEFAULT_TRACK\r\n", "//\r\nINHERIT_TYPE LATER\r\n"))
        with self.assertRaisesRegex(ValueError, "colon-less INHERIT_TYPE line to an earlier record: none; expected INDIGO"):
            verify_text_databases(self.game, TAGS)

    def test_reject_wrong_engine_count(self):
        self.write("engines", engine_file().replace(":TYPE CHILD49\r\n:INHERIT_TYPE CHILD41\r\n:TORQUE_MODIFIER 1\r\n", ""))
        with self.assertRaisesRegex(ValueError, "Engine record count mismatch"):
            verify_text_databases(self.game, TAGS)


if __name__ == "__main__":
    unittest.main()
