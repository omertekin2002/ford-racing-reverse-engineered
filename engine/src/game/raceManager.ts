import type { DifficultyLevel, RaceDefinition, RaceRule, RacingLine } from "../formats/databases";
import { clamp, lerp, quatFromAxisAngle, type Quat, type Vec3 } from "../math/mat4";
import {
  sampleRacingLine, trackProgressDelta, validateCircuit, wrapTrackProgress,
  type CarControlOutput, type CarTelemetryView, type TrackProgressSample,
} from "./aiDriver";

export type RaceMode = "RACING" | "RACING_BOOST";
export type RacePhase = "INTRO" | "COUNTDOWN" | "RACING" | "FINISHED";
export type GroundSampleFn = (x: number, z: number) => number | { readonly height: number } | null | undefined;

export function sampleGroundHeight(ground: GroundSampleFn | undefined, x: number, z: number): number | undefined {
  const sample = ground?.(x, z);
  const height = typeof sample === "number" ? sample : sample?.height;
  return Number.isFinite(height) ? height : undefined;
}

export interface RaceSelection {
  readonly trackId: string;
  readonly mode: RaceMode;
  readonly laps: number;
  readonly difficulty: DifficultyLevel;
  readonly entrants: readonly RaceEntrant[];
}

export interface RaceEntrant {
  readonly id: string;
  readonly carId: string;
  readonly isPlayer?: boolean;
}

/** Rotate through caller-supplied presets in order, or resolve an explicit selection. */
export class QuickRaceSelector {
  private index = 0;

  constructor(private readonly presets: readonly RaceDefinition[]) {}

  next(overrides: Partial<Pick<RaceSelection, "mode" | "laps" | "difficulty">> & { readonly carId?: string } = {}): RaceSelection {
    const preset = this.presets[this.index];
    if (!preset) throw new RangeError("No quick-race presets configured");
    const mode = overrides.mode ?? preset.gameplayId;
    if (mode !== "RACING" && mode !== "RACING_BOOST") throw new RangeError(`Unsupported race mode: ${mode}`);
    const selection = {
      trackId: preset.trackId, mode, laps: overrides.laps ?? preset.laps ?? 3,
      difficulty: overrides.difficulty ?? "MEDIUM",
      entrants: preset.participants.map((participant, index) => {
        const isPlayer = participant.control === "PLAYER_ACTIVE";
        return {
          id: participant.playerIndex ?? `grid-${index + 1}`,
          carId: (isPlayer && overrides.carId) || participant.carId, isPlayer,
        };
      }),
    } satisfies RaceSelection;
    this.index = (this.index + 1) % this.presets.length;
    return selection;
  }

  custom(selection: RaceSelection): RaceSelection {
    return { ...selection, entrants: selection.entrants.map(entrant => ({ ...entrant })) };
  }
}

export interface RaceManagerOptions {
  readonly line: RacingLine;
  readonly entrants: readonly RaceEntrant[];
  readonly laps: number;
  readonly mode: RaceMode;
  readonly rule?: Pick<RaceRule, "MIN_CARS" | "MAX_CARS" | "MAX_LAPS">;
  readonly ground?: GroundSampleFn;
  readonly startU?: number;
  /** Checkpoints as fractions of the lap measured forward from the finish line. */
  readonly checkpoints?: readonly number[];
  readonly introSeconds?: number;
  readonly countdownStepSeconds?: number;
  readonly boostChargesPerLap?: number;
  readonly boostDuration?: number;
  readonly onBoostReplenished?: (id: string, charges: number) => void;
}

export interface GridPosition {
  readonly id: string;
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly rotation: Quat;
  readonly track: TrackProgressSample;
  readonly progress: number;
}

export interface RaceObservation {
  readonly id: string;
  readonly car: CarTelemetryView;
  readonly track: TrackProgressSample;
}

export interface RaceStanding extends RaceEntrant {
  readonly place: number;
  readonly progress: number;
  readonly lap: number;
  readonly completedLaps: number;
  readonly lapTime: number;
  readonly bestLapTime: number | null;
  readonly totalRaceTime: number;
  readonly finishTime: number | null;
  readonly wrongWay: boolean;
  readonly boostCharges: number;
  readonly boostActive: boolean;
}

interface EntrantState {
  readonly entrant: RaceEntrant;
  readonly slot: number;
  u: number;
  progress: number;
  checkpointsPassed: number;
  completedLaps: number;
  lapStart: number | null;
  bestLapTime: number | null;
  finishTime: number | null;
  wrongWay: boolean;
  negativeTime: number;
  boostCharges: number;
  boostUntil: number;
}

const goSeconds = 0.8;
const takeoverSeconds = 0.6;

export class RaceManager {
  readonly grid: readonly GridPosition[];
  private readonly states = new Map<string, EntrantState>();
  private readonly checkpoints: readonly number[];
  private readonly introSeconds: number;
  private readonly countdownStep: number;
  private readonly boostChargesPerLap: number;
  private readonly boostDuration: number;
  private preRaceTime = 0;
  private raceTime = 0;
  private postRaceTime = 0;
  private currentPhase: RacePhase = "INTRO";
  private frozenStandings?: readonly RaceStanding[];

  constructor(private readonly options: RaceManagerOptions) {
    validateCircuit(options.line);
    const { entrants, laps, rule } = options;
    if (!Number.isInteger(laps) || laps < 1 || laps > (rule?.MAX_LAPS ?? Infinity)) {
      throw new RangeError("Invalid lap count");
    }
    if (entrants.length < (rule?.MIN_CARS ?? 1) || entrants.length > (rule?.MAX_CARS ?? Infinity)
      || entrants.filter(entrant => entrant.isPlayer).length !== 1
      || new Set(entrants.map(entrant => entrant.id)).size !== entrants.length) {
      throw new RangeError("A race needs unique entrants, exactly one player, and a field within the rule limits");
    }
    this.checkpoints = [...new Set(options.checkpoints ?? [0.3, 0.65])].sort((a, b) => a - b);
    if (this.checkpoints.some(checkpoint => !(checkpoint > 0 && checkpoint < 1))) {
      throw new RangeError("Lap checkpoints must be between zero and one");
    }
    this.introSeconds = Math.max(0, options.introSeconds ?? 2);
    this.countdownStep = options.countdownStepSeconds ?? 1;
    if (!Number.isFinite(this.introSeconds) || !Number.isFinite(this.countdownStep) || this.countdownStep <= 0) {
      throw new RangeError("Invalid intro or countdown duration");
    }
    this.boostChargesPerLap = options.mode === "RACING_BOOST" ? Math.max(0, Math.floor(options.boostChargesPerLap ?? 1)) : 0;
    this.boostDuration = Math.max(0, options.boostDuration ?? 4);
    const start = options.startU ?? 0;
    const gridSpacing = Math.min(9, options.line.length / (2 * entrants.length + 2));
    // Grid progress occupies less than half a lap, even on compact tracks.
    this.grid = entrants.map((entrant, slot) => {
      const progress = -(gridSpacing * (slot + 1)) / options.line.length;
      const u = wrapTrackProgress(start + progress);
      const line = sampleRacingLine(options.line, u, 0, false);
      const lateralOffset = (slot % 2 === 0 ? -1 : 1) * Math.min(1.8, Math.max(0, line.halfWidth - 1));
      const { position, forward } = sampleRacingLine(options.line, u, lateralOffset, false);
      position[1] = sampleGroundHeight(options.ground, position[0], position[2]) ?? position[1];
      const length = Math.hypot(forward[0], forward[2]);
      const heading: Vec3 = length > 0 ? [forward[0] / length, 0, forward[2] / length] : [0, 0, 1];
      this.states.set(entrant.id, {
        entrant: { ...entrant }, slot, u, progress, checkpointsPassed: 0, completedLaps: 0, lapStart: null,
        bestLapTime: null, finishTime: null, wrongWay: false, negativeTime: 0, boostCharges: this.boostChargesPerLap,
        boostUntil: 0,
      });
      return {
        id: entrant.id, position, forward: heading, progress, track: { u, lateralOffset },
        rotation: quatFromAxisAngle([0, 1, 0], Math.atan2(heading[0], heading[2])),
      };
    });
    if (this.introSeconds === 0) this.currentPhase = "COUNTDOWN";
  }

  get phase(): RacePhase { return this.currentPhase; }
  get canMove(): boolean { return this.phase === "RACING" || this.phase === "FINISHED"; }
  get elapsedRaceTime(): number { return this.raceTime; }

  get phaseElapsed(): number {
    switch (this.phase) {
      case "INTRO": return this.preRaceTime;
      case "COUNTDOWN": return this.preRaceTime - this.introSeconds;
      case "RACING": return this.raceTime;
      case "FINISHED": return this.postRaceTime;
    }
  }

  get countdownLabel(): "3" | "2" | "1" | "GO!" | null {
    if (this.phase === "COUNTDOWN") {
      return (["3", "2", "1"] as const)[Math.min(2, Math.floor(this.phaseElapsed / this.countdownStep))]!;
    }
    return this.phase === "RACING" && this.raceTime < goSeconds ? "GO!" : null;
  }

  get standings(): readonly RaceStanding[] {
    return this.frozenStandings ?? this.snapshotStandings();
  }

  get finalStandings(): readonly RaceStanding[] | undefined { return this.frozenStandings; }

  tryBoost(id: string): boolean {
    const state = this.states.get(id);
    if (this.phase !== "RACING" || !state || state.finishTime !== null || state.boostCharges === 0
      || state.boostUntil > this.raceTime || this.boostDuration === 0) return false;
    state.boostCharges--;
    state.boostUntil = this.raceTime + this.boostDuration;
    return true;
  }

  /** Resolve the player's controls after finishing, easing into the AI's controls. */
  finishControl(player: CarControlOutput, ai: CarControlOutput): CarControlOutput {
    if (this.phase !== "FINISHED") return player;
    const t = clamp(this.postRaceTime / takeoverSeconds, 0, 1);
    if (t === 1) return ai;
    const pedal = lerp(player.throttle - player.brake, ai.throttle - ai.brake, t);
    return {
      throttle: Math.max(0, pedal), brake: Math.max(0, -pedal),
      steer: lerp(player.steer, ai.steer, t), powerMultiplier: lerp(player.powerMultiplier, ai.powerMultiplier, t),
      boost: false, handbrake: t < 0.5 ? player.handbrake : ai.handbrake,
      driveDirection: t < 0.5 ? player.driveDirection : ai.driveDirection,
    };
  }

  update(dt: number, observations: readonly RaceObservation[]): void {
    let elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    if (this.phase === "FINISHED") {
      this.postRaceTime += elapsed;
      return;
    }
    if (!this.canMove) {
      const startTime = this.introSeconds + this.countdownStep * 3;
      const advance = Math.min(startTime - this.preRaceTime, elapsed);
      this.preRaceTime += advance;
      elapsed -= advance;
      if (this.preRaceTime < startTime) {
        this.currentPhase = this.preRaceTime < this.introSeconds ? "INTRO" : "COUNTDOWN";
        return;
      }
      this.currentPhase = "RACING";
    }
    if (elapsed === 0) return;

    const byId = new Map(observations.map(observation => [observation.id, observation]));
    const steps: { state: EntrantState; observation: RaceObservation; delta: number }[] = [];
    let fraction = 1;
    for (const state of this.states.values()) {
      const observation = byId.get(state.entrant.id);
      if (!observation || state.finishTime !== null || !Number.isFinite(observation.track.u)) continue;
      const delta = trackProgressDelta(state.u, observation.track.u);
      steps.push({ state, observation, delta });
      const remaining = this.options.laps - state.progress;
      if (state.entrant.isPlayer && state.lapStart !== null && remaining > 0 && delta >= remaining) {
        fraction = remaining / delta;
      }
    }
    const startTime = this.raceTime;
    const racingElapsed = elapsed * fraction;
    this.raceTime += racingElapsed;
    const replenished: EntrantState[] = [];
    for (const { state, observation, delta } of steps) {
      const advance = delta * fraction;
      const previous = state.progress;
      state.u = wrapTrackProgress(state.u + advance);
      state.progress += advance;
      this.updateWrongWay(state, observation.car, advance, racingElapsed);
      if (advance <= 0) continue;
      const crossingTime = (distance: number) => startTime + racingElapsed * clamp((distance - previous) / advance, 0, 1);
      if (state.lapStart === null) {
        if (state.progress < 0) continue;
        state.lapStart = crossingTime(0);
      }
      const lap = state.completedLaps;
      // Advance ordered gates once per credited lap. Reversing preserves the
      // gate cursor, and the next credited finish line stays one full lap ahead.
      while (state.checkpointsPassed < this.checkpoints.length) {
        const checkpoint = lap + this.checkpoints[state.checkpointsPassed]!;
        if (previous > checkpoint || state.progress < checkpoint) break;
        state.checkpointsPassed++;
      }
      if (state.checkpointsPassed !== this.checkpoints.length || state.progress < lap + 1 - 1e-12) continue;

      const finish = crossingTime(lap + 1);
      const lapTime = finish - state.lapStart;
      state.bestLapTime = Math.min(state.bestLapTime ?? Infinity, lapTime);
      state.completedLaps++;
      state.checkpointsPassed = 0;
      state.lapStart = finish;
      if (state.completedLaps >= this.options.laps) {
        state.finishTime = finish;
        state.progress = this.options.laps;
        state.wrongWay = false;
        state.boostUntil = 0;
      } else {
        // A single frame may carry the car beyond the first gate of its new lap.
        while (state.checkpointsPassed < this.checkpoints.length
          && state.progress >= state.completedLaps + this.checkpoints[state.checkpointsPassed]!) {
          state.checkpointsPassed++;
        }
        if (this.boostChargesPerLap > 0) {
          state.boostCharges = this.boostChargesPerLap;
          replenished.push(state);
        }
      }
    }
    if (steps.some(({ state }) => state.entrant.isPlayer && state.finishTime !== null)) {
      this.currentPhase = "FINISHED";
      this.postRaceTime = elapsed - racingElapsed;
      this.frozenStandings = Object.freeze(this.snapshotStandings().map(standing => Object.freeze(standing)));
    }
    for (const state of replenished) this.options.onBoostReplenished?.(state.entrant.id, this.boostChargesPerLap);
  }

  private updateWrongWay(state: EntrantState, car: CarTelemetryView, delta: number, dt: number): void {
    const { forward } = sampleRacingLine(this.options.line, state.u, 0, false);
    const length = Math.hypot(forward[0], forward[2]) * Math.hypot(car.forward[0], car.forward[2]);
    const dot = length > 0 ? (forward[0] * car.forward[0] + forward[2] * car.forward[2]) / length : 0;
    const moving = car.speed > 1;
    state.negativeTime = moving && delta < -1e-5 ? state.negativeTime + dt : 0;
    state.wrongWay = moving && (dot < -0.35 || state.negativeTime >= 0.45);
  }

  private snapshotStandings(): RaceStanding[] {
    return Array.from(this.states.values())
      .sort((a, b) => (a.finishTime ?? Infinity) - (b.finishTime ?? Infinity)
        || b.progress - a.progress || a.slot - b.slot)
      .map((state, index) => ({
        ...state.entrant,
        place: index + 1,
        progress: state.progress,
        completedLaps: state.completedLaps,
        lap: Math.min(this.options.laps, state.completedLaps + 1),
        lapTime: state.lapStart === null ? 0 : (state.finishTime ?? this.raceTime) - state.lapStart,
        bestLapTime: state.bestLapTime,
        totalRaceTime: state.finishTime ?? this.raceTime,
        finishTime: state.finishTime,
        wrongWay: state.wrongWay,
        boostCharges: state.boostCharges,
        boostActive: state.boostUntil > this.raceTime,
      }));
  }
}
