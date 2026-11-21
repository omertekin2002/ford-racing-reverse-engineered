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
records.

[`scripts/text_database.py`](../scripts/text_database.py) strictly parses the
three car databases, `ENGDATA.DAT`, `GEARDATA.DAT` and `TYREDATA.DAT`, and writes
them to `artifacts/text-databases/` as raw records with the source SHA-256. The
demo yields 56 engine and 14 gearbox records. There are 43 two-column torque arrays
of 5 to 10 rows and 51 `:INHERIT_TYPE` references, each naming an earlier record.
Every gearbox has the same 9 tags. The module docstring lists the exact grammar
and every rejected construct; tags must exist in the executable's registry.

One `ENGDATA.DAT` line, `INHERIT_TYPE DEFAULT_TRACK` in record `INDIGO`, lacks
the leading colon. The parser keeps such a line in the record's `untagged` list
rather than treating it as inheritance. Whether the game honours it is not
established. Other non-tag lines outside a value block are rejected.

`TYREDATA.DAT` yields 109 tyre records, 108 with `:INHERIT_TYPE`. It has one
9×11 longitudinal and one 10×21 lateral combined table, and three 10×2 blocks
each of vertical load and camber thrust. Its 40 `:SOUND_INFO` entries (14 in
`DEFAULT_ROAD`, 14 in `DEFAULT_OFFROAD`, 12 in `DEFAULT_TRACK`) each nest a
sample `:TYPE`, a `:VALUE` row count of 10 with that many index/value rows, and
a closing `:START_RPM`. `VALUE`, `TYPE` and `END` are not registry tags, so the
grammar, not the indentation, decides that `:TYPE` names a sample inside an
entry and a record outside one. The parser keeps each record's entries in file
order and checks the row count against `:VALUE`.

The parser resolves tyre inheritance for the five tables, as described in
[Tyre table inheritance](#tyre-table-inheritance), and for the scalar fields
with a byte-checked store, as described in
[Tyre scalar inheritance](#tyre-scalar-inheritance). It maps every engine tag the
demo uses to its byte-checked payload offsets and the C layout below, as described
in [New finding: engine stores and copy](#new-finding-engine-stores-and-copy), and
resolves each inheriting engine's effective fields from them, as described in
[Engine inheritance](#engine-inheritance). It maps every gearbox tag to its
byte-checked payload offset the same way, as described in
[New finding: gearbox stores and copy](#new-finding-gearbox-stores-and-copy). It
does not decide the colon-less `INDIGO` line, resolve gearbox inheritance (no demo
gearbox inherits), or handle the other text files. The meaning of the
sound table's first fifteen words, described below, is still unknown.

The engine loader at `0x005227f0` allocates a `0xb0`-byte payload, and the gearbox
loader at `0x00523220` allocates `0x34` bytes. Every engine and every gearbox
payload field from `+0x14` on is now byte-checked (see the next two sections), so
neither layout is transcribed any more. The engine record's derived `+0x2c` and `+0xa4` values and the
floating intermediate precision still need gameplay-level interpretation.

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

## New finding: engine stores and copy

[The engine loader](../analysis/selected/load_engine_database.asm) reads one tag
at a time and dispatches on its registry ID through a tree of `cmp eax, <id>`
branches. The record-creating branch keeps the allocated node in `EDI` and moves
it `0x20` bytes past the node header to the payload (`0x00522c03`, `0x00522c0f`),
so every handler stores at `EDI + offset`. Each of the 20 engine tags below has
its own compare, whose immediate is the tag's ID in `analysis/tags.json`, and a
handler that writes only the offsets listed. `ENGINE_FIELD_STORES` in
[the parser](../scripts/text_database.py) records them, and
[`field-evidence.json`](../analysis/selected/field-evidence.json) byte-checks
every compare and store against `fr3.exe`:

| Tag | ID | Compare | Offset | Width | Store | Notes |
|---|---|---|---|---|---|---|
| `LOCATION_TYPE` | `0xa5` | `0x00522b54` | `+0x14` | byte | `0x00522b70` | enum word from the table at `0x00597408` |
| `FUEL_CUTOFF` | `0x8a` | `0x00522ae2` | `+0x1c` | float | `0x00522b15` | |
| `ENGINE_BRAKING` | `0x7f` | `0x0052285d` | `+0x20` | float | `0x00522ada` | |
| `TORQUE_MODIFIER` | `0x119` | `0x00522a00` | `+0x24` | float | `0x00522a0e` | |
| `ROUGHNESS` | `0xe4` | `0x005228f6` | `+0x28` | float | `0x0052290e` | |
| `TORQUE_ARRAY` | `0x118` | `0x005228ef` | `+0x3c`, 18 slots | float | `0x00522969` | may derive `+0x2c` at `0x005229c1` or `0x005229f8` |
| `MAX_RPM` | `0xb0` | `0x005228b1` | `+0x30` | float | `0x00522a76` | |
| `CAPACITY` | `0x37` | `0x00522bd0` | `+0x34` | float | `0x00522be0` | |
| `TICKOVER_RPM` | `0x112` | `0x00522a53` | `+0x38` | float | `0x00522a65` | |
| `MAX_TURBO_PRESSURE` | `0xb1` | `0x00522a7e` | `+0x84` | float | `0x00522a8c` | |
| `FLYWHEEL_MASS` | `0x87` | `0x00522ae9` | `+0x88` | float | `0x00522b01` | |
| `FLYWHEEL_RADIUS` | `0x88` | `0x00522b78` | `+0x8c` | float | `0x00522b8a` | |
| `ACCELERATOR_SPEED` | `0x1` | `0x00522866` | `+0x90` | float | `0x00522b9e` | |
| `NUMBER_OF_TURBOS` | `0xc8` | `0x005228aa` | `+0x94` | byte | `0x005228e4` | |
| `NUMBER_OF_CYLINDERS` | `0xc6` | `0x00522a97` | `+0x95` | byte | `0x00522aa9` | |
| `ASPIRATION_TYPE` | `0x10` | `0x00522ba9` | `+0x98` | dword | `0x00522bc5` | enum word from the table at `0x005973f8` |
| `MAX_AIRFLOW` | `0xab` | `0x00522856` | `+0x9c` | float | `0x005228a2` | |
| `TURBO_MASS` | `0x15b` | `0x00522a16` | `+0xa0` | float | `0x00522a28` | derives `+0xa4` at `0x00522a48` or `0x00522c4e` |
| `MAX_FUELFLOW` | `0xae` | `0x00522ab4` | `+0xa8` | float | `0x00522ac6` | |
| `MAX_DELTA_FUELFLOW` | `0xad` | `0x005228bc` | `+0xac` | float | `0x005228d0` | |

Two handlers do more than store the declared value:

- `TORQUE_ARRAY` first zero-fills the `0x48` bytes at `+0x3c` by calling the
  fill routine at `0x00534690` with size `0x48`, destination `EDI + 0x3c` and
  value 0 (`0x0052291c`–`0x00522926`). It then derives a row count from the
  `MAX_RPM` value at `+0x30` (`0x0052292b`), so the count depends on whatever
  `+0x30` holds when the tag is parsed: the record's own `MAX_RPM` if declared
  earlier, a value an earlier `INHERIT_TYPE` copied, or zero. For each row it
  keeps the first column only in a stack temporary (`0x00522961`) and stores the
  second at `+0x3c + 4 * row`, through a pointer that starts at the record and
  steps by 4 (`0x00522952`, `0x0052295b`, `0x00522969`). The loop compares only
  with that count, not with the 18 slots. Afterwards it may write a derived
  `+0x2c`, but both stores are conditional. `0x005229c1` runs only for a row
  whose value beats the best so far, and not at all when `MAX_RPM` is not above
  zero (`0x00522980`, `0x005229b6`). `0x005229f8` runs only when `+0x2c` and
  `+0x30` differ by less than the float at `0x00581d20` (`0x005229e9`). When
  neither runs, `+0x2c` keeps what an earlier `INHERIT_TYPE` copied, or zero.
  Like the row count, this uses `+0x30` as it is when the tag is parsed: a later
  `MAX_RPM` does not re-derive it.
- `TURBO_MASS` stores `+0xa0`, then writes `1 / (+0xa0)` at `+0xa4`
  (`0x00522a48`), or `1.0` when `+0xa0` is zero (`0x00522c4e`).

Neither derived value is computed here.

`INHERIT_TYPE` (`0x9c`, compare `0x00522b1d`) reads a name and looks the parent
up by it (`call 0x00522d70` at `0x00522b3c`). It keeps the parent in `ECX` and
passes it in `EDX`, with the record in `EAX` (`0x00522b41`–`0x00522b45`), to
[the engine copy](../analysis/selected/copy_engine_record.asm)
(`call 0x00522c80` at `0x00522b47`), then stores the parent at `+0x18`
(`0x00522b4c`). The copy saves and restores `ECX` (`0x00522c81`, `0x00522d69`),
so that store writes the parent. The copy keeps the record in `EBX` and moves,
from the parent:

| Copied | How | Sites |
|---|---|---|
| byte `+0x14` | `mov al, [edx + 0x14]`, `mov [ebx + 0x14], al` | `0x00522c8b`, `0x00522c91` |
| dwords `+0x1c`–`+0x38` | eight load/store pairs through `EAX` | `0x00522c97`–`0x00522cc4` |
| `+0x3c`–`+0x83`, the 18 torque slots | `ECX = 0x48`, `ESI`/`EDI` = parent/record `+ 0x3c`, then `0x48 >> 2` = `0x12` dwords by `movsd` and `0x48 & 3` = 0 bytes by `movsb`, both with an `F2` repeat prefix | `0x00522c86`, `0x00522c8e`, `0x00522c94`, `0x00522cc8`–`0x00522cd4` |
| dwords `+0x84`–`+0x90` | four pairs | `0x00522cd7`–`0x00522d01` |
| bytes `+0x94`, `+0x95` | two pairs through `AL` | `0x00522d07`–`0x00522d19` |
| dwords `+0x98`–`+0xac` | six pairs | `0x00522d1f`–`0x00522d61` |

That is exactly the stored and derived offsets above, `+0x2c` and `+0xa4`
included. The copy leaves alone the name (`+0x00`–`+0x13`), `+0x18`, and the
padding at `+0x15`–`+0x17` and `+0x96`–`+0x97`. `ENGINE_COPY` records the call,
the copied offsets with their widths and the block.

`verify_text_databases()` checks this on the real demo:

- `engine_evidence_problems()` checks that each compare immediate equals the
  tag's ID in `analysis/tags.json`. Every cited site must be in
  `field-evidence.json`, inside its routine, and decode as the listed store,
  zero-fill, enum table or `INHERIT_TYPE` setup. Each offset needs at least one
  store site, each store site's claim must name its tag, and every byte-checked
  write to the record in the loader must be a mapped site. Every copy store must follow a
  load of the same parent offset into the same register. The copy must move
  exactly `ENGINE_COPY`'s offsets, and the bytes it writes must equal the bytes
  the mapped tags store, without the name or `+0x18`.
- `engine_layout_problems()` checks that each mapped offset is the
  `Fr3EngineRecord` field named in the map, with that width, in
  [the C header](../recovered/fr3_database_layouts.h). The header must
  `_Static_assert` each offset. This check corrected the header: `+0xa8` is
  `MAX_FUELFLOW` and `+0xac` is `MAX_DELTA_FUELFLOW`, and the earlier
  transcription had swapped their names.
- Every tag the demo's `ENGDATA.DAT` uses must be mapped, apart from `TYPE`,
  `INHERIT_TYPE` and `END`. Otherwise verification fails and names the tag. All
  21 tags in the demo are covered: the 20 above plus `INHERIT_TYPE`.

A unit test also follows the compare tree in the committed
`load_engine_database.asm`, so it runs without the demo. Each mapped ID reaches its handler through the
listed compare, and each handler writes exactly the mapped sites. Every other
registry ID reaches the default branch.

### Engine inheritance

The stores and copy above give engines the same model as
[tyre scalars](#tyre-scalar-inheritance), over every mapped field. In file order,
each record starts zero-filled; each tag in `ENGINE_FIELD_STORES` stores its
declaration at its offsets; `INHERIT_TYPE` copies the parent's current state over
every offset `ENGINE_COPY` covers, the torque block included. A field ends up
holding the record's own declaration when it follows `INHERIT_TYPE`, and
otherwise the parent's effective value at copy time, recursively. A declaration
made before `INHERIT_TYPE` is overwritten. As for tyres, the model assumes nothing
outside the loader writes a loaded record later; that code is not examined.

Three cases differ from tyres:

- `TORQUE_ARRAY` zero-fills all 18 slots before it stores rows, so a record's own
  table replaces the parent's whole block and never mixes rows with it. A record
  without one keeps the parent's rows. Because the row count is read from `+0x30`
  as the tag is parsed, each torque entry also names the `MAX_RPM` declaration
  (record and line) that was in the record at that moment: its own, an inherited
  one, or the zero fill.
- `+0xa4` is rewritten from `TURBO_MASS` whenever that tag is parsed, so its
  entry names the `TURBO_MASS` declaration that produced it.
- `+0x2c` may or may not be rewritten by `TORQUE_ARRAY` (the conditions above),
  so its entry is labelled conditional and lists every possible origin: the
  `TORQUE_ARRAY` declaration in effect, then whatever the offset held before,
  down the chain to the root's zero fill. It does not pick one.

Neither derived value is computed.

`effective_engine_fields()` replays this and `text_database.py` writes it to
`engines.json` as `effective_fields`. For each of the 51 engines with
`:INHERIT_TYPE` it gives the `INHERIT_TYPE` line and parent and, for each of the
20 mapped tags, the payload `offsets` and a `status` (`declared`, `inherited` or
`not declared (zero-filled)`, as for tyres). Declared and inherited fields give
the declared text `values` (and the `rows` of a torque array), the `source`
record, its `source_line` and the `path` from the engine to the source.
`TORQUE_ARRAY` adds `max_rpm`, and `TORQUE_ARRAY` and `TURBO_MASS` add `derived`
entries for `+0x2c` and `+0xa4`, each with a `conditional` flag and its
`origins`. `overwritten` and `unmapped` list early declarations and tags with no
mapped store. No units, physics or row positions are computed.

`engine_fields_by_recursion()` derives the same entries a second way, parent
first by recursion over earlier records, and `verify_text_databases()` checks on
the real demo that:

- the effective record set is exactly the 51 inheriting engines;
- the two derivations agree;
- nothing is overwritten and no tag is unmapped;
- every torque table was parsed with its own record's `MAX_RPM`;
- the per-tag status counts equal `ENGINE_FIELD_COUNTS`.

In the demo no field is zero-filled, because the five roots declare all 20
tags. 38 inheriting engines declare their own `TORQUE_ARRAY`, each after its own
`MAX_RPM`; the other 13 inherit the table. Of the 1,020 fields, 270 are declared
by the engine itself, 510 come from its direct parent, 137 from two levels up and
103 from three:

| Tag | Declared | Inherited |
|---|---|---|
| `TORQUE_MODIFIER` | 51 | 0 |
| `TORQUE_ARRAY`, `MAX_RPM` | 38 each | 13 each |
| `ASPIRATION_TYPE` | 18 | 33 |
| `ROUGHNESS` | 16 | 35 |
| `CAPACITY`, `MAX_TURBO_PRESSURE`, `NUMBER_OF_TURBOS`, `TURBO_MASS` | 14 each | 37 each |
| `FUEL_CUTOFF`, `NUMBER_OF_CYLINDERS` | 8 each | 43 each |
| `FLYWHEEL_MASS` | 7 | 44 |
| `LOCATION_TYPE`, `TICKOVER_RPM` | 6 each | 45 each |
| `FLYWHEEL_RADIUS`, `MAX_FUELFLOW` | 4 each | 47 each |
| `ACCELERATOR_SPEED`, `MAX_AIRFLOW`, `MAX_DELTA_FUELFLOW` | 3 each | 48 each |
| `ENGINE_BRAKING` | 1 | 50 |

A shared parent does not make two engines behave identically: each engine's
own declarations replace the parent's.

`INDIGO` stays a root as parsed and gets no `effective_fields` entry.
`untagged_inherit_consequences()` writes, as `untagged_inherit_consequences`,
what depends on its colon-less line: for each of the 16 mapped tags `INDIGO`
does not declare, `if_ignored` (zero-filled) and `if_applied` (the entry it
would get with `DEFAULT_TRACK` as its parent). It does not choose between them;
see the [Open questions page](#open-questions).

## New finding: gearbox stores and copy

[The gearbox loader](../analysis/selected/load_gearbox_database.asm) allocates
its `0x34`-byte payload (`mov edx, 0x34` at `0x00523234`, then
`call 0x0042ed50` at `0x00523242`). Its record-creating branch keeps the node in
`EDI`, moves it `0x20` bytes past the node header and reads the name into the
payload's first `0x14` bytes (`0x005233fe`–`0x00523411`), so every handler
stores at `EDI + offset`. The dispatch is a tree of range compares: where a tag's
compare is followed by a `jge`, the handler is selected by the `jg` at the
`jge`'s target not jumping, which leaves only that ID. Each of the nine gearbox
tags has the compare below, whose immediate is the tag's ID in
`analysis/tags.json`, and a handler that writes only the offset listed.
`GEARBOX_FIELD_STORES` in [the parser](../scripts/text_database.py) records them,
and [`field-evidence.json`](../analysis/selected/field-evidence.json) byte-checks
every compare, selecting `jg`, reader call, enum table and store against
`fr3.exe`:

| Tag | ID | Compare | Offset | Width | Store | Read as |
|---|---|---|---|---|---|---|
| `CLUTCH_SPEED` | `0x5f` | `0x00523289`, then `jg` `0x005232c1` | `+0x14` | float | `0x005232ca` | float (`call 0x0042e680` at `0x005232c5`), `fstp` |
| `CLUTCH_MAX_POWER` | `0x5e` | `0x005233cb` | `+0x18` | float | `0x005233db` | float (`0x005233d6`), `fstp` |
| `TORQUE_SHIFT` | `0x11a` | `0x00523310`, then `jg` `0x00523343` | `+0x1c` | float | `0x0052334c` | float (`0x00523347`), `fstp` |
| `DRIVE_SPLIT` | `0x76` | `0x00523378` | `+0x20` | float | `0x00523388` | float (`0x00523383`), `fstp` |
| `TRANSMISSION_TYPE` | `0x159` | `0x00523354` | `+0x24` | dword | `0x00523370` | enum word (`call 0x0042e820` at `0x0052336b`) from the table at `0x0059743c` (`0x00523364`) |
| `DIFF_TYPE` | `0x6d` | `0x005232d4` | `+0x28` | dword | `0x005232f0` | enum word (`0x005232eb`) from the table at `0x00597460` (`0x005232e4`) |
| `DRIVE_TYPE` | `0x77` | `0x005232cf`, then `jg` `0x005232f5` | `+0x2c` | dword | `0x00523308` | enum word (`0x00523303`) from the table at `0x0059744c` (`0x005232fc`) |
| `ANTI_WHEELSPIN` | `0xf` | `0x005233ac` | `+0x30` | byte | `0x005233c3` | float (`0x005233b3`) passed to `0x005352fa` (`0x005233b8`), `fistp` to `[ebp - 0x18]` (`0x005233bd`), low byte via `AL` (`0x005233c0`) |
| `ANTI_WHEELSKID` | `0xe` | `0x0052328e`, then `jg` `0x00523390` | `+0x31` | byte | `0x005233a4` | the same, at `0x00523394`, `0x00523399`, `0x0052339e`, `0x005233a1` |

`INHERIT_TYPE` (`0x9c`, compare `0x00523317`) reads a name of up to `0x14`
bytes into a stack buffer (`0x0052331e`–`0x00523328`), passes that buffer to
the parent lookup (`call 0x005234b0` at `0x00523330`), and calls
[the gearbox copy](../analysis/selected/copy_gearbox_record.asm) with the parent
in `EDX` and the record in `EAX` (`0x00523335`–`0x00523339`). Then it jumps back
to the next tag (`0x0052333e`). Unlike the engine loader it stores no parent
address: `+0x18` is `CLUTCH_MAX_POWER`. The copy saves `EBX` and `ECX`
(`0x00523470`, `0x00523471`, restored at `0x005234a8`, `0x005234a9`) and moves,
from the parent to the record (`EAX`):

| Copied | How | Sites |
|---|---|---|
| dwords `+0x14`–`+0x2c` | seven load/store pairs through `ECX`, `+0x1c` first | `0x00523472`–`0x00523499` |
| byte `+0x30` | `mov bl, [edx + 0x30]`, `mov [eax + 0x30], bl` | `0x0052349c`, `0x0052349f` |
| byte `+0x31` | `mov dl, [edx + 0x31]`, `mov [eax + 0x31], dl` | `0x005234a2`, `0x005234a5` |

That is exactly the nine stored offsets. The copy leaves alone the name
(`+0x00`–`+0x13`) and `padding_32` (`+0x32`–`+0x33`). `GEARBOX_COPY` records
the `INHERIT_TYPE` path and the copied offsets with their widths. No demo
gearbox declares `:INHERIT_TYPE` (`verify_text_databases()` requires exactly the
nine tags on all 14), so the copy resolves no values; it documents what the
game would do.

`verify_text_databases()` checks this on the real demo:

- `GEARBOX_FIELD_STORES` must cover exactly the nine gearbox tags.
- `gearbox_evidence_problems()` checks that each compare immediate equals the
  tag's ID in `analysis/tags.json`, and each selecting site is a `jg` whose
  claim names the tag. Every cited site must be in `field-evidence.json`, inside
  its routine, and decode as the listed reader call, enum table, conversion or
  store of the read register (`ST0`, `EAX` or `AL`). Each store site's claim must
  name its tag, and every byte-checked write to the record in the loader must be
  a mapped site. The allocation, name read and `INHERIT_TYPE` path must have
  the listed bytes. Every copy store must follow a load of the same parent
  offset into the same register, the copy must move exactly `GEARBOX_COPY`'s
  offsets, and the bytes it writes must equal the bytes the tags store, without
  the name or padding.
- `gearbox_layout_problems()` checks that each mapped offset is the
  `Fr3GearboxRecord` field named in the map, with that width, in
  [the C header](../recovered/fr3_database_layouts.h), which must
  `_Static_assert` all nine offsets.

A unit test follows the compare tree in the committed
`load_gearbox_database.asm` without the demo. Each mapped ID reaches its handler
through the listed compare, and each handler calls its reader and writes exactly
the mapped site. `INHERIT_TYPE` writes nothing to the record, and every other
registry ID reaches the default branch.

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

The scalar-copy helper at `0x00524090` copies the eleven dwords `+0x18` to
`+0x40`, every scalar field above, from the parent record to the inheriting
one, and leaves the name, `+0x14` and the table addresses alone; see
[Tyre scalar inheritance](#tyre-scalar-inheritance). The grip scaling global's
runtime value and physical units remain unverified; the table dimensions do not
prove the force equations.

### Tyre table inheritance

[The table accessors](../analysis/selected/tyre_table_accessors.asm) resolve
inheritance for the five table addresses:

| Accessor | Offset | Table |
|---|---|---|
| `0x00523e90` | `0x44` | `LONGITUDINAL_COMBINED_VALUES` |
| `0x00523eb0` | `0x48` | `LATERAL_COMBINED_VALUES` |
| `0x00523e50` | `0x4c` | `VERTICAL_LOAD` |
| `0x00523e70` | `0x50` | `CAMBER_THRUST` |
| `0x00523f10` | `0x54` | `:SOUND_INFO` entries (`0x00523ed0` returns one sound row) |

Each accessor returns the record's own address at that offset when it is
non-zero. Otherwise it loads the inherited record from `+0x14` and jumps back to
the same test, so it follows any number of levels and never checks for a null
parent. For each of the five accessors,
[`field-evidence.json`](../analysis/selected/field-evidence.json) byte-checks
against `fr3.exe` the instruction that reads its offset and the fallback load
from `+0x14`, along with the loader's store of each table address at that offset.
A synthetic test checks that the table above and the parser's
`TYRE_TABLE_ACCESSORS` agree with those sites. The loader writes each table
address only when it parses the matching tag; the first `:SOUND_INFO` of a record allocates its `0x2d0`-byte table, and
later ones reuse it (test at `0x00523a5c`). `INHERIT_TYPE` sets `+0x14` and runs
the scalar copy above, which leaves `+0x44` to `+0x54` untouched.

A record without one of these tags holds zero at that offset. The tyre loader
creates its database at `0x00523842` with no preallocated record slots (the
argument pushed at `0x00523839` is 0). Each `:TYPE` therefore reaches
[the record allocator](../analysis/selected/allocate_database_record.asm),
called at `0x005238c4`, on its heap path at `0x0042ef36`. It allocates the `0x58`-byte payload plus the
`0x20`-byte node header and clears all of it with
[`0x00534690`](../analysis/selected/fill_memory.asm), a fill routine called here
with value 0 and the node size. The [database
constructor](../analysis/selected/create_database.asm) stores that `0x58` size
at `0x0042ed93`.

`resolve_tyre_tables()` in the parser applies the same rule and `tyres.json`
records, as `resolved_tables`, which record's table each tyre ends up reading. A
chain that reaches a record with no table and no `:INHERIT_TYPE` is rejected,
because the game would follow a null `+0x14` there. In the demo all 109 tyre
records resolve all five tables:

| Table | Source records |
|---|---|
| Longitudinal and lateral combined | `DEFAULT_ROAD` 109 |
| Vertical load, camber thrust and sound information | `DEFAULT_ROAD` 73, `DEFAULT_OFFROAD` 23, `DEFAULT_TRACK` 13 |

`tyres.json` also records, as `table_provenance`, how each tyre reaches each of
the five tables. For every record and table it gives the `source` (the same
record as `resolved_tables`), the `path` of records the accessor visits from the
record itself to the source, the `source_line` in `TYREDATA.DAT` where the
source declares the table (the tag's line, or its first `:SOUND_INFO` entry's
line) and the `accessor` and `record_offset` from the table above. For example,
`OFFROAD_R366x297` reads its longitudinal table along
`OFFROAD_R366x297` → `DEFAULT_OFFROAD` → `DEFAULT_ROAD` from line 24, through
`0x00523e90` at `+0x44`. `verify_text_databases()` checks that every path starts
at its record, follows each hop's `:INHERIT_TYPE` past records without the
table, and ends at a record that declares the table on `source_line`. It also
compares every source with one derived separately, in file order, from each
record's own tables and its parent's sources.

### Tyre scalar inheritance

Scalar fields are not read through accessors. The loader stores each scalar
tag in the payload as it parses it, and `INHERIT_TYPE` copies them, so the
result depends on tag order. The model `effective_scalars()` in the parser
applies rests on these byte-checked facts:

- The loader stores each tag at the offsets in the payload table above.
  `TYRE_SCALAR_STORES` in the parser lists, for each tag, its offsets and the
  `field-evidence.json` store sites; `RADIUS` and `MASS` also write their
  reciprocals at `+0x3c` and `+0x38`.
- The two grip numbers are stored, loaded again, multiplied by the float at
  `0x00597484` and stored back (`0x00523937`–`0x00523945` and
  `0x00523ca8`–`0x00523cb6`), so the value a child copies is the scaled one.
- The `INHERIT_TYPE` branch passes the parent in `EDX` and the current record in
  `EAX` (`0x00523b35`, `0x00523b37`) to `call 0x00524090` at `0x00523b3a`, and
  then stores the parent at `+0x14` (`0x00523b42`).
- [The scalar copy](../analysis/selected/copy_tyre_scalar_fields.asm) is eleven
  load/store pairs, `mov ecx, [edx + n]` then `mov [eax + n], ecx`, for each
  dword from `+0x18` to `+0x40`, followed by `pop ecx` and `ret`
  (`0x00524091`–`0x005240d4`).
- The record allocator zero-fills each payload (see above), and `INHERIT_TYPE`
  can only name an earlier record, which is fully parsed by then.

So, in file order, each record starts at zero; each scalar tag stores its
declaration; `INHERIT_TYPE` overwrites all eleven dwords with the parent's
current values. A field ends up holding the record's own declaration when it
follows `INHERIT_TYPE`, and otherwise the parent's effective value at copy
time, recursively. A declaration made before `INHERIT_TYPE` is overwritten.
The model assumes nothing else writes these offsets after the copy. In the
loader's export span the only other stores at these displacements are indexed
writes into the sound table loaded from `+0x54` (`0x00523b10`, `0x00523d81`,
`0x00523da5`); code outside the loader that might write a loaded record later
is not examined.

`tyres.json` records this under `effective_scalars`. For each of the 108
records with `:INHERIT_TYPE` it gives the `INHERIT_TYPE` line and parent and,
for each tag in `TYRE_SCALAR_STORES`, the payload `offsets` and a `status`:

- `declared`: the record's own declaration, after `INHERIT_TYPE`, wins;
- `inherited`: the value comes from an ancestor;
- `not declared (zero-filled)`: no record along the chain declares it, so the
  field stays zero. No value is given.

For `declared` and `inherited` fields it gives the declared text `values`, the
`source` record, its `source_line` in `TYREDATA.DAT` and the `path` of records
from the tyre to the source. `overwritten` lists declarations made before
`INHERIT_TYPE`, and `unmapped` lists scalar tags with no byte-checked store
(for example `LOCATION_TYPE`, whose registry ID `0xa5` reaches the loader's
default branch); neither gets a value. Values are the declarations as written:
no units, physical meaning or grip scale value is applied.

`verify_text_databases()` checks, on the real demo, that every store, the
scale loads and multiplies, the call and every copy pair in
`TYRE_SCALAR_STORES` match a site in `field-evidence.json` (and that the
copied offsets are exactly `+0x18` to `+0x40`). It then derives each
effective field a second way, parent first by recursion over earlier records,
and compares it with the file-order replay; any `INHERIT_TYPE` naming a later or
missing record, or any difference, fails. In the demo every inheriting record
declares its scalars after `INHERIT_TYPE`, none declares an unmapped tag and no
field is zero-filled, because `DEFAULT_ROAD`, `DEFAULT_OFFROAD` and
`DEFAULT_TRACK` declare all nine tags. Of the 972 fields, 366 are declared by
the record itself and 606 come from its direct parent; none in the demo comes
from two levels up:

| Tag | Declared | Inherited |
|---|---|---|
| `ROAD_MAGIC_GRIP_NUMBER`, `RADIUS`, `WIDTH` | 108 each | 0 |
| `OFFROAD_MAGIC_GRIP_NUMBER` | 26 | 82 |
| `TYRE_PATCH_LENGTH` | 6 | 102 |
| `MASS` | 4 | 104 |
| `WET_MAGIC_GRIP_PERCENTAGE`, `TYRE_GRIP_DEPTH`, `ROLLING_RESISTANCE` | 2 each | 106 each |

Engine inheritance is resolved the same way in
[Engine inheritance](#engine-inheritance); the colon-less
`INHERIT_TYPE DEFAULT_TRACK` line in `INDIGO` remains unresolved.

The tyre sites among the [274 byte-checked instruction sites](../analysis/selected/field-evidence.json)
and [the loader's disassembly](../analysis/selected/load_tyre_database.asm)
preserve the concrete evidence for these new findings.

### Tyre dossier

`python3 scripts/tyre_dossier.py`, run after `text_database.py`, writes
`artifacts/dossier/tyres.html`. For each tyre it shows the declarations as
written, the source, path, source line, accessor and offset of each of the five
tables above, and a "Why?" trail of the field-evidence sites behind each table:
the sites inside that table's accessor and the loader's byte-checked store
sites, plus allocation-size sites where available. Sites are matched by address,
not claim text. Inheriting records
show, for each mapped scalar tag, its effective declaration, status, source
record and line (linked to that line's row in the source's declarations),
`INHERIT_TYPE` path, payload offsets, and links to its store and copy sites.
Zero-filled fields show the label and no value, and unmapped tags stay labelled
`unmapped` with no value. The page links into the [routine index](#routine-index),
`routines.html`, beside it: a "Loaded by" line links `fr3_load_tyre_database`,
each "Why?" trail links its accessor's section and every site's
`#site-<va>` row, and each scalar section links `0x00524090` to
`fr3_copy_tyre_scalar_fields` and its `INHERIT_TYPE` call at `0x00523b3a`. Each label is read from
`analysis/annotated/status.json` by entry VA (`--status` changes the file). The
script exits non-zero instead of writing a page when a
record lacks a table, `resolved_tables` and `table_provenance` disagree, a path
does not follow `INHERIT_TYPE`, a cited accessor or offset has no matching
byte-checked site, `effective_scalars` disagrees with the declarations or a
scalar store, the call or a copy pair has no matching site, or a linked routine is missing from `status.json` (or, for
the loader and scalar copy, labelled differently there). A shared table source does not make two tyres handle the
same: their scalar fields can differ. The page is not committed because it holds
game data; [`build_research.py`](#research-directory) builds it with the other
research pages, for publishing per decision #46.

### Engine and gearbox dossier

`python3 scripts/record_dossier.py`, run after `text_database.py`, writes
`artifacts/dossier/engines.html` and `artifacts/dossier/gearboxes.html` beside
the tyre page, with a link bar between the dossier pages. Each page lists the records in
file order, with each engine's `:INHERIT_TYPE` parent and torque array shape,
and then shows every record's declarations exactly as written, in line order.
Multi-row fields such as `TORQUE_ARRAY` appear as row tables with their
dimensions. `:INHERIT_TYPE` links to the parent.

Each of the 51 inheriting engines also gets an effective-fields table from
`engines.json`'s `effective_fields` (see [Engine inheritance](#engine-inheritance)):
for each mapped tag, its status, declared values (a torque array's shape), source
record and line linked to that line's declaration row, path, and byte-checked
store sites on `routines.html`. The section links the copy routine and its
`INHERIT_TYPE` call site, and the torque zero fill. A torque row names the
`MAX_RPM` declaration its row count was read from, with the `+0x30` read site.
`+0x2c` and `+0xa4` get rows of their own, labelled derived (`+0x2c` also
conditional, linking its three condition jumps), listing their possible origins
and no value. A shared parent does not make two engines behave identically, and
units and physics are not claimed.

The colon-less `INHERIT_TYPE DEFAULT_TRACK` line in `INDIGO` is shown verbatim
as an untagged line, not as inheritance, with a note that whether the game
honours it is not established. `INDIGO`'s section lists, labelled unresolved and
linked to `questions.html#indigo`, the 16 tags that depend on the line, under
both readings. The engine page has a "Where each field is stored" table with
one row per tag in `ENGINE_FIELD_STORES`, in payload offset order, each with
the id `engine-store-<TAG>`: the offsets the tag's handler writes, their width
and `Fr3EngineRecord` field, the `cmp eax, <id>` dispatch site and the store
sites, linked to `routines.html`. `TORQUE_ARRAY`'s row gives the 18-slot block
at `+0x3c`, its zero fill and the row count read from `+0x30` when the tag is
parsed; the derived `+0x2c` (conditional, linking its jumps) and `+0xa4` are
listed as derived with no value, and `LOCATION_TYPE` and `ASPIRATION_TYPE` name
their enum word tables. The table also links the `INHERIT_TYPE` copy call and
the parent store at `+0x18`. The gearbox page has a "Where each field is stored" table with
one row per gearbox tag: its payload offset, width and `Fr3GearboxRecord` field,
how it is read (float, enum word table, or float stored as an integer's low
byte), and its compare (with the selecting `jg`) and store sites linked to
`routines.html` (see
[New finding: gearbox stores and copy](#new-finding-gearbox-stores-and-copy)).
It names the copy call too. Gearbox `:INHERIT_TYPE` (none in the demo) stays labelled
unresolved. A "Loaded by" line near the top links the database's load and copy
routines (`fr3_load_engine_database` `0x005227f0` and `fr3_copy_engine_record`
`0x00522c80`, or `fr3_load_gearbox_database` `0x00523220` and
`fr3_copy_gearbox_record` `0x00523470`) to their sections on `routines.html`.
The script exits non-zero without writing either page when an input is missing
or malformed: records that are not a list or lack `type`, `line` or `fields`,
duplicate record names, an `:INHERIT_TYPE` that does not name an earlier record
of the same file, `effective_fields` or `untagged_inherit_consequences` that
differ from what `text_database.py` derives from the records, a linked site
missing from `field-evidence.json` (`--evidence`), PE metadata without `sha256`,
or a load or copy routine that is missing from
`status.json` or labelled differently there. The pages are not committed because they hold game
data; [`build_research.py`](#research-directory) builds them with the other
research pages, for publishing per decision #46.

### Compare records

`python3 scripts/record_compare.py`, run after `text_database.py`, writes
`artifacts/dossier/compare.html` beside the engine and gearbox pages, the
"Compare records" research page. Its first section compares the 14 demo
gearboxes and its second the 56 demo engines; tyres are not compared yet. A
jump link at the top leads to each section. The gearbox matrix has one row per
gearbox, in `GEARDATA.DAT` order, and one column per tag in
`GEARBOX_FIELD_STORES`, in payload offset order (`+0x14` to `+0x31`), so any
two rows compare two records field by field without client-side code. Each
cell shows the declared value exactly as written, read from `GEARDATA.DAT`
itself (`--game`), whose SHA-256 must match `gearboxes.json` and whose tokens
must parse to the values `gearboxes.json` holds: the parsed JSON keeps `0.20`
only as the number `0.2`, and the demo writes `CLUTCH_SPEED` both ways. Each
cell links to its declaration row on `gearboxes.html`
(`gearbox-<name>-line-<n>`), and each column header, which gives the tag's
offset, width and how it is read (float, enum word, or float stored as an
integer's low byte), links to the tag's row in that page's "Where each field
is stored" table (`gearbox-store-<TAG>`), which links the byte-checked compare
and store sites on `routines.html`.

The "What differs" table has one row per tag: how many distinct values the
gearboxes declare and which gearboxes declare each. Tags read as a float,
`ANTI_WHEELSPIN` and `ANTI_WHEELSKID` included, are grouped by the parsed
number, showing each written form (`0.2` and `0.20`, or `1` and `1.0`, are one
value); enum tags are grouped by the exact word. A tag with one value is
labelled "same in all 14"; in the demo that is `TRANSMISSION_TYPE` (`MANUAL`).
The page claims no units, enum meanings or physics, and does not compute the
integer whose low byte the loader stores for `ANTI_WHEELSPIN` and
`ANTI_WHEELSKID`. Declared values equal stored values only because no demo
gearbox inherits, so the script exits non-zero without writing the page when a
gearbox lacks one of the nine mapped tags, declares a tag that is not mapped,
declares `:INHERIT_TYPE` (gearbox inheritance is not resolved), has an
untagged line, or declares a mapped tag with rows or more than one value, when
a float tag's value is not a number, and when `GEARDATA.DAT` does not match
`gearboxes.json`.

The engine section shows each engine's effective values: what the loader ends
up storing once each `:INHERIT_TYPE` has copied the parent's fields, as
`engines.json` `effective_fields` resolve them (see
[Engine inheritance](#engine-inheritance)); a root's values are its own
declarations. Its matrix has one row per engine, in `ENGDATA.DAT` order, and
one column per tag in `ENGINE_FIELD_STORES`, in payload offset order, 56 × 20
in the demo. Each column header links to the tag's `engine-store-<TAG>` row on
`engines.html`. Each cell shows the effective value as written on the line that
declares it, read from `ENGDATA.DAT` (whose SHA-256 must match `engines.json`),
linked to that declaration's row (`engine-<source>-line-<n>`) and marked
declared or inherited from its source record, with the `INHERIT_TYPE` path when
it is longer than one step. `TORQUE_ARRAY` cells list no values: they give the
source record and line, the row count and the `MAX_RPM` declaration the table
was parsed with, and link the engine's effective `engine-<name>-torque-array`
row (a root has none, so its cell links only the declaration).

`INDIGO`'s colon-less `INHERIT_TYPE DEFAULT_TRACK` line is not applied. Each
of the 16 tags `INDIGO` does not declare, and any tag another engine gets
through such a field, is shown as `unresolved` with no value, never `0`,
linked to `questions.html#indigo`; a field a root declares before such a line
would be unresolved too, because applying the line would overwrite it. The
engine "What differs" table has one row per tag: the distinct effective values
and the engines that hold each (numbers grouped by the parsed number, enum
words by the exact word, torque tables by source record and line), the
unresolved cells counted apart, and how the 51 inheriting engines get the field
as parsed. When `ENGDATA.DAT` is the demo's, by the SHA-256 in
`analysis/game-file-manifest.json`, those declared and inherited counts must
equal `ENGINE_FIELD_COUNTS`. The engine section claims no units, enum meanings
or physics, computes no derived `+0x2c` or `+0xa4` value and does not apply
`TORQUE_MODIFIER` to the table. The script also exits non-zero without writing
the page when an engine declares a tag with no byte-checked store, declares
`:INHERIT_TYPE` but has no `effective_fields` entry or has a declaration before
it that the copy overwrites, has an untagged line other than a root's
colon-less `INHERIT_TYPE` line, or declares a mapped tag that is not one inline
value (a `TORQUE_ARRAY` that is not a block of rows) or whose written token
does not parse to the value `engines.json` holds, when `effective_fields` or
`untagged_inherit_consequences` differ from what `text_database.py` derives,
and when `ENGDATA.DAT` does not match `engines.json`. The page is not committed
because it holds game data; [`build_research.py`](#research-directory) builds
it with the other research pages.

### PCG catalogue

`python3 scripts/pcg_catalogue.py` writes `artifacts/dossier/pcg.html` beside
the other dossier pages, which link to it. It needs no demo, network or Ghidra:
it reads only the committed [PCG index](../analysis/pcg-index.json),
[decoded manifest](../analysis/unpacked-manifest.json), PE metadata and
[verification results](../analysis/verification.json). The page covers the PCG
directory structure only; no pixel data is decoded or shown. It lists the 62
collections with their payload base, raw header words and compressed and decoded
SHA-256, then each of the 654 graphics with its name and name bytes, file offset,
width and height, declared payload, span and extra bytes. Every graphic carries
one decoding status from a fixed set in the script; today all are
`not decoded: pixel encoding not established`. Of the 32 graphic header words,
only `+8` (width), `+12` (height) and `+0x28` (declared payload) are labelled;
the rest are shown raw as "meaning not established". The 1,024 extra bytes of
`_loadbar` and `_loadbr2` are labelled unresolved. The script exits non-zero
without writing the page when an input is missing or malformed, collection paths
repeat, a count disagrees with its entries, entry indexes are not `0..count-1`
in order, a width, height or declared payload disagrees with its header word,
the extra bytes disagree with the span, the payload base disagrees with the
formula above, a collection has no manifest entry, the totals disagree with
`verification.json`, or the PE metadata has no `sha256`.

### Routine index

`python3 scripts/routine_index.py` writes `artifacts/dossier/routines.html`
beside the other dossier pages. Like the PCG catalogue it needs no demo, network
or Ghidra: it reads only the committed
[annotated status](../analysis/annotated/status.json),
[pseudocode](../analysis/annotated/selected.c), the bounded `.asm` files and
[field evidence](../analysis/selected/field-evidence.json) under
`analysis/selected/`, and the PE metadata. A summary table lists the 25 routines
in `status.json` order with entry VA, analyst label, signature, return and
parameter storage and whether they decompiled, with the error text where one
did not. Each routine then gets a section anchored by its label (for example
`#fr3_load_tyre_database`) with its `selected.c` block, escaped, in a collapsed
`<pre>`; links to the disassembly files whose export span (start included, end
excluded) holds its entry VA; and the byte-checked sites placed under it. The
six tyre accessors share `tyre_table_accessors.asm`, so a site in a file that
holds several routine entries is listed under the routine with the nearest entry
VA at or below it. That is a placement rule of the page, not an established
routine boundary. The nine reader routines (`fr3_read_integer` and the like)
lie in no committed span. The four files that hold no routine entry
(`allocate_database_record`, `create_database`, `fill_memory` and
`fill_memory_body`) get their own sections, and any site in no span, or before
every routine entry in its file, is listed apart; today there is none. Each of
the 274 sites is shown exactly once. The page says that every label is
analyst-assigned, not an original symbol, and that the pseudocode is Ghidra
output with unresolved callees and inferred types. The script exits non-zero
without writing the page when an input is missing or malformed, the routines or
labels in `selected.c` disagree with the decompiled routines in `status.json`,
an `.asm` file lacks its `; Analyst label: <name>; export span
0x<start>..0x<end>` header or the span is empty or reversed, a site's VA repeats,
a site would be shown zero times or more than once, or the PE metadata has no
`sha256`.

### Open questions

`python3 scripts/open_questions.py`, run after `text_database.py`, writes
`artifacts/dossier/questions.html` beside the other dossier pages. It gives
three findings the other pages label unresolved their own anchored section,
each in four parts. **Observed** shows values read at build time from the parsed
`engines.json` and `tyres.json` and the committed `analysis/` files, never typed
into the script. **Why it matters** links the places on the other pages that
stay unresolved because of it. **Possible readings** lists only the
alternatives the observations leave open, each labelled *untested*, unranked.
**What would decide it** names the committed routine or the comparison that
would settle it. The page resolves nothing and assigns no meaning to the
unknown line, words or bytes.

- `#indigo`: `INDIGO`'s record and untagged line with its line number and
  tokens, the `ENGDATA.DAT` SHA-256, `INDIGO`'s own declarations, the
  `DEFAULT_TRACK` record the line names and the records whose `:INHERIT_TYPE`
  names it, and the tags `DEFAULT_TRACK` declares that `INDIGO` does not. It
  points at the engine loader at `0x005227f0` and the call of
  `copy_engine_record` it reads from `load_engine_database.asm`.
- `#sound-words`: the byte-checked `0x2d0` allocation and `+0x54` store from
  `field-evidence.json`, and the tyre loader's indexed stores into the table,
  read from `load_tyre_database.asm` (at `+0x3c` and `+0x78`, each within three
  instructions of loading the table address). Those two offsets and the
  allocation size give the layout above: fifteen unknown words, fifteen
  `START_RPM` values and fifteen rows of ten. It also lists each tyre's
  `:SOUND_INFO` entry count and how many tyres read their table from each
  source.
- `#pcg-extra-bytes`: from `pcg-index.json`, the collection holding `_loadbar`
  and `_loadbr2`, each graphic's offset, size, declared payload, span and extra
  bytes, and all 32 header words side by side, marking each word whose value
  differs from that word in every graphic of the collection without extra bytes.

The engine page's note on `INDIGO`'s line, the tyre page's note on the sound
table's leading words (`#sound-table-words`) and the PCG catalogue's
extra-bytes label on the two graphics link to their section. The script exits
non-zero without writing the page when an input is missing or malformed or no
longer shows the question: `INDIGO` is missing, has no untagged line, more than
one, or one whose tokens are not `INHERIT_TYPE DEFAULT_TRACK`; `DEFAULT_TRACK`
is not a record; `field-evidence.json` lacks the allocation size or the `+0x54`
store; the loader's indexed table stores are not at exactly two offsets that
split the allocation into an unknown block, a `START_RPM` block of the same size
and whole value rows; no tyre declares `:SOUND_INFO`; the graphics with extra
bytes are not exactly `_loadbar` and `_loadbr2`, 1,024 bytes each, in one
collection; the engine loader no longer calls the copy routine; an `.asm` file
lacks its span header; or the PE metadata has no `sha256`.

### Research directory

`python3 scripts/build_research.py`, run after `acquire_demo.py`, builds all of
the pages above into one self-contained directory, `artifacts/research/` by
default (`--game` and `--output` change the paths). It parses the three text
databases with `text_database.py` into a temporary working directory, so no
parsed JSON is published, and runs the tyre, engine and gearbox, compare records, PCG and
routine and open questions generators with their usual checks. The `analysis/` files the pages link
to, all 15 bounded `.asm` files, `field-evidence.json`, `pcg-index.json`,
`unpacked-manifest.json` and the annotated `status.json` and `selected.c`, are copied unchanged
to `evidence/` under their `analysis/` paths, and the pages link there instead
of into the repository. It also writes `index.html`, the "Explore findings"
entrance: it links the seven pages with a one-line description and the engine,
gearbox and tyre record counts, the number of gearboxes compared, the PCG collection and graphic counts, the
annotated routine count and the open question count, all computed from the inputs, and shows the `fr3.exe` SHA-256 and the producer
revision. Its `#tyre-tables` section, generated by `scripts/research_answers.py`
from the parsed `tyres.json`, answers "Do road, offroad and track tyres use
different tables?": how many tyres resolve each of the five tables to each
source record (in the demo the longitudinal and lateral tables come from
`DEFAULT_ROAD` for all 109 tyres, and the vertical load, camber thrust and sound
tables from `DEFAULT_ROAD` for 73, `DEFAULT_OFFROAD` for 23 and `DEFAULT_TRACK`
for 13), that those are record names in `TYREDATA.DAT` rather than an
established classification, one tyre's `INHERIT_TYPE` path, accessor and
byte-checked sites, and a pair of tyres with the same five table sources but
different effective scalar fields. The example and the pair are chosen from the
data, and the build fails when the data has neither. Its `#engine-torque-tables`
section, generated by the same script from the parsed `engines.json`, answers
"Which engines share a torque table, and what do they declare differently?"
from `effective_fields`: how many inheriting engines declare their own
`TORQUE_ARRAY` and how many inherit one (38 and 13 in the demo), the tables
read by more than one engine (8 in the demo, read by 21 engines), each listed by
its declaring record and line with the engines that read it and the other
mapped declarations each holds in effect, one engine's traced `INHERIT_TYPE`
path, the `MAX_RPM` its table's row count was read from, the record copy and
the torque zero fill, and where the comparison ends: each sharing engine's own
`TORQUE_MODIFIER` at `+ 0x24`, which is not combined with the table, and the
derived `+ 0x2c`, which gets no value. The example is chosen from the data, the
build fails when no table is shared, and `INDIGO` links its open question.
Values are shown as declared, and unresolved items stay labelled unresolved.

Every research page, the entrance included, carries the browser preview's
rights-holder notice (the credit, the official demo link and the removal-request
link) before its main content, and a link bar to the other seven pages. The pages
are built in a staging directory next to the output; `verify_research()` then
checks that all eight exist, that each has the notice before its `<h1>` and
names the same producer revision as `index.html`, that
none has a `<script>`, CSS `url()` or `@import`, or any external link or
resource other than the notice's two links, that every local link, fragment
included, resolves to a file and id inside the directory (so each record page's
`routines.html#<label>` and `routines.html#site-<va>` link must name a section
or site row on the routines page, built from the same `status.json`, and each
`gearboxes.html#<id>` and `engines.html#<id>` link on the compare page a declaration, store or
effective `TORQUE_ARRAY` row), and that the directory
holds no file other than the ones the script writes. Only then does the
staging directory replace the output; an existing output that holds anything
else is left alone. The directory is not committed because it holds game data.
Per decision #46 the Pages workflow builds it from the verified public demo and
publishes it under `research/` beside the browser preview, at
<https://omertekin2002.github.io/ford-racing-reverse-engineered/research/>; the
preview's landing page links it as "Explore findings". See
[the browser guide](browser.md#research-findings) for the build and takedown.

### Research packet

`python3 scripts/package_research.py`, run after `build_research.py` at the
same commit, packages the research directory as one citable ZIP,
`artifacts/fr3-research-<short revision>.zip` by default (`--research` and
`--output` change the paths; `--game` selects the extracted game directory used
for comparison). Before writing anything it re-runs
`check_output()` and `verify_research()` on the directory, checks every
`evidence/` file byte for byte against the `analysis/` file it was copied from
as committed at the current producer revision (read with `git show`, so evidence
copied from an uncommitted edit is refused), and checks that `index.html` names
that revision and the `fr3.exe` SHA-256 in its `analysis/pe-metadata.json`. It then
rebuilds all eight pages with the current generators and extracted game databases,
reading every analysis input (including tags and verification metadata) from
that Git revision into a temporary directory. Every page must match that fresh
build byte for byte, so changing a finding or count while keeping the revision,
notice and links intact is refused. It needs a Git checkout and the extracted
game databases. Any failure leaves the destination unchanged. The ZIP holds one folder,
`fr3-research-<short revision>/`, with every research file unchanged plus:

- `MANIFEST.json`: the edition name, the full producer revision, the `fr3.exe`
  SHA-256 and PE timestamp from the committed `analysis/pe-metadata.json`, the pinned demo
  archive SHA-256 and size from `scripts/fr3_common.py`, the Python and zlib
  versions, the list of checks the script ran, and each research file's size and
  SHA-256;
- `SHA256SUMS`, covering every other file in the folder, so
  `sha256sum -c SHA256SUMS` run inside the extracted folder checks it.

The ZIP is deterministic: sorted entries, mode 0644, compression level 9 and one
timestamp for every entry, `SOURCE_DATE_EPOCH` if set, otherwise 1980-01-01. The
same research directory, revision, Python and zlib give a byte-identical ZIP. It
is written to a temporary file beside the destination, reopened, checked with
`testzip()` and re-hashed against both manifests, and only then renamed into
place. An existing destination is replaced only if it is a regular file named
`fr3-research-*.zip`; a directory, a symlink or any other file is refused.

The manifest records which files the packet holds, the committed analysis
revision and pinned executable metadata, and the checks the pages passed. Page
comparison uses the current generators and local extracted databases; it does
not authenticate the generator source or those databases against that revision
or the pinned executable. The `fr3.exe` and demo archive hashes are copied
from the repository, not recomputed from the files; the instruction evidence is
not re-derived and Ghidra is not re-run. Like the research directory, the
packet holds game data and stays out of Git.

The Pages workflow runs it on every deploy, on the published `research/`
directory, with `SOURCE_DATE_EPOCH` set to the commit time, and publishes the
packet at the stable URL
<https://omertekin2002.github.io/ford-racing-reverse-engineered/downloads/fr3-research-latest.zip>,
linked from the preview's landing page. The URL always serves the latest
deploy's packet; its folder name and `MANIFEST.json` say which revision it is.
`verify_web.py` checks that the published packet holds exactly the published
`research/` files at the revision `research/index.html` names; see
[the browser guide](browser.md#research-findings).

### Analysis bundle

`python3 scripts/package_analysis.py` packages a layered reproduction bundle,
`artifacts/fr3-analysis-<short revision>.zip` by default (`--research` and
`--output` change the paths). It needs a clean Git checkout, the acquired demo
and the research directory from `build_research.py` built at the same commit;
it does not need Ghidra. The ZIP holds one folder,
`fr3-analysis-<short revision>/`, with these layers:

- **Source:** `README.md`, `ruff.toml` and the tracked files under `scripts/`,
  `tests/`, `recovered/`, `docs/` and `analysis/`, read from Git at the producer
  revision (`git ls-tree` and `git cat-file`). Any modified, staged, deleted or
  untracked file under those paths refuses the build, so the bundle never holds
  an edit its revision does not.
- **Text databases:** `text-databases/engines.json`, `gearboxes.json` and
  `tyres.json`, regenerated from the extracted demo with
  `text_database.write_databases()`.
- **Research:** the research directory unchanged under `research/`, after
  `package_research.read_research()` has checked it as the research packet
  does, including a byte-for-byte comparison with a fresh build at the revision.
- **Ghidra (optional):** `artifacts/ghidra/` (the five files `ExportFord.java`
  writes) and `artifacts/fr3-demo-annotated.gzf`, only when all are present and
  `decompiled.c` and the `.gzf` match `baseline_c_sha256` and
  `annotated_snapshot_sha256` in the committed `analysis/verification.json`, and
  `status.json` matches the committed `analysis/baseline-status.json`. The other
  three export files are packaged as found; the record does not cover them.

`MANIFEST.json` names the edition, the producer revision, the `fr3.exe` SHA-256
and PE timestamp from the committed `analysis/pe-metadata.json`, the pinned demo
archive SHA-256 and size, the Python, zlib, pefile and capstone versions, the
layers, each packaged file's path, size and SHA-256, and four verification
levels, each `performed` or `unavailable` with the checks and their counts:

| Level | What the bundle did |
| --- | --- |
| `read` | Checked the research pages with `read_research()` |
| `data` | Ran `verify_findings.py`'s `data` checks in-process on the acquired demo |
| `instructions` | Ran `verify_findings.py`'s `instructions` checks in-process on `inputs/fr3.exe` |
| `full` | Compared the Ghidra outputs' hashes with the committed verification record of `verified_utc`; Ghidra and the `full` checks are **not** re-run |

When any Ghidra output is missing, `full` is `unavailable`: the manifest names
the missing paths and the recovery commands (`scripts/setup_tools.py`, then
`scripts/run_analysis.py`, then `scripts/verify_findings.py`, then committing
the regenerated `analysis/` before rebuilding the research pages and the
bundle, since the full verification rewrites `analysis/verification.json`), and
no Ghidra output is packaged. A present output whose hash differs from the record refuses
the build instead of being left out. `SHA256SUMS` covers every other file, so
`sha256sum -c SHA256SUMS` passes inside the extracted folder.

The bundle never holds `inputs/` (the demo archive, its extraction or
`fr3.exe`), decoded resources, `artifacts/pe/`, `artifacts/logs/` or a Ghidra
project, and a final guard refuses any `.exe`, `.dll` or PE file. It is
deterministic in the same way as the research packet: sorted entries, mode
0644, compression level 9 and the `SOURCE_DATE_EPOCH` or 1980-01-01 timestamp,
so two runs at the same revision with the same inputs, Python and zlib give a
byte-identical ZIP. It is written to a temporary file, reopened and re-hashed
against both manifests, and renamed into place; only a previous
`fr3-analysis-*.zip` is overwritten. A missing demo or research directory exits
3 with the command that provides it; a failing check exits 1 naming the level
and check, and any refusal leaves the previous bundle in place. The bundle
holds game data and stays out of Git.

## Validation and limits

[Verification results](../analysis/verification.json) cover the exact executable,
all game files, all tags, all identified compressed resources, every PCG index,
the selected instruction sites, table dimensions, export counts and C layout
assertions. All 274 instruction sites were byte-checked against the pinned
`fr3.exe` at `field_instruction_sites_verified_utc`, with the comparison
`verify_findings.py` makes; the other results date from `verified_utc`. Nine parser tests additionally reject malformed synthetic
resources, and eight helper tests cover virtual-address bounds and file identity checks.
`verify_findings.py` runs these checks at three levels (see
[the README](../README.md#validate-without-rebuilding)). `--level data` needs
only the demo from `acquire_demo.py` and checks the archive, executable, game
files, tags, compressed resources, PCG indexes, text databases and tyre table
dimensions. `--level instructions` needs only `inputs/fr3.exe`: it checks the
PE build metadata and imports, byte-checks every `field-evidence.json` site,
and regenerates the bounded disassembly with `extract_selected.py` into a
temporary directory, failing on any line or file that differs from the
committed `analysis/selected/`. `--level full`, the default and the only level
that rewrites `verification.json`, adds the Ghidra baseline, annotated-export,
snapshot-import and C layout checks, and needs `scripts/run_analysis.py`'s
outputs and `gcc`. A level whose inputs are missing reports itself unavailable
(exit code 3) instead of failing part-way, and `--report` records which checks
a run performed and which levels it did not.
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

