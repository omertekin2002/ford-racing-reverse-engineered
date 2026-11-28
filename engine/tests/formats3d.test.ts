import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateRawSync, deflateSync, inflateSync } from "node:zlib";

import { decodeA8R8G8B8, decodeDxt1, decodeDxt3, parseTexturesDxt } from "../src/formats/dxt.js";
import { expandTriangleStrip, parse3dObjDb, parseBinInfo, parseXbx } from "../src/formats/xbx.js";
import { NodeVfs } from "../src/vfs/nodeVfs.js";
import { ZipVfs } from "../src/vfs/zipVfs.js";
import { hasFr3Wrapper, unpackFr3Resource } from "../src/vfs/zlib.js";

function words(...values: number[]): Buffer {
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => data.writeUInt32LE(value, i * 4));
  return data;
}

function shorts(...values: number[]): Buffer {
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => data.writeUInt16LE(value & 0xffff, i * 2));
  return data;
}

function floats(...values: number[]): Buffer {
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => data.writeFloatLE(value, i * 4));
  return data;
}

function wrap(data: Buffer, level = 6): Buffer {
  return Buffer.concat([words(data.length), deflateSync(data, { level })]);
}

test("FR3 resource wrapper recognizes multiple zlib headers and checks output size", async () => {
  const text = Buffer.from("synthetic resource");
  const plain = Buffer.from("plain resource");
  assert.equal(hasFr3Wrapper(plain), false);
  assert.equal(await unpackFr3Resource(plain), plain);
  for (const level of [0, 1, 6, 9]) {
    const packet = Buffer.concat([Buffer.from([255]), wrap(text, level)]).subarray(1);
    assert.equal(hasFr3Wrapper(packet), true);
    assert.deepEqual(await unpackFr3Resource(packet), new Uint8Array(text));
  }
  assert.deepEqual(await unpackFr3Resource(wrap(Buffer.alloc(0))), new Uint8Array());
  const packet = wrap(text);
  packet.writeUInt32LE(text.length - 1);
  await assert.rejects(unpackFr3Resource(packet), /exceeds declared size/);
  packet.writeUInt32LE(text.length + 1);
  await assert.rejects(unpackFr3Resource(packet), /does not match declared size/);
  packet.writeUInt32LE(text.length);
  await assert.rejects(unpackFr3Resource(packet.subarray(0, -1)));
  packet[5] = packet[5]! ^ 1;
  assert.equal(hasFr3Wrapper(packet), false);
});

interface FixtureZipEntry {
  name: string;
  bytes: Buffer;
  deflate?: boolean;
  descriptor?: boolean;
}

function makeZip(entries: FixtureZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const method = entry.deflate ? 8 : 0;
    const flags = 0x800 | (entry.descriptor ? 8 : 0);
    const packed = entry.deflate ? deflateRawSync(entry.bytes) : entry.bytes;
    const stats = words(crc32(entry.bytes), packed.length, entry.bytes.length);
    const local = Buffer.concat([
      words(0x04034b50), shorts(20, flags, method, 0, 0),
      entry.descriptor ? Buffer.alloc(12) : stats,
      shorts(name.length, 0), name, packed,
      ...(entry.descriptor ? [words(0x08074b50), stats] : []),
    ]);
    locals.push(local);
    directory.push(Buffer.concat([
      words(0x02014b50), shorts(20, 20, flags, method, 0, 0), stats,
      shorts(name.length, 0, 0, 0, 0), words(0, localOffset), name,
    ]));
    localOffset += local.length;
  }
  const central = Buffer.concat(directory);
  // Include a signature in the comment to exercise the EOCD search.
  const comment = Buffer.concat([words(0x06054b50), Buffer.alloc(22, 1)]);
  const end = Buffer.concat([
    words(0x06054b50), shorts(0, 0, entries.length, entries.length),
    words(central.length, localOffset), shorts(comment.length), comment,
  ]);
  return Buffer.concat([...locals, central, end]);
}

test("ZIP VFS reads stored and deflated entries with case-insensitive game paths", async () => {
  const wrapped = wrap(Buffer.from("wrapped data"));
  const archive = makeZip([
    { name: "Data/", bytes: Buffer.alloc(0) },
    { name: "Data/Readme.TXT", bytes: Buffer.from("hello") },
    { name: "Data/Éntry.BIN", bytes: wrapped, deflate: true, descriptor: true },
  ]);
  const zip = new ZipVfs(archive);
  assert.equal(zip.has("\\Data\\README.Txt"), true);
  assert.equal(zip.has("data/"), false);
  assert.deepEqual(zip.list("DATA\\"), ["data/readme.txt", "data/éntry.bin"]);
  assert.equal(await zip.readText("data/readme.txt"), "hello");
  assert.deepEqual(await zip.readBytes("DATA/ÉNTRY.BIN"), new Uint8Array(wrapped));
  assert.equal(await zip.readText("Data/éntry.bin"), "wrapped data");
  await assert.rejects(zip.readBytes("missing"), /File not found/);

  const damaged = Buffer.from(archive);
  const payloadOffset = 30 + "Data/".length + 30 + "Data/Readme.TXT".length;
  damaged[payloadOffset] = damaged[payloadOffset]! ^ 1;
  await assert.rejects(new ZipVfs(damaged).readBytes("data/readme.txt"), /CRC mismatch/);
  assert.throws(() => new ZipVfs(archive.subarray(0, -1)), /central directory is missing/);
});

test("Node VFS indexes files, reads wrapped content and normalizes lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "fr3-vfs-"));
  try {
    await mkdir(join(root, "DATA"));
    const text = Buffer.from("node vfs");
    const packed = wrap(text);
    await writeFile(join(root, "DATA", "Test.BIN"), packed);
    const vfs = await NodeVfs.open(root);
    assert.deepEqual(vfs.list("\\DATA\\"), ["data/test.bin"]);
    assert.equal(vfs.has("/DATA/test.BIN"), true);
    assert.deepEqual(await vfs.readBytes("DATA/test.BIN"), packed);
    assert.equal(await vfs.readText("DATA/test.BIN"), "node vfs");
    await assert.rejects(vfs.readBytes("../test.bin"), /File not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DXT1 expands RGB565, interpolates and respects the three-color alpha mode", () => {
  const selectors = 0xe4e4e4e4;
  const block = Buffer.concat([shorts(0x001f, 0xf800), words(selectors)]);
  assert.deepEqual([...decodeDxt1(block, 4, 1)], [
    0, 0, 255, 255, 255, 0, 0, 255, 127, 0, 127, 255, 0, 0, 0, 0,
  ]);
  assert.deepEqual([...decodeDxt1(Buffer.concat([shorts(0xf800, 0x001f), words(selectors)]), 4, 1)], [
    255, 0, 0, 255, 0, 0, 255, 255, 170, 0, 85, 255, 85, 0, 170, 255,
  ]);
  assert.throws(() => decodeDxt1(block.subarray(0, 7), 4, 4), /payload size/);
});

test("DXT3 always uses four colors and replicates all explicit alpha nibbles", () => {
  const block = Buffer.concat([
    Buffer.from([0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe]),
    shorts(0x001f, 0xf800), words(0xffffffff),
  ]);
  const pixels = decodeDxt3(block, 4, 4);
  for (let i = 0; i < 16; i++) {
    assert.deepEqual([...pixels.subarray(i * 4, i * 4 + 4)], [170, 0, 85, i * 17]);
  }
  assert.deepEqual([...decodeA8R8G8B8(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))], [3, 2, 1, 4, 7, 6, 5, 8]);
});

test("textures.DXT preserves palettes, class metadata, mips and duplicate livery names", () => {
  const shared = Buffer.from("body\0");
  const reference = Buffer.from("shared\0");
  const record = (flags: number, cls: number, levels: number, width: number, height: number, data: Buffer) =>
    Buffer.concat([words(flags, shared.length), shared, words(cls, levels), floats(0.5),
      words(width, height, 1, 0x1234), data]);
  const bytes = Buffer.concat([
    words(1, 1, 1), Buffer.alloc(1024, 1), Buffer.alloc(64, 2), Buffer.alloc(1024, 3),
    words(5, shared.length * 4 + reference.length),
    record(0x30180, 1, 1, 8, 8, Buffer.alloc(40, 10)),
    record(0x100208c, 2, 0, 4, 4, Buffer.alloc(8, 20)),
    record(0x2002084, 3, 0, 4, 4, Buffer.alloc(16, 30)),
    record(0x3002094, 3, 0, 4, 4, Buffer.alloc(64, 40)),
    words(1, reference.length), reference,
  ]);
  const parsed = parseTexturesDxt(bytes);
  assert.deepEqual([parsed.palettes256[0]?.length, parsed.palettes16[0]?.[4],
    parsed.supplementaryPalettes256[0]?.[3]], [1024, 2, 3]);
  assert.deepEqual(parsed.textures.map(texture => texture.name), ["body", "body", "body", "body", "shared"]);
  assert.deepEqual(parsed.textures.flatMap(texture => texture.kind === "texture" ? [texture.storage] : []),
    ["dxt1", "dxt1", "dxt3", "a8r8g8b8"]);
  const first = parsed.textures[0];
  assert.equal(first?.kind, "texture");
  assert.deepEqual(first.mips.map(mip => [mip.width, mip.height, mip.data.length, mip.data[0]]),
    [[8, 8, 32, 10], [4, 4, 8, 10]]);
  assert.equal(first.scalar, 0.5);
  assert.equal(first.paletteSelector, 1);
  assert.equal(first.colorMetadata, 0x1234);
  assert.deepEqual(parsed.textures[4], { kind: "reference", name: "shared", flags: 1 });
  assert.throws(() => parseTexturesDxt(Buffer.concat([bytes, Buffer.alloc(1)])), /Trailing/);
});

test("triangle strips alternate winding across degenerate triples", () => {
  assert.deepEqual([...expandTriangleStrip([0, 1, 2, 1, 3, 4])], [0, 1, 2, 2, 1, 3, 1, 4, 3]);
  assert.deepEqual([...expandTriangleStrip([0, 1])], []);
});

test("XBX reads both descriptor groups before indices and unpacks parallel vertex arrays", () => {
  const slot = Buffer.alloc(88);
  slot.writeFloatLE(5, 0x0c);
  floats(-1, 1, -2, 2, -3, 3).copy(slot, 0x10);
  shorts(1, 0x80).copy(slot, 0x28);
  shorts(1, 3).copy(slot, 0x38);
  floats(100, -50).copy(slot, 0x50);
  const descriptors = Buffer.concat([
    Buffer.from([0xde, 0x09]), shorts(1, 3, 1), words(7, 8),
    words(...Array.from({ length: 11 }, (_, index) => index)),
    Buffer.from([0, 0]), shorts(0xffff, 1, 0), words(9, 10, 11),
  ]);
  const mesh = Buffer.concat([words(2), Buffer.alloc(88), slot, descriptors, shorts(3, 0, 1, 2)]);
  const vertices = Buffer.concat([
    floats(1, 2, 3, 4, 5, 6, 7, 8, 9), Buffer.alloc(12, 1), Buffer.alloc(48, 2),
    words(0xff0003fc, 0x3f008000, 0), shorts(2048, -4096, 0, 0, 0, 0),
    shorts(-2048, 2048, 0, 0, 0, 0), shorts(4096, 2048, 0, 0, 0, 0),
    floats(10, 11, 12), words(0x01020304),
  ]);
  const model = parseXbx(mesh, vertices);
  assert.deepEqual(model[0]?.groups, [[], []]);
  const vehicle = model[1]!;
  assert.equal(vehicle.group2Flags, 3);
  assert.deepEqual([...vehicle.bounds], [-1, 1, -2, 2, -3, 3]);
  const first = vehicle.groups[0][0]!;
  const second = vehicle.groups[1][0]!;
  assert.equal(first.descriptorExtension.length, 11);
  assert.deepEqual([...first.indices], [0, 1, 2]);
  assert.deepEqual([...first.positions], [101, 2, -47, 104, 5, -44, 107, 8, -41]);
  assert.ok(Math.abs(first.normals[0]! + 0.8) < 1e-6);
  assert.ok(Math.abs(first.normals[1]! - 0.6) < 1e-6);
  assert.deepEqual([...first.normals.slice(3)], [0, -1, 0, 0, 0, 0]);
  assert.deepEqual([...first.colors.slice(0, 4)], [252, 3, 0, 255]);
  assert.deepEqual([...first.uv0!.slice(0, 2)], [1, -2]);
  assert.deepEqual([...first.uv1!.slice(0, 2)], [-1, 1]);
  assert.deepEqual([...first.uv2!.slice(0, 2)], [2, 1]);
  assert.deepEqual(first.vertexExtension?.map(block => [block.length, block[0]]), [[12, 1], [48, 2]]);
  assert.equal(second.primaryTexture, null);
  assert.equal(second.uv0, undefined);
  assert.deepEqual([...second.positions], [110, 11, -38]);
  const raw = parseXbx(mesh, vertices, { applySlotOffsets: false });
  assert.deepEqual([...raw[1]!.groups[0][0]!.positions.slice(0, 3)], [1, 2, 3]);
  assert.throws(() => parseXbx(mesh, vertices.subarray(0, -1)), /Truncated 3dobjsp.XBX/);
  const badIndex = Buffer.from(mesh);
  badIndex.writeUInt16LE(3, badIndex.length - 2);
  assert.throws(() => parseXbx(badIndex, vertices), /exceeds vertex count/);
});

function namesFixture(): Buffer {
  const strings = ["ROOT\0", "SECTOR\0", "WHEEL\0", "PAINT\0"].map(text => Buffer.from(text));
  const first = 4 + (11 + strings.length) * 4;
  const offsets: number[] = [];
  let next = first;
  for (const string of strings) {
    offsets.push(next);
    next += string.length;
  }
  return Buffer.concat([
    words(next, 2, offsets[0]!, offsets[1]!, 1, offsets[2]!, 0, 1, offsets[3]!, ...Array<number>(7).fill(0)),
    ...strings,
  ]);
}

test("bininfo.BIN follows absolute offsets across all eleven tables", () => {
  const bytes = namesFixture();
  const parsed = parseBinInfo(bytes);
  assert.equal(Object.keys(parsed).length, 11);
  assert.deepEqual(parsed.shapes, ["ROOT", "SECTOR"]);
  assert.deepEqual(parsed.subObjects, ["WHEEL"]);
  assert.deepEqual(parsed.textureLiveries, ["PAINT"]);
  assert.deepEqual(parsed.textureNames, []);
  const badOffset = Buffer.from(bytes);
  badOffset.writeUInt32LE(0, 8);
  assert.throws(() => parseBinInfo(badOffset), /string offset/);
  assert.throws(() => parseBinInfo(bytes.subarray(0, -1)), /length does not match/);
});

function sceneFixture(): Buffer {
  const header = words(18, 2, 1, 1, 1, 1, 1, 0, 0, 2, 1, 1, 1, 2, 0, 1, 0, 0);
  const sentinels = Buffer.alloc(16, 255);
  const camera = Buffer.alloc(108, 0);
  camera.writeUInt32LE(1, 12);
  const root = Buffer.concat([
    sentinels, words(0, 0x41), floats(1, 2, 3, 4, 5, 6), words(...Array<number>(15).fill(7)),
    words(1), Buffer.alloc(28, 8), words(1), floats(1, 2, 3), words(0x101, 14, 15, 0x10001),
    Buffer.alloc(32, 9), words(0xe, 1), Buffer.alloc(28, 10),
    words(22, 1), camera, Buffer.alloc(108), words(1, 23, 24),
    words(2), floats(0, 64), words(2, 1, 1, 42, 5, 6, 7, 1, 25, 26, 1),
    words(8, 9), floats(10, 11, 12, 13, 14, 15), words(1, 27, 28, 1),
    words(9, 10), floats(0, 0, 0, 0, 0, 0), words(0, 0),
  ]);
  const sector = Buffer.concat([
    sentinels, words(1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 6, 0, 0, 0, 1, 0),
  ]);
  const name = Buffer.from("scene-entry\0");
  return Buffer.concat([
    header, root, sector,
    words(1, 1, 1), shorts(1), Buffer.from([7, 8]), floats(1, 2, 3, 4), words(5, 6),
    words(1, 1, 1), floats(0, 0, 4, 0, 0, 4),
    words(1, name.length, 11, 12, name.length), name, Buffer.alloc(88, 13),
  ]);
}

test("3dobjdb.BIN parses root modes, recursive children and all trailing sections", () => {
  const data = sceneFixture();
  const names = parseBinInfo(namesFixture());
  const scene = parse3dObjDb(data, names);
  const [root, sector] = scene.roots;
  assert.equal(root?.meshSlotId, 5);
  assert.deepEqual([...root.transforms[0]!.first], [1, 2, 3]);
  assert.deepEqual([...root.transforms[0]!.second], [4, 5, 6]);
  assert.equal(root.boundaries[0]?.[27], 8);
  assert.deepEqual([...root.points], [1, 2, 3]);
  assert.deepEqual(root.references, [[14, 15]]);
  assert.equal(root.secondaryRecords[0]?.[31], 9);
  assert.equal(root.modeBoundaries[0]?.[27], 10);
  assert.equal(root.cameraControl, 22);
  assert.equal(root.cameras[0]?.children.length, 1);
  assert.deepEqual(root.modePairs, [[23, 24]]);
  assert.deepEqual([...root.lodValues], [0, 64]);
  assert.deepEqual([...root.preMeshWords], [42]);
  assert.deepEqual(root.meshPairs, [[25, 26]]);
  assert.equal(root.children.kind, "inline");
  const child = root.children.nodes[0]!;
  assert.equal(child.meshSlotId, 8);
  assert.deepEqual(child.pairs, [[27, 28]]);
  assert.equal(child.children[0]?.meshSlotId, 9);
  assert.equal(sector?.children.kind, "indirect");
  assert.deepEqual([...sector.children.references], [0]);
  const animation = scene.animationGroups[0]?.[0];
  assert.deepEqual([animation?.option0, animation?.option1], [7, 8]);
  assert.deepEqual([...(animation?.ranges[0]?.values ?? [])], [1, 2, 3, 4]);
  assert.deepEqual(animation?.ranges[0]?.trailingWords, [5, 6]);
  const boundary = scene.boundaryGroups[0]![0]!;
  assert.deepEqual([...boundary.points], [0, 0, 4, 0, 0, 4]);
  assert.equal(boundary.lastWord, 0x40800000);
  assert.equal(scene.namedRecords[0]?.name, "scene-entry");
  assert.equal(scene.namedRecords[0]?.fields[87], 13);
  assert.throws(() => parse3dObjDb(data.subarray(0, -1), names), /Truncated 3dobjdb.BIN/);
  assert.throws(() => parse3dObjDb(Buffer.concat([data, Buffer.alloc(1)]), names), /Trailing/);
});

import { fileURLToPath } from "node:url";

const demoPath = fileURLToPath(new URL("../../game", import.meta.url));

test("core Shuffle 3D sets (FORDGT, 04LIGHT, ENGAF, MISC) parse to EOF and match geometry", { skip: !existsSync(demoPath) }, async () => {
  const vfs = await NodeVfs.open(demoPath);
  const dirs = ["3ddata/cars/fordgt", "3ddata/cars/04light", "3ddata/tracks/engaf", "3ddata/misc"];
  for (const dir of dirs) {
    const textures = parseTexturesDxt(await vfs.readUnpacked(`${dir}/textures.dxt`));
    const slots = parseXbx(await vfs.readUnpacked(`${dir}/3dobjs.xbx`), await vfs.readUnpacked(`${dir}/3dobjsp.xbx`));
    const names = parseBinInfo(await vfs.readUnpacked(`${dir}/bininfo.bin`));
    const scene = parse3dObjDb(await vfs.readUnpacked(`${dir}/3dobjdb.bin`), names);
    const parts = slots.flatMap(slot => slot.groups.flat());
    const triangles = parts.reduce((count, part) => count + part.indices.length / 3, 0);
    assert.ok(textures.textures.length > 0, dir);
    assert.ok(triangles > 0, dir);

    if (dir.endsWith("/fordgt")) {
      assert.equal(triangles, 11229);
      const slot = slots[1]!;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const part of slot.groups.flat()) {
        for (let i = 2; i < part.positions.length; i += 3) {
          const z = part.positions[i]!;
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
        }
      }
      assert.ok(Math.abs(maxZ - minZ - 4.616072) < 1e-5);
      assert.ok(Math.abs(slot.bounds[5]! - slot.bounds[4]! - 4.616072) < 1e-5);
    }
    if (dir.endsWith("/engaf")) {
      assert.equal(triangles, 83471);
      assert.equal(scene.boundaryGroups.length, 23);
      assert.equal(scene.boundaryGroups.reduce((total, group) => total + group.length, 0), 262);
      assert.equal(scene.namedRecords.length, 22);
    }
    if (dir.endsWith("/misc")) {
      assert.ok(scene.animationGroups.length >= 35);
      assert.ok(scene.namedRecords.length >= 51);
    }
  }
  // 10-table bininfo.BIN (UI track previews and FR2 tracks) parses cleanly.
  const uiBin = parseBinInfo(await vfs.readUnpacked("3ddata/ui/engaf/bininfo.bin"));
  assert.deepEqual(uiBin.shapes, ["ENGAF"]);
  assert.deepEqual(uiBin.textureNames, []);
});

test("FR3 zlib fallback handles trailing junk and stale size prefixes while still rejecting corruption", async () => {
  const payload = Buffer.from(
    "FR3 Shuffle trailing junk regression payload ".repeat(64) +
    Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join(""),
    "latin1",
  );
  const junk = Buffer.alloc(1024, 0xa5);
  for (const level of [0, 1, 6, 9]) {
    const compressed = deflateSync(payload, { level });
    // Trailing junk with matching declared size, stale larger size, and stale smaller size.
    for (const declaredSize of [payload.length, payload.length + 50_000, Math.max(0, payload.length - 100)]) {
      const packet = Buffer.concat([words(declaredSize), compressed, junk]);
      assert.equal(hasFr3Wrapper(packet), true);
      assert.deepEqual(await unpackFr3Resource(packet), new Uint8Array(payload));
    }
    // Corrupting the Adler-32 trailer must still reject even when trailing junk is present.
    const badAdler = Buffer.concat([words(payload.length + 100), compressed, junk]);
    badAdler[4 + compressed.length - 1] = badAdler[4 + compressed.length - 1]! ^ 0xff;
    await assert.rejects(unpackFr3Resource(badAdler));
  }
  // Empty payload with trailing junk and stale size.
  const emptyPacket = Buffer.concat([words(1234), deflateSync(Buffer.alloc(0)), junk]);
  assert.deepEqual(await unpackFr3Resource(emptyPacket), new Uint8Array());
  // Corrupting deflate data must reject even with trailing junk.
  const badDeflate = Buffer.concat([words(payload.length), deflateSync(payload), junk]);
  badDeflate[6] = badDeflate[6]! ^ 0xff;
  badDeflate[7] = badDeflate[7]! ^ 0xff;
  await assert.rejects(unpackFr3Resource(badDeflate));
});

test("3dobjdb.BIN handles out-of-order roots, stale header totals, and version 17 headers", () => {
  const names = parseBinInfo(namesFixture());
  const sentinels = Buffer.alloc(16, 255);
  const root0 = Buffer.concat([
    sentinels, words(0, 0, 0, 0, 0, 0, 0, 2), floats(0, 50), words(0, 0, 1, 99, 5, 0, 0, 0, 0),
  ]);
  const root1 = Buffer.concat([
    sentinels, words(1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 6, 0, 0, 0, 1, 0),
  ]);
  const trailer = Buffer.concat([words(0, 0), words(0, 0)]);

  // C2 + C3: root 1 stored before root 0, plus stale header totals on words 4, 12, and 13.
  const staleHeader = words(18, 2, 0, 0, 99, 0, 0, 0, 0, 0, 0, 1, 77, 88, 0, 0, 0, 0);
  const outOfOrder = parse3dObjDb(Buffer.concat([staleHeader, root1, root0, trailer]), names);
  assert.equal(outOfOrder.version, 18);
  assert.equal(outOfOrder.header.length, 18);
  assert.deepEqual(outOfOrder.roots.map(r => r.shapeId), [0, 1]);
  assert.equal(outOfOrder.roots[0]?.meshSlotId, 5);
  assert.equal(outOfOrder.roots[1]?.meshSlotId, 6);

  // Duplicate and out-of-range shape IDs are still rejected.
  assert.throws(
    () => parse3dObjDb(Buffer.concat([staleHeader, root0, root0, trailer]), names),
    /Duplicate 3dobjdb\.BIN root/,
  );
  const badIdRoot = Buffer.from(root1);
  badIdRoot.writeUInt32LE(2, 16);
  assert.throws(
    () => parse3dObjDb(Buffer.concat([staleHeader, root0, badIdRoot, trailer]), names),
    /Invalid 3dobjdb\.BIN shape header id 2/,
  );

  // C4: version 17 uses a 17-word header (omitting word 17) with the same root & trailer layout.
  const v17Header = words(17, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 0, 0, 0);
  const v17 = parse3dObjDb(Buffer.concat([v17Header, root1, root0, trailer]), names);
  assert.equal(v17.version, 17);
  assert.equal(v17.header.length, 17);
  assert.deepEqual(v17.roots.map(r => r.shapeId), [0, 1]);
  assert.equal(v17.roots[0]?.meshSlotId, 5);
  assert.equal(v17.roots[1]?.meshSlotId, 6);

  // Unsupported versions still throw.
  const v16Header = Buffer.from(v17Header);
  v16Header.writeUInt32LE(16, 0);
  assert.throws(() => parse3dObjDb(Buffer.concat([v16Header, root0, root1, trailer]), names), /Unsupported 3dobjdb\.BIN version 16/);
});

test("Shuffle modded tracks (v17, out-of-order) and cars (stale headers, trailing zlib junk) parse cleanly", { skip: !existsSync(demoPath) }, async () => {
  const vfs = await NodeVfs.open(demoPath);

  // C4: all 17 version-17 FR2 port tracks.
  const v17Tracks = [
    "bayaf", "bayb", "bayc", "flora", "florb", "florc",
    "desa", "desb", "desc", "fukuoka", "junga", "jungb", "jungc",
    "oval2", "oval3", "spring", "spring2",
  ];
  for (const track of v17Tracks) {
    const dir = `3ddata/tracks/${track}`;
    const binInfo = parseBinInfo(await vfs.readUnpacked(`${dir}/bininfo.bin`));
    const slots = parseXbx(await vfs.readUnpacked(`${dir}/3dobjs.xbx`), await vfs.readUnpacked(`${dir}/3dobjsp.xbx`));
    const scene = parse3dObjDb(await vfs.readUnpacked(`${dir}/3dobjdb.bin`), binInfo);
    assert.equal(scene.version, 17, track);
    assert.equal(scene.header.length, 17, track);
    assert.equal(scene.roots.length, binInfo.shapes.length, track);
    assert.ok(slots.length > 0, track);
    for (let i = 0; i < scene.roots.length; i++) assert.equal(scene.roots[i]!.shapeId, i, track);
  }

  // C2: representative out-of-order tracks.
  for (const track of ["engbf", "pacbf", "paccf", "tfukuoka", "tmonza"]) {
    const dir = `3ddata/tracks/${track}`;
    const binInfo = parseBinInfo(await vfs.readUnpacked(`${dir}/bininfo.bin`));
    const scene = parse3dObjDb(await vfs.readUnpacked(`${dir}/3dobjdb.bin`), binInfo);
    assert.equal(scene.roots.length, binInfo.shapes.length, track);
    for (let i = 0; i < scene.roots.length; i++) assert.equal(scene.roots[i]!.shapeId, i, track);
  }

  // C3 + C5: stale-header cars and all 5 trailing-junk car directories.
  const trailingCars = ["75ranch", "cnmust", "fiestast", "v6must", "v6mus2"];
  for (const car of trailingCars) {
    const dir = `3ddata/cars/${car}`;
    const rawObjs = await vfs.readBytes(`${dir}/3dobjs.xbx`);
    const rawObjsp = await vfs.readBytes(`${dir}/3dobjsp.xbx`);
    const objs = await vfs.readUnpacked(`${dir}/3dobjs.xbx`);
    const objsp = await vfs.readUnpacked(`${dir}/3dobjsp.xbx`);
    assert.deepEqual(objs, new Uint8Array(inflateSync(rawObjs.subarray(4))), `${car}/3dobjs.xbx`);
    assert.deepEqual(objsp, new Uint8Array(inflateSync(rawObjsp.subarray(4))), `${car}/3dobjsp.xbx`);
    const slots = parseXbx(objs, objsp);
    assert.ok(slots.length > 0, car);
  }
  for (const car of ["01escap", "67gt500", "boss302", "rs200", "caprsev", ...trailingCars]) {
    const dir = `3ddata/cars/${car}`;
    const binInfo = parseBinInfo(await vfs.readUnpacked(`${dir}/bininfo.bin`));
    const scene = parse3dObjDb(await vfs.readUnpacked(`${dir}/3dobjdb.bin`), binInfo);
    assert.equal(scene.roots.length, binInfo.shapes.length, car);
  }
});
