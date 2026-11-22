"""Generate the offline "Compare records" research page, compare.html.

It compares the demo's gearboxes, then its engines, then its tyres, field by field. Inputs, all produced elsewhere and
only read here:
  * gearboxes.json, engines.json and tyres.json from scripts/text_database.py: `records`, plus the GEARDATA.DAT,
    ENGDATA.DAT or TYREDATA.DAT path and SHA-256; for engines, `effective_fields` and `untagged_inherit_consequences`;
    for tyres, `resolved_tables`, `table_provenance` and `effective_scalars`.
  * GEARDATA.DAT, ENGDATA.DAT and TYREDATA.DAT themselves, under the extracted game directory, whose SHA-256s must
    match the JSON.
    The page shows each value exactly as written there (0.2 and 0.20 stay distinct), which the parsed numbers in the
    JSON no longer record; each written token must parse to the value the JSON holds.
  * analysis/pe-metadata.json: the executable's identity.
  * analysis/game-file-manifest.json, whose ENGDATA.DAT and TYREDATA.DAT SHA-256s say whether those are the demo's.
  * analysis/annotated/status.json: the labels of the tyre table accessors, which the tyre columns link on
    routines.html.

The gearbox section has two tables:
  * The matrix: one row per gearbox in GEARDATA.DAT order, one column per tag in GEARBOX_FIELD_STORES in payload
    offset order (+0x14 to +0x31). Each cell shows the declared value as written and links to that declaration's
    row on gearboxes.html (gearbox-<name>-line-<n>); each column header shows the tag's offset, width and how it is
    read, and links to its row in that page's "Where each field is stored" table (gearbox-store-<TAG>), which links
    the byte-checked compare and store sites on routines.html.
  * What differs: per tag, how many distinct values the gearboxes declare and which gearboxes declare each. Float
    tags (read as a float, including the two stored as an integer's low byte) are grouped by the parsed number, so
    1 and 1.0 are one value, with each written form shown; enum tags are grouped by the exact word. A tag with one
    value is labelled "same in all <n>".

Gearbox values are not interpreted: no units, enum meanings or physics, and the integer the loader stores the low
byte of for ANTI_WHEELSPIN and ANTI_WHEELSKID is not computed. Declared values are the stored values only because no
gearbox inherits, so the script refuses to write the page, and exits non-zero, when a gearbox
  * lacks one of the mapped tags or declares a tag that is not mapped,
  * declares :INHERIT_TYPE (gearbox inheritance is not resolved, and would make declared differ from stored),
  * has an untagged line (whether the game honours it is not established),
  * declares a mapped tag with rows or more than one value, or
  * declares a float tag with a value that is not a number.

The engine section shows each engine's effective values, the declarations the loader ends up storing once
:INHERIT_TYPE has copied the parent's fields, as engines.json's `effective_fields` resolve them (a root's are its own
declarations). It has two tables:
  * The matrix: one row per engine in ENGDATA.DAT order, one column per tag in ENGINE_FIELD_STORES in payload offset
    order. Each column header links to its row in the engine page's "Where each field is stored" table
    (engine-store-<TAG>). Each cell shows the effective value as written on its source line, linked to that
    declaration's row (engine-<source>-line-<n>), marked declared or inherited from <source>, with the INHERIT_TYPE
    path when it is longer than one step. A TORQUE_ARRAY cell shows no values: it gives the source record and line,
    the row count and the MAX_RPM declaration the table was parsed with, and links the engine's effective
    TORQUE_ARRAY row (engine-<name>-torque-array; a root, which has none, links only the declaration).
  * What differs: per tag, the distinct effective values and the engines that hold each. Numbers are grouped by the
    parsed number, enum words by the exact word and torque tables by source record and line; zero-filled cells are
    listed apart. It counts how the inheriting engines get each field (declared, inherited or zero-filled, as
    engines.json resolves it); when ENGDATA.DAT is the demo's by the game-file manifest, those counts must equal
    ENGINE_FIELD_COUNTS.
INDIGO's colon-less `INHERIT_TYPE DEFAULT_TRACK` line is applied, as engines.json applies it, on static instruction
evidence: INDIGO's row is marked as inheriting through that line, and every cell whose INHERIT_TYPE path crosses it
says so, with the basis label linked to questions.html#indigo. Any other root's colon-less `INHERIT_TYPE <record>`
line, which engines.json lists as `unresolved`, is not applied. Every cell whose value depends on it, because the
root does not declare the tag or declares it before the line, and every engine whose effective origin for a tag runs
through such a cell, is labelled unresolved with no value, never zero. Such cells are counted apart in What differs. Engine values are not interpreted either:
no units, enum meanings or physics, no value for the derived +0x2c and +0xa4, and TORQUE_MODIFIER is not applied to
the table. The script refuses to write the page when ENGDATA.DAT does not match engines.json, when an engine
  * declares a tag with no byte-checked store,
  * declares :INHERIT_TYPE but has no effective_fields, or a declaration before it that the copy overwrites,
  * has an untagged line other than a root's colon-less INHERIT_TYPE line,
  * declares a mapped tag that is not one inline value (TORQUE_ARRAY: not a block of rows), or a number tag with a
    value that is not a number, or whose written token does not parse to the value engines.json holds,
when effective_fields or untagged_inherit_consequences differ from what text_database.py derives, and when the
inheriting engines' counts differ from ENGINE_FIELD_COUNTS as above.

The tyre section shows each tyre's effective scalar values, the declarations the loader ends up storing once
:INHERIT_TYPE has copied the parent's scalar fields (+0x18 to +0x40), as tyres.json's `effective_scalars` resolve them
(the root's are its own declarations), and the record each of its five resolved tables is read from, as
`table_provenance` gives it. It has two tables:
  * The matrix: one row per tyre in TYREDATA.DAT order; one column per tag in TYRE_SCALAR_STORES in payload offset
    order, then one per table in RESOLVED_TYRE_TABLES. A scalar cell shows the effective value as written on its source
    line, linked to that declaration's row on tyres.html (tyre-<source>-line-<n>), marked declared or inherited from
    <source>, with the INHERIT_TYPE path when it is longer than one step; a zero-filled cell has no value. A table cell
    names the source record and links the tyre's row for that table on tyres.html (tyre-<name>-<table>), which holds
    its Why? trail; no table values are shown. Each scalar header shows the tag's offsets and links its row in the
    tyre page's "Where each field is stored" table (tyre-store-<TAG>); each table header shows the record offset its
    accessor tests and links the accessor's section on routines.html. Unmapped declarations, and any the scalar copy
    overwrites, get no column and are listed under the matrix.
  * What differs: per scalar tag, the distinct effective values grouped by the parsed number, each written form shown,
    and the tyres that hold each, with zero-filled cells apart; per table, the source records and the tyres that read
    each. It counts how the inheriting tyres get each scalar (declared, inherited or zero-filled) and how many tyres
    read each table from each source; when TYREDATA.DAT is the demo's by the game-file manifest, those counts must
    equal TYRE_SCALAR_COUNTS and TYRE_TABLE_SOURCES.
Tyre values are declarations as written, not physical quantities: no units, compound meanings or physics, and the
grip scale the loader applies to the two grip numbers is not applied. The script refuses to write the page when
TYREDATA.DAT does not match tyres.json, when an inheriting tyre declares a scalar tag with no byte-checked store that
its effective_scalars entry does not list as unmapped (tyres.json lists none for a root, whose unmapped declarations
are listed under the matrix all the same), when resolved_tables, table_provenance or effective_scalars differ from what
text_database.py derives, when a mapped declaration is not one inline number or its written token does not parse to
the value tyres.json holds, and when the demo counts differ as above.

It also refuses when an input is missing or malformed as record_dossier.py checks it. The page has inline CSS, no
JavaScript and no external resources other than the rights-holder notice's two links. It links gearboxes.html,
engines.html, tyres.html, routines.html and questions.html, so it belongs beside them.
"""
import argparse
import hashlib
from pathlib import Path

from dossier_common import (INDIGO_ANCHOR, QUESTIONS_PAGE, ROUTINE_STATUS, STYLE, anchor, basis_html, check_fields,
                            check_pe, e, is_indigo_line, line_anchor, load_json, page_start, producer_revision,
                            routine_label, routine_labels, routine_link)
from record_dossier import (DATABASES, TORQUE, check_engine_fields, check_records, engine_store_anchor, engine_tags,
                            gearbox_tags, store_anchor)
from text_database import (ENGINE_FIELD_COUNTS, ENGINE_FIELD_STORES, GEARBOX_FIELD_STORES, REPO_ROOT,
                           RESOLVED_TYRE_TABLES, TYRE_SCALAR_COUNTS, TYRE_SCALAR_STORES, TYRE_TABLE_ACCESSORS,
                           TYRE_TABLE_SOURCES, ZERO_FILLED, check_effective_scalars, described, effective_scalars,
                           engine_field_counts, lines_of, own_origin, require, resolve_tyre_tables, scalar_counts,
                           scalar_tags, table_sources, tyre_table_provenance, value, zero_origin)
import tyre_dossier

PAGE = "compare.html"
GEARBOX_PAGE = DATABASES["gearboxes"]["page"]
ENGINE_PAGE = DATABASES["engines"]["page"]
TYRE_PAGE = tyre_dossier.PAGE
# The demo's counts the tyre section checks: the inheriting tyres' scalar statuses and every tyre's table sources.
TYRE_COUNTS = {"scalars": TYRE_SCALAR_COUNTS, "tables": TYRE_TABLE_SOURCES}
# The committed list of the demo's game files and their SHA-256s; it identifies the demo's ENGDATA.DAT, whose
# effective field counts ENGINE_FIELD_COUNTS records.
GAME_MANIFEST = REPO_ROOT / "analysis/game-file-manifest.json"
UNRESOLVED = "unresolved"
DEFAULT_GAME = REPO_ROOT / "inputs/extracted/Program_Executable_Files"
FLOAT_KINDS = frozenset({"float", "float_to_byte"})
READ_TEXT = {"float": "float", "enum": "enum word", "float_to_byte": "float stored as an integer's low byte"}
# Only the matrices scroll sideways, inside .wide: elsewhere long words (the SHA-256s, record names in lists) may break,
# and narrow screens get tighter padding, so that the page fits a phone's width. The engine matrix's cells wrap their
# provenance notes, and so do the tyre matrix's.
EXTRA_STYLE = (".wide { overflow-x: auto; }\ntable.matrix td { white-space: nowrap; }\n"
               "table.matrix th small { font-weight: normal; }\n"
               "dd code, table:not(.matrix) li { overflow-wrap: anywhere; }\n"
               "table.matrix.engines td { white-space: normal; min-width: 9em; }\n"
               "table.matrix.tyres td { white-space: normal; min-width: 9em; }\n"
               "table.tyre-differences td { overflow-wrap: anywhere; }\n"
               "@media (max-width: 40em) { body { padding: 0 0.5em; } th, td { padding: 0.2em 0.3em; } "
               "td ul { padding-left: 1.2em; } }\n")
SCOPE = ('Scope: values are shown exactly as declared in <code>GEARDATA.DAT</code>, and linked to their declaration '
         "rows on the gearbox page. This page claims no units, no meaning for the enum words and no physics. For "
         "<code>ANTI_WHEELSPIN</code> and <code>ANTI_WHEELSKID</code> the loader converts the float to an integer "
         "and stores that integer's low byte; this page does not compute it. No demo gearbox declares "
         "<code>:INHERIT_TYPE</code>, so the declared values are the values the loader stores from the file, and "
         "nothing is inherited.")
ENGINE_SCOPE = ("Scope: each engine's values are its effective ones, the declarations the loader ends up storing once "
                "each <code>:INHERIT_TYPE</code> has copied the parent's fields over the record, as "
                "<code>scripts/text_database.py</code> resolves them. Each is shown exactly as written in "
                "<code>ENGDATA.DAT</code> on the line that declares it, and linked to that line's row on the engine "
                "page. This page claims no units, no meaning for the enum words and no physics. It computes no value "
                "for the derived <code>+ 0x2c</code> and <code>+ 0xa4</code>, and does not apply "
                "<code>TORQUE_MODIFIER</code> to the torque table. <code>INDIGO</code>'s colon-less "
                "<code>INHERIT_TYPE DEFAULT_TRACK</code> line is applied as inheritance on static instruction evidence "
                f'(<a href="{QUESTIONS_PAGE}#{INDIGO_ANCHOR}">open question</a>): the tag reader gives it the same tag '
                "as <code>:INHERIT_TYPE</code>. Nothing has been run to confirm it, so every value that comes through "
                "that line is marked with its basis. Any other root's colon-less <code>INHERIT_TYPE</code> line is "
                "not applied: every field that depends on whether the game honours it is labelled unresolved and "
                "given no value, never zero.")
TYRE_SCOPE = ("Scope: each tyre's scalar values are its effective ones, the declarations the loader ends up storing "
              "once each <code>:INHERIT_TYPE</code> has copied the parent's scalar fields over the record, as "
              "<code>scripts/text_database.py</code> resolves them. Each is shown exactly as written in "
              "<code>TYREDATA.DAT</code> on the line that declares it, and linked to that line's row on the tyre page. "
              "Values are declarations as written, not physical quantities: this page claims no units, no meaning for "
              "the compounds and no physics. The loader multiplies the two grip numbers "
              "(<code>ROAD_MAGIC_GRIP_NUMBER</code> and <code>OFFROAD_MAGIC_GRIP_NUMBER</code>) by the global float at "
              "<code>0x00597484</code> when it stores them; that scale is not applied here. Each table cell names only "
              "the record whose table the game reads; the table's contents are on the tyre page.")


def is_float(tag):
    return GEARBOX_FIELD_STORES[tag]["read"]["kind"] in FLOAT_KINDS


def check_gearboxes(database, data):
    """Check gearboxes.json against GEARDATA.DAT's bytes; return its gearboxes for the page.

    Each is {"name", "line", "cells": {tag: {"line", "written", "value"}}}, with a cell for every mapped tag.
    """
    check_records(database, "gearboxes.json")
    require(hashlib.sha256(data).hexdigest() == database["sha256"],
            f"{database['source']} does not match gearboxes.json's SHA-256 (rerun scripts/text_database.py)")
    lines = dict(lines_of(data))
    tags = gearbox_tags()
    gearboxes = []
    for record in database["records"]:
        name, fields = record["type"], record["fields"]
        where = f"gearbox {name!r} (line {record['line']})"
        if "INHERIT_TYPE" in fields:
            raise ValueError(f"{where} declares :INHERIT_TYPE on line {fields['INHERIT_TYPE']['line']}; gearbox "
                             "inheritance is not resolved, so its declared values need not be the ones stored")
        require(not record.get("untagged"), f"{where} has untagged lines ("
                + ", ".join(str(item["line"]) for item in record.get("untagged", []))
                + "); whether the game honours them is not established")
        unmapped = sorted(set(fields) - set(tags))
        require(not unmapped, f"{where} declares tags with no byte-checked store: " + ", ".join(unmapped))
        missing = [tag for tag in tags if tag not in fields]
        require(not missing, f"{where} does not declare " + ", ".join(missing))
        cells = {}
        for tag in tags:
            field = fields[tag]
            line = field["line"]
            require(not field["rows"] and len(field["values"]) == 1,
                    f"{where}: :{tag} on line {line} is not a single inline value")
            declared = field["values"][0]
            require(not is_float(tag) or isinstance(declared, (int, float)),
                    f"{where}: :{tag} on line {line} is read as a float, but {declared!r} is not a number")
            tokens = lines.get(line, [])
            require(len(tokens) == 2 and tokens[0] == f":{tag}",
                    f"{where}: line {line} of {database['source']} is not ':{tag} <value>' (rerun "
                    "scripts/text_database.py)")
            parsed = value(tokens[1], line)
            require(type(parsed) is type(declared) and parsed == declared,
                    f"{where}: line {line} of {database['source']} declares {tokens[1]!r}, but gearboxes.json holds "
                    f"{declared!r} (rerun scripts/text_database.py)")
            cells[tag] = {"line": line, "written": tokens[1], "value": declared}
        gearboxes.append({"name": name, "line": record["line"], "cells": cells})
    return gearboxes


def differences(gearboxes):
    """Per mapped tag, in offset order: its distinct values, each {"forms", "gearboxes"}, in value order.

    Float tags are grouped by the parsed number, and their groups ordered by it; enum tags by the exact word.
    `forms` lists each written form once, in file order; `gearboxes` lists the gearboxes in file order.
    """
    result = {}
    for tag in gearbox_tags():
        groups = {}
        for gearbox in gearboxes:
            cell = gearbox["cells"][tag]
            group = groups.setdefault(float(cell["value"]) if is_float(tag) else cell["written"],
                                      {"forms": [], "gearboxes": []})
            if cell["written"] not in group["forms"]:
                group["forms"].append(cell["written"])
            group["gearboxes"].append(gearbox["name"])
        result[tag] = [groups[key] for key in sorted(groups)]
    return result


def row_anchor(name):
    return anchor("compare-gearbox", name)


def column_header(tag):
    entry = GEARBOX_FIELD_STORES[tag]
    (offset, store), = entry["offsets"].items()
    return (f'<th><a href="{e(GEARBOX_PAGE)}#{e(store_anchor(tag))}"><code>{e(tag)}</code></a><br>'
            f'<small><code>+ {e(offset)}</code>, {e(store["width"])}<br>{e(READ_TEXT[entry["read"]["kind"]])}'
            "</small></th>")


def matrix(gearboxes):
    header = "<tr><th>Gearbox</th>" + "".join(column_header(tag) for tag in gearbox_tags()) + "</tr>"
    rows = []
    for gearbox in gearboxes:
        name = gearbox["name"]
        cells = "".join(
            f'<td class="num"><a href="{e(GEARBOX_PAGE)}#{e(line_anchor("gearbox", name, cell["line"]))}" '
            f'title="{e(name)} line {e(cell["line"])}">{e(cell["written"])}</a></td>'
            for cell in (gearbox["cells"][tag] for tag in gearbox_tags()))
        rows.append(f'<tr id="{e(row_anchor(name))}"><td><a href="{e(GEARBOX_PAGE)}#{e(anchor("gearbox", name))}">'
                    f"{e(name)}</a></td>{cells}</tr>")
    return f'<div class="wide"><table class="matrix">{header}{"".join(rows)}</table></div>'


def differences_table(gearboxes):
    total = len(gearboxes)
    rows = []
    for tag, groups in differences(gearboxes).items():
        kind = "number" if is_float(tag) else "word"
        if len(groups) == 1:
            values = (f'<span class="label">same in all {total}</span>: '
                      + ", ".join(f"<code>{e(form)}</code>" for form in groups[0]["forms"]))
        else:
            values = "<ul>" + "".join(
                "<li>" + ", ".join(f"<code>{e(form)}</code>" for form in group["forms"])
                + f' ({len(group["gearboxes"])}): '
                + ", ".join(f'<a href="#{e(row_anchor(name))}">{e(name)}</a>' for name in group["gearboxes"])
                + "</li>" for group in groups) + "</ul>"
        rows.append(f'<tr id="{e(anchor("differs", tag))}"><td><code>{e(tag)}</code></td><td>{len(groups)}</td>'
                    f"<td>by {kind}</td><td>{values}</td></tr>")
    return ("<table><tr><th>Tag</th><th>Distinct values</th><th>Grouped</th><th>Values as written (gearbox count): "
            f'gearboxes</th></tr>{"".join(rows)}</table>')


def is_enum(tag):
    """True for an engine tag read as an enum word (LOCATION_TYPE, ASPIRATION_TYPE); the others hold numbers."""
    return "enum_table" in ENGINE_FIELD_STORES[tag]


def demo_engine_counts(database, manifest_path=GAME_MANIFEST):
    """ENGINE_FIELD_COUNTS when engines.json was parsed from the demo's ENGDATA.DAT, by the SHA-256 the committed
    game-file manifest records for its path; None for any other file, whose counts nothing records."""
    return ENGINE_FIELD_COUNTS if is_demo(database, manifest_path) else None


def written_value(database, where, tag, field, lines):
    """Check one mapped declaration against its line in ENGDATA.DAT; return the value token as written.

    TORQUE_ARRAY must be a block of rows under a bare `:TORQUE_ARRAY` line, and returns None: its rows are not
    shown on this page. Every other mapped tag must be one inline value, a number unless the tag reads an enum word,
    and its written token must parse to the value engines.json holds.
    """
    line = field["line"]
    tokens = lines.get(line, [])
    if tag == TORQUE:
        require(field["rows"] and not field["values"], f"{where}: :{tag} on line {line} is not a block of rows")
        require(tokens == [f":{tag}"], f"{where}: line {line} of {database['source']} is not ':{tag}' (rerun "
                "scripts/text_database.py)")
        return None
    require(not field["rows"] and len(field["values"]) == 1, f"{where}: :{tag} on line {line} is not a single inline value")
    declared = field["values"][0]
    require(is_enum(tag) or isinstance(declared, (int, float)),
            f"{where}: :{tag} on line {line} reads no enum word, but {declared!r} is not a number")
    require(len(tokens) == 2 and tokens[0] == f":{tag}",
            f"{where}: line {line} of {database['source']} is not ':{tag} <value>' (rerun scripts/text_database.py)")
    parsed = value(tokens[1], line)
    require(type(parsed) is type(declared) and parsed == declared,
            f"{where}: line {line} of {database['source']} declares {tokens[1]!r}, but engines.json holds "
            f"{declared!r} (rerun scripts/text_database.py)")
    return tokens[1]


def root_fields(record):
    """A root engine's mapped fields, shaped like engines.json's effective entries: its own declaration, or the
    zero fill. Its TORQUE_ARRAY's `max_rpm` is its own MAX_RPM when declared before the table, else the zero fill."""
    name, fields = record["type"], record["fields"]
    result = {}
    for tag in ENGINE_FIELD_STORES:
        field = fields.get(tag)
        if field is None:
            result[tag] = described(zero_origin(name))
            continue
        result[tag] = described(own_origin(name, tag, field), ("values", "source", "source_line"))
        if tag == TORQUE:
            result[tag]["rows"] = field["rows"]
            rpm = fields.get("MAX_RPM")
            result[tag]["max_rpm"] = described(own_origin(name, "MAX_RPM", rpm) if rpm and rpm["line"] < field["line"]
                                               else zero_origin(name))
    return result


def unresolved_root(origin, tag, consequences):
    """The root whose colon-less INHERIT_TYPE line `origin` depends on, or None.

    An origin ends its path at the record its value comes from. When that is a root with such a line, the value
    depends on the line if the root does not declare the tag (zero-filled as parsed, the parent's if applied) or
    declares it before the line (overwritten if applied).
    """
    root = origin["path"][-1]
    consequence = consequences.get(root)
    if consequence is None or consequence["status"] == "applied":
        return None
    overwritten = {item["tag"] for item in consequence["overwritten_if_applied"]}
    return root if origin["status"] == ZERO_FILLED or tag in overwritten else None


def unresolved_cell(root, consequences):
    consequence = consequences[root]
    return {"status": UNRESOLVED, "root": root, "root_line": consequence["line"],
            "question": is_indigo_line({"type": root}, consequence)}


def applied_hops(path, applied):
    """The applied colon-less INHERIT_TYPE lines an origin's path crosses, as their records' `inherit_type` entries.

    Every record in the path but the last copied the value from the next one through its INHERIT_TYPE.
    """
    return [{"record": hop, **applied[hop]} for hop in path[:-1] if hop in applied]


def engine_cell(tag, field, written, consequences, applied=None):
    """One matrix cell from an effective (or root) field: its status, provenance and value as written.

    `applied` maps each record whose INHERIT_TYPE is an applied colon-less line to its `inherit_type` entry; a cell
    whose path crosses one lists it under `applied`.
    """
    root = unresolved_root(field, tag, consequences)
    if root is not None:
        return {**unresolved_cell(root, consequences), "effective_status": field["status"]}
    cell = {"status": field["status"], "effective_status": field["status"], "path": field["path"],
            "applied": applied_hops(field["path"], applied or {})}
    if field["status"] == ZERO_FILLED:
        return cell
    cell.update(source=field["source"], source_line=field["source_line"])
    if tag == TORQUE:
        rpm = field["max_rpm"]
        rpm_root = unresolved_root(rpm, "MAX_RPM", consequences)
        cell.update(rows=len(field["rows"]), max_rpm=unresolved_cell(rpm_root, consequences) if rpm_root else rpm)
    else:
        cell.update(written=written[field["source"], tag], value=field["values"][0])
    return cell


def check_engines(database, data, expected_counts=None):
    """Check engines.json against ENGDATA.DAT's bytes; return its engines for the page, in file order.

    Each is {"name", "line", "root", "cells": {tag: cell}}, with a cell for every mapped tag. expected_counts, when
    given, must equal the per-tag status counts of the inheriting engines' effective fields.
    """
    check_records(database, "engines.json")
    require(hashlib.sha256(data).hexdigest() == database["sha256"],
            f"{database['source']} does not match engines.json's SHA-256 (rerun scripts/text_database.py)")
    check_fields(database, {"effective_fields": dict, "untagged_inherit_consequences": dict}, "engines.json")
    records, effective = database["records"], database["effective_fields"]
    consequences = database["untagged_inherit_consequences"]
    for record in records:
        name, fields = record["type"], record["fields"]
        where = f"engine {name!r} (line {record['line']})"
        unmapped = sorted(set(fields) - set(ENGINE_FIELD_STORES) - {"INHERIT_TYPE"})
        require(not unmapped, f"{where} declares tags with no byte-checked store: " + ", ".join(unmapped))
        require("INHERIT_TYPE" not in fields or name in effective,
                f"{where} declares :INHERIT_TYPE, but engines.json gives it no effective_fields (rerun "
                "scripts/text_database.py)")
    check_engine_fields(database)
    lines = dict(lines_of(data))
    written = {}
    for record in records:
        name = record["type"]
        where = f"engine {name!r} (line {record['line']})"
        allowed = {consequences[name]["line"]} if name in consequences else set()
        stray = [str(item["line"]) for item in record.get("untagged", []) if item["line"] not in allowed]
        require(not stray, f"{where} has untagged lines ({', '.join(stray)}) other than a root's colon-less "
                           "INHERIT_TYPE line; whether the game honours them is not established")
        overwritten = effective[name]["overwritten"] if name in effective else []
        require(not overwritten, f"{where} declares " + ", ".join(f":{item['tag']} (line {item['line']})"
                                                                  for item in overwritten)
                + " before its :INHERIT_TYPE, which overwrites them; this page shows no overwritten declaration")
        for tag, field in record["fields"].items():
            if tag != "INHERIT_TYPE":
                written[name, tag] = written_value(database, where, tag, field, lines)
    counts = engine_field_counts(effective)
    if expected_counts is not None:
        differ = [f"{tag} {counts.get(tag, {})}, not {expected}" for tag, expected in expected_counts.items()
                  if counts.get(tag) != expected]
        differ += [f"{tag} {counts[tag]}, not recorded" for tag in counts if tag not in expected_counts]
        require(not differ, "The inheriting engines' effective field counts differ from ENGINE_FIELD_COUNTS: "
                + "; ".join(differ))
    applied = {name: entry["inherit_type"] for name, entry in effective.items() if not entry["inherit_type"]["colon"]}
    engines = []
    for record in records:
        name = record["type"]
        fields = effective[name]["fields"] if name in effective else root_fields(record)
        engines.append({"name": name, "line": record["line"], "root": name not in effective,
                        "applied": applied.get(name),
                        "cells": {tag: engine_cell(tag, fields[tag], written, consequences, applied)
                                  for tag in engine_tags()}})
    return engines


def engine_differences(engines):
    """Per mapped tag, in offset order: {"groups", "zero_filled", "unresolved"}.

    Each group is {"forms", "engines"} for a value, or {"source", "source_line", "engines"} for a torque table.
    Numbers are grouped by the parsed number, enum words by the exact word, torque tables by the record and line
    that declare them; groups are in value order (torque tables in file order). Zero-filled and unresolved cells
    have no value and are listed apart. Engine lists are in file order.
    """
    order = {engine["name"]: i for i, engine in enumerate(engines)}
    result = {}
    for tag in engine_tags():
        groups, zero, unresolved = {}, [], []
        for engine in engines:
            cell = engine["cells"][tag]
            if cell["status"] in (UNRESOLVED, ZERO_FILLED):
                (unresolved if cell["status"] == UNRESOLVED else zero).append(engine["name"])
                continue
            if tag == TORQUE:
                key = (order[cell["source"]], cell["source_line"])
                group = groups.setdefault(key, {"source": cell["source"], "source_line": cell["source_line"],
                                                "engines": []})
            else:
                key = cell["written"] if is_enum(tag) else float(cell["value"])
                group = groups.setdefault(key, {"forms": [], "engines": []})
                if cell["written"] not in group["forms"]:
                    group["forms"].append(cell["written"])
            group["engines"].append(engine["name"])
        result[tag] = {"groups": [groups[key] for key in sorted(groups)], "zero_filled": zero,
                       "unresolved": unresolved}
    return result


def engine_row_anchor(name):
    return anchor("compare-engine", name)


def engine_line_link(name, line, text=None):
    return (f'<a href="{e(ENGINE_PAGE)}#{e(line_anchor("engine", name, line))}" title="{e(name)} line {e(line)}">'
            f'{e(text if text is not None else f"{name} line {line}")}</a>')


def unresolved_html(cell):
    """An unresolved value: the label, linked to the open question for INDIGO's line, and the line it depends on."""
    label = '<span class="label">unresolved</span>'
    if cell["question"]:
        label = f'<a href="{e(QUESTIONS_PAGE)}#{e(INDIGO_ANCHOR)}">{label}</a>'
    return f'{label}<br><small>no value; depends on {engine_line_link(cell["root"], cell["root_line"])}</small>'


def applied_html(hops):
    """The applied colon-less lines a value came through, each with its basis label linked to its question."""
    return "".join(f'; through {engine_line_link(hop["record"], hop["line"], f"{hop["record"]} line {hop["line"]}")} '
                   f'(no colon), {basis_html(hop["basis"])}' for hop in hops)


def provenance_html(cell):
    """Declared, or inherited from the source record, with the INHERIT_TYPE path when it has more than one step and
    each applied colon-less line it crosses."""
    if cell["status"] == "declared":
        return "declared"
    text = f'inherited from <a href="#{e(engine_row_anchor(cell["source"]))}">{e(cell["source"])}</a>'
    if len(cell["path"]) > 2:
        text += ", path " + " &rarr; ".join(e(hop) for hop in cell["path"])
    return text + applied_html(cell.get("applied", []))


def max_rpm_html(rpm):
    """The MAX_RPM a torque table was parsed with: its declaration, the zero fill, or unresolved."""
    if rpm["status"] == UNRESOLVED:
        label = '<span class="label">unresolved</span>'
        if rpm["question"]:
            label = f'<a href="{e(QUESTIONS_PAGE)}#{e(INDIGO_ANCHOR)}">{label}</a>'
        return f'{label} (depends on {engine_line_link(rpm["root"], rpm["root_line"])})'
    if rpm["status"] == ZERO_FILLED:
        return '<span class="label">zero-filled</span>'
    return engine_line_link(rpm["source"], rpm["source_line"])


def engine_cell_html(engine, tag, cell):
    """One matrix cell. A root's TORQUE_ARRAY links only its declaration row: the engine page gives only inheriting
    engines an effective TORQUE_ARRAY row."""
    if cell["status"] == UNRESOLVED:
        return f"<td>{unresolved_html(cell)}</td>"
    if cell["status"] == ZERO_FILLED:
        path = (", path " + " &rarr; ".join(e(hop) for hop in cell["path"])) if len(cell["path"]) > 1 else ""
        return (f'<td><span class="label">zero-filled</span><br><small>no value{path}'
                f'{applied_html(cell.get("applied", []))}</small></td>')
    if tag == TORQUE:
        rows = f'{cell["rows"]} row{"" if cell["rows"] == 1 else "s"}'
        if not engine["root"]:
            rows = f'<a href="{e(ENGINE_PAGE)}#{e(anchor("engine", engine["name"], "torque-array"))}">{rows}</a>'
        return (f'<td>{engine_line_link(cell["source"], cell["source_line"])}, {rows}<br><small>'
                f'{provenance_html(cell)}; parsed with <code>MAX_RPM</code> {max_rpm_html(cell["max_rpm"])}'
                "</small></td>")
    return (f'<td><span class="num">{engine_line_link(cell["source"], cell["source_line"], cell["written"])}</span>'
            f"<br><small>{provenance_html(cell)}</small></td>")


def engine_column_header(tag):
    stored = [(offset, store) for offset, store in ENGINE_FIELD_STORES[tag]["offsets"].items() if not store.get("derived")]
    where = ", ".join(f'<code>+ {e(offset)}</code>, {e(store["width"])}'
                      + (f' &times; {e(store["slots"])}' if "slots" in store else "") for offset, store in stored)
    kind = "rows" if tag == TORQUE else ("enum word" if is_enum(tag) else "number")
    return (f'<th><a href="{e(ENGINE_PAGE)}#{e(engine_store_anchor(tag))}"><code>{e(tag)}</code></a><br>'
            f"<small>{where}<br>{kind}</small></th>")


def engine_matrix(engines):
    header = "<tr><th>Engine</th>" + "".join(engine_column_header(tag) for tag in engine_tags()) + "</tr>"
    rows = []
    for engine in engines:
        name = engine["name"]
        cells = "".join(engine_cell_html(engine, tag, engine["cells"][tag]) for tag in engine_tags())
        kind = "root" if engine["root"] else "inherits"
        if engine.get("applied"):
            hop = engine["applied"]
            kind += (f' {e(hop["parent"])} through colon-less '
                     f'{engine_line_link(name, hop["line"], f"line {hop["line"]}")}, {basis_html(hop["basis"])}')
        rows.append(f'<tr id="{e(engine_row_anchor(name))}"><td><a href="{e(ENGINE_PAGE)}#{e(anchor("engine", name))}">'
                    f"{e(name)}</a><br><small>{kind}</small></td>{cells}</tr>")
    return f'<div class="wide"><table class="matrix engines">{header}{"".join(rows)}</table></div>'


def engine_links(names):
    return ", ".join(f'<a href="#{e(engine_row_anchor(name))}">{e(name)}</a>' for name in names)


def engine_differences_table(engines):
    total = len(engines)
    inheriting = [engine for engine in engines if not engine["root"]]
    rows = []
    for tag, entry in engine_differences(engines).items():
        groups = entry["groups"]
        if tag == TORQUE:
            kind = "by record and line"
            shown = [f'{engine_line_link(group["source"], group["source_line"])} ({len(group["engines"])}): '
                     f'{engine_links(group["engines"])}' for group in groups]
        else:
            kind = "by word" if is_enum(tag) else "by number"
            shown = [", ".join(f"<code>{e(form)}</code>" for form in group["forms"])
                     + f' ({len(group["engines"])}): {engine_links(group["engines"])}' for group in groups]
        if entry["zero_filled"]:
            shown.append(f'<span class="label">zero-filled</span>, no value ({len(entry["zero_filled"])}): '
                         f'{engine_links(entry["zero_filled"])}')
        if len(groups) == 1 and not entry["zero_filled"] and not entry["unresolved"]:
            values = f'<span class="label">same in all {total}</span>: ' + shown[0].split(" (", 1)[0]
        else:
            values = "<ul>" + "".join(f"<li>{item}</li>" for item in shown) + "</ul>"
        statuses = {}
        for engine in inheriting:
            status = engine["cells"][tag]["effective_status"]
            statuses[status] = statuses.get(status, 0) + 1
        counts = ", ".join(f'{count} {"zero-filled" if status == ZERO_FILLED else status}'
                           for status, count in sorted(statuses.items(), key=lambda item: ("declared", "inherited",
                                                                                           ZERO_FILLED).index(item[0])))
        unresolved = (f'{len(entry["unresolved"])}: {engine_links(entry["unresolved"])}' if entry["unresolved"]
                      else "0")
        # A long tag may break after an underscore, so that the table fits a phone's width.
        rows.append(f'<tr id="{e(anchor("differs-engine", tag))}"><td><code>{e(tag).replace("_", "_<wbr>")}</code></td>'
                    f"<td>{len(groups)}, {kind}</td><td>{values}</td><td>{len(inheriting)} inheriting: {counts}"
                    f"<br>unresolved: {unresolved}</td></tr>")
    return ("<table><tr><th>Tag</th><th>Distinct values</th><th>Values as written (engine count): engines</th>"
            f'<th>Counts</th></tr>{"".join(rows)}</table>')


def engines_section(engines, counts_checked):
    total = len(engines)
    inheriting = sum(not engine["root"] for engine in engines)
    if counts_checked:
        check = ("For the demo's <code>ENGDATA.DAT</code> these declared and inherited counts are the ones "
                 "<code>scripts/text_database.py</code> records in <code>ENGINE_FIELD_COUNTS</code>; the page is not "
                 "written when they differ.")
    else:
        check = ("This <code>ENGDATA.DAT</code> is not the demo's, so these counts are not checked against "
                 "<code>ENGINE_FIELD_COUNTS</code>.")
    return "\n".join([
        '<h2 id="engines">Engines</h2>',
        f'<p class="scope">{ENGINE_SCOPE}</p>',
        f'<h3 id="engine-matrix">Every engine, field by field</h3><p>One row per engine, in <code>ENGDATA.DAT</code> '
        f"order: {total - inheriting} roots, which declare their own values, and {inheriting} engines that inherit. "
        "One column per field the loader stores, in payload offset order. Each value is the effective one, as "
        f'written on the line that declares it and linked to that line\'s row on <a href="{e(ENGINE_PAGE)}">the engine '
        "page</a>; it is marked declared (the engine's own line) or inherited from the record that declares it, with "
        "the <code>INHERIT_TYPE</code> path when that is more than one step. A <code>TORQUE_ARRAY</code> cell gives the "
        "record and line that declare the table, its row count and the <code>MAX_RPM</code> declaration it was parsed "
        "with, and links the engine's effective <code>TORQUE_ARRAY</code> row. Each column header links to that "
        "field's row in the engine page's \"Where each field is stored\" table, with the byte-checked compare and "
        "store sites.</p>",
        engine_matrix(engines),
        f'<h3 id="engine-differences">What differs</h3><p>For each field, how many distinct effective values the {total} '
        "engines hold, and which engines hold each. Numbers are grouped by the number, so two spellings of one number "
        "are one value, with each spelling shown; enum words are grouped exactly as written, and torque tables by the "
        "record and line that declare them. Unresolved cells have no value and are counted apart, not as zero. The "
        f"last column counts how the {inheriting} inheriting engines get each field, <code>INDIGO</code>'s "
        "colon-less line applied on static instruction evidence and any other colon-less line not applied, and then "
        "the unresolved cells. "
        f"{check}</p>",
        engine_differences_table(engines)])


def is_demo(database, manifest_path=GAME_MANIFEST):
    """True when `database` was parsed from the demo's file, by the SHA-256 the committed game-file manifest records
    for its path."""
    manifest = load_json(manifest_path, "Game file manifest (analysis/game-file-manifest.json)")
    require(isinstance(manifest, list), "game-file-manifest.json must be a list")
    recorded = {item.get("path"): item.get("sha256") for item in manifest if isinstance(item, dict)}
    return recorded.get(database["source"]) == database["sha256"]


def demo_tyre_counts(database, manifest_path=GAME_MANIFEST):
    """TYRE_COUNTS when tyres.json was parsed from the demo's TYREDATA.DAT, else None: nothing records another
    file's counts."""
    return TYRE_COUNTS if is_demo(database, manifest_path) else None


def tyre_written(database, where, tag, field, lines):
    """Check one mapped tyre scalar declaration against its line in TYREDATA.DAT; return its token as written."""
    line = field["line"]
    require(not field["rows"] and len(field["values"]) == 1, f"{where}: :{tag} on line {line} is not a single inline value")
    declared = field["values"][0]
    require(isinstance(declared, (int, float)) and not isinstance(declared, bool),
            f"{where}: :{tag} on line {line} is stored as a float, but {declared!r} is not a number")
    tokens = lines.get(line, [])
    require(len(tokens) == 2 and tokens[0] == f":{tag}",
            f"{where}: line {line} of {database['source']} is not ':{tag} <value>' (rerun scripts/text_database.py)")
    parsed = value(tokens[1], line)
    require(type(parsed) is type(declared) and parsed == declared,
            f"{where}: line {line} of {database['source']} declares {tokens[1]!r}, but tyres.json holds "
            f"{declared!r} (rerun scripts/text_database.py)")
    return tokens[1]


def root_scalars(record):
    """A root tyre's mapped scalar fields, shaped like tyres.json's effective_scalars entries: its own declaration,
    or the zero fill."""
    name, fields = record["type"], record["fields"]
    result = {}
    for tag in TYRE_SCALAR_STORES:
        field = fields.get(tag)
        result[tag] = ({"status": "declared", "values": field["values"], "source": name, "source_line": field["line"],
                        "path": [name]} if field is not None else {"status": ZERO_FILLED, "path": [name]})
    return result


def count_problems(label, counts, expected):
    differ = [f"{key} {counts.get(key, {})}, not {want}" for key, want in expected.items() if counts.get(key) != want]
    differ += [f"{key} {counts[key]}, not recorded" for key in counts if key not in expected]
    require(not differ, f"{label}: " + "; ".join(differ))


def check_tyres(database, data, expected_counts=None):
    """Check tyres.json against TYREDATA.DAT's bytes; return {"tyres", "unmapped", "overwritten"} for the page.

    Each tyre is {"name", "line", "root", "scalars": {tag: cell}, "tables": {table: provenance entry}}, in file order,
    with a cell for every mapped scalar tag and every resolved table. `unmapped` and `overwritten` list the
    declarations that get no column: {"name", "tag", "line"}. expected_counts, when given, is {"scalars", "tables"}:
    the inheriting tyres' scalar status counts and every tyre's table source counts must equal them.
    """
    tyre_dossier.check_input_shapes(database)
    records = database["records"]
    names = [record["type"] for record in records]
    require(names, "tyres.json has no records")
    require(len(set(names)) == len(names), "tyres.json has duplicate record names")
    require(hashlib.sha256(data).hexdigest() == database["sha256"],
            f"{database['source']} does not match tyres.json's SHA-256 (rerun scripts/text_database.py)")
    effective = database["effective_scalars"]
    lines = dict(lines_of(data))
    written, unmapped, overwritten = {}, [], []
    for record in records:
        name = record["type"]
        where = f"tyre {name!r} (line {record['line']})"
        entry = effective.get(name)
        listed = {(item["tag"], item["line"]) for item in entry["unmapped"]} if entry else set()
        for tag, field in scalar_tags(record):
            if tag in TYRE_SCALAR_STORES:
                written[name, tag] = tyre_written(database, where, tag, field, lines)
                continue
            # tyres.json lists unmapped declarations only for inheriting tyres; a root's are its own, uncopied.
            require(entry is None or (tag, field["line"]) in listed,
                    f"{where} declares :{tag} on line {field['line']}, which has no byte-checked store, and tyres.json "
                    "does not list it as unmapped (rerun scripts/text_database.py)")
            unmapped.append({"name": name, "tag": tag, "line": field["line"]})
        if entry:
            overwritten += [{"name": name, "tag": item["tag"], "line": item["line"]} for item in entry["overwritten"]]
    require(database["resolved_tables"] == resolve_tyre_tables(records),
            "tyres.json resolved_tables disagrees with INHERIT_TYPE resolved by scripts/text_database.py (rerun it)")
    require(database["table_provenance"] == tyre_table_provenance(records),
            "tyres.json table_provenance disagrees with what scripts/text_database.py derives (rerun it)")
    require(effective == effective_scalars(records),
            "tyres.json effective_scalars disagrees with the record declarations (rerun scripts/text_database.py)")
    check_effective_scalars(records, effective)
    if expected_counts is not None:
        count_problems("The inheriting tyres' effective scalar counts differ from TYRE_SCALAR_COUNTS",
                       scalar_counts(effective), expected_counts["scalars"])
        count_problems("The tyres' table source counts differ from TYRE_TABLE_SOURCES",
                       table_sources(database["resolved_tables"]), expected_counts["tables"])
    tyres = []
    for record in records:
        name = record["type"]
        fields = effective[name]["fields"] if name in effective else root_scalars(record)
        scalars = {}
        for tag in tyre_dossier.tyre_tags():
            field = fields[tag]
            cell = {"status": field["status"], "path": field["path"]}
            if field["status"] != ZERO_FILLED:
                cell.update(source=field["source"], source_line=field["source_line"],
                            written=written[field["source"], tag], value=field["values"][0])
            scalars[tag] = cell
        tyres.append({"name": name, "line": record["line"], "root": name not in effective, "scalars": scalars,
                      "tables": database["table_provenance"][name]})
    return {"tyres": tyres, "unmapped": unmapped, "overwritten": overwritten}


def tyre_differences(tyres):
    """{"scalars": {tag: {"groups", "zero_filled"}}, "tables": {table: [{"source", "source_line", "tyres"}]}}.

    Scalar groups are {"forms", "tyres"}, grouped by the parsed number and in number order, each written form once in
    file order; zero-filled cells have no value and are listed apart. Table groups are by source record, in file order
    of the source. Tyre lists are in file order.
    """
    order = {tyre["name"]: i for i, tyre in enumerate(tyres)}
    scalars = {}
    for tag in tyre_dossier.tyre_tags():
        groups, zero = {}, []
        for tyre in tyres:
            cell = tyre["scalars"][tag]
            if cell["status"] == ZERO_FILLED:
                zero.append(tyre["name"])
                continue
            group = groups.setdefault(float(cell["value"]), {"forms": [], "tyres": []})
            if cell["written"] not in group["forms"]:
                group["forms"].append(cell["written"])
            group["tyres"].append(tyre["name"])
        scalars[tag] = {"groups": [groups[key] for key in sorted(groups)], "zero_filled": zero}
    tables = {}
    for table in RESOLVED_TYRE_TABLES:
        groups = {}
        for tyre in tyres:
            entry = tyre["tables"][table]
            group = groups.setdefault(entry["source"], {"source": entry["source"], "source_line": entry["source_line"],
                                                        "tyres": []})
            group["tyres"].append(tyre["name"])
        tables[table] = [groups[source] for source in sorted(groups, key=order.__getitem__)]
    return {"scalars": scalars, "tables": tables}


def tyre_row_anchor(name):
    return anchor("compare-tyre", name)


def tyre_links(names):
    return ", ".join(f'<a href="#{e(tyre_row_anchor(name))}">{e(name)}</a>' for name in names)


def tyre_line_link(name, line, text=None):
    return (f'<a href="{e(TYRE_PAGE)}#{e(line_anchor("tyre", name, line))}" title="{e(name)} line {e(line)}">'
            f'{e(text if text is not None else f"{name} line {line}")}</a>')


def tyre_source_link(table, group):
    """A table's source record, linked to the source's own row for the table on the tyre page, with the line that
    declares it."""
    source = group["source"]
    return (f'<a href="{e(TYRE_PAGE)}#{e(tyre_dossier.anchor(source, table))}" title="{e(source)} line '
            f'{e(group["source_line"])}">{e(source)}</a> line {e(group["source_line"])}')


def tyre_path_html(path):
    """The INHERIT_TYPE path, when it has more than one step."""
    return (", path " + " &rarr; ".join(e(hop) for hop in path)) if len(path) > 2 else ""


def tyre_scalar_html(cell):
    if cell["status"] == ZERO_FILLED:
        path = (", path " + " &rarr; ".join(e(hop) for hop in cell["path"])) if len(cell["path"]) > 1 else ""
        return f'<td><span class="label">{e(ZERO_FILLED)}</span><br><small>no value{path}</small></td>'
    if cell["status"] == "declared":
        note = "declared"
    else:
        note = (f'inherited from <a href="#{e(tyre_row_anchor(cell["source"]))}">{e(cell["source"])}</a>'
                + tyre_path_html(cell["path"]))
    return (f'<td><span class="num">{tyre_line_link(cell["source"], cell["source_line"], cell["written"])}</span>'
            f"<br><small>{note}</small></td>")


def tyre_table_html(name, table, entry):
    """A table cell: the source record, linked to this tyre's row for the table on the tyre page (its Why? trail)."""
    note = "own table" if entry["source"] == name else "inherited" + tyre_path_html(entry["path"])
    return (f'<td><a href="{e(TYRE_PAGE)}#{e(tyre_dossier.anchor(name, table))}" title="{e(name)} '
            f'{e(tyre_dossier.TABLE_LABELS[table])}">{e(entry["source"])}</a><br><small>{note}</small></td>')


def tyre_scalar_header(tag):
    entry = TYRE_SCALAR_STORES[tag]
    offsets = ", ".join(f"<code>+ {e(offset)}</code>" for offset in entry["offsets"])
    kind = "float, scaled when stored" if "scaled_by" in entry else "float"
    return (f'<th><a href="{e(TYRE_PAGE)}#{e(tyre_dossier.store_anchor(tag))}"><code>{e(tag)}</code></a><br>'
            f"<small>{offsets}<br>{kind}</small></th>")


def tyre_table_header(table, accessors):
    entry = TYRE_TABLE_ACCESSORS[table]
    return (f"<th><code>{e(table)}</code><br><small>record <code>+ {e(entry['record_offset'])}</code><br>accessor "
            f"{routine_link(accessors[table], entry['accessor'])}</small></th>")


def tyre_matrix(tyres, accessors):
    header = ("<tr><th>Tyre</th>" + "".join(tyre_scalar_header(tag) for tag in tyre_dossier.tyre_tags())
              + "".join(tyre_table_header(table, accessors) for table in RESOLVED_TYRE_TABLES) + "</tr>")
    rows = []
    for tyre in tyres:
        name = tyre["name"]
        cells = ("".join(tyre_scalar_html(tyre["scalars"][tag]) for tag in tyre_dossier.tyre_tags())
                 + "".join(tyre_table_html(name, table, tyre["tables"][table]) for table in RESOLVED_TYRE_TABLES))
        kind = "root" if tyre["root"] else "inherits"
        rows.append(f'<tr id="{e(tyre_row_anchor(name))}"><td><a href="{e(TYRE_PAGE)}#{e(tyre_dossier.anchor(name))}">'
                    f"{e(name)}</a><br><small>{kind}</small></td>{cells}</tr>")
    return f'<div class="wide"><table class="matrix tyres">{header}{"".join(rows)}</table></div>'


def no_column_html(checked):
    """The declarations that get no column: unmapped tags, and declarations the INHERIT_TYPE copy overwrites."""
    parts = []
    if checked["unmapped"]:
        items = ", ".join(f'{tyre_line_link(item["name"], item["line"])} (<code>:{e(item["tag"])}</code>)'
                          for item in checked["unmapped"])
        parts.append(f'<div class="unresolved" id="tyre-unmapped"><p><span class="label">unmapped</span>: no '
                     f"byte-checked store is known for {items}, so these get no column and no value.</p></div>")
    if checked["overwritten"]:
        items = ", ".join(f'{tyre_line_link(item["name"], item["line"])} (<code>:{e(item["tag"])}</code>)'
                          for item in checked["overwritten"])
        parts.append(f"<p>Declared before <code>INHERIT_TYPE</code> and overwritten by the scalar copy, so shown in no "
                     f"cell: {items}.</p>")
    return "".join(parts)


def tyre_differences_table(tyres):
    total = len(tyres)
    inheriting = [tyre for tyre in tyres if not tyre["root"]]
    found = tyre_differences(tyres)
    rows = []
    for tag, entry in found["scalars"].items():
        groups = entry["groups"]
        shown = [", ".join(f"<code>{e(form)}</code>" for form in group["forms"])
                 + f' ({len(group["tyres"])}): {tyre_links(group["tyres"])}' for group in groups]
        if entry["zero_filled"]:
            shown.append(f'<span class="label">{e(ZERO_FILLED)}</span>, no value ({len(entry["zero_filled"])}): '
                         f'{tyre_links(entry["zero_filled"])}')
        if len(groups) == 1 and not entry["zero_filled"]:
            values = (f'<span class="label">same in all {total}</span>: '
                      + ", ".join(f"<code>{e(form)}</code>" for form in groups[0]["forms"]))
        else:
            values = "<ul>" + "".join(f"<li>{item}</li>" for item in shown) + "</ul>"
        statuses = {}
        for tyre in inheriting:
            status = tyre["scalars"][tag]["status"]
            statuses[status] = statuses.get(status, 0) + 1
        counts = ", ".join(f"{statuses[status]} {'zero-filled' if status == ZERO_FILLED else status}"
                           for status in ("declared", "inherited", ZERO_FILLED) if status in statuses)
        rows.append(f'<tr id="{e(anchor("differs-tyre", tag))}"><td><code>{e(tag).replace("_", "_<wbr>")}</code></td>'
                    f"<td>{len(groups)}, by number</td><td>{values}</td><td>{len(inheriting)} inheriting: {counts}"
                    "</td></tr>")
    for table, groups in found["tables"].items():
        sources = [tyre_source_link(table, group) for group in groups]
        shown = [f'{source} ({len(group["tyres"])}): {tyre_links(group["tyres"])}'
                 for source, group in zip(sources, groups, strict=True)]
        if len(groups) == 1:
            values = f'<span class="label">same in all {total}</span>: {sources[0]}'
        else:
            values = "<ul>" + "".join(f"<li>{item}</li>" for item in shown) + "</ul>"
        counts = ", ".join(f'{len(group["tyres"])} {e(group["source"])}' for group in groups)
        rows.append(f'<tr id="{e(anchor("differs-tyre", table))}"><td><code>{e(table).replace("_", "_<wbr>")}</code>'
                    f"</td><td>{len(groups)}, by source record</td><td>{values}</td><td>all {total}: {counts}</td></tr>")
    return ('<table class="tyre-differences"><tr><th>Field or table</th><th>Distinct values</th><th>Values as written '
            "(tyre count): tyres</th>"
            f'<th>Counts</th></tr>{"".join(rows)}</table>')


def tyres_section(checked, accessors, counts_checked):
    tyres = checked["tyres"]
    total = len(tyres)
    inheriting = sum(not tyre["root"] for tyre in tyres)
    if counts_checked:
        check = ("For the demo's <code>TYREDATA.DAT</code> the inheriting tyres' declared and inherited counts are the "
                 "ones <code>scripts/text_database.py</code> records in <code>TYRE_SCALAR_COUNTS</code>, and the table "
                 "source counts the ones in <code>TYRE_TABLE_SOURCES</code>; the page is not written when they differ.")
    else:
        check = ("This <code>TYREDATA.DAT</code> is not the demo's, so these counts are not checked against "
                 "<code>TYRE_SCALAR_COUNTS</code> or <code>TYRE_TABLE_SOURCES</code>.")
    return "\n".join(part for part in [
        '<h2 id="tyres">Tyres</h2>',
        f'<p class="scope">{TYRE_SCOPE}</p>',
        f'<h3 id="tyre-matrix">Every tyre, field by field</h3><p>One row per tyre, in <code>TYREDATA.DAT</code> order: '
        f"{total - inheriting} root{'' if total - inheriting == 1 else 's'}, which declare{'s' if total - inheriting == 1 else ''} "
        f"{'its' if total - inheriting == 1 else 'their'} own values, and {inheriting} tyres that inherit. One column per "
        "scalar field the loader stores, in payload offset order, then one per table the game reads through an "
        "<code>INHERIT_TYPE</code>-following accessor. Each scalar value is the effective one, as written on the line "
        f'that declares it and linked to that line\'s row on <a href="{e(TYRE_PAGE)}">the tyre page</a>; it is marked '
        "declared (the tyre's own line) or inherited from the record that declares it, with the "
        "<code>INHERIT_TYPE</code> path when that is more than one step. Each table cell names the record whose table "
        "the game reads and links this tyre's row for that table on the tyre page, with its Why? trail. Each scalar "
        "column header links to that field's row in the tyre page's \"Where each field is stored\" table; each table "
        "column header gives the record offset its accessor tests and links the accessor on the routines page.</p>",
        tyre_matrix(tyres, accessors),
        no_column_html(checked),
        f'<h3 id="tyre-differences">What differs</h3><p>For each scalar field, how many distinct effective values the '
        f"{total} tyres hold, and which tyres hold each, grouped by the number, so two spellings of one number (such as "
        "<code>1</code> and <code>1.0</code>) are one value, with each spelling shown; zero-filled cells have no value "
        "and are listed apart. For each table, which record the tyres read it from. The last column counts how the "
        f"{inheriting} inheriting tyres get each scalar field, and how many tyres read each table from each source. "
        f"{check}</p>",
        tyre_differences_table(tyres)] if part)


def tyre_accessor_labels(labels):
    """{table: the status.json label of its accessor}, which the table column headers link on the routines page."""
    return {table: routine_label(labels, int(entry["accessor"], 16), f"{table} accessor {entry['accessor']}")
            for table, entry in TYRE_TABLE_ACCESSORS.items()}


def render(database, gearboxes, pe, revision, entrance=False, engine_database=None, engines=(), counts_checked=False,
           tyre_database=None, tyres=None, accessors=None, tyre_counts_checked=False):
    """Return the page. check_gearboxes() must have accepted the inputs and returned `gearboxes`, check_engines()
    `engine_database` and `engines`, and check_tyres() `tyre_database` and `tyres`; counts_checked and
    tyre_counts_checked say whether they checked the counts against the demo's. accessors is
    tyre_accessor_labels()."""
    total = len(gearboxes)
    fields = len(GEARBOX_FIELD_STORES)
    return "\n".join([
        page_start("Ford Racing 3 demo: compare records", PAGE, STYLE + EXTRA_STYLE, entrance),
        "<h1>Ford Racing 3 demo: compare records</h1><dl>",
        f'<dt>Executable</dt><dd><code>{e(pe.get("file", "fr3.exe"))}</code> SHA-256 <code>{e(pe["sha256"])}</code>, '
        f'PE timestamp {e(pe.get("timestamp_header_utc", "unknown"))}</dd>',
        f'<dt>Gearbox database</dt><dd><code>{e(database["source"])}</code> SHA-256 <code>{e(database["sha256"])}'
        "</code></dd>",
        f'<dt>Engine database</dt><dd><code>{e(engine_database["source"])}</code> SHA-256 '
        f'<code>{e(engine_database["sha256"])}</code></dd>',
        f'<dt>Tyre database</dt><dd><code>{e(tyre_database["source"])}</code> SHA-256 '
        f'<code>{e(tyre_database["sha256"])}</code></dd>',
        f"<dt>Producer revision</dt><dd><code>{e(revision)}</code> (<code>scripts/record_compare.py</code>)</dd>",
        f"<dt>Compared</dt><dd>{total} gearboxes, {fields} fields each; {len(engines)} engines, "
        f"{len(ENGINE_FIELD_STORES)} fields each; {len(tyres['tyres'])} tyres, {len(TYRE_SCALAR_STORES)} scalar fields "
        f"and {len(RESOLVED_TYRE_TABLES)} tables each</dd></dl>",
        "<p>This page lines up records of one kind field by field, each value linked to the line that declares it "
        "and each field to where the loader stores it. Gearboxes, engines and tyres are compared.</p>",
        '<p>Jump to: <a href="#gearboxes">Gearboxes</a> | <a href="#engines">Engines</a> | <a href="#tyres">Tyres</a>'
        "</p>",
        f'<p class="scope">{SCOPE}</p>',
        '<h2 id="gearboxes">Gearboxes</h2>',
        f'<h3 id="gearbox-matrix">Every gearbox, field by field</h3><p>One row per gearbox, in '
        f"<code>GEARDATA.DAT</code> order, and one column per field, in payload offset order. Read any two rows to "
        f'compare two gearboxes. Each value links to its declaration row on <a href="{e(GEARBOX_PAGE)}">the gearbox '
        "page</a>; each column header links to that field's row in its \"Where each field is stored\" table, with "
        "the byte-checked compare and store sites.</p>",
        matrix(gearboxes),
        f'<h3 id="gearbox-differences">What differs</h3><p>For each field, how many distinct values the {total} '
        "gearboxes declare, and which gearboxes declare each. Fields read as a float are grouped by the number, so "
        "two spellings of one number (such as <code>0.2</code> and <code>0.20</code>) are one value, with each "
        "spelling shown; enum words are grouped exactly as written.</p>",
        differences_table(gearboxes),
        engines_section(engines, counts_checked),
        tyres_section(tyres, accessors, tyre_counts_checked),
        "</body></html>\n"])


def game_file(database, label, game_dir):
    """The bytes of the database file `database` (gearboxes.json, engines.json or tyres.json) was parsed from, under
    game_dir."""
    require(isinstance(database, dict) and isinstance(database.get("source"), str),
            f"{label} must be an object with a 'source'")
    source = Path(game_dir) / database["source"]
    require(source.is_file(), f"{database['source']} not found under {game_dir} (run scripts/acquire_demo.py inputs)")
    return source.read_bytes()


def build(gearboxes_path, engines_path, tyres_path, game_dir, pe_path, output, revision=None, entrance=False,
          engine_counts=None, manifest_path=GAME_MANIFEST, tyre_counts=None, status_path=ROUTINE_STATUS):
    """Read and check the inputs, then write the page to `output`; return the gearbox, engine and tyre counts compared.

    game_dir is the extracted Program_Executable_Files directory holding the GEARDATA.DAT, ENGDATA.DAT and
    TYREDATA.DAT the JSON files were parsed from. The inheriting engines' effective field counts must equal
    engine_counts when it is given, else ENGINE_FIELD_COUNTS when ENGDATA.DAT is the demo's by manifest_path's SHA-256;
    likewise the tyres' counts must equal tyre_counts ({"scalars", "tables"}) when given, else TYRE_COUNTS when
    TYREDATA.DAT is the demo's. status_path is the status.json whose labels the routines page beside `output` uses;
    the tyre table columns link their accessors there. entrance=True adds the entrance page to the nav bar, for
    scripts/build_research.py.
    """
    database = load_json(gearboxes_path, "Gearbox database (run scripts/text_database.py first)")
    engine_database = load_json(engines_path, "Engine database (run scripts/text_database.py first)")
    tyre_database = load_json(tyres_path, "Tyre database (run scripts/text_database.py first)")
    pe = load_json(pe_path, "PE metadata")
    check_pe(pe)
    gearboxes = check_gearboxes(database, game_file(database, "gearboxes.json", game_dir))
    engine_data = game_file(engine_database, "engines.json", game_dir)
    check_fields(engine_database, {"sha256": str}, "engines.json")
    expected = engine_counts if engine_counts is not None else demo_engine_counts(engine_database, manifest_path)
    engines = check_engines(engine_database, engine_data, expected)
    tyre_data = game_file(tyre_database, "tyres.json", game_dir)
    check_fields(tyre_database, {"sha256": str}, "tyres.json")
    tyre_expected = tyre_counts if tyre_counts is not None else demo_tyre_counts(tyre_database, manifest_path)
    tyres = check_tyres(tyre_database, tyre_data, tyre_expected)
    accessors = tyre_accessor_labels(routine_labels(status_path))
    page = render(database, gearboxes, pe, revision or producer_revision(), entrance, engine_database, engines,
                  expected is not None, tyre_database, tyres, accessors, tyre_expected is not None)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text(page, encoding="utf-8")
    return {"compared_gearboxes": len(gearboxes), "compared_engines": len(engines),
            "compared_tyres": len(tyres["tyres"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--gearboxes", type=Path, default=DATABASES["gearboxes"]["input"],
                        help="gearboxes.json written by scripts/text_database.py (default: %(default)s)")
    parser.add_argument("--engines", type=Path, default=DATABASES["engines"]["input"],
                        help="engines.json written by scripts/text_database.py (default: %(default)s)")
    parser.add_argument("--tyres", type=Path, default=REPO_ROOT / "artifacts/text-databases/tyres.json",
                        help="tyres.json written by scripts/text_database.py (default: %(default)s)")
    parser.add_argument("--game", type=Path, default=DEFAULT_GAME,
                        help="Extracted Program_Executable_Files directory gearboxes.json, engines.json and tyres.json "
                             "were parsed from (default: %(default)s)")
    parser.add_argument("--status", type=Path, default=ROUTINE_STATUS,
                        help="Routine labels the tyre table columns link to on routines.html (default: %(default)s)")
    parser.add_argument("--pe", type=Path, default=REPO_ROOT / "analysis/pe-metadata.json",
                        help="fr3.exe identity (default: %(default)s)")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "artifacts/dossier" / PAGE,
                        help="HTML file to write, beside gearboxes.html, engines.html and tyres.html; keep it out of Git, "
                             "it holds game data (default: %(default)s)")
    args = parser.parse_args()
    try:
        counts = build(args.gearboxes, args.engines, args.tyres, args.game, args.pe, args.output,
                       status_path=args.status)
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        raise SystemExit(f"record_compare.py: {error}") from None
    print(f"Compared {counts['compared_gearboxes']} gearboxes, {counts['compared_engines']} engines and "
          f"{counts['compared_tyres']} tyres field by field in {args.output}")


if __name__ == "__main__":
    main()
