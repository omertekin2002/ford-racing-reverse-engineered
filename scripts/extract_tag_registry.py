"""Reproduce the supplied report's tag-table claim for its exact demo build."""
import argparse
import json
from pathlib import Path
import struct
import pefile
from fr3_common import verified_exe

TABLE_VA = 0x00594D94
COUNT = 363


def read_va(pe, data, va, size):
    rva = va - pe.OPTIONAL_HEADER.ImageBase
    for section in pe.sections:
        relative = rva - section.VirtualAddress
        if 0 <= relative and relative + size <= section.SizeOfRawData:
            offset = section.PointerToRawData + relative
            if offset + size <= len(data):
                return data[offset:offset + size]
    raise ValueError(f"VA 0x{va:08x} is not in file-backed section data")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = verified_exe(args.executable)
    pe = pefile.PE(data=data)
    pointers = struct.unpack(f"<{COUNT}I", read_va(pe, data, TABLE_VA, COUNT * 4))
    tags = []
    for index, pointer in enumerate(pointers):
        value = bytearray()
        for i in range(128):
            byte = read_va(pe, data, pointer + i, 1)[0]
            if byte == 0:
                break
            if not (65 <= byte <= 90 or 48 <= byte <= 57 or byte == 95):
                raise ValueError(f"Invalid tag at index {index}")
            value.append(byte)
        else:
            raise ValueError("Tag has no terminator within bound")
        if not value:
            raise ValueError("Empty tag")
        tags.append({"id": index, "pointer_va": pointer, "name": value.decode("ascii")})
    if tags[0]["name"] != "FIRST_APPLICATION_TAG" or tags[-1]["name"] != "WIDTH":
        raise ValueError("Reported registry endpoints do not match")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(tags, indent=2) + "\n")
    print(f"Extracted {len(tags)} tags from verified executable")


if __name__ == "__main__":
    main()

