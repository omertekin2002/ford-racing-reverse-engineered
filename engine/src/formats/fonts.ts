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

const FALLBACK_TRANSLITERATION: Readonly<Record<string, string>> = {
  // Punctuation and typographic symbols absent from the 134-glyph bitmap font
  "\u2026": "...", // …
  "\u2014": "-",   // —
  "\u2013": "-",   // –
  "\u2212": "-",   // −
  "\u2018": "'",   // ‘
  "\u2019": "'",   // ’
  "\u00b4": "'",   // ´
  "\u201c": "\"",  // “
  "\u201d": "\"",  // ”
  "\u2022": "-",   // •
  "\u00a0": " ",   // NBSP
  // Special Latin characters that do not decompose to ASCII under NFD
  "\u0141": "L", "\u0142": "l", // Ł ł
  "\u0110": "D", "\u0111": "d", // Đ đ
  "\u00d8": "O", "\u00f8": "o", // Ø ø
  "\u00c6": "AE", "\u00e6": "ae", // Æ æ
  "\u0153": "oe", // œ
  "\u00df": "ss", // ß (only used if a font lacks ß)
  // Cyrillic uppercase (RU translation)
  "\u0410": "A", "\u0411": "B", "\u0412": "V", "\u0413": "G", "\u0414": "D",
  "\u0415": "E", "\u0401": "YO", "\u0416": "ZH", "\u0417": "Z", "\u0418": "I",
  "\u0419": "Y", "\u041a": "K", "\u041b": "L", "\u041c": "M", "\u041d": "N",
  "\u041e": "O", "\u041f": "P", "\u0420": "R", "\u0421": "S", "\u0422": "T",
  "\u0423": "U", "\u0424": "F", "\u0425": "KH", "\u0426": "TS", "\u0427": "CH",
  "\u0428": "SH", "\u0429": "SHCH", "\u042a": "", "\u042b": "Y", "\u042c": "'",
  "\u042d": "E", "\u042e": "YU", "\u042f": "YA",
  // Cyrillic lowercase
  "\u0430": "a", "\u0431": "b", "\u0432": "v", "\u0433": "g", "\u0434": "d",
  "\u0435": "e", "\u0451": "yo", "\u0436": "zh", "\u0437": "z", "\u0438": "i",
  "\u0439": "y", "\u043a": "k", "\u043b": "l", "\u043c": "m", "\u043d": "n",
  "\u043e": "o", "\u043f": "p", "\u0440": "r", "\u0441": "s", "\u0442": "t",
  "\u0443": "u", "\u0444": "f", "\u0445": "kh", "\u0446": "ts", "\u0447": "ch",
  "\u0448": "sh", "\u0449": "shch", "\u044a": "", "\u044b": "y", "\u044c": "'",
  "\u044d": "e", "\u044e": "yu", "\u044f": "ya",
};

function stripDiacritics(ch: string): string {
  const mapped = FALLBACK_TRANSLITERATION[ch];
  if (mapped !== undefined) return mapped;
  const nfd = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return nfd !== ch ? nfd : "";
}

function fitReplacementToFont(font: ParsedFont, replacement: string): string | null {
  let out = "";
  for (let i = 0; i < replacement.length; i++) {
    const c = replacement[i]!;
    const cp = c.charCodeAt(0);
    if (font.glyphMap.has(cp)) {
      out += c;
      continue;
    }
    const upper = c.toUpperCase();
    if (upper.length === 1 && font.glyphMap.has(upper.charCodeAt(0))) {
      out += upper;
      continue;
    }
    const lower = c.toLowerCase();
    if (lower.length === 1 && font.glyphMap.has(lower.charCodeAt(0))) {
      out += lower;
      continue;
    }
    return null;
  }
  return out;
}

/**
 * Replace characters missing from `font` with ASCII/diacritic-stripped or transliterated equivalents
 * when those target glyphs exist in `font`. Exact glyphs already in `font` are left untouched.
 */
export function transliterateForFont(font: ParsedFont, text: string): string {
  let needsFallback = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x7e || code === 0x7c || code === 0x0a || code === 0x0d) continue;
    if (!font.glyphMap.has(code)) {
      needsFallback = true;
      break;
    }
  }
  if (!needsFallback) return text;

  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x7e || code === 0x7c || code === 0x0a || code === 0x0d || font.glyphMap.has(code)) {
      out += text[i]!;
      continue;
    }
    const ch = text[i]!;
    const stripped = stripDiacritics(ch);
    if (stripped.length > 0 || FALLBACK_TRANSLITERATION[ch] === "") {
      const fitted = fitReplacementToFont(font, stripped);
      if (fitted !== null) {
        out += fitted;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

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
  const exact = font.glyphMap.get(mapped);
  if (exact) return exact;
  const ch = String.fromCodePoint(mapped);
  const stripped = stripDiacritics(ch);
  if (stripped.length > 0) {
    const fitted = fitReplacementToFont(font, stripped[0]!);
    if (fitted && fitted.length > 0) {
      const fallback = font.glyphMap.get(fitted.charCodeAt(0));
      if (fallback) return fallback;
    }
  }
  return font.glyphMap.get(FALLBACK_CODEPOINT);
}

export function measureTextLine(font: ParsedFont, line: string): number {
  const normalized = transliterateForFont(font, line);
  let width = 0;
  let prev = -1;
  for (let i = 0; i < normalized.length; i++) {
    const raw = normalized.charCodeAt(i);
    const code = raw === 0x7e ? 0x20 : raw;
    const glyph = lookupGlyph(font, code);
    if (!glyph) continue;
    if (prev >= 0) {
      width += font.kerningMap.get((prev << 16) | glyph.codePoint) ?? 0;
    }
    width += glyph.advance;
    prev = glyph.codePoint;
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
  const normalized = transliterateForFont(font, text);
  const hardLines = normalized.split("|");
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
