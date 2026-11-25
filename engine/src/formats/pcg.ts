import { decodeDxt3 } from "./dxt";

export type PcgEncoding = "dxt3" | "raw-bgr-inva";

export interface PcgEntry {
  name: string;
  offset: number;
  spanSize: number;
  paletteSelector: number;
  encodingSelector: number;
  encoding: PcgEncoding;
  storedWidth: number;
  storedHeight: number;
  logicalWidth: number;
  logicalHeight: number;
  tileColumns: number;
  tileRows: number;
  alphaFlag: boolean;
  declaredPayloadBytes: number;
  extraBytes: number;
  /** Raw first-plane payload bytes (either DXT3 blocks or BGR+invA). */
  payload: Uint8Array;
}

export interface PcgCollection {
  count: number;
  year: number;
  creationMeta: number;
  reserved: number;
  payloadBase: number;
  entries: PcgEntry[];
}

export interface UiTextureTarget {
  pcgPath: string;
  entryName: string;
  /** Canonical registered key (lowercased with forward slashes and .psd suffix). */
  registeredKey: string;
}

const ASCII_DECODER = new TextDecoder("ascii");

export function parsePcg(bytes: Uint8Array): PcgCollection {
  if (bytes.length < 16) {
    throw new Error(`PCG too small (${bytes.length} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const year = view.getUint32(4, true);
  const creationMeta = view.getUint32(8, true);
  const reserved = view.getUint32(12, true);

  const dirEnd = 16 + count * 16;
  const payloadBase = (dirEnd + 127) & ~127;
  if (payloadBase > bytes.length) {
    throw new Error(`PCG directory extends past EOF (${payloadBase} > ${bytes.length})`);
  }

  const rawDir: { relativeOffset: number; name: string }[] = [];
  for (let i = 0; i < count; i++) {
    const off = 16 + i * 16;
    const relativeOffset = view.getUint32(off, true);
    const nameSlice = bytes.subarray(off + 4, off + 16);
    const nul = nameSlice.indexOf(0);
    const name = ASCII_DECODER.decode(nul >= 0 ? nameSlice.subarray(0, nul) : nameSlice);
    rawDir.push({ relativeOffset, name });
  }

  const sortedOffsets = [...new Set(rawDir.map((d) => payloadBase + d.relativeOffset))].sort((a, b) => a - b);
  const nextOffsetMap = new Map<number, number>();
  for (let i = 0; i < sortedOffsets.length; i++) {
    const cur = sortedOffsets[i]!;
    const next = i + 1 < sortedOffsets.length ? sortedOffsets[i + 1]! : bytes.length;
    nextOffsetMap.set(cur, next);
  }

  const entries: PcgEntry[] = [];
  for (const item of rawDir) {
    const start = payloadBase + item.relativeOffset;
    const end = nextOffsetMap.get(start) ?? bytes.length;
    if (start + 128 > end || end > bytes.length) {
      throw new Error(`PCG entry "${item.name}" out of bounds (${start}..${end})`);
    }
    const paletteSelector = view.getUint32(start + 0x00, true);
    const encodingSelector = view.getUint32(start + 0x04, true);
    const storedWidth = view.getUint32(start + 0x08, true);
    const storedHeight = view.getUint32(start + 0x0c, true);
    const logicalWidth = view.getUint32(start + 0x10, true);
    const logicalHeight = view.getUint32(start + 0x14, true);
    const tileColumns = view.getUint32(start + 0x1c, true);
    const tileRows = view.getUint32(start + 0x20, true);
    const alphaFlag = (view.getUint32(start + 0x24, true) & 1) !== 0;
    const declaredPayloadBytes = view.getUint32(start + 0x28, true);

    if (paletteSelector !== 0) {
      throw new Error(`Unsupported paletted PCG entry "${item.name}" (paletteSelector=${paletteSelector})`);
    }
    let encoding: PcgEncoding;
    let computedBytes: number;
    if (encodingSelector === 1) {
      encoding = "dxt3";
      computedBytes = 16 * Math.ceil(storedWidth / 4) * Math.ceil(storedHeight / 4);
    } else if (encodingSelector === 0) {
      encoding = "raw-bgr-inva";
      computedBytes = 4 * storedWidth * storedHeight;
    } else {
      throw new Error(`Unsupported PCG encoding selector ${encodingSelector} on "${item.name}"`);
    }

    if (computedBytes !== declaredPayloadBytes) {
      throw new Error(
        `PCG entry "${item.name}" size mismatch: computed ${computedBytes} != declared ${declaredPayloadBytes}`
      );
    }
    const payloadStart = start + 0x80;
    const payloadEnd = payloadStart + declaredPayloadBytes;
    if (payloadEnd > end) {
      throw new Error(`PCG entry "${item.name}" payload truncated (${payloadEnd} > ${end})`);
    }

    entries.push({
      name: item.name,
      offset: start,
      spanSize: end - start,
      paletteSelector,
      encodingSelector,
      encoding,
      storedWidth,
      storedHeight,
      logicalWidth,
      logicalHeight,
      tileColumns,
      tileRows,
      alphaFlag,
      declaredPayloadBytes,
      extraBytes: end - payloadEnd,
      payload: bytes.subarray(payloadStart, payloadEnd),
    });
  }

  return { count, year, creationMeta, reserved, payloadBase, entries };
}

/** Decode a PCG entry to tightly-packed RGBA8888 at its stored dimensions. */
export function decodePcgEntryRgba(entry: PcgEntry): Uint8Array {
  if (entry.encoding === "dxt3") {
    return decodeDxt3(entry.payload, entry.storedWidth, entry.storedHeight);
  }
  const src = entry.payload;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = src[i + 2]!;
    out[i + 1] = src[i + 1]!;
    out[i + 2] = src[i]!;
    out[i + 3] = 255 - src[i + 3]!;
  }
  return out;
}

/** Lookup an entry in a PCG collection (exact case-insensitive, then 8-char legacy fallback). */
export function findPcgEntry(collection: PcgCollection, name: string): PcgEntry | undefined {
  const target = name.toLowerCase();
  const exact = collection.entries.find((e) => e.name.toLowerCase() === target);
  if (exact) return exact;
  const shortTarget = target.slice(0, 8);
  return collection.entries.find((e) => e.name.toLowerCase().slice(0, 8) === shortTarget);
}

/**
 * Resolve a UI `:TEXTURE_ENUM` or `:CREATE_TEXTURE_GRAPHIC` path (e.g.
 * `GRAPHICS\GAME\STARTUS.PSD` or `GRAPHICS\GAME\BKGNDS\FORD`) to its PCG
 * collection path (`graphics/game/graphics.pcg`) and entry name (`startus`).
 */
export function resolveUiTextureRef(rawPath: string): UiTextureTarget | null {
  const cleaned = rawPath.trim().replace(/^"|"$/g, "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.toLowerCase() === "none") return null;

  const lower = cleaned.toLowerCase();
  const withoutExt = lower.endsWith(".psd") ? lower.slice(0, -4) : lower;
  const lastSlash = withoutExt.lastIndexOf("/");
  if (lastSlash < 0) {
    return {
      pcgPath: "graphics.pcg",
      entryName: withoutExt,
      registeredKey: `${withoutExt}.psd`,
    };
  }
  const dir = withoutExt.slice(0, lastSlash);
  const entryName = withoutExt.slice(lastSlash + 1);
  return {
    pcgPath: `${dir}/graphics.pcg`,
    entryName,
    registeredKey: `${withoutExt}.psd`,
  };
}
