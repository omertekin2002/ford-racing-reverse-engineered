"""Synthetic parser tests; these do not constitute game-binary validation."""
from pathlib import Path
import struct
import sys
import unittest
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from index_pcg import index_pcg
from unpack_resources import decode


class ResourceTests(unittest.TestCase):
    def wrap(self, payload):
        return struct.pack("<I", len(payload)) + zlib.compress(payload)

    def test_roundtrip_binary_and_empty(self):
        for payload in (b"", bytes(range(256)) * 20):
            self.assertEqual(decode(self.wrap(payload)), payload)

    def test_reject_wrong_length(self):
        data = self.wrap(b"Ford Racing")
        for length in (1, 200):
            with self.assertRaises(ValueError):
                decode(struct.pack("<I", length) + data[4:])

    def test_reject_truncation_and_trailing_data(self):
        data = self.wrap(b"Ford Racing")
        for malformed in (data[:-1], data + b"extra", data + zlib.compress(b"second")):
            with self.assertRaises(ValueError):
                decode(malformed)

    def test_reject_corruption(self):
        data = bytearray(self.wrap(b"Ford Racing"))
        data[-1] ^= 1
        with self.assertRaises(ValueError):
            decode(data)

    def test_enforce_output_limit(self):
        with self.assertRaises(ValueError):
            decode(self.wrap(b"x" * 1000), max_size=100)

    def make_pcg(self, extra=0):
        graphic = bytearray(128)
        struct.pack_into("<II", graphic, 8, 4, 2)
        struct.pack_into("<I", graphic, 40, 8)
        directory = struct.pack("<4I", 1, 2004, 0, 0) + struct.pack("<I12s", 0, b"example")
        return directory.ljust(128, b"\0") + graphic + b"abcdefgh" + b"\0" * extra

    def test_pcg_alignment_dimensions_and_extra_bytes(self):
        result = index_pcg(self.make_pcg(extra=1024))
        self.assertEqual(result["payload_base"], 128)
        self.assertEqual(result["entries"][0]["name"], "example")
        self.assertEqual((result["entries"][0]["width"], result["entries"][0]["height"]), (4, 2))
        self.assertEqual(result["entries"][0]["extra_bytes"], 1024)

    def test_pcg_empty_collection(self):
        result = index_pcg(struct.pack("<4I", 0, 2004, 0, 0).ljust(128, b"\0"))
        self.assertEqual((result["count"], result["payload_base"], result["entries"]), (0, 128, []))

    def test_pcg_spans_follow_file_order_not_directory_order(self):
        graphic = bytearray(128)
        struct.pack_into("<I", graphic, 40, 8)
        graphic = bytes(graphic) + b"abcdefgh"
        directory = struct.pack("<4I", 2, 2004, 0, 0) + struct.pack("<I12s", 136, b"second") + struct.pack("<I12s", 0, b"first")
        result = index_pcg(directory.ljust(128, b"\0") + graphic + graphic + b"tail")
        self.assertEqual([(e["name"], e["span_bytes"], e["extra_bytes"]) for e in result["entries"]],
                         [("second", 140, 4), ("first", 136, 0)])

    def test_pcg_reject_truncated_directory_and_graphic(self):
        for data in (b"", struct.pack("<4I", 100, 0, 0, 0), self.make_pcg()[:200]):
            with self.assertRaises(ValueError):
                index_pcg(data)

    def test_pcg_reject_payload_overrun(self):
        data = bytearray(self.make_pcg())
        struct.pack_into("<I", data, 128 + 40, 9)
        with self.assertRaises(ValueError):
            index_pcg(data)

    def test_pcg_reject_duplicate_offsets(self):
        data = bytearray(self.make_pcg())
        struct.pack_into("<I", data, 0, 2)
        data[32:48] = struct.pack("<I12s", 0, b"duplicate")
        with self.assertRaises(ValueError):
            index_pcg(data)


if __name__ == "__main__":
    unittest.main()
