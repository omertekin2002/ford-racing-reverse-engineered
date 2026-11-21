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
scalars_by_recursion() derives the same fields a second way.

ENGINE_FIELD_STORES maps each engine tag the loader at 0x005227f0 stores to its
registry ID, the dispatch's `cmp eax, <id>` site and its payload offsets, each
with the Fr3EngineRecord field, width (dword or byte) and store sites.
TORQUE_ARRAY zero-fills an 18-slot block at +0x3c, stores each row's second
column into it, reads its row count from the MAX_RPM value at +0x30 present when
the tag is parsed, and may write a derived +0x2c (both stores are conditional);
TURBO_MASS writes a derived reciprocal at +0xa4. ENGINE_COPY records INHERIT_TYPE: the parent lookup, the
call to the copy at 0x00522c80 with the parent in EDX and the record in EAX,
the parent store at +0x18, and the copy's byte, dword and 0x48-byte block moves.
engine_evidence_problems() checks both against field-evidence.json and requires
the copied bytes to equal the stored ones, name and +0x18 excluded;
engine_layout_problems() checks every mapped offset against
recovered/fr3_database_layouts.h; unmapped_engine_tags() names any engine tag in
use with no mapped store.
effective_engine_fields() resolves, as engines.json `effective_fields`, each
inheriting engine's mapped fields the way effective_scalars() does for tyres:
it replays the loader in file order, each record zero-filled, each mapped tag
stored as parsed and INHERIT_TYPE copying the parent's effective state, torque
block included, over the record's. A record's own TORQUE_ARRAY replaces the
parent's whole table, and its entry names the MAX_RPM declaration in the record
when it was parsed. The derived +0x2c and +0xa4 get no value: their entries
name the declarations that may have produced them (both of +0x2c's possible
origins, as its stores are conditional). Values stay the declared text, with
no units. engine_fields_by_recursion() derives the same fields parent first.
untagged_inherit_consequences() lists, as `untagged_inherit_consequences`, the
fields that depend on a root's colon-less INHERIT_TYPE line (the demo's INDIGO)
under both readings, without choosing one; INDIGO stays a root as parsed.

GEARBOX_FIELD_STORES maps each of the nine gearbox tags the loader at 0x00523220
stores to its registry ID, the `cmp eax, <id>` that finally selects it (and,
where the selection is a jg after that range compare's jge, the jg), its reader
call (float, enum with its word table, or float converted to an integer whose
low byte is stored) and its payload offset with the Fr3GearboxRecord field,
width and store site. GEARBOX_RECORD holds the 0x34-byte allocation and the name
read; GEARBOX_COPY records INHERIT_TYPE: the name read, parent lookup, the call
to the copy at 0x00523470 with the parent in EDX and the record in EAX, and the
copy's load/store pairs. Unlike engines no parent address is stored.
gearbox_evidence_problems() checks all three against field-evidence.json and
requires the copied bytes to equal the stored ones, name and padding excluded;
gearbox_layout_problems() checks every mapped offset against
recovered/fr3_database_layouts.h, and unmapped_gearbox_tags() compares the map
with GEARBOX_TAGS. No demo gearbox declares INHERIT_TYPE, so nothing resolves
gearbox inheritance: gearboxes.json holds the records as parsed.
"""
import argparse
from copy import deepcopy
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


def _store(field, sites, width="dword", **extra):
    return {"field": field, "width": width, "sites": sites, **extra}


# Each engine tag the loader at 0x005227f0 stores (load_engine_database.asm): its registry ID, the dispatch's
# `cmp eax, <id>` site, and the payload offsets it writes, each with the Fr3EngineRecord field at that offset, the
# width and the field-evidence.json store sites. `derived` offsets hold a value the handler computes rather than the
# declared one. TORQUE_ARRAY zero-fills 18 slots at +0x3c, then stores one slot per row (each row's second column)
# through a row pointer that starts at the record and steps by 4, so the store is `[edx + 0x38]`. Its row count comes
# from the MAX_RPM value at +0x30 when the tag is parsed. LOCATION_TYPE and ASPIRATION_TYPE pass an enum word table.
ENGINE_FIELD_STORES = {
    "LOCATION_TYPE": {"id": 0xa5, "compare": "0x00522b54",
                      "offsets": {"0x14": _store("location_type", ["0x00522b70"], "byte")},
                      "enum_table": {"va": "0x00597408", "site": "0x00522b64"}},
    "FUEL_CUTOFF": {"id": 0x8a, "compare": "0x00522ae2", "offsets": {"0x1c": _store("fuel_cutoff", ["0x00522b15"])}},
    "ENGINE_BRAKING": {"id": 0x7f, "compare": "0x0052285d",
                       "offsets": {"0x20": _store("engine_braking", ["0x00522ada"])}},
    "TORQUE_MODIFIER": {"id": 0x119, "compare": "0x00522a00",
                        "offsets": {"0x24": _store("torque_modifier", ["0x00522a0e"])}},
    "ROUGHNESS": {"id": 0xe4, "compare": "0x005228f6", "offsets": {"0x28": _store("roughness", ["0x0052290e"])}},
    "TORQUE_ARRAY": {"id": 0x118, "compare": "0x005228ef",
                     "offsets": {"0x2c": _store("derived_rpm", ["0x005229c1", "0x005229f8"], derived=True,
                                                conditional=["0x00522980", "0x005229b6", "0x005229e9"]),
                                 "0x3c": _store("torque", ["0x00522969"], slots=18)},
                     "zero_fill": {"size": "0x0052291c", "destination": "0x00522921", "value": "0x00522924",
                                   "call": "0x00522926"},
                     "row_count": {"offset": "0x30", "site": "0x0052292b"},
                     "row_pointer": {"start": "0x00522952", "step": "0x0052295b"}},
    "MAX_RPM": {"id": 0xb0, "compare": "0x005228b1", "offsets": {"0x30": _store("max_rpm", ["0x00522a76"])}},
    "CAPACITY": {"id": 0x37, "compare": "0x00522bd0", "offsets": {"0x34": _store("capacity", ["0x00522be0"])}},
    "TICKOVER_RPM": {"id": 0x112, "compare": "0x00522a53",
                     "offsets": {"0x38": _store("tickover_rpm", ["0x00522a65"])}},
    "MAX_TURBO_PRESSURE": {"id": 0xb1, "compare": "0x00522a7e",
                           "offsets": {"0x84": _store("max_turbo_pressure", ["0x00522a8c"])}},
    "FLYWHEEL_MASS": {"id": 0x87, "compare": "0x00522ae9", "offsets": {"0x88": _store("flywheel_mass", ["0x00522b01"])}},
    "FLYWHEEL_RADIUS": {"id": 0x88, "compare": "0x00522b78",
                        "offsets": {"0x8c": _store("flywheel_radius", ["0x00522b8a"])}},
    "ACCELERATOR_SPEED": {"id": 0x1, "compare": "0x00522866",
                          "offsets": {"0x90": _store("accelerator_speed", ["0x00522b9e"])}},
    "NUMBER_OF_TURBOS": {"id": 0xc8, "compare": "0x005228aa",
                         "offsets": {"0x94": _store("turbo_count", ["0x005228e4"], "byte")}},
    "NUMBER_OF_CYLINDERS": {"id": 0xc6, "compare": "0x00522a97",
                            "offsets": {"0x95": _store("cylinder_count", ["0x00522aa9"], "byte")}},
    "ASPIRATION_TYPE": {"id": 0x10, "compare": "0x00522ba9",
                        "offsets": {"0x98": _store("aspiration_type", ["0x00522bc5"])},
                        "enum_table": {"va": "0x005973f8", "site": "0x00522bb9"}},
    "MAX_AIRFLOW": {"id": 0xab, "compare": "0x00522856", "offsets": {"0x9c": _store("max_airflow", ["0x005228a2"])}},
    "TURBO_MASS": {"id": 0x15b, "compare": "0x00522a16",
                   "offsets": {"0xa0": _store("turbo_mass", ["0x00522a28"]),
                               "0xa4": _store("inverse_turbo_mass", ["0x00522a48", "0x00522c4e"], derived=True)}},
    "MAX_FUELFLOW": {"id": 0xae, "compare": "0x00522ab4", "offsets": {"0xa8": _store("max_fuel_flow", ["0x00522ac6"])}},
    "MAX_DELTA_FUELFLOW": {"id": 0xad, "compare": "0x005228bc",
                           "offsets": {"0xac": _store("max_delta_fuel_flow", ["0x005228d0"])}},
}
# Both +0x2c stores are conditional (the jumps at 0x00522980, 0x005229b6 and 0x005229e9, listed as `conditional`), so
# +0x2c can keep what an earlier INHERIT_TYPE copied, or zero. Every store and jump site's field-evidence.json claim
# starts with its tag's name.
# INHERIT_TYPE in the engine loader and the copy it calls (copy_engine_record.asm). The loader looks the parent up by
# name, passes it in EDX and the record in EAX to the copy, then stores the parent at +0x18. The copy keeps the record
# in EBX and writes `offsets` (each a load of parent + n into AL/EAX followed by a store at record + n) and the
# `block` with a repeated movsd of size >> 2 dwords and a repeated movsb of size & 3 bytes. It leaves the name and
# +0x18 alone.
# How many of the 51 inheriting demo engines end up with each status, per mapped tag. The five roots declare every
# mapped tag, so in the demo no field is zero-filled; none is overwritten and no tag is unmapped.
ENGINE_FIELD_COUNTS = {
    "LOCATION_TYPE": {"declared": 6, "inherited": 45},
    "FUEL_CUTOFF": {"declared": 8, "inherited": 43},
    "ENGINE_BRAKING": {"declared": 1, "inherited": 50},
    "TORQUE_MODIFIER": {"declared": 51},
    "ROUGHNESS": {"declared": 16, "inherited": 35},
    "TORQUE_ARRAY": {"declared": 38, "inherited": 13},
    "MAX_RPM": {"declared": 38, "inherited": 13},
    "CAPACITY": {"declared": 14, "inherited": 37},
    "TICKOVER_RPM": {"declared": 6, "inherited": 45},
    "MAX_TURBO_PRESSURE": {"declared": 14, "inherited": 37},
    "FLYWHEEL_MASS": {"declared": 7, "inherited": 44},
    "FLYWHEEL_RADIUS": {"declared": 4, "inherited": 47},
    "ACCELERATOR_SPEED": {"declared": 3, "inherited": 48},
    "NUMBER_OF_TURBOS": {"declared": 14, "inherited": 37},
    "NUMBER_OF_CYLINDERS": {"declared": 8, "inherited": 43},
    "ASPIRATION_TYPE": {"declared": 18, "inherited": 33},
    "MAX_AIRFLOW": {"declared": 3, "inherited": 48},
    "TURBO_MASS": {"declared": 14, "inherited": 37},
    "MAX_FUELFLOW": {"declared": 4, "inherited": 47},
    "MAX_DELTA_FUELFLOW": {"declared": 3, "inherited": 48},
}
ENGINE_LOADER_SPAN = (0x005227F0, 0x00522C80)
ENGINE_COPY = {
    "tag": "INHERIT_TYPE", "id": 0x9c, "compare": "0x00522b1d",
    "find_parent": {"call": "0x00522b3c", "target": "0x00522d70"},
    "arguments": {"parent_in_ecx": "0x00522b41", "parent_in_edx": "0x00522b43", "record_in_eax": "0x00522b45"},
    "call": "0x00522b47",
    "parent_store": {"offset": "0x18", "field": "inherited_address", "site": "0x00522b4c"},
    "span": (0x00522C80, 0x00522D6C),
    # The copy saves and restores ECX, so the parent address kept there survives to the +0x18 store.
    "keeps_ecx": {"push": "0x00522c81", "pop": "0x00522d69"},
    "record_in_ebx": "0x00522c84",
    "offsets": {"0x14": "byte", **{f"0x{offset:x}": "dword" for offset in range(0x1c, 0x3c, 4)},
                **{f"0x{offset:x}": "dword" for offset in range(0x84, 0x94, 4)}, "0x94": "byte", "0x95": "byte",
                **{f"0x{offset:x}": "dword" for offset in range(0x98, 0xb0, 4)}},
    "block": {"offset": "0x3c", "size": 0x48,
              "sites": {"size": "0x00522c86", "source": "0x00522c8e", "destination": "0x00522c94",
                        "keep_size": "0x00522cc8", "dword_count": "0x00522cca", "movsd": "0x00522ccd",
                        "remainder": "0x00522ccf", "remainder_mask": "0x00522cd1", "movsb": "0x00522cd4"}},
}
FILL_MEMORY = 0x00534690
ENGINE_RECORD_SIZE = 0xb0
# The name the record-creating branch reads into the payload's first 0x14 bytes; the copy must not write it.
ENGINE_NAME_BYTES = 0x14
# ENGDATA.DAT words that are not stored fields: INHERIT_TYPE is the copy above; TYPE and END are not fields.
ENGINE_UNSTORED_TAGS = frozenset({"TYPE", "INHERIT_TYPE", "END"})
GEARBOX_TAGS = frozenset({"CLUTCH_SPEED", "CLUTCH_MAX_POWER", "TRANSMISSION_TYPE", "TORQUE_SHIFT", "DRIVE_TYPE",
                          "DRIVE_SPLIT", "DIFF_TYPE", "ANTI_WHEELSPIN", "ANTI_WHEELSKID"})
FLOAT_READER = 0x0042E680
ENUM_READER = 0x0042E820
STRING_READER = 0x0042E7C0
# Each gearbox tag the loader at 0x00523220 stores (load_gearbox_database.asm): its registry ID, the `cmp eax, <id>`
# that finally selects it, how its value is read and the payload offset it writes, with the Fr3GearboxRecord field,
# width and store sites. The dispatch is a tree of range compares. CLUTCH_SPEED, DRIVE_TYPE, TORQUE_SHIFT and
# ANTI_WHEELSKID are selected by a jg that follows the jge of their own range compare (`after_range`): falling through
# it means the ID equals the compared one. `read` names the reader call: a float from FLOAT_READER stored with fstp, an
# enum from ENUM_READER given the word table in `enum_table`, or (`float_to_byte`) a float passed to `convert`,
# stored as an integer with fistp to a stack temporary whose low byte is then stored.
GEARBOX_FIELD_STORES = {
    "CLUTCH_SPEED": {"id": 0x5f, "compare": "0x00523289", "after_range": "0x005232c1",
                     "read": {"kind": "float", "call": "0x005232c5"},
                     "offsets": {"0x14": _store("clutch_speed", ["0x005232ca"])}},
    "CLUTCH_MAX_POWER": {"id": 0x5e, "compare": "0x005233cb", "read": {"kind": "float", "call": "0x005233d6"},
                         "offsets": {"0x18": _store("clutch_max_power", ["0x005233db"])}},
    "TORQUE_SHIFT": {"id": 0x11a, "compare": "0x00523310", "after_range": "0x00523343",
                     "read": {"kind": "float", "call": "0x00523347"},
                     "offsets": {"0x1c": _store("torque_shift", ["0x0052334c"])}},
    "DRIVE_SPLIT": {"id": 0x76, "compare": "0x00523378", "read": {"kind": "float", "call": "0x00523383"},
                    "offsets": {"0x20": _store("drive_split", ["0x00523388"])}},
    "TRANSMISSION_TYPE": {"id": 0x159, "compare": "0x00523354", "read": {"kind": "enum", "call": "0x0052336b"},
                          "enum_table": {"va": "0x0059743c", "site": "0x00523364"},
                          "offsets": {"0x24": _store("transmission_type", ["0x00523370"])}},
    "DIFF_TYPE": {"id": 0x6d, "compare": "0x005232d4", "read": {"kind": "enum", "call": "0x005232eb"},
                  "enum_table": {"va": "0x00597460", "site": "0x005232e4"},
                  "offsets": {"0x28": _store("differential_type", ["0x005232f0"])}},
    "DRIVE_TYPE": {"id": 0x77, "compare": "0x005232cf", "after_range": "0x005232f5",
                   "read": {"kind": "enum", "call": "0x00523303"},
                   "enum_table": {"va": "0x0059744c", "site": "0x005232fc"},
                   "offsets": {"0x2c": _store("drive_type", ["0x00523308"])}},
    "ANTI_WHEELSPIN": {"id": 0xf, "compare": "0x005233ac",
                       "read": {"kind": "float_to_byte", "call": "0x005233b3", "convert": "0x005233b8",
                                "fistp": "0x005233bd", "low_byte": "0x005233c0"},
                       "offsets": {"0x30": _store("anti_wheelspin", ["0x005233c3"], "byte")}},
    "ANTI_WHEELSKID": {"id": 0xe, "compare": "0x0052328e", "after_range": "0x00523390",
                       "read": {"kind": "float_to_byte", "call": "0x00523394", "convert": "0x00523399",
                                "fistp": "0x0052339e", "low_byte": "0x005233a1"},
                       "offsets": {"0x31": _store("anti_wheelskid", ["0x005233a4"], "byte")}},
}
GEARBOX_FLOAT_TO_BYTE_CALL = 0x005352FA
# How each `read` kind's value reaches the record: the reader it calls and the register the store writes.
GEARBOX_READS = {"float": (FLOAT_READER, "st0"), "enum": (ENUM_READER, "eax"), "float_to_byte": (FLOAT_READER, "al")}
GEARBOX_LOADER_SPAN = (0x00523220, 0x00523470)
GEARBOX_RECORD_SIZE = 0x34
GEARBOX_NAME_BYTES = 0x14
# The 0x34-byte payload allocation and the record-creating branch, which reads the name into the payload's first
# 0x14 bytes.
GEARBOX_RECORD = {"allocation": {"size": "0x00523234", "call": "0x00523242", "target": "0x0042ed50"},
                  "node_in_edi": "0x005233fe", "payload_in_edi": "0x0052340a",
                  "name": {"size": "0x00523405", "destination": "0x0052340f", "call": "0x00523411"}}
# INHERIT_TYPE in the gearbox loader and the copy it calls (copy_gearbox_record.asm). The loader reads the parent's
# name into a stack buffer, looks the parent up by it, and calls the copy with the parent in EDX and the record in
# EAX; then it reads the next tag. Unlike the engine loader it stores no parent address: + 0x18 is CLUTCH_MAX_POWER.
# The copy saves EBX and ECX and writes `offsets`, each a load of parent + n into a register followed by a store of
# that register at record (EAX) + n; it leaves the name and padding_32 alone. No demo gearbox declares INHERIT_TYPE.
GEARBOX_COPY = {
    "tag": "INHERIT_TYPE", "id": 0x9c, "compare": "0x00523317",
    "read_name": {"size": "0x0052331e", "buffer": "0x00523323", "call": "0x00523328"},
    "find_parent": {"name": "0x0052332d", "call": "0x00523330", "target": "0x005234b0"},
    "arguments": {"parent_in_edx": "0x00523335", "record_in_eax": "0x00523337"},
    "call": "0x00523339",
    "next_tag": "0x0052333e",
    "span": (0x00523470, 0x005234AB),
    "saves": {"push_ebx": "0x00523470", "push_ecx": "0x00523471", "pop_ecx": "0x005234a8", "pop_ebx": "0x005234a9",
              "ret": "0x005234aa"},
    "offsets": {**{f"0x{offset:x}": "dword" for offset in range(0x14, 0x30, 4)}, "0x30": "byte", "0x31": "byte"},
}
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


# A Jcc with an 8-bit (7x) or 32-bit (0f 8x) displacement.
CONDITIONAL_JUMP = re.compile(r"7[0-9a-f][0-9a-f]{2}|0f8[0-9a-f][0-9a-f]{8}")
REGISTERS = ("eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi")
BYTE_REGISTERS = ("al", "cl", "dl", "bl", "ah", "ch", "dh", "bh")
# Opcodes with a ModRM memory operand that the engine evidence uses, as (kind, width); 0xd9 depends on ModRM.reg.
MEMORY_OPCODES = {0x89: ("store", "dword"), 0x88: ("store", "byte"), 0xc7: ("store", "dword"),
                  0x8b: ("load", "dword"), 0x8a: ("load", "byte"), 0x8d: ("lea", None)}
X87_D9 = {0: ("load", "dword"), 2: ("store", "dword"), 3: ("store", "dword")}  # fld, fst, fstp m32


def register_family(register):
    """Return the 32-bit register a register name belongs to (al and ah -> eax); other values unchanged."""
    if register in BYTE_REGISTERS:
        return REGISTERS[BYTE_REGISTERS.index(register) % 4]
    return register


def memory_operand(raw):
    """Decode one `[base + disp]` instruction from its hex bytes, or return None for any other form.

    Handles mov/lea with a register (0x88, 0x89, 0x8a, 0x8b, 0x8d), `mov dword [base + disp], imm32` (0xc7 /0) and
    fld/fst/fstp m32 (0xd9 /0, /2, /3), with an 8- or 32-bit displacement and no SIB byte. Returns kind
    (store, load or lea), width (byte, dword or None for lea), base, disp and register (the other operand: a
    register name, `st0` or the immediate).
    """
    data = bytes.fromhex(raw)
    if len(data) < 3:
        return None
    opcode, modrm = data[0], data[1]
    mod, reg, rm = modrm >> 6, (modrm >> 3) & 7, modrm & 7
    if mod not in (1, 2) or rm == 4:
        return None
    size = 1 if mod == 1 else 4
    disp, rest = int.from_bytes(data[2:2 + size], "little", signed=True), data[2 + size:]
    if opcode == 0xd9 and reg in X87_D9 and not rest:
        (kind, width), register = X87_D9[reg], "st0"
    elif opcode == 0xc7 and reg == 0 and len(rest) == 4:
        (kind, width), register = MEMORY_OPCODES[opcode], int.from_bytes(rest, "little")
    elif opcode in MEMORY_OPCODES and opcode != 0xc7 and not rest:
        kind, width = MEMORY_OPCODES[opcode]
        register = (BYTE_REGISTERS if width == "byte" else REGISTERS)[reg]
    else:
        return None
    return {"kind": kind, "width": width, "base": REGISTERS[rm], "disp": disp, "register": register}


def compare_immediate(raw):
    """Return the immediate of `cmp eax, imm32` (3d) or `cmp eax, imm8` (83 f8), sign-extended, else None."""
    data = bytes.fromhex(raw)
    if len(data) == 5 and data[0] == 0x3d:
        return int.from_bytes(data[1:], "little", signed=True)
    if len(data) == 3 and data[:2] == b"\x83\xf8":
        return int.from_bytes(data[2:], "little", signed=True)
    return None


def call_bytes(site, target):
    """Return the hex bytes of `call target` (e8 rel32) placed at site."""
    return "e8" + ((target - (site + 5)) & 0xFFFFFFFF).to_bytes(4, "little").hex()


def byte_ranges(offsets):
    """Format a set of byte offsets as `+0x18..+0x1b, +0x30..+0x33` runs."""
    runs = []
    for offset in sorted(offsets):
        if runs and runs[-1][1] == offset - 1:
            runs[-1][1] = offset
        else:
            runs.append([offset, offset])
    return ", ".join(f"+0x{start:02x}" if start == end else f"+0x{start:02x}..+0x{end:02x}" for start, end in runs)


def engine_stored_bytes(stores):
    """Return {payload byte offset: tag} for every byte a store map (ENGINE_ or GEARBOX_FIELD_STORES) says a tag writes."""
    stored = {}
    for tag, entry in stores.items():
        for offset, store in entry["offsets"].items():
            size = (1 if store["width"] == "byte" else 4) * store.get("slots", 1)
            stored.update({byte: tag for byte in range(int(offset, 16), int(offset, 16) + size)})
    return stored


def engine_copy_bytes(copy):
    """Return the set of payload byte offsets a copy map (ENGINE_COPY, or GEARBOX_COPY with no block) says it writes."""
    copied = {byte for offset, width in copy["offsets"].items()
              for byte in range(int(offset, 16), int(offset, 16) + (1 if width == "byte" else 4))}
    if "block" not in copy:
        return copied
    block = int(copy["block"]["offset"], 16)
    return copied | set(range(block, block + copy["block"]["size"]))


class SiteChecks:
    """The field-evidence.json lookups the engine and gearbox map checks share; each failure appends to problems.

    spans maps a routine's description (`engine loader`) to its [start, end) VAs; a cited site must be
    byte-checked inside the named routine, by default the first one.
    """

    def __init__(self, evidence, tag_ids, problems, spans):
        self.by_va = {site["va"]: site["bytes"] for site in evidence}
        self.claims = {site["va"]: site.get("claim", "") for site in evidence}
        self.tag_ids, self.problems, self.spans = tag_ids, problems, spans
        self.default = next(iter(spans))

    def site(self, label, va, where=None):
        where = where or self.default
        start, end = self.spans[where]
        raw = self.by_va.get(int(va, 16))
        if raw is None or not start <= int(va, 16) < end:
            self.problems.append(f"{label}: no byte-checked {where} site at {va}")
            return None
        return raw

    def exact(self, label, va, expected, where=None):
        raw = self.site(label, va, where)
        if raw is not None and raw != expected:
            self.problems.append(f"{label}: site {va} ({raw}) is not {expected}")

    def operand(self, label, va, expected, where=None):
        raw = self.site(label, va, where)
        decoded = raw and memory_operand(raw)
        if raw is not None and (not decoded or any(decoded[key] != value for key, value in expected.items())):
            shown = ", ".join(f"{key} {value if isinstance(value, str) else hex(value)}" for key, value in expected.items())
            self.problems.append(f"{label}: site {va} ({raw}) is not a {shown} instruction")

    def call(self, label, va, target, where=None):
        self.exact(label, va, call_bytes(int(va, 16), int(target, 16) if isinstance(target, str) else target), where)

    def compare(self, tag, entry):
        if self.tag_ids.get(tag) != entry["id"]:
            registered = "no registry ID" if tag not in self.tag_ids else f"registry ID 0x{self.tag_ids[tag]:x}"
            self.problems.append(f"{tag}: analysis/tags.json gives {registered}, the map says 0x{entry['id']:x}")
        raw = self.site(f"{tag} compare", entry["compare"])
        if raw is not None and compare_immediate(raw) != entry["id"]:
            self.problems.append(f"{tag}: compare site {entry['compare']} ({raw}) is not cmp eax, 0x{entry['id']:x}")

    def about(self, va, tag):
        """Whether the byte-checked site at va has a claim that starts with the tag's name."""
        return self.claims.get(int(va, 16), "").startswith(tag + " ")


def copy_pair_problems(by_va, span, record_base, offsets, name, problems):
    """Check a record copy's load/store pairs against its map's {offset: width}; append each mismatch to problems.

    Every store at [record_base + n] inside span needs a byte-checked load of parent [edx + n] into the same
    register just before it (only a lea of another register may sit between them), and the pairs must be exactly
    the mapped offsets, with their widths.
    """
    inside = sorted((va, raw) for va, raw in by_va.items() if span[0] <= va < span[1])
    pairs = {}
    for index, (va, raw) in enumerate(inside):
        decoded = memory_operand(raw)
        if not decoded or decoded["kind"] != "store" or decoded["base"] != record_base:
            continue
        want = {"kind": "load", "width": decoded["width"], "base": "edx", "disp": decoded["disp"],
                "register": decoded["register"]}
        found, end = False, va
        # Walk back over contiguous byte-checked sites; only a lea of another register may sit between the pair.
        for before, raw_before in reversed(inside[:index]):
            if before + len(raw_before) // 2 != end:
                break
            previous = memory_operand(raw_before)
            if previous == want:
                found = True
                break
            if (not previous or previous["kind"] != "lea"
                    or register_family(previous["register"]) == register_family(decoded["register"])):
                break
            end = before
        if found:
            pairs[f"0x{decoded['disp']:x}"] = decoded["width"]
        else:
            problems.append(f"copy store at 0x{va:08x} has no byte-checked load of parent + 0x{decoded['disp']:02x} "
                            f"into {decoded['register']} before it")
    for offset in sorted(set(pairs) | set(offsets), key=lambda text: int(text, 16)):
        if offset not in pairs:
            problems.append(f"{name} + {offset}: no byte-checked load/store pair in the copy")
        elif offset not in offsets:
            problems.append(f"copy pair at + {offset} is not in {name}")
        elif pairs[offset] != offsets[offset]:
            problems.append(f"{name} + {offset}: the copy moves a {pairs[offset]}, not a {offsets[offset]}")


def engine_evidence_problems(evidence, tag_ids, stores=None, copy=None):
    """List every way ENGINE_FIELD_STORES and ENGINE_COPY lack matching byte-checked sites.

    tag_ids maps tag names to analysis/tags.json registry IDs. Every cited site must be in field-evidence.json
    inside the engine loader (or, for the copy's own instructions, inside the copy). Each tag's compare must be
    `cmp eax, <its registry ID>`; each store a write of its width at [edi + offset] (a TORQUE_ARRAY row at
    [edx + offset - 4], after `mov edx, edi` and `add edx, 4`); the zero-fill, enum tables, the INHERIT_TYPE
    argument setup, call and +0x18 store must have the exact bytes. In the copy every store at [ebx + n] needs a
    byte-checked load of parent [edx + n] into the same register just before it, the pairs must be exactly
    ENGINE_COPY's offsets, and the block must be the documented movsd/movsb sequence. The bytes the copy writes
    must equal the bytes the mapped tags store and exclude the name and +0x18. Each tag needs at least one store
    site per offset, each store site's claim must start with its tag's name, and every byte-checked write to the
    record ([edi + n], or a TORQUE_ARRAY row's [edx + n]) in the loader must be a mapped site.
    """
    stores = ENGINE_FIELD_STORES if stores is None else stores
    copy = ENGINE_COPY if copy is None else copy
    problems = []
    checks = SiteChecks(evidence, tag_ids, problems, {"engine loader": ENGINE_LOADER_SPAN, "engine copy": copy["span"]})
    by_va, claims, site, exact, operand, compare = (checks.by_va, checks.claims, checks.site, checks.exact,
                                                    checks.operand, checks.compare)

    for tag, entry in stores.items():
        compare(tag, entry)
        for offset, store in entry["offsets"].items():
            value = int(offset, 16)
            base, disp = ("edx", value - 4) if "slots" in store else ("edi", value)
            if not store["sites"]:
                problems.append(f"{tag} + {offset}: no store sites")
            for va in store["sites"]:
                operand(f"{tag} + {offset}", va, {"kind": "store", "width": store["width"], "base": base, "disp": disp})
                if int(va, 16) in by_va and not claims[int(va, 16)].startswith(tag + " "):
                    problems.append(f"{tag} + {offset}: the claim at {va} is not about {tag}: {claims[int(va, 16)]!r}")
            for va in store.get("conditional", []):
                raw = site(f"{tag} + {offset} condition", va)
                if raw is not None and not (CONDITIONAL_JUMP.fullmatch(raw) and claims[int(va, 16)].startswith(tag + " ")):
                    problems.append(f"{tag} + {offset}: condition site {va} ({raw}) is not a conditional jump "
                                    f"whose claim is about {tag}")
            if "slots" in store:
                fill, rows = entry["zero_fill"], entry["row_pointer"]
                exact(f"{tag} zero-fill size", fill["size"],
                      "bb" + (store["slots"] * 4).to_bytes(4, "little").hex())
                operand(f"{tag} zero-fill destination", fill["destination"],
                        {"kind": "lea", "register": "eax", "base": "edi", "disp": value})
                exact(f"{tag} zero-fill value", fill["value"], "31d2")
                exact(f"{tag} zero-fill call", fill["call"], call_bytes(int(fill["call"], 16), FILL_MEMORY))
                exact(f"{tag} row pointer start", rows["start"], "89fa")
                exact(f"{tag} row pointer step", rows["step"], "83c204")
        if "row_count" in entry:
            count = entry["row_count"]
            operand(f"{tag} row count", count["site"],
                    {"kind": "load", "width": "dword", "base": "edi", "disp": int(count["offset"], 16)})
            if not any(count["offset"] in other["offsets"] for name, other in stores.items() if name != tag):
                problems.append(f"{tag}: its row count offset {count['offset']} is not a mapped store")
        if "enum_table" in entry:
            table = entry["enum_table"]
            exact(f"{tag} enum table", table["site"], "ba" + int(table["va"], 16).to_bytes(4, "little").hex())

    compare(copy["tag"], copy)
    find = copy["find_parent"]
    exact("INHERIT_TYPE parent lookup", find["call"], call_bytes(int(find["call"], 16), int(find["target"], 16)))
    for key, expected in (("parent_in_ecx", "89c1"), ("parent_in_edx", "89c2"), ("record_in_eax", "89f8")):
        exact(f"INHERIT_TYPE {key.replace('_', ' ')}", copy["arguments"][key], expected)
    exact("INHERIT_TYPE copy call", copy["call"], call_bytes(int(copy["call"], 16), copy["span"][0]))
    parent = copy["parent_store"]
    operand(f"INHERIT_TYPE + {parent['offset']}", parent["site"],
            {"kind": "store", "width": "dword", "base": "edi", "disp": int(parent["offset"], 16), "register": "ecx"})
    mapped = {int(va, 16) for entry in stores.values() for store in entry["offsets"].values() for va in store["sites"]}
    mapped.add(int(parent["site"], 16))
    for va, raw in sorted(by_va.items()):
        decoded = memory_operand(raw)
        if (ENGINE_LOADER_SPAN[0] <= va < ENGINE_LOADER_SPAN[1] and decoded and decoded["kind"] == "store"
                and decoded["base"] in ("edi", "edx") and va not in mapped):
            problems.append(f"byte-checked record store at 0x{va:08x} ({raw}) is in no mapped tag")

    span = "engine copy"
    exact("Engine copy saves ECX", copy["keeps_ecx"]["push"], "51", span)
    exact("Engine copy restores ECX", copy["keeps_ecx"]["pop"], "59", span)
    exact("Engine copy record register", copy["record_in_ebx"], "89c3", span)
    copy_pair_problems(by_va, copy["span"], "ebx", copy["offsets"], "ENGINE_COPY", problems)
    block = copy["block"]
    offset, sites = int(block["offset"], 16), block["sites"]
    exact("Engine copy block size", sites["size"], "b9" + block["size"].to_bytes(4, "little").hex(), span)
    operand("Engine copy block source", sites["source"], {"kind": "lea", "register": "esi", "base": "edx", "disp": offset}, span)
    operand("Engine copy block destination", sites["destination"],
            {"kind": "lea", "register": "edi", "base": "ebx", "disp": offset}, span)
    for key, expected in (("keep_size", "89c8"), ("dword_count", "c1e902"), ("movsd", "f2a5"), ("remainder", "8ac8"),
                          ("remainder_mask", "80e103"), ("movsb", "f2a4")):
        exact(f"Engine copy block {key.replace('_', ' ')}", sites[key], expected, span)

    stored, copied = set(engine_stored_bytes(stores)), engine_copy_bytes(copy)
    if copied - stored:
        problems.append("the copy writes offsets no mapped tag stores: " + byte_ranges(copied - stored))
    if stored - copied:
        problems.append("mapped stores the copy misses: " + byte_ranges(stored - copied))
    parent_bytes = set(range(int(parent["offset"], 16), int(parent["offset"], 16) + 4))
    untouchable = set(range(ENGINE_NAME_BYTES)) | parent_bytes
    if copied & untouchable:
        problems.append("the copy writes the name or the parent address: " + byte_ranges(copied & untouchable))
    return problems


LAYOUT_MEMBER = re.compile(r"\b(char|uint8_t|uint32_t|float) (\w+)(?:\[(\d+)\])?;")
LAYOUT_SIZES = {"char": 1, "uint8_t": 1, "uint32_t": 4, "float": 4}


def struct_layout(header, name):
    """Return ({member: (offset, size)}, total size) for `typedef struct {...} <name>;` in the C header text."""
    end = header.index(f"}} {name};")
    body = header[:end].rsplit("typedef struct {", 1)[1]
    members, offset = {}, 0
    for kind, member, count in LAYOUT_MEMBER.findall(body):
        size = LAYOUT_SIZES[kind]
        offset = (offset + size - 1) // size * size
        members[member] = (offset, size * int(count or 1))
        offset += size * int(count or 1)
    return members, offset


def engine_layout_problems(header, stores=None, copy=None):
    """List every mapped engine offset that disagrees with Fr3EngineRecord in recovered/fr3_database_layouts.h.

    Each mapped field (and the INHERIT_TYPE parent address) must be at its offset with its width (18 floats for
    the torque slots), and the header must `_Static_assert` that offset.
    """
    stores = ENGINE_FIELD_STORES if stores is None else stores
    copy = ENGINE_COPY if copy is None else copy
    expected = [(f"{tag} + {offset}", offset, store["field"],
                 (1 if store["width"] == "byte" else 4) * store.get("slots", 1))
                for tag, entry in stores.items() for offset, store in entry["offsets"].items()]
    parent = copy["parent_store"]
    expected.append((f"{copy['tag']} + {parent['offset']}", parent["offset"], parent["field"], 4))
    return layout_problems(header, "Fr3EngineRecord", ENGINE_RECORD_SIZE, expected)


def unmapped_engine_tags(records, stores=None):
    """Return {tag: (record, line)} for each engine tag in use, beyond TYPE/INHERIT_TYPE/END, with no mapped store."""
    stores = ENGINE_FIELD_STORES if stores is None else stores
    unmapped = {}
    for record in records:
        for tag, field in record["fields"].items():
            if tag not in stores and tag not in ENGINE_UNSTORED_TAGS:
                unmapped.setdefault(tag, (record["type"], field["line"]))
    return dict(sorted(unmapped.items()))


def gearbox_evidence_problems(evidence, tag_ids, stores=None, copy=None):
    """List every way GEARBOX_FIELD_STORES, GEARBOX_RECORD and GEARBOX_COPY lack matching byte-checked sites.

    tag_ids maps tag names to analysis/tags.json registry IDs. Every cited site must be in field-evidence.json inside
    the gearbox loader (or, for the copy's own instructions, inside the copy). Each tag's compare must be
    `cmp eax, <its registry ID>` and any `after_range` site a jg whose claim names the tag. Its reader call must call
    the reader of its kind (an enum's word table passed in EDX, a byte flag's float passed to 0x005352fa, converted
    with fistp to a stack temporary and its low byte loaded into AL from there), and its store must write the read
    register at [edi + offset] with the mapped width. Each store site's claim must start with its tag's name, and
    every byte-checked write to [edi + n] in the loader must be a mapped site. The allocation, name read,
    INHERIT_TYPE path and copy must have the documented bytes. The copy's load/store pairs must be exactly
    GEARBOX_COPY's offsets, the bytes it writes must equal the bytes the mapped tags store, and it must not write
    the name or padding.
    """
    stores = GEARBOX_FIELD_STORES if stores is None else stores
    copy = GEARBOX_COPY if copy is None else copy
    problems = []
    checks = SiteChecks(evidence, tag_ids, problems, {"gearbox loader": GEARBOX_LOADER_SPAN, "gearbox copy": copy["span"]})

    record = GEARBOX_RECORD
    checks.exact("Gearbox allocation size", record["allocation"]["size"],
                 "ba" + GEARBOX_RECORD_SIZE.to_bytes(4, "little").hex())
    checks.call("Gearbox allocation call", record["allocation"]["call"], record["allocation"]["target"])
    checks.exact("Gearbox record node in EDI", record["node_in_edi"], "89c7")
    checks.exact("Gearbox payload in EDI", record["payload_in_edi"], "83c720")
    checks.exact("Gearbox name size", record["name"]["size"], "bb" + GEARBOX_NAME_BYTES.to_bytes(4, "little").hex())
    checks.exact("Gearbox name destination", record["name"]["destination"], "89fa")
    checks.call("Gearbox name read", record["name"]["call"], STRING_READER)

    for tag, entry in stores.items():
        checks.compare(tag, entry)
        if "after_range" in entry:
            raw = checks.site(f"{tag} selecting jg", entry["after_range"])
            if raw is not None and not (re.fullmatch(r"7f[0-9a-f]{2}|0f8f[0-9a-f]{8}", raw)
                                        and checks.about(entry["after_range"], tag)):
                problems.append(f"{tag}: selecting site {entry['after_range']} ({raw}) is not a jg whose claim is "
                                f"about {tag}")
        read = entry["read"]
        if read["kind"] not in GEARBOX_READS:
            problems.append(f"{tag}: unknown read kind {read['kind']!r}")
            continue
        reader, register = GEARBOX_READS[read["kind"]]
        checks.call(f"{tag} reader call", read["call"], reader)
        if read["kind"] == "enum" or "enum_table" in entry:
            table = entry.get("enum_table")
            if not table:
                problems.append(f"{tag}: an enum read with no enum_table")
            else:
                checks.exact(f"{tag} enum table", table["site"], "ba" + int(table["va"], 16).to_bytes(4, "little").hex())
        if read["kind"] == "float_to_byte":
            checks.call(f"{tag} float-to-integer call", read["convert"], GEARBOX_FLOAT_TO_BYTE_CALL)
            fistp = checks.site(f"{tag} fistp", read["fistp"])
            low = checks.site(f"{tag} low byte", read["low_byte"])
            if fistp is not None and low is not None:
                decoded = memory_operand(low)
                if not (len(fistp) == 6 and fistp[:4] == "db5d" and decoded
                        and (decoded["kind"], decoded["width"], decoded["base"], decoded["register"])
                        == ("load", "byte", "ebp", "al")
                        and int.from_bytes(bytes.fromhex(fistp[4:]), "little", signed=True) == decoded["disp"]):
                    problems.append(f"{tag}: {read['fistp']} ({fistp}) and {read['low_byte']} ({low}) are not a "
                                    "fistp to [ebp + n] and a load of its low byte into AL")
        for offset, store in entry["offsets"].items():
            if not store["sites"]:
                problems.append(f"{tag} + {offset}: no store sites")
            for va in store["sites"]:
                checks.operand(f"{tag} + {offset}", va, {"kind": "store", "width": store["width"], "base": "edi",
                                                         "disp": int(offset, 16), "register": register})
                if int(va, 16) in checks.by_va and not checks.about(va, tag):
                    problems.append(f"{tag} + {offset}: the claim at {va} is not about {tag}: "
                                    f"{checks.claims[int(va, 16)]!r}")

    checks.compare(copy["tag"], copy)
    name = copy["read_name"]
    checks.exact("INHERIT_TYPE name size", name["size"], "bb" + GEARBOX_NAME_BYTES.to_bytes(4, "little").hex())
    buffer = checks.site("INHERIT_TYPE name buffer", name["buffer"])
    checks.call("INHERIT_TYPE name read", name["call"], STRING_READER)
    find = copy["find_parent"]
    passed = checks.site("INHERIT_TYPE parent name", find["name"])
    if buffer is not None and passed is not None:
        into, out = memory_operand(buffer), memory_operand(passed)
        if not (into and out and (into["kind"], into["register"], out["kind"], out["register"])
                == ("lea", "edx", "lea", "eax") and (into["base"], into["disp"]) == (out["base"], out["disp"])):
            problems.append(f"INHERIT_TYPE: the parent lookup at {find['call']} is not passed the buffer the name was "
                            f"read into ({name['buffer']} {buffer}, {find['name']} {passed})")
    checks.call("INHERIT_TYPE parent lookup", find["call"], find["target"])
    for key, expected in (("parent_in_edx", "89c2"), ("record_in_eax", "89f8")):
        checks.exact(f"INHERIT_TYPE {key.replace('_', ' ')}", copy["arguments"][key], expected)
    checks.call("INHERIT_TYPE copy call", copy["call"], copy["span"][0])
    raw = checks.site("INHERIT_TYPE next tag", copy["next_tag"])
    if raw is not None and raw[:2] not in ("e9", "eb"):
        problems.append(f"INHERIT_TYPE: site {copy['next_tag']} ({raw}) is not the jump back to the next tag")
    mapped = {int(va, 16) for entry in stores.values() for store in entry["offsets"].values() for va in store["sites"]}
    for va, raw in sorted(checks.by_va.items()):
        decoded = memory_operand(raw)
        if (GEARBOX_LOADER_SPAN[0] <= va < GEARBOX_LOADER_SPAN[1] and decoded and decoded["kind"] == "store"
                and decoded["base"] == "edi" and va not in mapped):
            problems.append(f"byte-checked record store at 0x{va:08x} ({raw}) is in no mapped tag")

    for key, expected in (("push_ebx", "53"), ("push_ecx", "51"), ("pop_ecx", "59"), ("pop_ebx", "5b"), ("ret", "c3")):
        checks.exact(f"Gearbox copy {key.replace('_', ' ')}", copy["saves"][key], expected, "gearbox copy")
    copy_pair_problems(checks.by_va, copy["span"], "eax", copy["offsets"], "GEARBOX_COPY", problems)

    stored, copied = set(engine_stored_bytes(stores)), engine_copy_bytes(copy)
    if copied - stored:
        problems.append("the copy writes offsets no mapped tag stores: " + byte_ranges(copied - stored))
    if stored - copied:
        problems.append("mapped stores the copy misses: " + byte_ranges(stored - copied))
    # The padding is every byte after the last stored one (padding_32 in the header).
    untouchable = set(range(GEARBOX_NAME_BYTES)) | set(range(max(stored, default=-1) + 1, GEARBOX_RECORD_SIZE))
    if copied & untouchable:
        problems.append("the copy writes the name or the padding: " + byte_ranges(copied & untouchable))
    return problems


def layout_problems(header, struct, size, expected):
    """List every (label, offset, field, width) in expected that disagrees with `struct` in the C header text.

    Each field must be at its offset with its width, the header must `_Static_assert` that offset, and the struct
    must be `size` bytes.
    """
    members, total = struct_layout(header, struct)
    problems = [] if total == size else [f"{struct} is 0x{total:x} bytes, not 0x{size:x}"]
    asserted = {field: int(value, 16) for field, value in
                re.findall(rf"_Static_assert\(offsetof\({struct}, (\w+)\) == (0x[0-9a-fA-F]+)", header)}
    for label, offset, field, width in expected:
        if field not in members:
            problems.append(f"{label}: {struct} has no field {field}")
            continue
        at, length = members[field]
        if at != int(offset, 16):
            problems.append(f"{label}: {struct}.{field} is at +0x{at:02x}")
        elif length != width:
            problems.append(f"{label}: {struct}.{field} is {length} bytes, the map stores {width}")
        if asserted.get(field) != int(offset, 16):
            problems.append(f"{label}: the header does not _Static_assert offsetof({struct}, {field}) == {offset}")
    return problems


def gearbox_layout_problems(header, stores=None):
    """List every mapped gearbox offset that disagrees with Fr3GearboxRecord in recovered/fr3_database_layouts.h."""
    stores = GEARBOX_FIELD_STORES if stores is None else stores
    expected = [(f"{tag} + {offset}", offset, store["field"], 1 if store["width"] == "byte" else 4)
                for tag, entry in stores.items() for offset, store in entry["offsets"].items()]
    return layout_problems(header, "Fr3GearboxRecord", GEARBOX_RECORD_SIZE, expected)


def unmapped_gearbox_tags(stores=None):
    """Return the GEARBOX_TAGS with no mapped store and the mapped tags outside GEARBOX_TAGS, as two sorted lists."""
    stores = GEARBOX_FIELD_STORES if stores is None else stores
    return sorted(GEARBOX_TAGS - set(stores)), sorted(set(stores) - GEARBOX_TAGS)


def engine_derived_offsets(tag):
    """Return {offset: conditional} for each derived offset the tag's handler writes."""
    return {offset: bool(store.get("conditional")) for offset, store in ENGINE_FIELD_STORES[tag]["offsets"].items()
            if store.get("derived")}


def own_origin(name, tag, field):
    """The origin of a record's own declaration of one mapped tag, as the replay and the recursion carry it."""
    origin = {"source": name, "source_line": field["line"], "values": field["values"], "path": [name]}
    if field["rows"]:
        origin["rows"] = field["rows"]
    return origin


def zero_origin(name):
    """The origin of a field nobody declares: the record allocator's zero fill, seen from record `name`."""
    return {"status": ZERO_FILLED, "path": [name]}


def via(origin, name):
    """The same origin seen from `name`, which copied it from the record its path starts at."""
    return {**origin, "path": [name, *origin["path"]]}


def described(origin, keys=("source", "source_line")):
    """Return an origin's status (declared, inherited or zero-filled), its path and, unless zero-filled, `keys`."""
    if origin.get("status") == ZERO_FILLED:
        return {"status": ZERO_FILLED, "path": origin["path"]}
    status = "declared" if len(origin["path"]) == 1 else "inherited"
    return {"status": status, **{key: origin[key] for key in keys}, "path": origin["path"]}


def engine_field(tag, origin, derived):
    """Return one effective engine entry from the tag's origin and its derived offsets' possible origins."""
    entry = {**described(origin, ("values", "source", "source_line")), "offsets": list(ENGINE_FIELD_STORES[tag]["offsets"])}
    for key in ("rows", "max_rpm"):
        if key in origin:
            entry[key] = origin[key]
    conditional = engine_derived_offsets(tag)
    if conditional:
        entry["derived"] = {offset: {"label": "derived", "conditional": conditional[offset],
                                     "origins": [described(item) for item in derived[offset]]}
                            for offset in conditional}
    # Entries share origins along a chain; copy so that no entry aliases another's or the records' lists.
    return deepcopy(entry)


def engine_events(record):
    """Return the record's declarations and its INHERIT_TYPE, in line order, as the loader meets them."""
    return sorted(record["fields"].items(), key=lambda item: item[1]["line"])


def effective_engine_fields(records):
    """Return, for each engine with :INHERIT_TYPE, the declaration that ends up in each mapped tag's fields.

    Replays the loader at 0x005227f0 in file order: each record starts zero-filled, each tag in ENGINE_FIELD_STORES
    stores its declaration, and INHERIT_TYPE copies the parent's effective state over every offset ENGINE_COPY
    covers (all of them, the 18 torque slots included), so a declaration made before it is overwritten (listed under
    `overwritten`). TORQUE_ARRAY zero-fills its whole block before storing rows, so a record's own table replaces
    the parent's and never mixes rows with it; each TORQUE_ARRAY origin carries `max_rpm`, the MAX_RPM origin in its
    record when it was parsed, whose path runs from that record. Derived offsets carry their possible origins: the
    producing declaration and, for a conditional store, whatever the offset held before. Tags without a
    byte-checked store are listed under `unmapped`. Values stay the declared text; nothing is computed.
    """
    state = {}
    entries = {}
    for record in records:
        name = record["type"]
        fields = {tag: zero_origin(name) for tag in ENGINE_FIELD_STORES}
        derived = {(tag, offset): [zero_origin(name)] for tag in ENGINE_FIELD_STORES for offset in engine_derived_offsets(tag)}
        own, overwritten, unmapped = [], [], []
        for tag, field in engine_events(record):
            if tag == "INHERIT_TYPE":
                parent = field["values"][0]
                if parent not in state:
                    raise TextDatabaseError(field["line"], f"{name!r} inherits {parent!r}, which is not an earlier record")
                overwritten += own
                own = []
                fields = {key: via(origin, name) for key, origin in state[parent]["fields"].items()}
                derived = {key: [via(origin, name) for origin in origins] for key, origins in state[parent]["derived"].items()}
            elif tag in ENGINE_FIELD_STORES:
                origin = own_origin(name, tag, field)
                if tag == "TORQUE_ARRAY":
                    # The handler reads its row count from +0x30 as it is now (0x0052292b).
                    origin["max_rpm"] = described(fields["MAX_RPM"])
                fields[tag] = origin
                own.append({"tag": tag, "line": field["line"], "values": field["values"]})
                produced = {"source": name, "source_line": field["line"], "path": [name]}
                for offset, conditional in engine_derived_offsets(tag).items():
                    derived[tag, offset] = [produced, *derived[tag, offset]] if conditional else [produced]
            else:
                unmapped.append({"tag": tag, "line": field["line"], "status": UNMAPPED})
        state[name] = {"fields": fields, "derived": derived}
        inherit = record["fields"].get("INHERIT_TYPE")
        if inherit is None:
            continue
        entries[name] = {"inherit_type": {"line": inherit["line"], "parent": inherit["values"][0]},
                         "fields": {tag: engine_field(tag, fields[tag], {offset: derived[tag, offset]
                                                                          for offset in engine_derived_offsets(tag)})
                                    for tag in ENGINE_FIELD_STORES},
                         "overwritten": overwritten, "unmapped": unmapped}
    return entries


def engine_fields_by_recursion(records):
    """Derive each inheriting engine's effective fields a second way, independent of effective_engine_fields().

    Parent first, per record and tag: the record's own declaration counts when it follows its INHERIT_TYPE line (or
    the record has none), otherwise the field is whatever the parent ends up with, and a root that does not declare
    it is zero-filled. The MAX_RPM a TORQUE_ARRAY was parsed with is the record's own when declared before the
    table and in effect, else the parent's final one when INHERIT_TYPE precedes the table, else zero. A derived
    offset holds its tag's own declaration in effect, followed, for a conditional store, by what it held before.
    """
    by_name = {record["type"]: record for record in records}
    order = {record["type"]: i for i, record in enumerate(records)}

    def parent_of(name):
        inherit = by_name[name]["fields"].get("INHERIT_TYPE")
        if inherit is None:
            return None, None
        parent = inherit["values"][0]
        if parent not in by_name or order[parent] >= order[name]:
            raise TextDatabaseError(inherit["line"], f"{name!r} inherits {parent!r}, which is not an earlier record")
        return parent, inherit["line"]

    def in_effect(name, tag):
        own = by_name[name]["fields"].get(tag)
        _, line = parent_of(name)
        return own if own is not None and (line is None or own["line"] > line) else None

    def max_rpm_at(name, line):
        own = in_effect(name, "MAX_RPM")
        parent, inherit_line = parent_of(name)
        if own is not None and own["line"] < line:
            return own_origin(name, "MAX_RPM", own)
        if parent is not None and inherit_line < line:
            return via(origin(parent, "MAX_RPM"), name)
        return zero_origin(name)

    def origin(name, tag):
        own = in_effect(name, tag)
        if own is not None:
            found = own_origin(name, tag, own)
            if tag == "TORQUE_ARRAY":
                found["max_rpm"] = described(max_rpm_at(name, own["line"]))
            return found
        parent, _ = parent_of(name)
        return via(origin(parent, tag), name) if parent is not None else zero_origin(name)

    def derived(name, tag, conditional):
        own = in_effect(name, tag)
        parent, _ = parent_of(name)
        before = ([via(item, name) for item in derived(parent, tag, conditional)] if parent is not None
                  else [zero_origin(name)])
        if own is None:
            return before
        produced = {"source": name, "source_line": own["line"], "path": [name]}
        return [produced, *before] if conditional else [produced]

    return {record["type"]: {tag: engine_field(tag, origin(record["type"], tag),
                                               {offset: derived(record["type"], tag, conditional)
                                                for offset, conditional in engine_derived_offsets(tag).items()})
                             for tag in ENGINE_FIELD_STORES}
            for record in records if "INHERIT_TYPE" in record["fields"]}


def check_effective_engine_fields(records, effective):
    """Compare effective_engine_fields() output with engine_fields_by_recursion(); refuse any difference."""
    expected = engine_fields_by_recursion(records)
    require(set(effective) == set(expected), "Engine effective field record set mismatch")
    for name, fields in expected.items():
        for tag, entry in fields.items():
            require(effective[name]["fields"].get(tag) == entry,
                    f"Engine effective field disagrees with the parent-first derivation: {name} {tag}")
        require(set(effective[name]["fields"]) == set(fields), "Engine effective field tag set mismatch: " + name)


def engine_field_counts(effective):
    """Count, for each mapped engine tag, how many inheriting records end up with each status."""
    counts = {tag: {} for tag in ENGINE_FIELD_STORES}
    for entry in effective.values():
        for tag, field in entry["fields"].items():
            counts[tag][field["status"]] = counts[tag].get(field["status"], 0) + 1
    return counts


def torque_without_own_max_rpm(effective):
    """Return (record, TORQUE_ARRAY source) for each torque table not parsed with its own record's MAX_RPM."""
    return [(name, field["source"]) for name, entry in effective.items()
            for field in [entry["fields"]["TORQUE_ARRAY"]] if "max_rpm" in field and field["max_rpm"]["status"] != "declared"]


def untagged_inherit_consequences(records):
    """Return, per root record with one untagged `INHERIT_TYPE <earlier record>` line, what depends on that line.

    Nothing here decides whether the game honours the line. For each mapped tag the record does not declare, `fields`
    gives both readings: `if_ignored`, the zero fill the record keeps as parsed, and `if_applied`, the effective
    entry effective_engine_fields() gives when the line is read as :INHERIT_TYPE. `overwritten_if_applied` lists the
    record's own declarations that reading would overwrite.
    """
    consequences = {}
    for index, record in enumerate(records):
        names = {earlier["type"] for earlier in records[:index]}
        lines = [item for item in record["untagged"] if len(item["tokens"]) == 2 and item["tokens"][0] == "INHERIT_TYPE"
                 and item["tokens"][1] in names]
        if len(lines) != 1 or "INHERIT_TYPE" in record["fields"]:
            continue
        line, parent, name = lines[0]["line"], lines[0]["tokens"][1], record["type"]
        applied = {**record, "fields": {**record["fields"],
                                        "INHERIT_TYPE": {"line": line, "values": [parent], "rows": []}}}
        entry = effective_engine_fields(records[:index] + [applied])[name]
        consequences[name] = {"line": line, "tokens": lines[0]["tokens"], "parent": parent, "status": "unresolved",
                              "fields": {tag: {"if_ignored": described(zero_origin(name)),
                                               "if_applied": entry["fields"][tag]}
                                         for tag in ENGINE_FIELD_STORES if tag not in record["fields"]},
                              "overwritten_if_applied": entry["overwritten"]}
    return consequences


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


def load_tag_ids(path=REPO_ROOT / "analysis/tags.json"):
    return {tag["name"]: tag["id"] for tag in json.loads(Path(path).read_text())}


def load_layout_header(path=REPO_ROOT / "recovered/fr3_database_layouts.h"):
    return Path(path).read_text()


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


def verify_text_databases(game_dir, known_tags, evidence=None, tag_ids=None, header=None):
    """Check the parsed demo databases against the counts observed in the data.

    evidence is the field-evidence.json site list, tag_ids the analysis/tags.json name-to-ID map and header the
    text of recovered/fr3_database_layouts.h; by default the committed ones are read.
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
    evidence = load_field_evidence() if evidence is None else evidence
    problems = engine_evidence_problems(evidence, load_tag_ids() if tag_ids is None else tag_ids)
    require(not problems, "Engine stores lack byte-checked evidence: " + "; ".join(problems))
    problems = engine_layout_problems(load_layout_header() if header is None else header)
    require(not problems, "Engine stores disagree with recovered/fr3_database_layouts.h: " + "; ".join(problems))
    unmapped = unmapped_engine_tags(engines)
    require(not unmapped, "Engine tags without a byte-checked store: "
            + ", ".join(f"{tag} (first in {name}, line {line})" for tag, (name, line) in unmapped.items()))
    fields = effective_engine_fields(engines)
    require(set(fields) == {record["type"] for record in inherits}, "Engine effective field record set mismatch")
    check_effective_engine_fields(engines, fields)
    early = sorted(name for name, entry in fields.items() if entry["overwritten"])
    require(not early, "Engine fields declared before INHERIT_TYPE: " + ", ".join(early))
    unmapped = sorted(name for name, entry in fields.items() if entry["unmapped"])
    require(not unmapped, "Engine effective fields with an unmapped tag: " + ", ".join(unmapped))
    stray = torque_without_own_max_rpm(fields)
    require(not stray, "TORQUE_ARRAY parsed without its record's own MAX_RPM: "
            + ", ".join(f"{name} (from {source})" for name, source in stray))
    engine_counts = engine_field_counts(fields)
    require(engine_counts == ENGINE_FIELD_COUNTS, f"Engine effective field counts mismatch: {engine_counts}")
    consequences = untagged_inherit_consequences(engines)
    require(set(consequences) == {"INDIGO"}, "Engines with a colon-less INHERIT_TYPE line to an earlier record: "
            + (", ".join(consequences) or "none") + "; expected INDIGO only")
    for record in gearboxes:
        require(set(record["fields"]) == GEARBOX_TAGS, "Gearbox tag set mismatch: " + record["type"])
    missing, extra = unmapped_gearbox_tags()
    require(not missing and not extra, "GEARBOX_FIELD_STORES does not cover exactly GEARBOX_TAGS: "
            + "; ".join(part for part in (missing and "unmapped " + ", ".join(missing),
                                          extra and "not a gearbox tag " + ", ".join(extra)) if part))
    problems = gearbox_evidence_problems(evidence, load_tag_ids() if tag_ids is None else tag_ids)
    require(not problems, "Gearbox stores lack byte-checked evidence: " + "; ".join(problems))
    problems = gearbox_layout_problems(load_layout_header() if header is None else header)
    require(not problems, "Gearbox stores disagree with recovered/fr3_database_layouts.h: " + "; ".join(problems))
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
    problems = scalar_evidence_problems(evidence)
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
            "engine_mapped_tags": len(ENGINE_FIELD_STORES), "gearbox_mapped_tags": len(GEARBOX_FIELD_STORES),
            "torque_rows": [min(len(f["rows"]) for f in torque), max(len(f["rows"]) for f in torque)],
            "engine_inheritances": len(inherits), "engine_effective_field_records": len(fields),
            "engine_effective_field_counts": engine_counts,
            "indigo_dependent_tags": sorted(consequences["INDIGO"]["fields"]), "gearbox_tags": sorted(GEARBOX_TAGS), "untagged_lines": untagged,
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
        if stem == "engines":
            database["effective_fields"] = effective_engine_fields(database["records"])
            database["untagged_inherit_consequences"] = untagged_inherit_consequences(database["records"])
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
