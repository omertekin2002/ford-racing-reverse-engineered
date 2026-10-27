# Ford Racing 3 reverse engineering

Reproducible static analysis of the **public Windows demo**, acquired from
[ModDB](https://www.moddb.com/games/ford-racing/downloads/ford-racing-3-demo).
The archive and `fr3.exe` match the hashes in the supplied research report.

The baseline contains 4,922 detected functions, including 152 thunks, and 4,770
successful C-like decompiler exports. Selected annotations correct register
storage for 25 routines. Resource tools reproduce 363 application tags,
146 compressed resources and 62 PCG graphics collections with 654 entries.
The new tyre analysis reconstructs its 88-byte record and table allocations.

## Play the demo

- **Linux and macOS:** download the packages from the
  [v0.1.0-preview release](https://github.com/omertekin2002/ford-racing-reverse-engineered/releases/tag/v0.1.0-preview).
  They are Wine compatibility previews that run the unchanged public demo; the
  macOS package has not been tested on a Mac. See the
  [release instructions](docs/releases.md).
- **Browser:** open the
  [browser preview](https://omertekin2002.github.io/ford-racing-reverse-engineered/),
  an experimental build that runs the same demo through Boxedwine's
  WebAssembly runtime. See the [browser guide](docs/browser.md).

Read [the verified findings and limitations](docs/analysis.md). This is an
analysis package, not restored original source or a runnable replacement game.
The installer is extracted without execution. Separate Wine compatibility
packages run the original demo; see [release instructions](docs/releases.md)
and [runtime validation](docs/release-validation.md).

A static [browser preview and GitHub Pages workflow](docs/browser.md) package
the same demo with Boxedwine's WebAssembly JIT and Wine's WebGL runtime.
Pushes to `main` build and verify the site; redeploying it is a manual run of
the workflow with **deploy** checked. Build and browser validation are described
in the browser guide.

## Reproduce

From the repository checkout:

```sh
python3 scripts/setup_tools.py
"${FR3_TOOLS:-${XDG_DATA_HOME:-$HOME/.local/share}/fr3-tools}"/venv/bin/python scripts/run_analysis.py
"${FR3_TOOLS:-${XDG_DATA_HOME:-$HOME/.local/share}/fr3-tools}"/venv/bin/python scripts/package_analysis.py
```

`setup_tools.py` installs pinned, checksum-verified Ghidra 10.3.3, Java 17,
Unshield and Python dependencies in the tool root. It requires Python 3.12+,
`dpkg-deb`, GCC and Linux amd64. It leaves repository source and system
installations unchanged. The full script was tested in a fresh temporary tools
directory as well as the retained directory.

### Tool and cache locations

Every setup and build script resolves the same locations, so the commands above
need no flags. For each location an explicit flag wins, then the environment
variable, then the default:

| Location | Flag | Environment | Default |
|---|---|---|---|
| Analysis tools | `setup_tools.py --root`, `run_analysis.py --tools-root` | `FR3_TOOLS` | `$XDG_DATA_HOME/fr3-tools`, else `~/.local/share/fr3-tools` |
| Download cache | `--cache` | `FR3_CACHE` | `$XDG_CACHE_HOME/fr3/downloads`, else `~/.cache/fr3/downloads` |
| Wine release runtimes | `setup_release_tools.py --root`, `build_releases.py --runtime-root` | — | `<tools>/runtime` |
| Browser build tools | `setup_web_tools.py --root`, `build_web.py --tools` | `FR3_WEB_TOOLS` | `<tools>/web` |

Empty environment values are ignored. Each script's `--help` shows the resolved
defaults. The original cloud workspace keeps its layout with:

```sh
export FR3_TOOLS=/workspace/toolchains/fr3 FR3_CACHE=/workspace/shared/downloads
```

Acquisition downloads the freely distributed demo and extracts its ZIP and
InstallShield CAB without running `setup.exe`. Existing extracted inputs are
preserved and compared against the recorded file manifest. An existing valid
archive is reused. Acquisition needs `www.moddb.com` and the selected mirror,
`fmt1.dl.dbolical.com`; other mirrors may use different hostnames. Tool downloads
use GitHub release assets, Debian and PyPI with normal TLS verification.

The pipeline reuses completed baseline exports for the same executable.
It exports the 25 selected annotations, packs the saved program, imports that
snapshot into a separate project without reanalysis, and runs all verification.
It checks Ghidra completion messages as well as process exit codes because
headless script errors can be reported without a failing process exit code.

## Outputs

| Path | Contents |
|---|---|
| `docs/analysis.md` | Verified report, including new tyre findings |
| `analysis/verification.json` | Actual binary/resource verification results |
| `analysis/annotated/selected.c` | 25 selected, labelled decompilations |
| `analysis/selected/` | Instruction evidence and explicitly bounded disassembly |
| `recovered/fr3_database_layouts.h` | Engine, gearbox and tyre in-memory layouts |
| `artifacts/text-databases/` | Parsed engine, gearbox and tyre records from `scripts/text_database.py`, with source hashes |
| `artifacts/ghidra/` | Complete baseline C, function disassembly, function list and call edges |
| `artifacts/fr3-demo-annotated.gzf` | Portable annotated Ghidra program |
| `artifacts/fr3-analysis.zip` | Analysis bundle with SHA-256 manifest |
| `inputs/` | Original demo archive, installer extraction and verified executable |

`inputs/` and `artifacts/` are ignored by Git. The analysis bundle includes the
portable program, derived exports and reproduction tools; it excludes the demo
ZIP, game assets and working project database. Import the `.gzf` into a new
Ghidra 10.3.3 project to browse the annotations. No experimental compiler
specification is needed for this snapshot.

The engine, gearbox and tyre text databases parse from the extracted demo alone,
with no Ghidra tools. Tyre records keep their nested `:SOUND_INFO` entries in
file order. Inheritance is recorded, not resolved, and the meaning of the sound
table's first fifteen words is unknown:

```sh
python3 scripts/acquire_demo.py inputs
python3 scripts/text_database.py inputs/extracted/Program_Executable_Files --output artifacts/text-databases
```

## Validate without rebuilding

```sh
"${FR3_TOOLS:-${XDG_DATA_HOME:-$HOME/.local/share}/fr3-tools}"/venv/bin/python -m unittest discover -s tests -v
"${FR3_TOOLS:-${XDG_DATA_HOME:-$HOME/.local/share}/fr3-tools}"/venv/bin/python scripts/verify_findings.py .
```

The synthetic tests also run without the analysis toolchain, using any Python 3.12+
with the pinned `scripts/requirements.txt` installed:

```sh
python3 -m unittest discover -s tests -v
```

CI runs them, after a `compileall` syntax check, on every push and pull request
(`.github/workflows/tests.yml`). They use synthetic fixtures and test corruption,
output limits, truncation, trailing data and overlapping PCG payloads, as well as
the PE virtual-address reader, file identity checks and tool-path resolution. They also cover
the strict engine, gearbox and tyre text-database parser: its accepted grammar and each
rejected construct. For demo acquisition they cover, without network access, the
download-link filter, HTTPS-only fetches and redirects, the 12-URL cap, identity-checked
archive writes and ZIP extraction safety (unsafe paths, symlinks, size limit, existing
files). The separate verification command checks the actual demo,
all 773 game-file hashes, tag pointers, decoded resource hashes, PCG indexes,
parsed text-database counts, instruction sites, decompiler counts and C layout
assertions. Synthetic tests alone do not validate game behavior.
