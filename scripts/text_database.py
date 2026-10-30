"""Strictly parse the engine, gearbox and tyre text databases into JSON.

Grammar accepted by parse():
  * Input is ASCII text up to MAX_TEXT_BYTES, with CRLF or LF line endings.
    Control characters other than tab are rejected.
  * `//` starts a comment that runs to the end of the line.
  * `:TYPE <NAME>` starts a record. Names are unique, use only letters, digits
    and underscores (the demo has `46_CONVERTIBLE`), are shorter than 20 bytes
    (the recovered `char name[20]` field) and are kept as strings.
  * `:TAG <values...>` adds a field to the current record. Tags must be in the
    executable's tag registry and appear at most once per record. Values are
    separated by spaces or tabs; integers and finite decimals become numbers,
    enum words stay strings.
  * A tag with no inline values opens a block. The following lines that are not
    tags are its rows. Rows hold numbers only, and every row of one block has
    the same column count. Blank and comment-only lines inside a block are
    skipped.
  * `:INHERIT_TYPE <NAME>` must name a record defined earlier in the file.
    parse() records it as a field and does not resolve it.
  * A line outside a block whose first word is a registered tag written without
    its colon (the demo's ENGDATA.DAT has `INHERIT_TYPE DEFAULT_TRACK` in
    INDIGO) is kept verbatim in the record's `untagged` list. It is not applied
    as a field, and nothing is assumed about how the game reads it. Any other
    line outside a block is rejected.
  * One `:END` closes the file. Only comments and whitespace may follow it.

The tyre database is parsed with sound_info=True, which adds `:SOUND_INFO`
sub-entries. A record may hold any number of them, each in this fixed order:
  * `:SOUND_INFO` with no inline values opens the entry.
  * `:TYPE <WORD>` names its sample type (`TYRE_SAMPLE_TYPE_SQUEAK`, ...). It is
    an enum word, not a record name, so the char[20] limit does not apply. A
    sample type appears at most once per record.
  * `:VALUE <n>`, with n a positive integer, is followed by exactly n rows of
    two numbers (an index and a value).
  * `:START_RPM <number>` closes the entry.
Nesting comes from this order, not from indentation, which varies in the demo.
`VALUE`, `TYPE` and `END` are not in the executable's tag registry, and how the
loader recognises them is not established, so their meaning comes from position:
`:TYPE` starts a sample type inside an entry and a record outside one. `:VALUE` and `:START_RPM` are accepted only inside an entry;
any other tag, a missing or extra row, or the end of the file inside an entry is
rejected. With sound_info=False (engines and gearboxes) none of this applies.

resolve_tyre_tables() resolves tyre inheritance for five tables only: the four
TYRE_TABLES blocks and the sound information. The game's accessors at
0x00523e90, 0x00523eb0, 0x00523e50, 0x00523e70 and 0x00523f10 return the
record's own table address at +0x44, +0x48, +0x4c, +0x50 or +0x54 when it is
non-zero, and otherwise repeat the test on the record at +0x14 (INHERIT_TYPE).
main() adds the result to tyres.json as `resolved_tables`. tyre_table_provenance()
adds, as `table_provenance`, the INHERIT_TYPE path to each source, the source
line and the accessor and offset the game reads through.
scalar_inheritance() lists, as `scalar_inheritance`, the scalar tags each
inheriting record declares before and after its INHERIT_TYPE line, labelled
unresolved. Scalar fields, engine inheritance and the colon-less INDIGO line
stay unresolved.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re

MAX_TEXT_BYTES = 1 << 20
NAME_FIELD_BYTES = 20
INTEGER = re.compile(r"[+-]?\d+\Z")
DECIMAL = re.compile(r"[+-]?(?:\d+\.\d*|\.\d+)\Z")
WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
NAME = re.compile(r"[A-Za-z0-9_]+\Z")
CONTROL = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")
DATABASES = {"engines": "DATA/ASCII/CARS/ENGDATA.DAT", "gearboxes": "DATA/ASCII/CARS/GEARDATA.DAT",
             "tyres": "DATA/ASCII/CARS/TYREDATA.DAT"}
SOUND_INFO_DATABASES = frozenset({"tyres"})
TYRE_TABLES = {"LONGITUDINAL_COMBINED_VALUES": {"blocks": 1, "rows": 9, "columns": 11},
               "LATERAL_COMBINED_VALUES": {"blocks": 1, "rows": 10, "columns": 21},
               "VERTICAL_LOAD": {"blocks": 3, "rows": 10, "columns": 2},
               "CAMBER_THRUST": {"blocks": 3, "rows": 10, "columns": 2}}
SOUND_INFO_COUNTS = {"DEFAULT_ROAD": 14, "DEFAULT_OFFROAD": 14, "DEFAULT_TRACK": 12}
# Tables the accessors resolve through INHERIT_TYPE; "sound_info" is the :SOUND_INFO entry list.
RESOLVED_TYRE_TABLES = (*TYRE_TABLES, "sound_info")
# The accessor that reads each table and the tyre record offset it tests (analysis/selected/tyre_table_accessors.asm).
TYRE_TABLE_ACCESSORS = {"LONGITUDINAL_COMBINED_VALUES": {"accessor": "0x00523e90", "record_offset": "0x44"},
                        "LATERAL_COMBINED_VALUES": {"accessor": "0x00523eb0", "record_offset": "0x48"},
                        "VERTICAL_LOAD": {"accessor": "0x00523e50", "record_offset": "0x4c"},
                        "CAMBER_THRUST": {"accessor": "0x00523e70", "record_offset": "0x50"},
                        "sound_info": {"accessor": "0x00523f10", "record_offset": "0x54"}}
# How many demo tyre records resolve each table to each source record.
TYRE_TABLE_SOURCES = {"LONGITUDINAL_COMBINED_VALUES": {"DEFAULT_ROAD": 109},
                      "LATERAL_COMBINED_VALUES": {"DEFAULT_ROAD": 109},
                      **{table: {"DEFAULT_ROAD": 73, "DEFAULT_OFFROAD": 23, "DEFAULT_TRACK": 13}
                         for table in ("VERTICAL_LOAD", "CAMBER_THRUST", "sound_info")}}
GEARBOX_TAGS = frozenset({"CLUTCH_SPEED", "CLUTCH_MAX_POWER", "TRANSMISSION_TYPE", "TORQUE_SHIFT", "DRIVE_TYPE",
                          "DRIVE_SPLIT", "DIFF_TYPE", "ANTI_WHEELSPIN", "ANTI_WHEELSKID"})
REPO_ROOT = Path(__file__).resolve().parents[1]


class TextDatabaseError(ValueError):
    def __init__(self, line, message):
        super().__init__(f"line {line}: {message}" if line else message)
        self.line = line


def number(token, line):
    try:
        if INTEGER.match(token):
            return int(token)
        if DECIMAL.match(token):
            parsed = float(token)
            if math.isfinite(parsed):
                return parsed
    except ValueError:  # Integers beyond Python's digit limit.
        pass
    raise TextDatabaseError(line, f"unparsable number {token!r}")


def value(token, line):
    if INTEGER.match(token) or DECIMAL.match(token):
        return number(token, line)
    if WORD.match(token):
        return token
    raise TextDatabaseError(line, f"unparsable value {token!r}")


def lines_of(text):
    if isinstance(text, (bytes, bytearray)):
        if len(text) > MAX_TEXT_BYTES:
            raise TextDatabaseError(None, f"input exceeds {MAX_TEXT_BYTES} bytes")
        try:
            text = bytes(text).decode("ascii")
        except UnicodeDecodeError as error:
            raise TextDatabaseError(text.count(b"\n", 0, error.start) + 1, "non-ASCII byte") from None
    elif len(text) > MAX_TEXT_BYTES:
        raise TextDatabaseError(None, f"input exceeds {MAX_TEXT_BYTES} bytes")
    for number_, line in enumerate(text.split("\n"), 1):
        if line.endswith("\r"):
            line = line[:-1]
        if not line.isascii():
            raise TextDatabaseError(number_, "non-ASCII character")
        if CONTROL.search(line):
            raise TextDatabaseError(number_, "control character")
        yield number_, line.split("//", 1)[0].split()


def sound_info_tag(entry, expect, tag, values, line):
    """Apply one tag inside an open :SOUND_INFO entry; return the next expectation."""
    if expect == "rows":
        raise TextDatabaseError(line, f":SOUND_INFO entry from line {entry['line']} has {len(entry['rows'])} rows, "
                                      f":VALUE says {entry['value_count']}")
    if tag != expect:
        raise TextDatabaseError(line, f":SOUND_INFO entry from line {entry['line']} expects :{expect} here, not :{tag}")
    if len(values) != 1:
        raise TextDatabaseError(line, f":{tag} in a :SOUND_INFO entry needs exactly one value")
    if tag == "TYPE":
        if not WORD.match(values[0]):
            raise TextDatabaseError(line, f"unparsable sample type {values[0]!r}")
        entry["type"] = values[0]
        return "VALUE"
    if tag == "VALUE":
        if not INTEGER.match(values[0]) or number(values[0], line) < 1:
            raise TextDatabaseError(line, f":VALUE needs a positive integer row count, not {values[0]!r}")
        entry["value_count"] = number(values[0], line)
        return "rows"
    entry["start_rpm"] = number(values[0], line)
    return None


def parse(text, known_tags, sound_info=False):
    """Return the records of one text database in file order.

    sound_info=True accepts the tyre database's nested :SOUND_INFO entries.
    """
    records = []
    names = set()
    record = None
    block = None
    entry = None
    expect = None
    closed_entry = False
    ended = None
    last = 0
    for line, tokens in lines_of(text):
        last = line
        if not tokens:
            continue
        if ended:
            raise TextDatabaseError(line, f"content after :END on line {ended}")
        head = tokens[0]
        if not head.startswith(":"):
            if entry is not None:
                if expect != "rows":
                    raise TextDatabaseError(line, f"row in the :SOUND_INFO entry from line {entry['line']} "
                                                  + ("before :VALUE" if expect != "START_RPM" else
                                                     f"beyond its :VALUE {entry['value_count']}"))
                row = [number(token, line) for token in tokens]
                if len(row) != 2:
                    raise TextDatabaseError(line, f"sound row has {len(row)} columns, needs an index and a value")
                entry["rows"].append(row)
                if len(entry["rows"]) == entry["value_count"]:
                    expect = "START_RPM"
                continue
            if record is None:
                raise TextDatabaseError(line, "content before the first :TYPE")
            if block is None:
                if head in known_tags:
                    record["untagged"].append({"line": line, "tokens": tokens})
                    continue
                raise TextDatabaseError(line, "continuation row with no open tag")
            row = [number(token, line) for token in tokens]
            rows = block["rows"]
            if rows and len(row) != len(rows[0]):
                raise TextDatabaseError(line, f"row has {len(row)} columns, block has {len(rows[0])}")
            rows.append(row)
            continue
        if block is not None and not block["rows"]:
            raise TextDatabaseError(block["line"], "tag has neither values nor rows")
        block = None
        tag, values = head[1:], tokens[1:]
        if entry is not None:
            expect = sound_info_tag(entry, expect, tag, values, line)
            if tag == "TYPE":
                if any(other is not entry and other["type"] == entry["type"] for other in record["sound_info"]):
                    raise TextDatabaseError(line, f"duplicate sample type {entry['type']!r} in record {record['type']!r}")
            if expect is None:
                entry = None
                closed_entry = True
            continue
        after_entry, closed_entry = closed_entry, False
        if tag == "TYPE":
            if len(values) != 1:
                raise TextDatabaseError(line, ":TYPE needs exactly one name")
            name = values[0]
            if not NAME.match(name):
                raise TextDatabaseError(line, f"record name {name!r} has characters other than A-Z, a-z, 0-9 and _")
            if len(name.encode("ascii")) >= NAME_FIELD_BYTES:
                raise TextDatabaseError(line, f"record name {name!r} does not fit char[{NAME_FIELD_BYTES}]")
            if name in names:
                raise TextDatabaseError(line, f"duplicate record name {name!r}")
            record = {"type": name, "line": line, "fields": {}, "untagged": []}
            if sound_info:
                record["sound_info"] = []
            records.append(record)
            names.add(name)
            continue
        if tag == "END":
            if values:
                raise TextDatabaseError(line, ":END takes no values")
            ended = line
            continue
        if record is None:
            raise TextDatabaseError(line, "content before the first :TYPE")
        if sound_info and tag == "SOUND_INFO":
            if values:
                raise TextDatabaseError(line, ":SOUND_INFO takes no inline values")
            entry = {"line": line, "type": None, "value_count": None, "rows": [], "start_rpm": None}
            expect = "TYPE"
            record["sound_info"].append(entry)
            continue
        if sound_info and tag == "START_RPM" and after_entry:
            raise TextDatabaseError(line, "duplicate :START_RPM after the :SOUND_INFO entry it closed")
        if sound_info and tag in ("VALUE", "START_RPM"):
            raise TextDatabaseError(line, f":{tag} outside a :SOUND_INFO entry")
        if tag not in known_tags:
            raise TextDatabaseError(line, f"unknown tag {tag!r}")
        if tag in record["fields"]:
            raise TextDatabaseError(line, f"duplicate tag {tag!r} in record {record['type']!r}")
        if tag == "INHERIT_TYPE":
            if len(values) != 1:
                raise TextDatabaseError(line, ":INHERIT_TYPE needs exactly one name")
            if values[0] not in names or values[0] == record["type"]:
                raise TextDatabaseError(line, f"inherits {values[0]!r}, which is not an earlier record")
            parsed = list(values)
        else:
            parsed = [value(token, line) for token in values]
        field = {"line": line, "values": parsed, "rows": []}
        record["fields"][tag] = field
        if not parsed:
            block = field
    if block is not None and not block["rows"]:
        raise TextDatabaseError(block["line"], "tag has neither values nor rows")
    if entry is not None:
        raise TextDatabaseError(last, f"file ends inside the :SOUND_INFO entry from line {entry['line']}")
    if not ended:
        raise TextDatabaseError(last, "missing :END")
    return records


def has_local_table(record, table):
    if table == "sound_info":
        return bool(record["sound_info"])
    return table in record["fields"]


def table_line(record, table):
    """Return the line on which a record declares a table: its tag, or its first :SOUND_INFO."""
    if table == "sound_info":
        return record["sound_info"][0]["line"]
    return record["fields"][table]["line"]


def table_path(record, table, by_name, limit):
    """Return the record names the accessor visits for one table, from the record to its source."""
    path = [record["type"]]
    current = record
    # parse() only accepts an INHERIT_TYPE naming an earlier record, so no chain loops.
    for _ in range(limit):
        if has_local_table(current, table):
            return path
        inherit = current["fields"].get("INHERIT_TYPE")
        if inherit is None:
            raise TextDatabaseError(record["line"], f"tyre {record['type']!r} has no {table} table, "
                                                    f"and its INHERIT_TYPE chain ends at {current['type']!r}")
        parent = inherit["values"][0]
        if parent not in by_name:
            raise TextDatabaseError(inherit["line"], f"{current['type']!r} inherits unknown record {parent!r}")
        current = by_name[parent]
        path.append(parent)
    raise TextDatabaseError(record["line"], f"INHERIT_TYPE chain of tyre {record['type']!r} "
                                            f"does not end within {limit} records")


def tyre_table_paths(records):
    by_name = {record["type"]: record for record in records}
    return {record["type"]: {table: table_path(record, table, by_name, len(records)) for table in RESOLVED_TYRE_TABLES}
            for record in records}


def resolve_tyre_tables(records):
    """Return, for each tyre record, the name of the record whose table the game reads.

    Like the accessors, this follows INHERIT_TYPE through any depth until a record
    has its own table. A chain that ends without one is an error: the game would
    follow a null +0x14 there. The records are not modified.
    """
    return {name: {table: path[-1] for table, path in paths.items()} for name, paths in tyre_table_paths(records).items()}


def tyre_table_provenance(records):
    """Return, for each tyre record and table, how resolve_tyre_tables() reached its source.

    `path` lists the records visited, the record itself first and the source last.
    `source_line` is where the source declares the table, and `accessor` and
    `record_offset` name the routine and record field the game reads it through.
    """
    by_name = {record["type"]: record for record in records}
    return {name: {table: {"source": path[-1], "path": path, "source_line": table_line(by_name[path[-1]], table),
                           **TYRE_TABLE_ACCESSORS[table]}
                   for table, path in paths.items()}
            for name, paths in tyre_table_paths(records).items()}


def scalar_inheritance(records):
    """List, for each tyre with :INHERIT_TYPE, the scalar tags it declares before and after that line.

    Only facts from the file: no inherited value is computed, because the copy at
    0x00524090 depends on tag order, which is not modelled.
    """
    entries = {}
    for record in records:
        inherit = record["fields"].get("INHERIT_TYPE")
        if inherit is None:
            continue
        scalars = [{"tag": tag, "line": field["line"]} for tag, field in record["fields"].items()
                   if tag not in TYRE_TABLES and tag != "INHERIT_TYPE"]
        entries[record["type"]] = {
            "status": "unresolved", "inherit_type": {"line": inherit["line"], "parent": inherit["values"][0]},
            "scalars_before": [scalar for scalar in scalars if scalar["line"] < inherit["line"]],
            "scalars_after": [scalar for scalar in scalars if scalar["line"] > inherit["line"]]}
    return entries


def sources_in_file_order(records):
    """Return each tyre's table sources from its own tables, else its parent's sources.

    An independent check on resolve_tyre_tables(): it does not walk chains through
    table_path(). parse() only accepts an INHERIT_TYPE naming an earlier record, so
    every parent's sources are known before its children. A missing table is None.
    """
    sources = {}
    for record in records:
        inherit = record["fields"].get("INHERIT_TYPE")
        parent = sources.get(inherit["values"][0], {}) if inherit else {}
        sources[record["type"]] = {table: record["type"] if has_local_table(record, table) else parent.get(table)
                                   for table in RESOLVED_TYRE_TABLES}
    return sources


def check_table_provenance(records, provenance):
    """Check that every provenance path follows INHERIT_TYPE to a record declaring the table on source_line."""
    by_name = {record["type"]: record for record in records}
    require(set(provenance) == set(by_name), "Tyre table provenance record set mismatch")
    for name, tables in provenance.items():
        require(set(tables) == set(RESOLVED_TYRE_TABLES), "Tyre table provenance table set mismatch: " + name)
        for table, entry in tables.items():
            label = f"{name} {table}"
            path = entry["path"]
            require(path and path[0] == name, "Tyre table provenance path does not start at its record: " + label)
            require(entry["source"] == path[-1], "Tyre table provenance source is not the path end: " + label)
            for here, there in zip(path, path[1:], strict=False):
                record = by_name.get(here)
                inherit = record and record["fields"].get("INHERIT_TYPE")
                require(inherit and inherit["values"] == [there] and not has_local_table(record, table),
                        f"Tyre table provenance hop {here} -> {there} does not follow INHERIT_TYPE: " + label)
            source = by_name.get(path[-1])
            require(source and has_local_table(source, table) and table_line(source, table) == entry["source_line"],
                    "Tyre table provenance source does not declare the table on source_line: " + label)
            require({key: entry[key] for key in ("accessor", "record_offset")} == TYRE_TABLE_ACCESSORS[table],
                    "Tyre table provenance accessor mismatch: " + label)


def table_sources(resolved):
    """Count, for each table, how many records resolve it to each source record."""
    counts = {table: {} for table in RESOLVED_TYRE_TABLES}
    for sources in resolved.values():
        for table, source in sources.items():
            counts[table][source] = counts[table].get(source, 0) + 1
    return counts


def load_known_tags(path=REPO_ROOT / "analysis/tags.json"):
    return {tag["name"] for tag in json.loads(Path(path).read_text())}


def read_database(game_dir, relative, known_tags, sound_info=False):
    data = (Path(game_dir) / relative).read_bytes()
    return {"source": relative, "sha256": hashlib.sha256(data).hexdigest(),
            "records": parse(data, known_tags, sound_info)}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def table_dimensions(records, tag):
    """Return block count and the shape shared by every block of one tag."""
    blocks = [record["fields"][tag] for record in records if tag in record["fields"]]
    require(blocks and all(not field["values"] for field in blocks), "Tyre table is not a block: " + tag)
    # The parser already gives every row of one block the same column count.
    shapes = {(len(field["rows"]), len(field["rows"][0])) for field in blocks}
    require(len(shapes) == 1, "Tyre table shapes differ: " + tag)
    (rows, columns), = shapes
    return {"blocks": len(blocks), "rows": rows, "columns": columns}


def verify_text_databases(game_dir, known_tags):
    """Check the parsed demo databases against the counts observed in the data."""
    engines = read_database(game_dir, DATABASES["engines"], known_tags)["records"]
    gearboxes = read_database(game_dir, DATABASES["gearboxes"], known_tags)["records"]
    tyres = read_database(game_dir, DATABASES["tyres"], known_tags, sound_info=True)["records"]
    require(len(engines) == 56, f"Engine record count mismatch: {len(engines)}")
    require(len(gearboxes) == 14, f"Gearbox record count mismatch: {len(gearboxes)}")
    torque = [record["fields"]["TORQUE_ARRAY"] for record in engines if "TORQUE_ARRAY" in record["fields"]]
    require(len(torque) == 43, f"Torque array count mismatch: {len(torque)}")
    require(all(not field["values"] and 5 <= len(field["rows"]) <= 10 and all(len(row) == 2 for row in field["rows"])
                for field in torque), "Torque array shape mismatch")
    inherits = [record for record in engines if "INHERIT_TYPE" in record["fields"]]
    require(len(inherits) == 51, f"Engine inheritance count mismatch: {len(inherits)}")
    for record in gearboxes:
        require(set(record["fields"]) == GEARBOX_TAGS, "Gearbox tag set mismatch: " + record["type"])
    require(len(tyres) == 109, f"Tyre record count mismatch: {len(tyres)}")
    tyre_inherits = [record for record in tyres if "INHERIT_TYPE" in record["fields"]]
    require(len(tyre_inherits) == 108, f"Tyre inheritance count mismatch: {len(tyre_inherits)}")
    tables = {tag: table_dimensions(tyres, tag) for tag in TYRE_TABLES}
    require(tables == TYRE_TABLES, f"Tyre table dimensions mismatch: {tables}")
    sounds = {record["type"]: len(record["sound_info"]) for record in tyres if record["sound_info"]}
    require(sounds == SOUND_INFO_COUNTS, f"Sound entry count mismatch: {sounds}")
    entries = [entry for record in tyres for entry in record["sound_info"]]
    require(all(entry["value_count"] == 10 for entry in entries), "Sound entry row count mismatch")
    resolved = resolve_tyre_tables(tyres)
    sources = table_sources(resolved)
    require(sources == TYRE_TABLE_SOURCES, f"Tyre table source mismatch: {sources}")
    expected = sources_in_file_order(tyres)
    require(resolved == expected, "resolved_tables disagrees with INHERIT_TYPE resolved in file order")
    provenance = tyre_table_provenance(tyres)
    check_table_provenance(tyres, provenance)
    require({name: {table: entry["source"] for table, entry in tables.items()} for name, tables in provenance.items()}
            == expected, "Tyre table provenance disagrees with INHERIT_TYPE resolved in file order")
    scalars = scalar_inheritance(tyres)
    require(set(scalars) == {record["type"] for record in tyre_inherits}
            and all(entry["status"] == "unresolved" for entry in scalars.values()),
            "Tyre scalar inheritance record set mismatch")
    # docs/analysis.md states that every demo record declares its scalars after INHERIT_TYPE.
    early = sorted(name for name, entry in scalars.items() if entry["scalars_before"])
    require(not early, "Tyre scalars declared before INHERIT_TYPE: " + ", ".join(early))
    untagged = [{"record": record["type"], **item}
                for record in engines + gearboxes + tyres for item in record["untagged"]]
    require(untagged == [{"record": "INDIGO", "line": 1410, "tokens": ["INHERIT_TYPE", "DEFAULT_TRACK"]}],
            "Untagged line set mismatch")
    return {"engine_records": len(engines), "gearbox_records": len(gearboxes), "torque_arrays": len(torque),
            "torque_rows": [min(len(f["rows"]) for f in torque), max(len(f["rows"]) for f in torque)],
            "engine_inheritances": len(inherits), "gearbox_tags": sorted(GEARBOX_TAGS), "untagged_lines": untagged,
            "tyre_records": len(tyres), "tyre_inheritances": len(tyre_inherits), "tyre_tables": tables,
            "tyre_table_sources": sources, "tyre_scalar_inheritance_records": len(scalars),
            "sound_info_entries": len(entries), "sound_info_per_record": sounds}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("game_dir", type=Path, help="Extracted Program_Executable_Files directory")
    parser.add_argument("--output", type=Path, default=Path("artifacts/text-databases"), help="Directory for engines.json, gearboxes.json and tyres.json")
    parser.add_argument("--tags", type=Path, default=REPO_ROOT / "analysis/tags.json", help="Tag registry JSON")
    args = parser.parse_args()
    if not args.game_dir.is_dir():
        raise ValueError("Game directory does not exist")
    known_tags = load_known_tags(args.tags)
    args.output.mkdir(parents=True, exist_ok=True)
    for stem, relative in DATABASES.items():
        database = read_database(args.game_dir, relative, known_tags, stem in SOUND_INFO_DATABASES)
        if stem == "tyres":
            database["resolved_tables"] = resolve_tyre_tables(database["records"])
            database["table_provenance"] = tyre_table_provenance(database["records"])
            database["scalar_inheritance"] = scalar_inheritance(database["records"])
        (args.output / f"{stem}.json").write_text(json.dumps(database, indent=2, allow_nan=False) + "\n")
        print(f"Parsed {len(database['records'])} {stem} from {relative}")


if __name__ == "__main__":
    main()
