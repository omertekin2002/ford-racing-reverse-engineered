"""HTML and input helpers shared by the offline dossier generators.

scripts/tyre_dossier.py and scripts/record_dossier.py both write static pages
with inline CSS, no JavaScript and no external resources. Every piece of input
text goes through e() before it reaches the page.
"""
import html
import json
import os
from pathlib import Path
import subprocess

from text_database import REPO_ROOT, require

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
"""
# The dossier pages, as written next to each other in one directory, in navigation order.
PAGES = (("engines.html", "Engines"), ("gearboxes.html", "Gearboxes"), ("tyres.html", "Tyres"))
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


def nav(current):
    """Return the link bar between the sibling dossier pages; `current` is this page's file name."""
    items = [f"<strong>{e(title)}</strong>" if page == current else f'<a href="{e(page)}">{e(title)}</a>'
             for page, title in PAGES]
    return f'<nav>Dossiers: {" | ".join(items)}</nav>'


def rows_table(rows):
    body = "".join("<tr>" + "".join(f'<td class="num">{e(cell)}</td>' for cell in row) + "</tr>" for row in rows)
    return f'<table class="rows">{body}</table>'


def declarations(record, prefix, inherit_note="", untagged_note=UNTAGGED_NOTE):
    """Return the record's fields, :SOUND_INFO entries and untagged lines as table rows, in line order.

    :INHERIT_TYPE links to the parent's `prefix` anchor, followed by inherit_note. Untagged lines are
    shown verbatim followed by untagged_note. Both notes are HTML, not escaped here.
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
        items.append((item["line"], "(untagged)", f'<code>{e(" ".join(item["tokens"]))}</code>{untagged_note}'))
    body = "".join(f"<tr><td>{e(line)}</td><td><code>{e(tag)}</code></td><td>{shown}</td></tr>"
                   for line, tag, shown in sorted(items, key=lambda item: item[0]))
    return f"<table><tr><th>Line</th><th>Tag</th><th>Values</th></tr>{body}</table>"
