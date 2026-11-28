import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  loadVehicleDatabases, parseGameData, parseRacingLine, parseSurfaceDatabase, parseTrackDatabase, resolveCarConfig,
  type Pair, type RacingLine, type ResolvedCarConfig,
} from "../src/formats/databases";
import { parse3dObjDb, parseBinInfo, parseXbx, type MeshPartGeometry, type SceneDatabase, type SceneRoot } from "../src/formats/xbx";
import type { DrivingInput } from "../src/input/inputManager";
import type { Vec3 } from "../src/math/mat4";
import { resolveBarrierContact, resolveCarCollision, saturateCollisionImpulse } from "../src/physics/collision";
import { TrackSpatial, type XbxModel } from "../src/physics/trackSpatial";
import { computeMassProperties, engineTorqueAtRpm, steeringTarget, VehiclePhysics } from "../src/physics/vehiclePhysics";
import { NodeVfs } from "../src/vfs/nodeVfs";
import { AiDriver, trackProgressDelta } from "../src/game/aiDriver";
import { RaceManager } from "../src/game/raceManager";
import { aiControlToDrivingInput, isAiCarBlocked } from "../src/app";

const near = (value: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(value - expected) <= tolerance, `expected ${value} ≈ ${expected} (±${tolerance})`);

function line(positions: Vec3[], width: number, length = 0): RacingLine {
  return {
    version: 1, creationDate: "", timestamp: 0, sceneName: "", tolerance: 0, reverse: false,
    length, edgeModifier: 1, flyingLapStartInterpolant: 0, metadata: {},
    points: positions.map(position => ({
      position, width, forward: [0, 0, 1], lateral: [1, 0, 0], offset: 0, curvatureRadius: 300,
    })),
  };
}

function mesh(vertices: Vec3[], indices: number[]): XbxModel {
  const part: MeshPartGeometry = {
    f: 0, g: 2, primaryTexture: null, vertexCount: vertices.length, stripCount: 0, word8: 0, word12: 0,
    descriptorExtension: new Uint32Array(), strips: [], indices: Uint16Array.from(indices),
    positions: Float32Array.from(vertices.flat()), packedAttributes: new Uint32Array(),
    normals: new Float32Array(), colors: new Uint8Array(),
  };
  return [{
    id: 1, radius: 0, bounds: new Float32Array(), flags: 0, group2Flags: 0, offsetX: 0, offsetZ: 0,
    groups: [[part], []], rawHeader: new Uint8Array(),
  }];
}

const openLine = line([], 0);
const flat = new TrackSpatial(mesh([[-120, 0, -150], [-120, 0, 800], [120, 0, 800], [120, 0, -150]],
  [0, 1, 2, 0, 2, 3]), undefined, openLine);
const ten = (fn: (i: number) => number): Pair[] => Array.from({ length: 10 }, (_, i) => [i / 10, fn(i)]);
const baseConfig: ResolvedCarConfig = {
  car: { id: "example", fields: {}, performance: [], liveries: [] },
  body: {
    id: "example", fields: { DIMENSIONS: [1.8, 1.5, 4] }, aerofoils: [],
    masses: [
      { component: "FRONT", position: [0.8, 0.6, 1], mass: 250 },
      { component: "FRONT", position: [-0.8, 0.6, 1], mass: 250 },
      { component: "REAR", position: [0.8, 0.6, -1], mass: 250 },
      { component: "REAR", position: [-0.8, 0.6, -1], mass: 250 },
    ],
    collisionSpheres: [{ position: [0, 0.6, 0], radius: 0.75 }],
  },
  shapeFolder: "",
  engine: {
    id: "example", fields: {
      MAX_RPM: 7000, TICKOVER_RPM: 1000, TORQUE_MODIFIER: 2, FUEL_CUTOFF: 0.2, ENGINE_BRAKING: 1,
      FLYWHEEL_MASS: 5, FLYWHEEL_RADIUS: 0.16, ACCELERATOR_SPEED: 8,
    },
    torque: [100, 160, 220, 250, 270, 250, 240, 210], torqueCurve: [], peakPowerRpm: 5500, inverseTurboMass: 1,
  },
  gearbox: { id: "example", fields: { DRIVE_TYPE: "RWD", CLUTCH_SPEED: 0.16, CLUTCH_MAX_POWER: 1800 } },
  frontTyre: { id: "example", fields: { RADIUS: 0.32, MASS: 30 }, sounds: [] },
  rearTyre: { id: "example", fields: { RADIUS: 0.32, MASS: 30 }, sounds: [] },
  brakes: { id: "example", BRAKE_SPEED: 6, BRAKE_RADIUS: [0.24, 0.24], BRAKE_MAX_FORCE: [6000, 5000], ADDITIONAL_BRAKING: 7000 },
  setup: {
    id: "example", fields: {},
    gearRatios: [-3, 3.3, 3.6, 2.2, 1.55, 1.15].map((ratio, i) => ({ index: i - 1, ratio })),
  },
  control: {
    id: "example", STEERING_ANGLE_MAX_SPEED: 60, STEERING_SPEED_MAX_SPEED: 60, STEERING_RETURN_SPEED: 3,
    STEERING_ANGLE_ARRAY: ten(i => 30 - i * 2), STEERING_SPEED_ARRAY: ten(i => 90 - i * 5),
    DPAD_INPUT_ARRAY: ten(i => (i / 9) ** 2), JOYPAD_PC_INPUT_ARRAY: [], JOYPAD_PS2_INPUT_ARRAY: [],
    JOYPAD_XBOX_INPUT_ARRAY: [], WHEEL_ANGLE_ARRAY: [], WHEEL_INPUT_ARRAY: [],
  },
};
const idle: DrivingInput = {
  throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, gearUpPressed: false,
  gearDownPressed: false, cameraNextPressed: false, lookBack: false, pausePressed: false,
  resetPressed: false, isAnalogSteer: true,
};
function run(car: VehiclePhysics, seconds: number, input: Partial<DrivingInput>): void {
  for (let frame = 0; frame < Math.round(60 * seconds); frame++) car.step(1 / 60, { ...idle, ...input });
}

test("point masses produce the origin tensor and setup ballast replaces the placeholder", () => {
  const body = {
    ...baseConfig.body,
    masses: [
      { component: "frame", mass: 3, position: [1, 2, 0] as const },
      { component: "ballast", mass: 99, position: [5, 5, 5] as const },
    ],
  };
  const ballast = { component: "BALLAST", mass: 1, position: [0, 0, 2] as const };
  const result = computeMassProperties(body, { ...baseConfig.setup, ballast });
  assert.equal(result.mass, 4);
  assert.deepEqual(result.centerOfMass, [0.75, 1.5, 0.5]);
  assert.deepEqual(result.inertiaTensor, [16, -6, 0, -6, 7, 0, 0, 0, 15]);
  assert.deepEqual(computeMassProperties({ ...body, masses: body.masses.slice(0, 1) }, { ...baseConfig.setup, ballast }), result);
});

test("torque interpolates uniform samples, responds to the accelerator, and limits free revs", () => {
  const engine = baseConfig.engine;
  near(engineTorqueAtRpm(engine, 1500), 380);
  near(engineTorqueAtRpm(engine, 7000), 420);
  near(engineTorqueAtRpm(engine, 8000), -300);
  const car = new VehiclePhysics(baseConfig, flat, { automatic: false });
  car.step(1 / 60, { ...idle, gearDownPressed: true });
  assert.equal(car.state.gear, 0);
  assert.equal(car.state.rpm, 1000);
  run(car, 0.5, { throttle: 1 });
  assert.ok(car.state.rpm > 2500, String(car.state.rpm));
  run(car, 3, { throttle: 1 });
  assert.ok(car.state.rpm >= 2500 && car.state.rpm < 8000, String(car.state.rpm));
  assert.ok(car.state.speedMps < 0.5, String(car.state.speedMps));
  run(car, 2, {});
  assert.ok(car.state.rpm < 1600, String(car.state.rpm));
});

test("manual frame edges shift once and automatic shifting follows road RPM with delay", () => {
  const manual = new VehiclePhysics(baseConfig, flat, { automatic: false });
  manual.step(0.09, { ...idle, gearUpPressed: true, throttle: 1 });
  assert.equal(manual.state.gear, 2);
  near(manual.state.wheels[2].angularVel, 0, 1e-3);
  run(manual, 1, { throttle: 1 });
  assert.equal(manual.state.gear, 2);
  assert.ok(manual.state.wheels[2].angularVel > 1);
  manual.step(1 / 120, { ...idle, gearDownPressed: true });
  assert.equal(manual.state.gear, 1);

  const auto = new VehiclePhysics(baseConfig, flat);
  run(auto, 3, { throttle: 1 });
  assert.ok(auto.state.speedMps > 8, String(auto.state.speedMps));
  assert.ok(auto.state.gear >= 2, `gear ${auto.state.gear}, RPM ${auto.state.rpm}, speed ${auto.state.speedMps}`);
  const before = auto.state.speedMps;
  run(auto, 2, { brake: 1 });
  assert.ok(auto.state.speedMps < before / 2, String(auto.state.speedMps));

  const reverse = new VehiclePhysics(baseConfig, flat);
  run(reverse, 1, { brake: 1 });
  assert.equal(reverse.state.gear, -1);
  assert.ok(reverse.state.linearVelocity[2] < -0.3);
});

test("subdivision matches successive 120 Hz steps and turbo spools only under load", () => {
  const tuned: ResolvedCarConfig = {
    ...baseConfig,
    engine: {
      ...baseConfig.engine,
      fields: { ...baseConfig.engine.fields, ASPIRATION_TYPE: "TURBO", MAX_TURBO_PRESSURE: 2, NUMBER_OF_TURBOS: 1 },
      inverseTurboMass: 0.2,
    },
  };
  const a = new VehiclePhysics(tuned, flat, { automatic: false });
  const b = new VehiclePhysics(tuned, flat, { automatic: false });
  const input = { ...idle, throttle: 1 };
  a.step(1 / 20, input);
  for (let i = 0; i < 6; i++) b.step(1 / 120, input);
  assert.deepEqual(a.state, b.state);
  assert.equal(a.state.inductionPressure, 0);
  run(a, 0.7, { throttle: 1 });
  assert.ok(a.state.inductionPressure > 0 && a.state.inductionPressure < 2);
  assert.ok(a.state.turboSpeed > 0);
  a.step(1 / 120, idle);
  assert.equal(a.state.inductionPressure, 0);
});

test("boost is edge-triggered, lasts seven seconds and replenishes between laps", () => {
  const car = new VehiclePhysics(baseConfig, flat);
  car.step(0.25, { ...idle, boost: true });
  assert.deepEqual([car.state.boostCharges, car.state.boostActive], [1, true]);
  near(car.state.boostTimer, 6.75);
  run(car, 6.75, { boost: true });
  assert.deepEqual([car.state.boostCharges, car.state.boostTimer, car.state.boostActive], [1, 0, false]);
  car.step(0.1, { ...idle, boost: true });
  assert.equal(car.state.boostCharges, 1);
  car.step(0.1, idle);
  car.step(0.1, { ...idle, boost: true });
  assert.equal(car.state.boostCharges, 0);
  const remaining = car.state.boostTimer;
  car.replenishBoost(3, 3);
  assert.equal(car.state.boostCharges, 0);
  car.replenishBoost(2, 3);
  assert.equal(car.state.boostCharges, 2);
  assert.equal(car.state.boostTimer, remaining);
});

test("steering uses the analog and D-pad curves, rate limits and return speed", () => {
  const { control } = baseConfig;
  near(steeringTarget(control, 0, 0.5, true), 15 * Math.PI / 180);
  near(steeringTarget(control, 30, -1, true), -20 * Math.PI / 180);
  assert.ok(steeringTarget(control, 0, 0.5, false) < steeringTarget(control, 0, 0.5, true));
  const car = new VehiclePhysics(baseConfig, flat);
  const h = 1 / 120;
  car.step(h, { ...idle, steer: 1 });
  near(car.state.steerAngleRad, Math.PI / 2 * h);
  assert.ok(car.state.wheels[1].steerAngle > car.state.wheels[0].steerAngle);
  assert.equal(car.state.wheels[2].steerAngle, 0);
  car.step(h, idle);
  near(car.state.steerAngleRad, 0);
});

test("ground selects the closest upward plane at XZ and resolves surface data", () => {
  const model = mesh([
    [0, 0, 0], [0, 0, 8], [8, 4, 0], [0, 5, 0], [0, 5, 8], [8, 9, 0],
    [0, 8, 0], [8, 8, 0], [0, 8, 8],
  ], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const surfaces = parseSurfaceDatabase(`
:START
:TYPE Road
:EFFECT_TYPE TARMAC
:FRICTION 0.9
:DRAG 0.1
:SURFACE_AI_GRIP_MODIFIER 1
:SURFACE_SINK_FACTOR 0
:BUMP_AMPLITUDE 0
:BUMP_FREQUENCY 0
:SURFACE_SCALE_BUMPS 0
:VALID_RACING_SURFACE 1
:END
`);
  const track = new TrackSpatial(model, undefined, openLine, { surfaces, defaultSurfaceName: "Road", cellSize: 2 });
  const ground = track.queryGround(2, 1.2, 2);
  near(ground.height, 1);
  near(ground.normal[0], -1 / Math.sqrt(5));
  near(ground.normal[1], 2 / Math.sqrt(5));
  assert.equal(ground.surface?.FRICTION, 0.9);
  const upper = track.queryGround(2, 8, 2);
  near(upper.height, 6);
  assert.equal(track.queryGround(8, 8, 8).hit, false);
});

test("racing line projection provides a smooth fallback, progress and inward corridor normals", () => {
  const route = line([[0, 0, -30], [0, 3, 0], [0, 6, 30], [0, 9, 60], [100, 9, 60], [100, 0, -30]], 14, 300);
  const track = new TrackSpatial([], undefined, route);
  const result = track.queryProgress(2, 15, 5);
  near(result.interpolant, 0.25);
  near(result.distanceAlongTrack, 75);
  near(result.lateralOffset, 2);
  near(result.halfWidth, 7);
  assert.deepEqual(result.right, [1, 0, -0]);
  near(track.queryGround(2, 3, 15).height, 4.5);
  assert.ok(track.queryGround(2, 3, 15).normal[2] < 0);
  assert.equal(track.queryGround(30, 3, 15).hit, false);
  const [contact] = track.queryBarrierContacts([{ center: [6.75, 5, 15], radius: 0.5 }]);
  assert.ok(contact);
  near(contact.penetration, 0.25);
  near(contact.normal[0], -1);
  near(contact.normal[2], 0);
  const before = track.queryProgress(-0.01, -30, 5).interpolant;
  const after = track.queryProgress(0, -29.99, 5).interpolant;
  assert.ok(Math.min(Math.abs(before - after), 1 - Math.abs(before - after)) < 0.001);
});

test("planar boundary groups do not create invisible walls and directed wall bounces use limited sliding friction", () => {
  const planarGroup = [
    { points: Float32Array.of(0, 0, 0, 20, 20, 20), lastWord: 0 },
    { points: Float32Array.of(0, 0, 20, 20, 20, 0), lastWord: 0 },
  ];
  const zoneOnly: SceneDatabase = {
    version: 18, header: new Uint32Array(), roots: [], animationGroups: [],
    boundaryGroups: [planarGroup], namedRecords: [],
  };
  const zoneTrack = new TrackSpatial([], zoneOnly, openLine);
  assert.deepEqual(zoneTrack.queryBarrierContacts([{ center: [10, 0, 10], radius: 1 }]), []);
  assert.deepEqual(zoneTrack.queryBarrierContacts([{ center: [0, 0, 10], radius: 1 }]), []);

  const wall = Buffer.alloc(28);
  wall.writeFloatLE(0, 4);
  wall.writeFloatLE(0, 8);
  wall.writeFloatLE(1, 16);
  wall.writeFloatLE(20, 20);
  const wallRoot: SceneRoot = {
    shapeId: 1, meshSlotId: 0, mode: 0, transforms: [], boundaries: [wall], modeBoundaries: [],
    points: new Float32Array(), references: [], secondaryRecords: [], cameras: [], modePairs: [],
    lodValues: new Float32Array(), declaredInlineChildren: 0, declaredChildPairs: 0, preMeshWords: new Uint32Array(),
    controlWords: [0, 0], meshPairs: [], children: { kind: "inline", nodes: [] },
  };
  const track = new TrackSpatial([], {
    version: 18, header: new Uint32Array(), roots: [wallRoot], animationGroups: [], boundaryGroups: [planarGroup], namedRecords: [],
  }, openLine);
  const car = new VehiclePhysics(baseConfig, track, { position: [-0.4, 1, 10] });
  car.state.linearVelocity = [6, 0, 15];
  const [contact] = track.queryBarrierContacts(car.getWorldSpheres());
  assert.ok(contact);
  const impulse = resolveBarrierContact(car, contact);
  near(impulse, 9000);
  near(car.linearVelocity[0], -3);
  assert.ok(car.linearVelocity[2] < 15 && car.linearVelocity[2] > 14);
  assert.equal(track.queryBarrierContacts(car.getWorldSpheres()).length, 0);
});

test("directed scene walls use XZ start, direction and length, handle endpoint corners, and supersede corridor fallback", () => {
  const raw = Buffer.alloc(28);
  raw.writeFloatLE(-3, 4);
  raw.writeFloatLE(-5, 8);
  raw.writeFloatLE(1, 16);
  raw.writeFloatLE(15, 20);
  const root: SceneRoot = {
    shapeId: 1, meshSlotId: 0, mode: 0, transforms: [], boundaries: [raw], modeBoundaries: [raw],
    points: new Float32Array(), references: [], secondaryRecords: [], cameras: [], modePairs: [],
    lodValues: new Float32Array(), declaredInlineChildren: 0, declaredChildPairs: 0, preMeshWords: new Uint32Array(),
    controlWords: [0, 0], meshPairs: [], children: { kind: "inline", nodes: [] },
  };
  const route = line([[0, 0, -20], [0, 0, 0], [0, 0, 20], [20, 0, 20], [20, 0, -20]], 4, 80);
  const track = new TrackSpatial([], {
    version: 18, header: new Uint32Array(), roots: [root], animationGroups: [], boundaryGroups: [], namedRecords: [],
  }, route, { cellSize: 4 });
  const contacts = track.queryBarrierContacts([{ center: [-3.25, 2, 9], radius: 0.5 }]);
  assert.equal(contacts.length, 1);
  near(contacts[0]!.penetration, 0.25);
  assert.deepEqual(contacts[0]!.point, [-3, 2, 9]);
  assert.deepEqual(contacts[0]!.normal, [-1, 0, 0]);
  // Beyond segment end past radius: no contact.
  assert.deepEqual(track.queryBarrierContacts([{ center: [-3.25, 2, 11], radius: 0.5 }]), []);
  // On the permitted side near an endpoint corner: endpoint contact prevents seam tunneling.
  const [corner] = track.queryBarrierContacts([{ center: [-3.3, 2, 10.3], radius: 0.5 }]);
  assert.ok(corner);
  near(corner.penetration, 0.5 - Math.hypot(0.3, 0.3));
  assert.deepEqual(corner.point, [-3, 2, 10]);
  // Outside the narrower racing-line halfWidth (2m) but not touching any scene wall: no invisible corridor wall.
  assert.deepEqual(track.queryBarrierContacts([{ center: [3, 2, 0], radius: 0.5 }]), []);
});

test("car sphere impacts saturate the impulse and conserve linear momentum", () => {
  const a = new VehiclePhysics(baseConfig, flat, { position: [0, 0, 0] });
  const b = new VehiclePhysics(baseConfig, flat, { position: [0, 0, 1.4] });
  a.state.linearVelocity = [0, 0, 100];
  b.state.linearVelocity = [0, 0, -100];
  const expected = 40000 * (1 - Math.exp(-105000 / 40000));
  near(saturateCollisionImpulse(-105000), expected);
  const j = a.collideWith(b);
  near(j, expected);
  near(a.linearVelocity[2] + b.linearVelocity[2], 0);
  assert.equal(a.state.lastImpactImpulse, j);
  assert.equal(b.state.lastImpactImpulse, j);
  near(b.state.position[2] - a.state.position[2], 1.5);
  a.state.linearVelocity = [0, 0, -1];
  b.state.linearVelocity = [0, 0, 1];
  assert.equal(resolveCarCollision(a, b), 0);
});

import { fileURLToPath } from "node:url";

const demo = fileURLToPath(new URL("../../game", import.meta.url));
test("local parsed track and car stay finite during a ten-second multi-maneuver run", { skip: !fs.existsSync(demo) }, async () => {
  const ascii = (file: string) => fs.readFileSync(path.join(demo, "DATA/ASCII", file), "utf8");
  const vfs = await NodeVfs.open(demo);
  const dir = "3ddata/tracks/engaf";
  const [binInfo, sceneData, meshes, vertices, db] = await Promise.all([
    vfs.readUnpacked(`${dir}/bininfo.bin`), vfs.readUnpacked(`${dir}/3dobjdb.bin`),
    vfs.readUnpacked(`${dir}/3dobjs.xbx`), vfs.readUnpacked(`${dir}/3dobjsp.xbx`),
    loadVehicleDatabases({ readText: async file => fs.readFileSync(path.join(demo, file), "utf8") }),
  ]);
  const route = parseRacingLine(ascii("TRACKS/ENGAF.DAT"));
  const surfaces = parseSurfaceDatabase(ascii("SURFACE.DAT"));
  const defaultSurfaceName = parseTrackDatabase(ascii("TRACKS.DAT")).get("engaf")!.DEFAULT_TRACK_SURFACE;
  const track = new TrackSpatial(parseXbx(meshes, vertices), parse3dObjDb(sceneData, parseBinInfo(binInfo)), route,
    { surfaces, defaultSurfaceName });
  for (let i = 0; i < route.points.length; i++) {
    const a = route.points[i]!.position;
    const b = route.points[(i + 1) % route.points.length]!.position;
    for (let k = 0; k < 4; k++) {
      const t = k / 4;
      const sample: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      assert.deepEqual(track.queryBarrierContacts([{ center: sample, radius: 1 }]), [],
        `unexpected barrier across ENGAF racing line at segment ${i}+${t}`);
    }
  }
  const [x, y, z] = route.points[0]!.position;
  const ground = track.queryGround(x, y, z);
  assert.ok(ground.hit && ground.surface);
  assert.ok(route.points.some(({ position: [px, py, pz] }) => Math.abs(track.queryGround(px, py, pz).height - py) > 10),
    "the binary mesh supplies elevations that are missing from the racing line");
  const progress = track.queryProgress(x, z);
  const car = new VehiclePhysics(resolveCarConfig(db, "focus_svt"), track, { automatic: false });
  car.resetToTrack(progress);
  assert.equal(car.state.wheels.filter(wheel => wheel.grounded).length, 4);
  let groundedFrames = 0, moved = 0;
  for (let frame = 0; frame < 600; frame++) {
    const next = car.step(1 / 60, {
      ...idle, throttle: frame < 460 ? 1 : 0, gearUpPressed: frame === 175,
      steer: frame >= 190 && frame < 330 ? 0.1 : 0, boost: frame >= 240,
      brake: frame >= 460 ? 0.8 : 0, handbrake: frame >= 525 && frame < 540,
    });
    if (next.wheels.some(wheel => wheel.grounded)) groundedFrames++;
    moved = Math.max(moved, Math.hypot(next.position[0] - x, next.position[2] - z));
    const numeric = [
      ...next.position, ...next.orientation, ...next.linearVelocity, ...next.angularVelocity, next.speedMps,
      next.rpm, next.steerAngleRad, next.boostTimer, next.lastImpactImpulse,
      ...next.wheels.flatMap(wheel => [...wheel.worldPos, wheel.compression, wheel.spinAngle, wheel.angularVel, wheel.slipAngle, wheel.slipRatio]),
    ];
    assert.ok(numeric.every(Number.isFinite), `finite state at frame ${frame}`);
    near(Math.hypot(...next.orientation), 1);
  }
  assert.equal(car.state.gear, 2);
  assert.equal(car.state.boostCharges, 1);
  assert.ok(moved > 10, String(moved));
  assert.ok(groundedFrames > 500, String(groundedFrames));
});

test("idle cars do not creep with engine roughness, braking respects tyre grip, and ground clearance lifts the body", () => {
  const roughConfig: ResolvedCarConfig = {
    ...baseConfig,
    body: {
      ...baseConfig.body,
      masses: [
        { component: "FRONT", position: [0.8, 0.6, 1.3], mass: 350 },
        { component: "FRONT", position: [-0.8, 0.6, 1.3], mass: 350 },
        { component: "REAR", position: [0.8, 0.6, -1.0], mass: 150 },
        { component: "REAR", position: [-0.8, 0.6, -1.0], mass: 150 },
      ],
    },
    engine: {
      ...baseConfig.engine,
      fields: { ...baseConfig.engine.fields, ROUGHNESS: 0.4, TORQUE_MODIFIER: 6 },
    },
    brakes: {
      ...baseConfig.brakes,
      BRAKE_MAX_FORCE: [30000, 30000],
      ADDITIONAL_BRAKING: 25000,
    },
  };
  const idling = new VehiclePhysics(roughConfig, flat, { position: [0, 0.05, 0], yaw: 0 });
  run(idling, 3, {});
  assert.ok(idling.state.speedMps < 0.1, `expected negligible idle creep, got ${idling.state.speedMps}`);

  // Extreme brake forces remain bounded by tyre friction rather than producing multi-g stops.
  const braking = new VehiclePhysics(roughConfig, flat, { position: [0, 0.05, 0], yaw: 0 });
  run(braking, 4, { throttle: 1 });
  const v0 = braking.state.speedMps;
  // The traction aid trades launch wheelspin for grip, so this front-heavy, table-less RWD car pulls a little less.
  assert.ok(v0 > 12, `expected speed > 12 m/s before braking, got ${v0}`);
  let brakeTime = 0;
  while (braking.state.speedMps > 1 && brakeTime < 10) {
    braking.step(1 / 120, { ...idle, brake: 1 });
    brakeTime += 1 / 120;
  }
  const decelG = ((v0 - braking.state.speedMps) / brakeTime) / 9.81;
  assert.ok(decelG >= 0.4 && decelG <= 1.6, `expected realistic braking g in [0.4, 1.6], got ${decelG}`);
  assert.ok(braking.state.up[1] > 0.8, `car should remain upright under hard braking, up.y=${braking.state.up[1]}`);

  // Positive CAR_GROUND_CLEARANCE lifts the body above ground instead of slamming it into the floor.
  const liftedConfig: ResolvedCarConfig = {
    ...baseConfig,
    setup: { ...baseConfig.setup, fields: { ...baseConfig.setup.fields, CAR_GROUND_CLEARANCE: [0.12, 0.12] } },
  };
  const lifted = new VehiclePhysics(liftedConfig, flat, { position: [0, 0.15, 0], yaw: 0 });
  run(lifted, 1, {});
  assert.ok(lifted.state.position[1] > 0.05, `expected positive ride height, got y=${lifted.state.position[1]}`);
  assert.equal(lifted.state.wheels.filter(w => w.grounded).length, 4);
});

test("inverted vehicles report flipped state and auto-right after staying upside down", () => {
  const car = new VehiclePhysics(baseConfig, flat, { position: [0, 0.5, 0], yaw: 0 });
  assert.equal(car.isFlipped, false);
  // Flip upside down around Z axis.
  car.state.orientation = [0, 0, 1, 0];
  car.state.up = [0, -1, 0];
  car.state.right = [-1, 0, 0];
  assert.equal(car.isFlipped, true);
  run(car, 1.2, {});
  assert.equal(car.isFlipped, false);
  assert.ok(car.state.up[1] > 0.9, `expected auto-upright up.y > 0.9, got ${car.state.up[1]}`);
});

test("representative local cars stay upright, do not creep at idle, and brake within realistic bounds", { skip: !fs.existsSync(demo) }, async () => {
  const ascii = (file: string) => fs.readFileSync(path.join(demo, "DATA/ASCII", file), "utf8");
  const db = await loadVehicleDatabases({ readText: async file => fs.readFileSync(path.join(demo, file), "utf8") });
  const surfaces = parseSurfaceDatabase(ascii("SURFACE.DAT"));
  const S = 10000;
  const bigFlat = new TrackSpatial(
    mesh([[-S, 0, -S], [-S, 0, S], [S, 0, S], [S, 0, -S]], [0, 1, 2, 0, 2, 3]),
    undefined,
    openLine,
    { surfaces, defaultSurfaceName: "TARMAC_ENGLAND" },
  );
  for (const id of ["FORD_GT", "GT90", "SHELBY_GR1", "66_GT40", "MODEL_T", "LIGHTNING_SVT", "CHAMP_CAR", "LISTER_LMP", "GT70", "MUSTANG_68"]) {
    if (!db.cars.has(id.toLowerCase())) continue;
    const cfg = resolveCarConfig(db, id);
    const idleCar = new VehiclePhysics(cfg, bigFlat, { position: [0, 0.05, 0], yaw: 0 });
    run(idleCar, 3, {});
    assert.ok(idleCar.state.speedMps < 0.2, `${id} idle creep ${idleCar.state.speedMps.toFixed(3)} m/s`);

    const fastCar = new VehiclePhysics(cfg, bigFlat, { position: [0, 0.05, 0], yaw: 0 });
    let minUp = 1;
    for (let i = 0; i < 12 * 60; i++) {
      fastCar.step(1 / 60, { ...idle, throttle: 1, steer: i >= 10 * 60 ? 1 : 0 });
      minUp = Math.min(minUp, fastCar.state.up[1]);
    }
    assert.ok(minUp > 0.5, `${id} flipped during high-speed run/steer (minUp=${minUp.toFixed(2)})`);

    const brkCar = new VehiclePhysics(cfg, bigFlat, { position: [0, 0.05, 0], yaw: 0 });
    for (let i = 0; i < 6 * 120 && brkCar.state.speedMps < 30; i++) brkCar.step(1 / 120, { ...idle, throttle: 1 });
    const v0 = brkCar.state.speedMps;
    let t = 0;
    let minUpBrk = 1;
    while (brkCar.state.speedMps > 1 && t < 15) {
      brkCar.step(1 / 120, { ...idle, brake: 1 });
      minUpBrk = Math.min(minUpBrk, brkCar.state.up[1]);
      t += 1 / 120;
    }
    const decelG = ((v0 - brkCar.state.speedMps) / t) / 9.81;
    assert.ok(minUpBrk > 0.5, `${id} flipped under braking (minUp=${minUpBrk.toFixed(2)})`);
    assert.ok(decelG >= 0.4 && decelG <= 1.6, `${id} braking ${decelG.toFixed(2)}g out of [0.4, 1.6]`);
  }
});

const yawDegrees = (car: VehiclePhysics) => Math.atan2(car.state.forward[0], car.state.forward[2]) * 180 / Math.PI;

test("an off-centre CoM and a traction-limited axle still track dead straight at full throttle with zero steering", () => {
  const offCentre: ResolvedCarConfig = {
    ...baseConfig,
    body: {
      ...baseConfig.body,
      // 1.5 cm lateral CoM offset and a rear-biased layout with far more torque than the tyres can transmit.
      masses: baseConfig.body.masses.map(point => ({
        ...point, position: [point.position[0] + 0.015, point.position[1], point.position[2] - 0.2] as const,
      })),
    },
    engine: { ...baseConfig.engine, fields: { ...baseConfig.engine.fields, TORQUE_MODIFIER: 6 } },
  };
  const car = new VehiclePhysics(offCentre, flat, { position: [0, 0.05, 0], yaw: 0 });
  let maxYaw = 0;
  for (let i = 0; i < 20 * 120; i++) {
    car.step(1 / 120, { ...idle, throttle: 1 });
    maxYaw = Math.max(maxYaw, Math.abs(yawDegrees(car)));
  }
  assert.ok(car.state.speedMps > 30, String(car.state.speedMps));
  assert.ok(maxYaw < 0.25, `yaw drifted ${maxYaw.toFixed(3)}°`);
  assert.ok(Math.abs(car.state.position[0]) < 0.25, `lateral drift ${car.state.position[0].toFixed(3)} m`);
  // Without the driving aids the same car lights up the rear tyres and loses the line.
  const raw = new VehiclePhysics(offCentre, flat, { position: [0, 0.05, 0], yaw: 0, tractionControl: false, stabilityControl: false });
  let rawYaw = 0;
  for (let i = 0; i < 20 * 120; i++) {
    raw.step(1 / 120, { ...idle, throttle: 1 });
    rawYaw = Math.max(rawYaw, Math.abs(yawDegrees(raw)));
  }
  assert.ok(rawYaw > maxYaw, `aids should improve straight-line stability (${rawYaw} vs ${maxYaw})`);
});

test("automatic gearbox climbs through every gear without hunting and drag calibrates to the rated top speed", () => {
  const rated: ResolvedCarConfig = {
    ...baseConfig,
    car: { ...baseConfig.car, fields: { CAR_APPROXIMATE_TOP_SPEED: 120 } },
  };
  const S = 12000;
  const long = new TrackSpatial(mesh([[-S, 0, -S], [-S, 0, S], [S, 0, S], [S, 0, -S]], [0, 1, 2, 0, 2, 3]), undefined, openLine);
  const car = new VehiclePhysics(rated, long, { position: [0, 0.05, 0], yaw: 0 });
  let last = car.state.gear, downshifts = 0, top = 0;
  for (let i = 0; i < 60 * 120; i++) {
    car.step(1 / 120, { ...idle, throttle: 1 });
    if (car.state.gear < last && car.state.speedMps > 5) downshifts++;
    last = car.state.gear;
    top = Math.max(top, car.state.speedMph);
  }
  assert.equal(downshifts, 0);
  assert.equal(car.state.gear, 4, `ended in gear ${car.state.gear} at ${car.state.rpm.toFixed(0)} rpm`);
  assert.ok(top > 120 * 0.9 && top < 120 * 1.08, `top speed ${top.toFixed(1)} mph vs 120 rated`);
  assert.ok(car.state.rpm < 0.97 * car.state.maxRpm, `parked on the limiter at ${car.state.rpm.toFixed(0)} rpm`);
});

const slope = (degrees: number, surfaces: ReturnType<typeof parseSurfaceDatabase>, surface: string) => {
  const t = Math.tan(degrees * Math.PI / 180);
  return new TrackSpatial(mesh([[-200, -200 * t, -200], [-200, 800 * t, 800], [200, 800 * t, 800], [200, -200 * t, -200]],
    [0, 1, 2, 0, 2, 3]), undefined, openLine, { surfaces, defaultSurfaceName: surface });
};

test("installed cars: straight-line stability, top speed, gearbox, braking and steep loose hill starts", { skip: !fs.existsSync(demo) }, async () => {
  const ascii = (file: string) => fs.readFileSync(path.join(demo, "DATA/ASCII", file), "utf8");
  const db = await loadVehicleDatabases({ readText: async file => fs.readFileSync(path.join(demo, file), "utf8") });
  const surfaces = parseSurfaceDatabase(ascii("SURFACE.DAT"));
  const S = 12000;
  const road = new TrackSpatial(mesh([[-S, 0, -S], [-S, 0, S], [S, 0, S], [S, 0, -S]], [0, 1, 2, 0, 2, 3]),
    undefined, openLine, { surfaces, defaultSurfaceName: "TARMAC_ENGLAND" });
  // QA pass 2 regressions: spinners, slow pullers, gear hunters, limiter-stuck, over-fast and over-braking cars.
  const cars = ["LISTER_LMP", "EXPLORER_2008", "GT70_PERFORMANCE", "RS200_EVOLUTION", "ESCORT_RS", "TAURUS_STOCK_A",
    "F250SD", "BOSS_302", "F150_STX", "EQUATOR", "FORD_GT", "MODEL_T"];
  for (const id of cars) {
    if (!db.cars.has(id.toLowerCase())) continue;
    const cfg = resolveCarConfig(db, id);
    // Expected top speed: the authored rating, or the authored top-gear rev limit when the gearing cannot reach it.
    const ratios = new Map(cfg.setup.gearRatios.map(({ index, ratio }) => [index, ratio]));
    const gears = Math.max(...ratios.keys());
    const drivenTyre = cfg.gearbox.fields.DRIVE_TYPE?.toUpperCase().startsWith("FRONT") ? cfg.frontTyre : cfg.rearTyre;
    const gearLimitMph = 0.95 * (cfg.engine.fields.MAX_RPM ?? 7000) * Math.PI / 30
      / Math.abs(ratios.get(gears)! * (ratios.get(0) || 1)) * (drivenTyre.fields.RADIUS ?? 0.32) * 2.236936;
    const rated = Math.min(cfg.car.fields.CAR_APPROXIMATE_TOP_SPEED ?? 0, gearLimitMph);
    const car = new VehiclePhysics(cfg, road, { position: [0, 0.05, 0], yaw: 0 });
    let maxYaw = 0, top = 0, downshifts = 0, last = car.state.gear, minUp = 1;
    for (let i = 0; i < 45 * 120; i++) {
      car.step(1 / 120, { ...idle, throttle: 1 });
      if (i < 20 * 120) maxYaw = Math.max(maxYaw, Math.abs(yawDegrees(car)));
      if (car.state.gear < last && car.state.speedMps > 5) downshifts++;
      last = car.state.gear;
      top = Math.max(top, car.state.speedMph);
      minUp = Math.min(minUp, car.state.up[1]);
    }
    assert.ok(minUp > 0.9, `${id} rolled (up.y ${minUp.toFixed(2)})`);
    assert.ok(maxYaw < 0.5, `${id} yawed ${maxYaw.toFixed(2)}° in 20 s with zero steering`);
    assert.equal(downshifts, 0, `${id} hunted gears (${downshifts} full-throttle downshifts)`);
    // Top gear, unless it is an overdrive that cannot hold the speed (then the lower gear must be off the limiter).
    assert.ok(car.state.gear === gears || car.state.rpm < 0.94 * car.state.maxRpm,
      `${id} stuck on the limiter in gear ${car.state.gear}/${gears} at ${car.state.rpm.toFixed(0)} rpm`);
    assert.ok(top >= 0.85 * rated && top <= 1.1 * rated, `${id} top speed ${top.toFixed(1)} mph vs ${rated} rated`);

    const brk = new VehiclePhysics(cfg, road, { position: [0, 0.05, 0], yaw: 0 });
    for (let i = 0; i < 20 * 120 && brk.state.speedMps < 30; i++) brk.step(1 / 120, { ...idle, throttle: 1 });
    const v0 = brk.state.speedMps;
    let t = 0;
    while (brk.state.speedMps > 1 && t < 15) {
      brk.step(1 / 120, { ...idle, brake: 1 });
      t += 1 / 120;
    }
    const decelG = (v0 - brk.state.speedMps) / t / 9.81;
    assert.ok(decelG >= 0.45 && decelG <= 1.6, `${id} braking ${decelG.toFixed(2)} g`);
  }

  // 15° gravel grid start (ICECR/WATAF use GRAVEL) from the level grid pose, including a road tyre that authors no
  // off-road grip (FIESTA_ST) and a front-heavy RWD classic.
  const hill = slope(15, surfaces, "GRAVEL");
  for (const id of ["FIESTA_ST", "FOCUS_SVT", "BOSS_302", "FORD_GT", "RS200_EVOLUTION", "EQUATOR"]) {
    if (!db.cars.has(id.toLowerCase())) continue;
    const car = new VehiclePhysics(resolveCarConfig(db, id), hill, { position: [0, 0.05, 0], yaw: 0 });
    let minZ = 0;
    for (let i = 0; i < 4 * 120; i++) {
      car.step(1 / 120, { ...idle, throttle: 1 });
      minZ = Math.min(minZ, car.state.position[2]);
    }
    assert.ok(minZ > -1.5, `${id} slid ${(-minZ).toFixed(2)} m back down the grid`);
    assert.ok(car.state.linearVelocity[2] > 2.5, `${id} only reached ${car.state.linearVelocity[2].toFixed(2)} m/s uphill`);
  }
});

async function loadRealTrack(trackId: string) {
  const ascii = (file: string) => fs.readFileSync(path.join(demo, "DATA/ASCII", file), "utf8");
  const vfs = await NodeVfs.open(demo);
  const dir = `3ddata/tracks/${trackId.toLowerCase()}`;
  const [binInfo, sceneData, meshes, vertices, db] = await Promise.all([
    vfs.readUnpacked(`${dir}/bininfo.bin`), vfs.readUnpacked(`${dir}/3dobjdb.bin`),
    vfs.readUnpacked(`${dir}/3dobjs.xbx`), vfs.readUnpacked(`${dir}/3dobjsp.xbx`),
    loadVehicleDatabases({ readText: async file => fs.readFileSync(path.join(demo, file), "utf8") }),
  ]);
  const route = parseRacingLine(ascii(`TRACKS/${trackId.toUpperCase()}.DAT`));
  const record = parseTrackDatabase(ascii("TRACKS.DAT")).get(trackId.toLowerCase());
  const track = new TrackSpatial(parseXbx(meshes, vertices), parse3dObjDb(sceneData, parseBinInfo(binInfo)), route,
    { surfaces: parseSurfaceDatabase(ascii("SURFACE.DAT")), defaultSurfaceName: record?.DEFAULT_TRACK_SURFACE });
  const ground = (x: number, z: number) => {
    const p = track.queryProgress(x, z);
    const h = track.queryGround(x, p.point[1] + 4, z);
    return h.hit ? h.height : p.point[1];
  };
  const race = new RaceManager({
    line: route, ground, laps: 3, mode: "RACING", startU: 0.02, introSeconds: 1.4,
    entrants: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, carId: "X", isPlayer: i === 0 })),
  });
  return { db, route, record, track, grid: race.grid, game: parseGameData(ascii("GAMEDATA.DAT")) };
}

/** Builds a car on a grid slot and holds it there on the handbrake for a second, as the race intro does. */
function gridCar(cfg: ResolvedCarConfig, track: TrackSpatial, slot: { position: Vec3; forward: Vec3 }): VehiclePhysics {
  const yaw = Math.atan2(slot.forward[0], slot.forward[2]);
  const pose: Vec3 = [slot.position[0], slot.position[1] + 0.05, slot.position[2]];
  const car = new VehiclePhysics(cfg, track, { position: pose, yaw });
  for (let i = 0; i < 60; i++) {
    car.step(1 / 60, { ...idle, throttle: 0.45, brake: 1, handbrake: true });
    car.setPose(pose, yaw);
  }
  return car;
}

const classicLineup = ["MODEL_T", "MODEL_A", "46_CONVERTIBLE", "49_COUPE", "49_COUPE_MOVIE", "THUNDERBIRD"];

test("rally and off-road tyres reach their rated tarmac top speed (load-proportional rolling resistance)", { skip: !fs.existsSync(demo) }, async () => {
  const ascii = (file: string) => fs.readFileSync(path.join(demo, "DATA/ASCII", file), "utf8");
  const db = await loadVehicleDatabases({ readText: async file => fs.readFileSync(path.join(demo, file), "utf8") });
  const S = 12000;
  const road = new TrackSpatial(mesh([[-S, 0, -S], [-S, 0, S], [S, 0, S], [S, 0, -S]], [0, 1, 2, 0, 2, 3]),
    undefined, openLine, { surfaces: parseSurfaceDatabase(ascii("SURFACE.DAT")), defaultSurfaceName: "TARMAC_ENGLAND" });
  // QA pass 3: these cars author ROLLING_RESISTANCE 0.04–0.08 and topped out at 94–124 mph against 135–192 rated.
  for (const id of ["RS200", "RS500_RALLY", "ESCORT_RS_RALLY", "GT70_OFFROAD", "FIESTA_RALLYE", "PUMA_RALLY",
    "ESCORT_RS2000_73_RALLY", "RANCH_1975_OFFROAD"]) {
    if (!db.cars.has(id.toLowerCase())) continue;
    const cfg = resolveCarConfig(db, id);
    assert.ok((cfg.rearTyre.fields.ROLLING_RESISTANCE ?? 0) >= 0.04, `${id} no longer authors a rally tyre`);
    const ratios = new Map(cfg.setup.gearRatios.map(({ index, ratio }) => [index, ratio]));
    const gears = Math.max(...ratios.keys());
    const drivenTyre = cfg.gearbox.fields.DRIVE_TYPE?.toUpperCase().startsWith("FRONT") ? cfg.frontTyre : cfg.rearTyre;
    const gearLimitMph = 0.95 * (cfg.engine.fields.MAX_RPM ?? 7000) * Math.PI / 30
      / Math.abs(ratios.get(gears)! * (ratios.get(0) || 1)) * (drivenTyre.fields.RADIUS ?? 0.32) * 2.236936;
    const rated = Math.min(cfg.car.fields.CAR_APPROXIMATE_TOP_SPEED ?? 0, gearLimitMph);
    const car = new VehiclePhysics(cfg, road, { position: [0, 0.05, 0], yaw: 0 });
    let top = 0;
    for (let i = 0; i < 50 * 60; i++) {
      car.step(1 / 60, { ...idle, throttle: 1 });
      top = Math.max(top, car.state.speedMph);
    }
    assert.ok(top >= 0.85 * rated && top <= 1.1 * rated, `${id} top speed ${top.toFixed(1)} mph vs ${rated.toFixed(0)} expected`);
    const parked = new VehiclePhysics(cfg, road, { position: [0, 0.05, 0], yaw: 0 });
    run(parked, 3, {});
    assert.ok(parked.state.speedMps < 0.2, `${id} idle creep ${parked.state.speedMps.toFixed(3)} m/s`);
  }
});

test("classic cars climb the steep ICECR gravel grid without rolling back", { skip: !fs.existsSync(demo) }, async () => {
  const { db, track, grid } = await loadRealTrack("ICECR");
  for (const id of classicLineup) {
    if (!db.cars.has(id.toLowerCase())) continue;
    const cfg = resolveCarConfig(db, id);
    // Slots 2–4 sit on the steepest part of the grid (12–14° of loose gravel).
    for (const index of [2, 3, 4]) {
      const slot = grid[index]!;
      const car = gridCar(cfg, track, slot);
      const start = [...car.state.position];
      const along = () => (car.state.position[0] - start[0]!) * slot.forward[0] + (car.state.position[2] - start[2]!) * slot.forward[2];
      let minAlong = 0, maxPitch = 0;
      for (let i = 0; i < 8 * 60; i++) {
        car.step(1 / 60, { ...idle, throttle: 1 });
        minAlong = Math.min(minAlong, along());
        maxPitch = Math.max(maxPitch, car.state.forward[1]);
      }
      assert.ok(maxPitch > Math.sin(10 * Math.PI / 180), `ICECR slot ${index} is no longer a steep grid`);
      assert.ok(minAlong > -0.5, `${id} slot ${index} rolled ${(-minAlong).toFixed(2)} m back down the ICECR grid`);
      assert.ok(along() > 15, `${id} slot ${index} only climbed ${along().toFixed(1)} m in 8 s`);
      assert.ok(car.state.up[1] > 0.9, `${id} slot ${index} tipped over`);
    }
  }
});

test("the classic lineup races up the PACBF hill and the ICECR/WATAF grids without stalling or reversing", { skip: !fs.existsSync(demo) }, async () => {
  for (const [trackId, seconds, minDistance] of [["PACBF", 40, 200], ["ICECR", 20, 70], ["WATAF", 20, 70]] as const) {
    const { db, route, record, track, grid, game } = await loadRealTrack(trackId);
    const offsets = record?.difficulty.MEDIUM;
    const trackScales = (offsets ? [0, 1, 2].map(i => clampTrackScale(1 + offsets[i]!)) : [1, 1, 1]) as [number, number, number];
    const racers = classicLineup.filter(id => db.cars.has(id.toLowerCase())).map((id, index) => {
      const car = gridCar(resolveCarConfig(db, id), track, grid[index]!);
      return {
        id, car, low: 0, reversing: 0,
        startU: track.queryProgress(car.state.position[0], car.state.position[2]).interpolant,
        ai: new AiDriver(route, { difficulty: game.difficulty.MEDIUM, trackScales, packSlot: ((index - 1) / 4) * 2 - 1, mode: "RACING" }),
      };
    });
    const lateral = (car: VehiclePhysics) => {
      const p = track.queryProgress(car.state.position[0], car.state.position[2]);
      const point = route.points[p.segmentIndex];
      const flip = point && point.lateral[0] * p.right[0] + point.lateral[2] * p.right[2] < 0 ? -1 : 1;
      return { u: p.interpolant, lateralOffset: flip * p.lateralOffset, speed: car.state.speedMps };
    };
    for (let frame = 0; frame < seconds * 60; frame++) {
      const views = racers.map(r => lateral(r.car));
      for (const [i, r] of racers.entries()) {
        const st = r.car.state;
        r.low = frame > 60 && st.speedMps < 1.5 ? r.low + 1 / 60 : st.speedMps >= 2 ? 0 : r.low;
        const out = r.ai.update(1 / 60, {
          car: { position: st.position, forward: st.forward, rotation: st.orientation, speed: st.speedMps,
            blocked: isAiCarBlocked(st.lastImpactImpulse, st.speedMps, r.low) },
          track: views[i]!, obstacles: views.filter((_, k) => k !== i),
        });
        if (out.driveDirection < 0) r.reversing++;
        r.car.step(1 / 60, aiControlToDrivingInput(out, st));
      }
      for (let a = 0; a < racers.length; a++) {
        for (let b = a + 1; b < racers.length; b++) resolveCarCollision(racers[a]!.car, racers[b]!.car);
      }
    }
    for (const r of racers) {
      const distance = trackProgressDelta(r.startU, lateral(r.car).u) * route.length;
      assert.equal(r.reversing, 0, `${trackId} ${r.id} reversed for ${(r.reversing / 60).toFixed(1)} s`);
      // QA pass 3: on PACBF 46_CONVERTIBLE stalled on the segment 8–11 climb and never got past 72 m.
      assert.ok(distance > minDistance, `${trackId} ${r.id} only covered ${distance.toFixed(0)} m in ${seconds} s`);
    }
  }
});

const clampTrackScale = (value: number) => Math.min(1.5, Math.max(0.5, value));
