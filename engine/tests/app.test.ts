import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { aiControlToDrivingInput, resolveTrackDifficultyScales } from "../src/app.js";
import { DemoAssets, demoTrackDirectory } from "../src/demoAssets.js";
import { AiDriver, trackProgressDelta } from "../src/game/aiDriver.js";
import { CameraController } from "../src/game/cameraController.js";
import { RaceManager, type RaceObservation } from "../src/game/raceManager.js";
import { InputManager } from "../src/input/inputManager.js";
import { mountNativeEngine } from "../src/main.js";
import { resolveCarCollision } from "../src/physics/collision.js";
import { TrackSpatial } from "../src/physics/trackSpatial.js";
import { VehiclePhysics } from "../src/physics/vehiclePhysics.js";
import { buildHudViewModel } from "../src/ui/hudModel.js";
import { MenuController } from "../src/ui/menuController.js";
import { UiScreenInstance } from "../src/ui/uiRuntime.js";
import { NodeVfs } from "../src/vfs/nodeVfs.js";

const demoRoot = "/home/omertekin2002/.cache/fr3/agent-demo/extracted/Program_Executable_Files";
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

test("local demo catalog loads vehicle, UI, language, environment and audio assets", demoOptions, async () => {
  const vfs = await NodeVfs.open(demoRoot);
  const assets = await DemoAssets.load(vfs);
  assert.equal(assets.installedCars.length, 25);
  assert.equal(new Set(assets.installedCars.map(car => car.shapeFolder)).size, 25);
  assert.equal(assets.tables.vehicles.cars.size, 55);
  assert.ok(assets.tables.tracks.has("engaf") && assets.tables.surfaces.size > 0);
  assert.ok(assets.tables.rules.has("racing_boost") && assets.tables.cameras.length > 0);
  assert.ok(assets.tables.engineSounds.size > 0 && assets.tables.volumes.size > 0);
  assert.deepEqual(assets.tables.fog, { density: 0.2, color: [186, 139, 84] });
  assert.deepEqual(assets.quickRaces.map(preset => preset.number), [5, 6, 4, 1, 2, 3]);
  assert.ok(assets.quickRaces.every(preset => preset.participants.length === 6 && preset.laps === 2));
  assert.equal(assets.fonts.length, 6);
  assert.ok(assets.fonts.every(atlas => atlas.glyphs.size === 134));
  assert.equal(assets.language, "EN");
  assert.equal(assets.translation.entries.size, 1648);
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
  assert.equal((await bank).entries.length, 17);
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
  }, { gear: 1, speedMps: 0.4 });
  assert.equal(forwardBrake.throttle, 0);
  assert.equal(forwardBrake.brake, 0.8);
  assert.equal(forwardBrake.handbrake, true);

  const backingOut = aiControlToDrivingInput({
    throttle: 0.65, brake: 0, steer: -0.65, handbrake: false, boost: false, powerMultiplier: 1, driveDirection: -1,
  }, { gear: 1, speedMps: 0.1 });
  assert.equal(backingOut.throttle, 0);
  assert.equal(backingOut.brake, 0.65);
  assert.equal(backingOut.handbrake, false);
});
