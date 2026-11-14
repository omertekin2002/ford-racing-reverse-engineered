"""Generate an offline HTML catalogue of the PCG graphics collections, as indexed.

Inputs, all committed under analysis/ and only read here:
  * pcg-index.json from scripts/index_pcg.py: each collection's header fields
    and directory, and each graphic's 128-byte header words and byte spans.
  * unpacked-manifest.json: the compressed and decoded size and SHA-256 of each
    collection.
  * pe-metadata.json: the executable's identity.
  * verification.json: the verified collection and entry totals.

The output is one static HTML file, artifacts/dossier/pcg.html by default, with
inline CSS, no JavaScript and no external resources. It shows the PCG directory
structure only: no pixel data is decoded or shown. Every graphic gets exactly
one decoding status from STATUSES; today that is `not decoded` for all of them.
Only the header words at +8 (width), +12 (height) and +0x28 (declared payload
bytes) are labelled with a meaning; every other word is shown raw. Bytes past
the declared payload are labelled unresolved.

The script refuses to write the page, and exits non-zero, when an input is
missing or malformed, collection paths repeat, a collection's count disagrees
with its entries, entry indexes are not 0..count-1 in order, the width, height
or declared payload disagree with their header words, extra_bytes disagrees
with the span, payload_base disagrees with (16 + count*16 + 127) & ~127, a
collection has no unpacked-manifest.json entry, the totals disagree with
verification.json, or the PE metadata has no sha256.
"""
import argparse
from pathlib import Path
import re

from dossier_common import STYLE, check_fields, check_pe, e, load_json, nav, producer_revision, relative_href
from text_database import REPO_ROOT, require

PAGE = "pcg.html"
PCG_INDEX = REPO_ROOT / "analysis/pcg-index.json"
MANIFEST = REPO_ROOT / "analysis/unpacked-manifest.json"
PE_METADATA = REPO_ROOT / "analysis/pe-metadata.json"
VERIFICATION = REPO_ROOT / "analysis/verification.json"
VIEW_ASM = REPO_ROOT / "analysis/selected/build_pcg_view.asm"
GRAPHIC_HEADER_BYTES = 128
HEADER_WORDS = 32
# Header word index -> established meaning; every other word's meaning is not established.
ESTABLISHED_WORDS = {2: "width", 3: "height", 10: "declared payload bytes"}
NOT_ESTABLISHED = "meaning not established"
# The fixed decoding-status vocabulary, key -> label. A later decoder adds its statuses here.
STATUSES = {"not-decoded": "not decoded: pixel encoding not established"}
COLLECTION_FIELDS = {"path": str, "count": int, "year_word": int, "creation_metadata_hex": str, "reserved_word": int,
                     "payload_base": int, "entries": list}
ENTRY_FIELDS = {"index": int, "name": str, "name_raw_hex": str, "file_offset": int, "width": int, "height": int,
                "header_words": list, "declared_payload_bytes": int, "span_bytes": int, "extra_bytes": int}
MANIFEST_FIELDS = {"path": str, "input_size": int, "decoded_size": int, "input_sha256": str, "decoded_sha256": str}
EXTRA_STYLE = """section.collection { border-top: 2px solid #888; margin-top: 2em; }
table.words td { border-color: #e2e2e2; padding: 0 0.4em; white-space: nowrap; }
"""


def payload_base(count):
    return (16 + count * 16 + 127) & ~127


def check_ints(value, fields, label):
    """check_fields() for objects whose integer fields must not be booleans or negative."""
    check_fields(value, fields, label)
    for key, kind in fields.items():
        if kind is int:
            require(not isinstance(value[key], bool) and value[key] >= 0, f"{label}.{key} must be a non-negative integer")


def decoding_status(entry):
    """Return the entry's key in STATUSES. No pixel encoding is decoded yet, so every entry is not decoded."""
    del entry
    return "not-decoded"


def slug(path):
    return re.sub(r"[^A-Za-z0-9_.-]", "-", path)


def collection_id(collection):
    return f"pcg-{slug(collection['path'])}"


def entry_id(collection, entry):
    return f"{collection_id(collection)}-e{entry['index']}"


def check_entry(entry, i, where):
    check_ints(entry, ENTRY_FIELDS, where)
    require(entry["index"] == i, f"{where}.index is {entry['index']}; indexes must run 0..count-1 in order")
    words = entry["header_words"]
    require(len(words) == HEADER_WORDS and all(isinstance(word, int) and not isinstance(word, bool) and 0 <= word < 2**32
                                               for word in words),
            f"{where}.header_words must be {HEADER_WORDS} unsigned 32-bit integers")
    for word, field in ((2, "width"), (3, "height"), (10, "declared_payload_bytes")):
        require(entry[field] == words[word], f"{where}.{field} is {entry[field]} but header word {word} "
                                             f"(+0x{word * 4:02x}) is {words[word]}")
    expected = entry["span_bytes"] - GRAPHIC_HEADER_BYTES - entry["declared_payload_bytes"]
    require(entry["extra_bytes"] == expected, f"{where}.extra_bytes is {entry['extra_bytes']} but span_bytes - "
                                              f"{GRAPHIC_HEADER_BYTES} - declared_payload_bytes is {expected}")


def check_inputs(collections, manifest, verification):
    """Check every input against each other; return {collection path: manifest entry}."""
    require(isinstance(manifest, list), "unpacked-manifest.json must be a list")
    resources = {}
    for i, item in enumerate(manifest):
        check_ints(item, MANIFEST_FIELDS, f"unpacked-manifest.json[{i}]")
        require(item["path"] not in resources, f"unpacked-manifest.json has duplicate path {item['path']!r}")
        resources[item["path"]] = item
    require(isinstance(collections, list) and collections, "pcg-index.json must be a non-empty list")
    paths, ids, found = set(), set(), {}
    for i, collection in enumerate(collections):
        where = f"pcg-index.json[{i}]"
        check_ints(collection, COLLECTION_FIELDS, where)
        path = collection["path"]
        where = f"pcg-index.json {path!r}"
        require(path not in paths, f"pcg-index.json has duplicate collection path {path!r}")
        paths.add(path)
        require(collection["count"] == len(collection["entries"]),
                f"{where}: count is {collection['count']} but it lists {len(collection['entries'])} entries")
        require(collection["payload_base"] == payload_base(collection["count"]),
                f"{where}: payload_base is {collection['payload_base']} but (16 + count*16 + 127) & ~127 is "
                f"{payload_base(collection['count'])}")
        require(path in resources, f"{where} has no unpacked-manifest.json entry")
        found[path] = resources[path]
        new_ids = [collection_id(collection)]
        for j, entry in enumerate(collection["entries"]):
            check_entry(entry, j, f"{where}.entries[{j}]")
            new_ids.append(entry_id(collection, entry))
        for anchor in new_ids:
            require(anchor not in ids, f"{where}: anchor {anchor!r} is not unique")
            ids.add(anchor)
    check_ints(verification, {"pcg_collections_verified": int, "pcg_entries_verified": int}, "verification.json")
    entries = sum(len(collection["entries"]) for collection in collections)
    require(len(collections) == verification["pcg_collections_verified"],
            f"pcg-index.json has {len(collections)} collections but verification.json verified "
            f"{verification['pcg_collections_verified']}")
    require(entries == verification["pcg_entries_verified"],
            f"pcg-index.json has {entries} entries but verification.json verified {verification['pcg_entries_verified']}")
    return found


def num(value):
    return f'<span class="num">{e(value)}</span>'


def header_words(words):
    rows = []
    for i, word in enumerate(words):
        meaning = f"<strong>{e(ESTABLISHED_WORDS[i])}</strong>" if i in ESTABLISHED_WORDS else NOT_ESTABLISHED
        rows.append(f'<tr><td class="num">+0x{i * 4:02x}</td><td class="num">{word}</td>'
                    f'<td class="num">0x{word:08x}</td><td>{meaning}</td></tr>')
    return (f'<details><summary>{HEADER_WORDS} header words</summary><table class="words"><tr><th>Offset</th>'
            f'<th>Value</th><th>Hex</th><th>Meaning</th></tr>{"".join(rows)}</table></details>')


def entry_row(collection, entry):
    """Return one entry's table row on a single line, so `grep -c 'class="status'` counts entries."""
    extra = num(entry["extra_bytes"])
    if entry["extra_bytes"]:
        extra += (' <span class="label">unresolved</span>: what these bytes past the declared payload hold is not '
                  "established")
    status = decoding_status(entry)
    anchor = e(entry_id(collection, entry))
    return (f'<tr id="{anchor}"><td class="num"><a href="#{anchor}">{e(entry["index"])}</a></td>'
            f'<td><code>{e(entry["name"])}</code></td><td><code>{e(entry["name_raw_hex"])}</code></td>'
            f'<td>{num(entry["file_offset"])}</td><td>{num(entry["width"])} &times; {num(entry["height"])}</td>'
            f'<td>{num(entry["declared_payload_bytes"])}</td><td>{num(entry["span_bytes"])}</td><td>{extra}</td>'
            f'<td class="status status-{e(status)}">{e(STATUSES[status])}</td>'
            f'<td>{header_words(entry["header_words"])}</td></tr>')


def render(collections, resources, pe, revision, hrefs):
    """Return the catalogue page. check_inputs() must have accepted the inputs first."""
    entries = sum(len(collection["entries"]) for collection in collections)
    parts = [f'<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">'
             f'<title>Ford Racing 3 demo PCG catalogue</title><style>{STYLE}{EXTRA_STYLE}</style></head><body>',
             nav(PAGE),
             '<h1>Ford Racing 3 demo: PCG catalogue</h1><dl>',
             f'<dt>Executable</dt><dd><code>{e(pe.get("file", "fr3.exe"))}</code> SHA-256 <code>{e(pe["sha256"])}</code>, '
             f'PE timestamp {e(pe.get("timestamp_header_utc", "unknown"))}</dd>',
             f'<dt>Inputs</dt><dd><a href="{e(hrefs["index"])}">{e(Path(hrefs["index"]).name)}</a>, '
             f'<a href="{e(hrefs["manifest"])}">{e(Path(hrefs["manifest"]).name)}</a></dd>',
             f'<dt>Producer revision</dt><dd><code>{e(revision)}</code> (<code>scripts/pcg_catalogue.py</code>)</dd>',
             f'<dt>Collections</dt><dd>{len(collections)}</dd><dt>Graphics</dt><dd>{entries}</dd></dl>',
             '<p class="scope">Scope: PCG directory structure only; no pixel data is decoded or shown. Each graphic '
             'carries a decoding status, and today every one is not decoded because the pixel encoding is not '
             'established. Header words other than width, height and declared payload are shown raw, and their '
             'meaning is not established. Field names such as <code>year_word</code> are the indexer\'s analyst '
             'labels, not recovered symbols.</p>',
             '<h2 id="established">What is established</h2><ul>'
             '<li>A collection starts with a 16-byte header of four little-endian words: the entry count, then '
             '<code>year_word</code>, <code>creation_metadata_hex</code> and <code>reserved_word</code>, whose meaning '
             'is not established.</li>'
             '<li>16-byte directory entries follow: a payload-relative offset word and a 12-byte NUL-padded name.</li>'
             '<li>The payload base is <code>(16 + count*16 + 127) &amp; ~127</code>, consistent with the instructions '
             f'at <code>0x00423b20</code> (<a href="{e(hrefs["asm"])}">build_pcg_view.asm</a>).</li>'
             '<li>Each graphic starts with a 128-byte header of 32 little-endian words: width at <code>+8</code>, '
             'height at <code>+12</code> and declared payload bytes at <code>+0x28</code>. A graphic spans to the next '
             'graphic in file order, or to the end of the file; extra bytes are the span minus the header and the '
             'declared payload.</li></ul>',
             '<h3>Decoding statuses</h3><ul>'
             + "".join(f"<li><code>{e(key)}</code>: {e(label)}</li>" for key, label in STATUSES.items()) + "</ul>",
             '<h2 id="collections">Collections</h2><table><tr><th>Collection</th><th>Entries</th><th>Payload base</th>'
             '<th><code>year_word</code></th><th><code>creation_metadata_hex</code></th><th><code>reserved_word</code></th>'
             '<th>Compressed bytes</th><th>Compressed SHA-256</th><th>Decoded bytes</th><th>Decoded SHA-256</th></tr>']
    for collection in collections:
        resource = resources[collection["path"]]
        parts.append(f'<tr><td><a href="#{e(collection_id(collection))}">{e(collection["path"])}</a></td>'
                     f'<td>{num(collection["count"])}</td><td>{num(collection["payload_base"])}</td>'
                     f'<td>{num(collection["year_word"])}</td><td><code>{e(collection["creation_metadata_hex"])}</code></td>'
                     f'<td>{num(collection["reserved_word"])}</td><td>{num(resource["input_size"])}</td>'
                     f'<td><code>{e(resource["input_sha256"])}</code></td><td>{num(resource["decoded_size"])}</td>'
                     f'<td><code>{e(resource["decoded_sha256"])}</code></td></tr>')
    parts.append("</table>")
    for collection in collections:
        resource = resources[collection["path"]]
        parts.append(f'<section class="collection" id="{e(collection_id(collection))}"><h2>{e(collection["path"])}</h2>'
                     '<p><a href="#collections">Back to the collection index</a></p>'
                     f'<dl><dt>Entries</dt><dd>{num(collection["count"])}</dd>'
                     f'<dt>Payload base</dt><dd>{num(collection["payload_base"])}</dd>'
                     f'<dt>Header words (meaning not established)</dt><dd><code>year_word</code> {num(collection["year_word"])}, '
                     f'<code>creation_metadata_hex</code> <code>{e(collection["creation_metadata_hex"])}</code>, '
                     f'<code>reserved_word</code> {num(collection["reserved_word"])}</dd>'
                     f'<dt>Compressed</dt><dd>{num(resource["input_size"])} bytes, SHA-256 '
                     f'<code>{e(resource["input_sha256"])}</code></dd>'
                     f'<dt>Decoded</dt><dd>{num(resource["decoded_size"])} bytes, SHA-256 '
                     f'<code>{e(resource["decoded_sha256"])}</code></dd></dl>'
                     '<table><tr><th>Index</th><th>Name</th><th>Name bytes (hex)</th><th>File offset</th>'
                     '<th>Width &times; height</th><th>Declared payload bytes</th><th>Span bytes</th><th>Extra bytes</th>'
                     '<th>Decoding status</th><th>Header words</th></tr>')
        parts.extend(entry_row(collection, entry) for entry in collection["entries"])
        parts.append("</table></section>")
    parts.append("</body></html>\n")
    return "\n".join(parts)


def build(index_path, manifest_path, pe_path, verification_path, output, revision=None):
    """Read and check every input, then write the page; return (collections, entries)."""
    collections = load_json(index_path, "PCG index")
    manifest = load_json(manifest_path, "Unpacked manifest")
    pe = load_json(pe_path, "PE metadata")
    verification = load_json(verification_path, "Verification results")
    check_pe(pe)
    resources = check_inputs(collections, manifest, verification)
    hrefs = {"index": relative_href(Path(index_path).resolve(), output),
             "manifest": relative_href(Path(manifest_path).resolve(), output), "asm": relative_href(VIEW_ASM, output)}
    page = render(collections, resources, pe, revision or producer_revision(), hrefs)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text(page, encoding="utf-8")
    return len(collections), sum(len(collection["entries"]) for collection in collections)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--index", type=Path, default=PCG_INDEX,
                        help="PCG index written by scripts/index_pcg.py (default: %(default)s)")
    parser.add_argument("--manifest", type=Path, default=MANIFEST,
                        help="Compressed and decoded resource hashes (default: %(default)s)")
    parser.add_argument("--pe", type=Path, default=PE_METADATA, help="fr3.exe identity (default: %(default)s)")
    parser.add_argument("--verification", type=Path, default=VERIFICATION,
                        help="Verified PCG totals (default: %(default)s)")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "artifacts/dossier" / PAGE,
                        help="HTML file to write, next to the other dossier pages (default: %(default)s)")
    args = parser.parse_args()
    try:
        collections, entries = build(args.index, args.manifest, args.pe, args.verification, args.output)
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        raise SystemExit(f"pcg_catalogue.py: {error}") from None
    print(f"Wrote {collections} collections and {entries} graphics to {args.output}")


if __name__ == "__main__":
    main()
