# Ford Racing 3 Demo 0.1.0 preview

These packages run the original **public Windows demo** through bundled Wine.
They contain its unchanged 773 game files and original manuals. They are
compatibility releases; the recovered decompiler output is not yet a native
Linux or macOS game engine. The retail game is not included.

## Linux

Extract `ford-racing-3-demo-0.1.0-preview-linux-x86_64.tar.gz`, open its directory,
and run `./launch.sh` from a graphical desktop. Run `./launch.sh --configure`
to change the original game's display, audio, language and detail settings.
Linux launches inside a Wine virtual desktop, allowing the demo's fullscreen
renderer to work when the host desktop cannot switch to its older display modes.
Use `./launch.sh --fullscreen` to request the host display directly.

Requires Linux x86_64, glibc 2.27 or newer, kernel support for 32-bit x86 code,
and working graphics/audio drivers with Wine dependencies. This package uses
Wine 11.0 WoW64, so 32-bit Linux libraries are not required. Installing your
distribution's Wine package supplies the normal runtime dependencies if any
are missing. The demo's WMA music also needs 64-bit GStreamer base plugins,
ASF demuxing and WMA decoding. On Debian/Ubuntu those are supplied by
`gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-ugly` and `gstreamer1.0-libav`.
X11 or a desktop with XWayland is recommended.

Game files, saves, settings, and `last-run.log` are stored in
`${XDG_DATA_HOME:-~/.local/share}/ford-racing-3-demo`. The first launch copies
the demo into that writable directory and initializes a separate Wine prefix.
It may take a minute. Later launches reuse the prefix and preserve saves.

## macOS

Extract `ford-racing-3-demo-0.1.0-preview-macos.zip`, move **Ford Racing 3 Demo.app**
to Applications, and open it. Requires macOS Catalina 10.15 or newer. Apple
Silicon Macs also require Rosetta 2 because the bundled Wine runtime is Intel.
The upstream Wine 11.0_1 build requires
[GStreamer 1.28.1](https://gstreamer.freedesktop.org/data/pkg/osx/1.28.1/gstreamer-1.0-1.28.1-universal.pkg)
installed for all users. Wine itself is included.

This preview is unsigned and is not notarized. macOS may require an explicit
Open action in Finder. It has been assembled and checked on Linux; actual
macOS launch, graphics and input have not been tested on a Mac.

Game files, saves, settings and `last-run.log` are stored in
`~/Library/Application Support/Ford Racing 3 Demo`. To open game configuration:

```sh
"/Applications/Ford Racing 3 Demo.app/Contents/MacOS/ford-racing-3" --configure
```

## Options and troubleshooting

- `--verify` checks the installed package's file hashes without launching Wine.
- `--winecfg` opens Wine settings for this game's separate prefix.
- `--version` reports the package and bundled Wine versions.
- `--desktop` runs inside a Wine virtual desktop; this is the Linux default.
- `--fullscreen` uses the host display; this is the macOS default.
- `FR3_DESKTOP_SIZE=800x600` sets the initial virtual desktop size.
- `FR3_DATA_HOME=/absolute/path` selects a different writable save directory.
- `FR3_WINE=/absolute/path/to/wine` selects another compatible Wine build.
- Game arguments can follow the launcher. The demo recognizes `800` for
  800×600; the original settings tool is preferred for persistent settings.
  The demo forces fullscreen after parsing its `fs:0` argument, so that argument
  does not enable windowed rendering.

If startup fails, inspect `last-run.log`. A graphical desktop and functioning
3D driver are required. CPU emulation in this cloud workspace is a validation
aid, not part of the release runtime. See `docs/release-validation.md` in the
source repository for the exact scope of runtime testing.
To skip streamed music while diagnosing missing media codecs, launch with
`./launch.sh nomusic nostream`. This uses the demo's existing command-line
options and does not modify its executable.

Each package contains a SHA-256 manifest, `BUILD.json`, Wine's license,
third-party provenance, and the original game README/manuals. Release archive
checksums are in the adjacent `SHA256SUMS` file.

## Rebuild

From the repository checkout:

```sh
python3 scripts/setup_release_tools.py
python3 scripts/build_releases.py
```

Runtimes are installed in `<tools>/runtime` and downloads are cached in the
shared download cache. Both follow `FR3_TOOLS` and `FR3_CACHE`; see
[tool and cache locations](../README.md#tool-and-cache-locations). Pass the same
`--root`/`--runtime-root` and `--cache` to both commands to use other directories.

The builder checks every original demo file against the analysis manifest,
extracts runtimes from pinned upstream archives, preserves executable modes
and macOS symlinks, and checks all archive contents against their manifests.
Outputs are written to `artifacts/releases/`.
