# Ford Racing 3 browser preview

This folder is a complete static site containing the original Windows demo,
Boxedwine's WebAssembly runtime and the Wine WebGL filesystem.

To test it after extracting the ZIP:

```sh
python3 -m http.server 8000 --directory .
```

Open `http://localhost:8000/`, press Play, click the game canvas and press Enter
through the introduction. Select Quick Race. Arrow keys drive, Space is the
handbrake, Right Ctrl boosts and P pauses. First initialization can take
several minutes. Use a recent desktop browser with WebGL2 and a keyboard.
Serve over HTTPS when publicly hosting it; opening `index.html` as a local file
does not work.

For GitHub Pages, use the repository's **Browser demo and GitHub Pages**
workflow after selecting **GitHub Actions** in Settings → Pages. Manual runs
deploy only when **deploy** is checked. Source and build instructions are in
the repository's `docs/browser.md`.

The page shows an unofficial-preview notice above the player with the game's
credit, a link to the official demo download and a removal-request link to the
repository's issues. The hosted preview is taken down if a rights holder
objects. Keep the notice when hosting a copy.

Chromium on Linux was tested with a Quick Race and keyboard input. Software
graphics was slow. Other browsers, audible sound and full-race completion
remain unverified. Music/video streaming is disabled and sound effects are
experimental. This contains the demo, with its original car/track limits.

`build.json` identifies the runtime and assets; `SHA256SUMS` covers the static
files. See `THIRD_PARTY.md` and `licenses/` for notices and emulator source.
