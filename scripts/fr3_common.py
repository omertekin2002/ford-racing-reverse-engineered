"""Build identity from the supplied report, not yet independent evidence."""
import hashlib
from pathlib import Path

ARCHIVE_SIZE = 37_080_961
ARCHIVE_SHA256 = "4bf96967022195519817d91f143c5e1c62e5879a95dd70f5a1cd00ba89b1f84c"
EXE_SIZE = 1_782_784
EXE_SHA256 = "87cc71d881a2723784097108ce2923fe8d0384ea6a8b03fad3e95c5cda52e8b3"
DEMO_PAGE = "https://www.moddb.com/games/ford-racing/downloads/ford-racing-3-demo"


def verified_bytes(path, size, sha256):
    data = Path(path).read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    if len(data) != size or actual != sha256:
        raise ValueError(f"Identity mismatch: {path}: {len(data)} bytes, SHA-256 {actual}")
    return data


def verified_exe(path):
    return verified_bytes(path, EXE_SIZE, EXE_SHA256)

