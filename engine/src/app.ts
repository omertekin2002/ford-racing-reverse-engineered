import { AudioEngine, type CountdownStep, type EngineLayer, type EngineLayerRole, type TyreSurface } from "./audio/audioEngine.js";
import {
  CODE_SET_UI_TEXTURES, DemoAssets, trackDirectory, type LoadingSprites, type TrackRuntimeData,
} from "./demoAssets.js";
import type { EngineSoundRecord, ResolvedCarConfig, TrackRecord } from "./formats/databases.js";
import { measureTextLine, type FontAtlas } from "./formats/fonts.js";
import type { PcgEntry } from "./formats/pcg.js";
import type { SpcBank, SpcEntry } from "./formats/spc.js";
import { lookupTranslation, type TranslationTable } from "./formats/tlate.js";
import { AiDriver, type AiObstacle, type CarControlOutput } from "./game/aiDriver.js";
import { CameraController, cameraPresetFromDefinition, type CameraMode, type CameraView } from "./game/cameraController.js";
import { RaceManager, type RaceMode, type RaceObservation, type RacePhase } from "./game/raceManager.js";
import { InputManager, type DrivingInput, type InputFrame, type MenuInput } from "./input/inputManager.js";
import { clamp, mat4FromQuatTranslation } from "./math/mat4.js";
import { resolveCarCollision } from "./physics/collision.js";
import { TrackSpatial } from "./physics/trackSpatial.js";
import { VehiclePhysics } from "./physics/vehiclePhysics.js";
import { GlContext } from "./render/glContext.js";
import { SceneRenderer, type CarInstance, type CompiledModel, type ViewportRect } from "./render/sceneRenderer.js";
import {
  canvasToUiPoint, drawLoadingScreen, drawUiDrawItems, stepLoadingPhase, UiBatchBuilder, UiRenderer,
  uiTextMeasurer, type UiItemResources, type UiViewportMode,
} from "./render/uiRenderer.js";
import {
  cameraModeToHudGroup, COUNTDOWN_DURATION, COUNTDOWN_RACE_START_TIME, countdownFrame, formatResultsRowTimes,
  HUD_LABEL_KEYS, type HudAtlas, type HudLabelKey, type HudModelInput, type HudPoint, type HudVehicle,
  type LaunchResult, type SpeedUnits,
} from "./ui/hudModel.js";
import {
  MENU_SCREEN_SCRIPTS, MENU_SCREEN_TITLES, MenuController, type MenuCar, type MenuCommand, type MenuScene,
  type MenuSceneAction, type MenuSelectPage, type MenuSettings, type MenuState, type MenuTrack, type MenuValueKey,
  type MenuView, type RaceSetup, type RaceStanding,
} from "./ui/menuController.js";
import { UiScreenInstance, type ResolvedUiDrawItem, type UiRect, type UiScreenOptions } from "./ui/uiRuntime.js";

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
  courseMap: readonly HudPoint[];
  /** fr3.exe HUD sprites for the current speed units (`DemoAssets.loadHudAtlas`). */
  hudAtlas?: HudAtlas;
  /** Countdown chain step (0..3) whose sound cue already fired. */
  lastCountdownStep?: number;
  lastPhase: RacePhase;
  /** Launch-result banner queued on GO (race time it was queued at). */
  launchBanner?: { result: LaunchResult; start: number };
  /** HUD wrong-way flag (`0x52e390`): on the path corridor and heading against it. */
  playerWrongWay: boolean;
  /** Player lap bookkeeping for the HUD's LAST row (RaceManager only reports current and best). */
  playerCompletedLaps: number;
  playerLapStart: number;
  playerLastLap?: number;
  finishHoldTimer: number;
  finishedReported: boolean;
  /** Index of the player's row in the frozen results (RCRES highlight). */
  resultsPlayerIndex?: number;
}

/** CARDATA physics burns boost for 7 s (`VehiclePhysics` sets `boostTimer = 7`). */
const BOOST_BURN_SECONDS = 7;

/** Menus stretch over the whole backbuffer like fr3.exe's drawGraphic (0x421520); the HUD keeps 4:3 ("fit"). */
const MENU_VIEWPORT: UiViewportMode = "fullscreen";

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

/**
 * CAR.UI rating bars from CARDATA `:CAR_PERFORMANCE SPEED / AGILITY / ACCELERATION / WEIGHT` (0..1, the values
 * fr3.exe sizes RATING1 with). Cars without them fall back to an estimate from the engine and tyre data.
 */
export function computeCarRatings(
  cfg: Pick<ResolvedCarConfig, "car"> & Partial<Pick<ResolvedCarConfig, "engine" | "body" | "setup" | "frontTyre" | "rearTyre">>,
): NonNullable<MenuCar["ratings"]> {
  const perf = new Map(cfg.car.performance.map(p => [p.type.toUpperCase(), p.value]));
  const rating = (key: string) => {
    const value = perf.get(key);
    return value !== undefined && Number.isFinite(value) ? clamp(value, 0, 1) : undefined;
  };
  let estimate: { speed: number; power: number; acceleration: number; handling: number } | undefined;
  if (cfg.engine && cfg.body && cfg.frontTyre && cfg.rearTyre) {
    const maxTorque = Math.max(100, ...cfg.engine.torque) * (cfg.engine.fields.TORQUE_MODIFIER ?? 1);
    const maxRpm = cfg.engine.fields.MAX_RPM ?? 6500;
    const peakPower = (maxTorque * maxRpm) / 5252000;
    const totalMass = Math.max(800, cfg.body.masses.reduce((s, m) => s + m.mass, 0) + (cfg.setup?.ballast?.mass ?? 0));
    const grip = ((cfg.frontTyre.fields.ROAD_MAGIC_GRIP_NUMBER ?? 45) + (cfg.rearTyre.fields.ROAD_MAGIC_GRIP_NUMBER ?? 45)) * 0.5;
    estimate = {
      speed: clamp((peakPower / 2.2) * 0.65 + (maxRpm / 9000) * 0.35, 0.18, 1),
      power: clamp(peakPower / 2.3, 0.15, 1),
      acceleration: clamp((peakPower / (totalMass / 1400)) / 2.0, 0.15, 1),
      handling: clamp((grip - 25) / 45, 0.2, 1),
    };
  }
  const bhp = perf.get("BHP");
  const speed = rating("SPEED") ?? estimate?.speed ?? 0.5;
  const acceleration = rating("ACCELERATION") ?? estimate?.acceleration ?? 0.5;
  const agility = rating("AGILITY") ?? estimate?.handling ?? 0.5;
  return {
    speed,
    power: bhp !== undefined && Number.isFinite(bhp) ? clamp(bhp / 600, 0, 1) : estimate?.power ?? speed,
    acceleration,
    handling: agility,
    agility,
    weight: rating("WEIGHT") ?? 0.5,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Front end: every MenuState opens its authentic `.UI` screen (MENU_SCREEN_SCRIPTS) and is wired the way
// fr3.exe's ui_*.c modules do it (code-set texts/textures, MENUBAR selection bar, value rows). Nothing synthetic
// is drawn on top: `drawUiDrawItems` paints exactly what the script resolves to.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const PC_ENTER_ICON = "GRAPHICS\\GAME\\COMMON\\PC\\PCENTER.PSD";
const PC_ESCAPE_ICON = "GRAPHICS\\GAME\\COMMON\\PC\\PCESCAPE.PSD";
const PC_KEY_C_ICON = "GRAPHICS\\GAME\\COMMON\\PC\\PCKEYC.PSD";
const CAR_BACKGROUND = "GRAPHICS\\GAME\\BKGNDS\\CAR.PSD";
const FORD_RACE_LOGO = "GRAPHICS\\GAME\\COMMON\\FORDRACE.PSD";
/** `GRAPHICS\GAME\COMMON\MODEICON\%s.PSD` per race mode (CMODE.UI buttons, RCRES.UI MODEICON). */
export const MODE_ICON_TEXTURES: Readonly<Record<RaceMode, string>> = {
  RACING: "GRAPHICS\\GAME\\COMMON\\MODEICON\\RACING.PSD",
  RACING_BOOST: "GRAPHICS\\GAME\\COMMON\\MODEICON\\BOOST.PSD",
};
/** Race-type names and CMODE.UI descriptions. */
export const MODE_TEXT_KEYS: Readonly<Record<RaceMode, { name: string; description: string }>> = {
  RACING: { name: "TXT_GAME_MODE_STANDARD", description: "TXT_GAME_MODE_STANDARD_RACE_DES" },
  RACING_BOOST: { name: "TXT_GAMEMODE_BOOST", description: "TXT_GAMEMODE_BOOST_DES" },
};
/** fr3.exe overrides the MENU_RNG pulse TIME_LENGTH with 0.266667 s (`0x4a2af0`). */
const MENU_PULSE_SECONDS = 0.266667;
/** SMARROW is 19×19 and sits 5 px either side of the focused value text (fr3 `ui_funcs.c` `0x4a3360`, gap 5). */
const ARROW_PX = 19;
const ARROW_GAP_PX = 5;
/** Selection-bar icon/pulse nodes fr3 hides on value rows, where the arrows take over (`0x4a3d60` → `0x4a3fbb`). */
const MENUBAR_ICON_NODES = ["MENUBAR_ICON", "MENUBAR_ICON2", "MENUBAR_PULSE", "MENUBAR_PULSE2"] as const;
/** fr3 draws disabled rows in RCEND's unfocused grey (VIEW REPLAY: FONT_COLOUR 155,155,155). */
const DISABLED_TEXT_RGB = [155, 155, 155] as const;
/**
 * RCRES.UI layout fr3 sets by code (`ui_rcres.c`, `0x4bf1b0` intro / `0x4bf930` after the first confirm):
 * the intro shows MODETITLE at y 0.6 and the finishing position (BUTTON1, 0.042 tall) at y 0.652 with the
 * results list hidden; the first confirm slides them up to 0.419 / 0.47 over 0.2 s and opens LISTBOXBKG at
 * y 0.51667; the second confirm leaves the screen.
 */
export const RCRES_LAYOUT = {
  intro: { modeTitleY: 0.6, positionY: 0.652 },
  list: { modeTitleY: 0.419, positionY: 0.47, listY: 0.51667 },
  positionHeight: 0.042,
  moveSeconds: 0.2,
} as const;
/** AUDIO.UI VOLBAR (168×9) and VOLSLIDE knob (11×20) logical sizes. */
const VOLBAR_PX = 168;
const VOLSLIDE_PX = 11;
/** TRACK.UI HSC best-times nodes (all `TIME_LENGTH 0`) and the instant clip they get instead. */
export const HSC_TABLE_NODES = [
  "HSC_TABLE_AREA", "VEHICLE_CLASS_TXT", "NAME_TITLE_TXT", "CAR_TITLE_TXT", "TIME_TITLE_TXT",
  "NAME_LIST", "CAR_LIST", "TIME_LIST",
] as const;
const HSC_INSTANT_SECONDS = 0.001;
/** Credits LISTBOX scroll speed in screen heights per second [I]. */
const CREDITS_SCROLL_RATE = 0.06;

/**
 * Where the CAR.UI turntable renders (normalized full-screen rect): right of RATINGSWINDOW (x ≥ 283 px), below
 * CARNAME (y ≥ 108 px) and above MATRIXWINDOW's DARKPANEL (y < 288 px). [RE `ui_3d.c` for the exact viewport.]
 */
export const CAR_TURNTABLE_RECT: ViewportRect = { x: 0.45, y: 0.22, width: 0.53, height: 0.38 };
/** Retries a failed lazy UI texture load gets before the key is parked for the session. */
export const LAZY_UI_TEXTURE_RETRIES = 2;

/** Screen-sized textures (≥ 1024²) are uploaded only for the screen that shows them. */
export function isLargeUiTexture(entry: Pick<PcgEntry, "storedWidth" | "storedHeight">): boolean {
  return entry.storedWidth * entry.storedHeight >= 1024 * 1024;
}

/** The player's driving input for a race mode: boost exists only in RACING_BOOST (standard RACING has no boost HUD). */
export function playerDrivingInput(mode: RaceMode, driving: DrivingInput): DrivingInput {
  return mode === "RACING_BOOST" || !driving.boost ? driving : { ...driving, boost: false };
}

/**
 * The gap the AI rubber-bands against, or undefined when ROPT.UI CATCH UP is OFF (unset = on, as in quick
 * races). Undefined rather than 0: `catchupPower` shifts a 0 gap by the car's pack slot, which would still
 * speed up or slow down every non-centre AI; without a gap `AiDriver` runs at exactly 1× power.
 */
export function aiReferenceGap(setup: Pick<RaceSetup, "catchUp">, gap: number): number | undefined {
  return setup.catchUp === false ? undefined : gap;
}

/** TRACK.UI track page: the body between the TRACKNAME bar and the BACK row; its left/right half steps the track. */
export const TRACK_CYCLE_RECT: UiRect = { x: 0, y: 0.22, width: 1, height: 0.6 };

/** A pinned MENUBAR prompt (CAR.UI CARNAME, TRACK.UI TRACKNAME): the text on the bar plus the bar's graphics. */
function menuBarPromptNodes(textId: string): string[] {
  return [textId, "MENUBAR", "MENUBAR_ICON", "MENUBAR_PULSE"];
}

/** LANG.UI BUTTON1..5 and the TLATE tables that back them (first available code wins). */
const LANGUAGE_BUTTONS: readonly (readonly string[])[] = [["EN", "US"], ["FR"], ["GR", "DE"], ["IT"], ["SP", "ES"]];

const CAR_GROUP_TEXT_ALIASES: Readonly<Record<string, string>> = {
  CLASSIC: "TXT_CAR_THEME_ROAD_1", MODERN: "TXT_CAR_THEME_ROAD_2", OFFROAD: "TXT_CAR_THEME_OFF_ROAD",
};

export interface MenuSceneContext {
  readonly readFile: (path: string) => string | undefined;
  readonly translation: TranslationTable;
  /** `DemoAssets.getUiTextureSize`: drives AUTOSIZE and STRETCH_GRAPHIC 0 crops. */
  readonly getTextureSize?: UiScreenOptions["getTextureSize"];
  /** fontbase.dat slots (arrow placement measures value text; list rows use their cell height). */
  readonly fonts?: readonly FontAtlas[];
  /** Installed TLATE codes (LANG.UI hides languages that are not installed). */
  readonly languages?: readonly string[];
  /** All selectable cars, for CAR.UI's FR3_PAGE_COUNTER. */
  readonly cars?: readonly MenuCar[];
  /** Mode of the race whose results RCRES.UI shows. */
  readonly resultsMode?: () => RaceMode | undefined;
  /** Row of `view.standings` that belongs to the local player. */
  readonly resultsPlayerIndex?: () => number | undefined;
}

/** A MenuScene plus a per-frame hook (focus-dependent texts, value arrows, credit scroll). */
export interface AppMenuScene extends MenuScene {
  tick?(dt: number, view: MenuView): void;
  /**
   * Screen-level input handling that runs before MenuController (pointer in UI space): RCRES's first confirm
   * reveals the results list, and a click on a visible BACK_ICON / BACK_TEXT acts as Esc.
   */
  filterInput?(input: MenuInput): MenuInput;
  /** In-game options: the screen's own background (fill or texture) is not drawn, so the race shows through. */
  readonly overRace?: boolean;
  /** Non-button nodes drawn in the disabled grey (e.g. DISP's SCREEN MODE value). */
  readonly dimmed?: readonly string[];
}

export function carGroupLabel(translation: TranslationTable, group: string): string {
  const key = CAR_GROUP_TEXT_ALIASES[group.toUpperCase()] ?? `TXT_CAR_THEME_${group.toUpperCase()}`;
  return lookupTranslation(translation, key) ?? group.replaceAll("_", " ");
}

export function trackGroupLabel(translation: TranslationTable, group: string): string {
  return lookupTranslation(translation, `TXT_TRACKS_THEME_${group.toUpperCase()}`) ?? group.replaceAll("_", " ");
}

/** Finishing position as fr3 prints it: TXT_GENERAL_POSITION_<n> + ST/ND/RD/TH. */
export function formatFinishingPosition(translation: TranslationTable, place: number): string {
  const n = Math.max(1, Math.trunc(place));
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "TH" : (["TH", "ST", "ND", "RD"][n % 10] ?? "TH");
  const ordinalKey = ["", "1ST", "2ND", "3RD", "4TH", "5TH", "6TH", "7TH", "8TH"][n];
  const digits = (ordinalKey && lookupTranslation(translation, `TXT_GENERAL_POSITION_${ordinalKey}`)) || String(n);
  return `${digits}${lookupTranslation(translation, `TXT_GENERAL_POSITION_${suffix}`) ?? suffix}`;
}

interface ValueRow {
  /** Focusable row button. */
  readonly button: string;
  /** Value text node the arrows bracket. */
  readonly value?: string;
  /**
   * Slider the arrows bracket instead (AUDIO): the drawn bar (`id`, `widthPx` wide in 640-px units) plus its
   * knob, so the arrows never cover the knob at either end of its travel.
   */
  readonly slider?: { id: string; widthPx: number; knob: string };
}

/**
 * Place a node at a screen-space position whatever its parent is: `setNodePosition` takes parent units, so
 * probe the parent's origin and scale first (GMOPT's arrows live in MOVINGWINDOW at y −0.142).
 */
export function setNodeScreenPosition(screen: UiScreenInstance, id: string, x: number, y: number): boolean {
  if (!screen.setNodePosition(id, 0, 0)) return false;
  const origin = screen.getNodeRect(id);
  screen.setNodePosition(id, 1, 1);
  const unit = screen.getNodeRect(id);
  if (!origin || !unit) return false;
  const sx = unit.x - origin.x || 1;
  const sy = unit.y - origin.y || 1;
  return screen.setNodePosition(id, (x - origin.x) / sx, (y - origin.y) / sy);
}

/** Where a draw item's single-line text is painted (justified within its text rect), or undefined without text. */
function drawnTextExtent(item: ResolvedUiDrawItem, fonts?: readonly FontAtlas[]): UiRect | undefined {
  if (!item.text) return undefined;
  const font = fonts?.[item.font]?.font;
  const width = font ? measureTextLine(font, item.text) / 640 : item.text.length * 9 / 640;
  const h = Math.max(0, Math.min(8, Math.trunc(item.textJustify))) % 3;
  const x = h === 1 ? item.textRect.x : h === 2 ? item.textRect.x + item.textRect.width - width
    : item.textRect.x + (item.textRect.width - width) / 2;
  return { x, y: item.rect.y, width, height: item.rect.height };
}

function rectContains(rect: UiRect, x: number, y: number): boolean {
  return rect.width > 0 && rect.height > 0
    && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/**
 * The topmost visible draw item among `ids` under a UI-space point (its rect, or the text it paints: single-line
 * texts like COLOUR_TEXT overflow their placeholder rects). Used for clickable graphics that are not buttons.
 */
export function drawItemAt(
  screen: UiScreenInstance, ids: readonly string[], x: number, y: number, fonts?: readonly FontAtlas[],
): string | null {
  const wanted = new Set(ids.map(id => id.toLowerCase()));
  const items = screen.getDrawItems();
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.listRow || !wanted.has(item.id.toLowerCase())) continue;
    if (!item.textureRef && item.text === null) continue;
    const text = drawnTextExtent(item, fonts);
    if (rectContains(item.rect, x, y) || (text && rectContains(text, x, y))) return item.id;
  }
  return null;
}

/** Value-row arrows: the per-frame placement plus the pointer filter that turns arrow clicks into Left/Right. */
interface ValueArrows {
  tick(): void;
  filterInput(input: MenuInput): MenuInput;
}

/**
 * Keep LEFTARROW / RIGHTARROW beside the focused row's value (ROPT/GMOPT/DISP/AUDIO), like fr3's selection bar
 * (`ui_funcs.c` `0x4a3d60`): on a value row the arrows show and the bar's MENUBAR_ICON/ICON2/PULSE/PULSE2 hide
 * (so the left arrow never sits on the PCEnter icon); rows without a value (LET'S RACE!!!) show the icon and
 * hide the arrows. Arrows are re-faded on every focus change. Positions are screen space, converted to the
 * arrows' parent (GMOPT's MOVINGWINDOW is offset by −0.142).
 */
function valueArrowTicker(
  screen: UiScreenInstance, rows: readonly ValueRow[], fonts?: readonly FontAtlas[], barId = "MENUBAR",
): ValueArrows {
  let lastFocus: string | null | undefined;
  // The arrows sit inside the row buttons' 1.0-wide rects (ROPT's LEFTARROW overlaps LAPS), so they are
  // tested before the button hit-test: LEFTARROW steps the focused value down, RIGHTARROW up (fr3 0x4a3d60).
  const filterInput = (input: MenuInput): MenuInput => {
    if (!input.pointerClicked) return input;
    const hit = drawItemAt(screen, ["LEFTARROW", "RIGHTARROW"], input.pointerX, input.pointerY);
    if (!hit) return input;
    const left = hit.toUpperCase() === "LEFTARROW";
    return { ...input, pointerClicked: false, left, right: !left };
  };
  const tick = () => {
    const focused = screen.getFocusedId()?.toLowerCase() ?? null;
    const row = rows.find(r => r.button.toLowerCase() === focused);
    let anchor: UiRect | undefined;
    let gap = ARROW_GAP_PX / 640;
    if (row?.slider) {
      const bar = screen.getNodeRect(row.slider.id);
      const knob = screen.getNodeRect(row.slider.knob);
      if (bar) {
        // fr3 brackets sliders flush (`0x4a42a0`); include the knob, which overhangs the bar at 0 and 10.
        const left = Math.min(bar.x, knob?.x ?? bar.x);
        const right = Math.max(bar.x + row.slider.widthPx / 640, knob ? knob.x + knob.width : -Infinity);
        const top = Math.min(bar.y, knob?.y ?? bar.y);
        const bottom = Math.max(bar.y + bar.height, knob ? knob.y + knob.height : -Infinity);
        anchor = { x: left, y: top, width: right - left, height: bottom - top };
        gap = 0;
      }
    } else if (row?.value) {
      const item = screen.getDrawItems().find(entry => entry.id.toLowerCase() === row.value!.toLowerCase());
      if (item) anchor = drawnTextExtent(item, fonts);
    }
    screen.setNodeVisible("LEFTARROW", anchor !== undefined);
    screen.setNodeVisible("RIGHTARROW", anchor !== undefined);
    for (const id of MENUBAR_ICON_NODES) screen.setNodeVisible(`${barId}/${id}`, anchor === undefined);
    if (!anchor) {
      lastFocus = focused;
      return;
    }
    const y = anchor.y + (anchor.height - ARROW_PX / 480) / 2;
    setNodeScreenPosition(screen, "LEFTARROW", anchor.x - ARROW_PX / 640 - gap, y);
    setNodeScreenPosition(screen, "RIGHTARROW", anchor.x + anchor.width + gap, y);
    if (focused !== lastFocus) {
      screen.restartAnimation("LEFTARROW");
      screen.restartAnimation("RIGHTARROW");
      lastFocus = focused;
    }
  };
  return { tick, filterInput };
}

/**
 * Park a MENUBAR group on a code-chosen text line instead of following button focus (CARNAME, TRACKNAME and
 * CMODE's MODENAME use black text on the yellow bar, with the PCEnter icon at the left end) [I].
 */
function pinMenuBar(screen: UiScreenInstance, scope: string, x: number, y: number): void {
  screen.setNodePosition(`${scope}/MENUBAR`, x, y);
  screen.setNodeTexture(`${scope}/MENUBAR_ICON`, PC_ENTER_ICON);
  screen.setNodeTimeLength(`${scope}/MENUBAR_PULSE`, MENU_PULSE_SECONDS);
  screen.setNodeVisible(`${scope}/MENUBAR_PULSE2`, false);
  screen.setNodeVisible(`${scope}/MENUBAR_ICON2`, false);
}

/** VERTICAL_BOTTOM_BAR (RES_BOT) stays where the script puts it; only its icon is code-set (PCEnter). */
function armVerticalBar(screen: UiScreenInstance, scope?: string): void {
  const prefix = scope ? `${scope}/` : "";
  screen.setNodeTexture(`${prefix}MENUBAR_ICON`, PC_ENTER_ICON);
  screen.setNodeTimeLength(`${prefix}MENUBAR_PULSE`, MENU_PULSE_SECONDS);
}

/** The visible BACK_ICON / BACK_TEXT under a UI-space point, when no button is there. */
export function backPromptAt(screen: UiScreenInstance, x: number, y: number): string | null {
  if (screen.hitTest(x, y) !== null) return null;
  const hit = screen.getDrawItems().find(item => (item.id === "BACK_ICON" || item.id === "BACK_TEXT")
    && (item.id === "BACK_ICON" ? item.textureRef !== null : item.text !== null)
    && x >= item.rect.x && x <= item.rect.x + item.rect.width && y >= item.rect.y && y <= item.rect.y + item.rect.height);
  return hit?.id ?? null;
}

/** A click on the BACK prompt is Esc (the prompt is a graphic + text, not a UI_TYPE_BUTTON). */
function clickBack(screen: UiScreenInstance, input: MenuInput): MenuInput {
  if (!input.pointerClicked || !backPromptAt(screen, input.pointerX, input.pointerY)) return input;
  return { ...input, pointerClicked: false, back: true };
}

/**
 * What `renderMenuUi` paints for a scene: the screen's draw items, minus the screen's own background when the
 * options run over the race (`overRace`: the root is `CLEAR 0`, so a null texture would paint a white fill),
 * with disabled rows and `dimmed` nodes in the disabled grey.
 */
export function menuDrawItems(scene: AppMenuScene): ResolvedUiDrawItem[] {
  const screen = scene.screen;
  const dimmed = new Set((scene.dimmed ?? []).map(id => id.toLowerCase()));
  const items: ResolvedUiDrawItem[] = [];
  for (const item of screen.getDrawItems()) {
    if (scene.overRace && item.id === screen.id) continue;
    if (item.text !== null && !item.listRow && (!item.enabled || dimmed.has(item.id.toLowerCase()))) {
      items.push({ ...item, textColor: [...DISABLED_TEXT_RGB, item.textColor[3]] });
    } else {
      items.push(item);
    }
  }
  return items;
}

/**
 * Build the authentic `.UI` scene for a front-end state, wired like fr3.exe: code-set titles, icons and
 * backgrounds, the MENUBAR selection bar, value rows driven by `{ adjust }` actions, and page toggling on
 * CAR.UI / TRACK.UI. Returns undefined for states drawn by code (LOADING, IN_GAME) or missing scripts.
 * Every scene treats a click on its BACK prompt as Esc.
 */
export function buildMenuScene(state: MenuState, view: MenuView, ctx: MenuSceneContext): AppMenuScene | undefined {
  const scene = buildScreenScene(state, view, ctx);
  if (!scene) return undefined;
  const own = scene.filterInput;
  return { ...scene, filterInput: input => clickBack(scene.screen, own ? own(input) : input) };
}

function buildScreenScene(state: MenuState, view: MenuView, ctx: MenuSceneContext): AppMenuScene | undefined {
  const path = MENU_SCREEN_SCRIPTS[state];
  if (!path || ctx.readFile(path) === undefined) return undefined;
  const fonts = ctx.fonts;
  const screen = UiScreenInstance.load(path, {
    readFile: ctx.readFile,
    translation: ctx.translation,
    getTextureSize: ctx.getTextureSize,
    getFontLineHeight: fonts ? slot => fonts[slot]?.font.descriptor.cellHeight : undefined,
    measureText: fonts ? uiTextMeasurer(fonts) : undefined,
  });
  const tr = (key: string, fallback = key) => lookupTranslation(ctx.translation, key) ?? fallback;
  const reveal = (id: string, on = true) => {
    screen.setNodeVisible(id, on);
    screen.setNodeEnabled(id, on);
  };
  // Returning from a sub-screen re-focuses the row that opened it (fr3 keeps the hub's focus on its stack).
  const returnFocus = (map: Partial<Record<MenuState, string>>) => {
    const id = view.previousState && map[view.previousState];
    if (id) screen.setFocus(id);
  };
  const title = MENU_SCREEN_TITLES[state];
  if (title) screen.setNodeText("TITLE", title);
  screen.setNodeTexture("BACK_ICON", PC_ESCAPE_ICON);
  // Options opened from PAUSE run over the live race: no background texture or fill (`overRace`), and
  // IN_GAME_DARK_STRIP (OPTS/AUDIO/DISP) darkens the band behind the rows.
  const overRace = view.inGameOptions;
  const applyInGame = () => {
    if (overRace) screen.setNodeTexture(screen.id, null);
    screen.setNodeVisible("IN_GAME_DARK_STRIP", overRace);
  };

  switch (state) {
    case "START": {
      screen.setNodeText("BUTTON1", "TXT_START_PRESS_ANY_KEY_PC");
      // VERSION is filled with the build string by code; the native build has none.
      screen.setNodeTextRaw("VERSION", null);
      return { screen, actions: {} };
    }

    case "MAIN_MENU": {
      for (const id of ["BUTTON1", "BUTTON2", "BUTTON3", "BUTTON4"]) reveal(id);
      // MULTIPLAYER stays visible but cannot be selected (no split screen); EXIT TO OS has no browser equivalent.
      screen.setNodeEnabled("BUTTON3", false);
      for (const id of ["BUTTON5", "BUTTON6"]) reveal(id, false);
      screen.setNodeTextRaw("GAME_VERSION_INFO", null);
      screen.enableSelectionBar();
      screen.setFocus("BUTTON1");
      returnFocus({ MODE_SELECT: "BUTTON2", OPTIONS: "BUTTON4" });
      return {
        screen,
        actions: { BUTTON1: "quick-race", BUTTON2: "single-player", BUTTON4: "options" },
      };
    }

    case "MODE_SELECT": {
      const modes: [string, RaceMode][] = [["BUTTON1", "RACING"], ["BUTTON2", "RACING_BOOST"]];
      for (let i = 1; i <= 17; i++) reveal(`BUTTON${i}`, i <= modes.length);
      for (const [id, mode] of modes) screen.setNodeTexture(id, MODE_ICON_TEXTURES[mode]);
      pinMenuBar(screen, screen.id, 0.1392, 0.4521);
      screen.setFocus(modes.find(([, mode]) => mode === view.raceOptions.mode)?.[0] ?? "BUTTON1");
      let shown: string | null | undefined;
      const tick = () => {
        const focused = screen.getFocusedId();
        if (focused === shown) return;
        shown = focused;
        const mode = modes.find(([id]) => id.toLowerCase() === focused?.toLowerCase())?.[1];
        screen.setNodeText("MODENAME", mode ? MODE_TEXT_KEYS[mode].name : null);
        screen.setNodeText("MODEDESC", mode ? MODE_TEXT_KEYS[mode].description : null);
        for (const id of ["MODENAME", "MODEDESC", "MENUBAR"]) screen.restartAnimation(id);
      };
      tick();
      return {
        screen,
        actions: Object.fromEntries(modes.map(([id, mode]) => [id, { raceOptions: { mode }, then: "continue" }])),
        tick,
      };
    }

    case "CAR_SELECT": {
      screen.setNodeTexture(screen.id, CAR_BACKGROUND);
      screen.setNodeTexture("GROUPWINDOW/BACK_ICON", PC_ESCAPE_ICON);
      screen.setNodeTexture("CARINFOWINDOW/BACK_ICON", PC_ESCAPE_ICON);
      screen.setNodeText("GROUPWINDOW/TITLE", "TXT_TITLE_CAR_THEME");
      screen.setNodeText("CARINFOWINDOW/TITLE", "TXT_TITLE_CAR_SELECT");
      screen.setNodeTexture("COLOUR_ICON", PC_KEY_C_ICON);
      screen.setNodeTextRaw("LOCKEDTEXT", null);
      screen.setNodeTextRaw("FR3_PAGE_HELPER_TEXT", null);
      pinMenuBar(screen, "CARNAMEWINDOW", 0.0579, 0.1687);
      const groups = view.carGroups.slice(0, 8);
      const actions: Record<string, MenuSceneAction> = {};
      for (let i = 0; i < 8; i++) {
        const id = `BUTTON${i + 1}`;
        const group = groups[i];
        reveal(id, group !== undefined);
        if (group === undefined) continue;
        screen.setNodeTextRaw(id, carGroupLabel(ctx.translation, group));
        actions[id] = { carGroup: group };
      }
      screen.enableSelectionBar({ barId: "GROUPWINDOW/MENUBAR" });
      let page: MenuSelectPage | undefined;
      const update = (v: MenuView) => {
        const groupPage = v.carSelectPage === "GROUP";
        if (page !== v.carSelectPage) {
          page = v.carSelectPage;
          screen.setNodeVisible("GROUPWINDOW", groupPage);
          for (const id of ["CARNAMEWINDOW", "CARINFOWINDOW", "MATRIXWINDOW"]) screen.setNodeVisible(id, !groupPage);
          for (const id of groupPage ? ["GROUPWINDOW"] : ["CARNAMEWINDOW", "CARINFOWINDOW", "MATRIXWINDOW"]) {
            screen.restartAnimation(id);
          }
          const index = v.carGroup === undefined ? -1 : groups.indexOf(v.carGroup);
          if (groupPage && index >= 0) screen.setFocus(`BUTTON${index + 1}`);
        }
        const car = v.car;
        screen.setNodeTextRaw("CARNAME", car?.name ?? "");
        const ratings = car?.ratings;
        const bars: [string, number | undefined][] = [
          ["TOPSPEED", ratings?.speed], ["AGILITY", ratings?.agility ?? ratings?.handling],
          ["ACCELERATION", ratings?.acceleration], ["WEIGHT", ratings?.weight],
        ];
        // RATING1 is STRETCH_GRAPHIC 0: a narrower node crops the 105×15 bar instead of squashing it.
        for (const [id, value] of bars) screen.setNodeSize(id, clamp(value ?? 0.5, 0, 1), 1);
        const liveries = (car?.liveries.length ?? 0) > 1;
        screen.setNodeVisible("COLOUR_ICON", liveries);
        screen.setNodeVisible("COLOUR_TEXT", liveries);
        const members = (ctx.cars ?? []).filter(c => v.carGroup === undefined || c.group === v.carGroup);
        const position = car ? members.findIndex(c => c.id === car.id) : -1;
        screen.setNodeTextRaw("FR3_PAGE_COUNTER", position >= 0 ? `${position + 1}/${members.length}` : null);
      };
      update(view);
      // The car page has no buttons: its CARNAME bar (PCEnter) continues, the COLOUR prompt (C key) changes the
      // livery and the left/right half of the turntable steps the car, so a pointer alone can pick a car.
      const pointerAction = (x: number, y: number): MenuSceneAction | undefined => {
        if (page !== "ITEM") return undefined;
        if (drawItemAt(screen, ["COLOUR_ICON", "COLOUR_TEXT"], x, y, fonts)) return "next-livery";
        if (drawItemAt(screen, menuBarPromptNodes("CARNAME"), x, y, fonts)) return "continue";
        if (rectContains(CAR_TURNTABLE_RECT, x, y)) {
          return x < CAR_TURNTABLE_RECT.x + CAR_TURNTABLE_RECT.width / 2 ? "previous-car" : "next-car";
        }
        return undefined;
      };
      return { screen, actions, update, pointerAction };
    }

    case "TRACK_SELECT": {
      screen.setNodeTexture("GROUPWINDOW/BACK_ICON", PC_ESCAPE_ICON);
      screen.setNodeTexture("TRACKINFOWINDOW/BACK_ICON", PC_ESCAPE_ICON);
      screen.setNodeText("GROUPWINDOW/TITLE", "TXT_TITLE_TRACK_THEME");
      screen.setNodeText("TRACKINFOWINDOW/TITLE", "TXT_TITLE_TRACK_SELECT");
      // UNLOCKTEXT is a white `CLEAR 0` box with the unlock hint, shown by ui_track.c only for locked tracks.
      // Every installed track is unlocked, so it stays hidden and the HSC best-times table reads cleanly.
      screen.setNodeTextRaw("UNLOCKTEXT", null);
      reveal("UNLOCKTEXT", false);
      pinMenuBar(screen, "TRACKINFOWINDOW", 0.0781, 0.1479);
      const groups = view.trackGroups.slice(0, 6);
      const actions: Record<string, MenuSceneAction> = {};
      for (let i = 0; i < 6; i++) {
        const id = `BUTTON${i + 1}`;
        const group = groups[i];
        reveal(id, group !== undefined);
        if (group === undefined) continue;
        screen.setNodeTextRaw(id, trackGroupLabel(ctx.translation, group));
        actions[id] = { trackGroup: group };
      }
      screen.enableSelectionBar({ barId: "GROUPWINDOW/MENUBAR" });
      // No saved best times yet: the HSC table keeps its headers and empty lists.
      for (const id of ["NAME_LIST", "CAR_LIST", "TIME_LIST"]) screen.setListItems(id, []);
      // The HSC table is authored with TIME_LENGTH 0 and *_START colours at alpha 0; ui_track.c restarts it
      // every 4 s (HSC_TABLE_TIMER) and it shows at once, so a zero-length clip means "already at the end".
      // The runtime holds such clips at their start colour, so give them an instant (1 ms) clip instead.
      for (const id of HSC_TABLE_NODES) screen.setNodeTimeLength(id, HSC_INSTANT_SECONDS);
      let page: MenuSelectPage | undefined;
      const update = (v: MenuView) => {
        const groupPage = v.trackSelectPage === "GROUP";
        if (page !== v.trackSelectPage) {
          page = v.trackSelectPage;
          screen.setNodeVisible("GROUPWINDOW", groupPage);
          for (const id of ["TRACKINFOWINDOW", "HSC_TABLE_AREA", "MATRIXWINDOW"]) screen.setNodeVisible(id, !groupPage);
          for (const id of groupPage ? ["GROUPWINDOW"] : ["TRACKINFOWINDOW", "HSC_TABLE_AREA"]) screen.restartAnimation(id);
          const index = v.trackGroup === undefined ? -1 : groups.indexOf(v.trackGroup);
          if (groupPage && index >= 0) screen.setFocus(`BUTTON${index + 1}`);
        }
        screen.setNodeTextRaw("TRACKNAME", v.track?.name ?? "");
        screen.setNodeTextRaw("VEHICLE_CLASS_TXT", v.car?.group ? carGroupLabel(ctx.translation, v.car.group) : null);
      };
      update(view);
      // TRACK.UI's track page has no buttons either: the TRACKNAME bar continues and a click on the left/right
      // half of the page body (between the bar and the BACK row) steps the track.
      const pointerAction = (x: number, y: number): MenuSceneAction | undefined => {
        if (page !== "ITEM") return undefined;
        if (drawItemAt(screen, menuBarPromptNodes("TRACKNAME"), x, y, fonts)) return "continue";
        if (rectContains(TRACK_CYCLE_RECT, x, y)) {
          return x < TRACK_CYCLE_RECT.x + TRACK_CYCLE_RECT.width / 2 ? "previous-track" : "next-track";
        }
        return undefined;
      };
      return { screen, actions, update, pointerAction };
    }

    case "RACE_OPTIONS": {
      const rows: ValueRow[] = [
        { button: "LAPS", value: "LAPSNUMBER" }, { button: "OPPS", value: "OPPSNUMBER" },
        { button: "FIELD", value: "FIELDNUMBER" }, { button: "DIFF", value: "DIFFNUMBER" },
        { button: "CATCH_UP_BUTTON", value: "CATCH_UP_BUTTONNUMBER" }, { button: "RACE" },
      ];
      const update = (v: MenuView) => {
        const o = v.raceOptions;
        screen.setNodeTextRaw("LAPSNUMBER", String(o.laps));
        screen.setNodeTextRaw("OPPSNUMBER", String(o.opponents));
        screen.setNodeText("FIELDNUMBER", o.fieldType === "MATCH" ? "TXT_RACE_OPTIONS_AI_TYPE_SAME" : "TXT_RACE_OPTIONS_AI_TYPE_MIXED");
        screen.setNodeText("DIFFNUMBER", `TXT_OPTIONS_GAME_DIFFICULTY_${o.difficulty}`);
        screen.setNodeText("CATCH_UP_BUTTONNUMBER", o.catchUp ? "TXT_GENERAL_ON" : "TXT_GENERAL_OFF");
      };
      update(view);
      screen.enableSelectionBar();
      const arrows = valueArrowTicker(screen, rows, fonts);
      arrows.tick();
      return {
        screen,
        actions: {
          LAPS: { adjust: "laps" }, OPPS: { adjust: "opponents" }, FIELD: { adjust: "fieldType" },
          DIFF: { adjust: "difficulty" }, CATCH_UP_BUTTON: { adjust: "catchUp" }, RACE: "launch",
        },
        update,
        tick: arrows.tick,
        filterInput: arrows.filterInput,
      };
    }

    case "OPTIONS": {
      for (const id of ["BUTTON1", "BUTTON2", "BUTTON3", "BUTTON4", "BUTTON5"]) reveal(id);
      applyInGame();
      screen.enableSelectionBar();
      returnFocus({
        OPTIONS_GAME: "BUTTON1", OPTIONS_AUDIO: "BUTTON2", OPTIONS_DISPLAY: "BUTTON3", OPTIONS_CONTROLS: "BUTTON4",
        OPTIONS_CREDITS: "BUTTON5",
      });
      return {
        screen,
        actions: {
          BUTTON1: "options-game", BUTTON2: "options-audio", BUTTON3: "options-display",
          BUTTON4: "options-controls", BUTTON5: "options-credits",
        },
        overRace,
      };
    }

    case "OPTIONS_AUDIO": {
      const sliders: [string, MenuValueKey & keyof MenuSettings][] = [
        ["ENGINE", "engineVolume"], ["SPEECH", "speechVolume"],
        ["INGAMEMUSIC", "raceMusicVolume"], ["MENUMUSIC", "menuMusicVolume"],
      ];
      // AUDIO OUTPUT / SOUNDTRACK share one slot (console/PC variants) and have no browser equivalent.
      for (const id of ["AUDIOOUTPUT", "AUDIOOUTPUTVALUE", "SOUNDTRACK", "SOUNDTRACKVALUE"]) reveal(id, false);
      // ui_audio.c only drives the bars (it formats `%s%s`+VALUE for AUDIOOUTPUT/SOUNDTRACK and never names a
      // `*NUMBER` node), so ENGINENUMBER & co. keep the script's empty text: no digits over the bars.
      for (const [id] of sliders) screen.setNodeTextRaw(`${id}NUMBER`, null);
      applyInGame();
      const update = (v: MenuView) => {
        for (const [id, key] of sliders) {
          const value = clamp(Number(v.settings[key]), 0, 1);
          screen.setNodeSize(`${id}_SLIDER_BAR_VALUE`, value, 1);
          const areaPx = (screen.getNodeRect(`${id}_SLIDER_BAR`)?.width ?? 0.2798) * 640 || 179;
          // Keep the slider knob fully inside [0, VOLBAR_PX - VOLSLIDE_PX] so it is never clipped in half at 0.
          screen.setNodePosition(`${id}_SLIDER_BUTTON`, (value * Math.max(0, VOLBAR_PX - VOLSLIDE_PX)) / areaPx, 0);
        }
      };
      update(view);
      screen.enableSelectionBar();
      screen.setFocus("ENGINE");
      const arrows = valueArrowTicker(screen, sliders.map(([id]) => ({
        button: id, slider: { id: `${id}_SLIDER_BAR_BKGND`, widthPx: VOLBAR_PX, knob: `${id}_SLIDER_BUTTON` },
      })), fonts);
      arrows.tick();
      // A click along a slider (bar, fill or knob) focuses its row and sets the volume at the clicked point,
      // snapped to the 10 % steps Left/Right use.
      const pointerAction = (x: number, y: number): MenuSceneAction | undefined => {
        for (const [id, key] of sliders) {
          const parts = [`${id}_SLIDER_BAR_BKGND`, `${id}_SLIDER_BAR_VALUE`, `${id}_SLIDER_BUTTON`];
          const bar = screen.getNodeRect(`${id}_SLIDER_BAR_BKGND`);
          const drawn = screen.getDrawItems().some(item => item.id.toLowerCase() === parts[0]!.toLowerCase());
          if (!bar || !drawn) continue;
          const area = screen.getNodeRect(`${id}_SLIDER_BAR`);
          const inArea = area !== undefined && rectContains(area, x, y);
          if (!inArea && drawItemAt(screen, parts, x, y) === null) continue;
          screen.setFocus(id);
          const value = clamp(Math.round(((x - bar.x) / (VOLBAR_PX / 640)) * 10) / 10, 0, 1);
          return { settings: { [key]: value } };
        }
        return undefined;
      };
      return {
        screen,
        actions: Object.fromEntries(sliders.map(([id, key]) => [id, { adjust: key }])),
        update,
        tick: arrows.tick,
        filterInput: arrows.filterInput,
        pointerAction,
        overRace,
      };
    }

    case "OPTIONS_GAME": {
      const rows: ValueRow[] = [{ button: "SAVE", value: "SAVENUMBER" }, { button: "GEARS", value: "GEARSNUMBER" }];
      screen.setNodeTextRaw("INSTRUCTIONS", null);
      applyInGame();
      const update = (v: MenuView) => {
        screen.setNodeText("SAVENUMBER", v.settings.autosave ? "TXT_GENERAL_ON" : "TXT_GENERAL_OFF");
        screen.setNodeText("GEARSNUMBER", v.settings.transmission === "AUTO"
          ? "TXT_OPTIONS_GAME_GEARS_AUTOMATIC" : "TXT_OPTIONS_GAME_GEARS_MANUAL");
      };
      update(view);
      screen.enableSelectionBar({ barId: "MOVINGWINDOW/MENUBAR" });
      armVerticalBar(screen, "VERTICAL_BOTTOM_BAR");
      const arrows = valueArrowTicker(screen, rows, fonts, "MOVINGWINDOW/MENUBAR");
      arrows.tick();
      return {
        screen,
        actions: { SAVE: { adjust: "autosave" }, GEARS: { adjust: "transmission" } },
        update,
        tick: arrows.tick,
        filterInput: arrows.filterInput,
        overRace,
      };
    }

    case "OPTIONS_DISPLAY": {
      const rows: ValueRow[] = [
        { button: "SPEEDO", value: "SPEEDONUMBER" }, { button: "TRACKMAP", value: "TRACKMAPNUMBER" },
        { button: "SCREEN", value: "SCREENNUMBER" },
      ];
      applyInGame();
      // SCREEN MODE is the 16:9 profile option (the native build always uses the 4:3 HUD layout) and
      // POSITION SCREEN opens POSN.UI, which the native build does not implement: both stay visible, inert.
      screen.setNodeEnabled("SCREEN", false);
      screen.setNodeEnabled("POSSCREEN", false);
      screen.setNodeText("SCREENNUMBER", "TXT_OPTIONS_DISPLAY_SCREEN_MODE_NORMAL");
      const update = (v: MenuView) => {
        screen.setNodeText("SPEEDONUMBER", v.settings.speedUnits === "KPH" ? "TXT_GENERAL_KPH" : "TXT_GENERAL_MPH");
        screen.setNodeText("TRACKMAPNUMBER", v.settings.trackMap ? "TXT_GENERAL_ON" : "TXT_GENERAL_OFF");
      };
      update(view);
      screen.enableSelectionBar();
      const arrows = valueArrowTicker(screen, rows, fonts);
      arrows.tick();
      return {
        screen,
        actions: { SPEEDO: { adjust: "speedUnits" }, TRACKMAP: { adjust: "trackMap" } },
        update,
        tick: arrows.tick,
        filterInput: arrows.filterInput,
        overRace,
        dimmed: ["SCREENNUMBER"],
      };
    }

    case "OPTIONS_CONTROLS": {
      applyInGame();
      screen.setNodeText("CONTROLTYPE", "TXT_OPTIONS_CONTROLS_CONTROLLER_TYPE");
      screen.setNodeText("CONTROLTYPENUMBER", "TXT_OPTIONS_CONTROLS_MAPPING_A");
      // CTRLS.UI stacks alternates in shared slots: DEVICE over CONTROLTYPE (y 0.1541) and VIBRATION over
      // SETTINGS (y 0.2646). A single keyboard has no device choice and no vibration, so those alternates (and
      // the device arrows) are hidden; SETTINGS stays visible but disabled.
      for (const id of ["DEVICE", "DEVICENUMBER", "DEVICE_HIGHLIGHT_LEFT_ARROW", "DEVICE_HIGHLIGHT_RIGHT_ARROW",
        "VIBRATION", "VIBRATION_VALUE"]) reveal(id, false);
      screen.setNodeEnabled("SETTINGS", false);
      screen.setFocus("MAPPING");
      screen.enableSelectionBar();
      // BUTTON MAPPING restores the default key mapping (TXT_OPTIONS_CONTROLS_DEFAULT_BUTTONS).
      return { screen, actions: { MAPPING: "reset-controls" }, overRace };
    }

    case "OPTIONS_CREDITS": {
      applyInGame();
      const lines = [...ctx.translation.entries]
        .filter(([key]) => key === "TXT_CREDITS" || key.startsWith("TXT_CREDITS_"))
        .map(([, text]) => ({ text }));
      screen.setListItems("LISTBOX", lines);
      const listTop = screen.getNodeRect("LISTBOX")?.y ?? 0;
      const lastRow = screen.getDrawItems().filter(item => item.listRow?.listId === "LISTBOX").at(-1);
      const lineHeight = (fonts?.[1]?.font.descriptor.cellHeight ?? 23) / 480;
      const contentHeight = lastRow ? (lastRow.rect.y + lastRow.rect.height) - listTop : lines.length * lineHeight;
      let y = 1;
      screen.setNodePosition("LISTBOX", 0.0969, y);
      return {
        screen,
        actions: { BUTTON1: "back" },
        overRace,
        tick: dt => {
          y -= dt * CREDITS_SCROLL_RATE;
          if (y + contentHeight < 0) y = 1;
          screen.setNodePosition("LISTBOX", 0.0969, y);
        },
      };
    }

    case "OPTIONS_LANGUAGE": {
      const installed = ctx.languages ?? [];
      const actions: Record<string, MenuSceneAction> = {};
      let focus: string | undefined;
      LANGUAGE_BUTTONS.forEach((codes, i) => {
        const id = `BUTTON${i + 1}`;
        const code = codes.find(c => installed.includes(c));
        reveal(id, code !== undefined);
        if (!code) return;
        actions[id] = { settings: { language: code }, then: "back" };
        if (codes.includes(view.settings.language)) focus = id;
      });
      screen.setNodeText("TITLE", "TXT_PC_GAME_LANGUAGE_LANGUAGE_SELECTION");
      // ui_lang.c gives every BUTTONn a focus callback (`0x4b7280`) that runs the generic selection bar
      // (`0x4a3d60` → `0x4a2f10`): LANG's MENUBAR (RES_BOT + PCEnter) moves onto the focused language.
      screen.enableSelectionBar();
      if (focus) screen.setFocus(focus);
      applyInGame();
      return { screen, actions, overRace };
    }

    case "PAUSE": {
      // EXITREPLAY replaces RESTART during replays; RULES is for other game modes (its empty slot is authentic).
      for (const id of ["EXITREPLAY", "RULES"]) reveal(id, false);
      screen.enableSelectionBar();
      screen.setFocus("RESUME");
      returnFocus({ OPTIONS: "OPTIONS" });
      return {
        screen,
        actions: { RESUME: "resume", RESTART: "restart", OPTIONS: "options", RETIRE: "quit" },
      };
    }

    case "RESULTS": {
      const mode = ctx.resultsMode?.() ?? view.raceOptions.mode;
      screen.setNodeTexture("MODEICON", MODE_ICON_TEXTURES[mode]);
      screen.setNodeText("MODETITLE", MODE_TEXT_KEYS[mode].name);
      armVerticalBar(screen, "VERTICAL_BOTTOM_BAR");
      const update = (v: MenuView) => {
        const player = ctx.resultsPlayerIndex?.() ?? -1;
        screen.setNodeTextRaw("BUTTON1", player >= 0 ? formatFinishingPosition(ctx.translation, player + 1) : null);
        // The player's row uses the highlighted gold (255,249,135) the front end uses for focus.
        screen.setListItems("LISTBOX1", v.standings.map((row, i) => ({
          text: `${i + 1}  ${row.carName}`, colour: i === player ? [255, 249, 135, 255] : undefined,
        })));
        screen.setListItems("LISTBOX2", v.standings.map((row, i) => ({
          text: formatResultsRowTimes(row).time, colour: i === player ? [255, 249, 135, 255] : undefined,
        })));
      };
      update(view);
      // ui_rcres.c lays RCRES out by code, so the script's stacked rows (MODETITLE, BUTTON1 and LISTBOXBKG all
      // at y 0.4229) never show together: intro = mode title + finishing position, list hidden; the first
      // confirm slides both up and opens the list; the next confirm continues to RCEND.
      const { intro, list } = RCRES_LAYOUT;
      screen.setNodeSize("BUTTON1", 1, RCRES_LAYOUT.positionHeight);
      screen.setNodePosition("MODETITLE", 0, intro.modeTitleY);
      screen.setNodePosition("BUTTON1", 0, intro.positionY);
      screen.setNodePosition("LISTBOXBKG", 0, list.listY);
      screen.setNodeVisible("LISTBOXBKG", false);
      let listShown = false;
      let moveClock = 0;
      const showList = () => {
        if (listShown) return;
        listShown = true;
        moveClock = 0;
        screen.setNodeVisible("LISTBOXBKG", true);
        screen.restartAnimation("LISTBOXBKG");
      };
      const tick = (dt: number) => {
        if (!listShown || moveClock >= RCRES_LAYOUT.moveSeconds) return;
        moveClock = Math.min(RCRES_LAYOUT.moveSeconds, moveClock + Math.max(0, dt));
        const t = moveClock / RCRES_LAYOUT.moveSeconds;
        screen.setNodePosition("MODETITLE", 0, intro.modeTitleY + (list.modeTitleY - intro.modeTitleY) * t);
        screen.setNodePosition("BUTTON1", 0, intro.positionY + (list.positionY - intro.positionY) * t);
      };
      // A click on the position (BUTTON1) or the PCEnter prompt (MENUBAR / its icon / pulse) is a confirm, so
      // the pointer takes the same two steps as Enter: the first reveals the list, the second continues.
      const filterInput = (input: MenuInput): MenuInput => {
        const click = input.pointerClicked && (
          screen.hitTest(input.pointerX, input.pointerY)?.toLowerCase() === "button1"
          || drawItemAt(screen, ["MENUBAR", "MENUBAR_ICON", "MENUBAR_PULSE"], input.pointerX, input.pointerY) !== null);
        const confirmed = input.confirm || click;
        if (!confirmed) return input;
        if (!listShown) {
          showList();
          return { ...input, confirm: false, pointerClicked: false };
        }
        return { ...input, confirm: true, pointerClicked: false };
      };
      return { screen, actions: { BUTTON1: "continue" }, update, tick, filterInput };
    }

    case "RACE_END": {
      screen.setNodeTexture("FORDLOGO", FORD_RACE_LOGO);
      // VIEW REPLAY is greyed out (no replay system).
      screen.setNodeEnabled("REPLAY", false);
      screen.enableSelectionBar();
      screen.setFocus("RETRY");
      return { screen, actions: { RETRY: "restart", EXIT: "quit" } };
    }

    default:
      return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// In-race HUD wiring (HUD_PARITY_SPEC §3–§5): app state → `HudModelInput` for `buildHudDrawList`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Countdown chain time (§5.13): the chain starts when COUNTDOWN begins and the race starts on GO's keyframe c
 * (`COUNTDOWN_RACE_START_TIME`, 2.9 s), so RACING continues the chain until its 3.6 s end.
 */
export function raceCountdownTime(phase: RacePhase, phaseElapsed: number): number | undefined {
  if (phase === "COUNTDOWN") return Math.max(0, phaseElapsed);
  if (phase === "RACING") {
    const time = COUNTDOWN_RACE_START_TIME + Math.max(0, phaseElapsed);
    return time < COUNTDOWN_DURATION ? time : undefined;
  }
  return undefined;
}

/** Countdown sound for a chain step (0x68 "3", 0x69 "2", 0x67 "1", 0x66 "GO"). */
export function countdownStepSound(step: number): CountdownStep {
  return ([3, 2, 1, "GO"] as const)[Math.max(0, Math.min(3, Math.trunc(step)))]!;
}

/**
 * Launch banner on GO from the player's launch RPM. fr3.exe queues SUPER START / GOOD START / OVER REVS /
 * SHORT REVS from `0x50d19e`; its thresholds are not decoded [RE], so these bands are an approximation:
 * ≥92 % of MAX_RPM over-revs, 70–92 % super, 50–70 % good, 30–50 % short, and no banner when idling.
 */
export function classifyLaunch(rpm: number, maxRpm: number): LaunchResult | undefined {
  if (!(maxRpm > 0) || !Number.isFinite(rpm)) return undefined;
  const ratio = rpm / maxRpm;
  if (ratio >= 0.92) return "over";
  if (ratio >= 0.7) return "super";
  if (ratio >= 0.5) return "good";
  if (ratio >= 0.3) return "short";
  return undefined;
}

/** HUD wrong-way test (`0x52e390`): within 25 units of the path corridor and heading against it (dot < −0.2). */
export function isHudWrongWay(
  lateralOffset: number, halfWidth: number,
  pathForward: readonly [number, number, number], carForward: readonly [number, number, number],
): boolean {
  if (!(Math.abs(lateralOffset) - halfWidth < 25)) return false;
  const length = Math.hypot(pathForward[0], pathForward[2]) * Math.hypot(carForward[0], carForward[2]);
  if (!(length > 0)) return false;
  return (pathForward[0] * carForward[0] + pathForward[2] * carForward[2]) / length < -0.2;
}

/** Translated HUD labels (`TXT_INRACE_*`). */
export function hudLabels(translation: TranslationTable): Partial<Record<HudLabelKey, string>> {
  const labels: Partial<Record<HudLabelKey, string>> = {};
  for (const [label, key] of Object.entries(HUD_LABEL_KEYS) as [HudLabelKey, string][]) {
    const text = lookupTranslation(translation, key);
    if (text !== undefined) labels[label] = text;
  }
  return labels;
}

export interface RaceHudSource {
  readonly speedMps: number;
  readonly rpm: number;
  /** Engine MAX_RPM (ENGDATA). */
  readonly maxRpm: number;
  readonly gear: number;
  readonly units: SpeedUnits;
  /** CARDATA CAR_APPROXIMATE_TOP_SPEED (MPH). */
  readonly approxTopSpeedMph: number;
  /** Camera that drew this frame (INTRO hides the HUD) and the selected forward camera (for LOOK_BACK). */
  readonly cameraMode: CameraMode;
  readonly forwardCameraMode: CameraMode;
  readonly position: number;
  readonly participants: number;
  readonly lap: number;
  readonly laps: number;
  readonly currentLapSeconds: number;
  readonly lastLapSeconds?: number;
  readonly bestLapSeconds?: number;
  readonly mode: RaceMode;
  readonly boostActive: boolean;
  /** Seconds of boost left while burning. */
  readonly boostTimer: number;
  readonly boostCharges: number;
  readonly wrongWay: boolean;
  readonly phase: RacePhase;
  readonly phaseElapsed: number;
  readonly launchBanner?: { result: LaunchResult; time: number };
  readonly mapEnabled: boolean;
  readonly course: readonly HudPoint[];
  readonly cars: readonly HudVehicle[];
  readonly labels?: Partial<Record<HudLabelKey, string>>;
}

/** Assemble the authentic HUD input (§7.4): no total time, needle on MAX_RPM, boost bar only in RACING_BOOST. */
export function buildRaceHudInput(source: RaceHudSource): HudModelInput {
  const input: HudModelInput = {
    speedMps: source.speedMps,
    rpm: source.rpm,
    maxRpm: source.maxRpm,
    gear: source.gear,
    units: source.units,
    approxTopSpeedMph: source.approxTopSpeedMph,
    cameraGroup: cameraModeToHudGroup(source.cameraMode, cameraModeToHudGroup(source.forwardCameraMode)),
    position: source.position,
    participants: source.participants,
    lap: source.lap,
    laps: source.laps,
    currentLapSeconds: source.currentLapSeconds,
    lastLapSeconds: source.lastLapSeconds,
    bestLapSeconds: source.bestLapSeconds,
    mode: source.mode,
    wrongWay: source.wrongWay,
    countdownTime: raceCountdownTime(source.phase, source.phaseElapsed),
    launchBanner: source.launchBanner,
    map: { enabled: source.mapEnabled, course: source.course, cars: source.cars, localPlayers: 1 },
    labels: source.labels,
  };
  if (source.mode === "RACING_BOOST") {
    input.boost = {
      active: source.boostActive,
      elapsedFraction: source.boostActive ? clamp(1 - source.boostTimer / BOOST_BURN_SECONDS, 0, 1) : 0,
      // The native physics refills whole charges per lap; there is no partial 0..7 energy meter.
      energy: 0,
      charges: clamp(Math.trunc(source.boostCharges), 0, 2),
    };
  }
  return input;
}

/** Spread `count` picks evenly over `pool` (keeps a MIX field varied instead of the first cars in CARDATA). */
export function pickSpread<T>(pool: readonly T[], count: number): T[] {
  const n = Math.max(0, Math.min(pool.length, Math.trunc(count)));
  return Array.from({ length: n }, (_, k) => pool[Math.floor((k + 0.5) * pool.length / n)]!);
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
  private readonly uiResources: UiItemResources;
  /** Lazy UI texture loads in flight, or given up on after {@link LAZY_UI_TEXTURE_RETRIES} retries. */
  private readonly pendingUiTextures = new Set<string>();
  /** Failed attempts per lazily loaded UI texture key. */
  private readonly uiTextureFailures = new Map<string, number>();
  /** Large (≥1024²) screen textures uploaded for the open screen; released when a screen stops using them. */
  private uploadedScreenTextures = new Set<PcgEntry>();
  private activeScene?: AppMenuScene;
  private loadingSprites?: LoadingSprites;
  private loadingPhase = 0;

  private readonly carConfigs = new Map<string, ResolvedCarConfig>();
  private readonly compiledModels = new Map<string, CompiledModel>();
  /** In-flight `getOrCompileModel` work per model key, so concurrent callers share one GPU compile. */
  private readonly pendingModels = new Map<string, Promise<CompiledModel>>();

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
  private hudAtlasErrorReported = false;
  /** Bumped by every `ensureHudAtlas` call: only the latest unit request may attach its atlas. */
  private hudAtlasRequestSeq = 0;
  /** The HUD atlas whose sprites are on the GPU. */
  private uploadedHudAtlas?: HudAtlas;
  private hudLabelCache?: { table: TranslationTable; labels: Partial<Record<HudLabelKey, string>> };
  private readonly tickErrors = new TickErrorGuard();
  private errorRecoveryArmed = false;

  private frame?: number;
  private lastTime?: number;
  private clock = 0;
  private fps = 0;
  private status = "Initializing engine";
  private disposed = false;

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
    this.uiResources = {
      texture: key => this.resolveUiTexture(key),
      font: slot => assets.fonts[slot],
      onMissingTexture: key => this.requestUiTexture(key),
    };

    for (const cfg of assets.installedCars) {
      this.carConfigs.set(cfg.car.id, cfg);
    }

    const menuCars: MenuCar[] = assets.installedCars.map(cfg => ({
      id: cfg.car.id,
      name: formatCarDisplayName(assets, cfg),
      liveries: cfg.car.liveries.map(l => l.type),
      group: cfg.car.fields.CAR_GROUP_TYPE,
      ratings: computeCarRatings(cfg),
    }));

    const menuTracks: MenuTrack[] = assets.installedTracks.map(track => ({
      id: track.id,
      name: formatTrackDisplayName(assets, track),
      group: track.TRACK_GROUP_TYPE,
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

    const sceneContext: MenuSceneContext = {
      readFile: assets.readUiScript,
      get translation() { return assets.translation; },
      getTextureSize: assets.getUiTextureSize,
      fonts: assets.fonts,
      languages: assets.languages,
      cars: menuCars,
      resultsMode: () => this.activeRace?.setup.mode,
      resultsPlayerIndex: () => this.activeRace?.resultsPlayerIndex,
    };

    this.menu = new MenuController({
      cars: menuCars,
      trackId: assets.defaultTrackId,
      tracks: menuTracks,
      quickRaces,
      languages: assets.languages,
      input: this.input,
      createScene: (state, viewState) => {
        const scene = buildMenuScene(state, viewState, sceneContext);
        this.activeScene = scene;
        this.uploadScreenTextures(scene?.screen);
        return scene;
      },
    });

    this.previousTabIndex = canvas.getAttribute("tabindex");
    if (this.previousTabIndex === null) canvas.tabIndex = 0;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
  }

  /**
   * Resolve every texture the front end can show (all MENU_SCREEN_SCRIPTS plus the code-set textures of table
   * B-T) and the loading-screen sprites up front, so no menu or loading graphic pops in lazily.
   */
  async prepare(): Promise<void> {
    if (!this.assets.installedCars.length) throw new Error("No installed car models were found");
    this.setStatus("Loading interface graphics");
    const scripts = Object.values(MENU_SCREEN_SCRIPTS).filter((path): path is string => path !== null);
    const [, loading] = await Promise.allSettled([
      this.assets.preloadUiTextures(scripts, CODE_SET_UI_TEXTURES),
      this.assets.loadLoadingSprites(),
    ]);
    if (loading?.status === "fulfilled") {
      this.loadingSprites = loading.value;
      this.ui.preloadTextures([loading.value.load, loading.value.bar, loading.value.bar2]);
    }
    if (this.disposed) return;
    this.applySettings(this.menu.getView().settings);
    // Re-open the current screen now that AUTOSIZE / STRETCH_GRAPHIC 0 sizes are known and textures resolve.
    this.menu.rebuildScene();
    this.setStatus("Press any key or click to start");
  }

  start(): void {
    if (this.disposed || this.frame !== undefined || this.gl.gl.isContextLost()) return;
    this.input.attach(this.view, this.canvas);
    this.view.addEventListener("keydown", this.onMenuHotkey);
    this.canvas.focus();
    this.frame = this.view.requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.frame !== undefined) this.view.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.lastTime = undefined;
    this.fps = 0;
    this.view.removeEventListener("keydown", this.onMenuHotkey);
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
    const target = carId && this.carConfigs.has(carId) ? carId : undefined;
    if (target) {
      if (this.menu.getView().state !== "CAR_SELECT") this.menu.activate("select-car");
      const group = this.carConfigs.get(target)!.car.fields.CAR_GROUP_TYPE;
      // Cars step within their CAR.UI class, so pick the class first.
      for (let i = 0; i < 16 && this.menu.getView().car?.group !== group; i++) {
        if (!this.menu.activate("next-car-group")) break;
      }
      for (let i = 0; i < this.assets.installedCars.length && this.menu.getView().car?.id !== target; i++) {
        if (!this.menu.activate("next-car")) break;
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
    this.hudAtlasRequestSeq++;
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.disarmErrorRecovery();
    if (this.previousTabIndex === null) this.canvas.removeAttribute("tabindex");
    for (const model of this.compiledModels.values()) model.dispose();
    this.compiledModels.clear();
    this.pendingModels.clear();
    this.pendingUiTextures.clear();
    this.uploadedScreenTextures.clear();
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
    const status: Partial<Record<MenuState, string>> = {
      MAIN_MENU: "Main menu",
      MODE_SELECT: "Select race type",
      CAR_SELECT: view.car ? `Select Car: ${view.car.name}` : "Select Car",
      TRACK_SELECT: view.track ? `Select Track: ${view.track.name}` : "Select Track",
      RACE_OPTIONS: "Race settings",
      OPTIONS: "Options",
      OPTIONS_GAME: "Game options",
      OPTIONS_AUDIO: "Audio options",
      OPTIONS_DISPLAY: "Display options",
      OPTIONS_CONTROLS: "Control options",
      OPTIONS_CREDITS: "Credits",
      OPTIONS_LANGUAGE: "Language",
      PAUSE: "Paused",
      RESULTS: "Race finished",
      RACE_END: "Race finished",
    };
    const text = status[next];
    if (text) this.setStatus(text);
  }

  /**
   * Keys fr3's screens read directly: CAR.UI's COLOUR_ICON is the C key (livery; L too), `[`/`]` and PageUp/Down
   * step the track from Car Select, and L opens LANG.UI from the options hub (OPTS.UI has no language button).
   */
  private readonly onMenuHotkey = (event: KeyboardEvent): void => {
    if (this.disposed) return;
    const state = this.menu.getView().state;
    let action: Parameters<MenuController["activate"]>[0] | undefined;
    if (state === "CAR_SELECT") {
      if (event.code === "BracketLeft" || event.code === "PageUp") action = "previous-track";
      else if (event.code === "BracketRight" || event.code === "PageDown") action = "next-track";
      else if (event.code === "KeyC" || event.code === "KeyL") action = "next-livery";
    } else if (state === "OPTIONS" && event.code === "KeyL") {
      action = "options-language";
    }
    if (!action) return;
    event.preventDefault();
    this.menu.activate(action);
    this.processCommands();
  };

  private readonly onContextLost = (): void => {
    this.loadRequestSeq++;
    this.turntableRequest++;
    this.hudAtlasRequestSeq++;
    this.stop();
    this.setStatus("WebGL2 context lost");
    this.options.onError?.(new Error("WebGL2 context lost. Press Restart to reload."));
  };

  /** Return a loaded UI texture and track large (≥1024²) entries drawn by the open screen for later release. */
  private resolveUiTexture(registeredKey: string): PcgEntry | undefined {
    const entry = this.assets.getLoadedUiTexture(registeredKey);
    if (entry && isLargeUiTexture(entry)) this.uploadedScreenTextures.add(entry);
    return entry;
  }

  /**
   * Lazy fallback for a texture nothing preloaded (e.g. a code-set texture outside table B-T, or an AUTOSIZE
   * node whose size is still unknown). A failed fetch/decode frees the key for up to
   * {@link LAZY_UI_TEXTURE_RETRIES} retries, then the key stays parked so a broken asset never refetches every
   * frame. Large (≥ 1024²) textures upload only while a screen referencing them is still open, and join
   * that screen's large set so the next screen change releases them.
   */
  private requestUiTexture(registeredKey: string): void {
    if (this.pendingUiTextures.has(registeredKey) || this.disposed) return;
    this.pendingUiTextures.add(registeredKey);
    const screen = this.menu.screen;
    const fail = () => {
      const failures = (this.uiTextureFailures.get(registeredKey) ?? 0) + 1;
      this.uiTextureFailures.set(registeredKey, failures);
      if (failures <= LAZY_UI_TEXTURE_RETRIES) this.pendingUiTextures.delete(registeredKey);
    };
    void this.assets.getPcgEntry(registeredKey).then(entry => {
      if (this.disposed) return;
      if (!entry) {
        fail();
        return;
      }
      this.pendingUiTextures.delete(registeredKey);
      this.uiTextureFailures.delete(registeredKey);
      if (this.gl.gl.isContextLost()) return;
      if (isLargeUiTexture(entry)) {
        const current = this.menu.screen;
        const stillNeeded = current !== undefined && (
          current === screen
          || current.getTextureRefs().some(ref => ref.registeredKey === registeredKey)
        );
        if (!stillNeeded) return;
        this.uploadedScreenTextures.add(entry);
      }
      this.ui.preloadTextures([entry]);
    }, () => {
      if (!this.disposed) fail();
    });
  }

  /** Lazy-load the visible textures the open screen cannot size yet (AUTOSIZE nodes are skipped until then). */
  private requestPendingScreenTextures(screen: UiScreenInstance): void {
    for (const target of screen.getPendingTextureRefs()) this.requestUiTexture(target.registeredKey);
  }

  /** Upload a screen's textures as it opens (no first-draw hitch) and free big backgrounds it no longer uses. */
  private uploadScreenTextures(screen: UiScreenInstance | undefined): void {
    if (this.disposed) return;
    const entries = (screen?.getTextureRefs() ?? [])
      .map(ref => this.assets.getLoadedUiTexture(ref.registeredKey))
      .filter((entry): entry is PcgEntry => entry !== undefined);
    this.ui.preloadTextures(entries);
    const large = new Set(entries.filter(isLargeUiTexture));
    for (const entry of this.uploadedScreenTextures) if (!large.has(entry)) this.ui.releaseTexture(entry);
    this.uploadedScreenTextures = large;
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

  /**
   * The compiled model for a shape folder + livery. Concurrent callers (turntable and race load, or two race
   * slots with the same car) share one in-flight compile, and nothing compiles after `dispose()` or a lost
   * context.
   */
  private getOrCompileModel(dir: string, livery?: string): Promise<CompiledModel> {
    const key = `${dir.toLowerCase()}::${(livery ?? "").toLowerCase()}`;
    const existing = this.compiledModels.get(key);
    if (existing && !existing.isDisposed) return Promise.resolve(existing);
    const inFlight = this.pendingModels.get(key);
    if (inFlight) return inFlight;
    const pending = (async () => {
      const bundle = await this.assets.load3dBundle(dir);
      if (this.disposed || this.gl.gl.isContextLost()) throw new Error("Model compile cancelled: the engine was disposed or lost its WebGL context");
      const cached = this.compiledModels.get(key);
      if (cached && !cached.isDisposed) return cached;
      const compiled = this.scene.compileModel(bundle.xbx, bundle.textures, bundle.binInfo, bundle.scene, { livery });
      this.compiledModels.set(key, compiled);
      return compiled;
    })();
    this.pendingModels.set(key, pending);
    const settle = () => {
      if (this.pendingModels.get(key) === pending) this.pendingModels.delete(key);
    };
    pending.then(settle, settle);
    return pending;
  }

  private async loadTurntableCar(carId: string, livery?: string): Promise<void> {
    // Every request supersedes the one in flight, including a return to the car already shown (A -> B -> A).
    const req = ++this.turntableRequest;
    const cfg = this.carConfigs.get(carId);
    if (!cfg || this.disposed || this.gl.gl.isContextLost()) return;
    const key = `${cfg.shapeFolder}::${livery ?? ""}`;
    if (key === this.turntableKey && this.turntableModel && !this.turntableModel.isDisposed) {
      this.setStatus(`Select Car: ${formatCarDisplayName(this.assets, cfg)}`);
      return;
    }
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
    // AUDIO.UI "ENGINE / EFFECTS" drives both the engine and the effects buses.
    this.audio.setVolume("sfx", settings.sfxVolume * settings.engineVolume);
    this.audio.setVolume("engine", settings.engineVolume);
    if (settings.language !== this.assets.language && this.assets.languages.includes(settings.language)) {
      this.assets.setLanguage(settings.language);
      this.menu.rebuildScene();
    }
    const race = this.activeRace;
    if (race) {
      race.racers[0]!.physics.automatic = settings.transmission === "AUTO";
      void this.ensureHudAtlas(race, settings.speedUnits);
    }
  }

  /**
   * Attach the fr3.exe HUD atlas for the chosen units (MPH / KPH speedo numerals). Every call bumps
   * `hudAtlasRequestSeq`, even when `units` is already attached, so a slower earlier request (MPH -> KPH -> MPH)
   * can never attach a stale atlas. The swap shares the common collections and frees only the old
   * unit-specific dial sprites.
   */
  private async ensureHudAtlas(race: ActiveRace, units: SpeedUnits): Promise<void> {
    const req = ++this.hudAtlasRequestSeq;
    if (race.hudAtlas?.units === units) return;
    const { atlas, error } = await this.loadHudAtlasResult(units);
    if (!this.isCurrentHudAtlasRequest(req, units) || this.activeRace !== race) return;
    if (error) {
      this.reportHudAtlasError(error);
      return;
    }
    if (!atlas) return;
    this.attachHudAtlas(race, atlas);
  }

  private isCurrentHudAtlasRequest(req: number, units: SpeedUnits): boolean {
    return req === this.hudAtlasRequestSeq && !this.disposed && !this.gl.gl.isContextLost()
      && this.menu.getView().settings.speedUnits === units;
  }

  private reportHudAtlasError(cause: unknown): void {
    if (this.hudAtlasErrorReported) return;
    this.hudAtlasErrorReported = true;
    this.options.onError?.(asError(cause));
  }

  /**
   * Upload `next`'s sprites and release the GPU textures of the previously uploaded atlas that `next` does not
   * share (DemoAssets caches the GENERIC / PANEL / REV / NUMBERS / MISC entries, so only the MPH or KPH dial
   * sprites differ between units).
   */
  private swapHudAtlas(next: HudAtlas): void {
    const keep = new Set(next.sprites.values());
    this.ui.preloadTextures(keep);
    const previous = this.uploadedHudAtlas;
    if (previous && previous !== next) {
      for (const sprite of previous.sprites.values()) if (!keep.has(sprite)) this.ui.releaseTexture(sprite);
    }
    this.uploadedHudAtlas = next;
  }

  private attachHudAtlas(race: ActiveRace, atlas: HudAtlas): void {
    try {
      this.swapHudAtlas(atlas);
      race.hudAtlas = atlas;
    } catch (cause) {
      race.hudAtlas = undefined;
      if (!this.disposed && !this.gl.gl.isContextLost()) this.reportHudAtlasError(cause);
    }
  }

  /** Resolve (not upload) the HUD atlas for `units`, capturing any error so callers decide if it is still current. */
  private async loadHudAtlasResult(units: SpeedUnits): Promise<{ atlas?: HudAtlas; error?: Error }> {
    try {
      return { atlas: await this.assets.loadHudAtlas(units) };
    } catch (cause) {
      return { error: asError(cause) };
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
        // Invalidate in-flight loadRace / HUD atlas requests (Esc on LOADING) so nothing stale attaches or errors.
        this.loadRequestSeq++;
        this.hudAtlasRequestSeq++;
        this.activeRace = undefined;
        this.audio.update({ rpm: 0, speedMps: 0, tyreSlip: 0 });
        this.setStatus("Main menu");
        break;
    }
  }

  /** ROPT.UI OPPS / FIELD: the opponent field (preset ids first, then a MIX spread or same-class MATCH cars). */
  private pickOpponents(setup: RaceSetup, player: ResolvedCarConfig): string[] {
    const count = clamp(Math.trunc(setup.opponents ?? 5), 0, 5);
    const preset = (setup.opponentIds ?? []).filter(id => this.carConfigs.has(id) && id !== player.car.id);
    const others = this.assets.installedCars.map(c => c.car.id).filter(id => id !== player.car.id && !preset.includes(id));
    const group = player.car.fields.CAR_GROUP_TYPE;
    const sameClass = others.filter(id => this.carConfigs.get(id)!.car.fields.CAR_GROUP_TYPE === group);
    const missing = Math.max(0, count - preset.length);
    let fill: string[];
    if (setup.fieldType === "MATCH") {
      fill = pickSpread(sameClass, missing);
      if (fill.length < missing) fill.push(...pickSpread(others.filter(id => !sameClass.includes(id)), missing - fill.length));
    } else {
      fill = pickSpread(others, missing);
    }
    return [...preset, ...fill].slice(0, count);
  }

  private async loadRace(requestId: number, setup: RaceSetup): Promise<void> {
    const seq = ++this.loadRequestSeq;
    const trackId = setup.trackId || this.assets.defaultTrackId;
    const trackKey = trackId.toLowerCase();
    const trackRecord = this.assets.tables.tracks.get(trackKey);
    const trackName = trackRecord ? formatTrackDisplayName(this.assets, trackRecord) : trackId;
    this.setStatus(`Loading ${trackName} track and cars...`);
    this.menu.setLoadProgress(requestId, 0.08);
    let prepared: {
      activeRace: ActiveRace;
      hudUnits: SpeedUnits;
      hudResult: { atlas?: HudAtlas; error?: Error };
      playerCfg: ResolvedCarConfig;
    };
    try {
      const hudUnits = this.menu.getView().settings.speedUnits;
      const [trackBundle, trackData, hudResult] = await Promise.all([
        this.assets.load3dBundle(trackDirectory(trackId)),
        this.assets.loadTrackData(trackId),
        this.loadHudAtlasResult(hudUnits),
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
      const opponentIds = this.pickOpponents(setup, playerCfg);

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
        // The fr3 countdown chain (§5.13) starts the race on GO's keyframe c, 2.9 s after "3" appears.
        countdownStepSeconds: COUNTDOWN_RACE_START_TIME / 3,
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
      // Minimap course = the AI path / racing-line X/Z points (§5.12).
      const courseMap = racingLine.points.map(pt => ({ x: pt.position[0], z: pt.position[2] }));

      const activeRace: ActiveRace = {
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
        hudAtlas: undefined,
        lastPhase: race.phase,
        playerWrongWay: false,
        playerCompletedLaps: 0,
        playerLapStart: 0,
        finishHoldTimer: 0,
        finishedReported: false,
      };
      this.menu.setLoadProgress(requestId, 1);
      prepared = { activeRace, hudUnits, hudResult, playerCfg };
    } catch (cause) {
      if (seq !== this.loadRequestSeq || this.disposed) return;
      const err = asError(cause);
      if (!this.menu.failLoad(requestId, err.message)) return;
      this.setStatus(`Load failed: ${err.message}`);
      this.options.onError?.(err);
      return;
    }

    // Only a load that is still current (not cancelled by Esc / a newer launch / dispose) and that the menu
    // accepts becomes the active race; nothing is attached, played or reported for a stale one.
    if (seq !== this.loadRequestSeq || this.disposed || !this.menu.completeLoad(requestId)) return;
    this.activeRace = prepared.activeRace;
    const units = this.menu.getView().settings.speedUnits;
    if (prepared.hudResult.atlas?.units === units && !this.gl.gl.isContextLost()) {
      this.hudAtlasRequestSeq++;
      this.attachHudAtlas(prepared.activeRace, prepared.hudResult.atlas);
    } else if (prepared.hudResult.error && prepared.hudUnits === units) {
      if (!this.gl.gl.isContextLost()) this.reportHudAtlasError(prepared.hudResult.error);
    } else if (!this.gl.gl.isContextLost()) {
      void this.ensureHudAtlas(prepared.activeRace, units);
    }
    void this.loadSharedAudioOnce();
    void this.loadEngineBankForCar(prepared.playerCfg);
    this.setStatus(formatRacingStatus(formatCarDisplayName(this.assets, prepared.playerCfg), trackName));
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

  /** Every front-end state runs through `MenuController.update` (focus, left/right values, confirm, back, pointer). */
  private stepMenu(dt: number, frame: InputFrame): void {
    const before = this.menu.getView();
    if (before.state === "CAR_SELECT" && before.carSelectPage === "ITEM") {
      this.turntableAngle = (this.turntableAngle + dt * 0.6) % (2 * Math.PI);
    }
    // fr3 advances the loading chaser by 1/60 per frame (0x4b7400).
    if (before.state === "LOADING") this.loadingPhase = stepLoadingPhase(this.loadingPhase);

    const gl = this.gl.gl;
    const [uiPointerX, uiPointerY] = canvasToUiPoint(
      frame.menu.pointerX, frame.menu.pointerY, gl.drawingBufferWidth, gl.drawingBufferHeight, MENU_VIEWPORT,
    );
    let menuInput: MenuInput = { ...frame.menu, pointerX: uiPointerX, pointerY: uiPointerY };
    const scene = this.currentScene();
    if (scene?.filterInput) menuInput = scene.filterInput(menuInput);
    this.menu.update(dt, { driving: frame.driving, menu: menuInput });
    this.processCommands();
    this.activeScene?.tick?.(dt, this.menu.getView());
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
        ctrl = playerDrivingInput(active.setup.mode, driving);
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
        const referenceGap = aiReferenceGap(active.setup,
          ((standing?.progress ?? 0) - playerProgressTotal) * racingLine.length);
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
      if (r.isPlayer) {
        active.playerWrongWay = isHudWrongWay(prog.lateralOffset, prog.halfWidth, prog.forward, after.forward);
      }
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

    // Countdown sounds fire at each chain step's keyframe a (0x68 / 0x69 / 0x67 / 0x66).
    const countdownTime = raceCountdownTime(active.race.phase, active.race.phaseElapsed);
    const countdown = countdownTime === undefined ? null : countdownFrame(countdownTime);
    if (countdown && countdown.step !== active.lastCountdownStep) {
      active.lastCountdownStep = countdown.step;
      this.audio.playCountdown(countdownStepSound(countdown.step));
    }

    const ps = playerSlot.physics.state;
    // GO: classify the launch from the revs the player held on the line (colpan banner, §5.14).
    if (active.race.phase === "RACING" && active.lastPhase !== "RACING" && active.lastPhase !== "FINISHED") {
      const result = classifyLaunch(ps.rpm, playerSlot.config.engine.fields.MAX_RPM ?? ps.maxRpm);
      if (result) active.launchBanner = { result, start: active.race.elapsedRaceTime };
    }
    active.lastPhase = active.race.phase;

    for (const s of active.race.standings) {
      const slot = active.racers.find(r => r.id === s.id);
      if (slot && s.lap > slot.lastLap) {
        slot.lastLap = s.lap;
        if (active.setup.mode === "RACING_BOOST") {
          slot.physics.replenishBoost(s.completedLaps, active.setup.laps);
        }
      }
      if (s.isPlayer) {
        // LAST lap row: the finish crossing time minus the previous lap start.
        if (s.completedLaps > active.playerCompletedLaps) {
          const lapStart = s.finishTime ?? active.race.elapsedRaceTime - s.lapTime;
          active.playerLastLap = lapStart - active.playerLapStart;
          active.playerLapStart = lapStart;
          active.playerCompletedLaps = s.completedLaps;
        } else if (s.lapTime > 0) {
          active.playerLapStart = active.race.elapsedRaceTime - s.lapTime;
        }
      }
    }

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
        active.resultsPlayerIndex = standings.findIndex(s => s.isPlayer);
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
    const race = this.activeRace;
    // PAUSE, RCRES, RCEND and in-game OPTS have no background: the race shows through.
    const raceUnderneath = race !== undefined && (view.state === "IN_GAME" || view.state === "PAUSE"
      || view.state === "RESULTS" || view.state === "RACE_END" || view.inGameOptions);

    if (raceUnderneath) {
      this.renderRace3d(race, width, height);
    } else {
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    if (view.state === "IN_GAME" && race) {
      this.renderRaceHud(race, view.settings, width, height);
      return;
    }
    if (view.state === "LOADING") {
      this.renderLoadingScreen(view, width, height);
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
    const banner = active.launchBanner;
    const input = buildRaceHudInput({
      speedMps: ps.speedMps,
      rpm: ps.rpm,
      maxRpm: player.config.engine.fields.MAX_RPM ?? ps.maxRpm,
      gear: ps.gear,
      units: settings.speedUnits,
      approxTopSpeedMph: player.config.car.fields.CAR_APPROXIMATE_TOP_SPEED ?? 150,
      cameraMode: active.cameraView.modeName,
      forwardCameraMode: active.camera.mode,
      position: playerStanding.place,
      participants: active.racers.length,
      lap: playerStanding.lap,
      laps: active.setup.laps,
      currentLapSeconds: playerStanding.lapTime,
      lastLapSeconds: active.playerLastLap,
      bestLapSeconds: playerStanding.bestLapTime ?? undefined,
      mode: active.setup.mode,
      boostActive: ps.boostActive,
      boostTimer: ps.boostTimer,
      boostCharges: ps.boostCharges,
      wrongWay: active.playerWrongWay,
      phase: active.race.phase,
      phaseElapsed: active.race.phaseElapsed,
      launchBanner: banner && { result: banner.result, time: active.race.elapsedRaceTime - banner.start },
      mapEnabled: settings.trackMap,
      course: active.courseMap,
      cars: active.racers.map(r => ({
        id: r.id, x: r.physics.state.position[0], z: r.physics.state.position[2], local: r.isPlayer, active: true,
      })),
      labels: this.currentHudLabels(),
    });
    const fonts = this.assets.fonts;
    // HUD labels are font 2; the HUD keeps the 4:3 layout table 0 ("fit") so dials stay round.
    this.ui.renderHud(input, width, height, { body: fonts[2] ?? fonts[0]!, display: fonts[4] },
      { atlas: active.hudAtlas }, "fit");
  }

  /** `TXT_INRACE_*` labels for the active language (re-read only when the language changes). */
  private currentHudLabels(): Partial<Record<HudLabelKey, string>> {
    const table = this.assets.translation;
    if (this.hudLabelCache?.table !== table) this.hudLabelCache = { table, labels: hudLabels(table) };
    return this.hudLabelCache.labels;
  }

  /** LOADING (fr3.exe 0x4b7400): full-screen LOAD, the 9-segment chaser and the right-aligned caption only. */
  private renderLoadingScreen(view: MenuView, width: number, height: number): void {
    const sprites = this.loadingSprites;
    const font = this.assets.fonts[2];
    const batch = new UiBatchBuilder(width, height);
    const caption = view.loadingError ?? lookupTranslation(this.assets.translation, "TXT_GENERAL_LOADING") ?? "LOADING";
    if (sprites) {
      drawLoadingScreen(batch, sprites, this.loadingPhase, { text: caption, font });
    } else if (font) {
      batch.text({ x: 0, y: 0.856, width: 0.948437, height: 29 / 480 }, font, caption, { justify: 2 });
    }
    this.ui.render(batch.build(), width, height, MENU_VIEWPORT);
  }

  /** The AppMenuScene behind `menu.screen` (undefined while a state has no scene). */
  private currentScene(): AppMenuScene | undefined {
    const scene = this.activeScene;
    return scene && scene.screen === this.menu.screen ? scene : undefined;
  }

  /**
   * Paint the active `.UI` screen as resolved (fills, textures, text; `menuDrawItems` drops the background of
   * in-game options and greys disabled rows). CAR.UI then draws the 3D turntable over CAR.PSD: the UI batch
   * (background first) is flushed before `renderCarTurntable`, which only clears depth in its viewport.
   */
  private renderMenuUi(view: MenuView, width: number, height: number): void {
    const screen = this.menu.screen;
    if (!screen) return;
    const batch = new UiBatchBuilder(width, height);
    const scene = this.currentScene();
    drawUiDrawItems(batch, scene ? menuDrawItems(scene) : screen.getDrawItems(), this.uiResources);
    this.requestPendingScreenTextures(screen);
    this.ui.render(batch.build(), width, height, MENU_VIEWPORT);
    if (view.state === "CAR_SELECT" && view.carSelectPage === "ITEM"
      && this.turntableModel && !this.turntableModel.isDisposed) {
      this.scene.renderCarTurntable(this.turntableModel, this.turntableAngle, CAR_TURNTABLE_RECT, width, height);
    }
  }
}
