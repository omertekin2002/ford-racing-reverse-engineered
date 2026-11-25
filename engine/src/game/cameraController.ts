import type { CameraDefinition } from "../formats/databases";
import type { DrivingInput } from "../input/inputManager";
import {
  clamp, lerp, lookAtLH, mat4FromQuatTranslation, perspectiveLH,
  transformDirection, transformPoint, wrapAngle, type Mat4, type Vec3,
} from "../math/mat4";
import type { CarTelemetryView } from "./aiDriver";
import { sampleGroundHeight, type GroundSampleFn, type RacePhase } from "./raceManager";

const playableModes = ["CHASE_FAR", "CHASE_NEAR", "HOOD", "BUMPER"] as const;
export type PlayableCameraMode = typeof playableModes[number];
export type CameraMode = PlayableCameraMode | "LOOK_BACK" | "INTRO" | "FINISH";

export interface CameraPreset {
  readonly mount: Readonly<Vec3>;
  readonly target: Readonly<Vec3>;
  readonly fovDegrees: number;
  readonly showPlayerCar: boolean;
  readonly speedExpansion?: number;
  readonly speedFovDegrees?: number;
  readonly yawFrequency?: number;
  readonly heightRate?: number;
  readonly duration?: number;
}

export interface CameraOptions {
  readonly presets?: Partial<Record<CameraMode, CameraPreset>>;
  readonly ground?: GroundSampleFn;
  readonly groundClearance?: number;
  readonly near?: number;
  readonly far?: number;
}

export interface CameraFrame extends Partial<Pick<DrivingInput, "cameraNextPressed" | "lookBack">> {
  readonly car: CarTelemetryView;
  readonly aspect: number;
  readonly phase?: RacePhase;
  readonly phaseElapsed?: number;
}

export interface CameraView {
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  readonly fovYRad: number;
  readonly near: number;
  readonly far: number;
  readonly viewMatrix: Mat4;
  readonly projMatrix: Mat4;
  readonly modeName: CameraMode;
  readonly showPlayerCar: boolean;
}

const defaults: Record<CameraMode, CameraPreset> = {
  CHASE_FAR: {
    mount: [0, 3.8, -8], target: [0, 1.2, 2.6], fovDegrees: 58, showPlayerCar: true,
    speedExpansion: 3.4, speedFovDegrees: 11, yawFrequency: 5, heightRate: 6,
  },
  CHASE_NEAR: {
    mount: [0, 2.5, -4.8], target: [0, 1.1, 3.4], fovDegrees: 62, showPlayerCar: true,
    speedExpansion: 2.1, speedFovDegrees: 9, yawFrequency: 7, heightRate: 8,
  },
  HOOD: { mount: [0, 1.25, 1.25], target: [0, 1.12, 22], fovDegrees: 65, showPlayerCar: false },
  BUMPER: { mount: [0, 0.55, 2.35], target: [0, 0.65, 22], fovDegrees: 73, showPlayerCar: false },
  LOOK_BACK: { mount: [0, 2.65, 5.1], target: [0, 1.2, -3.5], fovDegrees: 64, showPlayerCar: true },
  INTRO: { mount: [0, 7, -16], target: [0, 1, 4], fovDegrees: 53, showPlayerCar: true, duration: 2 },
  FINISH: { mount: [0, 4.1, -9], target: [0, 1.1, 0], fovDegrees: 55, showPlayerCar: true, duration: 9 },
};

/** Adapt an authored mount and lens to a caller-assigned mode. */
export function cameraPresetFromDefinition(mode: CameraMode, definition: CameraDefinition): CameraPreset {
  const base = defaults[mode];
  return {
    ...base,
    mount: definition.mounting.CAMERA_SYSTEM_MOUNTING_OFFSET ?? base.mount,
    target: definition.fields.CAMERA_SYSTEM_CAMERA_OFFSET ?? base.target,
    fovDegrees: definition.fields.CAMERA_SYSTEM_CAMERA_FOV ?? base.fovDegrees,
    showPlayerCar: definition.fields.CAMERA_SYSTEM_CAMERA_SUBJECT_VISIBLE ?? base.showPlayerCar,
    duration: definition.fields.CAMERA_SYSTEM_CAMERA_TIME ?? base.duration,
  };
}

function yawOffset(origin: Readonly<Vec3>, offset: Readonly<Vec3>, yaw: number): Vec3 {
  const sine = Math.sin(yaw);
  const cosine = Math.cos(yaw);
  return [
    origin[0] + offset[0] * cosine + offset[2] * sine,
    origin[1] + offset[1],
    origin[2] + offset[2] * cosine - offset[0] * sine,
  ];
}

export class CameraController {
  private modeIndex = 0;
  private chaseYaw?: number;
  private chaseYawVelocity = 0;
  private chaseHeight?: number;
  private phaseTime = 0;
  private lastPhase?: RacePhase;
  private readonly presets: Record<CameraMode, CameraPreset>;
  private readonly near: number;
  private readonly far: number;

  constructor(private readonly options: CameraOptions = {}) {
    this.presets = { ...defaults, ...options.presets };
    this.near = options.near ?? 0.15;
    this.far = options.far ?? 1800;
    if (!(this.near > 0 && this.far > this.near && Number.isFinite(this.near))) {
      throw new RangeError("Invalid camera clipping planes");
    }
  }

  get mode(): PlayableCameraMode { return playableModes[this.modeIndex]!; }

  nextMode(): PlayableCameraMode {
    this.modeIndex = (this.modeIndex + 1) % playableModes.length;
    return this.mode;
  }

  /** Reset follow state after replacing or teleporting the subject. */
  reset(): void {
    this.chaseYaw = this.chaseHeight = undefined;
    this.chaseYawVelocity = this.phaseTime = 0;
    this.lastPhase = undefined;
  }

  update(dt: number, frame: CameraFrame): CameraView {
    const elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const { aspect, car, phase } = frame;
    if (!(aspect > 0 && Number.isFinite(aspect))) throw new RangeError("Camera aspect must be positive and finite");
    if (frame.cameraNextPressed) this.nextMode();
    const time = frame.phaseElapsed ?? (phase === this.lastPhase ? this.phaseTime + elapsed : 0);
    this.phaseTime = time;
    this.lastPhase = phase;

    const yaw = Math.atan2(car.forward[0], car.forward[2]);
    const speed = clamp(car.speed / 55, 0, 1);
    const chaseMode = this.mode === "CHASE_NEAR" ? "CHASE_NEAR" : "CHASE_FAR";
    const chase = this.presets[chaseMode];
    this.followYaw(yaw, Math.max(0.1, chase.yawFrequency ?? 5), elapsed);
    const desiredHeight = car.position[1] + chase.mount[1];
    this.chaseHeight = lerp(this.chaseHeight ?? desiredHeight, desiredHeight, -Math.expm1(-(chase.heightRate ?? 6) * elapsed));

    const modeName = phase === "INTRO" ? "INTRO" : phase === "FINISHED" ? "FINISH"
      : frame.lookBack ? "LOOK_BACK" : this.mode;
    const preset = this.presets[modeName];
    let eye: Vec3;
    let target: Vec3;
    let up: Vec3 = [0, 1, 0];
    if (modeName === "CHASE_FAR" || modeName === "CHASE_NEAR") {
      const mount: Vec3 = [...preset.mount];
      mount[2] -= speed * (preset.speedExpansion ?? 0);
      eye = yawOffset(car.position, mount, this.chaseYaw ?? yaw);
      eye[1] = this.chaseHeight;
      target = yawOffset(car.position, preset.target, yaw);
    } else if (modeName === "HOOD" || modeName === "BUMPER") {
      if (car.rotation) {
        const transform = mat4FromQuatTranslation(car.rotation, car.position);
        eye = transformPoint(transform, preset.mount);
        target = transformPoint(transform, preset.target);
        up = transformDirection(transform, up);
      } else {
        eye = yawOffset(car.position, preset.mount, yaw);
        target = yawOffset(car.position, preset.target, yaw);
      }
    } else if (modeName === "INTRO" || modeName === "FINISH") {
      const duration = Math.max(0.1, preset.duration ?? 3);
      const t = clamp(time / duration, 0, 1);
      const sweep = modeName === "INTRO" ? lerp(-1.8, -0.25, t * t * (3 - 2 * t)) : 0.65 + time * 2 * Math.PI / duration;
      eye = yawOffset(car.position, preset.mount, yaw + sweep);
      target = yawOffset(car.position, preset.target, yaw);
    } else {
      eye = yawOffset(car.position, preset.mount, yaw);
      target = yawOffset(car.position, preset.target, yaw);
    }

    const ground = sampleGroundHeight(this.options.ground, eye[0], eye[2]);
    if (ground !== undefined) eye[1] = Math.max(eye[1], ground + Math.max(0, this.options.groundClearance ?? 0.3));
    const fovYRad = clamp(preset.fovDegrees + speed * (preset.speedFovDegrees ?? 0), 10, 150) * Math.PI / 180;
    return {
      eye, target, up, fovYRad, near: this.near, far: this.far, modeName, showPlayerCar: preset.showPlayerCar,
      viewMatrix: lookAtLH(eye, target, up),
      projMatrix: perspectiveLH(fovYRad, aspect, this.near, this.far),
    };
  }

  private followYaw(target: number, frequency: number, dt: number): void {
    if (this.chaseYaw === undefined) {
      this.chaseYaw = target;
      return;
    }
    // Exact integration of a critically damped spring over a constant target.
    const error = wrapAngle(this.chaseYaw - target);
    const slope = this.chaseYawVelocity + frequency * error;
    const decay = Math.exp(-frequency * dt);
    this.chaseYaw = wrapAngle(target + (error + slope * dt) * decay);
    this.chaseYawVelocity = (this.chaseYawVelocity - frequency * slope * dt) * decay;
  }
}
