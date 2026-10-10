"""Strict, bounded decoding of a size prefix followed by one zlib stream."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import zlib

MAX_SIZE = 64 * 1024 * 1024


def has_wrapper(data):
    if len(data) < 6:
        return False
    cmf, flg = data[4:6]
    return cmf & 15 == 8 and cmf >> 4 <= 7 and (cmf * 256 + flg) % 31 == 0


def decode(data, max_size=MAX_SIZE):
    if not has_wrapper(data):
        raise ValueError("Missing size prefix or valid zlib header")
    size = struct.unpack_from("<I", data)[0]
    if size > max_size:
        raise ValueError("Declared decoded size exceeds limit")
    stream = zlib.decompressobj()
    try:
        output = stream.decompress(data[4:], size + 1)
    except zlib.error as error:
        raise ValueError(f"Invalid zlib stream: {error}") from error
    if len(output) != size:
        raise ValueError("Decoded length does not match prefix")
    if not stream.eof or stream.unconsumed_tail:
        raise ValueError("Truncated stream or decoded data exceeds declared size")
    if stream.unused_data:
        raise ValueError("Trailing bytes after zlib stream")
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    source, target = args.input.resolve(), args.output.resolve()
    if source == target or source in target.parents or target in source.parents:
        raise ValueError("Input and output directories must be separate")
    if not source.is_dir():
        raise ValueError("Input directory does not exist")
    manifest = []
    for path in sorted(source.rglob("*")):
        if not path.is_file():
            continue
        data = path.read_bytes()
        if not has_wrapper(data):
            continue
        output = decode(data)
        relative = path.relative_to(source)
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(output)
        manifest.append({"path": relative.as_posix(), "input_size": len(data), "decoded_size": len(output),
                         "input_sha256": hashlib.sha256(data).hexdigest(), "decoded_sha256": hashlib.sha256(output).hexdigest()})
    target.mkdir(parents=True, exist_ok=True)
    (target / "unpacked_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Decoded {len(manifest)} resources; {sum(item['decoded_size'] for item in manifest)} bytes")


if __name__ == "__main__":
    main()

