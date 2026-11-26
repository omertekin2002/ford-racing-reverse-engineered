"""Build a static GitHub Pages package for the original Ford Racing 3 demo."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import zipfile

from fr3_common import web_tools_root
from setup_tools import download
from setup_web_tools import BOXEDWINE_REVISION, EMSCRIPTEN_VERSION, WINE_WEB_SHA256, WINE_WEB_URL, require_clean_source

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def game_zip(game, destination):
    manifest = json.loads((ROOT / "analysis/game-file-manifest.json").read_text())
    actual = {p.relative_to(game).as_posix() for p in game.rglob("*") if p.is_file()}
    if actual != {entry["path"] for entry in manifest}:
        raise ValueError("Game files differ from the recorded demo manifest")
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for entry in manifest:
            path = game / entry["path"]
            if path.stat().st_size != entry["size"] or digest(path) != entry["sha256"]:
                raise ValueError(f"Demo file changed: {entry['path']}")
            info = zipfile.ZipInfo(entry["path"], (2026, 4, 22, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    return len(manifest)


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
    parser.add_argument("--tools", type=Path, default=web_tools_root(),
                        help="Browser tool root from setup_web_tools.py (env FR3_WEB_TOOLS, else <FR3_TOOLS>/web; default: %(default)s)")
    parser.add_argument("--game", type=Path, default=ROOT / "inputs/extracted/Program_Executable_Files")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/web")
    parser.add_argument("--native-bundle", type=Path, default=ROOT / "engine/dist/fr3-engine.js",
                        help="Built native TypeScript + WebGL2 bundle (default: %(default)s)")
    parser.add_argument("--native-only", action="store_true",
                        help="Package only the native WebGL2 engine + fr3.zip without Boxedwine/Wine")
    parser.add_argument("--skip-compile", action="store_true", help="Reuse this pinned source's existing JIT build")
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--runtime", choices=("jit", "multiThreadedJit"), default="jit")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    runtime = output / "runtime"
    runtime.mkdir(exist_ok=True)
    native_dest = copy_native_bundle(output, args.native_bundle)
    files = game_zip(args.game.resolve(), runtime / "fr3.zip")

    if args.native_only:
        copy_web_assets(output, native_dest)
        assets = {
            "fr3.zip": {"bytes": (runtime / "fr3.zip").stat().st_size, "sha256": digest(runtime / "fr3.zip")},
            "fr3-engine.js": {"bytes": native_dest.stat().st_size, "sha256": digest(native_dest)},
        }
        record = {
            "version": "0.3.0-native-webgl2",
            "runtime": "Native TypeScript + WebGL2",
            "original_game_files": files,
            "assets": assets,
        }
        (output / "build.json").write_text(json.dumps(record, indent=2) + "\n")
        (output / ".nojekyll").touch()
        (output / "SHA256SUMS").write_text("".join(f"{digest(p)}  {p.relative_to(output).as_posix()}\n"
                                                  for p in sorted(output.rglob("*")) if p.is_file() and p.name != "SHA256SUMS"))
        print(f"Static native WebGL2 package: {output}; {files} original game files verified")
        return

    tools = args.tools.resolve()
    source = tools / "Boxedwine"
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if revision != BOXEDWINE_REVISION:
        raise ValueError("Unexpected Boxedwine revision; run setup_web_tools.py")
    require_clean_source(source)
    if not args.skip_compile:
        script = "source " + shlex.quote(str(tools / "emsdk/emsdk_env.sh")) + "\n"
        script += f"test \"$(emcc -dumpversion)\" = {shlex.quote(EMSCRIPTEN_VERSION)}\n"
        script += "export SOURCE_DATE_EPOCH=1776872511\n"
        script += "make " + args.runtime + " cpus=" + str(max(2, args.jobs + 1)) + " WEBGL_COUNTER_JIT_EXPORTS=,FS,addRunDependency,removeRunDependency,ccall\n"
        subprocess.run(["bash", "-e", "-c", script], cwd=source / "project/emscripten", check=True)
    build = source / "project/emscripten/Build" / ("Jit" if args.runtime == "jit" else "MultiThreadedJit")
    for name in ("boxedwine.js", "boxedwine.wasm", "boxedwine-shell.js", "boxedwine.css"):
        shutil.copyfile(build / name, runtime / name)
    cache = tools / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    filesystem = download(cache, WINE_WEB_URL, "TinyCore15Wine11.0-web.zip", WINE_WEB_SHA256)
    subprocess.run(["python3", str(source / "tools/buildWine/webgl_filesystem.py"), "validate",
                    "--config", str(source / "tools/buildWine/webgl_filesystems_v14.json"),
                    "--profile", "web-v14", "--filesystem", str(filesystem)], check=True)
    shutil.copyfile(filesystem, runtime / "wine11.zip")
    html = (build / "boxedwine.html").read_text()
    html = html.replace("<!doctypehtml>", "<!doctype html>")
    html = html.replace("<title>BoxedWine</title>", "<title>Ford Racing 3 — game</title>")
    html = html.replace("</head>", '<link rel="stylesheet" href="../emulator.css"></head>')
    html = html.replace('<script async type="text/javascript" src="boxedwine.js">', '<script src="../runtime-bridge.js"></script><script async type="text/javascript" src="boxedwine.js">')
    if '../runtime-bridge.js' not in html:
        # Recent Emscripten emits a shorter script tag.
        needle = '<script'
        where = html.rfind(needle)
        html = html[:where] + '<script src="../runtime-bridge.js"></script>' + html[where:]
    (runtime / "game.html").write_text(html)
    copy_web_assets(output, native_dest)
    licenses = output / "licenses"
    licenses.mkdir(exist_ok=True)
    shutil.copyfile(source / "license.txt", licenses / "Boxedwine-GPL-2.0.txt")
    wine_license = download(cache, "https://raw.githubusercontent.com/wine-mirror/wine/wine-11.0/COPYING.LIB",
                            "wine-11.0-COPYING.LIB", "e237fa56668030e928551ddd60f05df5fe957f75eab874bbd017e085ed722e7c")
    shutil.copyfile(wine_license, licenses / "Wine-LGPL-2.1.txt")
    # Corresponding emulator source is served beside the binary, including build files.
    with (licenses / "boxedwine-source.tar.gz").open("wb") as stream:
        subprocess.run(["git", "-C", str(source), "archive", "--format=tar.gz", "--prefix=Boxedwine/", BOXEDWINE_REVISION], stdout=stream, check=True)
    assets = {name: {"bytes": (runtime / name).stat().st_size, "sha256": digest(runtime / name)}
              for name in ("boxedwine.js", "boxedwine.wasm", "wine11.zip", "fr3.zip")}
    record = {"version": "0.2.0-browser-preview", "runtime": "Boxedwine WebAssembly JIT, Wine 11",
              "runtime_target": args.runtime,
              "boxedwine_revision": revision, "emscripten": EMSCRIPTEN_VERSION,
              "wine_filesystem_sha256": WINE_WEB_SHA256,
              "original_game_files": files, "assets": assets,
              "runtime_validation": "See browser validation notes; successful packaging alone does not prove gameplay."}
    (output / "build.json").write_text(json.dumps(record, indent=2) + "\n")
    (output / ".nojekyll").touch()
    (output / "SHA256SUMS").write_text("".join(f"{digest(p)}  {p.relative_to(output).as_posix()}\n"
                                              for p in sorted(output.rglob("*")) if p.is_file() and p.name != "SHA256SUMS"))
    print(f"Static browser package: {output}; {files} original game files verified")


if __name__ == "__main__":
    main()
