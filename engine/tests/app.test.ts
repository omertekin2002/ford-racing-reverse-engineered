import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  aiControlToDrivingInput, buildRaceResultRows, dedupeCarLiveries, hasLiveryTextureVariants, defaultReferenceRpmForRole, fitTextScale,
  fitTextWithEllipsis, formatLanguageDisplayName, formatRacingStatus, GEN_ENGINE_SPC_PATH, isAiCarBlocked,
  pickBoostEntry, pickCollisionEntry, pickGenEngineAuxEntries, pickSkidEntry, pickWindEntry,
  READABLE_MIN_TEXT_SCALE, resolveCarEngineSound, resolveEngineLayerRole, resolveGenEngineRole,
  resolveTrackDifficultyScales, stripDisplayNameMarkers, TickErrorGuard, updateAiFlippedTimer,
} from "../src/app.js";
import { measureTextLine } from "../src/formats/fonts.js";
import { formatResultsRowTimes } from "../src/ui/hudModel.js";
import { DemoAssets, demoTrackDirectory } from "../src/demoAssets.js";
import { AiDriver, trackProgressDelta } from "../src/game/aiDriver.js";
import { CameraController } from "../src/game/cameraController.js";
import { RaceManager, type RaceObservation } from "../src/game/raceManager.js";
import { InputManager } from "../src/input/inputManager.js";
import { mountNativeEngine } from "../src/main.js";
import { resolveCarCollision } from "../src/physics/collision.js";
import { TrackSpatial } from "../src/physics/trackSpatial.js";
import { VehiclePhysics } from "../src/physics/vehiclePhysics.js";
import { canvasToUiPoint, computeUiViewport } from "../src/render/uiRenderer.js";
import { buildHudViewModel } from "../src/ui/hudModel.js";
import { MenuController } from "../src/ui/menuController.js";
import { UiScreenInstance } from "../src/ui/uiRuntime.js";
import { HttpVfs } from "../src/vfs/httpVfs.js";
import { NodeVfs } from "../src/vfs/nodeVfs.js";

const demoRoot = fileURLToPath(new URL("../../game", import.meta.url));
const demoOptions = { skip: !existsSync(demoRoot) };

test("the engine build emits a standalone browser ESM bundle", async () => {
  const work = await mkdtemp(join(tmpdir(), "fr3-bundle-"));
  try {
    const outfile = join(work, "engine.mjs");
    const metafile = join(work, "meta.json");
    execFileSync("npm", ["run", "build", "--", `--outfile=${outfile}`, `--metafile=${metafile}`], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
    });
    const metadata = JSON.parse(await readFile(metafile, "utf8")) as {
      outputs: Record<string, { bytes: number; imports: unknown[]; exports: string[] }>;
    };
    const bundle = Object.entries(metadata.outputs).find(([path]) => path.endsWith("engine.mjs"))?.[1];
    assert.ok(bundle && bundle.bytes > 0);
    assert.deepEqual(bundle.imports, []);
    assert.ok(bundle.exports.includes("mountNativeEngine"));
    const api = await import(pathToFileURL(outfile).href);
    assert.equal(typeof api.mountNativeEngine, "function");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("browser mount reports an invalid downloaded archive without initializing WebGL", async () => {
  const statuses: string[] = [];
  const errors: Error[] = [];
  const canvas = { ownerDocument: { defaultView: {} } } as HTMLCanvasElement;
  await assert.rejects(mountNativeEngine({
    canvas,
    zipUrl: "data:application/zip,invalid",
    onStatus: status => statuses.push(status),
    onError: error => errors.push(error),
  }), /ZIP end of central directory is missing/);
  assert.deepEqual(statuses, ["Downloading asset archive"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /ZIP end of central directory is missing/);
});

test("HttpVfs indexes a manifest, resolves relative URLs, caches fetches and retries failures", async () => {
  const requests: string[] = [];
  let failOnce = true;
  const fakeFetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://example.test/site/runtime/game-manifest.json") {
      return new Response(JSON.stringify({
        version: 1,
        baseUrl: "game",
        files: ["DATA/ASCII/TEST.DAT", "3DDATA/CARS/FORDGT/3dobjs.XBX"],
      }), { status: 200 });
    }
    if (url === "https://example.test/site/runtime/game/DATA/ASCII/TEST.DAT") {
      if (failOnce) {
        failOnce = false;
        return new Response("temporary error", { status: 503 });
      }
      return new Response("hello shuffle", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  const vfs = await HttpVfs.open("https://example.test/site/runtime/game-manifest.json", { fetch: fakeFetch });
  assert.equal(vfs.has("data\\ascii\\test.dat"), true);
  assert.equal(vfs.has("missing.dat"), false);
  assert.deepEqual(vfs.list("3ddata/"), ["3ddata/cars/fordgt/3dobjs.xbx"]);
  await assert.rejects(vfs.readText("DATA/ASCII/TEST.DAT"), /HTTP 503/);
  assert.equal(await vfs.readText("data/ascii/test.dat"), "hello shuffle");
  assert.equal(await vfs.readText("DATA\\ASCII\\TEST.DAT"), "hello shuffle");
  // Manifest + 1 failed read + 1 cached read = 3 total requests.
  assert.equal(requests.length, 3);
});

test("HttpVfs binds globalThis.fetch so browser Window.fetch does not throw Illegal invocation", async () => {
  const originalFetch = globalThis.fetch;
  const strictWindowFetch: typeof globalThis.fetch = async function (this: unknown, input) {
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    const url = String(input);
    if (url === "https://example.test/runtime/game-manifest.json") {
      return new Response(JSON.stringify({ version: 1, baseUrl: "game", files: ["DATA/ASCII/TRACKS.DAT"] }), { status: 200 });
    }
    if (url === "https://example.test/runtime/game/DATA/ASCII/TRACKS.DAT") {
      return new Response("tracks-ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  globalThis.fetch = strictWindowFetch;
  try {
    const vfs = await HttpVfs.open("https://example.test/runtime/game-manifest.json");
    assert.equal(await vfs.readText("DATA/ASCII/TRACKS.DAT"), "tracks-ok");
    const explicit = await HttpVfs.open("https://example.test/runtime/game-manifest.json", { fetch: strictWindowFetch });
    assert.equal(await explicit.readText("DATA/ASCII/TRACKS.DAT"), "tracks-ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MenuController cycles installed tracks forward and backward and launches the selected track", () => {
  const menu = new MenuController({
    cars: [{ id: "FORD_GT", name: "Ford GT", liveries: ["DEFAULT"] }],
    trackId: "ENGAF",
    tracks: [
      { id: "ENGAF", name: "England A" },
      { id: "ALASCF", name: "Alaska C" },
      { id: "DESA", name: "Desert A" },
    ],
    languages: ["EN"],
  });
  menu.continueFromStart();
  assert.ok(menu.activate("select-car"));
  assert.equal(menu.getView().track?.id, "ENGAF");
  assert.ok(menu.activate("previous-track"));
  assert.equal(menu.getView().track?.id, "DESA");
  assert.ok(menu.activate("next-track"));
  assert.equal(menu.getView().track?.id, "ENGAF");
  assert.ok(menu.activate("next-track"));
  assert.equal(menu.getView().track?.id, "ALASCF");
  assert.ok(menu.activate("launch"));
  const launch = menu.drainCommands().find(cmd => cmd.type === "LaunchRaceRequest")!;
  assert.equal(launch.setup.trackId, "ALASCF");
});

test("local Shuffle catalog loads vehicle, UI, language, environment and audio assets", demoOptions, async () => {
  const vfs = await NodeVfs.open(demoRoot);
  const assets = await DemoAssets.load(vfs);
  assert.equal(assets.installedCars.length, 148);
  assert.equal(assets.installedTracks.length, 125);
  assert.equal(assets.defaultTrackId, "ENGAF");
  assert.equal(assets.tables.vehicles.cars.size, 148);
  assert.ok(assets.tables.tracks.has("engaf") && assets.tables.surfaces.size > 0);
  assert.ok(assets.tables.rules.has("racing_boost") && assets.tables.cameras.length > 0);
  assert.ok(assets.tables.engineSounds.size > 0 && assets.tables.volumes.size > 0);
  assert.deepEqual(assets.tables.fog, { density: 0.2, color: [186, 139, 84] });
  assert.deepEqual(assets.quickRaces.map(preset => preset.number), [5, 6, 4, 1, 2, 3]);
  assert.ok(assets.quickRaces.every(preset => preset.participants.length === 6 && preset.laps >= 1));
  assert.equal(assets.fonts.length, 6);
  assert.ok(assets.fonts.every(atlas => atlas.glyphs.size === 134));
  assert.equal(assets.language, "EN");
  assert.equal(assets.translation.entries.size, 2065);
  const english = assets.translation;
  assets.setLanguage("fr");
  assert.equal(assets.language, "FR");
  assert.notEqual(assets.translation, english);
  assert.throws(() => assets.setLanguage("invalid"), /Translation unavailable/);
  assert.equal(assets.language, "FR");

  assert.equal(assets.uiScripts.size, 92);
  assert.equal(assets.readUiScript("UI\\MENUBAR.UI"), assets.readUiScript("/ui/menubar.ui"));
  for (const name of ["START", "GAMEF", "FORD", "CAR", "OPTS", "PAUSE", "RCRES", "RCEND"]) {
    const screen = UiScreenInstance.load(`UI/${name}.UI`, {
      readFile: assets.readUiScript, translation: assets.translation,
    });
    assert.ok(screen.id, name);
    assert.ok(!screen.diagnostics.some(message => message.includes("Missing included UI script")), name);
    screen.update(1);
    assert.ok(screen.getDrawItems().length > 0, name);
  }

  const pcg = assets.loadPcg("GRAPHICS/GAME/graphics.pcg");
  assert.equal(assets.loadPcg("graphics\\game\\GRAPHICS.PCG"), pcg);
  const sprite = await assets.getPcgEntry("GRAPHICS\\GAME\\STARTUS.PSD");
  assert.ok(sprite && sprite.storedWidth > 0);
  const loading = await assets.loadPcg("GRAPHICS/LOADING/graphics.pcg");
  assert.equal(await assets.getLoadingSprite(loading.entries[0]!.name), loading.entries[0]);
  assert.ok(await assets.getHudSprite("generic", "start1"));
  assert.equal(await assets.getPcgEntry("none"), undefined);

  const bank = assets.loadSpc("SND/misc.spc");
  assert.equal(assets.loadSpc("snd\\MISC.SPC"), bank);
  assert.ok((await bank).entries.length >= 17);
  const others = await Promise.all([
    ...Array.from({ length: 9 }, (_, i) => assets.loadSpc(`SND/ENGINE${i + 1}.SPC`)),
    assets.loadSpc("SND/GEN_ENG.SPC"),
  ]);
  assert.ok(others.every(item => item.entries.length > 0));
  const missing = assets.loadSpc("SND/missing.spc");
  await assert.rejects(missing, /Failed to load snd\/missing\.spc/);
  const retry = assets.loadSpc("SND/missing.spc");
  assert.notEqual(retry, missing);
  await assert.rejects(retry, /Failed to load snd\/missing\.spc/);
});

test("six independently configured cars exercise spatial, AI, race, collision, camera and HUD integration",
  demoOptions, async () => {
    const assets = await DemoAssets.load(await NodeVfs.open(demoRoot));
    const loadingTrack = assets.load3dBundle(demoTrackDirectory);
    assert.equal(assets.load3dBundle("3ddata\\tracks\\engaf\\"), loadingTrack);
    const { xbx, scene } = await loadingTrack;
    const { racingLine, surfaces, tracks, game } = assets.tables;
    const track = new TrackSpatial(xbx, scene, racingLine,
      { surfaces, defaultSurfaceName: tracks.get("engaf")!.DEFAULT_TRACK_SURFACE });
    const carIds = ["FOCUS_SVT", "FAIRLANE_66", "CAPRI_RS2600_70", "46_CONVERTIBLE", "RANCH_1972", "FORD_GT"];
    const configs = carIds.map(id => {
      const config = assets.installedCars.find(({ car }) => car.id === id);
      assert.ok(config, id);
      return config;
    });
    const entrants = configs.map(({ car }, index) => ({ id: `test-${index}`, carId: car.id, isPlayer: index === 0 }));
    const ground = (x: number, z: number) => {
      const hit = track.queryGround(x, track.queryProgress(x, z).point[1], z);
      return hit.hit ? hit.height : undefined;
    };
    const createRace = () => new RaceManager({
      line: racingLine, entrants, laps: 3, mode: "RACING_BOOST", ground, startU: 0.08,
    });
    let race = createRace();
    const createCars = () => configs.map((config, index) => {
      const { position, forward } = race.grid[index]!;
      return new VehiclePhysics(config, track, {
        position: [position[0], position[1] + 0.025, position[2]],
        yaw: Math.atan2(forward[0], forward[2]),
      });
    });
    let cars = createCars();
    const drivers = configs.slice(1).map(() => new AiDriver(racingLine, {
      difficulty: game.difficulty.MEDIUM,
      trackScales: resolveTrackDifficultyScales(tracks.get("engaf")?.difficulty.MEDIUM),
    }));
    const camera = new CameraController({ ground });
    const input = new InputManager();
    const menu = new MenuController({
      cars: configs.map(({ car }) => ({ id: car.id, name: car.id, liveries: [] })),
      languages: assets.languages,
      trackId: "ENGAF",
    });
    menu.continueFromStart();
    assert.ok(menu.activate("select-car"));
    menu.updateRaceOptions({ laps: 3, mode: "RACING_BOOST" });
    assert.ok(menu.activate("launch"));
    const launch = menu.drainCommands().find(command => command.type === "LaunchRaceRequest")!;
    assert.ok(menu.completeLoad(launch.requestId));

    function observe(): RaceObservation[] {
      return cars.map(({ state }, index) => {
        const { position, forward, orientation, speedMps } = state;
        const progress = track.queryProgress(position[0], position[2]);
        return {
          id: entrants[index]!.id,
          car: { position, forward, rotation: orientation, speed: speedMps },
          track: { u: progress.interpolant, lateralOffset: progress.lateralOffset },
        };
      });
    }

    const dt = 1 / 60;
    const phases = new Set<string>();
    let movingFrames = 0;
    let peakSpeed = 0;
    function tick() {
      if (menu.getView().state !== "IN_GAME") return;
      phases.add(race.phase);
      const observations = observe();
      const player = observations[0]!;
      if (race.canMove) {
        const idle = input.poll(dt).driving;
        const boost = movingFrames === 120 && race.tryBoost(player.id);
        cars.forEach((car, index) => {
          const current = observations[index]!;
          const ai = drivers[index - 1]?.update(dt, {
            car: current.car, track: current.track,
            referenceGap: trackProgressDelta(player.track.u, current.track.u) * racingLine.length,
          });
          if (ai) assert.ok(Number.isFinite(ai.powerMultiplier));
          car.step(dt, ai ? aiControlToDrivingInput(ai, car.state) : {
            ...idle, throttle: 1, steer: 0.08 * Math.sin(movingFrames * dt), boost,
          });
        });
        for (const [index, car] of cars.entries()) {
          for (const other of cars.slice(index + 1)) assert.ok(Number.isFinite(resolveCarCollision(car, other)));
        }
        movingFrames++;
        peakSpeed = Math.max(peakSpeed, cars[0]!.state.speedMps);
      }
      const next = observe();
      race.update(dt, next);
      const view = camera.update(dt, { aspect: 16 / 9, car: next[0]!.car, phase: race.phase, phaseElapsed: race.phaseElapsed });
      assert.ok(view.viewMatrix.every(Number.isFinite) && view.projMatrix.every(Number.isFinite));
      for (const { state, config } of cars) {
        assert.ok([...state.position, ...state.linearVelocity, state.speedMps, state.rpm].every(Number.isFinite),
          `${config.car.id} has invalid telemetry on driving frame ${movingFrames}`);
      }
    }

    assert.equal(race.phase, "INTRO");
    for (let frame = 0; frame < 610; frame++) tick();
    assert.deepEqual([...phases], ["INTRO", "COUNTDOWN", "RACING"]);
    assert.ok(movingFrames >= 300 && peakSpeed > 5, `Peak player speed ${peakSpeed} m/s`);
    for (const opponent of cars.slice(1)) {
      assert.ok(opponent.state.gear >= 1, `${opponent.config.car.id} shifted into reverse (gear ${opponent.state.gear})`);
      assert.ok(opponent.state.speedMps > 5, `${opponent.config.car.id} stalled at ${opponent.state.speedMps} m/s`);
    }
    const player = race.standings.find(standing => standing.isPlayer)!;
    assert.equal(player.boostCharges, 0);
    assert.equal(cars[0]!.state.boostCharges, 1);
    const hud = buildHudViewModel({ ...cars[0]!.state, boostCharges: player.boostCharges }, {
      position: player.place, participants: cars.length, lap: player.lap, laps: 3,
      totalSeconds: race.elapsedRaceTime,
    }, {
      speedUnits: "KPH", speedometerMaxMps: 80,
      minimap: {
        course: racingLine.points.map(({ position: [x, , z] }) => ({ x, z })),
        cars: observe().map(({ id, car: { position: [x, , z] } }) => ({ id, x, z, local: id === player.id })),
        viewport: { width: 640, height: 480 }, anchor: { x: 0.9, y: 0.18 }, extent: 100,
      },
    });
    assert.equal(hud.participants, "6");
    assert.equal(hud.minimap?.markers.length, 6);
    assert.ok(hud.speed > 0 && hud.rpm > 0 && hud.gear && hud.totalTime);

    const frame = input.poll(dt);
    menu.update(dt, { ...frame, driving: { ...frame.driving, pausePressed: true } });
    assert.equal(menu.getView().state, "PAUSE");
    const pausedTime = race.elapsedRaceTime;
    const pausedPosition = [...cars[0]!.state.position];
    tick();
    assert.equal(race.elapsedRaceTime, pausedTime);
    assert.deepEqual(cars[0]!.state.position, pausedPosition);
    assert.ok(menu.activate("resume"));
    tick();
    assert.ok(race.elapsedRaceTime > pausedTime);
    menu.update(dt, { ...frame, driving: { ...frame.driving, pausePressed: true } });
    assert.ok(menu.activate("restart"));
    const restart = menu.drainCommands().find(command => command.type === "RestartRace")!;
    assert.deepEqual(restart.setup, launch.setup);
    race = createRace();
    cars = createCars();
    assert.ok(menu.completeLoad(restart.requestId));
    assert.equal(race.phase, "INTRO");
    assert.equal(cars[0]!.state.speedMps, 0);
  });

test("track difficulty offsets resolve to positive AI scales and AI driveDirection maps cleanly to pedals", () => {
  assert.deepEqual(resolveTrackDifficultyScales(), [1, 1, 1]);
  assert.deepEqual(resolveTrackDifficultyScales([0, -0.04, -0.15]), [1, 0.96, 0.85]);
  assert.deepEqual(resolveTrackDifficultyScales([-2, 2, -0.39]), [0.5, 1.5, 0.61]);

  const forwardBrake = aiControlToDrivingInput({
    throttle: 0, brake: 0.8, steer: 0.2, handbrake: false, boost: false, powerMultiplier: 1, driveDirection: 1,
  }, { gear: 1, speedMps: 1.9 });
  assert.equal(forwardBrake.throttle, 0);
  assert.equal(forwardBrake.brake, 0.8);
  assert.equal(forwardBrake.handbrake, true);

  const exitReverse = aiControlToDrivingInput({
    throttle: 0, brake: 0.8, steer: 0, handbrake: false, boost: false, powerMultiplier: 1, driveDirection: 1,
  }, { gear: -1, speedMps: 1.5 });
  assert.equal(exitReverse.throttle, 0.25);
  assert.equal(exitReverse.brake, 0);
  assert.equal(exitReverse.handbrake, true);

  const backingOut = aiControlToDrivingInput({
    throttle: 0.65, brake: 0, steer: -0.65, handbrake: false, boost: false, powerMultiplier: 1, driveDirection: -1,
  }, { gear: 1, speedMps: 0.1 });
  assert.equal(backingOut.throttle, 0);
  assert.equal(backingOut.brake, 0.65);
  assert.equal(backingOut.handbrake, false);
});

test("AI blocked threshold detects pinned cars and flipped AI auto-recovers after 2s", () => {
  // Pinned cars commonly register ~198-199 N*s impulse at low speed.
  assert.equal(isAiCarBlocked(198, 0.4), true);
  assert.equal(isAiCarBlocked(60, 1.8), true);
  assert.equal(isAiCarBlocked(40, 0.5, 0), false);
  assert.equal(isAiCarBlocked(200, 5.0, 0), false);
  assert.equal(isAiCarBlocked(0, 0.8, 1.2), true);

  let timer = 0;
  let step = updateAiFlippedTimer(timer, 0.9, 1.0);
  assert.deepEqual(step, { timer: 0, shouldReset: false });
  step = updateAiFlippedTimer(step.timer, 0.1, 1.1);
  assert.equal(step.shouldReset, false);
  assert.ok(step.timer > 1.0);
  // Righting the car resets the timer.
  step = updateAiFlippedTimer(step.timer, 0.8, 0.2);
  assert.deepEqual(step, { timer: 0, shouldReset: false });
  // Staying flipped >= 2s triggers reset.
  step = updateAiFlippedTimer(0, -0.5, 1.2);
  assert.equal(step.shouldReset, false);
  step = updateAiFlippedTimer(step.timer, 0.2, 0.9);
  assert.deepEqual(step, { timer: 0, shouldReset: true });
});

test("engine audio layer roles, per-car ENGSND banks, and tyre/collision samples resolve accurately", demoOptions, async () => {
  // Positional fallback matches FR3's HIGH_LOADED..TICKOVER SPC order.
  assert.equal(resolveEngineLayerRole("unknown_0", 0), "HIGH_LOADED");
  assert.equal(resolveEngineLayerRole("unknown_4", 4), "TICKOVER");
  assert.equal(resolveEngineLayerRole("engine_sample_type_tickover", 0), "TICKOVER");
  assert.equal(resolveEngineLayerRole("ENGINE_SAMPLE_TYPE_HIGH_LOADED", 4), "HIGH_LOADED");
  assert.ok(defaultReferenceRpmForRole("TICKOVER") < defaultReferenceRpmForRole("LOW_LOADED"));
  assert.ok(defaultReferenceRpmForRole("LOW_LOADED") < defaultReferenceRpmForRole("HIGH_LOADED"));

  const assets = await DemoAssets.load(await NodeVfs.open(demoRoot));
  const eng1 = await assets.loadSpc("SND/ENGINE1.SPC");
  assert.deepEqual(
    eng1.entries.map((entry, idx) => resolveEngineLayerRole(entry.name, idx)),
    ["HIGH_LOADED", "HIGH_UNLOADED", "LOW_LOADED", "LOW_UNLOADED", "TICKOVER"],
  );

  // Per-car ENGSND.DAT mapping resolves distinct banks and falls back cleanly.
  const resolvedBanks = new Set(
    assets.installedCars.map(cfg => resolveCarEngineSound(cfg, assets.tables.engineSounds).bankPath),
  );
  assert.ok(resolvedBanks.size >= 10, `Expected diverse per-car engine banks, got ${resolvedBanks.size}`);
  const fallback = resolveCarEngineSound(
    { car: { id: "CUSTOM", fields: {}, performance: [], liveries: [] } },
    assets.tables.engineSounds,
  );
  assert.equal(fallback.bankPath, "SND/ENGINE1.SPC");
  assert.equal(fallback.record, undefined);

  const tyres = await assets.loadSpc("SND/TYRES.SPC");
  const skid = pickSkidEntry(tyres.entries);
  assert.ok(skid && skid.name.includes("SQUEAL"));

  const misc = await assets.loadSpc("SND/misc.spc");
  const collision = pickCollisionEntry(misc.entries);
  assert.ok(collision && /MEDIUM|HEAVY|LIGHT/.test(collision.name));
  const boost = pickBoostEntry(misc.entries);
  assert.ok(boost && boost.name.includes("BOOST"));
});

test("UI aspect viewport, language display names, and text scale fitting prevent stretching and overflow", demoOptions, async () => {
  // 4:3 stays full canvas; 16:9 pillarboxes; portrait letterboxes.
  assert.deepEqual(computeUiViewport(640, 480), { x: 0, y: 0, width: 640, height: 480 });
  assert.deepEqual(computeUiViewport(1280, 720), { x: 160, y: 0, width: 960, height: 720 });
  assert.deepEqual(computeUiViewport(400, 800), { x: 0, y: 250, width: 400, height: 300 });
  const [ux, uy] = canvasToUiPoint(0.5, 0.5, 1280, 720);
  assert.ok(Math.abs(ux - 0.5) < 1e-6 && Math.abs(uy - 0.5) < 1e-6);
  const [leftEdge] = canvasToUiPoint(160 / 1280, 0.5, 1280, 720);
  assert.ok(Math.abs(leftEdge) < 1e-6);

  assert.equal(formatLanguageDisplayName("GR"), "DEUTSCH (GR)");
  assert.equal(formatLanguageDisplayName("EN"), "ENGLISH");
  assert.equal(formatLanguageDisplayName("US"), "ENGLISH (US)");
  assert.equal(formatLanguageDisplayName("fr"), "FRANCAIS (FR)");

  const assets = await DemoAssets.load(await NodeVfs.open(demoRoot));
  const menuFont = assets.fonts[4]!.font;
  const maxWidthPx = (0.985 - (0.507666 + 0.045352)) * 640;
  for (const label of ["SCHNELLES RENNEN", "HRA PRO JEDNOHO HRÁČE", "GIOCATORE SINGOLO"]) {
    const scale = fitTextScale(menuFont, label, maxWidthPx, 1);
    assert.ok(scale > 0 && scale <= 1);
  }
});

test("results rows keep real finish times and never copy the player's time onto unfinished racers", () => {
  const playerFinish = 272.49;
  const standings = [
    { carId: "A", progress: 3, totalRaceTime: 260.1, bestLapTime: 85, finishTime: 260.1 },
    { carId: "P", progress: 3, totalRaceTime: playerFinish, bestLapTime: 88, finishTime: playerFinish },
    { carId: "B", progress: 2.9, totalRaceTime: playerFinish, bestLapTime: 90, finishTime: null },
    { carId: "C", progress: 1.8, totalRaceTime: playerFinish, bestLapTime: 95, finishTime: null },
    { carId: "D", progress: 0, totalRaceTime: playerFinish, bestLapTime: null, finishTime: null },
  ];
  const rows = buildRaceResultRows(standings, 3, id => `Car ${id}`);
  assert.deepEqual(rows.map(r => r.finished), [true, true, false, false, false]);
  assert.equal(rows[0]!.totalSeconds, 260.1);
  assert.equal(rows[1]!.totalSeconds, playerFinish);
  assert.ok(Math.abs(rows[1]!.gapSeconds! - 12.39) < 1e-9);
  for (const row of rows.slice(2)) assert.equal(row.totalSeconds, null);
  assert.equal(rows[3]!.lapsDown, 1);
  const times = rows.map(r => formatResultsRowTimes(r).time);
  assert.equal(times[0], "04:20.10");
  assert.equal(times[1], "04:32.49");
  assert.match(times[2]!, /^\+\d+\.\d{2}s$/);
  assert.equal(times[3], "+1 LAP");
  assert.equal(times[4], "+3 LAPS");
  assert.equal(new Set(times).size, times.length, "no two racers share a displayed time");
  assert.equal(rows[2]!.carName, "Car B");
});

test("race status keeps the car name after resume and Car Select collapses placeholder liveries", () => {
  assert.equal(formatRacingStatus("Ford Focus RS", "Alaska"), "Racing Ford Focus RS on Alaska");
  assert.equal(formatRacingStatus(undefined, "Alaska"), "Racing on Alaska");
  const question = Array.from({ length: 12 }, (_, i) => ({ type: `LIVERY_${i}`, stem: "QUESTION" }));
  assert.deepEqual(dedupeCarLiveries(question, false), ["LIVERY_0"]);
  assert.equal(dedupeCarLiveries(question, true).length, 12);
  assert.deepEqual(dedupeCarLiveries([], false), []);
  assert.equal(hasLiveryTextureVariants([{ kind: "texture", flags: 0x0003_0000 }]), false);
  assert.equal(hasLiveryTextureVariants([{ kind: "reference", flags: 0x0100_0000 }]), false);
  assert.equal(hasLiveryTextureVariants([{ kind: "texture", flags: 0x0200_0000 }]), true);
});

test("only the 16 GT/LMP placeholder-livery cars collapse; QUESTION-stem cars with texture variants keep them",
  demoOptions, async () => {
    const assets = await DemoAssets.load(await NodeVfs.open(demoRoot));
    const collapsed: string[] = [];
    let keptQuestionCars = 0;
    for (const cfg of assets.installedCars) {
      if (cfg.car.liveries.length < 2) continue;
      if (!cfg.car.liveries.every(l => l.stem.toUpperCase() === "QUESTION")) continue;
      const bundle = await assets.load3dBundle(cfg.shapeFolder);
      const liveries = dedupeCarLiveries(cfg.car.liveries, hasLiveryTextureVariants(bundle.textures.textures));
      if (liveries.length === 1) collapsed.push(cfg.car.id);
      else keptQuestionCars++;
    }
    assert.equal(collapsed.length, 16, collapsed.join(","));
    for (const id of ["BMW_M3_GTR", "AUDI_R8", "LISTER_LMP", "CHAMP_CAR", "MCLAREN_F1_GTR"]) {
      assert.ok(collapsed.includes(id), id);
    }
    assert.ok(!collapsed.includes("TBIRD_62"));
    assert.ok(keptQuestionCars > 0);
  });

test("tick error guard keeps the loop alive on transient errors, halts on a streak and recovers", () => {
  const guard = new TickErrorGuard(3);
  assert.deepEqual(guard.failure(false), { report: true, halt: false });
  guard.success();
  assert.deepEqual(guard.failure(false), { report: true, halt: false });
  assert.deepEqual(guard.failure(false), { report: false, halt: false });
  assert.deepEqual(guard.failure(false), { report: true, halt: true });
  assert.equal(guard.isHalted, true);
  assert.equal(guard.recover(), true);
  assert.equal(guard.isHalted, false);
  assert.equal(guard.consecutiveErrors, 0);
  assert.equal(guard.recover(), false);
  assert.deepEqual(guard.failure(true), { report: true, halt: true });
});

test("GEN_ENG.SPC supplies turbo/supercharger/whine layers per ENGSND record and a looped wind sample",
  demoOptions, async () => {
    assert.equal(resolveGenEngineRole("ENGINE_SAMPLE_TYPE_WIND"), "WIND");
    assert.equal(resolveGenEngineRole("ENGINE_SAMPLE_TYPE_SUPERCHARGER"), "SUPERCHARGER");
    assert.equal(resolveGenEngineRole("ENGINE_SAMPLE_TYPE_HIGH_LOADED"), null);

    const assets = await DemoAssets.load(await NodeVfs.open(demoRoot));
    const gen = await assets.loadSpc(GEN_ENGINE_SPC_PATH);
    assert.deepEqual(gen.entries.map(e => resolveGenEngineRole(e.name)).sort(),
      ["GEARBOX_WHINE", "SUPERCHARGER", "TURBO", "WIND"]);
    const wind = pickWindEntry(gen.entries);
    assert.ok(wind && wind.wave.smplLoops.length > 0);

    const records = [...assets.tables.engineSounds.values()];
    const auxRecords = records.filter(r => pickGenEngineAuxEntries(gen.entries, r).length > 0);
    assert.ok(auxRecords.length > 0, "some ENGSND records request GEN_ENG layers");
    for (const record of auxRecords) {
      const wanted = new Set(record.samples.map(s => resolveGenEngineRole(s.type)).filter(r => r && r !== "WIND"));
      const picked = pickGenEngineAuxEntries(gen.entries, record);
      assert.deepEqual(new Set(picked.map(p => p.role)), wanted);
      for (const { entry } of picked) assert.notEqual(resolveGenEngineRole(entry.name), "WIND");
    }
    const sample = auxRecords[0]!;
    const presentRole = pickGenEngineAuxEntries(gen.entries, sample)[0]!.role;
    assert.ok(pickGenEngineAuxEntries(gen.entries, sample, new Set([presentRole])).every(p => p.role !== presentRole));
    assert.deepEqual(pickGenEngineAuxEntries(gen.entries, undefined), []);
  });

test("Car Select track label keeps a readable scale and truncates with an ellipsis", demoOptions, async () => {
  const assets = await DemoAssets.load(await NodeVfs.open(demoRoot));
  const font = assets.fonts[2]!.font;
  const long = "TRACK: AN EXTREMELY LONG TRACK NAME THAT WILL NEVER FIT (ABCDEF)";
  const width = 0.2 * 640;
  const fitted = fitTextWithEllipsis(font, [long, "AN EXTREMELY LONG TRACK NAME THAT WILL NEVER FIT"], width, 0.62);
  assert.ok(fitted.scale >= Math.min(0.62, READABLE_MIN_TEXT_SCALE) - 1e-9);
  assert.ok(fitted.text.endsWith("..."));
  assert.ok(measureTextLine(font, fitted.text) * fitted.scale <= width + 1e-6);
  const short = fitTextWithEllipsis(font, ["TRACK: ALASKA"], 0.44 * 640, 0.62);
  assert.deepEqual(short, { text: "TRACK: ALASKA", scale: 0.62 });
  // Prefers a shorter candidate over truncation when it fits at a readable scale.
  const mid = fitTextWithEllipsis(font, [long, "ALASKA"], width, 0.62);
  assert.equal(mid.text, "ALASKA");
});

test("display names drop the translation tables' internal !!tag!! markers", () => {
  assert.equal(stripDisplayNameMarkers("!!secret!! 1970 CAPRI Mk I RS2600 ELECTRIC"), "1970 CAPRI Mk I RS2600 ELECTRIC");
  assert.equal(stripDisplayNameMarkers("!!clone!! 1985 RS200"), "1985 RS200");
  assert.equal(stripDisplayNameMarkers("  !!secret!!!!clone!!  2004 M3 GTR "), "2004 M3 GTR");
  assert.equal(stripDisplayNameMarkers("1966 GT40 MkII"), "1966 GT40 MkII");
  assert.equal(stripDisplayNameMarkers("SHELBY GR-1 !!concept!!"), "SHELBY GR-1 !!concept!!");
  // A bare marker is not a name: the caller falls back to the record id.
  assert.equal(stripDisplayNameMarkers("!!TEXT MISSING!!"), undefined);
  assert.equal(stripDisplayNameMarkers(undefined), undefined);
});
