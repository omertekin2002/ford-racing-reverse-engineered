"""Disassemble explicitly bounded routines and preserve instruction evidence."""
import argparse
import json
from pathlib import Path
import capstone
import pefile
from fr3_common import verified_exe
from extract_tag_registry import read_va

# These names are analyst-assigned. Bounds delimit byte exports, not a claim
# that every byte in a range belongs to a single discovered function.
ROUTINES = [
    (0x00409B80, 0x00409D80, "load_directx_libraries"),
    (0x0040BA30, 0x0040BB60, "load_compressed_resource"),
    (0x0042ED50, 0x0042EDF5, "create_database"),
    (0x0042EED0, 0x0042EF62, "allocate_database_record"),
    (0x00423B20, 0x00423C10, "build_pcg_view"),
    (0x005227F0, 0x00522C80, "load_engine_database"),
    (0x00522C80, 0x00522EC0, "copy_engine_record"),
    (0x00523220, 0x00523470, "load_gearbox_database"),
    (0x00523470, 0x00523540, "copy_gearbox_record"),
    (0x00523820, 0x00523DC0, "load_tyre_database"),
    (0x00523DC0, 0x00523E50, "free_tyre_tables"),
    (0x00523E50, 0x00523F30, "tyre_table_accessors"),
    (0x00524090, 0x005240E0, "copy_tyre_scalar_fields"),
    (0x00534690, 0x005346A8, "fill_memory"),
    (0x00537240, 0x005372E3, "fill_memory_body"),
]

EVIDENCE = [
    (0x00523834, "ba58000000", "Tyre payload allocation size: EDX = 0x58"),
    (0x00523900, "d95028", "RADIUS store at payload + 0x28"),
    (0x00523907, "d9583c", "Reciprocal radius store at payload + 0x3c"),
    (0x00523937, "d90584745900", "ROAD_MAGIC_GRIP_NUMBER loads the grip scale global at 0x00597484"),
    (0x0052393f, "d95818", "ROAD_MAGIC_GRIP_NUMBER initial store at + 0x18"),
    (0x00523942, "d84818", "ROAD_MAGIC_GRIP_NUMBER multiplied by the global loaded from 0x00597484 at 0x00523937"),
    (0x00523945, "d95818", "ROAD_MAGIC_GRIP_NUMBER scaled value stored back at + 0x18"),
    (0x0052395a, "d95824", "TYRE_GRIP_DEPTH store at + 0x24"),
    (0x0052397f, "d9582c", "TYRE_PATCH_LENGTH store at + 0x2c"),
    (0x005239a9, "89424c", "VERTICAL_LOAD allocation address store at + 0x4c"),
    (0x00523a1b, "d95820", "WET_MAGIC_GRIP_PERCENTAGE store at + 0x20"),
    (0x00523a35, "d95830", "WIDTH store at + 0x30"),
    (0x00523a4a, "d95840", "ROLLING_RESISTANCE store at + 0x40"),
    (0x00523a67, "bad0020000", "SOUND_INFO allocation size: EDX = 0x2d0"),
    (0x00523a89, "894854", "SOUND_INFO allocation address store at + 0x54"),
    (0x00523b35, "89c2", "INHERIT_TYPE passes the parent record address in EDX to the scalar copy"),
    (0x00523b37, "8b45e8", "INHERIT_TYPE passes the current record address in EAX to the scalar copy"),
    (0x00523b3a, "e851050000", "INHERIT_TYPE calls the scalar copy at 0x00524090"),
    (0x00523b42, "894814", "INHERIT_TYPE stores record address at + 0x14"),
    (0x00523b60, "be48030000", "LATERAL_COMBINED_VALUES allocation size: ESI = 0x348"),
    (0x00523b7d, "894248", "Lateral allocation address store at + 0x48"),
    (0x00523be2, "b98c010000", "LONGITUDINAL_COMBINED_VALUES allocation size: ECX = 0x18c"),
    (0x00523bfb, "894244", "Longitudinal allocation address store at + 0x44"),
    (0x00523c83, "d95034", "MASS store at + 0x34"),
    (0x00523c8a, "d95838", "Reciprocal mass store at + 0x38"),
    (0x00523ca8, "d90584745900", "OFFROAD_MAGIC_GRIP_NUMBER loads the grip scale global at 0x00597484"),
    (0x00523cb0, "d9581c", "OFFROAD_MAGIC_GRIP_NUMBER initial store at + 0x1c"),
    (0x00523cb3, "d8481c", "OFFROAD_MAGIC_GRIP_NUMBER multiplied by the global loaded from 0x00597484 at 0x00523ca8"),
    (0x00523cb6, "d9581c", "OFFROAD_MAGIC_GRIP_NUMBER scaled value stored back at + 0x1c"),
    (0x00523ce6, "894250", "CAMBER_THRUST allocation address store at + 0x50"),
    (0x00523e52, "8b504c", "VERTICAL_LOAD accessor reads record + 0x4c"),
    (0x00523e60, "8b4014", "VERTICAL_LOAD accessor loads the inherited record from + 0x14"),
    (0x00523e72, "8b5050", "CAMBER_THRUST accessor reads record + 0x50"),
    (0x00523e80, "8b4014", "CAMBER_THRUST accessor loads the inherited record from + 0x14"),
    (0x00523e92, "8b5044", "LONGITUDINAL_COMBINED_VALUES accessor reads record + 0x44"),
    (0x00523ea0, "8b4014", "LONGITUDINAL_COMBINED_VALUES accessor loads the inherited record from + 0x14"),
    (0x00523eb2, "8b5048", "LATERAL_COMBINED_VALUES accessor reads record + 0x48"),
    (0x00523ec0, "8b4014", "LATERAL_COMBINED_VALUES accessor loads the inherited record from + 0x14"),
    (0x00523f10, "83785400", "SOUND_INFO accessor compares record + 0x54 with 0"),
    (0x00523f1c, "8b4014", "SOUND_INFO accessor loads the inherited record from + 0x14"),
    (0x00523f27, "8b4054", "SOUND_INFO accessor returns record + 0x54"),
    (0x00524091, "8b4a24", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x24 into ECX"),
    (0x00524094, "894824", "Scalar copy stores that dword (ECX) at record (EAX) + 0x24"),
    (0x00524097, "8b4a2c", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x2c into ECX"),
    (0x0052409a, "89482c", "Scalar copy stores that dword (ECX) at record (EAX) + 0x2c"),
    (0x0052409d, "8b4a28", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x28 into ECX"),
    (0x005240a0, "894828", "Scalar copy stores that dword (ECX) at record (EAX) + 0x28"),
    (0x005240a3, "8b4a30", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x30 into ECX"),
    (0x005240a6, "894830", "Scalar copy stores that dword (ECX) at record (EAX) + 0x30"),
    (0x005240a9, "8b4a34", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x34 into ECX"),
    (0x005240ac, "894834", "Scalar copy stores that dword (ECX) at record (EAX) + 0x34"),
    (0x005240af, "8b4a18", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x18 into ECX"),
    (0x005240b2, "894818", "Scalar copy stores that dword (ECX) at record (EAX) + 0x18"),
    (0x005240b5, "8b4a20", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x20 into ECX"),
    (0x005240b8, "894820", "Scalar copy stores that dword (ECX) at record (EAX) + 0x20"),
    (0x005240bb, "8b4a1c", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x1c into ECX"),
    (0x005240be, "89481c", "Scalar copy stores that dword (ECX) at record (EAX) + 0x1c"),
    (0x005240c1, "8b4a40", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x40 into ECX"),
    (0x005240c4, "894840", "Scalar copy stores that dword (ECX) at record (EAX) + 0x40"),
    (0x005240c7, "8b4a3c", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x3c into ECX"),
    (0x005240ca, "89483c", "Scalar copy stores that dword (ECX) at record (EAX) + 0x3c"),
    (0x005240cd, "8b4a38", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x38 into ECX"),
    (0x005240d0, "894838", "Scalar copy stores that dword (ECX) at record (EAX) + 0x38"),
    (0x005240d4, "c3", "Scalar copy returns after its eleventh store (ECX restored at 0x005240d3)"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = verified_exe(args.executable)
    pe = pefile.PE(data=data)
    decoder = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    args.output.mkdir(parents=True, exist_ok=True)
    for start, end, name in ROUTINES:
        raw = read_va(pe, data, start, end - start)
        text = f"; Analyst label: {name}; export span 0x{start:08x}..0x{end:08x}\n"
        text += "; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.\n"
        text += "\n".join(f"{i.address:08x} {i.bytes.hex():<24} {i.mnemonic} {i.op_str}" for i in decoder.disasm(raw, start))
        (args.output / f"{name}.asm").write_text(text + "\n")
    evidence = []
    for va, expected, claim in EVIDENCE:
        raw = read_va(pe, data, va, len(bytes.fromhex(expected)))
        if raw.hex() != expected:
            raise ValueError(f"Instruction mismatch at 0x{va:08x}")
        evidence.append({"va": va, "bytes": expected, "claim": claim})
    (args.output / "field-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(f"Exported {len(ROUTINES)} spans and verified {len(evidence)} instruction sites")


if __name__ == "__main__":
    main()
