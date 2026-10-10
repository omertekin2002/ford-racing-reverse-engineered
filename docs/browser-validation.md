# Browser validation — 10 October 2026

The original demo reached its menu and an interactive Quick Race in Chromium
154 on Linux. Acceleration moved the car, steering changed its heading and
position, and P opened the pause menu. Enter resumed the race. This is a smoke
test of the original executable through browser emulation, not a validation of
reconstructed game code or a completed two-lap race.

The working configuration uses the single-threaded Boxedwine WebAssembly JIT,
Wine 11 WebGL filesystem 14, `WINE_D3D_CONFIG=webgl=1,webgl_glsl_es=1,csmt=0`,
and `fr3.exe 640 nomusic nostream nosound`. Game files match all 773 original
manifest entries. Wine's initialized prefix is used without rebuilding it.
The game's GPU synchronization stays enabled. The optional multithreaded JIT
produced black frames and is not the release default.

The test browser used ANGLE with Mesa llvmpipe on a virtual X display. Earlier
headless tests used SwiftShader and rendered the publisher/loading screens.
No physical GPU was available. First initialization took several minutes and
racing was slow on software graphics. This does not establish performance on
real desktop GPUs, Firefox or Safari. Audible sound, gamepads, mobile input,
a full race and long-session stability remain unverified.

The site was served by Python's ordinary static server with no custom headers
under `/ford-racing-reverse-engineered/`. Its service worker successfully made
the page and game iframe cross-origin isolated. Project-relative paths and the
packaged SHA-256 records passed verification. GitHub Pages itself has not been
enabled or deployed during this task.

Evidence is retained in `artifacts/browser-test/playable/`, including
`accelerating.png`, `engine-pause.png`, `steering.png` and `engine-keys.json`.
The input record contains down/up pairs for Enter, P, Arrow Up and Arrow Right.
Temporary C++ process/stack diagnostics were used during investigation and
removed before the release rebuild; the shipped emulator source is pristine
at the recorded revision. Final-package checks and browser observations are
recorded in `analysis/browser-validation.json` and
`artifacts/browser-test/release/`.

The pristine release runtime also reached the menu, Quick Race and pause menu.
Acceleration/steering changed the car's position and heading. A held Arrow Up
received a corresponding release when focus moved to the launcher. A test file
survived replacing the game iframe with the settings iframe through IndexedDB;
it was removed after verification. The original system-settings dialog
rendered in its CONFIG working directory. This storage test checks the mounted
writable filesystem, not completion and restoration of a game profile.
Fullscreen opens the player, and Escape exits through the launcher before the
emulator's keyboard handler consumes it.

For reproduction, build and serve the site as described in
[the browser guide](browser.md), click Play, click the canvas, press Enter
through the introduction and choose Quick Race. Hold Arrow Up to accelerate,
use Left/Right to steer and press P to pause. Do not infer playability from the
launcher reporting that its runtime has started: inspect the game itself.
