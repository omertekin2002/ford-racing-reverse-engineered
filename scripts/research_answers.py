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

Every link points at an anchor the tyre or routines page writes, so verify_research() refuses the build when one
goes missing. When the data has no example or no pair, the section refuses to render rather than state an empty
claim. Nothing here interprets units, physics or handling.
"""
import dossier_common
from dossier_common import e, routine_label, routine_link, site_link
from text_database import RESOLVED_TYRE_TABLES, TYRE_SCALAR_STORES, ZERO_FILLED, require, table_sources
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

