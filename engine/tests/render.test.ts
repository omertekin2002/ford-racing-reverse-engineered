import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import type { TextureArchive, TextureRecord } from "../src/formats/dxt.js";
import { parseTexturesDxt } from "../src/formats/dxt.js";
import { buildFontAtlas, type FontGlyph, type ParsedFont } from "../src/formats/fonts.js";
import type { PcgEntry } from "../src/formats/pcg.js";
import {
  parse3dObjDb, parseBinInfo, parseXbx, binInfoTableNames,
  type BinInfo, type MeshPartGeometry, type MeshSlot, type SceneChild, type SceneDatabase, type SceneRoot,
} from "../src/formats/xbx.js";
import {
  compileModelGeometry, CompiledModel, parseFogConfig, SceneRenderer, type CompiledGeometry,
} from "../src/render/sceneRenderer.js";
import { GlContext } from "../src/render/glContext.js";
import {
  buildHudBatch, drawLoadingScreen, drawUiDrawItems, justifyOffset, stepLoadingPhase, uiTextMeasurer, UiBatchBuilder,
  type HudState, type NumeralGlyphs,
} from "../src/render/uiRenderer.js";
import {
  BONNET_NEEDLE, boostSegmentColours, buildHudDrawList, cameraModeToHudGroup, CHASE_NEEDLE, COUNTDOWN_DURATION,
  COUNTDOWN_RACE_START_TIME, countdownFrame, formatHudTime, HUD_COLOURS, hudGearText, hudInputFromLegacyState,
  HUD_SPRITE_MANIFEST, needleAngle, roundHalfEven, selectRevDial, selectSpeedDial, speedToDisplayUnits,
  type HudAtlas, type HudDrawOp, type HudModelInput, type HudRgba,
} from "../src/ui/hudModel.js";
import { NodeVfs } from "../src/vfs/nodeVfs.js";
import { DemoAssets } from "../src/demoAssets.js";
import type { ResolvedUiDrawItem } from "../src/ui/uiRuntime.js";
import { decodePcgEntryRgba } from "../src/formats/pcg.js";

const floats = (...values: number[]) => Float32Array.from(values);
const words = (...values: number[]) => Uint32Array.from(values);

function mesh(id: number, part: MeshPartGeometry): MeshSlot<MeshPartGeometry> {
  return { id, radius: 1, bounds: floats(0, 1, 0, 1, 0, 0), flags: 0,
    group2Flags: 0, offsetX: 0, offsetZ: 0, rawHeader: new Uint8Array(), groups: [[part], []] };
}

function root(shapeId: number, overrides: Partial<SceneRoot> = {}): SceneRoot {
  return {
    shapeId, transforms: [], boundaries: [], points: floats(), references: [], secondaryRecords: [],
    mode: 0, modeBoundaries: [], cameras: [], modePairs: [], lodValues: floats(), declaredInlineChildren: 0,
    declaredChildPairs: 0, preMeshWords: words(), meshSlotId: 0, controlWords: [0, 0], meshPairs: [],
    children: { kind: "inline", nodes: [] }, ...overrides,
  };
}

function desc(meshSlotId: number, translation: number[], children: SceneChild[] = [], pairs: SceneChild["pairs"] = []): SceneChild {
  return { meshSlotId, flags: 1, transform: floats(...translation), children, pairs };
}

test("model compilation preserves local poses and names and selects LOD 0 and livery", () => {
  const part: MeshPartGeometry = {
    f: 0, g: 0xf0, primaryTexture: 0, vertexCount: 3, stripCount: 1, word8: 0, word12: 0,
    descriptorExtension: words(), strips: [], indices: Uint16Array.of(0, 1, 2),
    positions: floats(0, 0, 0, 1, 0, 0, 0, 1, 0), packedAttributes: words(1, 1, 1),
    normals: floats(0, 0, 1, 0, 0, 1, 0, 0, 1), colors: new Uint8Array(12),
    uv0: floats(0, 0, 1, 0, 0, 1),
  };
  const texture: TextureRecord = { kind: "texture", name: "Body", formatClass: 1, storage: "dxt1", flags: 0x30000,
    scalar: 1, paletteSelector: 0, colorMetadata: 0, mips: [] };
  const archive: TextureArchive = { palettes256: [], palettes16: [], supplementaryPalettes256: [],
    textures: [texture, { ...texture, name: "BODY", flags: 0x1002000 }, { ...texture, name: "Glass", formatClass: 3 },
      { ...texture, name: "Fence", formatClass: 2 }] };
  const names = Object.fromEntries(binInfoTableNames.map(name => [name, []])) as unknown as BinInfo;
  names.shapes = ["CAR", "CAR_SHADOW", "FENCE"];
  names.subObjects = ["WHEEL_FRONT_LEFT"];
  names.textureLiveries = ["DEFAULT", "Red"];
  const lod0 = desc(1, [10, 20, 30, Math.PI / 2, 0, 0],
    [desc(2, [2, 0, 0, 0, 0, 0])], [[0, 0]]);
  const scene: SceneDatabase = { version: 18, header: words(), animationGroups: [], boundaryGroups: [], namedRecords: [],
    roots: [
      root(0, { lodValues: floats(0, 10), children: { kind: "inline", nodes: [lod0, desc(3, [0, 0, 0, 0, 0, 0])] } }),
      root(1, { children: { kind: "indirect", references: words(1, 0) }, lodValues: floats(0, 100) }),
      root(2, { meshSlotId: 3 }),
    ] };
  const model = [mesh(0, part), mesh(1, part), mesh(2, { ...part, primaryTexture: 2 }), mesh(3, { ...part, primaryTexture: 3 })];
  const geometry = compileModelGeometry(model, archive, names, scene, { livery: "red" });
  assert.deepEqual(geometry.batches.map(b => [b.material.pass, b.material.textureIndex, b.indexCount, b.firstIndex]),
    [["opaque", 1, 3, 0], ["alpha", 2, 3, 3], ["shadow", 1, 3, 6], ["cutout", 3, 3, 9]]);
  assert.deepEqual([...geometry.indices], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(geometry.subObjects.get("BODY")?.[0]?.meshSlotId, 1);
  const wheel = geometry.subObjects.get("WHEEL_FRONT_LEFT")?.[0];
  assert.equal(wheel?.meshSlotId, 2);
  assert.equal(wheel.localTransform[12], 2);
  assert.deepEqual([...wheel.worldTransform.slice(12, 15)], [10, 20, 28]);
  assert.deepEqual(geometry.bounds, { min: [0, 0, 0], max: [10, 21, 30] });
  assert.deepEqual(parseFogConfig("// Environment\r\nFOG: 0.20 186 139 84"), { density: 0.2, color: [186, 139, 84] });
});

function pcg(alphaFlag = false): PcgEntry {
  return { name: "tile", offset: 0, spanSize: 0, paletteSelector: 0, encodingSelector: 1, encoding: "dxt3",
    storedWidth: 16, storedHeight: 16, logicalWidth: 12, logicalHeight: 8, tileColumns: 1, tileRows: 1,
    alphaFlag, declaredPayloadBytes: 256, extraBytes: 0, payload: new Uint8Array(256) };
}

function atlas() {
  const descriptor = {
    index: 0, name: "Fixture", rasterMode: 0, glyphCount: 2, cellWidth: 8, cellHeight: 8,
    requestedHeight: 8, requestedWidth: 8, italic: 0, kerningCount: 1, weight: 1, kerningOffset: 0, glyphOffset: 0,
  };
  const a: FontGlyph = { codePoint: 65, width: 3, height: 5, leftBearing: 1, bodyWidth: 3, rightBearing: 1,
    advance: 5, coverage: new Uint8Array(15).fill(255) };
  const space: FontGlyph = { ...a, codePoint: 32, advance: 3, coverage: new Uint8Array() };
  const font: ParsedFont = { descriptor, glyphs: [a, space], glyphMap: new Map([[65, a], [32, space]]),
    kerning: [{ left: 65, right: 65, adjustment: -1 }], kerningMap: new Map([[65 << 16 | 65, -1]]) };
  return buildFontAtlas(font);
}

const full = { x: 0, y: 0, width: 1, height: 1 };

test("UI batches padded PCG tiles and preserves opaque and blended compositing order", () => {
  const builder = new UiBatchBuilder();
  const tile = pcg();
  const alpha = pcg(true);
  builder.graphic(full, tile, { flipGraphic: [1, 0] });
  builder.graphic(full, tile);
  builder.graphic(full, tile, { colour: [1, 0.5, 0, 0.25] });
  builder.graphic(full, alpha);
  builder.solidQuad(full, [1, 1, 1, 1]);
  builder.gradientQuad(full, [0, 0, 0, 1], [1, 1, 1, 0]);
  const { vertices, commands } = builder.build();
  assert.deepEqual(commands.map(({ blend, textureAlpha, firstVertex, vertexCount }) => [blend, textureAlpha, firstVertex, vertexCount]),
    [[false, false, 0, 12], [true, false, 12, 6], [true, true, 18, 6], [false, false, 24, 6], [true, false, 30, 6]]);
  assert.deepEqual([...vertices.slice(0, 4)], [0, 0, 0.75, 0]);
  assert.deepEqual([...vertices.slice(8, 12)], [1, 0, 0, 0]);
  assert.deepEqual([...vertices.slice(16, 20)], [1, 1, 0, 0.5]);
  assert.deepEqual([...vertices.slice(100, 104)], [1, 0.5, 0, 0.25]);
  assert.equal(vertices.length, 36 * 8);
  builder.clear();
  assert.equal(builder.build().commands.length, 0);
  assert.equal(commands[0]?.vertexCount, 12);
});

test("bitmap text uses atlas UVs, kerning, non-breaking spaces, explicit lines and all justifications", () => {
  const font = atlas();
  const builder = new UiBatchBuilder(100, 100, 100, 100);
  const box = { x: 0, y: 0, width: 0.25, height: 0.24 };
  for (let justify = 0; justify < 9; justify++) {
    builder.text(box, font, "AA~A|A", { justify, shadow: true });
    const { vertices, commands } = builder.build();
    const px = (index: number) => Math.round(vertices[index]! * 100);
    const expectedX = [5, 1, 9][justify % 3]!;
    const expectedY = [4, 0, 8][Math.floor(justify / 3)]!;
    assert.deepEqual(commands.map(({ blend, vertexCount }) => [blend, vertexCount]), [[true, 48]]);
    assert.deepEqual([px(0), px(1)], [expectedX + 1, expectedY + 1]);
    assert.deepEqual([px(192), px(193)], [expectedX, expectedY]);
    assert.equal(px(240), expectedX + 4);
    assert.equal(px(288), expectedX + 12);
    assert.equal(px(337), expectedY + 8);
    assert.equal(vertices[194], font.glyphs.get(65)?.u0);
    assert.equal(vertices[210], font.glyphs.get(65)?.u1);
    builder.clear();
  }
});

function sprite(name: string, logicalWidth: number, logicalHeight: number, alphaFlag = true): PcgEntry {
  return { ...pcg(alphaFlag), name, logicalWidth, logicalHeight,
    storedWidth: 2 ** Math.ceil(Math.log2(logicalWidth)), storedHeight: 2 ** Math.ceil(Math.log2(logicalHeight)) };
}

/** Quad corners (reference px) of the `index`th quad in a batch built at 640×480. */
function quadPx(vertices: Float32Array, index: number): [number, number][] {
  const base = index * 6 * 8;
  // Triangle order 0,1,2,0,2,3 → corners 0,1,2 at vertices 0..2 and corner 3 at vertex 5.
  return [0, 1, 2, 5].map(v => [vertices[base + v * 8]! * 640, vertices[base + v * 8 + 1]! * 480]);
}
const close = (actual: number, expected: number, epsilon = 1e-3) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≉ ${expected}`);

test("UI draw items paint fill, cropped alpha-tested texture, then offset text with no shadow", () => {
  const entry = sprite("rating1", 105, 15, false);
  const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
  const items: ResolvedUiDrawItem[] = [{
    id: "A", rect, textureRef: null, color: [95, 95, 90, 255], flip: [false, false], stretch: false, text: "AA",
    font: 2, textColor: [255, 255, 255, 255], textJustify: 4, wordWrap: false, justifyOffset: [0.1, 0], highlighted: false,
    enabled: true, buttonId: null, clear: false, fill: true, autosize: false, graphicRect: rect,
    textRect: { ...rect, x: 0.13 },
  }, {
    id: "B", rect, textureRef: { pcgPath: "graphics/game/graphics.pcg", entryName: "rating1", registeredKey: "graphics/game/rating1.psd" },
    color: [255, 255, 255, 128], flip: [false, false], stretch: false, text: null, font: 2, textColor: [0, 0, 0, 0],
    textJustify: 0, wordWrap: false, justifyOffset: [0, 0], highlighted: false, enabled: true, buttonId: null, clear: true,
    fill: false, autosize: false, graphicRect: { ...rect, width: 0.1 }, uvRect: [0, 0, 0.5, 1], alphaTest: 64, textRect: rect,
  }, {
    id: "C", rect, textureRef: { pcgPath: "x", entryName: "missing", registeredKey: "missing.psd" }, color: [255, 255, 255, 255],
    flip: [false, false], stretch: true, text: null, font: 9, textColor: [0, 0, 0, 0], textJustify: 0, wordWrap: false,
    justifyOffset: [0, 0], highlighted: false, enabled: true, buttonId: null, clear: true, fill: false, autosize: false,
    graphicRect: rect, textRect: rect,
  }];
  const missing: string[] = [];
  const font = atlas();
  const builder = new UiBatchBuilder();
  drawUiDrawItems(builder, items, {
    texture: key => key === "graphics/game/rating1.psd" ? entry : undefined,
    font: slot => slot === 2 ? font : undefined, onMissingTexture: key => missing.push(key),
  });
  const { vertices, commands } = builder.build();
  assert.deepEqual(commands.map(command => [command.texture === null ? "fill" : command.texture === entry ? "tex" : "font",
    command.alphaTest, command.vertexCount]), [["fill", undefined, 6], ["font", undefined, 12], ["tex", 64, 6]]);
  close(vertices[4]!, 95 / 255);
  // Text starts at the offset text rect (no shadow pass: exactly two glyph quads).
  close(vertices[48]! * 640, 0.13 * 640 + 1, 0.6);
  // The texture quad starts at vertex 18 (after 6 fill + 12 glyph vertices) and is drawn in graphicRect.
  close(vertices[144 + 8]! * 640, 0.1 * 640 + 0.1 * 640);
  assert.deepEqual([vertices[144 + 10], vertices[144 + 7]], [Math.fround(0.5 * 105 / 128), Math.fround(128 / 255)]);
  assert.deepEqual(missing, ["missing.psd"]);
});

test("loading screen chaser follows 0x4b7400: alpha-tested _LOADBAR above 179, faded _LOADBR2 below", () => {
  const sprites = { load: sprite("Load", 1920, 1080, false), bar: sprite("_loadbar", 13, 6), bar2: sprite("_loadbr2", 13, 6) };
  const builder = new UiBatchBuilder();
  drawLoadingScreen(builder, sprites, 0.5, { text: "AA", font: atlas() });
  const { vertices, commands } = builder.build();
  assert.equal(commands[0]?.texture, sprites.load);
  const segments = commands.slice(1, -1);
  // phase 0.5: f_i = (0.5 − 0.05i)·1.1111 → a = 255 − round(255 f); a > 179 only once f < 0.298 (i ≥ 5).
  const expectedAlpha = Array.from({ length: 9 }, (_, i) => 255 - Math.round(Math.min(1, Math.max(0, (0.5 - 0.05 * i) * 1.1111)) * 255));
  const tested = expectedAlpha.filter(a => a > 179);
  assert.deepEqual(segments.filter(command => command.texture === sprites.bar).map(command => command.alphaTest), tested);
  assert.ok(segments.filter(command => command.texture === sprites.bar2).every(command => command.alphaTest === undefined));
  const firstSegment = quadPx(vertices, 1);
  close(firstSegment[0]![0], 0.7671875 * 640); close(firstSegment[0]![1], 0.2125 * 480);
  close(firstSegment[2]![0] - firstSegment[0]![0], 13);
  close(vertices[48 + 7]!, expectedAlpha[0]! / 179, 1e-6);
  close(vertices[48 + 4]!, 175 / 255, 1e-6);
  assert.ok("font" in commands.at(-1)!.texture!);
  assert.deepEqual([stepLoadingPhase(0), stepLoadingPhase(1.349)], [1 / 60, -0.05]);
  close(stepLoadingPhase(1.3), 1.3 + 1 / 60);
});

test("fr3 justify enum anchors sprites on the 3×3 grid (1–3 bottom, 4–6 middle, 7–9 top)", () => {
  const entry = sprite("box", 100, 50);
  const expected: Record<number, [number, number]> = {
    1: [270, 150], 2: [320, 150], 3: [220, 150], 4: [270, 175], 5: [320, 175],
    6: [220, 175], 7: [270, 200], 8: [320, 200], 9: [220, 200],
  };
  for (let j = 1; j <= 9; j++) {
    assert.deepEqual(justifyOffset(j, 100, 50), [expected[j]![0] - 320, expected[j]![1] - 200]);
    const builder = new UiBatchBuilder();
    builder.justifiedSprite(entry, 320, 200, j, [1, 1, 1, 1], 1);
    const [topLeft, , bottomRight] = quadPx(builder.build().vertices, 0);
    close(topLeft![0], expected[j]![0]);
    close(topLeft![1], expected[j]![1]);
    close(bottomRight![0], expected[j]![0] + 100);
    close(bottomRight![1], expected[j]![1] + 50);
  }
  const scaled = new UiBatchBuilder();
  scaled.justifiedSprite(entry, 320, 120, 4, [1, 1, 1, 0.5], 1, 2);
  const [a, , b] = quadPx(scaled.build().vertices, 0);
  close(a![0], 220); close(b![0], 420); close(a![1], 95); close(b![1], 145);
  assert.equal(scaled.build().commands[0]?.blend, true);
});

test("rotated needle hangs from its top-centre pivot and turns clockwise on screen", () => {
  const needle = sprite("needle", 73, 121);
  const tip = (angle: number) => {
    const builder = new UiBatchBuilder();
    builder.rotatedSprite(needle, [627, 350], angle);
    const corners = quadPx(builder.build().vertices, 0);
    // Bottom edge midpoint (corners 2 and 3) is the needle tip.
    return [(corners[2]![0] + corners[3]![0]) / 2, (corners[2]![1] + corners[3]![1]) / 2];
  };
  const down = tip(0);
  close(down[0]!, 627); close(down[1]!, 350 + 121);
  const left = tip(Math.PI / 2);
  close(left[0]!, 627 - 121); close(left[1]!, 350);
  const up = tip(Math.PI);
  close(up[0]!, 627); close(up[1]!, 350 - 121);
  const builder = new UiBatchBuilder();
  builder.rotatedSprite(needle, [0, 0], 0.3);
  const { vertices } = builder.build();
  // UVs still map the logical (unpadded) sprite.
  assert.deepEqual([vertices[2], vertices[3], vertices[18], vertices[19]], [0, 0, Math.fround(73 / 128), Math.fround(121 / 128)]);
});

test("cropped sprites and alpha-tested draws keep UV padding and split commands by alpha reference", () => {
  const bar = sprite("rating1", 105, 15, false);
  const builder = new UiBatchBuilder();
  builder.croppedSprite({ x: 0, y: 0, width: 0.1, height: 0.1 }, bar, [0, 0, 0.5, 1]);
  builder.graphic(full, bar, { uvRect: [0, 0, 0.5, 1], flipGraphic: [1, 0] });
  builder.graphic(full, bar, { alphaTest: 200 });
  builder.graphic(full, bar, { alphaTest: 200 });
  builder.graphic(full, bar, { alphaTest: 120 });
  builder.graphic(full, bar);
  const { vertices, commands } = builder.build();
  const u1 = Math.fround(0.5 * 105 / 128);
  const v1 = Math.fround(15 / 16);
  assert.deepEqual([vertices[2], vertices[3], vertices[10], vertices[19]], [0, 0, u1, v1]);
  assert.deepEqual([vertices[48 + 2], vertices[48 + 10]], [u1, 0]);
  assert.deepEqual(commands.map(command => [command.alphaTest, command.vertexCount]),
    [[undefined, 12], [200, 12], [120, 6], [undefined, 6]]);
});

test("graphical numerals use NUMBERS sprites, 0.615/1.0 scale markup, −2 px spacing and colour codes", () => {
  const glyphs: NumeralGlyphs = Object.fromEntries([
    ...Array.from({ length: 10 }, (_, i) => [String(i), sprite(String(i), 25, 23)] as const),
    ["/", sprite("slash", 19, 23)], [".", sprite("fullstop", 9, 23)], [":", sprite("colon", 9, 23)],
    ["R", sprite("R", 23, 23)], ["N", sprite("N", 25, 23)],
  ]);
  const builder = new UiBatchBuilder();
  const measured = builder.measureNumerals(">1<D/6", glyphs);
  close(measured.width, (25 - 2) + (19 * 0.615 - 2) + (25 * 0.615 - 2));
  assert.equal(measured.height, 23);
  builder.numeralString(">1<D/6", 160, 58, 9, [220 / 255, 220 / 255, 220 / 255, 1], glyphs);
  const { vertices, commands } = builder.build();
  assert.equal(vertices.length / 8, 18);
  const [big, slash, six] = [0, 1, 2].map(i => quadPx(vertices, i));
  close(big![0]![0], 160 - measured.width);
  close(big![0]![1], 58);
  close(big![2]![0] - big![0]![0], 25);
  close(slash![0]![0], big![0]![0] + 23);
  close(slash![2]![1] - slash![0]![1], 23 * 0.615);
  close(six![0]![0], slash![0]![0] + 19 * 0.615 - 2);
  // First glyph keeps the item colour; `D` switches the rest to C_C0.
  close(vertices[4]!, 220 / 255);
  close(vertices[48 + 4]!, 139 / 255);
  assert.ok(commands.every(command => command.blend));

  const padded = new UiBatchBuilder();
  padded.numeralString("D 24", 576, 365, 4, [1, 1, 1, 1], glyphs);
  const quads = padded.build().vertices.length / 48;
  assert.equal(quads, 3);
  assert.equal(padded.build().commands[0]?.texture, glyphs["0"]);
});

test("textured line strips mitre their joints and map texture U across the width", () => {
  const track = sprite("MAP_TRACK", 16, 16);
  const builder = new UiBatchBuilder();
  builder.texturedLineStrip([[100, 100], [200, 100], [200, 200]], 8, track);
  const { vertices, commands } = builder.build();
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.vertexCount, 12);
  const first = quadPx(vertices, 0);
  const second = quadPx(vertices, 1);
  // Straight end offsets are ±4 px; the 90° joint is mitred to (±4, ±4) and shared by both segments.
  close(first[0]![1], 96); close(first[1]![1], 104);
  close(first[2]![0], 196); close(first[2]![1], 104);
  close(first[3]![0], 204); close(first[3]![1], 96);
  assert.deepEqual(second[0], first[3]);
  assert.deepEqual(second[1], first[2]);
  assert.deepEqual([vertices[2], vertices[10]], [0, 1]);
  builder.clear();
  builder.texturedLineStrip([[0, 0], [0, 0]], 8, track);
  assert.equal(builder.build().commands.length, 0);
});

test("HUD model selects fr3 dials, needle arcs, rounding and timers exactly", () => {
  assert.deepEqual([3500, 4000, 5000, 6000, 6500, 7500, 8800, 9000, 9500].map(selectRevDial), [4, 4, 6, 6, 7, 8, 9, 9, 10]);
  assert.deepEqual(selectSpeedDial("MPH", 85), { row: 0, cap: 90, sprite: "MPH/spdn90m" });
  assert.deepEqual(selectSpeedDial("MPH", 155), { row: 2, cap: 160, sprite: "MPH/spdn160m" });
  assert.deepEqual(selectSpeedDial("MPH", 240), { row: 5, cap: 240, sprite: "MPH/spdn240m" });
  assert.deepEqual(selectSpeedDial("KPH", 190), { row: 3, cap: 320, sprite: "KPH/spdn320k" });
  assert.deepEqual(selectSpeedDial("KPH", 200), { row: 5, cap: 400, sprite: "KPH/spdn400k" });
  assert.deepEqual(selectSpeedDial("KPH", 120), { row: 1, cap: 240, sprite: "KPH/spdn240k" });
  assert.deepEqual(selectSpeedDial("KPH", 165), { row: 2, cap: 280, sprite: "KPH/spdn280k" });
  close(needleAngle(CHASE_NEEDLE, 0, 7000), Math.PI * 0.24);
  close(needleAngle(CHASE_NEEDLE, 3500, 7000), Math.PI * (0.24 + 0.34));
  close(needleAngle(CHASE_NEEDLE, 99999, 7000), Math.PI * 0.92);
  close(needleAngle(BONNET_NEEDLE, -5, 100), Math.PI * 0.66);
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, -1.5, 2.4999, 2.6].map(roundHalfEven), [0, 2, 2, 0, -2, 2, 3]);
  close(speedToDisplayUnits(10, "MPH"), 22.374145220);
  close(speedToDisplayUnits(-10, "KPH"), 36);
  assert.deepEqual([3, 0, -1, -2].map(hudGearText), ["D3", "DN", "DR", ""]);
  assert.equal(formatHudTime(59.999), "00:59.99");
  assert.equal(formatHudTime(0.29), "00:00.29");
  assert.equal(formatHudTime(-61.5), "-01:01.50");
  assert.equal(formatHudTime(NaN), null);
  assert.equal(cameraModeToHudGroup("CHASE_FAR"), "chase");
  assert.equal(cameraModeToHudGroup("BUMPER"), "bonnet");
  assert.equal(cameraModeToHudGroup("LOOK_BACK", "bonnet"), "bonnet");
  assert.equal(cameraModeToHudGroup("INTRO"), "none");
  assert.equal(cameraModeToHudGroup("FINISH"), "other");
});

test("boost bar reproduces 0x52ff40 flame gradient for active burns and stored charges", () => {
  const hex = (row: readonly HudRgba[]) => row.map(colour => colour === HUD_COLOURS.B4 ? "o" : colour === HUD_COLOURS.BC ? "-"
    : colour === HUD_COLOURS.A4 ? "Y" : colour === HUD_COLOURS.TRAIL1 ? "1" : colour === HUD_COLOURS.TRAIL2 ? "2" : "?").join("");
  const [fullUpper, fullLower] = boostSegmentColours({ active: false, charges: 2, energy: 0 });
  assert.equal(hex(fullUpper), "oooooooooo");
  assert.equal(hex(fullLower), "oooooooooo");
  const [oneUpper, oneLower] = boostSegmentColours({ active: false, charges: 1, energy: 6.51 });
  assert.equal(hex(oneLower), "oooooooooo");
  assert.equal(hex(oneUpper), "ooY12ooooo");
  assert.equal(hex(boostSegmentColours({ active: false, charges: 1, energy: 3.5 })[0]), "oooooo----");
  const [noneUpper, noneLower] = boostSegmentColours({ active: false, charges: 0, energy: 0 });
  assert.equal(hex(noneUpper), "----------");
  assert.equal(hex(noneLower), "----------");
  const [burnUpper, burnLower] = boostSegmentColours({ active: true, charges: 1, elapsedFraction: 0.4 });
  assert.equal(hex(burnUpper), "oo21Y-----");
  assert.deepEqual(burnLower, burnUpper);
});

test("countdown chain pops start3→start0 at (320,260) and fires the race start at 2.9 s", () => {
  assert.equal(countdownFrame(-0.1), null);
  assert.equal(countdownFrame(COUNTDOWN_DURATION), null);
  const gap = countdownFrame(0.1)!;
  assert.deepEqual([gap.sprite, gap.visible, gap.soundCue, gap.stepStart], ["GENERIC/start3", false, 0x68, 0]);
  const pop = countdownFrame(0.175)!;
  close(pop.scale, 1 - 0.75 * 0.5); close(pop.y, 290 - 30 * 0.025);
  close(countdownFrame(0.2)!.scale, 0.25);
  close(countdownFrame(0.25)!.scale, 1.25);
  const hold = countdownFrame(0.5)!;
  assert.deepEqual([hold.visible, hold.x, hold.y, hold.scale], [true, 320, 260, 1]);
  assert.deepEqual([1.0, 1.9, 2.8].map(t => countdownFrame(t)!.sprite), ["GENERIC/start2", "GENERIC/start1", "GENERIC/start0"]);
  assert.deepEqual([1.0, 1.9, 2.8].map(t => countdownFrame(t)!.soundCue), [0x69, 0x67, 0x66]);
  close(COUNTDOWN_RACE_START_TIME, 2.9);
  assert.equal(countdownFrame(2.9)!.step, 3);
});

const course = [{ x: -10, z: -20 }, { x: 10, z: -20 }, { x: 10, z: 20 }, { x: -10, z: 20 }];
const baseInput: HudModelInput = {
  speedMps: 10.7277, rpm: 3500, maxRpm: 7000, gear: 3, units: "MPH", approxTopSpeedMph: 150,
  cameraGroup: "chase", position: 1, participants: 6, lap: 1, laps: 3,
  currentLapSeconds: 12.345, lastLapSeconds: 0, bestLapSeconds: 59.99, mode: "RACING_BOOST",
  boost: { active: false, energy: 0, charges: 2 }, wrongWay: true,
  map: { course, cars: [{ id: "player", x: 10, z: 20, local: true }, { id: "ai", x: -10, z: -20 },
    { id: "gone", x: 0, z: 0, active: false }] },
};

test("HUD draw list follows hud.c order, anchors and camera-group layouts", () => {
  const ops = buildHudDrawList(baseInput);
  const keyed = (kind: HudDrawOp["kind"]) => ops.filter(op => op.kind === kind);
  const first = (key: string) => ops.find(op => "key" in op && op.key === key) as Extract<HudDrawOp, { key: string }> | undefined;
  assert.deepEqual(ops.slice(0, 3).map(op => op.kind === "sprite" || op.kind === "needle" ? op.key : op.kind),
    ["REV/revc", "REV/revcn7", "REV/needle"]);
  assert.deepEqual(first("REV/revc"), { kind: "sprite", key: "REV/revc", x: 627, y: 466, justify: 3, colour: HUD_COLOURS.C4 });
  const needle = first("REV/needle") as Extract<HudDrawOp, { kind: "needle" }>;
  assert.deepEqual([needle.pivotX, needle.pivotY], [627, 350]);
  close(needle.angle, Math.PI * 0.58);
  assert.deepEqual(first("GENERIC/turnrnd"), { kind: "sprite", key: "GENERIC/turnrnd", x: 320, y: 160, justify: 4, colour: [220, 220, 220, 128] });
  const numerals = keyed("numerals") as Extract<HudDrawOp, { kind: "numerals" }>[];
  assert.deepEqual(numerals.map(op => [op.text, op.x, op.y, op.justify]), [
    ["D3", 576, 341, 4], ["D 24", 576, 365, 4], [">1<D/6", 160, 58, 9], [">1<D/3", 470, 58, 8],
  ]);
  const texts = keyed("text") as Extract<HudDrawOp, { kind: "text" }>[];
  assert.deepEqual(texts.map(op => [op.text, op.x, op.y, op.justify]), [
    ["POSITION", 166, 39, 9], ["LAP", 473, 39, 8], ["LAP 00:12.34", 604, 91, 9], ["BEST 00:59.99", 604, 108, 9],
    ["BOOST", 37, 142, 8],
  ]);
  assert.deepEqual(ops.filter(op => op.kind === "sprite" && op.key === "PANEL/pantimer").map(op => (op as { y: number }).y), [91, 108]);
  assert.equal(ops.filter(op => op.kind === "sprite" && op.key === "PANEL/boostbit").length, 20);
  // Text and numeral items are flushed after every sprite of the frame.
  const lastSprite = ops.map(op => op.kind).lastIndexOf("sprite");
  assert.ok(ops.findIndex(op => op.kind === "numerals" || op.kind === "text") > lastSprite);

  const strip = keyed("strip")[0] as Extract<HudDrawOp, { kind: "strip" }>;
  assert.equal(strip.width, 8);
  assert.deepEqual(strip.points, [[60, 440], [110, 440], [110, 340], [60, 340], [60, 440]]);
  const dots = keyed("quad") as Extract<HudDrawOp, { kind: "quad" }>[];
  assert.deepEqual(dots.map(dot => [dot.x0, dot.y0, dot.x1 - dot.x0, dot.colour]), [
    [54, 434, 12, [220, 220, 220, 180]], [55, 435, 10, [70, 142, 231, 180]], [104, 334, 12, [155, 23, 52, 180]],
  ]);

  const bonnet = buildHudDrawList({ ...baseInput, cameraGroup: "bonnet", units: "KPH", wrongWay: false });
  assert.deepEqual(bonnet.filter(op => op.kind === "sprite" || op.kind === "needle").slice(0, 6).map(op =>
    [(op as { key: string }).key, (op as { x?: number }).x ?? (op as { pivotX: number }).pivotX]), [
    ["REV/revb", 190], ["REV/revbn7", 190], ["REV/needle", 190], ["REV/spd", 450], ["KPH/spdn280k", 450], ["REV/needle", 450],
  ]);
  const bonnetNumerals = bonnet.filter(op => op.kind === "numerals") as Extract<HudDrawOp, { kind: "numerals" }>[];
  assert.deepEqual(bonnetNumerals.slice(0, 2).map(op => [op.text, op.x, op.y]), [["D3", 190, 432], ["D 39", 450, 432]]);
  const bonnetStrip = bonnet.find(op => op.kind === "strip") as Extract<HudDrawOp, { kind: "strip" }>;
  assert.deepEqual(bonnetStrip.points[0], [60, 360]);
  assert.equal(bonnet.some(op => op.kind === "sprite" && op.key === "GENERIC/turnrnd"), false);

  assert.deepEqual(buildHudDrawList({ ...baseInput, cameraGroup: "none" }), []);
  const other = buildHudDrawList({ ...baseInput, cameraGroup: "other", mode: "RACING", map: { ...baseInput.map!, enabled: false } });
  assert.equal(other.some(op => op.kind === "needle" || op.kind === "strip"), false);
  assert.equal(other.some(op => op.kind === "sprite" && op.key === "PANEL/panbst"), false);
  const countdown = buildHudDrawList({ ...baseInput, countdownTime: 0.5, launchBanner: { result: "super", time: 1 },
    measureText: text => text.length * 10 });
  const tail = countdown.slice(-3);
  assert.deepEqual(tail[0], { kind: "sprite", key: "GENERIC/start3", x: 320, y: 260, justify: 4, colour: HUD_COLOURS.A4, scale: 1 });
  assert.equal((tail[1] as { key: string }).key, "PANEL/colpan");
  close((tail[1] as { scaleX: number }).scaleX, 140 / (512 * 0.78) + 0.05);
  assert.deepEqual(tail[2], { kind: "text", font: 2, text: "SUPER START!!!", x: 320, y: 122, justify: 4, colour: HUD_COLOURS.C4 });
});

test("HUD batches draw authentic sprites from the atlas and only labels without one", () => {
  const names = ["REV/revc", "REV/revcn7", "REV/needle", "GENERIC/turnrnd", "PANEL/panpos", "PANEL/panlap",
    "PANEL/pantimer", "PANEL/panbst", "PANEL/boostbit", "MISC/MAP_TRACK", "MISC/MAP_DOT"];
  const sprites = new Map(names.map(name => [name, sprite(name, 32, 32)]));
  const digits: Record<string, PcgEntry> = Object.fromEntries(
    ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "/", "R", "N"].map(name => [name, sprite(`n${name}`, 25, 23)]));
  const atlasEntries: HudAtlas = { units: "MPH", sprites, numerals: digits };
  const batch = buildHudBatch(baseInput, 1280, 960, { body: atlas() }, { atlas: atlasEntries });
  const used = new Set(batch.commands.map(command => command.texture));
  for (const name of names) assert.ok(used.has(sprites.get(name)!), name);
  assert.ok(used.has(digits["3"]!));
  assert.ok(batch.commands.every(command => command.texture !== null), "no procedural untextured geometry");
  assert.ok(batch.vertices.every(Number.isFinite));
  assert.equal(batch.commands.reduce((total, command) => total + command.vertexCount, 0), batch.vertices.length / 8);

  const labelsOnly = buildHudBatch(baseInput, 640, 480, { body: atlas() });
  assert.ok(labelsOnly.commands.length > 0);
  assert.ok(labelsOnly.commands.every(command => command.texture !== null && "font" in command.texture));

  const legacy: HudState = {
    speedMps: 20, speedUnit: "KPH", rpm: 5400, redlineRpm: 6790, gear: 3, boost: 0.5, boostCharges: 1,
    position: 3, participants: 6, lap: 1, laps: 2, lapTime: 18.31, bestTime: 24.9, totalTime: 43.21,
    countdown: "GO", wrongWay: true,
    map: { course, player: { x: 0, z: 0 }, opponents: [{ x: -5, z: 5 }] },
  };
  const adapted = hudInputFromLegacyState(legacy);
  close(adapted.maxRpm, 7000);
  assert.equal(adapted.cameraGroup, "chase");
  assert.deepEqual(adapted.boost, { active: true, elapsedFraction: 0.5, energy: 0, charges: 1 });
  assert.equal(countdownFrame(adapted.countdownTime!)?.sprite, "GENERIC/start0");
  assert.equal(adapted.map?.cars.at(-1)?.local, true);
  const legacyBatch = buildHudBatch(legacy, 640, 480, { body: atlas() }, { atlas: atlasEntries });
  assert.ok(legacyBatch.commands.some(command => command.texture === sprites.get("REV/needle")));
});

import { fileURLToPath } from "node:url";

const demoPath = fileURLToPath(new URL("../../game", import.meta.url));

test("demo FORDGT, 04LIGHT and ENGAF compile LOD, named parts and textured triangles",
  { skip: !existsSync(demoPath) }, async () => {
    const vfs = await NodeVfs.open(demoPath);
    for (const dir of ["cars/fordgt", "cars/04light", "tracks/engaf"]) {
      const read = (file: string) => vfs.readUnpacked(`3ddata/${dir}/${file}`);
      const [textures, mesh, vertices, info, db] = await Promise.all(
        ["textures.dxt", "3dobjs.xbx", "3dobjsp.xbx", "bininfo.bin", "3dobjdb.bin"].map(read),
      );
      const archive = parseTexturesDxt(textures!);
      const xbx = parseXbx(mesh!, vertices!);
      const names = parseBinInfo(info!);
      const geometry = compileModelGeometry(xbx, archive, names, parse3dObjDb(db!, names), { livery: "A" });
      assert.ok(geometry.indices.length > 1000);
      assert.ok(geometry.indices.every(index => index < geometry.vertices.length / 14));
      assert.ok(geometry.batches.every(batch => batch.indexCount > 0 && batch.indexCount % 3 === 0 &&
        batch.firstIndex + batch.indexCount <= geometry.indices.length));
      for (const { material } of geometry.batches) {
        for (const index of [material.textureIndex, material.detailTextureIndex]) {
          if (index !== null) assert.equal(archive.textures[index]?.kind, "texture");
        }
      }
      const span = geometry.bounds.max.map((value, axis) => value - geometry.bounds.min[axis]!);
      if (dir.startsWith("cars/")) {
        assert.ok(geometry.subObjects.has("BODY"));
        for (const side of ["FRONT_LEFT", "FRONT_RIGHT", "BACK_LEFT", "BACK_RIGHT"]) {
          assert.equal(geometry.subObjects.get(`WHEEL_${side}`)?.length, 1);
          assert.equal(geometry.subObjects.get(`HUB_${side}`)?.length, 1);
        }
        assert.equal(geometry.subObjects.get("WHEEL_MOVING")?.length, 4);
        assert.equal(geometry.subObjects.get("WHEEL_STATIC")?.length, 4);
        assert.ok(geometry.subObjects.has(`${dir.split("/")[1]!.toUpperCase()}_SHADOW`));
        assert.ok(geometry.batches.some(batch => batch.material.pass === "shadow"));
        assert.ok(geometry.batches.some(batch => batch.material.textureIndex !== null &&
          archive.textures[batch.material.textureIndex]!.flags >>> 24 === 3));
        assert.ok(span[0]! > 1 && span[0]! < 4 && span[1]! > 0.5 && span[1]! < 3 && span[2]! > 3 && span[2]! < 7);
      } else {
        assert.ok(geometry.subObjects.has("ENGAF_CUT_UP"));
        assert.ok(geometry.subObjects.has("ENGAF_OBJECTS"));
        assert.ok(geometry.batches.some(batch => batch.material.prelit && batch.material.detailTextureIndex !== null));
        assert.ok(geometry.batches.some(batch => batch.material.pass === "cutout"));
        assert.ok(span[0]! > 1000 && span[0]! < 7000 && span[1]! < 2000 && span[2]! > 1000 && span[2]! < 7000);
      }
    }
  });

test("livery selection matches top-byte variants without flag 0x2000 and handles 4+ variants", () => {
  const part: MeshPartGeometry = {
    f: 0, g: 0xf0, primaryTexture: 0, vertexCount: 3, stripCount: 1, word8: 0, word12: 0,
    descriptorExtension: words(), strips: [], indices: Uint16Array.of(0, 1, 2),
    positions: floats(0, 0, 0, 1, 0, 0, 0, 1, 0), packedAttributes: words(1, 1, 1),
    normals: floats(0, 0, 1, 0, 0, 1, 0, 0, 1), colors: new Uint8Array(12),
    uv0: floats(0, 0, 1, 0, 0, 1),
  };
  const base: TextureRecord = {
    kind: "texture", name: "MUSTANG_68B_512", formatClass: 1, storage: "dxt1", flags: 0x00041080,
    scalar: 1, paletteSelector: 0, colorMetadata: 0, mips: [],
  };
  const archive: TextureArchive = {
    palettes256: [], palettes16: [], supplementaryPalettes256: [],
    textures: [
      base,
      { ...base, flags: 0x01001080 },
      { ...base, flags: 0x02001080 },
      { ...base, flags: 0x03001080 },
      { ...base, flags: 0x04001080 },
    ],
  };
  const names = Object.fromEntries(binInfoTableNames.map(name => [name, []])) as unknown as BinInfo;
  names.shapes = ["CAR"];
  names.textureLiveries = ["DEFAULT", "C", "B", "A", "D1"];
  const scene: SceneDatabase = {
    version: 18, header: words(), animationGroups: [], boundaryGroups: [], namedRecords: [],
    roots: [root(0, { meshSlotId: 1 })],
  };
  const model = [mesh(0, part), mesh(1, part)];
  const resolved = names.textureLiveries.map(livery =>
    compileModelGeometry(model, archive, names, scene, { livery }).batches[0]?.material.textureIndex,
  );
  assert.deepEqual(resolved, [0, 1, 2, 3, 4]);
});

test("livery selection switches textures on cars without 0x2000 flags and Capri trailing liveries",
  { skip: !existsSync(demoPath) }, async () => {
    const vfs = await NodeVfs.open(demoPath);
    const cases = [
      { dir: "cars/must68c", liveries: ["DEFAULT", "C", "B", "A", "D1"], expectUnique: 5 },
      { dir: "cars/01escap", liveries: ["DEFAULT", "C"], expectUnique: 2 },
      { dir: "cars/78cap", liveries: ["DEFAULT", "C", "B", "A"], expectUnique: 4 },
      { dir: "cars/boss302", liveries: ["DEFAULT", "C", "B", "A", "D1", "A2"], expectUnique: 6 },
      { dir: "cars/bmwm3gtr", liveries: ["DEFAULT", "A"], expectUnique: 1 },
      { dir: "cars/champ", liveries: ["DEFAULT", "A"], expectUnique: 1 },
    ];
    for (const { dir, liveries, expectUnique } of cases) {
      if (!vfs.has(`3ddata/${dir}/textures.dxt`)) continue;
      const read = (file: string) => vfs.readUnpacked(`3ddata/${dir}/${file}`);
      const [textures, meshData, vertices, info, db] = await Promise.all(
        ["textures.dxt", "3dobjs.xbx", "3dobjsp.xbx", "bininfo.bin", "3dobjdb.bin"].map(read),
      );
      const archive = parseTexturesDxt(textures!);
      const xbx = parseXbx(meshData!, vertices!);
      const names = parseBinInfo(info!);
      const scene = parse3dObjDb(db!, names);
      const signatures = new Set(liveries.map(livery => {
        const geometry = compileModelGeometry(xbx, archive, names, scene, { livery });
        assert.ok(geometry.batches.length > 0, `${dir} (${livery}) produced no batches`);
        return geometry.batches.map(b => b.material.textureIndex).join(",");
      }));
      assert.equal(signatures.size, expectUnique, `${dir}: expected ${expectUnique} distinct livery texture sets`);
    }
  });

test("a mesh with both texture stages assigns the authored UVs to each sampler", () => {
  const part: MeshPartGeometry = {
    f: 0xc0, g: 0xf0, primaryTexture: 0, vertexCount: 3, stripCount: 1, word8: 0, word12: 0,
    descriptorExtension: words(1 << 16, 2 << 16), strips: [], indices: Uint16Array.of(0, 1, 2),
    positions: floats(0, 0, 0, 1, 0, 0, 0, 1, 0), packedAttributes: words(), normals: floats(0, 0, 1, 0, 0, 1, 0, 0, 1),
    colors: new Uint8Array(12), uv0: floats(0, 0, 1, 0, 0, 1),
    uv1: floats(2, 3, 4, 5, 6, 7), uv2: floats(0.25, 0.5, 0.5, 0.5, 0.25, 0.75),
  };
  const base: TextureRecord = {
    kind: "texture", name: "Base", formatClass: 1, flags: 0, storage: "dxt1", scalar: 1,
    paletteSelector: 0, colorMetadata: 0, mips: [],
  };
  const archive: TextureArchive = {
    palettes256: [], palettes16: [], supplementaryPalettes256: [],
    textures: [base, { ...base, name: "Dark" }, { ...base, name: "Overlay", formatClass: 3, storage: "dxt3" }],
  };
  const names = Object.fromEntries(binInfoTableNames.map(name => [name, []])) as unknown as BinInfo;
  const scene: SceneDatabase = {
    version: 18, header: words(), animationGroups: [], boundaryGroups: [], namedRecords: [],
    roots: [root(0, { meshSlotId: 1 })],
  };
  const geometry = compileModelGeometry([mesh(0, part), mesh(1, part)], archive, names, scene);
  const material = geometry.batches[0]?.material;
  assert.equal(material?.textureIndex, 0);
  assert.equal(material?.darkTextureIndex, 1);
  assert.equal(material?.detailTextureIndex, 2);
  assert.deepEqual(geometry.darkUvs, part.uv1);
  assert.deepEqual([12, 13, 26, 27, 40, 41].map(index => geometry.vertices[index]), [...part.uv2!]);
});

test("track overlays retain the base layer and select the 0x40 texture",
  { skip: !existsSync(demoPath) }, async () => {
    const vfs = await NodeVfs.open(demoPath);
    const cases = [
      { id: "oval2", base: "TARMAC_TRACK2", overlay: "FENCE3", count: 2280 },
      { id: "oval3", base: "TARMAC_TRACK", overlay: "FENCE_NIGHT", count: 5930 },
      { id: "pacbf", base: "STREAM_PACIFIC", overlay: "SHADOWS", count: 107 },
      { id: "pacbr", base: "STREAM_PACIFIC", overlay: "SHADOWS", count: 107 },
    ];
    for (const { id, base, overlay, count } of cases) {
      const { geometry, archive } = await compileTrack(vfs, id);
      const name = (index: number | null) => index === null ? undefined : archive.textures[index]?.name;
      const matching = geometry.batches.filter(({ material }) =>
        name(material.textureIndex) === base && name(material.detailTextureIndex) === overlay);
      assert.ok(matching.length > 0, id);
      assert.ok(matching.every(({ material }) => material.pass === "opaque"), id);
      assert.ok(matching.every(({ material }) => material.darkTextureIndex !== undefined), id);
      assert.equal(geometry.darkUvs?.length, geometry.vertices.length / 14 * 2, id);
      assert.ok(geometry.batches.every(({ material }) =>
        !/^(BLACK256_5|BLACK128|COLOURTEST)/.test(name(material.detailTextureIndex) ?? "")), id);
      assert.equal(matching.reduce((sum, batch) => sum + batch.indexCount / 3, 0), count, id);
      if (id.startsWith("pacb")) {
        assert.ok(geometry.batches.some(({ material }) =>
          name(material.textureIndex) === "CLIFFBOTTOM" && material.detailTextureIndex === null &&
          name(material.darkTextureIndex ?? null) === "COLOURTEST03"), id);
      }
    }
  });

test("JUNGA and BAYAF sun glows use additive compositing and preserve scenery triangles",
  { skip: !existsSync(demoPath) }, async () => {
    const vfs = await NodeVfs.open(demoPath);
    for (const [id, indexCount] of [["junga", 271572], ["bayaf", 380397], ["pacbf", 157938], ["oval2", 218127]] as const) {
      const { geometry, archive } = await compileTrack(vfs, id);
      assert.equal(geometry.indices.length, indexCount, id);
      if (id === "junga" || id === "bayaf") {
        const glows = geometry.batches.filter(({ material }) => material.textureIndex !== null &&
          archive.textures[material.textureIndex]?.name === "SUNGLOW");
        assert.ok(glows.length > 0, id);
        assert.ok(glows.every(({ material }) => material.pass === "alpha" && material.additive), id);
        assert.ok(geometry.batches.some(({ material }) => material.textureIndex === null && !material.additive), id);
      }
    }
  });

test("real HUD atlas, loading sprites and MAP_TRACK/MAP_DOT load from the Shuffle data",
  { skip: !existsSync(demoPath) }, async () => {
    const assets = await DemoAssets.load(await NodeVfs.open(demoPath));
    for (const units of ["MPH", "KPH"] as const) {
      const atlasEntries = await assets.loadHudAtlas(units);
      assert.equal(await assets.loadHudAtlas(units), atlasEntries, "cached per units");
      const expected = [...HUD_SPRITE_MANIFEST.GENERIC.map(n => `GENERIC/${n}`), ...HUD_SPRITE_MANIFEST.PANEL.map(n => `PANEL/${n}`),
        ...HUD_SPRITE_MANIFEST.REV.map(n => `REV/${n}`), ...HUD_SPRITE_MANIFEST[units].map(n => `${units}/${n}`),
        ...HUD_SPRITE_MANIFEST.NUMBERS.map(n => `NUMBERS/${n}`), "MISC/MAP_TRACK", "MISC/MAP_DOT"];
      assert.deepEqual([...atlasEntries.sprites.keys()].sort(), expected.sort());
      const size = (key: string) => [atlasEntries.sprites.get(key)!.logicalWidth, atlasEntries.sprites.get(key)!.logicalHeight];
      assert.deepEqual(size("REV/needle"), [73, 121]);
      assert.deepEqual(size("REV/revc"), [128, 256]);
      assert.deepEqual(size("PANEL/panpos"), [173, 49]);
      assert.deepEqual(size("PANEL/boostbit"), [6, 22]);
      assert.deepEqual(size("GENERIC/turnrnd"), [84, 84]);
      assert.deepEqual(size("GENERIC/start0"), [110, 51]);
      assert.equal(atlasEntries.sprites.get(units === "MPH" ? "MPH/spdn140m" : "KPH/spdn140k")?.name,
        units === "MPH" ? "spdn140m" : "spdn140k");
      assert.deepEqual(["0", "/", ".", ":", "R", "N"].map(k => atlasEntries.numerals[k]?.logicalWidth), [25, 19, 9, 9, 23, 25]);
      const track = atlasEntries.sprites.get("MISC/MAP_TRACK")!;
      const rgba = decodePcgEntryRgba(track);
      assert.deepEqual([track.logicalWidth, track.logicalHeight, track.alphaFlag], [16, 16, true]);
      // The ribbon's alpha profile runs across U and is constant along V.
      assert.deepEqual([rgba[3], rgba[4 * 4 + 3], rgba[15 * 16 * 4 + 4 * 4 + 3]], [0, 0x99, 0x99]);
      const batch = buildHudBatch({ ...baseInput, units }, 640, 480, { body: assets.fonts[2]! }, { atlas: atlasEntries });
      assert.ok(batch.commands.some(command => command.texture === atlasEntries.sprites.get("REV/needle")));
    }
    const loading = await assets.loadLoadingSprites();
    assert.deepEqual([loading.load.logicalWidth, loading.load.logicalHeight], [1920, 1080]);
    assert.deepEqual([loading.bar.logicalWidth, loading.bar.logicalHeight, loading.bar2.logicalWidth], [13, 6, 13]);
  });

async function compileTrack(vfs: NodeVfs, id: string) {
  const [textureData, meshData, vertices, info, db] = await Promise.all(
    ["textures.dxt", "3dobjs.xbx", "3dobjsp.xbx", "bininfo.bin", "3dobjdb.bin"]
      .map(file => vfs.readUnpacked(`3ddata/tracks/${id}/${file}`)),
  );
  const archive = parseTexturesDxt(textureData!);
  const names = parseBinInfo(info!);
  const geometry = compileModelGeometry(parseXbx(meshData!, vertices!), archive, names, parse3dObjDb(db!, names));
  return { geometry, archive };
}

/** Every vertex position of a batch, in normalized coordinates. */
function positions(vertices: Float32Array): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < vertices.length; i += 8) out.push([vertices[i]!, vertices[i + 1]!]);
  return out;
}

test("UI batch clip rect cuts quads and interpolates their UVs and colours", () => {
  const builder = new UiBatchBuilder();
  const tile = sprite("tile", 64, 64, false);
  assert.equal(builder.setClip({ x: 0.25, y: 0, width: 0.5, height: 0.5 }), null);
  builder.graphic(full, tile);
  builder.gradientQuad(full, [1, 0, 0, 1], [0, 0, 1, 1]);
  builder.solidQuad({ x: 0.8, y: 0.8, width: 0.1, height: 0.1 }, [1, 1, 1, 1]);
  assert.deepEqual(builder.setClip(null), { x: 0.25, y: 0, width: 0.5, height: 0.5 });
  builder.solidQuad({ x: 0.8, y: 0.8, width: 0.1, height: 0.1 }, [1, 1, 1, 1]);
  const { vertices, commands } = builder.build();
  // The fully clipped quad is dropped; the unclipped one after setClip(null) is kept.
  assert.deepEqual(commands.map(command => command.vertexCount), [6, 12]);
  assert.deepEqual(quadPx(vertices, 0), [[160, 0], [480, 0], [480, 240], [160, 240]]);
  // UVs follow the cut: 0.25..0.75 of 64/64 stored columns, 0..0.5 of the rows.
  close(vertices[2]!, 0.25); close(vertices[3]!, 0); close(vertices[8 + 2]!, 0.75); close(vertices[16 + 3]!, 0.5);
  // Gradient colour at the clipped bottom edge (half way) is the midpoint of red→blue.
  const bottom = 48 + 2 * 8;
  close(vertices[bottom + 4]!, 0.5); close(vertices[bottom + 6]!, 0.5);
  quadPx(vertices, 2).flat().forEach((value, i) => close(value, [512, 384, 576, 384, 576, 432, 512, 432][i]!));
});

test("drawUiDrawItems scissors each item to its clipRect, so oversized highlighted text stays in its row", () => {
  const font = atlas();
  const row = { x: 0.5, y: 0.4, width: 0.5, height: 12 / 480 };
  const clipRect = { x: 0.5, y: 0.4, width: 0.5, height: 12 / 480 };
  const item: ResolvedUiDrawItem = {
    id: "BUTTON1", rect: row, textureRef: null, color: [255, 255, 0, 76], flip: [false, false], stretch: true,
    text: "A".repeat(100), font: 4,
    textColor: [125, 120, 40, 255], textJustify: 1, wordWrap: false, justifyOffset: [0, 0], highlighted: true,
    enabled: true, buttonId: "BUTTON1", clear: false, fill: true, autosize: false, graphicRect: row, textRect: row,
    clipRect,
  };
  const draw = (clip?: boolean) => {
    const builder = new UiBatchBuilder();
    drawUiDrawItems(builder, [item], { texture: () => undefined, font: () => font, clip });
    return builder.build().vertices;
  };
  const clipped = positions(draw());
  // 100 glyphs × 4 px from x 320 px run to ~720 px: without the scissor the text leaves the screen.
  assert.ok(positions(draw(false)).some(([x]) => x > 1));
  for (const [x, y] of clipped) {
    assert.ok(x >= clipRect.x - 1e-6 && x <= clipRect.x + clipRect.width + 1e-6, `x ${x}`);
    assert.ok(y >= clipRect.y - 1e-6 && y <= clipRect.y + clipRect.height + 1e-6, `y ${y}`);
  }
  // A clip that excludes everything paints nothing; an outer clip set by the caller is intersected and restored.
  const builder = new UiBatchBuilder();
  builder.setClip({ x: 0, y: 0, width: 0.6, height: 1 });
  drawUiDrawItems(builder, [item, { ...item, id: "GONE", clipRect: { x: 0.5, y: 0.4, width: 0, height: 0.1 } }],
    { texture: () => undefined, font: () => font });
  assert.deepEqual(builder.getClip(), { x: 0, y: 0, width: 0.6, height: 1 });
  for (const [x] of positions(builder.build().vertices)) assert.ok(x <= 0.6 + 1e-6);
  assert.equal(uiTextMeasurer([undefined, font])(1, "AA"), 9);
  assert.equal(uiTextMeasurer(() => undefined)(1, "AA"), undefined);
});

/** WebGL2 stand-in that records calls; enough for SceneRenderer to build programs and run a frame. */
function recordingGl() {
  const calls: { name: string; args: unknown[] }[] = [];
  const constants = new Map<string, number>([["DEPTH_BUFFER_BIT", 0x100], ["COLOR_BUFFER_BIT", 0x4000]]);
  const objects = (name: string) => ({ kind: name, id: calls.length });
  const gl = new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(property)) {
        if (!constants.has(property)) constants.set(property, 0x10000 + constants.size);
        return constants.get(property);
      }
      return (...args: unknown[]) => {
        calls.push({ name: property, args });
        if (property.startsWith("create")) return objects(property);
        if (property === "getParameter") return new Int32Array(4);
        if (property === "getShaderParameter" || property === "getProgramParameter") return true;
        if (property === "isEnabled") return false;
        if (property === "getUniformLocation") return { uniform: args[1] };
        if (property === "getExtension") return null;
        return undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  const canvas = { getContext: () => gl } as unknown as HTMLCanvasElement;
  return { calls, constants, context: new GlContext(canvas) };
}

test("car turntable keeps the CAR.PSD background: depth-only clear and no sky pass unless asked", () => {
  const { calls, constants, context } = recordingGl();
  const scene = new SceneRenderer(context);
  const programs = calls.filter(call => call.name === "createProgram").length;
  assert.equal(programs, 4);
  const geometry = {
    nodes: [], batches: [], subObjects: new Map(), bounds: { min: [-1, 0, -2], max: [1, 1.2, 2] },
  } as unknown as CompiledGeometry;
  const car = new CompiledModel(geometry, {} as WebGLVertexArrayObject, [], () => {});
  const colourBit = constants.get("COLOR_BUFFER_BIT")!;
  const depthBit = constants.get("DEPTH_BUFFER_BIT")!;
  const frame = (clearColor?: boolean) => {
    calls.length = 0;
    scene.renderCarTurntable(car, 0.3, { x: 0.45, y: 0.22, width: 0.53, height: 0.38 }, 1280, 720, clearColor);
    return calls.slice();
  };
  const overlay = frame();
  const clears = overlay.filter(call => call.name === "clear").map(call => call.args[0] as number);
  assert.deepEqual(clears, [depthBit]);
  assert.ok(clears.every(mask => (mask & colourBit) === 0));
  assert.equal(overlay.some(call => call.name === "clearColor"), false);
  // The sky is a full-viewport triangle (drawArrays TRIANGLES 0 3): it must not run over the UI.
  const skyDraws = (log: typeof overlay) => log.filter(call => call.name === "drawArrays" && call.args[1] === 0
    && call.args[2] === 3).length;
  assert.equal(skyDraws(overlay), 0);
  // The scissor stays on the turntable viewport (576, 158, 678, 274 at 1280×720, GL bottom-up y).
  const scissor = overlay.find(call => call.name === "scissor")!.args;
  assert.deepEqual(scissor, [576, 720 - 158 - 274, 678, 274]);
  assert.equal(skyDraws(frame(true)), 1);
});
