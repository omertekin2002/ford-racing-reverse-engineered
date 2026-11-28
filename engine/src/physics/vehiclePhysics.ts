import type { BodyRecord, ControlRecord, EngineRecord, Pair, ResolvedCarConfig, SetupRecord, TyreRecord } from "../formats/databases";
import type { DrivingInput } from "../input/inputManager";
import { clamp, identity, invert, lerp, mat4FromQuatTranslation, quatFromAxisAngle, quatMultiply,
  transformDirection, wrapAngle, type Mat4, type Quat, type Vec3 } from "../math/mat4";
import { add, cross, dot, normalize, resolveBarrierContact, resolveCarCollision, resolveStaticContact,
  scale, sub, type CollisionBody } from "./collision";
import { TrackSpatial, type TrackProgress, type WorldSphere } from "./trackSpatial";

const gravity = 12.7530002594;
const degree = Math.PI / 180;
const rpmToRadians = 2 * Math.PI / 60;
/** Calibrated global tyre grip scale corresponding to fr3.exe's runtime 0x00597484 multiplier. */
const tyreGripScale = 0.37;
/** Effective tyre horizontal force height blend toward CoM (suspension roll/pitch center). */
const tyreRollCenterBlend = 0.45;
export const MAX_PHYSICS_STEP = 1 / 120;

type WheelTuple<T> = [T, T, T, T];
const wheelIndices = [0, 1, 2, 3] as const;
type WheelIndex = typeof wheelIndices[number];
const zero: Vec3 = [0, 0, 0];

export interface WheelPhysicsState {
  worldPos: Vec3;
  compression: number;
  steerAngle: number;
  spinAngle: number;
  angularVel: number;
  /** Signed tread speed deficit, normalized to [-1, 1]. */
  slipRatio: number;
  slipAngle: number;
  grounded: boolean;
  surfaceName: string;
}

export interface CarPhysicsState {
  /** Body model origin, in world coordinates. */
  position: Vec3;
  orientation: Quat;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  speedMps: number;
  speedMph: number;
  speedKph: number;
  rpm: number;
  maxRpm: number;
  redlineRpm: number;
  inductionPressure: number;
  turboSpeed: number;
  gear: number;
  throttle: number;
  brake: number;
  steerAngleRad: number;
  handbrake: boolean;
  boostCharges: number;
  boostTimer: number;
  boostActive: boolean;
  wheels: WheelTuple<WheelPhysicsState>;
  lastImpactImpulse: number;
}

export interface MassProperties {
  mass: number;
  centerOfMass: Vec3;
  /** Origin-based tensor, in column-major order. */
  inertiaTensor: readonly number[];
}

export function computeMassProperties(body: BodyRecord, setup: SetupRecord): MassProperties {
  const hasBallast = body.masses.some(point => point.component.toUpperCase() === "BALLAST");
  const points = body.masses.map(point => setup.ballast && point.component.toUpperCase() === "BALLAST" ? setup.ballast : point);
  if (setup.ballast && !hasBallast) points.push(setup.ballast);
  let mass = 0;
  let moment: Vec3 = [0, 0, 0];
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const { mass: m, position } of points) {
    const [x, y, z] = position;
    if (m <= 0) continue;
    mass += m;
    moment = add(moment, scale(position, m));
    xx += m * (y * y + z * z);
    yy += m * (x * x + z * z);
    zz += m * (x * x + y * y);
    xy -= m * x * y;
    xz -= m * x * z;
    yz -= m * y * z;
  }
  if (mass === 0) {
    const [width, height, length] = body.fields.DIMENSIONS ?? [2, 1.5, 4];
    mass = 1000;
    xx = mass * (height * height + length * length) / 12;
    yy = mass * (width * width + length * length) / 12;
    zz = mass * (width * width + height * height) / 12;
  }
  return { mass, centerOfMass: scale(moment, 1 / mass), inertiaTensor: [xx, xy, xz, xy, yy, yz, xz, yz, zz] };
}

function lookup(count: number, valueAt: (i: number) => number, x: number): number {
  const cell = clamp(Math.trunc(x), 0, count - 2);
  return count === 1 ? valueAt(0) : lerp(valueAt(cell), valueAt(cell + 1), clamp(x - cell, 0, 1));
}

function lookupPairs(rows: readonly Pair[] | undefined, x: number, fallback: number): number {
  return rows?.length ? lookup(rows.length, i => rows[i]![1], x) : fallback;
}

export function engineTorqueAtRpm(engine: EngineRecord, rpm: number): number {
  const max = engine.fields.MAX_RPM ?? 7000;
  const last = clamp(Math.trunc(max * 0.001), 0, Math.max(0, engine.torque.length - 1));
  const sample = (i: number) => engine.torque[i] ?? 0;
  if (rpm > max) return lerp(sample(last), -300, (rpm - max) * 0.001);
  return (engine.fields.TORQUE_MODIFIER ?? 1) * lookup(last + 1, sample, rpm * 0.001);
}

export function steeringTarget(
  control: ControlRecord, speed: number, input: number, analog: boolean,
): number {
  const maxSpeed = control.STEERING_ANGLE_MAX_SPEED > 0 ? control.STEERING_ANGLE_MAX_SPEED : 100;
  const maximum = lookupPairs(control.STEERING_ANGLE_ARRAY, 10 * Math.abs(speed) / maxSpeed, 30) * degree;
  const magnitude = clamp(Math.abs(input), 0, 1);
  const command = analog ? magnitude : lookupPairs(control.DPAD_INPUT_ARRAY, magnitude * 10, magnitude);
  return Math.sign(input) * command * maximum;
}

function combinedSlip(rows: TyreRecord["longitudinalSlip"], percent: number, angle: number, lateral: boolean): number {
  if (!rows?.length) return lateral ? clamp(angle / 0.18, 0, 1) : clamp(percent / 15, 0, 1);
  const degrees = angle / degree;
  const upper = rows.findIndex(row => row[0]! >= degrees);
  const index = clamp(upper === -1 ? rows.length - 2 : upper - 1, 0, rows.length - 1);
  const a = rows[index]!, b = rows[index + 1] ?? a;
  const t = b[0]! > a[0]! ? clamp((degrees - a[0]!) / (b[0]! - a[0]!), 0, 1) : 0;
  const columns = Math.min(a.length - 1, b.length - 1, lateral ? 20 : 10);
  return lookup(columns, col => lerp(a[col + 1]!, b[col + 1]!, t), percent * (lateral ? 0.19 : 0.1));
}

interface WheelSetup {
  mount: Vec3;
  tyre: TyreRecord;
  radius: number;
  mass: number;
  natural: number;
  minimum: number;
  maximum: number;
  spring: number;
  damper: number;
  /** Peak of the authored straight-line longitudinal slip curve, as a fraction of longitudinal capacity. */
  peakLongitudinal: number;
}

/** Tyre lateral and longitudinal force capacity at a vertical load, surface friction and camber. */
function tyreCapacity(wheel: WheelSetup, load: number, friction: number, road: boolean, camber = 0) {
  const tyre = wheel.tyre;
  const patch = Math.max(0, (tyre.fields.TYRE_PATCH_LENGTH ?? 0.08) * (tyre.fields.WIDTH ?? 0.24)
    * Math.max(0, 1 - camber * camber) ** 54);
  const grip = friction * (1 - 0.15 * clamp(patch / 0.1, 0, 1));
  const roadGrip = tyre.fields.ROAD_MAGIC_GRIP_NUMBER ?? 45;
  // A few road tyres author OFFROAD_MAGIC_GRIP_NUMBER 0, which would leave the car with no grip at all on gravel or
  // grass (sliding helplessly down any slope); treat a non-positive value as unspecified.
  const offroadGrip = tyre.fields.OFFROAD_MAGIC_GRIP_NUMBER ?? roadGrip;
  const runtimeGrip = road ? roadGrip : offroadGrip > 0 ? offroadGrip : roadGrip * defaultOffroadGripRatio;
  const loadProxy = Math.max(0, load / gravity + wheel.mass);
  const capacity = (0.8 + 5.4 * patch) * runtimeGrip * (100 * tyreGripScale)
    * lookupPairs(tyre.verticalLoad, loadProxy * 0.01, loadProxy * 0.01) * grip;
  const longCapacity = runtimeGrip > 0 ? capacity * roadGrip / runtimeGrip : 0;
  return { patch, capacity, longCapacity };
}

interface WheelContact {
  position: Vec3;
  point: Vec3;
  normal: Vec3;
  compression: number;
  spring: number;
  suspensionForce: number;
  grounded: boolean;
  surfaceName: string;
  friction: number;
  rollingDrag: number;
  road: boolean;
}

interface TyreForce {
  force: Vec3;
  longitudinal: number;
  lateral: number;
  slipRatio: number;
  slipAngle: number;
  forwardSpeed: number;
  /** Peak transmissible longitudinal force at the current load and surface. */
  tractionLimit: number;
}

interface WheelRuntime {
  length: number;
  extensionSpeed: number;
  lateralForce: number;
}

interface RigidState {
  center: Vec3;
  velocity: Vec3;
  orientation: Quat;
  momentum: Vec3;
}

interface Pose {
  center: Vec3;
  origin: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  rotation: Mat4;
  velocity: Vec3;
  omega: Vec3;
}

interface Derivative {
  velocity: Vec3;
  acceleration: Vec3;
  spin: Quat;
  torque: Vec3;
}

function qNormalize(q: Quat): Quat {
  const length = Math.hypot(...q);
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

export interface VehiclePhysicsOptions {
  /** The driving aid is enabled by default, including for manual hardware. */
  automatic?: boolean;
  /** Independent power scalar applied while boost is active. */
  boostTorqueMultiplier?: number;
  position?: Vec3;
  yaw?: number;
  /**
   * Traction-control driving aid: bounds driven-wheel slip near the tyre's peak so full throttle never
   * spins the driven axle up to the limiter (which strips lateral grip and spins the car). Enabled by default.
   */
  tractionControl?: boolean;
  /** Stability (yaw-control) driving aid that damps yaw beyond what the steering requests. Enabled by default. */
  stabilityControl?: boolean;
}

/** Driven-wheel slip ratio the traction aid holds, near the authored longitudinal peak (10–20%). */
const tractionSlipTarget = 0.12;
/** Share of the weaker driven wheel's peak traction the aid lets the axle use, keeping a lateral-grip reserve. */
const tractionReserve = 0.85;
/** Stability aid: yaw-rate damping (1/s) applied to yaw in excess of the steering's kinematic yaw rate. */
const stabilityYawDamping = 4;
/** Stability aid: bound on its yaw moment, as a share of weight times half-track (what selective braking can make). */
const stabilityMomentShare = 0.3;
/** Typical authored OFFROAD/ROAD magic-grip ratio, used when a tyre leaves its off-road grip unset (0). */
const defaultOffroadGripRatio = 0.88;
/** Absolute tread-speed margin (m/s) the traction aid permits so launches and hill starts keep full drive force. */
const tractionLaunchMargin = 1.2;
/**
 * Hill-start aid: on an uphill grade under throttle at low speed, the driven tyres may transmit enough longitudinal
 * force to climb at this acceleration (in g) on top of the grade, even when their authored grip could not hold the
 * car on a steep loose grid (classic cars author magic grip ~20 versus ~60 for rally tyres).
 */
const hillStartAcceleration = 0.15;
/** Upper bound on the hill-start aid's longitudinal grip multiplier. */
const hillStartMaxGrip = 3;
/** Road speeds (m/s) over which the hill-start aid fades out. */
const hillStartFadeSpeeds = [5, 10] as const;

/** Surface DRAG of the nominal tarmac (TARMAC_* surfaces author 0.001) used to calibrate top speed. */
const nominalSurfaceDrag = 0.001;

/**
 * Rolling resistance of one grounded wheel, in newtons at the tread.
 *
 * The tyre's ROLLING_RESISTANCE is a load-proportional coefficient (Crr · Fn): road tyres author 0.001 and the
 * rally/off-road tyres 0.04–0.08, the range of real knobbly tyres. The surface DRAG (tarmac 0.001, dirt 0.5, gravel
 * 0.75–2, grass 5) is a separate wheel-spin drag that grows with the cube of the wheel's revolutions per second.
 * Applying the tyre coefficient through that cubic spin law made rally tyres on tarmac cost 20 kN at 180 mph, far
 * more than any engine delivers.
 */
function wheelRollingResistance(wheel: WheelSetup, load: number, angularSpeed: number, surfaceDrag: number): number {
  const tyre = Math.max(0, wheel.tyre.fields.ROLLING_RESISTANCE ?? 0.001) * load;
  const spin = (angularSpeed / (2 * Math.PI)) ** 3 * (Math.max(0, surfaceDrag) * 0.1 + 0.001);
  return clamp(tyre + spin, 5, 100000);
}
/** Auto-shift: rpm ratio, relative to the previous gear's upshift point, below which the box downshifts. */
const downshiftHysteresis = 0.82;
/** Auto-shift: minimum time in a gear between automatic shifts (seconds). */
const autoShiftDwell = 0.6;
/** Upper bound for automatic upshifts, kept below the 0.97 * MAX_RPM fuel-cut redline. */
const upshiftRpmLimit = 0.94;
/** Peak pedal-braking force as a fraction of the tyre's longitudinal capacity. */
const brakeGripFraction = 1;
/**
 * Peak pedal-braking force per unit tyre load. The simulation's gravity is 12.753 m/s², so 1.1 bounds stops at
 * ~1.5 standard g even for high-grip slicks, matching road-car (~1 g) to race-car (~1.5 g) braking without downforce.
 */
const brakeLoadLimit = 1.1;
const mphToMps = 0.44704;

export class VehiclePhysics implements CollisionBody {
  readonly state: CarPhysicsState;
  readonly massProperties: MassProperties;
  readonly inverseMass: number;
  automatic: boolean;
  private readonly inertia: Mat4;
  private readonly inverseInertia: Mat4;
  private readonly gears: ReadonlyMap<number, number>;
  private readonly gearCount: number;
  private readonly finalDrive: number;
  private readonly derivedRpm: number;
  private readonly idleRpm: number;
  private readonly flywheel: number;
  private readonly shiftDelay: number;
  private readonly wheelSetup: WheelTuple<WheelSetup>;
  private readonly wheelRuntime: WheelTuple<WheelRuntime>;
  private readonly driveWeights: WheelTuple<number>;
  private readonly drivenAxles: readonly [boolean, boolean];
  private readonly boostTorqueMultiplier: number;
  private readonly groundProbes: readonly Vec3[];
  private readonly collisionSpheres: BodyRecord["collisionSpheres"];
  private readonly tractionControl: boolean;
  private readonly stabilityControl: boolean;
  private readonly drivenRadius: number;
  /** Aerodynamic drag coefficient applied to the DIMENSIONS frontal area. */
  readonly dragCoefficient: number;
  /** Per-gear automatic upshift rpm, indexed by forward gear (index 0 unused). */
  private readonly upshiftRpm: number[] = [];
  private autoShiftTimer = 0;
  private clutch = 0;
  private shiftRemaining = 0;
  private handbrakeAmount = 0;
  /** Hill-start aid multiplier on the driven tyres' longitudinal capacity for the current substep (1 = inactive). */
  private launchGrip = 1;
  /** Hill-start aid: hold the wheels against rolling opposite the drive direction (0–1). */
  private hillHold = 0;
  private boostHeld = false;
  private fuel = 0;
  private fuelOutput = 0;
  private enginePhase = 0;
  private engineLoad = 0;
  private flippedTime = 0;

  constructor(readonly config: ResolvedCarConfig, readonly track: TrackSpatial, options: VehiclePhysicsOptions = {}) {
    this.massProperties = computeMassProperties(config.body, config.setup);
    this.inverseMass = 1 / this.massProperties.mass;
    this.inertia = identity();
    const tensor = this.massProperties.inertiaTensor;
    for (let column = 0; column < 3; column++) {
      for (let row = 0; row < 3; row++) this.inertia[column * 4 + row] = tensor[column * 3 + row]!;
    }
    let inverse = invert(this.inertia);
    if (!inverse) {
      // A degenerate point-mass layout needs positive inertia on every axis.
      for (const i of [0, 5, 10]) this.inertia[i] = this.inertia[i]! + this.massProperties.mass * 0.1;
      inverse = invert(this.inertia);
    }
    this.inverseInertia = inverse!;
    this.gears = new Map(config.setup.gearRatios.map(({ index, ratio }) => [index, ratio]));
    this.gearCount = Math.max(1, ...this.gears.keys());
    this.finalDrive = Math.abs(this.gears.get(0) || 1);
    const engine = config.engine.fields;
    const maxRpm = Math.max(100, engine.MAX_RPM ?? 7000);
    this.idleRpm = clamp(engine.TICKOVER_RPM ?? 1000, 100, maxRpm);
    this.derivedRpm = clamp(config.engine.peakPowerRpm || maxRpm - 1500, this.idleRpm, maxRpm);
    this.flywheel = Math.max(0.05, (engine.FLYWHEEL_MASS ?? 8) * (engine.FLYWHEEL_RADIUS ?? 0.16));
    this.shiftDelay = Math.max(0.01, config.gearbox.fields.CLUTCH_SPEED ?? 0.2);
    this.automatic = options.automatic ?? true;
    this.boostTorqueMultiplier = Math.max(0, options.boostTorqueMultiplier ?? 1);

    const drive = config.gearbox.fields.DRIVE_TYPE?.toUpperCase();
    const allWheels = drive === "4WD" || drive === "AWD" || drive === "ALL_WHEELS";
    const frontWheels = drive === "FWD" || drive === "FRONT_WHEELS";
    const split = clamp(config.gearbox.fields.DRIVE_SPLIT ?? 0.5, 0, 1);
    const front = frontWheels ? 1 : allWheels ? split : 0;
    this.driveWeights = [front / 2, front / 2, (1 - front) / 2, (1 - front) / 2];
    this.drivenAxles = [frontWheels || allWheels, !frontWheels];
    const [width, height, length] = config.body.fields.DIMENSIONS ?? [2, 1.5, 4];
    const spheres = config.body.collisionSpheres.filter(({ radius }) => radius > 0);
    this.collisionSpheres = spheres.length ? spheres : [{ position: [0, height / 2, 0], radius: Math.max(0.1, width / 2) }];
    const setup = config.setup.fields;
    const lateralCentre = this.massProperties.centerOfMass[0];
    this.wheelSetup = wheelIndices.map((i): WheelSetup => {
      const axle = i < 2 ? 0 : 1;
      const tyre = axle === 0 ? config.frontTyre : config.rearTyre;
      const natural = Math.max(0.05, setup.SUSPENSION_NATURAL_LENGTH?.[axle] ?? 0.45);
      const radius = Math.max(0.05, tyre.fields.RADIUS ?? 0.32);
      // Model wheel anchors are unavailable in ResolvedCarConfig. Use the
      // authored half-track when set and estimate wheelbase from body length.
      const halfTrack = Math.abs(setup.WHEEL_SPACING?.[axle] ?? 0) || width * 0.42;
      const spring = Math.max(1, setup.SUSPENSION_MOE?.[axle] ?? 35000);
      const staticCompression = this.massProperties.mass * gravity * natural / (4 * spring);
      const clearance = setup.CAR_GROUND_CLEARANCE?.[axle] ?? 0;
      return {
        // Centre the estimated track on the chassis mass centreline: authored point masses leave millimetre-scale
        // lateral CoM offsets that would otherwise turn equal left/right drive forces into a constant yaw pull.
        mount: [lateralCentre + halfTrack * (i % 2 === 0 ? -1 : 1),
          natural + radius - staticCompression - clearance,
          length * (axle === 0 ? 0.28 : -0.28)],
        tyre, natural, radius, spring,
        mass: Math.max(1, tyre.fields.MASS ?? 30),
        minimum: clamp(Math.abs(setup.SUSPENSION_MIN_EXTENSION?.[axle] ?? 0.55 * natural), 0.02, natural),
        maximum: Math.max(natural, Math.abs(setup.SUSPENSION_MAX_EXTENSION?.[axle] ?? 1.4 * natural)),
        damper: Math.max(0, setup.SUSPENSION_DAMPING?.[axle] ?? 3800),
        peakLongitudinal: clamp(Math.max(0, ...(tyre.longitudinalSlip?.[0]?.slice(1) ?? [1])) || 1, 0.2, 1),
      };
    }) as WheelTuple<WheelSetup>;
    const [frontBumper, rearBumper] = config.body.fields.BUMPER_HEIGHT ?? [0.08, 0.08];
    this.groundProbes = [
      [-width * 0.35, frontBumper, length * 0.43], [width * 0.35, frontBumper, length * 0.43],
      [-width * 0.35, rearBumper, -length * 0.43], [width * 0.35, rearBumper, -length * 0.43],
      [-width * 0.4, 0.08, 0], [width * 0.4, 0.08, 0],
      ...this.wheelSetup.map(({ mount: [x, , z] }): Vec3 => [x, 0.1, z]),
    ];
    this.wheelRuntime = this.wheelSetup.map(({ natural }) => ({ length: natural, extensionSpeed: 0, lateralForce: 0 })) as WheelTuple<WheelRuntime>;
    this.tractionControl = options.tractionControl ?? true;
    this.stabilityControl = options.stabilityControl ?? true;
    const drivenWheels = wheelIndices.filter(i => this.driveWeights[i] > 0);
    this.drivenRadius = drivenWheels.length
      ? drivenWheels.reduce((sum: number, i) => sum + this.wheelSetup[i].radius, 0) / drivenWheels.length
      : this.wheelSetup[2].radius;
    for (let gear = 1; gear < this.gearCount; gear++) this.upshiftRpm[gear] = this.computeUpshiftRpm(gear, maxRpm);
    this.upshiftRpm[this.gearCount] = upshiftRpmLimit * maxRpm;
    this.dragCoefficient = this.calibrateDrag(maxRpm, width * height);
    this.state = {
      position: [0, 0, 0], orientation: [0, 0, 0, 1], forward: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0],
      linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0], speedMps: 0, speedMph: 0, speedKph: 0,
      rpm: this.idleRpm, maxRpm, redlineRpm: 0.97 * maxRpm, inductionPressure: 0, turboSpeed: 0,
      gear: 1, throttle: 0, brake: 0, steerAngleRad: 0,
      handbrake: false, boostCharges: 2, boostTimer: 0, boostActive: false, lastImpactImpulse: 0,
      wheels: wheelIndices.map((): WheelPhysicsState => ({
        worldPos: [0, 0, 0], compression: 0, steerAngle: 0, spinAngle: 0,
        angularVel: 0, slipRatio: 0, slipAngle: 0, grounded: false, surfaceName: "",
      })) as WheelTuple<WheelPhysicsState>,
    };
    if (options.position) {
      this.setPose(options.position, options.yaw ?? 0);
    } else {
      const [x, , z] = track.racingLine.points[0]?.position ?? zero;
      this.resetToTrack(track.queryProgress(x, z, 0));
      if (options.yaw !== undefined) this.setPose(this.state.position, options.yaw);
    }
  }

  get linearVelocity(): Vec3 { return this.state.linearVelocity; }
  get angularVelocity(): Vec3 { return this.state.angularVelocity; }
  get isFlipped(): boolean { return this.state.up[1] < 0.35; }
  get centerOfMassWorld(): Vec3 {
    return add(this.state.position, this.toWorld(this.massProperties.centerOfMass));
  }

  private toWorld(v: Readonly<Vec3>): Vec3 {
    const { right, up, forward } = this.state;
    return add(scale(right, v[0]), add(scale(up, v[1]), scale(forward, v[2])));
  }

  inverseInertiaWorld(v: Readonly<Vec3>): Vec3 {
    const { right, up, forward } = this.state;
    return this.toWorld(transformDirection(this.inverseInertia, [dot(v, right), dot(v, up), dot(v, forward)]));
  }

  getWorldSpheres(): WorldSphere[] {
    return this.collisionSpheres.map(({ position, radius }) => ({
      center: add(this.state.position, this.toWorld(position)), radius,
    }));
  }

  translate(offset: Vec3): void {
    this.state.position = add(this.state.position, offset);
    for (const wheel of this.state.wheels) wheel.worldPos = add(wheel.worldPos, offset);
  }

  applyImpulse(impulse: Vec3, point: Readonly<Vec3>): void {
    this.state.linearVelocity = add(this.linearVelocity, scale(impulse, this.inverseMass));
    const angular = cross(sub(point, this.centerOfMassWorld), impulse);
    this.state.angularVelocity = add(this.angularVelocity, this.inverseInertiaWorld(angular));
    this.updateSpeed();
  }

  /** Call after advancing both cars through the same simulation substep. */
  collideWith(other: VehiclePhysics): number {
    const impulse = resolveCarCollision(this, other);
    this.state.lastImpactImpulse = Math.max(this.state.lastImpactImpulse, impulse);
    other.state.lastImpactImpulse = Math.max(other.state.lastImpactImpulse, impulse);
    return impulse;
  }

  /** Place the model origin at the supplied position and clear accumulated motion. */
  setPose(position: Readonly<Vec3>, yaw: number): void {
    const state = this.state;
    state.position = [...position];
    state.orientation = quatFromAxisAngle([0, 1, 0], yaw);
    state.right = [Math.cos(yaw), 0, -Math.sin(yaw)];
    state.up = [0, 1, 0];
    state.forward = [Math.sin(yaw), 0, Math.cos(yaw)];
    state.linearVelocity = [0, 0, 0];
    state.angularVelocity = [0, 0, 0];
    state.rpm = this.idleRpm;
    state.gear = 1;
    state.throttle = state.brake = state.steerAngleRad = state.lastImpactImpulse = 0;
    state.handbrake = false;
    this.clutch = this.shiftRemaining = this.handbrakeAmount = this.fuel = this.fuelOutput = this.autoShiftTimer = 0;
    this.enginePhase = this.engineLoad = this.flippedTime = state.inductionPressure = state.turboSpeed = 0;
    this.updateSpeed();
    const pose = this.pose(this.rigidState());
    for (const i of wheelIndices) {
      const runtime = this.wheelRuntime[i];
      runtime.length = this.wheelSetup[i].natural;
      runtime.extensionSpeed = runtime.lateralForce = 0;
      const contact = this.wheelContact(pose, i);
      state.wheels[i] = {
        worldPos: contact.position, compression: contact.compression, grounded: contact.grounded,
        surfaceName: contact.surfaceName, steerAngle: 0, spinAngle: 0, angularVel: 0, slipRatio: 0, slipAngle: 0,
      };
    }
  }

  resetToTrack(progress: TrackProgress = this.track.queryProgress(this.state.position[0], this.state.position[2])): void {
    const { point: [x, y, z], forward } = progress;
    const ground = this.track.queryGround(x, y, z);
    this.setPose([x, (ground.hit ? ground.height : y) + 0.025, z], Math.atan2(forward[0], forward[2]));
  }

  replenishBoost(completedLap = 0, totalLaps = Infinity): void {
    if (completedLap < totalLaps) this.state.boostCharges = 2;
  }

  /** Consume frame edges once and run equal substeps no larger than 1/120 s. */
  step(dt: number, input: DrivingInput): CarPhysicsState {
    if (!Number.isFinite(dt) || dt <= 0) return this.state;
    if (input.resetPressed) this.resetToTrack();
    const state = this.state;
    state.lastImpactImpulse = 0;
    if (input.boost && !this.boostHeld && state.boostCharges > 0 && state.boostTimer === 0) {
      state.boostCharges--;
      state.boostTimer = 7;
    }
    this.boostHeld = input.boost;
    const manualShift = Number(input.gearUpPressed) - Number(input.gearDownPressed);
    if (manualShift) this.shift(state.gear + manualShift);

    const count = Math.ceil(dt / MAX_PHYSICS_STEP);
    const h = dt / count;
    for (let i = 0; i < count; i++) {
      state.boostActive = state.boostTimer > 0;
      this.updateControls(input, h);
      const driveTorque = this.updatePowertrain(h, manualShift === 0);
      this.updateHillStart();
      const rigid = this.integrateBody(h);
      this.applyPose(rigid);
      this.resolveTrackContacts();
      this.updateRolloverRecovery(h);
      this.updateWheels(this.pose(this.rigidState()), driveTorque, h);
      state.boostTimer = Math.max(0, state.boostTimer - h);
    }
    if (state.boostTimer < 1e-9) state.boostTimer = 0;
    state.boostActive = state.boostTimer > 0;
    return state;
  }

  private updateControls(input: DrivingInput, dt: number): void {
    const { state, config } = this;
    const brakeRate = Math.max(0, config.brakes.BRAKE_SPEED ?? 5);
    let throttle = clamp(input.throttle, 0, 1);
    let brake = clamp(input.brake, 0, 1);
    const forwardSpeed = dot(state.linearVelocity, state.forward);
    if (this.automatic && this.shiftRemaining === 0 && !input.handbrake) {
      if (brake > 0.1 && throttle === 0 && state.gear >= 0 && forwardSpeed < 0.5 && state.speedMps < 0.8) this.shift(-1);
      if (throttle > 0.1 && state.gear < 0 && forwardSpeed > -0.5 && state.speedMps < 0.8) this.shift(1);
    }
    if (this.automatic && state.gear < 0) [throttle, brake] = [brake, throttle];
    const ramp = Math.max(0, config.engine.fields.ACCELERATOR_SPEED ?? 10) * dt;
    state.throttle = throttle > state.throttle ? Math.min(throttle, state.throttle + ramp) : throttle;
    state.brake = Math.min(brake, state.brake + brakeRate * dt);
    state.handbrake = input.handbrake;
    this.handbrakeAmount = input.handbrake ? Math.min(1, this.handbrakeAmount + brakeRate * dt) : 0;

    const target = steeringTarget(config.control, state.speedMps, input.steer, input.isAnalogSteer);
    const speedScale = config.control.STEERING_SPEED_MAX_SPEED > 0 ? config.control.STEERING_SPEED_MAX_SPEED : 100;
    let rate = lookupPairs(config.control.STEERING_SPEED_ARRAY, 10 * state.speedMps / speedScale, 90) * degree;
    if (target * state.steerAngleRad < 0 || Math.abs(target) < Math.abs(state.steerAngleRad)) {
      rate *= Math.max(0, config.control.STEERING_RETURN_SPEED ?? 1);
    }
    state.steerAngleRad += clamp(target - state.steerAngleRad, -rate * dt, rate * dt);
    const tangent = Math.tan(state.steerAngleRad);
    const wheelbase = this.wheelSetup[0].mount[2] - this.wheelSetup[2].mount[2];
    for (const i of wheelIndices) {
      const toe = (config.setup.fields.WHEEL_TOE_IN?.[i < 2 ? 0 : 1] ?? 0) * degree;
      const steer = i < 2 ? Math.atan2(wheelbase * tangent, wheelbase - tangent * this.wheelSetup[i].mount[0]) : 0;
      state.wheels[i].steerAngle = steer + (i % 2 === 0 ? toe : -toe);
    }
  }

  private shift(gear: number): void {
    const next = clamp(gear, this.gears.has(-1) ? -1 : 0, this.gearCount);
    if (next === this.state.gear) return;
    this.state.gear = next;
    this.clutch = 0;
    this.shiftRemaining = this.shiftDelay;
  }

  private ratio(gear = this.state.gear): number {
    if (gear === 0) return 0;
    return (this.gears.get(gear) ?? (gear === 1 ? 1 : 0)) * this.finalDrive / (this.state.boostActive ? 1.4 : 1);
  }

  private drivenRpm(): number {
    const wheels = this.state.wheels;
    const frontRpm = (wheels[0].angularVel + wheels[1].angularVel) / (2 * rpmToRadians);
    const rearRpm = (wheels[2].angularVel + wheels[3].angularVel) / (2 * rpmToRadians);
    const ratio = this.ratio();
    return !this.drivenAxles[0] ? rearRpm
      : !this.drivenAxles[1] ? frontRpm
        : ratio < 0 ? Math.min(frontRpm, rearRpm) : Math.max(frontRpm, rearRpm);
  }

  /** Authored gear ratio times final drive, without the transient boost scaling. */
  private rawRatio(gear: number): number {
    if (gear === 0) return 0;
    return (this.gears.get(gear) ?? (gear === 1 ? 1 : 0)) * this.finalDrive;
  }

  /** Steady full-throttle engine torque, including forced induction at full boost pressure. */
  private steadyTorque(rpm: number): number {
    const engine = this.config.engine.fields;
    const aspiration = engine.ASPIRATION_TYPE?.toUpperCase();
    const maxPressure = Math.max(0, engine.MAX_TURBO_PRESSURE ?? 0);
    const pressure = aspiration === "TURBO" ? maxPressure
      : aspiration === "SUPER_CHARGER" ? maxPressure * rpm / Math.max(100, engine.MAX_RPM ?? 7000) : 0;
    return engineTorqueAtRpm(this.config.engine, rpm) * (1 + 0.1 * (engine.NUMBER_OF_TURBOS ?? 0) * pressure);
  }

  /** Clutch-transferred drive torque at full throttle (the powertrain loses 10% of transfer to engine load). */
  private steadyTransfer(rpm: number): number {
    return Math.max(0, Math.min(this.steadyTorque(rpm) / 1.1, this.config.gearbox.fields.CLUTCH_MAX_POWER ?? Infinity));
  }

  /** Steady full-throttle tractive force in a gear at a road speed, or 0 above the rev limit. */
  private steadyWheelForce(gear: number, speed: number, rpmLimit: number): number {
    const ratio = Math.abs(this.rawRatio(gear));
    const rpm = Math.max(0, speed) / this.drivenRadius * ratio / rpmToRadians;
    return ratio > 0 && rpm <= rpmLimit ? this.steadyTransfer(Math.max(rpm, this.idleRpm)) * ratio / this.drivenRadius : 0;
  }

  /** Tyre rolling resistance of all four wheels at a road speed on a nominal tarmac surface, at static load. */
  private rollingResistance(speed: number): number {
    const load = this.massProperties.mass * gravity / 4;
    return this.wheelSetup.reduce((sum, wheel) => sum
      + wheelRollingResistance(wheel, load, Math.abs(speed) / wheel.radius, nominalSurfaceDrag), 0);
  }

  /** Flat-road drag plus rolling resistance at a road speed. */
  private roadResistance(speed: number): number {
    const [width, height] = this.config.body.fields.DIMENSIONS ?? [2, 1.5, 4];
    return this.dragCoefficient * 0.6125 * width * height * speed * speed + this.rollingResistance(speed);
  }

  /**
   * Acceleration-optimal upshift point: the lowest rpm at which the next gear delivers at least the current
   * gear's tractive force at the same road speed, bounded below the fuel-cut redline.
   */
  private computeUpshiftRpm(gear: number, maxRpm: number): number {
    const limit = upshiftRpmLimit * maxRpm;
    const current = Math.abs(this.rawRatio(gear)), next = Math.abs(this.rawRatio(gear + 1));
    if (!(current > 0 && next > 0 && next < current)) return limit;
    const k = next / current;
    for (let rpm = Math.max(this.idleRpm * 1.5, this.derivedRpm * 0.6); rpm < limit; rpm += 25) {
      if (this.steadyTransfer(rpm * k) * k >= this.steadyTransfer(rpm)) return rpm;
    }
    return limit;
  }

  /**
   * CAR_APPROXIMATE_TOP_SPEED is authored for every car, while MODEL_CD_FACTOR does not map consistently onto a
   * drag coefficient (authored values span 0.16–45 for similar bodies). Calibrate the drag coefficient so flat-road
   * terminal velocity matches the authored top speed, or the authored gearing's top-gear rev limit when that is lower.
   */
  private calibrateDrag(maxRpm: number, area: number): number {
    const fallback = Math.max(0.32, (this.config.body.fields.MODEL_CD_FACTOR ?? 0) * 0.1);
    const rated = (this.config.car.fields.CAR_APPROXIMATE_TOP_SPEED ?? 0) * mphToMps;
    const topRatio = Math.abs(this.rawRatio(this.gearCount));
    if (!(rated > 0) || !(topRatio > 0) || !(area > 0)) return fallback;
    const rpmLimit = 0.95 * maxRpm;
    const gearLimited = rpmLimit * rpmToRadians / topRatio * this.drivenRadius;
    const target = Math.min(rated, gearLimited);
    let engineForce = 0;
    for (let gear = 1; gear <= this.gearCount; gear++) {
      engineForce = Math.max(engineForce, this.steadyWheelForce(gear, target, rpmLimit * 1.001));
    }
    // Each driven axle delivers its share of engine thrust up to the traction its tyres (and the traction aid) allow
    // at static load plus downforce on nominal tarmac.
    const { mass, centerOfMass } = this.massProperties;
    const frontZ = this.wheelSetup[0].mount[2], rearZ = this.wheelSetup[2].mount[2];
    const frontShare = clamp((centerOfMass[2] - rearZ) / (frontZ - rearZ), 0.1, 0.9);
    const downforce = (this.config.body.fields.MODEL_DOWNFORCE_FACTOR ?? 0) * 0.1 * 0.6125 * area * target * target;
    let force = 0;
    for (const axle of [0, 1] as const) {
      const share = this.driveWeights[axle * 2]! * 2;
      if (share <= 0) continue;
      const wheel = this.wheelSetup[axle * 2]!;
      const load = (mass * gravity * (axle === 0 ? frontShare : 1 - frontShare) + downforce / 2) / 2;
      const traction = 2 * wheel.peakLongitudinal * tyreCapacity(wheel, load, 0.95, true).longCapacity
        * (this.tractionControl ? tractionReserve : 1);
      force += Math.min(engineForce * share, traction);
    }
    const aero = force - this.rollingResistance(target);
    return aero > 0 ? clamp(aero / (0.6125 * area * target * target), 0.12, 4) : fallback;
  }

  /**
   * Hill-start aid (part of the traction aid). Under throttle in a drive gear at low road speed on an uphill grade, it
   * (1) lets the driven tyres transmit enough longitudinal force to climb the grade at hillStartAcceleration, and
   * (2) holds the wheels against rolling back, like a hill-hold brake. It is inactive on level ground, when
   * the throttle is released, while braking, and fades out by hillStartFadeSpeeds[1].
   */
  private updateHillStart(): void {
    this.launchGrip = 1;
    this.hillHold = 0;
    const { state } = this;
    const ratio = this.ratio();
    if (!this.tractionControl || ratio === 0 || state.throttle < 0.1 || state.brake > 0.05 || this.handbrakeAmount > 0) return;
    const driveSign = Math.sign(ratio);
    const roadSpeed = dot(state.linearVelocity, state.forward) * driveSign;
    const [fadeStart, fadeEnd] = hillStartFadeSpeeds;
    const active = 1 - clamp((Math.abs(roadSpeed) - fadeStart) / (fadeEnd - fadeStart), 0, 1);
    const grade = state.forward[1] * driveSign;
    if (active <= 0 || grade <= 0) return;
    this.hillHold = active;
    const pose = this.pose(this.rigidState());
    const contacts = wheelIndices.map(i => this.wheelContact(pose, i)) as WheelTuple<WheelContact>;
    const loads = this.contactLoads(contacts);
    // Usable drive force, as the traction aid shares it: each driven axle pushes with its weaker grounded wheel.
    let available = 0, rolling = 0;
    for (const axle of [0, 1] as const) {
      const grounded = (axle === 0 ? [0, 1] as const : [2, 3] as const).filter(i => contacts[i].grounded);
      for (const i of grounded) {
        rolling += wheelRollingResistance(this.wheelSetup[i], Math.max(0, loads[i]), 0, contacts[i].rollingDrag);
      }
      if (!this.drivenAxles[axle] || !grounded.length) continue;
      available += grounded.length * Math.min(...grounded.map(i =>
        tyreCapacity(this.wheelSetup[i], Math.max(0, loads[i]), contacts[i].friction, contacts[i].road).longCapacity));
    }
    if (!(available > 0)) return;
    // Ramp the climb reserve in over the first few degrees so gentle grades barely change.
    const required = rolling
      + this.massProperties.mass * gravity * (grade + hillStartAcceleration * clamp(grade / 0.05, 0, 1));
    this.launchGrip = lerp(1, clamp(required / available, 1, hillStartMaxGrip), active);
  }

  private autoShift(dt: number): void {
    const { gear, maxRpm, throttle } = this.state;
    this.autoShiftTimer = Math.max(0, this.autoShiftTimer - dt);
    if (gear === 0) {
      this.shift(1);
      return;
    }
    if (gear < 0 || (this.clutch < 0.99 && !this.state.handbrake)) return;
    const ratio = Math.abs(this.ratio(gear));
    if (ratio <= 0) return;
    // Shift on road speed, not driven-wheel speed, so launch wheelspin or a locked axle never trips a shift.
    const roadSpeed = Math.max(0, dot(this.state.linearVelocity, this.state.forward));
    const rpm = roadSpeed / this.drivenRadius * ratio / rpmToRadians;
    const lower = Math.abs(this.ratio(gear - 1));
    if (gear > 1 && lower > ratio) {
      // Downshift only when the lower gear lands well below its own upshift point (hysteresis prevents hunting).
      const lowerRpm = rpm * lower / ratio;
      const stalled = rpm < this.idleRpm * 1.1;
      if (stalled || (this.autoShiftTimer === 0 && lowerRpm < downshiftHysteresis * this.upshiftRpm[gear - 1]!)) {
        this.shift(gear - 1);
        this.autoShiftTimer = autoShiftDwell;
        return;
      }
    }
    if (gear >= this.gearCount || throttle <= 0.1 || this.autoShiftTimer > 0) return;
    // Driven wheels run slightly ahead of the road under drive; allow that tread slip (but not launch wheelspin)
    // so the upshift point stays reachable before the driven wheels reach the rev limit.
    const shiftRpm = Math.min(Math.max(rpm, this.drivenRpm() * ratio), rpm * 1.2);
    if (shiftRpm < this.upshiftRpm[gear]!) return;
    // Never upshift into a gear that cannot hold the current road speed against drag (avoids bog/limiter hunting).
    if (this.steadyWheelForce(gear + 1, roadSpeed, maxRpm) <= this.roadResistance(roadSpeed)) return;
    this.shift(gear + 1);
    this.autoShiftTimer = autoShiftDwell;
  }

  private updatePowertrain(dt: number, allowAutoShift: boolean): number {
    const { state, config } = this;
    const engine = config.engine.fields;
    const gearbox = config.gearbox.fields;
    const horizontalSpeed = Math.hypot(state.linearVelocity[0], state.linearVelocity[2]);
    this.shiftRemaining = Math.max(0, this.shiftRemaining - dt);
    if (this.shiftRemaining === 0) {
      if (allowAutoShift && this.automatic) this.autoShift(dt);
      if (this.shiftRemaining === 0) {
        if (state.throttle > 1e-4 || state.brake > 1e-4 || horizontalSpeed > 0.5) {
          this.clutch = Math.min(1, this.clutch + dt / this.shiftDelay);
        } else {
          this.clutch = Math.max(0, this.clutch - dt / this.shiftDelay);
        }
      }
    }
    const ratio = this.ratio();
    const { rpm, throttle, maxRpm } = state;
    const air = rpm / 60 * (engine.CAPACITY ?? 2) * 0.001;
    const aspiration = engine.ASPIRATION_TYPE?.toUpperCase();
    const maxPressure = Math.max(0, engine.MAX_TURBO_PRESSURE ?? 0);
    if (aspiration === "TURBO") {
      state.inductionPressure = throttle <= 0.2 || this.clutch <= 0.5 ? 0
        : clamp(lerp(state.inductionPressure, throttle ** 2 * maxPressure, 3 * dt), 0, maxPressure);
      state.turboSpeed = clamp(state.turboSpeed + dt * state.inductionPressure * 800000 * config.engine.inverseTurboMass, 0, 100000);
    } else if (aspiration === "SUPER_CHARGER") {
      state.inductionPressure = maxPressure * rpm / maxRpm;
    }

    const input = Math.max(throttle, clamp(1 - rpm / this.idleRpm, 0, 1));
    const fuelRate = Math.max(0, engine.MAX_DELTA_FUELFLOW ?? 1000);
    this.fuel += dt * clamp(10 * (air * input / 44100 - this.fuel), -fuelRate, fuelRate);
    if (rpm > state.redlineRpm && Math.sin(this.enginePhase) < 0.85) this.fuel *= clamp(engine.FUEL_CUTOFF ?? 0.7, 0, 1);
    const roughness = state.gear === -1 ? 0 : engine.ROUGHNESS ?? 0;
    if (roughness > 0) this.enginePhase = (this.enginePhase + rpm * rpmToRadians) % (2000 * Math.PI);
    const baseFuel = lerp(this.fuelOutput, air > 0 ? this.fuel * 44100 / air : 0, dt * 50);
    const roughRipple = throttle > 1e-4
      ? (1 - throttle) * Math.sin(this.enginePhase * 0.001) * roughness * clamp(1 - rpm / maxRpm, 0, 1)
      : 0;
    this.fuelOutput = clamp(baseFuel - roughRipple, 0, 1);

    let torque = engineTorqueAtRpm(config.engine, rpm) * (1 + 0.1 * (engine.NUMBER_OF_TURBOS ?? 0) * state.inductionPressure);
    if (torque > 0) torque *= this.fuelOutput * (state.boostActive ? this.boostTorqueMultiplier : 1);
    torque -= 0.1 * this.engineLoad + Math.max(0, (1 - throttle) * (1.4 + 0.1 * (this.gearCount - Math.abs(state.gear)))
      * ((rpm - this.idleRpm) / this.idleRpm) * 60 * (engine.ENGINE_BRAKING ?? 0));
    if (state.speedMps < 2.5 && rpm <= maxRpm) torque = Math.max(0, torque);

    const shiftOpen = this.shiftRemaining > 0;
    const free = this.fuelOutput * maxRpm * (ratio === 0 || shiftOpen ? 2 : 1);
    const drivenRpm = this.drivenRpm();
    const coupled = Math.max(0, drivenRpm * ratio);
    let engagement = ratio === 0 || shiftOpen ? 0 : this.clutch;
    if (Math.abs(state.gear) === 1 && coupled < this.derivedRpm && this.derivedRpm < free) {
      engagement = Math.min(engagement, Math.max(0.55, (this.derivedRpm - free) / (coupled - free)));
    }
    const correction = shiftOpen ? 2 * (free - rpm)
      : clamp(10 * (1 + engagement) * (lerp(free, coupled, engagement) - rpm), -6000, 6000);
    const predicted = rpm + dt * (correction + 60 * torque * (1 - engagement)) / this.flywheel;
    state.rpm = clamp(lerp(predicted, coupled, engagement * dt / this.shiftDelay), this.idleRpm, maxRpm * 1.05);
    const drivenTorque = throttle <= 1e-4 && torque > 0 ? 0 : torque;
    const transfer = Math.min(4 * engagement, 1) * Math.min(drivenTorque, gearbox.CLUTCH_MAX_POWER ?? Infinity);
    this.engineLoad = Math.max(0, transfer);
    return transfer * ratio;
  }

  private rigidState(): RigidState {
    const { orientation, right, up, forward, angularVelocity } = this.state;
    const localOmega: Vec3 = [dot(angularVelocity, right), dot(angularVelocity, up), dot(angularVelocity, forward)];
    return {
      center: this.centerOfMassWorld, velocity: this.linearVelocity, orientation,
      momentum: this.toWorld(transformDirection(this.inertia, localOmega)),
    };
  }

  private pose(state: RigidState): Pose {
    const rotation = mat4FromQuatTranslation(qNormalize(state.orientation), zero);
    const right: Vec3 = [rotation[0]!, rotation[1]!, rotation[2]!];
    const up: Vec3 = [rotation[4]!, rotation[5]!, rotation[6]!];
    const forward: Vec3 = [rotation[8]!, rotation[9]!, rotation[10]!];
    const localMomentum: Vec3 = [dot(state.momentum, right), dot(state.momentum, up), dot(state.momentum, forward)];
    return {
      center: state.center, velocity: state.velocity, rotation, right, up, forward,
      origin: sub(state.center, transformDirection(rotation, this.massProperties.centerOfMass)),
      omega: transformDirection(rotation, transformDirection(this.inverseInertia, localMomentum)),
    };
  }

  private applyPose(rigid: RigidState): void {
    const pose = this.pose(rigid);
    const state = this.state;
    state.position = pose.origin;
    state.orientation = qNormalize(rigid.orientation);
    state.right = pose.right;
    state.up = pose.up;
    state.forward = pose.forward;
    state.linearVelocity = pose.velocity;
    state.angularVelocity = pose.omega;
    this.updateSpeed();
  }

  private updateSpeed(): void {
    const state = this.state;
    state.speedMps = Math.hypot(...state.linearVelocity);
    state.speedMph = state.speedMps * 2.236936292;
    state.speedKph = state.speedMps * 3.6;
  }

  private wheelContact(pose: Pose, i: WheelIndex): WheelContact {
    const wheel = this.wheelSetup[i];
    const runtime = this.wheelRuntime[i];
    const mount = add(pose.origin, transformDirection(pose.rotation, wheel.mount));
    const probe = sub(mount, scale(pose.up, runtime.length + wheel.radius));
    const hit = this.track.queryGround(probe[0], probe[1], probe[2]);
    const planeDistance = (mount[1] - hit.height) * hit.normal[1]
      + dot(sub(mount, probe), [hit.normal[0], 0, hit.normal[2]]);
    const up = dot(pose.up, hit.normal);
    const requiredLength = (planeDistance - wheel.radius) / Math.max(0.1, up);
    const grounded = hit.hit && up > 0.1 && requiredLength <= wheel.maximum
      && requiredLength <= runtime.length + (wheel.tyre.fields.TYRE_GRIP_DEPTH ?? 0.1);
    const length = grounded ? clamp(requiredLength, wheel.minimum, wheel.maximum) : runtime.length;
    const position = sub(mount, scale(pose.up, length));
    const point = sub(position, scale(hit.normal, wheel.radius));
    const compression = wheel.natural - length;
    const spring = wheel.spring * compression / wheel.natural;
    const mountVelocity = add(pose.velocity, cross(pose.omega, sub(mount, pose.center)));
    const lengthSpeed = grounded ? dot(mountVelocity, hit.normal) / up : runtime.extensionSpeed;
    const bumpStop = grounded ? wheel.spring * Math.max(0, wheel.minimum - requiredLength) / wheel.natural : 0;
    return {
      position, point, normal: hit.normal, compression, spring, grounded,
      suspensionForce: spring - wheel.damper * lengthSpeed + bumpStop,
      surfaceName: grounded ? hit.surfaceName : "",
      friction: clamp(hit.surface?.FRICTION ?? 1, 0, 1),
      rollingDrag: Math.max(0, hit.surface?.DRAG ?? 0),
      road: hit.surface?.VALID_RACING_SURFACE ?? true,
    };
  }

  private contactLoads(contacts: WheelTuple<WheelContact>): WheelTuple<number> {
    const loads = contacts.map(contact => contact.suspensionForce) as WheelTuple<number>;
    const pair = (a: WheelIndex, b: WheelIndex, stiffness: number) => {
      const correction = (contacts[a].spring - contacts[b].spring) * stiffness * 0.0005;
      loads[a] += correction;
      loads[b] -= correction;
    };
    const setup = this.config.setup.fields;
    pair(0, 1, setup.ANTI_ROLLBAR_STIFFNESS?.[0] ?? 0);
    pair(2, 3, setup.ANTI_ROLLBAR_STIFFNESS?.[1] ?? 0);
    pair(0, 2, setup.ANTI_DIVE_STIFFNESS?.[0] ?? 0);
    pair(1, 3, setup.ANTI_DIVE_STIFFNESS?.[1] ?? 0);
    return loads;
  }

  private wheelEffectiveMass(i: WheelIndex): number {
    return this.wheelSetup[i].mass + (this.drivenAxles[i < 2 ? 0 : 1] ? Math.abs(this.ratio()) * this.flywheel : 0);
  }

  private tyreForce(pose: Pose, i: WheelIndex, contact: WheelContact, load: number, dt: number): TyreForce {
    if (!contact.grounded) {
      return { force: zero, longitudinal: 0, lateral: 0, slipRatio: 0, slipAngle: 0, forwardSpeed: 0, tractionLimit: 0 };
    }
    const wheel = this.wheelSetup[i];
    const tyre = wheel.tyre;
    const state = this.state.wheels[i];
    const { point, normal } = contact;
    const wheelHeading = add(scale(pose.forward, Math.cos(state.steerAngle)), scale(pose.right, Math.sin(state.steerAngle)));
    const side = normalize(cross(normal, wheelHeading), pose.right);
    const forward = normalize(cross(side, normal), pose.forward);
    const velocity = add(pose.velocity, cross(pose.omega, sub(point, pose.center)));
    const forwardSpeed = dot(velocity, forward), sideSpeed = dot(velocity, side);
    const speed = Math.hypot(forwardSpeed, sideSpeed);
    const tread = state.angularVel * wheel.radius;
    const deviation = tread - forwardSpeed;
    const slip = Math.min(100, Math.abs(forwardSpeed) < 1e-6 ? 20 : Math.abs(1 - Math.abs(tread / forwardSpeed)) * 100);
    const angle = Math.atan2(Math.abs(sideSpeed), Math.abs(forwardSpeed));
    const blend = clamp((0.4 * speed) ** 4, 0, 1);
    const slipAngle = Math.sign(sideSpeed) * angle * blend;

    const camber = clamp(dot(normal, cross(pose.up, wheelHeading)), -1, 1);
    const { patch, capacity, longCapacity } = tyreCapacity(wheel, load, contact.friction, contact.road, camber);
    const rpm = Math.abs(state.angularVel) / rpmToRadians;
    const boostLongScale = (this.state.boostActive ? 3 : 1) * (this.drivenAxles[i < 2 ? 0 : 1] ? this.launchGrip : 1);
    const boostLatScale = this.state.boostActive ? 1.5625 : 1;
    const longitudinalLimit = lerp(combinedSlip(tyre.longitudinalSlip, slip, 0, false),
      combinedSlip(tyre.longitudinalSlip, slip, angle, false), blend)
      * longCapacity * boostLongScale;
    const wheelMass = this.wheelEffectiveMass(i);
    const longitudinalConstraint = Math.abs(deviation) / (dt * (1 / wheelMass + this.inverseMass));
    let longitudinal = Math.sign(deviation) * Math.min(longitudinalConstraint,
      Math.max(0, lerp(longCapacity * boostLongScale, longitudinalLimit, clamp(rpm / 300, 0, 1))));
    const targetLateral = -Math.sign(sideSpeed) * combinedSlip(tyre.lateralSlip, slip, Math.abs(slipAngle), true)
      * capacity * boostLatScale;
    const relaxation = this.config.setup.fields.RELAXATION_LENGTH;
    const previous = this.wheelRuntime[i].lateralForce;
    const relax = Math.min(1, Math.abs(state.angularVel * dt / (2 * Math.PI) * (relaxation ?? 1))
      * (Math.abs(targetLateral) < Math.abs(previous) ? 5 : 1));
    const lateralConstraint = Math.abs(sideSpeed) / (dt * this.inverseMass * 4);
    const lockedLateral = Math.abs(sideSpeed) > 1e-4
      ? -Math.sign(sideSpeed) * Math.min(lateralConstraint,
        Math.max(Math.abs(targetLateral), capacity * 0.5 * clamp(Math.abs(sideSpeed), 0, 1)))
      : 0;
    let lateral = rpm <= 60 ? lockedLateral : relaxation ? lerp(previous, targetLateral, relax) : targetLateral;
    // Bound combined planar tyre force to the tyre's friction circle.
    const maxCombined = Math.max(capacity * boostLatScale, longCapacity * boostLongScale);
    const combinedMag = Math.hypot(longitudinal, lateral);
    if (maxCombined > 0 && combinedMag > maxCombined) {
      const shrink = maxCombined / combinedMag;
      longitudinal *= shrink;
      lateral *= shrink;
    }
    const camberForce = -Math.sign(camber) * 0.02 * capacity
      * lookupPairs(tyre.camberThrust, Math.abs(camber) / degree * 0.1, 0);
    // Pedal braking is tyre-limited: wheel-brake retardation plus ADDITIONAL_BRAKING never exceeds a fixed share of
    // the tyre's longitudinal capacity, keeping peak stops near 1.5 g even on high-grip slicks with downforce.
    const brakeLimit = Math.min(longCapacity * brakeGripFraction, brakeLoadLimit * load);
    const retarding = longitudinal * forwardSpeed < 0 ? Math.abs(longitudinal) : 0;
    if (this.state.brake > 0 && retarding > brakeLimit) longitudinal *= brakeLimit / retarding;
    const rawBrake = (this.config.brakes.ADDITIONAL_BRAKING ?? 0) * this.state.brake * 0.25;
    const maxExtraBrake = Math.max(0, brakeLimit - Math.min(retarding, brakeLimit));
    const additional = Math.sign(forwardSpeed) * Math.min(rawBrake, maxExtraBrake,
      Math.abs(forwardSpeed) / (dt * this.inverseMass * 4));
    return {
      force: add(scale(forward, longitudinal - additional), scale(side, lateral + camberForce)),
      longitudinal, lateral, forwardSpeed, slipRatio: -Math.sign(deviation) * slip / 100, slipAngle,
      // Mirrors the low-wheel-speed blend above: near standstill the tyre transmits its full capacity.
      tractionLimit: lerp(1, wheel.peakLongitudinal, clamp(rpm / 300, 0, 1)) * longCapacity * boostLongScale,
    };
  }

  private forces(rigid: RigidState, dt: number): Derivative {
    const pose = this.pose(rigid);
    const contacts = wheelIndices.map(i => this.wheelContact(pose, i)) as WheelTuple<WheelContact>;
    const loads = this.contactLoads(contacts);
    const [width, height] = this.config.body.fields.DIMENSIONS ?? [2, 1.5, 4];
    const speed = Math.hypot(...rigid.velocity);
    // Conventional dynamic pressure (0.5 * rho * A * v^2 = 0.6125 * A * v^2) with the calibrated drag coefficient.
    const dynamicPressureArea = 0.6125 * width * height * speed ** 2;
    const drag = this.dragCoefficient * dynamicPressureArea;
    const downforce = (this.config.body.fields.MODEL_DOWNFORCE_FACTOR ?? 0) * 0.1 * dynamicPressureArea;
    let force = add([0, -this.massProperties.mass * gravity, 0], scale(pose.up, -downforce));
    if (speed > 1e-9) force = add(force, scale(rigid.velocity, -drag / speed));
    let torque = scale(rigid.momentum, -0.6);
    for (const i of wheelIndices) {
      const contact = contacts[i];
      const suspension = contact.grounded ? Math.max(0, loads[i]) : 0;
      const tyre = this.tyreForce(pose, i, contact, suspension, dt);
      const spring = scale(contact.normal, suspension);
      force = add(force, add(spring, tyre.force));
      const tyrePoint: Vec3 = [
        contact.point[0],
        lerp(contact.point[1], rigid.center[1], tyreRollCenterBlend),
        contact.point[2],
      ];
      torque = add(torque, add(cross(sub(contact.position, rigid.center), spring),
        cross(sub(tyrePoint, rigid.center), tyre.force)));
    }
    if (this.stabilityControl) torque = add(torque, this.stabilityTorque(pose, contacts));
    const spin = quatMultiply([...pose.omega, 0], qNormalize(rigid.orientation));
    return {
      velocity: rigid.velocity, acceleration: scale(force, this.inverseMass), torque,
      spin: [spin[0] / 2, spin[1] / 2, spin[2] / 2, spin[3] / 2],
    };
  }

  /**
   * Stability aid (ESC): resist only the yaw rate in excess of the steering's kinematic yaw rate, as selective wheel
   * braking would. It never opposes the yaw the steering asks for (so it adds no understeer), fades out at parking
   * speeds and in the air, and is bounded by the yaw moment the tyres could realistically develop through braking.
   */
  private stabilityTorque(pose: Pose, contacts: WheelTuple<WheelContact>): Vec3 {
    const grounded = contacts.filter(contact => contact.grounded).length;
    // A deliberate handbrake slide is the driver's call, so the aid stands down while the handbrake is held.
    if (grounded < 3 || this.handbrakeAmount > 0) return zero;
    const forwardSpeed = dot(pose.velocity, pose.forward);
    const wheelbase = Math.max(0.5, this.wheelSetup[0].mount[2] - this.wheelSetup[2].mount[2]);
    const reference = forwardSpeed * Math.tan(this.state.steerAngleRad) / wheelbase;
    const yawRate = dot(pose.omega, pose.up);
    const excess = yawRate * reference > 0 && Math.abs(reference) > 1e-3
      ? Math.sign(yawRate) * Math.max(0, Math.abs(yawRate) - Math.abs(reference))
      : Math.abs(reference) <= 1e-3 ? yawRate : 0;
    const fade = clamp((Math.abs(forwardSpeed) - 3) / 7, 0, 1);
    const halfTrack = Math.abs(this.wheelSetup[1].mount[0] - this.wheelSetup[0].mount[0]) / 2;
    const limit = stabilityMomentShare * this.massProperties.mass * gravity * halfTrack;
    const moment = clamp(stabilityYawDamping * this.inertia[5]! * excess * fade, -limit, limit);
    return scale(pose.up, -moment);
  }

  private integrateBody(h: number): RigidState {
    const base = this.rigidState();
    const at = (d: Derivative, t: number): RigidState => ({
      center: add(base.center, scale(d.velocity, t)),
      velocity: add(base.velocity, scale(d.acceleration, t)),
      orientation: base.orientation.map((value, i) => value + t * d.spin[i]!) as Quat,
      momentum: add(base.momentum, scale(d.torque, t)),
    });
    const a = this.forces(base, h);
    const b = this.forces(at(a, h / 2), h);
    const c = this.forces(at(b, h / 2), h);
    const d = this.forces(at(c, h), h);
    const sum = (key: "velocity" | "acceleration" | "torque") => add(add(a[key], d[key]), scale(add(b[key], c[key]), 2));
    return at({
      velocity: sum("velocity"), acceleration: sum("acceleration"), torque: sum("torque"),
      spin: a.spin.map((value, i) => value + 2 * (b.spin[i]! + c.spin[i]!) + d.spin[i]!) as Quat,
    }, h / 6);
  }

  private resolveTrackContacts(): void {
    const state = this.state;
    for (let i = 0; i < 4; i++) {
      const contacts = this.track.queryBarrierContacts(this.getWorldSpheres());
      const deepest = contacts.reduce<typeof contacts[number] | undefined>((best, contact) =>
        !best || contact.penetration > best.penetration ? contact : best, undefined);
      if (!deepest) break;
      // Apply vertical-wall barrier impulses at CoM height so grazing wall contacts
      // generate realistic yaw and bounce without catapulting the car into a rollover.
      const barrierContact = Math.abs(deepest.normal[1]) < 0.2
        ? { ...deepest, point: [deepest.point[0], this.centerOfMassWorld[1], deepest.point[2]] as Vec3 }
        : deepest;
      state.lastImpactImpulse = Math.max(state.lastImpactImpulse, resolveBarrierContact(this, barrierContact));
    }
    let deepest = 0;
    let normal: Vec3 = [0, 1, 0], point = state.position;
    for (const probe of this.groundProbes) {
      const candidate = add(state.position, this.toWorld(probe));
      const ground = this.track.queryGround(...candidate);
      const penetration = (ground.height - candidate[1]) * ground.normal[1];
      if (ground.hit && penetration > deepest) {
        deepest = penetration;
        normal = ground.normal;
        point = candidate;
      }
    }
    if (deepest > 0) {
      this.state.lastImpactImpulse = Math.max(this.state.lastImpactImpulse, resolveStaticContact(this, point, normal, 0.05, 50000));
      this.translate(scale(normal, deepest));
    }
  }

  /** Auto-right the car if it ever remains inverted so it never slides upside down forever. */
  private updateRolloverRecovery(dt: number): void {
    const state = this.state;
    if (state.up[1] < 0.35) {
      this.flippedTime += dt;
      if (this.flippedTime >= 1.0) {
        const [x, y, z] = state.position;
        const ground = this.track.queryGround(x, y + 1, z);
        const yaw = Math.atan2(state.forward[0], state.forward[2]);
        const linearVelocity: Vec3 = [state.linearVelocity[0] * 0.5, 0, state.linearVelocity[2] * 0.5];
        this.setPose([x, (ground.hit ? ground.height : y) + 0.08, z], yaw);
        state.linearVelocity = linearVelocity;
        this.updateSpeed();
      }
    } else {
      this.flippedTime = Math.max(0, this.flippedTime - dt * 2);
    }
  }

  private updateWheels(pose: Pose, driveTorque: number, dt: number): void {
    const { state, config } = this;
    const contacts = wheelIndices.map(i => this.wheelContact(pose, i)) as WheelTuple<WheelContact>;
    const loads = this.contactLoads(contacts);
    const distribution = clamp(config.setup.fields.BRAKE_DISTRIBUTION ?? 0.6, 0, 1);
    const gearbox = config.gearbox.fields;
    const differential = gearbox.DIFF_TYPE?.toUpperCase();
    const brakeForce = config.brakes.BRAKE_MAX_FORCE;
    const brakeRadius = config.brakes.BRAKE_RADIUS;
    const axialBias = (axle: 0 | 1) => {
      if (differential === "QUAIFE" && axle === 0) return clamp((gearbox.TORQUE_SHIFT ?? 0) * state.steerAngleRad, -1, 1);
      if (differential !== "TORSON" && differential !== "TORSEN") return 0;
      const diff = (state.wheels[axle * 2]!.angularVel - state.wheels[axle * 2 + 1]!.angularVel) / rpmToRadians;
      const limit = axle === 1 && this.state.boostActive ? 0.1 : 1;
      return 0.1 * Math.sign(driveTorque) * clamp(0.005 * diff, -limit, limit);
    };
    const biases = [axialBias(0), axialBias(1)] as const;
    const tyres = wheelIndices.map(i => this.tyreForce(pose, i, contacts[i], Math.max(0, loads[i]), dt)) as WheelTuple<TyreForce>;
    // Traction aid: like an open differential, an axle can only push as hard as its less-loaded grounded wheel.
    // Limiting each driven wheel's drive force to that shared traction keeps left/right thrust equal, so roll-induced
    // load transfer cannot feed a yaw moment back into the car on a straight.
    const axleTraction = ([0, 1] as const).map(axle => {
      const pair = [tyres[axle * 2]!, tyres[axle * 2 + 1]!].filter((_, side) => contacts[axle * 2 + side]!.grounded);
      if (!pair.length) return Infinity;
      // Launches and hill starts may use all of it; the lateral reserve matters once the car is really moving.
      const speed = Math.max(...pair.map(tyre => Math.abs(tyre.forwardSpeed)));
      return Math.min(...pair.map(tyre => tyre.tractionLimit)) * lerp(1, tractionReserve, clamp((speed - 3) / 7, 0, 1));
    });
    for (const i of wheelIndices) {
      const wheel = this.wheelSetup[i], runtime = this.wheelRuntime[i], w = state.wheels[i];
      const contact = contacts[i];
      const tyre = tyres[i];
      if (contact.grounded) {
        runtime.length = wheel.natural - contact.compression;
        const up = dot(pose.up, contact.normal);
        const velocity = add(pose.velocity, cross(pose.omega, sub(contact.position, pose.center)));
        runtime.extensionSpeed = dot(velocity, contact.normal) / up;
      } else {
        // Two spring predictions advance the unsprung wheel to its travel stop.
        const accel = (length: number, speed: number) => (
          wheel.spring * (wheel.natural - length) / wheel.natural - wheel.damper * speed
        ) / wheel.mass + gravity * pose.up[1];
        const initial = accel(runtime.length, runtime.extensionSpeed);
        const provisional = runtime.extensionSpeed + initial * dt / 3;
        const predicted = accel(runtime.length + provisional * dt / 3, provisional);
        runtime.extensionSpeed += (initial + predicted) * dt / 2;
        const length = runtime.length + runtime.extensionSpeed * dt;
        runtime.length = clamp(length, wheel.minimum, wheel.maximum);
        if (runtime.length !== length) runtime.extensionSpeed = 0;
      }
      runtime.lateralForce = tyre.lateral;

      const axle = i < 2 ? 0 : 1;
      const driven = this.drivenAxles[axle];
      const left = i % 2 === 0;
      const engineDrive = driveTorque * this.driveWeights[i] * (1 + (left ? -1 : 1) * biases[axle]) / wheel.radius;
      const forwardDrive = engineDrive * (tyre.forwardSpeed || engineDrive) > 0;
      const drive = this.tractionControl && driven && forwardDrive && contact.grounded
        ? Math.sign(engineDrive) * Math.min(Math.abs(engineDrive), axleTraction[axle]!)
        : engineDrive;
      const speed = w.angularVel * wheel.radius;
      const effectiveMass = this.wheelEffectiveMass(i);
      const rolling = contact.grounded
        ? wheelRollingResistance(wheel, Math.max(0, loads[i]), Math.abs(w.angularVel), contact.rollingDrag) : 0;
      let free = speed + (drive - tyre.longitudinal) / effectiveMass * dt;
      free -= Math.sign(free) * Math.min(Math.abs(free), rolling / effectiveMass * dt);

      const pedal = state.brake * (axle === 0 ? 1 + (left ? -1 : 1) * 0.85 * Math.sin(state.steerAngleRad) : 1);
      const rearHandbrake = axle === 1 && this.handbrakeAmount > 0;
      const pad = config.setup.fields.BRAKE_PAD_FRICTION?.[axle] ?? 1;
      const brake = Math.max(0, 5.2 * (brakeForce?.[axle] ?? 3500) * (axle === 0 ? distribution : 1 - distribution)
        * (brakeRadius?.[axle] ?? 0.24) / wheel.radius * pad * pedal);
      const stop = rearHandbrake ? Math.abs(free) * 0.5 * this.handbrakeAmount
        : Math.min(Math.abs(free), brake / effectiveMass * dt);
      let tread = free - Math.sign(free) * stop;
      // Hill-start aid: like a hill-hold brake, no wheel may roll against the drive direction while it is active.
      if (this.hillHold > 0 && contact.grounded && tread * Math.sign(this.ratio()) < 0) {
        tread *= 1 - this.hillHold;
      }

      if (contact.grounded) {
        const road = tyre.forwardSpeed;
        const direction = Math.sign(road || drive || tread);
        const roadSpeed = Math.abs(road);
        const margin = Math.max(1, roadSpeed * clamp((1 - 0.01 * state.speedMps) * 0.45, 0.04, 0.45));
        if ((gearbox.ANTI_WHEELSPIN ?? 0) > 0 && driven && tread * direction > roadSpeed + margin) {
          tread = direction * (roadSpeed + margin);
        }
        if ((gearbox.ANTI_WHEELSKID ?? 0) > 0 && !rearHandbrake && state.brake > 0 && tread * direction < roadSpeed * 0.55) {
          tread = direction * roadSpeed * 0.55;
        }
        // Traction aid: hold driven tread speed near peak slip in the drive direction (also while rolling back
        // on a hill start) so excess torque never spins the axle up and strips its lateral grip.
        const driveSign = Math.sign(drive);
        if (this.tractionControl && driven && driveSign !== 0) {
          const along = road * driveSign;
          const allowed = along + tractionLaunchMargin + tractionSlipTarget * Math.max(0, along);
          if (tread * driveSign > allowed) tread = driveSign * allowed;
        }
      } else if (!driven) {
        tread *= 1 - dt;
      }
      const ratio = this.ratio();
      const limit = driven && ratio !== 0 ? state.maxRpm / Math.abs(ratio) : 5000;
      w.angularVel = clamp(tread / wheel.radius, -limit * rpmToRadians, limit * rpmToRadians);
      w.spinAngle = wrapAngle(w.spinAngle + w.angularVel * dt);
      const mount = add(pose.origin, transformDirection(pose.rotation, wheel.mount));
      w.worldPos = sub(mount, scale(pose.up, runtime.length));
      w.compression = wheel.natural - runtime.length;
      w.grounded = contact.grounded;
      w.surfaceName = contact.surfaceName;
      w.slipAngle = tyre.slipAngle;
      w.slipRatio = tyre.slipRatio;
    }
  }
}
