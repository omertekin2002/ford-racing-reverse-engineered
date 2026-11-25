export interface FontDescriptor {
  index: number;
  name: string;
  rasterMode: number;
  glyphCount: number;
  cellWidth: number;
  cellHeight: number;
  requestedHeight: number;
  requestedWidth: number;
  italic: number;
  kerningCount: number;
  weight: number;
  kerningOffset: number;
  glyphOffset: number;
}

export interface FontGlyph {
  codePoint: number;
  width: number;
  height: number;
  leftBearing: number;
  bodyWidth: number;
  rightBearing: number;
  advance: number;
  /** Row-major 8-bit coverage bitmap (length 0 for U+0020 space). */
  coverage: Uint8Array;
}

export interface KerningPair {
  left: number;
  right: number;
  adjustment: number;
}

export interface ParsedFont {
  descriptor: FontDescriptor;
  glyphs: FontGlyph[];
  glyphMap: Map<number, FontGlyph>;
  kerning: KerningPair[];
  kerningMap: Map<number, number>;
}

export interface AtlasGlyphMetrics {
  glyph: FontGlyph;
  cellX: number;
  cellY: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface FontAtlas {
  font: ParsedFont;
  width: number;
  height: number;
  /** Tightly packed RGBA8888 white+alpha coverage texture. */
  rgba: Uint8Array;
  glyphs: Map<number, AtlasGlyphMetrics>;
  fallback: AtlasGlyphMetrics | undefined;
}

export interface TextLineLayout {
  text: string;
  width: number;
  x: number;
  y: number;
}

const ASCII_DECODER = new TextDecoder("ascii");
const DESCRIPTOR_STRIDE = 172;
const FALLBACK_CODEPOINT = 0x25a1;

export function parseFontBase(bytes: Uint8Array): FontDescriptor[] {
  if (bytes.length === 0 || bytes.length % DESCRIPTOR_STRIDE !== 0) {
    throw new Error(`Invalid fontbase.dat size ${bytes.length} (not a multiple of ${DESCRIPTOR_STRIDE})`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.length / DESCRIPTOR_STRIDE;
  const descriptors: FontDescriptor[] = [];

  for (let i = 0; i < count; i++) {
    const base = i * DESCRIPTOR_STRIDE;
    const rawName = bytes.subarray(base, base + 128);
    const nul = rawName.indexOf(0);
    const name = ASCII_DECODER.decode(nul >= 0 ? rawName.subarray(0, nul) : rawName);

    descriptors.push({
      index: i,
      name,
      rasterMode: view.getUint32(base + 0x80, true),
      glyphCount: view.getUint32(base + 0x84, true),
      cellWidth: view.getUint32(base + 0x88, true),
      cellHeight: view.getUint32(base + 0x8c, true),
      requestedHeight: view.getUint32(base + 0x90, true),
      requestedWidth: view.getUint32(base + 0x94, true),
      italic: view.getUint32(base + 0x98, true),
      kerningCount: view.getUint32(base + 0x9c, true),
      weight: view.getFloat32(base + 0xa0, true),
      kerningOffset: view.getUint32(base + 0xa4, true),
      glyphOffset: view.getUint32(base + 0xa8, true),
    });
  }
  return descriptors;
}

export function parseFonts(fontBaseBytes: Uint8Array, fontDataBytes: Uint8Array): ParsedFont[] {
  const descriptors = parseFontBase(fontBaseBytes);
  const view = new DataView(fontDataBytes.buffer, fontDataBytes.byteOffset, fontDataBytes.byteLength);
  const fonts: ParsedFont[] = [];

  for (const desc of descriptors) {
    let cursor = desc.glyphOffset;
    const glyphs: FontGlyph[] = [];
    const glyphMap = new Map<number, FontGlyph>();

    for (let g = 0; g < desc.glyphCount; g++) {
      if (cursor + 24 > fontDataBytes.length) {
        throw new Error(`Truncated glyph header in font ${desc.index} glyph ${g} at ${cursor}`);
      }
      const codePoint = view.getUint32(cursor + 0x00, true);
      const width = view.getUint32(cursor + 0x04, true);
      const height = view.getUint32(cursor + 0x08, true);
      const leftBearing = view.getInt32(cursor + 0x0c, true);
      const bodyWidth = view.getInt32(cursor + 0x10, true);
      const rightBearing = view.getInt32(cursor + 0x14, true);
      cursor += 24;

      const pixelBytes = codePoint === 0x20 ? 0 : width * height;
      if (cursor + pixelBytes > fontDataBytes.length) {
        throw new Error(`Truncated glyph bitmap in font ${desc.index} U+${codePoint.toString(16)} at ${cursor}`);
      }
      const coverage = fontDataBytes.subarray(cursor, cursor + pixelBytes);
      cursor += pixelBytes;

      const glyph: FontGlyph = {
        codePoint,
        width,
        height,
        leftBearing,
        bodyWidth,
        rightBearing,
        advance: leftBearing + bodyWidth + rightBearing,
        coverage,
      };
      glyphs.push(glyph);
      glyphMap.set(codePoint, glyph);
    }

    const kerning: KerningPair[] = [];
    const kerningMap = new Map<number, number>();
    let kCursor = desc.kerningOffset;
    for (let k = 0; k < desc.kerningCount; k++) {
      if (kCursor + 8 > fontDataBytes.length) {
        throw new Error(`Truncated kerning pair in font ${desc.index} at ${kCursor}`);
      }
      const left = view.getUint16(kCursor, true);
      const right = view.getUint16(kCursor + 2, true);
      const adjustment = view.getInt32(kCursor + 4, true);
      kCursor += 8;
      kerning.push({ left, right, adjustment });
      kerningMap.set((left << 16) | right, adjustment);
    }

    fonts.push({ descriptor: desc, glyphs, glyphMap, kerning, kerningMap });
  }

  return fonts;
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function buildFontAtlas(font: ParsedFont): FontAtlas {
  const { cellWidth, cellHeight } = font.descriptor;
  const count = Math.max(1, font.glyphs.length);
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const width = nextPowerOfTwo(cols * cellWidth);
  const height = nextPowerOfTwo(rows * cellHeight);
  const rgba = new Uint8Array(width * height * 4);
  const glyphs = new Map<number, AtlasGlyphMetrics>();

  const cellsPerRow = Math.max(1, Math.floor(width / cellWidth));
  for (let i = 0; i < font.glyphs.length; i++) {
    const glyph = font.glyphs[i]!;
    const cx = (i % cellsPerRow) * cellWidth;
    const cy = Math.floor(i / cellsPerRow) * cellHeight;

    if (glyph.coverage.length > 0) {
      const drawW = Math.min(glyph.width, cellWidth);
      const drawH = Math.min(glyph.height, cellHeight);
      for (let y = 0; y < drawH; y++) {
        for (let x = 0; x < drawW; x++) {
          const cov = glyph.coverage[y * glyph.width + x]!;
          const dst = ((cy + y) * width + (cx + x)) * 4;
          rgba[dst] = 255;
          rgba[dst + 1] = 255;
          rgba[dst + 2] = 255;
          rgba[dst + 3] = cov;
        }
      }
    }

    const metrics: AtlasGlyphMetrics = {
      glyph,
      cellX: cx,
      cellY: cy,
      u0: cx / width,
      v0: cy / height,
      u1: (cx + glyph.width) / width,
      v1: (cy + glyph.height) / height,
    };
    glyphs.set(glyph.codePoint, metrics);
  }

  return {
    font,
    width,
    height,
    rgba,
    glyphs,
    fallback: glyphs.get(FALLBACK_CODEPOINT) ?? glyphs.values().next().value,
  };
}

export function lookupGlyph(font: ParsedFont, codePoint: number): FontGlyph | undefined {
  // Renderer maps '~' (non-breaking space) to U+0020 space glyph.
  const mapped = codePoint === 0x7e ? 0x20 : codePoint;
  return font.glyphMap.get(mapped) ?? font.glyphMap.get(FALLBACK_CODEPOINT);
}

export function measureTextLine(font: ParsedFont, line: string): number {
  let width = 0;
  let prev = -1;
  for (let i = 0; i < line.length; i++) {
    const raw = line.charCodeAt(i);
    const code = raw === 0x7e ? 0x20 : raw;
    const glyph = lookupGlyph(font, code);
    if (!glyph) continue;
    if (prev >= 0) {
      width += font.kerningMap.get((prev << 16) | code) ?? 0;
    }
    width += glyph.advance;
    prev = code;
  }
  return width;
}

/**
 * Wrap and justify text using FR3's rules:
 * - `|` forces a hard line break
 * - `~` renders as a space glyph but never breaks during word wrapping
 * - `justify` follows the 9-case dispatch (0..8):
 *   0: center/center, 1: left/center, 2: right/center,
 *   3: center/top,    4: left/top,    5: right/top,
 *   6: center/bottom, 7: left/bottom, 8: right/bottom.
 */
export function layoutText(
  font: ParsedFont,
  text: string,
  boxWidth: number,
  boxHeight: number,
  justify: number,
  wordWrap: boolean,
  scale = 1
): TextLineLayout[] {
  const hardLines = text.split("|");
  const lines: string[] = [];
  const invScale = scale > 0 ? 1 / scale : 1;
  const maxFontWidth = wordWrap && boxWidth > 0 ? boxWidth * invScale : Number.POSITIVE_INFINITY;

  for (const segment of hardLines) {
    if (!wordWrap || !Number.isFinite(maxFontWidth)) {
      lines.push(segment);
      continue;
    }
    const words = segment.split(" ");
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && measureTextLine(font, candidate) > maxFontWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }

  const lineHeight = font.descriptor.cellHeight * scale;
  const totalHeight = lines.length * lineHeight;
  const j = Math.max(0, Math.min(8, Math.trunc(justify)));
  const hMode = j % 3; // 0=center, 1=left, 2=right
  const vMode = Math.floor(j / 3); // 0=center, 1=top, 2=bottom

  let startY = 0;
  if (vMode === 0) startY = (boxHeight - totalHeight) * 0.5;
  else if (vMode === 1) startY = 0;
  else startY = boxHeight - totalHeight;

  return lines.map((line, idx) => {
    const w = measureTextLine(font, line) * scale;
    let x = 0;
    if (hMode === 0) x = (boxWidth - w) * 0.5;
    else if (hMode === 1) x = 0;
    else x = boxWidth - w;
    return {
      text: line,
      width: w,
      x,
      y: startY + idx * lineHeight,
    };
  });
}
