"""Routine index tests: synthetic fixtures for the page and each refusal, plus the committed analysis/ files."""
import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dossier_common import NOTICE_LINKS, rights_notice
import routine_index
from text_database import REPO_ROOT

from test_pcg_catalogue import Page

# extract_selected imports capstone and pefile, which only the disassembly export needs.
try:
    from extract_selected import ROUTINES
except ImportError:
    ROUTINES = None

PE = json.loads((REPO_ROOT / "analysis/pe-metadata.json").read_text())
SCRIPT = REPO_ROOT / "scripts/routine_index.py"


def routine(va, label, decompiled=True, error=""):
    return {"entry_va": f"{va:08x}", "label": label, "signature": f"int {label}(void * reader)",
            "return_storage": "EAX:4", "parameter_storage": ["reader:EAX:4"], "decompiled": decompiled,
            "error": error}


def status():
    # fr3_shared_b is listed before fr3_shared_a although its entry VA is higher, as in the committed status.json.
    return [routine(0x1000, "fr3_alone"), routine(0x2020, "fr3_shared_b"), routine(0x2000, "fr3_shared_a"),
            routine(0x3000, "fr3_no_asm")]


def block(va, label, body="  return 0;"):
    return f"\n/* {va:08x} {label} */\n\nint {label}(void)\n\n{{\n{body}\n}}\n"


def pseudocode(routines=None):
    body = {"fr3_alone": "  if (a < b && c > d) { s = \"<script>\"; }"}
    return "/* Analyst-labelled Ghidra pseudocode. */\n" + "".join(
        block(int(item["entry_va"], 16), item["label"], body.get(item["label"], "  return 0;"))
        for item in (status() if routines is None else routines))


ASM = {"alone.asm": (0x1000, 0x1100), "shared.asm": (0x2000, 0x2040), "other.asm": (0x4000, 0x4010)}


def asm_text(name, start, end):
    return (f"; Analyst label: {Path(name).stem}; export span 0x{start:08x}..0x{end:08x}\n"
            "; Linear decoding may include padding or neighboring code.\n"
            f"{start:08x} 55                       push ebp\n")


def evidence():
    return [{"va": 0x1004, "bytes": "8b4014", "claim": "alone reads + 0x14 & <more>"},
            {"va": 0x2004, "bytes": "8b504c", "claim": "shared a reads + 0x4c"},
            {"va": 0x2024, "bytes": "8b5050", "claim": "shared b reads + 0x50"},
            {"va": 0x4002, "bytes": "89424c", "claim": "other store at + 0x4c"},
            {"va": 0x5000, "bytes": "d95028", "claim": "outside every span"}]


class RoutineTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.output = self.root / "dossier/routines.html"
        self.status, self.c, self.evidence = self.root / "status.json", self.root / "selected.c", self.root / "ev.json"
        self.selected = self.root / "selected"
        self.selected.mkdir()
        self.write(status(), pseudocode(), evidence(), ASM)

    def write(self, routines=None, c=None, sites=None, asm=None):
        if routines is not None:
            self.status.write_text(json.dumps(routines), encoding="utf-8")
        if c is not None:
            self.c.write_text(c, encoding="utf-8")
        if sites is not None:
            self.evidence.write_text(json.dumps(sites), encoding="utf-8")
        for name, (start, end) in (asm or {}).items():
            (self.selected / name).write_text(asm_text(name, start, end), encoding="utf-8")

    def build(self, **kwargs):
        counts = routine_index.build(self.status, self.c, self.selected, self.evidence,
                                     REPO_ROOT / "analysis/pe-metadata.json", self.output, revision="0123abcd", **kwargs)
        self.assertEqual(counts, (4, 3, 5))
        return self.output.read_text(encoding="utf-8")

    def refuse(self, fragment):
        with self.assertRaises(ValueError) as caught:
            routine_index.build(self.status, self.c, self.selected, self.evidence,
                                REPO_ROOT / "analysis/pe-metadata.json", self.output, revision="0123abcd")
        self.assertIn(fragment, str(caught.exception))
        self.assertFalse(self.output.exists())


def sections(page):
    """Map each routine or file section id to its HTML."""
    return dict(re.findall(r'<section class="(?:routine|asm)" id="([^"]+)">(.*?)</section>', page, re.S))


def site_vas(html):
    return re.findall(r'<tr class="site" id="site-([0-9a-f]{8})">', html)


class PageTests(RoutineTestCase):
    def test_summary_lists_every_routine_in_status_order(self):
        page = self.build()
        summary = page[page.index('id="summary"'):page.index("</table>", page.index('id="summary"'))]
        labels = re.findall(r'<td><a href="#([^"]+)"><code>', summary)
        self.assertEqual(labels, ["fr3_alone", "fr3_shared_b", "fr3_shared_a", "fr3_no_asm"])
        self.assertIn("<code>int fr3_alone(void * reader)</code>", summary)
        self.assertIn("<td><code>EAX:4</code></td><td><code>reader:EAX:4</code></td><td>yes</td>", summary)

    def test_one_section_per_routine_with_escaped_pseudocode(self):
        page = self.build()
        self.assertEqual(page.count('<section class="routine"'), 4)
        found = sections(page)
        alone = found["fr3_alone"]
        self.assertIn("<pre>/* 00001000 fr3_alone */", alone)
        self.assertIn("if (a &lt; b &amp;&amp; c &gt; d) { s = &quot;&lt;script&gt;&quot;; }", alone)
        self.assertNotIn("<script", page.lower())
        self.assertNotIn("fr3_shared_b", alone.split("<details>")[1], "a block must stop at the next header")

    def test_disassembly_links_by_span(self):
        page = self.build()
        found = sections(page)
        self.assertIn("alone.asm</code></a> (export span 0x00001000..0x00001100)", found["fr3_alone"])
        for label, other in (("fr3_shared_a", "fr3_shared_b"), ("fr3_shared_b", "fr3_shared_a")):
            self.assertIn("shared.asm</code></a>", found[label])
            self.assertIn(f'Shared with <a href="#{other}"><code>{other}</code></a>.', found[label])
        self.assertIn("No committed disassembly file's export span holds this entry VA.", found["fr3_no_asm"])
        self.assertIn("other.asm</code></a>", found["asm-other"])
        links = {Path(os.path.normpath(self.output.parent / href))
                 for href in re.findall(r'href="([^"#][^"]*)"', page) if href.endswith(".asm")}
        self.assertEqual(links, {(self.selected / name).resolve() for name in ASM})

    def test_every_site_is_shown_once_where_it_belongs(self):
        page = self.build()
        found = sections(page)
        self.assertEqual(sorted(site_vas(page)), sorted(f"{site['va']:08x}" for site in evidence()))
        self.assertEqual(site_vas(found["fr3_alone"]), ["00001004"])
        # Sites in a shared file go to the nearest entry at or below them, whatever the status.json order.
        self.assertEqual(site_vas(found["fr3_shared_a"]), ["00002004"])
        self.assertEqual(site_vas(found["fr3_shared_b"]), ["00002024"])
        self.assertEqual(site_vas(found["fr3_no_asm"]), [])
        self.assertIn("None of the byte-checked sites is placed under this routine.", found["fr3_no_asm"])
        self.assertEqual(site_vas(found["asm-other"]), ["00004002"])
        unplaced = page[page.index('id="unplaced-sites"'):]
        self.assertEqual(site_vas(unplaced), ["00005000"])
        self.assertIn("<td>alone reads + 0x14 &amp; &lt;more&gt;</td>", page)

    def test_site_before_every_entry_in_its_file_is_unplaced(self):
        self.write(asm={"shared.asm": (0x1ff0, 0x2040)})
        self.write(sites=[*evidence()[:-1], {"va": 0x1ff4, "bytes": "90", "claim": "before the entries"}])
        page = self.build()
        self.assertEqual(site_vas(page[page.index('id="unplaced-sites"'):]), ["00001ff4"])

    def test_no_unplaced_sites_or_other_files(self):
        (self.selected / "other.asm").unlink()
        self.write(sites=evidence()[:3])
        page = routine_index.build(self.status, self.c, self.selected, self.evidence,
                                   REPO_ROOT / "analysis/pe-metadata.json", self.output, revision="0123abcd")
        self.assertEqual(page, (4, 2, 3))
        text = self.output.read_text(encoding="utf-8")
        self.assertIn("None: every disassembly file holds an annotated routine's entry VA.", text)
        self.assertIn("None: every byte-checked site is listed above.", text)

    def test_scope_identity_and_notice(self):
        page = self.build()
        for text in ("analyst-assigned, not an original symbol", "callees stay unresolved",
                     "types are inferred", f'SHA-256 <code>{PE["sha256"]}</code>', "<code>0123abcd</code>",
                     "<dt>Routines</dt><dd>4</dd>", "<dt>Byte-checked sites</dt><dd>5</dd>"):
            self.assertIn(text, page)
        self.assertEqual(page.count(rights_notice()), 1)
        self.assertLess(page.index(rights_notice()), page.index("<h1>"))
        self.assertIn('<a href="pcg.html">PCG catalogue</a> | <strong>Routines</strong> | <a href="questions.html">Open questions</a></nav>', page)
        self.assertNotIn("index.html", page)

    def test_anchors_are_unique_and_resolve(self):
        page = self.build()
        parsed = Page(page)
        self.assertEqual(len(parsed.ids), len(set(parsed.ids)))
        internal = [href[1:] for href in parsed.hrefs if href.startswith("#")]
        self.assertEqual([href for href in internal if href not in parsed.ids], [])
        self.assertFalse([href for href in parsed.hrefs if "://" in href and href not in NOTICE_LINKS])
        self.assertEqual(parsed.scripts, 0)

    def test_failed_decompilation_shows_the_error(self):
        routines = status()
        routines[3] = routine(0x3000, "fr3_no_asm", decompiled=False, error="Timed <out>")
        self.write(routines, pseudocode(routines[:3]))
        page = self.build()
        self.assertIn("<td>no: Timed &lt;out&gt;</td>", page)
        self.assertIn("No pseudocode: decompilation failed (Timed &lt;out&gt;).", sections(page)["fr3_no_asm"])

    def test_given_hrefs(self):
        hrefs = {"status": "evidence/s.json", "pseudocode": "evidence/c.c", "evidence": "evidence/e.json",
                 **{name: f"evidence/{name}" for name in ASM}}
        page = self.build(hrefs=hrefs, entrance=True)
        for href in hrefs.values():
            self.assertIn(f'href="{href}"', page)
        self.assertIn('<a href="index.html">Explore findings</a>', page)
        del hrefs["other.asm"]
        with self.assertRaisesRegex(ValueError, "No link given for: other.asm"):
            self.build(hrefs=hrefs)


class RefusalTests(RoutineTestCase):
    def test_label_that_repeats_an_id_in_the_rights_notice(self):
        # Read the ids from the notice itself, so one added to it later has to be reserved too.
        notice_ids = Page(rights_notice()).ids
        self.assertEqual(notice_ids, ["rights-notice", "rights-title"])
        for label in notice_ids:
            with self.subTest(label=label):
                routines = [routine(0x1000, label), *status()[1:]]
                self.write(routines, pseudocode(routines))
                self.refuse(f"These page anchors are not unique: {label}")

    def test_selected_c_lacks_a_routine(self):
        self.write(c=pseudocode(status()[:3]))
        self.refuse("status.json routine fr3_no_asm (00003000) has no block in selected.c")

    def test_selected_c_has_an_extra_routine(self):
        self.write(c=pseudocode() + block(0x6000, "fr3_extra"))
        self.refuse("selected.c routine fr3_extra (00006000) is not a decompiled routine in status.json")

    def test_labels_disagree(self):
        self.write(c=pseudocode().replace("/* 00001000 fr3_alone */", "/* 00001000 fr3_renamed */"))
        self.refuse("entry VA 00001000 is fr3_alone in status.json but fr3_renamed in selected.c")

    def test_block_for_a_failed_routine(self):
        routines = status()
        routines[0] = routine(0x1000, "fr3_alone", decompiled=False, error="failed")
        self.write(routines)
        self.refuse("selected.c routine fr3_alone (00001000) is not a decompiled routine in status.json")

    def test_duplicate_block(self):
        self.write(c=pseudocode() + block(0x1000, "fr3_alone"))
        self.refuse("selected.c has two blocks for entry VA 00001000")

    def test_no_blocks(self):
        self.write(c="/* nothing */\n")
        self.refuse("selected.c has no `/* <entry VA> <label> */` routine headers")

    def test_malformed_status(self):
        cases = (([], "status.json must be a non-empty list"),
                 ([{**routine(0x1000, "a"), "entry_va": "0x1000"}], "status.json[0].entry_va must be 8 lowercase hex"),
                 ([{**routine(0x1000, "a"), "label": "bad label"}], "is not usable as an anchor"),
                 ([{**routine(0x1000, "a"), "parameter_storage": [1]}], "parameter_storage must be a list of strings"),
                 ([{**routine(0x1000, "a"), "decompiled": "yes"}], "status.json[0].decompiled has the wrong type"),
                 ([routine(0x1000, "a"), routine(0x1000, "b")], "lists entry VA 00001000 twice"),
                 ([routine(0x1000, "a"), routine(0x2000, "a")], "lists label 'a' twice"))
        for routines, fragment in cases:
            with self.subTest(fragment=fragment):
                self.write(routines)
                self.refuse(fragment)

    def test_malformed_asm_headers(self):
        cases = (("", "alone.asm does not start with"),
                 ("; Linear decoding only\n", "alone.asm does not start with"),
                 ("; Analyst label: alone; export span 0x1000..0x1100\n", "alone.asm does not start with"),
                 ("; Analyst label: alone; export span 0x00001000..0x00001100 trailing\n", "alone.asm does not start"),
                 ("; Analyst label: other; export span 0x00001000..0x00001100\n",
                  "alone.asm: its header labels it 'other', not 'alone'"),
                 ("; Analyst label: alone; export span 0x00001100..0x00001000\n", "is empty or reversed"),
                 ("; Analyst label: alone; export span 0x00001000..0x00001000\n", "is empty or reversed"))
        for text, fragment in cases:
            with self.subTest(text=text):
                (self.selected / "alone.asm").write_text(text, encoding="utf-8")
                self.refuse(fragment)

    def test_no_asm_files(self):
        for path in self.selected.glob("*.asm"):
            path.unlink()
        self.refuse("No .asm files in")

    def test_site_shown_twice_through_overlapping_spans(self):
        self.write(asm={"other.asm": (0x0ff0, 0x1010)})
        self.refuse("Every byte-checked site must be shown exactly once: 0x00001004 would be shown 2 times")

    def test_repeated_site(self):
        self.write(sites=[*evidence(), copy.deepcopy(evidence()[0])])
        self.refuse("field-evidence.json lists these VAs more than once: 0x00001004")

    def test_malformed_site(self):
        self.write(sites=[{"va": "0x1004", "bytes": "90", "claim": "x"}])
        self.refuse("Malformed field-evidence site")

    def test_missing_input(self):
        self.c.unlink()
        self.refuse("Pseudocode not found")

    def test_dropped_or_extra_site_is_refused(self):
        sites = evidence()
        with self.assertRaisesRegex(ValueError, "0x00001004 would be shown 0 times"):
            routine_index.check_placements(sites, sites[1:])
        with self.assertRaisesRegex(ValueError, "0x00001004 would be shown 2 times"):
            routine_index.check_placements(sites, sites, sites[:1])
        with self.assertRaisesRegex(ValueError, "0x00009999 is not in field-evidence.json"):
            routine_index.check_placements(sites, sites, [{"va": 0x9999}])
        routine_index.check_placements(sites, sites[:2], sites[2:])

    def test_pe_without_sha256(self):
        pe = self.root / "pe.json"
        pe.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "PE metadata has no sha256"):
            routine_index.build(self.status, self.c, self.selected, self.evidence, pe, self.output)


class CommittedFilesTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.output = Path(directory.name) / "routines.html"

    def run_script(self, *args, script=SCRIPT):
        # A wide terminal, so argparse does not wrap the default paths at their hyphens.
        return subprocess.run([sys.executable, str(script), *args], capture_output=True, text=True, check=False,
                              timeout=60, env={**os.environ, "COLUMNS": "1000"})

    def test_builds_from_the_committed_analysis_files(self):
        result = self.run_script("--output", str(self.output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Wrote 25 routines, 15 disassembly files and 189 byte-checked sites", result.stdout)
        page = self.output.read_text(encoding="utf-8")
        committed = json.loads(routine_index.STATUS.read_text(encoding="utf-8"))
        self.assertEqual(page.count('<section class="routine"'), 25)
        for item in committed:
            self.assertIn(f'<section class="routine" id="{item["label"]}">', page)
        sites = json.loads(routine_index.FIELD_EVIDENCE.read_text(encoding="utf-8"))
        self.assertEqual(sorted(site_vas(page)), sorted(f"{site['va']:08x}" for site in sites))
        asm = {Path(href).name for href in re.findall(r'href="([^"]+\.asm)"', page)}
        self.assertEqual(asm, set(routine_index.ASM_FILES))
        self.assertEqual(len(routine_index.ASM_FILES), 15)
        found = sections(page)
        self.assertEqual(site_vas(found["fr3_get_tyre_sound_info"]), ["00523f10", "00523f1c", "00523f27"])
        self.assertEqual(len(site_vas(found["fr3_load_tyre_database"])), 30)
        # The scalar copy's eleven load/store pairs and its ret.
        self.assertEqual(len(site_vas(found["fr3_copy_tyre_scalar_fields"])), 23)
        # The engine loader: allocation size, 21 dispatch compares and the stores, zero-fill, derived values,
        # enum tables and INHERIT_TYPE setup; the engine copy: every load/store pair, the block and its ret.
        engine_loader, engine_copy = site_vas(found["fr3_load_engine_database"]), site_vas(found["fr3_copy_engine_record"])
        self.assertEqual((len(engine_loader), len(engine_copy)), (72, 53))
        self.assertTrue(all(0x005227F0 <= int(va, 16) < 0x00522C80 for va in engine_loader))
        self.assertTrue(all(0x00522C80 <= int(va, 16) < 0x00522D6C for va in engine_copy))
        for name in ("fill_memory", "allocate_database_record", "create_database", "fill_memory_body"):
            self.assertIn(f"asm-{name}", found)

    def test_asm_files_names_exactly_the_committed_disassembly(self):
        committed = sorted(path.name for path in routine_index.SELECTED.glob("*.asm"))
        self.assertEqual(list(routine_index.ASM_FILES), committed)

    @unittest.skipIf(ROUTINES is None, "needs capstone and pefile from scripts/requirements.txt")
    def test_asm_files_names_every_span_extract_selected_exports(self):
        self.assertEqual(list(routine_index.ASM_FILES), sorted(f"{name}.asm" for _, _, name in ROUTINES))

    def test_missing_committed_disassembly_file_is_refused(self):
        # A copy of the scripts and their inputs, run in a new process: the list of committed files must not
        # come from whatever the working tree holds when the module is imported.
        copy_root = self.output.parent / "copy"
        shutil.copytree(REPO_ROOT / "scripts", copy_root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        for name in ("selected", "annotated"):
            shutil.copytree(REPO_ROOT / "analysis" / name, copy_root / "analysis" / name)
        shutil.copyfile(REPO_ROOT / "analysis/pe-metadata.json", copy_root / "analysis/pe-metadata.json")
        script = copy_root / "scripts/routine_index.py"
        result = self.run_script("--output", str(self.output), script=script)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("15 disassembly files", result.stdout)
        self.output.unlink()
        (copy_root / "analysis/selected/fill_memory_body.asm").unlink()
        for args in ((), ("--selected", str(copy_root / "analysis/selected"))):
            with self.subTest(args=args):
                result = self.run_script("--output", str(self.output), *args, script=script)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("routine_index.py: ", result.stderr)
                self.assertIn("lacks committed disassembly files: fill_memory_body.asm", result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                self.assertFalse(self.output.exists())

    def test_refusal_exits_non_zero_without_a_traceback(self):
        directory = self.output.parent
        bad = directory / "status.json"
        committed = json.loads(routine_index.STATUS.read_text(encoding="utf-8"))
        bad.write_text(json.dumps(committed[:-1]), encoding="utf-8")
        result = self.run_script("--status", str(bad), "--output", str(self.output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("routine_index.py: selected.c disagrees with status.json", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(self.output.exists())

    def test_help_documents_flags_and_defaults(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0)
        text = " ".join(result.stdout.split())
        for flag, default in (("--status", "annotated/status.json"), ("--pseudocode", "annotated/selected.c"),
                              ("--selected", "analysis/selected"), ("--evidence", "field-evidence.json"),
                              ("--output", "artifacts/dossier/routines.html")):
            self.assertRegex(text, rf"{flag} .*default: [^)]*{re.escape(default)}\)")


if __name__ == "__main__":
    unittest.main()
