# Browser preview and GitHub Pages (Ford Racing 3 Shuffle)

This static site runs the independent TypeScript + WebGL2 engine (`engine/`)
against the **Ford Racing 3 Shuffle** game files in `game/` (4,446 files,
148 cars, 125 tracks). Boxedwine is not built for Shuffle.

## How assets are loaded

- **On-demand HTTP VFS (default):** `scripts/build_web.py` stages `game/`
  under `runtime/game/` and writes `runtime/game-manifest.json`. `web/native.html`
  mounts `HttpVfs` against `runtime/game-manifest.json`, fetching only the
  databases, UI assets, and selected cars/tracks on demand.
- **ZIP fallback (optional):** pass `--zip` to `scripts/build_web.py` to also
  package `runtime/fr3.zip`. Open `native.html?zip=runtime/fr3.zip` to load
  through `ZipVfs`.

## Build locally

Requires Node 22+ and Python 3.12+ (no Emscripten, Unshield, or Boxedwine tools):

```sh
npm --prefix engine ci
npm --prefix engine run typecheck
npm --prefix engine run build
npm --prefix engine test

python3 scripts/acquire_demo.py game
python3 scripts/build_web.py --game game --output artifacts/web --symlink-game
python3 scripts/verify_web.py artifacts/web
python3 -m http.server 8000 --directory artifacts/web
```

Omit `--symlink-game` when building a self-contained static copy for upload or
deployment. Open `http://localhost:8000/` in a desktop browser with WebGL2 and
keyboard input.

## Tests

```sh
node --test "tests/js/*.test.mjs"
npm --prefix engine test
python3 -m unittest discover -s tests -v
```

## Rights-holder notice

Both `web/index.html` and `web/native.html` carry `#rights-notice` crediting
`Ford Racing 3 © 2004 Empire Interactive Europe Ltd.` and linking to
[Ford Racing 3 Shuffle](https://github.com/ZippyZolton/Ford-Racing-3-Shuffle)
and the [repository's issues](https://github.com/omertekin2002/ford-racing-reverse-engineered/issues).
`scripts/verify_web.py` fails the build if the notice, credit, or either link is
missing or obscured by the loading overlay.
