# Browser preview and GitHub Pages

This static site runs the original Windows **demo** through a WebAssembly build
of Boxedwine and the Wine 11 WebGL filesystem. It does not replace the original
engine with newly recovered source. It uses the current pinned development
runtime because Boxedwine's published 26R1 web runtime cannot render Direct3D.

## Enable Pages when ready

Commit and push the source changes to `main` (or merge their branch into `main`),
including `web/`, the scripts,
`analysis/game-file-manifest.json` and `.github/workflows/pages.yml`.
Generated files in `artifacts/` and downloaded inputs stay out of Git.

1. Open the repository's **Settings → Pages** and choose **GitHub Actions** as
   the build and deployment source.
2. Open **Actions → Browser demo and GitHub Pages → Run workflow**.
3. Select the branch containing these changes, check **deploy**, and run it.
4. Open the URL reported by the deployment. For this repository it normally is
   `https://omertekin2002.github.io/ford-racing-reverse-engineered/`.

Pushes to `main` build and verify the site without deploying it. Manual runs
with **deploy** unchecked also produce a downloadable artifact without
publishing. The site is live at the URL above; changes on `main` reach it only
after a manual run with **deploy** checked.

The workflow compiles the pinned runtime, downloads and verifies the public
demo, extracts its CAB with Unshield, verifies all 773 original game files,
then uploads the static artifact. It never executes the Windows installer.
Runtime and game assets are assembled during the build instead of committed
as large binaries. If ModDB changes its mirrors, supply the exact same demo ZIP
to `inputs/fordracing3demo.zip` for local builds; its required SHA-256 is
`4bf96967022195519817d91f143c5e1c62e5879a95dd70f5a1cd00ba89b1f84c`.

## Rights-holder notice

The page shows a notice above the player: it is an unofficial preservation
preview, not affiliated with or endorsed by the rights holders, credits the
Ford Racing 3 demo © 2004 Empire Interactive Europe Ltd., links the
[official demo download](https://www.moddb.com/games/ford-racing/downloads/ford-racing-3-demo)
and tells rights holders to request removal through the
[repository's issues](https://github.com/omertekin2002/ford-racing-reverse-engineered/issues).
The preview is taken down if a rights holder objects.
`verify_web.py` fails the build when `index.html` lacks this notice.

## Build locally

Use Linux with Python 3.12+, Git, Make, a C++ build environment and Unshield.
The tool directory requires several GB of free disk space. On a typical
Debian/Ubuntu development machine, install `git make build-essential unshield`
using your normal package manager. An existing verified demo extraction in
`inputs/` is reused. The Unshield wrapper installed by `setup_tools.py`,
`"${FR3_TOOLS:-${XDG_DATA_HOME:-$HOME/.local/share}/fr3-tools}"/bin/unshield`,
can replace the system `unshield`.

```sh
python3 scripts/setup_web_tools.py
python3 scripts/acquire_demo.py inputs --unshield unshield
python3 scripts/build_web.py --jobs 4
python3 scripts/verify_web.py artifacts/web
python3 -m http.server 8000 --directory artifacts/web
```

Open `http://localhost:8000/`. Use HTTP for local testing and HTTPS for public
hosting; opening `index.html` as a local file cannot fetch the runtime.
The production launcher has only relative URLs and supports GitHub project
Pages under a repository path.

The tools default to `<tools>/web`, where `<tools>` is the analysis tool root
(`FR3_TOOLS`, else `${XDG_DATA_HOME:-~/.local/share}/fr3-tools`; see
[tool and cache locations](../README.md#tool-and-cache-locations)).
Set `FR3_WEB_TOOLS` to select another writable tool directory, or pass `--root`
to setup and the same `--tools` to build. `--skip-compile` repackages an existing
build from that pinned checkout; it is useful when editing the launcher.
Setup preserves modified tool source instead of replacing it.

## Runtime requirements and behavior

Use a desktop keyboard, WebGL2, WebAssembly SIMD, tail calls and standardized
Wasm exception handling. The pinned runtime documents Chrome/Edge 137+,
Firefox 131+ and Safari 18.4+; browser/driver differences still need testing.
The default single-threaded JIT rendered and ran the demo in browser testing.
The optional `--runtime multiThreadedJit` build remains experimental: it produced
black frames in this environment and is not the release default.
That runtime needs cross-origin isolation and SharedArrayBuffer.
`isolation-worker.js` supplies COOP/COEP headers for same-origin static responses;
the launcher registers it and reloads once on first use. This works with GitHub
Pages without configuring server headers. It requires HTTPS or localhost.
The worker does not cache or proxy external requests. The launcher requests
isolation for both builds to keep the hosting setup consistent.

The first visit downloads approximately 135 MB, mostly the Wine filesystem and
the original game assets. Downloads are checked against the build's SHA-256
records. Wine and game files are mounted in the emulator; its writable root
and profiles use IndexedDB. Clearing site data, private browsing, or a different
origin/device affects those saves. No backend or game streaming service is used.

Default launch uses `640 nomusic nostream nosound`. Sound effects
are experimental and can be enabled for the next launch; apply changes with
Restart. Streamed music/video are disabled. **Game settings**
opens the original `CONFIG/syscfg.exe` in its required working directory.
Save settings with OK, then use Play demo. The preview's launch resolution is
fixed at 640×480; use the detail settings to reduce rendering work.
The game canvas receives keyboard
input after clicking it. Gamepad and mobile touch controls are not implemented.

The loading bar measures downloads, not game initialization. A quick race,
acceleration, steering and pause were observed in Chromium on Linux. See
[browser validation](browser-validation.md) for evidence and limits.

The Wine filesystem already contains an initialized prefix. Its ZIP timestamp
for `wine.inf` differs from the recorded prefix timestamp by eight hours when
interpreted in UTC, causing an unnecessary rebuild in this environment.
The launcher writes Wine 11's supported `disable` marker to `.update-timestamp`
to use the prepared image. It suppresses unused Mono/Gecko downloads and sets
`WINE_D3D_CONFIG=webgl=1,webgl_glsl_es=1,csmt=0` to disable Wine's multithreaded
graphics command stream. The game keeps its GPU synchronization enabled.
These settings allowed initialization to proceed to the menu and race.
