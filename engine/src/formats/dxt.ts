export type TextureStorage = "dxt1" | "dxt3" | "a8r8g8b8" | "r8g8b8";

export interface TextureMip {
  width: number;
  height: number;
  data: Uint8Array;
}

export type TextureRecord = {
  name: string;
  flags: number;
} & ({
  kind: "reference";
} | {
  kind: "texture";
  formatClass: 1 | 2 | 3 | 5;
  storage: TextureStorage;
  scalar: number;
  paletteSelector: number;
  colorMetadata: number;
  mips: TextureMip[];
});

export interface TextureArchive {
  palettes256: Uint8Array[];
  palettes16: Uint8Array[];
  supplementaryPalettes256: Uint8Array[];
  /** File order is also texture selector order. Names can repeat across liveries. */
  textures: TextureRecord[];
}

function isSupportedFormatClass(value: number): value is 1 | 2 | 3 | 5 {
  return value === 1 || value === 2 || value === 3 || value === 5;
}

function isOpaqueFormatClass(formatClass: 1 | 2 | 3 | 5): boolean {
  // fr3.exe (0x442635) immediately normalizes format class 1 to 5; both are opaque DXT1 or 24-bit RGB.
  return formatClass === 1 || formatClass === 5;
}

function isPrintableAsciiName(rawName: Uint8Array): boolean {
  if (rawName.length < 2 || rawName.length > 256 || rawName[rawName.length - 1] !== 0) return false;
  for (let i = 0; i < rawName.length - 1; i++) {
    const byte = rawName[i]!;
    if (byte < 0x20 || byte > 0x7e) return false;
  }
  return true;
}

function mipChainByteSize(
  width: number, height: number, extraMipCount: number, storage: TextureStorage,
): number | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(extraMipCount)
    || width <= 0 || height <= 0 || extraMipCount < 0 || extraMipCount > 16) {
    return null;
  }
  const compressed = storage === "dxt1" || storage === "dxt3";
  const blockBytes = storage === "dxt3" ? 16 : 8;
  const pixelBytes = storage === "r8g8b8" ? 3 : 4;
  let total = 0;
  let mipWidth = width;
  let mipHeight = height;
  for (let level = 0; level <= extraMipCount; level++) {
    if (mipWidth === 0 || mipHeight === 0 || (compressed && (mipWidth % 4 !== 0 || mipHeight % 4 !== 0))) {
      return null;
    }
    total += compressed ? (mipWidth / 4) * (mipHeight / 4) * blockBytes : mipWidth * mipHeight * pixelBytes;
    if (!Number.isSafeInteger(total)) return null;
    mipWidth = Math.floor(mipWidth / 2);
    mipHeight = Math.floor(mipHeight / 2);
  }
  return total;
}

export function parseTexturesDxt(bytes: Uint8Array): TextureArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;

  function take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset) {
      throw new Error(`Truncated textures.DXT at ${offset} (need ${length} bytes)`);
    }
    const start = offset;
    offset += length;
    return bytes.subarray(start, offset);
  }

  function u32(): number {
    take(4);
    return view.getUint32(offset - 4, true);
  }

  function palettes(count: number, stride: number): Uint8Array[] {
    const group = take(count * stride);
    return Array.from({ length: count }, (_, i) => group.subarray(i * stride, (i + 1) * stride));
  }

  function isPlausibleRecordAt(pos: number): boolean {
    if (pos + 8 > bytes.length) return false;
    const nextFlags = view.getUint32(pos, true);
    const nextNameLength = view.getUint32(pos + 4, true);
    if (nextNameLength < 2 || nextNameLength > 256 || pos + 8 + nextNameLength > bytes.length) return false;
    if (!isPrintableAsciiName(bytes.subarray(pos + 8, pos + 8 + nextNameLength))) return false;
    if (nextFlags & 1) return true;
    const metaPos = pos + 8 + nextNameLength;
    if (metaPos + 28 > bytes.length) return false;
    const nextClass = view.getUint32(metaPos, true);
    const nextExtra = view.getUint32(metaPos + 4, true);
    const nextWidth = view.getUint32(metaPos + 12, true);
    const nextHeight = view.getUint32(metaPos + 16, true);
    return isSupportedFormatClass(nextClass) && nextExtra <= 16
      && nextWidth > 0 && nextWidth <= 8192 && nextHeight > 0 && nextHeight <= 8192;
  }

  function readRecord(recordIndex: number, allowEofAfter: boolean, strictTrailing: boolean): TextureRecord {
    const flags = u32();
    const nameLength = u32();
    const rawName = take(nameLength);
    if (!nameLength || rawName.indexOf(0) !== nameLength - 1
      || (strictTrailing && !isPrintableAsciiName(rawName))) {
      throw new Error(`Invalid textures.DXT name at record ${recordIndex}`);
    }
    const name = decoder.decode(rawName.subarray(0, -1));
    namesRead += nameLength;

    if (flags & 1) {
      return { kind: "reference", name, flags };
    }

    const formatClass = u32();
    const extraMipCount = u32();
    take(4);
    const scalar = view.getFloat32(offset - 4, true);
    const width = u32();
    const height = u32();
    const paletteSelector = u32();
    const colorMetadata = u32();
    if (!isSupportedFormatClass(formatClass)) {
      throw new Error(`Unsupported texture class ${formatClass} for ${name}`);
    }

    const uncompressedStorage: TextureStorage = isOpaqueFormatClass(formatClass) ? "r8g8b8" : "a8r8g8b8";
    let storage: TextureStorage = flags & 0x10
      ? uncompressedStorage
      : formatClass === 3 ? "dxt3" : "dxt1";

    // Some assets (e.g. DTOWN3F/R SHADOW_HDR) omit flag 0x10 despite storing uncompressed pixels.
    if ((flags & 0x10) === 0) {
      const compressedSize = mipChainByteSize(width, height, extraMipCount, storage);
      const compressedEnd = compressedSize === null ? -1 : offset + compressedSize;
      const compressedValid = compressedEnd >= 0 && compressedEnd <= bytes.length
        && ((allowEofAfter && compressedEnd === bytes.length) || isPlausibleRecordAt(compressedEnd));
      if (!compressedValid) {
        const uncompressedSize = mipChainByteSize(width, height, extraMipCount, uncompressedStorage);
        const uncompressedEnd = uncompressedSize === null ? -1 : offset + uncompressedSize;
        if (uncompressedEnd >= 0 && uncompressedEnd <= bytes.length
          && ((allowEofAfter && uncompressedEnd === bytes.length) || isPlausibleRecordAt(uncompressedEnd))) {
          storage = uncompressedStorage;
        }
      }
    }

    const compressed = storage === "dxt1" || storage === "dxt3";
    const blockBytes = storage === "dxt3" ? 16 : 8;
    const pixelBytes = storage === "r8g8b8" ? 3 : 4;
    const mips: TextureMip[] = [];
    let mipWidth = width;
    let mipHeight = height;
    for (let level = 0; level <= extraMipCount; level++) {
      if (mipWidth === 0 || mipHeight === 0
        || (compressed && (mipWidth % 4 !== 0 || mipHeight % 4 !== 0))) {
        throw new Error(`Invalid mip dimensions ${mipWidth}x${mipHeight} for ${name}`);
      }
      const size = compressed
        ? (mipWidth / 4) * (mipHeight / 4) * blockBytes
        : mipWidth * mipHeight * pixelBytes;
      mips.push({ width: mipWidth, height: mipHeight, data: take(size) });
      mipWidth = Math.floor(mipWidth / 2);
      mipHeight = Math.floor(mipHeight / 2);
    }

    return { kind: "texture", name, flags, formatClass, storage, scalar, paletteSelector, colorMetadata, mips };
  }

  const count256 = u32();
  const count16 = u32();
  const supplementaryCount = u32();
  const palettes256 = palettes(count256, 1024);
  const palettes16 = palettes(count16, 64);
  const supplementaryPalettes256 = palettes(supplementaryCount, 1024);
  const count = u32();
  const nameBytes = u32();
  const textures: TextureRecord[] = [];
  let namesRead = 0;

  for (let i = 0; i < count; i++) {
    textures.push(readRecord(i, i === count - 1, false));
  }

  // Some assets (e.g. CAPRI_78/85/87) append valid texture records past the declared header count.
  if (offset < bytes.length) {
    const trailingStart = offset;
    const extraTextures: TextureRecord[] = [];
    try {
      while (offset < bytes.length) {
        extraTextures.push(readRecord(textures.length + extraTextures.length, true, true));
      }
    } catch {
      throw new Error(`Trailing textures.DXT bytes at ${trailingStart}`);
    }
    textures.push(...extraTextures);
  }

  // Note: Shuffle mod tools sometimes leave a stale nameBytes header count even when all records parse to EOF.
  void namesRead;
  void nameBytes;
  return { palettes256, palettes16, supplementaryPalettes256, textures };
}

function writeRgb565(palette: Uint8Array, offset: number, packed: number): void {
  const r = packed >>> 11;
  const g = (packed >>> 5) & 63;
  const b = packed & 31;
  palette[offset] = (r << 3) | (r >>> 2);
  palette[offset + 1] = (g << 2) | (g >>> 4);
  palette[offset + 2] = (b << 3) | (b >>> 2);
  palette[offset + 3] = 255;
}

function decodeBlocks(data: Uint8Array, width: number, height: number, explicitAlpha: boolean): Uint8Array {
  const outputSize = width * height * 4;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || !Number.isSafeInteger(outputSize)) {
    throw new Error("Invalid DXT dimensions");
  }
  const columns = Math.ceil(width / 4);
  const rows = Math.ceil(height / 4);
  const blockBytes = explicitAlpha ? 16 : 8;
  if (data.length !== columns * rows * blockBytes) throw new Error("Invalid DXT payload size");

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pixels = new Uint8Array(outputSize);
  const palette = new Uint8Array(16);
  let offset = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const colorOffset = offset + (explicitAlpha ? 8 : 0);
      const color0 = view.getUint16(colorOffset, true);
      const color1 = view.getUint16(colorOffset + 2, true);
      const selectors = view.getUint32(colorOffset + 4, true);
      const transparent = !explicitAlpha && color0 <= color1;
      writeRgb565(palette, 0, color0);
      writeRgb565(palette, 4, color1);
      for (let channel = 0; channel < 3; channel++) {
        const a = palette[channel]!;
        const b = palette[4 + channel]!;
        palette[8 + channel] = transparent ? (a + b) / 2 : (2 * a + b) / 3;
        palette[12 + channel] = transparent ? 0 : (a + 2 * b) / 3;
      }
      palette[11] = 255;
      palette[15] = transparent ? 0 : 255;

      for (let y = 0; y < 4 && row * 4 + y < height; y++) {
        for (let x = 0; x < 4 && column * 4 + x < width; x++) {
          const texel = y * 4 + x;
          const source = ((selectors >>> (texel * 2)) & 3) * 4;
          const target = ((row * 4 + y) * width + column * 4 + x) * 4;
          pixels[target] = palette[source]!;
          pixels[target + 1] = palette[source + 1]!;
          pixels[target + 2] = palette[source + 2]!;
          pixels[target + 3] = explicitAlpha
            ? ((data[offset + (texel >>> 1)]! >>> ((texel & 1) * 4)) & 15) * 17
            : palette[source + 3]!;
        }
      }
      offset += blockBytes;
    }
  }
  return pixels;
}

export function decodeDxt1(data: Uint8Array, width: number, height: number): Uint8Array {
  return decodeBlocks(data, width, height, false);
}

export function decodeDxt3(data: Uint8Array, width: number, height: number): Uint8Array {
  return decodeBlocks(data, width, height, true);
}

/** Convert little-endian A8R8G8B8 words from BGRA byte order into RGBA. */
export function decodeA8R8G8B8(data: Uint8Array): Uint8Array {
  if (data.length % 4 !== 0) throw new Error("Invalid A8R8G8B8 payload size");
  const pixels = new Uint8Array(data.length);
  for (let offset = 0; offset < data.length; offset += 4) {
    pixels[offset] = data[offset + 2]!;
    pixels[offset + 1] = data[offset + 1]!;
    pixels[offset + 2] = data[offset]!;
    pixels[offset + 3] = data[offset + 3]!;
  }
  return pixels;
}

/** Expand 24-bit RGB textures.DXT payloads (fr3.exe 0x424640) into opaque RGBA. */
export function decodeR8G8B8(data: Uint8Array): Uint8Array {
  if (data.length % 3 !== 0) throw new Error("Invalid R8G8B8 payload size");
  const pixelCount = data.length / 3;
  const pixels = new Uint8Array(pixelCount * 4);
  for (let src = 0, dst = 0; src < data.length; src += 3, dst += 4) {
    pixels[dst] = data[src]!;
    pixels[dst + 1] = data[src + 1]!;
    pixels[dst + 2] = data[src + 2]!;
    pixels[dst + 3] = 255;
  }
  return pixels;
}

/** Decode 32-bit textures.DXT payloads stored as RGB + inverted alpha (fr3.exe 0x424bd0 / 0x424ee0). */
export function decodeR8G8B8T8(data: Uint8Array): Uint8Array {
  if (data.length % 4 !== 0) throw new Error("Invalid R8G8B8T8 payload size");
  const pixels = new Uint8Array(data.length);
  for (let offset = 0; offset < data.length; offset += 4) {
    pixels[offset] = data[offset]!;
    pixels[offset + 1] = data[offset + 1]!;
    pixels[offset + 2] = data[offset + 2]!;
    pixels[offset + 3] = 255 - data[offset + 3]!;
  }
  return pixels;
}

/** Decode a parsed texture mip level to RGBA bytes. */
export function decodeTextureMip(
  record: Extract<TextureRecord, { kind: "texture" }>,
  level = 0,
): Uint8Array {
  const mip = record.mips[level];
  if (!mip) throw new Error(`Missing mip level ${level} for ${record.name}`);
  switch (record.storage) {
    case "dxt1": return decodeDxt1(mip.data, mip.width, mip.height);
    case "dxt3": return decodeDxt3(mip.data, mip.width, mip.height);
    case "r8g8b8": return decodeR8G8B8(mip.data);
    case "a8r8g8b8": return decodeR8G8B8T8(mip.data);
  }
}
