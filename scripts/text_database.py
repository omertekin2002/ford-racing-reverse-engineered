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
effective_scalars() resolves, as `effective_scalars`, the scalar fields of each
inheriting tyre. The loader stores each tag in TYRE_SCALAR_STORES at its payload
offsets as it parses the tag, the record allocator zero-fills the payload, and at
INHERIT_TYPE the loader calls 0x00524090, which copies the parent's eleven dwords
+0x18..+0x40 over the record's. effective_scalars() replays that in file order:
a field holds the record's own declaration when it comes after INHERIT_TYPE,
otherwise the parent's effective value at copy time, and a declaration before
INHERIT_TYPE is overwritten. A field nobody along the chain declares is labelled
zero-filled and given no value; a scalar tag with no byte-checked store is
labelled unmapped and given no value. Values stay the declared text values: no
units, and no grip scaling applied. scalar_evidence_problems() checks
TYRE_SCALAR_STORES and the copy against field-evidence.json, and
scalars_by_recursion() derives the same fields a second way. Engine inheritance
and the colon-less INDIGO line stay unresolved.
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
# Each tyre scalar tag the loader stores, the payload offsets it writes and the field-evidence.json sites that
# byte-check each store (load_tyre_database.asm). The two grip numbers are stored, multiplied in place by the
# float at `scaled_by` and stored again, so the value a child copies is the scaled one; `scale_sites` are the
# byte-checked load of that float and the multiply.
TYRE_SCALAR_STORES = {
    "ROAD_MAGIC_GRIP_NUMBER": {"offsets": {"0x18": ["0x0052393f", "0x00523945"]}, "scaled_by": "0x00597484",
                               "scale_sites": {"load": "0x00523937", "multiply": "0x00523942"}},
    "OFFROAD_MAGIC_GRIP_NUMBER": {"offsets": {"0x1c": ["0x00523cb0", "0x00523cb6"]}, "scaled_by": "0x00597484",
                                  "scale_sites": {"load": "0x00523ca8", "multiply": "0x00523cb3"}},
    "WET_MAGIC_GRIP_PERCENTAGE": {"offsets": {"0x20": ["0x00523a1b"]}},
    "TYRE_GRIP_DEPTH": {"offsets": {"0x24": ["0x0052395a"]}},
    "RADIUS": {"offsets": {"0x28": ["0x00523900"], "0x3c": ["0x00523907"]}},
    "TYRE_PATCH_LENGTH": {"offsets": {"0x2c": ["0x0052397f"]}},
    "WIDTH": {"offsets": {"0x30": ["0x00523a35"]}},
    "MASS": {"offsets": {"0x34": ["0x00523c83"], "0x38": ["0x00523c8a"]}},
    "ROLLING_RESISTANCE": {"offsets": {"0x40": ["0x00523a4a"]}},
}
# The tyre loader's export span, the INHERIT_TYPE call to the scalar copy and the copy's export span
# (load_tyre_database.asm, copy_tyre_scalar_fields.asm).
TYRE_LOADER_SPAN = (0x00523820, 0x00523DC0)
SCALAR_COPY_CALL = 0x00523B3A
SCALAR_COPY_SPAN = (0x00524090, 0x005240E0)
# The scalar copy writes the eleven dwords +0x18..+0x40 and nothing else.
SCALAR_COPY_OFFSETS = tuple(range(0x18, 0x44, 4))
ZERO_FILLED = "not declared (zero-filled)"
UNMAPPED = "unmapped"
# How many of the 108 inheriting demo tyres end up with each status, per mapped tag. In the demo no field is
# zero-filled, none is overwritten and no tag is unmapped.
TYRE_SCALAR_COUNTS = {
    "ROAD_MAGIC_GRIP_NUMBER": {"declared": 108},
    "OFFROAD_MAGIC_GRIP_NUMBER": {"declared": 26, "inherited": 82},
    "WET_MAGIC_GRIP_PERCENTAGE": {"declared": 2, "inherited": 106},
    "TYRE_GRIP_DEPTH": {"declared": 2, "inherited": 106},
    "RADIUS": {"declared": 108},
    "TYRE_PATCH_LENGTH": {"declared": 6, "inherited": 102},
    "WIDTH": {"declared": 108},
    "MASS": {"declared": 4, "inherited": 104},
    "ROLLING_RESISTANCE": {"declared": 2, "inherited": 106},
}
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


def scalar_tags(record):
    """Return the record's scalar declarations in line order: every field but a table and INHERIT_TYPE."""
    return sorted(((tag, field) for tag, field in record["fields"].items()
                   if tag not in TYRE_TABLES and tag != "INHERIT_TYPE"), key=lambda item: item[1]["line"])


def inherit_chain(record, by_name, order):
    """Return the record names from the record up its INHERIT_TYPE chain, each parent earlier in the file."""
    chain = [record["type"]]
    current = record
    while "INHERIT_TYPE" in current["fields"]:
        inherit = current["fields"]["INHERIT_TYPE"]
        parent = inherit["values"][0]
        if parent not in by_name or order[parent] >= order[current["type"]]:
            raise TextDatabaseError(inherit["line"], f"{current['type']!r} inherits {parent!r}, "
                                                     "which is not an earlier record")
        current = by_name[parent]
        chain.append(parent)
    return chain


def scalar_field(tag, origin, chain):
    """Return one effective scalar entry: where the field's value comes from, or that nobody declares it."""
    entry = {"offsets": list(TYRE_SCALAR_STORES[tag]["offsets"])}
    if origin is None:
        return {"status": ZERO_FILLED, "path": chain, **entry}
    status = "declared" if origin["source"] == chain[0] else "inherited"
    return {"status": status, "values": origin["values"], "source": origin["source"],
            "source_line": origin["source_line"], "path": origin["path"], **entry}


def effective_scalars(records):
    """Return, for each tyre with :INHERIT_TYPE, the declaration that ends up in each mapped scalar field.

    Replays the loader in file order: each record starts zero-filled, each mapped tag stores its declaration,
    and INHERIT_TYPE copies the parent's effective fields over all of the record's, so a declaration made
    before it is overwritten (listed under `overwritten`). `path` runs from the record to the declaring source.
    Scalar tags without a byte-checked store are listed under `unmapped` with no value. Records are not modified.
    """
    by_name = {record["type"]: record for record in records}
    order = {record["type"]: i for i, record in enumerate(records)}
    state = {}
    entries = {}
    for record in records:
        name = record["type"]
        current, overwritten, unmapped = {}, [], []
        events = scalar_tags(record)
        inherit = record["fields"].get("INHERIT_TYPE")
        if inherit is not None:
            events = sorted(events + [("INHERIT_TYPE", inherit)], key=lambda item: item[1]["line"])
        for tag, field in events:
            if tag == "INHERIT_TYPE":
                parent = field["values"][0]
                if parent not in state:
                    raise TextDatabaseError(field["line"], f"{name!r} inherits {parent!r}, which is not an earlier record")
                overwritten += [{"tag": key, "line": origin["source_line"], "values": origin["values"]}
                                for key, origin in current.items()]
                current = {key: {**origin, "path": [name, *origin["path"]]} for key, origin in state[parent].items()}
            elif tag in TYRE_SCALAR_STORES:
                current[tag] = {"source": name, "source_line": field["line"], "values": field["values"], "path": [name]}
            else:
                unmapped.append({"tag": tag, "line": field["line"], "status": UNMAPPED})
        state[name] = current
        if inherit is None:
            continue
        chain = inherit_chain(record, by_name, order)
        entries[name] = {"inherit_type": {"line": inherit["line"], "parent": inherit["values"][0]},
                         "fields": {tag: scalar_field(tag, current.get(tag), chain) for tag in TYRE_SCALAR_STORES},
                         "overwritten": sorted(overwritten, key=lambda item: item["line"]), "unmapped": unmapped}
    return entries


def scalars_by_recursion(records):
    """Derive each inheriting tyre's effective scalar fields a second way, independent of effective_scalars().

    For each record and tag, parent first: the record's own declaration counts when it follows its
    INHERIT_TYPE line (or the record has none); otherwise the field is whatever the parent ends up with.
    """
    by_name = {record["type"]: record for record in records}
    order = {record["type"]: i for i, record in enumerate(records)}

    def origin(name, tag):
        record = by_name[name]
        inherit = record["fields"].get("INHERIT_TYPE")
        own = record["fields"].get(tag)
        if own is not None and (inherit is None or own["line"] > inherit["line"]):
            return {"source": name, "source_line": own["line"], "values": own["values"], "path": [name]}
        if inherit is None:
            return None
        parent = inherit["values"][0]
        if parent not in by_name or order[parent] >= order[name]:
            raise TextDatabaseError(inherit["line"], f"{name!r} inherits {parent!r}, which is not an earlier record")
        found = origin(parent, tag)
        return found and {**found, "path": [name, *found["path"]]}

    return {record["type"]: {tag: scalar_field(tag, origin(record["type"], tag),
                                               inherit_chain(record, by_name, order))
                             for tag in TYRE_SCALAR_STORES}
            for record in records if "INHERIT_TYPE" in record["fields"]}


def check_effective_scalars(records, effective):
    """Compare effective_scalars() output with scalars_by_recursion(); refuse any difference."""
    expected = scalars_by_recursion(records)
    require(set(effective) == set(expected), "Tyre effective scalar record set mismatch")
    for name, fields in expected.items():
        for tag, entry in fields.items():
            require(effective[name]["fields"].get(tag) == entry,
                    f"Tyre effective scalar disagrees with the parent-first derivation: {name} {tag}")
        require(set(effective[name]["fields"]) == set(fields), "Tyre effective scalar tag set mismatch: " + name)


def scalar_counts(effective):
    """Count, for each mapped tag, how many inheriting records end up with each status."""
    counts = {tag: {} for tag in TYRE_SCALAR_STORES}
    for entry in effective.values():
        for tag, field in entry["fields"].items():
            counts[tag][field["status"]] = counts[tag].get(field["status"], 0) + 1
    return counts


def disp8(text):
    """Return the hex offset string `0x..` a disp8 operand byte encodes, as TYRE_SCALAR_STORES writes it."""
    return f"0x{int(text, 16):02x}"


def scalar_evidence_problems(evidence, stores=None):
    """List every way TYRE_SCALAR_STORES and the scalar copy lack matching byte-checked sites.

    Each cited site must be in field-evidence.json, inside the tyre loader, and be `fst`/`fstp dword [eax + off]`
    at its offset; a scaled tag's scale_sites must be the `fld` of its global and an `fmul dword [eax + off]`.
    The loader must call
    0x00524090 at SCALAR_COPY_CALL, and inside the copy each mapped offset needs `mov ecx, [edx + off]` followed by
    `mov [eax + off], ecx`, with the copy writing exactly SCALAR_COPY_OFFSETS.
    """
    stores = TYRE_SCALAR_STORES if stores is None else stores
    by_va = {site["va"]: site["bytes"] for site in evidence}
    loader = {va: raw for va, raw in by_va.items() if TYRE_LOADER_SPAN[0] <= va < TYRE_LOADER_SPAN[1]}
    problems = []
    mapped = set()
    for tag, entry in stores.items():
        for offset, sites in entry["offsets"].items():
            mapped.add(int(offset, 16))
            for site in sites:
                raw = loader.get(int(site, 16))
                if raw is None:
                    problems.append(f"{tag} + {offset}: no byte-checked tyre loader site at {site}")
                elif not (len(raw) == 6 and raw[:2] == "d9" and raw[2:4] in ("50", "58") and disp8(raw[4:]) == offset):
                    problems.append(f"{tag} + {offset}: site {site} ({raw}) is not a float store at [eax + {offset}]")
        if "scaled_by" in entry:
            load = "d905" + int(entry["scaled_by"], 16).to_bytes(4, "little").hex()
            if loader.get(int(entry["scale_sites"]["load"], 16)) != load:
                problems.append(f"{tag}: no byte-checked load of its scale global {entry['scaled_by']} at "
                                + entry["scale_sites"]["load"])
            multiply = {"d848" + offset[2:].zfill(2) for offset in entry["offsets"]}
            if loader.get(int(entry["scale_sites"]["multiply"], 16)) not in multiply:
                problems.append(f"{tag}: no byte-checked fmul by its scale global at {entry['scale_sites']['multiply']}")
    target = SCALAR_COPY_SPAN[0] - (SCALAR_COPY_CALL + 5)
    call = "e8" + (target & 0xFFFFFFFF).to_bytes(4, "little").hex()
    if by_va.get(SCALAR_COPY_CALL) != call:
        problems.append(f"no byte-checked call from 0x{SCALAR_COPY_CALL:08x} to 0x{SCALAR_COPY_SPAN[0]:08x}")
    copied = set()
    for va, raw in sorted(by_va.items()):
        if SCALAR_COPY_SPAN[0] <= va < SCALAR_COPY_SPAN[1] and len(raw) == 6 and raw[:4] == "8948":
            offset = int(raw[4:], 16)
            if by_va.get(va - 3) == "8b4a" + raw[4:]:
                copied.add(offset)
            else:
                problems.append(f"copy store at 0x{va:08x} has no byte-checked load of parent + 0x{offset:02x} before it")
    if copied != set(SCALAR_COPY_OFFSETS):
        problems.append("byte-checked copy offsets " + ", ".join(f"0x{offset:02x}" for offset in sorted(copied))
                        + " are not exactly +0x18..+0x40")
    if mapped - copied:
        problems.append("mapped offsets the copy does not write: "
                        + ", ".join(f"0x{offset:02x}" for offset in sorted(mapped - copied)))
    return problems


def load_field_evidence(path=REPO_ROOT / "analysis/selected/field-evidence.json"):
    return json.loads(Path(path).read_text())


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


def verify_text_databases(game_dir, known_tags, evidence=None):
    """Check the parsed demo databases against the counts observed in the data.

    evidence is the field-evidence.json site list; by default the committed one is read.
    """
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
    problems = scalar_evidence_problems(load_field_evidence() if evidence is None else evidence)
    require(not problems, "Tyre scalar stores lack byte-checked evidence: " + "; ".join(problems))
    scalars = effective_scalars(tyres)
    require(set(scalars) == {record["type"] for record in tyre_inherits}, "Tyre effective scalar record set mismatch")
    check_effective_scalars(tyres, scalars)
    # docs/analysis.md states that every demo record declares its scalars after INHERIT_TYPE, so none is overwritten.
    early = sorted(name for name, entry in scalars.items() if entry["overwritten"])
    require(not early, "Tyre scalars declared before INHERIT_TYPE: " + ", ".join(early))
    unmapped = sorted(name for name, entry in scalars.items() if entry["unmapped"])
    require(not unmapped, "Tyre scalar tags without a byte-checked store: " + ", ".join(unmapped))
    counts = scalar_counts(scalars)
    require(counts == TYRE_SCALAR_COUNTS, f"Tyre effective scalar counts mismatch: {counts}")
    untagged = [{"record": record["type"], **item}
                for record in engines + gearboxes + tyres for item in record["untagged"]]
    require(untagged == [{"record": "INDIGO", "line": 1410, "tokens": ["INHERIT_TYPE", "DEFAULT_TRACK"]}],
            "Untagged line set mismatch")
    return {"engine_records": len(engines), "gearbox_records": len(gearboxes), "torque_arrays": len(torque),
            "torque_rows": [min(len(f["rows"]) for f in torque), max(len(f["rows"]) for f in torque)],
            "engine_inheritances": len(inherits), "gearbox_tags": sorted(GEARBOX_TAGS), "untagged_lines": untagged,
            "tyre_records": len(tyres), "tyre_inheritances": len(tyre_inherits), "tyre_tables": tables,
            "tyre_table_sources": sources, "tyre_effective_scalar_records": len(scalars),
            "tyre_effective_scalar_counts": counts,
            "sound_info_entries": len(entries), "sound_info_per_record": sounds}


def write_databases(game_dir, output, known_tags):
    """Parse the three text databases under game_dir into <output>/<stem>.json; return the record count per stem."""
    require(Path(game_dir).is_dir(), f"Game directory does not exist: {game_dir}")
    Path(output).mkdir(parents=True, exist_ok=True)
    counts = {}
    for stem, relative in DATABASES.items():
        database = read_database(game_dir, relative, known_tags, stem in SOUND_INFO_DATABASES)
        if stem == "tyres":
            database["resolved_tables"] = resolve_tyre_tables(database["records"])
            database["table_provenance"] = tyre_table_provenance(database["records"])
            database["effective_scalars"] = effective_scalars(database["records"])
        (Path(output) / f"{stem}.json").write_text(json.dumps(database, indent=2, allow_nan=False) + "\n")
        counts[stem] = len(database["records"])
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("game_dir", type=Path, help="Extracted Program_Executable_Files directory")
    parser.add_argument("--output", type=Path, default=Path("artifacts/text-databases"), help="Directory for engines.json, gearboxes.json and tyres.json")
    parser.add_argument("--tags", type=Path, default=REPO_ROOT / "analysis/tags.json", help="Tag registry JSON")
    args = parser.parse_args()
    for stem, count in write_databases(args.game_dir, args.output, load_known_tags(args.tags)).items():
        print(f"Parsed {count} {stem} from {DATABASES[stem]}")


if __name__ == "__main__":
    main()
