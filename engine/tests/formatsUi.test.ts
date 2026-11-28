import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildFontAtlas, layoutText, lookupGlyph, parseFonts, transliterateForFont } from "../src/formats/fonts";
import { decodePcgEntryRgba, findPcgEntry, parsePcg, resolveUiTextureRef } from "../src/formats/pcg";
import { lookupTranslation, parseTranslationTable } from "../src/formats/tlate";
import { collectUiNodes, indexUiTemplates, parseUiScript } from "../src/formats/uiScript";
import { NodeVfs } from "../src/vfs/nodeVfs";

import { fileURLToPath } from "node:url";

const DEMO_ROOT = fileURLToPath(new URL("../../game", import.meta.url));

function buildSyntheticPcg(): Uint8Array {
  // 2 entries: one 4x4 DXT3 (16 bytes), one 2x2 raw BGR+invA (16 bytes).
  const payloadBase = 128;
  const entry0Off = 0;
  const entry1Off = 128 + 16;
  const totalSize = payloadBase + entry1Off + 128 + 16;
  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);

  view.setUint32(0, 2, true);
  view.setUint32(4, 2004, true);

  // Directory entry 0: "dxtimg"
  view.setUint32(16, entry0Off, true);
  buf.set(Buffer.from("dxtimg"), 20);
  // Directory entry 1: "rawimg"
  view.setUint32(32, entry1Off, true);
  buf.set(Buffer.from("rawimg"), 36);

  // Graphic 0 header (DXT3 4x4)
  const g0 = payloadBase + entry0Off;
  view.setUint32(g0 + 0x04, 1, true);
  view.setUint32(g0 + 0x08, 4, true);
  view.setUint32(g0 + 0x0c, 4, true);
  view.setUint32(g0 + 0x10, 4, true);
  view.setUint32(g0 + 0x14, 4, true);
  view.setUint32(g0 + 0x1c, 1, true);
  view.setUint32(g0 + 0x20, 1, true);
  view.setUint32(g0 + 0x24, 1, true);
  view.setUint32(g0 + 0x28, 16, true);
  // Alpha all 0xFF, color0 = white (0xFFFF), color1 = black (0x0000), selectors = 0
  buf.fill(0xff, g0 + 0x80, g0 + 0x88);
  view.setUint16(g0 + 0x88, 0xffff, true);
  view.setUint16(g0 + 0x8a, 0x0000, true);

  // Graphic 1 header (raw BGR + invA 2x2)
  const g1 = payloadBase + entry1Off;
  view.setUint32(g1 + 0x04, 0, true);
  view.setUint32(g1 + 0x08, 2, true);
  view.setUint32(g1 + 0x0c, 2, true);
  view.setUint32(g1 + 0x10, 2, true);
  view.setUint32(g1 + 0x14, 2, true);
  view.setUint32(g1 + 0x1c, 1, true);
  view.setUint32(g1 + 0x20, 1, true);
  view.setUint32(g1 + 0x24, 1, true);
  view.setUint32(g1 + 0x28, 16, true);
  // Pixel 0: B=10, G=20, R=30, invA=55 -> RGBA(30,20,10,200)
  buf.set([10, 20, 30, 55], g1 + 0x80);
  return buf;
}

test("PCG parser decodes DXT3 and raw BGR-inverted-alpha entries and resolves UI paths", () => {
  const pcg = parsePcg(buildSyntheticPcg());
  assert.equal(pcg.entries.length, 2);
  const dxt = findPcgEntry(pcg, "DXTIMG")!;
  const rgba0 = decodePcgEntryRgba(dxt);
  assert.deepEqual(Array.from(rgba0.subarray(0, 4)), [255, 255, 255, 255]);

  const raw = findPcgEntry(pcg, "rawimg")!;
  const rgba1 = decodePcgEntryRgba(raw);
  assert.deepEqual(Array.from(rgba1.subarray(0, 4)), [30, 20, 10, 200]);

  const ref = resolveUiTextureRef("GRAPHICS\\GAME\\STARTUS.PSD");
  assert.deepEqual(ref, {
    pcgPath: "graphics/game/graphics.pcg",
    entryName: "startus",
    registeredKey: "graphics/game/startus.psd",
  });
  assert.equal(resolveUiTextureRef("none"), null);
});

test("Translation table parses UTF-16LE BOM, comments, and ~ / | control chars", () => {
  const body = "// comment\r\n\r\nTXT_HELLO Hello~World|Line 2\r\n";
  const bom = Buffer.from([0xff, 0xfe]);
  const encoded = Buffer.concat([bom, Buffer.from(body, "utf16le")]);
  const table = parseTranslationTable(encoded);
  assert.equal(table.entries.size, 1);
  assert.equal(table.commentLines, 1);
  assert.equal(table.blankLines, 1);
  assert.equal(lookupTranslation(table, "txt_hello"), "Hello~World|Line 2");
  assert.equal(lookupTranslation(table, "0"), undefined);
});

test("Font parser builds RGBA glyph atlas and wraps text honoring ~ and |", () => {
  const base = new Uint8Array(172);
  const bv = new DataView(base.buffer);
  base.set(Buffer.from("TestFont"), 0);
  bv.setUint32(0x80, 1, true);
  bv.setUint32(0x84, 2, true); // ' ' and 'A'
  bv.setUint32(0x88, 8, true);
  bv.setUint32(0x8c, 10, true);
  bv.setUint32(0x90, 10, true);
  bv.setFloat32(0xa0, 1.0, true);

  // Glyph 0: space (24 bytes, 0 pixels); Glyph 1: 'A' (24 bytes + 2x2 pixels)
  const data = new Uint8Array(24 + 24 + 4);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 0x20, true);
  dv.setInt32(0x10, 4, true); // advance 4
  dv.setUint32(24, 0x41, true);
  dv.setUint32(28, 2, true);
  dv.setUint32(32, 2, true);
  dv.setInt32(40, 6, true); // advance 6
  data.set([255, 128, 64, 32], 48);

  const [font] = parseFonts(base, data);
  assert.ok(font);
  const atlas = buildFontAtlas(font);
  assert.ok(atlas.width >= 16 && atlas.height >= 16);
  assert.ok(atlas.glyphs.has(0x41));

  // "A~A A|A" in width 16: "A~A" = 6+4+6=16 fits on line 1, "A" wraps to line 2, "|A" -> line 3
  const lines = layoutText(font, "A~A A|A", 16, 40, 4, true, 1);
  assert.deepEqual(
    lines.map((l) => l.text),
    ["A~A", "A", "A"]
  );
});

test("UI script parser handles nesting, inheritance, includes, connections, and quirks", () => {
  const common = `
    :TYPE UI_TYPE_BUTTON
    :OBJECT_ID BASE_BTN
    :FONT 3
    :FONT_COLOUR 10 20 30 255
  `;
  const templates = indexUiTemplates(parseUiScript(common).roots);

  const childInclude = `
    :TYPE UI_TYPE_GRAPHIC
    :OBJECT_ID INC_GFX
    :TEXTURE_ENUM GRAPHICS\\GAME\\ICON.PSD
  `;
  const mainUi = `
    :TYPE UI_TYPE_SCREEN
    :OBJECT_ID TEST_SCR
    :S{*****>>>
      :READ_SCRIPT_FILE UI\\INC.UI
      :INHERIT BASE_BTN
      ::OBJECT_ID BTN1
      :POSITION_START 0.0f 0.25
      :POSITION_END 0.5 0.25
      :TEXT_JUSTIFY TEXT_JUSTIFY_CENTRE
      :COLOUR 255l 128 50^ 255
      :CONNECTION BTN1 none BTN2 none none
    :E}*****<<<
  `;
  const parsed = parseUiScript(mainUi, {
    templates,
    readFile: (p) => (p.toLowerCase().includes("inc.ui") ? childInclude : undefined),
  });
  assert.equal(parsed.roots.length, 1);
  assert.equal(parsed.balancedBlocks, 1);
  assert.equal(parsed.connections.length, 1);
  assert.equal(parsed.connections[0]!.down, "BTN2");
  const screen = parsed.roots[0]!;
  assert.equal(screen.children.length, 2);
  const btn = screen.children[1]!;
  assert.equal(btn.objectId, "BTN1");
  assert.equal(btn.font, 3);
  assert.deepEqual(btn.colour, [255, 128, 50, 255]);
});

test("real Shuffle UI, PCG, font, and translation files parse completely", { skip: !fs.existsSync(DEMO_ROOT) }, async () => {
  const vfs = await NodeVfs.open(DEMO_ROOT);

  // 1. All 58 PCGs / 1,222 entries
  const pcgPaths = vfs.list("graphics/").filter((p) => p.endsWith(".pcg"));
  assert.equal(pcgPaths.length, 58);
  const pcgCache = new Map<string, ReturnType<typeof parsePcg>>();
  let totalEntries = 0;
  for (const p of pcgPaths) {
    const raw = await vfs.readUnpacked(p);
    const parsed = parsePcg(raw);
    pcgCache.set(p, parsed);
    totalEntries += parsed.entries.length;
    for (const entry of parsed.entries) {
      const rgba = decodePcgEntryRgba(entry);
      assert.equal(rgba.length, entry.storedWidth * entry.storedHeight * 4);
    }
  }
  assert.equal(totalEntries, 1222);

  // 2. All 6 fonts / 804 glyphs
  const fontBase = await vfs.readBytes("FONTS/fontbase.dat");
  const fontData = await vfs.readBytes("FONTS/fontdata.dat");
  const fonts = parseFonts(fontBase, fontData);
  assert.equal(fonts.length, 6);
  assert.equal(
    fonts.reduce((acc, f) => acc + f.glyphs.length, 0),
    804
  );
  for (const f of fonts) {
    const atlas = buildFontAtlas(f);
    assert.equal(atlas.glyphs.size, 134);
  }

  // 3. English translation table (2,065 entries)
  const tlate = parseTranslationTable(await vfs.readBytes("LANGUAGE/TLATE_EN.DAT"));
  assert.equal(tlate.entries.size, 2065);

  // 4. All 92 UI files (201 balanced blocks, all 52 distinct non-none TEXTURE_ENUM paths resolve)
  const uiPaths = vfs.list("ui/").filter((p) => p.endsWith(".ui"));
  assert.equal(uiPaths.length, 92);
  let totalBlocks = 0;
  const distinctTextures = new Set<string>();
  for (const p of uiPaths) {
    const text = await vfs.readText(p);
    const parsed = parseUiScript(text);
    totalBlocks += parsed.balancedBlocks;
    for (const node of collectUiNodes(parsed.roots)) {
      if (node.textureEnum) {
        distinctTextures.add(node.textureEnum.toLowerCase());
        const target = resolveUiTextureRef(node.textureEnum);
        assert.ok(target, `Failed to resolve ${node.textureEnum} in ${p}`);
        const col = pcgCache.get(target.pcgPath);
        assert.ok(col, `Missing PCG ${target.pcgPath} for ${node.textureEnum} in ${p}`);
        assert.ok(findPcgEntry(col, target.entryName), `Missing entry ${target.entryName} in ${target.pcgPath}`);
      }
    }
  }
  assert.equal(totalBlocks, 201);
  assert.equal(distinctTextures.size, 52);
  assert.ok(path.isAbsolute(DEMO_ROOT));

  // 5. Font fallback transliteration keeps exact glyphs and removes □ boxes across all 12 TLATE languages.
  const bodyFont = fonts[2]!;
  assert.equal(lookupGlyph(bodyFont, "É".charCodeAt(0))?.codePoint, "É".charCodeAt(0));
  assert.equal(lookupGlyph(bodyFont, "ß".charCodeAt(0))?.codePoint, "ß".charCodeAt(0));
  assert.equal(lookupGlyph(bodyFont, "Ř".charCodeAt(0))?.codePoint, "R".charCodeAt(0));
  assert.equal(lookupGlyph(bodyFont, "Ł".charCodeAt(0))?.codePoint, "L".charCodeAt(0));
  assert.equal(transliterateForFont(bodyFont, "LOADING…"), "LOADING...");
  assert.equal(transliterateForFont(bodyFont, "SZYBKI WYŚCIG"), "SZYBKI WYSCIG");
  assert.equal(transliterateForFont(bodyFont, "БЫСТРАЯ ГОНКА"), "BYSTRAYA GONKA");

  const tlatePaths = vfs.list("language/").filter((p) => /^language\/tlate_[a-z0-9]+\.dat$/i.test(p));
  assert.equal(tlatePaths.length, 12);
  for (const tp of tlatePaths) {
    const tbl = parseTranslationTable(await vfs.readBytes(tp));
    for (const value of tbl.entries.values()) {
      const rendered = transliterateForFont(bodyFont, value);
      for (let i = 0; i < rendered.length; i++) {
        const cp = rendered.charCodeAt(i);
        if (cp === 0x7e || cp === 0x7c || cp === 0x0a || cp === 0x0d || cp === 0x09) continue;
        const g = lookupGlyph(bodyFont, cp);
        assert.ok(g && g.codePoint !== 0x25a1, `Unexpected □ fallback for U+${cp.toString(16)} in ${tp}: ${value}`);
      }
    }
  }
});
