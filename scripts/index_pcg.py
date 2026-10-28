"""Validate the PCG directory hypothesis in the supplied report."""
import argparse
from itertools import pairwise
import json
from pathlib import Path
import struct


def index_pcg(data):
    if len(data) < 16:
        raise ValueError("Truncated PCG header")
    count, year, metadata, reserved = struct.unpack_from("<4I", data)
    if count > 100_000 or 16 + count * 16 > len(data):
        raise ValueError("PCG directory exceeds file")
    base = (16 + count * 16 + 127) & ~127
    if base > len(data):
        raise ValueError("PCG payload base exceeds file")
    entries = []
    offsets = []
    for i in range(count):
        offset, name = struct.unpack_from("<I12s", data, 16 + i * 16)
        absolute = base + offset
        if absolute + 128 > len(data):
            raise ValueError("Graphic header exceeds file")
        offsets.append(absolute)
        entries.append({"index": i, "name": name.split(b"\0", 1)[0].decode("ascii"), "name_raw_hex": name.hex(), "file_offset": absolute})
    if len(set(offsets)) != len(offsets):
        raise ValueError("Duplicate graphic offsets")
    ends = dict(pairwise([*sorted(offsets), len(data)]))
    for entry in entries:
        offset = entry["file_offset"]
        span = ends[offset] - offset
        words = struct.unpack_from("<32I", data, offset)
        declared = words[10]
        if span < 128 or declared > span - 128:
            raise ValueError("Graphic payload overlaps the next entry or file end")
        entry.update(width=words[2], height=words[3], header_words=list(words), declared_payload_bytes=declared,
                     span_bytes=span, extra_bytes=span - 128 - declared)
    return {"count": count, "year_word": year, "creation_metadata_hex": struct.pack("<I", metadata).hex(),
            "reserved_word": reserved, "payload_base": base, "entries": entries}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if not args.input.is_dir():
        raise ValueError("Input directory does not exist")
    collections = []
    for path in sorted(args.input.rglob("*")):
        if path.is_file() and path.suffix.lower() == ".pcg":
            collections.append({"path": path.relative_to(args.input).as_posix(), **index_pcg(path.read_bytes())})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(collections, indent=2) + "\n")
    print(f"Indexed {len(collections)} collections, {sum(item['count'] for item in collections)} entries")


if __name__ == "__main__":
    main()
