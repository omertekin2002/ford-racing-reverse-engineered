# Compatibility release validation

The 0.1.0 preview packages contain the public Windows demo and bundled Wine,
not a native reconstruction of the engine. The installer was not executed;
the extracted original demo files remain unchanged.

## Archive checks

Both archives were built and checked against SHA-256 manifests. All 773 game
files match the original extraction. The Linux package contains 4,758 hashed
files; the macOS package contains 5,545. ZIP CRC checks, the macOS bundle plist
and executable, shell syntax, Unix executable permissions and all 67 macOS
runtime symlinks were checked. The extracted Linux package's hashes were also
checked independently before launch. Repeated runtime setup and the saved
environment installation script completed successfully.
Repeated launches also preserved a user file in the writable game directory.

## Linux execution

The cloud host rejects a minimal 32-bit Linux ELF executable, and Wine 10/11
WoW64 failed before the game could open a window. A QEMU userspace fallback
also failed. Those failures are not reported as successful runtime checks.

The subsequent functional check used QEMU 10.0.13 with the signed Debian
6.12.107 amd64 kernel, which enables IA32 emulation, two emulated CPUs and
4 GiB RAM. It used Xvfb, Mesa 25.0.7 llvmpipe and Wine 11.0 WoW64. The guest
root contains staged validation dependencies and game copies; it has no
network interface or access to the host's home/credentials.

The original configuration screen opened. Direct fullscreen rendering failed
because Xvfb could not switch to the game's requested display mode. Wine's
virtual desktop resolved that failure and is now the Linux launcher's default.
The configuration launcher also uses the CONFIG directory so its Run Game
button can resolve `../fr3.exe`.

The extracted release launcher successfully created a writable copy of the
game, started its separate Wine prefix, and rendered the title and an animated
race scene. The tested command was:

```sh
FR3_DATA_HOME=/release-state ./launch.sh 800 nomusic nostream
```

The VM used a null audio sink. Earlier runs without the media/audio dependencies
produced GStreamer errors and a loading crash. Streamed music was disabled in
the recorded smoke test. **Audible playback, a complete interactive race,
physical gamepads and long-session stability remain unverified.** This smoke
test does not validate reconstructed physics or numerical equivalence.

Evidence is retained under `artifacts/runtime-test/vm-root/state/`, including
the extracted release's title/race screenshots, and in
`analysis/release-validation.json`. These large files are ignored by Git.

## macOS execution

The app was assembled on Linux from a checksum-verified Wine 11.0_1 Intel
macOS runtime. Its Wine executable is Mach-O x86_64. This environment has no
Mac, so Finder launch, graphics, audio, Rosetta and input are **unrun**.
The app is unsigned and not notarized. The upstream runtime requires macOS
10.15 or newer and GStreamer 1.28.1; Apple Silicon requires Rosetta 2.

Local archives are in `artifacts/releases/`, with `SHA256SUMS` and `builds.json`.
They are published as the GitHub prerelease
[v0.1.0-preview](https://github.com/omertekin2002/ford-racing-reverse-engineered/releases/tag/v0.1.0-preview).
