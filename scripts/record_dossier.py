"""Generate offline HTML dossiers of the engine and gearbox records, as declared.

Inputs, all produced elsewhere and only read here:
  * engines.json and gearboxes.json from scripts/text_database.py: `records`,
    plus the ENGDATA.DAT or GEARDATA.DAT path and SHA-256.
  * analysis/pe-metadata.json: the executable's identity.

The output is two static HTML files, engines.html and gearboxes.html, with
inline CSS, no JavaScript and no external resources. For each record they show
the declarations exactly as written, in line order: scalar values, multi-row
fields such as TORQUE_ARRAY as row tables with their dimensions, :INHERIT_TYPE
as a link to the parent labelled unresolved, and every untagged line verbatim
labelled unresolved. Nothing is resolved: no parent value is copied into a
child, and the meaning and units of the values are not interpreted.

The script refuses to write either page, and exits non-zero, when an input is
missing or malformed: `records` that are not a list, a record without `type`,
`line` or `fields`, duplicate record names, an :INHERIT_TYPE that does not name
an earlier record of the same file, or PE metadata without `sha256`.
"""
import argparse
from pathlib import Path

from dossier_common import STYLE, anchor, check_fields, check_pe, declarations, e, link, load_json, nav, producer_revision
from text_database import REPO_ROOT, require

TORQUE = "TORQUE_ARRAY"
# Per database: the default input, the output page, the anchor prefix and the wording.
DATABASES = {
    "engines": {"input": REPO_ROOT / "artifacts/text-databases/engines.json", "page": "engines.html",
                "prefix": "engine", "title": "engine", "file": "ENGDATA.DAT"},
    "gearboxes": {"input": REPO_ROOT / "artifacts/text-databases/gearboxes.json", "page": "gearboxes.html",
                  "prefix": "gearbox", "title": "gearbox", "file": "GEARDATA.DAT"},
}
EXTRA_STYLE = "section.record { border-top: 2px solid #888; margin-top: 2em; }\n"
INHERIT_NOTE = (' <span class="label">unresolved</span>: how the game applies this parent is not established; '
                "none of its values are copied here")
UNTAGGED_NOTE = (' kept verbatim, not applied <div class="unresolved"><span class="label">unresolved</span>: '
                 "this line has no colon, so the parser does not apply it; whether the game honours it is not "
                 "established</div>")


def scalar(item):
    return isinstance(item, (str, int, float)) and not isinstance(item, bool)


def check_records(database, label):
    """Check one parsed database's shape and INHERIT_TYPE references, in the manner of tyre_dossier.py."""
    check_fields(database, {"source": str, "sha256": str, "records": list}, label)
    names = set()
    require(database["records"], f"{label} has no records")
    for i, record in enumerate(database["records"]):
        where = f"{label}.records[{i}]"
        check_fields(record, {"type": str, "line": int, "fields": dict}, where)
        name = record["type"]
        require(name not in names, f"{label} has duplicate record name {name!r}")
        for tag, field in record["fields"].items():
            field_label = f"{where}.fields.{tag}"
            check_fields(field, {"line": int, "values": list, "rows": list}, field_label)
            require(all(scalar(item) for item in field["values"]), f"{field_label}.values must be scalars")
            require(all(isinstance(row, list) and row and all(scalar(cell) for cell in row)
                        for row in field["rows"]), f"{field_label}.rows must be non-empty lists of scalars")
            require(len({len(row) for row in field["rows"]}) <= 1, f"{field_label}.rows differ in column count")
            if tag == "INHERIT_TYPE":
                require(len(field["values"]) == 1 and isinstance(field["values"][0], str),
                        f"{field_label}.values must name one parent")
                parent = field["values"][0]
                require(parent in names, f"{label}: {name!r} inherits {parent!r}, which is not an earlier record")
        require(isinstance(record.get("untagged", []), list), f"{where}.untagged must be a list")
        for j, item in enumerate(record.get("untagged", [])):
            check_fields(item, {"line": int, "tokens": list}, f"{where}.untagged[{j}]")
            require(all(isinstance(token, str) for token in item["tokens"]), f"{where}.untagged[{j}].tokens must be strings")
        names.add(name)


def shape(field):
    return f'{len(field["rows"])} &times; {len(field["rows"][0])}' if field["rows"] else "inline"


def render(database, kind, pe, revision):
    """Return one dossier page. check_records() must have accepted the database first."""
    spec = DATABASES[kind]
    prefix, title = spec["prefix"], spec["title"]
    records = database["records"]
    inherits = kind == "engines" or any("INHERIT_TYPE" in record["fields"] for record in records)
    torque = kind == "engines"
    parts = [f'<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">'
             f'<title>Ford Racing 3 demo {title} dossier</title><style>{STYLE}{EXTRA_STYLE}</style></head><body>',
             nav(spec["page"]),
             f'<h1>Ford Racing 3 demo: {title} dossier</h1><dl>',
             f'<dt>Executable</dt><dd><code>{e(pe.get("file", "fr3.exe"))}</code> SHA-256 <code>{e(pe["sha256"])}</code>, '
             f'PE timestamp {e(pe.get("timestamp_header_utc", "unknown"))}</dd>',
             f'<dt>{title.capitalize()} database</dt><dd><code>{e(database["source"])}</code> '
             f'SHA-256 <code>{e(database["sha256"])}</code></dd>',
             f'<dt>Producer revision</dt><dd><code>{e(revision)}</code> (<code>scripts/record_dossier.py</code>)</dd>',
             f'<dt>Records</dt><dd>{len(records)}</dd></dl>',
             f'<p class="scope">Scope: values are shown exactly as declared in <code>{e(spec["file"])}</code>. '
             'Engine inheritance (<code>:INHERIT_TYPE</code>) and scalar fields are unresolved: no parent value is '
             'copied into a child, and a shared parent does not make two engines behave identically. The meaning and '
             'units of the values, including the torque arrays, are not established. Untagged lines, such as the '
             "colon-less <code>INHERIT_TYPE DEFAULT_TRACK</code> in the demo's <code>INDIGO</code> engine, are kept "
             'verbatim and not applied; whether the game honours them is not established.</p>',
             '<h2>Summary</h2><table><tr><th>Record</th><th>Line</th>'
             + ("<th>Parent (unresolved)</th>" if inherits else "")
             + (f"<th>{TORQUE} rows &times; columns</th>" if torque else "") + "</tr>"]
    for record in records:
        fields = record["fields"]
        row = f'<tr><td>{link(prefix, record["type"])}</td><td>{e(record["line"])}</td>'
        if inherits:
            row += f'<td>{link(prefix, fields["INHERIT_TYPE"]["values"][0]) if "INHERIT_TYPE" in fields else ""}</td>'
        if torque:
            row += f"<td>{shape(fields[TORQUE]) if TORQUE in fields else ''}</td>"
        parts.append(row + "</tr>")
    parts.append("</table>")
    for record in records:
        name = record["type"]
        parts.append(f'<section class="record" id="{e(anchor(prefix, name))}"><h2>{e(name)}</h2>'
                     f'<p>Declared at line {e(record["line"])} of <code>{e(database["source"])}</code>.</p>')
        inherit = record["fields"].get("INHERIT_TYPE")
        if inherit:
            parts.append(f'<div class="unresolved"><p><span class="label">unresolved</span>: <code>:INHERIT_TYPE</code> '
                         f'{link(prefix, inherit["values"][0])} on line {e(inherit["line"])}. Which of the parent\'s '
                         'values this record ends up with is not established, so only its own declarations are '
                         'shown.</p></div>')
        parts.append(f"<h3>Declarations, as written</h3>"
                     f"{declarations(record, prefix, INHERIT_NOTE, UNTAGGED_NOTE)}</section>")
    parts.append("</body></html>\n")
    return "\n".join(parts)


def build(engines_path, gearboxes_path, pe_path, output_dir, revision=None):
    """Read and check every input, then write both pages; return the record count per database."""
    databases = {"engines": load_json(engines_path, "Engine database (run scripts/text_database.py first)"),
                 "gearboxes": load_json(gearboxes_path, "Gearbox database (run scripts/text_database.py first)")}
    pe = load_json(pe_path, "PE metadata")
    check_pe(pe)
    for kind, database in databases.items():
        check_records(database, f"{kind}.json")
    revision = revision or producer_revision()
    pages = {kind: render(database, kind, pe, revision) for kind, database in databases.items()}
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    for kind, page in pages.items():
        (Path(output_dir) / DATABASES[kind]["page"]).write_text(page, encoding="utf-8")
    return {kind: len(database["records"]) for kind, database in databases.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engines", type=Path, default=DATABASES["engines"]["input"],
                        help="engines.json written by scripts/text_database.py (default: %(default)s)")
    parser.add_argument("--gearboxes", type=Path, default=DATABASES["gearboxes"]["input"],
                        help="gearboxes.json written by scripts/text_database.py (default: %(default)s)")
    parser.add_argument("--pe", type=Path, default=REPO_ROOT / "analysis/pe-metadata.json",
                        help="fr3.exe identity (default: %(default)s)")
    parser.add_argument("--output-dir", type=Path, default=REPO_ROOT / "artifacts/dossier",
                        help="Directory for engines.html and gearboxes.html, next to tyres.html; keep it out of Git, "
                             "the pages hold game data (default: %(default)s)")
    args = parser.parse_args()
    try:
        counts = build(args.engines, args.gearboxes, args.pe, args.output_dir)
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        raise SystemExit(f"record_dossier.py: {error}") from None
    print(f"Wrote {counts['engines']} engine and {counts['gearboxes']} gearbox records to {args.output_dir}")


if __name__ == "__main__":
    main()
