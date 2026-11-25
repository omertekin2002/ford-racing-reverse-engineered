import assert from "node:assert/strict";
import test from "node:test";
import { parseTranslationTable } from "../src/formats/tlate";
import { InputManager, type MenuInput } from "../src/input/inputManager";
import { buildHudViewModel, formatRaceTime } from "../src/ui/hudModel";
import {
  MenuController, type MenuAction, type MenuControllerOptions, type RaceSetup,
} from "../src/ui/menuController";
import { UiScreenInstance } from "../src/ui/uiRuntime";

const button = (id: string, x: number, y: number) => `
  :TYPE UI_TYPE_BUTTON
  :OBJECT_ID ${id}
  :POSITION_START ${x} ${y}
  :POSITION_END ${x} ${y}
  :SIZE .125 .125
  :TEXT ${id}
`;

test("screen interpolates nested rectangles and delayed color, then reverses on exit", () => {
  const screen = new UiScreenInstance(`
    :TYPE UI_TYPE_SCREEN
    :OBJECT_ID internal
    :POSITION_START -.5 0
    :POSITION_END 0 0
    :SIZE_START .5 .5
    :SIZE_END 1 1
    :OFFSET_TIME .25
    :TIME_LENGTH .5
    :S{*****>>>
      :TYPE UI_TYPE_GRAPHIC
      :OBJECT_ID emblem
      :POSITION_START .5 .25
      :POSITION_END .5 .25
      :SIZE .5 .25
      :OFFSET_TIME .25
      :TIME_LENGTH .5
      :COLOUR_START 0 40 80 0
      :COLOUR_END 200 120 160 200
      :TEXTURE_ENUM Art\\Emblem.psd
      :FLIP_GRAPHIC 1 0
      :STRETCH_GRAPHIC 1
    :E}*****<<<
  `, {}, "screens/alias.ui");
  assert.equal(screen.id, "internal");
  assert.equal(screen.path, "screens/alias.ui");
  assert.equal(screen.isExitComplete(), false);
  screen.update(.125);
  assert.deepEqual(screen.getDrawItems()[0]?.rect, { x: -.25, y: .125, width: .25, height: .125 });
  screen.update(.375);

  const item = screen.getDrawItems()[0]!;
  assert.deepEqual(item.rect, { x: .125, y: .1875, width: .375, height: .1875 });
  assert.deepEqual(item.color, [100, 80, 120, 100]);
  assert.deepEqual(item.flip, [true, false]);
  assert.equal(item.stretch, true);
  assert.equal(item.textureRef?.pcgPath, "art/graphics.pcg");

  screen.startExit();
  screen.update(.25);
  assert.equal(screen.getDrawItems()[0]?.rect.x, -.25);
  assert.equal(screen.isExitComplete(), false);
  screen.update(.25);
  assert.equal(screen.isExitComplete(), true);
});

test("screen loads common templates and includes, resolves translations and accepts text overrides", () => {
  const common = `
    :TYPE UI_TYPE_TEXT
    :OBJECT_ID header
    :FONT 2
    :FONT_COLOUR 10 20 30 255
    :TEXT TITLE_KEY
    :TEXT_JUSTIFY 5
    :WORD_WRAP 1
    :JUSTIFY_OFFSET .125 .25
  `;
  const files = new Map([
    ["shared/header.ui", common],
    ["screens/lobby.ui", ":READ_SCRIPT_FILE screens/fragment.ui"],
    ["screens/fragment.ui", ":INHERIT header :OBJECT_ID heading"],
  ]);
  const translation = parseTranslationTable(Buffer.concat([
    Buffer.from([0xff, 0xfe]), Buffer.from("title_key Track~day|Welcome\r\n", "utf16le"),
  ]));
  const screen = UiScreenInstance.load("screens/lobby.ui", {
    readFile: name => files.get(name), commonPaths: ["shared/header.ui"], translation,
  });
  const item = screen.getDrawItems()[0]!;
  assert.equal(item.text, "Track~day|Welcome");
  assert.equal(item.font, 2);
  assert.equal(item.textJustify, 5);
  assert.equal(item.wordWrap, true);
  assert.deepEqual(item.justifyOffset, [.125, .25]);
  assert.deepEqual(item.textColor, [10, 20, 30, 255]);
  assert.equal(screen.setNodeTextRaw("HEADING", "TITLE_KEY"), true);
  assert.equal(screen.getDrawItems()[0]?.text, "TITLE_KEY");
  assert.equal(screen.setNodeText("heading", "title_key"), true);
  assert.equal(screen.getDrawItems()[0]?.text, "Track~day|Welcome");
  screen.setNodeTexture("heading", "icons/flag.psd");
  assert.equal(screen.getDrawItems()[0]?.textureRef?.entryName, "flag");
  screen.setNodeVisible("heading", false);
  assert.deepEqual(screen.getDrawItems(), []);
  assert.throws(() => UiScreenInstance.load("missing.ui", { readFile: name => files.get(name) }), /Missing UI script/);
});

test("screen follows linked focus past unavailable buttons and uses nearest fallback for missing links", () => {
  const screen = new UiScreenInstance(`
    ${button("a", 0, 0)}
    ${button("b", .25, 0)}
    ${button("c", .5, 0)}
    ${button("d", .5, .5)}
    :CONNECTION a none none none b
    :CONNECTION b none none none c
    :CONNECTION c none none none a
  `);
  assert.equal(screen.getFocusedId(), "a");
  screen.setNodeEnabled("b", false);
  assert.equal(screen.moveFocus("right"), "c");
  assert.equal(screen.moveFocus("down"), "d");
  assert.equal(screen.moveFocus("up"), "c");
  screen.setNodeVisible("c", false);
  assert.equal(screen.getFocusedId(), "a");
  assert.equal(screen.moveFocus("right"), "a");
  assert.equal(screen.setFocus("b"), false);
  assert.equal(screen.setFocus("D"), true);
  assert.equal(screen.getDrawItems().find(item => item.id === "d")?.highlighted, true);
});

test("pointer input hits the topmost available button and ignores outside coordinates", () => {
  const screen = new UiScreenInstance(button("under", .25, .25) + button("over", .25, .25));
  assert.equal(screen.pointerMove(.3, .3), "over");
  assert.equal(screen.getFocusedId(), "over");
  screen.setNodeEnabled("over", false);
  assert.equal(screen.pointerClick(.3, .3), "under");
  assert.equal(screen.pointerClick(.6, .6), null);
  assert.equal(screen.hitTest(NaN, .3), null);
  screen.startExit();
  assert.equal(screen.pointerClick(.3, .3), null);
});

test("absolute child geometry normalizes pixels while preserving the parent origin", () => {
  const screen = new UiScreenInstance(`
    :TYPE UI_TYPE_AREA
    :POSITION_START .25 .5
    :SIZE .5 .25
    :S{*****>>>
      :TYPE UI_TYPE_GRAPHIC
      :OBJECT_ID badge
      :POSITION_START 40 20
      :SIZE 2 1
      :AUTOSIZE 1
      :TEXTURE_ENUM Icons/badge.psd
    :E}*****<<<
  `, {
    viewport: { width: 800, height: 400 },
    isAbsolute: node => node.objectId === "badge",
    intrinsicSize: () => ({ width: 20, height: 10 }),
  });
  assert.deepEqual(screen.getDrawItems()[0]?.rect, { x: .3, y: .55, width: .05, height: .025 });
});

const car = { id: "compact", name: "Compact", liveries: ["blue", "green"] };
const secondCar = { id: "roadster", name: "Roadster", liveries: [] };
const preset: RaceSetup = {
  trackId: "club", carId: car.id, laps: 2, difficulty: "MEDIUM", mode: "RACING", transmission: "AUTO",
};

function menuOptions(patch: Partial<MenuControllerOptions> = {}): MenuControllerOptions {
  return {
    cars: [car, secondCar], trackId: "club", languages: ["en", "es"],
    ...patch,
  };
}

function scene(actions: readonly MenuAction[]) {
  return {
    screen: new UiScreenInstance(actions.map((action, index) => button(action, 0, index / 4)).join("")),
    actions: Object.fromEntries(actions.map(action => [action, action])),
  };
}

test("menu routes input through scenes, launches a car, pauses, resumes and shows standings", () => {
  const controller = new MenuController(menuOptions({
    createScene: state => {
      if (state === "MAIN_MENU") return scene(["select-car", "options"]);
      if (state === "CAR_SELECT") return scene(["next-livery", "launch"]);
      return undefined;
    },
  }));
  const input = new InputManager();
  const tick = (menu: Partial<MenuInput> = {}, pause = false) => {
    const frame = input.poll(0);
    controller.update(1 / 60, {
      driving: { ...frame.driving, pausePressed: pause },
      menu: { ...frame.menu, ...menu },
    });
  };
  assert.equal(controller.getView().state, "START");
  tick({ pointerClicked: true });
  assert.equal(controller.getView().state, "MAIN_MENU");
  tick({ confirm: true });
  assert.equal(controller.getView().state, "CAR_SELECT");
  assert.deepEqual(controller.drainCommands().at(-1), {
    type: "TurntableCarRequest", carId: "compact", livery: "blue",
  });

  tick({ confirm: true });
  controller.updateRaceOptions({ laps: 20, difficulty: "HARD", mode: "RACING_BOOST" });
  tick({ pointerClicked: true, pointerX: .05, pointerY: .3 });
  assert.equal(controller.getView().state, "LOADING");
  const launch = controller.drainCommands().find(command => command.type === "LaunchRaceRequest");
  assert.ok(launch && launch.type === "LaunchRaceRequest");
  assert.deepEqual(launch.setup, {
    trackId: "club", carId: "compact", livery: "green", laps: 9,
    difficulty: "HARD", mode: "RACING_BOOST", transmission: "AUTO",
    opponentIds: undefined,
  });
  assert.equal(controller.setLoadProgress(launch.requestId, .4), true);
  assert.equal(controller.setLoadProgress(launch.requestId, .2), true);
  assert.equal(controller.getView().progress, .4);
  assert.equal(controller.completeLoad(launch.requestId), true);
  assert.equal(controller.getView().state, "IN_GAME");
  tick({}, true);
  assert.equal(controller.getView().state, "PAUSE");
  controller.activate("options");
  assert.equal(controller.getView().state, "OPTIONS");
  tick({ back: true });
  assert.equal(controller.getView().state, "PAUSE");
  controller.activate("resume");
  assert.deepEqual(controller.drainCommands().at(-1), { type: "ResumeRace" });
  assert.equal(controller.getView().state, "IN_GAME");

  const results = [{
    carId: "compact", carName: "Compact", totalSeconds: 132, bestLapSeconds: 42, gapSeconds: 0,
  }];
  assert.equal(controller.finishRace(results), true);
  assert.equal(controller.getView().state, "RACE_END");
  controller.activate("standings");
  assert.equal(controller.getView().state, "RESULTS");
  assert.deepEqual(controller.getView().standings, results);
  controller.activate("quit");
  assert.equal(controller.getView().state, "MAIN_MENU");
  assert.deepEqual(controller.drainCommands().at(-1), { type: "QuitToMenu" });
});

test("quick races rotate configured presets and restart keeps the same setup", () => {
  const controller = new MenuController(menuOptions({
    quickRaces: [preset, { ...preset, carId: secondCar.id }],
  }));
  controller.continueFromStart();
  controller.activate("quick-race");
  const launch = controller.drainCommands().at(-1);
  assert.ok(launch?.type === "LaunchRaceRequest");
  controller.completeLoad(launch.requestId);
  controller.finishRace([]);
  controller.activate("restart");
  const restart = controller.drainCommands().at(-1);
  assert.ok(restart?.type === "RestartRace");
  assert.deepEqual(restart.setup, launch.setup);
  assert.equal(controller.completeLoad(launch.requestId), false);
  assert.equal(controller.completeLoad(restart.requestId), true);
  controller.finishRace([]);
  controller.activate("quick-race");
  const next = controller.drainCommands().at(-1);
  assert.ok(next?.type === "LaunchRaceRequest");
  assert.equal(next.setup.carId, secondCar.id);
  controller.failLoad(next.requestId, "Track could not be loaded");
  assert.equal(controller.getView().loadingError, "Track could not be loaded");
  assert.equal(controller.completeLoad(next.requestId), false);
  controller.activate("back");
  assert.equal(controller.getView().state, "MAIN_MENU");
  assert.equal(controller.setLoadProgress(next.requestId, 1), false);
});

test("menu persists validated preferences and delegates key bindings", () => {
  const records = new Map<string, string>();
  const input = {
    getBinding: () => ["KeyW"],
    setBinding: (action: string, codes: readonly string[]) => {
      assert.equal(action, "throttle");
      assert.deepEqual(codes, ["ArrowUp"]);
    },
  };
  const options = menuOptions({
    storage: {
      getItem: key => records.get(key) ?? null,
      setItem: (key, value) => { records.set(key, value); },
    },
    input,
    createScene: state => state === "OPTIONS" ? {
      screen: new UiScreenInstance(button("metric", 0, 0)),
      actions: { metric: { settings: { speedUnits: "KPH" } } },
    } : undefined,
  });
  const controller = new MenuController(options);
  controller.continueFromStart();
  controller.activate("options");
  const frame = new InputManager().poll(0);
  controller.update(0, { ...frame, menu: { ...frame.menu, confirm: true } });
  assert.equal(controller.getView().settings.speedUnits, "KPH");
  controller.updateSettings({ language: "es", masterVolume: 2, transmission: "MANUAL" });
  controller.updateSettings({ language: "invalid", fov: NaN });
  assert.equal(controller.drainCommands().at(-1)?.type, "SettingsChanged");
  const restored = new MenuController(options);
  assert.deepEqual(restored.getView().settings, controller.getView().settings);
  assert.equal(restored.getView().settings.language, "es");
  assert.equal(restored.getView().settings.masterVolume, 1);
  assert.equal(restored.getView().settings.speedUnits, "KPH");
  assert.deepEqual(restored.getBinding("throttle"), ["KeyW"]);
  restored.setBinding("throttle", ["ArrowUp"]);
});

test("HUD formats time, gear, rank, lap and countdown and clamps gauges", () => {
  const telemetry = {
    speedMps: 50, rpm: 9000, redlineRpm: 7500, gear: -1,
    boostCharges: 3, boostActive: true, boostRemainingFraction: .5,
  };
  const race = {
    position: 12, participants: 13, lap: 5, laps: 4, currentLapSeconds: 59.999,
    bestLapSeconds: 43.255, totalSeconds: 121, countdown: "go" as const, wrongWay: true,
    banner: "final-lap" as const,
  };
  const model = buildHudViewModel(telemetry, race, {
    speedUnits: "MPH", speedometerMaxMps: 100, speedometerArc: { start: 1, sweep: 4 },
  });
  assert.equal(model.speed, 112);
  assert.equal(model.speedometerFraction, .5);
  assert.equal(model.speedometerAngle, 3);
  assert.equal(model.rpmFraction, 1);
  assert.equal(model.gear, "R");
  assert.equal(model.boostCharges, 2);
  assert.equal(model.boostActive, true);
  assert.equal(model.boostRemainingFraction, .5);
  assert.equal(model.ordinalPosition, "12TH");
  assert.equal(model.participants, "13");
  assert.equal(model.lap, "4");
  assert.equal(model.currentLapTime, "01:00.00");
  assert.equal(model.bestLapTime, "00:43.26");
  assert.equal(model.totalTime, "02:01.00");
  assert.equal(model.countdown, "GO!");
  assert.equal(model.wrongWay, true);
  assert.equal(model.banner, "final-lap");
  assert.equal(formatRaceTime(-1.25), "-00:01.25");
  assert.equal(formatRaceTime(Infinity), null);
  const other = buildHudViewModel({ ...telemetry, gear: 0 }, { ...race, position: 2, countdown: 3 }, {
    speedUnits: "KPH", speedometerMaxMps: 30,
  });
  assert.equal(other.speed, 180);
  assert.equal(other.speedometerFraction, 1);
  assert.equal(other.ordinalPosition, "2ND");
  assert.equal(other.gear, "N");
  assert.equal(other.countdown, "3");
});

test("minimap keeps virtual aspect, closes the outline and draws the local marker last", () => {
  const course = [{ x: 10, z: 4 }, { x: 14, z: 4 }, { x: 14, z: 6 }, { x: 10, z: 6 }];
  const minimap = {
    course,
    cars: [
      { ...course[0]!, id: "local", local: true },
      { ...course[1]!, id: "hidden", active: false },
      { ...course[2]!, id: "rival" },
    ],
    viewport: { width: 800, height: 400 },
    anchor: { x: .5, y: .25 },
    extent: 200,
  };
  const telemetry = { speedMps: 0, rpm: 0, redlineRpm: 0, gear: 1 };
  const race = { position: 1, participants: 2, lap: 1, laps: 2 };
  const model = buildHudViewModel(telemetry, race, { speedUnits: "KPH", speedometerMaxMps: 50, minimap });
  assert.deepEqual(model.minimap, {
    outline: [
      { x: .375, y: .375 }, { x: .625, y: .375 },
      { x: .625, y: .125 }, { x: .375, y: .125 }, { x: .375, y: .375 },
    ],
    markers: [
      { x: .625, y: .125, id: "rival", local: false },
      { x: .375, y: .375, id: "local", local: true },
    ],
  });
  assert.equal(model.ordinalPosition, "1ST");
  assert.equal(model.bestLapTime, null);
  const degenerate = buildHudViewModel(telemetry, race, {
    speedUnits: "KPH", speedometerMaxMps: 50, minimap: { ...minimap, course: [course[0]!, course[0]!] },
  });
  assert.equal(degenerate.minimap, null);
});
