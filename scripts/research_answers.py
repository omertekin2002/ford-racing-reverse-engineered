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
INDIGO, wherever it is named, links to its section on the Open questions page. INDIGO inherits through its
colon-less INHERIT_TYPE line, which engines.json applies on static instruction evidence; the lead paragraph says so
and links that basis.

Finally it calls car_sharing_section() with the cars.json scripts/car_page.py has accepted, its reverse index from
text_database.car_usage() and the declarations as written in CARDATA.DAT. That section answers "Which cars share an
engine, gearbox or tyre record?", again with nothing written by hand:
  * per CAR_REFERENCE_STORES tag, how many distinct records the cars name (refused unless it equals
    check_car_usage()'s count), how many of those more than one car names, and how many cars name them; only a record
    a car names directly counts, never one it reaches through :INHERIT_TYPE;
  * one table per tag of the shared records, in their database file's order, each with the cars that name it in
    CARDATA.DAT order, their declaration lines and each reference's basis; the front and back tyre are kept apart, and
    a line says how many cars name the same tyre record for both, listing those that do not;
  * one traced example, chosen by sharing_example(): the first shared record in CAR_REFERENCE_STORES order and then
    in file order, with its first two cars' declaration lines, the loader's car-store-<TAG> row and the byte-checked
    handler sites, each linked to its anchor on cars.html, routines.html or the record's page;
  * where the comparison ends: that pair's other references and CAR_PERFORMANCE lines as written, and a statement
    that naming the same record does not establish the same performance or handling. The brake, body, setup and
    control records are named but not parsed, so they are not compared.

It also calls car_tyre_roots_section() with that cars.json and the tyres.json. That section answers "Which cars run
road, offroad or track tyres?", again with nothing written by hand:
  * for CAR_FRONT_TYRE_TYPE and CAR_BACK_TYRE_TYPE apart, how many cars' named tyres end, along their :INHERIT_TYPE
    chain (text_database.inherit_chain()), at each root, a record without :INHERIT_TYPE; refused unless each tag's
    counts add up to the cars in cars.json;
  * the record each car tyre reads the vertical load, camber thrust and sound info tables from (`resolved_tables`),
    grouped by root and sources, and the cars whose source is not the root, with their chains; the other two tables in
    one sentence;
  * the cars whose front and back tyres end at different roots or read those tables from different records, or a
    line saying there are none;
  * one traced example, chosen by car_tyre_example(): the first car in CARDATA.DAT order whose front or back tyre,
    front first, inherits, from its declaration line through the cars page's car-store-<TAG> row, each :INHERIT_TYPE
    line, the scalar copy and its byte-checked call to each table's declaring line and table-source row;
  * where the answer ends: the roots' and sources' names are record names in TYREDATA.DAT, sharing them does not
    establish that cars handle alike, and the brake, body, setup and control records are not parsed.

Every link points at an anchor the car, tyre, engine, gearbox or routines page writes, so verify_research() refuses
the build when one goes missing. When the data has no example, no pair, no shared torque table, no shared car
record or no car tyre that inherits, or a linked site is not in field-evidence.json, the section refuses to render rather than state an empty
claim. Nothing here interprets units, physics or handling.
"""
from itertools import zip_longest

import car_page
import dossier_common
from dossier_common import (INDIGO_ANCHOR, INDIGO_RECORD, basis_html, e, line_anchor, question_link, routine_label,
                            routine_link, site_link)
import record_dossier
from text_database import (CAR_REFERENCE_STORES, ENGINE_COPY, ENGINE_FIELD_STORES, RESOLVED_TYRE_TABLES,
                           SCALAR_COPY_CALL, TYRE_SCALAR_STORES, ZERO_FILLED, check_car_usage, inherit_chain, require,
                           table_sources)
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
                 f"path and keep{'s' if zero == 1 else ''} the zero-filled slots" if zero else "")
    applied = [name for name in names if not effective[name]["inherit_type"]["colon"]]
    lead = (f"Of the {len(names)} inheriting engines" if applied
            else f"Of the {len(names)} engines with <code>:INHERIT_TYPE</code>")
    parts = [f"{lead}, {declared} declare their own <code>{TORQUE}</code> and {inherited} inherit one{zero_text}."]
    if applied:
        via = names_list(f"{engine_ref(name)} through its colon-less <code>INHERIT_TYPE</code> "
                         f"{engine_line_link(name, effective[name]['inherit_type']['line'])}" for name in applied)
        basis = basis_html(effective[applied[0]]["inherit_type"]["basis"])
        parts.append(f"{len(names) - len(applied)} of them inherit through <code>:INHERIT_TYPE</code>, and {via}, "
                     f"applied on {basis}: nothing has been run to confirm it.")
    parts.append(f"{plural(len(shared), 'table')} {is_are(len(shared))} read by more than one engine, "
                 f"{len(sharing)} engines in all; the other {plural(alone, 'inheriting engine')} each "
                 f"read{'s' if alone == 1 else ''} a table that no other engine reads.")
    roots = [record["type"] for record in engines["records"] if record["type"] not in effective]
    if roots:
        shared_roots = [group["source"] for group in shared if group["source"] in roots]
        counted = (f"{names_list(engine_ref(name) for name in shared_roots)} {is_are(len(shared_roots))} counted "
                   "among the readers of the shared tables because inheriting engines read "
                   f"{'its table' if len(shared_roots) == 1 else 'their tables'}." if shared_roots
                   else "No inheriting engine reads a table one of them declares.")
        parts.append(f"The {plural(len(roots), 'record')} that inherit{'s' if len(roots) == 1 else ''} nothing "
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
    effective = engines["effective_fields"]
    field = effective[name]["fields"][TORQUE]
    path, source, line = field["path"], field["source"], field["source_line"]
    torque, block = ENGINE_FIELD_STORES[TORQUE], ENGINE_COPY["block"]
    copy = routine_label(labels, ENGINE_COPY_ROUTINE[0], "engine record copy", ENGINE_COPY_ROUTINE[1])
    steps = []
    for hop, parent in zip(path[:-1], path[1:], strict=True):
        inherit = effective[hop]["inherit_type"]
        written = ("<code>:INHERIT_TYPE</code>" if inherit["colon"] else
                   f"colon-less <code>INHERIT_TYPE</code> line, applied on {basis_html(inherit['basis'])},")
        steps.append(f"<li>{engine_ref(hop)} declares no <code>{TORQUE}</code> after its {written} "
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



CAR_SECTION_ID = "car-shared-records"
CAR_QUESTION = "Which cars share an engine, gearbox or tyre record?"
CAR_PERFORMANCE = "CAR_PERFORMANCE"
# The car tags that name records of databases these pages do not parse, so the answer does not compare them.
UNPARSED_CAR_TAGS = ("CAR_BRAKE_TYPE", "CAR_BODY_TYPE", "CAR_SETUP_TYPE", "CAR_CONTROL_TYPE")


def car_link(name, part=None, text=None):
    """Return a link to a car's section, or one of its rows, on the cars page."""
    return (f'<a href="{e(car_page.PAGE)}#{e(dossier_common.anchor("car", name, part))}">'
            f'{e(name if text is None else text)}</a>')


def car_line_link(name, line):
    """Return a link to the declarations row for line `line` of car `name` on the cars page."""
    return f'<a href="{e(car_page.PAGE)}#{e(line_anchor("car", name, line))}">line {e(line)}</a>'


def store_link(tag, text=None):
    """Return a link to the cars page's row for how the car loader resolves `tag`."""
    return (f'<a href="{e(car_page.PAGE)}#{e(dossier_common.car_store_anchor(tag))}">'
            f'{text if text is not None else f"<code>{e(tag)}</code>"}</a>')


def record_link(database, name, part=None, text=None):
    """Return a link to a record's section, or one of its blocks, on its engine, gearbox or tyre page."""
    page, prefix = car_page.TARGET_PAGES[database]
    return (f'<a href="{e(page)}#{e(dossier_common.anchor(prefix, name, part))}">'
            f'{e(name if text is None else text)}</a>')


def tag_noun(tag, count):
    """The record noun for `tag`: engine, gearbox, front tyre or back tyre, plural unless count is 1."""
    return car_page.TAG_COUNTED[tag][count != 1]


def tag_users(cars, usage, tag):
    """Return [(record, [car, ...])] for the records the cars name through `tag`, from car_usage()'s reverse index.

    Records are in their database file's order (the line that declares them) and each record's cars in CARDATA.DAT
    order. Only a record a car names directly is in the index, so a parent reached through :INHERIT_TYPE is not here.
    """
    database = CAR_REFERENCE_STORES[tag]["database"]
    order = {record["type"]: i for i, record in enumerate(cars["records"])}
    found = []
    for record, users in usage.get(database, {}).items():
        named = [car for car, user_tag, _ in users if user_tag == tag]
        if not named:
            continue
        require(all(car in cars["references"] for car in named),
                f"The cars' reverse index names a car cars.json lacks under {database} {record}")
        found.append((record, sorted(named, key=order.__getitem__)))
    line = {entries[tag]["target"]: entries[tag]["target_line"] for entries in cars["references"].values()}
    require(all(record in line for record, _ in found),
            f"The cars' reverse index names a {database} record no car's {tag} resolves to")
    return sorted(found, key=lambda item: line[item[0]])


def sharing_counts(cars, usage):
    """Return {tag: (distinct records, records named by more than one car, cars naming a shared record)}.

    The distinct records come from car_usage()'s reverse index and must equal what check_car_usage() returns for it
    against cars.json's references; the build refuses when they disagree.
    """
    checked = check_car_usage(usage, cars["references"])
    counts = {}
    for tag in CAR_REFERENCE_STORES:
        named = tag_users(cars, usage, tag)
        shared = [users for _, users in named if len(users) > 1]
        counts[tag] = (len(named), len(shared), sum(len(users) for users in shared))
    distinct = {tag: counts[tag][0] for tag in CAR_REFERENCE_STORES}
    require(distinct == checked, f"The #{CAR_SECTION_ID} answer's distinct records per tag, {distinct}, disagree "
                                 f"with check_car_usage()'s {checked}")
    return counts


def sharing_example(cars, usage):
    """Return (tag, record, cars) for the traced example.

    The record is the first, in CAR_REFERENCE_STORES order and then in its database file's order, that more than one
    car names; cars lists every car that names it through `tag`, in CARDATA.DAT order, and the example traces the
    first two. Refuses data where no record is shared.
    """
    for tag in CAR_REFERENCE_STORES:
        for record, named in tag_users(cars, usage, tag):
            if len(named) > 1:
                return tag, record, named
    raise ValueError("No two cars in cars.json name the same engine, gearbox or tyre record, so the entrance page's "
                     f"#{CAR_SECTION_ID} answer has no shared record to show")


def reference_html(cars, car, tag):
    """A car's declaration of `tag`: its line on the cars page and the name as written, with a case-match note."""
    reference = cars["references"][car][tag]
    match = "" if reference["match"] == "exact" else " (matches ignoring case, as the lookup compares)"
    return f'{car_line_link(car, reference["line"])}: <code>:{e(tag)} {e(reference["name"])}</code>{match}'


def car_counts_table(counts):
    rows = "".join(f"<tr><td>{e(car_page.TAG_TITLES[tag])} ({store_link(tag)})</td>"
                   + "".join(f'<td class="num">{e(count)}</td>' for count in counts[tag]) + "</tr>"
                   for tag in car_page.SUMMARY_TAGS)
    return ("<table><tr><th>Record (tag)</th><th>Distinct records</th><th>Shared</th><th>Cars naming a shared "
            f"record</th></tr>{rows}</table>")


def car_sharing_summary(cars, counts):
    total = len(cars["records"])
    named = names_list(f"{counts[tag][0]} {e(tag_noun(tag, counts[tag][0]))}" for tag in car_page.SUMMARY_TAGS)
    shared = names_list(f"{counts[tag][1]} {e(tag_noun(tag, counts[tag][1]))} named by {plural(counts[tag][2], 'car')}"
                        for tag in car_page.SUMMARY_TAGS)
    return (f"<p>The {plural(total, 'car')} in <code>{e(cars['source'])}</code> name {named}. Of those records, "
            f"{shared} are shared: more than one car names them through the same tag. Counts come from the cars' "
            "references indexed the other way round, the index the record pages' \"Used by cars\" blocks show, "
            "checked against the references themselves. Only a record a car names directly is counted: a record "
            "that one inherits from through <code>:INHERIT_TYPE</code> is not counted through it.</p>")


def shared_tables(cars, usage):
    """One table per tag of the records more than one car names, each car on its own row, or a line saying none."""
    parts = []
    for tag in car_page.SUMMARY_TAGS:
        database = CAR_REFERENCE_STORES[tag]["database"]
        shared = [(record, named) for record, named in tag_users(cars, usage, tag) if len(named) > 1]
        title = car_page.TAG_TITLES[tag]
        parts.append(f"<h3>{e(title)} records named by more than one car</h3>")
        if not shared:
            parts.append(f"<p>No two cars' {store_link(tag)} name the same record.</p>")
            continue
        rows = []
        for record, named in shared:
            line = cars["references"][named[0]][tag]["target_line"]
            source = (f'<td rowspan="{len(named)}">{record_link(database, record)} (line {e(line)} of '
                      f"<code>{e(car_page.TARGET_FILES[database])}</code>; "
                      f"{record_link(database, record, dossier_common.USED_BY, 'its Used by cars block')})</td>")
            for i, car in enumerate(named):
                basis = cars["references"][car][tag]["basis"]
                rows.append(f"<tr>{source if i == 0 else ''}<td>{car_link(car)}</td>"
                            f"<td>{reference_html(cars, car, tag)}</td>"
                            f'<td><span class="label">{e(basis)}</span></td></tr>')
        parts.append(f"<p>{store_link(tag)}: {plural(len(shared), 'record')} named by more than one car.</p>"
                     '<table><tr><th>Record</th><th>Car</th><th>Declared</th><th>Basis</th></tr>'
                     f"{''.join(rows)}</table>")
    return "".join(parts)


def front_back_html(cars):
    """How many cars name one tyre record front and back, and the cars that name different ones, linked."""
    front, back = dossier_common.car_tags("tyres")
    names = [record["type"] for record in cars["records"]]
    same = [car for car in names
            if cars["references"][car][front]["target"] == cars["references"][car][back]["target"]]
    different = [car for car in names if car not in same]
    text = (f"<h3>Same tyre front and back</h3><p>The front and back tyre are counted apart above. "
            f"{plural(len(same), 'car names', 'cars name')} the same tyre record through {store_link(front)} and "
            f"{store_link(back)}; {plural(len(different), 'car names', 'cars name')} different ones"
            f"{':' if different else '.'}</p>")
    if not different:
        return text
    rows = "".join(f"<tr><td>{car_link(car)}</td>"
                   f"<td>{record_link('tyres', cars['references'][car][front]['target'])}</td>"
                   f"<td>{record_link('tyres', cars['references'][car][back]['target'])}</td></tr>"
                   for car in different)
    return text + f'<table><tr><th>Car</th><th>Front tyre</th><th>Back tyre</th></tr>{rows}</table>'


def store_site_vas(tag):
    """Every byte-checked site the traced example links for `tag`: its handler's path, name read, lookup and store."""
    entry = CAR_REFERENCE_STORES[tag]
    path = [step.get("compare") or step["jump"] for step in entry["select"]]
    read = [entry["read"][key] for key in ("size", "buffer", "call")]
    return [int(va, 16) for va in (*path, *read, entry["lookup"]["call"], entry["store"])]


def car_trace(cars, tag, record, named):
    """Return the traced example: the first two cars' declarations, the loader's handler and its sites, the record."""
    entry = CAR_REFERENCE_STORES[tag]
    database = entry["database"]
    first, second = named[:2]
    path = ", ".join(f"compare {site_link(int(step['compare'], 16))}" if "compare" in step else
                     f"jump {site_link(int(step['jump'], 16))} {'taken' if step['taken'] else 'not taken'}"
                     for step in entry["select"])
    read = ", ".join(site_link(int(entry["read"][key], 16)) for key in ("size", "buffer", "call"))
    target_line = cars["references"][first][tag]["target_line"]
    order = ", ".join(f"<code>{e(name)}</code>" for name in CAR_REFERENCE_STORES)
    steps = [f"<li>{car_link(first)} names it on {reference_html(cars, first, tag)}, and {car_link(second)} on "
             f"{reference_html(cars, second, tag)}, in <code>{e(cars['source'])}</code>.</li>",
             f"<li>For each, the car loader's handler for <code>{e(tag)}</code> "
             f"({store_link(tag, 'its row on the cars page')}), reached by {path}, reads the name into the "
             f"<code>0x40</code>-byte buffer ({read}), calls the {e(database)} lookup "
             f"<code>{e(entry['lookup']['target'])}</code> ({site_link(int(entry['lookup']['call'], 16))}) and stores "
             f"the record it returns at car payload <code>+ {e(entry['offset'])}</code> "
             f"({site_link(int(entry['store'], 16))}).</li>",
             f"<li>The lookup compares names ignoring the case of A&ndash;Z; both names resolve to "
             f"{record_link(database, record)}, declared at line {e(target_line)} of "
             f"<code>{e(car_page.TARGET_FILES[database])}</code>, so both references resolve to that one record "
             f"({record_link(database, record, dossier_common.USED_BY, 'its Used by cars block')} lists the "
             f"{plural(len(named), 'car')} that name it).</li>"]
    return (f"<h3>Traced example: {e(record)}</h3><p>Chosen from the data: the first record, in the car loader's tag "
            f"order ({order}) and then in file order, that more than one car names, traced for the first two cars "
            f"that name it in <code>{e(cars['source'])}</code> order. Both references are labelled "
            f'<span class="label">{e(cars["references"][first][tag]["basis"])}</span>'
            + ("" if cars["references"][second][tag]["basis"] == cars["references"][first][tag]["basis"] else
               f' and <span class="label">{e(cars["references"][second][tag]["basis"])}</span>')
            + f".</p><ol>{''.join(steps)}</ol>")


def performance_html(car, item):
    if item is None:
        return '<span class="label">none</span>'
    line, _, tokens = item
    return f'<code>{e(" ".join(tokens))}</code> ({car_line_link(car, line)})'


def car_comparison_ends(cars, written, tag, pair):
    """Return where the comparison ends: the pair's other references and their CAR_PERFORMANCE lines as written."""
    first, second = pair
    rows = []
    for other in car_page.SUMMARY_TAGS:
        if other == tag:
            continue
        database = CAR_REFERENCE_STORES[other]["database"]
        cells = "".join(f"<td>{record_link(database, cars['references'][car][other]['target'])} "
                        f"({car_line_link(car, cars['references'][car][other]['line'])})</td>" for car in pair)
        rows.append(f"<tr><td>{store_link(other)}</td>{cells}</tr>")
    for car in pair:
        require(car in written, f"No written declarations for car {car!r}")
    lines = [[item for item in written[car] if item[1] == CAR_PERFORMANCE] for car in pair]
    for a, b in zip_longest(*lines):
        rows.append(f"<tr><td><code>:{CAR_PERFORMANCE}</code></td><td>{performance_html(first, a)}</td>"
                    f"<td>{performance_html(second, b)}</td></tr>")
    unparsed = names_list(f"<code>{e(name)}</code>" for name in UNPARSED_CAR_TAGS)
    return (f"<h3>Where the comparison ends</h3><p>{car_link(first)} and {car_link(second)} both name "
            f"{record_link(CAR_REFERENCE_STORES[tag]['database'], cars['references'][first][tag]['target'])} through "
            f"<code>{e(tag)}</code>. Their other references, and their <code>:{CAR_PERFORMANCE}</code> lines as "
            "written, in file order:</p>"
            f'<table><tr><th>Tag</th><th>{e(first)}</th><th>{e(second)}</th></tr>{"".join(rows)}'
            "</table>"
            "<p>Naming the same record does not establish that two cars have the same performance or handling: this "
            f"answer compares only the records the loader's lookups resolve. {unparsed} also name records, but their "
            "databases are not parsed, so they are not compared. Values are shown as written; no units, menu meaning "
            "or physics are claimed for them.</p>")


def car_sharing_section(cars, usage, written, evidence):
    """Return the entrance page's #car-shared-records section.

    cars is the cars.json car_page.build() accepted, usage text_database.car_usage() of its references, written
    car_page.check_cars()'s {car: [(line, tag, written tokens)]} and evidence the field-evidence.json whose sites the
    routines page anchors. Refuses, with ValueError, distinct counts that disagree with check_car_usage(), data where
    no two cars name the same record, and a linked site that is not in field-evidence.json.
    """
    counts = sharing_counts(cars, usage)
    tag, record, named = sharing_example(cars, usage)
    missing = sorted(set(store_site_vas(tag)) - {site["va"] for site in evidence})
    require(not missing, f"The #{CAR_SECTION_ID} answer links sites that are not in field-evidence.json: "
                         + ", ".join(f"0x{va:08x}" for va in missing))
    return "".join([
        f'<section id="{CAR_SECTION_ID}"><h2>{e(CAR_QUESTION)}</h2>',
        car_sharing_summary(cars, counts),
        car_counts_table(counts),
        "<p>Each table lists a record once with every car that names it through that tag, in "
        f"<code>{e(cars['source'])}</code> order, each with its declaration line and the basis of the reference: "
        "<em>resolved by the loader's lookup (byte-checked)</em> only when every site of that path is byte-checked, "
        f'otherwise <em>declared by name</em>. Each car\'s four references are on the <a href="{e(car_page.PAGE)}">'
        "cars page</a>.</p>",
        shared_tables(cars, usage),
        front_back_html(cars),
        car_trace(cars, tag, record, named),
        car_comparison_ends(cars, written, tag, named[:2]),
        "</section>"])



ROOTS_SECTION_ID = "car-tyre-roots"
ROOTS_QUESTION = "Which cars run road, offroad or track tyres?"
# The tables whose sources split across records in the #tyre-tables answer; this answer shows each car tyre's source
# for each of them. The other resolved tables are summarised in one sentence.
ROOT_TABLES = ("VERTICAL_LOAD", "CAMBER_THRUST", "sound_info")


def car_tyre_lineages(cars, tyres):
    """Return [(car, {tag: lineage})] in CARDATA.DAT order for every car cars.json holds references for.

    For CAR_FRONT_TYRE_TYPE and CAR_BACK_TYRE_TYPE, lineage is {"tyre": the record the car names, "chain": its
    :INHERIT_TYPE chain from text_database.inherit_chain(), "root": the chain's last record, which declares no
    :INHERIT_TYPE, "sources": its `resolved_tables`}. Refuses, with ValueError, a car without a tyre reference, a
    reference to a record tyres.json lacks, a chain inherit_chain() refuses (a cycle, or a parent later in the file)
    and a resolved source that is not on the chain.
    """
    by_name = {record["type"]: record for record in tyres["records"]}
    order = {record["type"]: i for i, record in enumerate(tyres["records"])}
    found = []
    for record in cars["records"]:
        car = record["type"]
        if car not in cars["references"]:
            continue
        lineage = {}
        for tag in dossier_common.car_tags("tyres"):
            reference = cars["references"][car].get(tag)
            require(reference is not None, f"Car {car!r} has no {tag} reference in cars.json, so the "
                                           f"#{ROOTS_SECTION_ID} answer cannot place it")
            tyre = reference["target"]
            require(tyre in by_name and tyre in tyres["resolved_tables"],
                    f"Car {car!r}'s {tag} names {tyre!r}, which is not a tyre record in tyres.json")
            chain = inherit_chain(by_name[tyre], by_name, order)
            sources = tyres["resolved_tables"][tyre]
            require(all(sources[table] in chain for table in RESOLVED_TYRE_TABLES),
                    f"Tyre {tyre!r} resolves a table to a record that is not on its :INHERIT_TYPE chain")
            lineage[tag] = {"tyre": tyre, "chain": chain, "root": chain[-1], "sources": sources}
        found.append((car, lineage))
    return found


def tyre_order(tyres):
    order = {record["type"]: i for i, record in enumerate(tyres["records"])}
    return order.__getitem__


def root_counts(cars, tyres, lineages):
    """Return {tag: {root: cars}} in TYREDATA.DAT order; refuse counts that do not add up to the cars in cars.json."""
    total = len(cars["records"])
    counts = {}
    for tag in dossier_common.car_tags("tyres"):
        counts[tag] = dict(tyre_counts(tyres, (lineage[tag]["root"] for _, lineage in lineages)))
        counted = sum(counts[tag].values())
        require(counted == total, f"The #{ROOTS_SECTION_ID} answer counts {counted} cars' {tag} by root, not the "
                                  f"{total} cars in cars.json")
    return counts


def source_groups(tyres, lineages):
    """Return [(root, (source per ROOT_TABLES), {tag: [car, ...]})], ordered by the records' TYREDATA.DAT order."""
    tags = dossier_common.car_tags("tyres")
    groups = {}
    for car, lineage in lineages:
        for tag in tags:
            key = (lineage[tag]["root"], tuple(lineage[tag]["sources"][table] for table in ROOT_TABLES))
            groups.setdefault(key, {name: [] for name in tags})[tag].append(car)
    position = tyre_order(tyres)
    return [(root, sources, named) for (root, sources), named in
            sorted(groups.items(), key=lambda item: (position(item[0][0]), *map(position, item[0][1])))]


def below_root(lineage):
    """The ROOT_TABLES a car tyre reads from a record other than its root, as {source: [table, ...]}."""
    found = {}
    for table in ROOT_TABLES:
        source = lineage["sources"][table]
        if source != lineage["root"]:
            found.setdefault(source, []).append(table)
    return found


def car_tyre_example(lineages):
    """Return (car, tag): the first car in CARDATA.DAT order, front tyre before back, whose tyre inherits."""
    for car, lineage in lineages:
        for tag in dossier_common.car_tags("tyres"):
            if len(lineage[tag]["chain"]) > 1:
                return car, tag
    raise ValueError("No car in cars.json names a front or back tyre that inherits through :INHERIT_TYPE, so the "
                     f"entrance page's #{ROOTS_SECTION_ID} answer has no traced example")


def table_names(tables):
    return names_list(e(tyre_dossier.TABLE_LABELS[table].lower()) for table in tables)


def tyre_counts(tyres, names):
    """Return ((record, count), ...) for the record names in `names`, in TYREDATA.DAT order."""
    found = {}
    for name in names:
        found[name] = found.get(name, 0) + 1
    return tuple(sorted(found.items(), key=lambda item: tyre_order(tyres)(item[0])))


def cars_end(count):
    return f"{plural(count, 'car')} {'ends' if count == 1 else 'end'}"


def roots_summary(cars, tyres, counts, lineages):
    """Return the lead paragraphs: where each tag's chains end, and where the three split tables are read from."""
    front, back = dossier_common.car_tags("tyres")
    ends = "; ".join(f"for the {e(tag_noun(tag, 2))} ({store_link(tag)}), "
                     + names_list(f"{cars_end(n)} at {tyre_link(root)}" for root, n in counts[tag].items())
                     for tag in (front, back))
    parts = [f"<p>The {plural(len(cars['records']), 'car')} in <code>{e(cars['source'])}</code> each name a front and "
             "a back tyre record. Following each named record's <code>:INHERIT_TYPE</code> chain to the record that "
             f"declares none, its root: {ends}.</p>"]
    splits = []
    for tag in (front, back):
        groups = {}
        for table in ROOT_TABLES:
            split = tyre_counts(tyres, (lineage[tag]["sources"][table] for _, lineage in lineages))
            groups.setdefault(split, []).append(table)
        noun = e(tag_noun(tag, 2))
        for split, tables in groups.items():
            which = "" if len(groups) == 1 else f" ({table_names(tables)})"
            splits.append(f"the {noun}{which} {names_list(f'{n} from {tyre_link(source)}' for source, n in split)}")
    parts.append("<p>A root does not by itself say which tables a tyre reads: each table comes from the nearest record "
                 "along the chain that declares it, as the accessors resolve it "
                 f'(<a href="#{e(SECTION_ID)}">the tyre tables answer</a>). The cars read the '
                 f"{table_names(ROOT_TABLES)} tables from these records: {'; '.join(splits)}.")
    references = 2 * len(lineages)
    groups = {}
    for table in RESOLVED_TYRE_TABLES:
        if table not in ROOT_TABLES:
            split = tyre_counts(tyres, (lineage[tag]["sources"][table] for _, lineage in lineages
                                        for tag in (front, back)))
            groups.setdefault(split, []).append(table)
    for split, tables in groups.items():
        noun = f"{table_names(tables)} {'table' if len(tables) == 1 else 'tables'}"
        if len(split) == 1:
            parts.append(f" All {references} front and back tyre references read the {noun} from "
                         f"{tyre_link(split[0][0])}.")
        else:
            parts.append(f" The {references} front and back tyre references read the {noun} "
                         f"{names_list(f'{n} from {tyre_link(source)}' for source, n in split)}.")
    parts.append("</p>")
    return "".join(parts)


def roots_table(counts):
    front, back = dossier_common.car_tags("tyres")
    roots = list(dict.fromkeys([*counts[front], *counts[back]]))
    rows = "".join(f'<tr><td>{tyre_link(root)}</td><td class="num">{counts[front].get(root, 0)}</td>'
                   f'<td class="num">{counts[back].get(root, 0)}</td></tr>' for root in roots)
    total = (f'<tr><td>All roots</td><td class="num">{sum(counts[front].values())}</td>'
             f'<td class="num">{sum(counts[back].values())}</td></tr>')
    return (f"<table><tr><th>Root (no <code>:INHERIT_TYPE</code>)</th><th>Cars, {store_link(front)}</th>"
            f"<th>Cars, {store_link(back)}</th></tr>{rows}{total}</table>")


def group_cars_cell(cars, names, tag):
    """Count and link the cars in one root/source group for `tag`, carrying each car's reference basis."""
    if not names:
        return '<td class="num">0</td>'
    by_basis = {}
    for car in names:
        by_basis.setdefault(cars["references"][car][tag]["basis"], []).append(car)
    parts = [f'{", ".join(car_link(car) for car in subset)} <span class="label">{e(basis)}</span>'
             for basis, subset in by_basis.items()]
    return f"<td>{len(names)}: {'; '.join(parts)}</td>"


def sources_table(cars, groups):
    front, back = dossier_common.car_tags("tyres")
    head = "".join(f"<th>{e(tyre_dossier.TABLE_LABELS[table])} from</th>" for table in ROOT_TABLES)
    rows = "".join(f"<tr><td>{tyre_link(root)}</td>" + "".join(f"<td>{tyre_link(source)}</td>" for source in sources)
                   + group_cars_cell(cars, named[front], front) + group_cars_cell(cars, named[back], back) + "</tr>"
                   for root, sources, named in groups)
    return (f"<table><tr><th>Root</th>{head}<th>Cars, {store_link(front)}</th><th>Cars, {store_link(back)}</th></tr>"
            f"{rows}</table>")


def basis_label(cars, car, tag):
    return f'<span class="label">{e(cars["references"][car][tag]["basis"])}</span>'


def chain_links(chain):
    return " &rarr; ".join(tyre_link(hop) for hop in chain)


def below_root_html(cars, tyres, lineages):
    """Per tag, the cars whose tyre reads a split table from a record other than its root, or a line saying none."""
    parts = ["<h3>Tables declared below the root</h3>"]
    for tag in dossier_common.car_tags("tyres"):
        found = [(car, lineage[tag]) for car, lineage in lineages if below_root(lineage[tag])]
        if not found:
            parts.append(f"<p>{store_link(tag)}: every car's tyre reads the {table_names(ROOT_TABLES)} tables from its "
                         "root.</p>")
            continue
        rows = []
        for car, lineage in found:
            read = "; ".join(
                f"{names_list(tyre_link(lineage['tyre'], table, tyre_dossier.TABLE_LABELS[table].lower()) for table in tables)} "
                f"from {tyre_link(source)}" for source, tables in below_root(lineage).items())
            rows.append(f"<tr><td>{car_link(car)}</td><td>{reference_html(cars, car, tag)}</td>"
                        f"<td>{basis_label(cars, car, tag)}</td><td>{chain_links(lineage['chain'])}</td>"
                        f"<td>{read}</td></tr>")
        parts.append(f"<p>{store_link(tag)}: {plural(len(found), 'car')} of {len(lineages)} "
                     f"read{'s' if len(found) == 1 else ''} at least one of these tables from a record on the chain "
                     "other than the root, which declares that table itself:</p>"
                     "<table><tr><th>Car</th><th>Declared</th><th>Basis</th><th>Chain to the root</th>"
                     f"<th>Read from a record other than the root</th></tr>{''.join(rows)}</table>")
    return "".join(parts)


def mixed_html(cars, lineages):
    """The cars whose front and back tyres end at different roots, and those that read the split tables differently."""
    front, back = dossier_common.car_tags("tyres")
    total = len(lineages)
    roots = [(car, lineage) for car, lineage in lineages if lineage[front]["root"] != lineage[back]["root"]]
    parts = ["<h3>Front and back on different roots</h3>"]
    if roots:
        rows = "".join(f"<tr><td>{car_link(car)}</td><td>{reference_html(cars, car, front)} "
                       f"{basis_label(cars, car, front)}</td><td>{tyre_link(lineage[front]['root'])}</td>"
                       f"<td>{reference_html(cars, car, back)} {basis_label(cars, car, back)}</td>"
                       f"<td>{tyre_link(lineage[back]['root'])}</td></tr>" for car, lineage in roots)
        parts.append(f"<p>{plural(len(roots), 'car')} of {total} name{'s' if len(roots) == 1 else ''} a front and a "
                     "back tyre whose chains end at different roots:</p>"
                     "<table><tr><th>Car</th><th>Front tyre declared</th><th>Front root</th><th>Back tyre declared</th>"
                     f"<th>Back root</th></tr>{rows}</table>")
    else:
        parts.append(f"<p>None of the {plural(total, 'car')}: each car's front and back tyre chains end at the same "
                     "root.</p>")
    split = [(car, lineage) for car, lineage in lineages
             if any(lineage[front]["sources"][table] != lineage[back]["sources"][table] for table in ROOT_TABLES)]
    if split:
        rows = "".join(f"<tr><td>{car_link(car)}</td>"
                       + "".join(f"<td>{tyre_link(lineage[front]['sources'][table])} / "
                                 f"{tyre_link(lineage[back]['sources'][table])}</td>" for table in ROOT_TABLES)
                       + "</tr>" for car, lineage in split)
        head = "".join(f"<th>{e(tyre_dossier.TABLE_LABELS[table])} (front / back)</th>" for table in ROOT_TABLES)
        parts.append(f"<p>{plural(len(split), 'car')} of {total} read{'s' if len(split) == 1 else ''} at least one of "
                     f"the {table_names(ROOT_TABLES)} tables from different records front and back:</p>"
                     f"<table><tr><th>Car</th>{head}</tr>{rows}</table>")
    else:
        parts.append(f"<p>No car reads the {table_names(ROOT_TABLES)} tables from different records front and "
                     "back.</p>")
    return "".join(parts)


def roots_trace(cars, tyres, car, tag, lineage, labels):
    """Return the traced example: the car's declaration, the loader's row, each :INHERIT_TYPE line, the root's tables."""
    by_name = {record["type"]: record for record in tyres["records"]}
    tyre, chain, root = lineage["tyre"], lineage["chain"], lineage["root"]
    reference = cars["references"][car][tag]
    noun = tag_noun(tag, 1)
    copy_va = tyre_dossier.SCALAR_COPY_VA
    copy = routine_label(labels, copy_va, *tyre_dossier.LINKED_ROUTINES[copy_va])
    steps = [f"<li>{car_link(car)} declares its {e(noun)} on {reference_html(cars, car, tag)}; the reference is "
             f"labelled {basis_label(cars, car, tag)}.</li>",
             f"<li>The cars page's {store_link(tag, 'row for <code>' + e(tag) + '</code>')} shows how the car loader "
             f"looks that name up in <code>{e(tyres['source'])}</code> and where it stores the record. The name "
             f"matches {tyre_link(tyre)}, declared at line {e(reference['target_line'])}.</li>"]
    for hop, parent in zip(chain[:-1], chain[1:], strict=True):
        inherit = by_name[hop]["fields"]["INHERIT_TYPE"]
        steps.append(f"<li>{tyre_link(hop)}'s <code>:INHERIT_TYPE</code> on {line_link(hop, inherit['line'])} names "
                     f"{tyre_link(parent)}.</li>")
    steps.append(f"<li>{tyre_link(root)} declares no <code>:INHERIT_TYPE</code>, so the chain ends there: it is the "
                 "root counted above.</li>")
    steps.append(f"<li>For each <code>:INHERIT_TYPE</code> the tyre loader calls the scalar copy {routine_link(copy)} "
                 f"({site_link(SCALAR_COPY_CALL)}), which copies the parent's scalar fields at <code>+ 0x18</code> to "
                 "<code>+ 0x40</code> and no table address. Each table accessor instead returns the record's own table "
                 "when its address is non-zero and otherwise repeats the test on the record at <code>+ 0x14</code>, "
                 "the inherited record.</li>")
    for table in ROOT_TABLES:
        entry = tyres["table_provenance"][tyre][table]
        accessor = entry["accessor"]
        routine = routine_label(labels, int(accessor, 16), f"{table} accessor {accessor}")
        where = "the root" if entry["source"] == root else f"not the root {tyre_link(root)}"
        steps.append(f"<li>{e(tyre_dossier.TABLE_LABELS[table])}: read through {routine_link(routine, accessor)} at "
                     f"<code>+ {e(entry['record_offset'])}</code> from {tyre_link(entry['source'])} ({where}), which "
                     f"declares it on {line_link(entry['source'], entry['source_line'])}; "
                     f"{tyre_link(tyre, table, 'the table-source row of ' + tyre)}.</li>")
    return (f"<h3>Traced example: {e(car)}'s {e(noun)}</h3><p>Chosen from the data: the first car in "
            f"<code>{e(cars['source'])}</code> order whose front or back tyre, front first, inherits through at least "
            f"one <code>:INHERIT_TYPE</code> step. {car_link(car)}'s {e(noun)} {tyre_link(tyre)} reaches the root "
            f"{tyre_link(root)} through {chain_links(chain)}.</p><ol>{''.join(steps)}</ol>")


def roots_ends(tyres, groups):
    names = list(dict.fromkeys(name for root, sources, _ in groups for name in (root, *sources)))
    unparsed = names_list(f"<code>{e(name)}</code>" for name in UNPARSED_CAR_TAGS)
    return (f"<h3>Where the answer ends</h3><p>{names_list(f'<code>{e(name)}</code>' for name in names)} "
            f"{is_are(len(names))} the names of records declared by <code>:TYPE</code> lines in "
            f"<code>{e(tyres['source'])}</code>, and this answer groups the cars by those record names only. These pages "
            "do not establish that the game treats them as road, offroad or track tyres, or as any vehicle or surface "
            "classification. Sharing a root or a table source does not establish that two cars handle alike: the "
            "effective scalar fields of tyres that read the same tables can differ "
            f'(<a href="#{e(SECTION_ID)}">the tyre tables answer</a> shows such a pair; each tyre\'s are on the '
            f'<a href="{e(tyre_dossier.PAGE)}">tyre page</a>), and {unparsed} name records whose databases are not '
            "parsed. No units, surface meaning or physics are claimed.</p>")


def car_tyre_roots_section(cars, tyres, evidence, labels):
    """Return the entrance page's #car-tyre-roots section.

    cars is the cars.json car_page.build() accepted, tyres the tyres.json tyre_dossier.build() accepted, evidence the
    field-evidence.json whose sites the routines page anchors and labels the routine labels from status.json.
    Refuses, with ValueError, a missing tyre reference, a chain text_database.inherit_chain() refuses, per-root counts
    that do not add up to the cars, data where no car's tyre inherits and a linked site not in field-evidence.json.
    """
    require(SCALAR_COPY_CALL in {site["va"] for site in evidence},
            f"The #{ROOTS_SECTION_ID} answer links sites that are not in field-evidence.json: 0x{SCALAR_COPY_CALL:08x}")
    lineages = car_tyre_lineages(cars, tyres)
    counts = root_counts(cars, tyres, lineages)
    groups = source_groups(tyres, lineages)
    car, tag = car_tyre_example(lineages)
    lineage = dict(lineages)[car][tag]
    return "".join([
        f'<section id="{ROOTS_SECTION_ID}"><h2>{e(ROOTS_QUESTION)}</h2>',
        roots_summary(cars, tyres, counts, lineages),
        roots_table(counts),
        "<p>Each car tyre's root, with the record it reads each of these tables from, and the cars in each group, "
        "front and back apart:</p>",
        sources_table(cars, groups),
        below_root_html(cars, tyres, lineages),
        mixed_html(cars, lineages),
        roots_trace(cars, tyres, car, tag, lineage, labels),
        roots_ends(tyres, groups),
        "</section>"])
