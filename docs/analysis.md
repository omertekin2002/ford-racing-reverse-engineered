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
[Tyre scalar inheritance](#tyre-scalar-inheritance). It does not resolve engine
inheritance or the colon-less `INDIGO` line, map other fields to the C layout
offsets below, or handle the other text files. The meaning of the
sound table's first fifteen words, described below, is still unknown.

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

Engine inheritance in `ENGDATA.DAT` and the colon-less
`INHERIT_TYPE DEFAULT_TRACK` line in `INDIGO` remain unresolved.

[Sixty-four byte-checked instruction sites](../analysis/selected/field-evidence.json)
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
dimensions. `:INHERIT_TYPE` links to the parent and is labelled unresolved: none
of the parent's values are copied into the child, because engine inheritance is
not resolved. The colon-less `INHERIT_TYPE DEFAULT_TRACK` line in `INDIGO` is
shown verbatim as an untagged line, not as inheritance, with a note that whether
the game honours it is not established. The meaning and units of the values,
including the torque arrays, are not interpreted. A "Loaded by" line near the
top links the database's load and copy routines (`fr3_load_engine_database`
`0x005227f0` and `fr3_copy_engine_record` `0x00522c80`, or
`fr3_load_gearbox_database` `0x00523220` and `fr3_copy_gearbox_record`
`0x00523470`) to their sections on `routines.html`, and each unresolved
`:INHERIT_TYPE` note links the copy routine; the inheritance itself stays
unresolved. The script exits non-zero
without writing either page when an input is missing or malformed: records that
are not a list or lack `type`, `line` or `fields`, duplicate record names, an
`:INHERIT_TYPE` that does not name an earlier record of the same file, PE
metadata without `sha256`, or a load or copy routine that is missing from
`status.json` or labelled differently there. The pages are not committed because they hold game
data; [`build_research.py`](#research-directory) builds them with the other
research pages, for publishing per decision #46.

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
the 32 sites is shown exactly once. The page says that every label is
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
parsed JSON is published, and runs the tyre, engine and gearbox, PCG and
routine and open questions generators with their usual checks. The `analysis/` files the pages link
to, all 15 bounded `.asm` files, `field-evidence.json`, `pcg-index.json`,
`unpacked-manifest.json` and the annotated `status.json` and `selected.c`, are copied unchanged
to `evidence/` under their `analysis/` paths, and the pages link there instead
of into the repository. It also writes `index.html`, the "Explore findings"
entrance: it links the six pages with a one-line description and the engine,
gearbox and tyre record counts, the PCG collection and graphic counts, the
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
data, and the build fails when the data has neither. Values are shown as declared, and unresolved items stay labelled
unresolved.

Every research page, the entrance included, carries the browser preview's
rights-holder notice (the credit, the official demo link and the removal-request
link) before its main content, and a link bar to the other six pages. The pages
are built in a staging directory next to the output; `verify_research()` then
checks that all seven exist, that each has the notice before its `<h1>`, that
none has a `<script>`, CSS `url()` or `@import`, or any external link or
resource other than the notice's two links, that every local link, fragment
included, resolves to a file and id inside the directory (so each record page's
`routines.html#<label>` and `routines.html#site-<va>` link must name a section
or site row on the routines page, built from the same `status.json`), and that the directory
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
rebuilds all seven pages with the current generators and extracted game databases,
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

## Validation and limits

[Verification results](../analysis/verification.json) cover the exact executable,
all game files, all tags, all identified compressed resources, every PCG index,
the selected instruction sites, table dimensions, export counts and C layout
assertions. All 64 instruction sites were byte-checked against the pinned
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

