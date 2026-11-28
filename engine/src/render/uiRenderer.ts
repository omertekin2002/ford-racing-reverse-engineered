import { layoutText, lookupGlyph, measureTextLine, type FontAtlas } from "../formats/fonts.js";
import type { PcgEntry } from "../formats/pcg.js";
import {
  buildHudDrawList, hudInputFromLegacyState, type HudAtlas, type HudDrawOp, type HudModelInput, type LegacyHudState,
} from "../ui/hudModel.js";
import type { ResolvedUiDrawItem } from "../ui/uiRuntime.js";
import { GlContext } from "./glContext.js";
import type { ViewportRect } from "./sceneRenderer.js";

export type UiColor = readonly [number, number, number, number];
type Point = readonly [number, number];
export type UiUvRect = readonly [number, number, number, number];
type UiTexture = PcgEntry | FontAtlas;
export interface UiDrawCommand {
  texture: UiTexture | null;
  blend: boolean;
  /** Whether the texture's alpha channel participates in compositing. */
  textureAlpha: boolean;
  /**
   * fr3.exe `0x420d90` alpha test: when set, fragments whose final alpha (in 0..255) is `<=` this
   * reference are discarded (D3DCMP_GREATER). Absent means D3DCMP_ALWAYS.
   */
  alphaTest?: number;
  firstVertex: number;
  vertexCount: number;
}
export interface UiBatch {
  /** Interleaved normalized XY, UV and RGBA. */
  vertices: Float32Array;
  /** Consecutive compatible commands merge while preserving painter order. */
  commands: readonly UiDrawCommand[];
}

export interface GraphicStyle {
  /** RGBA channels in [0, 1]. Divide UI script color channels by 255. */
  colour?: UiColor;
  flipGraphic?: readonly [boolean | number, boolean | number];
  /**
   * Sub-rectangle `[u0, v0, u1, v1]` of the entry's *logical* image in [0, 1] (`[0, 0, 1, 1]` is the whole
   * graphic). Used for `:STRETCH_GRAPHIC 0` crops (rating bars, volume sliders).
   */
  uvRect?: UiUvRect;
  /** D3DCMP_GREATER alpha-test reference in [0, 255] (the loading chaser uses this). */
  alphaTest?: number;
}
export interface TextStyle {
  colour?: UiColor;
  justify?: number;
  wordWrap?: boolean;
  scale?: number;
  shadow?: boolean | { x: number; y: number; colour: UiColor };
}

/** The HUD/graphics justification enum of fr3.exe (`0x52df60`): 1..3 bottom, 4..6 middle, 7..9 top; centre/left/right. */
export type FrJustify = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** NUMBERS/graphics.pcg glyphs used by {@link UiBatchBuilder.numeralString}. Keys: `0`..`9`, `/`, `.`, `:`, `R`, `N`. */
export type NumeralGlyphs = Readonly<Record<string, PcgEntry | undefined>>;

const WHITE: UiColor = [1, 1, 1, 1];
const STRIDE = 8;
const REF_WIDTH = 640;
const REF_HEIGHT = 480;
const ZERO_UV: Point = [0, 0];
const QUAD_INDICES = [0, 1, 2, 0, 2, 3] as const;
const DEFAULT_SHADOW = { x: 1, y: 1, colour: [0, 0, 0, 0.72] as UiColor };
const FULL_UV: UiUvRect = [0, 0, 1, 1];

/** fr3.exe numeral markup colours (`0x52c8f0`): `D`, `L`, `X`, `G`. */
export const NUMERAL_MARKUP: Readonly<Record<"D" | "L" | "X" | "G", UiColor>> = {
  D: [139 / 255, 186 / 255, 202 / 255, 1],
  L: [220 / 255, 220 / 255, 220 / 255, 1],
  X: [155 / 255, 23 / 255, 52 / 255, 1],
  G: [6 / 255, 174 / 255, 6 / 255, 1],
};
const NUMERAL_SMALL_SCALE = 0.615;
const NUMERAL_SPACING = -2;
const NUMERAL_NAMES: Readonly<Record<string, string>> = { " ": "0", "/": "/", ".": ".", ":": ":", R: "R", N: "N" };

/** Offset of the anchor to the top-left corner of a `width`×`height` box for an fr3 justify value (§2.1). */
export function justifyOffset(justify: number, width: number, height: number): Point {
  const j = Math.max(1, Math.min(9, Math.trunc(justify))) - 1;
  const h = j % 3; // 0 centre, 1 left, 2 right
  const v = Math.floor(j / 3); // 0 bottom, 1 middle, 2 top
  return [h === 0 ? -width / 2 : h === 1 ? 0 : -width, v === 0 ? -height : v === 1 ? -height / 2 : 0];
}

/** Compute the largest centered 4:3 viewport rectangle inside a canvas so 640x480 UI never stretches unevenly. */
export function computeUiViewport(
  canvasWidth: number,
  canvasHeight: number,
  targetAspect = REF_WIDTH / REF_HEIGHT,
): ViewportRect {
  if (canvasWidth <= 0 || canvasHeight <= 0 || !Number.isFinite(targetAspect) || targetAspect <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const aspect = canvasWidth / canvasHeight;
  if (Math.abs(aspect - targetAspect) < 1e-4) {
    return { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
  }
  if (aspect > targetAspect) {
    const width = Math.max(1, Math.round(canvasHeight * targetAspect));
    const x = Math.floor((canvasWidth - width) * 0.5);
    return { x, y: 0, width, height: canvasHeight };
  }
  const height = Math.max(1, Math.round(canvasWidth / targetAspect));
  const y = Math.floor((canvasHeight - height) * 0.5);
  return { x: 0, y, width: canvasWidth, height };
}

/**
 * How the 640×480 virtual UI maps onto the canvas. `"fit"` pillarboxes to 4:3 (HUD layout table 0);
 * `"fullscreen"` stretches over the whole backbuffer exactly like fr3.exe's `drawGraphic` (`0x421520`),
 * which keeps the 16:9 Shuffle menu backgrounds unsquashed.
 */
export type UiViewportMode = "fit" | "fullscreen";

export function uiViewportFor(canvasWidth: number, canvasHeight: number, mode: UiViewportMode = "fit"): ViewportRect {
  return mode === "fullscreen"
    ? { x: 0, y: 0, width: Math.max(0, canvasWidth), height: Math.max(0, canvasHeight) }
    : computeUiViewport(canvasWidth, canvasHeight);
}

/** Map normalized full-canvas pointer coordinates [0, 1] into the UI viewport's [0, 1] space. */
export function canvasToUiPoint(
  canvasX: number,
  canvasY: number,
  canvasWidth: number,
  canvasHeight: number,
  mode: UiViewportMode = "fit",
): readonly [number, number] {
  const vp = uiViewportFor(canvasWidth, canvasHeight, mode);
  if (vp.width <= 0 || vp.height <= 0) return [canvasX, canvasY];
  return [
    (canvasX * canvasWidth - vp.x) / vp.width,
    (canvasY * canvasHeight - vp.y) / vp.height,
  ];
}

/** Build a frame in normalized UI coordinates with a top-left origin. */
export class UiBatchBuilder {
  private readonly vertices: number[] = [];
  private readonly commands: UiDrawCommand[] = [];
  private clip: ViewportRect | null = null;

  constructor(
    private readonly canvasWidth = REF_WIDTH, private readonly canvasHeight = REF_HEIGHT,
    private readonly layoutWidth = REF_WIDTH, private readonly layoutHeight = REF_HEIGHT,
  ) {}

  clear(): void {
    this.vertices.length = this.commands.length = 0;
    this.clip = null;
  }

  /**
   * Scissor (normalized coordinates) for subsequent axis-aligned quads: fills, graphics and text glyphs are cut
   * to it with their UVs and vertex colours interpolated, like fr3.exe's clip rect (`0x4258e0`, polygon clipper
   * `0x40fb00`). `null` disables clipping. Returns the previous clip so callers can restore it.
   */
  setClip(rect: ViewportRect | null): ViewportRect | null {
    const previous = this.clip;
    this.clip = rect ? { ...rect } : null;
    return previous;
  }

  getClip(): ViewportRect | null {
    return this.clip ? { ...this.clip } : null;
  }

  build(): UiBatch {
    return { vertices: Float32Array.from(this.vertices), commands: this.commands.map(command => ({ ...command })) };
  }

  private command(
    texture: UiTexture | null, textureAlpha: boolean, vertexAlpha: boolean, count: number, alphaTest?: number,
  ): void {
    const blend = textureAlpha || vertexAlpha;
    const test = alphaTest === undefined || !Number.isFinite(alphaTest) ? undefined : Math.max(0, Math.min(255, alphaTest));
    const last = this.commands.at(-1);
    if (last && last.texture === texture && last.textureAlpha === textureAlpha && last.blend === blend
      && last.alphaTest === test) {
      last.vertexCount += count;
    } else {
      const command: UiDrawCommand = {
        texture, textureAlpha, blend, firstVertex: this.vertices.length / STRIDE, vertexCount: count,
      };
      if (test !== undefined) command.alphaTest = test;
      this.commands.push(command);
    }
  }

  private writeQuad(
    points: readonly [Point, Point, Point, Point], uv: UiUvRect, colors: readonly [UiColor, UiColor, UiColor, UiColor],
    texture: UiTexture | null, textureAlpha: boolean, alphaTest?: number,
  ): void {
    const [u0, v0, u1, v1] = uv;
    const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] as const;
    this.command(texture, textureAlpha, colors.some(color => color[3] < 1), 6, alphaTest);
    for (const index of QUAD_INDICES) this.vertices.push(...points[index], ...uvs[index], ...colors[index]);
  }

  private rect(
    rect: ViewportRect, uv: UiUvRect, colors: readonly [UiColor, UiColor, UiColor, UiColor],
    texture: UiTexture | null, textureAlpha: boolean, alphaTest?: number,
  ): void {
    const { x, y, width, height } = rect;
    if (!(width > 0 && height > 0)) return;
    const clip = this.clip;
    if (clip) {
      const left = Math.max(x, clip.x);
      const top = Math.max(y, clip.y);
      const right = Math.min(x + width, clip.x + clip.width);
      const bottom = Math.min(y + height, clip.y + clip.height);
      if (!(right > left && bottom > top)) return;
      if (left > x || top > y || right < x + width || bottom < y + height) {
        const s0 = (left - x) / width, s1 = (right - x) / width;
        const t0 = (top - y) / height, t1 = (bottom - y) / height;
        const [u0, v0, u1, v1] = uv;
        const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
        // Bilinear vertex colour at (s, t) over [top-left, top-right, bottom-right, bottom-left].
        const at = (s: number, t: number): UiColor => {
          const [c0, c1, c2, c3] = colors;
          return [0, 1, 2, 3].map(i => lerp(lerp(c0[i]!, c1[i]!, s), lerp(c3[i]!, c2[i]!, s), t)) as unknown as UiColor;
        };
        this.writeQuad([[left, top], [right, top], [right, bottom], [left, bottom]],
          [lerp(u0, u1, s0), lerp(v0, v1, t0), lerp(u0, u1, s1), lerp(v0, v1, t1)],
          [at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)], texture, textureAlpha, alphaTest);
        return;
      }
    }
    this.writeQuad([[x, y], [x + width, y], [x + width, y + height], [x, y + height]], uv, colors, texture,
      textureAlpha, alphaTest);
  }

  /** Texture coordinates of an entry's logical sub-rectangle, honouring padded PCG tiles and flips. */
  private entryUv(entry: PcgEntry, crop: UiUvRect = FULL_UV, flip: GraphicStyle["flipGraphic"] = undefined): UiUvRect {
    const su = entry.logicalWidth / entry.storedWidth;
    const sv = entry.logicalHeight / entry.storedHeight;
    const [c0, d0, c1, d1] = crop;
    const [flipX, flipY] = flip ?? [];
    return [
      (flipX ? c1 : c0) * su, (flipY ? d1 : d0) * sv,
      (flipX ? c0 : c1) * su, (flipY ? d0 : d1) * sv,
    ];
  }

  private px(x: number, y: number): Point {
    return [x / this.layoutWidth, y / this.layoutHeight];
  }

  solidQuad(rect: ViewportRect, colour: UiColor): void {
    this.gradientQuad(rect, colour, colour);
  }

  gradientQuad(rect: ViewportRect, top: UiColor, bottom: UiColor): void {
    this.rect(rect, FULL_UV, [top, top, bottom, bottom], null, false);
  }

  graphic(rect: ViewportRect, entry: PcgEntry, style: GraphicStyle = {}): void {
    const colour = style.colour ?? WHITE;
    this.rect(rect, this.entryUv(entry, style.uvRect, style.flipGraphic),
      [colour, colour, colour, colour], entry, entry.alphaFlag, style.alphaTest);
  }

  /** Alias of {@link graphic} that names the `:STRETCH_GRAPHIC 0` crop explicitly. */
  croppedSprite(rect: ViewportRect, entry: PcgEntry, uvRect: UiUvRect, style: Omit<GraphicStyle, "uvRect"> = {}): void {
    this.graphic(rect, entry, { ...style, uvRect });
  }

  /**
   * Draw an entry at its logical pixel size (× `scale`, optionally a separate `scaleX`) anchored at
   * reference-pixel `(x, y)` with the fr3 justify enum (§2.1).
   */
  justifiedSprite(
    entry: PcgEntry, x: number, y: number, justify: number, colour: UiColor = WHITE, scale = 1, scaleX = scale,
  ): void {
    const width = entry.logicalWidth * scaleX;
    const height = entry.logicalHeight * scale;
    const [dx, dy] = justifyOffset(justify, width, height);
    this.graphic(this.pxRect(x + dx, y + dy, width, height), entry, { colour });
  }

  /**
   * Draw a sprite whose top-centre sits on `pivot` (reference px) and that hangs straight down at angle 0,
   * rotated clockwise on screen by `angle` radians (fr3 needle `0x52e290`: 90° points left, 180° up).
   */
  rotatedSprite(entry: PcgEntry, pivot: Point, angle: number, colour: UiColor = WHITE): void {
    const w = entry.logicalWidth;
    const h = entry.logicalHeight;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const corner = (x: number, y: number) => this.px(pivot[0] + x * cos - y * sin, pivot[1] + x * sin + y * cos);
    this.writeQuad([corner(-w / 2, 0), corner(w / 2, 0), corner(w / 2, h), corner(-w / 2, h)],
      this.entryUv(entry), [colour, colour, colour, colour], entry, entry.alphaFlag);
  }

  /** Measure a numeral string (§2.4) in reference pixels. */
  measureNumerals(text: string, glyphs: NumeralGlyphs, xScale = 1): { width: number; height: number } {
    let width = 0;
    let height = 0;
    let scale = NUMERAL_SMALL_SCALE;
    for (const char of text) {
      if (char === ">") scale = 1;
      else if (char === "<") scale = NUMERAL_SMALL_SCALE;
      else if (char in NUMERAL_MARKUP) continue;
      else {
        const glyph = glyphs[NUMERAL_NAMES[char] ?? char];
        if (!glyph) continue;
        width += (glyph.logicalWidth * scale + NUMERAL_SPACING) * xScale;
        height = Math.max(height, glyph.logicalHeight);
      }
    }
    return { width, height };
  }

  /**
   * fr3.exe graphical numerals (`0x52c8f0`): digits from NUMBERS/graphics.pcg at scale 0.615 (`>` = 1.0,
   * `<` = 0.615), −2 px letter spacing, space renders the `0` sprite, `D`/`L`/`X`/`G` switch colour.
   * The whole run is justified with §2.1 and each glyph is drawn top-left at the pen.
   */
  numeralString(
    text: string, x: number, y: number, justify: number, colour: UiColor, glyphs: NumeralGlyphs, xScale = 1,
  ): void {
    const size = this.measureNumerals(text, glyphs, xScale);
    const [dx, dy] = justifyOffset(justify, size.width, size.height);
    let pen = x + dx;
    const top = y + dy;
    let scale = NUMERAL_SMALL_SCALE;
    let ink = colour;
    for (const char of text) {
      if (char === ">") scale = 1;
      else if (char === "<") scale = NUMERAL_SMALL_SCALE;
      else if (char in NUMERAL_MARKUP) ink = NUMERAL_MARKUP[char as keyof typeof NUMERAL_MARKUP];
      else {
        const glyph = glyphs[NUMERAL_NAMES[char] ?? char];
        if (!glyph) continue;
        this.graphic(this.pxRect(pen, top, glyph.logicalWidth * scale * xScale, glyph.logicalHeight * scale), glyph,
          { colour: ink });
        pen += (glyph.logicalWidth * scale + NUMERAL_SPACING) * xScale;
      }
    }
  }

  /**
   * Textured line strip in reference pixels (minimap `MAP_TRACK`): the texture's U runs across the
   * `width`, V along the strip, with mitred joints so consecutive segments share edges.
   */
  texturedLineStrip(points: readonly Point[], width: number, entry: PcgEntry | null, colour: UiColor = WHITE): void {
    const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1]![0] || p[1] !== points[i - 1]![1]);
    if (pts.length < 2 || !(width > 0)) return;
    const half = width / 2;
    const normal = (a: Point, b: Point): Point => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy) || 1;
      return [-dy / length, dx / length];
    };
    const offsets = pts.map((point, i): Point => {
      const before = i > 0 ? normal(pts[i - 1]!, point) : undefined;
      const after = i < pts.length - 1 ? normal(point, pts[i + 1]!) : undefined;
      if (!before) return [after![0] * half, after![1] * half];
      if (!after) return [before[0] * half, before[1] * half];
      const mx = before[0] + after[0];
      const my = before[1] + after[1];
      const length = Math.hypot(mx, my);
      if (length < 1e-6) return [after[0] * half, after[1] * half];
      // Mitre length is half / cos(theta/2); clamp so hairpins don't spike.
      const cosHalf = (mx * after[0] + my * after[1]) / length;
      const mitre = half / Math.max(0.25, cosHalf);
      return [mx / length * mitre, my / length * mitre];
    });
    const [u0, v0, u1, v1] = entry ? this.entryUv(entry) : FULL_UV;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const oa = offsets[i]!;
      const ob = offsets[i + 1]!;
      this.writeQuad([
        this.px(a[0] - oa[0], a[1] - oa[1]), this.px(a[0] + oa[0], a[1] + oa[1]),
        this.px(b[0] + ob[0], b[1] + ob[1]), this.px(b[0] - ob[0], b[1] - ob[1]),
      ], [u0, v0, u1, v1], [colour, colour, colour, colour], entry, entry?.alphaFlag ?? false);
    }
  }

  /** Stroke using thickness measured in reference pixels. */
  line(start: Point, end: Point, thickness: number, colour: UiColor): void {
    const dx = (end[0] - start[0]) * this.layoutWidth;
    const dy = (end[1] - start[1]) * this.layoutHeight;
    const length = Math.hypot(dx, dy);
    if (!length || thickness <= 0) return;
    const x = -dy * thickness / (2 * length * this.layoutWidth);
    const y = dx * thickness / (2 * length * this.layoutHeight);
    this.writeQuad([
      [start[0] + x, start[1] + y], [end[0] + x, end[1] + y],
      [end[0] - x, end[1] - y], [start[0] - x, start[1] - y],
    ], FULL_UV, [colour, colour, colour, colour], null, false);
  }

  disk(center: Point, radius: number, colour: UiColor, sides = 20): void {
    sides = Math.floor(sides);
    if (radius <= 0 || !Number.isFinite(sides) || sides < 3) return;
    this.command(null, false, colour[3] < 1, sides * 3);
    for (let i = 0; i < sides; i++) {
      this.vertices.push(...center, ...ZERO_UV, ...colour);
      for (const angle of [i, i + 1].map(step => step * 2 * Math.PI / sides)) {
        this.vertices.push(center[0] + Math.cos(angle) * radius / this.layoutWidth,
          center[1] + Math.sin(angle) * radius / this.layoutHeight, ...ZERO_UV, ...colour);
      }
    }
  }

  /**
   * Single-line font text anchored at reference-pixel `(x, y)` with the fr3 HUD justify enum (§2.1); the box
   * height is the font cell height (HUD labels, timer rows, banners).
   */
  anchoredText(atlas: FontAtlas, content: string, x: number, y: number, justify: number, colour: UiColor = WHITE,
    scale = 1): void {
    const width = measureTextLine(atlas.font, content) * scale;
    const height = atlas.font.descriptor.cellHeight * scale;
    const [dx, dy] = justifyOffset(justify, width, height);
    this.text(this.pxRect(x + dx, y + dy, Math.max(width, 1), height), atlas, content,
      { justify: 4, colour, scale });
  }

  private pxRect(x: number, y: number, width: number, height: number): ViewportRect {
    return { x: x / this.layoutWidth, y: y / this.layoutHeight, width: width / this.layoutWidth,
      height: height / this.layoutHeight };
  }

  text(rect: ViewportRect, atlas: FontAtlas, content: string, style: TextStyle = {}): void {
    const { font } = atlas;
    const scale = style.scale ?? 1;
    if (scale <= 0 || this.canvasWidth <= 0 || this.canvasHeight <= 0) return;
    const lines = layoutText(font, content.replace(/\r?\n/g, "|"), rect.width * this.layoutWidth,
      rect.height * this.layoutHeight, style.justify ?? 0, style.wordWrap ?? false, scale);
    const color = style.colour ?? WHITE;
    const shadow = style.shadow === true ? DEFAULT_SHADOW : style.shadow;
    const glyphs: { rect: ViewportRect; uv: UiUvRect }[] = [];
    for (const line of lines) {
      let x = line.x;
      let previous = -1;
      for (let i = 0; i < line.text.length; i++) {
        const char = line.text.charCodeAt(i);
        const code = char === 0x7e ? 0x20 : char;
        const glyph = lookupGlyph(font, code);
        if (!glyph) continue;
        if (previous >= 0) x += (font.kerningMap.get((previous << 16) | glyph.codePoint) ?? 0) * scale;
        const metrics = atlas.glyphs.get(glyph.codePoint);
        if (metrics && glyph.coverage.length && glyph.width && glyph.height) {
          const left = rect.x + (x + glyph.leftBearing * scale) / this.layoutWidth;
          const top = rect.y + line.y / this.layoutHeight;
          glyphs.push({
            rect: {
              x: Math.round(left * this.canvasWidth) / this.canvasWidth,
              y: Math.round(top * this.canvasHeight) / this.canvasHeight,
              width: glyph.width * scale / this.layoutWidth, height: glyph.height * scale / this.layoutHeight,
            },
            uv: [metrics.u0, metrics.v0, metrics.u1, metrics.v1],
          });
        }
        x += glyph.advance * scale;
        previous = glyph.codePoint;
      }
    }

    if (shadow) {
      const ink: UiColor = [shadow.colour[0], shadow.colour[1], shadow.colour[2], shadow.colour[3] * color[3]];
      const offsetX = Math.round(shadow.x) / this.canvasWidth;
      const offsetY = Math.round(shadow.y) / this.canvasHeight;
      for (const glyph of glyphs) this.rect(
        { ...glyph.rect, x: glyph.rect.x + offsetX, y: glyph.rect.y + offsetY },
        glyph.uv, [ink, ink, ink, ink], atlas, true,
      );
    }
    for (const glyph of glyphs) this.rect(glyph.rect, glyph.uv, [color, color, color, color], atlas, true);
  }
}

const UI_VERTEX = `#version 300 es
layout(location=0) in vec2 position;
layout(location=1) in vec2 uv;
layout(location=2) in vec4 colour;
out vec2 textureUV;
out vec4 tint;
void main() {
  gl_Position = vec4(position.x * 2.0 - 1.0, 1.0 - position.y * 2.0, 0.0, 1.0);
  textureUV = uv;
  tint = colour;
}`;
const UI_FRAGMENT = `#version 300 es
precision highp float;
in vec2 textureUV;
in vec4 tint;
uniform sampler2D image;
uniform bool textureAlpha;
uniform float alphaRef;
out vec4 pixel;
void main() {
  vec4 texel = texture(image, textureUV);
  if (!textureAlpha) texel.a = 1.0;
  pixel = texel * tint;
  if (alphaRef >= 0.0 && floor(pixel.a * 255.0 + 0.5) <= alphaRef) discard;
}`;

export class UiRenderer {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly white: WebGLTexture;
  private readonly image: WebGLUniformLocation | null;
  private readonly textureAlpha: WebGLUniformLocation | null;
  private readonly alphaRef: WebGLUniformLocation | null;
  private readonly textures = new Map<UiTexture, WebGLTexture>();
  private disposed = false;

  constructor(private readonly context: GlContext) {
    const gl = context.gl;
    const owned: (WebGLProgram | WebGLVertexArrayObject | WebGLBuffer | WebGLTexture)[] = [];
    try {
      this.program = context.createProgram(UI_VERTEX, UI_FRAGMENT);
      owned.push(this.program);
      this.vao = context.createVertexArray();
      owned.push(this.vao);
      this.buffer = context.createBuffer();
      owned.push(this.buffer);
      this.white = context.uploadRgba(1, 1, new Uint8Array([255, 255, 255, 255]));
      owned.push(this.white);
      this.image = gl.getUniformLocation(this.program, "image");
      this.textureAlpha = gl.getUniformLocation(this.program, "textureAlpha");
      this.alphaRef = gl.getUniformLocation(this.program, "alphaRef");
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      [2, 2, 4].forEach((size, location) => {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, STRIDE * 4, location * 8);
      });
    } catch (error) {
      owned.forEach(resource => context.release(resource));
      throw error;
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  private texture(source: UiTexture | null): WebGLTexture {
    if (source === null) return this.white;
    const cached = this.textures.get(source);
    if (cached) return cached;
    const texture = "font" in source ? this.context.uploadFont(source) : this.context.uploadPcg(source);
    this.textures.set(source, texture);
    return texture;
  }

  /** Upload textures ahead of their first draw so large backgrounds don't hitch the frame they appear in. */
  preloadTextures(sources: Iterable<UiTexture>): void {
    if (this.disposed) return;
    for (const source of sources) this.texture(source);
  }

  releaseTexture(source: UiTexture): void {
    const texture = this.textures.get(source);
    if (texture) this.context.release(texture);
    this.textures.delete(source);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const texture of this.textures.values()) this.context.release(texture);
    this.textures.clear();
    for (const resource of [this.program, this.vao, this.buffer, this.white]) this.context.release(resource);
  }

  /**
   * Draw a batch. `preserveAspect` (default `true`) pillarboxes to 4:3; pass `false` (or `"fullscreen"`) to
   * stretch over the whole canvas as fr3.exe does for menus.
   */
  render(
    batch: UiBatch,
    canvasWidth = this.context.gl.drawingBufferWidth,
    canvasHeight = this.context.gl.drawingBufferHeight,
    preserveAspect: boolean | UiViewportMode = true,
  ): void {
    if (this.disposed) throw new Error("UI renderer has been disposed");
    if (!batch.commands.length || canvasWidth <= 0 || canvasHeight <= 0) return;
    const gl = this.context.gl;
    const mode: UiViewportMode = preserveAspect === true || preserveAspect === "fit" ? "fit" : "fullscreen";
    const vp = uiViewportFor(canvasWidth, canvasHeight, mode);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.image, 0);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, batch.vertices, gl.STREAM_DRAW);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    try {
      for (const command of batch.commands) {
        if (command.blend) gl.enable(gl.BLEND);
        else gl.disable(gl.BLEND);
        gl.bindTexture(gl.TEXTURE_2D, this.texture(command.texture));
        gl.uniform1i(this.textureAlpha, Number(command.textureAlpha));
        gl.uniform1f(this.alphaRef, command.alphaTest ?? -1);
        gl.drawArrays(gl.TRIANGLES, command.firstVertex, command.vertexCount);
      }
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  /**
   * Draw the in-race HUD. Pass `atlas` (from `DemoAssets.loadHudAtlas`) to get the authentic fr3.exe sprite HUD;
   * without it only the font labels can be drawn. `state` may be the legacy {@link HudState} or a full
   * {@link HudModelInput}.
   */
  renderHud(
    state: HudState | HudModelInput, canvasWidth: number, canvasHeight: number, fonts: HudFonts,
    textures: HudTextures = {}, mode: UiViewportMode = "fit",
  ): void {
    const vp = uiViewportFor(canvasWidth, canvasHeight, mode);
    this.render(buildHudBatch(state, vp.width || canvasWidth, vp.height || canvasHeight, fonts, textures),
      canvasWidth, canvasHeight, mode);
  }
}

export interface MapPoint { x: number; z: number }
export interface HudMap {
  course: readonly MapPoint[];
  player: MapPoint;
  opponents: readonly MapPoint[];
}
/**
 * Legacy HUD input still produced by `app.ts`. The optional fields below map 1:1 onto {@link HudModelInput};
 * prefer passing a `HudModelInput` directly.
 */
export type HudState = LegacyHudState;

export interface HudFonts {
  /** Font slot 2 of fontbase.dat (fr3 HUD labels always use font 2). */
  body: FontAtlas;
  display?: FontAtlas;
}
export interface HudTextures {
  /** Authentic HUD sprite atlas (`DemoAssets.loadHudAtlas`). */
  atlas?: HudAtlas;
}

const rgba = (colour: readonly [number, number, number, number]): UiColor =>
  [colour[0] / 255, colour[1] / 255, colour[2] / 255, colour[3] / 255];

/** Execute ordered HUD draw ops (640×480 reference pixels) into a batch. Ops whose sprite is missing are skipped. */
export function executeHudDrawOps(
  batch: UiBatchBuilder, ops: readonly HudDrawOp[], fonts: HudFonts, atlas: HudAtlas | undefined,
): void {
  const sprite = (key: string) => atlas?.sprites.get(key);
  const numerals = atlas?.numerals ?? {};
  for (const op of ops) {
    switch (op.kind) {
      case "sprite": {
        const entry = sprite(op.key);
        if (entry) batch.justifiedSprite(entry, op.x, op.y, op.justify, rgba(op.colour), op.scale ?? 1, op.scaleX ?? op.scale ?? 1);
        break;
      }
      case "needle": {
        const entry = sprite(op.key);
        if (entry) batch.rotatedSprite(entry, [op.pivotX, op.pivotY], op.angle, rgba(op.colour));
        break;
      }
      case "numerals":
        batch.numeralString(op.text, op.x, op.y, op.justify, rgba(op.colour), numerals);
        break;
      case "text":
        batch.anchoredText(fonts.body, op.text, op.x, op.y, op.justify, rgba(op.colour));
        break;
      case "strip": {
        const entry = sprite(op.key);
        if (entry) batch.texturedLineStrip(op.points, op.width, entry, rgba(op.colour));
        break;
      }
      case "quad": {
        const entry = sprite(op.key);
        if (entry) batch.graphic({ x: op.x0 / REF_WIDTH, y: op.y0 / REF_HEIGHT,
          width: (op.x1 - op.x0) / REF_WIDTH, height: (op.y1 - op.y0) / REF_HEIGHT }, entry, { colour: rgba(op.colour) });
        break;
      }
    }
  }
}

function isModelInput(state: HudState | HudModelInput): state is HudModelInput {
  return "cameraGroup" in state && "maxRpm" in state && "units" in state;
}

/** Build the fr3.exe HUD (hud.c `0x52bcd0` frame order) for one 640×480 viewport. */
export function buildHudBatch(
  state: HudState | HudModelInput, canvasWidth: number, canvasHeight: number, fonts: HudFonts,
  textures: HudTextures = {},
): UiBatch {
  const batch = new UiBatchBuilder(canvasWidth, canvasHeight);
  const input = isModelInput(state) ? state : hudInputFromLegacyState(state);
  const measureText = (text: string) => measureTextLine(fonts.body.font, text);
  executeHudDrawOps(batch, buildHudDrawList({ measureText, ...input }), fonts, textures.atlas);
  return batch.build();
}

export interface UiItemResources {
  /** Loaded PCG entry for a registered texture key (`graphics/game/startus.psd`), or undefined while loading. */
  texture: (registeredKey: string) => PcgEntry | undefined;
  /** fontbase.dat slot → atlas (direct index, as fr3.exe's fontsys does). */
  font: (slot: number) => FontAtlas | undefined;
  /** Called for textures that are not loaded yet (e.g. to queue a fetch). */
  onMissingTexture?: (registeredKey: string) => void;
  /** Apply each item's `clipRect` (fr3's per-node scissor). Defaults to true. */
  clip?: boolean;
}

/**
 * `UiScreenOptions.measureText` backed by fontbase.dat atlases: width of one line in 640-wide virtual pixels,
 * or undefined for a slot that is not loaded.
 */
export function uiTextMeasurer(
  fonts: readonly (FontAtlas | undefined)[] | ((slot: number) => FontAtlas | undefined),
): (font: number, text: string) => number | undefined {
  const lookup = typeof fonts === "function" ? fonts : (slot: number) => fonts[slot];
  return (font, text) => {
    const atlas = lookup(font);
    return atlas ? measureTextLine(atlas.font, text) : undefined;
  };
}

/**
 * Paint `UiScreenInstance.getDrawItems()` exactly as fr3.exe does, in preorder: `CLEAR 0` fill, then the
 * texture (tinted by COLOUR, `STRETCH_GRAPHIC 0` crop, alpha test), then the text laid out in `textRect`
 * (JUSTIFY_OFFSET applied) at the node's font size with no shadow or shrink-to-fit. Everything an item paints
 * is cut to its `clipRect` (node ∩ ancestors ∩ screen), as fr3's tree draw scissors each node.
 */
export function drawUiDrawItems(
  batch: UiBatchBuilder, items: readonly ResolvedUiDrawItem[], resources: UiItemResources,
): void {
  const outer = batch.getClip();
  const clipping = resources.clip ?? true;
  for (const item of items) {
    if (clipping) {
      const clip = item.clipRect;
      const scissor = !clip ? outer : !outer ? clip : intersectRects(clip, outer);
      if (scissor && !(scissor.width > 0 && scissor.height > 0)) continue;
      batch.setClip(scissor);
    }
    const colour = rgba(item.color);
    if (item.fill) batch.solidQuad(item.rect, colour);
    if (item.textureRef) {
      const entry = resources.texture(item.textureRef.registeredKey);
      if (entry) {
        const style: GraphicStyle = { colour, flipGraphic: item.flip };
        if (item.uvRect) style.uvRect = item.uvRect;
        if (item.alphaTest !== undefined) style.alphaTest = item.alphaTest;
        batch.graphic(item.graphicRect, entry, style);
      } else {
        resources.onMissingTexture?.(item.textureRef.registeredKey);
      }
    }
    if (item.text) {
      const font = resources.font(item.font);
      if (font) {
        batch.text(item.textRect, font, item.text, {
          justify: item.textJustify, wordWrap: item.wordWrap, colour: rgba(item.textColor),
        });
      }
    }
  }
  if (clipping) batch.setClip(outer);
}

function intersectRects(a: ViewportRect, b: ViewportRect): ViewportRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x, y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

/** `graphics\\loading\\graphics` sprites (see `DemoAssets.loadLoadingSprites`). */
export interface LoadingScreenSprites {
  load: PcgEntry;
  bar: PcgEntry;
  bar2: PcgEntry;
}

const LOADING_TINT: UiColor = [175 / 255, 18 / 255, 4 / 255, 1];
const LOADING_TEXT_COLOUR: UiColor = [98 / 255, 96 / 255, 86 / 255, 1];

/** Advance the loading chaser phase one frame (fr3 adds 1/60 per frame and wraps to −0.05 past 1.35). */
export function stepLoadingPhase(phase: number): number {
  const next = phase + 1 / 60;
  return next > 1.35 ? -0.05 : next;
}

/**
 * Loading screen (fr3.exe `0x4b7400`): LOAD over the whole screen, a 9-segment chaser at
 * (0.7671875 + i·w, 0.2125) tinted (175,18,4) that uses `_LOADBAR` with alpha test GREATER `a` while
 * `a > 179` and `_LOADBR2` with vertex alpha `a·255/179` otherwise, and the right-aligned font-2 caption
 * (98,96,86) in START's prompt box (x ≤ 0.948437, y 0.856). No percentage or status text.
 */
export function drawLoadingScreen(
  batch: UiBatchBuilder, sprites: LoadingScreenSprites, phase: number,
  options: { text?: string; font?: FontAtlas; fade?: UiColor } = {},
): void {
  batch.graphic({ x: 0, y: 0, width: 1, height: 1 }, sprites.load, { colour: options.fade ?? WHITE });
  const width = sprites.bar2.logicalWidth / REF_WIDTH;
  const height = sprites.bar2.logicalHeight / REF_HEIGHT;
  for (let i = 0; i < 9; i++) {
    const f = Math.min(1, Math.max(0, (phase - 0.05 * i) * 1.1111));
    const a = 255 - Math.round(f * 255);
    const rect = { x: 0.7671875 + i * width, y: 0.2125, width, height };
    if (a > 179) batch.graphic(rect, sprites.bar, { colour: LOADING_TINT, alphaTest: a });
    else batch.graphic(rect, sprites.bar2, { colour: [LOADING_TINT[0], LOADING_TINT[1], LOADING_TINT[2], a / 179] });
  }
  if (options.text && options.font) {
    batch.text({ x: 0, y: 0.856, width: 0.948437, height: 29 / REF_HEIGHT }, options.font, options.text,
      { justify: 2, colour: LOADING_TEXT_COLOUR });
  }
}
