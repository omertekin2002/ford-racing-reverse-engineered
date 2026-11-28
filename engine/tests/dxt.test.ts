import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  decodeA8R8G8B8, decodeR8G8B8, decodeR8G8B8T8, decodeTextureMip, parseTexturesDxt,
} from "../src/formats/dxt.js";
import { NodeVfs } from "../src/vfs/nodeVfs.js";

function words(...values: number[]): Buffer {
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => data.writeUInt32LE(value >>> 0, i * 4));
  return data;
}

function floats(...values: number[]): Buffer {
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => data.writeFloatLE(value, i * 4));
  return data;
}

function makeRecord(
  name: string, flags: number, formatClass: number, extraMips: number,
  width: number, height: number, payload: Buffer,
): Buffer {
  const rawName = Buffer.from(`${name}\0`);
  return Buffer.concat([
    words(flags, rawName.length), rawName,
    words(formatClass, extraMips), floats(1),
    words(width, height, 0, 0), payload,
  ]);
}

test("decoders handle 24-bit RGB, 32-bit inverted-alpha RGBT, and backward-compatible A8R8G8B8", () => {
  assert.deepEqual([...decodeR8G8B8(Uint8Array.of(0x5d, 0x7a, 0x97, 0xb2, 0x09, 0x0c))], [
    0x5d, 0x7a, 0x97, 255, 0xb2, 0x09, 0x0c, 255,
  ]);
  assert.throws(() => decodeR8G8B8(Uint8Array.of(1, 2)), /Invalid R8G8B8 payload size/);

  assert.deepEqual([...decodeR8G8B8T8(Uint8Array.of(0x97, 0xa8, 0xbd, 0xff, 0x10, 0x20, 0x30, 0x00))], [
    0x97, 0xa8, 0xbd, 0, 0x10, 0x20, 0x30, 255,
  ]);
  assert.throws(() => decodeR8G8B8T8(Uint8Array.of(1, 2, 3)), /Invalid R8G8B8T8 payload size/);

  assert.deepEqual([...decodeA8R8G8B8(Uint8Array.of(1, 2, 3, 4))], [3, 2, 1, 4]);
});

test("parseTexturesDxt handles 24-bit class 1/5, format class 5 DXT1, omitted 0x10 flag, and trailing valid records", () => {
  // C1: class 1 with flag 0x10 -> 24-bit RGB (4x4 + 2x2 = 20 pixels = 60 bytes)
  const rgb24 = makeRecord("RGB24", 0x1390, 1, 1, 4, 4, Buffer.alloc(60, 0x42));
  // C7: format class 5 compressed -> DXT1 (4x4 = 8 bytes)
  const class5Dxt1 = makeRecord("SNOW_CLASS5", 0x1180, 5, 0, 4, 4, Buffer.alloc(8, 0x11));
  // C8: class 3 without flag 0x10 but storing 4 bpp uncompressed (4x4 = 64 bytes instead of 16 bytes DXT3)
  const shadowHdr = makeRecord("SHADOW_HDR", 0x5384, 3, 0, 4, 4, Buffer.alloc(64, 0x80));
  // Following normal record to anchor the C8 boundary
  const normalDxt3 = makeRecord("AFTER_HDR", 0x12f4, 3, 0, 4, 4, Buffer.alloc(64, 0x20));
  // C6: extra valid record beyond declared count (header declares 4, file has 5)
  const trailingLogo = makeRecord("CAP_LOGO", 0x1001a84, 3, 0, 4, 4, Buffer.alloc(16, 0x33));

  const bytes = Buffer.concat([
    words(0, 0, 0, 4, 0),
    rgb24, class5Dxt1, shadowHdr, normalDxt3, trailingLogo,
  ]);
  const parsed = parseTexturesDxt(bytes);
  assert.equal(parsed.textures.length, 5);
  assert.deepEqual(
    parsed.textures.map(t => t.kind === "texture" ? [t.name, t.formatClass, t.storage, t.mips.length] : null),
    [
      ["RGB24", 1, "r8g8b8", 2],
      ["SNOW_CLASS5", 5, "dxt1", 1],
      ["SHADOW_HDR", 3, "a8r8g8b8", 1],
      ["AFTER_HDR", 3, "a8r8g8b8", 1],
      ["CAP_LOGO", 3, "dxt3", 1],
    ],
  );
  for (const record of parsed.textures) {
    assert.equal(record.kind, "texture");
    for (const [level, mip] of record.mips.entries()) {
      const rgba = decodeTextureMip(record, level);
      assert.equal(rgba.length, mip.width * mip.height * 4);
    }
  }

  // Genuine trailing garbage must still be rejected.
  assert.throws(() => parseTexturesDxt(Buffer.concat([bytes, Buffer.from([1, 2, 3, 4, 5])])), /Trailing/);
  assert.throws(() => parseTexturesDxt(Buffer.concat([bytes, Buffer.alloc(32)])), /Trailing/);
});

const gamePath = fileURLToPath(new URL("../../game", import.meta.url));

test("all installed track and car textures.DXT archives parse to EOF and decode cleanly to RGBA",
  { skip: !existsSync(gamePath) }, async () => {
    const vfs = await NodeVfs.open(gamePath);
    const files = vfs.list("3ddata/").filter(file => file.endsWith("/textures.dxt")).sort();
    assert.ok(files.length >= 270, `Expected full game textures.dxt corpus, found ${files.length}`);

    let trackFiles = 0;
    let carFiles = 0;
    let decodedTextures = 0;
    for (const file of files) {
      if (file.startsWith("3ddata/tracks/")) trackFiles++;
      else if (file.startsWith("3ddata/cars/")) carFiles++;
      const archive = parseTexturesDxt(await vfs.readUnpacked(file));
      for (const record of archive.textures) {
        if (record.kind !== "texture") continue;
        for (const [level, mip] of record.mips.entries()) {
          const rgba = decodeTextureMip(record, level);
          assert.equal(rgba.length, mip.width * mip.height * 4, `${file}:${record.name} mip ${level}`);
        }
        decodedTextures++;
      }
    }
    assert.ok(trackFiles >= 125, `Expected >=125 tracks, got ${trackFiles}`);
    assert.ok(carFiles >= 148, `Expected >=148 cars, got ${carFiles}`);
    assert.ok(decodedTextures > 10000);

    // Spot-check specific QA bug regressions against real game assets:
    // C1: PACBF COLOURTEST04 (24-bit RGB) + TBIRDM red pixel channel order
    const pacbf = parseTexturesDxt(await vfs.readUnpacked("3ddata/tracks/pacbf/textures.dxt"));
    const colourTest = pacbf.textures.find(t => t.name === "COLOURTEST04");
    assert.equal(colourTest?.kind, "texture");
    assert.equal(colourTest.storage, "r8g8b8");
    const tbirdm = parseTexturesDxt(await vfs.readUnpacked("3ddata/cars/tbirdm/textures.dxt"));
    const tbirdTex = tbirdm.textures.find(t => t.name === "TBIRD_MOVIE_512");
    assert.equal(tbirdTex?.kind, "texture");
    assert.equal(tbirdTex.storage, "r8g8b8");
    const tbirdPx = decodeTextureMip(tbirdTex, 0);
    // Red Thunderbird movie car: R >> G, B (0xb2, 0x09, 0x0c, 0xff)
    assert.deepEqual([...tbirdPx.subarray(0, 4)], [0xb2, 0x09, 0x0c, 255]);

    // C6: 78CAP has 11 records (declared 9 + 2 trailing 78CAP_LOGO variants)
    const cap78 = parseTexturesDxt(await vfs.readUnpacked("3ddata/cars/78cap/textures.dxt"));
    assert.equal(cap78.textures.length, 11);
    assert.deepEqual(cap78.textures.slice(9).map(t => [t.name, t.flags]), [
      ["78CAP_LOGO", 0x1001a84],
      ["78CAP_LOGO", 0x2001a84],
    ]);

    // C7: ICEAF format class 5
    const iceaf = parseTexturesDxt(await vfs.readUnpacked("3ddata/tracks/iceaf/textures.dxt"));
    const snow = iceaf.textures.find(t => t.name === "SNOW_DRIVEABLE_ALASKA_SNOWTRACK_B");
    assert.equal(snow?.kind, "texture");
    assert.equal(snow.formatClass, 5);
    assert.equal(snow.storage, "dxt1");

    // C8: DTOWN3F SHADOW_HDR uncompressed 4bpp without flag 0x10, RGB + inverted alpha
    const dtown3f = parseTexturesDxt(await vfs.readUnpacked("3ddata/tracks/dtown3f/textures.dxt"));
    const shadowHdr = dtown3f.textures.find(t => t.name === "SHADOW_HDR");
    assert.equal(shadowHdr?.kind, "texture");
    assert.equal(shadowHdr.storage, "a8r8g8b8");
    assert.equal(shadowHdr.mips[0]?.data.length, 8192);
    const hdrPx = decodeTextureMip(shadowHdr, 0);
    assert.deepEqual([...hdrPx.subarray(0, 4)], [0, 0, 0, 0]);
  });
