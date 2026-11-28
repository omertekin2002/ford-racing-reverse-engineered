import {
  loadVehicleDatabases, parseCameraDatabase, parseEngineSoundDatabase, parseGameData,
  parseQuickRace, parseRacingLine, parseRulesDatabase, parseSurfaceDatabase, parseTrackConfig,
  parseTrackDatabase, parseVolumeDatabase, resolveCarConfig, type RacingLine, type ResolvedCarConfig,
  type TrackConfig, type TrackRecord,
} from "./formats/databases.js";
import { decodeTextureMip as decodeTextureMipRgba, parseTexturesDxt, type TextureArchive, type TextureRecord } from "./formats/dxt.js";
import { buildFontAtlas, parseFonts } from "./formats/fonts.js";
import {
  findPcgEntry, parsePcg, resolveUiTextureRef, type PcgCollection, type PcgEntry, type UiTextureTarget,
} from "./formats/pcg.js";
import { parseSpc, type SpcBank } from "./formats/spc.js";
import { parseTranslationTable } from "./formats/tlate.js";
import { collectUiNodes, indexUiTemplates, parseUiScript, type UiNode } from "./formats/uiScript.js";
import { parse3dObjDb, parseBinInfo, parseXbx, type BinInfo, type SceneDatabase } from "./formats/xbx.js";
import { parseFogConfig } from "./render/sceneRenderer.js";
import {
  HUD_MAP_TEXTURES, HUD_SPRITE_MANIFEST, type HudAtlas, type SpeedUnits,
} from "./ui/hudModel.js";
import { normalizeGamePath, type VirtualFileSystem } from "./vfs/types.js";

const ascii = "DATA/ASCII/";
const presetNumbers = [5, 6, 4, 1, 2, 3] as const;
export const demoTrackDirectory = "3DDATA/TRACKS/ENGAF";

export function trackDirectory(trackId: string): string {
  return `3DDATA/TRACKS/${trackId}`;
}

export interface TrackRuntimeData {
  readonly trackId: string;
  readonly racingLine: RacingLine;
  readonly trackConfig: TrackConfig;
  readonly fog: ReturnType<typeof parseFogConfig>;
}

const DEFAULT_TRACK_CONFIG: TrackConfig = {
  FOG: { density: 0, colour: [0, 0, 0] },
  CAR_HEADLIGHT_STRENGTH: 0,
  TRACK_WETNESS: 0,
  SUN_FLARE_SIZE: 0,
  HEAT_HAZE_STRENGTH: 0,
};

export interface DemoModelBundle {
  xbx: ReturnType<typeof parseXbx>;
  textures: TextureArchive;
  binInfo: BinInfo;
  scene: SceneDatabase;
}

async function readResource<T>(path: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    throw new Error(`Failed to load ${path}`, { cause });
  }
}

async function loadTrackRuntimeData(vfs: VirtualFileSystem, trackId: string): Promise<TrackRuntimeData> {
  const racingLinePath = `${ascii}TRACKS/${trackId}.DAT`;
  const configPath = `3DDATA/TRACKS/CONFIGS/${trackId}.cfg`;
  const [racingLine, environment] = await Promise.all([
    readResource(racingLinePath, async () => parseRacingLine(await vfs.readText(racingLinePath))),
    vfs.has(configPath)
      ? readResource(configPath, async () => {
        const content = await vfs.readText(configPath);
        return { trackConfig: parseTrackConfig(content), fog: parseFogConfig(content) };
      })
      : Promise.resolve({ trackConfig: DEFAULT_TRACK_CONFIG, fog: null }),
  ]);
  return { trackId, racingLine, ...environment };
}

async function loadTables(vfs: VirtualFileSystem) {
  const readText = <T>(path: string, parse: (text: string) => T) =>
    readResource(path, async () => parse(await vfs.readText(path)));
  const [vehicles, tracks, surfaces, cameras, game, rules, quickRaces, engineSounds, volumes] =
    await Promise.all([
      loadVehicleDatabases(vfs),
      readText(ascii + "TRACKS.DAT", parseTrackDatabase),
      readText(ascii + "SURFACE.DAT", parseSurfaceDatabase),
      readText(ascii + "CAMERAS/CAMERAS.DAT", parseCameraDatabase),
      readText(ascii + "GAMEDATA.DAT", parseGameData),
      readText(ascii + "GAMEPLAY/RULES.DAT", parseRulesDatabase),
      Promise.all(presetNumbers.map(async number => ({
        number,
        ...await readText(ascii + `GAMEPLAY/QRACE_${number}.DAT`, parseQuickRace),
      }))),
      readText(ascii + "ENGSND.DAT", parseEngineSoundDatabase),
      readText(ascii + "VOLUMES.DAT", parseVolumeDatabase),
    ]);
  const installedTracks = [...tracks.values()].filter(
    track => vfs.has(`${trackDirectory(track.id)}/3dobjs.xbx`) && vfs.has(`${ascii}TRACKS/${track.id}.DAT`),
  );
  const defaultTrackId = installedTracks.find(t => t.id.toUpperCase() === "ENGAF")?.id
    ?? installedTracks[0]?.id
    ?? "ENGAF";
  const defaultTrack = await loadTrackRuntimeData(vfs, defaultTrackId);
  return {
    vehicles, tracks, installedTracks, defaultTrackId, surfaces, cameras, game, rules, quickRaces, engineSounds, volumes,
    racingLine: defaultTrack.racingLine,
    trackConfig: defaultTrack.trackConfig,
    fog: defaultTrack.fog,
  };
}

async function loadInterfaceAssets(vfs: VirtualFileSystem) {
  const translationPaths = vfs.list("language/").filter(path => /^language\/tlate_[a-z0-9]+\.dat$/i.test(path));
  const scriptPaths = vfs.list("ui/").filter(path => /\.ui$/i.test(path));
  const [fonts, translations, scripts] = await Promise.all([
    readResource("FONTS/fontbase.dat and FONTS/fontdata.dat", async () => {
      const [base, data] = await Promise.all([
        vfs.readUnpacked("FONTS/fontbase.dat"), vfs.readUnpacked("FONTS/fontdata.dat"),
      ]);
      return parseFonts(base, data).map(buildFontAtlas);
    }),
    Promise.all(translationPaths.map(async path => {
      const language = normalizeGamePath(path).slice("language/tlate_".length, -".dat".length).toUpperCase();
      const table = await readResource(path, async () => parseTranslationTable(await vfs.readUnpacked(path)));
      return [language, table] as const;
    })),
    Promise.all(scriptPaths.map(async path =>
      [normalizeGamePath(path), await readResource(path, () => vfs.readText(path))] as const)),
  ]);
  return { fonts, translations: new Map(translations), scripts: new Map(scripts) };
}

/**
 * Wrap the top mip of a DXT1/DXT3 `textures.DXT` record as a PCG-shaped entry so the UI renderer can draw
 * it (e.g. the minimap's `MAP_TRACK` / `MAP_DOT`).
 */
export function textureRecordToPcgEntry(record: TextureRecord): PcgEntry {
  if (record.kind !== "texture") throw new Error(`Texture ${record.name} is a reference, not image data`);
  const mip = record.mips[0];
  if (!mip) throw new Error(`Texture ${record.name} has no mip levels`);
  if (record.storage !== "dxt3") {
    // Re-encode as raw BGR + inverted alpha, which decodePcgEntryRgba understands.
    const rgba = decodeTextureMipRgba(record);
    const payload = new Uint8Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      payload[i] = rgba[i + 2]!;
      payload[i + 1] = rgba[i + 1]!;
      payload[i + 2] = rgba[i]!;
      payload[i + 3] = 255 - rgba[i + 3]!;
    }
    return pcgShaped(record.name, "raw-bgr-inva", mip.width, mip.height, payload);
  }
  return pcgShaped(record.name, "dxt3", mip.width, mip.height, mip.data);
}

function pcgShaped(
  name: string, encoding: PcgEntry["encoding"], width: number, height: number, payload: Uint8Array,
): PcgEntry {
  return {
    name, offset: 0, spanSize: payload.length, paletteSelector: 0, encodingSelector: encoding === "dxt3" ? 1 : 0,
    encoding, storedWidth: width, storedHeight: height, logicalWidth: width, logicalHeight: height,
    tileColumns: 1, tileRows: 1, alphaFlag: true, declaredPayloadBytes: payload.length, extraBytes: 0, payload,
  };
}

/** Code-set textures fr3.exe assigns without a script reference (UI_PARITY_SPEC table B-T). */
export const CODE_SET_UI_TEXTURES = [
  "GRAPHICS\\GAME\\BKGNDS\\CAR.PSD",
  "GRAPHICS\\GAME\\CARGLOW.PSD",
  "GRAPHICS\\GAME\\DOT.PSD",
  "GRAPHICS\\GAME\\COMMON\\PC\\PCENTER.PSD",
  "GRAPHICS\\GAME\\COMMON\\PC\\PCESCAPE.PSD",
  "GRAPHICS\\GAME\\COMMON\\PC\\PCKEYC.PSD",
  "GRAPHICS\\GAME\\COMMON\\FORDRACE.PSD",
  "GRAPHICS\\GAME\\COMMON\\MODEICON\\RACING.PSD",
  "GRAPHICS\\GAME\\COMMON\\MODEICON\\BOOST.PSD",
] as const;

/** `graphics\\loading\\graphics` entries drawn by the loading screen (`0x4b7400`). */
export interface LoadingSprites {
  /** 1920×1080 background. */
  load: PcgEntry;
  /** Chaser segment drawn with alpha test GREATER while its alpha is above 179. */
  bar: PcgEntry;
  /** Chaser segment drawn with vertex alpha below that. */
  bar2: PcgEntry;
}

/** Share concurrent requests and allow a failed read to be retried. */
function cached<T>(cache: Map<string, Promise<T>>, path: string, load: (path: string) => Promise<T>): Promise<T> {
  const key = normalizeGamePath(path);
  let pending = cache.get(key);
  if (!pending) {
    pending = readResource(key, () => load(key)).catch(error => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
  }
  return pending;
}

export class DemoAssets {
  readonly installedCars: readonly ResolvedCarConfig[];
  readonly installedTracks: readonly TrackRecord[];
  readonly defaultTrackId: string;
  private readonly models = new Map<string, Promise<DemoModelBundle>>();
  private readonly trackData = new Map<string, Promise<TrackRuntimeData>>();
  private readonly collections = new Map<string, Promise<PcgCollection>>();
  private readonly banks = new Map<string, Promise<SpcBank>>();
  private readonly hudAtlases = new Map<string, Promise<HudAtlas>>();
  private readonly hudMapTextures = new Map<string, Promise<ReadonlyMap<string, PcgEntry>>>();
  private readonly loadedUiTextures = new Map<string, PcgEntry>();
  private languageCode: string;

  private constructor(
    private readonly vfs: VirtualFileSystem,
    readonly tables: Awaited<ReturnType<typeof loadTables>>,
    private readonly interfaceAssets: Awaited<ReturnType<typeof loadInterfaceAssets>>,
  ) {
    this.installedCars = [...tables.vehicles.cars.values()]
      .map(car => resolveCarConfig(tables.vehicles, car.id))
      .filter(car => vfs.has(`${car.shapeFolder}/3dobjs.xbx`));
    this.installedTracks = tables.installedTracks;
    this.defaultTrackId = tables.defaultTrackId;
    this.trackData.set(
      normalizeGamePath(tables.defaultTrackId),
      Promise.resolve({
        trackId: tables.defaultTrackId,
        racingLine: tables.racingLine,
        trackConfig: tables.trackConfig,
        fog: tables.fog,
      }),
    );
    const [firstLanguage] = this.languages;
    if (!firstLanguage) throw new Error("Missing LANGUAGE/TLATE_*.DAT translation tables");
    this.languageCode = interfaceAssets.translations.has("EN") ? "EN" : firstLanguage;
  }

  loadTrackData(trackId: string): Promise<TrackRuntimeData> {
    return cached(this.trackData, trackId, () => loadTrackRuntimeData(this.vfs, trackId));
  }

  static async load(vfs: VirtualFileSystem): Promise<DemoAssets> {
    const [tables, interfaceAssets] = await Promise.all([loadTables(vfs), loadInterfaceAssets(vfs)]);
    return new DemoAssets(vfs, tables, interfaceAssets);
  }

  get fonts() { return this.interfaceAssets.fonts; }
  get quickRaces() { return this.tables.quickRaces; }
  get languages(): readonly string[] {
    const keys = [...this.interfaceAssets.translations.keys()];
    return keys.sort((a, b) => {
      const rank = (code: string) => (code === "EN" ? 0 : code === "US" ? 1 : 2);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  }
  get language(): string { return this.languageCode; }
  get translation() { return this.interfaceAssets.translations.get(this.languageCode)!; }
  get uiScripts(): ReadonlyMap<string, string> { return this.interfaceAssets.scripts; }

  setLanguage(language: string): void {
    const code = language.toUpperCase();
    if (!this.interfaceAssets.translations.has(code)) throw new Error(`Translation unavailable: ${language}`);
    this.languageCode = code;
  }

  readonly readUiScript = (path: string): string | undefined =>
    this.interfaceAssets.scripts.get(normalizeGamePath(path));

  loadPcg(path: string): Promise<PcgCollection> {
    return cached(this.collections, path, async key => parsePcg(await this.vfs.readUnpacked(key)));
  }

  async getPcgEntry(textureEnumPath: string) {
    const target = resolveUiTextureRef(textureEnumPath);
    if (!target || !this.vfs.has(target.pcgPath)) return undefined;
    const entry = findPcgEntry(await this.loadPcg(target.pcgPath), target.entryName);
    if (entry) this.loadedUiTextures.set(target.registeredKey, entry);
    return entry;
  }

  async getLoadingSprite(name: string) {
    return findPcgEntry(await this.loadPcg("GRAPHICS/LOADING/graphics.pcg"), name);
  }

  async getHudSprite(collection: string, name: string) {
    return findPcgEntry(await this.loadPcg(`GRAPHICS/HUD/${collection}/graphics.pcg`), name);
  }

  /** The three loading-screen sprites (`LOAD`, `_LOADBAR`, `_LOADBR2`). Throws if any is missing. */
  async loadLoadingSprites(): Promise<LoadingSprites> {
    const pcg = await this.loadPcg("GRAPHICS/LOADING/graphics.pcg");
    const get = (name: string) => {
      const entry = findPcgEntry(pcg, name);
      if (!entry) throw new Error(`Missing GRAPHICS/LOADING/graphics.pcg entry ${name}`);
      return entry;
    };
    return { load: get("Load"), bar: get("_loadbar"), bar2: get("_loadbr2") };
  }

  /**
   * Load (once per units setting) every sprite the fr3.exe RACING / RACING_BOOST HUD draws:
   * GENERIC, PANEL, REV, NUMBERS, the chosen MPH or KPH speedo numerals, and `MAP_TRACK` / `MAP_DOT` from
   * `3DDATA/MISC/textures.DXT`. Throws if any sprite is missing rather than silently falling back.
   */
  loadHudAtlas(units: SpeedUnits = "MPH"): Promise<HudAtlas> {
    return cached(this.hudAtlases, units, async () => {
      const sprites = new Map<string, PcgEntry>();
      const collections = (["GENERIC", "PANEL", "REV", "NUMBERS", units] as const);
      await Promise.all(collections.map(async collection => {
        const pcg = await this.loadPcg(`GRAPHICS/HUD/${collection}/graphics.pcg`);
        for (const name of HUD_SPRITE_MANIFEST[collection]) {
          // Exact (case-insensitive) match only: the 8-character fallback would alias spdn140m/spdn140k etc.
          const entry = pcg.entries.find(candidate => candidate.name.toLowerCase() === name.toLowerCase());
          if (!entry) throw new Error(`Missing HUD sprite GRAPHICS/HUD/${collection}/${name}`);
          sprites.set(`${collection}/${name}`, entry);
        }
      }));
      for (const [name, entry] of await this.loadHudMapTextures()) sprites.set(`MISC/${name}`, entry);
      const glyph = (name: string) => sprites.get(`NUMBERS/${name}`);
      const numerals: Record<string, PcgEntry | undefined> = {
        "/": glyph("slash"), ".": glyph("fullstop"), ":": glyph("colon"), R: glyph("R"), N: glyph("N"),
      };
      for (let digit = 0; digit < 10; digit++) numerals[String(digit)] = glyph(String(digit));
      return { units, sprites, numerals };
    });
  }

  /**
   * The minimap textures from `3DDATA/MISC/textures.DXT`, converted once and shared by the MPH and KPH atlases
   * (the PCG collections are shared through `loadPcg`), so a units swap only changes the speedo dial sprites.
   */
  private loadHudMapTextures(): Promise<ReadonlyMap<string, PcgEntry>> {
    return cached(this.hudMapTextures, "3DDATA/MISC/textures.DXT", async path => {
      const misc = parseTexturesDxt(await this.vfs.readUnpacked(path));
      const entries = new Map<string, PcgEntry>();
      for (const name of HUD_MAP_TEXTURES) {
        const record = misc.textures.find(texture => texture.name === name && texture.kind === "texture");
        if (!record) throw new Error(`Missing 3DDATA/MISC/textures.DXT texture ${name}`);
        entries.set(name, textureRecordToPcgEntry(record));
      }
      return entries;
    });
  }

  /**
   * Every distinct `:TEXTURE_ENUM` / `:CREATE_TEXTURE_GRAPHIC` target referenced by the given UI scripts
   * (templates from `UI/COMOBJ/COMOBJ.UI` and `UI/STD_OBJS.UI` are applied, as `UiScreenInstance` does), plus
   * the PCG paths of `:CREATE_TEXTURE_GRAPHIC_COLLECTION` declarations.
   */
  collectUiTextureRefs(scriptPaths: Iterable<string>, extra: Iterable<string> = []): UiTextureTarget[] {
    return this.collectUiTextureRefsAndCollections(scriptPaths, extra).targets;
  }

  private collectUiTextureRefsAndCollections(scriptPaths: Iterable<string>, extra: Iterable<string>) {
    const targets = new Map<string, UiTextureTarget>();
    const collections = new Set<string>();
    const add = (raw: string | null | undefined) => {
      const target = raw ? resolveUiTextureRef(raw) : null;
      if (target && this.vfs.has(target.pcgPath)) targets.set(target.registeredKey, target);
    };
    const templates = new Map<string, UiNode>();
    for (const common of ["UI/COMOBJ/COMOBJ.UI", "UI/STD_OBJS.UI"]) {
      const source = this.readUiScript(common);
      if (source !== undefined) {
        indexUiTemplates(parseUiScript(source, { readFile: this.readUiScript, templates }).roots, templates);
      }
    }
    for (const path of scriptPaths) {
      const source = this.readUiScript(path);
      if (source === undefined) continue;
      const parsed = parseUiScript(source, { readFile: this.readUiScript, templates });
      for (const node of collectUiNodes(parsed.roots)) add(node.textureEnum);
      for (const resource of parsed.resources) {
        if (resource.kind === "graphic") add(resource.path);
        else {
          const target = resolveUiTextureRef(resource.path);
          if (target && this.vfs.has(target.pcgPath)) collections.add(target.pcgPath);
        }
      }
    }
    for (const raw of extra) add(raw);
    return { targets: [...targets.values()], collections: [...collections] };
  }

  /**
   * Resolve and cache every texture referenced by the given UI scripts (plus `extra` code-set textures, e.g.
   * {@link CODE_SET_UI_TEXTURES}) so screens open with zero lazy pop-in. Whole `:CREATE_TEXTURE_GRAPHIC_COLLECTION`
   * PCGs are registered too. Returns the entries keyed by registered key (lowercase, forward slashes, `.psd`),
   * which is also what {@link getLoadedUiTexture} reads.
   */
  async preloadUiTextures(
    scriptPaths: Iterable<string>, extra: Iterable<string> = [],
  ): Promise<ReadonlyMap<string, PcgEntry>> {
    const loaded = new Map<string, PcgEntry>();
    const { targets, collections } = this.collectUiTextureRefsAndCollections(scriptPaths, extra);
    // Each PCG loads independently: one unreadable collection must not keep every other texture unsized.
    const results = await Promise.allSettled([
      ...targets.map(async target => {
        const entry = findPcgEntry(await this.loadPcg(target.pcgPath), target.entryName);
        if (entry) {
          loaded.set(target.registeredKey, entry);
          this.loadedUiTextures.set(target.registeredKey, entry);
        }
      }),
      ...collections.map(async pcgPath => {
        const dir = pcgPath.slice(0, pcgPath.lastIndexOf("/"));
        for (const entry of (await this.loadPcg(pcgPath)).entries) {
          const key = `${dir}/${entry.name.toLowerCase()}.psd`;
          loaded.set(key, entry);
          this.loadedUiTextures.set(key, entry);
        }
      }),
    ]);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
    if (failures.length) {
      // Everything that did load is registered above; report the failures to the caller.
      throw new AggregateError(failures, `Failed to preload ${failures.length} UI texture collection(s)`);
    }
    return loaded;
  }

  /** Synchronous lookup of a texture already resolved by {@link preloadUiTextures} / {@link getPcgEntry}. */
  getLoadedUiTexture(textureRef: string): PcgEntry | undefined {
    const target = resolveUiTextureRef(textureRef);
    return target ? this.loadedUiTextures.get(target.registeredKey) : undefined;
  }

  /** Pixel size of a loaded UI texture, for `UiScreenInstance` `getTextureSize` (AUTOSIZE / STRETCH_GRAPHIC 0). */
  readonly getUiTextureSize = (textureRef: string): { width: number; height: number } | undefined => {
    const entry = this.getLoadedUiTexture(textureRef);
    return entry && { width: entry.logicalWidth, height: entry.logicalHeight };
  };

  load3dBundle(dir: string): Promise<DemoModelBundle> {
    return cached(this.models, dir.replace(/[\\/]+$/, ""), async key => {
      const read = (file: string) => this.vfs.readUnpacked(`${key}/${file}`);
      const [objects, vertices, textures, info, scene] = await Promise.all([
        read("3dobjs.xbx"), read("3dobjsp.xbx"), read("textures.dxt"), read("bininfo.bin"), read("3dobjdb.bin"),
      ]);
      const binInfo = parseBinInfo(info);
      return {
        xbx: parseXbx(objects, vertices),
        textures: parseTexturesDxt(textures),
        binInfo,
        scene: parse3dObjDb(scene, binInfo),
      };
    });
  }

  loadSpc(path: string): Promise<SpcBank> {
    return cached(this.banks, path, async key => parseSpc(await this.vfs.readUnpacked(key)));
  }
}
