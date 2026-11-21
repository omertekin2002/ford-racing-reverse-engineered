"""Generate offline HTML dossiers of the engine and gearbox records.

Inputs, all produced elsewhere and only read here:
  * engines.json and gearboxes.json from scripts/text_database.py: `records`,
    plus the ENGDATA.DAT or GEARDATA.DAT path and SHA-256, and, for engines,
    `effective_fields` and `untagged_inherit_consequences`.
  * analysis/selected/field-evidence.json: the byte-checked sites the engine and
    gearbox pages link to on the routines page.
  * analysis/pe-metadata.json: the executable's identity.
  * analysis/annotated/status.json: the analyst labels of the load and copy
    routines the pages link to on the sibling routines page.

The output is two static HTML files, engines.html and gearboxes.html, with
inline CSS, no JavaScript and no external resources. For each record they show
the declarations exactly as written, in line order: scalar values, multi-row
fields such as TORQUE_ARRAY as row tables with their dimensions, :INHERIT_TYPE
as a link to the parent, and every untagged line verbatim labelled unresolved;
INDIGO's colon-less line links to its section on the Open questions page
(scripts/open_questions.py).

Each inheriting engine also gets an effective-fields table: for every tag in
ENGINE_FIELD_STORES, its status (declared, inherited or zero-filled), the
declared values, the source record and line (linked to that line's row), the
INHERIT_TYPE path and the byte-checked store sites. A TORQUE_ARRAY row, whose
id the entrance page's torque-table answer links, names the MAX_RPM
declaration its row count was read from; the derived +0x2c and
+0xa4 are labelled derived (+0x2c also conditional) with their possible
origins and no value. A root with a colon-less INHERIT_TYPE line (INDIGO) lists
the fields that depend on it under both readings, labelled unresolved. Units
and physics are not interpreted.

The gearbox page has a "Where each field is stored" table: for each tag in
GEARBOX_FIELD_STORES, its payload offset, width and Fr3GearboxRecord field, how
it is read (float, enum word table, or float stored as an integer's low byte)
and its compare (with the selecting jg after a range compare) and store sites.
Each row has the id gearbox-store-<TAG>, and each declaration row on both pages
the id <engine|gearbox>-<record>-line-<n>; the Compare records page
(scripts/record_compare.py) links both.
Gearbox inheritance is not resolved: no demo gearbox declares :INHERIT_TYPE,
and a gearbox's :INHERIT_TYPE is labelled unresolved.

A "Loaded by" line near the top of each page links its database's load and
copy routines to their sections on the routines page (scripts/routine_index.py),
and each inheriting record's section links the copy routine. The routines are
looked up in status.json by the entry VAs in DATABASES and must carry the
labels given there.

The script refuses to write either page, and exits non-zero, when an input is
missing or malformed: `records` that are not a list, a record without `type`,
`line` or `fields`, duplicate record names, an :INHERIT_TYPE that does not name
an earlier record of the same file, `effective_fields` or
`untagged_inherit_consequences` that differ from what text_database.py derives
from the records, a linked site missing from field-evidence.json, PE metadata
without `sha256`, or a load or copy routine that is missing from status.json or
labelled differently there.
"""
import argparse
from pathlib import Path

from dossier_common import (INDIGO_ANCHOR, ROUTINE_STATUS, STYLE, anchor, check_fields, check_pe, declarations, e,
                            is_indigo_line, line_anchor, link, load_json, page_start, producer_revision, question_link,
                            routine_label, routine_labels, routine_link, site_link)
from text_database import (ENGINE_COPY, ENGINE_FIELD_STORES, FLOAT_READER, ENUM_READER, GEARBOX_COPY,
                           GEARBOX_FIELD_STORES, GEARBOX_FLOAT_TO_BYTE_CALL, REPO_ROOT, ZERO_FILLED,
                           check_effective_engine_fields, effective_engine_fields, require,
                           untagged_inherit_consequences)

TORQUE = "TORQUE_ARRAY"
# Per database: the default input, the output page, the anchor prefix, the wording, and the entry VA and status.json
# label of its load and copy routines, which the page links to on the routines page.
DATABASES = {
    "engines": {"input": REPO_ROOT / "artifacts/text-databases/engines.json", "page": "engines.html",
                "prefix": "engine", "title": "engine", "file": "ENGDATA.DAT",
                "load": (0x005227f0, "fr3_load_engine_database"), "copy": (0x00522c80, "fr3_copy_engine_record")},
    "gearboxes": {"input": REPO_ROOT / "artifacts/text-databases/gearboxes.json", "page": "gearboxes.html",
                  "prefix": "gearbox", "title": "gearbox", "file": "GEARDATA.DAT",
                  "load": (0x00523220, "fr3_load_gearbox_database"), "copy": (0x00523470, "fr3_copy_gearbox_record")},
}
EVIDENCE = REPO_ROOT / "analysis/selected/field-evidence.json"
EXTRA_STYLE = "section.record { border-top: 2px solid #888; margin-top: 2em; }\n"
INHERIT_NOTE = (' <span class="label">unresolved</span>: how the game applies this parent is not established; '
                "none of its values are copied here")
ENGINE_INHERIT_NOTE = "; the loader copies its effective fields over this record's here (see Effective fields)"
ENGINE_SCOPE = ('Scope: values are shown exactly as declared in <code>ENGDATA.DAT</code>. Each inheriting engine\'s '
                "effective fields replay the loader: a record starts zero-filled, its own declarations are stored as "
                "they are read, and its <code>:INHERIT_TYPE</code> line copies the parent's effective fields, the "
                "torque table included, over everything declared before it. A shared parent does not make two "
                "engines behave identically: each one's own declarations replace the parent's. The meaning, units "
                "and physics of the values, including the torque arrays, are not established, and nothing is "
                "computed, including the derived <code>+ 0x2c</code> and <code>+ 0xa4</code>. Untagged lines, such "
                "as the colon-less <code>INHERIT_TYPE DEFAULT_TRACK</code> in the demo's <code>INDIGO</code> engine, "
                "are kept verbatim and not applied; whether the game honours them is not established.")
GEARBOX_SCOPE = ('Scope: values are shown exactly as declared in <code>GEARDATA.DAT</code>. Gearbox inheritance '
                 "(<code>:INHERIT_TYPE</code>) is unresolved: no parent value is copied into a child here. The meaning "
                 "and units of the values are not established. Untagged lines are kept verbatim and not applied; "
                 "whether the game honours them is not established.")
STATUS_TEXT = {"declared": "declared", "inherited": "inherited", ZERO_FILLED: "zero-filled"}
UNTAGGED_NOTE = (' kept verbatim, not applied <div class="unresolved"><span class="label">unresolved</span>: '
                 "this line has no colon, so the parser does not apply it; whether the game honours it is not "
                 "established{}</div>")


def untagged_note(record, item):
    """The unresolved note after an untagged line; INDIGO's colon-less line links to its open question."""
    if is_indigo_line(record, item):
        return UNTAGGED_NOTE.format(" (" + question_link(INDIGO_ANCHOR, "open question") + ")")
    return UNTAGGED_NOTE.format("")


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


def check_engine_fields(database):
    """Check engines.json's effective fields and colon-less line consequences against its records."""
    check_fields(database, {"effective_fields": dict, "untagged_inherit_consequences": dict}, "engines.json")
    records = database["records"]
    require(database["effective_fields"] == effective_engine_fields(records),
            "engines.json effective_fields disagrees with the record declarations (rerun scripts/text_database.py)")
    check_effective_engine_fields(records, database["effective_fields"])
    require(database["untagged_inherit_consequences"] == untagged_inherit_consequences(records),
            "engines.json untagged_inherit_consequences disagrees with the record declarations "
            "(rerun scripts/text_database.py)")


def engine_site_vas():
    """Every byte-checked site the engine page links: the stores, their conditions, the copy call and torque reads."""
    torque = ENGINE_FIELD_STORES["TORQUE_ARRAY"]
    vas = {int(va, 16) for entry in ENGINE_FIELD_STORES.values() for store in entry["offsets"].values()
           for va in store["sites"] + store.get("conditional", [])}
    return vas | {int(va, 16) for va in (ENGINE_COPY["call"], torque["row_count"]["site"], torque["zero_fill"]["call"])}


def gearbox_site_vas():
    """Every byte-checked site the gearbox page links: each tag's compare, selecting jg, reader call, enum table or
    float-to-integer call and store, and the INHERIT_TYPE copy call."""
    vas = {GEARBOX_COPY["call"]}
    for entry in GEARBOX_FIELD_STORES.values():
        vas |= {entry["compare"], entry["read"]["call"], *(store_va for store in entry["offsets"].values()
                                                           for store_va in store["sites"])}
        vas |= {va for va in (entry.get("after_range"), entry.get("enum_table", {}).get("site"),
                              entry["read"].get("convert"), entry["read"].get("fistp")) if va}
    return {int(va, 16) for va in vas}


def check_sites(evidence):
    """Refuse a linked engine or gearbox site that field-evidence.json, which the routines page anchors, lacks."""
    require(isinstance(evidence, list) and all(isinstance(site, dict) and isinstance(site.get("va"), int)
                                               for site in evidence), "field-evidence.json must be a list of sites")
    missing = sorted((engine_site_vas() | gearbox_site_vas()) - {site["va"] for site in evidence})
    require(not missing, "These linked sites are not in field-evidence.json: "
                         + ", ".join(f"0x{va:08x}" for va in missing))


def check_routines(labels):
    """Check each database's load and copy routines against status.json; return {kind: {"load", "copy": label}}."""
    return {kind: {role: routine_label(labels, spec[role][0], f'{spec["title"]} {role} routine', spec[role][1])
                   for role in ("load", "copy")}
            for kind, spec in DATABASES.items()}


def routine_ref(spec, routines, role):
    return f"{routine_link(routines[role])} (<code>0x{spec[role][0]:08x}</code>)"


def shape(field):
    return f'{len(field["rows"])} &times; {len(field["rows"][0])}' if field["rows"] else "inline"


def source_link(name, line):
    return f'<a href="#{e(line_anchor("engine", name, line))}">{e(name)} line {e(line)}</a>'


def path_html(path):
    return " &rarr; ".join(link("engine", hop) for hop in path)


def sites_html(vas):
    return ", ".join(site_link(int(va, 16)) for va in vas)


def origin_html(origin):
    """One origin: a source line link with its status and path, or the zero fill."""
    if origin["status"] == ZERO_FILLED:
        return f'<span class="label">zero-filled</span> (path {path_html(origin["path"])})'
    return f'{source_link(origin["source"], origin["source_line"])} ({e(origin["status"])}; path {path_html(origin["path"])})'


def value_html(field):
    if field["status"] == ZERO_FILLED:
        return '<span class="label">zero-filled</span>, no value'
    if field.get("rows"):
        return f'{len(field["rows"])} rows &times; {len(field["rows"][0])} columns'
    return f'<span class="num">{e(" ".join(map(str, field["values"])))}</span>'


def field_rows(name, tag, field):
    """The table rows for engine `name`'s mapped tag: its stored offsets, then each derived offset.

    The TORQUE_ARRAY row has the id anchor("engine", name, "torque-array"), which the entrance page links.
    """
    stores = ENGINE_FIELD_STORES[tag]["offsets"]
    stored = [offset for offset in field["offsets"] if not stores[offset].get("derived")]
    source = ("none along the path" if field["status"] == ZERO_FILLED
              else source_link(field["source"], field["source_line"]))
    value = value_html(field)
    if "max_rpm" in field:
        torque = ENGINE_FIELD_STORES["TORQUE_ARRAY"]
        value += (f'<br>row count read from <code>+ {e(torque["row_count"]["offset"])}</code> '
                  f'({site_link(int(torque["row_count"]["site"], 16))}) when parsed: <code>MAX_RPM</code> from '
                  f'{origin_html(field["max_rpm"])}')
    row_id = f' id="{e(anchor("engine", name, "torque-array"))}"' if tag == TORQUE else ""
    rows = [f'<tr{row_id}><td><code>{e(tag)}</code></td><td>{", ".join(f"<code>+ {e(offset)}</code>" for offset in stored)}</td>'
            f'<td>{value}</td><td>{e(STATUS_TEXT[field["status"]])}</td><td>{source}</td>'
            f'<td>{path_html(field["path"])}</td>'
            f'<td>{sites_html(va for offset in stored for va in stores[offset]["sites"])}</td></tr>']
    for offset, derived in field.get("derived", {}).items():
        labels = '<span class="label">derived</span>'
        if derived["conditional"]:
            labels += (', <span class="label">conditional</span>: stored only past the jumps at '
                       + sites_html(stores[offset]["conditional"]) + ", so it may instead keep what it held before")
        origins = "".join(f"<li>{origin_html(origin)}</li>" for origin in derived["origins"])
        rows.append(f'<tr><td><code>+ {e(offset)}</code> from <code>{e(tag)}</code></td><td><code>+ {e(offset)}</code>'
                    f'</td><td>{labels}; not computed</td><td>derived</td><td>possible origins:<ol>{origins}</ol></td>'
                    f'<td></td><td>{sites_html(stores[offset]["sites"])}</td></tr>')
    return "".join(rows)


FIELD_HEADER = ("<table><tr><th>Tag</th><th>Offsets</th><th>Effective declaration</th><th>Status</th><th>Source</th>"
                "<th>Path</th><th>Store sites</th></tr>")


def effective_section(name, entry, routines):
    inherit = entry["inherit_type"]
    torque = ENGINE_FIELD_STORES["TORQUE_ARRAY"]
    parts = [f'<h3>Effective fields</h3><p><code>:INHERIT_TYPE</code> {link("engine", inherit["parent"])} is on line '
             f'{e(inherit["line"])}. When the loader parses it, it calls the record copy {routine_link(routines["copy"])} '
             f'({site_link(int(ENGINE_COPY["call"], 16))}), which copies the parent\'s effective fields, the 18 torque '
             'slots included, over this record\'s, all but the name and <code>+ 0x18</code>. So each field '
             f'holds {e(name)}\'s own declaration when that follows <code>INHERIT_TYPE</code>, and otherwise the '
             'parent\'s effective value at copy time. An own <code>TORQUE_ARRAY</code> first zero-fills all 18 slots '
             f'({site_link(int(torque["zero_fill"]["call"], 16))}), so it replaces the parent\'s table and never mixes '
             'rows with it. Values are the declarations as written, not physical quantities.</p>', FIELD_HEADER]
    parts += [field_rows(name, tag, field) for tag, field in entry["fields"].items()]
    parts.append("</table>")
    if entry["overwritten"]:
        items = ", ".join(f'<code>{e(item["tag"])}</code> (line {e(item["line"])})' for item in entry["overwritten"])
        parts.append(f"<p>Declared before <code>INHERIT_TYPE</code> and overwritten by the copy: {items}.</p>")
    if entry["unmapped"]:
        items = ", ".join(f'<code>{e(item["tag"])}</code> (line {e(item["line"])})' for item in entry["unmapped"])
        parts.append(f'<div class="unresolved"><p><span class="label">unmapped</span>: no byte-checked store is known '
                     f"for {items}, so no effective value is given.</p></div>")
    return "".join(parts)


def read_html(entry):
    """How a gearbox tag's value is read, with its reader call and table or conversion sites."""
    read = entry["read"]
    call = site_link(int(read["call"], 16))
    if read["kind"] == "enum":
        table = entry["enum_table"]
        return (f'enum word, from the reader at <code>0x{ENUM_READER:08x}</code> ({call}) given the word table at '
                f'<code>{e(table["va"])}</code> ({site_link(int(table["site"], 16))})')
    text = f'float, from the reader at <code>0x{FLOAT_READER:08x}</code> ({call})'
    if read["kind"] == "float_to_byte":
        text += (f', passed to <code>0x{GEARBOX_FLOAT_TO_BYTE_CALL:08x}</code> ({site_link(int(read["convert"], 16))}), '
                 f'converted to an integer with <code>fistp</code> ({site_link(int(read["fistp"], 16))}) and stored '
                 "as its low byte")
    return text


def gearbox_tags():
    """The tags in GEARBOX_FIELD_STORES, in payload offset order (+0x14 to +0x31)."""
    return sorted(GEARBOX_FIELD_STORES, key=lambda tag: int(next(iter(GEARBOX_FIELD_STORES[tag]["offsets"])), 16))


def store_anchor(tag):
    """The id of gearbox tag `tag`'s row in the gearbox page's "Where each field is stored" table."""
    return anchor("gearbox", "store", tag)


def gearbox_store_section(routines):
    """The nine-row table of where the gearbox loader stores each tag, linked to its byte-checked sites.

    Each row has the id store_anchor(tag), which the Compare records page (scripts/record_compare.py) links.
    """
    rows = []
    for tag in gearbox_tags():
        entry = GEARBOX_FIELD_STORES[tag]
        (offset, store), = entry["offsets"].items()
        compare = site_link(int(entry["compare"], 16))
        if "after_range" in entry:
            compare += f', then <code>jg</code> {site_link(int(entry["after_range"], 16))}'
        rows.append(f'<tr id="{e(store_anchor(tag))}"><td><code>{e(tag)}</code></td><td><code>+ {e(offset)}</code></td>'
                    f'<td>{e(store["width"])}</td>'
                    f'<td><code>{e(store["field"])}</code></td><td>{read_html(entry)}</td>'
                    f'<td><code>cmp eax, 0x{entry["id"]:x}</code> {compare}</td><td>{sites_html(store["sites"])}</td></tr>')
    return ('<h2 id="field-stores">Where each field is stored</h2>'
            f'<p>The loader {routine_link(routines["load"])} stores each tag into the <code>0x34</code>-byte record as '
            'it parses it. Each row gives the payload offset, its width and its <code>Fr3GearboxRecord</code> field '
            '(an analyst label), how the value is read, the tag-ID compare that selects the handler and the store, '
            'each linked to its byte-checked site on the routines page. Where the compare is a range compare, the '
            "handler is selected by the <code>jg</code> after its <code>jge</code> not jumping. "
            f'<code>:INHERIT_TYPE</code> calls the record copy {routine_link(routines["copy"])} '
            f'({site_link(int(GEARBOX_COPY["call"], 16))}), which copies all nine fields from the parent, not the '
            'name or the padding, and stores no parent address. No demo gearbox declares <code>:INHERIT_TYPE</code>, '
            'so this page resolves none.</p>'
            '<table><tr><th>Tag</th><th>Offset</th><th>Width</th><th>Field</th><th>Read as</th><th>Compare</th>'
            f'<th>Store</th></tr>{"".join(rows)}</table>')


def consequence_section(record, consequence):
    """What depends on a root's colon-less INHERIT_TYPE line, under both readings, without choosing one."""
    item = {"line": consequence["line"], "tokens": consequence["tokens"]}
    question = (" (" + question_link(INDIGO_ANCHOR, "open question") + ")") if is_indigo_line(record, item) else ""
    rows = "".join(f'<tr><td><code>{e(tag)}</code></td><td><span class="label">zero-filled</span></td>'
                   f'<td>{value_html(field["if_applied"])}, '
                   + ("" if field["if_applied"]["status"] == ZERO_FILLED
                      else f'{source_link(field["if_applied"]["source"], field["if_applied"]["source_line"])}, ')
                   + f'path {path_html(field["if_applied"]["path"])}</td></tr>'
                   for tag, field in consequence["fields"].items())
    overwritten = ", ".join(f'<code>{e(entry["tag"])}</code> (line {e(entry["line"])})'
                            for entry in consequence["overwritten_if_applied"])
    note = (f"<p>Applying it would also overwrite these earlier declarations: {overwritten}.</p>" if overwritten else "")
    return (f'<div class="unresolved"><p><span class="label">unresolved</span>: {e(record["type"])} is a root as parsed, '
            f'because line {e(consequence["line"])}, <code>{e(" ".join(consequence["tokens"]))}</code>, has no colon'
            f'{question}. The {len(consequence["fields"])} mapped tags it does not declare depend on that line: '
            f'zero-filled if the game ignores it, or {link("engine", consequence["parent"])}\'s effective value if '
            "the game applies it as inheritance. Neither reading is chosen here.</p>"
            f"<table><tr><th>Tag</th><th>If the line is ignored</th><th>If it is applied</th></tr>{rows}</table>"
            f"{note}</div>")


def render(database, kind, pe, revision, routines, entrance=False):
    """Return one dossier page. check_records() and check_routines() must have accepted the inputs first.

    routines maps "load" and "copy" to the labels of this database's routines.
    """
    spec = DATABASES[kind]
    prefix, title = spec["prefix"], spec["title"]
    records = database["records"]
    engines = kind == "engines"
    inherits = engines or any("INHERIT_TYPE" in record["fields"] for record in records)
    torque = engines
    parts = [page_start(f"Ford Racing 3 demo {title} dossier", spec["page"], STYLE + EXTRA_STYLE, entrance),
             f'<h1>Ford Racing 3 demo: {title} dossier</h1><dl>',
             f'<dt>Executable</dt><dd><code>{e(pe.get("file", "fr3.exe"))}</code> SHA-256 <code>{e(pe["sha256"])}</code>, '
             f'PE timestamp {e(pe.get("timestamp_header_utc", "unknown"))}</dd>',
             f'<dt>{title.capitalize()} database</dt><dd><code>{e(database["source"])}</code> '
             f'SHA-256 <code>{e(database["sha256"])}</code></dd>',
             f'<dt>Producer revision</dt><dd><code>{e(revision)}</code> (<code>scripts/record_dossier.py</code>)</dd>',
             f'<dt>Records</dt><dd>{len(records)}</dd>',
             f'<dt>Loaded by</dt><dd>{routine_ref(spec, routines, "load")}; record copy '
             f'{routine_ref(spec, routines, "copy")}; on the routines page. Routine labels are analyst-assigned, not '
             'original symbols.</dd></dl>',
             f'<p class="scope">{ENGINE_SCOPE if engines else GEARBOX_SCOPE}</p>']
    if not engines:
        parts.append(gearbox_store_section(routines))
    parts.append('<h2>Summary</h2><table><tr><th>Record</th><th>Line</th>'
                 + (f"<th>Parent{'' if engines else ' (unresolved)'}</th>" if inherits else "")
                 + (f"<th>{TORQUE} rows &times; columns</th>" if torque else "") + "</tr>")
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
        if engines and name in database["effective_fields"]:
            parts.append(effective_section(name, database["effective_fields"][name], routines))
        elif inherit:
            parts.append(f'<div class="unresolved"><p><span class="label">unresolved</span>: <code>:INHERIT_TYPE</code> '
                         f'{link(prefix, inherit["values"][0])} on line {e(inherit["line"])}. Which of the parent\'s '
                         'values this record ends up with is not established, so only its own declarations are '
                         f'shown. This database\'s record copy routine is {routine_link(routines["copy"])}.</p></div>')
        if engines and name in database["untagged_inherit_consequences"]:
            parts.append(consequence_section(record, database["untagged_inherit_consequences"][name]))
        note = ENGINE_INHERIT_NOTE if engines else INHERIT_NOTE
        parts.append(f"<h3>Declarations, as written</h3>"
                     f"{declarations(record, prefix, note, untagged_note, row_ids=True)}</section>")
    parts.append("</body></html>\n")
    return "\n".join(parts)


def build(engines_path, gearboxes_path, pe_path, output_dir, revision=None, entrance=False,
          status_path=ROUTINE_STATUS, evidence_path=EVIDENCE):
    """Read and check every input, then write both pages; return the record count per database.

    status_path is the status.json whose labels the routines page beside the pages uses, and evidence_path the
    field-evidence.json whose sites it anchors. entrance=True adds the entrance page to the nav bar, for
    scripts/build_research.py.
    """
    databases = {"engines": load_json(engines_path, "Engine database (run scripts/text_database.py first)"),
                 "gearboxes": load_json(gearboxes_path, "Gearbox database (run scripts/text_database.py first)")}
    pe = load_json(pe_path, "PE metadata")
    check_pe(pe)
    for kind, database in databases.items():
        check_records(database, f"{kind}.json")
    check_engine_fields(databases["engines"])
    check_sites(load_json(evidence_path, "Field evidence (analysis/selected/field-evidence.json)"))
    routines = check_routines(routine_labels(status_path))
    revision = revision or producer_revision()
    pages = {kind: render(database, kind, pe, revision, routines[kind], entrance)
             for kind, database in databases.items()}
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
    parser.add_argument("--evidence", type=Path, default=EVIDENCE,
                        help="Byte-checked sites the engine page links to on routines.html (default: %(default)s)")
    parser.add_argument("--status", type=Path, default=ROUTINE_STATUS,
                        help="Routine labels the pages link to on routines.html (default: %(default)s)")
    parser.add_argument("--output-dir", type=Path, default=REPO_ROOT / "artifacts/dossier",
                        help="Directory for engines.html and gearboxes.html, next to tyres.html; keep it out of Git, "
                             "the pages hold game data (default: %(default)s)")
    args = parser.parse_args()
    try:
        counts = build(args.engines, args.gearboxes, args.pe, args.output_dir, status_path=args.status,
                       evidence_path=args.evidence)
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        raise SystemExit(f"record_dossier.py: {error}") from None
    print(f"Wrote {counts['engines']} engine and {counts['gearboxes']} gearbox records to {args.output_dir}")


if __name__ == "__main__":
    main()
