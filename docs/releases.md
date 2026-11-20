# Ford Racing 3 Demo 0.1.0 preview

These packages run the original **public Windows demo** through bundled Wine.
They contain its unchanged 773 game files and original manuals. They are
compatibility releases; the recovered decompiler output is not yet a native
Linux or macOS game engine. The retail game is not included.

**Download:** the packages and their `SHA256SUMS` are attached to the
[v0.1.0-preview release](https://github.com/omertekin2002/ford-racing-reverse-engineered/releases/tag/v0.1.0-preview)
([`SHA256SUMS`](https://github.com/omertekin2002/ford-racing-reverse-engineered/releases/download/v0.1.0-preview/SHA256SUMS)).

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
Outputs are written to `artifacts/releases/`: the two archives, `SHA256SUMS`
and `builds.json`, which lists each archive's size, SHA-256 and manifest file
count beside the package's `BUILD.json` fields.

`BUILD.json` and every `builds.json` entry name the commit that was built in
`source_revision` (the full `git rev-parse HEAD`) and record `dirty`. The
builder refuses a checkout with uncommitted or untracked changes, or a tree
that is not a Git checkout. Pass `--allow-dirty` to build one anyway; the
packages then record `"dirty": true`, and `source_revision` is `null` when
there is no commit to name.

### Building in CI

The **Wine compatibility packages** workflow
(`.github/workflows/releases.yml`) runs the same steps on a GitHub-hosted
Ubuntu runner: it acquires and verifies the public demo, installs the pinned
runtimes, runs `build_releases.py`, checks `sha256sum -c SHA256SUMS`, verifies
both archives again, extracts the Linux package and runs `./launch.sh --verify`
in it. It runs on pull requests and pushes to `main` that change the builder,
the launchers, these documents or the game-file manifest, on every pushed
`v*` tag (see [Making a release](#making-a-release)), and on demand:

```sh
gh workflow run releases.yml --repo omertekin2002/ford-racing-reverse-engineered --ref main
```

Each run uploads one workflow artifact, `ford-racing-3-demo-wine-packages`,
holding exactly the two archives, `SHA256SUMS` and `builds.json`. It appears
under **Artifacts** on the run's summary page and is kept for 14 days. Fetch
and check it with:

```sh
gh run download <run-id> --repo omertekin2002/ford-racing-reverse-engineered \
  --name ford-racing-3-demo-wine-packages --dir wine-packages
cd wine-packages && sha256sum -c SHA256SUMS
```

A pull-request run builds GitHub's temporary merge commit, so its
`source_revision` names that commit; a run on `main` names the `main` commit.
The build job has read-only repository access. Pull-request, `main` and
on-demand runs create no release, tag or deployment. No run launches the game
under Wine; see [runtime validation](release-validation.md) for what has been run.

### Making a release

A pushed version tag drafts the release from the CI-built files; publishing it
stays the repository owner's click.

1. Bump `VERSION` in `scripts/build_releases.py` and merge that to `main`.
2. Push the matching tag from that `main` commit: `git tag v<VERSION>` and
   `git push origin v<VERSION>`. Agents never push release tags.
3. The tag runs **Wine compatibility packages**. Before building it fails if
   the tag is not exactly `v` + `VERSION`, naming both. After the build
   and its checksum checks, it also requires each `builds.json` entry's `source_revision`
   to be the tagged commit.
4. The `draft-release` job, the only job with write access, runs only on tag
   pushes. It downloads the run's artifact, checks
   `sha256sum -c SHA256SUMS` again and runs `scripts/release_tag.py draft`.
   That creates a **draft** release for the tag with `gh release create
   --draft --verify-tag`, titled like `Ford Racing 3 Demo 0.1.0 preview (Wine
   packages)`, marked pre-release when `VERSION` has a `-` suffix. It attaches
   exactly the two archives, `SHA256SUMS` and `builds.json`, with notes
   generated from `builds.json` that link this page and the run.
5. If the tag already has a release, draft or published, the job fails and
   leaves that release unchanged. Delete the old draft first, or bump
   `VERSION` and tag again.
6. Review the draft on the Releases page, edit its notes if needed, and press
   **Publish**. The workflow never publishes, edits a release or pushes a tag.

To preview the command and notes from a downloaded artifact without touching
GitHub:

```sh
python3 scripts/release_tag.py draft wine-packages --tag v<VERSION> \
  --sha <commit> --repo omertekin2002/ford-racing-reverse-engineered \
  --run-url <run-url> --dry-run
```

v0.1.0-preview predates this workflow and was published by hand from a local
build: the packages were built with the two commands above, checked with
`sha256sum -c SHA256SUMS` and the Linux package's `./launch.sh --verify`, and
attached with `gh release create v<version> --prerelease` to the two archives
and `SHA256SUMS`.

The version comes from `VERSION` in `scripts/build_releases.py`.
