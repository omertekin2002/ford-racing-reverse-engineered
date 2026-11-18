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
  [release instructions](docs/releases.md). A
  [CI workflow](docs/releases.md#building-in-ci) rebuilds and verifies both
  packages and keeps them as a downloadable workflow artifact.
- **Browser:** open the
  [browser preview](https://omertekin2002.github.io/ford-racing-reverse-engineered/),
  an experimental build that runs the same demo through Boxedwine's
  WebAssembly runtime. See the [browser guide](docs/browser.md).
- **Research findings:** open
  [Explore findings](https://omertekin2002.github.io/ford-racing-reverse-engineered/research/),
  the engine, gearbox, tyre, PCG catalogue, routines and open questions pages built from the demo in the
  same Pages workflow and published beside the preview under `research/`. The
  [research packet](https://omertekin2002.github.io/ford-racing-reverse-engineered/downloads/fr3-research-latest.zip)
  is an offline ZIP of those pages with a `MANIFEST.json` naming their revision,
  input build and the checks they passed; it is rebuilt on every deploy.

Read [the verified findings and limitations](docs/analysis.md). This is an
analysis package, not restored original source or a runnable replacement game.
The installer is extracted without execution. Separate Wine compatibility
packages run the original demo; see [release instructions](docs/releases.md)
and [runtime validation](docs/release-validation.md).

A static [browser preview and GitHub Pages workflow](docs/browser.md) package
the same demo with Boxedwine's WebAssembly JIT and Wine's WebGL runtime.
The workflow also builds the research pages into the site's `research/`
directory and packages them as `downloads/fr3-research-latest.zip`. Pushes to
`main` build, verify and deploy the site; manual runs of the workflow deploy
only with **deploy** checked. Build and browser validation are
described in the browser guide.

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
| `artifacts/research/` | Self-contained research directory from `scripts/build_research.py`: the "Explore findings" entrance page `index.html`, the six pages below, and the `analysis/` files they link to under `evidence/`; every page carries the rights-holder notice |
| `artifacts/fr3-research-<revision>.zip` | Citable research packet from `scripts/package_research.py`: the verified research directory in one folder, with a `MANIFEST.json` naming the input build, producer revision, Python version, the checks actually run and each file's SHA-256, plus `SHA256SUMS` |
| `artifacts/dossier/tyres.html` | Offline tyre dossier from `scripts/tyre_dossier.py`: each tyre's declarations beside its five table sources and their byte-checked evidence |
| `artifacts/dossier/engines.html`, `artifacts/dossier/gearboxes.html` | Offline engine and gearbox dossiers from `scripts/record_dossier.py`: each record's declarations as written, with inheritance and untagged lines labelled unresolved |
| `artifacts/dossier/pcg.html` | Offline PCG catalogue from `scripts/pcg_catalogue.py`: every PCG collection and graphic, its header fields, byte spans and decoding status |
| `artifacts/dossier/routines.html` | Offline routine index from `scripts/routine_index.py`: each of the 25 analyst-labelled routines with its signature, Ghidra pseudocode, bounded disassembly and byte-checked sites |
| `artifacts/dossier/questions.html` | Offline "Open questions" page from `scripts/open_questions.py`: for `INDIGO`'s colon-less line, the tyre sound table's first fifteen words and the PCG extra bytes, what was observed, what depends on it, the untested alternatives and what evidence would decide it |
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
file order. `tyres.json` also lists, under `resolved_tables`, which record's
longitudinal, lateral, vertical-load, camber-thrust and sound tables each tyre
reads through `:INHERIT_TYPE`, following the game's accessors at
`0x00523e50`–`0x00523f10`. Under `table_provenance` it gives, for each of those
tables, the inheritance path, the `TYREDATA.DAT` line the table comes from and
the accessor and record offset the game reads it through; those accessor
reads and their `+0x14` fallbacks are byte-checked in
[`field-evidence.json`](analysis/selected/field-evidence.json). Under
`scalar_inheritance` it lists, for each inheriting tyre, the scalar tags
declared before and after its `INHERIT_TYPE` line, labelled `unresolved`.
Engine and scalar-field inheritance are recorded, not resolved, and the meaning
of the sound table's first fifteen words is unknown:

```sh
python3 scripts/acquire_demo.py inputs
python3 scripts/text_database.py inputs/extracted/Program_Executable_Files --output artifacts/text-databases
```

`scripts/build_research.py` builds every research page in one step, after
`acquire_demo.py`. It parses the text databases into a temporary directory,
writes the tyre, engine, gearbox, PCG, routines and open questions pages described below plus an "Explore
findings" entrance page, `index.html`, into `artifacts/research/`, and copies the
committed `analysis/` files the pages link to into `artifacts/research/evidence/`,
so the directory is self-contained. Every page carries the browser preview's
rights-holder notice before its content and a link bar to the other pages. The
script then checks the directory and exits non-zero if a page is missing, lacks
the notice, has a `<script>` or an external resource, or has a local link that
does not resolve inside it (see
[the analysis notes](docs/analysis.md#research-directory)):

```sh
python3 scripts/acquire_demo.py inputs
python3 scripts/build_research.py
```

`scripts/package_research.py` then packages that directory as a deterministic,
citable ZIP, `artifacts/fr3-research-<short revision>.zip`, with a
`MANIFEST.json` and a `SHA256SUMS` file. It re-checks the directory first and
records only the checks it ran (see
[the analysis notes](docs/analysis.md#research-packet)):

```sh
python3 scripts/package_research.py
```

The per-page commands below still work on their own and write to
`artifacts/dossier/`, without the entrance page or a nav link to it.

`scripts/tyre_dossier.py` turns `tyres.json`, `field-evidence.json` and
`pe-metadata.json` into one static page, `artifacts/dossier/tyres.html`, with no
JavaScript or external resources. It needs only the standard library and
refuses to write the page when the inputs disagree; see
[the analysis notes](docs/analysis.md#tyre-dossier). The page holds game data,
so it stays under the ignored `artifacts/`:

```sh
python3 scripts/tyre_dossier.py
```

`scripts/record_dossier.py` does the same for `engines.json` and
`gearboxes.json`, writing `engines.html` and `gearboxes.html` next to the tyre
page. They show each record's declarations as written; engine inheritance, the
colon-less `INDIGO` line and the units of the values stay unresolved (see
[the analysis notes](docs/analysis.md#engine-and-gearbox-dossier)):

```sh
python3 scripts/record_dossier.py
```

`scripts/pcg_catalogue.py` builds `artifacts/dossier/pcg.html` from the
committed `analysis/` files alone, so it needs no demo. It lists every PCG
collection and graphic with its header fields, byte spans and decoding status;
no pixel data is decoded, and header words other than width, height and
declared payload stay unlabelled (see
[the analysis notes](docs/analysis.md#pcg-catalogue)):

```sh
python3 scripts/pcg_catalogue.py
```

`scripts/routine_index.py` builds `artifacts/dossier/routines.html` from the
committed `analysis/annotated/` and `analysis/selected/` files alone, so it also
needs no demo. It gives each of the 25 annotated routines a section with its
analyst label, signature, register storage, pseudocode, the disassembly files
whose span holds its entry and the byte-checked sites in them; every label is
analyst-assigned, not an original symbol (see
[the analysis notes](docs/analysis.md#routine-index)):

```sh
python3 scripts/routine_index.py
```

`scripts/open_questions.py`, run after `text_database.py`, builds
`artifacts/dossier/questions.html`, the "Open questions" page. It gives three
findings the other pages label unresolved their own section: the colon-less
`INHERIT_TYPE DEFAULT_TRACK` line in `INDIGO` (`#indigo`), the tyre sound
table's leading words (`#sound-words`) and the extra bytes after `_loadbar` and
`_loadbr2` (`#pcg-extra-bytes`). Each section shows what was observed, read
from the parsed databases and committed `analysis/` files at build time, where
the other pages depend on it, the alternatives the observations leave open
(each labelled untested) and what evidence would decide it. It resolves
nothing, and it exits non-zero when its inputs no longer show the question
(see [the analysis notes](docs/analysis.md#open-questions)):

```sh
python3 scripts/open_questions.py
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
rejected construct, and tyre table inheritance resolution. They check the tyre dossier's anchors and links, its
address-matched evidence trails, its escaping and each input disagreement it refuses, and the engine and gearbox
dossiers' anchors, unresolved labels, escaping and the malformed inputs they refuse. The PCG catalogue tests run the script on the committed `analysis/` files and check every input disagreement it refuses. The routine index tests check its sections, escaping and site placement on synthetic routines, run it on the committed files, and check each refusal: `selected.c` and `status.json` disagreeing, a malformed `.asm` span header, and a site that would be dropped or shown twice. The open questions tests check the page's three anchored sections and their four parts, that observed values follow synthetic inputs, that every reading is labelled untested, escaping, the engine, tyre and PCG pages' links to each question, and each refusal: `INDIGO` missing or without exactly one `INHERIT_TYPE DEFAULT_TRACK` line, the sound table's allocation or `+0x54` store missing from `field-evidence.json`, the tyre loader's table stores changed, and extra bytes on any graphics but `_loadbar` and `_loadbr2` at 1,024 bytes each. The research-directory tests build it from fixture game files, check its pages, notice, links and copied evidence, and check that the verifier rejects a missing page or notice, a broken local link, an external resource, a `<script>` and a file the build does not write. The research-packet tests package a fixture research directory, check its folder, `MANIFEST.json` and `SHA256SUMS` (with `sha256sum -c` where installed) and that two runs give byte-identical ZIPs, and check that a missing directory, a page without the notice, an extra file, changed evidence, evidence copied from an uncommitted `analysis/` edit and a directory or symlink destination are refused with nothing written. The site-verifier packet tests lay a fixture packet beside a published `research/` and check that a missing linked packet, one absent from the site's `SHA256SUMS`, one built at another revision, one whose page differs from `research/`, and one with an extra or missing file are each refused with a specific message, and that a site with neither a packet nor a link to one still passes. For demo acquisition they cover, without network access, the
download-link filter, HTTPS-only fetches and redirects, the 12-URL cap, identity-checked
archive writes and ZIP extraction safety (unsafe paths, symlinks, size limit, existing
files). The separate verification command checks the actual demo,
all 773 game-file hashes, tag pointers, decoded resource hashes, PCG indexes,
parsed text-database counts, instruction sites, decompiler counts and C layout
assertions. Synthetic tests alone do not validate game behavior.

The browser launcher (`web/site.js`) and runtime bridge (`web/runtime-bridge.js`)
have their own tests. They load the real files into Node's `vm` with stand-in
browser and Boxedwine globals, need Node 22+ and no `npm install` or network, and
also run in CI:

```sh
node --test "tests/js/*.test.mjs"
```

Lint the scripts and tests with the hash-pinned ruff and the repository's `ruff.toml`;
CI also runs this lint step on every push and pull request:

```sh
python3 -m pip install --require-hashes -r scripts/requirements-lint.txt
ruff check scripts tests
```
