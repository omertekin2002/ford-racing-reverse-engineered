import type { GameSettings, DifficultyLevel, RacingLine } from "../formats/databases";
import type { DrivingInput } from "../input/inputManager";
import { clamp, lerp, wrapAngle, type Quat, type Vec3 } from "../math/mat4";

export interface CarTelemetryView {
  readonly position: Readonly<Vec3>;
  readonly forward: Readonly<Vec3>;
  readonly rotation?: Readonly<Quat>;
  /** Speed magnitude in meters per second. */
  readonly speed: number;
  /** Surface-adjusted lateral acceleration capacity in m/s². */
  readonly grip?: number;
  readonly brakingDeceleration?: number;
  readonly blocked?: boolean;
}

export interface TrackProgressSample {
  /** Wrapped progress along the line, independent of the start/finish location. */
  readonly u: number;
  /** Signed meters along the line's lateral axis, relative to its center. */
  readonly lateralOffset: number;
}

export interface CarControlOutput extends Pick<DrivingInput, "throttle" | "brake" | "steer" | "handbrake" | "boost"> {
  readonly powerMultiplier: number;
  /** Apply the pedals in this gear direction. */
  readonly driveDirection: 1 | -1;
}

export interface AiObstacle extends TrackProgressSample {
  readonly speed?: number;
  readonly halfWidth?: number;
  readonly halfLength?: number;
}

export interface AiDriverFrame {
  readonly car: CarTelemetryView;
  readonly track: TrackProgressSample;
  readonly obstacles?: readonly AiObstacle[];
  /** Signed gap to the reference racer in meters, positive when ahead. */
  readonly referenceGap?: number;
  readonly boostCharges?: number;
  readonly boostActive?: boolean;
}

export type GameDataDifficulty = GameSettings["difficulty"][DifficultyLevel];

export interface AiDriverOptions {
  readonly difficulty: GameDataDifficulty;
  /** Resolved track grip, top-speed and braking scales, in that order. */
  readonly trackScales?: readonly [number, number, number];
  readonly maxSpeed?: number;
  /** Stable position within the pack, in [-1, 1]. */
  readonly packSlot?: number;
  readonly mode?: "RACING" | "RACING_BOOST";
  readonly halfWidth?: number;
  readonly halfLength?: number;
}

export function wrapTrackProgress(u: number): number {
  return u - Math.floor(u);
}

export function trackProgressDelta(previous: number, current: number): number {
  return wrapTrackProgress(current - previous + 0.5) - 0.5;
}

export function validateCircuit(line: RacingLine): void {
  if (!Number.isFinite(line.length) || line.length <= 0 || line.points.length < 3) {
    throw new RangeError("A circuit needs a positive length and at least three line points");
  }
}

interface LineSample {
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly offset: number;
  readonly halfWidth: number;
  readonly curvatureRadius: number;
}

/** Interpolate a closed, evenly sampled centerline and a bounded lateral offset. */
export function sampleRacingLine(line: RacingLine, u: number, lane = 0, useAuthoredOffset = true): LineSample {
  const count = line.points.length;
  const index = wrapTrackProgress(u) * count;
  const base = Math.floor(index);
  const t = index - base;
  const a = line.points[base % count]!;
  const b = line.points[(base + 1) % count]!;
  const previous = line.points[(base + count - 1) % count]!;
  const next = line.points[(base + 2) % count]!;
  const width = Math.max(0, lerp(a.width, b.width, t) / 2);
  const offset = lerp(a.offset, b.offset, t);
  const lateral = clamp(lane + (useAuthoredOffset ? offset : 0), -width, width);
  const lateralX = lerp(a.lateral[0], b.lateral[0], t);
  const lateralZ = lerp(a.lateral[2], b.lateral[2], t);
  const lateralLength = Math.hypot(lateralX, lateralZ) || 1;
  const position: Vec3 = [0, 0, 0];
  const forward: Vec3 = [0, 0, 0];
  for (const axis of [0, 1, 2] as const) {
    const start = a.position[axis];
    const end = b.position[axis];
    const startSlope = (end - previous.position[axis]) / 2;
    const endSlope = (next.position[axis] - start) / 2;
    const curve = start + t * (startSlope + t * (3 * (end - start) - 2 * startSlope - endSlope
      + t * (2 * (start - end) + startSlope + endSlope)));
    position[axis] = curve + lateral * lerp(a.lateral[axis], b.lateral[axis], t) / lateralLength;
    forward[axis] = lerp(a.forward[axis], b.forward[axis], t);
  }
  return { position, forward, offset, halfWidth: width, curvatureRadius: Math.abs(lerp(a.curvatureRadius, b.curvatureRadius, t)) };
}

/** Bounded power adjustment with a separate fading window for cars ahead. */
export function catchupPower(difficulty: GameDataDifficulty, gap: number, packSlot = 0): number {
  const shiftedGap = gap - clamp(packSlot, -1, 1) * Math.max(0, difficulty.CATCHUP_PACK_SPREAD);
  if (shiftedGap <= 0) {
    const amount = clamp(-shiftedGap / Math.max(0.001, difficulty.CATCHUP_RANGE_BEHIND), 0, 1);
    return clamp(1 + difficulty.CATCHUP_ADDITIONAL_POWER * amount, 0, 2);
  }
  const amount = clamp(shiftedGap / Math.max(0.001, difficulty.CATCHUP_RANGE_AHEAD), 0, 1);
  const fadeStart = Math.max(0, difficulty.CATCHUP_START_FADEOUT);
  const fadeStop = Math.max(fadeStart + 0.001, difficulty.CATCHUP_STOP_FADEOUT);
  const fade = 1 - clamp((shiftedGap - fadeStart) / (fadeStop - fadeStart), 0, 1);
  return clamp(1 - Math.abs(difficulty.CATCHUP_SUBTRACTIVE_POWER) * amount * fade, 0, 2);
}

export class AiDriver {
  private laneOffset = 0;
  private steer = 0;
  private pedal = 0;
  private previousError?: number;
  private blockedTime = 0;
  private reverseTime = 0;
  private reverseSteer = 0;

  constructor(private readonly line: RacingLine, private readonly options: AiDriverOptions) {
    validateCircuit(line);
  }

  reset(): void {
    this.laneOffset = this.steer = this.pedal = this.blockedTime = this.reverseTime = this.reverseSteer = 0;
    this.previousError = undefined;
  }

  update(dt: number, frame: AiDriverFrame): CarControlOutput {
    const elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const { car, track } = frame;
    const speed = Math.max(0, car.speed);
    const difficulty = this.options.difficulty;
    const packSlot = clamp(this.options.packSlot ?? 0, -1, 1);
    const powerMultiplier = frame.referenceGap === undefined ? 1 : catchupPower(difficulty, frame.referenceGap, packSlot);
    const [gripScale, speedScale, brakeScale] = this.options.trackScales ?? [1, 1, 1];
    const skill = clamp(difficulty.CAR_BASE_DIFFICULTY_LEVEL + packSlot * difficulty.CAR_DIFFICULTY_LEVEL_SPREAD, 0, 1);
    const grip = Math.max(0.1, (car.grip ?? 9) * gripScale * lerp(0.8, 1.1, skill));
    const deceleration = Math.max(0.5, (car.brakingDeceleration ?? 8) * brakeScale);
    const topSpeed = Math.max(0, (this.options.maxSpeed ?? 65) * speedScale);
    const lookahead = clamp(5 + 0.55 * speed, 5, 55);
    const horizon = Math.min(this.line.length, Math.max(lookahead, speed * speed / (2 * deceleration) + 5));
    const points = this.line.points;
    const spacing = this.line.length / points.length;
    let targetSpeed = this.cornerSpeed(sampleRacingLine(this.line, track.u).curvatureRadius, grip, topSpeed);
    const sampleIndex = wrapTrackProgress(track.u) * points.length;
    for (let index = Math.floor(sampleIndex) + 1; index <= sampleIndex + horizon / spacing; index++) {
      const distance = (index - sampleIndex) * spacing;
      const cornerSpeed = this.cornerSpeed(Math.abs(points[index % points.length]!.curvatureRadius), grip, topSpeed);
      const brakingDistance = Math.max(0, distance - speed * 0.15);
      targetSpeed = Math.min(targetSpeed, Math.sqrt(cornerSpeed ** 2 + 2 * deceleration * brakingDistance));
    }

    const targetU = track.u + lookahead / this.line.length;
    const look = sampleRacingLine(this.line, targetU);
    const halfWidth = this.options.halfWidth ?? 1;
    const halfLength = this.options.halfLength ?? 2.2;
    const clearance = Math.max(0, difficulty.DIFFICULTY_OVERTAKE_CLEARANCE);
    const laneLimit = Math.max(0, look.halfWidth - halfWidth - 0.25);
    const preferredLane = clamp(look.offset + packSlot * difficulty.DIFFICULTY_LINE_VARIATION, -laneLimit, laneLimit);
    const obstacles = (frame.obstacles ?? []).map(obstacle => {
      const combinedHalfWidth = halfWidth + (obstacle.halfWidth ?? 1);
      return {
        ...obstacle,
        distance: trackProgressDelta(track.u, obstacle.u) * this.line.length,
        clearance: combinedHalfWidth + clearance,
        minClearance: combinedHalfWidth + 0.4,
        length: halfLength + (obstacle.halfLength ?? 2.2),
      };
    });
    let targetLane = preferredLane;
    let passingLeader = false;
    const leader = obstacles
      .filter(other => other.distance > -other.length * 0.5 && other.distance - other.length <= horizon
        && Math.abs(other.lateralOffset - preferredLane) < other.clearance)
      .sort((a, b) => a.distance - a.length - (b.distance - b.length))[0];
    if (leader) {
      const passHorizon = Math.max(leader.distance + leader.length + 12, lookahead);
      const isClear = (lane: number, useMin: boolean) => obstacles.every(other =>
        other.distance < -other.length - speed * 0.4 || other.distance > passHorizon + other.length
        || Math.abs(lane - other.lateralOffset) >= (useMin ? other.minClearance : other.clearance));
      const sortByNearest = (lanes: number[]) =>
        lanes.sort((a, b) => Math.abs(a - track.lateralOffset) - Math.abs(b - track.lateralOffset));
      const preferredPass = sortByNearest([leader.lateralOffset - leader.clearance, leader.lateralOffset + leader.clearance])
        .find(lane => Math.abs(lane) <= laneLimit && isClear(lane, false));
      const tightPass = preferredPass ?? sortByNearest([
        clamp(leader.lateralOffset - leader.clearance, -laneLimit, laneLimit),
        clamp(leader.lateralOffset + leader.clearance, -laneLimit, laneLimit),
      ]).find(lane => Math.abs(lane) <= laneLimit && isClear(lane, true));
      if (tightPass !== undefined) {
        targetLane = tightPass;
        passingLeader = true;
      }
    }

    // Brake for traffic in the lane we occupy or cross while changing lanes.
    let pinnedBehindStopped = false;
    for (const other of obstacles) {
      if (other.distance <= other.length * 0.4 || other.distance > horizon + other.length) continue;
      const passingCleanly = Math.abs(targetLane - other.lateralOffset) >= other.minClearance;
      if (passingCleanly) {
        if (Math.abs(track.lateralOffset - other.lateralOffset) >= other.minClearance) continue;
        const safeDistance = Math.max(0, other.distance - other.length - 1.5 - speed * 0.2);
        const braked = Math.sqrt(Math.max(0, other.speed ?? 0) ** 2 + 2 * deceleration * safeDistance);
        // Keep enough maneuvering speed to steer out of the blocked lane instead of deadlocking at 0 m/s.
        const floor = other.distance > other.length + 0.5 ? Math.min(targetSpeed, 5) : 0;
        targetSpeed = Math.min(targetSpeed, Math.max(braked, floor));
      } else {
        const laneMin = Math.min(track.lateralOffset, targetLane);
        const laneMax = Math.max(track.lateralOffset, targetLane);
        if (Math.abs(clamp(other.lateralOffset, laneMin, laneMax) - other.lateralOffset) >= other.clearance) continue;
        const safeDistance = Math.max(0, other.distance - other.length - 3 - speed * 0.3);
        targetSpeed = Math.min(targetSpeed, Math.sqrt(Math.max(0, other.speed ?? 0) ** 2 + 2 * deceleration * safeDistance));
      }
      if (other.distance < other.length + 2.5 && Math.abs(track.lateralOffset - other.lateralOffset) < other.minClearance
        && (other.speed ?? 0) < 1.5) {
        pinnedBehindStopped = true;
      }
    }

    const laneRate = leader ? 8 : 4;
    this.laneOffset = clamp(lerp(this.laneOffset, targetLane, -Math.expm1(-laneRate * elapsed)), -laneLimit, laneLimit);
    const steerLookahead = passingLeader && leader && leader.distance > 0
      ? Math.min(lookahead, Math.max(6, leader.distance * 0.75))
      : lookahead;
    const target = sampleRacingLine(this.line, track.u + steerLookahead / this.line.length, this.laneOffset, false).position;
    const dx = target[0] - car.position[0];
    const dz = target[2] - car.position[2];
    const heading = Math.atan2(car.forward[0], car.forward[2]);
    const error = Math.hypot(dx, dz) > 1e-6 ? wrapAngle(Math.atan2(dx, dz) - heading) : 0;
    const derivative = this.previousError === undefined || elapsed <= 0
      ? 0 : clamp(wrapAngle(error - this.previousError) / elapsed, -4, 4);
    this.previousError = error;
    this.steer = lerp(this.steer, clamp(1.6 * error + 0.08 * derivative, -1, 1), -Math.expm1(-10 * elapsed));

    if (this.reverseTime > 0) {
      this.reverseTime = Math.max(0, this.reverseTime - elapsed);
      if (this.reverseTime > 0) return this.reverseControl(powerMultiplier);
    } else {
      this.blockedTime = (car.blocked || pinnedBehindStopped) && speed < 1.5 ? this.blockedTime + elapsed : 0;
      if (this.blockedTime > 2) {
        this.blockedTime = 0;
        this.reverseTime = 1.1;
        this.reverseSteer = error >= 0 ? -0.65 : 0.65;
        this.pedal = 0;
        return this.reverseControl(powerMultiplier);
      }
    }

    const alignedSpeed = targetSpeed * lerp(1, 0.32, clamp(Math.abs(error) / 1.3, 0, 1));
    const speedError = alignedSpeed - speed;
    const requestedPedal = clamp(speedError / (speedError < 0 ? 6 : 10), -1, 1);
    this.pedal = lerp(this.pedal, requestedPedal, -Math.expm1(-(requestedPedal < this.pedal ? 12 : 5) * elapsed));
    const boost = this.options.mode === "RACING_BOOST" && (frame.boostCharges ?? 0) > 0 && !frame.boostActive
      && speed > 14 && alignedSpeed > speed + 6 && this.pedal > 0.65 && Math.abs(this.steer) < 0.2 && !leader;
    return {
      throttle: Math.max(0, this.pedal), brake: Math.max(0, -this.pedal), steer: this.steer,
      handbrake: false, boost, powerMultiplier, driveDirection: 1,
    };
  }

  private cornerSpeed(radius: number, grip: number, topSpeed: number): number {
    return radius > 0 ? Math.min(topSpeed, Math.sqrt(grip * radius)) : topSpeed;
  }

  private reverseControl(powerMultiplier: number): CarControlOutput {
    return {
      throttle: 0.65, brake: 0, steer: this.reverseSteer, handbrake: false, boost: false, powerMultiplier, driveDirection: -1,
    };
  }
}
