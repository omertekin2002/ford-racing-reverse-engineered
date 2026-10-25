# Ford Racing 3: verified Windows demo analysis

Analysis performed on 10 October 2026. The attached earlier report was used as
a set of hypotheses and build identifiers. Its accompanying scripts and project
were not supplied; the tooling and exports here were produced in this workspace.
[The supplied report](../analysis/user-supplied-report.md) remains reference
material, and its claims of packaged files do not describe this repository.

## Acquisition and identity

The public demo was downloaded over HTTPS from the
[ModDB demo page](https://www.moddb.com/games/ford-racing/downloads/ford-racing-3-demo)
through its `fmt1.dl.dbolical.com` mirror. The page reproduces the publisher's
demo readme. The published archive size and MD5 match the downloaded bytes;
both SHA-256 values also match the supplied report. These matches establish
build consistency, not independent publisher signature authentication.

| Item | Actual verified value |
|---|---|
| Demo archive | `fordracing3demo.zip`, 37,080,961 bytes |
| Archive MD5 | `4736b176575e2ccd238fdff9f966ea6e` |
| Archive SHA-256 | `4bf96967022195519817d91f143c5e1c62e5879a95dd70f5a1cd00ba89b1f84c` |
| Executable | `fr3.exe`, 1,782,784 bytes |
| Executable SHA-256 | `87cc71d881a2723784097108ce2923fe8d0384ea6a8b03fad3e95c5cda52e8b3` |
| Format | PE32, x86, Windows GUI |
| Preferred image base / entry point | `0x00400000` / `0x00534ac2` |
| COFF timestamp | `2004-12-21T16:15:02Z`; header metadata |

Unshield extracted 813 installer-component files without executing game code.
The game-file component contains 773 files totaling 36,701,680 bytes.
[Its manifest](../analysis/game-file-manifest.json) records every SHA-256.
Retail and console builds are outside this analysis.

## Code exports and ABI corrections

Ghidra 10.3.3's Windows baseline independently reproduced the earlier report's
4,922 detected functions, 152 thunks and 4,770 successful non-thunk exports,
with no decompiler failures. Complete C-like text, function-based assembly,
function metadata and direct call references are in `artifacts/ghidra/`.
These counts include runtime and library code and do not imply complete
function discovery or correct semantics.

Many internal routines take inputs through EAX, EDX, EBX and ECX. This and the
`AUTO`/`DGROUP` section names are consistent with a Watcom-style build; a
particular compiler/version is not proved. The ordinary Windows model produces
missing arguments, `extraout_` values and spurious EDX:EAX combined returns.

[The selected annotated exports](../analysis/annotated/selected.c) label 25
routines and explicitly correct parameter storage where checked. Integer readers
return through EAX; floating readers use ST0. Internal copy helpers receive
EAX destination and EDX source. `__cdecl` serves as Ghidra's base prototype for
these custom-storage signatures; it is not a claim that those parameters use
the ordinary C stack ABI. Uncorrected callees can still degrade selected output.
Original instruction bytes take precedence over decompiler expressions.

The baseline missed the tyre cleanup callback at `0x00523dc0`. Its pointer is
passed by the tyre loader at `0x0052382f`; its code checks and frees the five
table pointers. The annotated program explicitly creates this function, so it
has one more identified function than the preserved baseline. The exported
GZF was imported into a separate project without reanalysis, confirming that
its labels, EAX/EDX storage and float/ST0 return survived.

There are 189 static imports across 11 DLLs. Selected DirectX initialization
at `0x00409b80` loads graphics/input/sound DLLs dynamically. Embedded module
source paths provide context, but recovered names in this project are analyst
labels rather than original symbols. Addresses throughout are preferred virtual
addresses, not file offsets.

## Tags, records and resource formats

The actual table at `0x00594d94` contains 363 pointers to application tag names,
starting with `FIRST_APPLICATION_TAG` and ending with `WIDTH`.
[All tags and numeric IDs](../analysis/tags.json) were re-extracted from the
hash-pinned executable. The text databases use colon-prefixed tags and `:TYPE`
records; this project does not implement their full general grammar.

The engine loader at `0x005227f0` allocates a `0xb0`-byte payload, and the gearbox
loader at `0x00523220` allocates `0x34` bytes. Their stores and copy routines
support the layouts transcribed from the earlier report. The engine record
includes 18 torque slots at `+0x3c`; its derived RPM calculation and floating
intermediate precision still need gameplay-level interpretation.

[The recovered C header](../recovered/fr3_database_layouts.h) expresses engine,
gearbox and tyre layouts with fixed-width address fields and compile-time size
and offset assertions. These are in-memory structures, not proven save-file
schemas or native pointers on this 64-bit analysis machine.

The compressed resources have a little-endian decoded-length word followed by
a complete zlib stream. Strict decoding independently reproduced 146 resources,
totaling 56,325,649 decoded bytes. The decoder bounds output and checks stream
termination, the exact length, integrity and trailing bytes. The
[decoded manifest](../analysis/unpacked-manifest.json) preserves the hashes.

PCG collections have a 16-byte header and 16-byte directory entries. The payload
base is `(16 + count*16 + 127) & ~127`, consistent with the instructions at
`0x00423b20`. Each graphic has a 128-byte header; width/height occur at `+8`/`+12`
and its declared payload size at `+0x28`. Actual indexing reproduced 62 collections
and 654 entries. `_loadbar` and `_loadbr2` in the loading collection each have
1,024 bytes beyond the declared payload; their meaning remains unresolved.
Inner mesh, texture and pixel encodings are not converted to standard formats.

## New finding: tyre payload and tables

The loader at `0x00523820` supplies size `0x58` when creating the tyre database.
Its branches compare actual registry IDs and write the following payload fields.
The record lies after a separate `0x20`-byte database node header.

| Payload offset | Field | Evidence |
|---|---|---|
| `0x00` | Name, 20 bytes | `:TYPE` string-read destination and limit |
| `0x14` | Inherited record address | `INHERIT_TYPE`; store at `0x00523b42` |
| `0x18`, `0x1c` | Road/offroad grip values | Stores at `0x0052393f`, `0x00523cb0`, then multiplied by global `0x00597484` |
| `0x20` | Wet grip percentage | Store at `0x00523a1b` |
| `0x24` | Grip depth | Store at `0x0052395a` |
| `0x28`, `0x3c` | Radius and reciprocal radius | Stores at `0x00523900`, `0x00523907` |
| `0x2c`, `0x30` | Patch length and width | Stores at `0x0052397f`, `0x00523a35` |
| `0x34`, `0x38` | Mass and reciprocal mass | Stores at `0x00523c83`, `0x00523c8a` |
| `0x40` | Rolling resistance | Store at `0x00523a4a` |
| `0x44` | Longitudinal combined table address | `0x18c` bytes: 9 rows × 11 floats |
| `0x48` | Lateral combined table address | `0x348` bytes: 10 rows × 21 floats |
| `0x4c` | Vertical load table address | `0x28` bytes: 10 indexed floats |
| `0x50` | Camber thrust table address | `0x28` bytes: 10 indexed floats |
| `0x54` | Sound information address | `0x2d0` bytes; 15 sound types |

The first longitudinal and lateral blocks in `TYREDATA.DAT` have exactly the
dimensions implied by the loops and allocations. Vertical load and camber
branches read ten index/value pairs. The sound table has values starting at
`+0x78`, with 15 rows of ten floats, and `START_RPM` values at `+0x3c`.
The meaning of its first fifteen words remains unknown.

Accessors at `0x00523e50`, `0x00523e70`, `0x00523e90` and `0x00523eb0` retrieve
the corresponding local table or follow the inherited address at `+0x14`.
The scalar-copy helper at `0x00524090` copies selected physical values rather
than deep-copying tables. The grip scaling global's runtime value and physical
units remain unverified; the table dimensions do not prove the force equations.

[Twenty byte-checked instruction sites](../analysis/selected/field-evidence.json)
and [the loader's disassembly](../analysis/selected/load_tyre_database.asm)
preserve the concrete evidence for these new findings.

## Validation and limits

[Verification results](../analysis/verification.json) cover the exact executable,
all game files, all tags, all identified compressed resources, every PCG index,
the selected instruction sites, table dimensions, export counts and C layout
assertions. Nine parser tests additionally reject malformed synthetic resources,
and eight helper tests cover virtual-address bounds and file identity checks.
The pinned installer was tested from a fresh temporary tool directory; its
Ghidra probe decompiled the expected arithmetic expression.
The default acquisition script also downloaded and extracted the demo into a
fresh temporary directory, independently checking both pinned game hashes.

The static analysis does not execute the installer or game. Separate
[Wine release validation](release-validation.md) records subsequent runtime
checks of the original demo. Those checks do not establish the accuracy of
the recovered physics, collision, AI, or bit-exact floating arithmetic.
Complete source reconstruction requires further function-boundary,
calling-convention, type and behavior analysis.

