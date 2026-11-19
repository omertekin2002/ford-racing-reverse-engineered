"""Build every research page, plus an "Explore findings" entrance page, into one self-contained directory.

Run it after scripts/acquire_demo.py has extracted the demo. It:
  1. parses ENGDATA.DAT, GEARDATA.DAT and TYREDATA.DAT with scripts/text_database.py
     into a temporary working directory, so no parsed JSON lands in the output;
  2. writes tyres.html, engines.html, gearboxes.html, pcg.html, routines.html and
     questions.html with scripts/tyre_dossier.py, scripts/record_dossier.py,
     scripts/pcg_catalogue.py, scripts/routine_index.py and scripts/open_questions.py;
  3. copies every committed analysis/ file those pages link to into
     <output>/evidence/, keeping its path under analysis/, and points the pages there;
  4. writes <output>/index.html, which links the six pages with their record,
     graphic, routine and question counts, the fr3.exe SHA-256 and the producer revision;
  5. checks the directory with verify_research(): all seven pages exist, each carries
     the rights-holder notice before its main content, none has a <script> or an
     external resource, every local link resolves to a file inside the output, every
     link to another page's fragment, such as the tyre, engine and gearbox pages'
     links to routines.html#<label> and routines.html#site-<va>, names an id on that
     page, and the directory holds no file other than the ones this script writes.

The pages are built in a staging directory next to the output and only replace it
once they pass. An existing output directory is replaced only when it holds nothing
but files this script writes. The pages hold game data: keep them out of Git.
"""
import argparse
from html.parser import HTMLParser
from pathlib import Path
import re
import shutil
import tempfile
import urllib.parse

from dossier_common import (INDEX_PAGE, NOTICE_ID, NOTICE_LINKS, PAGES, e, load_json, page_start, producer_revision)
import open_questions
import pcg_catalogue
import record_dossier
import routine_index
from text_database import REPO_ROOT, load_known_tags, require, write_databases
import tyre_dossier
from verify_web import RIGHTS_CREDIT

ANALYSIS = REPO_ROOT / "analysis"
DEFAULT_GAME = REPO_ROOT / "inputs/extracted/Program_Executable_Files"
DEFAULT_OUTPUT = REPO_ROOT / "artifacts/research"
EVIDENCE_DIR = "evidence"
RESEARCH_PAGES = tuple(page for page, _ in PAGES)
# The analysis/ files the pages link to, by the hrefs key each generator uses, as paths under analysis/.
TYRE_EVIDENCE = {"accessors": tyre_dossier.ACCESSORS_ASM.relative_to(ANALYSIS),
                 "loader": tyre_dossier.LOADER_ASM.relative_to(ANALYSIS),
                 "evidence": tyre_dossier.FIELD_EVIDENCE.relative_to(ANALYSIS)}
PCG_EVIDENCE = {"index": pcg_catalogue.PCG_INDEX.relative_to(ANALYSIS),
                "manifest": pcg_catalogue.MANIFEST.relative_to(ANALYSIS),
                "asm": pcg_catalogue.VIEW_ASM.relative_to(ANALYSIS)}
# routine_index.py's hrefs keys: its three inputs and every committed .asm file, all of which it links.
ROUTINE_EVIDENCE = {"status": routine_index.STATUS.relative_to(ANALYSIS),
                    "pseudocode": routine_index.PSEUDOCODE.relative_to(ANALYSIS),
                    "evidence": routine_index.FIELD_EVIDENCE.relative_to(ANALYSIS),
                    **{name: (routine_index.SELECTED / name).relative_to(ANALYSIS) for name in routine_index.ASM_FILES}}
# open_questions.py's hrefs keys: field evidence, the PCG index and the four .asm files it reads.
QUESTION_EVIDENCE = dict(open_questions.EVIDENCE)
# Every path this script writes under the output directory, and the directories that hold them.
OUTPUT_FILES = frozenset({*RESEARCH_PAGES, *(f"{EVIDENCE_DIR}/{relative.as_posix()}"
                                            for relative in (*TYRE_EVIDENCE.values(), *PCG_EVIDENCE.values(),
                                                             *ROUTINE_EVIDENCE.values(),
                                                             *QUESTION_EVIDENCE.values()))})
OUTPUT_DIRS = frozenset(parent.as_posix() for name in OUTPUT_FILES for parent in Path(name).parents
                        if parent != Path("."))
STYLE_URL = re.compile(r"url\s*\(|@import", re.I)


def check_output(output):
    """Refuse to replace a directory that holds anything, at any depth, this script does not write."""
    if not output.exists() and not output.is_symlink():
        return
    require(output.is_dir() and not output.is_symlink(), f"Output is not a directory: {output}")
    foreign = []
    for path in output.rglob("*"):
        relative = path.relative_to(output).as_posix()
        expected = (OUTPUT_DIRS if path.is_dir() else OUTPUT_FILES) if not path.is_symlink() else ()
        if relative not in expected or not (path.is_dir() or path.is_file()):
            foreign.append(relative)
    foreign.sort()
    require(not foreign, f"Refusing to replace {output}: it holds files build_research.py does not write: "
                         + ", ".join(foreign))


def copy_evidence(analysis, staging, files):
    """Copy analysis/<relative> to <staging>/evidence/<relative>; return {key: href from a page in staging}."""
    hrefs = {}
    for key, relative in files.items():
        target = staging / EVIDENCE_DIR / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(analysis / relative, target)
        hrefs[key] = (Path(EVIDENCE_DIR) / relative).as_posix()
    return hrefs


def render_index(counts, pe, revision, evidence):
    """Return the "Explore findings" entrance page."""
    rows = (("engines.html", "Engines", "Each engine record's declarations as written. <code>:INHERIT_TYPE</code> "
             "parents and untagged lines are labelled unresolved.", f'{counts["engines"]} engine records'),
            ("gearboxes.html", "Gearboxes", "Each gearbox record's declarations as written.",
             f'{counts["gearboxes"]} gearbox records'),
            ("tyres.html", "Tyres", "Each tyre's declarations beside the source of its five resolved tables and the "
             "byte-checked instruction sites behind each one.", f'{counts["tyres"]} tyre records'),
            ("pcg.html", "PCG catalogue", "Every PCG graphics collection and graphic: header fields, byte spans and "
             "decoding status. No pixel data is decoded.",
             f'{counts["pcg_collections"]} collections, {counts["pcg_graphics"]} graphics'),
            ("routines.html", "Routines", "Each analyst-labelled routine's signature, Ghidra pseudocode, bounded "
             "disassembly and the byte-checked instruction sites in it. Labels are analyst-assigned, not original "
             "symbols.", f'{counts["routines"]} annotated routines'),
            ("questions.html", "Open questions", "Findings labelled unresolved elsewhere: what was observed, what "
             "depends on each, the alternatives the observations leave open (all untested) and what evidence would "
             "decide it. Nothing is resolved.", f'{counts["questions"]} open questions'))
    table = "".join(f'<tr><td><a href="{e(page)}">{e(title)}</a></td><td>{text}</td><td>{e(count)}</td></tr>'
                    for page, title, text, count in rows)
    files = "".join(f'<li><a href="{e(href)}"><code>{e(href)}</code></a></li>' for href in evidence)
    return "\n".join([
        page_start("Ford Racing 3 demo research findings", INDEX_PAGE, entrance=True),
        "<h1>Ford Racing 3 demo: explore the findings</h1><dl>",
        f'<dt>Executable</dt><dd><code>{e(pe.get("file", "fr3.exe"))}</code> SHA-256 <code>{e(pe["sha256"])}</code>, '
        f'PE timestamp {e(pe.get("timestamp_header_utc", "unknown"))}</dd>',
        f"<dt>Producer revision</dt><dd><code>{e(revision)}</code> (<code>scripts/build_research.py</code>)</dd></dl>",
        '<p class="scope">Values are shown exactly as declared in the demo\'s files. Anything whose meaning or effect '
        "in the game is not established stays labelled unresolved; these pages do not fill it in.</p>",
        f"<h2>Pages</h2><table><tr><th>Page</th><th>What it shows</th><th>Count</th></tr>{table}</table>",
        "<h2>Evidence files</h2><p>Copied unchanged from the repository's <code>analysis/</code> directory; "
        f"the pages link to them.</p><ul>{files}</ul>",
        "</body></html>\n"])


def build(game_dir=DEFAULT_GAME, output=DEFAULT_OUTPUT, analysis=ANALYSIS, revision=None):
    """Build and verify the research directory; return the counts shown on the entrance page."""
    game_dir, output, analysis = Path(game_dir), Path(output), Path(analysis)
    require(game_dir.is_dir(), f"Game directory does not exist: {game_dir} (run scripts/acquire_demo.py inputs first)")
    check_output(output)
    revision = revision or producer_revision()
    pe_path = analysis / "pe-metadata.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    try:
        tyre_hrefs = copy_evidence(analysis, staging, TYRE_EVIDENCE)
        pcg_hrefs = copy_evidence(analysis, staging, PCG_EVIDENCE)
        question_hrefs = copy_evidence(analysis, staging, QUESTION_EVIDENCE)
        with tempfile.TemporaryDirectory() as work:
            work = Path(work)
            write_databases(game_dir, work, load_known_tags(analysis / "tags.json"))
            # The tyre, engine and gearbox pages link routines.html, so they read the same status.json it does.
            status_path = analysis / ROUTINE_EVIDENCE["status"]
            counts = {"tyres": tyre_dossier.build(work / "tyres.json", analysis / TYRE_EVIDENCE["evidence"], pe_path,
                                                  staging / tyre_dossier.PAGE, revision, hrefs=tyre_hrefs,
                                                  entrance=True, status_path=status_path),
                      **record_dossier.build(work / "engines.json", work / "gearboxes.json", pe_path, staging, revision,
                                               entrance=True, status_path=status_path)}
            counts["questions"] = open_questions.build(
                work / "engines.json", work / "tyres.json", analysis / QUESTION_EVIDENCE["evidence"],
                analysis / QUESTION_EVIDENCE["pcg_index"], pe_path, staging / open_questions.PAGE, revision,
                hrefs=question_hrefs, entrance=True, selected=analysis / "selected")
        counts["pcg_collections"], counts["pcg_graphics"] = pcg_catalogue.build(
            analysis / PCG_EVIDENCE["index"], analysis / PCG_EVIDENCE["manifest"], pe_path,
            analysis / "verification.json", staging / pcg_catalogue.PAGE, revision, hrefs=pcg_hrefs, entrance=True)
        routine_hrefs = copy_evidence(analysis, staging, ROUTINE_EVIDENCE)
        counts["routines"], _, _ = routine_index.build(
            analysis / ROUTINE_EVIDENCE["status"], analysis / ROUTINE_EVIDENCE["pseudocode"], analysis / "selected",
            analysis / ROUTINE_EVIDENCE["evidence"], pe_path, staging / routine_index.PAGE, revision,
            hrefs=routine_hrefs, entrance=True)
        evidence = sorted({*tyre_hrefs.values(), *pcg_hrefs.values(), *routine_hrefs.values(),
                           *question_hrefs.values()})
        index = render_index(counts, load_json(pe_path, "PE metadata"), revision, evidence)
        (staging / INDEX_PAGE).write_text(index, encoding="utf-8")
        verify_research(staging)
        if output.exists():
            shutil.rmtree(output)
        staging.rename(output)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return counts


class ResearchPage(HTMLParser):
    """Collect a page's ids, links and resources, its <script> tags and its rights-holder notice."""

    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.ids, self.refs, self.styles = set(), [], []
        self.scripts = 0
        self.notice_depth = 0
        self.notice_found = self.main_before_notice = self.in_style = False
        self.notice_text, self.notice_links = [], []
        self.feed(text)
        self.close()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids.add(attrs["id"])
        if tag == "script":
            self.scripts += 1
        if tag == "style":
            self.in_style = True
        if attrs.get("style"):
            self.styles.append(attrs["style"])
        if self.notice_depth:
            if tag == "aside":
                self.notice_depth += 1
            if tag == "a" and attrs.get("href"):
                self.notice_links.append(attrs["href"])
        elif attrs.get("id") == NOTICE_ID and not self.notice_found:
            self.notice_found, self.notice_depth = True, int(tag == "aside")
        elif tag in ("h1", "main") and not self.notice_found:
            self.main_before_notice = True
        for key in ("href", "src", "srcset", "data", "poster", "action", "formaction"):
            if key in attrs:
                self.refs.append((tag, key, attrs[key] or "", bool(self.notice_depth)))

    def handle_endtag(self, tag):
        if tag == "style":
            self.in_style = False
        if self.notice_depth and tag == "aside":
            self.notice_depth -= 1

    def handle_data(self, data):
        if self.notice_depth:
            self.notice_text.append(data)
        if self.in_style:
            self.styles.append(data)


def verify_research(root):
    """Check a built research directory; raise ValueError listing every problem found."""
    root = Path(root).resolve()
    errors, parsed = [], {}
    for page in RESEARCH_PAGES:
        path = root / page
        if not path.is_file():
            errors.append(f"{page} is missing")
            continue
        parsed[page] = ResearchPage(path.read_text(encoding="utf-8"))
    for page, found in parsed.items():
        if not found.notice_found:
            errors.append(f"{page} lacks the rights-holder notice (<aside id=\"{NOTICE_ID}\">)")
        else:
            if RIGHTS_CREDIT not in " ".join("".join(found.notice_text).split()):
                errors.append(f"{page}: the rights-holder notice lacks the credit: {RIGHTS_CREDIT}")
            errors.extend(f"{page}: the rights-holder notice lacks a link to {url}"
                          for url in NOTICE_LINKS if url not in found.notice_links)
            if found.main_before_notice:
                errors.append(f"{page}: the rights-holder notice must come before the main content (<h1>)")
        if found.scripts:
            errors.append(f"{page} contains a <script>")
        if any(STYLE_URL.search(style) for style in found.styles):
            errors.append(f"{page} loads a resource from its CSS (url() or @import)")
        for tag, key, value, in_notice in found.refs:
            errors.extend(check_ref(root, page, parsed, tag, key, value, in_notice))
    # Nothing else may ride along: the directory is published as it stands, and only the pages above are
    # checked for the notice.
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink() or (not path.is_dir() and relative not in OUTPUT_FILES):
            errors.append(f"{relative} is not a file build_research.py writes")
    require(not errors, "Research pages failed verification:\n  " + "\n  ".join(errors))
    return sorted(parsed)


def check_ref(root, page, parsed, tag, key, value, in_notice):
    """Return the problems with one href or src: external, or a local link that does not resolve inside root."""
    split = urllib.parse.urlsplit(value.strip())
    if split.scheme or split.netloc or value.strip().startswith("//"):
        if tag == "a" and key == "href" and in_notice and value in NOTICE_LINKS:
            return []
        return [f"{page} links to an external resource: <{tag} {key}={value!r}>"]
    if key != "href":
        return [f"{page} loads a resource: <{tag} {key}={value!r}>; research pages load none"]
    if not split.path:
        target_page = page
    else:
        target = (root / page).parent.joinpath(urllib.parse.unquote(split.path)).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            return [f"{page} has a broken local link: {value!r} does not resolve to a file inside {root}"]
        target_page = target.relative_to(root).as_posix()
    fragment = urllib.parse.unquote(split.fragment)
    if fragment and target_page in parsed and fragment not in parsed[target_page].ids:
        return [f"{page} has a broken local link: {value!r} names no id in {target_page}"]
    return []


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--game", type=Path, default=DEFAULT_GAME,
                        help="Extracted Program_Executable_Files directory (default: %(default)s)")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT,
                        help="Research directory to write; keep it out of Git, the pages hold game data "
                             "(default: %(default)s)")
    args = parser.parse_args()
    try:
        counts = build(args.game, args.output)
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        raise SystemExit(f"build_research.py: {error}") from None
    print(f"Wrote {len(RESEARCH_PAGES)} verified pages to {args.output}: {counts['engines']} engines, "
          f"{counts['gearboxes']} gearboxes, {counts['tyres']} tyres, {counts['pcg_collections']} PCG collections, "
          f"{counts['pcg_graphics']} graphics, {counts['routines']} routines and {counts['questions']} open questions")


if __name__ == "__main__":
    main()
