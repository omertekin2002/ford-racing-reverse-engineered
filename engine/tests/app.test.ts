import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  aiControlToDrivingInput, buildMenuScene, buildRaceHudInput, buildRaceResultRows, CAR_TURNTABLE_RECT, carGroupLabel,
  classifyLaunch, computeCarRatings, countdownStepSound, dedupeCarLiveries, defaultReferenceRpmForRole,
  formatFinishingPosition, formatLanguageDisplayName, formatRacingStatus, GEN_ENGINE_SPC_PATH, hasLiveryTextureVariants,
  hudLabels, isAiCarBlocked, isHudWrongWay, MODE_ICON_TEXTURES, pickBoostEntry, pickCollisionEntry,
  pickGenEngineAuxEntries, pickSkidEntry, pickSpread, pickWindEntry, raceCountdownTime, resolveCarEngineSound,
  resolveEngineLayerRole, resolveGenEngineRole, resolveTrackDifficultyScales, stripDisplayNameMarkers, TickErrorGuard,
  menuDrawItems, RCRES_LAYOUT, trackGroupLabel, updateAiFlippedTimer, type AppMenuScene, type MenuSceneContext,
  type RaceHudSource, aiReferenceGap, drawItemAt, FordRacing3App, LAZY_UI_TEXTURE_RETRIES, playerDrivingInput,
  TRACK_CYCLE_RECT,
} from "../src/app.js";
import { CODE_SET_UI_TEXTURES } from "../src/demoAssets.js";
import {
  buildHudDrawList, COUNTDOWN_DURATION, COUNTDOWN_RACE_START_TIME, formatResultsRowTimes,
} from "../src/ui/hudModel.js";
import { DemoAssets, demoTrackDirectory } from "../src/demoAssets.js";
import { AiDriver, trackProgressDelta } from "../src/game/aiDriver.js";
import { CameraController } from "../src/game/cameraController.js";
import { RaceManager, type RaceObservation } from "../src/game/raceManager.js";
import { InputManager } from "../src/input/inputManager.js";
import { mountNativeEngine } from "../src/main.js";
import { resolveCarCollision } from "../src/physics/collision.js";
import { TrackSpatial } from "../src/physics/trackSpatial.js";
import { VehiclePhysics } from "../src/physics/vehiclePhysics.js";
import {
  buildHudBatch, canvasToUiPoint, computeUiViewport, drawUiDrawItems, UiBatchBuilder,
} from "../src/render/uiRenderer.js";
import { measureTextLine } from "../src/formats/fonts.js";
import {
  MENU_SCREEN_SCRIPTS, MenuController, type MenuCar, type MenuState, type MenuTrack, type MenuView,
} from "../src/ui/menuController.js";
import { UiScreenInstance, type ResolvedUiDrawItem, type UiRect } from "../src/ui/uiRuntime.js";
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
    let lastView: ReturnType<CameraController["update"]> | undefined;
    const view0 = () => lastView!;
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
      lastView = view;
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
    // The authentic fr3.exe HUD pipeline the app runs every frame: app state -> HudModelInput -> draw ops.
    const playerCar = cars[0]!.state;
    const hudInput = buildRaceHudInput({
      speedMps: playerCar.speedMps, rpm: playerCar.rpm, maxRpm: configs[0]!.engine.fields.MAX_RPM ?? playerCar.maxRpm,
      gear: playerCar.gear, units: "KPH", approxTopSpeedMph: configs[0]!.car.fields.CAR_APPROXIMATE_TOP_SPEED ?? 150,
      cameraMode: view0().modeName, forwardCameraMode: camera.mode,
      position: player.place, participants: cars.length, lap: player.lap, laps: 3,
      currentLapSeconds: player.lapTime, bestLapSeconds: player.bestLapTime ?? undefined,
      mode: "RACING_BOOST", boostActive: playerCar.boostActive, boostTimer: playerCar.boostTimer,
      boostCharges: playerCar.boostCharges, wrongWay: false, phase: race.phase, phaseElapsed: race.phaseElapsed,
      mapEnabled: true, course: racingLine.points.map(({ position: [x, , z] }) => ({ x, z })),
      cars: observe().map(({ id, car: { position: [x, , z] } }) => ({ id, x, z, local: id === player.id, active: true })),
      labels: hudLabels(assets.translation),
    });
    assert.equal(hudInput.cameraGroup, "chase");
    assert.equal(hudInput.participants, 6);
    assert.ok(hudInput.boost && hudInput.boost.charges === 1);
    const ops = buildHudDrawList(hudInput);
    // One opponent dot per AI car, then the player's dot last (§5.12).
    const dots = ops.filter(op => op.kind === "quad" && op.key === "MISC/MAP_DOT");
    assert.equal(dots.length, 1 + 5 + 1);
    assert.ok(ops.some(op => op.kind === "needle" && op.key === "REV/needle"));
    assert.ok(ops.some(op => op.kind === "numerals" && op.text.startsWith("D")));
    assert.ok(ops.some(op => op.kind === "text" && op.text === "POSITION"));

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

test("HUD keeps the 4:3 viewport while menus map pointers over the full canvas like fr3.exe", () => {
  // 4:3 stays full canvas; 16:9 pillarboxes; portrait letterboxes (HUD layout table 0).
  assert.deepEqual(computeUiViewport(640, 480), { x: 0, y: 0, width: 640, height: 480 });
  assert.deepEqual(computeUiViewport(1280, 720), { x: 160, y: 0, width: 960, height: 720 });
  assert.deepEqual(computeUiViewport(400, 800), { x: 0, y: 250, width: 400, height: 300 });
  const [ux, uy] = canvasToUiPoint(0.5, 0.5, 1280, 720);
  assert.ok(Math.abs(ux - 0.5) < 1e-6 && Math.abs(uy - 0.5) < 1e-6);
  const [leftEdge] = canvasToUiPoint(160 / 1280, 0.5, 1280, 720);
  assert.ok(Math.abs(leftEdge) < 1e-6);
  // Menus: 0x421520 stretches over the whole backbuffer, so pointer coordinates pass straight through.
  assert.deepEqual(canvasToUiPoint(0.1, 0.9, 1280, 720, "fullscreen"), [0.1, 0.9]);

  assert.equal(formatLanguageDisplayName("GR"), "DEUTSCH (GR)");
  assert.equal(formatLanguageDisplayName("EN"), "ENGLISH");
  assert.equal(formatLanguageDisplayName("US"), "ENGLISH (US)");
  assert.equal(formatLanguageDisplayName("fr"), "FRANCAIS (FR)");
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

// ─── Authentic front end (every MENU_SCREEN_SCRIPTS screen through buildMenuScene) ───────────────────────────

let frontEndFixture: Promise<{
  assets: DemoAssets; ctx: MenuSceneContext; cars: MenuCar[]; tracks: MenuTrack[];
}> | undefined;
function frontEnd() {
  frontEndFixture ??= (async () => {
    const assets = await DemoAssets.load(await NodeVfs.open(demoRoot));
    const scripts = Object.values(MENU_SCREEN_SCRIPTS).filter((path): path is string => path !== null);
    await assets.preloadUiTextures(scripts, CODE_SET_UI_TEXTURES);
    const cars: MenuCar[] = assets.installedCars.map(cfg => ({
      id: cfg.car.id, name: cfg.car.id, liveries: cfg.car.liveries.map(l => l.type),
      group: cfg.car.fields.CAR_GROUP_TYPE, ratings: computeCarRatings(cfg),
    }));
    const tracks: MenuTrack[] = assets.installedTracks.map(t => ({ id: t.id, name: t.id, group: t.TRACK_GROUP_TYPE }));
    const ctx: MenuSceneContext = {
      readFile: assets.readUiScript, translation: assets.translation, getTextureSize: assets.getUiTextureSize,
      fonts: assets.fonts, languages: assets.languages, cars,
    };
    return { assets, ctx, cars, tracks };
  })();
  return frontEndFixture;
}

const idle = { up: false, down: false, left: false, right: false, confirm: false, back: false, anyKey: false,
  pointerX: 0, pointerY: 0, pointerMoved: false, pointerClicked: false };
const noDriving = new InputManager().poll(0).driving;
function press(menu: MenuController, key: keyof typeof idle) {
  menu.update(1 / 60, { driving: noDriving, menu: { ...idle, [key]: true } });
}
const px = (value: number, axis: "x" | "y") => Math.round(value * (axis === "x" ? 640 : 480));

test("every front-end state opens its authentic .UI screen with real textures and no synthetic layer", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  const menu = new MenuController({ cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages });
  const view = menu.getView();
  for (const state of Object.keys(MENU_SCREEN_SCRIPTS) as MenuState[]) {
    const scene = buildMenuScene(state, { ...view, state }, ctx);
    if (MENU_SCREEN_SCRIPTS[state] === null) {
      assert.equal(scene, undefined, state);
      continue;
    }
    assert.ok(scene, state);
    assert.equal(scene.screen.path, MENU_SCREEN_SCRIPTS[state], state);
    for (let i = 0; i < 30; i++) {
      scene.screen.update(1 / 30);
      scene.tick?.(1 / 30, { ...view, state });
    }
    const items = scene.screen.getDrawItems();
    assert.ok(items.length > 0, state);
    for (const item of items) {
      if (item.textureRef) {
        assert.ok(assets.getLoadedUiTexture(item.textureRef.registeredKey), `${state} ${item.id} preloaded`);
      }
      // AUTOSIZE nodes always resolve to the texture's real pixel size, never 0×0.
      if (item.autosize && item.textureRef) assert.ok(item.rect.width > 0 && item.rect.height > 0, `${state} ${item.id}`);
    }
    // Every action id is a real node of the script.
    for (const id of Object.keys(scene.actions)) assert.ok(scene.screen.getNodeRect(id), `${state} action ${id}`);

    // Painting the items adds only what the script resolves to (fills, textures, glyphs).
    const batch = new UiBatchBuilder(1280, 720);
    drawUiDrawItems(batch, items, {
      texture: key => assets.getLoadedUiTexture(key), font: slot => assets.fonts[slot],
      onMissingTexture: key => assert.fail(`${state} lazily requested ${key}`),
    });
    assert.ok(batch.build().commands.length > 0, state);
  }
  // RCEND, not RCRES, is the race-end screen; RCRES is the results screen.
  assert.equal(buildMenuScene("RACE_END", { ...view, state: "RACE_END" }, ctx)!.screen.path, "UI/RCEND.UI");
  assert.equal(buildMenuScene("RESULTS", { ...view, state: "RESULTS" }, ctx)!.screen.path, "UI/RCRES.UI");
});

test("START, GAMEF and PAUSE use the script texts, the MENUBAR selection bar and auto-sized icons", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  const menu = new MenuController({ cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages });
  const view = menu.getView();
  const text = (scene: ReturnType<typeof buildMenuScene>, id: string) =>
    scene!.screen.getDrawItems().find(item => item.id === id)?.text ?? null;

  const start = buildMenuScene("START", view, ctx)!;
  assert.equal(text(start, "BUTTON1"), "PRESS ANY KEY");
  assert.equal(text(start, "VERSION"), null);
  assert.ok(!start.screen.getDrawItems().some(item => item.text?.includes("WEBGL")));

  const gamef = buildMenuScene("MAIN_MENU", { ...view, state: "MAIN_MENU" }, ctx)!;
  for (let i = 0; i < 60; i++) gamef.screen.update(1 / 60);
  const items = gamef.screen.getDrawItems();
  assert.deepEqual(["BUTTON1", "BUTTON2", "BUTTON3", "BUTTON4"].map(id => text(gamef, id)),
    ["QUICK RACE", "SINGLE PLAYER", "MULTIPLAYER", "OPTIONS"]);
  assert.ok(!items.some(item => item.id === "BUTTON5" || item.id === "BUTTON6"));
  assert.equal(text(gamef, "TITLE"), "WELCOME TO SHUFFLE");
  assert.deepEqual(gamef.actions, { BUTTON1: "quick-race", BUTTON2: "single-player", BUTTON4: "options" });
  // MULTIPLAYER is shown but skipped by focus navigation.
  assert.equal(gamef.screen.moveFocus("down"), "BUTTON2");
  assert.equal(gamef.screen.moveFocus("down"), "BUTTON4");
  gamef.screen.update(1 / 60);
  const bar = gamef.screen.getDrawItems().find(item => item.id === "MENUBAR")!;
  const focused = gamef.screen.getNodeRect("BUTTON4")!;
  assert.equal(bar.textureRef?.entryName, "menu_hi");
  assert.deepEqual([bar.rect.x, bar.rect.y], [focused.x, focused.y]);
  assert.equal(gamef.screen.getDrawItems().find(item => item.id === "MENUBAR_ICON")?.textureRef?.entryName, "pcenter");
  assert.equal(gamef.screen.getDrawItems().find(item => item.id === "BACK_ICON")?.textureRef?.entryName, "pcescape");

  const pause = buildMenuScene("PAUSE", { ...view, state: "PAUSE" }, ctx)!;
  for (let i = 0; i < 60; i++) pause.screen.update(1 / 60);
  const icon = pause.screen.getDrawItems().find(item => item.id === "PAUSEICON")!;
  assert.deepEqual([px(icon.rect.width, "x"), px(icon.rect.height, "y")], [84, 84]);
  assert.equal(px(icon.rect.x, "x"), 277);
  const strip = pause.screen.getDrawItems().find(item => item.id === "DARKBKG")!;
  assert.ok(strip.fill && px(strip.rect.y, "y") === 208 && px(strip.rect.height, "y") === 152);
  assert.ok(!pause.screen.getDrawItems().some(item => item.id === "RULES" || item.id === "EXITREPLAY"));
  assert.deepEqual(pause.actions, { RESUME: "resume", RESTART: "restart", OPTIONS: "options", RETIRE: "quit" });
});

test("CAR.UI separates the class and car pages, crops RATING1 bars and pins CARNAME on the bar", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  const menu = new MenuController({
    cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages,
    createScene: (state, view) => buildMenuScene(state, view, ctx),
  });
  menu.continueFromStart();
  assert.ok(menu.activate("select-car"));
  const screen = menu.screen!;
  assert.equal(screen.path, "UI/CAR.UI");
  assert.equal(menu.getView().carSelectPage, "GROUP");
  const groupItems = screen.getDrawItems();
  const classes = menu.getView().carGroups;
  assert.ok(classes.length >= 2 && classes.length <= 8);
  assert.deepEqual(
    classes.map((_, i) => groupItems.find(item => item.id === `BUTTON${i + 1}`)?.text),
    classes.map(group => carGroupLabel(assets.translation, group)),
  );
  // Only the class page draws: one TITLE, no car name, no rating bars.
  assert.deepEqual(groupItems.filter(item => item.id === "TITLE").map(item => item.text), ["CHOOSE A VEHICLE CLASS"]);
  assert.ok(!groupItems.some(item => ["CARNAME", "TOPSPEED", "COLOUR_TEXT"].includes(item.id)));
  assert.equal(groupItems.find(item => item.id === "CAR")?.textureRef?.entryName.toLowerCase(), "car");

  // Pick the second class: the car page opens with that class's first car.
  screen.moveFocus("down");
  press(menu, "confirm");
  const view = menu.getView();
  assert.equal(view.carSelectPage, "ITEM");
  assert.equal(view.car?.group, classes[1]);
  for (let i = 0; i < 30; i++) menu.update(1 / 30, { driving: noDriving, menu: idle });
  const items = screen.getDrawItems();
  assert.deepEqual(items.filter(item => item.id === "TITLE").map(item => item.text), ["CHOOSE A VEHICLE"]);
  assert.equal(items.find(item => item.id === "CARNAME")?.text, view.car!.id);
  assert.ok(!items.some(item => item.id.startsWith("BUTTON")));
  const ratings = view.car!.ratings!;
  for (const [id, value] of [["TOPSPEED", ratings.speed], ["AGILITY", ratings.agility], ["ACCELERATION", ratings.acceleration],
    ["WEIGHT", ratings.weight]] as const) {
    const bar = items.find(item => item.id === id)!;
    assert.equal(px(bar.graphicRect.width, "x"), Math.round(105 * value!), id);
    // STRETCH_GRAPHIC 0: the narrower bar samples a UV crop of rating1, never a squashed copy.
    if (value! < 1) assert.ok(Math.abs(bar.uvRect![2] - value!) < 1e-3, id);
  }
  // CARNAMEWINDOW's MENUBAR sits on the car name with the PCEnter icon.
  const nameBar = screen.getNodeRect("CARNAMEWINDOW/MENUBAR")!;
  assert.deepEqual([px(nameBar.x, "x"), px(nameBar.y, "y")], [37, 81]);
  const counter = items.find(item => item.id === "FR3_PAGE_COUNTER")?.text;
  assert.match(counter ?? "", /^1\/\d+$/);
  assert.ok(CAR_TURNTABLE_RECT.x * 640 >= 283 && (CAR_TURNTABLE_RECT.y + CAR_TURNTABLE_RECT.height) * 480 <= 288);

  // Left/Right steps cars inside the class; Esc returns to the class page.
  const first = view.car!.id;
  press(menu, "right");
  assert.notEqual(menu.getView().car!.id, first);
  assert.equal(menu.getView().car!.group, classes[1]);
  press(menu, "back");
  assert.equal(menu.getView().carSelectPage, "GROUP");
  assert.equal(screen.getFocusedId(), "BUTTON2");
});

test("single player runs GAMEF -> CMODE -> CAR -> TRACK -> ROPT -> LOADING through authentic screens", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  const menu = new MenuController({
    cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages,
    createScene: (state, view) => buildMenuScene(state, view, ctx),
  });
  press(menu, "anyKey");
  assert.equal(menu.getView().state, "MAIN_MENU");
  press(menu, "down");
  press(menu, "confirm");
  assert.equal(menu.getView().state, "MODE_SELECT");
  assert.equal(menu.screen!.path, "UI/CMODE.UI");
  const modeIcons = menu.screen!.getDrawItems().filter(item => item.id === "BUTTON1" || item.id === "BUTTON2");
  assert.deepEqual(modeIcons.map(item => item.textureRef?.entryName), ["racing", "boost"]);
  assert.ok(MODE_ICON_TEXTURES.RACING_BOOST.endsWith("BOOST.PSD"));
  press(menu, "right");
  press(menu, "confirm");
  assert.equal(menu.getView().raceOptions.mode, "RACING_BOOST");
  assert.equal(menu.getView().state, "CAR_SELECT");
  press(menu, "confirm"); // class page -> car page
  press(menu, "confirm"); // car page DONE -> track select
  assert.equal(menu.getView().state, "TRACK_SELECT");
  assert.equal(menu.screen!.path, "UI/TRACK.UI");
  const rosters = menu.screen!.getDrawItems().filter(item => /^BUTTON\d$/.test(item.id)).map(item => item.text);
  assert.deepEqual(rosters, menu.getView().trackGroups.map(group => trackGroupLabel(assets.translation, group)));
  press(menu, "confirm"); // roster -> track page
  assert.equal(menu.getView().trackSelectPage, "ITEM");
  const trackBefore = menu.getView().track!.id;
  press(menu, "right");
  assert.notEqual(menu.getView().track!.id, trackBefore);
  assert.equal(menu.screen!.getDrawItems().find(item => item.id === "TRACKNAME")?.text, menu.getView().track!.id);
  press(menu, "confirm");
  assert.equal(menu.getView().state, "RACE_OPTIONS");

  // ROPT rows change with Left/Right through { adjust } actions; the arrows follow the focused value.
  const ropt = menu.screen!;
  const value = (id: string) => ropt.getDrawItems().find(item => item.id === id)?.text;
  assert.equal(value("LAPSNUMBER"), "3");
  press(menu, "right");
  assert.equal(value("LAPSNUMBER"), "4");
  press(menu, "down");
  press(menu, "left");
  assert.equal(menu.getView().raceOptions.opponents, 4);
  press(menu, "down");
  press(menu, "confirm");
  assert.equal(value("FIELDNUMBER"), "MATCH");
  buildMenuScene("RACE_OPTIONS", menu.getView(), ctx)!.tick?.(0, menu.getView());
  const scene = buildMenuScene("RACE_OPTIONS", menu.getView(), ctx)!;
  scene.screen.setFocus("DIFF");
  scene.tick!(0, menu.getView());
  const diff = scene.screen.getDrawItems().find(item => item.id === "DIFFNUMBER")!;
  const left = scene.screen.getNodeRect("LEFTARROW")!;
  const right = scene.screen.getNodeRect("RIGHTARROW")!;
  assert.ok(left.x + left.width <= diff.textRect.x && right.x > diff.textRect.x, "arrows bracket the value");
  assert.ok(Math.abs(left.y + left.height / 2 - (diff.rect.y + diff.rect.height / 2)) < 1e-6);
  scene.screen.setFocus("RACE");
  scene.tick!(0, menu.getView());
  assert.ok(!scene.screen.getDrawItems().some(item => item.id === "LEFTARROW"));

  for (let i = 0; i < 3; i++) press(menu, "down"); // FIELD -> DIFF -> CATCH UP -> RACE
  menu.drainCommands();
  press(menu, "confirm");
  assert.equal(menu.getView().state, "LOADING");
  const launch = menu.drainCommands().find(command => command.type === "LaunchRaceRequest");
  assert.ok(launch && launch.type === "LaunchRaceRequest");
  assert.deepEqual([launch.setup.laps, launch.setup.opponents, launch.setup.fieldType, launch.setup.mode],
    [4, 4, "MATCH", "RACING_BOOST"]);
});

test("options hub and sub-screens wire OPTS, AUDIO, GMOPT, DISP, CTRLS, CRED and LANG", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  let resets = 0;
  const input = new InputManager();
  const menu = new MenuController({
    cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages,
    input: { getBinding: a => input.getBinding(a), setBinding: (a, c) => input.setBinding(a, c), resetBindings: () => { resets++; } },
    storage: { getItem: () => null, setItem: () => undefined },
    createScene: (state, view) => buildMenuScene(state, view, ctx),
  });
  menu.continueFromStart();
  assert.ok(menu.activate("options"));
  const hub = menu.screen!;
  assert.deepEqual(hub.getDrawItems().filter(item => /^BUTTON\d$/.test(item.id)).map(item => item.text),
    ["GAME", "AUDIO", "DISPLAY", "CONTROLS", "CREDITS"]);
  assert.ok(!hub.getDrawItems().some(item => item.id === "IN_GAME_DARK_STRIP"), "front-end OPTS has no in-game strip");

  press(menu, "down");
  press(menu, "confirm");
  assert.equal(menu.getView().state, "OPTIONS_AUDIO");
  assert.equal(menu.screen!.getFocusedId(), "ENGINE");
  press(menu, "left");
  press(menu, "left");
  assert.equal(menu.getView().settings.engineVolume, 0.8);
  const audio = menu.screen!;
  const valueBar = audio.getDrawItems().find(item => item.id === "ENGINE_SLIDER_BAR_VALUE")!;
  assert.equal(px(valueBar.graphicRect.width, "x"), Math.round(168 * 0.8));
  // ui_audio.c never fills ENGINENUMBER & co.: no digits over the bars.
  assert.ok(!audio.getDrawItems().some(item => /NUMBER$/.test(item.id) && item.text));
  assert.ok(!audio.getDrawItems().some(item => item.id === "SOUNDTRACK" || item.id === "AUDIOOUTPUT"));
  press(menu, "back");
  assert.equal(menu.screen!.getFocusedId(), "BUTTON2", "the hub reopens on the row that opened AUDIO");

  press(menu, "up");
  press(menu, "confirm");
  assert.equal(menu.getView().state, "OPTIONS_GAME");
  press(menu, "down");
  press(menu, "right");
  assert.equal(menu.getView().settings.transmission, "MANUAL");
  assert.equal(menu.screen!.getDrawItems().find(item => item.id === "GEARSNUMBER")?.text, "MANUAL");
  press(menu, "back");

  assert.ok(menu.activate("options-display"));
  press(menu, "right");
  assert.equal(menu.getView().settings.speedUnits, "KPH");
  assert.equal(menu.screen!.getDrawItems().find(item => item.id === "SPEEDONUMBER")?.text, "KM/H");
  press(menu, "down");
  press(menu, "confirm");
  assert.equal(menu.getView().settings.trackMap, false);
  press(menu, "back");

  assert.ok(menu.activate("options-controls"));
  assert.equal(menu.screen!.path, "UI/CTRLS.UI");
  press(menu, "confirm");
  assert.equal(resets, 1);
  press(menu, "back");

  assert.ok(menu.activate("options-credits"));
  const credits = buildMenuScene("OPTIONS_CREDITS", menu.getView(), ctx)!;
  const rows = credits.screen.getListItems("LISTBOX");
  assert.ok(rows.length > 20 && rows.some(row => row.text === "PROGRAMMING"));
  const y0 = credits.screen.getNodeRect("LISTBOX")!.y;
  credits.tick!(1, menu.getView());
  assert.ok(credits.screen.getNodeRect("LISTBOX")!.y < y0, "credits scroll");
  press(menu, "back");

  assert.ok(menu.activate("options-language"));
  const lang = menu.screen!;
  assert.deepEqual(lang.getDrawItems().filter(item => /^BUTTON\d$/.test(item.id)).map(item => item.text),
    ["ENGLISH", "FRANÇAIS", "DEUTSCH", "ITALIANO", "ESPAÑOL"]);
  press(menu, "down");
  press(menu, "confirm");
  assert.equal(menu.getView().settings.language, "FR");
  assert.equal(menu.getView().state, "OPTIONS");
});

test("pause options run in-game, and RCRES -> RCEND show the real results list and buttons", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  let playerIndex: number | undefined;
  const menu = new MenuController({
    cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages,
    quickRaces: [{ trackId: assets.defaultTrackId, carId: cars[0]!.id, laps: 2, difficulty: "MEDIUM",
      mode: "RACING_BOOST", transmission: "AUTO" }],
    createScene: (state, view) => buildMenuScene(state, view, {
      ...ctx, resultsMode: () => "RACING_BOOST", resultsPlayerIndex: () => playerIndex,
    }),
  });
  menu.continueFromStart();
  assert.ok(menu.activate("quick-race"));
  const launch = menu.drainCommands().find(command => command.type === "LaunchRaceRequest");
  assert.ok(launch && launch.type === "LaunchRaceRequest" && menu.completeLoad(launch.requestId));
  menu.update(1 / 60, { driving: { ...noDriving, pausePressed: true }, menu: idle });
  assert.equal(menu.getView().state, "PAUSE");
  assert.ok(menu.activate("options"));
  assert.equal(menu.getView().inGameOptions, true);
  const opts = menu.screen!.getDrawItems();
  assert.ok(opts.some(item => item.id === "IN_GAME_DARK_STRIP" && item.fill));
  assert.equal(opts.find(item => item.id === menu.screen!.id)?.textureRef ?? null, null, "no 49.PSD over the race");
  press(menu, "back");
  assert.equal(menu.getView().state, "PAUSE");
  assert.ok(menu.activate("resume"));

  playerIndex = 1;
  const standings = buildRaceResultRows([
    { carId: "A", progress: 2, totalRaceTime: 100, bestLapTime: 49, finishTime: 100 },
    { carId: cars[0]!.id, progress: 2, totalRaceTime: 101.5, bestLapTime: 50, finishTime: 101.5 },
    { carId: "C", progress: 0.9, totalRaceTime: 101.5, bestLapTime: 60, finishTime: null },
  ], 2, id => `Car ${id}`);
  assert.ok(menu.finishRace(standings));
  assert.equal(menu.screen!.path, "UI/RCRES.UI");
  const results = menu.screen!;
  assert.equal(results.getDrawItems().find(item => item.id === "BUTTON1")?.text, formatFinishingPosition(assets.translation, 2));
  assert.equal(formatFinishingPosition(assets.translation, 2), "2ND");
  assert.equal(results.getDrawItems().find(item => item.id === "MODETITLE")?.text, "BOOST");
  assert.equal(results.getDrawItems().find(item => item.id === "MODEICON")?.textureRef?.entryName, "boost");
  assert.deepEqual(results.getListItems("LISTBOX1").map(row => row.text), ["1  Car A", `2  Car ${cars[0]!.id}`, "3  Car C"]);
  assert.deepEqual(results.getListItems("LISTBOX2").map(row => row.text), ["01:40.00", "01:41.50", "+1 LAP"]);
  assert.deepEqual(results.getListItems("LISTBOX2")[1]!.colour, [255, 249, 135, 255]);

  press(menu, "confirm");
  assert.equal(menu.getView().state, "RACE_END");
  const end = menu.screen!;
  assert.equal(end.path, "UI/RCEND.UI");
  assert.equal(end.getFocusedId(), "RETRY");
  assert.equal(end.getDrawItems().find(item => item.id === "FORDLOGO")?.textureRef?.entryName.toLowerCase(), "fordrace");
  press(menu, "up");
  assert.equal(end.getFocusedId(), "EXIT", "VIEW REPLAY is greyed out and skipped");
  menu.drainCommands();
  press(menu, "down");
  press(menu, "confirm");
  assert.ok(menu.drainCommands().some(command => command.type === "RestartRace"));
});

// ─── Phase 3 polish: fr3.exe layout fidelity of the front-end screens ──────────────────────────────────────

function settle(scene: AppMenuScene, view: MenuView, frames = 40) {
  for (let i = 0; i < frames; i++) {
    scene.screen.update(1 / 30);
    scene.tick?.(1 / 30, view);
  }
}
const drawn = (scene: AppMenuScene, id: string) => scene.screen.getDrawItems().find(item => item.id === id);
const overlaps = (a: UiRect, b: UiRect) => a.x < b.x + b.width - 1e-9 && b.x < a.x + a.width - 1e-9
  && a.y < b.y + b.height - 1e-9 && b.y < a.y + a.height - 1e-9;
const centreY = (rect: UiRect) => rect.y + rect.height / 2;
/** Horizontal extent of an item's text as the renderer lays it out (font metrics + justification). */
function textSpan(assets: DemoAssets, item: ResolvedUiDrawItem): [number, number] {
  const font = assets.fonts[item.font]!.font;
  const width = measureTextLine(font, item.text!) / 640;
  const h = Math.max(0, Math.min(8, Math.trunc(item.textJustify))) % 3;
  const x = h === 1 ? item.textRect.x : h === 2 ? item.textRect.x + item.textRect.width - width
    : item.textRect.x + (item.textRect.width - width) / 2;
  return [x, x + width];
}
const idleInput = { up: false, down: false, left: false, right: false, confirm: false, back: false, anyKey: false,
  pointerX: 0, pointerY: 0, pointerMoved: false, pointerClicked: false };

test("in-game options draw no background over the race; the front end keeps it", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  const view = new MenuController({ cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages }).getView();
  for (const state of ["OPTIONS", "OPTIONS_AUDIO", "OPTIONS_GAME", "OPTIONS_DISPLAY", "OPTIONS_CONTROLS",
    "OPTIONS_CREDITS"] as const) {
    const inGame = { ...view, state, inGameOptions: true };
    const scene = buildMenuScene(state, inGame, ctx)!;
    settle(scene, inGame);
    assert.equal(scene.overRace, true, state);
    const items = menuDrawItems(scene);
    assert.ok(!items.some(item => item.id === scene.screen.id), `${state}: no background item (no white CLEAR 0 fill)`);
    assert.ok(!items.some(item => item.fill && item.color[3] > 0 && item.rect.width >= 0.99 && item.rect.height >= 0.99),
      `${state}: nothing opaque covers the race`);
    if (state === "OPTIONS" || state === "OPTIONS_AUDIO" || state === "OPTIONS_DISPLAY") {
      assert.ok(items.some(item => item.id === "IN_GAME_DARK_STRIP" && item.fill), `${state}: dark strip`);
    }
    const menuScene = buildMenuScene(state, { ...view, state }, ctx)!;
    assert.ok(!menuScene.overRace, state);
    assert.ok(menuDrawItems(menuScene).some(item => item.id === menuScene.screen.id), `${state}: front-end background`);
    assert.ok(!menuDrawItems(menuScene).some(item => item.id === "IN_GAME_DARK_STRIP"), state);
  }
});

test("TRACK.UI hides UNLOCKTEXT so the best-times table shows; CTRLS.UI rows never overlap", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  const view = new MenuController({ cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages }).getView();

  const trackView = { ...view, state: "TRACK_SELECT" as const, trackSelectPage: "ITEM" as const };
  const track = buildMenuScene("TRACK_SELECT", trackView, ctx)!;
  settle(track, trackView);
  const trackItems = menuDrawItems(track);
  assert.ok(!trackItems.some(item => item.id === "UNLOCKTEXT"));
  const table = track.screen.getNodeRect("HSC_TABLE_AREA")!;
  assert.ok(!trackItems.some(item => item.fill && item.color[3] > 0 && item.color[0] === 255 && overlaps(item.rect, table)),
    "no white box over the best-times table");
  for (const [id, text] of [["NAME_TITLE_TXT", "DRIVER"], ["CAR_TITLE_TXT", "VEHICLE"], ["TIME_TITLE_TXT", "TIME"]]) {
    const header = trackItems.find(item => item.id === id)!;
    assert.equal(header.text, text);
    assert.equal(header.textColor[3], 255, `${id} fades in (TIME_LENGTH 0 = shown at once)`);
  }

  const ctrlsView = { ...view, state: "OPTIONS_CONTROLS" as const };
  const ctrls = buildMenuScene("OPTIONS_CONTROLS", ctrlsView, ctx)!;
  settle(ctrls, ctrlsView);
  const ctrlItems = menuDrawItems(ctrls);
  for (const id of ["DEVICE", "DEVICENUMBER", "VIBRATION", "VIBRATION_VALUE", "DEVICE_HIGHLIGHT_LEFT_ARROW"]) {
    assert.ok(!ctrlItems.some(item => item.id === id), `${id} hidden`);
  }
  for (const id of ["CONTROLTYPE", "CONTROLTYPENUMBER", "MAPPING", "SETTINGS"]) assert.ok(ctrlItems.some(item => item.id === id), id);
  const ctrlBar = ctrlItems.find(item => item.id === "MENUBAR")!;
  const ctrlMapping = ctrlItems.find(item => item.id === "MAPPING")!;
  assert.ok(ctrlBar && ctrlBar.rect.width > 0.8 && ctrlBar.rect.height < 0.08, `CTRLS MENUBAR should be horizontal: ${JSON.stringify(ctrlBar?.rect)}`);
  assert.ok(Math.abs(ctrlBar.rect.y - ctrlMapping.rect.y) < 1e-4, `CTRLS MENUBAR should track focused MAPPING row`);
  // No two labels share a line where their glyphs would collide.
  const texts = ctrlItems.filter(item => item.text && item.id !== "TITLE");
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!;
      const b = texts[j]!;
      const sameLine = Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height) - Math.max(a.rect.y, b.rect.y)
        > Math.min(a.rect.height, b.rect.height) / 2;
      if (!sameLine) continue;
      const [a0, a1] = textSpan(assets, a);
      const [b0, b1] = textSpan(assets, b);
      assert.ok(a1 <= b0 || b1 <= a0, `${a.id} "${a.text}" overlaps ${b.id} "${b.text}"`);
    }
  }
  assert.deepEqual(ctrlItems.find(item => item.id === "SETTINGS")!.textColor.slice(0, 3), [155, 155, 155], "SETTINGS dimmed");
  assert.equal(ctrls.screen.getFocusedId(), "MAPPING");
});

test("RCRES shows the finishing position first, then the results list, without stacking rows", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  const view = new MenuController({ cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages }).getView();
  const standings = buildRaceResultRows(Array.from({ length: 6 }, (_, i) => ({
    carId: `C${i}`, progress: 2, totalRaceTime: 100 + i, bestLapTime: 50, finishTime: 100 + i,
  })), 2, id => `Car ${id}`);
  const resultsView = { ...view, state: "RESULTS" as const, standings };
  const scene = buildMenuScene("RESULTS", resultsView, {
    ...ctx, resultsMode: () => "RACING", resultsPlayerIndex: () => 5,
  })!;
  settle(scene, resultsView);
  const rect = (id: string) => drawn(scene, id)?.rect;
  // Intro (ui_rcres.c 0x4bf1b0): mode title + "6TH", list hidden.
  assert.equal(drawn(scene, "BUTTON1")?.text, "6TH");
  assert.ok(!scene.screen.getDrawItems().some(item => item.id === "LISTBOXBKG" || item.listRow));
  assert.ok(Math.abs(rect("MODETITLE")!.y - RCRES_LAYOUT.intro.modeTitleY) < 1e-6);
  assert.ok(Math.abs(rect("BUTTON1")!.y - RCRES_LAYOUT.intro.positionY) < 1e-6);
  const header = ["MODEICONBKG", "MODEICON", "REEF", "FLAGS"];
  const rows = () => ["MODETITLE", "BUTTON1", "LISTBOXBKG"].map(id => rect(id)).filter((r): r is UiRect => !!r);
  for (const row of rows()) for (const id of header) assert.ok(!overlaps(row, rect(id)!), `intro row vs ${id}`);
  assert.ok(!overlaps(rect("MODETITLE")!, rect("BUTTON1")!));

  // The first confirm (or click on the position) opens the list instead of leaving the screen.
  const first = scene.filterInput!({ ...idleInput, confirm: true });
  assert.equal(first.confirm, false);
  settle(scene, resultsView);
  assert.ok(Math.abs(rect("MODETITLE")!.y - RCRES_LAYOUT.list.modeTitleY) < 1e-6);
  assert.ok(Math.abs(rect("BUTTON1")!.y - RCRES_LAYOUT.list.positionY) < 1e-6);
  const list = rect("LISTBOXBKG")!;
  assert.ok(Math.abs(list.y - RCRES_LAYOUT.list.listY) < 1e-6 && list.width > 0.99);
  const [title, position] = rows();
  assert.ok(!overlaps(title!, position!) && !overlaps(position!, list) && !overlaps(title!, list), "rows stack cleanly");
  for (const row of rows()) for (const id of header) assert.ok(!overlaps(row, rect(id)!), `list row vs ${id}`);
  const listRows = scene.screen.getDrawItems().filter(item => item.listRow);
  assert.equal(listRows.filter(item => item.listRow!.listId === "LISTBOX1").length, 6);
  for (const row of listRows) assert.ok(row.rect.y >= list.y - 1e-9 && row.rect.y + row.rect.height <= list.y + list.height + 1e-9);
  // The second confirm passes through to MenuController ("continue" to RCEND).
  assert.equal(scene.filterInput!({ ...idleInput, confirm: true }).confirm, true);
});

test("value arrows sit on the focused value, replace the bar icon and clear AUDIO knobs", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  const view = new MenuController({ cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages }).getView();
  const icons = ["MENUBAR_ICON", "MENUBAR_ICON2", "MENUBAR_PULSE", "MENUBAR_PULSE2"];
  const barIcons = (scene: AppMenuScene, bar: string) => scene.screen.getDrawItems().filter(item => icons.includes(item.id)
    && overlaps(item.rect, scene.screen.getNodeRect(bar)!));
  const check = (state: MenuState, focus: string, value: string, bar = "MENUBAR", extra: Partial<MenuView> = {}) => {
    const v = { ...view, ...extra, state };
    const scene = buildMenuScene(state, v, ctx)!;
    scene.screen.setFocus(focus);
    settle(scene, v);
    const left = drawn(scene, "LEFTARROW")!.rect;
    const right = drawn(scene, "RIGHTARROW")!.rect;
    const target = scene.screen.getNodeRect(value)!;
    assert.ok(Math.abs(centreY(left) - centreY(target)) < 1e-6, `${state} ${focus}: left arrow on the row`);
    assert.ok(Math.abs(centreY(right) - centreY(target)) < 1e-6, `${state} ${focus}: right arrow on the row`);
    assert.equal(barIcons(scene, bar).length, 0, `${state} ${focus}: arrows replace the bar's icon/pulse`);
    return { scene, left, right };
  };

  // GMOPT: LEFTARROW/RIGHTARROW are MOVINGWINDOW children (y −0.142); they still land on the value rows.
  for (const [row, value] of [["SAVE", "SAVENUMBER"], ["GEARS", "GEARSNUMBER"]] as const) {
    const { scene, left, right } = check("OPTIONS_GAME", row, value, "MOVINGWINDOW/MENUBAR");
    const [x0, x1] = textSpan(assets, drawn(scene, value)!);
    assert.ok(left.x + left.width <= x0 && right.x >= x1, `GMOPT ${row}: arrows bracket the value`);
    assert.ok(Math.abs(left.x + left.width - (x0 - 5 / 640)) < 1e-6, "5 px gap (fr3 0x4a3360)");
  }
  check("RACE_OPTIONS", "LAPS", "LAPSNUMBER");
  check("OPTIONS_DISPLAY", "SPEEDO", "SPEEDONUMBER");

  // AUDIO: arrows bracket the bar and its knob at both ends of travel; the knob is never covered.
  for (const level of [0, 1]) {
    const settings = { ...view.settings, engineVolume: level };
    // The knob (11×20) spans the 9-px bar vertically, so the arrows centre on it.
    const { scene, left, right } = check("OPTIONS_AUDIO", "ENGINE", "ENGINE_SLIDER_BUTTON", "MENUBAR", { settings });
    const knob = drawn(scene, "ENGINE_SLIDER_BUTTON")!.rect;
    assert.ok(!overlaps(left, knob) && !overlaps(right, knob), `knob at ${level} stays clear`);
    assert.ok(!scene.screen.getDrawItems().some(item => /NUMBER$/.test(item.id) && item.text), "no digits over the bars");
    const label = drawn(scene, "ENGINE")!;
    assert.ok(left.x >= textSpan(assets, label)[1], "left arrow clears the row label");
  }

  // A row without a value (LET'S RACE!!!) shows the bar's icon again and hides the arrows.
  const ropt = buildMenuScene("RACE_OPTIONS", { ...view, state: "RACE_OPTIONS" }, ctx)!;
  ropt.screen.setFocus("RACE");
  settle(ropt, { ...view, state: "RACE_OPTIONS" });
  assert.ok(!drawn(ropt, "LEFTARROW") && !drawn(ropt, "RIGHTARROW"));
  assert.ok(barIcons(ropt, "MENUBAR").some(item => item.id === "MENUBAR_ICON2"));
});

test("LANG focus bar, disabled-row dimming and the clickable BACK prompt", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  const view = new MenuController({ cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages }).getView();

  // LANG.UI: ui_lang.c runs the generic selection bar on focus, so MENUBAR (RES_BOT + PCEnter) follows it.
  const langView = { ...view, state: "OPTIONS_LANGUAGE" as const };
  const lang = buildMenuScene("OPTIONS_LANGUAGE", langView, ctx)!;
  settle(lang, langView);
  for (const target of ["BUTTON1", "BUTTON2", "BUTTON3"]) {
    if (lang.screen.getFocusedId() !== target) lang.screen.moveFocus("down");
    lang.screen.update(1 / 30);
    assert.equal(lang.screen.getFocusedId(), target);
    const bar = lang.screen.getNodeRect("MENUBAR")!;
    const row = lang.screen.getNodeRect(target)!;
    assert.deepEqual([bar.x, bar.y], [row.x, row.y], `bar on ${target}`);
    assert.equal(drawn(lang, "MENUBAR_ICON")?.textureRef?.entryName, "pcenter");
  }

  // Disabled rows use RCEND's VIEW REPLAY grey; enabled rows keep their colours.
  const grey = [155, 155, 155];
  const gamef = buildMenuScene("MAIN_MENU", { ...view, state: "MAIN_MENU" }, ctx)!;
  settle(gamef, { ...view, state: "MAIN_MENU" });
  const gamefItems = menuDrawItems(gamef);
  assert.deepEqual(gamefItems.find(item => item.id === "BUTTON3")!.textColor.slice(0, 3), grey, "MULTIPLAYER");
  assert.notDeepEqual(gamefItems.find(item => item.id === "BUTTON2")!.textColor.slice(0, 3), grey);
  const disp = buildMenuScene("OPTIONS_DISPLAY", { ...view, state: "OPTIONS_DISPLAY" }, ctx)!;
  settle(disp, { ...view, state: "OPTIONS_DISPLAY" });
  const dispItems = menuDrawItems(disp);
  for (const id of ["SCREEN", "SCREENNUMBER", "POSSCREEN"]) {
    assert.deepEqual(dispItems.find(item => item.id === id)!.textColor.slice(0, 3), grey, id);
  }
  assert.notDeepEqual(dispItems.find(item => item.id === "TRACKMAPNUMBER")!.textColor.slice(0, 3), grey);

  // BACK: clicking the PCEscape icon or the BACK text acts as Esc; clicks on buttons are untouched.
  let scene: AppMenuScene | undefined;
  const menu = new MenuController({
    cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages,
    storage: { getItem: () => null, setItem: () => undefined },
    createScene: (state, v) => (scene = buildMenuScene(state, v, ctx)),
  });
  menu.continueFromStart();
  assert.ok(menu.activate("options"));
  assert.ok(menu.activate("options-audio"));
  for (let i = 0; i < 30; i++) menu.update(1 / 30, { driving: noDriving, menu: idleInput });
  for (const id of ["BACK_ICON", "BACK_TEXT"]) {
    const target = drawn(scene!, id)!.rect;
    const click = { ...idleInput, pointerClicked: true, pointerX: target.x + target.width / 2,
      pointerY: target.y + target.height / 2 };
    assert.deepEqual(scene!.filterInput!(click), { ...click, pointerClicked: false, back: true }, id);
  }
  const engine = scene!.screen.getNodeRect("ENGINE")!;
  const onButton = { ...idleInput, pointerClicked: true, pointerX: Math.max(0.01, engine.x + engine.width - 0.05),
    pointerY: engine.y + engine.height / 2 };
  assert.deepEqual(scene!.filterInput!(onButton), onButton, "button clicks pass through");
  const icon = drawn(scene!, "BACK_ICON")!.rect;
  menu.update(1 / 60, { driving: noDriving, menu: scene!.filterInput!({ ...idleInput, pointerClicked: true,
    pointerX: icon.x + icon.width / 2, pointerY: icon.y + icon.height / 2 }) });
  assert.equal(menu.getView().state, "OPTIONS", "clicking BACK leaves AUDIO");
});

test("HUD wiring follows fr3.exe: countdown chain, launch banner, wrong way, boost and camera groups", () => {
  assert.equal(raceCountdownTime("INTRO", 1), undefined);
  assert.equal(raceCountdownTime("COUNTDOWN", 1.2), 1.2);
  assert.ok(Math.abs(raceCountdownTime("RACING", 0.3)! - (COUNTDOWN_RACE_START_TIME + 0.3)) < 1e-9);
  assert.equal(raceCountdownTime("RACING", COUNTDOWN_DURATION), undefined);
  assert.deepEqual([0, 1, 2, 3].map(countdownStepSound), [3, 2, 1, "GO"]);

  assert.equal(classifyLaunch(900, 7000), undefined);
  assert.equal(classifyLaunch(2500, 7000), "short");
  assert.equal(classifyLaunch(4000, 7000), "good");
  assert.equal(classifyLaunch(5500, 7000), "super");
  assert.equal(classifyLaunch(6900, 7000), "over");

  assert.equal(isHudWrongWay(2, 6, [0, 0, 1], [0, 0, -1]), true);
  assert.equal(isHudWrongWay(2, 6, [0, 0, 1], [0.3, 0, 1]), false);
  assert.equal(isHudWrongWay(40, 6, [0, 0, 1], [0, 0, -1]), false, "far off the corridor");

  assert.deepEqual(pickSpread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3), [2, 6, 9]);
  assert.deepEqual(pickSpread([1, 2], 5), [1, 2]);

  const base: RaceHudSource = {
    speedMps: 30, rpm: 5000, maxRpm: 6500, gear: 3, units: "MPH", approxTopSpeedMph: 140,
    cameraMode: "CHASE_FAR", forwardCameraMode: "CHASE_FAR", position: 2, participants: 6, lap: 1, laps: 3,
    currentLapSeconds: 12.34, lastLapSeconds: 61.2, bestLapSeconds: 60.5, mode: "RACING", boostActive: false,
    boostTimer: 0, boostCharges: 2, wrongWay: true, phase: "COUNTDOWN", phaseElapsed: 0.5,
    launchBanner: { result: "super", time: 0.5 }, mapEnabled: false,
    course: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }], cars: [], labels: { POSITION: "POSITION" },
  };
  const racing = buildRaceHudInput(base);
  assert.equal(racing.boost, undefined, "no boost bar in RACING");
  assert.equal(racing.countdownTime, 0.5);
  assert.equal(racing.maxRpm, 6500);
  assert.equal(racing.map?.enabled, false);
  assert.ok(!("totalTime" in racing));
  const ops = buildHudDrawList(racing);
  assert.ok(ops.some(op => op.kind === "sprite" && op.key === "GENERIC/turnrnd"));
  assert.ok(ops.some(op => op.kind === "sprite" && op.key === "GENERIC/start3"));
  assert.ok(ops.some(op => op.kind === "sprite" && op.key === "PANEL/colpan"));
  assert.ok(ops.some(op => op.kind === "text" && op.text === "SUPER START!!!"));
  assert.ok(!ops.some(op => op.kind === "strip"), "TRACK MAP off hides the minimap");
  assert.deepEqual(ops.filter(op => op.kind === "text" && /^(LAP|LAST|BEST) /.test(op.text)).map(op => op.kind === "text" && op.text),
    ["LAP 00:12.34", "LAST 01:01.20", "BEST 01:00.50"]);

  const boost = buildRaceHudInput({ ...base, mode: "RACING_BOOST", boostActive: true, boostTimer: 3.5, boostCharges: 1 });
  assert.deepEqual(boost.boost, { active: true, elapsedFraction: 0.5, energy: 0, charges: 1 });
  assert.equal(buildRaceHudInput({ ...base, cameraMode: "INTRO" }).cameraGroup, "none");
  assert.equal(buildRaceHudInput({ ...base, cameraMode: "HOOD" }).cameraGroup, "bonnet");
  assert.equal(buildRaceHudInput({ ...base, cameraMode: "LOOK_BACK", forwardCameraMode: "HOOD" }).cameraGroup, "bonnet");
  assert.deepEqual(buildHudDrawList(buildRaceHudInput({ ...base, cameraMode: "INTRO" })), []);
});

test("the race HUD renders real GRAPHICS/HUD sprites from the atlas for both speed units", demoOptions, async () => {
  const { assets } = await frontEnd();
  const cfg = assets.installedCars.find(c => c.car.id === "FORD_GT")!;
  assert.ok((cfg.engine.fields.MAX_RPM ?? 0) > 0 && (cfg.car.fields.CAR_APPROXIMATE_TOP_SPEED ?? 0) > 0);
  const ratings = computeCarRatings(cfg);
  const speed = cfg.car.performance.find(p => p.type === "SPEED")!.value;
  assert.equal(ratings.speed, speed);
  assert.deepEqual(hudLabels(assets.translation).POSITION, "POSITION");
  for (const units of ["MPH", "KPH"] as const) {
    const atlas = await assets.loadHudAtlas(units);
    const input = buildRaceHudInput({
      speedMps: 40, rpm: 5200, maxRpm: cfg.engine.fields.MAX_RPM!, gear: 4, units,
      approxTopSpeedMph: cfg.car.fields.CAR_APPROXIMATE_TOP_SPEED!, cameraMode: "HOOD", forwardCameraMode: "HOOD",
      position: 1, participants: 6, lap: 2, laps: 3, currentLapSeconds: 30, mode: "RACING_BOOST",
      boostActive: false, boostTimer: 0, boostCharges: 2, wrongWay: false, phase: "RACING", phaseElapsed: 20,
      mapEnabled: true, course: assets.tables.racingLine.points.map(p => ({ x: p.position[0], z: p.position[2] })),
      cars: [{ id: "player", x: 0, z: 0, local: true, active: true }, { id: "ai", x: 5, z: 5, active: true }],
      labels: hudLabels(assets.translation),
    });
    const ops = buildHudDrawList(input);
    for (const op of ops) {
      if ("key" in op) assert.ok(atlas.sprites.has(op.key), `${units} ${op.key}`);
    }
    assert.ok(ops.some(op => op.kind === "sprite" && op.key.startsWith(units === "MPH" ? "MPH/" : "KPH/")));
    assert.ok(ops.some(op => op.kind === "sprite" && op.key === "PANEL/boostbit"));
    const batch = buildHudBatch(input, 960, 720, { body: assets.fonts[2]! }, { atlas });
    const textured = new Set(batch.commands.map(command => command.texture));
    for (const key of ["REV/revb", "REV/needle", "PANEL/panpos", "MISC/MAP_TRACK", "MISC/MAP_DOT", "NUMBERS/4"]) {
      assert.ok(textured.has(atlas.sprites.get(key)!), `${units} draws ${key}`);
    }
  }
});

// ─── FordRacing3App async guards (prototype harness: the private methods run against stub GL / assets) ─────

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

/** A FordRacing3App without a canvas: fields the async paths read, with recording GL/UI/audio stubs. */
function appHarness(fields: Record<string, unknown> = {}) {
  const app = Object.create(FordRacing3App.prototype) as Record<string, any>;
  const calls = { compiled: 0, preloaded: [] as unknown[], released: [] as unknown[], statuses: [] as string[], errors: [] as Error[] };
  Object.assign(app, {
    options: { onStatus: (status: string) => calls.statuses.push(status), onError: (error: Error) => calls.errors.push(error) },
    status: "", disposed: false,
    gl: { gl: { isContextLost: () => false, drawingBufferWidth: 1280, drawingBufferHeight: 720 } },
    compiledModels: new Map(), pendingModels: new Map(), carConfigs: new Map(),
    trackModelCache: new Map(), trackSpatialCache: new Map(),
    turntableRequest: 0, turntableKey: "", turntableAngle: 0, loadRequestSeq: 0,
    hudAtlasRequestSeq: 0, hudAtlasErrorReported: false,
    pendingUiTextures: new Set(), uiTextureFailures: new Map(), uploadedScreenTextures: new Set(),
    sharedAudioLoaded: true, loadedEngineBankKey: "", engineBankRequestSeq: 0,
    scene: {
      compileModel: () => {
        calls.compiled++;
        return { id: calls.compiled, isDisposed: false, dispose() {} };
      },
    },
    ui: {
      preloadTextures: (sources: Iterable<unknown>) => calls.preloaded.push(...sources),
      releaseTexture: (source: unknown) => calls.released.push(source),
    },
    audio: { update() {}, resume: async () => false, playMenu() {} },
    ...fields,
  });
  return { app, calls };
}

test("getOrCompileModel shares one in-flight compile per key and never compiles after dispose", async () => {
  const bundle = deferred<unknown>();
  let bundleLoads = 0;
  const { app, calls } = appHarness({
    assets: { load3dBundle: () => { bundleLoads++; return bundle.promise; } },
  });
  const first = app.getOrCompileModel("3DDATA/CARS/A", "red");
  const second = app.getOrCompileModel("3ddata/cars/a", "RED");
  assert.equal(app.pendingModels.size, 1);
  bundle.resolve({ xbx: {}, textures: {}, binInfo: {}, scene: {} });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, "concurrent callers get the same compiled model");
  assert.equal(calls.compiled, 1, "one GPU compile");
  assert.equal(app.pendingModels.size, 0, "the in-flight entry is cleaned up");
  assert.equal(await app.getOrCompileModel("3DDATA/CARS/A", "red"), a, "later calls hit the cache");
  assert.ok(bundleLoads >= 1);

  // Disposed (or context lost) while the bundle loads: nothing is compiled and the pending entry clears.
  const late = deferred<unknown>();
  app.assets = { load3dBundle: () => late.promise };
  const cancelled = app.getOrCompileModel("3DDATA/CARS/B");
  app.disposed = true;
  late.resolve({ xbx: {}, textures: {}, binInfo: {}, scene: {} });
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(calls.compiled, 1);
  assert.equal(app.pendingModels.size, 0);
});

test("turntable A -> B -> A invalidates the in-flight B request, so A stays on the turntable", async () => {
  const bundles = new Map<string, Deferred<unknown>>();
  const cfg = (id: string) => ({ shapeFolder: `3DDATA/CARS/${id}`, car: { id, liveries: [], fields: {} } });
  const { app } = appHarness({
    assets: {
      translation: { entries: new Map() },
      load3dBundle: (dir: string) => {
        if (!bundles.has(dir)) bundles.set(dir, deferred());
        return bundles.get(dir)!.promise;
      },
    },
    carConfigs: new Map([["A", cfg("A")], ["B", cfg("B")]]),
  });
  const empty = { xbx: {}, textures: { textures: [] }, binInfo: {}, scene: {} };
  const loadA = app.loadTurntableCar("A");
  bundles.get("3DDATA/CARS/A")!.resolve(empty);
  await loadA;
  const modelA = app.turntableModel;
  assert.ok(modelA);
  assert.equal(app.turntableKey, "3DDATA/CARS/A::");

  const loadB = app.loadTurntableCar("B"); // in flight
  await app.loadTurntableCar("A"); // back to A: the fast path, but it must still supersede B
  bundles.get("3DDATA/CARS/B")!.resolve(empty);
  await loadB;
  assert.equal(app.turntableModel, modelA, "the stale B load never replaces A");
  assert.equal(app.turntableKey, "3DDATA/CARS/A::");
});

test("HUD atlas: MPH -> KPH -> MPH never attaches the stale KPH atlas, and swaps free only dial sprites", async () => {
  const shared = { id: "GENERIC/needle" };
  const atlas = (units: "MPH" | "KPH") => ({
    units, numerals: {},
    sprites: new Map<string, unknown>([["GENERIC/needle", shared], [`${units}/dial`, { id: `${units}/dial` }]]),
  });
  const mph = atlas("MPH");
  const kph = atlas("KPH");
  const pending = { MPH: deferred<unknown>(), KPH: deferred<unknown>() };
  let units: "MPH" | "KPH" = "MPH";
  const race: Record<string, unknown> = { hudAtlas: mph };
  const { app, calls } = appHarness({
    assets: { loadHudAtlas: (u: "MPH" | "KPH") => pending[u].promise },
    menu: { getView: () => ({ settings: { speedUnits: units } }) },
    activeRace: race,
    uploadedHudAtlas: mph,
  });
  units = "KPH";
  const toKph = app.ensureHudAtlas(race, "KPH");
  units = "MPH";
  const backToMph = app.ensureHudAtlas(race, "MPH"); // already attached, still bumps the sequence
  await backToMph;
  pending.KPH.resolve(kph);
  await toKph;
  assert.equal(race.hudAtlas, mph, "the slow KPH request is stale");
  assert.equal(calls.preloaded.length, 0, "nothing uploaded for the stale atlas");

  // A current switch uploads KPH and releases only the MPH dial (the shared sprite stays on the GPU).
  units = "KPH";
  const current = app.ensureHudAtlas(race, "KPH");
  await current;
  assert.equal(race.hudAtlas, kph);
  assert.deepEqual(calls.released, [mph.sprites.get("MPH/dial")]);
  assert.ok(calls.preloaded.includes(shared) && calls.preloaded.includes(kph.sprites.get("KPH/dial")));

  // A request whose units no longer match the settings (or after dispose) never attaches.
  pending.MPH.resolve(mph);
  units = "KPH";
  await app.ensureHudAtlas(race, "MPH");
  assert.equal(race.hudAtlas, kph);
  units = "MPH";
  app.disposed = true;
  await app.ensureHudAtlas(race, "MPH");
  assert.equal(race.hudAtlas, kph);
});

test("lazy UI textures retry a bounded number of times and skip big uploads once their screen closed", async () => {
  let fetches = 0;
  let mode: "fail" | "large" | "small" = "fail";
  const large = { storedWidth: 2048, storedHeight: 1024 };
  const small = { storedWidth: 64, storedHeight: 64 };
  const screenA = { getPendingTextureRefs: () => [{ registeredKey: "graphics/game/a.psd" }], getTextureRefs: () => [] };
  const screenB = { getTextureRefs: () => [] };
  const menu = { screen: screenA as unknown };
  let release: () => void = () => undefined;
  const { app, calls } = appHarness({
    menu,
    assets: {
      getPcgEntry: () => {
        fetches++;
        if (mode === "fail") return Promise.reject(new Error("decode failed"));
        return new Promise(resolve => { release = () => resolve(mode === "large" ? large : small); });
      },
    },
  });
  // Visible-but-unsized refs (AUTOSIZE nodes) are requested, not only refs a draw found missing.
  for (let attempt = 0; attempt < LAZY_UI_TEXTURE_RETRIES + 3; attempt++) {
    app.requestPendingScreenTextures(screenA);
    await flush();
  }
  assert.equal(fetches, LAZY_UI_TEXTURE_RETRIES + 1, "one try plus the bounded retries, then parked");
  assert.ok(app.pendingUiTextures.has("graphics/game/a.psd"));

  // A large texture that resolves after the screen changed is not uploaded (the next screen preloads its own).
  mode = "large";
  app.requestUiTexture("graphics/game/big.psd");
  menu.screen = screenB;
  release();
  await flush();
  assert.equal(calls.preloaded.length, 0);
  assert.equal(app.uploadedScreenTextures.size, 0);
  assert.equal(app.pendingUiTextures.has("graphics/game/big.psd"), false);

  // On the screen that asked, it uploads and joins that screen's large set (released on the next change).
  menu.screen = screenA;
  app.requestUiTexture("graphics/game/big2.psd");
  release();
  await flush();
  assert.deepEqual(calls.preloaded, [large]);
  assert.ok(app.uploadedScreenTextures.has(large));

  // Small textures upload regardless; nothing uploads after dispose.
  mode = "small";
  app.requestUiTexture("graphics/game/small.psd");
  app.disposed = true;
  release();
  await flush();
  assert.deepEqual(calls.preloaded, [large]);
});

test("Esc on LOADING cancels the in-flight race load: no failLoad, error or status from the stale request", async () => {
  const track = deferred<unknown>();
  const menuCalls: string[] = [];
  const { app, calls } = appHarness({
    assets: {
      defaultTrackId: "T1", tables: { tracks: new Map() }, translation: { entries: new Map() },
      load3dBundle: () => track.promise, loadTrackData: () => new Promise(() => undefined),
      loadHudAtlas: () => Promise.resolve(undefined),
    },
    menu: {
      getView: () => ({ settings: { speedUnits: "MPH" } }),
      setLoadProgress: () => true,
      completeLoad: () => { menuCalls.push("complete"); return true; },
      failLoad: () => { menuCalls.push("fail"); return true; },
    },
  });
  const setup = { trackId: "T1", carId: "c", laps: 1, difficulty: "EASY", mode: "RACING", transmission: "AUTO" };
  // A load that fails after Esc reports nothing.
  const failing = app.loadRace(1, setup);
  app.handleCommand({ type: "QuitToMenu" });
  track.reject(new Error("network down"));
  await failing;
  assert.deepEqual(menuCalls, []);
  assert.equal(calls.errors.length, 0);
  assert.ok(!calls.statuses.some(status => status.startsWith("Load failed")));
  assert.equal(app.activeRace, undefined);

  // A current load that fails is reported.
  const again = deferred<unknown>();
  app.assets.load3dBundle = () => again.promise;
  const current = app.loadRace(2, setup);
  again.reject(new Error("network down"));
  await current;
  assert.deepEqual(menuCalls, ["fail"]);
  assert.equal(calls.errors.length, 1);

  // Same-turn track + HUD rejections report only the track error once and never consume hudAtlasErrorReported.
  const track3 = deferred<unknown>();
  const hud3 = deferred<unknown>();
  let failed3 = 0;
  app.assets.load3dBundle = () => track3.promise;
  app.assets.loadHudAtlas = () => hud3.promise;
  app.menu.acceptsLoad = (id: number) => id === 3 && failed3 === 0;
  app.menu.failLoad = (id: number) => {
    if (id !== 3 || failed3 > 0) return false;
    failed3++;
    return true;
  };
  const third = app.loadRace(3, setup);
  track3.reject(new Error("track broken"));
  hud3.reject(new Error("same-turn hud failure"));
  await third;
  await flush();
  assert.equal(failed3, 1);
  assert.equal(calls.errors.length, 2);
  assert.equal(calls.errors.at(-1)?.message, "track broken");
  assert.equal(app.hudAtlasErrorReported, false);

  // Late HUD rejection after track failure has already settled also stays silent.
  const track3b = deferred<unknown>();
  const hud3b = deferred<unknown>();
  let failed3b = 0;
  app.assets.load3dBundle = () => track3b.promise;
  app.assets.loadHudAtlas = () => hud3b.promise;
  app.menu.acceptsLoad = (id: number) => id === 31 && failed3b === 0;
  app.menu.failLoad = (id: number) => {
    if (id !== 31 || failed3b > 0) return false;
    failed3b++;
    return true;
  };
  const thirdB = app.loadRace(31, setup);
  track3b.reject(new Error("track broken later"));
  await thirdB;
  hud3b.reject(new Error("late hud failure"));
  await flush();
  assert.equal(failed3b, 1);
  assert.equal(calls.errors.length, 3);
  assert.equal(app.hudAtlasErrorReported, false);

  // Changing speedUnits or leaving LOADING (menu-only cancel) silences a HUD atlas rejection too.
  let units4: "MPH" | "KPH" = "MPH";
  let accepts4 = true;
  const track4 = deferred<unknown>();
  const hud4 = deferred<unknown>();
  app.assets.load3dBundle = () => track4.promise;
  app.assets.loadHudAtlas = () => hud4.promise;
  app.menu.getView = () => ({ state: accepts4 ? "LOADING" : "MAIN_MENU", settings: { speedUnits: units4 } });
  app.menu.acceptsLoad = (id: number) => id === 4 && accepts4;
  app.menu.failLoad = (id: number) => id === 4 && accepts4;
  const fourth = app.loadRace(4, setup);
  units4 = "KPH";
  hud4.reject(new Error("obsolete units hud fail"));
  await flush();
  assert.equal(calls.errors.length, 3);
  assert.equal(app.hudAtlasErrorReported, false);
  accepts4 = false;
  track4.reject(new Error("menu already moved on"));
  await fourth;
  assert.equal(calls.errors.length, 3);
  assert.equal(app.hudAtlasErrorReported, false);

  // Menu-only cancel (acceptsLoad becomes false without QuitToMenu) also silences pending HUD + track rejections.
  let accepts5 = true;
  const track5 = deferred<unknown>();
  const hud5 = deferred<unknown>();
  app.assets.load3dBundle = () => track5.promise;
  app.assets.loadHudAtlas = () => hud5.promise;
  app.menu.getView = () => ({ state: accepts5 ? "LOADING" : "MAIN_MENU", settings: { speedUnits: "MPH" } });
  app.menu.acceptsLoad = (id: number) => id === 5 && accepts5;
  app.menu.failLoad = (id: number) => id === 5 && accepts5;
  const fifth = app.loadRace(5, setup);
  accepts5 = false;
  hud5.reject(new Error("menu-only canceled hud fail"));
  track5.reject(new Error("menu-only canceled track fail"));
  await fifth;
  await flush();
  assert.equal(calls.errors.length, 3);
  assert.equal(app.hudAtlasErrorReported, false);
});

test("HUD upload failure after completeLoad reports once and still finishes starting race audio and status", demoOptions, async () => {
  const { assets, cars, tracks } = await frontEnd();
  const menu = new MenuController({ cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages });
  const { app, calls } = appHarness({ assets, menu, carConfigs: new Map(assets.installedCars.map(cfg => [cfg.car.id, cfg])) });
  let sharedAudioLoads = 0;
  let engineAudioLoads = 0;
  app.loadSharedAudioOnce = async () => { sharedAudioLoads++; };
  app.loadEngineBankForCar = async () => { engineAudioLoads++; };
  app.ui.preloadTextures = () => { throw new Error("texImage2D OOM"); };

  press(menu, "anyKey");
  menu.updateRaceOptions({ opponents: 0 });
  menu.activate("select-car");
  menu.activate("launch");
  const launch = menu.drainCommands().find(command => command.type === "LaunchRaceRequest");
  assert.ok(launch && launch.type === "LaunchRaceRequest");

  await app.loadRace(launch.requestId, launch.setup);
  assert.equal(menu.getView().state, "IN_GAME");
  assert.ok(app.activeRace, "race stays active without the HUD atlas");
  assert.equal(app.activeRace.hudAtlas, undefined);
  assert.equal(sharedAudioLoads, 1, "shared audio still initializes");
  assert.equal(engineAudioLoads, 1, "engine audio bank still initializes");
  assert.ok(calls.statuses.at(-1)?.startsWith("Racing"), `status updated instead of staying Loading (${calls.statuses.at(-1)})`);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0]?.message, "texImage2D OOM");
  assert.equal(app.hudAtlasErrorReported, true);
});

test("standard RACING drops player boost and CATCH UP OFF turns off AI catch-up", () => {
  const driving = { ...noDriving, throttle: 1, boost: true };
  assert.equal(playerDrivingInput("RACING", driving).boost, false);
  assert.equal(playerDrivingInput("RACING", driving).throttle, 1);
  assert.equal(playerDrivingInput("RACING_BOOST", driving).boost, true);
  assert.equal(playerDrivingInput("RACING_BOOST", driving), driving);

  assert.equal(aiReferenceGap({ catchUp: false }, -300), undefined);
  assert.equal(aiReferenceGap({ catchUp: true }, -300), -300);
  assert.equal(aiReferenceGap({}, 25), 25, "quick races (unset) keep catch-up");

  const points = Array.from({ length: 40 }, (_, i) => {
    const a = i * 2 * Math.PI / 40;
    return {
      position: [100 * (1 - Math.cos(a)), 0, 100 * Math.sin(a)] as [number, number, number],
      forward: [Math.sin(a), 0, Math.cos(a)] as [number, number, number],
      lateral: [Math.cos(a), 0, -Math.sin(a)] as [number, number, number],
      width: 16, offset: 0, curvatureRadius: 100,
    };
  });
  const line = {
    version: 1, creationDate: "", timestamp: 0, sceneName: "", tolerance: 0, reverse: false,
    length: 2 * Math.PI * 100, edgeModifier: 0, flyingLapStartInterpolant: 0, metadata: {}, points,
  };
  const difficulty = {
    DIFFICULTY_LINE_VARIATION: 0, DIFFICULTY_OVERTAKE_CLEARANCE: 0.75,
    CATCHUP_ADDITIONAL_START_POWER: 0, CATCHUP_SUBTRACTIVE_START_POWER: 0,
    CATCHUP_ADDITIONAL_POWER: 0.2, CATCHUP_SUBTRACTIVE_POWER: -0.25,
    CATCHUP_RANGE_AHEAD: 40, CATCHUP_RANGE_BEHIND: 80, CATCHUP_START_FADEOUT: 50, CATCHUP_STOP_FADEOUT: 100,
    CATCHUP_PACK_SPREAD: 8, CATCHUP_PACK_SHIFT: 0, CATCHUP_PACK_RATE_OF_CHANGE_PER_LAP: 0,
    CAR_BASE_DIFFICULTY_LEVEL: 0.6, CAR_DIFFICULTY_LEVEL_SPREAD: 0.2,
    AI_OVERTAKE_POWER_MODIFIER: 0, AI_DRAFTING_POWER_MODIFIER: 0, AI_RACELINE_POWER_BOOST: 0,
  };
  const power = (catchUp: boolean, gap: number, packSlot: number) => new AiDriver(line, { difficulty, packSlot })
    .update(0.1, {
      car: { position: [0, 0, 0], forward: [0, 0, 1], speed: 20 }, track: { u: 0, lateralOffset: 0 },
      referenceGap: aiReferenceGap({ catchUp }, gap),
    }).powerMultiplier;
  assert.ok(power(true, -300, 0) > 1.1, "catch-up on: a trailing AI gets extra power");
  assert.ok(power(true, 60, 0) < 1, "catch-up on: a leading AI is held back");
  for (const [gap, slot] of [[-300, 0], [60, 0], [0, 1], [0, -1]] as const) {
    assert.equal(power(false, gap, slot), 1, `catch-up off: gap ${gap}, pack slot ${slot}`);
  }
});

test("a race load finishing after Esc (or after the menu moved on) never becomes the active race", demoOptions, async () => {
  const { assets, cars, tracks } = await frontEnd();
  const run = async (cancel: "none" | "esc" | "menu-only") => {
    const menu = new MenuController({ cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages });
    const { app, calls } = appHarness({ assets, menu, carConfigs: new Map(assets.installedCars.map(cfg => [cfg.car.id, cfg])) });
    // Race audio = the player's engine bank (menu sounds from the Esc itself also resume the AudioContext).
    let audioResumes = 0;
    app.loadEngineBankForCar = async () => { audioResumes++; };
    press(menu, "anyKey");
    menu.updateRaceOptions({ opponents: 0 });
    menu.activate("select-car");
    menu.activate("launch");
    const launch = menu.drainCommands().find(command => command.type === "LaunchRaceRequest");
    assert.ok(launch && launch.type === "LaunchRaceRequest");
    const loading = app.loadRace(launch.requestId, launch.setup);
    if (cancel !== "none") {
      press(menu, "back"); // Esc on LOADING
      assert.equal(menu.getView().state, "MAIN_MENU");
      const commands = menu.drainCommands();
      assert.ok(commands.some(command => command.type === "QuitToMenu"));
      // "menu-only": the menu left LOADING but the app never saw QuitToMenu; completeLoad still rejects it.
      if (cancel === "esc") for (const command of commands) app.handleCommand(command);
    }
    await loading;
    return { app, menu, calls, audioResumes };
  };

  const done = await run("none");
  assert.ok(done.app.activeRace, "control: an uncancelled load starts the race");
  assert.equal(done.menu.getView().state, "IN_GAME");
  assert.ok(done.calls.statuses.at(-1)?.startsWith("Racing"));

  for (const cancel of ["esc", "menu-only"] as const) {
    const { app, menu, calls, audioResumes } = await run(cancel);
    assert.equal(app.activeRace, undefined, cancel);
    assert.equal(menu.getView().state, "MAIN_MENU", cancel);
    assert.equal(audioResumes, 0, `${cancel}: no race audio started`);
    assert.ok(!calls.statuses.some(status => status.startsWith("Racing")), cancel);
    assert.equal(calls.errors.length, 0, cancel);
  }
});

// ─── Pointer-only front end (scene.filterInput + MenuController, as FordRacing3App.stepMenu runs them) ─────

function pointerMenu(ctx: MenuSceneContext, cars: MenuCar[], tracks: MenuTrack[], trackId: string, languages: readonly string[]) {
  let current: AppMenuScene | undefined;
  const menu = new MenuController({
    cars, tracks, trackId, languages,
    createScene: (state, view) => (current = buildMenuScene(state, view, ctx)),
  });
  const scene = () => {
    assert.ok(current && current.screen === menu.screen, "a scene is open");
    return current;
  };
  const settle = () => {
    for (let i = 0; i < 90; i++) {
      menu.screen?.update(1 / 30);
      current?.tick?.(1 / 30, menu.getView());
    }
  };
  const click = (x: number, y: number) => {
    const open = current && current.screen === menu.screen ? current : undefined;
    let input = { ...idle, pointerX: x, pointerY: y, pointerClicked: true, pointerMoved: true };
    if (open?.filterInput) input = open.filterInput(input);
    menu.update(1 / 60, { driving: noDriving, menu: input });
    current?.tick?.(0, menu.getView());
  };
  // Centre of the on-screen part (rows are 1.0 wide and start off-screen or run past the right edge).
  const centre = (rect: UiRect) => {
    const left = Math.max(0, rect.x);
    const right = Math.min(1, rect.x + rect.width);
    return [(left + right) / 2, rect.y + rect.height / 2] as const;
  };
  const item = (id: string) => {
    const found = scene().screen.getDrawItems().find(entry => entry.id === id && !entry.listRow);
    assert.ok(found, `${id} is drawn`);
    return found;
  };
  const clickItem = (id: string) => click(...centre(item(id).rect));
  return { menu, scene, settle, click, clickItem, centre, item };
}

test("pointer-only players finish single-player setup: CAR, TRACK, ROPT arrows and RCRES's two-step prompt", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  const ui = pointerMenu(ctx, cars, tracks, assets.defaultTrackId, assets.languages);
  const { menu, click, clickItem, settle } = ui;
  click(0.5, 0.5);
  assert.equal(menu.getView().state, "MAIN_MENU");
  settle();
  clickItem("BUTTON2");
  assert.equal(menu.getView().state, "MODE_SELECT");
  settle();
  clickItem("BUTTON1");
  assert.equal(menu.getView().state, "CAR_SELECT");
  settle();

  // CAR.UI class page -> car page via a class button with liveries.
  const liveryCar = cars.find(car => car.liveries.length > 1)!;
  const groupIndex = menu.getView().carGroups.indexOf(liveryCar.group!);
  clickItem(`BUTTON${groupIndex + 1}`);
  assert.equal(menu.getView().carSelectPage, "ITEM");
  settle();
  const t = CAR_TURNTABLE_RECT;
  const first = menu.getView().car!.id;
  click(t.x + t.width * 0.75, t.y + t.height / 2);
  const second = menu.getView().car!.id;
  assert.notEqual(second, first, "right half of the turntable: next car");
  click(t.x + t.width * 0.25, t.y + t.height / 2);
  assert.equal(menu.getView().car!.id, first, "left half: previous car");
  // Find a car with several liveries in this class and change its livery with a click on the COLOUR prompt.
  for (let i = 0; i < 20 && (menu.getView().car?.liveries.length ?? 0) < 2; i++) click(t.x + t.width * 0.75, t.y + t.height / 2);
  assert.ok((menu.getView().car?.liveries.length ?? 0) > 1);
  settle();
  const livery = menu.getView().livery;
  assert.equal(drawItemAt(ui.scene().screen, ["COLOUR_TEXT"], ...ui.centre(ui.item("COLOUR_TEXT").rect), ctx.fonts), "COLOUR_TEXT");
  clickItem("COLOUR_TEXT");
  assert.notEqual(menu.getView().livery, livery, "COLOUR_TEXT changes the livery");
  clickItem("COLOUR_ICON");
  assert.equal(menu.getView().state, "CAR_SELECT");
  clickItem("CARNAME");
  assert.equal(menu.getView().state, "TRACK_SELECT", "the CARNAME bar continues");
  settle();

  // TRACK.UI roster page -> track page; body halves step the track; the TRACKNAME bar continues.
  clickItem("BUTTON1");
  assert.equal(menu.getView().trackSelectPage, "ITEM");
  settle();
  const r = TRACK_CYCLE_RECT;
  const trackBefore = menu.getView().track!.id;
  click(r.x + r.width * 0.75, r.y + r.height / 2);
  assert.notEqual(menu.getView().track!.id, trackBefore, "right half: next track");
  click(r.x + r.width * 0.25, r.y + r.height / 2);
  assert.equal(menu.getView().track!.id, trackBefore, "left half: previous track");
  clickItem("MENUBAR_ICON");
  assert.equal(menu.getView().state, "RACE_OPTIONS");
  settle();

  // ROPT: RIGHTARROW increments and LEFTARROW decrements the focused row (LEFTARROW lies inside LAPS' rect).
  assert.equal(menu.getView().raceOptions.laps, 3);
  clickItem("RIGHTARROW");
  assert.equal(menu.getView().raceOptions.laps, 4);
  clickItem("LEFTARROW");
  clickItem("LEFTARROW");
  assert.equal(menu.getView().raceOptions.laps, 2);
  // CATCH UP toggles from its own row arrows too.
  const catchUp = menu.getView().raceOptions.catchUp;
  clickItem("CATCH_UP_BUTTON");
  ui.settle();
  assert.notEqual(menu.getView().raceOptions.catchUp, catchUp);
  clickItem("RIGHTARROW");
  assert.equal(menu.getView().raceOptions.catchUp, catchUp);
  clickItem("RACE");
  assert.equal(menu.getView().state, "LOADING");
  const launch = menu.drainCommands().find(command => command.type === "LaunchRaceRequest");
  assert.ok(launch && launch.type === "LaunchRaceRequest");
  assert.equal(launch.setup.laps, 2);
  assert.ok(menu.completeLoad(launch.requestId));
  assert.ok(menu.finishRace([{ carId: "a", carName: "A", totalSeconds: 60, bestLapSeconds: 30, gapSeconds: 0 }]));
  settle();

  // RCRES: the PCEnter prompt takes Enter's two steps (reveal the list, then continue to RCEND).
  for (const id of ["MENUBAR_ICON", "MENUBAR"]) {
    if (menu.getView().state === "RACE_END") menu.activate("standings"); // a fresh RCRES for the second prompt
    assert.equal(menu.getView().state, "RESULTS");
    settle();
    clickItem(id);
    assert.equal(menu.getView().state, "RESULTS", `${id}: first click reveals the list`);
    assert.ok(ui.scene().screen.getDrawItems().some(entry => entry.id === "LISTBOXBKG"));
    settle();
    clickItem(id);
    assert.equal(menu.getView().state, "RACE_END", `${id}: second click continues`);
  }
});

test("AUDIO slider bars and DISP/GMOPT value arrows work with the pointer", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  const ui = pointerMenu(ctx, cars, tracks, assets.defaultTrackId, assets.languages);
  const { menu, click, clickItem, settle } = ui;
  click(0.5, 0.5);
  menu.activate("options");
  menu.activate("options-audio");
  settle();
  const bar = ui.scene().screen.getNodeRect("SPEECH_SLIDER_BAR_BKGND")!;
  const barWidth = 168 / 640; // VOLBAR_PX
  click(bar.x + barWidth * 0.3, bar.y + bar.height / 2);
  assert.equal(ui.scene().screen.getFocusedId(), "SPEECH", "the clicked slider's row takes focus");
  assert.equal(menu.getView().settings.speechVolume, 0.3);
  click(bar.x + barWidth * 0.95, bar.y + bar.height / 2);
  assert.equal(menu.getView().settings.speechVolume, 1);
  settle();
  clickItem("LEFTARROW");
  assert.equal(menu.getView().settings.speechVolume, 0.9, "AUDIO LEFTARROW steps the focused slider down");
  clickItem("RIGHTARROW");
  assert.equal(menu.getView().settings.speechVolume, 1);
  menu.activate("back");

  menu.activate("options-display");
  settle();
  const units = menu.getView().settings.speedUnits;
  clickItem("RIGHTARROW");
  assert.notEqual(menu.getView().settings.speedUnits, units);
  clickItem("LEFTARROW");
  assert.equal(menu.getView().settings.speedUnits, units);
  menu.activate("back");

  menu.activate("options-game");
  settle();
  const save = menu.getView().settings.autosave;
  clickItem("LEFTARROW");
  assert.notEqual(menu.getView().settings.autosave, save);
});

test("canceled/obsolete HUD atlas rejections report no error, A->B->A restores turntable status, and shared late large textures release", async () => {
  const kph = deferred<unknown>();
  const mphFail = deferred<unknown>();
  let units: "MPH" | "KPH" = "MPH";
  const race: { hudAtlas?: unknown } = { hudAtlas: { units: "MPH", sprites: new Map() } };
  const { app, calls } = appHarness({
    menu: { getView: () => ({ settings: { speedUnits: units } }), screen: undefined },
    assets: {
      loadHudAtlas: (u: "MPH" | "KPH") => (u === "KPH" ? kph.promise : mphFail.promise),
    },
    activeRace: race,
  });

  // Switch MPH -> KPH -> MPH, then reject the obsolete KPH request: must not fire onError or consume hudAtlasErrorReported.
  units = "KPH";
  const staleKph = app.ensureHudAtlas(race, "KPH");
  units = "MPH";
  await app.ensureHudAtlas(race, "MPH");
  kph.reject(new Error("obsolete kph fail"));
  await staleKph;
  assert.equal(calls.errors.length, 0);
  assert.equal(app.hudAtlasErrorReported, false);

  // A current failure still reports once.
  race.hudAtlas = undefined;
  const currentFail = app.ensureHudAtlas(race, "MPH");
  mphFail.reject(new Error("current mph fail"));
  await currentFail;
  assert.equal(calls.errors.length, 1);
  assert.equal(app.hudAtlasErrorReported, true);

  // Turntable A -> B -> A restores "Select Car: A" instead of leaving "Loading B".
  const carA = { car: { id: "CAR_A", fields: {}, liveries: [] }, shapeFolder: "3DDATA/CARS/A" };
  const carB = { car: { id: "CAR_B", fields: {}, liveries: [] }, shapeFolder: "3DDATA/CARS/B" };
  const pendingB = deferred<unknown>();
  const modelA = { isDisposed: false };
  const { app: ttApp, calls: ttCalls } = appHarness({
    carConfigs: new Map([["CAR_A", carA], ["CAR_B", carB]]),
    assets: {
      translation: { entries: new Map() },
      load3dBundle: (dir: string) => (dir === "3DDATA/CARS/A" ? Promise.resolve({}) : pendingB.promise),
    },
    scene: { compileModel: () => modelA },
  });
  await ttApp.loadTurntableCar("CAR_A");
  const loadB = ttApp.loadTurntableCar("CAR_B");
  assert.equal(ttCalls.statuses.at(-1), "Loading CAR B");
  await ttApp.loadTurntableCar("CAR_A");
  assert.equal(ttCalls.statuses.at(-1), "Select Car: CAR A");
  pendingB.resolve({});
  await loadB;
  assert.equal(ttApp.turntableModel, modelA);
  assert.equal(ttCalls.statuses.at(-1), "Select Car: CAR A");

  // Shared late large texture drawn on screen B joins uploadedScreenTextures and is released when leaving B.
  const sharedLarge = { storedWidth: 1920, storedHeight: 1080 };
  const sharedLoad = deferred<unknown>();
  const screenA = { getTextureRefs: () => [{ registeredKey: "graphics/game/common/shared.psd" }] };
  const screenB = { getTextureRefs: () => [{ registeredKey: "graphics/game/common/shared.psd" }] };
  const screenC = { getTextureRefs: () => [] };
  const texMenu = { screen: screenA as unknown };
  const { app: texApp, calls: texCalls } = appHarness({
    menu: texMenu,
    assets: {
      getPcgEntry: () => sharedLoad.promise,
      getLoadedUiTexture: () => sharedLarge,
    },
  });
  texApp.requestUiTexture("graphics/game/common/shared.psd");
  texMenu.screen = screenB;
  sharedLoad.resolve(sharedLarge);
  await flush();
  assert.ok(texApp.uploadedScreenTextures.has(sharedLarge), "shared late large texture tracked on screen B");
  assert.equal(texApp.resolveUiTexture("graphics/game/common/shared.psd"), sharedLarge);
  texApp.uploadScreenTextures(screenC);
  assert.deepEqual(texCalls.released, [sharedLarge]);
});

test("CRED.UI scrolls past the last wrapped credits entry before resetting", demoOptions, async () => {
  const { assets, ctx, cars, tracks } = await frontEnd();
  const view = new MenuController({ cars, tracks, trackId: assets.defaultTrackId, languages: assets.languages }).getView();
  const credView = { ...view, state: "OPTIONS_CREDITS" as const };
  const scene = buildMenuScene("OPTIONS_CREDITS", credView, ctx)!;
  const listTop = scene.screen.getNodeRect("LISTBOX")!.y;
  const rows = scene.screen.getDrawItems().filter(item => item.listRow?.listId === "LISTBOX");
  assert.ok(rows.length > 0);
  const lastIndex = rows.length - 1;
  let sawLastEntryVisible = false;
  for (let i = 0; i < 600; i++) {
    scene.tick?.(0.25, credView);
    scene.screen.update(0.25);
    const last = scene.screen.getDrawItems().find(item => item.listRow?.listId === "LISTBOX" && item.listRow.index === lastIndex);
    if (last && last.rect.y < 1 && last.rect.y + last.rect.height > 0) {
      sawLastEntryVisible = true;
      break;
    }
  }
  assert.ok(listTop >= 0);
  assert.equal(sawLastEntryVisible, true, "the final credits entry must scroll into the viewport before reset");
});
