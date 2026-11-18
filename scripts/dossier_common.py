"""HTML and input helpers shared by the offline dossier generators.

scripts/tyre_dossier.py, scripts/record_dossier.py, scripts/pcg_catalogue.py, scripts/routine_index.py and
scripts/open_questions.py write static pages
with inline CSS, no JavaScript and no external resources other than the two links in
the rights-holder notice. Every piece of input text goes through e() before it reaches
the page. scripts/build_research.py writes all of them, plus the entrance page, into
one directory.
"""
import html
import json
import os
from pathlib import Path
import subprocess

from fr3_common import DEMO_PAGE
from text_database import REPO_ROOT, require
from verify_web import ISSUES_PAGE, RIGHTS_CREDIT

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
.rights { background: #eef3fb; border-left: 4px solid #3b7ddd; margin: 1em 0; padding: 0.2em 0.8em; }
.rights h2 { font-size: 1.05em; margin: 0.5em 0 0.2em; }
"""
# The research pages, as written next to each other in one directory, in navigation order. index.html is the
# "Explore findings" entrance that scripts/build_research.py writes.
INDEX_PAGE = "index.html"
PAGES = ((INDEX_PAGE, "Explore findings"), ("engines.html", "Engines"), ("gearboxes.html", "Gearboxes"),
         ("tyres.html", "Tyres"), ("pcg.html", "PCG catalogue"), ("routines.html", "Routines"),
         ("questions.html", "Open questions"))
# The open questions that scripts/open_questions.py writes up, and what each one is about. The engine, tyre and PCG
# pages link their unresolved label for each case to its anchor on QUESTIONS_PAGE; open_questions.py refuses to
# write the page when its inputs no longer show the case described here.
QUESTIONS_PAGE = "questions.html"
INDIGO_ANCHOR, SOUND_ANCHOR, PCG_ANCHOR = "indigo", "sound-words", "pcg-extra-bytes"
INDIGO_RECORD = "INDIGO"
INDIGO_TOKENS = ("INHERIT_TYPE", "DEFAULT_TRACK")
PCG_QUESTION_ENTRIES = ("_loadbar", "_loadbr2")
PCG_QUESTION_EXTRA = 1024
# The id of the tyre page's note on the sound table's leading words.
SOUND_NOTE_ID = "sound-table-words"
# The external links a research page may carry; both sit in the rights-holder notice.
NOTICE_LINKS = (DEMO_PAGE, ISSUES_PAGE)
NOTICE_ID = "rights-notice"
# The notice's heading. A page whose anchors come from its data must reserve both ids.
NOTICE_TITLE_ID = "rights-title"
UNTAGGED_NOTE = " kept verbatim, not applied"


def load_json(path, label):
    require(Path(path).is_file(), f"{label} not found: {path}")
    return json.loads(Path(path).read_text(encoding="utf-8"))


def check_fields(value, fields, label):
    """Reject malformed JSON containers with a field-specific diagnostic."""
    require(isinstance(value, dict), f"{label} must be an object")
    for key, kind in fields.items():
        require(key in value, f"{label} has no {key!r}")
        require(isinstance(value[key], kind), f"{label}.{key} has the wrong type")


def check_pe(pe):
    require(isinstance(pe, dict) and pe.get("sha256"), "PE metadata has no sha256")


def producer_revision():
    try:
        result = subprocess.run(["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"], capture_output=True, text=True,
                                check=False, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    revision = result.stdout.strip()
    return revision if result.returncode == 0 and revision else "unknown"


def relative_href(target, output):
    return Path(os.path.relpath(target, Path(output).resolve().parent)).as_posix()


def e(text):
    return html.escape(str(text), quote=True)


def anchor(prefix, name, part=None):
    return f"{prefix}-{name}-{part}" if part else f"{prefix}-{name}"


def link(prefix, name, part=None):
    return f'<a href="#{e(anchor(prefix, name, part))}">{e(name)}</a>'


def nav(current, entrance=False):
    """Return the link bar between the sibling research pages; `current` is this page's file name.

    The entrance page (index.html) is listed only when `entrance` is true: scripts/build_research.py writes it,
    the standalone generators do not.
    """
    items = [f"<strong>{e(title)}</strong>" if page == current else f'<a href="{e(page)}">{e(title)}</a>'
             for page, title in PAGES if entrance or page != INDEX_PAGE]
    return f'<nav>Research: {" | ".join(items)}</nav>'


def question_link(anchor_id, text="open question"):
    """Return a link to one section of the Open questions page, from a sibling research page."""
    return f'<a href="{e(QUESTIONS_PAGE)}#{e(anchor_id)}">{e(text)}</a>'


def is_indigo_line(record, item):
    """True for the colon-less line the Open questions page writes up: INDIGO's untagged INDIGO_TOKENS."""
    return record["type"] == INDIGO_RECORD and tuple(item["tokens"]) == INDIGO_TOKENS


def is_pcg_question(entry):
    """True for a PCG graphic whose extra bytes the Open questions page writes up."""
    return entry["name"] in PCG_QUESTION_ENTRIES and entry["extra_bytes"] == PCG_QUESTION_EXTRA


def rights_notice():
    """Return the rights-holder notice, worded as on the browser preview (web/index.html).

    Every research page carries it before its main content; scripts/build_research.py checks that.
    """
    return (f'<aside id="{NOTICE_ID}" class="rights" aria-labelledby="{NOTICE_TITLE_ID}">'
            f'<h2 id="{NOTICE_TITLE_ID}">Unofficial research findings</h2>'
            "<p>This fan project is not affiliated with or endorsed by the rights holders. "
            f"{e(RIGHTS_CREDIT)}</p>"
            f'<p><a href="{e(DEMO_PAGE)}" rel="noopener">Get the official demo download</a> · Rights holders can '
            f'<a href="{e(ISSUES_PAGE)}" rel="noopener">request removal through the project’s issues</a>.</p></aside>')


def page_start(title, current, style=STYLE, entrance=False):
    """Return a research page's head, nav bar and rights-holder notice, up to where its main content starts."""
    return (f'<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">'
            f'<title>{e(title)}</title><style>{style}</style></head><body>\n{nav(current, entrance)}\n'
            f'{rights_notice()}')


def rows_table(rows):
    body = "".join("<tr>" + "".join(f'<td class="num">{e(cell)}</td>' for cell in row) + "</tr>" for row in rows)
    return f'<table class="rows">{body}</table>'


def declarations(record, prefix, inherit_note="", untagged_note=UNTAGGED_NOTE):
    """Return the record's fields, :SOUND_INFO entries and untagged lines as table rows, in line order.

    :INHERIT_TYPE links to the parent's `prefix` anchor, followed by inherit_note. Untagged lines are
    shown verbatim followed by untagged_note, or by untagged_note(record, item) when it is callable. Both notes are
    HTML, not escaped here.
    """
    items = []
    for tag, field in record["fields"].items():
        if tag == "INHERIT_TYPE":
            shown = "parent " + link(prefix, field["values"][0]) + inherit_note
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
        note = untagged_note(record, item) if callable(untagged_note) else untagged_note
        items.append((item["line"], "(untagged)", f'<code>{e(" ".join(item["tokens"]))}</code>{note}'))
    body = "".join(f"<tr><td>{e(line)}</td><td><code>{e(tag)}</code></td><td>{shown}</td></tr>"
                   for line, tag, shown in sorted(items, key=lambda item: item[0]))
    return f"<table><tr><th>Line</th><th>Tag</th><th>Values</th></tr>{body}</table>"
