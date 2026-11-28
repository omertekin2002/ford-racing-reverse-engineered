import type { PcgEntry } from "../formats/pcg";

export type SpeedUnits = "MPH" | "KPH";

export interface HudPoint {
  x: number;
  z: number;
}

export interface HudVehicle extends HudPoint {
  id: string;
  local?: boolean;
  active?: boolean;
}

export interface HudTelemetry {
  speedMps: number;
  rpm: number;
  redlineRpm: number;
  gear: number;
  boostCharges?: number;
  boostActive?: boolean;
  boostRemainingFraction?: number;
}

export interface HudRaceState {
  position: number;
  participants: number;
  lap: number;
  laps: number;
  currentLapSeconds?: number;
  bestLapSeconds?: number;
  totalSeconds?: number;
  countdown?: 1 | 2 | 3 | "go";
  wrongWay?: boolean;
  banner?: "final-lap" | "lap-record";
}

export interface HudOptions {
  speedUnits: SpeedUnits;
  /** Full-scale speed for the current vehicle's gauge, in m/s. */
  speedometerMaxMps: number;
  /** Optional angle in radians at zero speed and the clockwise sweep. */
  speedometerArc?: { start: number; sweep: number };
  minimap?: {
    course: readonly HudPoint[];
    cars: readonly HudVehicle[];
    /** Width and height in the renderer's virtual viewport. */
    viewport: { width: number; height: number };
    /** Normalized position of the map's center. */
    anchor: HudMapPoint;
    /** Maximum map extent in the same units as the viewport. */
    extent: number;
    maxSamples?: number;
  };
}

export interface HudMapPoint {
  x: number;
  y: number;
}

export interface HudMinimap {
  outline: HudMapPoint[];
  markers: (HudMapPoint & { id: string; local: boolean })[];
}

export interface HudViewModel {
  speed: number;
  speedUnits: SpeedUnits;
  speedometerFraction: number;
  speedometerAngle: number;
  rpm: number;
  redlineRpm: number;
  rpmFraction: number;
  gear: string;
  boostCharges: number;
  boostActive: boolean;
  boostRemainingFraction: number;
  position: string;
  participants: string;
  ordinalPosition: string;
  lap: string;
  laps: string;
  currentLapTime: string | null;
  bestLapTime: string | null;
  totalTime: string | null;
  countdown: string | null;
  wrongWay: boolean;
  banner: HudRaceState["banner"];
  minimap: HudMinimap | null;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const finite = (value: number) => Number.isFinite(value) ? value : 0;
const fraction = (value: number) => clamp(finite(value), 0, 1);

export function formatRaceTime(seconds: number): string | null {
  if (!Number.isFinite(seconds)) return null;
  const centiseconds = Math.round(Math.abs(seconds) * 100);
  if (!Number.isSafeInteger(centiseconds)) return null;
  const minutes = Math.floor(centiseconds / 6000);
  const wholeSeconds = Math.floor(centiseconds / 100) % 60;
  const remainder = centiseconds % 100;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${seconds < 0 ? "-" : ""}${pad(minutes)}:${pad(wholeSeconds)}.${pad(remainder)}`;
}

function ordinal(position: number): string {
  const exceptional = position % 100 >= 11 && position % 100 <= 13;
  const suffix = exceptional ? "TH" : ["TH", "ST", "ND", "RD"][position % 10] ?? "TH";
  return `${position}${suffix}`;
}

function projectMinimap(config: NonNullable<HudOptions["minimap"]>): HudMinimap | null {
  const { viewport, anchor, extent, course, cars } = config;
  if (course.length < 2 || !(viewport.width > 0 && viewport.height > 0 && extent > 0)) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of course) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) return null;
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }

  const span = Math.max(maxX - minX, maxZ - minZ);
  if (!(span > 0 && Number.isFinite(span))) return null;
  const scale = extent / span;
  const centerX = minX + (maxX - minX) / 2;
  const centerZ = minZ + (maxZ - minZ) / 2;
  const project = ({ x, z }: HudPoint): HudMapPoint => ({
    x: anchor.x + (x - centerX) * scale / viewport.width,
    y: anchor.y - (z - centerZ) * scale / viewport.height,
  });

  const sampleLimit = Math.max(3, Math.floor(finite(config.maxSamples ?? 128)));
  const count = Math.min(course.length, sampleLimit);
  const outline = Array.from({ length: count }, (_, index) => project(course[Math.floor(index * course.length / count)]!));
  outline.push(project(course[0]!));
  const markers = cars
    .filter(car => car.active !== false && Number.isFinite(car.x) && Number.isFinite(car.z))
    .map(car => ({ ...project(car), id: car.id, local: car.local === true }))
    .sort((a, b) => Number(a.local) - Number(b.local));
  return { outline, markers };
}

/**
 * @deprecated Procedural view model from before the fr3.exe HUD audit; nothing renders it. Use
 * {@link buildHudDrawList}, which reproduces `hud.c`/`huditems.c` exactly.
 */
export function buildHudViewModel(
  telemetry: HudTelemetry,
  race: HudRaceState,
  options: HudOptions,
): HudViewModel {
  const speedMps = Math.abs(finite(telemetry.speedMps));
  const speedometerFraction = fraction(speedMps / options.speedometerMaxMps);
  const rpm = Math.max(0, finite(telemetry.rpm));
  const redlineRpm = Math.max(0, finite(telemetry.redlineRpm));
  const participants = Math.max(0, Math.trunc(finite(race.participants)));
  const position = clamp(Math.trunc(finite(race.position)), 0, participants);
  const laps = Math.max(1, Math.trunc(finite(race.laps)));
  const gear = telemetry.gear;
  const count = race.countdown;
  const arc = options.speedometerArc;
  return {
    speed: Math.round(speedMps * (options.speedUnits === "MPH" ? 2.2369363 : 3.6)),
    speedUnits: options.speedUnits,
    speedometerFraction,
    speedometerAngle: arc ? arc.start + speedometerFraction * arc.sweep : speedometerFraction,
    rpm,
    redlineRpm,
    rpmFraction: fraction(rpm / redlineRpm),
    gear: gear === -1 ? "R" : gear === 0 ? "N" : Number.isSafeInteger(gear) && gear > 0 ? String(gear) : "",
    boostCharges: clamp(Math.trunc(finite(telemetry.boostCharges ?? 0)), 0, 2),
    boostActive: telemetry.boostActive === true,
    boostRemainingFraction: fraction(telemetry.boostRemainingFraction ?? 0),
    position: String(position),
    participants: String(participants),
    ordinalPosition: position === 0 ? "" : ordinal(position),
    lap: String(clamp(Math.trunc(finite(race.lap)), 1, laps)),
    laps: String(laps),
    currentLapTime: formatRaceTime(race.currentLapSeconds ?? NaN),
    bestLapTime: formatRaceTime(race.bestLapSeconds ?? NaN),
    totalTime: formatRaceTime(race.totalSeconds ?? NaN),
    countdown: count === "go" ? "GO!" : count === undefined ? null : String(count),
    wrongWay: race.wrongWay === true,
    banner: race.banner,
    minimap: options.minimap ? projectMinimap(options.minimap) : null,
  };
}

export interface ResultsRowTimes {
  readonly totalSeconds: number | null;
  readonly bestLapSeconds: number | null;
  readonly gapSeconds: number | null;
  readonly finished?: boolean;
  readonly lapsDown?: number;
}

/**
 * Format the TIME / BEST columns of a results row. Finished racers show their finish time; unfinished
 * racers show `+N LAP(S)` when lapped, an estimated `+S.SSs` gap on the lead lap, or `DNF` — never a
 * borrowed finish time.
 */
export function formatResultsRowTimes(row: ResultsRowTimes): { time: string; best: string } {
  const best = row.bestLapSeconds !== null ? (formatRaceTime(row.bestLapSeconds) ?? "--:--.--") : "--:--.--";
  const finished = row.finished ?? row.totalSeconds !== null;
  if (finished && row.totalSeconds !== null) {
    return { time: formatRaceTime(row.totalSeconds) ?? "--:--.--", best };
  }
  const lapsDown = Math.floor(row.lapsDown ?? 0);
  if (lapsDown >= 1) return { time: `+${lapsDown} ${lapsDown === 1 ? "LAP" : "LAPS"}`, best };
  if (row.gapSeconds !== null && Number.isFinite(row.gapSeconds) && row.gapSeconds >= 0) {
    const gap = row.gapSeconds;
    return { time: gap >= 60 ? `+${formatRaceTime(gap)}` : `+${gap.toFixed(2)}s`, best };
  }
  return { time: "DNF", best };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Authentic fr3.exe (Shuffle) in-race HUD: `\fr3\source\overlay\hud.c` (0x529810–0x52fafb) + `huditems.c`.
// Everything below is in 640×480 virtual pixels, y down, single-player layout table L = layout[0][0][0].
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** RGBA in 0..255 (D3DCOLOR bytes reordered). */
export type HudRgba = readonly [number, number, number, number];

/** Palette set in `0x52ac10` (§2.2). */
export const HUD_COLOURS = {
  /** Boost leading segment; countdown tint. */
  A4: [255, 249, 135, 255],
  A8: [204, 204, 204, 255],
  /** Markup `X`; player map dot. */
  AC: [155, 23, 52, 255],
  /** Boost full segment. */
  B4: [211, 96, 14, 255],
  /** All panel tints (panpos/panlap/pantimer/panbst/colpan). */
  B8: [0, 0, 0, 128],
  /** Boost empty segment. */
  BC: [50, 50, 50, 255],
  /** Markup `D`; gear + speed digits. */
  C0: [139, 186, 202, 255],
  /** Default text; dial body, numeral and needle tint. */
  C4: [220, 220, 220, 255],
  /** Wrong-way icon. */
  C8: [220, 220, 220, 128],
  CC: [6, 174, 6, 255],
  /** Opponent map dot. */
  D0: [70, 142, 231, 255],
  TRAIL1: [240, 195, 95, 255],
  TRAIL2: [225, 154, 55, 255],
} as const satisfies Record<string, HudRgba>;

/** Every HUD sprite fr3.exe draws in RACING / RACING_BOOST single player, by collection (GRAPHICS/HUD/<C>). */
export const HUD_SPRITE_MANIFEST = {
  GENERIC: ["turnrnd", "start0", "start1", "start2", "start3"],
  PANEL: ["panpos", "panlap", "pantimer", "panbst", "boostbit", "colpan"],
  REV: ["needle", "revc", "revcn4", "revcn6", "revcn7", "revcn8", "revcn9", "revcn10",
    "revb", "revbn4", "revbn6", "revbn7", "revbn8", "revbn9", "revbn10", "spd"],
  MPH: ["spdn90m", "spdn140m", "spdn160m", "spdn180m", "spdn200m", "spdn240m"],
  KPH: ["spdn140k", "spdn240k", "spdn280k", "spdn320k", "spdn400k"],
  NUMBERS: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "slash", "colon", "fullstop", "R", "N"],
} as const;
/** `3DDATA/MISC/textures.DXT` minimap textures (looked up by name at `0x517071` / `0x5170d7`). */
export const HUD_MAP_TEXTURES = ["MAP_TRACK", "MAP_DOT"] as const;

/** Sprites keyed `COLLECTION/name` (e.g. `REV/needle`, `MISC/MAP_TRACK`) plus the numeral glyph table. */
export interface HudAtlas {
  readonly units: SpeedUnits;
  readonly sprites: ReadonlyMap<string, PcgEntry>;
  /** Keys `0`..`9`, `/`, `.`, `:`, `R`, `N`. */
  readonly numerals: Readonly<Record<string, PcgEntry | undefined>>;
}

export type HudDrawOp =
  | { kind: "sprite"; key: string; x: number; y: number; justify: number; colour: HudRgba; scale?: number; scaleX?: number }
  | { kind: "needle"; key: string; pivotX: number; pivotY: number; angle: number; colour: HudRgba }
  | { kind: "numerals"; text: string; x: number; y: number; justify: number; colour: HudRgba }
  | { kind: "text"; font: 2; text: string; x: number; y: number; justify: number; colour: HudRgba }
  | { kind: "strip"; key: string; points: readonly (readonly [number, number])[]; width: number; colour: HudRgba }
  | { kind: "quad"; key: string; x0: number; y0: number; x1: number; y1: number; colour: HudRgba };

/** Camera group of the viewport (§3): BONNET = group 1, CHASE = groups 2/3, `other` = no gauges, `none` = no HUD. */
export type HudCameraGroup = "bonnet" | "chase" | "other" | "none";

/**
 * Native camera mode → fr3 HUD group. `LOOK_BACK` keeps the forward group (pass it as `forward`);
 * `INTRO` draws no HUD; `FINISH` draws no gauges.
 */
export function cameraModeToHudGroup(mode: string, forward: HudCameraGroup = "chase"): HudCameraGroup {
  switch (mode) {
    case "CHASE_FAR": case "CHASE_NEAR": case "CHASE_HIGH": case "CHASE_LOW": return "chase";
    case "HOOD": case "BUMPER": case "BONNET": return "bonnet";
    case "LOOK_BACK": return forward;
    case "INTRO": return "none";
    default: return "other";
  }
}

export type HudLabelKey = "POSITION" | "LAP" | "CURRENT_LAP" | "LAST_LAP" | "BEST_LAP" | "BOOST"
  | "SUPER_START" | "GOOD_START" | "OVER_REVS" | "SHORT_REVS";
/** TLATE keys of the HUD's font-2 labels (pass translated strings through {@link HudModelInput.labels}). */
export const HUD_LABEL_KEYS: Readonly<Record<HudLabelKey, string>> = {
  POSITION: "TXT_INRACE_POSITION",
  LAP: "TXT_INRACE_LAP",
  CURRENT_LAP: "TXT_INRACE_CURRENT_LAP_TIME",
  LAST_LAP: "TXT_INRACE_PREVIOUS_LAP_TIME",
  BEST_LAP: "TXT_INRACE_BEST_LAP_TIME",
  BOOST: "TXT_INRACE_BOOST_BOOST_BAR",
  SUPER_START: "TXT_INRACE_SUPER_START",
  GOOD_START: "TXT_INRACE_GOOD_START",
  OVER_REVS: "TXT_INRACE_OVER_REVS",
  SHORT_REVS: "TXT_INRACE_SHORT_REVS",
};
const DEFAULT_LABELS: Readonly<Record<HudLabelKey, string>> = {
  POSITION: "POSITION", LAP: "LAP", CURRENT_LAP: "LAP", LAST_LAP: "LAST", BEST_LAP: "BEST", BOOST: "BOOST",
  SUPER_START: "SUPER START!!!", GOOD_START: "GOOD START!", OVER_REVS: "OVER REVS...", SHORT_REVS: "SHORT REVS...",
};

export type LaunchResult = "super" | "good" | "over" | "short";
const LAUNCH_LABEL: Readonly<Record<LaunchResult, HudLabelKey>> = {
  super: "SUPER_START", good: "GOOD_START", over: "OVER_REVS", short: "SHORT_REVS",
};

export interface HudBoostInput {
  /** Boost currently burning. */
  active: boolean;
  /** 0→1 over the active burn (`0x4f4260`: value = elapsedFraction, max 1, mode 2). */
  elapsedFraction?: number;
  /** Energy toward the next charge, 0..7 (vehicle +0x1e4). */
  energy?: number;
  /** Stored charges, 0..2. */
  charges: number;
}

export interface HudModelInput {
  speedMps: number;
  rpm: number;
  /** Engine `MAX_RPM` (ENGDATA). Selects the rev dial and is the needle's full scale. */
  maxRpm: number;
  /** Signed gear: >0 forward, 0 neutral, −1 reverse. */
  gear: number;
  units: SpeedUnits;
  /** CARDATA `CAR_APPROXIMATE_TOP_SPEED` in MPH (selects the bonnet speedo dial). */
  approxTopSpeedMph: number;
  cameraGroup: HudCameraGroup;
  position: number;
  participants: number;
  lap: number;
  laps: number;
  currentLapSeconds?: number;
  lastLapSeconds?: number;
  bestLapSeconds?: number;
  mode?: "RACING" | "RACING_BOOST";
  boost?: HudBoostInput;
  wrongWay?: boolean;
  /** Minimap; shown when `enabled !== false` and exactly one local player. */
  map?: {
    enabled?: boolean;
    /** AI path / racing-line X/Z points. */
    course: readonly HudPoint[];
    cars: readonly HudVehicle[];
    localPlayers?: number;
  };
  /** Seconds since the countdown chain started (3.6 s chain); omit when no countdown is running. */
  countdownTime?: number;
  /** Launch-result banner and seconds since it was queued. */
  launchBanner?: { result: LaunchResult; time: number };
  /** Translated label strings (defaults are English). */
  labels?: Partial<Record<HudLabelKey, string>>;
  /** Font-2 width in reference px, for the `colpan` banner x-scale. */
  measureText?: (text: string) => number;
}

/** fistp rounding (round half to even), as fr3.exe converts HUD values to integers. */
export function roundHalfEven(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** m/s → display units: KPH `v·3.6`, MPH `v·3600·0.0006215040339`. */
export function speedToDisplayUnits(speedMps: number, units: SpeedUnits): number {
  const speed = Math.abs(Number.isFinite(speedMps) ? speedMps : 0);
  return units === "KPH" ? speed * 3600 * 0.001 : speed * 3600 * 0.0006215040339;
}

const MPH_DIAL_CAPS = [90, 140, 160, 180, 200, 240] as const;
const KPH_DIAL_CAPS = [140, 240, 280, 320, 320, 400] as const;

/**
 * Bonnet speedo dial (`0x52db80`). The original underflows to row −1 for tops beyond the last cap (a 240 mph
 * car → 245); this clamps to the last row instead (deliberate fix).
 */
export function selectSpeedDial(units: SpeedUnits, approxTopSpeedMph: number): { row: number; cap: number; sprite: string } {
  const base = (Number.isFinite(approxTopSpeedMph) ? approxTopSpeedMph : 0) + 5;
  const top = roundHalfEven(units === "KPH" ? base * 1.609344 : base);
  const caps = units === "KPH" ? KPH_DIAL_CAPS : MPH_DIAL_CAPS;
  let row = caps.findIndex(cap => cap >= top);
  if (row < 0) row = caps.length - 1;
  const cap = caps[row]!;
  return { row, cap, sprite: units === "KPH" ? `KPH/spdn${cap}k` : `MPH/spdn${cap}m` };
}

/** Rev dial numerals suffix (`0x52da00`/`0x52dac0`): ≤4000→4, ≤6000→6, ≤7000→7, ≤8000→8, ≤9000→9, else 10. */
export function selectRevDial(maxRpm: number): 4 | 6 | 7 | 8 | 9 | 10 {
  if (maxRpm <= 4000) return 4;
  if (maxRpm <= 6000) return 6;
  if (maxRpm <= 7000) return 7;
  if (maxRpm <= 8000) return 8;
  if (maxRpm <= 9000) return 9;
  return 10;
}

export const CHASE_NEEDLE = { base: 0.24, span: 0.68 } as const;
export const BONNET_NEEDLE = { base: 0.66, span: 0.67 } as const;

/** `angle = π·clamp(base + span·value/max, base, base + span)` (§2.5). */
export function needleAngle(arc: { base: number; span: number }, value: number, max: number): number {
  const ratio = max > 0 && Number.isFinite(value) ? value / max : 0;
  const t = Math.min(arc.base + arc.span, Math.max(arc.base, arc.base + arc.span * ratio));
  return Math.PI * t;
}

/** Gear numerals: `D%d`, `DN`, `DR`, or empty for other negative gears. */
export function hudGearText(gear: number): string {
  const g = Math.trunc(Number.isFinite(gear) ? gear : 0);
  if (g > 0) return `D${g}`;
  if (g === 0) return "DN";
  if (g === -1) return "DR";
  return "";
}

/** HUD timer (`0x52dd90`): truncated centiseconds, `%02d:%02d.%02d`, "-" prefix when negative. */
export function formatHudTime(seconds: number): string | null {
  if (!Number.isFinite(seconds)) return null;
  // Tiny epsilon so binary artefacts (0.29*100 = 28.999…) don't drop a centisecond the float32 original keeps.
  const centiseconds = Math.trunc(Math.abs(seconds) * 100 + 1e-7);
  if (!Number.isSafeInteger(centiseconds)) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${seconds < 0 ? "-" : ""}${pad(Math.floor(centiseconds / 6000))}:${pad(Math.floor(centiseconds / 100) % 60)}.${pad(centiseconds % 100)}`;
}

/**
 * Boost bar segment colours (`0x52ff40(value, max, mode, active)`, §5.10). Returns [upper row y=96 (second
 * charge), lower row y=120 (first charge)], ten colours each.
 */
export function boostSegmentColours(boost: HudBoostInput): [HudRgba[], HudRgba[]] {
  const active = boost.active;
  const value = active ? Math.min(1, Math.max(0, boost.elapsedFraction ?? 0)) : Math.max(0, boost.energy ?? 0);
  const max = active ? 1 : 7;
  const mode = active ? 2 : Math.min(2, Math.max(0, Math.trunc(boost.charges)));
  const x = 10 * value / max;
  const n = roundHalfEven(x);
  const f = x - n;
  const trailA = active ? -1 : 1;
  const trailB = active ? -2 : 2;
  const perSegment = (c: number): HudRgba[] => {
    const lead = active ? c : roundHalfEven(10 * f) - (10 - c);
    return Array.from({ length: 10 }, (_, i) => {
      if (i > c || value <= 0) return HUD_COLOURS.BC;
      if (i === lead) return HUD_COLOURS.A4;
      if (i === lead + trailA) return HUD_COLOURS.TRAIL1;
      if (i === lead + trailB) return HUD_COLOURS.TRAIL2;
      return HUD_COLOURS.B4;
    });
  };
  const uniform = (colour: HudRgba): HudRgba[] => Array.from({ length: 10 }, () => colour);
  if (active) return [perSegment(n), perSegment(n)];
  if (mode === 2) return [uniform(HUD_COLOURS.B4), uniform(HUD_COLOURS.B4)];
  if (mode === 1) return [perSegment(n), uniform(HUD_COLOURS.B4)];
  return [uniform(HUD_COLOURS.BC), perSegment(n)];
}

const COUNTDOWN_STEP = 0.9;
/** The GO step's keyframe c fires the race-start callback `0x4ecb50`: 3·0.9 + 0.15 + 0.05. */
export const COUNTDOWN_RACE_START_TIME = 3 * COUNTDOWN_STEP + 0.2;
export const COUNTDOWN_DURATION = 4 * COUNTDOWN_STEP;
const COUNTDOWN_SPRITES = ["GENERIC/start3", "GENERIC/start2", "GENERIC/start1", "GENERIC/start0"] as const;
/** Sound cues 0x68 (3), 0x69 (2), 0x67 (1), 0x66 (GO), fired at each step's keyframe a. */
export const COUNTDOWN_SOUND_CUES = [0x68, 0x69, 0x67, 0x66] as const;

export interface CountdownFrame {
  step: 0 | 1 | 2 | 3;
  sprite: string;
  visible: boolean;
  x: number;
  y: number;
  scale: number;
  soundCue: number;
  /** Chain time at which this step (and its sound) started. */
  stepStart: number;
}

/**
 * Start countdown message chain (`0x531670`, §5.13): per step a 0.15 s hidden gap (sound fires), then
 * b/c/d pops of 0.05 s and a 0.60 s hold, at (320,260) tinted C_A4. Velocity integrates in px/s; the
 * scale `(start, rate)` pairs are applied across each 0.05 s keyframe, which makes the chain continuous
 * (1.0→0.25, 0.25→1.25, 1.25→1.0) [inferred; the message-queue renderer was not decoded].
 */
export function countdownFrame(time: number): CountdownFrame | null {
  if (!Number.isFinite(time) || time < 0 || time >= COUNTDOWN_DURATION) return null;
  const step = Math.min(3, Math.floor(time / COUNTDOWN_STEP)) as 0 | 1 | 2 | 3;
  const local = time - step * COUNTDOWN_STEP;
  const frame = (visible: boolean, y: number, scale: number): CountdownFrame => ({
    step, sprite: COUNTDOWN_SPRITES[step], visible, x: 320, y, scale,
    soundCue: COUNTDOWN_SOUND_CUES[step], stepStart: step * COUNTDOWN_STEP,
  });
  if (local < 0.15) return frame(false, 260 - 300 * local, 1);
  if (local < 0.2) { const t = local - 0.15; return frame(true, 290 - 30 * t, 1 - 0.75 * t / 0.05); }
  if (local < 0.25) { const t = local - 0.2; return frame(true, 260 + 30 * t, 0.25 + 1 * t / 0.05); }
  if (local < 0.3) { const t = local - 0.25; return frame(true, 260, 1.25 - 0.25 * t / 0.05); }
  return frame(true, 260, 1);
}

/** Banner timeline (`0x531e70`): 0.25 s in, 1.5 s hold, 0.25 s out; returns alpha in [0,1] or null when done. */
export function bannerAlpha(time: number): number | null {
  if (!Number.isFinite(time) || time < 0 || time >= 2) return null;
  if (time < 0.25) return time / 0.25;
  if (time < 1.75) return 1;
  return (2 - time) / 0.25;
}

export interface MinimapLayout {
  outline: [number, number][];
  start: [number, number];
  project: (point: HudPoint) => [number, number];
}

/**
 * Minimap projection (`0x52f330`/`0x52f640`/`0x52f740`): sample every `floor(n/127)+1`th point (closing on
 * point 0); the bounds skip sample index `stride` (the original's first-iteration double increment);
 * the larger side is scaled to 100 px and centred on `centre`.
 */
export function minimapLayout(course: readonly HudPoint[], centre: readonly [number, number]): MinimapLayout | null {
  const count = course.length;
  if (count < 2) return null;
  const stride = Math.floor(count / 127) + 1;
  const indices: number[] = [];
  for (let i = 0; i < count; i += stride) indices.push(i);
  const bounds = indices.filter(i => i !== stride);
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const i of bounds.length ? bounds : indices) {
    const p = course[i]!;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const extent = Math.max(maxX - minX, maxZ - minZ);
  if (!(extent > 0 && Number.isFinite(extent))) return null;
  const k = 100 / extent;
  const cx = (minX + maxX) / 2 * k;
  const cy = -(minZ + maxZ) / 2 * k;
  const project = (p: HudPoint): [number, number] => [p.x * k - cx + centre[0], -p.z * k - cy + centre[1]];
  const outline = indices.map(i => project(course[i]!));
  outline.push(project(course[0]!));
  return { outline, start: project(course[0]!), project };
}

/** Minimap centre (`0x52c420`): bonnet (85,310); chase and everything else (85,390). */
export function minimapCentre(group: HudCameraGroup): [number, number] {
  return group === "bonnet" ? [85, 310] : [85, 390];
}

const MAP_STRIP_BATCH = 48;

/**
 * Build the ordered fr3.exe HUD draw list for one viewport (`0x52bcd0`): gauges → wrong-way → minimap →
 * game-mode HUD (position, lap, timers, boost) → flushed text/numeral items → message queue (countdown, banner).
 */
export function buildHudDrawList(input: HudModelInput): HudDrawOp[] {
  const ops: HudDrawOp[] = [];
  if (input.cameraGroup === "none") return ops;
  const text: HudDrawOp[] = [];
  const labels = { ...DEFAULT_LABELS, ...input.labels };
  const C = HUD_COLOURS;
  const sprite = (key: string, x: number, y: number, justify: number, colour: HudRgba, scale?: number, scaleX?: number) => {
    const op: HudDrawOp = { kind: "sprite", key, x, y, justify, colour };
    if (scale !== undefined) op.scale = scale;
    if (scaleX !== undefined) op.scaleX = scaleX;
    ops.push(op);
  };
  const label = (value: string, x: number, y: number, justify: number, colour: HudRgba = C.C4) =>
    text.push({ kind: "text", font: 2, text: value, x, y, justify, colour });
  const numerals = (value: string, x: number, y: number, justify: number, colour: HudRgba = C.C4) =>
    text.push({ kind: "numerals", text: value, x, y, justify, colour });

  // Gauges (§5.1 / §5.2).
  const speed = speedToDisplayUnits(input.speedMps, input.units);
  const rpm = Math.max(0, Number.isFinite(input.rpm) ? input.rpm : 0);
  const maxRpm = Number.isFinite(input.maxRpm) && input.maxRpm > 0 ? input.maxRpm : 7000;
  const revDial = selectRevDial(maxRpm);
  const speedText = `D${String(roundHalfEven(speed)).padStart(3, " ")}`;
  const gearText = hudGearText(input.gear);
  if (input.cameraGroup === "chase") {
    sprite("REV/revc", 627, 466, 3, C.C4);
    sprite(`REV/revcn${revDial}`, 627, 466, 3, C.C4);
    ops.push({ kind: "needle", key: "REV/needle", pivotX: 627, pivotY: 350,
      angle: needleAngle(CHASE_NEEDLE, rpm, maxRpm), colour: C.C4 });
    if (gearText) numerals(gearText, 576, 341, 4, C.C0);
    numerals(speedText, 576, 365, 4, C.C0);
  } else if (input.cameraGroup === "bonnet") {
    const dial = selectSpeedDial(input.units, input.approxTopSpeedMph);
    sprite("REV/revb", 190, 425, 4, C.C4);
    sprite(`REV/revbn${revDial}`, 190, 425, 4, C.C4);
    ops.push({ kind: "needle", key: "REV/needle", pivotX: 190, pivotY: 491,
      angle: needleAngle(BONNET_NEEDLE, rpm, maxRpm), colour: C.C4 });
    sprite("REV/spd", 450, 425, 4, C.C4);
    sprite(dial.sprite, 450, 425, 4, C.C4);
    ops.push({ kind: "needle", key: "REV/needle", pivotX: 450, pivotY: 491,
      angle: needleAngle(BONNET_NEEDLE, speed, dial.cap), colour: C.C4 });
    if (gearText) numerals(gearText, 190, 432, 4, C.C0);
    numerals(speedText, 450, 432, 4, C.C0);
  }

  // Wrong way (§5.11): steady, no text.
  if (input.wrongWay) sprite("GENERIC/turnrnd", 320, 160, 4, C.C8);

  // Minimap (§5.12): no background panel.
  const map = input.map;
  if (map && map.enabled !== false && (map.localPlayers ?? 1) === 1) {
    const layout = minimapLayout(map.course, minimapCentre(input.cameraGroup));
    if (layout) {
      const points = layout.outline;
      for (let first = 0; first < points.length - 1; first += MAP_STRIP_BATCH - 1) {
        ops.push({ kind: "strip", key: "MISC/MAP_TRACK", width: 8, colour: [255, 255, 255, 255],
          points: points.slice(first, first + MAP_STRIP_BATCH) });
      }
      const dot = (point: readonly [number, number], half: number, colour: HudRgba) => ops.push({
        kind: "quad", key: "MISC/MAP_DOT", x0: point[0] - half, y0: point[1] - half,
        x1: point[0] + half, y1: point[1] + half, colour,
      });
      dot(layout.start, 6, [220, 220, 220, 180]);
      for (const car of map.cars) {
        if (car.local || car.active === false || !Number.isFinite(car.x) || !Number.isFinite(car.z)) continue;
        dot(layout.project(car), 5, [C.D0[0], C.D0[1], C.D0[2], 180]);
      }
      const player = map.cars.find(car => car.local && car.active !== false);
      if (player && Number.isFinite(player.x) && Number.isFinite(player.z)) {
        dot(layout.project(player), 6, [C.AC[0], C.AC[1], C.AC[2], 180]);
      }
    }
  }

  // Game-mode HUD (RACING / RACING_BOOST).
  const participants = Math.max(0, Math.trunc(Number.isFinite(input.participants) ? input.participants : 0));
  const position = Math.min(participants, Math.max(0, Math.trunc(Number.isFinite(input.position) ? input.position : 0)));
  sprite("PANEL/panpos", 0, 36, 8, C.B8);
  label(labels.POSITION, 166, 39, 9);
  numerals(`>${position}<D/${participants}`, 160, 58, 9);

  const laps = Math.max(1, Math.trunc(Number.isFinite(input.laps) ? input.laps : 1));
  const lap = Math.min(laps, Math.max(1, Math.trunc(Number.isFinite(input.lap) ? input.lap : 1)));
  sprite("PANEL/panlap", 640, 36, 9, C.B8);
  label(labels.LAP, 473, 39, 8);
  numerals(`>${lap}<D/${laps}`, 470, 58, 8);

  const rows: [string, number][] = [];
  if (input.currentLapSeconds !== undefined && input.currentLapSeconds >= 0) rows.push([labels.CURRENT_LAP, input.currentLapSeconds]);
  if ((input.lastLapSeconds ?? 0) > 0) rows.push([labels.LAST_LAP, input.lastLapSeconds!]);
  if ((input.bestLapSeconds ?? 0) > 0) rows.push([labels.BEST_LAP, input.bestLapSeconds!]);
  rows.forEach(([name, seconds], i) => {
    const y = [91, 108, 125][i]!;
    const time = formatHudTime(seconds);
    sprite("PANEL/pantimer", 640, y, 9, C.B8);
    if (time) label(`${name} ${time}`, 604, y, 9);
  });

  if (input.mode === "RACING_BOOST" && input.boost) {
    sprite("PANEL/panbst", 0, 91, 8, C.B8);
    const [upper, lower] = boostSegmentColours(input.boost);
    upper.forEach((colour, i) => sprite("PANEL/boostbit", 38 + i * 7, 96, 8, colour));
    lower.forEach((colour, i) => sprite("PANEL/boostbit", 38 + i * 7, 120, 8, colour));
    label(labels.BOOST, 37, 142, 8);
  }

  ops.push(...text);

  // Message queue: countdown, then the launch banner.
  if (input.countdownTime !== undefined) {
    const frame = countdownFrame(input.countdownTime);
    if (frame?.visible) sprite(frame.sprite, frame.x, frame.y, 4, C.A4, frame.scale);
  }
  if (input.launchBanner) {
    const alpha = bannerAlpha(input.launchBanner.time);
    if (alpha !== null) {
      const message = labels[LAUNCH_LABEL[input.launchBanner.result]];
      const width = input.measureText?.(message) ?? message.length * 9;
      const fade = (colour: HudRgba): HudRgba => [colour[0], colour[1], colour[2], Math.round(colour[3] * alpha)];
      sprite("PANEL/colpan", 320, 120, 4, fade(C.B8), 1, width / (512 * 0.78) + 0.05);
      ops.push({ kind: "text", font: 2, text: message, x: 320, y: 122, justify: 4, colour: fade(C.C4) });
    }
  }
  return ops;
}

/** Legacy `HudState` shape still produced by `app.ts`, plus optional fields that feed the authentic model. */
export interface LegacyHudState {
  speedMps: number;
  speedUnit?: SpeedUnits;
  /** @deprecated Ignored by the fr3 HUD; the speedo dial comes from `approxTopSpeedMph`. */
  speedRangeMps?: number;
  rpm: number;
  redlineRpm: number;
  gear: number;
  /** Normalized boost remaining while burning, in [0, 1]. */
  boost: number;
  boostCharges?: number;
  maxBoostCharges?: number;
  position: number;
  participants: number;
  lap: number;
  laps: number;
  lapTime: number;
  bestTime?: number;
  /** @deprecated The fr3 HUD has no total race timer. */
  totalTime?: number;
  countdown?: 3 | 2 | 1 | "GO";
  wrongWay?: boolean;
  map?: { course: readonly HudPoint[]; player: HudPoint; opponents: readonly HudPoint[] };
  /** Engine MAX_RPM (falls back to `redlineRpm / 0.97`). */
  maxRpm?: number;
  approxTopSpeedMph?: number;
  cameraGroup?: HudCameraGroup;
  lastLapTime?: number;
  mode?: "RACING" | "RACING_BOOST";
  boostEnergy?: number;
  countdownTime?: number;
  launchBanner?: { result: LaunchResult; time: number };
  mapEnabled?: boolean;
  labels?: Partial<Record<HudLabelKey, string>>;
}

const LEGACY_COUNTDOWN_STEP: Readonly<Record<string, number>> = { 3: 0, 2: 1, 1: 2, GO: 3 };

/** Adapt the legacy `HudState` to {@link HudModelInput}. */
export function hudInputFromLegacyState(state: LegacyHudState): HudModelInput {
  const active = state.boost > 0;
  const step = state.countdown === undefined ? undefined : LEGACY_COUNTDOWN_STEP[String(state.countdown)];
  const input: HudModelInput = {
    speedMps: state.speedMps,
    rpm: state.rpm,
    maxRpm: state.maxRpm ?? (state.redlineRpm > 0 ? state.redlineRpm / 0.97 : 7000),
    gear: state.gear,
    units: state.speedUnit ?? "MPH",
    approxTopSpeedMph: state.approxTopSpeedMph
      ?? (state.speedRangeMps !== undefined ? state.speedRangeMps * 2.2374145 - 5 : 150),
    cameraGroup: state.cameraGroup ?? "chase",
    position: state.position,
    participants: state.participants,
    lap: state.lap,
    laps: state.laps,
    currentLapSeconds: state.lapTime,
    lastLapSeconds: state.lastLapTime,
    bestLapSeconds: state.bestTime,
    mode: state.mode ?? (state.boostCharges !== undefined ? "RACING_BOOST" : "RACING"),
    boost: {
      active,
      elapsedFraction: active ? 1 - Math.min(1, Math.max(0, state.boost)) : 0,
      energy: state.boostEnergy ?? 0,
      charges: state.boostCharges ?? 0,
    },
    wrongWay: state.wrongWay,
    countdownTime: state.countdownTime ?? (step === undefined ? undefined : step * COUNTDOWN_STEP + 0.3),
    launchBanner: state.launchBanner,
    labels: state.labels,
  };
  if (state.map) {
    input.map = {
      enabled: state.mapEnabled,
      course: state.map.course,
      cars: [
        ...state.map.opponents.map((p, i) => ({ id: `opponent${i}`, x: p.x, z: p.z })),
        { id: "player", x: state.map.player.x, z: state.map.player.z, local: true },
      ],
    };
  }
  return input;
}
