"""The static instruction evidence for how the engine loader reads INDIGO's colon-less INHERIT_TYPE line.

INDIGO_GAPS lists, gap by gap, the analysis/selected/field-evidence.json sites (by VA) the reading rests on and says
in plain words what they show. scripts/open_questions.py checks and shows them on questions.html#indigo, and
scripts/text_database.py refuses to apply the allow-listed line (APPLIED_UNTAGGED_INHERIT) when any of these sites is
missing, so the page and the data rest on one list.
"""

# The #indigo instruction evidence: the static evidence for how the engine loader reads INDIGO's colon-less line,
# gap by gap. Each gap lists the field-evidence.json sites (by VA) it rests on and says, in plain words, what they
# show. The page states a reading only when every gap is evidenced: every site present, and the checks that
# check_indigo_evidence() runs on the committed disassembly and analysis/tags.json pass.
TAG_READER = 0x0042D0A0
NEXT_TAG = 0x0042E530
COLON_SEARCH = 0x0042D2A0
SEEK_TAG = 0x0042E5A0
# The engine loader's `cmp eax, imm32` that selects the INHERIT_TYPE branch; its immediate is the tag ID.
INHERIT_DISPATCH = 0x00522B1D
# The tag registry (extract_tag_registry.TABLE_VA, not imported here because that module needs pefile), and the data
# sites for INHERIT_TYPE's entry in it (REGISTRY + 4 * its ID) and the string that entry points to.
REGISTRY, REGISTRY_ENTRY, REGISTRY_STRING = 0x00594D94, 0x00595004, 0x00564390
# The entries of the tag registry that lookup mode 2 searches (register_application_tags.asm and the table lookup's
# bounds): 1..0x16a of the 0x16b, compared ignoring case.
LOOKUP_FIRST, LOOKUP_LAST = 1, 0x16A
INDIGO_GAPS = (
    {"id": "reader", "title": "Which tag reader ENGDATA.DAT is read with",
     "shows": "The engine loader opens <code>cars\\engdata</code> with reader type 0 (<code>EBX = 0</code>). The reader "
              "opening keeps that type, jumps through its table to the type 0 case, which uses the format string "
              "<code>data\\ascii\\%s.dat</code> and stores 0 as the reader's type dword. At the head of its tag loop "
              "the loader passes that reader and lookup mode 2 to the next-tag dispatcher at "
              "<code>0x0042e530</code>, which reads the type dword and calls <code>0x0042d0a0</code> for type 0. "
              "This page calls <code>0x0042d0a0</code> the ASCII tag reader for that reason; the label is the "
              "analyst's.",
     "sites": (0x00522828, 0x0052282A, 0x00522832, 0x00581CB4, 0x00522839, 0x004F8F80, 0x004F8FBD, 0x0042E92F,
               0x0042E943, 0x0042E961, 0x0042E96B, 0x0042E910, 0x0042E973, 0x0054BB30, 0x0042E984, 0x0052283E,
               0x00522848, 0x0052284D, 0x0052284F, 0x0042E535, 0x0042E541, 0x0042E543, 0x0042E547)},
    {"id": "colon-before", "title": "How the tag reader handles ':' before a token",
     "shows": "The reader first calls the separator skip, which reads again only for tab, LF, CR, space, "
              "<code>(</code>, <code>)</code>, <code>,</code>, <code>;</code> and <code>{</code> and gives any other "
              "character back, so <code>:</code> stays in the stream. The reader then reads <code>:</code>: its byte "
              "in the character table is <code>0x0c</code>, with no <code>0xc0</code> bit, it is not <code>!</code>, "
              "the byte has no <code>0xe0</code> bit, it is not <code>-</code> or <code>+</code>, and it is none of "
              "<code>[</code>, <code>=</code>, <code>}</code> or <code>]</code>. So the reader keeps it only as the "
              "previous character and reads the next one without starting a token. <code>I</code>, the first "
              "letter of <code>INHERIT_TYPE</code>, has the byte <code>0x48</code>, with the <code>0x40</code> bit, "
              "and the previous character is <code>:</code> or, after the separator skip, 0, neither of them "
              "<code>\\</code>. So the token starts at <code>I</code> whether or not a colon comes before it.",
     "sites": (0x0042D0B2, 0x0042CFDE, 0x0042CFFA, 0x0042D0C9, 0x0042D0E0, 0x0042D125, 0x00597AA7, 0x0042D12C,
               0x0042D212, 0x0042D21F, 0x0042D226, 0x0042D25E, 0x0042D262, 0x0042D266, 0x0042D230, 0x0042D239,
               0x0042D242, 0x0042D24B, 0x0042D256, 0x0042D259, 0x00597AB6, 0x0042D132, 0x0042D135, 0x0042D151)},
    {"id": "colon-after", "title": "Where a token ends",
     "shows": "After a token's first character the reader appends each character it reads until the delimiter "
              "test returns non-zero. The test returns 1 for <code>:</code> (<code>0x3a</code>) and for space "
              "(<code>0x20</code>) and 0 for <code>_</code> (<code>0x5f</code>). So <code>INHERIT_TYPE</code> is "
              "collected whole and ends at the space before <code>DEFAULT_TRACK</code>, and a <code>:</code> right "
              "after a token would end it rather than join it.",
     "sites": (0x0042D15C, 0x0042D175, 0x0042D17F, 0x0042D186, 0x0042D18C, 0x0042D05E, 0x0042D061, 0x0042D072,
               0x0042D056, 0x0042D074, 0x0042D077, 0x0042D07E, 0x0042D080, 0x0042D083, 0x0042D06D, 0x0042D06F,
               0x0042D08E, 0x0042D091)},
    {"id": "lookup", "title": "How the token's name is looked up",
     "shows": "The reader passes the token and the loader's mode 2 to the name lookup at <code>0x0042d310</code>. "
              "It searches the table registered for mode 2: the tag registry at <code>0x00594d94</code>, with the "
              "values 0 and <code>0x16b</code>, so entries 1 to <code>0x16a</code>. The search is a binary search "
              "over 4-byte entries whose callback compares the two strings after adding <code>0x20</code> to "
              "<code>A</code>&ndash;<code>Z</code> in both, so the compare ignores case and the token itself is "
              "not changed. Only a result of <code>-0x12</code>, nothing found, leads to the second lookup in "
              "mode 1. The same search, run over the registry in <code>tags.json</code> with those bounds and that "
              "compare, returns the ID shown below for <code>INHERIT_TYPE</code>.",
     "sites": (0x0042D0AF, 0x0042D1DE, 0x0042D1E1, 0x0042D1E7, 0x0042D316, 0x0042D318, 0x0042D31A, 0x0042D31F,
               0x0042D324, 0x0042D338, 0x004FA473, 0x004FA478, 0x004FA47D, 0x004FA482, 0x004FA484, 0x0042E359,
               0x0042E365, 0x0042E36B, 0x0042E371, 0x0042E89F, 0x0042E8A2, 0x0042E8A8, 0x0042E8B0, 0x0042E8BB,
               0x0042E8C5, 0x0042E8CA, 0x0042E8CF, 0x0042E8D4, 0x0042E8D7, 0x0042E8DD, 0x0042F453, 0x0042F455,
               0x0042F461, 0x0042F466, 0x0042F46B, 0x0042F470, 0x0042F475, 0x0042F477, 0x0042F479, 0x0042F485,
               0x0042E880, 0x0042E882, 0x0042E884, 0x00534987, 0x0053498B, 0x0053498F, 0x00534991, 0x00534996,
               0x0053499B, 0x0053499E, 0x005349B5, 0x0042E8EE, 0x0042D207, 0x00595004, 0x00564390)},
    {"id": "colon-search", "title": "Whether 0x0042d2a0, which reads up to the next ':', is on this path",
     "shows": "<code>0x0042d2a0</code> reads characters until <code>:</code>, gives that <code>:</code> back and "
              "then calls the ASCII tag reader. Its only call in the committed spans is in <code>0x0042e5a0</code>. "
              "No call to either routine is in the committed spans of the engine loader, the next-tag dispatcher, "
              "the tag reader or the routines it calls, listed below, so it is not on the path "
              "<code>ENGDATA.DAT</code>'s tags are read through. Only direct calls in those spans were searched.",
     "sites": (0x0042D2D2, 0x0042D2DB, 0x0042D2DF, 0x0042D2EE, 0x0042D2F7, 0x0042E5FF)},
    {"id": "dispatch", "title": "Whether INHERIT_TYPE reaches the engine copy",
     "shows": "The engine loader's dispatch compares the tag ID with the ID the lookup returns for "
              "<code>INHERIT_TYPE</code>; that branch reads the parent's name, looks the parent record up and calls "
              "the engine copy at <code>0x00522c80</code>. These sites were already byte-checked for "
              "<code>:INHERIT_TYPE</code>. The ID comes from the name lookup, not from the colon, so the colon-less "
              "token reaches the same branch.",
     "sites": (INHERIT_DISPATCH, 0x00522B3C, 0x00522B47)},
)

INDIGO_EVIDENCE_SITES = tuple(va for gap in INDIGO_GAPS for va in gap["sites"])
