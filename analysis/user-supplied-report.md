# Ford Racing 3 — binary reverse engineering report

Analysis date: 9 October 2026. Target: the public Windows demo, specifically the verified `fr3.exe` below.

The demo was acquired and its main executable was disassembled and decompiled. The analysis recovered a 363-entry configuration tag registry, engine and gearbox record layouts, the outer resource compression format, and the directory structure of PCG graphics collections. The accompanying package includes the original demo archive, a portable annotated Ghidra program, complete machine-generated exports, and reproducible extraction scripts.

This is a static reverse engineering deliverable. It is not a complete restoration of the original source or a runnable replacement engine. The game and installer were not executed. Addresses, layouts, and counts apply to this demo binary; retail and console builds have not been compared.

## Copy and executable identity

The copy came from the [ModDB Ford Racing 3 Demo page](https://www.moddb.com/games/ford-racing/downloads/ford-racing-3-demo). Its published archive size and MD5 matched the downloaded bytes. A matching mirror hash confirms consistency with that mirror, rather than independent publisher authentication. The page reproduces the demo's publisher readme.

| Item | Verified value |
|---|---|
| Archive | `fordracing3demo.zip` |
| Archive size | 37,080,961 bytes |
| Archive MD5 | `4736b176575e2ccd238fdff9f966ea6e` |
| Archive SHA-256 | `4bf96967022195519817d91f143c5e1c62e5879a95dd70f5a1cd00ba89b1f84c` |
| Main executable | `fr3.exe`, 1,782,784 bytes |
| Executable SHA-256 | `87cc71d881a2723784097108ce2923fe8d0384ea6a8b03fad3e95c5cda52e8b3` |
| Format | PE32, Intel x86, Windows GUI subsystem |
| Preferred image base | `0x00400000` |
| Entry point | RVA `0x00134ac2`, preferred VA `0x00534ac2` |
| COFF timestamp | `2004-12-21T16:15:02Z` |

The timestamp is header metadata, not an independently verified build date. All addresses below are preferred virtual addresses, not raw file offsets.

The ZIP contains InstallShield installation files. Unshield extracted 813 files without running `setup.exe`. The game-file component contains 773 files totaling 36,701,680 bytes. Their individual SHA-256 hashes are recorded in `analysis/game-file-manifest.json`. The package preserves the original archive and a convenient separate `inputs/fr3.exe`; the other game files can be reproduced from the archive.

## Binary organization and compiler evidence

The executable contains sections named `AUTO`, `.idata`, `DGROUP`, `.bss`, `.reloc`, and `.rsrc`. It has no PE debug directory or embedded PDB path. Source-path strings nevertheless preserve module hints under `modules5` and `fr3_demo/source`, including database, physics, AI, user interface, and game-loop code. These strings support module identification; they do not recover all original function names.

There are 189 static import entries across 11 DLLs. Imports cover Windows UI and file services, sound, timing, and Winsock. Graphics initialization at `0x00409b80` also loads `ddraw.dll`, `dinput8.dll`, `d3d9.dll`, and `dsound.dll` dynamically. It resolves `DirectDrawCreateEx`, `DirectDrawEnumerateExA`, `DirectInput8Create`, `Direct3DCreate9`, and `DirectSoundCreate8`. Its observed return convention is an integer success/failure result. The routine checks library loads; this finding does not establish that every resolved function pointer is checked.

Many internal calls pass integer/pointer arguments in EAX, EDX, EBX, and ECX. This resembles the register convention documented by [Open Watcom's C/C++ guide](https://open-watcom.github.io/open-watcom-v2-wikidocs/cguide.html). The pattern, section naming, and runtime code suggest a Watcom-style build, but do not prove a particular compiler or version. The guide describes floating arguments and special conventions separately; the supplied experimental Ghidra specification is not a complete implementation of those cases.

Ghidra's ordinary Windows convention frequently produces missing parameters, `extraout_` variables, and misleading combined EDX:EAX return values for these routines. Selected signatures were therefore corrected with explicit register storage. Floating readers were marked as returning `float` through ST0, and debug variadic wrappers received a separate stack-argument model. Other routines still need individual ABI and type correction.

## Code recovered

| Export | Detected internal functions | C-like exports | Failures |
|---|---:|---:|---:|
| Initial Windows-model analysis | 4,922, including 152 thunks | 4,770 non-thunks | 0 |
| Experimental register-model analysis | 4,914, including 152 thunks | 4,761 non-thunks | 1 |
| Selected annotated functions | 25 | 25 | 0 |

These are tool-detected functions and successful decompiler outputs, including runtime/library routines. Successful export does not establish semantic correctness or complete function discovery. The experimental analysis fails at `0x005373b0` with a low-level merge error; its status file preserves the failure. Different compiler models also change detected boundaries.

The initial full disassembly, function list, call edges, string cross-references, C-like text, and export status are in `analysis/ghidra/`. The alternative analysis is in `analysis/register-abi/`. Corrected selected output and the portable program are in `analysis/annotated/`.

The following names are analyst-assigned labels, not recovered original symbols:

| Preferred VA | Label | Basis and limit |
|---|---|---|
| `0x00409b80` | `fr3_load_directx_libraries` | DLL loads and API resolution directly observed |
| `0x0040ba30` | `fr3_load_compressed_resource` | Output-size prefix and inflate path observed |
| `0x00423b20` | `fr3_build_pcg_view` | Directory pointers and 128-byte alignment observed |
| `0x0042d0a0` | `fr3_ascii_next_tag` | ASCII tag-scanning behavior |
| `0x0042e530` | `fr3_next_tag` | Tagged reader dispatch |
| `0x0042e680` | `fr3_read_float` | Reader dispatch and ST0 result |
| `0x0049b310` | `fr3_main_loop` | Loop structure, frame call, and source context |
| `0x0049b510` | `fr3_update_frame` | Called from the main loop; behavior only partly interpreted |
| `0x004e1a40` | `fr3_car_update_dispatch` | Inferred from source context and call structure |
| `0x004e8370` | `fr3_ai_update_dispatch` | Inferred from source context and call structure |
| `0x004f9cd0` | `fr3_internal_save_load` | Save/load context; full format remains unresolved |
| `0x005227f0` | `fr3_load_engine_database` | Tag comparisons and record field writes |
| `0x00522c80` | `fr3_copy_engine_record` | Field-wise copy, including 18 torque samples |
| `0x00523220` | `fr3_load_gearbox_database` | Tag comparisons and record field writes |
| `0x00523470` | `fr3_copy_gearbox_record` | Field-wise copy |
| `0x00523820` | `fr3_load_tyre_database` | Database context; tyre layout not fully reconstructed |

All 25 labels are listed in `analysis/analyst_labels.tsv`. Complex annotated decompilations still contain unresolved variables and types. The original instruction bytes in the disassembly remain the stronger evidence when C output disagrees with them.

## Configuration registry and vehicle records

The application tag table starts at `0x00594d94`. It contains 363 little-endian 32-bit pointers to ASCII tag names, indexed from 0 through 362. The parser setup supplies count `0x16b`. The first entry is `FIRST_APPLICATION_TAG`; the last is `WIDTH`. `scripts/extract_tag_registry.py` checks the executable hash before extracting this build-specific table.

| Tag | Decimal ID | Hex ID |
|---|---:|---|
| `ASPIRATION_TYPE` | 16 | `0x10` |
| `CAPACITY` | 55 | `0x37` |
| `CLUTCH_MAX_POWER` | 94 | `0x5e` |
| `CLUTCH_SPEED` | 95 | `0x5f` |
| `DRIVE_SPLIT` | 118 | `0x76` |
| `DRIVE_TYPE` | 119 | `0x77` |
| `ENGINE_BRAKING` | 127 | `0x7f` |
| `FLYWHEEL_MASS` | 135 | `0x87` |
| `MAX_RPM` | 176 | `0xb0` |
| `NUMBER_OF_CYLINDERS` | 198 | `0xc6` |
| `ROUGHNESS` | 228 | `0xe4` |
| `TORQUE_ARRAY` | 280 | `0x118` |
| `TORQUE_MODIFIER` | 281 | `0x119` |
| `TRANSMISSION_TYPE` | 345 | `0x159` |

Text database examples are `DATA/ASCII/CARS/ENGDATA.DAT` and `GEARDATA.DAT`. They contain `:TYPE` record declarations, colon-prefixed keys, `//` comments, and multiline numeric torque arrays. The registry also covers unrelated application data. A complete general-purpose tagged-file grammar was not implemented.

The engine loader allocates a `0xb0`-byte payload after a separate `0x20`-byte database node header. Offsets below are relative to the payload. Float fields are 32-bit; stored addresses are 32-bit even when inspected on a 64-bit host.

| Engine offset | Reconstructed field | Storage |
|---|---|---|
| `0x00` | Name area | 20 bytes |
| `0x14` | Location type | Byte, then 3 padding bytes |
| `0x18` | Inherited record address | 32-bit address |
| `0x1c` | Fuel cutoff | Float |
| `0x20` | Engine braking | Float |
| `0x24` | Torque modifier | Float |
| `0x28` | Roughness | Float |
| `0x2c` | Derived RPM value | Float; purpose inferred |
| `0x30` | Maximum RPM | Float |
| `0x34` | Capacity | Float |
| `0x38` | Tickover RPM | Float |
| `0x3c` | Torque array | 18 floats, ending before `0x84` |
| `0x84` | Maximum turbo pressure | Float |
| `0x88` | Flywheel mass | Float |
| `0x8c` | Flywheel radius | Float |
| `0x90` | Accelerator speed | Float |
| `0x94`, `0x95` | Number of turbos, cylinders | One byte each; 2 padding bytes follow |
| `0x98` | Aspiration type | 32-bit enum |
| `0x9c` | Maximum airflow | Float |
| `0xa0` | Turbo mass | Float |
| `0xa4` | Inverse turbo mass | Float; zero mass yields 1.0, otherwise reciprocal |
| `0xa8` | Maximum change in fuel flow | Float |
| `0xac` | Maximum fuel flow | Float |

The gearbox payload is `0x34` bytes:

| Gearbox offset | Reconstructed field | Storage |
|---|---|---|
| `0x00` | Name area | 20 bytes |
| `0x14` | Clutch speed | Float |
| `0x18` | Clutch maximum power | Float |
| `0x1c` | Torque shift | Float |
| `0x20` | Drive split | Float |
| `0x24` | Transmission type | 32-bit enum |
| `0x28` | Differential type | 32-bit enum |
| `0x2c` | Drive type | 32-bit enum |
| `0x30` | Anti-wheelspin flag | Byte |
| `0x31` | Anti-wheelskid flag | Byte; 2 padding bytes follow |

`recovered/fr3_database_layouts.h` expresses both layouts and includes compile-time size and offset assertions. It describes in-memory records, not necessarily a serialized save-file layout.

### An interpreted engine-loader calculation

At `0x0052291c`, the `TORQUE_ARRAY` branch clears 18 slots, computes a sample count from maximum RPM, and reads that many pairs of numbers. It discards the first number of each pair and stores the second sequentially. A later scan chooses the RPM producing the greatest torque-times-RPM score and constrains values close to maximum RPM.

Conceptual pseudocode, preserving the stored constants and ordering:

```c
clear(torque_values, 18 * sizeof(float));
count = truncate((max_rpm + 250.0) * K_RPM) + 1;
for (i = 0; i < count; i++) {
    discarded_input_rpm = read_float();
    torque_values[i] = read_float();
}
best_score = 0.0f;
for (rpm = 0.0f; rpm < max_rpm; rpm += 500.0f) {
    i = truncate((rpm + 5.0) * K_RPM);
    score = (float)(rpm * torque_values[i] * K_SCORE);
    if (score > best_score) {
        best_score = score;
        derived_rpm = rpm;
    }
}
if (abs(derived_rpm - max_rpm) < 1500.0)
    derived_rpm = max_rpm - 1500.0;
```

`K_RPM` is the float at `0x00581d10`, approximately `0.0010000000474974513`; `K_SCORE` at `0x00581d14` is approximately `0.00019040366169065237`. Helper `0x005352fa` temporarily selects x87 truncation toward zero. This pseudocode omits parser error handling and is not a bit-exact implementation of x87 intermediate precision. The score's physical units and the derived field's subsequent gameplay use remain unverified. The observed loader is not presented as a safe parser for arbitrary modified inputs.

## Resource formats

### Outer compressed wrapper

For the identified resources, bytes 0–3 contain a little-endian 32-bit decoded length. Byte 4 begins a complete zlib stream. The resource-loading code and actual decoding agree on this layout.

`scripts/unpack_resources.py` removes this wrapper. It bounds output size, checks the zlib header, verifies the exact decoded length and end of stream, and rejects trailing bytes. It preserves the input files. Applied to all extracted game files, it decoded 146 resources totaling 56,325,649 bytes. The decoded SHA-256 hashes are recorded in `analysis/unpacked/unpacked_manifest.json`.

| Example input | Input bytes | Decoded bytes |
|---|---:|---:|
| `3DDATA/CARS/FORDGT/3dobjs.XBX` | 11,477 | 45,108 |
| `3DDATA/CARS/FORDGT/textures.DXT` | 187,069 | 567,747 |
| `GRAPHICS/GAME/COMMON/graphics.pcg` | 53,183 | 648,320 |

Removing the wrapper does not convert inner XBX models or DXT texture collections to standard interchange formats.

### PCG graphics collections

After decompression, a PCG starts with a 16-byte header and a directory of 16-byte entries. The directory's payload base is aligned to 128 bytes. The alignment is directly visible in `fr3_build_pcg_view` at `0x00423b20` and was checked against every supplied collection.

| Location | Field |
|---|---|
| Header `+0x00` | 32-bit entry count |
| Header `+0x04` | Word interpreted as creation year |
| Header `+0x08` | Four raw creation-metadata bytes; exact encoding unresolved |
| Header `+0x0c` | Raw reserved/unknown word |
| Directory entry `+0x00` | 32-bit offset relative to the aligned payload base |
| Directory entry `+0x04` | 12-byte name area |
| Graphic header `+0x08`, `+0x0c` | Width and height |
| Graphic header `+0x28` | Declared payload byte count |
| Graphic header `+0x80` | Start of stored graphic payload |

The file-relative payload base is `(16 + count * 16 + 127) & ~127`. Each graphic has a 128-byte header. Other header fields are preserved as raw words rather than assigned unsupported meanings.

`scripts/index_pcg.py` verified 62 collections containing 654 entries. For 652 entries, the declared payload fills the span before the next entry or file end. Two entries, `_loadbar` and `_loadbr2` in `GRAPHICS/LOADING/graphics.pcg`, each have 1,024 additional bytes. Their purpose is unresolved; a palette is a possible explanation, not a confirmed one. The script records this explicitly in `analysis/pcg-index.json`. Pixel encodings and texture rendering were not fully recovered.

## Reproduction and package contents

Tooling used: Ghidra 10.3.3, Java 17, Unshield 1.5.1, Python 3, pefile 2024.8.26, and Capstone 5.0.9. Ghidra and Java are not bundled. Use the [official Ghidra release](https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_10.3.3_build) and [Unshield project](https://github.com/twogood/unshield). The downloaded Ghidra archive's verified SHA-256 was `63833361bea8ef5ada1bc28cd2aa2ae4ab43204d2672b595500372582152eebe`.

From the extracted analysis-package root:

```sh
python3 -m pip install -r scripts/requirements.txt
python3 scripts/acquire_demo.py inputs
unshield -d inputs/extracted x inputs/installer/is/data1.cab
python3 scripts/inspect_pe.py inputs/fr3.exe analysis/pe-reproduced
python3 scripts/extract_tag_registry.py inputs/fr3.exe analysis/tags-reproduced.json
python3 scripts/unpack_resources.py inputs/extracted/Program_Executable_Files analysis/unpacked-reproduced
python3 scripts/index_pcg.py analysis/unpacked-reproduced analysis/pcg-reproduced.json
python3 scripts/verify_findings.py . inputs/extracted/Program_Executable_Files
gcc -std=c11 -Wall -Wextra -Werror -x c -fsyntax-only recovered/fr3_database_layouts.h
```

The included acquisition script reuses and verifies the preserved archive; it only contacts ModDB when that archive is absent. InstallShield extraction may also produce additional installer support components outside the game-file directory.

To open the annotated program, first run `python3 scripts/install_register_abi.py /absolute/path/to/ghidra_10.3.3_PUBLIC` on a disposable Ghidra 10.3.3 installation. This adds an experimental compiler specification while retaining standard Windows conventions. Restart Ghidra if it was already running, then import `analysis/annotated/fr3-demo-annotated.gzf` into a new project. This import was verified without reanalysis; the labels, custom EAX argument storage, compiler specification, and float return type survived export and import. Later Ghidra versions have not been tested.

For a fresh baseline analysis, set `GHIDRA_DIR` to that Ghidra installation, ensure Java 17 is selected, create a `project` directory, and run:

```sh
"$GHIDRA_DIR/support/analyzeHeadless" "$PWD/project" FordRacing3Baseline \
  -import "$PWD/inputs/fr3.exe" -processor x86:LE:32:default -cspec windows \
  -scriptPath "$PWD/scripts" -postScript ExportFord.java "$PWD/analysis/fresh-baseline"
```

The alternative register analysis uses `-cspec fr3register -preScript PrepareFord.java` before the same export. `AnnotateFord.java` takes the absolute paths to `analysis/analyst_labels.tsv` and a selected-output directory. `ExportAnnotatedProject.java` takes an absolute GZF output path. The preserved exports avoid requiring these expensive steps just to read the findings.

The package excludes redundant installer extraction directories, decoded resource bytes, and raw working projects. They can be recreated from the preserved archive and scripts. It includes all analysis manifests, the portable annotated program, the original executable, both full code-export sets, recovered layouts, reproduction scripts, relevant logs, and a `MANIFEST.sha256` for its contents.

## Verification and unresolved work

The final checks verified every game-file hash, re-extracted all 363 tags, re-decoded every identified resource and matched its decoded hash, reproduced all 62 PCG indexes, and rejected malformed length and trailing-data wrapper fixtures. Both reconstructed vehicle record sizes and selected field offsets passed C11 compile-time assertions. Python scripts compiled successfully. The annotated Ghidra program imported into a separate project and retained the checked annotations and signatures. Results are in `analysis/verification.json` and `logs/headless-verify-snapshot.log`.

Remaining work includes individual function-boundary and ABI review, complete physics and collision interpretation, AI behavior, save-file schema, mesh and pixel-format conversion, and dynamic validation on Windows. A complete source reconstruction or faithful replacement game would require substantial further analysis. The supplied disassembly, project, formats, and working decoders provide a reproducible basis for that work.
