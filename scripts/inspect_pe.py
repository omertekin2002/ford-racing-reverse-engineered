"""Export PE metadata, imports, strings and section-linear disassembly."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import capstone
import pefile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = args.executable.read_bytes()
    pe = pefile.PE(data=data)
    if pe.FILE_HEADER.Machine != 0x14C or pe.OPTIONAL_HEADER.Magic != 0x10B:
        raise ValueError("Expected an x86 PE32 executable")
    args.output.mkdir(parents=True, exist_ok=True)
    base = pe.OPTIONAL_HEADER.ImageBase
    report = {
        "file": args.executable.name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
        "image_base": base, "entry_va": base + pe.OPTIONAL_HEADER.AddressOfEntryPoint,
        "timestamp_header_utc": datetime.datetime.fromtimestamp(pe.FILE_HEADER.TimeDateStamp, datetime.timezone.utc).isoformat(),
        "sections": [], "imports": [], "warnings": pe.get_warnings(),
        "disassembly_limit": "Linear section decoding; data can be misidentified as instructions. Use Ghidra function analysis and original bytes for interpretation.",
    }
    decoder = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    decoder.skipdata = True
    with (args.output / "disassembly.txt").open("w") as stream:
        for section in pe.sections:
            name = section.Name.rstrip(b"\0").decode("ascii", errors="replace")
            report["sections"].append({"name": name, "va": base + section.VirtualAddress, "virtual_size": section.Misc_VirtualSize,
                                      "file_offset": section.PointerToRawData, "raw_size": section.SizeOfRawData, "flags": section.Characteristics})
            if section.Characteristics & 0x20000000:
                stream.write(f"\n; Section {name}\n")
                for insn in decoder.disasm(section.get_data(), base + section.VirtualAddress):
                    stream.write(f"{insn.address:08x}  {insn.bytes.hex():<30} {insn.mnemonic} {insn.op_str}\n")
    for dll in getattr(pe, "DIRECTORY_ENTRY_IMPORT", []):
        for imp in dll.imports:
            report["imports"].append({"dll": dll.dll.decode("ascii"), "name": imp.name.decode("ascii") if imp.name else None,
                                      "ordinal": imp.ordinal, "iat_va": imp.address})
    strings = []
    for match in re.finditer(rb"[\x20-\x7e]{5,}", data):
        offset = match.start()
        try:
            va = base + pe.get_rva_from_offset(offset)
        except pefile.PEFormatError:
            va = None
        strings.append({"file_offset": offset, "va": va, "text": match.group().decode("ascii")})
    (args.output / "metadata.json").write_text(json.dumps(report, indent=2) + "\n")
    (args.output / "strings.json").write_text(json.dumps(strings, indent=2) + "\n")
    print(json.dumps({"sha256": report["sha256"], "sections": len(report["sections"]), "imports": len(report["imports"]), "strings": len(strings)}))


if __name__ == "__main__":
    main()

