"""Synthetic helper tests; these do not constitute game-binary validation."""
import hashlib
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from extract_tag_registry import read_va
from fr3_common import verified_bytes


class ReadVaTests(unittest.TestCase):
    def setUp(self):
        section = SimpleNamespace(VirtualAddress=0x1000, SizeOfRawData=0x20, PointerToRawData=0x10)
        self.pe = SimpleNamespace(OPTIONAL_HEADER=SimpleNamespace(ImageBase=0x400000), sections=[section])
        # Trailing file bytes ensure SizeOfRawData, not the file length, bounds the section.
        self.data = bytes(range(0x40))

    def test_map_va_inside_section(self):
        self.assertEqual(read_va(self.pe, self.data, 0x401000, 4), bytes(range(0x10, 0x14)))
        self.assertEqual(read_va(self.pe, self.data, 0x40101C, 4), bytes(range(0x2C, 0x30)))

    def test_reject_va_below_every_section(self):
        for va in (0x400FFF, 0x3FFFFF):
            with self.assertRaises(ValueError):
                read_va(self.pe, self.data, va, 1)

    def test_reject_va_beyond_every_section(self):
        with self.assertRaises(ValueError):
            read_va(self.pe, self.data, 0x401020, 1)

    def test_reject_read_crossing_raw_size(self):
        with self.assertRaises(ValueError):
            read_va(self.pe, self.data, 0x40101D, 4)

    def test_reject_read_past_file_data(self):
        with self.assertRaises(ValueError):
            read_va(self.pe, self.data[:0x20], 0x401010, 1)


class VerifiedBytesTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "sample.bin"
        self.payload = b"Ford Racing 3"
        self.path.write_bytes(self.payload)
        self.sha256 = hashlib.sha256(self.payload).hexdigest()

    def test_accept_matching_identity(self):
        self.assertEqual(verified_bytes(self.path, len(self.payload), self.sha256), self.payload)

    def test_reject_size_mismatch(self):
        with self.assertRaises(ValueError):
            verified_bytes(self.path, len(self.payload) + 1, self.sha256)

    def test_reject_hash_mismatch(self):
        with self.assertRaises(ValueError):
            verified_bytes(self.path, len(self.payload), hashlib.sha256(b"other").hexdigest())


if __name__ == "__main__":
    unittest.main()
