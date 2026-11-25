import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCameraDatabase, type RacingLine, type RaceDefinition } from "../src/formats/databases";
import { quatFromAxisAngle, transformPoint, type Vec3 } from "../src/math/mat4";
import {
  AiDriver, catchupPower, sampleRacingLine,
  type CarControlOutput, type CarTelemetryView, type GameDataDifficulty,
} from "../src/game/aiDriver";
import { QuickRaceSelector, RaceManager, type RaceObservation } from "../src/game/raceManager";
import { CameraController, cameraPresetFromDefinition, type CameraView } from "../src/game/cameraController";

function circuit(radius = 100, curveRadius = radius, width = 16): RacingLine {
  return {
    version: 1, creationDate: "synthetic", timestamp: 0, sceneName: "Practice", tolerance: 0,
    reverse: false, length: 2 * Math.PI * radius, edgeModifier: 0, flyingLapStartInterpolant: 0, metadata: {},
    points: Array.from({ length: 80 }, (_, i) => {
      const a = i * 2 * Math.PI / 80;
      return {
        position: [radius * (1 - Math.cos(a)), 0, radius * Math.sin(a)],
        forward: [Math.sin(a), 0, Math.cos(a)], lateral: [Math.cos(a), 0, -Math.sin(a)],
        width, offset: 0, curvatureRadius: curveRadius,
      };
    }),
  };
}

const difficulty: GameDataDifficulty = {
  DIFFICULTY_LINE_VARIATION: 0.5, DIFFICULTY_OVERTAKE_CLEARANCE: 0.75,
  CATCHUP_ADDITIONAL_START_POWER: 0, CATCHUP_SUBTRACTIVE_START_POWER: 0,
  CATCHUP_ADDITIONAL_POWER: 0.2, CATCHUP_SUBTRACTIVE_POWER: -0.25,
  CATCHUP_RANGE_AHEAD: 40, CATCHUP_RANGE_BEHIND: 80, CATCHUP_START_FADEOUT: 50, CATCHUP_STOP_FADEOUT: 100,
  CATCHUP_PACK_SPREAD: 8, CATCHUP_PACK_SHIFT: 0, CATCHUP_PACK_RATE_OF_CHANGE_PER_LAP: 0,
  CAR_BASE_DIFFICULTY_LEVEL: 0.6, CAR_DIFFICULTY_LEVEL_SPREAD: 0.2,
  AI_OVERTAKE_POWER_MODIFIER: 0, AI_DRAFTING_POWER_MODIFIER: 0, AI_RACELINE_POWER_BOOST: 0,
};

const baseCar: CarTelemetryView = { position: [0, 0, 0], forward: [0, 0, 1], speed: 20 };
const baseTrack = { u: 0, lateralOffset: 0 };

function approximate(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

test("AI follows a closed course, correcting steering in both directions", () => {
  const line = circuit();
  const start = sampleRacingLine(line, 0);
  assert.deepEqual(sampleRacingLine(line, 1), start);
  assert.deepEqual(sampleRacingLine(line, -0.25), sampleRacingLine(line, 0.75));
  const driver = new AiDriver(line, { difficulty });
  const right = driver.update(0.2, { car: { ...baseCar, forward: [-1, 0, 0] }, track: baseTrack });
  assert.ok(right.steer > 0.7);
  driver.reset();
  const left = driver.update(0.2, { car: { ...baseCar, forward: [1, 0, 0] }, track: baseTrack });
  assert.ok(left.steer < -0.7);
});

test("AI brakes in advance of a tight corner and accounts for grip and track scaling", () => {
  const line = circuit(100, 180);
  const corner = { ...line, points: line.points.map((point, i) => i === 3 ? { ...point, curvatureRadius: 75 } : point) };
  const frame = { car: { ...baseCar, speed: 32 }, track: baseTrack };
  const normal = new AiDriver(line, { difficulty }).update(0.25, frame);
  const precaution = new AiDriver(corner, { difficulty }).update(0.25, frame);
  const slippery = new AiDriver(corner, { difficulty, trackScales: [0.5, 1, 0.7] }).update(0.25, frame);
  assert.ok(normal.throttle > 0 && normal.brake === 0);
  assert.ok(precaution.brake > 0 && precaution.throttle === 0);
  assert.ok(slippery.brake > precaution.brake);
});

test("AI picks a free passing lane and brakes when clearance is unavailable", () => {
  const line = circuit();
  const leader = { u: 8 / line.length, lateralOffset: 0, speed: 2 };
  const rightBlocker = { u: 3 / line.length, lateralOffset: 2.75, speed: 2 };
  const leftBlocker = { u: 3 / line.length, lateralOffset: -2.75, speed: 2 };
  const update = (obstacles: readonly typeof leader[]) =>
    new AiDriver(line, { difficulty }).update(0.3, { car: baseCar, track: baseTrack, obstacles });
  const clear = update([]);
  const passLeft = update([leader, rightBlocker]);
  const passRight = update([leader, leftBlocker]);
  const blocked = update([leader, rightBlocker, leftBlocker]);
  assert.ok(passLeft.steer < clear.steer);
  assert.ok(passRight.steer > clear.steer);
  approximate(blocked.steer, clear.steer);
  assert.ok(blocked.brake > 0.8 && blocked.throttle === 0);
  const seamDriver = new AiDriver(line, { difficulty });
  const position = sampleRacingLine(line, 0.998);
  const seam = seamDriver.update(0.2, {
    car: { ...baseCar, position: position.position, forward: position.forward },
    track: { u: 0.998, lateralOffset: 0 }, obstacles: [{ ...leader, u: 0.004 }],
  });
  assert.ok(seam.brake > 0.7);
});

test("catchup power saturates behind and fades out ahead", () => {
  approximate(catchupPower(difficulty, 0), 1);
  approximate(catchupPower(difficulty, -40), 1.1);
  approximate(catchupPower(difficulty, -500), 1.2);
  approximate(catchupPower(difficulty, 20), 0.875);
  approximate(catchupPower(difficulty, 45), 0.75);
  approximate(catchupPower(difficulty, 75), 0.875);
  approximate(catchupPower(difficulty, 100), 1);
  approximate(catchupPower(difficulty, 500), 1);
  assert.ok(catchupPower(difficulty, 20, 1) > catchupPower(difficulty, 20, -1));
  const driver = new AiDriver(circuit(), { difficulty });
  approximate(driver.update(0.1, { car: baseCar, track: baseTrack, referenceGap: -500 }).powerMultiplier, 1.2);
});

test("AI uses boost on a clear fast segment and backs away after sustained barrier contact", () => {
  const line = circuit(250);
  const frame = { car: baseCar, track: baseTrack, boostCharges: 1 };
  const driver = new AiDriver(line, { difficulty, mode: "RACING_BOOST" });
  assert.ok(driver.update(0.5, frame).boost);
  assert.equal(driver.update(0.5, { ...frame, boostActive: true }).boost, false);
  assert.equal(new AiDriver(line, { difficulty }).update(0.5, frame).boost, false);
  const pinned = { ...frame, car: { ...baseCar, blocked: true, speed: 0.1 } };
  assert.equal(driver.update(2, pinned).driveDirection, 1);
  const reversing = driver.update(0.02, pinned);
  assert.equal(reversing.driveDirection, -1);
  assert.equal(reversing.boost, false);
  assert.equal(driver.update(0.2, frame).driveDirection, -1);
  assert.equal(driver.update(1, frame).driveDirection, 1);
});

const line = circuit();
const entrants = [{ id: "p", carId: "roadster", isPlayer: true }, { id: "a", carId: "tourer" }];

function observation(id: string, u: number, backwards = false): RaceObservation {
  const { position, forward } = sampleRacingLine(line, u);
  return {
    id, car: { ...baseCar, position, forward: backwards ? [-forward[0], -forward[1], -forward[2]] : forward },
    track: { u, lateralOffset: 0 },
  };
}

test("race grid honors the start offset and ground and unlocks mobility at GO", () => {
  const race = new RaceManager({ line, entrants, laps: 2, mode: "RACING", startU: 0.2, ground: () => ({ height: 3 }) });
  assert.equal(race.phase, "INTRO");
  assert.equal(race.canMove, false);
  const [player, opponent] = race.grid;
  assert.ok(player!.progress < 0 && player!.progress > opponent!.progress);
  approximate(player!.track.u, 0.2 + player!.progress);
  assert.ok(player!.track.lateralOffset < 0 && opponent!.track.lateralOffset > 0);
  for (const grid of race.grid) {
    assert.equal(grid.position[1], 3);
    assert.ok(grid.forward.every(Number.isFinite));
    approximate(Math.hypot(...grid.forward), 1);
    approximate(Math.hypot(...grid.rotation), 1);
  }
  race.update(2, [observation("p", 0.75)]);
  assert.equal(race.phase, "COUNTDOWN");
  assert.equal(race.countdownLabel, "3");
  assert.equal(race.canMove, false);
  assert.equal(race.standings[0]!.progress, player!.progress);
  for (const label of ["2", "1", "GO!"]) {
    race.update(1, []);
    assert.equal(race.countdownLabel, label);
  }
  assert.equal(race.phase, "RACING");
  assert.equal(race.canMove, true);
  race.update(1, []);
  assert.equal(race.countdownLabel, null);
  assert.equal(race.elapsedRaceTime, 1);
  assert.equal(race.tryBoost("p"), false);
});

test("race tracks both directions of the seam and awards laps and boost once", () => {
  const refills: [string, number][] = [];
  const race = new RaceManager({
    line, entrants, laps: 2, mode: "RACING_BOOST", introSeconds: 0, boostDuration: 2,
    onBoostReplenished: (id, charges) => refills.push([id, charges]),
  });
  const player = () => race.standings.find(row => row.id === "p")!;
  assert.equal(race.tryBoost("p"), false);
  race.update(3, []);
  assert.equal(race.tryBoost("p"), true);
  assert.equal(race.tryBoost("p"), false);
  race.update(1, [observation("p", 0.01)]);
  assert.equal(player().completedLaps, 0);
  assert.equal(player().boostActive, true);
  race.update(1, [observation("p", 0.99, true)]);
  assert.ok(player().progress < 0 && player().wrongWay);
  assert.equal(player().boostActive, false);
  race.update(1, [observation("p", 0.01)]);
  assert.equal(player().completedLaps, 0);
  assert.equal(player().wrongWay, false);
  for (const u of [0.32, 0.69, 0.99, 0.01]) race.update(1, [observation("p", u)]);
  assert.equal(player().completedLaps, 1);
  assert.equal(player().lap, 2);
  assert.ok(player().bestLapTime! > 0 && player().lapTime > 0 && player().lapTime < 1);
  assert.deepEqual(refills, [["p", 1]]);
  for (const u of [0.99, 0.01]) race.update(1, [observation("p", u)]);
  assert.equal(player().completedLaps, 1);
  assert.deepEqual(refills, [["p", 1]]);
  race.update(0.5, [observation("p", 0.005)]);
  assert.equal(player().wrongWay, true);
});

test("race ranks live leaders, resolves frame crossing order, and freezes player finish standings", () => {
  const race = new RaceManager({ line, entrants, laps: 1, mode: "RACING", introSeconds: 0 });
  race.update(3, []);
  for (const u of [0.01, 0.32, 0.69, 0.97]) {
    race.update(1, [observation("p", u), observation("a", u + 0.015)]);
  }
  assert.deepEqual(race.standings.map(({ id, place }) => [id, place]), [["a", 1], ["p", 2]]);
  race.update(1, [observation("p", 0.03), observation("a", 0.05)]);
  assert.equal(race.phase, "FINISHED");
  const final = race.finalStandings!;
  approximate(final[0]!.finishTime!, 4 + 0.015 / 0.065);
  approximate(final[1]!.finishTime!, 4.5);
  assert.equal(final[1]!.completedLaps, 1);
  const input: CarControlOutput = {
    throttle: 0, brake: 1, steer: -0.5, powerMultiplier: 1, handbrake: false, boost: false, driveDirection: 1,
  };
  const autopilot = { ...input, brake: 0, throttle: 1, steer: 0.6 };
  const takeover = race.finishControl(input, autopilot);
  assert.ok(takeover.steer > input.steer && takeover.steer < autopilot.steer);
  race.update(3, [observation("p", 0.4)]);
  assert.equal(race.standings, final);
  assert.equal(race.finishControl(input, autopilot), autopilot);
});

test("quick race cycles caller-owned presets and resolves explicit selections", () => {
  const presets: RaceDefinition[] = ["Quarry", "Orchard", "Dunes"].map(trackId => ({
    trackId, gameplayId: "RACING", laps: 3, participants: [{ carId: "roadster", control: "PLAYER_ACTIVE" }],
  }));
  const selector = new QuickRaceSelector(presets);
  assert.deepEqual(Array.from({ length: 4 }, () => selector.next().trackId), ["Quarry", "Orchard", "Dunes", "Quarry"]);
  const chosen = selector.next({ carId: "coupe", difficulty: "HARD", laps: 7, mode: "RACING_BOOST" });
  assert.deepEqual(chosen, {
    trackId: "Orchard", mode: "RACING_BOOST", difficulty: "HARD", laps: 7,
    entrants: [{ id: "grid-1", carId: "coupe", isPlayer: true }],
  });
  assert.deepEqual(selector.custom(chosen), chosen);
  assert.throws(() => new RaceManager({
    line, ...chosen, rule: { MIN_CARS: 1, MAX_CARS: 4, MAX_LAPS: 5 },
  }), /lap count/);
});

function checkMatrices(view: CameraView): void {
  for (const matrix of [view.viewMatrix, view.projMatrix]) {
    assert.equal(matrix.length, 16);
    assert.ok(matrix.every(Number.isFinite));
  }
  const eyeSpace = transformPoint(view.viewMatrix, view.eye);
  eyeSpace.forEach(value => approximate(value, 0, 1e-4));
  assert.ok(transformPoint(view.viewMatrix, view.target)[2] > 0);
  approximate(transformPoint(view.projMatrix, [0, 0, view.near])[2], -1);
  approximate(transformPoint(view.projMatrix, [0, 0, view.far])[2], 1);
}

test("camera cycles four playable views and preserves selection through overrides", () => {
  const controller = new CameraController();
  const frame = { car: baseCar, aspect: 16 / 9 };
  const expected = ["CHASE_FAR", "CHASE_NEAR", "HOOD", "BUMPER", "CHASE_FAR"];
  for (const [i, mode] of expected.entries()) {
    const view = controller.update(0.02, { ...frame, cameraNextPressed: i !== 0 });
    assert.equal(view.modeName, mode);
    assert.equal(view.showPlayerCar, mode.startsWith("CHASE"));
    checkMatrices(view);
  }
  const lookBack = controller.update(0.1, { ...frame, lookBack: true });
  assert.equal(lookBack.modeName, "LOOK_BACK");
  assert.ok(lookBack.eye[2] > lookBack.target[2]);
  checkMatrices(lookBack);
  assert.equal(controller.update(0.1, frame).modeName, "CHASE_FAR");
  for (const [phase, mode] of [["INTRO", "INTRO"], ["FINISHED", "FINISH"]] as const) {
    const start = controller.update(0.1, { ...frame, phase, phaseElapsed: 0, lookBack: true });
    const next = controller.update(0.1, { ...frame, phase, phaseElapsed: 1, lookBack: true });
    assert.equal(start.modeName, mode);
    assert.notDeepEqual(start.eye, next.eye);
    checkMatrices(start);
    checkMatrices(next);
  }
});

test("chase eases around heading changes, expands at speed and clears hills", () => {
  const controller = new CameraController({ ground: () => 5, groundClearance: 0.5 });
  const frame = { car: { ...baseCar, speed: 0 }, aspect: 1.6 };
  const slow = controller.update(0.016, frame);
  const fast = controller.update(0.016, { ...frame, car: { ...frame.car, speed: 55 } });
  assert.equal(slow.eye[1], 5.5);
  assert.ok(fast.eye[2] < slow.eye[2] && fast.fovYRad > slow.fovYRad);
  const turned = { ...frame, car: { ...frame.car, forward: [1, 0, 0] as Vec3, position: [0, 10, 0] as Vec3 } };
  const initial = controller.update(0.03, turned);
  const settled = controller.update(2, turned);
  assert.ok(initial.eye[2] < -7);
  assert.ok(settled.eye[0] < -7 && Math.abs(settled.eye[2]) < 0.02);
  assert.ok(initial.eye[1] < settled.eye[1]);
  checkMatrices(settled);
});

test("camera adapts a synthetic authored lens and follows the vehicle rotation on mounts", () => {
  const [definition] = parseCameraDatabase(`
:CAMERA_SYSTEM_CAMERA ENTITY_SUB_TYPE_CAMERA_PRACTICE DIRECTOR_CAMERA_GROUP_TYPE_PRACTICE "Practice" CAMERA_LEVEL_TYPE_PRACTICE
:CAMERA_SYSTEM_CAMERA_FOV 47
:CAMERA_SYSTEM_CAMERA_OFFSET 0 0 12
:CAMERA_SYSTEM_CAMERA_SUBJECT_VISIBLE 0
:CAMERA_SYSTEM_CAMERA_CREATE
:CAMERA_SYSTEM_MOUNTING_OFFSET 0 0 2
:CAMERA_SYSTEM_MOUNTING_CREATE
`);
  const camera = new CameraController({ presets: { HOOD: cameraPresetFromDefinition("HOOD", definition!) } });
  camera.nextMode();
  camera.nextMode();
  const view = camera.update(0, {
    aspect: 1, car: { ...baseCar, rotation: quatFromAxisAngle([1, 0, 0], -Math.PI / 4) },
  });
  assert.equal(view.modeName, "HOOD");
  approximate(view.eye[1], Math.SQRT2);
  approximate(view.fovYRad, 47 * Math.PI / 180);
  assert.equal(view.showPlayerCar, false);
  checkMatrices(view);
});
