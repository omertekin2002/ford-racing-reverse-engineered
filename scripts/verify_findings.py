"""Verify actual demo bytes, all file/resource manifests and analysis exports.

Three levels, each a fixed list of checks:
  data          the acquired demo files (scripts/acquire_demo.py inputs); no Ghidra
  instructions  inputs/fr3.exe only: PE metadata, the field-evidence sites and the regenerated bounded disassembly
  full          both, plus the Ghidra baseline, annotated export, snapshot import and C layout checks (the default)
Only full writes analysis/verification.json. --report writes what was checked to a separate JSON file.
"""
import argparse
from dataclasses import dataclass
import datetime
import functools
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import pefile
from fr3_common import ARCHIVE_SHA256, ARCHIVE_SIZE, EXE_SHA256, verified_bytes, verified_exe
from extract_selected import export_selected
from extract_tag_registry import COUNT, TABLE_VA, read_va
from index_pcg import index_pcg
from text_database import verify_text_databases
from unpack_resources import decode, has_wrapper

EXIT_FAILED = 1
EXIT_UNAVAILABLE = 3

ACQUIRE_HINT = "run `python3 scripts/acquire_demo.py inputs` to download and extract the public demo"
GHIDRA_HINT = "run `scripts/run_analysis.py` (after `scripts/setup_tools.py`) to produce the Ghidra outputs"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load(path):
    return json.loads(path.read_text())


class Context:
    """Inputs shared between checks, read once and only when a check needs them."""

    def __init__(self, root):
        self.root = root
        self.game = root / "inputs/extracted/Program_Executable_Files"
        self.verified = {}

    @functools.cached_property
    def archive(self):
        return verified_bytes(self.root / "inputs/fordracing3demo.zip", ARCHIVE_SIZE, ARCHIVE_SHA256)

    @functools.cached_property
    def executable(self):
        return verified_exe(self.root / "inputs/fr3.exe")

    @functools.cached_property
    def pe(self):
        return pefile.PE(data=self.executable)

    @functools.cached_property
    def game_paths(self):
        return sorted(p.relative_to(self.game).as_posix() for p in self.game.rglob("*") if p.is_file())

    @functools.cached_property
    def game_manifest(self):
        return load(self.root / "analysis/game-file-manifest.json")

    @functools.cached_property
    def tags(self):
        return load(self.root / "analysis/tags.json")

    @functools.cached_property
    def wrapper_manifest(self):
        return load(self.root / "analysis/unpacked-manifest.json")

    @functools.cached_property
    def pcgs(self):
        return load(self.root / "analysis/pcg-index.json")

    @functools.cached_property
    def field_evidence(self):
        return load(self.root / "analysis/selected/field-evidence.json")


# Each check verifies one claim and returns the counts it covered; failures raise ValueError.

def check_archive_identity(ctx):
    require(hashlib.md5(ctx.archive).hexdigest() == "4736b176575e2ccd238fdff9f966ea6e", "Mirror-published MD5 mismatch")
    return {"bytes": len(ctx.archive)}


def check_executable_identity(ctx):
    return {"bytes": len(ctx.executable)}


def check_pe_build_metadata(ctx):
    pe = ctx.pe
    require(pe.FILE_HEADER.Machine == 0x14c and pe.OPTIONAL_HEADER.ImageBase == 0x400000 and pe.OPTIONAL_HEADER.AddressOfEntryPoint == 0x134ac2, "PE build metadata mismatch")
    imports = sum(len(dll.imports) for dll in pe.DIRECTORY_ENTRY_IMPORT)
    require(imports == 189 and len(pe.DIRECTORY_ENTRY_IMPORT) == 11, "Import registry mismatch")
    return {"imported_functions": imports, "imported_dlls": len(pe.DIRECTORY_ENTRY_IMPORT)}


def check_game_file_manifest(ctx):
    manifest = ctx.game_manifest
    require(ctx.game_paths == sorted(item["path"] for item in manifest), "Game manifest path set mismatch")
    for item in manifest:
        data = (ctx.game / item["path"]).read_bytes()
        require(len(data) == item["size"] and hashlib.sha256(data).hexdigest() == item["sha256"], "Game-file hash mismatch: " + item["path"])
    total = sum(x["size"] for x in manifest)
    require(len(manifest) == 773 and total == 36_701_680, "Game component size/count mismatch")
    return {"files": len(manifest), "bytes": total}


def check_tag_registry(ctx):
    tags, pe, executable = ctx.tags, ctx.pe, ctx.executable
    pointers = struct.unpack(f"<{COUNT}I", read_va(pe, executable, TABLE_VA, COUNT * 4))
    require(len(tags) == COUNT, "Tag count mismatch")
    for i, pointer in enumerate(pointers):
        value = bytearray()
        for j in range(128):
            byte = read_va(pe, executable, pointer + j, 1)[0]
            if byte == 0:
                break
            value.append(byte)
        else:
            raise ValueError("Unterminated tag")
        require(tags[i] == {"id": i, "pointer_va": pointer, "name": value.decode("ascii")}, "Tag bytes mismatch")
    expected_tags = {0x1e: "CAMBER_THRUST", 0xa3: "LATERAL_COMBINED_VALUES", 0xa6: "LONGITUDINAL_COMBINED_VALUES", 0xa8: "MASS", 0xd5: "RADIUS", 0x15c: "TYRE_GRIP_DEPTH", 0x15d: "TYRE_PATCH_LENGTH", 0x162: "VERTICAL_LOAD", 0x16a: "WIDTH"}
    require(all(tags[i]["name"] == name for i, name in expected_tags.items()), "Tyre tag interpretation mismatch")
    return {"tags": len(tags)}


def check_compressed_resources(ctx):
    manifest = ctx.wrapper_manifest
    identified = [path for path in ctx.game_paths if has_wrapper((ctx.game / path).read_bytes())]
    require(identified == sorted(item["path"] for item in manifest), "Compressed resource path set mismatch")
    for item in manifest:
        data = (ctx.game / item["path"]).read_bytes()
        output = decode(data)
        require(len(output) == item["decoded_size"] and hashlib.sha256(output).hexdigest() == item["decoded_sha256"], "Resource decoding mismatch: " + item["path"])
        require(hashlib.sha256(data).hexdigest() == item["input_sha256"], "Compressed input hash mismatch")
    total = sum(x["decoded_size"] for x in manifest)
    require(len(manifest) == 146 and total == 56_325_649, "Decoded resource total mismatch")
    return {"resources": len(manifest), "decoded_bytes": total}


def check_pcg_index(ctx):
    pcgs = ctx.pcgs
    for pcg in pcgs:
        recomputed = index_pcg(decode((ctx.game / pcg["path"]).read_bytes()))
        require(pcg == {"path": pcg["path"], **recomputed}, "PCG index mismatch: " + pcg["path"])
    entries = sum(pcg["count"] for pcg in pcgs)
    require(len(pcgs) == 62 and entries == 654, "PCG collection/entry totals mismatch")
    extra = [(pcg["path"], e["name"], e["extra_bytes"]) for pcg in pcgs for e in pcg["entries"] if e["extra_bytes"]]
    require(extra == [("GRAPHICS/LOADING/graphics.pcg", "_loadbar", 1024), ("GRAPHICS/LOADING/graphics.pcg", "_loadbr2", 1024)], "PCG trailing-byte exceptions mismatch")
    return {"collections": len(pcgs), "entries": entries, "trailing_byte_exceptions": len(extra)}


def check_field_instruction_sites(ctx):
    for item in ctx.field_evidence:
        actual = read_va(ctx.pe, ctx.executable, item["va"], len(bytes.fromhex(item["bytes"]))).hex()
        require(actual == item["bytes"], f"Field instruction mismatch at 0x{item['va']:08x}: field-evidence.json has {item['bytes']}, fr3.exe has {actual}")
    return {"sites": len(ctx.field_evidence)}


def check_text_databases(ctx):
    summary = verify_text_databases(ctx.game, {tag["name"] for tag in ctx.tags}, ctx.field_evidence,
                                    {tag["name"]: tag["id"] for tag in ctx.tags},
                                    (ctx.root / "recovered/fr3_database_layouts.h").read_text())
    ctx.verified["text_databases"] = summary
    return {key: summary[key] for key in ("engine_records", "gearbox_records", "tyre_records", "torque_arrays",
                                          "engine_mapped_tags", "engine_effective_field_records", "gearbox_mapped_tags",
                                          "tyre_effective_scalar_records", "sound_info_entries")}


def check_tyre_table_dimensions(ctx):
    # Reads the parsed tables the text_databases check (always run first) recorded.
    tyre_tables = ctx.verified["text_databases"]["tyre_tables"]
    table_counts = {tag: {"rows": tyre_tables[tag]["rows"], "columns": tyre_tables[tag]["columns"]}
                    for tag in ("LONGITUDINAL_COMBINED_VALUES", "LATERAL_COMBINED_VALUES")}
    require(table_counts == {"LONGITUDINAL_COMBINED_VALUES": {"rows": 9, "columns": 11},
                             "LATERAL_COMBINED_VALUES": {"rows": 10, "columns": 21}}, "Tyre table dimensions mismatch")
    ctx.verified["tyre_table_dimensions"] = table_counts
    return {"tables": len(table_counts)}


def first_difference(kept, fresh):
    """'<line>: committed ..., regenerated ...' for the first line where two different byte strings disagree."""
    kept_lines, fresh_lines = kept.split(b"\n"), fresh.split(b"\n")
    line = next((i for i, (a, b) in enumerate(zip(kept_lines, fresh_lines, strict=False)) if a != b),
                min(len(kept_lines), len(fresh_lines)))

    def show(lines):
        return repr(lines[line].decode("utf-8", "replace")) if line < len(lines) else "<end of file>"
    return f"{line + 1}: committed {show(kept_lines)}, regenerated {show(fresh_lines)}"


def compare_directories(committed, regenerated, label=None):
    """List every difference between a committed directory and a freshly regenerated one, as readable lines.

    label names the committed directory in the messages (default: its path).
    """
    committed, regenerated = Path(committed), Path(regenerated)
    shown = Path(label) if label is not None else committed

    def files(directory):
        return {p.relative_to(directory).as_posix() for p in directory.rglob("*") if p.is_file()} if directory.is_dir() else set()

    expected, actual = files(regenerated), files(committed)
    problems = [f"{shown / name}: missing (the regeneration writes it)" for name in sorted(expected - actual)]
    problems += [f"{shown / name}: extra file (the regeneration does not write it)" for name in sorted(actual - expected)]
    for name in sorted(expected & actual):
        fresh, kept = (regenerated / name).read_bytes(), (committed / name).read_bytes()
        if fresh != kept:
            problems.append(f"{shown / name}:{first_difference(kept, fresh)}")
    return problems


def check_selected_disassembly(ctx):
    committed = ctx.root / "analysis/selected"
    with tempfile.TemporaryDirectory(prefix="fr3-selected-") as scratch:
        spans, evidence = export_selected(ctx.executable, scratch)
        problems = compare_directories(committed, scratch, "analysis/selected")
    require(not problems, "Regenerated bounded disassembly differs from analysis/selected:\n  " + "\n  ".join(problems))
    return {"spans": spans, "files": spans + 1, "sites": len(evidence)}


def check_ghidra_baseline(ctx):
    baseline = load(ctx.root / "artifacts/ghidra/status.json")
    require(baseline["executable_sha256"] == EXE_SHA256 and baseline["compiler_spec"] == "windows", "Ghidra baseline identity mismatch")
    require(baseline["functions"] == 4922 and baseline["thunks"] == 152 and baseline["decompiled"] == 4770 and not baseline["failures"], "Baseline export outcome mismatch")
    c_count = len(re.findall(r"^/\* [0-9a-f]{8} ", (ctx.root / "artifacts/ghidra/decompiled.c").read_text(), re.MULTILINE))
    require(c_count == baseline["decompiled"], "Decompiler C export count mismatch")
    ctx.verified["baseline"], ctx.verified["c_count"] = baseline, c_count
    return {"functions": baseline["functions"], "decompiled": c_count}


def check_annotated_export(ctx):
    annotated = load(ctx.root / "analysis/annotated/status.json")
    require(len(annotated) == 25 and all(item["decompiled"] for item in annotated), "Selected export outcome mismatch")
    ctx.verified["annotated"] = annotated
    return {"functions": len(annotated)}


def check_snapshot_import(ctx):
    snapshot = load(ctx.root / "analysis/snapshot-verification.json")
    require(all(snapshot.values()), "Fresh GZF import validation failed")
    return {"assertions": len(snapshot)}


def check_c_layout(ctx):
    subprocess.run(["gcc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-x", "c", "-fsyntax-only", str(ctx.root / "recovered/fr3_database_layouts.h")], check=True)
    return {"headers": 1}


@dataclass(frozen=True)
class Prerequisite:
    path: str
    hint: str
    command: bool = False  # True: a program looked up on PATH instead of a file under the checkout

    def available(self, root):
        return shutil.which(self.path) is not None if self.command else (root / self.path).exists()


DEMO_ARCHIVE = Prerequisite("inputs/fordracing3demo.zip", ACQUIRE_HINT)
DEMO_EXECUTABLE = Prerequisite("inputs/fr3.exe", ACQUIRE_HINT)
DEMO_GAME_FILES = Prerequisite("inputs/extracted/Program_Executable_Files", ACQUIRE_HINT)
GHIDRA_STATUS = Prerequisite("artifacts/ghidra/status.json", GHIDRA_HINT)
GHIDRA_C = Prerequisite("artifacts/ghidra/decompiled.c", GHIDRA_HINT)
GHIDRA_SNAPSHOT = Prerequisite("artifacts/fr3-demo-annotated.gzf", GHIDRA_HINT)
GCC = Prerequisite("gcc", "install gcc (the C layout check compiles recovered/fr3_database_layouts.h)", command=True)

CHECKS = {
    "archive_identity": check_archive_identity,
    "executable_identity": check_executable_identity,
    "pe_build_metadata": check_pe_build_metadata,
    "game_file_manifest": check_game_file_manifest,
    "tag_registry": check_tag_registry,
    "compressed_resources": check_compressed_resources,
    "pcg_index": check_pcg_index,
    "field_instruction_sites": check_field_instruction_sites,
    "selected_disassembly": check_selected_disassembly,
    "text_databases": check_text_databases,
    "tyre_table_dimensions": check_tyre_table_dimensions,
    "ghidra_baseline": check_ghidra_baseline,
    "annotated_export": check_annotated_export,
    "snapshot_import": check_snapshot_import,
    "c_layout": check_c_layout,
}

DATA_CHECKS = ("archive_identity", "executable_identity", "game_file_manifest", "tag_registry", "compressed_resources",
               "pcg_index", "text_databases", "tyre_table_dimensions")
INSTRUCTION_CHECKS = ("executable_identity", "pe_build_metadata", "field_instruction_sites", "selected_disassembly")
GHIDRA_CHECKS = ("ghidra_baseline", "annotated_export", "snapshot_import", "c_layout")

LEVELS = {
    "data": {"checks": DATA_CHECKS, "needs": (DEMO_ARCHIVE, DEMO_EXECUTABLE, DEMO_GAME_FILES)},
    "instructions": {"checks": INSTRUCTION_CHECKS, "needs": (DEMO_EXECUTABLE,)},
    # The order the checks ran in before the levels existed, with the regenerated disassembly added after the sites.
    "full": {"checks": ("archive_identity", "executable_identity", "pe_build_metadata", "game_file_manifest", "tag_registry",
                        "compressed_resources", "pcg_index", "field_instruction_sites", "selected_disassembly",
                        "text_databases", "tyre_table_dimensions", *GHIDRA_CHECKS),
             "needs": (DEMO_ARCHIVE, DEMO_EXECUTABLE, DEMO_GAME_FILES, GHIDRA_STATUS, GHIDRA_C, GHIDRA_SNAPSHOT, GCC)},
}


class CheckFailed(Exception):
    def __init__(self, check, message, performed):
        super().__init__(f"{check}: {message}")
        self.check, self.message, self.performed = check, message, performed


def missing_prerequisites(root, level):
    return [need for need in LEVELS[level]["needs"] if not need.available(root)]


def unavailable_message(level, missing):
    lines = [f"Verification level '{level}' is unavailable; it needs:"]
    lines += [f"  {'program ' if need.command else ''}{need.path}: {need.hint}" for need in missing]
    others = [name for name in LEVELS if name != level]
    lines.append("Other levels: " + ", ".join(f"--level {name}" for name in others) + " (data and instructions need only the acquired demo).")
    return "\n".join(lines)


def run_checks(ctx, level, checks=None):
    """Run the level's checks in order. Returns [(name, counts)]; raises CheckFailed naming the failing check."""
    checks = CHECKS if checks is None else checks
    performed = []
    for name in LEVELS[level]["checks"]:
        try:
            counts = checks[name](ctx)
        # OSError: a committed analysis/ file the check reads is missing or unreadable.
        except (ValueError, OSError, subprocess.CalledProcessError) as error:
            raise CheckFailed(name, str(error), performed) from error
        performed.append((name, counts))
    return performed


def verification_record(ctx):
    """analysis/verification.json, as written by the full level (unchanged fields)."""
    game_manifest, wrapper_manifest, pcgs = ctx.game_manifest, ctx.wrapper_manifest, ctx.pcgs
    baseline = ctx.verified["baseline"]
    return {
        "verified_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "archive_sha256": ARCHIVE_SHA256, "executable_sha256": EXE_SHA256,
        "game_files_verified": len(game_manifest), "tag_entries_verified": len(ctx.tags),
        "resources_decoded_verified": len(wrapper_manifest), "decoded_bytes_verified": sum(x["decoded_size"] for x in wrapper_manifest),
        "pcg_collections_verified": len(pcgs), "pcg_entries_verified": sum(pcg["count"] for pcg in pcgs),
        "field_instruction_sites_verified": len(ctx.field_evidence), "tyre_ascii_table_dimensions": ctx.verified["tyre_table_dimensions"],
        "text_databases": ctx.verified["text_databases"],
        "baseline_functions": baseline["functions"], "baseline_decompiled": ctx.verified["c_count"], "baseline_decompiler_failures": baseline["failures"],
        "annotated_functions_verified": len(ctx.verified["annotated"]), "snapshot_import_verified": True, "c_layout_assertions_passed": True,
        "annotated_snapshot_sha256": hashlib.sha256((ctx.root / "artifacts/fr3-demo-annotated.gzf").read_bytes()).hexdigest(),
        "baseline_c_sha256": hashlib.sha256((ctx.root / "artifacts/ghidra/decompiled.c").read_bytes()).hexdigest(),
        "executed_during_static_verification": False,
        "limit": "This check verifies static bytes and formats. See docs/release-validation.md for separate Wine runtime testing.",
    }


def producer_revision(root):
    """The checkout's commit and whether it has uncommitted changes, or None outside a git checkout."""
    def git(*argv):
        return subprocess.run(["git", "-C", str(root), *argv], capture_output=True, text=True, check=True).stdout
    try:
        return {"commit": git("rev-parse", "HEAD").strip(), "dirty": bool(git("status", "--porcelain").strip())}
    except (OSError, subprocess.CalledProcessError):
        return None


def tool_versions():
    versions = {"python": platform.python_version()}
    for package in ("pefile", "capstone"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    return versions


def build_report(level, result, revision, performed, failure=None, missing=()):
    """The --report JSON: what ran at this level, against which inputs, and what did not run."""
    names = {name for name, _ in performed}
    return {
        "level": level,
        "result": result,
        "producer_revision": revision,
        # The pinned identities, reported only when a check performed at this level verified those bytes.
        "archive_sha256": ARCHIVE_SHA256 if "archive_identity" in names else None,
        "executable_sha256": EXE_SHA256 if "executable_identity" in names else None,
        "tool_versions": tool_versions(),
        "checks_performed": [{"name": name, "counts": counts} for name, counts in performed],
        "failure": failure,
        "missing_prerequisites": [{"path": need.path, "hint": need.hint} for need in missing],
        # An unavailable level was not performed either; a failed one was, up to its failing check.
        "levels_not_performed": [name for name in LEVELS if name != level or result == "unavailable"],
        "writes_analysis_verification": level == "full",
        "executed_during_static_verification": False,
    }


def write_report(path, report):
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2) + "\n")


def main(argv=None, checks=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", type=Path)
    parser.add_argument("--level", choices=tuple(LEVELS), default="full",
                        help="which checks to run (default: %(default)s, which also writes analysis/verification.json)")
    parser.add_argument("--report", type=Path, help="write a JSON report of the checks performed to this path")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    revision = producer_revision(root)
    missing = missing_prerequisites(root, args.level)
    if missing:
        print(unavailable_message(args.level, missing), file=sys.stderr)
        write_report(args.report, build_report(args.level, "unavailable", revision, [], missing=missing))
        return EXIT_UNAVAILABLE
    ctx = Context(root)
    try:
        performed = run_checks(ctx, args.level, checks)
    except CheckFailed as failure:
        print(f"Verification level '{args.level}' failed in check {failure.check}: {failure.message}", file=sys.stderr)
        write_report(args.report, build_report(args.level, "failed", revision, failure.performed,
                                               failure={"check": failure.check, "message": failure.message}))
        return EXIT_FAILED
    if args.level == "full":
        result = verification_record(ctx)
        (root / "analysis/verification.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))
    else:
        for name, counts in performed:
            print(f"ok  {name}  " + ", ".join(f"{key}={value}" for key, value in counts.items()))
        print(f"Verification level '{args.level}' passed: {len(performed)} checks; analysis/ was not written.")
    write_report(args.report, build_report(args.level, "passed", revision, performed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
