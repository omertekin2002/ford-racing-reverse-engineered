export interface TranslationTable {
  entries: Map<string, string>;
  /** Case-folded lookup index (`key.toLowerCase()` -> canonical key). */
  lowerIndex: Map<string, string>;
  lineCount: number;
  commentLines: number;
  blankLines: number;
}

/**
 * Parse `LANGUAGE/TLATE_*.DAT` (UTF-16LE with `FF FE` BOM, CRLF line endings).
 * Preserves renderer control characters (`~` non-breaking space, `|` line break).
 */
export function parseTranslationTable(bytes: Uint8Array): TranslationTable {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xfe) {
    throw new Error("TLATE file missing UTF-16LE BOM (FF FE)");
  }
  const text = new TextDecoder("utf-16le").decode(bytes.subarray(2));
  const rawLines = text.split(/\r\n|\n/);
  // Trailing CRLF creates one empty element at the end of split().
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  const entries = new Map<string, string>();
  const lowerIndex = new Map<string, string>();
  let commentLines = 0;
  let blankLines = 0;

  for (const line of rawLines) {
    const trimmedStart = line.replace(/^ +/, "");
    if (trimmedStart.length === 0) {
      blankLines++;
      continue;
    }
    if (trimmedStart.startsWith("//")) {
      commentLines++;
      continue;
    }
    const spaceIdx = trimmedStart.indexOf(" ");
    const key = spaceIdx >= 0 ? trimmedStart.slice(0, spaceIdx) : trimmedStart;
    const value = spaceIdx >= 0 ? trimmedStart.slice(spaceIdx + 1) : "";
    entries.set(key, value);
    lowerIndex.set(key.toLowerCase(), key);
  }

  return {
    entries,
    lowerIndex,
    lineCount: rawLines.length,
    commentLines,
    blankLines,
  };
}

export function lookupTranslation(table: TranslationTable, key: string): string | undefined {
  if (!key || key === "0") return undefined;
  const exact = table.entries.get(key);
  if (exact !== undefined) return exact;
  const canonical = table.lowerIndex.get(key.toLowerCase());
  return canonical !== undefined ? table.entries.get(canonical) : undefined;
}
