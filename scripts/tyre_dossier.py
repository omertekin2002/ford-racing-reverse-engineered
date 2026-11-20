"""Generate an offline HTML dossier of the tyre records and their five resolved tables.

Inputs, all produced elsewhere and only read here:
  * tyres.json from scripts/text_database.py: `records`, `resolved_tables`,
    `table_provenance` and `effective_scalars`, plus the TYREDATA.DAT path and
    SHA-256.
  * analysis/selected/field-evidence.json: instruction sites byte-checked
    against fr3.exe.
  * analysis/pe-metadata.json: the executable's identity.
  * analysis/annotated/status.json: the analyst labels of the routines the page
    links to on the sibling routines page (scripts/routine_index.py).

The output is one static HTML file with inline CSS, no JavaScript and no
external resources. For each tyre it shows the declarations as written, the
source record, INHERIT_TYPE path, source line, accessor and record offset of
each of the five tables, a "Why?" trail of the byte-checked sites behind each
table, and, for inheriting records, each mapped scalar field's effective
declaration with its status (declared, inherited or zero-filled), source record
and line (linked to that record's declaration row), INHERIT_TYPE path, payload
offsets and the byte-checked store and copy sites behind it. Zero-filled fields
get no value, and scalar tags without a byte-checked store are labelled
unmapped with no value. Values are the declared text, not physical quantities.
A note labels the
sound table's leading words, before its START_RPM values, unresolved and links
to their section on the Open questions page (scripts/open_questions.py).

The page links into the sibling routines page, routines.html: a "Loaded by"
line links the tyre loader's section, each Why? trail links its accessor's
section and every byte-checked site's row (#site-<va>), and each scalar section
links the scalar copy's section and its store, call and copy sites' rows. Every routine label comes from status.json by
entry VA; the loader and the scalar copy must also carry the labels in
LINKED_ROUTINES.

Evidence is matched by address, not claim text. A table's accessor sites are
the field-evidence sites inside its accessor (ACCESSOR_SPAN bytes from the
accessor address). Each of them must read [eax + record offset] or load the
inherited record from [eax + 0x14], and both kinds must be present. The loader
sites are the stores of the table address at the record offset and the
allocation sizes in LOADER_ALLOCATIONS, inside the loader's LOADER_SPAN, where
the evidence has them.

The script refuses to write a page, and exits non-zero, when a record lacks one
of the five tables, when `resolved_tables` and `table_provenance` disagree,
when a provenance path does not follow INHERIT_TYPE, when a cited accessor
or record offset has no matching byte-checked site, when `effective_scalars`
disagrees with the record declarations or TYRE_SCALAR_STORES lacks matching
byte-checked store, call or copy sites, or when a routine the page
links to is missing from status.json or, for the loader and scalar copy,
labelled differently there.
"""
import argparse
from pathlib import Path

import dossier_common
from dossier_common import (ROUTINE_STATUS, SOUND_ANCHOR, SOUND_NOTE_ID, check_fields, check_pe, e, line_anchor,
                            load_json, page_start, producer_revision, question_link, relative_href, routine_label,
                            routine_labels, routine_link, site_link)
from text_database import (REPO_ROOT, RESOLVED_TYRE_TABLES, SCALAR_COPY_CALL, SCALAR_COPY_SPAN, TYRE_SCALAR_STORES,
                           ZERO_FILLED, check_effective_scalars, check_table_provenance, effective_scalars, require,
                           scalar_evidence_problems, table_sources)

PAGE = "tyres.html"
# Each table accessor ends before the next routine starts 0x20 bytes later (tyre_table_accessors.asm).
ACCESSOR_SPAN = 0x20
INHERIT_OFFSET = 0x14
# The tyre loader's export span (load_tyre_database.asm).
LOADER_SPAN = (0x00523820, 0x00523dc0)
# Loader sites that set a table's allocation size; they name no record offset (load_tyre_database.asm).
LOADER_ALLOCATIONS = {"LONGITUDINAL_COMBINED_VALUES": 0x00523be2, "LATERAL_COMBINED_VALUES": 0x00523b60,
                      "sound_info": 0x00523a67}
# The routines the page links by a fixed entry VA, with the label status.json must give each; a renamed routine
# fails the build rather than shipping a link to a section the routines page does not have.
LOADER_VA, SCALAR_COPY_VA = LOADER_SPAN[0], SCALAR_COPY_SPAN[0]
SCALAR_STATUSES = ("declared", "inherited", ZERO_FILLED)
LINKED_ROUTINES = {LOADER_VA: ("tyre loader", "fr3_load_tyre_database"),
                   SCALAR_COPY_VA: ("tyre scalar copy", "fr3_copy_tyre_scalar_fields")}
TABLE_LABELS = {"LONGITUDINAL_COMBINED_VALUES": "Longitudinal", "LATERAL_COMBINED_VALUES": "Lateral",
                "VERTICAL_LOAD": "Vertical load", "CAMBER_THRUST": "Camber thrust", "sound_info": "Sound info"}
ACCESSORS_ASM = REPO_ROOT / "analysis/selected/tyre_table_accessors.asm"
LOADER_ASM = REPO_ROOT / "analysis/selected/load_tyre_database.asm"
FIELD_EVIDENCE = REPO_ROOT / "analysis/selected/field-evidence.json"


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
    stores = 0
    for site in evidence:
        if not LOADER_SPAN[0] <= site["va"] < LOADER_SPAN[1]:
            continue
        raw = bytes.fromhex(site["bytes"])
        operand = modrm_disp8(raw)
        # mov [reg + disp8], r32 (89) at the table's record offset stores the table address.
        store = raw[0] == 0x89 and operand and operand[1] == offset
        if store:
            stores += 1
        if store or site["va"] == LOADER_ALLOCATIONS.get(table):
            loader_sites.append(site)
    require(stores, f"No byte-checked loader store in field-evidence.json shows the {table} table at {record_offset}")
    return {"accessor": accessor_sites, "loader": loader_sites}


def check_input_shapes(tyres):
    check_fields(tyres, {"source": str, "sha256": str, "records": list, "resolved_tables": dict,
                         "table_provenance": dict, "effective_scalars": dict}, "tyres.json")
    for i, record in enumerate(tyres["records"]):
        label = f"tyres.json.records[{i}]"
        check_fields(record, {"type": str, "line": int, "fields": dict}, label)
        for tag, field in record["fields"].items():
            check_fields(field, {"line": int, "values": list, "rows": list}, f"{label}.fields.{tag}")
            require(all(isinstance(row, list) for row in field["rows"]), f"{label}.fields.{tag}.rows must contain lists")
            if tag == "INHERIT_TYPE":
                require(len(field["values"]) == 1 and isinstance(field["values"][0], str),
                        f"{label}.fields.INHERIT_TYPE.values must name one parent")
        for key in ("sound_info", "untagged"):
            require(isinstance(record.get(key, []), list), f"{label}.{key} must be a list")
        for j, entry in enumerate(record.get("sound_info", [])):
            entry_label = f"{label}.sound_info[{j}]"
            check_fields(entry, {"type": str, "line": int, "value_count": int, "start_rpm": (int, float), "rows": list},
                         entry_label)
            require(all(isinstance(row, list) for row in entry["rows"]), f"{entry_label}.rows must contain lists")
        for j, entry in enumerate(record.get("untagged", [])):
            check_fields(entry, {"line": int, "tokens": list}, f"{label}.untagged[{j}]")
            require(all(isinstance(token, str) for token in entry["tokens"]), f"{label}.untagged[{j}].tokens must be strings")
    for name, tables in tyres["resolved_tables"].items():
        require(isinstance(tables, dict), f"tyres.json.resolved_tables.{name} must be an object")
        require(all(isinstance(source, str) for source in tables.values()),
                f"tyres.json.resolved_tables.{name} sources must be strings")
    for name, tables in tyres["table_provenance"].items():
        require(isinstance(tables, dict), f"tyres.json.table_provenance.{name} must be an object")
        for table, entry in tables.items():
            label = f"tyres.json.table_provenance.{name}.{table}"
            check_fields(entry, {"source": str, "source_line": int, "accessor": str, "record_offset": str, "path": list}, label)
            require(all(isinstance(hop, str) for hop in entry["path"]), f"{label}.path must contain record names")
    for name, entry in tyres["effective_scalars"].items():
        label = f"tyres.json.effective_scalars.{name}"
        check_fields(entry, {"inherit_type": dict, "fields": dict, "overwritten": list, "unmapped": list}, label)
        check_fields(entry["inherit_type"], {"line": int, "parent": str}, f"{label}.inherit_type")
        for tag, field in entry["fields"].items():
            check_fields(field, {"status": str, "path": list, "offsets": list}, f"{label}.fields.{tag}")
            require(field["status"] in SCALAR_STATUSES, f"{label}.fields.{tag}.status {field['status']!r} is not one of "
                                                        + ", ".join(SCALAR_STATUSES))
            if field["status"] != ZERO_FILLED:
                check_fields(field, {"values": list, "source": str, "source_line": int}, f"{label}.fields.{tag}")
        for key in ("overwritten", "unmapped"):
            for i, scalar in enumerate(entry[key]):
                check_fields(scalar, {"tag": str, "line": int}, f"{label}.{key}[{i}]")


def check_inputs(tyres, evidence):
    """Check the inputs agree with each other; return the evidence sites per (table, accessor, offset)."""
    check_input_shapes(tyres)
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
    scalars = tyres["effective_scalars"]
    require(set(scalars) == inheriting, "effective_scalars does not list exactly the records with INHERIT_TYPE")
    problems = scalar_evidence_problems(evidence)
    require(not problems, "Tyre scalar stores lack byte-checked evidence: " + "; ".join(problems))
    require(scalars == effective_scalars(records), "effective_scalars disagrees with record declarations")
    check_effective_scalars(records, scalars)
    return sites


def copy_sites(evidence):
    """Return {payload offset: [load VA, store VA]} for the scalar copy's byte-checked load/store pairs."""
    pairs = {}
    for site in evidence:
        raw = site["bytes"]
        if SCALAR_COPY_SPAN[0] <= site["va"] < SCALAR_COPY_SPAN[1] and len(raw) == 6 and raw[:4] in ("8b4a", "8948"):
            pairs.setdefault(f"0x{int(raw[4:], 16):02x}", []).append(site["va"])
    return {offset: sorted(vas) for offset, vas in pairs.items()}


def store_sites(tag):
    """The byte-checked loader sites behind one tag's stores, in address order: the stores and any scale sites."""
    entry = TYRE_SCALAR_STORES[tag]
    sites = [site for sites in entry["offsets"].values() for site in sites] + list(entry.get("scale_sites", {}).values())
    return sorted(int(site, 16) for site in sites)


def scalar_site_vas(evidence):
    """Every site VA a scalar section links: the mapped stores, the INHERIT_TYPE call and the copy pairs."""
    stores = {va for tag in TYRE_SCALAR_STORES for va in store_sites(tag)}
    return stores | {SCALAR_COPY_CALL} | {va for vas in copy_sites(evidence).values() for va in vas}


def anchor(name, table=None):
    return dossier_common.anchor("tyre", name, table)


def link(name, table=None):
    return dossier_common.link("tyre", name, table)


def path_html(path, table):
    return " &rarr; ".join(link(hop, table) for hop in path)


def check_routines(labels, sites, evidence):
    """Check the routines and sites the page links to on the routines page; return {role or accessor: label}.

    Each accessor's label is whatever status.json gives its entry VA. The loader and the scalar copy must carry
    their LINKED_ROUTINES labels. Every linked site must be in field-evidence.json, where the routines page
    anchors it.
    """
    routines = {role: routine_label(labels, va, role, expected) for va, (role, expected) in LINKED_ROUTINES.items()}
    for table, accessor, _ in sites:
        routines[accessor] = routine_label(labels, int(accessor, 16), f"{table} accessor {accessor}")
    known = {site["va"] for site in evidence}
    linked = {site["va"] for found in sites.values() for group in found.values() for site in group}
    missing = sorted((linked | scalar_site_vas(evidence)) - known)
    require(not missing, "These linked sites are not in field-evidence.json: "
                         + ", ".join(f"0x{va:08x}" for va in missing))
    return routines


def site_rows(role, sites):
    return "".join(f'<tr><td>{role}</td><td>{site_link(site["va"])}</td><td><code>{e(site["bytes"])}</code></td>'
                   f'<td>{e(site["claim"])}</td></tr>' for site in sites)


def why_trail(name, table, entry, sites, by_name, hrefs, exe_sha256, routines):
    hops = []
    for hop in entry["path"][:-1]:
        inherit = by_name[hop]["fields"]["INHERIT_TYPE"]
        hops.append(f"<li>{link(hop)} has no {e(table)} of its own; its <code>:INHERIT_TYPE</code> on line "
                    f"{e(inherit['line'])} names {link(inherit['values'][0])}.</li>")
    hops.append(f"<li>{link(entry['source'])} declares {e(table)} on line {e(entry['source_line'])}.</li>")
    found = site_rows("accessor", sites["accessor"]) + site_rows("loader", sites["loader"])
    return (f'<details><summary>Why does {e(name)} read {e(TABLE_LABELS[table])} from {e(entry["source"])}?</summary>'
            f'<p>The accessor at {routine_link(routines[entry["accessor"]], entry["accessor"])} returns the table address at record '
            f'<code>+ {e(entry["record_offset"])}</code> when it is non-zero, and otherwise loads the inherited record '
            f'from <code>+ 0x14</code> and repeats the test (<a href="{e(hrefs["accessors"])}">accessor disassembly</a>, '
            f'<a href="{e(hrefs["loader"])}">loader disassembly</a>).</p><ol>{"".join(hops)}</ol>'
            f'<table><tr><th>Role</th><th>VA</th><th>Bytes</th><th>Claim</th></tr>{found}</table>'
            f'<p>Sites byte-checked against <code>fr3.exe</code> SHA-256 <code>{e(exe_sha256)}</code> '
            f'(<a href="{e(hrefs["evidence"])}">{e(Path(hrefs["evidence"]).name)}</a>).</p></details>')


def site_links(vas):
    return ", ".join(site_link(va) for va in vas)


def scalar_row(tag, field, copies):
    stores = store_sites(tag)
    offsets = ", ".join(f"<code>+ {e(offset)}</code>" for offset in field["offsets"])
    copied = site_links(va for offset in field["offsets"] for va in copies[offset])
    if field["status"] == ZERO_FILLED:
        value, source = f'<span class="label">{e(ZERO_FILLED)}</span>', "none along the path"
    else:
        value = f'<span class="num">{e(" ".join(map(str, field["values"])))}</span>'
        source = (f'<a href="#{e(line_anchor("tyre", field["source"], field["source_line"]))}">{e(field["source"])} '
                  f'line {e(field["source_line"])}</a>')
    scaled = (f' (scaled by the float at <code>{e(TYRE_SCALAR_STORES[tag]["scaled_by"])}</code> when stored)'
              if "scaled_by" in TYRE_SCALAR_STORES[tag] else "")
    return (f'<tr><td><code>{e(tag)}</code>{scaled}</td><td>{offsets}</td><td>{value}</td><td>{e(field["status"])}</td>'
            f'<td>{source}</td><td>{path_html(field["path"], None)}</td><td>{site_links(stores)}</td>'
            f'<td>{copied}</td></tr>')


def scalar_section(name, entry, copies, routines):
    inherit = entry["inherit_type"]
    copy = routine_link(routines["tyre scalar copy"], f"0x{SCALAR_COPY_VA:08x}")
    parts = [f'<h3>Scalar fields</h3><p><code>:INHERIT_TYPE</code> {link(inherit["parent"])} is on line '
             f'{e(inherit["line"])}. When the loader parses it, it calls the scalar copy at {copy} '
             f'({site_link(SCALAR_COPY_CALL)}), which copies the parent\'s eleven dwords <code>+ 0x18</code> to '
             f'<code>+ 0x40</code> over this record\'s. So each field holds {e(name)}\'s own declaration when that '
             'follows <code>INHERIT_TYPE</code>, and otherwise the parent\'s effective value at copy time. Values are '
             'the declarations as written, not physical quantities. The loader multiplies the two grip numbers by '
             'a global float when it stores them, so a copied grip value is the already-scaled one; that scale is '
             'not applied here.</p>'
             '<table><tr><th>Tag</th><th>Offsets</th><th>Effective declaration</th><th>Status</th><th>Source</th>'
             '<th>Path</th><th>Store sites</th><th>Copy sites</th></tr>']
    parts += [scalar_row(tag, field, copies) for tag, field in entry["fields"].items()]
    parts.append("</table>")
    if entry["overwritten"]:
        items = ", ".join(f'<code>{e(item["tag"])}</code> (line {e(item["line"])})' for item in entry["overwritten"])
        parts.append(f"<p>Declared before <code>INHERIT_TYPE</code> and overwritten by the copy: {items}.</p>")
    if entry["unmapped"]:
        items = ", ".join(f'<code>{e(item["tag"])}</code> (line {e(item["line"])})' for item in entry["unmapped"])
        parts.append(f'<div class="unresolved"><p><span class="label">unmapped</span>: no byte-checked store is known '
                     f"for {items}, so no effective value is given.</p></div>")
    return "".join(parts)


def render(tyres, sites, copies, pe, revision, hrefs, routines, entrance=False):
    """Return the dossier HTML. check_inputs() and check_routines() must have accepted the inputs first.

    copies is copy_sites(evidence): the scalar copy's load and store sites per payload offset.
    """
    records = tyres["records"]
    by_name = {record["type"]: record for record in records}
    provenance = tyres["table_provenance"]
    parts = [page_start("Ford Racing 3 demo tyre dossier", PAGE, entrance=entrance),
             '<h1>Ford Racing 3 demo: tyre dossier</h1><dl>',
             f'<dt>Executable</dt><dd><code>{e(pe.get("file", "fr3.exe"))}</code> SHA-256 <code>{e(pe["sha256"])}</code>, '
             f'PE timestamp {e(pe.get("timestamp_header_utc", "unknown"))}</dd>',
             f'<dt>Tyre database</dt><dd><code>{e(tyres["source"])}</code> SHA-256 <code>{e(tyres["sha256"])}</code></dd>',
             f'<dt>Producer revision</dt><dd><code>{e(revision)}</code> (<code>scripts/tyre_dossier.py</code>)</dd>',
             f'<dt>Records</dt><dd>{len(records)}</dd>',
             f'<dt>Loaded by</dt><dd>{routine_link(routines["tyre loader"])} (<code>0x{LOADER_VA:08x}</code>); '
             'on the routines page. Routine labels are analyst-assigned, not original symbols.</dd></dl>',
             '<p class="scope">Scope: this dossier covers the five tables the game reads through its '
             'INHERIT_TYPE-following accessors (longitudinal, lateral, vertical load, camber thrust and sound '
             'information) and, for each inheriting tyre, which declaration ends up in each scalar field with a '
             'byte-checked store. Scalar values are shown as declared: their units and physical meaning are not '
             'interpreted, and the grip scale global\'s runtime value is not applied. Engine inheritance and the '
             'colon-less <code>INDIGO</code> line in <code>ENGDATA.DAT</code> are unresolved. Two tyres that share a '
             'table source do not necessarily handle identically: their scalar fields can differ.</p>']
    counts = table_sources(tyres["resolved_tables"])
    parts.append('<h2>Table sources</h2><table><tr><th>Table</th><th>Accessor</th><th>Records per source</th></tr>')
    for table in RESOLVED_TYRE_TABLES:
        cited = provenance[records[0]["type"]][table]
        shown = ", ".join(f"{link(source, table)} {count}" for source, count in counts[table].items())
        parts.append(f'<tr><td>{e(TABLE_LABELS[table])}</td><td><code>{e(cited["accessor"])}</code> '
                     f'<code>+ {e(cited["record_offset"])}</code></td><td>{shown}</td></tr>')
    parts.append(f'</table><div class="unresolved" id="{SOUND_NOTE_ID}"><p><span class="label">unresolved</span>: '
                 "the sound information table's leading words, before its <code>START_RPM</code> values, are not "
                 "shown here, and what they hold is not established "
                 f"({question_link(SOUND_ANCHOR, 'open question')}).</p></div>")
    parts.append('<h2>Summary</h2><table><tr><th>Tyre</th>'
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
                     f'<h3>Declarations, as written</h3>{dossier_common.declarations(record, "tyre", row_ids=True)}'
                     '<h3>Table sources</h3>'
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
            parts.append(why_trail(name, table, entry, found, by_name, hrefs, pe["sha256"], routines))
        if name in tyres["effective_scalars"]:
            parts.append(scalar_section(name, tyres["effective_scalars"][name], copies, routines))
        parts.append("</section>")
    parts.append("</body></html>\n")
    return "\n".join(parts)


def build(tyres_path, evidence_path, pe_path, output, revision=None, hrefs=None, entrance=False,
          status_path=ROUTINE_STATUS):
    """Read the inputs, check them and write the dossier; return the number of records.

    status_path is the status.json whose labels the routines page beside `output` uses. hrefs maps "accessors", "loader" and "evidence" to the links the page uses for its evidence files; by
    default they are relative links from `output` to the files in this repository. entrance=True adds the
    entrance page to the nav bar, for scripts/build_research.py.
    """
    tyres = load_json(tyres_path, "Tyre database (run scripts/text_database.py first)")
    evidence = load_json(evidence_path, "Field evidence")
    pe = load_json(pe_path, "PE metadata")
    check_pe(pe)
    sites = check_inputs(tyres, evidence)
    routines = check_routines(routine_labels(status_path), sites, evidence)
    hrefs = hrefs or {"accessors": relative_href(ACCESSORS_ASM, output), "loader": relative_href(LOADER_ASM, output),
                      "evidence": relative_href(Path(evidence_path).resolve(), output)}
    page = render(tyres, sites, copy_sites(evidence), pe, revision or producer_revision(), hrefs, routines, entrance)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text(page, encoding="utf-8")
    return len(tyres["records"])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tyres", type=Path, default=REPO_ROOT / "artifacts/text-databases/tyres.json",
                        help="tyres.json written by scripts/text_database.py (default: %(default)s)")
    parser.add_argument("--evidence", type=Path, default=FIELD_EVIDENCE,
                        help="Byte-checked instruction sites (default: %(default)s)")
    parser.add_argument("--pe", type=Path, default=REPO_ROOT / "analysis/pe-metadata.json",
                        help="fr3.exe identity (default: %(default)s)")
    parser.add_argument("--status", type=Path, default=ROUTINE_STATUS,
                        help="Routine labels the page links to on routines.html (default: %(default)s)")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "artifacts/dossier/tyres.html",
                        help="HTML file to write; keep it out of Git, it holds game data (default: %(default)s)")
    args = parser.parse_args()
    try:
        count = build(args.tyres, args.evidence, args.pe, args.output, status_path=args.status)
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        raise SystemExit(f"tyre_dossier.py: {error}") from None
    print(f"Wrote {count} tyre records to {args.output}")


if __name__ == "__main__":
    main()
