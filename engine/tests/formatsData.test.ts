import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  parseCollectionUnlocks, parseCompetitions, parseRewardObjectives, parseSpeechDatabase, parseTrackBonuses,
  parseTrackCones, parseTrackGroupValues, parseTrackParticles, parseVibrationPatterns, parseWorldRatings,
  loadVehicleDatabases, parseAnimatedSounds, parseBodyDatabase, parseCameraDatabase, parseCameraOverride,
  parseCameraViewports, parseDifficultyMultipliers, parseEngineDatabase, parseEngineSoundDatabase,
  parseGameData, parseGearboxDatabase, parseQuickRace, parseRaceDefinition, parseRacingLine, parseReverbSounds, parseRulesDatabase,
  parseSetupDatabase, parseSoundTracks, parseStaticSounds, parseSurfaceDatabase, parseTrackConfig,
  parseTrackDatabase, parseTrackGates, parseTyreDatabase, parseVolumeDatabase, readDatabaseText, resolveCarConfig,
} from "../src/formats/databases";
import { parseMpc, parseSpc, parseWaveSample } from "../src/formats/spc";

test("engine inheritance copies at declaration time, including the derived fields", () => {
  const engines = parseEngineDatabase(`
:TYPE Base
:MAX_RPM 5000
:TURBO_MASS 4
:TORQUE_ARRAY
  5 1
  6 40
  7 1000
  8 10
  9 10
 10 10
:TYPE ParentWins
:MAX_RPM 6000
:INHERIT_TYPE BASE
:TYPE LocalWins
:INHERIT_TYPE ParentWins
:TURBO_MASS 0
:MAX_RPM 4000
:TORQUE_ARRAY
 0 1
 1000 40
 2000 1
 3000 100
 4000 2
:TYPE RetainsPeak
:INHERIT_TYPE Base
:TORQUE_ARRAY
 0 -1
 1000 -1
 2000 -1
 3000 -1
 4000 -1
 5000 -1
:END
`);
  const base = engines.get("base")!;
  assert.equal(base.peakPowerRpm, 2500);
  assert.equal(base.inverseTurboMass, 0.25);
  assert.deepEqual(base.torqueCurve[2], [7, 1000]);
  assert.deepEqual(base.torque, [1, 40, 1000, 10, 10, 10, ...Array(12).fill(0)]);
  const inherited = engines.get("parentwins")!;
  assert.equal(inherited.fields.MAX_RPM, 5000);
  assert.equal(inherited.peakPowerRpm, 2500);
  assert.equal(inherited.inverseTurboMass, 0.25);
  assert.equal(engines.get("localwins")?.peakPowerRpm, 2500);
  assert.equal(engines.get("localwins")?.inverseTurboMass, 1);
  assert.equal(engines.get("retainspeak")?.peakPowerRpm, 2500);
  assert.throws(() => parseEngineDatabase(":TYPE X\n:INHERIT_TYPE Y\n:END"), /declared earlier/);
  assert.throws(() => parseEngineDatabase(":TYPE X\n:MAX_RPM 1000\n:TORQUE_ARRAY\n0 1\n:END"), /expected 2 rows/);
});

test("gearboxes, bodies, and setups apply their own copy rules", () => {
  const gearbox = parseGearboxDatabase(`
:TYPE Base
:DRIVE_TYPE REAR
:DRIVE_SPLIT 1
:TYPE Next
:DRIVE_TYPE FRONT
:INHERIT_TYPE Base
:DRIVE_SPLIT 0.75
:END
`).get("next");
  assert.deepEqual(gearbox?.fields, { DRIVE_TYPE: "REAR", DRIVE_SPLIT: 0.75 });

  const bodies = parseBodyDatabase(`
:TYPE Base
:GENERIC_BODY_FLAG 1
:OPEN_TOP 1
:DIMENSIONS 1 2 3
:BUMPER_HEIGHT 0.2 0.3
:OBJECT_3D_SHAPE BaseShape
:MASS BODYWORK 5 0 0 0
:COLLISION_SPHERE 0 0 0 2
:AEROFOIL
:TYPE REAR_SPOILER
:POSITION 0 0 0
:POSITION 1 0 0
:POSITION 1 0 1
:POSITION 0 0 1
:TYPE Child
:DIMENSIONS 7 7 7
:INHERIT_TYPE Base
:MASS ENGINE 3 1 0 0
:TYPE Local
:AEROFOIL
:TYPE FRONT_SPOILER
:POSITION 0 0 0
:POSITION 2 0 0
:POSITION 2 0 1
:POSITION 0 0 1
:OBJECT_3D_SHAPE LocalShape
:INHERIT_TYPE Child
:OPEN_TOP 0
:END
`);
  const child = bodies.get("child")!;
  assert.deepEqual(child.fields.DIMENSIONS, [1, 2, 3]);
  assert.equal(child.fields.OPEN_TOP, true);
  assert.equal(child.fields.GENERIC_BODY_FLAG, undefined);
  assert.equal(child.fields.BUMPER_HEIGHT, undefined);
  assert.equal(child.fields.OBJECT_3D_SHAPE, "BaseShape");
  assert.deepEqual(child.masses, [{ component: "ENGINE", mass: 3, position: [1, 0, 0] }]);
  assert.equal(child.collisionSpheres.length, 0);
  assert.equal(child.aerofoils[0]?.type, "REAR_SPOILER");
  const local = bodies.get("local")!;
  assert.equal(local.aerofoils.length, 1);
  assert.equal(local.aerofoils[0]?.type, "FRONT_SPOILER");
  assert.equal(local.fields.OBJECT_3D_SHAPE, "LocalShape");
  assert.equal(local.fields.OPEN_TOP, false);

  const setups = parseSetupDatabase(`
:CAR_TYPE BASE
:GEARING_ARRAY 3
 -1, -3
 0, 2.7
 1, 4
:MASS BALLAST, 42, 0, 0, 0
:WHEEL_SPACING 1.4, 1.5
/ F150 1998
:CAR_TYPE Child
:MASS BALLAST, 2, 0, 0, 0
:INHERIT_TYPE base
:ANTI_DIVE_STIFFNESS 0.3, 0.4
:CAR_TYPE Grandchild
:INHERIT_TYPE Child
:MASS BALLAST, 20, 1, 2, 3
:END
`);
  assert.deepEqual(setups.get("grandchild")?.gearRatios, [
    { index: -1, ratio: -3 }, { index: 0, ratio: 2.7 }, { index: 1, ratio: 4 },
  ]);
  assert.equal(setups.get("child")?.ballast?.mass, 42);
  assert.deepEqual(setups.get("grandchild")?.ballast, { component: "BALLAST", mass: 20, position: [1, 2, 3] });
  assert.deepEqual(setups.get("grandchild")?.fields.ANTI_DIVE_STIFFNESS, [0.3, 0.4]);
  assert.deepEqual(setups.get("grandchild")?.fields.WHEEL_SPACING, [1.4, 1.5]);
});

test("tyre scalars copy immediately while each local table takes precedence", () => {
  const rectangle = (rows: number, columns: number) =>
    Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, col) => row + col).join(" ")).join("\n");
  const tyres = parseTyreDatabase(`
:TYPE Base
:RADIUS 0.4
:MASS 10
:VERTICAL_LOAD
${rectangle(10, 2)}
:CAMBER_THRUST
${rectangle(10, 2)}
:LONGITUDINAL_COMBINED_VALUES
${rectangle(9, 11)}
:LATERAL_COMBINED_VALUES
${rectangle(10, 21)}
:SOUND_INFO
:TYPE TYRE_SAMPLE_TYPE_SQUEAK
:VALUE 2
 0 0.125
 1 0.25
:START_RPM 300
:TYPE Override
:RADIUS 0.7
:VERTICAL_LOAD
${rectangle(10, 2).replace("0 1", "0 2")}
:INHERIT_TYPE Base
:MASS 20
:TYPE Grandchild
:INHERIT_TYPE Override
:SOUND_INFO
:TYPE TYRE_SAMPLE_TYPE_HISS
:VALUE 1
0 0.1
:START_RPM 400
:END
`);
  const override = tyres.get("override")!;
  assert.deepEqual(override.fields, { RADIUS: 0.4, MASS: 20 });
  assert.deepEqual(override.verticalLoad?.[0], [0, 2]);
  assert.deepEqual(override.camberThrust?.[0], [0, 1]);
  assert.equal(override.longitudinalSlip?.[8]?.length, 11);
  assert.equal(override.lateralSlip?.[9]?.[20], 29);
  assert.deepEqual(override.sounds, [{ type: "TYRE_SAMPLE_TYPE_SQUEAK", values: [[0, 0.125], [1, 0.25]], startRpm: 300 }]);
  assert.deepEqual(tyres.get("grandchild")?.sounds, [
    { type: "TYRE_SAMPLE_TYPE_HISS", values: [[0, 0.1]], startRpm: 400 },
  ]);
  assert.throws(() => parseTyreDatabase(":TYPE X\n:CAMBER_THRUST\n0 1\n:END"), /expected 10 rows/);
});

test("racing line reads declared point count, vectors, signed scalars and the flying lap interpolant", () => {
  const text = `
:TRACK_TOOL_HEADER
:TRACK_TOOL_VERSION_NUMBER 1
:TRACK_TOOL_CREATION_DATE "Test // date"
:TRACK_TOOL_TIMESTAMP 0
:TRACK_TOOL_SCENE_NAME //server/a track.ma
:TRACK_TOOL_TOLERANCE 0.5
:TRACK_TOOL_REVERSE_FLAG 1
:TRACK_TOOL_DATA
:TRACK_TOOL_NUM_RACING_LINE_POINTS 1
:TRACK_TOOL_RACING_LINE_LENGTH 42
:TRACK_TOOL_TRACK_EDGE_MODIFIER 1
:TRACK_TOOL_RACING_LINE_POINTS_START
1 2 3
0.01 0 0
0 0 1
5
-0.25
-1500
:TRACK_TOOL_RACING_LINE_POINTS_END
:TRACK_TOOL_FLYING_LAP_START_INTERPOLANT 0.42
:END
`;
  const line = parseRacingLine(text.replaceAll("\n", "\r\n"));
  assert.equal(line.creationDate, "Test // date");
  assert.equal(line.sceneName, "//server/a track.ma");
  assert.equal(line.flyingLapStartInterpolant, 0.42);
  assert.deepEqual(line.points, [{
    position: [1, 2, 3], lateral: [0.01, 0, 0], forward: [0, 0, 1], width: 5, offset: -0.25, curvatureRadius: -1500,
  }]);
  assert.throws(() => parseRacingLine(text.replace("POINTS 1", "POINTS 2")), /expected 24 values/);
  assert.throws(() => parseRacingLine(text.replace(":TRACK_TOOL_RACING_LINE_POINTS_END", "")), /expected :TRACK_TOOL_RACING_LINE_POINTS_END/);
});

test("camera stages accept continuation rows and distinguish binding from numeric parameters", () => {
  const [camera] = parseCameraDatabase(`
:CAMERA_SYSTEM_CAMERA SUBTYPE
  GROUP,
  "Name // with comment marker",
  LEVEL,
:CAMERA_SYSTEM_CAMERA_FOV 75.0, // comment
:CAMERA_SYSTEM_CAMERA_OFFSET
  1, 2, 3,
:CAMERA_SYSTEM_CAMERA_CREATE
:CAMERA_SYSTEM_MOUNTING_TYPE_SPECIFIC MOUNTING_SUBJECT_BINDING_TYPE_TEST, 0, -2, 1
:CAMERA_SYSTEM_MOUNTING_SUBJECT_SCALE_VALUE 1
  "Car", 1.5
:CAMERA_SYSTEM_MOUNTING_CREATE
`);
  assert.equal(camera?.label, "Name // with comment marker");
  assert.deepEqual(camera?.fields.CAMERA_SYSTEM_CAMERA_OFFSET, [1, 2, 3]);
  assert.deepEqual(camera?.mounting.CAMERA_SYSTEM_MOUNTING_TYPE_SPECIFIC, {
    kind: "subjectBinding", binding: "MOUNTING_SUBJECT_BINDING_TYPE_TEST", values: [0, -2, 1],
  });
  assert.deepEqual(camera?.subjectScales, [{ subjectId: "Car", scale: 1.5 }]);
});

function waveChunk(tag: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(8 + data.length + (data.length & 1));
  chunk.write(tag, 0, "ascii");
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  return chunk;
}

function testWave(): Buffer {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(22050, 4);
  fmt.writeUInt32LE(44100, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const smpl = Buffer.alloc(60);
  smpl.writeUInt32LE(1, 28);
  smpl.writeUInt32LE(9, 36);
  smpl.writeUInt32LE(1, 44);
  smpl.writeUInt32LE(2, 48);
  const wsmp = Buffer.alloc(64);
  wsmp.writeUInt32LE(24, 0); // four optional header bytes
  wsmp.writeUInt32LE(2, 16);
  wsmp.writeUInt32LE(24, 24); // eight optional bytes in the first loop
  wsmp.writeUInt32LE(3, 36);
  wsmp.writeUInt32LE(16, 48);
  wsmp.writeUInt32LE(1, 52);
  wsmp.writeUInt32LE(2, 56);
  wsmp.writeUInt32LE(1, 60);
  const header = Buffer.from("RIFF\0\0\0\0WAVE", "ascii");
  const wave = Buffer.concat([
    header, waveChunk("JUNK", Buffer.from([3])),
    waveChunk("fmt ", fmt), waveChunk("smpl", smpl), waveChunk("data", Buffer.alloc(6)), waveChunk("wsmp", wsmp),
  ]);
  wave.writeUInt32LE(wave.length - 8, 4);
  return wave;
}

test("SPC uses declared ranges and WAVE walks padded chunks and both loop formats", () => {
  const wave = testWave();
  const table = Buffer.alloc(4 + 2 * 76);
  table.writeUInt32LE(2, 0);
  table.write("12345678901234567890123456789012", 4);
  table.writeUInt8(0xa5, 36);
  table.writeUInt32LE(wave.length + 2, 72);
  table.writeUInt32LE(wave.length, 76);
  table.write("short", 80);
  table.writeUInt8(0xdd, 86);
  table.writeUInt32LE(wave.length, 152);
  const bytes = Buffer.concat([Buffer.alloc(7), table, wave, Buffer.alloc(2), wave, Buffer.alloc(1)]).subarray(7);
  const bank = parseSpc(bytes);
  assert.equal(bank.payloadOffset, 156);
  assert.equal(bank.leftoverBytes, 3);
  assert.deepEqual(bank.entries.map(entry => entry.name), ["12345678901234567890123456789012", "short"]);
  const entry = bank.entries[0]!;
  assert.equal(entry.metadata[0], 0xa5);
  assert.equal(entry.wave.data.length, 6);
  assert.deepEqual(entry.wave.format, {
    codec: 1, channels: 1, sampleRate: 22050, byteRate: 44100, blockAlign: 2, bitsPerSample: 16,
  });
  assert.deepEqual(entry.wave.smplLoops, [{ cueId: 9, type: 0, startFrame: 1, endFrameInclusive: 2, fraction: 0, playCount: 0 }]);
  assert.deepEqual(entry.wave.wsmpLoops, [
    { type: 0, startFrame: 0, frameCount: 3 }, { type: 1, startFrame: 2, frameCount: 1 },
  ]);
  assert.throws(() => parseSpc(bytes.subarray(0, 80)), /table/);
  const outOfBounds = Buffer.from(bytes);
  outOfBounds.writeUInt32LE(0xffffffff, 72);
  assert.throws(() => parseSpc(outOfBounds), /range/);
  const overlap = Buffer.from(bytes);
  overlap.writeUInt32LE(0, 72);
  assert.throws(() => parseSpc(overlap), /Overlapping/);
  const badChunk = Buffer.from(wave);
  badChunk.writeUInt32LE(0x7fffffff, 16);
  assert.throws(() => parseWaveSample(badChunk), /Truncated WAVE chunk/);
  const badLoop = Buffer.from(wave);
  badLoop.writeUInt32LE(0, badLoop.indexOf("wsmp") + 8 + 24);
  assert.throws(() => parseWaveSample(badLoop), /wsmp loop size/);
});

test("MPC strict and demo-tolerant modes retain the declared count and reject partial entries", () => {
  const bytes = Buffer.alloc(68);
  bytes.writeUInt32LE(7);
  bytes.write("TRACK001", 4);
  bytes[13] = 0x7f;
  assert.throws(() => parseMpc(bytes), /declares 7 entries but contains 1/);
  const index = parseMpc(bytes, { allowShortfall: true });
  assert.equal(index.declaredCount, 7);
  assert.equal(index.shortfall, 6);
  assert.equal(index.entries[0]?.stem, "TRACK001");
  assert.equal(index.entries[0]?.metadata[0], 0x7f);
  assert.throws(() => parseMpc(bytes.subarray(0, 67), { allowShortfall: true }), /Partial MPC/);
});

import { fileURLToPath } from "node:url";

const demo = fileURLToPath(new URL("../../game", import.meta.url));
const demoOptions = { skip: !fs.existsSync(demo) };
const asciiRoot = path.join(demo, "DATA/ASCII");
const readAscii = (relative: string) => fs.readFileSync(path.join(asciiRoot, relative), "utf8");
const listFiles = (directory: string, extension: string) => fs.readdirSync(directory, { recursive: true, encoding: "utf8" })
  .filter(file => path.extname(file).toLowerCase() === extension).sort();

test("Shuffle vehicle databases resolve all 148 cars with installed model directories", demoOptions, async () => {
  const db = await loadVehicleDatabases({ readText: async file => fs.readFileSync(path.join(demo, file), "utf8") });
  assert.deepEqual(Object.fromEntries(Object.entries(db).map(([key, table]) => [key, table.size])), {
    cars: 148, bodies: 177, engines: 155, gearboxes: 56, tyres: 212,
    brakes: 55, setups: 140, controls: 5, materials: 5, overlays: 10,
  });
  const carFolders = new Set(
    fs.readdirSync(path.join(demo, "3DDATA/CARS"), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name.toLowerCase()),
  );
  for (const car of db.cars.values()) {
    const config = resolveCarConfig(db, car.id.toLowerCase());
    const stem = path.basename(config.shapeFolder).toLowerCase();
    assert.ok(carFolders.has(stem), `Missing car model directory for ${car.id}: ${stem}`);
  }
  const focus = resolveCarConfig(db, "focus_svt");
  assert.equal(focus.shapeFolder, "3DDATA/CARS/FOCUSSVT");
  assert.equal(db.engines.get("indigo")?.parentId, "DEFAULT_TRACK");
  for (const tyre of db.tyres.values()) {
    assert.equal(tyre.longitudinalSlip?.length, 9);
    assert.equal(tyre.lateralSlip?.length, 10);
    assert.equal(tyre.verticalLoad?.length, 10);
    assert.equal(tyre.camberThrust?.length, 10);
    assert.ok(tyre.sounds.length > 0);
  }
});

test("Shuffle track registries, configs, gates, racing lines and fallback AI path", demoOptions, () => {
  const tracks = parseTrackDatabase(readAscii("TRACKS.DAT"));
  const surfaces = parseSurfaceDatabase(readAscii("SURFACE.DAT"));
  assert.equal(tracks.size, 125);
  assert.equal(surfaces.size, 43);
  for (const track of tracks.values()) assert.ok(surfaces.has(track.DEFAULT_TRACK_SURFACE.toLowerCase()), track.id);
  const lines = listFiles(path.join(asciiRoot, "TRACKS"), ".dat");
  assert.equal(lines.length, 126);
  for (const file of lines) {
    const line = parseRacingLine(readAscii(`TRACKS/${file}`));
    assert.ok(line.points.length >= 20, file);
    if (file.toUpperCase() === "ENGAF.DAT") assert.equal(line.points.length, 225);
  }
  const fallback = parseRacingLine(readAscii("AI_DFLT.DAT"));
  assert.equal(fallback.points.length, 217);
  const gateFiles = listFiles(path.join(asciiRoot, "GATE/MAIN"), ".dat");
  assert.ok(gateFiles.length >= 15);
  for (const file of gateFiles) {
    const gates = parseTrackGates(readAscii(`GATE/MAIN/${file}`));
    if (file.toUpperCase() === "ENGAF.DAT") assert.equal(gates.length, 43);
  }
  const configRoot = path.join(demo, "3DDATA/TRACKS/CONFIGS");
  const configs = listFiles(configRoot, ".cfg");
  assert.equal(configs.length, 125);
  for (const file of configs) assert.equal(parseTrackConfig(fs.readFileSync(path.join(configRoot, file), "utf8")).FOG.colour.length, 3);
});

test("Shuffle cameras, difficulty multipliers, rules and quick race definitions", demoOptions, () => {
  assert.equal(parseCameraDatabase(readAscii("CAMERAS/CAMERAS.DAT")).length, 12);
  assert.equal(Object.keys(parseGameData(readAscii("GAMEDATA.DAT")).difficulty).length, 3);
  for (const [type, columns] of [["SECONDS", 2], ["SKILLS", 3], ["TIMEATTA", 1]] as const) {
    assert.equal(parseDifficultyMultipliers(readAscii(`DIFFMULT/${type}.DAT`), type).HARD.length, columns);
  }
  const rules = parseRulesDatabase(readAscii("GAMEPLAY/RULES.DAT"));
  assert.equal(rules.size, 11);
  const quickRaces = listFiles(path.join(asciiRoot, "GAMEPLAY"), ".dat").filter(file => /^QRACE_/i.test(file));
  assert.equal(quickRaces.length, 6);
  for (const file of quickRaces) {
    const race = parseQuickRace(readAscii(`GAMEPLAY/${file}`));
    assert.ok(rules.has(race.gameplayId.toLowerCase()), file);
    assert.equal(race.participants.length, 6);
    assert.equal(race.participants.filter(participant => participant.playerIndex === "PLAYER_ONE").length, 1);
  }
});

test("Shuffle audio text and SPC sound banks parse cleanly", demoOptions, () => {
  const profiles = [...parseEngineSoundDatabase(readAscii("ENGSND.DAT")).values()];
  assert.equal(profiles.length, 62);
  const modes = parseVolumeDatabase(readAscii("VOLUMES.DAT"));
  assert.equal(modes.size, 3);
  const root = path.join(demo, "SND");
  const banks = listFiles(root, ".spc");
  assert.equal(banks.length, 119);
  for (const file of banks) {
    const bank = parseSpc(fs.readFileSync(path.join(root, file)));
    assert.ok(bank.entries.length > 0, file);
  }
});
