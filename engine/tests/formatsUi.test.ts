import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildFontAtlas, layoutText, lookupGlyph, parseFonts, transliterateForFont } from "../src/formats/fonts";
import { decodePcgEntryRgba, findPcgEntry, parsePcg, resolveUiTextureRef } from "../src/formats/pcg";
import { lookupTranslation, parseTranslationTable } from "../src/formats/tlate";
import { collectUiNodes, indexUiTemplates, parseUiScript } from "../src/formats/uiScript";
import { NodeVfs } from "../src/vfs/nodeVfs";
import { CODE_SET_UI_TEXTURES, DemoAssets } from "../src/demoAssets";
import {
  FONTBASE_AVG_ADVANCE, intersectUiRects, justifiedTextRect, uiTypeFillsWhenClear0, UiScreenInstance, wrapUiTextLines,
  type ResolvedUiDrawItem, type UiRect,
} from "../src/ui/uiRuntime";
import { uiTextMeasurer } from "../src/render/uiRenderer";

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

const SIZES: Record<string, { width: number; height: number }> = {
  "graphics/game/common/pause.psd": { width: 84, height: 84 },
  "graphics/game/rating1.psd": { width: 105, height: 15 },
  "graphics/game/common/grady.psd": { width: 1920, height: 1080 },
};

const RUNTIME_SCREEN = `
  :TYPE UI_TYPE_SCREEN
  :OBJECT_ID SCR
  :S{*****>>>
    :TYPE UI_TYPE_AREA
    :OBJECT_ID BAR
    :CLEAR 0
    :COLOUR_START 0 0 0 0
    :COLOUR 95 95 90 255
    :TIME_LENGTH 1
    :POSITION_START 0 0.3
    :POSITION_END 0 0.3
    :SIZE 1 0.0375
    :TEXT TITLE
    :TEXT_JUSTIFY 4
    :JUSTIFY_OFFSET 0.04 0.11
    :S{*****>>>
      :TYPE UI_TYPE_TEXT
      :OBJECT_ID RIGHT
      :TEXT R
      :TEXT_JUSTIFY 2
      :JUSTIFY_OFFSET 0.0454 0.5
      :TYPE UI_TYPE_TEXT
      :OBJECT_ID CENTRE
      :TEXT C
      :TEXT_JUSTIFY 3
      :JUSTIFY_OFFSET 0.5 0.2
      :TYPE UI_TYPE_TEXT
      :OBJECT_ID BOTTOM
      :TEXT B
      :TEXT_JUSTIFY 6
      :JUSTIFY_OFFSET 0.5 0.2
    :E}*****<<<
    :TYPE UI_TYPE_GRAPHIC
    :OBJECT_ID EMPTY
    :TYPE UI_TYPE_GRAPHIC
    :OBJECT_ID ICON
    :AUTOSIZE 1
    :SIZE 0 0
    :POSITION_START 0.4329 0.2
    :POSITION_END 0.4329 0.2
    :TEXTURE_ENUM GRAPHICS\\GAME\\COMMON\\PAUSE.PSD
    :TYPE UI_TYPE_GRAPHIC
    :OBJECT_ID RATING
    :STRETCH_GRAPHIC 0
    :SIZE 0.08203125 0.05
    :TEXTURE_ENUM GRAPHICS\\GAME\\RATING1.PSD
    :TYPE UI_TYPE_GRAPHIC
    :OBJECT_ID BG
    :TEXTURE_ENUM GRAPHICS\\GAME\\COMMON\\GRADY.PSD
  :E}*****<<<
`;

// The .UI parser keeps fr3's float precision (~1e-4), so compare script-derived values loosely.
const near = (actual: number, expected: number, epsilon = 2e-4) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≉ ${expected}`);

test("UI runtime emits CLEAR 0 fills, AUTOSIZE pixel sizes, STRETCH_GRAPHIC 0 crops and signed JUSTIFY_OFFSETs", () => {
  const screen = new UiScreenInstance(RUNTIME_SCREEN, { getTextureSize: key => SIZES[key] });
  const byId = () => new Map(screen.getDrawItems().map(item => [item.id, item]));
  let items = byId();
  assert.equal(items.has("EMPTY"), false, "CLEAR 1 without texture or text draws nothing");
  const bar = items.get("BAR")!;
  assert.deepEqual([bar.fill, bar.clear, bar.textureRef], [true, false, null]);
  assert.deepEqual(bar.color, [0, 0, 0, 0]);
  screen.update(0.5);
  assert.deepEqual(byId().get("BAR")!.color, [47.5, 47.5, 45, 127.5]);

  // AUTOSIZE replaces SIZE with pixels / 640×480: PAUSE.PSD (84×84) at x 0.4329 centres on ~319 px.
  const icon = items.get("ICON")!;
  near(icon.rect.width, 84 / 640);
  near(icon.rect.height, 84 / 480);
  near((icon.rect.x + icon.rect.width / 2) * 640, 319.056, 0.05);
  assert.equal(icon.autosize, true);
  assert.equal(icon.uvRect, undefined);

  // STRETCH_GRAPHIC 0: 52.5 of 105 px wide → U crop 0.5; the 24 px tall node clips to the 15 px texture.
  const rating = items.get("RATING")!;
  assert.deepEqual(rating.uvRect, [0, 0, 0.5, 1]);
  near(rating.graphicRect.width, 0.08203125);
  near(rating.graphicRect.height, 15 / 480);
  near(rating.rect.height, 0.05);
  // Screen-sized art is never cropped, even at the parser's default STRETCH_GRAPHIC 0.
  assert.equal(items.get("BG")!.uvRect, undefined);
  assert.equal(screen.setNodeSize("RATING", 0.03, 0.05), true);
  near(byId().get("RATING")!.uvRect![2], 0.03 * 640 / 105);

  // JUSTIFY_OFFSET is in node-size units: + for left/top, − (and −2 px) for right/bottom, none when centred.
  items = byId();
  near(bar.textRect.x, 0.04);
  near(bar.textRect.y, 0.3 + 0.11 * 0.0375);
  const right = items.get("RIGHT")!;
  near(right.textRect.x, right.rect.x - 0.0454 * right.rect.width - 2 / 640);
  near(right.textRect.y, right.rect.y);
  const centre = items.get("CENTRE")!;
  near(centre.textRect.x, centre.rect.x);
  near(centre.textRect.y, centre.rect.y + 0.2 * centre.rect.height);
  const bottom = items.get("BOTTOM")!;
  near(bottom.textRect.y, bottom.rect.y - 0.2 * bottom.rect.height - 2 / 480);
  assert.deepEqual(justifiedTextRect({ x: 0, y: 0, width: 1, height: 1 }, 0, [0.5, 0.5]), { x: 0, y: 0, width: 1, height: 1 });

  assert.equal(screen.setNodeAlphaTest("ICON", 179), true);
  assert.equal(byId().get("ICON")!.alphaTest, 179);
  assert.deepEqual(screen.getTextureRefs().map(ref => ref.entryName).sort(), ["grady", "pause", "rating1"]);

  // Until the texture size is known an AUTOSIZE node is skipped rather than drawn at 0×0.
  const loading = new UiScreenInstance(RUNTIME_SCREEN, { getTextureSize: () => undefined });
  assert.equal(loading.getDrawItems().some(item => item.id === "ICON"), false);
  assert.ok(loading.getPendingTextureRefs().some(ref => ref.entryName === "pause"));
});

test("UI runtime animation types follow fr3.exe: once, reverse, loop with offset, ping-pong, clamped steps", () => {
  const node = (id: string, type: number) => `
    :TYPE UI_TYPE_AREA
    :OBJECT_ID ${id}
    :CLEAR 0
    :ANIMATION_TYPE ${type}
    :COLOUR_START 0 0 0 0
    :COLOUR 0 0 0 200
    :OFFSET_TIME 0.2
    :TIME_LENGTH 1
  `;
  const screen = new UiScreenInstance([0, 1, 2, 3].map(type => node(`T${type}`, type)).join("\n"));
  const alpha = (id: string) => screen.getDrawItems().find(item => item.id === id)!.color[3];
  assert.deepEqual(["T0", "T1", "T2", "T3"].map(alpha), [0, 200, 0, 0]);
  screen.update(0.45);
  screen.update(0.45);
  const f = (actual: number, expected: number) => near(actual, expected, 0.05);
  f(alpha("T0"), 140); f(alpha("T1"), 20); f(alpha("T2"), 140); f(alpha("T3"), 140);
  screen.update(0.35);
  // T2 restarts its clock (offset applies again); T3 turns around; T1 has finished backwards.
  assert.deepEqual([alpha("T0"), alpha("T1"), alpha("T2")], [200, 0, 0]);
  f(alpha("T3"), 200);
  screen.update(0.3);
  f(alpha("T2"), 20);
  f(alpha("T3"), 150);
  screen.update(3);
  f(alpha("T2"), 30);

  screen.startExit();
  assert.equal(screen.isExiting(), true);
  screen.update(0.2);
  assert.equal(screen.isExitComplete(), false);
  assert.equal(screen.isExitComplete(0.15), true);
});

test("UI list boxes stack one font line per row, use the list font and clip to the list rect", () => {
  const screen = new UiScreenInstance(`
    :TYPE UI_TYPE_LIST_BOX
    :OBJECT_ID NAME_LIST
    :FONT 2
    :FONT_COLOUR 50 50 50 255
    :TEXT_JUSTIFY 4
    :POSITION_START 0.25 0.5
    :POSITION_END 0.25 0.5
    :SIZE 0.5 0.1
  `);
  assert.deepEqual(screen.getDrawItems(), []);
  assert.equal(screen.setListItems("name_list", [
    { text: "ALPHA" }, { text: "BRAVO", colour: [255, 0, 0, 255] }, { text: "CHARLIE" }, { text: "DELTA" },
  ]), true);
  const rows = screen.getDrawItems().filter(item => item.listRow);
  assert.deepEqual(rows.map(row => row.text), ["ALPHA", "BRAVO"]);
  near(rows[0]!.rect.y, 0.5);
  near(rows[0]!.rect.height, 17 / 480);
  near(rows[1]!.rect.y, 0.5 + 17 / 480);
  assert.deepEqual(rows.map(row => [row.font, row.textColor, row.listRow]), [
    [2, [50, 50, 50, 255], { listId: "NAME_LIST", index: 0 }],
    [2, [255, 0, 0, 255], { listId: "NAME_LIST", index: 1 }],
  ]);
  near(rows[0]!.rect.width, 0.5);
  const roomy = new UiScreenInstance(`
    :TYPE UI_TYPE_LIST_BOX
    :OBJECT_ID L
    :FONT 5
    :SIZE 1 1
  `, { getFontLineHeight: () => 130 });
  roomy.setListItems("L", [{ text: "A" }, { text: "B|C" }, { text: "D" }]);
  assert.deepEqual(roomy.getDrawItems().filter(item => item.listRow).map(row => Math.round(row.rect.height * 480)), [130, 260]);
  assert.deepEqual(roomy.getListItems("L").map(row => row.text), ["A", "B|C", "D"]);
});

test("MENUBAR selection bar tracks the focused button, swaps icon sides and restarts its fade", () => {
  const menubar = readFileSync(path.join(DEMO_ROOT, "UI/MENUBAR.UI"), "latin1");
  const files = new Map([["ui/menubar.ui", menubar]]);
  const screen = new UiScreenInstance(`
    :TYPE UI_TYPE_SCREEN
    :OBJECT_ID SCR
    :S{*****>>>
      :READ_SCRIPT_FILE UI\\MENUBAR.UI
      :TYPE UI_TYPE_BUTTON
      :OBJECT_ID LEFTROW
      :TEXT L
      :TEXT_JUSTIFY 1
      :POSITION_START 0.5 0.4
      :POSITION_END 0.5 0.4
      :SIZE 1 0.06
      :TYPE UI_TYPE_BUTTON
      :OBJECT_ID RIGHTROW
      :TEXT R
      :TEXT_JUSTIFY 2
      :POSITION_START -0.5 0.6
      :POSITION_END -0.5 0.6
      :SIZE 1 0.06
    :E}*****<<<
  `, { readFile: name => files.get(name.toLowerCase().replaceAll("\\", "/")) });
  assert.equal(screen.enableSelectionBar(), true);
  const items = () => new Map(screen.getDrawItems().map(item => [item.id, item]));
  let drawn = items();
  near(drawn.get("MENUBAR")!.rect.x, 0.5, 1e-3);
  near(drawn.get("MENUBAR")!.rect.y, 0.4, 1e-3);
  near(drawn.get("MENUBAR")!.rect.height, 0.05625, 1e-4);
  assert.equal(drawn.get("MENUBAR")!.color[3], 0);
  assert.ok(drawn.has("MENUBAR_ICON") && drawn.has("MENUBAR_PULSE"));
  assert.ok(!drawn.has("MENUBAR_ICON2") && !drawn.has("MENUBAR_PULSE2"));
  assert.equal(drawn.get("MENUBAR_ICON")!.textureRef?.registeredKey, "graphics/game/common/pc/pcenter.psd");
  assert.equal(drawn.get("MENUBAR_ICON")!.rect.x, drawn.get("MENUBAR")!.rect.x);
  screen.update(0.2);
  assert.equal(items().get("MENUBAR")!.color[3], 76);

  assert.equal(screen.moveFocus("down"), "RIGHTROW");
  screen.update(0.01);
  drawn = items();
  near(drawn.get("MENUBAR")!.rect.x, -0.5, 1e-3);
  near(drawn.get("MENUBAR")!.rect.y, 0.6, 1e-3);
  near(drawn.get("MENUBAR")!.color[3], 76 * 0.01 / 0.166667, 0.05);
  assert.ok(drawn.has("MENUBAR_ICON2") && !drawn.has("MENUBAR_ICON"));
  near(drawn.get("MENUBAR_ICON2")!.rect.x, -0.5 + 0.957812, 1e-3);
  assert.equal(new UiScreenInstance(":TYPE UI_TYPE_SCREEN").enableSelectionBar(), false);
});

test("real Shuffle screens resolve fills, AUTOSIZE and crops with preloaded textures", { skip: !fs.existsSync(DEMO_ROOT) }, async () => {
  const assets = await DemoAssets.load(await NodeVfs.open(DEMO_ROOT));
  const screens = ["START", "GAMEF", "CAR", "TRACK", "ROPT", "OPTS", "AUDIO", "GMOPT", "LANG", "CTRLS", "PC_CTRLS",
    "KEYBD", "PAUSE", "RCEND", "RCRES", "POSN", "DISP", "FORD", "CONTINUE", "RNDIN"].map(name => `UI/${name}.UI`);
  const loaded = await assets.preloadUiTextures(screens, CODE_SET_UI_TEXTURES);
  assert.ok(loaded.size >= 27);
  for (const code of CODE_SET_UI_TEXTURES) assert.ok(assets.getLoadedUiTexture(code), code);
  const open = (path: string) => UiScreenInstance.load(path, {
    readFile: assets.readUiScript, translation: assets.translation, getTextureSize: assets.getUiTextureSize,
  });
  for (const path of screens) assert.deepEqual(open(path).getPendingTextureRefs(), [], path);

  const pause = open("UI/PAUSE.UI");
  pause.update(0.45);
  pause.update(0.45);
  const pauseItems = new Map(pause.getDrawItems().map(item => [item.id, item]));
  const icon = pauseItems.get("PAUSEICON")!;
  near(icon.rect.width * 640, 84, 1e-6);
  near((icon.rect.x + icon.rect.width / 2) * 640, 319, 0.5);
  assert.deepEqual([pauseItems.get("DARKBKG")!.fill, pauseItems.get("DARKBKG")!.color], [true, [0, 0, 0, 128]]);

  const start = open("UI/START.UI");
  start.update(0.45);
  const title = start.getDrawItems().find(item => item.id === "TITLE")!;
  assert.deepEqual([title.fill, title.color], [true, [95, 95, 90, 255]]);
  near(title.rect.height * 480, 18, 0.1);
  near(title.textRect.y * 480 - title.rect.y * 480, 0.11 * 18, 0.05);

  const car = open("UI/CAR.UI");
  assert.equal(car.setNodeSize("TOPSPEED", 0.25, 1), true);
  car.update(0.45);
  car.update(0.45);
  const topSpeed = car.getDrawItems().find(item => item.id === "TOPSPEED")!;
  near(topSpeed.uvRect![2], 0.25, 1e-6);
  const ratingBackground = car.getDrawItems().find(item => item.textureRef?.entryName === "rating0")!;
  near(ratingBackground.rect.width * 640, 105, 1e-6);

  const lang = open("UI/LANG.UI");
  assert.equal(lang.getDrawItems().find(item => item.textureRef?.entryName === "grady")?.uvRect, undefined);

  const gamef = open("UI/GAMEF.UI");
  gamef.setNodeVisible("BUTTON1", true);
  gamef.setNodeVisible("BUTTON2", true);
  gamef.setFocus("BUTTON1");
  assert.equal(gamef.enableSelectionBar(), true);
  gamef.update(0.45);
  gamef.update(0.45);
  const gamefItems = new Map(gamef.getDrawItems().map(item => [item.id, item]));
  assert.deepEqual(gamefItems.get("MENUBAR")!.rect.y, gamefItems.get("BUTTON1")!.rect.y);
  near(gamefItems.get("MENUBAR")!.rect.x * 640, 0.507666 * 640, 0.1);
  assert.equal(gamefItems.get("MENUBAR_ICON")!.textureRef?.entryName, "pcenter");
  const button = gamefItems.get("BUTTON1")!;
  near((button.textRect.x - button.rect.x) * 640, 0.045352 * 640, 0.1);
  assert.equal(button.font, 4);
});

const inside = (inner: UiRect, outer: UiRect, epsilon = 1e-9) =>
  inner.x >= outer.x - epsilon && inner.y >= outer.y - epsilon
  && inner.x + inner.width <= outer.x + outer.width + epsilon && inner.y + inner.height <= outer.y + outer.height + epsilon;

test("CLEAR 0 fills follow fr3's per-type draw methods: TEXT never fills, code-cleared screens show the race", () => {
  const node = (type: string, id: string, extra = "") => `
    :TYPE ${type}
    :OBJECT_ID ${id}
    :CLEAR 0
    :COLOUR 255 255 255 255
    :POSITION_START 0 0.5
    :POSITION_END 0 0.5
    :SIZE 0.5 0.2
    ${extra}`;
  const screen = new UiScreenInstance(`
    :TYPE UI_TYPE_SCREEN
    :OBJECT_ID OPTS
    :CLEAR 0
    :COLOUR 255 255 255 255
    :TEXTURE_ENUM GRAPHICS\\GAME\\BKGNDS\\350.PSD
    :S{*****>>>
    ${node("UI_TYPE_TEXT", "UNLOCKTEXT", ":TEXT TXT_UNLOCK_HINT\n:FONT 2")}
    ${node("UI_TYPE_TEXT", "TEXTBAR", ":TEXTURE_ENUM GRAPHICS\\GAME\\COMMON\\TITLEBAR.PSD\n:TEXT TXT_X")}
    ${node("UI_TYPE_AREA", "DARKBKG")}
    ${node("UI_TYPE_BASIC", "BASIC")}
    ${node("UI_TYPE_BUTTON", "BUTTON1")}
    ${node("UI_TYPE_GRAPHIC", "GRAPHIC")}
    ${node("UI_TYPE_LIST_BOX", "LISTBOXBKG")}
    :E}*****<<<
  `);
  const byId = () => new Map(screen.getDrawItems().map(item => [item.id, item]));
  let items = byId();
  // UI_TYPE_TEXT (0x48c0c0) never fills: no white box behind UNLOCKTEXT.
  const unlock = items.get("UNLOCKTEXT")!;
  assert.deepEqual([unlock.fill, unlock.textureRef, unlock.text], [false, null, "TXT_UNLOCK_HINT"]);
  assert.equal(items.get("TEXTBAR")!.fill, false);
  // AREA, BASIC, BUTTON, GRAPHIC and LIST_BOX keep their real CLEAR 0 fills (DARKBKG, LISTBOXBKG, panels).
  for (const id of ["DARKBKG", "BASIC", "BUTTON1", "GRAPHIC", "LISTBOXBKG"]) assert.equal(items.get(id)?.fill, true, id);
  // The screen draws its background; once code removes it (in-game options over the race) it must not turn into a
  // full-screen white fill.
  assert.deepEqual([items.get("OPTS")!.fill, items.get("OPTS")!.textureRef?.entryName], [false, "350"]);
  assert.equal(screen.setNodeTexture("OPTS", null), true);
  items = byId();
  assert.equal(items.has("OPTS"), false);
  assert.equal(items.get("DARKBKG")!.fill, true);
  // An authored texture-less CLEAR 0 screen (RNDIN's black cover) still fills.
  const cover = new UiScreenInstance(`
    :TYPE UI_TYPE_SCREEN
    :OBJECT_ID RNDIN
    :CLEAR 0
    :COLOUR 0 0 0 255
  `);
  assert.deepEqual(cover.getDrawItems().map(item => [item.id, item.fill]), [["RNDIN", true]]);
  assert.deepEqual(["UI_TYPE_TEXT", "UI_TYPE_SCREEN", "UI_TYPE_AREA", "UI_TYPE_LIST_BOX"].map(uiTypeFillsWhenClear0),
    [false, true, true, true]);
});

test("every draw item carries fr3's node ∩ ancestors ∩ screen clip rect", () => {
  const screen = new UiScreenInstance(`
    :TYPE UI_TYPE_SCREEN
    :OBJECT_ID S
    :S{*****>>>
      :TYPE UI_TYPE_AREA
      :OBJECT_ID PANEL
      :CLEAR 0
      :POSITION_START 0.25 0.25
      :POSITION_END 0.25 0.25
      :SIZE 0.5 0.5
      :S{*****>>>
        :TYPE UI_TYPE_BUTTON
        :OBJECT_ID ROW
        :TEXT TXT_ROW
        :POSITION_START 0.5 0.9
        :POSITION_END 0.5 0.9
        :SIZE 1 0.2
      :E}*****<<<
    :E}*****<<<
  `);
  const items = new Map(screen.getDrawItems().map(item => [item.id, item]));
  assert.deepEqual(items.get("PANEL")!.clipRect, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  const row = items.get("ROW")!;
  // ROW spans x 0.5..1.0 and y 0.7..0.8 of the screen; PANEL ends at 0.75 on both axes.
  near(row.rect.x, 0.5); near(row.rect.width, 0.5); near(row.rect.y, 0.7);
  near(row.clipRect!.x, 0.5); near(row.clipRect!.width, 0.25);
  near(row.clipRect!.y, 0.7); near(row.clipRect!.height, 0.05);
  assert.deepEqual(intersectUiRects({ x: 0, y: 0, width: 0.2, height: 0.2 }, { x: 0.5, y: 0.5, width: 1, height: 1 }),
    { x: 0.5, y: 0.5, width: 0, height: 0 });
});

test("indexUiTemplates prefers top-level MENUBAR over nested child MENUBAR and unwrapped UI_TYPE_TEXT does not clip to 0.1×0.1", { skip: !fs.existsSync(DEMO_ROOT) }, async () => {
  const assets = await DemoAssets.load(await NodeVfs.open(DEMO_ROOT));
  const lang = UiScreenInstance.load("UI/LANG.UI", {
    readFile: assets.readUiScript, translation: assets.translation, getTextureSize: assets.getUiTextureSize,
  });
  lang.enableSelectionBar();
  lang.update(0.3);
  const bar = lang.getDrawItems().find(item => item.id === "MENUBAR")!;
  assert.ok(bar, "LANG.UI should inherit top-level horizontal MENUBAR");
  assert.ok(bar.rect.width > 0.8 && bar.rect.height < 0.08, `expected horizontal MENUBAR, got ${JSON.stringify(bar.rect)}`);
  assert.ok(bar.textureRef?.entryName.toLowerCase() === "menu_hi", `expected MENU_HI texture, got ${bar.textureRef?.entryName}`);

  const car = UiScreenInstance.load("UI/CAR.UI", {
    readFile: assets.readUiScript, translation: assets.translation, getTextureSize: assets.getUiTextureSize,
  });
  car.setNodeVisible("GROUPWINDOW", false);
  car.setNodeVisible("CARINFOWINDOW", true);
  car.update(0.3);
  const hint = car.getDrawItems().find(item => item.id === "COLOUR_TEXT")!;
  assert.ok(hint, "CAR.UI should draw COLOUR_TEXT");
  assert.ok((hint.clipRect?.width ?? 0) > 0.5, `COLOUR_TEXT clip should not truncate at 0.1 placeholder rect: ${JSON.stringify(hint.clipRect)}`);
});

test("highlighted HIGHLIGHTED_FONT 4 labels on GAMEF, PAUSE and RCEND stay inside their row and the screen", { skip: !fs.existsSync(DEMO_ROOT) }, async () => {
  const assets = await DemoAssets.load(await NodeVfs.open(DEMO_ROOT));
  const fonts = assets.fonts;
  const open = (path: string) => UiScreenInstance.load(path, {
    readFile: assets.readUiScript, translation: assets.translation, getTextureSize: assets.getUiTextureSize,
  });
  const unit = { x: 0, y: 0, width: 1, height: 1 };
  for (const [path, ids] of [["UI/GAMEF.UI", ["BUTTON1", "BUTTON2"]], ["UI/PAUSE.UI", ["CONTINUE", "OPTIONS"]],
    ["UI/RCEND.UI", ["RETRY", "EXIT"]]] as const) {
    const screen = open(path);
    for (const id of ids) {
      screen.setNodeVisible(id, true);
      screen.setNodeEnabled(id, true);
      if (!screen.setFocus(id)) continue;
      screen.update(0.45);
      screen.update(0.45);
      const items = screen.getDrawItems();
      const button = items.find(item => item.id === id && item.highlighted)!;
      assert.ok(button, `${path} ${id}`);
      // fr3 draws HIGHLIGHTED_FONT 4 (48 px cell) at scale 1.0 and relies on the per-node scissor.
      const cell = fonts[button.font]!.font.descriptor.cellHeight;
      assert.ok(cell / 480 > button.rect.height, `${path} ${id}: highlighted cell overflows its row unclipped`);
      const clip = button.clipRect!;
      assert.ok(inside(clip, button.rect) && inside(clip, unit), `${path} ${id} clip ${JSON.stringify(clip)}`);
      // The focused row's scissor reaches into a neighbouring row only where the script's own rects overlap
      // (GAMEF's 0.06-tall rows are spaced 0.0535 apart), never by the 48 px cell's extra height.
      for (const other of items) {
        if (other === button || other.buttonId === null || !other.clipRect) continue;
        const overlap = intersectUiRects(clip, other.clipRect);
        const authored = intersectUiRects(button.rect, other.rect);
        assert.ok(overlap.height <= authored.height + 1e-9, `${path} ${id} overlaps ${other.id}`);
        assert.ok(overlap.height * 480 < 4, `${path} ${id} overlaps ${other.id} by ${overlap.height * 480} px`);
      }
    }
  }
});

test("list rows advance by their wrapped line count and are clipped to their own column", () => {
  const credits = `
    :TYPE UI_TYPE_SCREEN
    :OBJECT_ID CRED
    :S{*****>>>
      :TYPE UI_TYPE_LIST_BOX
      :OBJECT_ID LISTBOX
      :FONT 1
      :TEXT_JUSTIFY 1
      :WORD_WRAP 1
      :POSITION_START 0.096875 0
      :POSITION_END 0.096875 0
      :SIZE 0.379639 8.5
    :E}*****<<<
  `;
  const rows = [
    { text: "LEAD PROGRAMMER" },
    { text: "A VERY LONG CREDITS ENTRY THAT CANNOT POSSIBLY FIT ON ONE LINE OF A NARROW COLUMN" },
    { text: "SHORT|TWO LINES" },
    { text: "NEXT" },
  ];
  // 10 px per character: the 243 px column holds 24 characters per line.
  const measureText = (_font: number, text: string) => text.length * 10;
  const screen = new UiScreenInstance(credits, { measureText, getFontLineHeight: () => 23 });
  screen.setListItems("LISTBOX", rows);
  const items = screen.getDrawItems().filter(item => item.listRow);
  const widthPx = 0.379639 * 640;
  const expected = rows.map(row => wrapUiTextLines(row.text, widthPx, line => line.length * 10).length);
  assert.deepEqual(expected, [1, 4, 2, 1]);
  assert.deepEqual(items.map(item => Math.round(item.rect.height * 480)), expected.map(lines => lines * 23));
  for (let i = 1; i < items.length; i++) near(items[i]!.rect.y, items[i - 1]!.rect.y + items[i - 1]!.rect.height);

  // Without a measurer the wrap is estimated from the font's mean advance (never a single 23 px row).
  const estimated = new UiScreenInstance(credits, { getFontLineHeight: () => 23 });
  estimated.setListItems("LISTBOX", rows);
  const lines = estimated.getDrawItems().filter(item => item.listRow).map(item => Math.round(item.rect.height * 480 / 23));
  assert.deepEqual(lines, rows.map(row => wrapUiTextLines(row.text, widthPx, line => line.length * FONTBASE_AVG_ADVANCE[1]!).length));
  assert.ok(lines[1]! > 1);

  // RCRES: right-justified names in LISTBOX1 are scissored to x < 0.5 so they never run into LISTBOX2's times.
  const results = new UiScreenInstance(`
    :TYPE UI_TYPE_GRAPHIC
    :OBJECT_ID LISTBOXBKG
    :CLEAR 0
    :POSITION_START 0 0.5
    :POSITION_END 0 0.5
    :SIZE 1 0.25
    :S{*****>>>
      :TYPE UI_TYPE_LIST_BOX
      :OBJECT_ID LISTBOX1
      :FONT 2
      :TEXT_JUSTIFY 2
      :SIZE 0.5 1
      :TYPE UI_TYPE_LIST_BOX
      :OBJECT_ID LISTBOX2
      :FONT 2
      :TEXT_JUSTIFY 1
      :POSITION_START 0.5 0
      :POSITION_END 0.5 0
      :SIZE 0.5 1
    :E}*****<<<
  `);
  results.setListItems("LISTBOX1", [{ text: "1  2005 MUSTANG V6 CONVERTIBLE" }, { text: "3  2009 F-150 FX4" }]);
  results.setListItems("LISTBOX2", [{ text: "00:51.47" }, { text: "00:58.33" }]);
  const resultRows = results.getDrawItems().filter(item => item.listRow);
  for (const row of resultRows) {
    const column = row.listRow!.listId === "LISTBOX1" ? { x: 0, width: 0.5 } : { x: 0.5, width: 0.5 };
    near(row.clipRect!.x, column.x);
    near(row.clipRect!.width, column.width);
    near(row.clipRect!.y, 0.5);
    near(row.clipRect!.height, 0.25);
  }
});

test("real CRED.UI credits rows wrap with real font metrics and never overlap", { skip: !fs.existsSync(DEMO_ROOT) }, async () => {
  const assets = await DemoAssets.load(await NodeVfs.open(DEMO_ROOT));
  const fonts = assets.fonts;
  const screen = UiScreenInstance.load("UI/CRED.UI", {
    readFile: assets.readUiScript, translation: assets.translation, getTextureSize: assets.getUiTextureSize,
    getFontLineHeight: slot => fonts[slot]?.font.descriptor.cellHeight, measureText: uiTextMeasurer(fonts),
  });
  const entries = [...assets.translation.entries.entries()].filter(([key]) => key.startsWith("TXT_CREDITS_"))
    .slice(0, 40).map(([, text]) => ({ text }));
  assert.ok(entries.length > 5);
  screen.setListItems("LISTBOX", entries);
  const rows = screen.getDrawItems().filter(item => item.listRow) as ResolvedUiDrawItem[];
  assert.ok(rows.length > 5);
  const font = fonts[rows[0]!.font]!.font;
  let wrapped = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const lines = layoutText(font, row.text!, row.textRect.width * 640, row.rect.height * 480, row.textJustify, row.wordWrap);
    // The renderer's own wrap fits exactly in the row the runtime allotted.
    near(row.rect.height * 480, lines.length * font.descriptor.cellHeight, 1e-6);
    if (lines.length > 1) wrapped++;
    if (i > 0) near(row.rect.y, rows[i - 1]!.rect.y + rows[i - 1]!.rect.height);
  }
  assert.ok(wrapped > 0, "some credits entries wrap in the 0.38-wide column");
});


test("list rows count literal newlines as hard breaks, like `|` and the renderer", () => {
  const list = (wordWrap: 0 | 1) => `
    :TYPE UI_TYPE_SCREEN
    :OBJECT_ID S
    :S{*****>>>
      :TYPE UI_TYPE_LIST_BOX
      :OBJECT_ID LISTBOX
      :FONT 1
      :TEXT_JUSTIFY 1
      :WORD_WRAP ${wordWrap}
      :SIZE 0.9 8
    :E}*****<<<
  `;
  const rows = [{ text: "ONE\nTWO" }, { text: "A\r\nB|C" }, { text: "SINGLE" }, { text: "X|Y\nZ\r\nW" }];
  assert.deepEqual(wrapUiTextLines("ONE\nTWO", 500, line => line.length * 10), ["ONE", "TWO"]);
  assert.deepEqual(wrapUiTextLines("A\r\nB|C", 500, line => line.length * 10), ["A", "B", "C"]);
  for (const wordWrap of [0, 1] as const) {
    const screen = new UiScreenInstance(list(wordWrap), { measureText: (_font, text) => text.length * 10, getFontLineHeight: () => 20 });
    screen.setListItems("LISTBOX", rows);
    const heights = screen.getDrawItems().filter(item => item.listRow).map(item => Math.round(item.rect.height * 480 / 20));
    assert.deepEqual(heights, [2, 3, 1, 4], `WORD_WRAP ${wordWrap}`);
  }
});

test("preloadUiTextures registers every collection that loads even when another PCG fails", { skip: !fs.existsSync(DEMO_ROOT) }, async () => {
  const assets = await DemoAssets.load(await NodeVfs.open(DEMO_ROOT));
  const screens = ["UI/CAR.UI", "UI/TRACK.UI", "UI/ROPT.UI"];
  const refs = assets.collectUiTextureRefs(screens, CODE_SET_UI_TEXTURES);
  const broken = refs.find(ref => /graphics\/game\/common\//i.test(ref.registeredKey))!;
  assert.ok(broken, "a COMMON texture is referenced");
  const brokenPcg = broken.pcgPath.toLowerCase();
  const survivors = refs.filter(ref => ref.pcgPath.toLowerCase() !== brokenPcg);
  assert.ok(survivors.length > 0);
  const loadPcg = assets.loadPcg.bind(assets);
  let failures = 0;
  assets.loadPcg = (path: string) => {
    if (path.toLowerCase() === brokenPcg) {
      failures++;
      return Promise.reject(new Error(`unreadable ${path}`));
    }
    return loadPcg(path);
  };
  await assert.rejects(assets.preloadUiTextures(screens, CODE_SET_UI_TEXTURES), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.length >= 1 && error.errors.length === failures);
    return true;
  });
  // Every texture from the healthy PCGs is registered and sized; only the broken collection is missing.
  for (const ref of survivors) {
    assert.ok(assets.getLoadedUiTexture(ref.registeredKey), `${ref.registeredKey} registered`);
    assert.ok(assets.getUiTextureSize(ref.registeredKey), `${ref.registeredKey} sized`);
  }
  assert.equal(assets.getLoadedUiTexture(broken.registeredKey), undefined);

  // Once the PCG reads again, a retry fills in the rest and resolves.
  assets.loadPcg = loadPcg;
  const loaded = await assets.preloadUiTextures(screens, CODE_SET_UI_TEXTURES);
  assert.ok(loaded.has(broken.registeredKey));
});
