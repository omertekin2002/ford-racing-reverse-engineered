"""Build a static Native WebGL2 site for Ford Racing 3 Shuffle."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

from fr3_common import DEFAULT_GAME_DIR, verified_exe

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_game_tree(game, manifest=None):
    """Verify every file in game against analysis/game-file-manifest.json and return the manifest list."""
    if manifest is None:
        manifest = json.loads((ROOT / "analysis/game-file-manifest.json").read_text(encoding="utf-8"))
    verified_exe(game / "fr3.exe")
    actual = {p.relative_to(game).as_posix() for p in game.rglob("*") if p.is_file()}
    if actual != {entry["path"] for entry in manifest}:
        raise ValueError("Game files differ from the recorded game manifest")
    for entry in manifest:
        path = game / entry["path"]
        if path.stat().st_size != entry["size"] or digest(path) != entry["sha256"]:
            raise ValueError(f"Game file changed: {entry['path']}")
    return manifest


def game_zip(game, destination, manifest=None):
    """Package verified game files into a deterministic ZIP archive."""
    manifest = verify_game_tree(game, manifest)
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for entry in manifest:
            path = game / entry["path"]
            info = zipfile.ZipInfo(entry["path"], (2026, 4, 22, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    return len(manifest)


def stage_http_game(game, runtime, manifest, symlink=False):
    """Stage game files for on-demand HTTP VFS streaming and write runtime/game-manifest.json."""
    game_dest = runtime / "game"
    if game_dest.is_symlink():
        game_dest.unlink()
    elif game_dest.exists():
        shutil.rmtree(game_dest)
    if symlink:
        game_dest.symlink_to(game.resolve())
    else:
        for entry in manifest:
            src = game / entry["path"]
            dst = game_dest / entry["path"]
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
    manifest_dest = runtime / "game-manifest.json"
    payload = {
        "version": 1,
        "baseUrl": "game",
        "files": [entry["path"] for entry in manifest],
    }
    manifest_dest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return manifest_dest


def copy_native_bundle(output, native_bundle):
    bundle = native_bundle.resolve()
    if not bundle.is_file():
        raise ValueError(f"Native WebGL2 bundle missing: {bundle} (run 'npm --prefix engine run build')")
    native_dir = output / "native"
    native_dir.mkdir(parents=True, exist_ok=True)
    destination = native_dir / "fr3-engine.js"
    shutil.copyfile(bundle, destination)
    return destination


def _stamp_once(path, old, new):
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise ValueError(f"Expected {old!r} in {path.name} for cache busting")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def copy_web_assets(output, native_bundle, web_dir=ROOT / "web"):
    """Copy static web/ files and stamp content-hash query parameters onto the native WebGL2 chain."""
    for path in web_dir.iterdir():
        if path.is_file():
            shutil.copyfile(path, output / path.name)
    engine_hash = digest(native_bundle)[:12]
    native_html = output / "native.html"
    if native_html.is_file():
        _stamp_once(native_html, "./native/fr3-engine.js", f"./native/fr3-engine.js?v={engine_hash}")
        native_html_hash = digest(native_html)[:12]
        site_js = output / "site.js"
        if site_js.is_file():
            _stamp_once(site_js, "native.html?sound=", f"native.html?v={native_html_hash}&sound=")
    index_html = output / "index.html"
    if index_html.is_file():
        site_js = output / "site.js"
        if site_js.is_file():
            _stamp_once(index_html, 'src="site.js"', f'src="site.js?v={digest(site_js)[:12]}"')
        site_css = output / "site.css"
        if site_css.is_file():
            _stamp_once(index_html, 'href="site.css"', f'href="site.css?v={digest(site_css)[:12]}"')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game", type=Path, default=DEFAULT_GAME_DIR,
                        help="Verified Ford Racing 3 Shuffle directory (default: %(default)s)")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/web",
                        help="Static site output directory (default: %(default)s)")
    parser.add_argument("--native-bundle", type=Path, default=ROOT / "engine/dist/fr3-engine.js",
                        help="Built native TypeScript + WebGL2 bundle (default: %(default)s)")
    parser.add_argument("--zip", action="store_true",
                        help="Also package all verified game files into runtime/fr3.zip")
    parser.add_argument("--symlink-game", action="store_true",
                        help="Symlink runtime/game to --game instead of copying (for fast local dev)")
    args = parser.parse_args()

    game = args.game.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    runtime = output / "runtime"
    runtime.mkdir(exist_ok=True)

    manifest = verify_game_tree(game)
    native_dest = copy_native_bundle(output, args.native_bundle)
    manifest_dest = stage_http_game(game, runtime, manifest, symlink=args.symlink_game)

    assets = {
        "fr3-engine.js": {
            "path": "native/fr3-engine.js",
            "bytes": native_dest.stat().st_size,
            "sha256": digest(native_dest),
        },
        "game-manifest.json": {
            "path": "runtime/game-manifest.json",
            "bytes": manifest_dest.stat().st_size,
            "sha256": digest(manifest_dest),
        },
    }

    if args.zip:
        zip_dest = runtime / "fr3.zip"
        game_zip(game, zip_dest, manifest)
        assets["fr3.zip"] = {
            "path": "runtime/fr3.zip",
            "bytes": zip_dest.stat().st_size,
            "sha256": digest(zip_dest),
        }

    copy_web_assets(output, native_dest)
    record = {
        "version": "0.4.0-shuffle-webgl2",
        "game": "Ford Racing 3 Shuffle",
        "runtime": "Native TypeScript + WebGL2",
        "manifest": "runtime/game-manifest.json",
        "original_game_files": len(manifest),
        "assets": assets,
    }
    (output / "build.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    (output / ".nojekyll").touch()
    sum_lines = []
    for path in sorted(output.rglob("*")):
        if path.is_symlink() or not path.is_file() or path.name == "SHA256SUMS":
            continue
        sum_lines.append(f"{digest(path)}  {path.relative_to(output).as_posix()}\n")
    (output / "SHA256SUMS").write_text("".join(sum_lines), encoding="utf-8")
    mode = "symlinked" if args.symlink_game else "copied"
    zip_note = " + runtime/fr3.zip" if args.zip else ""
    print(f"Static Native WebGL2 Shuffle package: {output}; {len(manifest)} game files verified ({mode}{zip_note})")


if __name__ == "__main__":
    main()
