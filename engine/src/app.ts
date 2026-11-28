import { AudioEngine, type CountdownStep, type EngineLayer, type EngineLayerRole, type TyreSurface } from "./audio/audioEngine.js";
import { DemoAssets, trackDirectory, type TrackRuntimeData } from "./demoAssets.js";
import type { EngineSoundRecord, ResolvedCarConfig, TrackRecord } from "./formats/databases.js";
import { measureTextLine, type ParsedFont } from "./formats/fonts.js";
import type { PcgEntry } from "./formats/pcg.js";
import type { SpcBank, SpcEntry } from "./formats/spc.js";
import { lookupTranslation } from "./formats/tlate.js";
import { AiDriver, type AiObstacle, type CarControlOutput } from "./game/aiDriver.js";
import { CameraController, cameraPresetFromDefinition, type CameraMode, type CameraView } from "./game/cameraController.js";
import { RaceManager, type RaceMode, type RaceObservation, type RacePhase } from "./game/raceManager.js";
import { InputManager, type DrivingInput, type InputFrame } from "./input/inputManager.js";
import { clamp, mat4FromQuatTranslation } from "./math/mat4.js";
import { resolveCarCollision } from "./physics/collision.js";
import { TrackSpatial } from "./physics/trackSpatial.js";
import { VehiclePhysics } from "./physics/vehiclePhysics.js";
import { GlContext } from "./render/glContext.js";
import { SceneRenderer, type CarInstance, type CompiledModel, type ViewportRect } from "./render/sceneRenderer.js";
import {
  canvasToUiPoint, computeUiViewport, UiBatchBuilder, UiRenderer, type HudState, type UiColor,
} from "./render/uiRenderer.js";
import { formatRaceTime, formatResultsRowTimes } from "./ui/hudModel.js";
import {
  MenuController, type MenuCar, type MenuCommand, type MenuScene, type MenuSceneAction,
  type MenuSettings, type MenuState, type MenuTrack, type MenuView, type RaceSetup, type RaceStanding,
} from "./ui/menuController.js";
import { UiScreenInstance } from "./ui/uiRuntime.js";

export interface EngineSnapshot {
  status: string;
  fps: number;
  running: boolean;
  state: MenuState;
  phase: RacePhase | null;
  trackId: string | null;
  carId: string | null;
  livery: string | null;
  speedMph: number;
  speedKph: number;
  gear: number;
  rpm: number;
  lap: number;
  laps: number;
  position: number;
  participants: number;
  boostCharges: number;
  boostActive: boolean;
  cameraMode: CameraMode;
  muted: boolean;
}

export interface EngineAppOptions {
  sound?: boolean;
  onStatus?: (status: string) => void;
  onError?: (error: Error) => void;
}

interface RacerSlot {
  id: string;
  carId: string;
  carName: string;
  isPlayer: boolean;
  config: ResolvedCarConfig;
  physics: VehiclePhysics;
  ai?: AiDriver;
  model: CompiledModel;
  lastGear: number;
  lastLap: number;
  lastBoostActive: boolean;
  lowSpeedTimer: number;
  flippedTimer: number;
}

interface ActiveRace {
  setup: RaceSetup;
  trackId: string;
  trackName: string;
  trackData: TrackRuntimeData;
  trackModel: CompiledModel;
  spatial: TrackSpatial;
  race: RaceManager;
  racers: RacerSlot[];
  camera: CameraController;
  cameraView: CameraView;
  courseMap: readonly { x: number; z: number }[];
  lastCountdown?: CountdownStep;
  finishHoldTimer: number;
  finishedReported: boolean;
}

const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
const RACE_MODES: readonly RaceMode[] = ["RACING_BOOST", "RACING"];
const TURNTABLE_RECT: ViewportRect = { x: 0.04, y: 0.16, width: 0.56, height: 0.62 };

/** Smallest text scale used for labels that must stay legible on narrow (portrait) viewports. */
export const READABLE_MIN_TEXT_SCALE = 0.6;
const PANEL_DARK: UiColor = [0.03, 0.06, 0.09, 0.86];
const PANEL_SCRIM: UiColor = [0.02, 0.04, 0.07, 0.68];
const PANEL_CARD: UiColor = [0.05, 0.10, 0.15, 0.92];
const ACCENT: UiColor = [0.99, 0.85, 0.32, 1];
const CYAN: UiColor = [0.24, 0.86, 0.82, 1];
const INK: UiColor = [0.91, 0.96, 0.99, 1];
const MUTED: UiColor = [0.62, 0.73, 0.81, 1];
const BAR_BG: UiColor = [0.12, 0.19, 0.25, 0.95];

const EMPTY_DRIVING: DrivingInput = {
  throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false,
  gearUpPressed: false, gearDownPressed: false, cameraNextPressed: false,
  lookBack: false, pausePressed: false, resetPressed: false, isAnalogSteer: false,
};

/** TRACKS.DAT stores signed difficulty offsets around 0 (e.g. [0, -0.04, -0.15]); convert to positive AI multipliers. */
export function resolveTrackDifficultyScales(
  offsets?: readonly [number, number, number],
): [number, number, number] {
  if (!offsets) return [1, 1, 1];
  return [
    clamp(1 + offsets[0], 0.5, 1.5),
    clamp(1 + offsets[1], 0.5, 1.5),
    clamp(1 + offsets[2], 0.5, 1.5),
  ];
}

/** Translate AI driving output into VehiclePhysics inputs, honoring driveDirection without tripping auto-reverse when braking. */
export function aiControlToDrivingInput(
  control: CarControlOutput,
  state: { readonly gear: number; readonly speedMps: number },
): DrivingInput {
  if (control.driveDirection < 0) {
    return {
      ...EMPTY_DRIVING,
      throttle: 0,
      brake: control.throttle,
      steer: control.steer,
      handbrake: false,
      boost: false,
      isAnalogSteer: true,
    };
  }
  if (state.gear < 0 && control.throttle === 0 && control.brake > 0) {
    return {
      ...EMPTY_DRIVING,
      throttle: 0.25,
      brake: 0,
      steer: control.steer,
      handbrake: true,
      boost: false,
      isAnalogSteer: true,
    };
  }
  const holdStopped = state.gear >= 0 && state.speedMps < 2.2 && control.brake > 0.1 && control.throttle === 0;
  return {
    ...EMPTY_DRIVING,
    throttle: control.throttle,
    brake: control.brake,
    steer: control.steer,
    handbrake: control.handbrake || holdStopped,
    boost: control.boost,
    isAnalogSteer: true,
  };
}

export const AI_BLOCKED_IMPULSE_THRESHOLD = 50;
export const AI_FLIPPED_UP_THRESHOLD = 0.25;
export const AI_FLIPPED_RESET_SECONDS = 2.0;

/** Detect when an AI car is pinned against a barrier/car or stalled at low speed. */
export function isAiCarBlocked(
  lastImpactImpulse: number,
  speedMps: number,
  lowSpeedContactSeconds = 0,
): boolean {
  return (lastImpactImpulse > AI_BLOCKED_IMPULSE_THRESHOLD && speedMps < 2.0)
    || (lowSpeedContactSeconds >= 1.0 && speedMps < 1.5);
}

/** Track how long an AI car has been overturned (`up[1] < 0.25`) and trigger upright recovery after 2s. */
export function updateAiFlippedTimer(
  currentTimer: number,
  upY: number,
  dt: number,
): { timer: number; shouldReset: boolean } {
  if (upY < AI_FLIPPED_UP_THRESHOLD) {
    const next = currentTimer + Math.max(0, dt);
    if (next >= AI_FLIPPED_RESET_SECONDS) return { timer: 0, shouldReset: true };
    return { timer: next, shouldReset: false };
  }
  return { timer: 0, shouldReset: false };
}

const ENGINE_SPC_POSITIONAL_ROLES: readonly EngineLayerRole[] = [
  "HIGH_LOADED", "HIGH_UNLOADED", "LOW_LOADED", "LOW_UNLOADED", "TICKOVER",
];

/** Match an SPC entry name (case-insensitive) to an engine layer role, falling back to FR3's SPC order. */
export function resolveEngineLayerRole(entryName: string, index: number): EngineLayerRole | null {
  const upper = entryName.toUpperCase();
  if (upper.includes("HIGH_LOADED")) return "HIGH_LOADED";
  if (upper.includes("HIGH_UNLOADED")) return "HIGH_UNLOADED";
  if (upper.includes("LOW_LOADED")) return "LOW_LOADED";
  if (upper.includes("LOW_UNLOADED")) return "LOW_UNLOADED";
  if (upper.includes("TICKOVER")) return "TICKOVER";
  if (upper.includes("SUPERCHARGER")) return "SUPERCHARGER";
  if (upper.includes("TURBO")) return "TURBO";
  if (upper.includes("GEARBOX_WHINE")) return "GEARBOX_WHINE";
  return ENGINE_SPC_POSITIONAL_ROLES[index] ?? null;
}

/** Sensible recorded reference RPM per engine layer role when ENGSND.DAT does not specify START_RPM. */
export function defaultReferenceRpmForRole(role: EngineLayerRole): number {
  switch (role) {
    case "TICKOVER": return 1800;
    case "LOW_UNLOADED":
    case "LOW_LOADED": return 3500;
    case "HIGH_UNLOADED":
    case "HIGH_LOADED": return 6200;
    case "SUPERCHARGER": return 3000;
    case "TURBO":
    case "GEARBOX_WHINE": return 4000;
  }
}

/** Resolve a car's configured engine sound bank from ENGSND.DAT, falling back to SND/ENGINE1.SPC. */
export function resolveCarEngineSound(
  cfg: Pick<ResolvedCarConfig, "car">,
  engineSounds: ReadonlyMap<string, EngineSoundRecord>,
): { bankPath: string; record?: EngineSoundRecord } {
  const soundType = cfg.car.fields.CAR_SOUND_TYPE;
  const record = soundType ? engineSounds.get(soundType.toLowerCase()) : undefined;
  const bank = record?.bank?.trim();
  return {
    bankPath: bank ? `SND/${bank}.SPC` : "SND/ENGINE1.SPC",
    record,
  };
}

/** Shared auxiliary engine sample bank referenced by ENGSND.DAT TURBO/SUPERCHARGER/GEARBOX_WHINE/WIND types. */
export const GEN_ENGINE_SPC_PATH = "SND/GEN_ENG.SPC";

export type GenEngineSampleRole = "TURBO" | "SUPERCHARGER" | "GEARBOX_WHINE" | "WIND";

/** Strictly match an SND/GEN_ENG.SPC entry name to its auxiliary role (no positional fallback). */
export function resolveGenEngineRole(entryName: string): GenEngineSampleRole | null {
  const upper = entryName.toUpperCase();
  if (upper.includes("SUPERCHARGER")) return "SUPERCHARGER";
  if (upper.includes("TURBO")) return "TURBO";
  if (upper.includes("GEARBOX_WHINE")) return "GEARBOX_WHINE";
  if (upper.includes("WIND")) return "WIND";
  return null;
}

/**
 * Pick the GEN_ENG.SPC entries a car's ENGSND.DAT record asks for (TURBO / SUPERCHARGER / GEARBOX_WHINE)
 * that its own engine bank does not already provide.
 */
export function pickGenEngineAuxEntries(
  entries: readonly SpcEntry[],
  record: Pick<EngineSoundRecord, "samples"> | undefined,
  presentRoles: ReadonlySet<EngineLayerRole> = new Set(),
): { role: Exclude<GenEngineSampleRole, "WIND">; entry: SpcEntry }[] {
  if (!record) return [];
  const wanted = new Set<GenEngineSampleRole>();
  for (const sample of record.samples) {
    const role = resolveGenEngineRole(sample.type);
    if (role && role !== "WIND" && !presentRoles.has(role)) wanted.add(role);
  }
  const picked: { role: Exclude<GenEngineSampleRole, "WIND">; entry: SpcEntry }[] = [];
  for (const entry of entries) {
    const role = resolveGenEngineRole(entry.name);
    if (!role || role === "WIND" || !wanted.has(role)) continue;
    wanted.delete(role);
    picked.push({ role, entry });
  }
  return picked;
}

/** Pick the looped wind sample from SND/GEN_ENG.SPC. */
export function pickWindEntry(entries: readonly SpcEntry[]): SpcEntry | undefined {
  return entries.find(e => resolveGenEngineRole(e.name) === "WIND");
}

/**
 * True when a car's texture archive carries per-livery texture variants (fr3.exe matches bits 24..31 of
 * the texture flags against the livery index). CARDATA.DAT livery stems are not a reliable signal: many
 * cars list `QUESTION` for every livery yet ship real variants.
 */
export function hasLiveryTextureVariants(textures: readonly { kind: string; flags: number }[]): boolean {
  return textures.some(t => t.kind !== "reference" && (t.flags >>> 24) > 0);
}

/**
 * Selectable liveries for Car Select: a car whose model has no texture variants (the 16 GT/LMP bonus cars
 * that list 12 `QUESTION` liveries) collapses to its first livery so the menu offers no no-op choices.
 */
export function dedupeCarLiveries(
  liveries: readonly { type: string }[],
  hasTextureVariants: boolean,
): string[] {
  const types = liveries.map(l => l.type);
  return !hasTextureVariants && types.length > 1 ? [types[0]!] : types;
}

/** Results-table row input: the race manager standing fields needed to build a results row. */
export interface ResultStandingInput {
  readonly carId: string;
  readonly progress: number;
  readonly totalRaceTime: number;
  readonly bestLapTime: number | null;
  readonly finishTime: number | null;
}

/**
 * Build results rows. Finished racers keep their real finish time; unfinished racers get no time
 * (so the table never repeats the player's finish time) and instead a laps-down count or an
 * estimated gap to the winner from their average pace.
 */
export function buildRaceResultRows(
  standings: readonly ResultStandingInput[],
  laps: number,
  carNameOf: (carId: string, index: number) => string,
): RaceStanding[] {
  const leaderTime = standings.find(s => s.finishTime !== null)?.finishTime ?? null;
  const raceLaps = Math.max(1, laps);
  return standings.map((s, index) => {
    const finished = s.finishTime !== null;
    let lapsDown = 0;
    let estimatedGapSeconds: number | null = null;
    if (!finished) {
      const remaining = Math.max(0, raceLaps - s.progress);
      lapsDown = Math.floor(remaining + 1e-9);
      if (lapsDown < 1 && leaderTime !== null && s.progress > 0.05 && s.totalRaceTime > 0) {
        const pace = s.totalRaceTime / s.progress;
        const projected = s.totalRaceTime + remaining * pace;
        estimatedGapSeconds = Math.max(0, projected - leaderTime);
      }
    }
    return {
      carId: s.carId,
      carName: carNameOf(s.carId, index),
      totalSeconds: s.finishTime,
      bestLapSeconds: s.bestLapTime,
      gapSeconds: leaderTime !== null && s.finishTime !== null ? Math.max(0, s.finishTime - leaderTime) : estimatedGapSeconds,
      finished,
      lapsDown,
    };
  });
}

/**
 * Policy for exceptions thrown inside the animation frame. Transient errors keep the loop alive (reporting
 * only the first of a streak); after `maxConsecutive` back-to-back failures the loop halts instead of
 * spamming errors, and a later user gesture / restart / menu action may resume it.
 */
export class TickErrorGuard {
  private consecutive = 0;
  private halted = false;

  constructor(readonly maxConsecutive = 5) {}

  get isHalted(): boolean { return this.halted; }
  get consecutiveErrors(): number { return this.consecutive; }

  /** Record a successful frame. */
  success(): void {
    this.consecutive = 0;
  }

  /** Record a failed frame; `contextLost` errors always halt. */
  failure(contextLost: boolean): { report: boolean; halt: boolean } {
    this.consecutive++;
    const halt = contextLost || this.consecutive >= Math.max(1, this.maxConsecutive);
    if (halt) this.halted = true;
    return { report: this.consecutive === 1 || halt, halt };
  }

  /** Clear the halt so the loop may restart; returns whether it had been halted. */
  recover(): boolean {
    const was = this.halted;
    this.halted = false;
    this.consecutive = 0;
    return was;
  }
}

/** Race status line, shared by race start and resume-from-pause: `Racing <car> on <track>`. */
export function formatRacingStatus(carName: string | undefined, trackName: string): string {
  return carName ? `Racing ${carName} on ${trackName}` : `Racing on ${trackName}`;
}

/** Pick the primary tyre skid loop sample from SND/TYRES.SPC. */
export function pickSkidEntry(entries: readonly SpcEntry[]): SpcEntry | undefined {
  const byMatch = (needle: string) => entries.find(e => e.name.toUpperCase().includes(needle));
  return byMatch("SQUEAL") ?? byMatch("SQUEAK") ?? byMatch("SQUALL") ?? byMatch("SKID") ?? entries[0];
}

/** Pick the primary collision impact sample from SND/misc.spc. */
export function pickCollisionEntry(entries: readonly SpcEntry[]): SpcEntry | undefined {
  const byMatch = (needle: string) => entries.find(e => e.name.toUpperCase().includes(needle));
  return byMatch("MEDIUM1") ?? byMatch("HEAVY1") ?? byMatch("MEDIUM") ?? byMatch("HEAVY") ?? byMatch("LIGHT") ?? byMatch("CRASH");
}

/** Pick the boost activation sample from SND/misc.spc. */
export function pickBoostEntry(entries: readonly SpcEntry[]): SpcEntry | undefined {
  return entries.find(e => e.name.toUpperCase().includes("BOOST"));
}

/** Clamp text scale so single/multi-line UI strings stay inside `maxWidthPx` without overflowing the 640px frame. */
export function fitTextScale(
  font: ParsedFont,
  text: string,
  maxWidthPx: number,
  baseScale = 1,
  minScale = 0.45,
): number {
  if (baseScale <= 0 || maxWidthPx <= 0) return baseScale;
  const lines = text.replace(/\r?\n/g, "|").split("|");
  let maxLineWidth = 0;
  for (const line of lines) {
    maxLineWidth = Math.max(maxLineWidth, measureTextLine(font, line));
  }
  if (maxLineWidth <= 0) return baseScale;
  const needed = maxLineWidth * baseScale;
  if (needed <= maxWidthPx) return baseScale;
  return Math.max(minScale, maxWidthPx / maxLineWidth);
}

/**
 * Fit a label into `maxWidthPx` without shrinking below a readable `minScale`: try each candidate
 * (longest first) and, when even the shortest overflows at `minScale`, truncate it with "...".
 */
export function fitTextWithEllipsis(
  font: ParsedFont,
  candidates: readonly string[],
  maxWidthPx: number,
  baseScale = 1,
  minScale = 0.6,
): { text: string; scale: number } {
  const options = candidates.filter(c => c.length > 0);
  if (!options.length) return { text: "", scale: baseScale };
  if (baseScale <= 0 || maxWidthPx <= 0) return { text: options[0]!, scale: baseScale };
  const floor = Math.min(baseScale, Math.max(0.01, minScale));
  for (const text of options) {
    const scale = fitTextScale(font, text, maxWidthPx, baseScale, floor);
    if (measureTextLine(font, text) * scale <= maxWidthPx + 1e-6) return { text, scale };
  }
  const last = options[options.length - 1]!;
  for (let len = last.length - 1; len > 0; len--) {
    const text = `${last.slice(0, len).trimEnd()}...`;
    if (measureTextLine(font, text) * floor <= maxWidthPx + 1e-6) return { text, scale: floor };
  }
  return { text: "...", scale: floor };
}

const LANGUAGE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  EN: "ENGLISH",
  US: "ENGLISH (US)",
  GR: "DEUTSCH (GR)",
  DE: "DEUTSCH (DE)",
  FR: "FRANCAIS (FR)",
  SP: "ESPANOL (SP)",
  ES: "ESPANOL (ES)",
  IT: "ITALIANO (IT)",
  CZ: "CESTINA (CZ)",
  PL: "POLSKI (PL)",
  RU: "RUSSKIY (RU)",
  HN: "MAGYAR (HN)",
  RM: "ROMANA (RM)",
  TK: "TURKCE (TK)",
};

/** Format a TLATE language code (e.g. `GR`, `EN`, `US`) as a human-readable label for the Options menu. */
export function formatLanguageDisplayName(code: string): string {
  const upper = code.trim().toUpperCase();
  return LANGUAGE_DISPLAY_NAMES[upper] ?? upper;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function normalizeRgba(c: readonly [number, number, number, number]): UiColor {
  return [c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255];
}

function countdownLabelToStep(label: "3" | "2" | "1" | "GO!" | null): CountdownStep | undefined {
  if (label === "3") return 3;
  if (label === "2") return 2;
  if (label === "1") return 1;
  if (label === "GO!") return "GO";
  return undefined;
}

function surfaceToTyreSurface(surfaceName: string): TyreSurface {
  const s = surfaceName.toLowerCase();
  if (s.includes("grass")) return "grass";
  if (s.includes("gravel") || s.includes("stone")) return "gravel";
  if (s.includes("sand")) return "sand";
  if (s.includes("mud") || s.includes("dirt")) return "dirt";
  if (s.includes("snow") || s.includes("ice")) return "ice";
  if (s.includes("wet") || s.includes("stream")) return "wet";
  return "asphalt";
}

function computeCarRatings(cfg: ResolvedCarConfig): NonNullable<MenuCar["ratings"]> {
  const maxTorque = Math.max(100, ...cfg.engine.torque) * (cfg.engine.fields.TORQUE_MODIFIER ?? 1);
  const maxRpm = cfg.engine.fields.MAX_RPM ?? 6500;
  const peakPower = (maxTorque * maxRpm) / 5252000;
  const totalMass = Math.max(800, cfg.body.masses.reduce((s, m) => s + m.mass, 0) + (cfg.setup.ballast?.mass ?? 0));
  const grip = ((cfg.frontTyre.fields.ROAD_MAGIC_GRIP_NUMBER ?? 45) + (cfg.rearTyre.fields.ROAD_MAGIC_GRIP_NUMBER ?? 45)) * 0.5;
  return {
    speed: clamp((peakPower / 2.2) * 0.65 + (maxRpm / 9000) * 0.35, 0.18, 1),
    power: clamp(peakPower / 2.3, 0.15, 1),
    acceleration: clamp((peakPower / (totalMass / 1400)) / 2.0, 0.15, 1),
    handling: clamp((grip - 25) / 45, 0.2, 1),
  };
}

/**
 * Strips the internal `!!tag!!` markers the translation tables prefix to some names (`!!secret!! 2004 M3 GTR`,
 * `!!clone!! 1985 RS200`). A string that is nothing but a marker (`!!TEXT MISSING!!`) is not a name, so it yields
 * `undefined` and the caller falls back to the record id.
 */
export function stripDisplayNameMarkers(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const stripped = text.replace(/^(?:\s*!![^!]*!!)+\s*/, "").trim();
  return stripped || undefined;
}

function formatCarDisplayName(assets: DemoAssets, cfg: ResolvedCarConfig): string {
  const enumKey = cfg.car.fields.INGAME_TEXT_ENUM;
  if (typeof enumKey === "string") {
    const localized = stripDisplayNameMarkers(lookupTranslation(assets.translation, enumKey));
    if (localized) return localized;
  }
  return cfg.car.id.replaceAll("_", " ");
}

function formatTrackDisplayName(assets: DemoAssets, track: TrackRecord): string {
  const localized = stripDisplayNameMarkers(lookupTranslation(assets.translation, track.INGAME_TEXT_ENUM));
  return localized ?? track.id.replaceAll("_", " ");
}

/** Complete playable WebGL2 Ford Racing 3 runtime (menus, 3D turntable, multi-track races, HUD, audio). */
export class FordRacing3App {
  private readonly gl: GlContext;
  private readonly scene: SceneRenderer;
  private readonly ui: UiRenderer;
  private readonly audio: AudioEngine;
  private readonly input = new InputManager();
  private readonly menu: MenuController;
  private readonly view: Window;
  private readonly previousTabIndex: string | null;

  private readonly pcgCache = new Map<string, PcgEntry | null>();
  private readonly carConfigs = new Map<string, ResolvedCarConfig>();
  private readonly compiledModels = new Map<string, CompiledModel>();

  private turntableModel?: CompiledModel;
  private turntableKey = "";
  private turntableAngle = 0;
  private turntableRequest = 0;

  private activeRace?: ActiveRace;
  private readonly trackSpatialCache = new Map<string, TrackSpatial>();
  private readonly trackModelCache = new Map<string, CompiledModel>();
  private loadRequestSeq = 0;
  private sharedAudioLoaded = false;
  private loadedEngineBankKey = "";
  private engineBankRequestSeq = 0;
  private genEngineBank?: Promise<SpcBank | null>;
  private readonly tickErrors = new TickErrorGuard();
  private errorRecoveryArmed = false;

  private frame?: number;
  private lastTime?: number;
  private clock = 0;
  private fps = 0;
  private status = "Initializing engine";
  private disposed = false;

  private overlayButtons: { rect: ViewportRect; label: string; active?: boolean; onClick: () => void }[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly assets: DemoAssets,
    private readonly options: EngineAppOptions = {},
  ) {
    const view = canvas.ownerDocument.defaultView;
    if (!view) throw new Error("The canvas requires a browser window");
    this.view = view;
    this.gl = new GlContext(canvas);
    try {
      this.scene = new SceneRenderer(this.gl);
      this.ui = new UiRenderer(this.gl);
    } catch (error) {
      this.gl.dispose();
      throw error;
    }
    this.audio = new AudioEngine({ unlockTarget: canvas });
    this.setMuted(options.sound === false);

    for (const cfg of assets.installedCars) {
      this.carConfigs.set(cfg.car.id, cfg);
    }

    const menuCars: MenuCar[] = assets.installedCars.map(cfg => ({
      id: cfg.car.id,
      name: formatCarDisplayName(assets, cfg),
      liveries: cfg.car.liveries.map(l => l.type),
      ratings: computeCarRatings(cfg),
    }));

    const menuTracks: MenuTrack[] = assets.installedTracks.map(track => ({
      id: track.id,
      name: formatTrackDisplayName(assets, track),
    }));
    const installedTrackIds = new Set(assets.installedTracks.map(t => t.id.toLowerCase()));

    // Build Quick Race presets in fr3.exe's exact rotation order (QRACE_5 -> QRACE_6 -> QRACE_4 -> 1..3).
    const quickRaces: RaceSetup[] = assets.quickRaces
      .map(preset => {
        const player = preset.participants.find(p => p.control === "PLAYER_ACTIVE") ?? preset.participants[0];
        const opponents = preset.participants
          .filter(p => p !== player && this.carConfigs.has(p.carId))
          .map(p => p.carId);
        const carId = player && this.carConfigs.has(player.carId) ? player.carId : menuCars[0]!.id;
        const trackId = preset.trackId && installedTrackIds.has(preset.trackId.toLowerCase())
          ? preset.trackId
          : assets.defaultTrackId;
        return {
          trackId,
          carId,
          laps: Math.max(1, preset.laps || 2),
          difficulty: "MEDIUM" as const,
          mode: (preset.gameplayId === "RACING" ? "RACING" : "RACING_BOOST") as RaceMode,
          transmission: "AUTO" as const,
          opponentIds: opponents,
        };
      })
      .filter(p => this.carConfigs.has(p.carId));

    this.menu = new MenuController({
      cars: menuCars,
      trackId: assets.defaultTrackId,
      tracks: menuTracks,
      quickRaces,
      languages: assets.languages,
      input: this.input,
      createScene: (state, viewState) => this.buildScene(state, viewState),
    });

    this.previousTabIndex = canvas.getAttribute("tabindex");
    if (this.previousTabIndex === null) canvas.tabIndex = 0;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
  }

  async prepare(): Promise<void> {
    if (!this.assets.installedCars.length) throw new Error("No installed car models were found");
    this.setStatus("Loading interface graphics");
    await this.preloadCoreSprites();
    this.applySettings(this.menu.getView().settings);
    this.setStatus("Press any key or click to start");
  }

  start(): void {
    if (this.disposed || this.frame !== undefined || this.gl.gl.isContextLost()) return;
    this.input.attach(this.view, this.canvas);
    this.view.addEventListener("keydown", this.onTrackSelectKeyDown);
    this.canvas.focus();
    this.frame = this.view.requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.frame !== undefined) this.view.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.lastTime = undefined;
    this.fps = 0;
    this.view.removeEventListener("keydown", this.onTrackSelectKeyDown);
    this.input.detach();
  }

  restart(): void {
    this.resumeAfterError();
    if (this.activeRace) {
      this.menu.activate("restart");
      this.processCommands();
      return;
    }
    this.start();
  }

  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
  }

  continueFromStart(): void {
    this.resumeAfterError();
    const prev = this.menu.getView().state;
    this.menu.continueFromStart();
    this.processCommands();
    this.syncStatusForState(prev, this.menu.getView().state);
  }

  launchQuickRace(): void {
    this.resumeAfterError();
    if (this.menu.getView().state === "START") this.menu.continueFromStart();
    this.menu.activate("quick-race");
    this.processCommands();
  }

  launchCarRace(carId?: string): void {
    this.resumeAfterError();
    if (this.menu.getView().state === "START") this.menu.continueFromStart();
    if (carId && this.carConfigs.has(carId)) {
      const idx = this.assets.installedCars.findIndex(c => c.car.id === carId);
      if (idx >= 0) {
        if (this.menu.getView().state !== "CAR_SELECT") this.menu.activate("select-car");
        for (let i = 0; i < this.assets.installedCars.length; i++) {
          if (this.menu.getView().car?.id === carId) break;
          this.menu.activate("next-car");
        }
      }
    }
    if (this.menu.getView().state === "CAR_SELECT") this.menu.activate("launch");
    else this.menu.activate("quick-race");
    this.processCommands();
  }

  togglePause(): void {
    const st = this.menu.getView().state;
    if (st === "IN_GAME") {
      this.menu.update(0, {
        driving: { ...EMPTY_DRIVING, pausePressed: true },
        menu: { up: false, down: false, left: false, right: false, confirm: false, back: false, anyKey: false, pointerX: 0, pointerY: 0, pointerMoved: false, pointerClicked: false },
      });
      this.processCommands();
    } else if (st === "PAUSE") {
      this.menu.activate("resume");
      this.processCommands();
    }
  }

  cycleCamera(): void {
    this.activeRace?.camera.nextMode();
  }

  getSnapshot(): EngineSnapshot {
    const view = this.menu.getView();
    const race = this.activeRace;
    const player = race?.racers[0];
    const standing = race?.race.standings.find(s => s.isPlayer);
    return {
      status: this.status,
      fps: Math.round(this.fps),
      running: this.frame !== undefined,
      state: view.state,
      phase: race?.race.phase ?? null,
      trackId: race?.trackId ?? view.track?.id ?? null,
      carId: player?.carId ?? view.car?.id ?? null,
      livery: view.livery ?? null,
      speedMph: player?.physics.state.speedMph ?? 0,
      speedKph: player?.physics.state.speedKph ?? 0,
      gear: player?.physics.state.gear ?? 1,
      rpm: player?.physics.state.rpm ?? 0,
      lap: standing?.lap ?? 1,
      laps: race?.setup.laps ?? view.raceOptions.laps,
      position: standing?.place ?? 1,
      participants: race?.racers.length ?? 0,
      boostCharges: player?.physics.state.boostCharges ?? 0,
      boostActive: player?.physics.state.boostActive ?? false,
      cameraMode: race?.camera.mode ?? "CHASE_FAR",
      muted: this.audio.muted,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadRequestSeq++;
    this.turntableRequest++;
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.disarmErrorRecovery();
    if (this.previousTabIndex === null) this.canvas.removeAttribute("tabindex");
    for (const model of this.compiledModels.values()) model.dispose();
    this.compiledModels.clear();
    for (const model of this.trackModelCache.values()) model.dispose();
    this.trackModelCache.clear();
    this.trackSpatialCache.clear();
    this.turntableModel = undefined;
    this.activeRace = undefined;
    this.ui.dispose();
    this.scene.dispose();
    this.gl.dispose();
    void this.audio.dispose();
  }

  private setStatus(status: string): void {
    this.status = status;
    this.options.onStatus?.(status);
  }

  private syncStatusForState(prev: MenuState, next: MenuState): void {
    if (prev === next) return;
    const view = this.menu.getView();
    switch (next) {
      case "MAIN_MENU":
        this.setStatus("Main menu");
        break;
      case "CAR_SELECT":
        this.setStatus(view.car ? `Select Car: ${view.car.name}` : "Select Car");
        break;
      case "OPTIONS":
        this.setStatus("Options");
        break;
      case "PAUSE":
        this.setStatus("Paused");
        break;
      case "RACE_END":
      case "RESULTS":
        this.setStatus("Race finished");
        break;
      default:
        break;
    }
  }

  private readonly onTrackSelectKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed || this.menu.getView().state !== "CAR_SELECT") return;
    if (event.code === "BracketLeft" || event.code === "PageUp") {
      event.preventDefault();
      this.menu.activate("previous-track");
      this.processCommands();
    } else if (event.code === "BracketRight" || event.code === "PageDown") {
      event.preventDefault();
      this.menu.activate("next-track");
      this.processCommands();
    }
  };

  private readonly onContextLost = (): void => {
    this.loadRequestSeq++;
    this.stop();
    this.setStatus("WebGL2 context lost");
    this.options.onError?.(new Error("WebGL2 context lost. Press Restart to reload."));
  };

  private async preloadCoreSprites(): Promise<void> {
    const refs = [
      "GRAPHICS\\GAME\\STARTUS.PSD",
      "GRAPHICS\\GAME\\BKGNDS\\GAMEF.PSD",
      "GRAPHICS\\GAME\\BKGNDS\\FORD.PSD",
      "GRAPHICS\\GAME\\BKGNDS\\49.PSD",
      "GRAPHICS\\GAME\\COMMON\\PAUSE.PSD",
      "GRAPHICS\\GAME\\COMMON\\RES_TOP.PSD",
      "GRAPHICS\\GAME\\COMMON\\LAUREL.PSD",
      "GRAPHICS\\GAME\\COMMON\\CHEQFLAG.PSD",
      "GRAPHICS\\GAME\\COMMON\\FORDRACE.PSD",
      "GRAPHICS\\GAME\\COMMON\\TITLEBAR.PSD",
    ];
    await Promise.all(refs.map(ref => this.cachePcg(ref)));
  }

  private async cachePcg(texturePath: string): Promise<PcgEntry | null> {
    const key = texturePath.toLowerCase();
    if (this.pcgCache.has(key)) return this.pcgCache.get(key) ?? null;
    try {
      const entry = (await this.assets.getPcgEntry(texturePath)) ?? null;
      this.pcgCache.set(key, entry);
      return entry;
    } catch {
      this.pcgCache.set(key, null);
      return null;
    }
  }

  private async loadSharedAudioOnce(): Promise<void> {
    if (this.disposed) return;
    const ready = await this.audio.resume();
    if (!ready || this.disposed) return;
    if (!this.sharedAudioLoaded) {
      this.sharedAudioLoaded = true;
      try {
        const [tyresBank, miscBank, genBank] = await Promise.all([
          this.assets.loadSpc("SND/TYRES.SPC").catch(() => null),
          this.assets.loadSpc("SND/misc.spc").catch(() => null),
          this.loadGenEngineBank(),
        ]);
        if (this.disposed) return;
        const windEntry = genBank ? pickWindEntry(genBank.entries) : undefined;
        if (windEntry) {
          const buffer = await this.audio.decodeWave(windEntry.wave.riff);
          if (buffer && !this.disposed) {
            const smpl = windEntry.wave.smplLoops[0];
            this.audio.setWindSample({
              buffer,
              loop: smpl ? {
                loopStartFrame: smpl.startFrame,
                loopEndFrame: smpl.endFrameInclusive,
                sampleRate: windEntry.wave.format.sampleRate,
              } : undefined,
            });
          }
        }
        if (tyresBank && tyresBank.entries.length > 0) {
          const skidEntry = pickSkidEntry(tyresBank.entries);
          if (skidEntry) {
            const buffer = await this.audio.decodeWave(skidEntry.wave.riff);
            if (buffer && !this.disposed) {
              const smpl = skidEntry.wave.smplLoops[0];
              this.audio.setSkidSample({
                buffer,
                loop: smpl ? {
                  loopStartFrame: smpl.startFrame,
                  loopEndFrame: smpl.endFrameInclusive,
                  sampleRate: skidEntry.wave.format.sampleRate,
                } : undefined,
              });
            }
          }
        }
        if (miscBank && miscBank.entries.length > 0) {
          const collisionEntry = pickCollisionEntry(miscBank.entries);
          if (collisionEntry) {
            const buffer = await this.audio.decodeWave(collisionEntry.wave.riff);
            if (buffer && !this.disposed) this.audio.setEffectSample("collision", buffer);
          }
          const boostEntry = pickBoostEntry(miscBank.entries);
          if (boostEntry) {
            const buffer = await this.audio.decodeWave(boostEntry.wave.riff);
            if (buffer && !this.disposed) this.audio.setEffectSample("boost", buffer);
          }
        }
      } catch {
        // Keep procedural audio fallback active cleanly.
      }
    }
    const targetCar = this.activeRace?.racers[0]?.config ?? this.assets.installedCars[0];
    if (targetCar && !this.loadedEngineBankKey) {
      void this.loadEngineBankForCar(targetCar);
    }
  }

  /** Load SND/GEN_ENG.SPC once (shared turbo / supercharger / gearbox whine / wind samples). */
  private loadGenEngineBank(): Promise<SpcBank | null> {
    this.genEngineBank ??= this.assets.loadSpc(GEN_ENGINE_SPC_PATH).catch(() => null);
    return this.genEngineBank;
  }

  private async loadEngineBankForCar(cfg: ResolvedCarConfig): Promise<void> {
    if (this.disposed) return;
    const ready = await this.audio.resume();
    if (!ready || this.disposed) return;
    const { bankPath, record } = resolveCarEngineSound(cfg, this.assets.tables.engineSounds);
    const cacheKey = `${bankPath.toLowerCase()}::${record?.id.toLowerCase() ?? "default"}`;
    if (this.loadedEngineBankKey === cacheKey) return;
    const seq = ++this.engineBankRequestSeq;
    try {
      const engBank = await this.assets.loadSpc(bankPath).catch(() =>
        bankPath.toUpperCase() === "SND/ENGINE1.SPC"
          ? null
          : this.assets.loadSpc("SND/ENGINE1.SPC").catch(() => null),
      );
      if (this.disposed || seq !== this.engineBankRequestSeq || !engBank || engBank.entries.length === 0) return;

      const sampleMap = new Map<EngineLayerRole, { startRpm: number; maxVolume: number }>();
      if (record) {
        for (const s of record.samples) {
          const role = resolveEngineLayerRole(s.type, -1);
          if (role) sampleMap.set(role, { startRpm: s.startRpm, maxVolume: s.maxVolume });
        }
      }

      const layers: EngineLayer[] = [];
      for (let i = 0; i < engBank.entries.length; i++) {
        const e = engBank.entries[i]!;
        const role = resolveEngineLayerRole(e.name, i);
        if (!role) continue;
        const buffer = await this.audio.decodeWave(e.wave.riff);
        if (this.disposed || seq !== this.engineBankRequestSeq) return;
        if (!buffer) continue;
        const smpl = e.wave.smplLoops[0];
        const info = sampleMap.get(role);
        const referenceRpm = info && Number.isFinite(info.startRpm) && info.startRpm > 0
          ? info.startRpm
          : defaultReferenceRpmForRole(role);
        layers.push({
          role,
          buffer,
          referenceRpm,
          maxGain: info && Number.isFinite(info.maxVolume) ? clamp(info.maxVolume, 0, 1) : 1,
          loop: smpl ? {
            loopStartFrame: smpl.startFrame,
            loopEndFrame: smpl.endFrameInclusive,
            sampleRate: e.wave.format.sampleRate,
          } : undefined,
        });
      }
      if (layers.length > 0 && record) {
        const present = new Set(layers.map(l => l.role));
        const genBank = await this.loadGenEngineBank();
        if (this.disposed || seq !== this.engineBankRequestSeq) return;
        for (const { role, entry } of pickGenEngineAuxEntries(genBank?.entries ?? [], record, present)) {
          const buffer = await this.audio.decodeWave(entry.wave.riff);
          if (this.disposed || seq !== this.engineBankRequestSeq) return;
          if (!buffer) continue;
          const info = sampleMap.get(role);
          const smpl = entry.wave.smplLoops[0];
          layers.push({
            role,
            buffer,
            referenceRpm: info && Number.isFinite(info.startRpm) && info.startRpm > 0
              ? info.startRpm
              : defaultReferenceRpmForRole(role),
            maxGain: info && Number.isFinite(info.maxVolume) ? clamp(info.maxVolume, 0, 1) : 1,
            loop: smpl ? {
              loopStartFrame: smpl.startFrame,
              loopEndFrame: smpl.endFrameInclusive,
              sampleRate: entry.wave.format.sampleRate,
            } : undefined,
          });
        }
      }
      if (layers.length > 0 && !this.disposed && seq === this.engineBankRequestSeq) {
        this.audio.setEngineBank({
          layers,
          pitchMultiplier: record && Number.isFinite(record.pitchModifier) && record.pitchModifier > 0
            ? record.pitchModifier
            : 1,
        });
        this.loadedEngineBankKey = cacheKey;
      }
    } catch {
      // Keep procedural audio fallback active cleanly.
    }
  }

  private buildScene(state: MenuState, view: MenuView): MenuScene | undefined {
    const loadScript = (path: string) => UiScreenInstance.load(path, {
      readFile: this.assets.readUiScript,
      translation: this.assets.translation,
      viewport: { width: 640, height: 480 },
    });

    if (state === "START") {
      const screen = loadScript("UI/START.UI");
      const pressKey = lookupTranslation(this.assets.translation, "TXT_PRESS_ANY_KEY") ?? "PRESS ANY KEY";
      screen.setNodeTextRaw("BUTTON1", pressKey);
      screen.setNodeTextRaw("VERSION", "NATIVE WEBGL2 ENGINE");
      return { screen, actions: {} };
    }

    if (state === "MAIN_MENU") {
      const screen = loadScript("UI/GAMEF.UI");
      const labels: [string, string, MenuSceneAction][] = [
        ["BUTTON1", "TXT_MENU_BUTTON_QUICKRACE", "quick-race"],
        ["BUTTON2", "TXT_MENU_BUTTON_SINGLE_PLAYER", "select-car"],
        ["BUTTON3", "TXT_MENU_BUTTON_OPTIONS", "options"],
      ];
      const actions: Record<string, MenuSceneAction> = {};
      for (const id of ["BUTTON1", "BUTTON2", "BUTTON3", "BUTTON4", "BUTTON5", "BUTTON6", "BACK_ICON", "BACK_TEXT"]) {
        screen.setNodeVisible(id, false);
        screen.setNodeEnabled(id, false);
      }
      for (const [id, textKey, action] of labels) {
        screen.setNodeVisible(id, true);
        screen.setNodeEnabled(id, true);
        screen.setNodeText(id, textKey);
        actions[id] = action;
      }
      screen.setFocus("BUTTON1");
      return { screen, actions };
    }

    if (state === "PAUSE") {
      const screen = loadScript("UI/PAUSE.UI");
      for (const hide of ["EXITREPLAY", "RULES"]) {
        screen.setNodeVisible(hide, false);
        screen.setNodeEnabled(hide, false);
      }
      screen.setFocus("RESUME");
      return {
        screen,
        actions: {
          RESUME: "resume",
          RESTART: "restart",
          OPTIONS: "options",
          RETIRE: "quit",
          EXIT: "quit",
        },
      };
    }

    if (state === "OPTIONS") {
      const screen = loadScript("UI/OPTS.UI");
      for (const id of ["BUTTON1", "BUTTON2", "BUTTON3", "BUTTON4", "BUTTON5"]) {
        screen.setNodeVisible(id, false);
        screen.setNodeEnabled(id, false);
      }
      return { screen, actions: {} };
    }

    if (state === "CAR_SELECT") {
      const screen = loadScript("UI/CAR.UI");
      screen.setNodeTextRaw("CARNAME", view.car?.name ?? "");
      return {
        screen,
        actions: {},
        update: next => screen.setNodeTextRaw("CARNAME", next.car?.name ?? ""),
      };
    }

    if (state === "RESULTS" || state === "RACE_END") {
      const screen = loadScript("UI/RCRES.UI");
      return { screen, actions: {} };
    }

    return undefined;
  }

  private async getOrCompileModel(dir: string, livery?: string): Promise<CompiledModel> {
    const key = `${dir.toLowerCase()}::${(livery ?? "").toLowerCase()}`;
    const existing = this.compiledModels.get(key);
    if (existing && !existing.isDisposed) return existing;
    const bundle = await this.assets.load3dBundle(dir);
    const compiled = this.scene.compileModel(bundle.xbx, bundle.textures, bundle.binInfo, bundle.scene, { livery });
    this.compiledModels.set(key, compiled);
    return compiled;
  }

  private async loadTurntableCar(carId: string, livery?: string): Promise<void> {
    const cfg = this.carConfigs.get(carId);
    if (!cfg || this.disposed || this.gl.gl.isContextLost()) return;
    const key = `${cfg.shapeFolder}::${livery ?? ""}`;
    if (key === this.turntableKey && this.turntableModel && !this.turntableModel.isDisposed) return;
    const req = ++this.turntableRequest;
    this.setStatus(`Loading ${formatCarDisplayName(this.assets, cfg)}`);
    try {
      const model = await this.getOrCompileModel(cfg.shapeFolder, livery);
      if (req !== this.turntableRequest || this.disposed) return;
      if (cfg.car.liveries.length > 1) {
        // Cached by DemoAssets: inspect texture variants to hide no-op placeholder liveries.
        const bundle = await this.assets.load3dBundle(cfg.shapeFolder);
        if (req !== this.turntableRequest || this.disposed) return;
        const liveries = dedupeCarLiveries(cfg.car.liveries, hasLiveryTextureVariants(bundle.textures.textures));
        this.menu.setCarLiveries(carId, liveries);
      }
      this.turntableModel = model;
      this.turntableKey = key;
      this.setStatus(`Select Car: ${formatCarDisplayName(this.assets, cfg)}`);
    } catch (cause) {
      if (req === this.turntableRequest) this.options.onError?.(asError(cause));
    }
  }

  private applySettings(settings: Readonly<MenuSettings>): void {
    this.audio.setVolume("master", settings.masterVolume);
    this.audio.setVolume("sfx", settings.sfxVolume);
    this.audio.setVolume("engine", settings.engineVolume);
    if (settings.language !== this.assets.language && this.assets.languages.includes(settings.language)) {
      this.assets.setLanguage(settings.language);
      this.menu.rebuildScene();
    }
    if (this.activeRace) {
      this.activeRace.racers[0]!.physics.automatic = settings.transmission === "AUTO";
    }
  }

  private processCommands(): void {
    const commands = this.menu.drainCommands();
    for (const cmd of commands) {
      this.handleCommand(cmd);
    }
  }

  private handleCommand(cmd: MenuCommand): void {
    switch (cmd.type) {
      case "PlayUiSound":
        void this.loadSharedAudioOnce();
        this.audio.playMenu(cmd.sound === "move" ? "navigate" : cmd.sound);
        break;
      case "SettingsChanged":
        this.applySettings(cmd.settings);
        break;
      case "TurntableCarRequest":
        void this.loadTurntableCar(cmd.carId, cmd.livery);
        break;
      case "LaunchRaceRequest":
      case "RestartRace":
        void this.loadRace(cmd.requestId, cmd.setup);
        break;
      case "ResumeRace":
        this.setStatus(formatRacingStatus(
          this.activeRace?.racers[0]?.carName,
          this.activeRace?.trackName ?? this.assets.defaultTrackId,
        ));
        break;
      case "CycleCamera":
        this.activeRace?.camera.nextMode();
        break;
      case "QuitToMenu":
        this.activeRace = undefined;
        this.audio.update({ rpm: 0, speedMps: 0, tyreSlip: 0 });
        this.setStatus("Main menu");
        break;
    }
  }

  private async loadRace(requestId: number, setup: RaceSetup): Promise<void> {
    const seq = ++this.loadRequestSeq;
    const trackId = setup.trackId || this.assets.defaultTrackId;
    const trackKey = trackId.toLowerCase();
    const trackRecord = this.assets.tables.tracks.get(trackKey);
    const trackName = trackRecord ? formatTrackDisplayName(this.assets, trackRecord) : trackId;
    this.setStatus(`Loading ${trackName} track and cars...`);
    this.menu.setLoadProgress(requestId, 0.08);
    try {
      const [trackBundle, trackData] = await Promise.all([
        this.assets.load3dBundle(trackDirectory(trackId)),
        this.assets.loadTrackData(trackId),
      ]);
      if (seq !== this.loadRequestSeq || this.disposed) return;
      this.menu.setLoadProgress(requestId, 0.35);

      let trackModel = this.trackModelCache.get(trackKey);
      if (!trackModel || trackModel.isDisposed) {
        trackModel = this.scene.compileModel(
          trackBundle.xbx, trackBundle.textures, trackBundle.binInfo, trackBundle.scene,
        );
        this.trackModelCache.set(trackKey, trackModel);
      }
      let spatial = this.trackSpatialCache.get(trackKey);
      if (!spatial) {
        const defaultSurfaceName = trackRecord?.DEFAULT_TRACK_SURFACE;
        spatial = new TrackSpatial(
          trackBundle.xbx, trackBundle.scene, trackData.racingLine,
          { surfaces: this.assets.tables.surfaces, defaultSurfaceName },
        );
        this.trackSpatialCache.set(trackKey, spatial);
      }
      this.menu.setLoadProgress(requestId, 0.52);

      const playerCfg = this.carConfigs.get(setup.carId) ?? this.assets.installedCars[0]!;
      const opponentPool = (setup.opponentIds ?? []).filter(id => this.carConfigs.has(id));
      const fallbackPool = this.assets.installedCars
        .map(c => c.car.id)
        .filter(id => id !== playerCfg.car.id);
      const opponentIds: string[] = [];
      for (const id of [...opponentPool, ...fallbackPool]) {
        if (opponentIds.length >= 5) break;
        opponentIds.push(id);
      }

      const lineupCfgs = [playerCfg, ...opponentIds.map(id => this.carConfigs.get(id)!)];
      const models: CompiledModel[] = [];
      for (let i = 0; i < lineupCfgs.length; i++) {
        const cfg = lineupCfgs[i]!;
        const livery = i === 0
          ? (setup.livery ?? cfg.car.liveries[0]?.type)
          : cfg.car.liveries[i % Math.max(1, cfg.car.liveries.length)]?.type;
        models.push(await this.getOrCompileModel(cfg.shapeFolder, livery));
        if (seq !== this.loadRequestSeq || this.disposed) return;
        this.menu.setLoadProgress(requestId, 0.52 + ((i + 1) / lineupCfgs.length) * 0.42);
      }

      const racingLine = trackData.racingLine;
      const ground = (x: number, z: number) => {
        const p = spatial.queryProgress(x, z);
        const h = spatial.queryGround(x, p.point[1] + 4, z);
        return h.hit ? h.height : p.point[1];
      };

      const entrants = lineupCfgs.map((cfg, index) => ({
        id: index === 0 ? "player" : `ai-${index}`,
        carId: cfg.car.id,
        isPlayer: index === 0,
      }));
      const race = new RaceManager({
        line: racingLine,
        entrants,
        laps: setup.laps,
        mode: setup.mode,
        ground,
        startU: 0.02,
        introSeconds: 1.4,
      });

      const difficulty = this.assets.tables.game.difficulty[setup.difficulty];
      const trackScales = resolveTrackDifficultyScales(trackRecord?.difficulty[setup.difficulty]);
      const automatic = setup.transmission === "AUTO";

      const racers: RacerSlot[] = lineupCfgs.map((cfg, index) => {
        const gridSlot = race.grid[index]!;
        const yaw = Math.atan2(gridSlot.forward[0], gridSlot.forward[2]);
        const physics = new VehiclePhysics(cfg, spatial, {
          position: [gridSlot.position[0], gridSlot.position[1] + 0.05, gridSlot.position[2]],
          yaw,
          automatic: index === 0 ? automatic : true,
        });
        const packSlot = ((index - 1) / 4) * 2 - 1;
        return {
          id: entrants[index]!.id,
          carId: cfg.car.id,
          carName: formatCarDisplayName(this.assets, cfg),
          isPlayer: index === 0,
          config: cfg,
          physics,
          ai: index === 0 ? undefined : new AiDriver(racingLine, {
            difficulty,
            trackScales,
            packSlot,
            mode: setup.mode,
          }),
          model: models[index]!,
          lastGear: physics.state.gear,
          lastLap: 1,
          lastBoostActive: false,
          lowSpeedTimer: 0,
          flippedTimer: 0,
        };
      });

      const presets: Partial<Record<CameraMode, ReturnType<typeof cameraPresetFromDefinition>>> = {};
      const camDefs = this.assets.tables.cameras;
      if (camDefs[0]) presets.INTRO = cameraPresetFromDefinition("INTRO", camDefs[0]);
      if (camDefs[7]) presets.CHASE_FAR = cameraPresetFromDefinition("CHASE_FAR", camDefs[7]);
      if (camDefs[8]) presets.CHASE_NEAR = cameraPresetFromDefinition("CHASE_NEAR", camDefs[8]);
      if (camDefs[9]) presets.HOOD = cameraPresetFromDefinition("HOOD", camDefs[9]);
      if (camDefs[5]) presets.LOOK_BACK = cameraPresetFromDefinition("LOOK_BACK", camDefs[5]);
      const camera = new CameraController({ ground, presets });
      const ps = racers[0]!.physics.state;
      const gl = this.gl.gl;
      const aspect = gl.drawingBufferHeight > 0 ? gl.drawingBufferWidth / gl.drawingBufferHeight : 16 / 9;
      const cameraView = camera.update(0, {
        car: { position: ps.position, forward: ps.forward, rotation: ps.orientation, speed: ps.speedMps },
        aspect,
        phase: race.phase,
        phaseElapsed: race.phaseElapsed,
      });
      const courseMap = racingLine.points.map(pt => ({ x: pt.position[0], z: pt.position[2] }));

      this.activeRace = {
        setup: { ...setup, trackId },
        trackId,
        trackName,
        trackData,
        trackModel,
        spatial,
        race,
        racers,
        camera,
        cameraView,
        courseMap,
        finishHoldTimer: 0,
        finishedReported: false,
      };
      this.menu.setLoadProgress(requestId, 1);
      this.menu.completeLoad(requestId);
      void this.loadSharedAudioOnce();
      void this.loadEngineBankForCar(playerCfg);
      this.setStatus(formatRacingStatus(formatCarDisplayName(this.assets, playerCfg), trackName));
    } catch (cause) {
      if (seq !== this.loadRequestSeq) return;
      const err = asError(cause);
      this.menu.failLoad(requestId, err.message);
      this.setStatus(`Load failed: ${err.message}`);
      this.options.onError?.(err);
    }
  }

  private readonly tick = (now: number): void => {
    const elapsed = this.lastTime === undefined ? 0 : (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (elapsed > 0) this.fps += (1 / elapsed - this.fps) * Math.min(elapsed * 6, 1);
    const dt = Math.min(elapsed, 0.05);
    this.clock += dt;

    try {
      const frame = this.input.poll(dt);
      const stateBefore = this.menu.getView().state;

      if (frame.menu.anyKey || frame.menu.pointerClicked) {
        void this.loadSharedAudioOnce();
      }

      if (stateBefore === "IN_GAME" && this.activeRace) {
        if (frame.driving.pausePressed) {
          this.menu.update(dt, frame);
          this.processCommands();
          this.audio.update({ rpm: 0, speedMps: 0, tyreSlip: 0 });
        } else {
          this.stepRace(dt, frame.driving);
        }
      } else {
        this.stepMenu(dt, frame);
      }

      this.syncStatusForState(stateBefore, this.menu.getView().state);
      this.render();
      this.tickErrors.success();
    } catch (cause) {
      const contextLost = this.gl.gl.isContextLost();
      const { report, halt } = this.tickErrors.failure(contextLost);
      if (report) this.options.onError?.(asError(cause));
      if (halt) {
        this.stop();
        this.setStatus(contextLost ? "WebGL2 context lost" : "Engine error - click or press a key to retry");
        if (!contextLost) this.armErrorRecovery();
        return;
      }
    }

    if (this.frame !== undefined) this.frame = this.view.requestAnimationFrame(this.tick);
  };

  /** After a halt on repeated non-fatal errors, resume on the next pointer or key gesture. */
  private armErrorRecovery(): void {
    if (this.errorRecoveryArmed || this.disposed) return;
    this.errorRecoveryArmed = true;
    this.view.addEventListener("keydown", this.onErrorRecoveryGesture);
    this.canvas.addEventListener("pointerdown", this.onErrorRecoveryGesture);
  }

  private disarmErrorRecovery(): void {
    if (!this.errorRecoveryArmed) return;
    this.errorRecoveryArmed = false;
    this.view.removeEventListener("keydown", this.onErrorRecoveryGesture);
    this.canvas.removeEventListener("pointerdown", this.onErrorRecoveryGesture);
  }

  private readonly onErrorRecoveryGesture = (): void => {
    this.resumeAfterError();
  };

  /** Restart a loop halted by non-fatal frame errors (no-op while running, disposed or context-lost). */
  private resumeAfterError(): void {
    if (!this.tickErrors.isHalted || this.disposed || this.gl.gl.isContextLost()) return;
    this.disarmErrorRecovery();
    this.tickErrors.recover();
    this.setStatus("Recovered from engine error");
    this.start();
  }

  private stepMenu(dt: number, frame: InputFrame): void {
    const view = this.menu.getView();
    if (view.state === "CAR_SELECT") {
      this.turntableAngle = (this.turntableAngle + dt * 0.6) % (2 * Math.PI);
    }

    const gl = this.gl.gl;
    const [uiPointerX, uiPointerY] = canvasToUiPoint(
      frame.menu.pointerX,
      frame.menu.pointerY,
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
    );
    const uiFrame: InputFrame = {
      driving: frame.driving,
      menu: { ...frame.menu, pointerX: uiPointerX, pointerY: uiPointerY },
    };

    if (uiFrame.menu.pointerClicked && this.overlayButtons.length > 0) {
      const px = uiFrame.menu.pointerX;
      const py = uiFrame.menu.pointerY;
      for (const btn of this.overlayButtons) {
        if (px >= btn.rect.x && px <= btn.rect.x + btn.rect.width && py >= btn.rect.y && py <= btn.rect.y + btn.rect.height) {
          btn.onClick();
          this.audio.playMenu("confirm");
          this.processCommands();
          return;
        }
      }
    }

    if (view.state === "CAR_SELECT") {
      if (uiFrame.menu.left) this.menu.activate("previous-car");
      else if (uiFrame.menu.right) this.menu.activate("next-car");
      else if (uiFrame.menu.up) this.menu.activate("previous-livery");
      else if (uiFrame.menu.down) this.menu.activate("next-livery");
      else if (uiFrame.menu.confirm) this.menu.activate("launch");
      else if (uiFrame.menu.back) this.menu.activate("back");
      this.processCommands();
      return;
    }

    if (view.state === "OPTIONS") {
      if (uiFrame.menu.back) {
        this.menu.activate("back");
        this.processCommands();
      }
      return;
    }

    if (view.state === "RESULTS" || view.state === "RACE_END") {
      if (uiFrame.menu.confirm) this.menu.activate("restart");
      // Esc follows MenuController.back(): RACE_END -> RESULTS, RESULTS -> main menu.
      else if (uiFrame.menu.back) this.menu.activate("back");
      this.processCommands();
      return;
    }

    this.menu.update(dt, uiFrame);
    this.processCommands();
  }

  private stepRace(dt: number, driving: DrivingInput): void {
    const active = this.activeRace;
    if (!active) return;

    const mobile = active.race.canMove;
    const playerSlot = active.racers[0]!;
    const racingLine = active.trackData.racingLine;
    const playerStand = active.race.standings.find(s => s.isPlayer);
    const playerProgressTotal = playerStand?.progress ?? 0;

    const lineLateralOffset = (p: ReturnType<TrackSpatial["queryProgress"]>): number => {
      const pt = racingLine.points[p.segmentIndex];
      if (!pt) return p.lateralOffset;
      const align = pt.lateral[0] * p.right[0] + pt.lateral[2] * p.right[2];
      return align < 0 ? -p.lateralOffset : p.lateralOffset;
    };

    const tracks = active.racers.map(r => {
      const p = active.spatial.queryProgress(r.physics.state.position[0], r.physics.state.position[2]);
      return { u: p.interpolant, lateralOffset: lineLateralOffset(p), speed: r.physics.state.speedMps };
    });

    const observations: RaceObservation[] = [];

    for (let i = 0; i < active.racers.length; i++) {
      const r = active.racers[i]!;
      const tr = tracks[i]!;
      const st = r.physics.state;
      const standing = active.race.standings.find(s => s.id === r.id);

      let ctrl: DrivingInput;
      if (!mobile) {
        ctrl = {
          ...EMPTY_DRIVING,
          throttle: r.isPlayer ? driving.throttle : 0.45,
          brake: 1,
          handbrake: true,
        };
      } else if (r.isPlayer && active.race.phase !== "FINISHED") {
        ctrl = driving;
      } else {
        if (!r.isPlayer) {
          const flipped = updateAiFlippedTimer(r.flippedTimer, st.up[1], dt);
          r.flippedTimer = flipped.timer;
          if (flipped.shouldReset) {
            r.physics.resetToTrack();
            r.lowSpeedTimer = 0;
          }
          if (active.race.phase === "RACING" && active.race.phaseElapsed > 1.0 && st.speedMps < 1.5) {
            r.lowSpeedTimer += dt;
          } else if (st.speedMps >= 2.0) {
            r.lowSpeedTimer = 0;
          }
        }
        const curState = r.physics.state;
        const ai = r.ai ?? (r.ai = new AiDriver(racingLine, {
          difficulty: this.assets.tables.game.difficulty[active.setup.difficulty],
          trackScales: resolveTrackDifficultyScales(this.assets.tables.tracks.get(active.trackId.toLowerCase())?.difficulty[active.setup.difficulty]),
          mode: active.setup.mode,
        }));
        const obstacles: AiObstacle[] = tracks
          .filter((_, idx) => idx !== i)
          .map(o => ({ u: o.u, lateralOffset: o.lateralOffset, speed: o.speed }));
        const referenceGap = ((standing?.progress ?? 0) - playerProgressTotal) * racingLine.length;
        const aiOut = ai.update(dt, {
          car: {
            position: curState.position,
            forward: curState.forward,
            rotation: curState.orientation,
            speed: curState.speedMps,
            blocked: isAiCarBlocked(curState.lastImpactImpulse, curState.speedMps, r.lowSpeedTimer),
          },
          track: { u: tr.u, lateralOffset: tr.lateralOffset },
          obstacles,
          referenceGap,
          boostCharges: curState.boostCharges,
          boostActive: curState.boostActive,
        });
        let finalOut: CarControlOutput = aiOut;
        if (r.isPlayer) {
          finalOut = active.race.finishControl({
            throttle: driving.throttle,
            brake: driving.brake,
            steer: driving.steer,
            handbrake: driving.handbrake,
            boost: false,
            powerMultiplier: 1,
            driveDirection: 1,
          }, aiOut);
        }
        ctrl = aiControlToDrivingInput(finalOut, curState);
      }

      r.physics.step(dt, ctrl);

      if (!mobile) {
        const gridSlot = active.race.grid[i]!;
        r.physics.setPose(
          [gridSlot.position[0], gridSlot.position[1] + 0.05, gridSlot.position[2]],
          Math.atan2(gridSlot.forward[0], gridSlot.forward[2]),
        );
      }

      const after = r.physics.state;
      const prog = active.spatial.queryProgress(after.position[0], after.position[2]);
      observations.push({
        id: r.id,
        car: { position: after.position, forward: after.forward, rotation: after.orientation, speed: after.speedMps },
        track: { u: prog.interpolant, lateralOffset: lineLateralOffset(prog) },
      });
    }

    if (mobile) {
      for (let a = 0; a < active.racers.length; a++) {
        for (let b = a + 1; b < active.racers.length; b++) {
          const impulse = resolveCarCollision(active.racers[a]!.physics, active.racers[b]!.physics);
          if (impulse > 150 && (a === 0 || b === 0)) {
            this.audio.playCollision(impulse);
          }
        }
      }
    }

    active.race.update(dt, observations);

    const step = countdownLabelToStep(active.race.countdownLabel);
    if (step !== active.lastCountdown && step !== undefined) {
      active.lastCountdown = step;
      this.audio.playCountdown(step);
    }

    for (const s of active.race.standings) {
      const slot = active.racers.find(r => r.id === s.id);
      if (slot && s.lap > slot.lastLap) {
        slot.lastLap = s.lap;
        if (active.setup.mode === "RACING_BOOST") {
          slot.physics.replenishBoost(s.completedLaps, active.setup.laps);
        }
      }
    }

    const ps = playerSlot.physics.state;
    if (ps.gear !== playerSlot.lastGear && mobile) {
      this.audio.playGearShift();
    }
    playerSlot.lastGear = ps.gear;
    if (ps.boostActive && !playerSlot.lastBoostActive) {
      this.audio.playBoost();
    }
    playerSlot.lastBoostActive = ps.boostActive;
    if (ps.lastImpactImpulse > 150) {
      this.audio.playCollision(ps.lastImpactImpulse);
    }

    const maxSlip = Math.max(...ps.wheels.map(w => Math.abs(w.slipRatio) + Math.abs(w.slipAngle) * 0.6));
    const surface = surfaceToTyreSurface(ps.wheels.find(w => w.grounded)?.surfaceName ?? "tarmac");
    this.audio.update({
      rpm: ps.rpm,
      idleRpm: playerSlot.config.engine.fields.TICKOVER_RPM ?? 1000,
      redlineRpm: ps.redlineRpm,
      throttle: ps.throttle,
      speedMps: ps.speedMps,
      tyreSlip: mobile ? clamp((maxSlip - 0.18) * 1.4, 0, 1) : 0,
      surface,
    });

    const gl = this.gl.gl;
    const aspect = gl.drawingBufferHeight > 0 ? gl.drawingBufferWidth / gl.drawingBufferHeight : 16 / 9;
    active.cameraView = active.camera.update(dt, {
      car: { position: ps.position, forward: ps.forward, rotation: ps.orientation, speed: ps.speedMps },
      aspect,
      phase: active.race.phase,
      phaseElapsed: active.race.phaseElapsed,
      cameraNextPressed: driving.cameraNextPressed,
      lookBack: driving.lookBack,
    });

    if (active.race.phase === "FINISHED" && !active.finishedReported) {
      active.finishHoldTimer += dt;
      if (active.finishHoldTimer >= 2.2) {
        active.finishedReported = true;
        const standings = active.race.standings;
        const resultRows = buildRaceResultRows(standings, active.setup.laps, (_carId, i) => {
          const s = standings[i]!;
          return active.racers.find(r => r.id === s.id)?.carName ?? s.carId;
        });
        this.menu.finishRace(resultRows);
        this.audio.update({ rpm: 0, speedMps: 0, tyreSlip: 0 });
        this.setStatus("Race finished");
      }
    }
  }

  private render(): void {
    const gl = this.gl.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (!width || !height || gl.isContextLost()) return;

    const view = this.menu.getView();
    const inRaceRender = this.activeRace !== undefined
      && (view.state === "IN_GAME" || view.state === "PAUSE" || view.state === "RESULTS" || view.state === "RACE_END");

    if (inRaceRender && this.activeRace) {
      this.renderRace3d(this.activeRace, width, height);
    } else {
      gl.viewport(0, 0, width, height);
      gl.clearColor(0.03, 0.05, 0.08, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    if (view.state === "IN_GAME" && this.activeRace) {
      this.renderRaceHud(this.activeRace, view.settings, width, height);
      return;
    }

    this.renderMenuUi(view, width, height);
  }

  private renderRace3d(active: ActiveRace, width: number, height: number): void {
    const camView = active.cameraView;
    const carInstances: CarInstance[] = [];
    for (let i = 0; i < active.racers.length; i++) {
      const r = active.racers[i]!;
      if (i === 0 && !camView.showPlayerCar) continue;
      const st = r.physics.state;
      const ground = active.spatial.queryGround(st.position[0], st.position[1] + 1.5, st.position[2]);
      const avgSpin = (st.wheels[0].spinAngle + st.wheels[1].spinAngle + st.wheels[2].spinAngle + st.wheels[3].spinAngle) * 0.25;
      const avgAngVel = Math.max(...st.wheels.map(w => Math.abs(w.angularVel)));
      carInstances.push({
        model: r.model,
        transform: mat4FromQuatTranslation(st.orientation, st.position),
        wheelSpeed: avgAngVel,
        wheelSpin: avgSpin,
        steeringAngle: st.steerAngleRad,
        headlights: (active.trackData.trackConfig.CAR_HEADLIGHT_STRENGTH ?? 0) > 0.1,
        braking: st.brake > 0.1,
        reversing: st.gear < 0,
        exhaust: st.boostActive,
        groundY: ground.hit ? ground.height : st.position[1] - 0.3,
      });
    }
    this.scene.renderScene(
      camView.viewMatrix,
      camView.projMatrix,
      active.trackModel,
      carInstances,
      active.trackData.fog ?? undefined,
      { x: 0, y: 0, width, height },
    );
  }

  private renderRaceHud(active: ActiveRace, settings: Readonly<MenuSettings>, width: number, height: number): void {
    const player = active.racers[0]!;
    const ps = player.physics.state;
    const standings = active.race.standings;
    const playerStanding = standings.find(s => s.isPlayer) ?? standings[0]!;

    const hudState: HudState = {
      speedMps: ps.speedMps,
      speedUnit: settings.speedUnits,
      rpm: ps.rpm,
      redlineRpm: ps.redlineRpm,
      gear: ps.gear,
      boost: ps.boostActive ? ps.boostTimer / 7 : 0,
      boostCharges: ps.boostCharges,
      maxBoostCharges: 2,
      position: playerStanding.place,
      participants: active.racers.length,
      lap: playerStanding.lap,
      laps: active.setup.laps,
      lapTime: playerStanding.lapTime,
      bestTime: playerStanding.bestLapTime ?? undefined,
      totalTime: active.race.elapsedRaceTime,
      countdown: countdownLabelToStep(active.race.countdownLabel),
      wrongWay: playerStanding.wrongWay,
      map: {
        course: active.courseMap,
        player: { x: ps.position[0], z: ps.position[2] },
        opponents: active.racers.slice(1).map(r => ({ x: r.physics.state.position[0], z: r.physics.state.position[2] })),
      },
    };

    const bodyFont = this.assets.fonts[2] ?? this.assets.fonts[0]!;
    const displayFont = this.assets.fonts[4] ?? this.assets.fonts[0]!;
    this.ui.renderHud(hudState, width, height, { body: bodyFont, display: displayFont });
  }

  private renderMenuUi(view: MenuView, width: number, height: number): void {
    const vp = computeUiViewport(width, height);
    const batch = new UiBatchBuilder(vp.width || width, vp.height || height);
    const fonts = this.assets.fonts;
    const fontFor = (slot: number) => fonts[slot] ?? fonts[2] ?? fonts[0]!;
    this.overlayButtons = [];

    if (view.state === "PAUSE" || view.state === "RESULTS" || view.state === "RACE_END") {
      batch.solidQuad({ x: 0, y: 0, width: 1, height: 1 }, PANEL_SCRIM);
    }

    const activeScreen = this.menu.screen;
    if (activeScreen) {
      const items = activeScreen.getDrawItems();
      for (const item of items) {
        if (item.textureRef) {
          const entry = this.pcgCache.get(item.textureRef.registeredKey)
            ?? this.pcgCache.get(item.textureRef.registeredKey.replaceAll("/", "\\"));
          if (entry) {
            batch.graphic(item.rect, entry, {
              colour: normalizeRgba(item.color),
              flipGraphic: item.flip,
            });
          } else {
            void this.cachePcg(item.textureRef.registeredKey);
          }
        }
        if (item.text) {
          const font = fontFor(item.font);
          let color = normalizeRgba(item.textColor);
          if (view.state === "START" && item.id === "BUTTON1") {
            const pulse = 0.55 + 0.45 * Math.sin(this.clock * 4);
            color = [color[0], color[1], color[2], color[3] * pulse];
          }
          if (item.highlighted && item.buttonId && view.state !== "START") {
            batch.solidQuad(
              { x: item.rect.x, y: item.rect.y, width: Math.min(item.rect.width, 1 - item.rect.x), height: item.rect.height },
              [0.08, 0.22, 0.34, 0.72],
            );
          }
          const textX = item.rect.x + item.justifyOffset[0];
          const maxWidthNorm = !item.wordWrap && textX >= 0 && textX < 0.985
            ? Math.min(item.rect.width, Math.max(0.05, 0.985 - textX))
            : item.rect.width;
          const fittedScale = item.wordWrap
            ? 1
            : fitTextScale(font.font, item.text, maxWidthNorm * 640, 1);
          batch.text(
            {
              x: textX,
              y: item.rect.y + item.justifyOffset[1],
              width: item.textJustify % 3 === 1 ? maxWidthNorm : item.rect.width,
              height: item.rect.height,
            },
            font,
            item.text,
            {
              justify: item.textJustify,
              wordWrap: item.wordWrap,
              colour: color,
              scale: fittedScale,
              shadow: true,
            },
          );
        }
      }
    }

    if (view.state === "CAR_SELECT") {
      this.ui.render(batch.build(), width, height);
      batch.clear();
      if (this.turntableModel && !this.turntableModel.isDisposed) {
        const turntableCanvasRect: ViewportRect = {
          x: (vp.x + TURNTABLE_RECT.x * vp.width) / width,
          y: (vp.y + TURNTABLE_RECT.y * vp.height) / height,
          width: (TURNTABLE_RECT.width * vp.width) / width,
          height: (TURNTABLE_RECT.height * vp.height) / height,
        };
        this.scene.renderCarTurntable(this.turntableModel, this.turntableAngle, turntableCanvasRect, width, height);
      }
      this.drawCarSelectOverlay(batch, view);
    } else if (view.state === "OPTIONS") {
      this.drawOptionsOverlay(batch, view);
    } else if (view.state === "LOADING") {
      this.drawLoadingOverlay(batch, view);
    } else if (view.state === "RESULTS" || view.state === "RACE_END") {
      this.drawResultsOverlay(batch, view);
    }

    this.ui.render(batch.build(), width, height);
  }

  private addButton(
    batch: UiBatchBuilder,
    rect: ViewportRect,
    label: string,
    onClick: () => void,
    scale: number,
    accent = false,
    /** Shorter fallbacks; when given, the label keeps a readable minimum scale and truncates with "...". */
    fallbackLabels?: readonly string[],
  ): void {
    const font = this.assets.fonts[2] ?? this.assets.fonts[0]!;
    const maxWidthPx = Math.max(8, (rect.width - 0.012) * 640);
    let fittedScale: number;
    let shown = label;
    if (fallbackLabels) {
      const fitted = fitTextWithEllipsis(font.font, [label, ...fallbackLabels], maxWidthPx, scale, READABLE_MIN_TEXT_SCALE);
      shown = fitted.text;
      fittedScale = fitted.scale;
    } else {
      fittedScale = fitTextScale(font.font, label, maxWidthPx, scale);
    }
    batch.solidQuad(rect, accent ? [0.14, 0.46, 0.34, 0.94] : [0.08, 0.15, 0.22, 0.92]);
    batch.text(rect, font, shown, {
      justify: 0,
      colour: accent ? ACCENT : INK,
      scale: fittedScale,
      shadow: true,
    });
    this.overlayButtons.push({ rect, label, active: accent, onClick });
  }

  private drawCarSelectOverlay(batch: UiBatchBuilder, view: MenuView): void {
    const fTitle = this.assets.fonts[3] ?? this.assets.fonts[0]!;
    const fBody = this.assets.fonts[2] ?? this.assets.fonts[0]!;
    const s = 0.78;

    batch.solidQuad({ x: 0, y: 0, width: 1, height: 0.11 }, PANEL_DARK);
    const carTitle = view.car?.name ?? "SELECT CAR";
    batch.text({ x: 0.03, y: 0.02, width: 0.37, height: 0.07 }, fTitle, carTitle, {
      justify: 1, colour: ACCENT, scale: fitTextScale(fTitle.font, carTitle, 0.37 * 640, s * 1.15),
    });
    const trackName = view.track?.name ?? this.assets.defaultTrackId;
    const trackLabels = view.track
      ? [`TRACK: ${view.track.name} (${view.track.id})`, `TRACK: ${view.track.name}`, view.track.name]
      : [`TRACK: ${trackName}`, trackName];
    this.addButton(batch, { x: 0.41, y: 0.02, width: 0.05, height: 0.07 }, "<", () => {
      this.menu.activate("previous-track");
    }, s * 0.85);
    this.addButton(batch, { x: 0.465, y: 0.02, width: 0.445, height: 0.07 }, trackLabels[0]!, () => {
      this.menu.activate("next-track");
    }, s * 0.8, false, trackLabels.slice(1));
    this.addButton(batch, { x: 0.915, y: 0.02, width: 0.05, height: 0.07 }, ">", () => {
      this.menu.activate("next-track");
    }, s * 0.85);

    const px = 0.63;
    const pw = 0.33;
    batch.solidQuad({ x: px, y: 0.15, width: pw, height: 0.68 }, PANEL_CARD);
    const ratings = view.car?.ratings ?? { speed: 0.5, power: 0.5, acceleration: 0.5, handling: 0.5 };
    const statRows: [string, number][] = [
      ["TOP SPEED", ratings.speed],
      ["POWER", ratings.power],
      ["ACCEL", ratings.acceleration],
      ["HANDLING", ratings.handling],
    ];
    statRows.forEach(([label, val], idx) => {
      const y = 0.18 + idx * 0.075;
      batch.text({ x: px + 0.02, y, width: pw - 0.04, height: 0.03 }, fBody, label, {
        justify: 1, colour: MUTED, scale: s * 0.8,
      });
      batch.solidQuad({ x: px + 0.02, y: y + 0.032, width: pw - 0.04, height: 0.022 }, BAR_BG);
      batch.solidQuad({ x: px + 0.02, y: y + 0.032, width: (pw - 0.04) * clamp(val, 0.05, 1), height: 0.022 }, CYAN);
    });

    const { difficulty, laps, mode } = view.raceOptions;
    const tx = view.settings.transmission;
    this.addButton(batch, { x: px + 0.02, y: 0.50, width: pw - 0.04, height: 0.055 }, `MODE: ${mode.replace("_", " ")}`, () => {
      const next = RACE_MODES[(RACE_MODES.indexOf(mode) + 1) % RACE_MODES.length]!;
      this.menu.updateRaceOptions({ mode: next });
    }, s * 0.85);
    this.addButton(batch, { x: px + 0.02, y: 0.565, width: pw - 0.04, height: 0.055 }, `DIFFICULTY: ${difficulty}`, () => {
      const next = DIFFICULTIES[(DIFFICULTIES.indexOf(difficulty) + 1) % DIFFICULTIES.length]!;
      this.menu.updateRaceOptions({ difficulty: next });
    }, s * 0.85);
    this.addButton(batch, { x: px + 0.02, y: 0.63, width: pw - 0.04, height: 0.055 }, `LAPS: ${laps}`, () => {
      this.menu.updateRaceOptions({ laps: laps >= 9 ? 1 : laps + 1 });
    }, s * 0.85);
    this.addButton(batch, { x: px + 0.02, y: 0.695, width: pw - 0.04, height: 0.055 }, `GEARS: ${tx}`, () => {
      this.menu.updateSettings({ transmission: tx === "AUTO" ? "MANUAL" : "AUTO" });
    }, s * 0.85);
    this.addButton(batch, { x: px + 0.02, y: 0.76, width: pw - 0.04, height: 0.055 }, `LIVERY: ${view.livery ?? "DEFAULT"}`, () => {
      this.menu.activate("next-livery");
    }, s * 0.85);

    this.addButton(batch, { x: 0.04, y: 0.86, width: 0.14, height: 0.08 }, "< PREV CAR", () => this.menu.activate("previous-car"), s * 0.9);
    this.addButton(batch, { x: 0.20, y: 0.86, width: 0.14, height: 0.08 }, "NEXT CAR >", () => this.menu.activate("next-car"), s * 0.9);
    this.addButton(batch, { x: 0.36, y: 0.86, width: 0.14, height: 0.08 }, "BACK", () => this.menu.activate("back"), s * 0.9);
    this.addButton(batch, { x: 0.63, y: 0.86, width: 0.33, height: 0.08 }, "START RACE (ENTER)", () => this.menu.activate("launch"), s * 1.0, true);
  }

  private drawOptionsOverlay(batch: UiBatchBuilder, view: MenuView): void {
    const fTitle = this.assets.fonts[3] ?? this.assets.fonts[0]!;
    const s = 0.80;
    const st = view.settings;
    batch.solidQuad({ x: 0.16, y: 0.14, width: 0.68, height: 0.72 }, PANEL_CARD);
    batch.text({ x: 0.20, y: 0.17, width: 0.60, height: 0.07 }, fTitle, "OPTIONS", {
      justify: 0, colour: ACCENT, scale: s * 1.15,
    });

    this.addButton(batch, { x: 0.22, y: 0.27, width: 0.56, height: 0.07 }, `SPEED UNITS: ${st.speedUnits}`, () => {
      this.menu.updateSettings({ speedUnits: st.speedUnits === "MPH" ? "KPH" : "MPH" });
    }, s * 0.9);
    this.addButton(batch, { x: 0.22, y: 0.36, width: 0.56, height: 0.07 }, `TRANSMISSION: ${st.transmission}`, () => {
      this.menu.updateSettings({ transmission: st.transmission === "AUTO" ? "MANUAL" : "AUTO" });
    }, s * 0.9);
    this.addButton(batch, { x: 0.22, y: 0.45, width: 0.56, height: 0.07 }, `SOUND: ${this.audio.muted ? "OFF" : "ON"} (${Math.round(st.masterVolume * 100)}%)`, () => {
      this.setMuted(!this.audio.muted);
    }, s * 0.9);
    this.addButton(batch, { x: 0.22, y: 0.54, width: 0.56, height: 0.07 }, `LANGUAGE: ${formatLanguageDisplayName(st.language)}`, () => {
      const langs = this.assets.languages;
      const next = langs[(langs.indexOf(st.language) + 1) % langs.length] ?? "EN";
      this.menu.updateSettings({ language: next });
    }, s * 0.9);
    this.addButton(batch, { x: 0.30, y: 0.72, width: 0.40, height: 0.08 }, "BACK (ESC)", () => this.menu.activate("back"), s * 0.95, true);
  }

  private drawLoadingOverlay(batch: UiBatchBuilder, view: MenuView): void {
    const fTitle = this.assets.fonts[3] ?? this.assets.fonts[0]!;
    const fBody = this.assets.fonts[2] ?? this.assets.fonts[0]!;
    const s = 0.82;
    batch.solidQuad({ x: 0.14, y: 0.34, width: 0.72, height: 0.30 }, PANEL_CARD);
    batch.text({ x: 0.18, y: 0.38, width: 0.64, height: 0.07 }, fTitle, "LOADING RACE...", {
      justify: 0, colour: ACCENT, scale: s * 1.1,
    });
    batch.solidQuad({ x: 0.20, y: 0.49, width: 0.60, height: 0.045 }, BAR_BG);
    batch.solidQuad({ x: 0.20, y: 0.49, width: 0.60 * clamp(view.progress, 0.02, 1), height: 0.045 }, CYAN);
    const statusText = view.loadingError ?? this.status;
    batch.text({ x: 0.18, y: 0.56, width: 0.64, height: 0.05 }, fBody, statusText, {
      justify: 0, colour: INK, scale: fitTextScale(fBody.font, statusText, 0.62 * 640, s * 0.85),
    });
  }

  private drawResultsOverlay(batch: UiBatchBuilder, view: MenuView): void {
    const fTitle = this.assets.fonts[3] ?? this.assets.fonts[0]!;
    const fBody = this.assets.fonts[2] ?? this.assets.fonts[0]!;
    const s = 0.78;

    batch.solidQuad({ x: 0.10, y: 0.10, width: 0.80, height: 0.78 }, PANEL_CARD);
    const resultsTitle = `RACE RESULTS - ${this.activeRace?.trackName ?? this.assets.defaultTrackId}`;
    batch.text({ x: 0.14, y: 0.13, width: 0.72, height: 0.07 }, fTitle, resultsTitle, {
      justify: 0, colour: ACCENT, scale: fitTextScale(fTitle.font, resultsTitle, 0.70 * 640, s * 1.15),
    });

    // Columns: POS | CAR | TIME | BEST (all in 0..1 UI space, inside the 0.14..0.86 card).
    const cols = {
      pos: { x: 0.15, width: 0.06 },
      car: { x: 0.22, width: 0.33 },
      time: { x: 0.56, width: 0.14 },
      best: { x: 0.71, width: 0.14 },
    } as const;
    const headerY = 0.205;
    const cell = (col: { x: number; width: number }, y: number, height: number, text: string,
      justify: 0 | 1 | 2, colour: UiColor, base: number) => {
      batch.text({ x: col.x, y, width: col.width, height }, fBody, text, {
        justify, colour, scale: fitTextScale(fBody.font, text, (col.width - 0.008) * 640, base, 0.5),
      });
    };
    cell(cols.pos, headerY, 0.03, "POS", 1, MUTED, s * 0.7);
    cell(cols.car, headerY, 0.03, "CAR", 1, MUTED, s * 0.7);
    cell(cols.time, headerY, 0.03, "TIME", 2, MUTED, s * 0.7);
    cell(cols.best, headerY, 0.03, "BEST", 2, MUTED, s * 0.7);

    view.standings.slice(0, 6).forEach((row, idx) => {
      const y = 0.24 + idx * 0.072;
      const h = 0.06;
      batch.solidQuad({ x: 0.14, y, width: 0.72, height: h }, idx === 0 ? [0.14, 0.27, 0.22, 0.9] : [0.06, 0.11, 0.16, 0.88]);
      const { time, best } = formatResultsRowTimes(row);
      const finished = row.finished ?? row.totalSeconds !== null;
      cell(cols.pos, y, h, `${idx + 1}`, 1, idx === 0 ? ACCENT : INK, s * 0.88);
      cell(cols.car, y, h, row.carName, 1, idx === 0 ? ACCENT : INK, s * 0.88);
      cell(cols.time, y, h, time, 2, finished ? CYAN : MUTED, s * 0.82);
      cell(cols.best, y, h, best, 2, CYAN, s * 0.82);
    });

    this.addButton(batch, { x: 0.14, y: 0.76, width: 0.22, height: 0.08 }, "RETRY RACE", () => this.menu.activate("restart"), s * 0.9, true);
    this.addButton(batch, { x: 0.39, y: 0.76, width: 0.22, height: 0.08 }, "NEXT QUICK RACE", () => this.menu.activate("quick-race"), s * 0.85);
    this.addButton(batch, { x: 0.64, y: 0.76, width: 0.22, height: 0.08 }, "MAIN MENU", () => this.menu.activate("quit"), s * 0.9);
  }
}
