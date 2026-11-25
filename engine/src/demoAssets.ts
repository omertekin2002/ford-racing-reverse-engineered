import {
  loadVehicleDatabases, parseCameraDatabase, parseEngineSoundDatabase, parseGameData,
  parseQuickRace, parseRacingLine, parseRulesDatabase, parseSurfaceDatabase, parseTrackConfig,
  parseTrackDatabase, parseVolumeDatabase, resolveCarConfig, type ResolvedCarConfig,
} from "./formats/databases.js";
import { parseTexturesDxt, type TextureArchive } from "./formats/dxt.js";
import { buildFontAtlas, parseFonts } from "./formats/fonts.js";
import { findPcgEntry, parsePcg, resolveUiTextureRef, type PcgCollection } from "./formats/pcg.js";
import { parseSpc, type SpcBank } from "./formats/spc.js";
import { parseTranslationTable } from "./formats/tlate.js";
import { parse3dObjDb, parseBinInfo, parseXbx, type BinInfo, type SceneDatabase } from "./formats/xbx.js";
import { parseFogConfig } from "./render/sceneRenderer.js";
import { normalizeGamePath, type VirtualFileSystem } from "./vfs/types.js";

const ascii = "DATA/ASCII/";
const presetNumbers = [5, 6, 4, 1, 2, 3] as const;
export const demoTrackDirectory = "3DDATA/TRACKS/ENGAF";

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

async function loadTables(vfs: VirtualFileSystem) {
  const readText = <T>(path: string, parse: (text: string) => T) =>
    readResource(path, async () => parse(await vfs.readText(path)));
  const [vehicles, tracks, surfaces, cameras, game, rules, quickRaces, engineSounds, volumes, racingLine, environment] =
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
      readText(ascii + "TRACKS/ENGAF.DAT", parseRacingLine),
      readText("3DDATA/TRACKS/CONFIGS/engaf.cfg", content => ({
        trackConfig: parseTrackConfig(content),
        fog: parseFogConfig(content),
      })),
    ]);
  return { vehicles, tracks, surfaces, cameras, game, rules, quickRaces, engineSounds, volumes, racingLine, ...environment };
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
  private readonly models = new Map<string, Promise<DemoModelBundle>>();
  private readonly collections = new Map<string, Promise<PcgCollection>>();
  private readonly banks = new Map<string, Promise<SpcBank>>();
  private languageCode: string;

  private constructor(
    private readonly vfs: VirtualFileSystem,
    readonly tables: Awaited<ReturnType<typeof loadTables>>,
    private readonly interfaceAssets: Awaited<ReturnType<typeof loadInterfaceAssets>>,
  ) {
    this.installedCars = [...tables.vehicles.cars.values()]
      .map(car => resolveCarConfig(tables.vehicles, car.id))
      .filter(car => vfs.has(`${car.shapeFolder}/3dobjs.xbx`));
    const [firstLanguage] = this.languages;
    if (!firstLanguage) throw new Error("Missing LANGUAGE/TLATE_*.DAT translation tables");
    this.languageCode = interfaceAssets.translations.has("EN") ? "EN" : firstLanguage;
  }

  static async load(vfs: VirtualFileSystem): Promise<DemoAssets> {
    const [tables, interfaceAssets] = await Promise.all([loadTables(vfs), loadInterfaceAssets(vfs)]);
    return new DemoAssets(vfs, tables, interfaceAssets);
  }

  get fonts() { return this.interfaceAssets.fonts; }
  get quickRaces() { return this.tables.quickRaces; }
  get languages(): readonly string[] { return [...this.interfaceAssets.translations.keys()]; }
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
    return findPcgEntry(await this.loadPcg(target.pcgPath), target.entryName);
  }

  async getLoadingSprite(name: string) {
    return findPcgEntry(await this.loadPcg("GRAPHICS/LOADING/graphics.pcg"), name);
  }

  async getHudSprite(collection: string, name: string) {
    return findPcgEntry(await this.loadPcg(`GRAPHICS/HUD/${collection}/graphics.pcg`), name);
  }

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
