"""Generate the offline "Cars" research page, cars.html.

It gives each car in CARDATA.DAT its engine, gearbox and front and back tyre, linked to those records' sections on
the sibling engine, gearbox and tyre pages. Inputs, all produced elsewhere and only read here:
  * cars.json from scripts/text_database.py: `records`, `references` and the CARDATA.DAT path and SHA-256; and
    engines.json, gearboxes.json and tyres.json, whose records the references are resolved against again.
  * CARDATA.DAT itself, under the extracted game directory, whose SHA-256 must match cars.json. The page shows every
    declaration exactly as written there (0.2 and 0.20 stay distinct), which the parsed numbers no longer record; each
    written token must parse to the value cars.json holds.
  * analysis/selected/field-evidence.json and analysis/tags.json: the byte-checked sites and tag registry IDs from
    which car_reference_bases() decides each reference's basis.
  * analysis/selected/*.asm: the disassembly files the page links, under evidence/ in the research directory.
  * analysis/pe-metadata.json: the executable's identity.
  * analysis/game-file-manifest.json, whose CARDATA.DAT SHA-256 says whether it is the demo's.

The page has:
  * a summary table, one row per car in CARDATA.DAT order, naming the four records it references, each linked to its
    section on engines.html (engine-<name>), gearboxes.html (gearbox-<name>) or tyres.html (tyre-<name>);
  * a "How the car loader resolves each reference" table, one row per CAR_REFERENCE_STORES tag with the id
    car-store-<TAG>: its registry ID, the path of compares and jumps that selects its handler, the name read, the
    lookup it calls and the car payload offset it stores the result at (+0x1a8, +0x1ac, +0x1b4, +0x1b8). Each site
    in field-evidence.json links to its row on routines.html (routines.html#site-<va>); a site that is not there is
    shown unlinked and labelled not byte-checked. A row per lookup (car-lookup-<database>) gives the database it
    walks and the disassembly files whose span holds it; none of the lookups is an annotated routine, so their sites
    are linked one by one. The loader's own export, load_car_database.asm, is linked under evidence/ and to its
    section on the routines page;
  * one section per car with the id car-<name>, so a car never shares an id with an engine, gearbox or tyre record
    of the same name: the four references, each with its declaration line, the record it resolves to (linked) and
    the basis cars.json gives it, "resolved by the loader's lookup (byte-checked)" or "declared by name"; then every
    declaration as written, in line order, each row with the id car-<name>-line-<n>, the repeated CAR_PERFORMANCE
    and VALID_LIVERY lines included.

Nothing on the car is interpreted: CAR_PERFORMANCE, CAR_APPROXIMATE_TOP_SPEED, CAR_MODEL_YEAR and the other values are
shown as written, with no units or menu meaning, and the tags that name records of databases nobody parses
(CAR_BODY_TYPE, CAR_BRAKE_TYPE, CAR_SETUP_TYPE, CAR_CONTROL_TYPE and the rest) are shown as declared names, unlinked.

The script refuses to write the page, and exits non-zero, when an input is missing or malformed, when CARDATA.DAT does
not match cars.json or a written token does not parse to the value cars.json holds, when `references` differ from
what text_database.resolve_car_references() gives against the three target databases with the bases the evidence
supports (a dangling or ambiguous reference is refused there, and so is a reference called byte-checked whose sites
are not), when two ids on the page coincide, and, when CARDATA.DAT is the demo's by the game-file manifest (or
`targets` is given), when the car count, the CAR_PERFORMANCE entries per car or the distinct records referenced per
tag differ from the demo's: 55 cars, 6 entries each, CAR_REFERENCE_TARGETS (52 engines, 14 gearboxes, 53 front and
53 back tyres). The page has inline CSS, no JavaScript and no external resources other than the rights-holder
notice's two links. It links engines.html, gearboxes.html, tyres.html and routines.html, so it belongs beside them.
"""
import argparse
from collections import Counter
import hashlib
from pathlib import Path

from dossier_common import (CARS_PAGE, NOTICE_ID, NOTICE_TITLE_ID, ROUTINES_PAGE, STYLE, anchor, car_store_anchor,
                            check_fields, check_pe, e, line_anchor, load_json, page_start, producer_revision,
                            relative_href, site_link)
from record_compare import GAME_MANIFEST, game_file, is_demo
from record_dossier import DATABASES as RECORD_PAGES, check_records
import routine_index
from text_database import (CAR_LOADER_SPAN, CAR_LOOKUPS, CAR_PERFORMANCE_ENTRIES, CAR_RECORD,
                           CAR_RECORD_TAG, CAR_REFERENCE_STORES, CAR_REFERENCE_TARGETS, LOOKUP_SHAPE, REPO_ROOT,
                           car_reference_bases, car_reference_targets, lines_of, load_known_tags, load_tag_ids,
                           parse_cars, require, resolve_car_references)
import tyre_dossier

PAGE = CARS_PAGE
ANALYSIS = REPO_ROOT / "analysis"
FIELD_EVIDENCE = ANALYSIS / "selected/field-evidence.json"
TAGS = ANALYSIS / "tags.json"
SELECTED = ANALYSIS / "selected"
LOADER_ASM = "load_car_database.asm"
DEMO_CARS = 55
# Where each referenced database's records are shown, and the prefix of their section ids there.
TARGET_PAGES = {"engines": (RECORD_PAGES["engines"]["page"], RECORD_PAGES["engines"]["prefix"]),
                "gearboxes": (RECORD_PAGES["gearboxes"]["page"], RECORD_PAGES["gearboxes"]["prefix"]),
                "tyres": (tyre_dossier.PAGE, "tyre")}
TARGET_FILES = {"engines": "ENGDATA.DAT", "gearboxes": "GEARDATA.DAT", "tyres": "TYREDATA.DAT"}
TAG_TITLES = {"CAR_ENGINE_TYPE": "Engine", "CAR_GEARBOX_TYPE": "Gearbox", "CAR_FRONT_TYRE_TYPE": "Front tyre",
              "CAR_BACK_TYRE_TYPE": "Back tyre"}
TAG_COUNTED = {"CAR_ENGINE_TYPE": ("engine", "engines"), "CAR_GEARBOX_TYPE": ("gearbox", "gearboxes"),
               "CAR_FRONT_TYRE_TYPE": ("front tyre", "front tyres"), "CAR_BACK_TYRE_TYPE": ("back tyre", "back tyres")}
# The summary's columns, in the order a reader expects them; every CAR_REFERENCE_STORES tag appears once.
SUMMARY_TAGS = ("CAR_ENGINE_TYPE", "CAR_GEARBOX_TYPE", "CAR_FRONT_TYRE_TYPE", "CAR_BACK_TYRE_TYPE")
FIXED_IDS = ("summary", "how-loaded", "lookups", "cars")
EXTRA_STYLE = ("section.car { border-top: 2px solid #888; margin-top: 2em; }\n"
               ".wide { overflow-x: auto; }\n"
               "dd code { overflow-wrap: anywhere; }\n"
               "@media (max-width: 40em) { body { padding: 0 0.5em; } th, td { padding: 0.2em 0.3em; } }\n")
SCOPE = ("Scope: every value is shown exactly as written in <code>CARDATA.DAT</code>, on the line that declares it. "
         "The four tags the car loader resolves to another database's record, <code>CAR_ENGINE_TYPE</code>, "
         "<code>CAR_GEARBOX_TYPE</code>, <code>CAR_FRONT_TYRE_TYPE</code> and <code>CAR_BACK_TYRE_TYPE</code>, are "
         "linked to the record they name on the engine, gearbox and tyre pages, matched as the loader's lookups "
         "compare names (equal once A&ndash;Z are lower-cased), and labelled with their basis: <em>resolved by the "
         "loader's lookup (byte-checked)</em> only when every site of that path is in "
         "<code>field-evidence.json</code>, otherwise <em>declared by name</em>. The other tags that name something, "
         "such as <code>CAR_BODY_TYPE</code>, <code>CAR_BRAKE_TYPE</code>, <code>CAR_SETUP_TYPE</code> and "
         "<code>CAR_CONTROL_TYPE</code>, are shown as declared names and not linked: their databases are not parsed. "
         "<code>CAR_PERFORMANCE</code> (repeated, every occurrence in file order), "
         "<code>CAR_APPROXIMATE_TOP_SPEED</code>, <code>CAR_MODEL_YEAR</code> and the other values are shown as "
         "declared: no units, menu meaning or physics are claimed for any of them, and their stores are not mapped.")


def exact_equal(left, right):
    """Compare parsed JSON values strictly, distinguishing int, float and bool."""
    if type(left) is not type(right):
        return False
    if isinstance(left, list):
        return len(left) == len(right) and all(exact_equal(a, b) for a, b in zip(left, right, strict=True))
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(exact_equal(left[key], right[key]) for key in left)
    return left == right


def check_cars(database, data, known_tags=None):
    """Check cars.json against CARDATA.DAT's bytes; return {car: [(line, tag, written tokens)]} in line order."""
    check_records(database, "cars.json")
    check_fields(database, {"references": dict}, "cars.json")
    require(hashlib.sha256(data).hexdigest() == database["sha256"],
            f"{database['source']} does not match cars.json's SHA-256 (rerun scripts/text_database.py)")
    parsed = parse_cars(data, load_known_tags(TAGS) if known_tags is None else known_tags)
    require(exact_equal(database["records"], parsed),
            f"cars.json records differ from parsing {database['source']} (rerun scripts/text_database.py)")
    lines = dict(lines_of(data))
    written = {}
    for record in parsed:
        items = [(field["line"], tag) for tag, field in record["fields"].items()]
        for tag, fields in record["repeated"].items():
            items.extend((field["line"], tag) for field in fields)
        written[record["type"]] = [(line, tag, lines[line][1:]) for line, tag in sorted(items, key=lambda item: item[0])]
    return written


def check_references(database, targets, bases):
    """Refuse `references` that differ from resolve_car_references() on the target databases with `bases`."""
    expected = resolve_car_references(database["records"], targets, bases)
    differ = sorted(name for name in expected.keys() | database["references"].keys()
                    if expected.get(name) != database["references"].get(name))
    require(not differ, "cars.json references differ from what scripts/text_database.py resolves against the engine, "
                        "gearbox and tyre databases with the bases field-evidence.json supports, for: "
                        + ", ".join(differ) + " (rerun scripts/text_database.py)")
    return expected


def check_demo_counts(database, references, targets):
    """Refuse a demo CARDATA.DAT whose cars, CAR_PERFORMANCE entries or referenced records differ from the demo's."""
    records = database["records"]
    require(len(records) == DEMO_CARS, f"Car record count mismatch: {len(records)}, the demo has {DEMO_CARS}")
    performance = sorted({len(record["repeated"].get("CAR_PERFORMANCE", [])) for record in records})
    require(performance == [CAR_PERFORMANCE_ENTRIES], f"CAR_PERFORMANCE entries per car mismatch: {performance}, the "
                                                      f"demo has {CAR_PERFORMANCE_ENTRIES}")
    found = car_reference_targets(references)
    require(found == targets, f"Car reference target counts mismatch: {found}, expected {targets}")


def store_anchor(tag):
    """The id of the tag's row in the "How the car loader resolves each reference" table."""
    return car_store_anchor(tag)


def lookup_anchor(database):
    return anchor("car", "lookup", database)


def site_html(va, checked):
    """A site linked to its row on routines.html when it is byte-checked; otherwise shown and labelled."""
    number = int(va, 16)
    if number in checked:
        return site_link(number)
    return f'<code>{e(va)}</code> (<span class="label">not byte-checked</span>)'


def select_html(path, checked):
    steps = []
    for step in path:
        if "compare" in step:
            steps.append(f"compare {site_html(step['compare'], checked)}")
        else:
            steps.append(f"jump {site_html(step['jump'], checked)} {'taken' if step['taken'] else 'not taken'}")
    return ", ".join(steps)


def store_section(bases, checked):
    """The table of how the loader resolves each reference, one row (car-store-<TAG>) per CAR_REFERENCE_STORES tag."""
    rows = []
    for tag in SUMMARY_TAGS:
        entry = CAR_REFERENCE_STORES[tag]
        read, lookup = entry["read"], entry["lookup"]
        reads = ", ".join(site_html(read[key], checked) for key in ("size", "buffer", "call"))
        rows.append(f'<tr id="{e(store_anchor(tag))}"><td><code>{e(tag)}</code></td>'
                    f'<td><code>0x{entry["id"]:02x}</code></td><td>{select_html(entry["select"], checked)}</td>'
                    f"<td>{reads}</td>"
                    f'<td><a href="#{e(lookup_anchor(entry["database"]))}"><code>{e(lookup["target"])}</code></a> '
                    f'({e(entry["database"])}), called at {site_html(lookup["call"], checked)}</td>'
                    f'<td><code>+ {e(entry["offset"])}</code>, stored at {site_html(entry["store"], checked)}</td>'
                    f'<td><span class="label">{e(bases[tag])}</span></td></tr>')
    return ("<table><tr><th>Tag</th><th>Registry ID</th><th>Path to its handler</th><th>Name read (size, buffer, "
            "call)</th><th>Lookup</th><th>Car payload offset</th><th>Basis</th></tr>" + "".join(rows) + "</table>")


def lookup_section(files, hrefs, checked):
    """One row (car-lookup-<database>) per lookup a reference calls: its database and its byte-checked sites."""
    rows = []
    for database in sorted({entry["database"] for entry in CAR_REFERENCE_STORES.values()}):
        entry = CAR_LOOKUPS[database]
        routine = int(entry["routine"], 16)
        holders = [item for item in files if item["start"] <= routine < item["end"]]
        require(holders, f"No disassembly file's export span holds the {database} lookup at {entry['routine']}")
        held = ", ".join(f'<a href="{e(hrefs[item["name"]])}"><code>{e(item["name"])}</code></a>' for item in holders)
        sites = ", ".join(site_html(f"0x{routine + offset:08x}", checked) for offset in sorted(LOOKUP_SHAPE))
        page, _ = TARGET_PAGES[database]
        rows.append(f'<tr id="{e(lookup_anchor(database))}"><td><code>{e(entry["routine"])}</code></td>'
                    f'<td><a href="{e(page)}">{e(database)}</a>, database at <code>{e(entry["database"])}</code></td>'
                    f"<td>{held}</td><td>{sites}</td></tr>")
    return ("<table><tr><th>Lookup</th><th>Database it walks</th><th>Disassembly</th><th>Byte-checked sites</th></tr>"
            + "".join(rows) + "</table>")


def target_link(reference):
    page, prefix = TARGET_PAGES[reference["database"]]
    return f'<a href="{e(page)}#{e(anchor(prefix, reference["target"]))}">{e(reference["target"])}</a>'


def references_table(name, references):
    rows = []
    for tag in SUMMARY_TAGS:
        reference = references[tag]
        match = "" if reference["match"] == "exact" else " (matches ignoring case, as the lookup compares)"
        rows.append(f'<tr><td><a href="#{e(store_anchor(tag))}"><code>{e(tag)}</code></a></td>'
                    f'<td><a href="#{e(line_anchor("car", name, reference["line"]))}">line {e(reference["line"])}</a>: '
                    f'<code>{e(reference["name"])}</code></td>'
                    f'<td>{target_link(reference)}{match}, line {e(reference["target_line"])} of '
                    f'<code>{e(TARGET_FILES[reference["database"]])}</code></td>'
                    f'<td><code>+ {e(reference["record_offset"])}</code></td>'
                    f'<td><span class="label">{e(reference["basis"])}</span></td></tr>')
    return ("<table><tr><th>Tag</th><th>Declared</th><th>Record</th><th>Car payload offset</th><th>Basis</th></tr>"
            + "".join(rows) + "</table>")


def declarations_table(name, rows):
    body = "".join(f'<tr id="{e(line_anchor("car", name, line))}"><td>{e(line)}</td><td><code>:{e(tag)}</code></td>'
                   f'<td><code>{e(" ".join(tokens))}</code></td></tr>' for line, tag, tokens in rows)
    return f"<table><tr><th>Line</th><th>Tag</th><th>Values, as written</th></tr>{body}</table>"


def check_anchors(database, written):
    """Every id on the page must be unique; refuse otherwise."""
    ids = [NOTICE_ID, NOTICE_TITLE_ID, *FIXED_IDS, *(store_anchor(tag) for tag in CAR_REFERENCE_STORES),
           *(lookup_anchor(name) for name in {entry["database"] for entry in CAR_REFERENCE_STORES.values()})]
    for record in database["records"]:
        ids.append(anchor("car", record["type"]))
        ids.extend(line_anchor("car", record["type"], line) for line, _, _ in written[record["type"]])
    repeated = sorted(key for key, count in Counter(ids).items() if count > 1)
    require(not repeated, "These page anchors are not unique: " + ", ".join(repeated))


def render(database, written, references, bases, checked, files, hrefs, pe, revision, counts_checked, entrance=False):
    """Return the page. The inputs must have passed the checks in build() first."""
    records = database["records"]
    targets = car_reference_targets(references)
    loader = (f'<a href="{e(hrefs[LOADER_ASM])}"><code>{e(LOADER_ASM)}</code></a> (export span '
              f"<code>0x{CAR_LOADER_SPAN[0]:08x}</code>..<code>0x{CAR_LOADER_SPAN[1]:08x}</code>; "
              f'<a href="{e(ROUTINES_PAGE)}#{e(routine_index.file_anchor(LOADER_ASM))}">its byte-checked sites</a> '
              "on the routines page)")
    record_sites = "; ".join(f"{role} {', '.join(site_html(va, checked) for va in vas)}" for role, vas in (
        ("database allocation", (CAR_RECORD["allocation"]["size"], CAR_RECORD["allocation"]["call"])),
        ("file name", (CAR_RECORD["file"]["site"],)), ("database store", (CAR_RECORD["database"]["site"],)),
        ("node allocation and link", (CAR_RECORD["allocate"], CAR_RECORD["node_in_ecx"], CAR_RECORD["link"])),
        ("payload", (CAR_RECORD["payload_in_esi"],)), ("name read", tuple(CAR_RECORD["name"].values()))))
    record_select = select_html(CAR_RECORD["select"], checked)
    counted = ", ".join(f"{targets[tag]} {TAG_COUNTED[tag][targets[tag] != 1]}" for tag in SUMMARY_TAGS)
    check = (f"These counts, the {DEMO_CARS} cars and their {CAR_PERFORMANCE_ENTRIES} <code>:CAR_PERFORMANCE</code> "
             "lines each are checked against the demo's when the page is built."
             if counts_checked else "This is not the demo's <code>CARDATA.DAT</code>, so its counts are not checked.")
    parts = [page_start("Ford Racing 3 demo cars", PAGE, STYLE + EXTRA_STYLE, entrance),
             "<h1>Ford Racing 3 demo: cars</h1><dl>",
             f'<dt>Executable</dt><dd><code>{e(pe.get("file", "fr3.exe"))}</code> SHA-256 <code>{e(pe["sha256"])}</code>, '
             f'PE timestamp {e(pe.get("timestamp_header_utc", "unknown"))}</dd>',
             f'<dt>Car database</dt><dd><code>{e(database["source"])}</code> SHA-256 <code>{e(database["sha256"])}</code></dd>',
             f'<dt>Producer revision</dt><dd><code>{e(revision)}</code> (<code>scripts/car_page.py</code>)</dd>',
             f"<dt>Cars</dt><dd>{len(records)}</dd>",
             f"<dt>Records referenced</dt><dd>{counted}. {check}</dd>",
             f"<dt>Loaded by</dt><dd>the car loader at <code>0x{CAR_LOADER_SPAN[0]:08x}</code>, {loader}</dd></dl>",
             f'<p class="scope">{SCOPE}</p>',
             '<h2 id="summary">Summary</h2><div class="wide"><table><tr><th>Car</th><th>Line</th>'
             + "".join(f"<th>{e(TAG_TITLES[tag])}</th>" for tag in SUMMARY_TAGS) + "</tr>"]
    for record in records:
        name = record["type"]
        parts.append(f'<tr><td><a href="#{e(anchor("car", name))}">{e(name)}</a></td><td>{e(record["line"])}</td>'
                     + "".join(f"<td>{target_link(references[name][tag])}</td>" for tag in SUMMARY_TAGS) + "</tr>")
    parts.append("</table></div>")
    parts.append('<h2 id="how-loaded">How the car loader resolves each reference</h2>'
                 f"<p>The loader creates the car database with a <code>0x1bc</code>-byte payload per record. Each "
                 f"<code>:{e(CAR_RECORD_TAG)}</code> line, selected by {record_select}, allocates and links a record "
                 f"and reads its name into payload <code>+ 0x03</code> ({record_sites}). Each reference tag's "
                 "handler reads a name into a <code>0x40</code>-byte buffer, passes it to the lookup of its database "
                 "and stores the record the lookup returns at a dword in the car payload. Sites link to their rows on "
                 "the routines page; analyst labels there are not original symbols.</p>"
                 f'<div class="wide">{store_section(bases, checked)}</div>'
                 '<h3 id="lookups">Lookups</h3><p>Each lookup walks its database\'s record list and returns the first '
                 "record whose name equals the one read, ignoring the case of A&ndash;Z, or 0. Which record comes first "
                 "is not established, so a name that matches two records refuses the build.</p>"
                 f'<div class="wide">{lookup_section(files, hrefs, checked)}</div>')
    parts.append('<h2 id="cars">Cars</h2>')
    for record in records:
        name = record["type"]
        parts.append(f'<section class="car" id="{e(anchor("car", name))}"><h3>{e(name)}</h3>'
                     f'<p>Declared at line {e(record["line"])} of <code>{e(database["source"])}</code>.</p>'
                     f'<h4>Records it references</h4><div class="wide">{references_table(name, references[name])}</div>'
                     "<h4>Declarations, as written</h4><p>Every line in file order, repeated tags included; no units "
                     f'or menu meaning are claimed.</p><div class="wide">{declarations_table(name, written[name])}</div>'
                     "</section>")
    parts.append("</body></html>\n")
    return "\n".join(parts)


def default_hrefs(output, selected=SELECTED):
    return {path.name: relative_href(path.resolve(), output) for path in Path(selected).glob("*.asm")}


def build(cars_path, engines_path, gearboxes_path, tyres_path, game_dir, pe_path, output, revision=None, hrefs=None,
          entrance=False, evidence_path=FIELD_EVIDENCE, tags_path=TAGS, selected=SELECTED,
          manifest_path=GAME_MANIFEST, targets=None):
    """Read and check the inputs, then write the page to `output`; return the number of cars.

    game_dir is the extracted Program_Executable_Files directory holding the CARDATA.DAT cars.json was parsed from.
    hrefs maps each .asm file name under `selected` to its href from the page (by default a relative path to it).
    The distinct records referenced per tag must equal `targets` when it is given, else CAR_REFERENCE_TARGETS (with
    55 cars of 6 CAR_PERFORMANCE lines each) when CARDATA.DAT is the demo's by manifest_path's SHA-256.
    entrance=True adds the entrance page to the nav bar, for scripts/build_research.py.
    """
    database = load_json(cars_path, "Car database (run scripts/text_database.py first)")
    target_databases = {"engines": load_json(engines_path, "Engine database (run scripts/text_database.py first)"),
                        "gearboxes": load_json(gearboxes_path, "Gearbox database (run scripts/text_database.py first)"),
                        "tyres": load_json(tyres_path, "Tyre database (run scripts/text_database.py first)")}
    pe = load_json(pe_path, "PE metadata")
    check_pe(pe)
    for stem, target in target_databases.items():
        check_records(target, f"{stem}.json")
    written = check_cars(database, game_file(database, "cars.json", game_dir), known_tags=load_known_tags(tags_path))
    evidence = load_json(evidence_path, "Field evidence (analysis/selected/field-evidence.json)")
    tyre_dossier.check_evidence(evidence)
    bases = car_reference_bases(evidence, load_tag_ids(tags_path))
    references = check_references(database, {stem: target["records"] for stem, target in target_databases.items()},
                                  bases)
    expected = targets if targets is not None else (CAR_REFERENCE_TARGETS if is_demo(database, manifest_path) else None)
    if expected is not None:
        check_demo_counts(database, references, expected)
    check_anchors(database, written)
    files = routine_index.disassembly_files(selected)
    hrefs = default_hrefs(output, selected) if hrefs is None else hrefs
    require(LOADER_ASM in {item["name"] for item in files}, f"{selected} has no {LOADER_ASM}")
    missing = sorted({item["name"] for item in files} - set(hrefs))
    require(not missing, "No href for these disassembly files: " + ", ".join(missing))
    checked = {site["va"] for site in evidence}
    page = render(database, written, references, bases, checked, files, hrefs, pe, revision or producer_revision(),
                  expected is not None, entrance)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text(page, encoding="utf-8")
    return len(database["records"])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    databases = REPO_ROOT / "artifacts/text-databases"
    for stem in ("cars", "engines", "gearboxes", "tyres"):
        parser.add_argument(f"--{stem}", type=Path, default=databases / f"{stem}.json",
                            help=f"{stem}.json written by scripts/text_database.py (default: %(default)s)")
    parser.add_argument("--game", type=Path, default=REPO_ROOT / "inputs/extracted/Program_Executable_Files",
                        help="Extracted Program_Executable_Files directory (default: %(default)s)")
    parser.add_argument("--pe", type=Path, default=ANALYSIS / "pe-metadata.json",
                        help="fr3.exe identity (default: %(default)s)")
    parser.add_argument("--evidence", type=Path, default=FIELD_EVIDENCE,
                        help="Byte-checked sites the page links to on routines.html (default: %(default)s)")
    parser.add_argument("--tags", type=Path, default=TAGS, help="Tag registry (default: %(default)s)")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "artifacts/dossier" / PAGE,
                        help="Page to write, next to engines.html, gearboxes.html, tyres.html and routines.html; keep "
                             "it out of Git, it holds game data (default: %(default)s)")
    args = parser.parse_args()
    try:
        count = build(args.cars, args.engines, args.gearboxes, args.tyres, args.game, args.pe, args.output,
                      evidence_path=args.evidence, tags_path=args.tags)
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        raise SystemExit(f"car_page.py: {error}") from None
    print(f"Wrote {count} cars to {args.output}")


if __name__ == "__main__":
    main()
