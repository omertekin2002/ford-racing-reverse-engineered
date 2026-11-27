# Browser preview and GitHub Pages

This static site offers two runtimes. **Play (Boxedwine)** runs the original
Windows **demo** through a WebAssembly build of Boxedwine and the Wine 11 WebGL
filesystem. It does not replace the original engine with newly recovered source.
It uses the current pinned development runtime because Boxedwine's published
26R1 web runtime cannot render Direct3D.

**Play** opens `native.html`, which runs the separate, owner-maintained native
engine from `engine/`: an independent TypeScript + WebGL2 reimplementation, not
the original executable. `build_web.py` copies its bundle,
`engine/dist/fr3-engine.js`, to the site's `native/` directory. It reads the
same `runtime/fr3.zip` of unchanged demo files at runtime, so the site
redistributes nothing new, and it is not research evidence: nothing under
`research/` cites it. Build and test it with `npm --prefix engine ci`, then
`npm --prefix engine run typecheck`, `run build` and `test`; see the
[README](../README.md#native-engine-engine). The rest of this guide describes
the Boxedwine runtime unless it says otherwise.

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

Pushes to `main` that touch `web/`, `scripts/`, `analysis/` or the workflow
build, verify and deploy the site to the URL above. Manual runs with **deploy** unchecked produce a
downloadable artifact without publishing.

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
`native.html`, which can be opened directly, shows the same credit and both
links in a strip below the game canvas, outside the loading overlay, with a line
saying it is an independent reimplementation reading the demo's files, not the
original executable, whose physics and AI are approximations.
`verify_web.py` fails the build when `index.html` or `native.html` lacks this
notice, its credit or either link, or when `native.html` puts it inside the
loading overlay.

## Research findings

Per decision #46 the site also publishes the generated research pages under
`research/`, at
<https://omertekin2002.github.io/ford-racing-reverse-engineered/research/>. The
landing page links them as **Explore findings**. The directory holds what
`scripts/build_research.py` writes (see
[the analysis notes](analysis.md#research-directory)): the entrance page
`index.html`, `cars.html`, `engines.html`, `gearboxes.html`, `compare.html`, `tyres.html`, `pcg.html`,
`routines.html` and `questions.html`, and the committed `analysis/` files they link to under
`evidence/`. No parsed JSON
or game file is published there. Every page carries the same rights-holder
notice and official demo link as the preview, before its content.

The workflow builds the pages from the verified demo right after acquiring it,
into `artifacts/web/research/`, before `build_web.py` writes `SHA256SUMS`, so the
sums cover every research file. When `index.html` links to `research/` or the
directory exists, `verify_web.py` requires `research/index.html`, runs
`verify_research()` on the directory (notice on every page, no scripts or
external resources, every local link resolving inside `research/`, no file
other than the ones `build_research.py` writes), checks
`research/index.html`'s relative URLs and requires every file under `research/`
to be listed in `SHA256SUMS`.

The workflow then packages those pages with `scripts/package_research.py` (see
[the analysis notes](analysis.md#research-packet)) as
`artifacts/web/downloads/fr3-research-latest.zip`, also before `build_web.py`,
so `SHA256SUMS` lists it. It is published at the stable URL
<https://omertekin2002.github.io/ford-racing-reverse-engineered/downloads/fr3-research-latest.zip>,
linked from the landing page's intro and footer, and rebuilt on every deploy:
an offline copy of the `research/` files in one `fr3-research-<short revision>/`
folder, with a `MANIFEST.json` naming the producer revision, input build and
checks it passed, and a `SHA256SUMS`. `SOURCE_DATE_EPOCH` is set to the commit
time, so its entries carry that timestamp. When `index.html` links to the packet
or the file exists, `verify_web.py` requires it to be listed in the site's
`SHA256SUMS`, to pass a ZIP integrity test, to hold exactly one top-level folder
named for the revision `research/index.html` names, with `MANIFEST.json` and
`SHA256SUMS`, to name that producer revision in `MANIFEST.json`, and to hold
exactly the files published under `research/`, byte for byte, each matching both
of its manifests. Older revisions' packets are not kept on the site.

The research pages and the packet are taken down together with the preview if a
rights holder objects: all are one Pages deployment, so disabling Pages or
removing the deploy removes them all.

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
python3 scripts/build_research.py --output artifacts/web/research
python3 scripts/package_research.py --research artifacts/web/research \
  --output artifacts/web/downloads/fr3-research-latest.zip
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

After editing `web/site.js` or `web/runtime-bridge.js`, run their tests with
Node 22+ (no `npm install`, no network, no build needed):

```sh
node --test "tests/js/*.test.mjs"
```

They load the real files with stand-in browser and Boxedwine globals and cover
the launcher's readiness, isolation, launch of both runtimes, Restart, message and log handling,
and the bridge's runtime arguments, download size and SHA-256 checks and its
messages to the launcher. They do not run Boxedwine, Wine or the game.

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

The loading bar measures downloads. After that, Wine and the game start and the
screen can stay black for minutes. The launcher shows an indeterminate bar and
keeps Play demo and Game settings disabled until the game shows a detailed
frame, so Play demo cannot restart a slow first launch; Restart stays
available. `runtime-bridge.js` checks once a second: software frames on the
2D present canvas, and Direct3D frames by `readPixels` from the emulator's
preserved WebGL2 buffer (copying that canvas to a 2D canvas read back black in
testing, probably because Direct3D leaves alpha at zero). Single-colour frames, such as the black screen and Wine's
plain desktop, are ignored. Only then does it ask for Enter, which the game
accepts at its PRESS ANY KEY screen. After 10 minutes without such a frame the
buttons are re-enabled anyway. A quick race,
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
