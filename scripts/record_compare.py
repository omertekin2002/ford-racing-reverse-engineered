"""Generate the offline "Compare records" research page, compare.html.

Its first section compares the demo's gearboxes field by field. Inputs, all produced elsewhere and only read here:
  * gearboxes.json from scripts/text_database.py: `records`, plus the GEARDATA.DAT path and SHA-256.
  * GEARDATA.DAT itself, under the extracted game directory, whose SHA-256 must match gearboxes.json. The page
    shows each value exactly as written there (0.2 and 0.20 stay distinct), which the parsed numbers in
    gearboxes.json no longer record; each written token must parse to the value gearboxes.json holds.
  * analysis/pe-metadata.json: the executable's identity.

The page has two tables:
  * The matrix: one row per gearbox in GEARDATA.DAT order, one column per tag in GEARBOX_FIELD_STORES in payload
    offset order (+0x14 to +0x31). Each cell shows the declared value as written and links to that declaration's
    row on gearboxes.html (gearbox-<name>-line-<n>); each column header shows the tag's offset, width and how it is
    read, and links to its row in that page's "Where each field is stored" table (gearbox-store-<TAG>), which links
    the byte-checked compare and store sites on routines.html.
  * What differs: per tag, how many distinct values the gearboxes declare and which gearboxes declare each. Float
    tags (read as a float, including the two stored as an integer's low byte) are grouped by the parsed number, so
    1 and 1.0 are one value, with each written form shown; enum tags are grouped by the exact word. A tag with one
    value is labelled "same in all <n>".

Values are not interpreted: no units, enum meanings or physics, and the integer the loader stores the low byte of
for ANTI_WHEELSPIN and ANTI_WHEELSKID is not computed. Declared values are the stored values only because no
gearbox inherits, so the script refuses to write the page, and exits non-zero, when a gearbox
  * lacks one of the mapped tags or declares a tag that is not mapped,
  * declares :INHERIT_TYPE (gearbox inheritance is not resolved, and would make declared differ from stored),
  * has an untagged line (whether the game honours it is not established),
  * declares a mapped tag with rows or more than one value, or
  * declares a float tag with a value that is not a number,
and when GEARDATA.DAT does not match gearboxes.json, or an input is missing or malformed as record_dossier.py
checks it. The page has inline CSS, no JavaScript and no external resources other than the rights-holder notice's
two links. It links gearboxes.html, so it belongs beside the engine and gearbox pages.
"""
import argparse
import hashlib
from pathlib import Path

from dossier_common import STYLE, anchor, check_pe, e, line_anchor, load_json, page_start, producer_revision
from record_dossier import DATABASES, check_records, gearbox_tags, store_anchor
from text_database import GEARBOX_FIELD_STORES, REPO_ROOT, lines_of, require, value

PAGE = "compare.html"
GEARBOX_PAGE = DATABASES["gearboxes"]["page"]
DEFAULT_GAME = REPO_ROOT / "inputs/extracted/Program_Executable_Files"
FLOAT_KINDS = frozenset({"float", "float_to_byte"})
READ_TEXT = {"float": "float", "enum": "enum word", "float_to_byte": "float stored as an integer's low byte"}
EXTRA_STYLE = (".wide { overflow-x: auto; }\ntable.matrix td { white-space: nowrap; }\n"
               "table.matrix th small { font-weight: normal; }\n")
SCOPE = ('Scope: values are shown exactly as declared in <code>GEARDATA.DAT</code>, and linked to their declaration '
         "rows on the gearbox page. This page claims no units, no meaning for the enum words and no physics. For "
         "<code>ANTI_WHEELSPIN</code> and <code>ANTI_WHEELSKID</code> the loader converts the float to an integer "
         "and stores that integer's low byte; this page does not compute it. No demo gearbox declares "
         "<code>:INHERIT_TYPE</code>, so the declared values are the values the loader stores from the file, and "
         "nothing is inherited.")


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


def render(database, gearboxes, pe, revision, entrance=False):
    """Return the page. check_gearboxes() must have accepted the inputs and returned `gearboxes`."""
    total = len(gearboxes)
    fields = len(GEARBOX_FIELD_STORES)
    return "\n".join([
        page_start("Ford Racing 3 demo: compare records", PAGE, STYLE + EXTRA_STYLE, entrance),
        "<h1>Ford Racing 3 demo: compare records</h1><dl>",
        f'<dt>Executable</dt><dd><code>{e(pe.get("file", "fr3.exe"))}</code> SHA-256 <code>{e(pe["sha256"])}</code>, '
        f'PE timestamp {e(pe.get("timestamp_header_utc", "unknown"))}</dd>',
        f'<dt>Gearbox database</dt><dd><code>{e(database["source"])}</code> SHA-256 <code>{e(database["sha256"])}'
        "</code></dd>",
        f"<dt>Producer revision</dt><dd><code>{e(revision)}</code> (<code>scripts/record_compare.py</code>)</dd>",
        f"<dt>Compared</dt><dd>{total} gearboxes, {fields} fields each</dd></dl>",
        "<p>This page lines up records of one kind field by field, each value linked to the line that declares it "
        "and each field to where the loader stores it. Gearboxes come first; engines and tyres are not compared "
        "yet.</p>",
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
        "</body></html>\n"])


def build(gearboxes_path, game_dir, pe_path, output, revision=None, entrance=False):
    """Read and check the inputs, then write the page to `output`; return the number of gearboxes compared.

    game_dir is the extracted Program_Executable_Files directory holding the GEARDATA.DAT gearboxes.json was parsed
    from. entrance=True adds the entrance page to the nav bar, for scripts/build_research.py.
    """
    database = load_json(gearboxes_path, "Gearbox database (run scripts/text_database.py first)")
    pe = load_json(pe_path, "PE metadata")
    check_pe(pe)
    require(isinstance(database, dict) and isinstance(database.get("source"), str),
            "gearboxes.json must be an object with a 'source'")
    source = Path(game_dir) / database["source"]
    require(source.is_file(), f"{database['source']} not found under {game_dir} (run scripts/acquire_demo.py inputs)")
    gearboxes = check_gearboxes(database, source.read_bytes())
    page = render(database, gearboxes, pe, revision or producer_revision(), entrance)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text(page, encoding="utf-8")
    return len(gearboxes)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--gearboxes", type=Path, default=DATABASES["gearboxes"]["input"],
                        help="gearboxes.json written by scripts/text_database.py (default: %(default)s)")
    parser.add_argument("--game", type=Path, default=DEFAULT_GAME,
                        help="Extracted Program_Executable_Files directory gearboxes.json was parsed from "
                             "(default: %(default)s)")
    parser.add_argument("--pe", type=Path, default=REPO_ROOT / "analysis/pe-metadata.json",
                        help="fr3.exe identity (default: %(default)s)")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "artifacts/dossier" / PAGE,
                        help="HTML file to write, beside gearboxes.html; keep it out of Git, it holds game data "
                             "(default: %(default)s)")
    args = parser.parse_args()
    try:
        count = build(args.gearboxes, args.game, args.pe, args.output)
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        raise SystemExit(f"record_compare.py: {error}") from None
    print(f"Compared {count} gearboxes field by field in {args.output}")


if __name__ == "__main__":
    main()
