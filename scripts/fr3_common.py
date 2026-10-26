"""Build identity from the supplied report, not yet independent evidence.

Also resolves the tool and download-cache roots shared by the setup and build
scripts: an explicit flag wins, then FR3_TOOLS / FR3_CACHE, then XDG defaults.
The original cloud workspace layout is FR3_TOOLS=/workspace/toolchains/fr3
FR3_CACHE=/workspace/shared/downloads.
"""
import hashlib
import os
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



def _env_path(environ, name):
    value = environ.get(name, "").strip()
    return Path(value) if value else None


def _xdg_dir(environ, name, fallback):
    # The XDG spec says relative values are invalid and must be ignored.
    base = _env_path(environ, name)
    if base and base.is_absolute():
        return base
    home = _env_path(environ, "HOME") or Path.home()
    return home / fallback


def tools_root(explicit=None, environ=None):
    """Analysis tool root: flag, then FR3_TOOLS, then $XDG_DATA_HOME/fr3-tools."""
    if explicit is not None:
        return Path(explicit)
    environ = os.environ if environ is None else environ
    return _env_path(environ, "FR3_TOOLS") or _xdg_dir(environ, "XDG_DATA_HOME", ".local/share") / "fr3-tools"


def download_cache(explicit=None, environ=None):
    """Download cache: flag, then FR3_CACHE, then $XDG_CACHE_HOME/fr3/downloads."""
    if explicit is not None:
        return Path(explicit)
    environ = os.environ if environ is None else environ
    return _env_path(environ, "FR3_CACHE") or _xdg_dir(environ, "XDG_CACHE_HOME", ".cache") / "fr3" / "downloads"


def runtime_root(explicit=None, environ=None):
    """Wine release runtimes: flag, then <tools root>/runtime."""
    return Path(explicit) if explicit is not None else tools_root(environ=environ) / "runtime"


def web_tools_root(explicit=None, environ=None):
    """Browser build tools: flag, then FR3_WEB_TOOLS, then <tools root>/web."""
    if explicit is not None:
        return Path(explicit)
    environ = os.environ if environ is None else environ
    return _env_path(environ, "FR3_WEB_TOOLS") or tools_root(environ=environ) / "web"
