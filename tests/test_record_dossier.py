"""Synthetic engine and gearbox dossier tests; these use no game data."""
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import record_dossier
from text_database import GEARBOX_TAGS, REPO_ROOT, parse

TAGS = {"CAPACITY", "LOCATION_TYPE", "MAX_RPM", "TORQUE_ARRAY", "INHERIT_TYPE", *GEARBOX_TAGS}
# BASE declares everything, CHILD and GRANDCHILD inherit, LONER has a colon-less INHERIT_TYPE line.
ENGINES = """:TYPE BASE
:CAPACITY 777.25
:LOCATION_TYPE FRONT
:MAX_RPM 6500
:TORQUE_ARRAY
0 100.5
1000 200.5
2000 150.5
:TYPE CHILD
:INHERIT_TYPE BASE
:CAPACITY 1.5
:TYPE GRANDCHILD
:INHERIT_TYPE CHILD
:MAX_RPM 9100
:TYPE LONER
INHERIT_TYPE BASE
:CAPACITY 2.25
:END
"""
GEARBOXES = """:TYPE ROAD_OLD
:CLUTCH_SPEED 0.3
:DRIVE_TYPE FRONT_WHEELS
:TYPE TRACK
:CLUTCH_SPEED 0.45
:END
"""
ENGINE_NAMES = ["BASE", "CHILD", "GRANDCHILD", "LONER"]
PE = json.loads((REPO_ROOT / "analysis/pe-metadata.json").read_text())
BASE_VALUES = ("777.25", "FRONT", "6500", "100.5", "200.5", "150.5")


def database(text, source):
    return {"source": source, "sha256": hashlib.sha256(text.encode()).hexdigest(), "records": parse(text, TAGS)}


def engines_json(text=ENGINES):
    return database(text, "DATA/ASCII/CARS/ENGDATA.DAT")


def gearboxes_json(text=GEARBOXES):
    return database(text, "DATA/ASCII/CARS/GEARDATA.DAT")


def section(page, prefix, name):
    start = page.index(f'<section class="record" id="{prefix}-{name}">')
    return page[start:page.index("</section>", start)]


def summary_row(page, prefix, name):
    summary = page[page.index("<h2>Summary</h2>"):page.index('<section class="record"')]
    start = summary.index(f'<tr><td><a href="#{prefix}-{name}">')
    return summary[start:summary.index("</tr>", start)]


class Links(HTMLParser):
    def __init__(self, page):
        super().__init__()
        self.ids, self.hrefs = [], []
        self.feed(page)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag == "a":
            self.hrefs.append(attrs["href"])


class RecordDossierTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.output = self.root / "dossier"
        self.pages = [self.output / "engines.html", self.output / "gearboxes.html"]

    def write(self, name, data):
        path = self.root / name
        path.write_text(data if isinstance(data, str) else json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path

    def build(self, engines=None, gearboxes=None, pe=PE):
        engines = engines_json() if engines is None else engines
        gearboxes = gearboxes_json() if gearboxes is None else gearboxes
        counts = record_dossier.build(self.write("engines.json", engines), self.write("gearboxes.json", gearboxes),
                                      self.write("pe.json", pe), self.output, revision="0123abcd")
        self.assertEqual(counts, {"engines": len(engines["records"]), "gearboxes": len(gearboxes["records"])})
        return tuple(page.read_text(encoding="utf-8") for page in self.pages)

    def reject(self, fragment, engines=None, gearboxes=None, pe=PE):
        with self.assertRaises(ValueError) as caught:
            self.build(engines, gearboxes, pe)
        self.assertIn(fragment, str(caught.exception))
        for page in self.pages:
            self.assertFalse(page.exists(), page)


class RecordDossierPageTests(RecordDossierTestCase):
    def test_anchors_are_unique_and_every_link_resolves(self):
        for page, prefix, names in zip(self.build(), ("engine", "gearbox"), (ENGINE_NAMES, ["ROAD_OLD", "TRACK"]),
                                       strict=True):
            with self.subTest(prefix=prefix):
                links = Links(page)
                self.assertEqual(links.ids, [f"{prefix}-{name}" for name in names])
                internal = [href[1:] for href in links.hrefs if href.startswith("#")]
                self.assertTrue(internal)
                self.assertEqual([href for href in internal if href not in links.ids], [])
                self.assertEqual({href for href in links.hrefs if not href.startswith("#")},
                                 {"engines.html", "gearboxes.html", "tyres.html"} - {self.pages[prefix == "gearbox"].name})

    def test_inherit_type_links_to_the_parent_and_is_unresolved(self):
        engines, _ = self.build()
        child = section(engines, "engine", "CHILD")
        self.assertIn('<code>:INHERIT_TYPE</code></td><td>parent <a href="#engine-BASE">BASE</a> '
                      '<span class="label">unresolved</span>', child)
        self.assertIn('<span class="label">unresolved</span>: <code>:INHERIT_TYPE</code> '
                      '<a href="#engine-BASE">BASE</a> on line 10.', child)
        grandchild = section(engines, "engine", "GRANDCHILD")
        self.assertIn('parent <a href="#engine-CHILD">CHILD</a>', grandchild)

    def test_inherited_records_show_only_their_own_declarations(self):
        engines, _ = self.build()
        child = section(engines, "engine", "CHILD")
        grandchild = section(engines, "engine", "GRANDCHILD")
        for value in BASE_VALUES:
            self.assertIn(value, section(engines, "engine", "BASE"))
            self.assertNotIn(value, child)
            self.assertNotIn(value, grandchild)
        self.assertIn('<td>11</td><td><code>:CAPACITY</code></td><td><span class="num">1.5</span></td>', child)
        self.assertNotIn("1.5", grandchild)
        self.assertNotIn(":TORQUE_ARRAY", child + grandchild)
        self.assertIn('<td>14</td><td><code>:MAX_RPM</code></td><td><span class="num">9100</span></td>', grandchild)

    def test_untagged_line_is_verbatim_unresolved_and_not_inheritance(self):
        engines, _ = self.build()
        loner = section(engines, "engine", "LONER")
        self.assertIn('<td>16</td><td><code>(untagged)</code></td><td><code>INHERIT_TYPE BASE</code> kept verbatim, '
                      'not applied <div class="unresolved"><span class="label">unresolved</span>', loner)
        self.assertIn("whether the game honours it is not established", loner)
        self.assertNotIn("href=", loner)
        self.assertNotIn(":INHERIT_TYPE", loner)
        self.assertNotIn("href=", summary_row(engines, "engine", "LONER").split("</td>", 1)[1])
        self.assertIn('<span class="num">2.25</span>', loner)

    def test_multi_row_fields_render_as_row_tables_with_dimensions(self):
        engines, _ = self.build()
        base = section(engines, "engine", "BASE")
        self.assertIn('<td>5</td><td><code>:TORQUE_ARRAY</code></td><td>3 rows &times; 2 columns<table class="rows">'
                      '<tr><td class="num">0</td><td class="num">100.5</td></tr>', base)
        self.assertIn("<td>3 &times; 2</td>", summary_row(engines, "engine", "BASE"))
        self.assertIn("units of the values, including the torque arrays, are not established", engines)

    def test_declarations_are_sorted_by_line(self):
        engines, _ = self.build()
        lines = [int(line) for line in re.findall(r"<tr><td>(\d+)</td><td><code>", section(engines, "engine", "BASE"))]
        self.assertEqual(lines, [2, 3, 4, 5])

    def test_summary_lists_records_in_file_order_with_parents(self):
        engines, gearboxes = self.build()
        summary = engines[engines.index("<h2>Summary</h2>"):engines.index('<section class="record"')]
        self.assertEqual(re.findall(r'<tr><td><a href="#engine-(\w+)">', summary), ENGINE_NAMES)
        self.assertIn("<th>Parent (unresolved)</th>", summary)
        self.assertIn('<td>9</td><td><a href="#engine-BASE">BASE</a></td>', summary_row(engines, "engine", "CHILD"))
        self.assertIn('<td>12</td><td><a href="#engine-CHILD">CHILD</a></td>', summary_row(engines, "engine", "GRANDCHILD"))
        self.assertIn("<td>1</td><td></td><td>3 &times; 2</td>", summary_row(engines, "engine", "BASE"))
        gear_summary = gearboxes[gearboxes.index("<h2>Summary</h2>"):gearboxes.index('<section class="record"')]
        self.assertEqual(re.findall(r'<tr><td><a href="#gearbox-(\w+)">', gear_summary), ["ROAD_OLD", "TRACK"])
        self.assertNotIn("Parent", gear_summary)
        self.assertNotIn("TORQUE_ARRAY", gear_summary)

    def test_header_identity(self):
        for page, text, source, count in zip(self.build(), (ENGINES, GEARBOXES), ("ENGDATA.DAT", "GEARDATA.DAT"),
                                             (4, 2), strict=True):
            with self.subTest(source=source):
                header = page[:page.index("<h2>")]
                self.assertIn(PE["sha256"], header)
                self.assertIn(PE["timestamp_header_utc"], header)
                self.assertIn(f"<code>DATA/ASCII/CARS/{source}</code> SHA-256 "
                              f"<code>{hashlib.sha256(text.encode()).hexdigest()}</code>", header)
                self.assertIn("<code>0123abcd</code>", header)
                self.assertIn(f"<dt>Records</dt><dd>{count}</dd>", header)
                self.assertIn('<p class="scope">', header)
                self.assertIn("unresolved", header)

    def test_nav_bar(self):
        engines, gearboxes = self.build()
        self.assertIn('<nav>Dossiers: <strong>Engines</strong> | <a href="gearboxes.html">Gearboxes</a> | '
                      '<a href="tyres.html">Tyres</a></nav>', engines)
        self.assertIn('<nav>Dossiers: <a href="engines.html">Engines</a> | <strong>Gearboxes</strong> | '
                      '<a href="tyres.html">Tyres</a></nav>', gearboxes)

    def test_no_scripts_or_remote_resources(self):
        for page in self.build():
            self.assertNotIn("<script", page.lower())
            self.assertNotRegex(page, r"https?://")

    def test_input_text_is_escaped(self):
        engines = json.loads(json.dumps(engines_json()).replace("BASE", 'A<&\\"B').replace("FRONT", 'x<&\\"y'))
        engines["records"][3]["untagged"][0]["tokens"].append("<b>")
        engines["source"] = "<i>ENG</i>"
        page, _ = self.build(engines)
        for raw in ('A<&"B', 'x<&"y', "<b>", "<i>"):
            self.assertNotIn(raw, page)
        self.assertIn('id="engine-A&lt;&amp;&quot;B"', page)
        self.assertIn('href="#engine-A&lt;&amp;&quot;B"', page)
        self.assertIn("x&lt;&amp;&quot;y", page)
        self.assertIn("<code>INHERIT_TYPE A&lt;&amp;&quot;B &lt;b&gt;</code>", page)
        self.assertIn("&lt;i&gt;ENG&lt;/i&gt;", page)


class RecordDossierRejectTests(RecordDossierTestCase):
    def mutate(self, path, value, which="engines"):
        data = engines_json() if which == "engines" else gearboxes_json()
        target = data
        for key in path[:-1]:
            target = target[key]
        if value is KeyError:
            del target[path[-1]]
        else:
            target[path[-1]] = value
        return {which: data}

    def test_malformed_containers(self):
        cases = [
            (("records",), {}, "engines.json.records has the wrong type"),
            (("records",), [], "engines.json has no records"),
            (("source",), KeyError, "engines.json has no 'source'"),
            (("sha256",), None, "engines.json.sha256 has the wrong type"),
            (("records", 0), [], "engines.json.records[0] must be an object"),
            (("records", 0, "type"), KeyError, "records[0] has no 'type'"),
            (("records", 0, "line"), KeyError, "records[0] has no 'line'"),
            (("records", 0, "line"), "1", "records[0].line has the wrong type"),
            (("records", 0, "fields"), KeyError, "records[0] has no 'fields'"),
            (("records", 0, "fields"), [], "records[0].fields has the wrong type"),
            (("records", 0, "fields", "CAPACITY"), [], "fields.CAPACITY must be an object"),
            (("records", 0, "fields", "CAPACITY", "values"), [{}], "fields.CAPACITY.values must be scalars"),
            (("records", 0, "fields", "TORQUE_ARRAY", "rows"), [[0, 1], [2]], "TORQUE_ARRAY.rows differ in column count"),
            (("records", 0, "fields", "TORQUE_ARRAY", "rows"), [[]], "TORQUE_ARRAY.rows must be non-empty lists"),
            (("records", 1, "fields", "INHERIT_TYPE", "values"), ["BASE", "X"], "INHERIT_TYPE.values must name one parent"),
            (("records", 3, "untagged"), {}, "records[3].untagged must be a list"),
            (("records", 3, "untagged", 0, "tokens"), [1], "untagged[0].tokens must be strings"),
        ]
        for path, value, message in cases:
            with self.subTest(path=path, value=value):
                self.reject(message, **self.mutate(path, value))
        self.reject("engines.json must be an object", engines=[])

    def test_malformed_gearboxes_block_both_pages(self):
        self.reject("gearboxes.json.records[1] has no 'type'", **self.mutate(("records", 1, "type"), KeyError, "gearboxes"))

    def test_inherit_type_must_name_an_earlier_record(self):
        for parent in ("GRANDCHILD", "CHILD", "NOWHERE"):
            with self.subTest(parent=parent):
                engines = engines_json()
                engines["records"][1]["fields"]["INHERIT_TYPE"]["values"] = [parent]
                self.reject(f"engines.json: 'CHILD' inherits {parent!r}, which is not an earlier record", engines)

    def test_inherit_type_must_stay_within_the_file(self):
        gearboxes = gearboxes_json()
        gearboxes["records"][1]["fields"]["INHERIT_TYPE"] = {"line": 5, "values": ["BASE"], "rows": []}
        self.reject("gearboxes.json: 'TRACK' inherits 'BASE', which is not an earlier record", gearboxes=gearboxes)

    def test_duplicate_record_names(self):
        engines = engines_json()
        engines["records"][2]["type"] = "BASE"
        self.reject("engines.json has duplicate record name 'BASE'", engines)

    def test_pe_metadata_without_sha256(self):
        for pe in ({k: v for k, v in PE.items() if k != "sha256"}, {**PE, "sha256": ""}, []):
            with self.subTest(pe=type(pe).__name__):
                self.reject("PE metadata has no sha256", pe=pe)

    def test_missing_input(self):
        with self.assertRaises(ValueError) as caught:
            record_dossier.build(self.root / "absent.json", self.write("gearboxes.json", gearboxes_json()),
                                 REPO_ROOT / "analysis/pe-metadata.json", self.output)
        self.assertIn("run scripts/text_database.py first", str(caught.exception))
        self.assertFalse(self.output.exists())


class RecordDossierCommandTests(RecordDossierTestCase):
    SCRIPT = REPO_ROOT / "scripts/record_dossier.py"

    def run_script(self, engines, gearboxes=None, env=None):
        gearboxes = gearboxes_json() if gearboxes is None else gearboxes
        engines_path = self.write("engines.json", engines) if not isinstance(engines, Path) else engines
        return subprocess.run([sys.executable, str(self.SCRIPT), "--engines", str(engines_path),
                               "--gearboxes", str(self.write("gearboxes.json", gearboxes)),
                               "--output-dir", str(self.output)], capture_output=True, text=True, check=False, env=env)

    def test_cli_writes_both_pages(self):
        result = self.run_script(engines_json())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Wrote 4 engine and 2 gearbox records", result.stdout)
        self.assertIn('id="engine-LONER"', self.pages[0].read_text(encoding="utf-8"))
        self.assertIn('id="gearbox-TRACK"', self.pages[1].read_text(encoding="utf-8"))

    def test_cli_uses_utf8_even_with_an_ascii_locale(self):
        engines = engines_json()
        engines["source"] = "Veri/Türkçe.DAT"
        result = self.run_script(engines, env={**os.environ, "LC_ALL": "C", "PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Veri/Türkçe.DAT", self.pages[0].read_bytes().decode("utf-8"))

    def test_cli_fails_loudly_without_writing(self):
        engines = engines_json()
        engines["records"][1]["fields"]["INHERIT_TYPE"]["values"] = ["LONER"]
        for bad in (engines, self.write("broken.json", "{not json")):
            with self.subTest(bad=type(bad).__name__):
                result = self.run_script(bad)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("record_dossier.py: ", result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                for page in self.pages:
                    self.assertFalse(page.exists())

    def test_help_documents_flags_and_defaults(self):
        result = subprocess.run([sys.executable, str(self.SCRIPT), "--help"], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0)
        text = " ".join(result.stdout.split()).replace("- ", "-")
        for flag in ("--engines", "--gearboxes", "--pe", "--output-dir"):
            self.assertIn(flag, text)
        for default in ("artifacts/text-databases/engines.json", "artifacts/text-databases/gearboxes.json",
                        "pe-metadata.json", "artifacts/dossier"):
            self.assertRegex(text, rf"default: [^)]*{re.escape(default)}\)")


if __name__ == "__main__":
    unittest.main()
