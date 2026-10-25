# Ford Racing 3 reverse engineering

Reproducible static analysis of the **public Windows demo**, acquired from
[ModDB](https://www.moddb.com/games/ford-racing/downloads/ford-racing-3-demo).
The archive and `fr3.exe` match the hashes in the supplied research report.

The baseline contains 4,922 detected functions, including 152 thunks, and 4,770
successful C-like decompiler exports. Selected annotations correct register
storage for 25 routines. Resource tools reproduce 363 application tags,
146 compressed resources and 62 PCG graphics collections with 654 entries.
The new tyre analysis reconstructs its 88-byte record and table allocations.

Read [the verified findings and limitations](docs/analysis.md). This is an
analysis package, not restored original source or a runnable replacement game.
The installer is extracted without execution. Separate Wine compatibility
packages now run the original demo; see [release instructions](docs/releases.md)
and [runtime validation](docs/release-validation.md).

A static [browser preview and GitHub Pages workflow](docs/browser.md) now
package the same demo with Boxedwine's WebAssembly JIT and Wine's WebGL runtime.
The workflow builds on push; publication is a separate manual run after Pages
is enabled. Build and browser validation are described in the browser guide.

## Reproduce in the cloud workspace

```sh
cd /workspace/ford-racing-reverse-engineered
python3 scripts/setup_tools.py
/workspace/toolchains/fr3/venv/bin/python scripts/run_analysis.py
/workspace/toolchains/fr3/venv/bin/python scripts/package_analysis.py
```

`setup_tools.py` installs pinned, checksum-verified Ghidra 10.3.3, Java 17,
Unshield and Python dependencies under `/workspace/toolchains/fr3`. It requires
the cloud machine's Python 3.12+, `dpkg-deb`, GCC and Linux amd64. It leaves
repository source and system installations unchanged. The full script was
tested in a fresh temporary tools directory as well as the retained directory.

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
| `artifacts/ghidra/` | Complete baseline C, function disassembly, function list and call edges |
| `artifacts/fr3-demo-annotated.gzf` | Portable annotated Ghidra program |
| `artifacts/fr3-analysis.zip` | Analysis bundle with SHA-256 manifest |
| `inputs/` | Original demo archive, installer extraction and verified executable |

`inputs/` and `artifacts/` are ignored by Git. The analysis bundle includes the
portable program, derived exports and reproduction tools; it excludes the demo
ZIP, game assets and working project database. Import the `.gzf` into a new
Ghidra 10.3.3 project to browse the annotations. No experimental compiler
specification is needed for this snapshot.

## Validate without rebuilding

```sh
/workspace/toolchains/fr3/venv/bin/python -m unittest discover -s tests -v
/workspace/toolchains/fr3/venv/bin/python scripts/verify_findings.py .
```

The synthetic tests also run without the cloud toolchain, using any Python 3.12+
with the pinned `scripts/requirements.txt` installed:

```sh
python3 -m unittest discover -s tests -v
```

CI runs them, after a `compileall` syntax check, on every push and pull request
(`.github/workflows/tests.yml`). They use synthetic fixtures and test corruption,
output limits, truncation, trailing data and overlapping PCG payloads, as well as
the PE virtual-address reader and file identity checks. The separate verification
command checks the actual demo, all 773 game-file hashes, tag pointers, decoded
resource hashes, PCG indexes, instruction sites, decompiler counts and C layout
assertions. Synthetic tests alone do not validate game behavior.

Each cloud task already has an isolated environment. Use this checkout;
creating another Git worktree is unnecessary unless explicitly requested.

