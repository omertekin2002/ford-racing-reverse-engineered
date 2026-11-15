"""Generate an offline HTML index of the analyst-labelled routines, as annotated.

Inputs, all committed under analysis/ and only read here:
  * annotated/status.json from scripts/AnnotateFord.java: each routine's entry VA,
    analyst label, signature, return and parameter storage, and decompile outcome.
  * annotated/selected.c: their Ghidra pseudocode, one block per routine, each
    opening with `/* <entry VA> <label> */`.
  * selected/*.asm from scripts/extract_selected.py: bounded linear disassembly,
    each headed `; Analyst label: <name>; export span 0x<start>..0x<end>`, where
    the span includes start and excludes end.
  * selected/field-evidence.json: instruction sites byte-checked against fr3.exe.
  * pe-metadata.json: the executable's identity.

The output is one static HTML file, artifacts/dossier/routines.html by default,
with inline CSS, no JavaScript and no external resources. It has a summary table
in status.json order and one section per routine, anchored by its label, with the
pseudocode block, the disassembly files whose span holds the entry VA, and the
byte-checked sites placed under it. A site inside a disassembly file goes to the
routine in that file with the nearest entry VA at or below the site. Disassembly
files holding no routine entry get their own section with their sites. Sites in
no span, or before every routine entry in their file, are listed apart. Every
site is shown exactly once. Labels are analyst-assigned, not original symbols.

The script refuses to write the page, and exits non-zero, when an input is
missing or malformed, the routines or labels in selected.c disagree with the
decompiled routines in status.json, an .asm file's span header is missing or
malformed, a site's VA repeats, a site would be shown zero times or more than
once, or the PE metadata has no sha256.
"""
import argparse
from collections import Counter
from pathlib import Path
import re

from dossier_common import STYLE, check_fields, check_pe, e, load_json, page_start, producer_revision, relative_href
from text_database import REPO_ROOT, require
from tyre_dossier import check_evidence

PAGE = "routines.html"
ANALYSIS = REPO_ROOT / "analysis"
STATUS = ANALYSIS / "annotated/status.json"
PSEUDOCODE = ANALYSIS / "annotated/selected.c"
SELECTED = ANALYSIS / "selected"
FIELD_EVIDENCE = SELECTED / "field-evidence.json"
PE_METADATA = ANALYSIS / "pe-metadata.json"
# The committed disassembly files, by name. scripts/build_research.py copies each one beside the page.
ASM_FILES = tuple(sorted(path.name for path in SELECTED.glob("*.asm")))
STATUS_FIELDS = {"entry_va": str, "label": str, "signature": str, "return_storage": str, "parameter_storage": list,
                 "decompiled": bool, "error": str}
ENTRY_VA = re.compile(r"[0-9a-f]{8}")
# Labels become anchors, so they are limited to characters that need no escaping in a URL fragment.
LABEL = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]*")
BLOCK_HEADER = re.compile(r"^/\* ([0-9a-f]{8}) (\S+) \*/$", re.M)
ASM_HEADER = re.compile(r"; Analyst label: (\S+); export span 0x([0-9a-f]{8})\.\.0x([0-9a-f]{8})")
EXTRA_STYLE = """section.routine, section.asm { border-top: 2px solid #888; margin-top: 2em; }
pre { background: #f7f7f7; border: 1px solid #e2e2e2; overflow-x: auto; padding: 0.5em; }
"""


def check_status(status):
    """Check status.json; return its routines in order, each with its entry VA as an integer under "va"."""
    require(isinstance(status, list) and status, "status.json must be a non-empty list")
    routines, vas, labels = [], set(), set()
    for i, item in enumerate(status):
        where = f"status.json[{i}]"
        check_fields(item, STATUS_FIELDS, where)
        require(ENTRY_VA.fullmatch(item["entry_va"]), f"{where}.entry_va must be 8 lowercase hex digits: "
                                                      f"{item['entry_va']!r}")
        require(LABEL.fullmatch(item["label"]), f"{where}.label {item['label']!r} is not usable as an anchor")
        require(all(isinstance(value, str) for value in item["parameter_storage"]),
                f"{where}.parameter_storage must be a list of strings")
        require(item["entry_va"] not in vas, f"status.json lists entry VA {item['entry_va']} twice")
        require(item["label"] not in labels, f"status.json lists label {item['label']!r} twice")
        vas.add(item["entry_va"])
        labels.add(item["label"])
        routines.append({**item, "va": int(item["entry_va"], 16)})
    return routines


def pseudocode_blocks(text):
    """Split selected.c into {entry VA: (label, block)}; each block runs from its header to the next one."""
    headers = list(BLOCK_HEADER.finditer(text))
    require(headers, "selected.c has no `/* <entry VA> <label> */` routine headers")
    blocks = {}
    for i, header in enumerate(headers):
        va, label = header.groups()
        require(va not in blocks, f"selected.c has two blocks for entry VA {va}")
        end = headers[i + 1].start() if i + 1 < len(headers) else len(text)
        blocks[va] = (label, text[header.start():end].rstrip())
    return blocks


def check_pseudocode(routines, blocks):
    """selected.c must hold exactly one block per decompiled routine, under the same label as status.json."""
    expected = {routine["entry_va"]: routine["label"] for routine in routines if routine["decompiled"]}
    problems = [f"status.json routine {label} ({va}) has no block in selected.c"
                for va, label in expected.items() if va not in blocks]
    problems += [f"selected.c routine {label} ({va}) is not a decompiled routine in status.json"
                 for va, (label, _) in blocks.items() if va not in expected]
    problems += [f"entry VA {va} is {expected[va]} in status.json but {label} in selected.c"
                 for va, (label, _) in blocks.items() if va in expected and expected[va] != label]
    require(not problems, "selected.c disagrees with status.json: " + "; ".join(problems))


def disassembly_files(directory):
    """Read each .asm file's span header; return [{"name", "label", "start", "end"}] sorted by name."""
    paths = sorted(Path(directory).glob("*.asm"))
    require(paths, f"No .asm files in {directory}")
    files = []
    for path in paths:
        lines = path.read_text(encoding="utf-8").splitlines()
        header = ASM_HEADER.fullmatch(lines[0]) if lines else None
        require(header, f"{path.name} does not start with a `; Analyst label: <name>; export span "
                        "0x<start>..0x<end>` header of 8-digit lowercase hex addresses")
        label, start, end = header[1], int(header[2], 16), int(header[3], 16)
        require(label == path.stem, f"{path.name}: its header labels it {label!r}, not {path.stem!r}")
        require(start < end, f"{path.name}: export span 0x{start:08x}..0x{end:08x} is empty or reversed")
        files.append({"name": path.name, "label": label, "start": start, "end": end})
    return files


def place(routines, files, sites):
    """Decide where each site is shown; return ({routine label: sites}, {file name: sites}, unplaced sites).

    A routine's files are the ones whose span holds its entry VA. A site in a file that holds routine entries goes
    to the one with the nearest entry VA at or below it; a site in a file that holds none goes to that file; any
    other site is unplaced. A site in two overlapping spans is placed twice, which check_placements() refuses.
    """
    by_routine = {routine["label"]: [] for routine in routines}
    by_file = {item["name"]: [] for item in files}
    unplaced = []
    for routine in routines:
        routine["files"] = [item["name"] for item in files if item["start"] <= routine["va"] < item["end"]]
    entries = {item["name"]: sorted((routine for routine in routines if item["name"] in routine["files"]),
                                    key=lambda routine: routine["va"]) for item in files}
    for site in sites:
        spans = [item for item in files if item["start"] <= site["va"] < item["end"]]
        if not spans:
            unplaced.append(site)
        for item in spans:
            before = [routine for routine in entries[item["name"]] if routine["va"] <= site["va"]]
            if not entries[item["name"]]:
                by_file[item["name"]].append(site)
            elif before:
                by_routine[before[-1]["label"]].append(site)
            else:
                unplaced.append(site)
    return by_routine, by_file, unplaced


def check_sites(sites):
    check_evidence(sites)
    repeated = sorted(va for va, count in Counter(site["va"] for site in sites).items() if count > 1)
    require(not repeated, "field-evidence.json lists these VAs more than once: "
                          + ", ".join(f"0x{va:08x}" for va in repeated))


def check_placements(sites, *groups):
    """Every site must be shown exactly once across the groups (lists of sites); refuse otherwise."""
    shown = Counter(site["va"] for group in groups for site in group)
    problems = [f"0x{site['va']:08x} would be shown {shown[site['va']]} times" for site in sites
                if shown[site["va"]] != 1]
    problems += [f"0x{va:08x} is not in field-evidence.json" for va in shown if va not in {s["va"] for s in sites}]
    require(not problems, "Every byte-checked site must be shown exactly once: " + "; ".join(problems))


def file_anchor(name):
    return f"asm-{Path(name).stem}"


def site_anchor(site):
    return f"site-{site['va']:08x}"


def sites_table(sites):
    """Return the sites as a table, one row per line, so `grep -c 'class="site"'` counts them."""
    rows = "".join(f'\n<tr class="site" id="{e(site_anchor(site))}"><td><code>0x{site["va"]:08x}</code></td>'
                   f'<td><code>{e(site["bytes"])}</code></td><td>{e(site["claim"])}</td></tr>' for site in sites)
    return f"<table><tr><th>VA</th><th>Bytes</th><th>Claim</th></tr>{rows}\n</table>"


def span_text(item):
    return f"0x{item['start']:08x}..0x{item['end']:08x}"


def file_link(item, hrefs):
    return f'<a href="{e(hrefs[item["name"]])}"><code>{e(item["name"])}</code></a> (export span {span_text(item)})'


def storage(routine):
    params = ", ".join(f"<code>{e(value)}</code>" for value in routine["parameter_storage"]) or "none"
    return f'<code>{e(routine["return_storage"])}</code>', params


def decompiled_text(routine):
    return "yes" if routine["decompiled"] else f'no: {e(routine["error"] or "no error text recorded")}'


def routine_section(routine, blocks, files, by_routine, routines_by_file, hrefs):
    label = routine["label"]
    returns, params = storage(routine)
    parts = [f'\n<section class="routine" id="{e(label)}"><h2><code>{e(label)}</code></h2>'
             '<p><a href="#summary">Back to the summary</a></p>'
             f'<dl><dt>Entry VA</dt><dd><code>{e(routine["entry_va"])}</code></dd>'
             f'<dt>Signature</dt><dd><code>{e(routine["signature"])}</code></dd>'
             f'<dt>Return storage</dt><dd>{returns}</dd><dt>Parameter storage</dt><dd>{params}</dd>'
             f'<dt>Decompiled</dt><dd>{decompiled_text(routine)}</dd></dl>', "<h3>Bounded disassembly</h3>"]
    if routine["files"]:
        items = []
        for name in routine["files"]:
            others = [other for other in routines_by_file[name] if other["label"] != label]
            shared = (" Shared with " + ", ".join(f'<a href="#{e(other["label"])}"><code>{e(other["label"])}</code></a>'
                                                  for other in others) + "." if others else "")
            items.append(f"<li>{file_link(files[name], hrefs)}.{shared}</li>")
        parts.append(f'<ul>{"".join(items)}</ul>')
    else:
        parts.append("<p>No committed disassembly file's export span holds this entry VA.</p>")
    parts.append("<h3>Byte-checked sites</h3>")
    sites = by_routine[label]
    parts.append(sites_table(sites) if sites else "<p>None of the byte-checked sites is placed under this routine.</p>")
    if routine["entry_va"] in blocks:
        block = blocks[routine["entry_va"]][1]
        parts.append(f'<details><summary>Ghidra pseudocode ({len(block.splitlines())} lines, from '
                     f'<a href="{e(hrefs["pseudocode"])}">selected.c</a>)</summary><pre>{e(block)}</pre></details>')
    else:
        parts.append(f'<p>No pseudocode: decompilation failed ({e(routine["error"] or "no error text recorded")}).</p>')
    parts.append("</section>")
    return "".join(parts)


def render(routines, blocks, files, placement, pe, revision, hrefs, entrance=False):
    """Return the page. The inputs must have passed the checks in build() first."""
    by_routine, by_file, unplaced = placement
    sites = sum(len(group) for group in (*by_routine.values(), *by_file.values(), unplaced))
    files_by_name = {item["name"]: item for item in files}
    routines_by_file = {item["name"]: [routine for routine in routines if item["name"] in routine["files"]]
                        for item in files}
    other_files = [item for item in files if not routines_by_file[item["name"]]]
    parts = [page_start("Ford Racing 3 demo routines", PAGE, STYLE + EXTRA_STYLE, entrance),
             "<h1>Ford Racing 3 demo: annotated routines</h1><dl>",
             f'<dt>Executable</dt><dd><code>{e(pe.get("file", "fr3.exe"))}</code> SHA-256 <code>{e(pe["sha256"])}</code>, '
             f'PE timestamp {e(pe.get("timestamp_header_utc", "unknown"))}</dd>',
             f'<dt>Inputs</dt><dd><a href="{e(hrefs["status"])}">status.json</a>, '
             f'<a href="{e(hrefs["pseudocode"])}">selected.c</a>, '
             f'<a href="{e(hrefs["evidence"])}">field-evidence.json</a> and the disassembly files below</dd>',
             f'<dt>Producer revision</dt><dd><code>{e(revision)}</code> (<code>scripts/routine_index.py</code>)</dd>',
             f"<dt>Routines</dt><dd>{len(routines)}</dd><dt>Disassembly files</dt><dd>{len(files)}</dd>"
             f"<dt>Byte-checked sites</dt><dd>{sites}</dd></dl>",
             '<p class="scope">Scope: every routine label here, and every disassembly file\'s label, is '
             "analyst-assigned, not an original symbol. The pseudocode is Ghidra output as committed in "
             "<code>selected.c</code>: selected register signatures are corrected, but callees stay unresolved and "
             "types are inferred, so it needs review. Each disassembly file is a linear decoding of an export span "
             "and may include padding or neighbouring code. A byte-checked site inside a disassembly file shared by "
             "several routines is listed under the routine with the nearest entry VA at or below it; that is how this "
             "page places sites, not an established routine boundary. Nothing here goes beyond those files.</p>",
             '<h2 id="summary">Summary</h2><table><tr><th>Entry VA</th><th>Analyst label</th><th>Signature</th>'
             "<th>Return storage</th><th>Parameter storage</th><th>Decompiled</th></tr>"]
    for routine in routines:
        returns, params = storage(routine)
        parts.append(f'\n<tr><td><code>{e(routine["entry_va"])}</code></td>'
                     f'<td><a href="#{e(routine["label"])}"><code>{e(routine["label"])}</code></a></td>'
                     f'<td><code>{e(routine["signature"])}</code></td><td>{returns}</td><td>{params}</td>'
                     f"<td>{decompiled_text(routine)}</td></tr>")
    parts.append("\n</table>")
    parts.extend(routine_section(routine, blocks, files_by_name, by_routine, routines_by_file, hrefs)
                 for routine in routines)
    parts.append('\n<h2 id="other-files">Other disassembly files</h2>')
    if other_files:
        parts.append("<p>No annotated routine's entry VA lies in these files' export spans.</p>")
    else:
        parts.append("<p>None: every disassembly file holds an annotated routine's entry VA.</p>")
    for item in other_files:
        sites_here = by_file[item["name"]]
        parts.append(f'\n<section class="asm" id="{e(file_anchor(item["name"]))}"><h3><code>{e(item["label"])}</code>'
                     f"</h3><p>{file_link(item, hrefs)}</p>"
                     + (sites_table(sites_here) if sites_here else "<p>No byte-checked site lies in this span.</p>")
                     + "</section>")
    parts.append('\n<h2 id="unplaced-sites">Sites outside every routine</h2>')
    if unplaced:
        parts.append("<p>These byte-checked sites lie in no disassembly file's export span, or before every "
                     "annotated routine entry in their file.</p>" + sites_table(unplaced))
    else:
        parts.append("<p>None: every byte-checked site is listed above.</p>")
    parts.append("</body></html>\n")
    return "\n".join(parts)


def check_anchors(routines, files, sites):
    ids = (["summary", "other-files", "unplaced-sites"] + [routine["label"] for routine in routines]
           + [file_anchor(item["name"]) for item in files] + [site_anchor(site) for site in sites])
    repeated = sorted(anchor for anchor, count in Counter(ids).items() if count > 1)
    require(not repeated, "These page anchors are not unique: " + ", ".join(repeated))


def default_hrefs(output, status_path, pseudocode_path, evidence_path, selected_dir):
    hrefs = {"status": relative_href(Path(status_path).resolve(), output),
             "pseudocode": relative_href(Path(pseudocode_path).resolve(), output),
             "evidence": relative_href(Path(evidence_path).resolve(), output)}
    hrefs.update({path.name: relative_href(path.resolve(), output) for path in Path(selected_dir).glob("*.asm")})
    return hrefs


def build(status_path, pseudocode_path, selected_dir, evidence_path, pe_path, output, revision=None, hrefs=None,
          entrance=False):
    """Read and check every input, then write the page; return (routines, disassembly files, sites).

    hrefs maps "status", "pseudocode", "evidence" and each .asm file name to the link the page uses for it; by
    default they are relative links from `output` to the input files. entrance=True adds the entrance page to
    the nav bar, for scripts/build_research.py.
    """
    routines = check_status(load_json(status_path, "Annotated status"))
    require(Path(pseudocode_path).is_file(), f"Pseudocode not found: {pseudocode_path}")
    blocks = pseudocode_blocks(Path(pseudocode_path).read_text(encoding="utf-8"))
    check_pseudocode(routines, blocks)
    require(Path(selected_dir).is_dir(), f"Disassembly directory not found: {selected_dir}")
    files = disassembly_files(selected_dir)
    sites = load_json(evidence_path, "Field evidence")
    check_sites(sites)
    pe = load_json(pe_path, "PE metadata")
    check_pe(pe)
    placement = place(routines, files, sites)
    by_routine, by_file, unplaced = placement
    check_placements(sites, *by_routine.values(), *by_file.values(), unplaced)
    check_anchors(routines, files, sites)
    hrefs = hrefs or default_hrefs(output, status_path, pseudocode_path, evidence_path, selected_dir)
    missing = [name for name in ("status", "pseudocode", "evidence", *(item["name"] for item in files))
               if name not in hrefs]
    require(not missing, "No link given for: " + ", ".join(missing))
    page = render(routines, blocks, files, placement, pe, revision or producer_revision(), hrefs, entrance)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text(page, encoding="utf-8")
    return len(routines), len(files), len(sites)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--status", type=Path, default=STATUS,
                        help="Annotated routines from scripts/AnnotateFord.java (default: %(default)s)")
    parser.add_argument("--pseudocode", type=Path, default=PSEUDOCODE,
                        help="Their Ghidra pseudocode (default: %(default)s)")
    parser.add_argument("--selected", type=Path, default=SELECTED,
                        help="Directory of bounded .asm files (default: %(default)s)")
    parser.add_argument("--evidence", type=Path, default=FIELD_EVIDENCE,
                        help="Byte-checked instruction sites (default: %(default)s)")
    parser.add_argument("--pe", type=Path, default=PE_METADATA, help="fr3.exe identity (default: %(default)s)")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "artifacts/dossier" / PAGE,
                        help="HTML file to write, next to the other dossier pages (default: %(default)s)")
    args = parser.parse_args()
    try:
        routines, files, sites = build(args.status, args.pseudocode, args.selected, args.evidence, args.pe,
                                       args.output)
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        raise SystemExit(f"routine_index.py: {error}") from None
    print(f"Wrote {routines} routines, {files} disassembly files and {sites} byte-checked sites to {args.output}")


if __name__ == "__main__":
    main()
