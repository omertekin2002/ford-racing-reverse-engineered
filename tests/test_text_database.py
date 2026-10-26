"""Synthetic text-database parser tests; these use no game data."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import text_database
from text_database import GEARBOX_TAGS, MAX_TEXT_BYTES, TextDatabaseError, parse, read_database, verify_text_databases

TAGS = {"CAPACITY", "LOCATION_TYPE", "INHERIT_TYPE", "TORQUE_ARRAY", "MAX_RPM", "ENGINE_BRAKING", *GEARBOX_TAGS}
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


class VerifyTextDatabaseTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.game = Path(directory.name)
        (self.game / "DATA/ASCII/CARS").mkdir(parents=True)
        self.write("engines", engine_file())
        self.write("gearboxes", gearbox_file())

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

    def test_reject_wrong_engine_count(self):
        self.write("engines", engine_file().replace(":TYPE CHILD49\r\n:INHERIT_TYPE BASE4\r\n", ""))
        with self.assertRaisesRegex(ValueError, "Engine record count mismatch"):
            verify_text_databases(self.game, TAGS)


if __name__ == "__main__":
    unittest.main()
