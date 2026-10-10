"""Verify actual demo bytes, all file/resource manifests and analysis exports."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import pefile
from fr3_common import ARCHIVE_SHA256, ARCHIVE_SIZE, EXE_SHA256, verified_bytes, verified_exe
from extract_tag_registry import COUNT, TABLE_VA, read_va
from index_pcg import index_pcg
from unpack_resources import decode, has_wrapper


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load(path):
    return json.loads(path.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    archive = verified_bytes(root / "inputs/fordracing3demo.zip", ARCHIVE_SIZE, ARCHIVE_SHA256)
    require(hashlib.md5(archive).hexdigest() == "4736b176575e2ccd238fdff9f966ea6e", "Mirror-published MD5 mismatch")
    executable = verified_exe(root / "inputs/fr3.exe")
    pe = pefile.PE(data=executable)
    require(pe.FILE_HEADER.Machine == 0x14c and pe.OPTIONAL_HEADER.ImageBase == 0x400000 and pe.OPTIONAL_HEADER.AddressOfEntryPoint == 0x134ac2, "PE build metadata mismatch")
    require(sum(len(dll.imports) for dll in pe.DIRECTORY_ENTRY_IMPORT) == 189 and len(pe.DIRECTORY_ENTRY_IMPORT) == 11, "Import registry mismatch")
    game = root / "inputs/extracted/Program_Executable_Files"
    game_manifest = load(root / "analysis/game-file-manifest.json")
    paths = sorted(p.relative_to(game).as_posix() for p in game.rglob("*") if p.is_file())
    require(paths == sorted(item["path"] for item in game_manifest), "Game manifest path set mismatch")
    for item in game_manifest:
        data = (game / item["path"]).read_bytes()
        require(len(data) == item["size"] and hashlib.sha256(data).hexdigest() == item["sha256"], "Game-file hash mismatch: " + item["path"])
    require(len(game_manifest) == 773 and sum(x["size"] for x in game_manifest) == 36_701_680, "Game component size/count mismatch")
    tags = load(root / "analysis/tags.json")
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
    wrapper_manifest = load(root / "analysis/unpacked-manifest.json")
    identified = [path for path in paths if has_wrapper((game / path).read_bytes())]
    require(identified == sorted(item["path"] for item in wrapper_manifest), "Compressed resource path set mismatch")
    for item in wrapper_manifest:
        data = (game / item["path"]).read_bytes()
        output = decode(data)
        require(len(output) == item["decoded_size"] and hashlib.sha256(output).hexdigest() == item["decoded_sha256"], "Resource decoding mismatch: " + item["path"])
        require(hashlib.sha256(data).hexdigest() == item["input_sha256"], "Compressed input hash mismatch")
    require(len(wrapper_manifest) == 146 and sum(x["decoded_size"] for x in wrapper_manifest) == 56_325_649, "Decoded resource total mismatch")
    pcgs = load(root / "analysis/pcg-index.json")
    for pcg in pcgs:
        recomputed = index_pcg(decode((game / pcg["path"]).read_bytes()))
        require(pcg == {"path": pcg["path"], **recomputed}, "PCG index mismatch: " + pcg["path"])
    require(len(pcgs) == 62 and sum(pcg["count"] for pcg in pcgs) == 654, "PCG collection/entry totals mismatch")
    extra = [(pcg["path"], e["name"], e["extra_bytes"]) for pcg in pcgs for e in pcg["entries"] if e["extra_bytes"]]
    require(extra == [("GRAPHICS/LOADING/graphics.pcg", "_loadbar", 1024), ("GRAPHICS/LOADING/graphics.pcg", "_loadbr2", 1024)], "PCG trailing-byte exceptions mismatch")
    field_evidence = load(root / "analysis/selected/field-evidence.json")
    for item in field_evidence:
        require(read_va(pe, executable, item["va"], len(bytes.fromhex(item["bytes"]))).hex() == item["bytes"], "Field instruction mismatch")
    tyre_text = (game / "DATA/ASCII/CARS/TYREDATA.DAT").read_text()
    table_counts = {}
    for tag, rows, columns in (("LONGITUDINAL_COMBINED_VALUES", 9, 11), ("LATERAL_COMBINED_VALUES", 10, 21)):
        block = re.search(r":" + tag + r"\s*([^:]+)", tyre_text).group(1)
        lines = [line.split("//", 1)[0].strip() for line in block.splitlines()]
        values = [[float(value) for value in line.split()] for line in lines if line]
        require(len(values) == rows and all(len(row) == columns for row in values), "Tyre table dimensions mismatch: " + tag)
        table_counts[tag] = {"rows": rows, "columns": columns}
    baseline = load(root / "artifacts/ghidra/status.json")
    require(baseline["executable_sha256"] == EXE_SHA256 and baseline["compiler_spec"] == "windows", "Ghidra baseline identity mismatch")
    require(baseline["functions"] == 4922 and baseline["thunks"] == 152 and baseline["decompiled"] == 4770 and not baseline["failures"], "Baseline export outcome mismatch")
    c_count = len(re.findall(r"^/\* [0-9a-f]{8} ", (root / "artifacts/ghidra/decompiled.c").read_text(), re.MULTILINE))
    require(c_count == baseline["decompiled"], "Decompiler C export count mismatch")
    annotated = load(root / "analysis/annotated/status.json")
    require(len(annotated) == 25 and all(item["decompiled"] for item in annotated), "Selected export outcome mismatch")
    snapshot = load(root / "analysis/snapshot-verification.json")
    require(all(snapshot.values()), "Fresh GZF import validation failed")
    subprocess.run(["gcc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-x", "c", "-fsyntax-only", str(root / "recovered/fr3_database_layouts.h")], check=True)
    result = {
        "verified_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "archive_sha256": ARCHIVE_SHA256, "executable_sha256": EXE_SHA256,
        "game_files_verified": len(game_manifest), "tag_entries_verified": len(tags),
        "resources_decoded_verified": len(wrapper_manifest), "decoded_bytes_verified": sum(x["decoded_size"] for x in wrapper_manifest),
        "pcg_collections_verified": len(pcgs), "pcg_entries_verified": sum(pcg["count"] for pcg in pcgs),
        "field_instruction_sites_verified": len(field_evidence), "tyre_ascii_table_dimensions": table_counts,
        "baseline_functions": baseline["functions"], "baseline_decompiled": c_count, "baseline_decompiler_failures": baseline["failures"],
        "annotated_functions_verified": len(annotated), "snapshot_import_verified": True, "c_layout_assertions_passed": True,
        "annotated_snapshot_sha256": hashlib.sha256((root / "artifacts/fr3-demo-annotated.gzf").read_bytes()).hexdigest(),
        "baseline_c_sha256": hashlib.sha256((root / "artifacts/ghidra/decompiled.c").read_bytes()).hexdigest(),
        "executed_during_static_verification": False,
        "limit": "This check verifies static bytes and formats. See docs/release-validation.md for separate Wine runtime testing.",
    }
    (root / "analysis/verification.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
