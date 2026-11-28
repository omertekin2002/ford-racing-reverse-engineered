import { layoutText, lookupGlyph, type FontAtlas } from "../formats/fonts.js";
import type { PcgEntry } from "../formats/pcg.js";
import { clamp } from "../math/mat4.js";
import { GlContext } from "./glContext.js";
import type { ViewportRect } from "./sceneRenderer.js";

export type UiColor = readonly [number, number, number, number];
type Point = readonly [number, number];
type UvRect = readonly [number, number, number, number];
type UiTexture = PcgEntry | FontAtlas;
export interface UiDrawCommand {
  texture: UiTexture | null;
  blend: boolean;
  /** Whether the texture's alpha channel participates in compositing. */
  textureAlpha: boolean;
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
}
export interface TextStyle {
  colour?: UiColor;
  justify?: number;
  wordWrap?: boolean;
  scale?: number;
  shadow?: boolean | { x: number; y: number; colour: UiColor };
}

const WHITE: UiColor = [1, 1, 1, 1];
const STRIDE = 8;
const REF_WIDTH = 640;
const REF_HEIGHT = 480;
const ZERO_UV: Point = [0, 0];
const QUAD_INDICES = [0, 1, 2, 0, 2, 3] as const;
const DEFAULT_SHADOW = { x: 1, y: 1, colour: [0, 0, 0, 0.72] as UiColor };

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

/** Map normalized full-canvas pointer coordinates [0, 1] into the centered 4:3 UI viewport's [0, 1] space. */
export function canvasToUiPoint(
  canvasX: number,
  canvasY: number,
  canvasWidth: number,
  canvasHeight: number,
): readonly [number, number] {
  const vp = computeUiViewport(canvasWidth, canvasHeight);
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

  constructor(
    private readonly canvasWidth = REF_WIDTH, private readonly canvasHeight = REF_HEIGHT,
    private readonly layoutWidth = REF_WIDTH, private readonly layoutHeight = REF_HEIGHT,
  ) {}

  clear(): void {
    this.vertices.length = this.commands.length = 0;
  }

  build(): UiBatch {
    return { vertices: Float32Array.from(this.vertices), commands: this.commands.map(command => ({ ...command })) };
  }

  private command(texture: UiTexture | null, textureAlpha: boolean, vertexAlpha: boolean, count: number): void {
    const blend = textureAlpha || vertexAlpha;
    const last = this.commands.at(-1);
    if (last && last.texture === texture && last.textureAlpha === textureAlpha && last.blend === blend) {
      last.vertexCount += count;
    } else {
      this.commands.push({ texture, textureAlpha, blend, firstVertex: this.vertices.length / STRIDE, vertexCount: count });
    }
  }

  private writeQuad(
    points: readonly [Point, Point, Point, Point], uv: UvRect, colors: readonly [UiColor, UiColor, UiColor, UiColor],
    texture: UiTexture | null, textureAlpha: boolean,
  ): void {
    const [u0, v0, u1, v1] = uv;
    const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] as const;
    this.command(texture, textureAlpha, colors.some(color => color[3] < 1), 6);
    for (const index of QUAD_INDICES) this.vertices.push(...points[index], ...uvs[index], ...colors[index]);
  }

  private rect(
    rect: ViewportRect, uv: UvRect, colors: readonly [UiColor, UiColor, UiColor, UiColor],
    texture: UiTexture | null, textureAlpha: boolean,
  ): void {
    const { x, y, width, height } = rect;
    if (width <= 0 || height <= 0) return;
    this.writeQuad([[x, y], [x + width, y], [x + width, y + height], [x, y + height]], uv, colors, texture, textureAlpha);
  }

  solidQuad(rect: ViewportRect, colour: UiColor): void {
    this.gradientQuad(rect, colour, colour);
  }

  gradientQuad(rect: ViewportRect, top: UiColor, bottom: UiColor): void {
    this.rect(rect, [0, 0, 1, 1], [top, top, bottom, bottom], null, false);
  }

  graphic(rect: ViewportRect, entry: PcgEntry, style: GraphicStyle = {}): void {
    const colour = style.colour ?? WHITE;
    const [flipX, flipY] = style.flipGraphic ?? [];
    const u = entry.logicalWidth / entry.storedWidth;
    const v = entry.logicalHeight / entry.storedHeight;
    this.rect(rect, [flipX ? u : 0, flipY ? v : 0, flipX ? 0 : u, flipY ? 0 : v],
      [colour, colour, colour, colour], entry, entry.alphaFlag);
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
    ], [0, 0, 1, 1], [colour, colour, colour, colour], null, false);
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

  text(rect: ViewportRect, atlas: FontAtlas, content: string, style: TextStyle = {}): void {
    const { font } = atlas;
    const scale = style.scale ?? 1;
    if (scale <= 0 || this.canvasWidth <= 0 || this.canvasHeight <= 0) return;
    const lines = layoutText(font, content.replace(/\r?\n/g, "|"), rect.width * this.layoutWidth,
      rect.height * this.layoutHeight, style.justify ?? 0, style.wordWrap ?? false, scale);
    const color = style.colour ?? WHITE;
    const shadow = style.shadow === true ? DEFAULT_SHADOW : style.shadow;
    const glyphs: { rect: ViewportRect; uv: UvRect }[] = [];
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
out vec4 pixel;
void main() {
  vec4 texel = texture(image, textureUV);
  if (!textureAlpha) texel.a = 1.0;
  pixel = texel * tint;
}`;

export class UiRenderer {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly white: WebGLTexture;
  private readonly image: WebGLUniformLocation | null;
  private readonly textureAlpha: WebGLUniformLocation | null;
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

  render(
    batch: UiBatch,
    canvasWidth = this.context.gl.drawingBufferWidth,
    canvasHeight = this.context.gl.drawingBufferHeight,
    preserveAspect = true,
  ): void {
    if (this.disposed) throw new Error("UI renderer has been disposed");
    if (!batch.commands.length || canvasWidth <= 0 || canvasHeight <= 0) return;
    const gl = this.context.gl;
    const vp = preserveAspect
      ? computeUiViewport(canvasWidth, canvasHeight)
      : { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
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
        gl.drawArrays(gl.TRIANGLES, command.firstVertex, command.vertexCount);
      }
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  renderHud(hudState: HudState, canvasWidth: number, canvasHeight: number, fonts: HudFonts, pcgTextures: HudTextures = {}): void {
    const vp = computeUiViewport(canvasWidth, canvasHeight);
    this.render(buildHudBatch(hudState, vp.width || canvasWidth, vp.height || canvasHeight, fonts, pcgTextures), canvasWidth, canvasHeight);
  }
}

export interface MapPoint { x: number; z: number }
export interface HudMap {
  course: readonly MapPoint[];
  player: MapPoint;
  opponents: readonly MapPoint[];
}
export interface HudState {
  speedMps: number;
  speedUnit?: "MPH" | "KPH";
  /** Vehicle gauge range in m/s. */
  speedRangeMps?: number;
  rpm: number;
  redlineRpm: number;
  gear: number;
  /** Normalized boost remaining, in [0, 1]. */
  boost: number;
  boostCharges?: number;
  maxBoostCharges?: number;
  position: number;
  participants: number;
  lap: number;
  laps: number;
  lapTime: number;
  bestTime?: number;
  totalTime?: number;
  countdown?: 3 | 2 | 1 | "GO";
  wrongWay?: boolean;
  map?: HudMap;
}

export interface HudFonts {
  body: FontAtlas;
  display?: FontAtlas;
}
export interface HudTextures {
  speedDial?: PcgEntry;
  rpmDial?: PcgEntry;
  playerDot?: PcgEntry;
  opponentDot?: PcgEntry;
}

const INK: UiColor = [0.89, 0.94, 0.98, 1];
const MUTED: UiColor = [0.66, 0.76, 0.83, 1];
const ACCENT: UiColor = [0.24, 0.89, 0.80, 1];
const ALERT: UiColor = [1, 0.32, 0.29, 1];
const PANEL: UiColor = [0.035, 0.068, 0.099, 0.88];
const DIVIDER: UiColor = [0.14, 0.22, 0.29, 1];

function rectPx(x: number, y: number, width: number, height: number): ViewportRect {
  return { x: x / REF_WIDTH, y: y / REF_HEIGHT, width: width / REF_WIDTH, height: height / REF_HEIGHT };
}
function pointPx(x: number, y: number): Point {
  return [x / REF_WIDTH, y / REF_HEIGHT];
}
function formatTime(seconds: number): string {
  const time = Math.round(Math.abs(seconds) * 100);
  const minutes = Math.floor(time / 6000).toString().padStart(2, "0");
  const remainder = Math.floor(time / 100 % 60).toString().padStart(2, "0");
  const hundredths = (time % 100).toString().padStart(2, "0");
  return `${seconds < 0 ? "-" : ""}${minutes}:${remainder}.${hundredths}`;
}

function drawDial(
  batch: UiBatchBuilder, x: number, y: number, reading: number, redline: number, face?: PcgEntry,
): void {
  const radius = 42;
  const center = pointPx(x, y);
  const radial = (ratio: number, r: number): Point => {
    const angle = (0.75 + 1.5 * ratio) * Math.PI;
    return pointPx(x + Math.cos(angle) * r, y + Math.sin(angle) * r);
  };
  if (face) batch.graphic(rectPx(x - radius, y - radius, radius * 2, radius * 2), face);
  else {
    batch.disk(center, radius, PANEL, 48);
    for (let step = 0; step < 48; step++) {
      const fraction = step / 48;
      batch.line(radial(fraction, 37), radial((step + 1) / 48, 37), 2,
        fraction >= redline ? ALERT : DIVIDER);
    }
    for (let i = 0; i <= 16; i++) {
      const fraction = i / 16;
      batch.line(radial(fraction, i % 4 ? 32 : 29), radial(fraction, 36), i % 4 ? 1 : 1.75,
        fraction >= redline ? ALERT : MUTED);
    }
  }
  batch.line(center, radial(clamp(reading, 0, 1), 30), 2, ACCENT);
  batch.disk(center, 3, INK);
}

function drawMap(batch: UiBatchBuilder, map: HudMap, textures: HudTextures): void {
  if (map.course.length < 2) return;
  const stride = 1 + Math.floor(map.course.length / 127);
  const points = map.course.filter((_, i) => i % stride === 0);
  const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
  const minZ = Math.min(...points.map(p => p.z)), maxZ = Math.max(...points.map(p => p.z));
  const extent = Math.max(maxX - minX, maxZ - minZ);
  if (!Number.isFinite(extent) || extent <= 0) return;
  const scale = 94 / extent;
  const centerX = (minX + maxX) / 2, centerZ = (minZ + maxZ) / 2;
  const project = (p: MapPoint): Point => pointPx(69 + (p.x - centerX) * scale, 408 - (p.z - centerZ) * scale);
  batch.solidQuad(rectPx(12, 351, 114, 114), PANEL);
  const projected = points.map(project);
  for (let i = 0; i < projected.length; i++) {
    batch.line(projected[i]!, projected[(i + 1) % projected.length]!, 2, MUTED);
  }
  batch.disk(projected[0]!, 3, INK);
  const dot = (point: MapPoint, radius: number, colour: UiColor, sprite?: PcgEntry) => {
    const [x, y] = project(point);
    if (sprite) batch.graphic(rectPx(x * REF_WIDTH - radius, y * REF_HEIGHT - radius, radius * 2, radius * 2),
      sprite, { colour });
    else batch.disk([x, y], radius, colour);
  };
  for (const p of map.opponents) dot(p, 2.8, INK, textures.opponentDot);
  dot(map.player, 3.8, ACCENT, textures.playerDot);
}

export function buildHudBatch(
  state: HudState, canvasWidth: number, canvasHeight: number, fonts: HudFonts, textures: HudTextures = {},
): UiBatch {
  const batch = new UiBatchBuilder(canvasWidth, canvasHeight);
  const display = fonts.display ?? fonts.body;
  const print = (content: string, rect: ViewportRect, options: TextStyle = {}, font = fonts.body) => {
    const scale = (options.scale ?? 1) * 20 / font.font.descriptor.cellHeight;
    batch.text(rect, font, content, { colour: INK, shadow: true, ...options, scale });
  };
  const kph = state.speedUnit === "KPH";
  const units = kph ? "KPH" : "MPH";
  const conversion = kph ? 3.6 : 2.237414522;
  const speed = Math.abs(state.speedMps * conversion);
  const speedRange = (state.speedRangeMps ?? 70) * conversion;
  const caps = kph ? [140, 240, 280, 320, 400] : [90, 140, 160, 180, 200, 240];
  const maxSpeed = Math.max(caps.find(cap => cap >= speedRange) ?? caps.at(-1)!, speedRange);
  const maxRpm = [4000, 6000, 7000, 8000, 9000, 10000].find(cap => cap >= state.redlineRpm) ?? Math.max(10000, state.redlineRpm);

  batch.solidQuad(rectPx(12, 12, 122, 62), PANEL);
  batch.solidQuad(rectPx(12, 12, 2, 62), ACCENT);
  print("POSITION", rectPx(21, 15, 103, 13), { colour: MUTED, justify: 4, scale: 0.57 });
  print(`${clamp(state.position, 0, state.participants)} / ${state.participants}`, rectPx(21, 27, 103, 17),
    { justify: 1, scale: 0.8 }, display);
  print(`LAP  ${clamp(state.lap, 1, state.laps)} / ${state.laps}`, rectPx(21, 49, 103, 18), { justify: 1, scale: 0.67 });

  const timers: [string, number | undefined][] = [["LAP", state.lapTime], ["BEST", state.bestTime], ["TOTAL", state.totalTime]];
  const visible = timers.filter((entry): entry is [string, number] => entry[1] !== undefined && Number.isFinite(entry[1]));
  batch.solidQuad(rectPx(483, 12, 145, 10 + visible.length * 16), PANEL);
  visible.forEach(([label, time], i) => {
    print(label, rectPx(491, 17 + i * 16, 42, 16), { justify: 1, colour: MUTED, scale: 0.56 });
    print(formatTime(time), rectPx(530, 17 + i * 16, 90, 16), { justify: 2, scale: 0.68 });
  });

  batch.solidQuad(rectPx(406, 358, 222, 107), PANEL);
  drawDial(batch, 452, 402, state.rpm / maxRpm, clamp(state.redlineRpm / maxRpm, 0, 1), textures.rpmDial);
  drawDial(batch, 581, 402, speed / maxSpeed, Infinity, textures.speedDial);
  print("RPM", rectPx(414, 420, 76, 14), { colour: MUTED, scale: 0.55 });
  print(`${String(Math.trunc(speed)).padStart(3, "0")} ${units}`, rectPx(540, 420, 82, 14), { scale: 0.61 });
  batch.solidQuad(rectPx(498, 375, 37, 44), DIVIDER);
  print(state.gear < 0 ? "R" : state.gear === 0 ? "N" : String(state.gear),
    rectPx(498, 375, 37, 44), { scale: 1.25 }, display);
  print("BOOST", rectPx(414, 442, 39, 15), { colour: MUTED, justify: 1, scale: 0.53 });
  const boost = clamp(state.boost, 0, 1) * 10;
  for (let i = 0; i < 10; i++) {
    const x = 455 + i * 13;
    batch.solidQuad(rectPx(x, 448, 11, 5), DIVIDER);
    batch.solidQuad(rectPx(x, 448, 11 * clamp(boost - i, 0, 1), 5), ACCENT);
  }
  const charges = clamp(Math.trunc(state.maxBoostCharges ?? 3), 0, 5);
  for (let i = 0; i < charges; i++) batch.disk(pointPx(594 + i * 6, 450), 2, i < (state.boostCharges ?? 0) ? ACCENT : MUTED);

  if (state.countdown !== undefined) {
    const lights = state.countdown === "GO" ? 3 : 4 - state.countdown;
    batch.solidQuad(rectPx(270, 173, 100, 76), PANEL);
    for (let i = 0; i < 3; i++) {
      batch.disk(pointPx(298 + i * 22, 190), 6, i >= lights ? DIVIDER : state.countdown === "GO" ? ACCENT : ALERT);
    }
    print(String(state.countdown), rectPx(270, 202, 100, 38), { scale: 1.65 }, display);
  }
  if (state.wrongWay) {
    batch.solidQuad(rectPx(249, 83, 142, 26), PANEL);
    print("WRONG WAY", rectPx(249, 83, 142, 26), { colour: ALERT, scale: 0.8 }, display);
  }

  if (state.map) drawMap(batch, state.map, textures);
  return batch.build();
}
