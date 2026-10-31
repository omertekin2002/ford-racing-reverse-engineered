"""Generate an offline HTML dossier of the tyre records and their five resolved tables.

Inputs, all produced elsewhere and only read here:
  * tyres.json from scripts/text_database.py: `records`, `resolved_tables`,
    `table_provenance` and `scalar_inheritance`, plus the TYREDATA.DAT path and
    SHA-256.
  * analysis/selected/field-evidence.json: instruction sites byte-checked
    against fr3.exe.
  * analysis/pe-metadata.json: the executable's identity.

The output is one static HTML file with inline CSS, no JavaScript and no
external resources. For each tyre it shows the declarations as written, the
source record, INHERIT_TYPE path, source line, accessor and record offset of
each of the five tables, a "Why?" trail of the byte-checked sites behind each
table, and, for inheriting records, the scalar tags around INHERIT_TYPE labelled
unresolved. No inherited scalar value is computed or shown.

Evidence is matched by address, not claim text. A table's accessor sites are
the field-evidence sites inside its accessor (ACCESSOR_SPAN bytes from the
accessor address). Each of them must read [eax + record offset] or load the
inherited record from [eax + 0x14], and both kinds must be present. The loader
sites are the stores of the table address at the record offset and the
allocation sizes in LOADER_ALLOCATIONS, inside the loader's LOADER_SPAN, where
the evidence has them.

The script refuses to write a page, and exits non-zero, when a record lacks one
of the five tables, when `resolved_tables` and `table_provenance` disagree,
when a provenance path does not follow INHERIT_TYPE, or when a cited accessor
or record offset has no matching byte-checked site.
"""
import argparse
import html
import json
import os
from pathlib import Path
import subprocess

from text_database import REPO_ROOT, RESOLVED_TYRE_TABLES, check_table_provenance, require, table_sources

# Each table accessor ends before the next routine starts 0x20 bytes later (tyre_table_accessors.asm).
ACCESSOR_SPAN = 0x20
INHERIT_OFFSET = 0x14
# The tyre loader's export span (load_tyre_database.asm).
LOADER_SPAN = (0x00523820, 0x00523dc0)
# Loader sites that set a table's allocation size; they name no record offset (load_tyre_database.asm).
LOADER_ALLOCATIONS = {"LONGITUDINAL_COMBINED_VALUES": 0x00523be2, "LATERAL_COMBINED_VALUES": 0x00523b60,
                      "sound_info": 0x00523a67}
TABLE_LABELS = {"LONGITUDINAL_COMBINED_VALUES": "Longitudinal", "LATERAL_COMBINED_VALUES": "Lateral",
                "VERTICAL_LOAD": "Vertical load", "CAMBER_THRUST": "Camber thrust", "sound_info": "Sound info"}
ACCESSORS_ASM = REPO_ROOT / "analysis/selected/tyre_table_accessors.asm"
LOADER_ASM = REPO_ROOT / "analysis/selected/load_tyre_database.asm"
FIELD_EVIDENCE = REPO_ROOT / "analysis/selected/field-evidence.json"
STYLE = """
body { font: 15px/1.45 system-ui, sans-serif; margin: 2em auto; max-width: 72em; padding: 0 1em; color: #1b1b1b; }
code, .num { font-family: ui-monospace, monospace; font-size: 0.92em; }
table { border-collapse: collapse; margin: 0.5em 0 1em; }
th, td { border: 1px solid #c8c8c8; padding: 0.2em 0.5em; text-align: left; vertical-align: top; }
th { background: #f0f0f0; }
table.rows td { border-color: #e2e2e2; padding: 0 0.4em; text-align: right; }
section.tyre { border-top: 2px solid #888; margin-top: 2em; }
details { margin: 0.3em 0; }
summary { cursor: pointer; }
.scope, .unresolved { background: #fff6dd; border-left: 4px solid #d8a400; padding: 0.4em 0.8em; }
.label { font-weight: bold; text-transform: uppercase; }
:target { outline: 3px solid #3b7ddd; }
"""


def load_json(path, label):
    require(Path(path).is_file(), f"{label} not found: {path}")
    return json.loads(Path(path).read_text())


def modrm_disp8(raw):
    """Return (base register number, displacement) for an operand of the form [reg + disp8], else None."""
    if len(raw) < 3 or raw[1] >> 6 != 1 or raw[1] & 7 == 4:
        return None
    return raw[1] & 7, raw[2]


def check_evidence(evidence):
    require(isinstance(evidence, list), "field-evidence.json is not a list of sites")
    for site in evidence:
        require(isinstance(site, dict) and isinstance(site.get("va"), int) and isinstance(site.get("claim"), str)
                and isinstance(site.get("bytes"), str) and site["bytes"], f"Malformed field-evidence site: {site!r}")
        try:
            bytes.fromhex(site["bytes"])
        except ValueError:
            raise ValueError(f"Malformed field-evidence bytes at 0x{site['va']:08x}: {site['bytes']!r}") from None


def table_evidence(evidence, table, accessor, record_offset):
    """Return the accessor and loader sites in field-evidence.json for one table's accessor and offset."""
    label = f"{table} accessor {accessor} at + {record_offset}"
    try:
        start, offset = int(accessor, 16), int(record_offset, 16)
    except (TypeError, ValueError):
        raise ValueError(f"Unparsable accessor or record offset: {label}") from None
    reads = hops = 0
    accessor_sites = []
    for site in evidence:
        if not start <= site["va"] < start + ACCESSOR_SPAN:
            continue
        raw = bytes.fromhex(site["bytes"])
        operand = modrm_disp8(raw)
        # mov r32, [eax + disp8] (8b) or cmp dword [eax + disp8], imm8 (83 /7); the record pointer is in eax.
        require(operand and operand[0] == 0 and raw[0] in (0x8B, 0x83) and operand[1] in (offset, INHERIT_OFFSET),
                f"Byte-checked site 0x{site['va']:08x} inside {label} is neither a read of + {record_offset} "
                f"nor the + 0x{INHERIT_OFFSET:02x} fallback")
        reads += operand[1] == offset
        hops += operand[1] == INHERIT_OFFSET and raw[0] == 0x8B
        accessor_sites.append(site)
    require(reads, f"No byte-checked site in field-evidence.json shows the {label} reading its record offset")
    require(hops, f"No byte-checked site in field-evidence.json shows the {label} loading + 0x14")
    loader_sites = []
    for site in evidence:
        if not LOADER_SPAN[0] <= site["va"] < LOADER_SPAN[1]:
            continue
        raw = bytes.fromhex(site["bytes"])
        operand = modrm_disp8(raw)
        # mov [reg + disp8], r32 (89) at the table's record offset stores the table address.
        if (raw[0] == 0x89 and operand and operand[1] == offset) or site["va"] == LOADER_ALLOCATIONS.get(table):
            loader_sites.append(site)
    return {"accessor": accessor_sites, "loader": loader_sites}


def check_inputs(tyres, evidence):
    """Check the inputs agree with each other; return the evidence sites per (table, accessor, offset)."""
    for key in ("source", "sha256", "records", "resolved_tables", "table_provenance", "scalar_inheritance"):
        require(key in tyres, f"tyres.json has no {key!r}; regenerate it with scripts/text_database.py")
    records = tyres["records"]
    names = [record["type"] for record in records]
    require(names, "tyres.json has no records")
    require(len(set(names)) == len(names), "tyres.json has duplicate record names")
    resolved, provenance = tyres["resolved_tables"], tyres["table_provenance"]
    for name in names:
        for table in RESOLVED_TYRE_TABLES:
            require(table in resolved.get(name, {}), f"Tyre {name!r} lacks the {table} table in resolved_tables")
            require(table in provenance.get(name, {}), f"Tyre {name!r} lacks the {table} table in table_provenance")
            source, cited = resolved[name][table], provenance[name][table].get("source")
            require(source == cited, f"resolved_tables says {name!r} reads {table} from {source!r}, "
                                     f"table_provenance says {cited!r}")
    require(set(resolved) == set(names), "resolved_tables names records that are not in tyres.json records")
    require(all(set(tables) == set(RESOLVED_TYRE_TABLES) for tables in resolved.values()),
            "resolved_tables names tables other than the five resolved tables")
    check_evidence(evidence)
    sites = {}
    for tables in provenance.values():
        for table, entry in tables.items():
            key = (table, entry.get("accessor"), entry.get("record_offset"))
            if key not in sites:
                sites[key] = table_evidence(evidence, *key)
    check_table_provenance(records, provenance)
    inheriting = {record["type"] for record in records if "INHERIT_TYPE" in record["fields"]}
    scalars = tyres["scalar_inheritance"]
    require(set(scalars) == inheriting, "scalar_inheritance does not list exactly the records with INHERIT_TYPE")
    require(all(entry.get("status") == "unresolved" for entry in scalars.values()),
            "scalar_inheritance has an entry not labelled unresolved")
    return sites


def producer_revision():
    try:
        result = subprocess.run(["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"], capture_output=True, text=True,
                                check=False, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    revision = result.stdout.strip()
    return revision if result.returncode == 0 and revision else "unknown"


def e(text):
    return html.escape(str(text), quote=True)


def anchor(name, table=None):
    return f"tyre-{name}-{table}" if table else f"tyre-{name}"


def link(name, table=None):
    return f'<a href="#{e(anchor(name, table))}">{e(name)}</a>'


def rows_table(rows):
    body = "".join("<tr>" + "".join(f'<td class="num">{e(cell)}</td>' for cell in row) + "</tr>" for row in rows)
    return f'<table class="rows">{body}</table>'


def declarations(record):
    """Return the record's fields, :SOUND_INFO entries and untagged lines as table rows, in line order."""
    items = []
    for tag, field in record["fields"].items():
        if tag == "INHERIT_TYPE":
            shown = "parent " + link(field["values"][0])
        elif field["rows"]:
            shown = f'{len(field["rows"])} rows &times; {len(field["rows"][0])} columns' + rows_table(field["rows"])
        else:
            shown = f'<span class="num">{e(" ".join(map(str, field["values"])))}</span>'
        items.append((field["line"], f":{tag}", shown))
    for entry in record.get("sound_info", []):
        shown = (f'type <code>{e(entry["type"])}</code>, {e(entry["value_count"])} values, '
                 f'START_RPM <span class="num">{e(entry["start_rpm"])}</span>' + rows_table(entry["rows"]))
        items.append((entry["line"], ":SOUND_INFO", shown))
    for item in record.get("untagged", []):
        items.append((item["line"], "(untagged)", f'<code>{e(" ".join(item["tokens"]))}</code> kept verbatim, not applied'))
    body = "".join(f"<tr><td>{e(line)}</td><td><code>{e(tag)}</code></td><td>{shown}</td></tr>"
                   for line, tag, shown in sorted(items, key=lambda item: item[0]))
    return f"<table><tr><th>Line</th><th>Tag</th><th>Values</th></tr>{body}</table>"


def path_html(path, table):
    return " &rarr; ".join(link(hop, table) for hop in path)


def site_rows(role, sites):
    return "".join(f'<tr><td>{role}</td><td><code>0x{site["va"]:08x}</code></td><td><code>{e(site["bytes"])}</code></td>'
                   f'<td>{e(site["claim"])}</td></tr>' for site in sites)


def why_trail(name, table, entry, sites, by_name, hrefs, exe_sha256):
    hops = []
    for hop in entry["path"][:-1]:
        inherit = by_name[hop]["fields"]["INHERIT_TYPE"]
        hops.append(f"<li>{link(hop)} has no {e(table)} of its own; its <code>:INHERIT_TYPE</code> on line "
                    f"{e(inherit['line'])} names {link(inherit['values'][0])}.</li>")
    hops.append(f"<li>{link(entry['source'])} declares {e(table)} on line {e(entry['source_line'])}.</li>")
    found = site_rows("accessor", sites["accessor"]) + site_rows("loader", sites["loader"])
    return (f'<details><summary>Why does {e(name)} read {e(TABLE_LABELS[table])} from {e(entry["source"])}?</summary>'
            f'<p>The accessor at <code>{e(entry["accessor"])}</code> returns the table address at record '
            f'<code>+ {e(entry["record_offset"])}</code> when it is non-zero, and otherwise loads the inherited record '
            f'from <code>+ 0x14</code> and repeats the test (<a href="{e(hrefs["accessors"])}">accessor disassembly</a>, '
            f'<a href="{e(hrefs["loader"])}">loader disassembly</a>).</p><ol>{"".join(hops)}</ol>'
            f'<table><tr><th>Role</th><th>VA</th><th>Bytes</th><th>Claim</th></tr>{found}</table>'
            f'<p>Sites byte-checked against <code>fr3.exe</code> SHA-256 <code>{e(exe_sha256)}</code> '
            f'(<a href="{e(hrefs["evidence"])}">{e(Path(hrefs["evidence"]).name)}</a>).</p></details>')


def scalar_section(entry):
    def tags(scalars):
        return ", ".join(f"<code>{e(scalar['tag'])}</code> (line {e(scalar['line'])})" for scalar in scalars) or "none"
    inherit = entry["inherit_type"]
    return (f'<h3>Scalar inheritance</h3><div class="unresolved"><p><span class="label">{e(entry["status"])}</span>: '
            f'<code>:INHERIT_TYPE</code> {link(inherit["parent"])} on line {e(inherit["line"])}. The scalar copy at '
            f'<code>0x00524090</code> runs when <code>INHERIT_TYPE</code> is parsed, so which scalar values this tyre '
            f'ends up with depends on tag order, which is not modelled. No inherited value is shown.</p>'
            f'<table><tr><th>Scalar tags before <code>INHERIT_TYPE</code></th><td>{tags(entry["scalars_before"])}</td></tr>'
            f'<tr><th>Scalar tags after <code>INHERIT_TYPE</code></th><td>{tags(entry["scalars_after"])}</td></tr>'
            f'</table></div>')


def render(tyres, sites, pe, revision, hrefs):
    """Return the dossier HTML. check_inputs() must have accepted tyres first."""
    records = tyres["records"]
    by_name = {record["type"]: record for record in records}
    provenance = tyres["table_provenance"]
    parts = [f'<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">'
             f'<title>Ford Racing 3 demo tyre dossier</title><style>{STYLE}</style></head><body>',
             '<h1>Ford Racing 3 demo: tyre dossier</h1><dl>',
             f'<dt>Executable</dt><dd><code>{e(pe.get("file", "fr3.exe"))}</code> SHA-256 <code>{e(pe["sha256"])}</code>, '
             f'PE timestamp {e(pe.get("timestamp_header_utc", "unknown"))}</dd>',
             f'<dt>Tyre database</dt><dd><code>{e(tyres["source"])}</code> SHA-256 <code>{e(tyres["sha256"])}</code></dd>',
             f'<dt>Producer revision</dt><dd><code>{e(revision)}</code> (<code>scripts/tyre_dossier.py</code>)</dd>',
             f'<dt>Records</dt><dd>{len(records)}</dd></dl>',
             '<p class="scope">Scope: this dossier covers only the five tables the game reads through its '
             'INHERIT_TYPE-following accessors (longitudinal, lateral, vertical load, camber thrust and sound '
             'information). Scalar fields, engine inheritance and the colon-less <code>INDIGO</code> line in '
             '<code>ENGDATA.DAT</code> are unresolved. Two tyres that share a table source do not necessarily handle '
             'identically: their scalar fields and other tables can differ.</p>']
    counts = table_sources(tyres["resolved_tables"])
    parts.append('<h2>Table sources</h2><table><tr><th>Table</th><th>Accessor</th><th>Records per source</th></tr>')
    for table in RESOLVED_TYRE_TABLES:
        cited = provenance[records[0]["type"]][table]
        shown = ", ".join(f"{link(source, table)} {count}" for source, count in counts[table].items())
        parts.append(f'<tr><td>{e(TABLE_LABELS[table])}</td><td><code>{e(cited["accessor"])}</code> '
                     f'<code>+ {e(cited["record_offset"])}</code></td><td>{shown}</td></tr>')
    parts.append('</table><h2>Summary</h2><table><tr><th>Tyre</th>'
                 + "".join(f"<th>{e(TABLE_LABELS[table])}</th>" for table in RESOLVED_TYRE_TABLES) + "</tr>")
    for record in records:
        name = record["type"]
        parts.append(f"<tr><td>{link(name)}</td>"
                     + "".join(f"<td>{link(provenance[name][table]['source'])}</td>" for table in RESOLVED_TYRE_TABLES)
                     + "</tr>")
    parts.append("</table>")
    for record in records:
        name = record["type"]
        parts.append(f'<section class="tyre" id="{e(anchor(name))}"><h2>{e(name)}</h2>'
                     f'<p>Declared at line {e(record["line"])} of <code>{e(tyres["source"])}</code>.</p>'
                     f'<h3>Declarations, as written</h3>{declarations(record)}<h3>Table sources</h3>'
                     '<table><tr><th>Table</th><th>Source</th><th>Path</th><th>Source line</th><th>Accessor</th>'
                     '<th>Record offset</th></tr>')
        for table in RESOLVED_TYRE_TABLES:
            entry = provenance[name][table]
            parts.append(f'<tr id="{e(anchor(name, table))}"><td>{e(TABLE_LABELS[table])}</td>'
                         f'<td>{link(entry["source"], table)}</td><td>{path_html(entry["path"], table)}</td>'
                         f'<td>{e(entry["source_line"])}</td><td><code>{e(entry["accessor"])}</code></td>'
                         f'<td><code>+ {e(entry["record_offset"])}</code></td></tr>')
        parts.append("</table><h3>Why?</h3>")
        for table in RESOLVED_TYRE_TABLES:
            entry = provenance[name][table]
            found = sites[(table, entry["accessor"], entry["record_offset"])]
            parts.append(why_trail(name, table, entry, found, by_name, hrefs, pe["sha256"]))
        if name in tyres["scalar_inheritance"]:
            parts.append(scalar_section(tyres["scalar_inheritance"][name]))
        parts.append("</section>")
    parts.append("</body></html>\n")
    return "\n".join(parts)


def relative_href(target, output):
    return Path(os.path.relpath(target, Path(output).resolve().parent)).as_posix()


def build(tyres_path, evidence_path, pe_path, output, revision=None):
    """Read the inputs, check them and write the dossier; return the number of records."""
    tyres = load_json(tyres_path, "Tyre database (run scripts/text_database.py first)")
    evidence = load_json(evidence_path, "Field evidence")
    pe = load_json(pe_path, "PE metadata")
    require(isinstance(pe, dict) and pe.get("sha256"), "PE metadata has no sha256")
    sites = check_inputs(tyres, evidence)
    hrefs = {"accessors": relative_href(ACCESSORS_ASM, output), "loader": relative_href(LOADER_ASM, output),
             "evidence": relative_href(Path(evidence_path).resolve(), output)}
    page = render(tyres, sites, pe, revision or producer_revision(), hrefs)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text(page)
    return len(tyres["records"])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tyres", type=Path, default=REPO_ROOT / "artifacts/text-databases/tyres.json",
                        help="tyres.json written by scripts/text_database.py (default: %(default)s)")
    parser.add_argument("--evidence", type=Path, default=FIELD_EVIDENCE,
                        help="Byte-checked instruction sites (default: %(default)s)")
    parser.add_argument("--pe", type=Path, default=REPO_ROOT / "analysis/pe-metadata.json",
                        help="fr3.exe identity (default: %(default)s)")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "artifacts/dossier/tyres.html",
                        help="HTML file to write; keep it out of Git, it holds game data (default: %(default)s)")
    args = parser.parse_args()
    try:
        count = build(args.tyres, args.evidence, args.pe, args.output)
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit(f"tyre_dossier.py: {error}") from None
    print(f"Wrote {count} tyre records to {args.output}")


if __name__ == "__main__":
    main()
