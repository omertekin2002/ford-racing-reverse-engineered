"""Package verified analysis, excluding game assets and working databases."""
import hashlib
import json
from pathlib import Path
import zipfile


def main():
    root = Path(__file__).resolve().parents[1]
    verified = json.loads((root / "analysis/verification.json").read_text())
    packed = root / "artifacts/fr3-demo-annotated.gzf"
    if hashlib.sha256(packed.read_bytes()).hexdigest() != verified["annotated_snapshot_sha256"]:
        raise ValueError("Packed snapshot has changed since verification")
    files = [root / "README.md"]
    for directory in ("scripts", "tests", "recovered", "docs", "analysis", "artifacts/ghidra", "artifacts/pe", "artifacts/logs"):
        files.extend(p for p in sorted((root / directory).rglob("*")) if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc")
    files.append(packed)
    manifest = "\n".join(hashlib.sha256(path.read_bytes()).hexdigest() + "  " + path.relative_to(root).as_posix() for path in files) + "\n"
    (root / "artifacts/MANIFEST.sha256").write_text(manifest)
    destination = root / "artifacts/fr3-analysis.zip"
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in files:
            archive.write(path, path.relative_to(root).as_posix())
        archive.writestr("MANIFEST.sha256", manifest)
    with zipfile.ZipFile(destination) as archive:
        if archive.testzip() is not None:
            raise ValueError("Analysis bundle failed its ZIP integrity check")
        for line in archive.read("MANIFEST.sha256").decode().splitlines():
            digest, name = line.split("  ", 1)
            if hashlib.sha256(archive.read(name)).hexdigest() != digest:
                raise ValueError("Bundle content hash mismatch: " + name)
    print(f"Packaged and verified {len(files)} files: {destination} ({destination.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
