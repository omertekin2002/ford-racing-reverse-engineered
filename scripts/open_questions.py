"""Generate an offline "Open questions" page for three findings the research edition labels unresolved.

The questions, each with its own anchored section:
  * #indigo: the colon-less `INHERIT_TYPE DEFAULT_TRACK` line in engine INDIGO (ENGDATA.DAT);
  * #sound-words: the words of the tyre sound table at record +0x54 that come before its START_RPM values;
  * #pcg-extra-bytes: the extra bytes past the declared payload of `_loadbar` and `_loadbr2`.

Inputs, all produced elsewhere and only read here:
  * engines.json and tyres.json from scripts/text_database.py: records, untagged lines, :SOUND_INFO entries and the
    resolved table sources.
  * analysis/selected/field-evidence.json: the byte-checked sound table allocation size and +0x54 store.
  * analysis/selected/load_tyre_database.asm, load_engine_database.asm, copy_engine_record.asm and
    build_pcg_view.asm: export spans, the loader's indexed stores into the sound table and the engine loader's call
    of the copy routine.
  * analysis/pcg-index.json: each graphic's span, extra bytes and 32 header words.
  * analysis/pe-metadata.json: the executable's identity.

The output is one static HTML file, artifacts/dossier/questions.html by default, with inline CSS, no JavaScript and
no external resources. Each section has four parts: what was observed (every value read from the inputs above at
build time), why it matters (the places on the other research pages that stay unresolved because of it), possible
readings (only the alternatives the observations leave open, each labelled untested and none ranked) and what would
decide it. The page resolves nothing and assigns no meaning to the unknown line, words or bytes.

The script refuses to write the page, and exits non-zero, when an input is missing or malformed or no longer shows
the question: INDIGO is missing, has no untagged line, more than one, or one whose tokens are not
`INHERIT_TYPE DEFAULT_TRACK`; DEFAULT_TRACK is not a record; field-evidence.json lacks the sound table's allocation
size or its +0x54 store; the tyre loader's indexed stores into the sound table are not at exactly two offsets that
split the allocation into an unknown block, a START_RPM block of the same size and whole value rows; no tyre declares
:SOUND_INFO; the graphics with extra bytes are not exactly `_loadbar` and `_loadbr2`, 1,024 bytes each, in one
collection; an .asm file lacks its span header; or the PE metadata has no sha256.
"""
import argparse
from pathlib import Path
import re

from dossier_common import (INDIGO_ANCHOR, INDIGO_RECORD, INDIGO_TOKENS, PCG_ANCHOR, PCG_QUESTION_ENTRIES,
                            PCG_QUESTION_EXTRA, QUESTIONS_PAGE, SOUND_ANCHOR, SOUND_NOTE_ID, STYLE, anchor, check_pe, e,
                            load_json, page_start, producer_revision, relative_href)
import pcg_catalogue
from record_dossier import DATABASES, check_records
from routine_index import ASM_HEADER
from text_database import REPO_ROOT, TYRE_TABLE_ACCESSORS, require, table_sources
import tyre_dossier

PAGE = QUESTIONS_PAGE
ANALYSIS = REPO_ROOT / "analysis"
SELECTED = ANALYSIS / "selected"
FIELD_EVIDENCE = SELECTED / "field-evidence.json"
PCG_INDEX = ANALYSIS / "pcg-index.json"
PE_METADATA = ANALYSIS / "pe-metadata.json"
# The committed disassembly each section reads or links, by the hrefs key the page uses.
ASM = {"tyre_loader": "load_tyre_database.asm", "engine_loader": "load_engine_database.asm",
       "engine_copy": "copy_engine_record.asm", "pcg_view": "build_pcg_view.asm"}
# The page's links to its inputs, by key, as paths under analysis/; scripts/build_research.py copies them to evidence/.
EVIDENCE = {"evidence": FIELD_EVIDENCE.relative_to(ANALYSIS), "pcg_index": PCG_INDEX.relative_to(ANALYSIS),
            **{key: (SELECTED / name).relative_to(ANALYSIS) for key, name in ASM.items()}}
SOUND = "sound_info"
SOUND_OFFSET = int(TYRE_TABLE_ACCESSORS[SOUND]["record_offset"], 16)
ASM_LINE = re.compile(r"([0-9a-f]{8}) ([0-9a-f]+) +(.*)")
# An indexed dword store, `fstp dword ptr [base + index*4 + disp]` or `mov dword ptr [base + index*4 + disp], reg`.
INDEXED_STORE = re.compile(r"(?:fstp|mov) dword ptr \[\w+ \+ \w+\*4 \+ (0x[0-9a-f]+)\]")
# A load of the sound table address from the tyre record: `mov reg, dword ptr [reg + 0x54]`.
TABLE_LOAD = re.compile(rf"mov \w+, dword ptr \[\w+ \+ 0x{SOUND_OFFSET:x}\]")
# How many instructions before an indexed store the table address must have been loaded.
LOAD_WINDOW = 3
SECTIONS = ((INDIGO_ANCHOR, "Engine INDIGO's colon-less INHERIT_TYPE line"),
            (SOUND_ANCHOR, "The tyre sound table's leading words"),
            (PCG_ANCHOR, "The extra bytes after _loadbar and _loadbr2"))
EXTRA_STYLE = """section.question { border-top: 2px solid #888; margin-top: 2em; }
td.differs { background: #fde8e8; font-weight: bold; }
table.words td { border-color: #e2e2e2; padding: 0 0.4em; white-space: nowrap; }
"""


def disassembly(path):
    """Read one committed .asm file; return (label, start, end, [(va, bytes hex, instruction)]) within its span."""
    require(Path(path).is_file(), f"Disassembly not found: {path}")
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    header = ASM_HEADER.fullmatch(lines[0]) if lines else None
    require(header, f"{Path(path).name} does not start with a `; Analyst label: <name>; export span "
                    "0x<start>..0x<end>` header")
    label, start, end = header[1], int(header[2], 16), int(header[3], 16)
    instructions = []
    for line in lines[1:]:
        match = ASM_LINE.fullmatch(line.rstrip())
        if match and start <= int(match[1], 16) < end:
            instructions.append((int(match[1], 16), match[2], match[3].strip()))
    require(instructions, f"{Path(path).name} has no instructions inside its export span")
    return label, start, end, instructions


def check_indigo(engines):
    """Return the INDIGO case: its record, its untagged line, the parent it names and the records that name it."""
    check_records(engines, "engines.json")
    by_name = {record["type"]: record for record in engines["records"]}
    require(INDIGO_RECORD in by_name, f"engines.json has no {INDIGO_RECORD} record; the open question no longer exists")
    record = by_name[INDIGO_RECORD]
    untagged = record.get("untagged", [])
    require(untagged, f"{INDIGO_RECORD} has no untagged line; the open question no longer exists")
    require(len(untagged) == 1, f"{INDIGO_RECORD} has {len(untagged)} untagged lines; the page describes exactly one")
    tokens = tuple(untagged[0]["tokens"])
    require(tokens == INDIGO_TOKENS, f"{INDIGO_RECORD}'s untagged line {' '.join(tokens)!r} on line "
                                     f"{untagged[0]['line']} is not {' '.join(INDIGO_TOKENS)!r}")
    parent = tokens[-1]
    require(parent in by_name, f"{INDIGO_RECORD}'s untagged line names {parent!r}, which is not an engine record")
    children = [(item["type"], item["fields"]["INHERIT_TYPE"]["line"]) for item in engines["records"]
                if item["fields"].get("INHERIT_TYPE", {}).get("values") == [parent]]
    return {"record": record, "line": untagged[0], "parent": by_name[parent], "children": children}


def immediate(site):
    """Return the imm32 of a byte-checked `mov r32, imm32` site, else None."""
    raw = bytes.fromhex(site["bytes"])
    return int.from_bytes(raw[1:5], "little") if len(raw) == 5 and 0xB8 <= raw[0] <= 0xBF else None


def check_sound(tyres, evidence, tyre_loader):
    """Return the sound-words case: the byte-checked sites, the loader's table stores and the implied layout."""
    tyre_dossier.check_input_shapes(tyres)
    tyre_dossier.check_evidence(evidence)
    start, end = tyre_dossier.LOADER_SPAN
    allocation_va = tyre_dossier.LOADER_ALLOCATIONS[SOUND]
    allocation = next((site for site in evidence if site["va"] == allocation_va), None)
    require(allocation and immediate(allocation),
            f"field-evidence.json has no byte-checked `mov r32, imm32` sound table allocation size at 0x{allocation_va:08x}")
    size = immediate(allocation)
    stores = []
    for site in evidence:
        raw = bytes.fromhex(site["bytes"])
        operand = tyre_dossier.modrm_disp8(raw)
        if start <= site["va"] < end and raw[0] == 0x89 and operand and operand[1] == SOUND_OFFSET:
            stores.append(site)
    require(stores, f"field-evidence.json has no byte-checked tyre loader store of the sound table address at "
                    f"+ 0x{SOUND_OFFSET:02x}")
    label, asm_start, asm_end, instructions = tyre_loader
    require((asm_start, asm_end) == (start, end), f"{label}.asm spans 0x{asm_start:08x}..0x{asm_end:08x}, not the "
                                                  f"tyre loader's 0x{start:08x}..0x{end:08x}")
    table_stores = []
    for i, (va, raw, text) in enumerate(instructions):
        match = INDEXED_STORE.match(text)
        if match and any(TABLE_LOAD.match(before) for _, _, before in instructions[max(0, i - LOAD_WINDOW):i]):
            table_stores.append({"va": va, "bytes": raw, "text": text, "offset": int(match[1], 16)})
    offsets = sorted({store["offset"] for store in table_stores})
    require(len(offsets) == 2, f"{label}.asm stores into the sound table at {len(offsets)} indexed offsets "
                               f"({', '.join(f'+0x{offset:x}' for offset in offsets) or 'none'}), not two: the "
                               "layout this page describes no longer holds")
    rpm, values = offsets
    words = rpm // 4
    require(rpm % 4 == 0 and values - rpm == rpm and values < size and (size - values) % (4 * words) == 0,
            f"Sound table stores at +0x{rpm:x} and +0x{values:x} do not split the 0x{size:x}-byte allocation into "
            "an unknown block, a START_RPM block of the same size and whole value rows")
    records = [record for record in tyres["records"] if record.get("sound_info")]
    require(records, "No tyre record declares :SOUND_INFO; the open question no longer has a table to describe")
    return {"allocation": allocation, "stores": stores, "table_stores": table_stores, "size": size, "rpm": rpm,
            "values": values, "words": words, "per_type": (size - values) // 4 // words, "records": records,
            "sources": table_sources(tyres["resolved_tables"])[SOUND],
            "tyres": len(tyres["records"])}


def check_pcg(collections):
    """Return the PCG case: the collection holding the two graphics with extra bytes, and those graphics."""
    require(isinstance(collections, list) and collections, "pcg-index.json must be a non-empty list")
    extra = []
    for i, collection in enumerate(collections):
        where = f"pcg-index.json[{i}]"
        pcg_catalogue.check_ints(collection, pcg_catalogue.COLLECTION_FIELDS, where)
        for j, entry in enumerate(collection["entries"]):
            pcg_catalogue.check_entry(entry, j, f"{where}.entries[{j}]")
            if entry["extra_bytes"]:
                extra.append((collection, entry))
    found = ", ".join(f"{entry['name']!r} ({entry['extra_bytes']} bytes, {collection['path']})"
                      for collection, entry in extra) or "none"
    require(sorted(entry["name"] for _, entry in extra) == sorted(PCG_QUESTION_ENTRIES),
            f"The graphics with extra bytes are {found}, not {' and '.join(PCG_QUESTION_ENTRIES)}; "
            "the open question no longer matches")
    require(all(entry["extra_bytes"] == PCG_QUESTION_EXTRA for _, entry in extra),
            f"The graphics with extra bytes are {found}, not {PCG_QUESTION_EXTRA} bytes each")
    require(len({id(collection) for collection, _ in extra}) == 1,
            f"The graphics with extra bytes are {found}, not in one collection")
    return {"collection": extra[0][0], "entries": [entry for _, entry in extra]}


def check_engine_call(engine_loader, engine_copy):
    """Return the engine loader's calls of the copy routine, as (va, instruction); refuse if there is none."""
    label, _, _, instructions = engine_loader
    copy_label, copy_start, _, _ = engine_copy
    calls = [(va, text) for va, _, text in instructions if text == f"call 0x{copy_start:x}"]
    require(calls, f"{label}.asm has no call of {copy_label} at 0x{copy_start:08x}")
    return calls


def num(value):
    return f'<span class="num">{e(value)}</span>'


def asm_link(hrefs, key):
    return f'<a href="{e(hrefs[key])}"><code>{e(Path(hrefs[key]).name)}</code></a>'


def untested(items):
    return "<ul>" + "".join(f'<li><span class="label">untested</span>: {item}</li>' for item in items) + "</ul>"


def section(anchor_id, title, observed, matters, readings, decide):
    return (f'<section class="question" id="{e(anchor_id)}"><h2>{e(title)}</h2>'
            f'<h3 id="{e(anchor_id)}-observed">Observed</h3>{observed}'
            f'<h3 id="{e(anchor_id)}-matters">Why it matters</h3>{matters}'
            f'<h3 id="{e(anchor_id)}-readings">Possible readings</h3>'
            "<p>Only the alternatives the observations leave open. None is tested, ranked or preferred here.</p>"
            f'{untested(readings)}<h3 id="{e(anchor_id)}-decide">What would decide it</h3>{decide}</section>')


def engine_link(name, text=None):
    return f'<a href="{e(DATABASES["engines"]["page"])}#{e(anchor("engine", name))}">{e(text or name)}</a>'


def indigo_section(case, engines, hrefs, calls, engine_loader, engine_copy):
    record, line, parent = case["record"], case["line"], case["parent"]
    name, parent_name = record["type"], parent["type"]
    own = list(record["fields"])
    missing = [tag for tag in parent["fields"] if tag not in record["fields"]]
    inherit = record["fields"].get("INHERIT_TYPE")
    own_inherit = (f"names {engine_link(inherit['values'][0])} on line {e(inherit['line'])}" if inherit
                   else "none")
    children = ", ".join(f"{engine_link(child)} (line {e(at)})" for child, at in case["children"]) or "none"
    tags = ", ".join(f"<code>{e(tag)}</code>" for tag in own) or "none"
    observed = (f'<dl><dt>Engine database</dt><dd><code>{e(engines["source"])}</code> SHA-256 '
                f'<code>{e(engines["sha256"])}</code></dd>'
                f'<dt>Record</dt><dd>{engine_link(name)}, declared on line {e(record["line"])}</dd>'
                f'<dt>Untagged line</dt><dd>line {e(line["line"])}: <code>{e(" ".join(line["tokens"]))}</code> '
                f'({len(line["tokens"])} tokens, the first without a leading colon)</dd>'
                f"<dt>{e(name)}'s own declarations</dt><dd>{tags}</dd>"
                f"<dt>{e(name)}'s own <code>:INHERIT_TYPE</code></dt><dd>{own_inherit}</dd>"
                f'<dt>Record named by the line</dt><dd>{engine_link(parent_name)}, declared on line '
                f'{e(parent["line"])} with {len(parent["fields"])} tags</dd>'
                f'<dt>Records whose <code>:INHERIT_TYPE</code> names {e(parent_name)}</dt><dd>{children}</dd></dl>')
    missing_tags = ", ".join(f"<code>{e(tag)}</code>" for tag in missing) or "none"
    matters = (f'<ul><li>{engine_link(name, "The engine page")} keeps line {e(line["line"])} verbatim, labelled '
               "unresolved, and does not apply it: it shows only the record's own declarations.</li>"
               f"<li>{e(parent_name)} declares {len(missing)} tags that {e(name)} does not: {missing_tags}. Which values "
               f"{e(name)} ends up with for them depends on the answer: zero-filled if the line is ignored, or "
               f"{e(parent_name)}'s effective values if it is applied. {engine_link(name, 'The engine page')} lists "
               "both readings for each tag.</li></ul>")
    readings = (f"The engine loader skips or ignores the line, so {e(name)} keeps only its own declarations.",
                f"The engine loader applies the line as inheritance, giving {e(name)} {e(parent_name)} as its parent.")
    call_text = ", ".join(f"<code>0x{va:08x}</code>" for va, _ in calls)
    decide = (f"<ul><li>How the engine loader, {e(engine_loader[0])} at <code>0x{engine_loader[1]:08x}</code> "
              f"({asm_link(hrefs, 'engine_loader')}), and the tag reader it calls treat a line whose first token has "
              "no colon: whether such a token reaches the branch that handles <code>:INHERIT_TYPE</code> or is "
              f"skipped. The loader calls {e(engine_copy[0])} (<code>0x{engine_copy[1]:08x}</code>, "
              f"{asm_link(hrefs, 'engine_copy')}) at {call_text}.</li>"
              f"<li>A comparison of {e(name)}'s loaded engine record with {e(parent_name)}'s, for the tags "
              f"{e(name)} does not declare.</li></ul>")
    return section(INDIGO_ANCHOR, SECTIONS[0][1], observed, matters, readings, decide)


def site_rows(sites):
    return "".join(f'<tr><td><code>0x{site["va"]:08x}</code></td><td><code>{e(site["bytes"])}</code></td>'
                   f'<td>{e(site["claim"])}</td></tr>' for site in sites)


def sound_section(case, tyres, hrefs, exe_sha256):
    words, rpm, values, size = case["words"], case["rpm"], case["values"], case["size"]
    value_words = (size - values) // 4
    stores = "".join(f'<tr><td><code>0x{store["va"]:08x}</code></td><td><code>{e(store["bytes"])}</code></td>'
                     f'<td><code>{e(store["text"])}</code></td><td><code>+0x{store["offset"]:x}</code></td></tr>'
                     for store in case["table_stores"])
    counts = "".join(f'<tr><td><a href="tyres.html#{e(anchor("tyre", record["type"]))}">{e(record["type"])}</a></td>'
                     f'<td>{e(record["sound_info"][0]["line"])}</td><td>{num(len(record["sound_info"]))}</td></tr>'
                     for record in case["records"])
    observed = (f"<p>Byte-checked against <code>fr3.exe</code> SHA-256 <code>{e(exe_sha256)}</code> "
                f'(<a href="{e(hrefs["evidence"])}">{e(Path(hrefs["evidence"]).name)}</a>):</p>'
                f'<table><tr><th>VA</th><th>Bytes</th><th>Claim</th></tr>'
                f'{site_rows([case["allocation"], *case["stores"]])}</table>'
                f"<p>The tyre loader's indexed stores into the table, read from {asm_link(hrefs, 'tyre_loader')} "
                f"(each within {LOAD_WINDOW} instructions of loading the table address from record "
                f"<code>+0x{SOUND_OFFSET:x}</code>):</p>"
                f"<table><tr><th>VA</th><th>Bytes</th><th>Instruction</th><th>Offset</th></tr>{stores}</table>"
                f"<p>The layout these offsets imply, as described in <code>docs/analysis.md</code>:</p>"
                "<table><tr><th>Bytes</th><th>Words</th><th>Content</th></tr>"
                f'<tr><td><code>+0x00</code>&ndash;<code>+0x{rpm - 4:x}</code></td><td>{num(words)}</td>'
                '<td><span class="label">unresolved</span>: no meaning established</td></tr>'
                f'<tr><td><code>+0x{rpm:x}</code>&ndash;<code>+0x{values - 4:x}</code></td><td>{num(words)}</td>'
                "<td><code>START_RPM</code> values</td></tr>"
                f'<tr><td><code>+0x{values:x}</code>&ndash;<code>+0x{size - 4:x}</code></td><td>{num(value_words)}</td>'
                f"<td>{num(words)} rows of {num(case['per_type'])} values</td></tr></table>"
                f'<p>Tyre records that declare <code>:SOUND_INFO</code>, in <code>{e(tyres["source"])}</code> SHA-256 '
                f'<code>{e(tyres["sha256"])}</code>:</p>'
                f"<table><tr><th>Record</th><th>First entry line</th><th><code>:SOUND_INFO</code> entries</th></tr>"
                f"{counts}</table>")
    sources = ", ".join(f'<a href="tyres.html#{e(anchor("tyre", source, SOUND))}">{e(source)}</a> {num(count)}'
                        for source, count in case["sources"].items()) or "none"
    matters = (f"<ul><li>All {num(case['tyres'])} tyre records read their sound table through the accessor at "
               f"<code>{e(TYRE_TABLE_ACCESSORS[SOUND]['accessor'])}</code>; records per source: {sources}.</li>"
               f'<li>The <a href="{e(tyre_dossier.PAGE)}#{e(SOUND_NOTE_ID)}">tyre page</a> shows each '
               "<code>:SOUND_INFO</code> entry as declared and labels the table's leading words unresolved: no page "
               "in the edition shows a value for them.</li></ul>")
    readings = (f"Nothing writes the {e(words)} words once the table is allocated.",
                f"Code outside the tyre loader's committed span writes the {e(words)} words.",
                f"Code reads the {e(words)} words, whatever writes them.",
                f"Nothing reads the {e(words)} words.")
    decide = (f"<ul><li>Every reader of the sound table: the callers of the accessor at "
              f"<code>{e(TYRE_TABLE_ACCESSORS[SOUND]['accessor'])}</code>, and whether any of them reads offsets "
              f"<code>+0x00</code>&ndash;<code>+0x{rpm - 4:x}</code>. None of those callers is committed yet.</li>"
              f"<li>Every write into those offsets: the indexed stores this page finds in the tyre loader "
              f"({asm_link(hrefs, 'tyre_loader')}) are at the offsets listed above, so a cross-reference search for "
              f"other code that writes through the <code>+0x{SOUND_OFFSET:x}</code> table address.</li></ul>")
    return section(SOUND_ANCHOR, SECTIONS[1][1], observed, matters, readings, decide)


def differing_words(collection, entry):
    """Return the header word indexes where `entry` differs from every graphic of its collection with no extra bytes."""
    others = [other for other in collection["entries"] if not other["extra_bytes"]]
    if not others:
        return set()
    return {i for i, word in enumerate(entry["header_words"])
            if all(other["header_words"][i] != word for other in others)}


def pcg_link(collection, entry, text=None):
    return f'<a href="{e(pcg_catalogue.PAGE)}#{e(pcg_catalogue.entry_id(collection, entry))}">{e(text or entry["name"])}</a>'


def pcg_section(case, hrefs, view):
    collection, extra = case["collection"], case["entries"]
    entries = collection["entries"]
    rows = "".join(f'<tr><td>{num(entry["index"])}</td><td>{pcg_link(collection, entry)}</td>'
                   f'<td>{num(entry["file_offset"])}</td><td>{num(entry["width"])} &times; {num(entry["height"])}</td>'
                   f'<td>{num(entry["declared_payload_bytes"])}</td><td>{num(entry["span_bytes"])}</td>'
                   f'<td>{num(entry["extra_bytes"])}</td></tr>' for entry in entries)
    differs = {entry["index"]: differing_words(collection, entry) for entry in extra}
    head = "".join(f"<th><code>{e(entry['name'])}</code></th>" for entry in entries)
    words = []
    for i in range(pcg_catalogue.HEADER_WORDS):
        cells = "".join(f'<td class="num differs">{entry["header_words"][i]} &ne;</td>'
                        if i in differs.get(entry["index"], ()) else f'<td class="num">{entry["header_words"][i]}</td>'
                        for entry in entries)
        meaning = pcg_catalogue.ESTABLISHED_WORDS.get(i, pcg_catalogue.NOT_ESTABLISHED)
        words.append(f'<tr><td class="num">+0x{i * 4:02x}</td>{cells}<td>{e(meaning)}</td></tr>')
    changed = "; ".join(f"<code>{e(entry['name'])}</code>: "
                        + (", ".join(f"<code>+0x{i * 4:02x}</code>" for i in sorted(differs[entry["index"]])) or "none")
                        for entry in extra)
    names = " and ".join(f"<code>{e(entry['name'])}</code>" for entry in extra)
    observed = (f'<p>From <a href="{e(hrefs["pcg_index"])}">{e(Path(hrefs["pcg_index"]).name)}</a>, collection '
                f'<code>{e(collection["path"])}</code> ({num(collection["count"])} graphics, payload base '
                f'{num(collection["payload_base"])}). Of all indexed graphics, only {names} have extra bytes.</p>'
                "<table><tr><th>Index</th><th>Name</th><th>File offset</th><th>Width &times; height</th>"
                "<th>Declared payload bytes</th><th>Span bytes</th><th>Extra bytes</th></tr>" + rows + "</table>"
                f'<p>Header words, all {pcg_catalogue.HEADER_WORDS}. A value marked &ne; differs from that word in every '
                f"graphic of the collection without extra bytes. Words that differ: {changed}.</p>"
                f'<table class="words"><tr><th>Offset</th>{head}<th>Meaning</th></tr>{"".join(words)}</table>')
    labels = " and ".join(pcg_link(collection, entry) for entry in extra)
    matters = (f"<ul><li>The <a href=\"{e(pcg_catalogue.PAGE)}\">PCG catalogue</a> labels the extra bytes of {labels} "
               "unresolved: it counts them, but does not say what they hold or whether they belong to the "
               "graphic.</li><li>Spans run from one graphic to the next in file order, so the extra bytes are counted "
               "with the graphic before them; whether that is how the game reads them is not established.</li></ul>")
    readings = ("The extra bytes are read as part of the graphic before them, beyond its declared payload.",
                "The extra bytes are separate data that sit between graphics and are read on their own.",
                "The game does not read the extra bytes.")
    decide = (f"<ul><li>How many bytes the code that reads a graphic takes from it: the view builder {e(view[0])} at "
              f"<code>0x{view[1]:08x}</code> ({asm_link(hrefs, 'pcg_view')}) and the code that uses its result, "
              "and whether either reads past the header and the declared payload.</li>"
              "<li>Which header words control that read: a comparison of the words marked above with the code that "
              "consumes the graphic header.</li></ul>")
    return section(PCG_ANCHOR, SECTIONS[2][1], observed, matters, readings, decide)


def render(cases, inputs, pe, revision, hrefs, entrance=False):
    """Return the page. The check_*() functions must have accepted every input first."""
    contents = "".join(f'<li><a href="#{e(anchor_id)}">{e(title)}</a></li>' for anchor_id, title in SECTIONS)
    parts = [page_start("Ford Racing 3 demo open questions", PAGE, STYLE + EXTRA_STYLE, entrance),
             "<h1>Ford Racing 3 demo: open questions</h1><dl>",
             f'<dt>Executable</dt><dd><code>{e(pe.get("file", "fr3.exe"))}</code> SHA-256 <code>{e(pe["sha256"])}</code>, '
             f'PE timestamp {e(pe.get("timestamp_header_utc", "unknown"))}</dd>',
             f'<dt>Producer revision</dt><dd><code>{e(revision)}</code> (<code>scripts/open_questions.py</code>)</dd>',
             f"<dt>Questions</dt><dd>{len(SECTIONS)}</dd></dl>",
             '<p class="scope">Scope: three findings the other pages label unresolved. For each, this page shows what '
             "was observed, read from the parsed game files and the committed <code>analysis/</code> files when the "
             "page was built; where the other pages depend on it; the alternatives the observations leave open, each "
             "untested; and what evidence would decide it. It resolves none of them and assigns no meaning to the "
             "unknown line, words or bytes.</p>",
             f"<h2>Questions</h2><ol>{contents}</ol>",
             indigo_section(cases["indigo"], inputs["engines"], hrefs, cases["engine_calls"], inputs["engine_loader"],
                            inputs["engine_copy"]),
             sound_section(cases["sound"], inputs["tyres"], hrefs, pe["sha256"]),
             pcg_section(cases["pcg"], hrefs, inputs["pcg_view"]),
             "</body></html>\n"]
    return "\n".join(parts)


def build(engines_path, tyres_path, evidence_path, index_path, pe_path, output, revision=None, hrefs=None,
          entrance=False, selected=SELECTED):
    """Read and check every input, then write the page; return the number of questions.

    hrefs maps the keys of EVIDENCE to the links the page uses for its inputs; by default they are relative links
    from `output` to the files read. `selected` is the directory holding the .asm files. entrance=True adds the
    entrance page to the nav bar, for scripts/build_research.py.
    """
    selected = Path(selected)
    inputs = {"engines": load_json(engines_path, "Engine database (run scripts/text_database.py first)"),
              "tyres": load_json(tyres_path, "Tyre database (run scripts/text_database.py first)"),
              **{key: disassembly(selected / name) for key, name in ASM.items()}}
    evidence = load_json(evidence_path, "Field evidence")
    collections = load_json(index_path, "PCG index")
    pe = load_json(pe_path, "PE metadata")
    check_pe(pe)
    cases = {"indigo": check_indigo(inputs["engines"]),
             "engine_calls": check_engine_call(inputs["engine_loader"], inputs["engine_copy"]),
             "sound": check_sound(inputs["tyres"], evidence, inputs["tyre_loader"]),
             "pcg": check_pcg(collections)}
    files = {"evidence": Path(evidence_path), "pcg_index": Path(index_path),
             **{key: selected / name for key, name in ASM.items()}}
    hrefs = hrefs or {key: relative_href(path.resolve(), output) for key, path in files.items()}
    page = render(cases, inputs, pe, revision or producer_revision(), hrefs, entrance)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text(page, encoding="utf-8")
    return len(SECTIONS)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engines", type=Path, default=DATABASES["engines"]["input"],
                        help="engines.json written by scripts/text_database.py (default: %(default)s)")
    parser.add_argument("--tyres", type=Path, default=REPO_ROOT / "artifacts/text-databases/tyres.json",
                        help="tyres.json written by scripts/text_database.py (default: %(default)s)")
    parser.add_argument("--evidence", type=Path, default=FIELD_EVIDENCE,
                        help="Byte-checked instruction sites (default: %(default)s)")
    parser.add_argument("--index", type=Path, default=PCG_INDEX,
                        help="PCG index written by scripts/index_pcg.py (default: %(default)s)")
    parser.add_argument("--pe", type=Path, default=PE_METADATA, help="fr3.exe identity (default: %(default)s)")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "artifacts/dossier" / PAGE,
                        help="HTML file to write, next to the other dossier pages; keep it out of Git, it holds game "
                             "data (default: %(default)s)")
    args = parser.parse_args()
    try:
        count = build(args.engines, args.tyres, args.evidence, args.index, args.pe, args.output)
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        raise SystemExit(f"open_questions.py: {error}") from None
    print(f"Wrote {count} open questions to {args.output}")


if __name__ == "__main__":
    main()
