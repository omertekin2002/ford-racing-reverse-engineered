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
