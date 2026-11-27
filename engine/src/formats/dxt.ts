export type TextureStorage = "dxt1" | "dxt3" | "a8r8g8b8";

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
  formatClass: 1 | 2 | 3;
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

export function parseTexturesDxt(bytes: Uint8Array): TextureArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;

  function take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length > bytes.length - offset) {
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
    const flags = u32();
    const nameLength = u32();
    const rawName = take(nameLength);
    if (!nameLength || rawName.indexOf(0) !== nameLength - 1) {
      throw new Error(`Invalid textures.DXT name at record ${i}`);
    }
    const name = decoder.decode(rawName.subarray(0, -1));
    namesRead += nameLength;

    if (flags & 1) {
      textures.push({ kind: "reference", name, flags });
      continue;
    }

    const formatClass = u32();
    const extraMipCount = u32();
    take(4);
    const scalar = view.getFloat32(offset - 4, true);
    const width = u32();
    const height = u32();
    const paletteSelector = u32();
    const colorMetadata = u32();
    if (formatClass !== 1 && formatClass !== 2 && formatClass !== 3) {
      throw new Error(`Unsupported texture class ${formatClass} for ${name}`);
    }
    const storage = flags & 0x10 ? "a8r8g8b8" : formatClass === 3 ? "dxt3" : "dxt1";
    const blockBytes = storage === "dxt3" ? 16 : 8;
    const mips: TextureMip[] = [];
    let mipWidth = width;
    let mipHeight = height;
    for (let level = 0; level <= extraMipCount; level++) {
      if (mipWidth === 0 || mipHeight === 0
        || (storage !== "a8r8g8b8" && (mipWidth % 4 !== 0 || mipHeight % 4 !== 0))) {
        throw new Error(`Invalid mip dimensions ${mipWidth}x${mipHeight} for ${name}`);
      }
      const size = storage === "a8r8g8b8"
        ? mipWidth * mipHeight * 4
        : (mipWidth / 4) * (mipHeight / 4) * blockBytes;
      mips.push({ width: mipWidth, height: mipHeight, data: take(size) });
      mipWidth = Math.floor(mipWidth / 2);
      mipHeight = Math.floor(mipHeight / 2);
    }

    textures.push({ kind: "texture", name, flags, formatClass, storage, scalar, paletteSelector, colorMetadata, mips });
  }

  if (offset !== bytes.length) throw new Error(`Trailing textures.DXT bytes at ${offset}`);
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
