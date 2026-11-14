"""PCG catalogue tests: synthetic fixtures for each refusal, plus the committed analysis/ files."""
import copy
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
import pcg_catalogue
from text_database import REPO_ROOT

PE = json.loads((REPO_ROOT / "analysis/pe-metadata.json").read_text())
SCRIPT = REPO_ROOT / "scripts/pcg_catalogue.py"


def entry(index, name, offset, width, height, extra=0):
    declared = width * height * 2
    words = [0, 1, width, height, width, height, 1, 1, 1, 0, declared] + [0] * 21
    return {"index": index, "name": name, "name_raw_hex": name.encode().ljust(12, b"\0").hex(), "file_offset": offset,
            "width": width, "height": height, "header_words": words, "declared_payload_bytes": declared,
            "span_bytes": 128 + declared + extra, "extra_bytes": extra}


def collection(path, entries):
    return {"path": path, "count": len(entries), "year_word": 2004, "creation_metadata_hex": "0c0f0c1e",
            "reserved_word": 0, "payload_base": pcg_catalogue.payload_base(len(entries)), "entries": entries}


def pcg_index():
    return [collection("GRAPHICS/A/graphics.pcg", [entry(0, "first", 128, 4, 2), entry(1, "bar", 272, 2, 2, extra=1024)]),
            collection("GRAPHICS/B C/graphics.pcg", [entry(0, "only", 128, 8, 8)])]


def manifest():
    return [{"path": path, "input_size": 100 + i, "decoded_size": 1000 + i, "input_sha256": f"{i:x}" * 64,
             "decoded_sha256": f"{i + 5:x}" * 64}
            for i, path in enumerate(["GRAPHICS/A/graphics.pcg", "GRAPHICS/B C/graphics.pcg", "OTHER/file.DXT"])]


def verification():
    return {"pcg_collections_verified": 2, "pcg_entries_verified": 3}


class Page(HTMLParser):
    """Collects ids, hrefs, <script> tags and section ids."""

    def __init__(self, text):
        super().__init__()
        self.ids, self.hrefs, self.scripts, self.sections = [], [], 0, []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag == "a" and "href" in attrs:
            self.hrefs.append(attrs["href"])
        if tag == "script":
            self.scripts += 1
        if tag == "section":
            self.sections.append(attrs.get("id"))


def rows(page):
    """Map each entry row's id to its one-line HTML."""
    return dict(re.findall(r'^<tr id="([^"]+)">(.*)</tr>$', page, re.M))


class CatalogueTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.output = self.root / "dossier/pcg.html"

    def write(self, name, data):
        path = self.root / name
        path.write_text(data if isinstance(data, str) else json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path

    def paths(self, index=None, files=None, pe=PE, results=None):
        return (self.write("pcg-index.json", pcg_index() if index is None else index),
                self.write("manifest.json", manifest() if files is None else files), self.write("pe.json", pe),
                self.write("verification.json", verification() if results is None else results))

    def build(self, **inputs):
        counts = pcg_catalogue.build(*self.paths(**inputs), self.output, revision="0123abcd")
        self.assertEqual(counts, (2, 3))
        return self.output.read_text(encoding="utf-8")

    def reject(self, fragment, **inputs):
        with self.assertRaises(ValueError) as caught:
            pcg_catalogue.build(*self.paths(**inputs), self.output, revision="0123abcd")
        self.assertIn(fragment, str(caught.exception))
        self.assertFalse(self.output.exists())


class CataloguePageTests(CatalogueTestCase):
    def test_sections_rows_and_statuses(self):
        page = self.build()
        self.assertEqual(Page(page).sections, ["pcg-GRAPHICS-A-graphics.pcg", "pcg-GRAPHICS-B-C-graphics.pcg"])
        found = rows(page)
        self.assertEqual(list(found), ["pcg-GRAPHICS-A-graphics.pcg-e0", "pcg-GRAPHICS-A-graphics.pcg-e1",
                                       "pcg-GRAPHICS-B-C-graphics.pcg-e0"])
        for row in found.values():
            self.assertEqual(re.findall(r'<td class="status status-([a-z-]+)">([^<]*)</td>', row),
                             [("not-decoded", "not decoded: pixel encoding not established")])
        self.assertEqual(page.count('class="status'), 3)

    def test_extra_bytes_are_unresolved(self):
        found = rows(self.build())
        self.assertIn('<span class="num">1024</span> <span class="label">unresolved</span>',
                      found["pcg-GRAPHICS-A-graphics.pcg-e1"])
        self.assertEqual([key for key, row in found.items() if "unresolved" in row], ["pcg-GRAPHICS-A-graphics.pcg-e1"])

    def test_header_words_are_labelled(self):
        row = rows(self.build())["pcg-GRAPHICS-A-graphics.pcg-e0"]
        labelled = re.findall(r'<td class="num">\+0x([0-9a-f]{2})</td><td class="num">(\d+)</td>'
                              r'<td class="num">0x[0-9a-f]{8}</td><td>([^<]*|<strong>[^<]*</strong>)</td>', row)
        self.assertEqual(len(labelled), 32)
        meanings = {offset: meaning for offset, _, meaning in labelled}
        self.assertEqual(meanings.pop("08"), "<strong>width</strong>")
        self.assertEqual(meanings.pop("0c"), "<strong>height</strong>")
        self.assertEqual(meanings.pop("28"), "<strong>declared payload bytes</strong>")
        self.assertEqual(set(meanings.values()), {"meaning not established"})
        self.assertIn("<details><summary>32 header words</summary>", row)

    def test_collection_index_and_hashes(self):
        page = self.build()
        index = page[page.index('<h2 id="collections">'):page.index('<section class="collection"')]
        for i, item in enumerate(manifest()[:2]):
            with self.subTest(path=item["path"]):
                self.assertIn(f'<a href="#{pcg_catalogue.collection_id({"path": item["path"]})}">{item["path"]}</a>', index)
                section = page[page.index(f'id="{pcg_catalogue.collection_id({"path": item["path"]})}"'):]
                section = section[:section.index("</section>")]
                for text in (index, section):
                    self.assertIn(item["input_sha256"], text)
                    self.assertIn(item["decoded_sha256"], text)
                    self.assertIn(f'<span class="num">{100 + i}</span>', text)
        self.assertNotIn("OTHER/file.DXT", page)

    def test_header_identity_and_scope(self):
        page = self.build()
        self.assertIn(f'SHA-256 <code>{PE["sha256"]}</code>', page)
        self.assertIn("<code>0123abcd</code>", page)
        self.assertIn("PCG directory structure only; no pixel data is decoded or shown", page)
        self.assertIn("<code>(16 + count*16 + 127) &amp; ~127</code>", page)
        self.assertIn("<code>0x00423b20</code>", page)
        self.assertIn("<dt>Collections</dt><dd>2</dd><dt>Graphics</dt><dd>3</dd>", page)

    def test_anchors_links_and_no_scripts(self):
        page = self.build()
        parsed = Page(page)
        self.assertEqual(len(parsed.ids), len(set(parsed.ids)))
        internal = [href[1:] for href in parsed.hrefs if href.startswith("#")]
        self.assertTrue(internal)
        self.assertEqual([href for href in internal if href not in parsed.ids], [])
        self.assertEqual(parsed.scripts, 0)
        self.assertNotIn("<script", page.lower())
        self.assertNotRegex(page, r"https?://")
        files = {href for href in parsed.hrefs if not href.startswith("#")} - {"engines.html", "gearboxes.html", "tyres.html"}
        self.assertEqual({Path(os.path.normpath(self.output.parent / href)) for href in files},
                         {pcg_catalogue.VIEW_ASM, (self.root / "pcg-index.json").resolve(),
                          (self.root / "manifest.json").resolve()})

    def test_nav_bar(self):
        self.assertIn('<nav>Dossiers: <a href="engines.html">Engines</a> | <a href="gearboxes.html">Gearboxes</a> | '
                      '<a href="tyres.html">Tyres</a> | <strong>PCG catalogue</strong></nav>', self.build())

    def test_hostile_entry_name_is_escaped(self):
        index = pcg_index()
        index[0]["entries"][0]["name"] = '<script>"x"&</script>'
        index[0]["path"] = 'GRAPHICS/A"<b>/graphics.pcg'
        files = manifest()
        files[0]["path"] = index[0]["path"]
        page = self.build(index=index, files=files)
        self.assertNotIn("<script", page)
        self.assertNotIn('A"<b>', page)
        self.assertIn("<code>&lt;script&gt;&quot;x&quot;&amp;&lt;/script&gt;</code>", page)
        self.assertIn("GRAPHICS/A&quot;&lt;b&gt;/graphics.pcg", page)
        parsed = Page(page)
        self.assertEqual(len(parsed.ids), len(set(parsed.ids)))
        self.assertEqual([href for href in parsed.hrefs if href.startswith("#") and href[1:] not in parsed.ids], [])


class CatalogueRejectTests(CatalogueTestCase):
    def mutate(self, change):
        index = pcg_index()
        change(index)
        return index

    def test_missing_input(self):
        with self.assertRaises(ValueError) as caught:
            pcg_catalogue.build(self.root / "absent.json", *self.paths()[1:], self.output)
        self.assertIn("PCG index not found", str(caught.exception))
        self.assertFalse(self.output.exists())

    def test_malformed_json(self):
        with self.assertRaises(ValueError):
            pcg_catalogue.build(self.write("broken.json", "[{"), *self.paths()[1:], self.output)
        self.assertFalse(self.output.exists())

    def test_malformed_containers(self):
        cases = [
            ("pcg-index.json must be a non-empty list", {"index": {}}),
            ("pcg-index.json must be a non-empty list", {"index": []}),
            ("pcg-index.json[0] has no 'entries'", {"index": self.mutate(lambda i: i[0].pop("entries"))}),
            ("pcg-index.json[0].count has the wrong type", {"index": self.mutate(lambda i: i[0].update(count="2"))}),
            ("pcg-index.json[0].count must be a non-negative integer", {"index": self.mutate(lambda i: i[0].update(count=True))}),
            (".entries[1] must be an object", {"index": self.mutate(lambda i: i[0]["entries"].__setitem__(1, []))}),
            (".entries[0] has no 'span_bytes'", {"index": self.mutate(lambda i: i[0]["entries"][0].pop("span_bytes"))}),
            (".header_words must be 32 unsigned 32-bit integers",
             {"index": self.mutate(lambda i: i[0]["entries"][0]["header_words"].pop())}),
            (".header_words must be 32 unsigned 32-bit integers",
             {"index": self.mutate(lambda i: i[0]["entries"][0]["header_words"].__setitem__(5, -1))}),
            ("unpacked-manifest.json must be a list", {"files": {}}),
            ("unpacked-manifest.json[0] has no 'decoded_sha256'",
             {"files": [{key: value for key, value in manifest()[0].items() if key != "decoded_sha256"}]}),
            ("verification.json has no 'pcg_entries_verified'", {"results": {"pcg_collections_verified": 2}}),
            ("PE metadata has no sha256", {"pe": {"file": "fr3.exe"}}),
        ]
        for fragment, inputs in cases:
            with self.subTest(fragment=fragment):
                self.reject(fragment, **inputs)

    def test_duplicate_collection_path(self):
        self.reject("pcg-index.json has duplicate collection path 'GRAPHICS/A/graphics.pcg'",
                    index=self.mutate(lambda i: i[1].update(path=i[0]["path"])))

    def test_count_disagrees_with_entries(self):
        def change(index):
            index[0]["count"] = 3
            index[0]["payload_base"] = pcg_catalogue.payload_base(3)
        self.reject("count is 3 but it lists 2 entries", index=self.mutate(change))

    def test_indexes_out_of_order(self):
        def change(index):
            index[0]["entries"][0]["index"], index[0]["entries"][1]["index"] = 1, 0
        self.reject(".entries[0].index is 1; indexes must run 0..count-1 in order", index=self.mutate(change))
        self.reject(".entries[1].index is 2", index=self.mutate(lambda i: i[0]["entries"][1].update(index=2)))

    def test_dimensions_disagree_with_header_words(self):
        for field, word in (("width", 2), ("height", 3), ("declared_payload_bytes", 10)):
            with self.subTest(field=field):
                index = pcg_index()
                index[0]["entries"][0]["header_words"][word] += 1
                self.reject(f".entries[0].{field} is {index[0]['entries'][0][field]} but header word {word} "
                            f"(+0x{word * 4:02x})", index=index)

    def test_extra_bytes_disagree_with_span(self):
        self.reject(".entries[1].extra_bytes is 1024 but span_bytes - 128 - declared_payload_bytes is 1025",
                    index=self.mutate(lambda i: i[0]["entries"][1].update(span_bytes=i[0]["entries"][1]["span_bytes"] + 1)))

    def test_payload_base_disagrees_with_formula(self):
        self.reject("payload_base is 256 but (16 + count*16 + 127) & ~127 is 128",
                    index=self.mutate(lambda i: i[1].update(payload_base=256)))

    def test_collection_without_manifest_entry(self):
        self.reject("pcg-index.json 'GRAPHICS/B C/graphics.pcg' has no unpacked-manifest.json entry",
                    files=[item for item in manifest() if item["path"] != "GRAPHICS/B C/graphics.pcg"])

    def test_duplicate_manifest_path(self):
        files = manifest()
        self.reject("unpacked-manifest.json has duplicate path", files=[*files, copy.deepcopy(files[0])])

    def test_totals_disagree_with_verification(self):
        self.reject("pcg-index.json has 2 collections but verification.json verified 3",
                    results={**verification(), "pcg_collections_verified": 3})
        self.reject("pcg-index.json has 3 entries but verification.json verified 4",
                    results={**verification(), "pcg_entries_verified": 4})

    def test_colliding_anchors(self):
        # "/" and "?" both become "-" in an anchor, so these two paths would share one.
        self.reject("anchor 'pcg-GRAPHICS-A-graphics.pcg' is not unique",
                    index=self.mutate(lambda i: i[1].update(path="GRAPHICS/A?graphics.pcg")),
                    files=[*manifest(), {**manifest()[0], "path": "GRAPHICS/A?graphics.pcg"}])


class CatalogueCommandTests(CatalogueTestCase):
    def run_script(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False)

    def test_committed_analysis_files(self):
        """The real committed inputs: 62 collections, 654 rows, two unresolved extra-byte entries."""
        result = self.run_script("--output", str(self.output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Wrote 62 collections and 654 graphics", result.stdout)
        page = self.output.read_text(encoding="utf-8")
        parsed = Page(page)
        self.assertEqual(len(parsed.sections), 62)
        found = rows(page)
        self.assertEqual(len(found), 654)
        self.assertEqual(len(re.findall(r'(?m)^.*class="status', page)), 654)
        for row in found.values():
            self.assertEqual(len(re.findall(r'<td class="status status-not-decoded">', row)), 1)
        unresolved = {key for key, row in found.items() if 'class="label">unresolved' in row}
        self.assertEqual(len(unresolved), 2)
        for key in unresolved:
            self.assertTrue(key.startswith("pcg-GRAPHICS-LOADING-graphics.pcg-e"))
            self.assertIn('<span class="num">1024</span> <span class="label">unresolved</span>', found[key])
        names = {re.search(r"<td><code>([^<]*)</code>", found[key]).group(1) for key in unresolved}
        self.assertEqual(names, {"_loadbar", "_loadbr2"})
        self.assertEqual(len(parsed.ids), len(set(parsed.ids)))
        self.assertEqual([href for href in parsed.hrefs if href.startswith("#") and href[1:] not in parsed.ids], [])
        self.assertEqual(parsed.scripts, 0)
        self.assertNotRegex(page, r"https?://")
        self.assertEqual(page.count("<details><summary>32 header words</summary>"), 654)

    def test_cli_fails_loudly(self):
        index = pcg_index()
        index[0]["count"] = 5
        result = self.run_script("--index", str(self.write("bad.json", index)), "--output", str(self.output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("pcg_catalogue.py: pcg-index.json 'GRAPHICS/A/graphics.pcg': count is 5", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(self.output.exists())

    def test_help_documents_flags_and_defaults(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0)
        text = " ".join(result.stdout.split()).replace("- ", "-")
        for flag in ("--index", "--manifest", "--pe", "--verification", "--output"):
            self.assertIn(flag, text)
        for default in ("pcg-index.json", "unpacked-manifest.json", "pe-metadata.json", "verification.json", "pcg.html"):
            self.assertRegex(text, rf"default: [^)]*{re.escape(default)}\)")


if __name__ == "__main__":
    unittest.main()
