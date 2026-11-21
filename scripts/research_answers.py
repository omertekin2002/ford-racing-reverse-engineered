"""Answer readers' questions on the "Explore findings" entrance page from the data the research build checked.

scripts/build_research.py calls tyre_tables_section() with the tyres.json it parsed, after scripts/tyre_dossier.py
has accepted it, and puts the result on index.html. The section answers "Do road, offroad and track tyres use
different tables?" with nothing written by hand:
  * per table, how many tyres resolve it to each source record (`resolved_tables`);
  * the source records' names, which are record names in TYREDATA.DAT, not a classification the game is shown
    to use;
  * one traced example, chosen from the data by worked_example(): its INHERIT_TYPE path to the declaring record
    and line, the accessor routine and the byte-checked accessor and loader sites, each linked to its anchor on
    tyres.html or routines.html;
  * where the comparison ends, also chosen from the data by same_tables_pair(): two tyres that read all five
    tables from the same records but whose `effective_scalars` hold different declarations.

It also calls engine_torque_section() with the engines.json scripts/record_dossier.py has accepted. That section
answers "Which engines share a torque table, and what do they declare differently?" from `effective_fields`, again
with nothing written by hand:
  * how many inheriting engines declare their own TORQUE_ARRAY and how many inherit one, and how many tables are
    read by more than one engine, and by how many engines;
  * one row per shared table, by its declaring record and line in file order, listing the engines that read it, how
    each reaches it and the other mapped declarations each holds in effect, linked to their lines on engines.html;
  * one traced example, chosen by torque_example(): the first engine in file order that inherits its TORQUE_ARRAY,
    with its INHERIT_TYPE path, the MAX_RPM the table's row count was read from, the record copy and the torque
    zero fill, each linked to its anchor on engines.html or routines.html;
  * where the comparison ends: each sharing engine's own TORQUE_MODIFIER, stored at + 0x24, which is not combined
    with the table, and the derived + 0x2c, which gets no value.
INDIGO, wherever it is named, links to its section on the Open questions page.

Every link points at an anchor the tyre, engine or routines page writes, so verify_research() refuses the build when
one goes missing. When the data has no example, no pair or no shared torque table, the section refuses to render
rather than state an empty claim. Nothing here interprets units, physics or handling.
"""
import dossier_common
from dossier_common import (INDIGO_ANCHOR, INDIGO_RECORD, e, line_anchor, question_link, routine_label, routine_link,
                            site_link)
import record_dossier
from text_database import (ENGINE_COPY, ENGINE_FIELD_STORES, RESOLVED_TYRE_TABLES, TYRE_SCALAR_STORES, ZERO_FILLED,
                           require, table_sources)
import tyre_dossier

SECTION_ID = "tyre-tables"
QUESTION = "Do road, offroad and track tyres use different tables?"


def tyre_link(name, part=None, text=None):
    """Return a link to a tyre's section, or one of its rows, on the tyre page."""
    return (f'<a href="{e(tyre_dossier.PAGE)}#{e(dossier_common.anchor("tyre", name, part))}">'
            f'{e(name if text is None else text)}</a>')


def line_link(name, line):
    """Return a link to the declarations row for line `line` of tyre `name` on the tyre page."""
    return tyre_link(name, f"line-{line}", f"line {line}")


def declares_a_table(provenance, name):
    return any(len(entry["path"]) == 1 for entry in provenance[name].values())


def worked_example(tyres):
    """Return (tyre, table) for the traced example.

    The tyre is the first, in file order, that declares none of the five tables itself and reads them from more
    than one record; the table is the first of its tables whose source differs from its longitudinal table's.
    """
    provenance = tyres["table_provenance"]
    for record in tyres["records"]:
        name = record["type"]
        tables = provenance[name]
        if declares_a_table(provenance, name):
            continue
        first = tables[RESOLVED_TYRE_TABLES[0]]["source"]
        for table in RESOLVED_TYRE_TABLES:
            if tables[table]["source"] != first:
                return name, table
    raise ValueError("No tyre in tyres.json inherits all five tables and reads them from more than one record, so "
                     f"the entrance page's #{SECTION_ID} answer has no worked example to trace")


def effective(field):
    """What a scalar field ends up holding, as compared between tyres: its declared values, or zero-filled."""
    return None if field["status"] == ZERO_FILLED else field["values"]


def same_tables_pair(tyres):
    """Return (first, second, tags): two inheriting tyres with identical table sources but different scalar fields.

    The pair is the first, in file order of the second tyre and then of the first, among tyres that have
    `effective_scalars`; tags lists the scalar fields whose effective declarations differ, in field order.
    """
    resolved, scalars = tyres["resolved_tables"], tyres["effective_scalars"]
    names = [record["type"] for record in tyres["records"] if record["type"] in scalars]
    for j, second in enumerate(names):
        for first in names[:j]:
            if resolved[first] != resolved[second]:
                continue
            fields_a, fields_b = scalars[first]["fields"], scalars[second]["fields"]
            tags = [tag for tag in fields_a if tag in fields_b and effective(fields_a[tag]) != effective(fields_b[tag])]
            if tags:
                return first, second, tags
    raise ValueError("No two tyres in tyres.json share all five table sources yet differ in an effective scalar "
                     f"field, so the entrance page's #{SECTION_ID} answer cannot show where the comparison ends")


def names_list(names):
    names = list(names)
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def counts_table(tyres, counts, sources, labels):
    """Return the table of how many tyres resolve each table to each source record."""
    cited = tyres["table_provenance"][tyres["records"][0]["type"]]
    head = "".join(f"<th>{tyre_link(source)}</th>" for source in sources)
    rows = []
    for table in RESOLVED_TYRE_TABLES:
        accessor = cited[table]["accessor"]
        label = routine_label(labels, int(accessor, 16), f"{table} accessor {accessor}")
        cells = "".join(f'<td class="num">{counts[table].get(source, 0)}</td>' for source in sources)
        rows.append(f"<tr><td>{e(tyre_dossier.TABLE_LABELS[table])}</td><td>{routine_link(label, accessor)} "
                    f'<code>+ {e(cited[table]["record_offset"])}</code></td>{cells}</tr>')
    return (f'<table><tr><th rowspan="2">Table</th><th rowspan="2">Accessor and record offset</th>'
            f'<th colspan="{len(sources)}">Tyres reading it from each source record</th></tr><tr>{head}</tr>'
            + "".join(rows) + "</table>")


def summary(tyres, counts):
    """Return the lead paragraph: which tables every tyre reads from one record, and which come from several."""
    total = len(tyres["records"])
    single = [table for table in RESOLVED_TYRE_TABLES if len(counts[table]) == 1]
    several = [table for table in RESOLVED_TYRE_TABLES if len(counts[table]) > 1]
    parts = []
    if single:
        sources = sorted({next(iter(counts[table])) for table in single})
        parts.append(f"For the {names_list(e(tyre_dossier.TABLE_LABELS[table].lower()) for table in single)} "
                     f"{'table' if len(single) == 1 else 'tables'}, all {total} tyres read the table declared by "
                     f"{names_list(tyre_link(source) for source in sources)}.")
    groups = {}
    for table in several:
        groups.setdefault(tuple(counts[table].items()), []).append(table)
    for shares, tables in groups.items():
        split = names_list(f"{count} from {tyre_link(source)}" for source, count in shares)
        parts.append(f"For the {names_list(e(tyre_dossier.TABLE_LABELS[table].lower()) for table in tables)} "
                     f"{'table' if len(tables) == 1 else 'tables'}, the {total} tyres split across {len(shares)} "
                     f"records: {split}.")
    return f"<p>{' '.join(parts)}</p>"


def example_trace(tyres, name, table, evidence, labels, hrefs):
    """Return the worked example: the INHERIT_TYPE path, the declaring line, the accessor and its byte-checked sites."""
    by_name = {record["type"]: record for record in tyres["records"]}
    entry = tyres["table_provenance"][name][table]
    label = tyre_dossier.TABLE_LABELS[table].lower()
    steps = []
    for hop in entry["path"][:-1]:
        inherit = by_name[hop]["fields"]["INHERIT_TYPE"]
        steps.append(f"<li>{tyre_link(hop)} declares no {e(label)} table of its own; its <code>:INHERIT_TYPE</code> "
                     f"on {line_link(hop, inherit['line'])} names {tyre_link(inherit['values'][0])}.</li>")
    steps.append(f"<li>{tyre_link(entry['source'])} declares the {e(label)} table on "
                 f"{line_link(entry['source'], entry['source_line'])} of <code>{e(tyres['source'])}</code>.</li>")
    accessor = entry["accessor"]
    routine = routine_label(labels, int(accessor, 16), f"{table} accessor {accessor}")
    steps.append(f"<li>The game reads it through the accessor {routine_link(routine, accessor)}: it returns the "
                 f"table address at record <code>+ {e(entry['record_offset'])}</code> when that is non-zero, and "
                 "otherwise repeats the test on the record at <code>+ 0x14</code>, which points at the "
                 "inherited record.</li>")
    sites = tyre_dossier.table_evidence(evidence, table, accessor, entry["record_offset"])
    found = "; ".join(f"{role} {', '.join(site_link(site['va']) for site in sites[role])}"
                      for role in ("accessor", "loader") if sites[role])
    steps.append(f'<li>Byte-checked sites ({found}) are listed with their bytes in '
                 f'<a href="{e(hrefs["evidence"])}"><code>{e(hrefs["evidence"].rsplit("/", 1)[-1])}</code></a>.</li>')
    return (f"<h3>Traced example: {e(name)}</h3><p>Chosen from the data: the first tyre in file order that declares "
            "none of the five tables itself and reads them from more than one record, traced for the first of its "
            f"tables whose source differs from its longitudinal table's. {tyre_link(name)} reads its {e(label)} "
            f"table from {tyre_link(entry['source'])} ({tyre_link(name, table, 'its table-source row')}, with the "
            f"full trail under Why?).</p><ol>{''.join(steps)}</ol>")


def scalar_cell(field):
    if field["status"] == ZERO_FILLED:
        return f'<span class="label">{e(ZERO_FILLED)}</span>'
    return (f'<span class="num">{e(" ".join(map(str, field["values"])))}</span> ({e(field["status"])}, '
            f'{tyre_link(field["source"])} {line_link(field["source"], field["source_line"])})')


def pair_section(tyres, first, second, tags):
    """Return where the comparison ends: two tyres with the same five table sources and different scalar fields."""
    sources = tyres["resolved_tables"][first]
    shared = names_list(tyre_link(source) for source in dict.fromkeys(sources.values()))
    fields_a, fields_b = tyres["effective_scalars"][first]["fields"], tyres["effective_scalars"][second]["fields"]
    rows = "".join(f"<tr><td><code>{e(tag)}</code></td><td>{scalar_cell(fields_a[tag])}</td>"
                   f"<td>{scalar_cell(fields_b[tag])}</td></tr>" for tag in tags)
    scaled = [tag for tag in tags if "scaled_by" in TYRE_SCALAR_STORES.get(tag, {})]
    scale = (f" The loader multiplies {names_list(f'<code>{e(tag)}</code>' for tag in scaled)} by a global float "
             "when it stores it; that scale is not applied here." if scaled else "")
    return (f"<h3>Where the table comparison ends</h3><p>{tyre_link(first)} and {tyre_link(second)} read all five "
            f"tables from the same records ({shared}), yet their scalar fields hold different declarations "
            "(chosen from the data: the first such pair in file order):</p>"
            f"<table><tr><th>Scalar field</th><th>{e(first)}</th><th>{e(second)}</th></tr>{rows}</table>"
            "<p>So a shared table source does not mean identical handling. Values are shown as declared; what "
            f"a table or a scalar value does in the game, and in what units, is not interpreted here.{scale}</p>")


def tyre_tables_section(tyres, evidence, labels, hrefs):
    """Return the entrance page's #tyre-tables section.

    tyres is the tyres.json tyre_dossier.build() accepted, evidence the field-evidence.json it checked, labels the
    routine labels from status.json (dossier_common.routine_labels) and hrefs["evidence"] the page's link to
    field-evidence.json. Refuses, with ValueError, data that has no worked example or no same-tables pair.
    """
    counts = table_sources(tyres["resolved_tables"])
    sources = list(dict.fromkeys(source for table in RESOLVED_TYRE_TABLES for source in counts[table]))
    for source in sources:
        require(source in tyres["table_provenance"], f"Table source {source!r} is not a tyre record in tyres.json")
    name, table = worked_example(tyres)
    first, second, tags = same_tables_pair(tyres)
    return "".join([
        f'<section id="{SECTION_ID}"><h2>{e(QUESTION)}</h2>',
        summary(tyres, counts),
        counts_table(tyres, counts, sources, labels),
        f"<p>{names_list(f'<code>{e(source)}</code>' for source in sources)} are the names of records declared by "
        f"<code>:TYPE</code> lines in <code>{e(tyres['source'])}</code>; each declares the tables counted under its "
        "name above, and the other tyres reach them through <code>:INHERIT_TYPE</code>. They are record names in that "
        "file. These pages do not establish that the game uses them as a vehicle, surface or tyre classification. "
        f'Each tyre\'s own sources are on the <a href="{e(tyre_dossier.PAGE)}">tyre page</a>.</p>',
        example_trace(tyres, name, table, evidence, labels, hrefs),
        pair_section(tyres, first, second, tags),
        "</section>"])



ENGINE_SECTION_ID = "engine-torque-tables"
ENGINE_QUESTION = "Which engines share a torque table, and what do they declare differently?"
TORQUE = "TORQUE_ARRAY"
MODIFIER = "TORQUE_MODIFIER"
ENGINE_PAGE = record_dossier.DATABASES["engines"]["page"]
ENGINE_COPY_ROUTINE = record_dossier.DATABASES["engines"]["copy"]


def plural(count, singular, many=None):
    return f"{count} {singular if count == 1 else many or singular + 's'}"


def engine_link(name, part=None, text=None):
    """Return a link to an engine's section, or one of its rows, on the engine page."""
    return (f'<a href="{e(ENGINE_PAGE)}#{e(dossier_common.anchor("engine", name, part))}">'
            f'{e(name if text is None else text)}</a>')


def engine_ref(name):
    """An engine's name linked to its section; INDIGO also links its section on the Open questions page."""
    question = f" ({question_link(INDIGO_ANCHOR)})" if name == INDIGO_RECORD else ""
    return engine_link(name) + question


def engine_line_link(name, line):
    """Return a link to the declarations row for line `line` of engine `name` on the engine page."""
    return (f'<a href="{e(ENGINE_PAGE)}#{e(line_anchor("engine", name, line))}">line {e(line)}</a>')


def torque_groups(engines):
    """Return every TORQUE_ARRAY an inheriting engine reads, as {"source", "source_line", "readers"}, in file order.

    Readers are grouped by the (source record, declaring line) of their effective TORQUE_ARRAY and listed in file
    order. A root (a record without :INHERIT_TYPE) reads the table it declares, so it is a reader of its own table
    when an inheriting engine reads that table too. Zero-filled tables have no source and are left out.
    """
    effective = engines["effective_fields"]
    by_name = {record["type"]: record for record in engines["records"]}
    order = {record["type"]: i for i, record in enumerate(engines["records"])}
    groups = {}
    for record in engines["records"]:
        name = record["type"]
        if name not in effective:
            continue
        field = effective[name]["fields"][TORQUE]
        if field["status"] == ZERO_FILLED:
            continue
        groups.setdefault((field["source"], field["source_line"]), []).append(name)
    for (source, line), readers in groups.items():
        require(source in by_name, f"TORQUE_ARRAY source {source!r} is not an engine record in engines.json")
        own = by_name[source]["fields"].get(TORQUE)
        if source not in effective and own is not None and own["line"] == line:
            readers.append(source)
        readers.sort(key=order.__getitem__)
    return [{"source": source, "source_line": line, "readers": readers}
            for (source, line), readers in sorted(groups.items(), key=lambda item: (item[0][1], order[item[0][0]]))]


def shared_groups(engines):
    """Return the torque tables more than one engine reads; refuse data that has none."""
    shared = [group for group in torque_groups(engines) if len(group["readers"]) > 1]
    if not shared:
        raise ValueError("No two engines in engines.json read the same TORQUE_ARRAY, so the entrance page's "
                         f"#{ENGINE_SECTION_ID} answer has no shared torque table to show")
    return shared


def torque_example(engines):
    """Return the traced example: the first engine, in file order, whose effective TORQUE_ARRAY is inherited."""
    effective = engines["effective_fields"]
    for record in engines["records"]:
        name = record["type"]
        if name in effective and effective[name]["fields"][TORQUE]["status"] == "inherited":
            return name
    raise ValueError("No engine in engines.json inherits its TORQUE_ARRAY, so the entrance page's "
                     f"#{ENGINE_SECTION_ID} answer has no traced example")


def own_declarations(engines, name):
    """Return [(tag, values, line)]: the mapped declarations other than TORQUE_ARRAY in effect in `name`, by line."""
    effective = engines["effective_fields"]
    if name in effective:
        found = [(tag, field["values"], field["source_line"]) for tag, field in effective[name]["fields"].items()
                 if tag != TORQUE and field["status"] == "declared" and field["source"] == name]
    else:
        record = next(record for record in engines["records"] if record["type"] == name)
        found = [(tag, field["values"], field["line"]) for tag, field in record["fields"].items()
                 if tag != TORQUE and tag in ENGINE_FIELD_STORES]
    return sorted(found, key=lambda item: item[2])


def declaration_html(name, tag, values, line):
    return (f'<code>{e(tag)}</code> <span class="num">{e(" ".join(map(str, values)))}</span> '
            f"({engine_line_link(name, line)})")


def path_links(path):
    return " &rarr; ".join(engine_ref(hop) for hop in path)


def reads_html(engines, name, group):
    """How one engine reaches the shared table: it declares it, or inherits it along its INHERIT_TYPE path."""
    effective = engines["effective_fields"]
    if name not in effective or effective[name]["fields"][TORQUE]["status"] == "declared":
        return f"declares it ({engine_line_link(name, group['source_line'])})"
    return f"inherits it: {path_links(effective[name]['fields'][TORQUE]['path'])}"


def sharing_table(engines, shared):
    """Return one row per reader of each shared table, grouped by the table's declaring record and line."""
    rows = []
    for group in shared:
        readers = group["readers"]
        source = (f'<td rowspan="{len(readers)}">{engine_ref(group["source"])} '
                  f'{engine_line_link(group["source"], group["source_line"])}</td>')
        for i, name in enumerate(readers):
            declared = "; ".join(declaration_html(name, *item) for item in own_declarations(engines, name))
            rows.append(f"<tr>{source if i == 0 else ''}<td>{engine_ref(name)}</td>"
                        f"<td>{reads_html(engines, name, group)}</td><td>{declared or 'none'}</td></tr>")
    return ("<table><tr><th>Table declared by</th><th>Engine reading it</th><th>How it reaches the table</th>"
            f"<th>Its own other mapped declarations in effect</th></tr>{''.join(rows)}</table>")


def is_are(count):
    return "is" if count == 1 else "are"


def torque_summary(engines, groups, shared):
    """Return the lead paragraph: who declares or inherits a torque table, and how many tables are shared."""
    effective = engines["effective_fields"]
    names = [record["type"] for record in engines["records"] if record["type"] in effective]
    statuses = [effective[name]["fields"][TORQUE]["status"] for name in names]
    declared, inherited, zero = (statuses.count(status) for status in ("declared", "inherited", ZERO_FILLED))
    sharing = {name for group in shared for name in group["readers"]}
    alone = sum(1 for group in groups if len(group["readers"]) == 1)
    zero_text = (f"; {plural(zero, 'has', 'have')} no <code>{TORQUE}</code> along its <code>:INHERIT_TYPE</code> "
                 "path and keeps the zero-filled slots" if zero else "")
    parts = [f"Of the {len(names)} engines with <code>:INHERIT_TYPE</code>, {declared} declare their own "
             f"<code>{TORQUE}</code> and {inherited} inherit one{zero_text}.",
             f"{plural(len(shared), 'table')} {is_are(len(shared))} read by more than one engine, "
             f"{len(sharing)} engines in all; the other {plural(alone, 'inheriting engine')} each "
             f"read{'s' if alone == 1 else ''} a table that no other engine reads."]
    roots = [record["type"] for record in engines["records"] if record["type"] not in effective]
    if roots:
        shared_roots = [group["source"] for group in shared if group["source"] in roots]
        counted = (f"{names_list(engine_ref(name) for name in shared_roots)} {is_are(len(shared_roots))} counted "
                   "among the readers of the shared tables because inheriting engines read "
                   f"{'its table' if len(shared_roots) == 1 else 'their tables'}." if shared_roots
                   else "No inheriting engine reads a table one of them declares.")
        parts.append(f"The {plural(len(roots), 'record')} without <code>:INHERIT_TYPE</code> "
                     f"({names_list(engine_ref(name) for name in roots)}) {is_are(len(roots))} not counted above. "
                     f"{counted}")
    return f"<p>{' '.join(parts)}</p>"


def max_rpm_html(engines, origin):
    """The MAX_RPM a table's row count was read from: its declaration and line, or the zero fill."""
    torque = ENGINE_FIELD_STORES[TORQUE]
    read = (f"it read the row count from <code>+ {e(torque['row_count']['offset'])}</code> "
            f"({site_link(int(torque['row_count']['site'], 16))})")
    if origin["status"] == ZERO_FILLED:
        return (f"{read}, which no <code>MAX_RPM</code> along {path_links(origin['path'])} had set, so it held the "
                "zero fill")
    record = next(record for record in engines["records"] if record["type"] == origin["source"])
    declared = record["fields"].get("MAX_RPM")
    value = (f' <span class="num">{e(" ".join(map(str, declared["values"])))}</span>'
             if declared and declared["line"] == origin["source_line"] else "")
    via = (f", which reached {engine_ref(origin['path'][0])} through {path_links(origin['path'])}"
           if len(origin["path"]) > 1 else "")
    return (f"{read}, which held the <code>MAX_RPM</code>{value} that {engine_ref(origin['source'])} declares on "
            f"{engine_line_link(origin['source'], origin['source_line'])}{via}")


def torque_trace(engines, name, labels):
    """Return the traced example: the INHERIT_TYPE path, the declaring line, the row count, the copy and zero fill."""
    by_name = {record["type"]: record for record in engines["records"]}
    field = engines["effective_fields"][name]["fields"][TORQUE]
    path, source, line = field["path"], field["source"], field["source_line"]
    torque, block = ENGINE_FIELD_STORES[TORQUE], ENGINE_COPY["block"]
    copy = routine_label(labels, ENGINE_COPY_ROUTINE[0], "engine record copy", ENGINE_COPY_ROUTINE[1])
    steps = []
    for hop, parent in zip(path[:-1], path[1:], strict=True):
        inherit = by_name[hop]["fields"]["INHERIT_TYPE"]
        steps.append(f"<li>{engine_ref(hop)} declares no <code>{TORQUE}</code> after its <code>:INHERIT_TYPE</code> "
                     f"on {engine_line_link(hop, inherit['line'])}, which names {engine_ref(parent)}.</li>")
    rows = by_name[source]["fields"][TORQUE]["rows"]
    shape = f"{len(rows)} rows &times; {len(rows[0])} columns" if rows else "no rows"
    steps.append(f"<li>{engine_ref(source)} declares the <code>{TORQUE}</code> on {engine_line_link(source, line)} "
                 f"of <code>{e(engines['source'])}</code>, {shape}.</li>")
    steps.append(f"<li>When the loader parsed that table, {max_rpm_html(engines, field['max_rpm'])}.</li>")
    steps.append(f"<li>Each <code>:INHERIT_TYPE</code> on the path calls the record copy {routine_link(copy)} "
                 f"({site_link(int(ENGINE_COPY['call'], 16))}). The copy moves the parent's 18 torque slots at "
                 f"<code>+ {e(block['offset'])}</code> as one 0x{block['size']:x}-byte block "
                 f"({site_link(int(block['sites']['movsd'], 16))}, {site_link(int(block['sites']['movsb'], 16))}), "
                 "with the parent's other mapped fields.</li>")
    steps.append(f"<li>An engine's own <code>{TORQUE}</code> first zero-fills all 18 slots "
                 f"({site_link(int(torque['zero_fill']['call'], 16))}) and then stores its rows, so a table replaces "
                 f"the one before it whole and never mixes rows with it. {engine_ref(name)} declares none after its "
                 f"<code>:INHERIT_TYPE</code>, so it keeps the copied block "
                 f"({engine_link(name, 'torque-array', 'its effective TORQUE_ARRAY row')}).</li>")
    return (f"<h3>Traced example: {e(name)}</h3><p>Chosen from the data: the first engine in file order that inherits "
            f"its <code>{TORQUE}</code>. {engine_ref(name)} reads the table {engine_ref(source)} declares on "
            f"{engine_line_link(source, line)}.</p><ol>{''.join(steps)}</ol>")


def modifier_of(engines, name):
    """The TORQUE_MODIFIER in effect in `name`: (values or None when zero-filled, declaring record, line, own)."""
    effective = engines["effective_fields"]
    if name in effective:
        field = effective[name]["fields"][MODIFIER]
        if field["status"] == ZERO_FILLED:
            return None, None, None, False
        return field["values"], field["source"], field["source_line"], field["status"] == "declared"
    field = next(record for record in engines["records"] if record["type"] == name)["fields"].get(MODIFIER)
    return (field["values"], name, field["line"], True) if field else (None, None, None, False)


def comparison_ends(engines, shared):
    """Return where the comparison ends: each sharing engine's own TORQUE_MODIFIER, and the derived + 0x2c."""
    torque, modifier = ENGINE_FIELD_STORES[TORQUE], ENGINE_FIELD_STORES[MODIFIER]
    readers = [name for group in shared for name in group["readers"]]
    own = sum(1 for name in readers if modifier_of(engines, name)[3])
    differing = [group for group in shared
                 if len({tuple(modifier_of(engines, name)[0] or ()) for name in group["readers"]}) > 1]
    store = ", ".join(site_link(int(va, 16)) for va in modifier["offsets"]["0x24"]["sites"])
    counted = f"All {len(readers)}" if own == len(readers) else f"{own} of the {len(readers)}"
    parts = [f"<h3>Where the comparison ends</h3><p>A shared table does not make two engines' effective fields the "
             f"same. {counted} engines that read a shared table declare their own "
             f"<code>{MODIFIER}</code>, which the loader stores at <code>+ 0x24</code> ({store})."]
    parts.append(f" For {len(differing)} of the {plural(len(shared), 'shared table')}, the engines that read the "
                 f"table hold different <code>{MODIFIER}</code> declarations." if differing else
                 f" The engines reading each shared table hold the same <code>{MODIFIER}</code>.")
    if differing:
        group = differing[0]
        held = []
        for name in group["readers"]:
            values, source, line, _ = modifier_of(engines, name)
            held.append(f'{engine_ref(name)} <span class="label">zero-filled</span>' if values is None else
                        f'{engine_ref(name)} <span class="num">{e(" ".join(map(str, values)))}</span> '
                        f"({engine_line_link(source, line)})")
        parts.append(f" For example (the first such table in file order), the engines reading the table "
                     f"{engine_ref(group['source'])} declares on "
                     f"{engine_line_link(group['source'], group['source_line'])} hold {names_list(held)}.")
    derived = ", ".join(site_link(int(va, 16)) for va in torque["offsets"]["0x2c"]["sites"])
    parts.append(f"</p><p>How the game uses <code>+ 0x24</code> together with the table is not byte-checked here, so "
                 "this answer neither combines them nor computes anything from them. The <code>+ 0x2c</code> that "
                 f"<code>{TORQUE}</code> may also write ({derived}) is labelled "
                 '<span class="label">derived</span> and <span class="label">conditional</span> and is given no '
                 f'value; each engine\'s possible origins for it are on the <a href="{e(ENGINE_PAGE)}">engine page</a>. '
                 "Values are shown as declared.</p>")
    return "".join(parts)


def engine_site_vas():
    """Every byte-checked site the engine answer links on the routines page."""
    torque, block = ENGINE_FIELD_STORES[TORQUE], ENGINE_COPY["block"]["sites"]
    vas = [ENGINE_COPY["call"], torque["row_count"]["site"], torque["zero_fill"]["call"], block["movsd"],
           block["movsb"], *ENGINE_FIELD_STORES[MODIFIER]["offsets"]["0x24"]["sites"], *torque["offsets"]["0x2c"]["sites"]]
    return {int(va, 16) for va in vas}


def engine_torque_section(engines, evidence, labels):
    """Return the entrance page's #engine-torque-tables section.

    engines is the engines.json record_dossier.build() accepted, evidence the field-evidence.json whose sites the
    routines page anchors and labels the routine labels from status.json (dossier_common.routine_labels). Refuses,
    with ValueError, data with no shared torque table or no inheriting engine to trace, and a linked site that is not
    in field-evidence.json.
    """
    missing = sorted(engine_site_vas() - {site["va"] for site in evidence})
    require(not missing, f"The #{ENGINE_SECTION_ID} answer links sites that are not in field-evidence.json: "
                         + ", ".join(f"0x{va:08x}" for va in missing))
    groups = torque_groups(engines)
    shared = shared_groups(engines)
    name = torque_example(engines)
    return "".join([
        f'<section id="{ENGINE_SECTION_ID}"><h2>{e(ENGINE_QUESTION)}</h2>',
        torque_summary(engines, groups, shared),
        sharing_table(engines, shared),
        "<p>Each row's declarations are the mapped tags that engine declares itself and that are still in effect "
        f"after its <code>:INHERIT_TYPE</code>, as written; a table's declaring line is its <code>{TORQUE}</code> "
        f'line. Every engine\'s full set of effective fields is on the <a href="{e(ENGINE_PAGE)}">engine page</a>.</p>',
        torque_trace(engines, name, labels),
        comparison_ends(engines, shared),
        "</section>"])
