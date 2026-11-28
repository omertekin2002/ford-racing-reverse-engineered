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
import { compileModelGeometry, parseFogConfig } from "../src/render/sceneRenderer.js";
import { buildHudBatch, UiBatchBuilder } from "../src/render/uiRenderer.js";
import { NodeVfs } from "../src/vfs/nodeVfs.js";

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

test("HUD batches optional dial sprites, text and a course outline with live dots", () => {
  const dial = pcg(true);
  const map = { course: [{ x: -1, z: -1 }, { x: -1, z: 1 }, { x: 1, z: 1 }],
    player: { x: 0, z: 0 }, opponents: [{ x: -0.5, z: 0.5 }] };
  const batch = buildHudBatch({
    speedMps: 20, speedUnit: "KPH", rpm: 5400, redlineRpm: 7200, gear: 3, boost: 0.5, boostCharges: 2,
    position: 3, participants: 6, lap: 1, laps: 2, lapTime: 18.31, bestTime: 24.9,
    totalTime: 43.21, countdown: "GO", wrongWay: true, map,
  }, 1280, 720, { body: atlas() }, { rpmDial: dial });
  assert.ok(batch.commands.some(command => command.texture === dial && command.blend));
  assert.ok(batch.commands.some(command => command.texture === null && command.vertexCount > 100));
  assert.ok(batch.vertices.every(Number.isFinite));
  assert.equal(batch.commands.reduce((total, command) => total + command.vertexCount, 0), batch.vertices.length / 8);
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
