import assert from "node:assert/strict";
import test from "node:test";
import { parseTranslationTable } from "../src/formats/tlate";
import { InputManager, type MenuInput } from "../src/input/inputManager";
import { buildHudViewModel, formatRaceTime, formatResultsRowTimes } from "../src/ui/hudModel";
import {
  MENU_SCREEN_SCRIPTS, MenuController, type MenuAction, type MenuControllerOptions, type MenuSceneAction,
  type MenuState, type RaceSetup,
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
    opponents: 5, fieldType: "MIX", catchUp: false, opponentIds: undefined,
  });
  assert.equal(controller.setLoadProgress(launch.requestId, .4), true);
  assert.equal(controller.setLoadProgress(launch.requestId, .2), true);
  assert.equal(controller.getView().progress, .4);
  assert.equal(controller.completeLoad(launch.requestId), true);
  assert.equal(controller.getView().state, "IN_GAME");
  tick({}, true);
  assert.equal(controller.getView().state, "PAUSE");
  // Pressing P (pausePressed without menu.back) while paused unpauses back to IN_GAME.
  tick({}, true);
  assert.deepEqual(controller.drainCommands().at(-1), { type: "ResumeRace" });
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
  // fr3: UI_MODULE_RACE_RESULTS (RCRES.UI) comes first; its DONE opens UI_MODULE_RACE_END (RCEND.UI).
  assert.equal(controller.getView().state, "RESULTS");
  assert.deepEqual(controller.getView().standings, results);
  tick({ confirm: true });
  assert.equal(controller.getView().state, "RACE_END");
  controller.activate("standings");
  assert.equal(controller.getView().state, "RESULTS");
  controller.activate("continue");
  assert.equal(controller.getView().state, "RACE_END");
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

test("Esc on RESULTS opens RACE_END and Esc on RACE_END returns to the main menu", () => {
  const controller = new MenuController(menuOptions({ quickRaces: [preset] }));
  controller.continueFromStart();
  controller.activate("quick-race");
  const launch = controller.drainCommands().at(-1);
  assert.ok(launch?.type === "LaunchRaceRequest");
  controller.completeLoad(launch.requestId);
  controller.finishRace([]);
  assert.equal(controller.getView().state, "RESULTS");
  const input = new InputManager();
  const esc = () => {
    const frame = input.poll(0);
    controller.update(1 / 60, { driving: frame.driving, menu: { ...frame.menu, back: true } });
  };
  esc();
  assert.equal(controller.getView().state, "RACE_END");
  controller.drainCommands();
  esc();
  assert.equal(controller.getView().state, "MAIN_MENU");
  assert.deepEqual(controller.drainCommands().filter(c => c.type === "QuitToMenu"), [{ type: "QuitToMenu" }]);
});

test("results rows show real finish times only, with lap-down, estimated gap or DNF for unfinished racers", () => {
  const finished = formatResultsRowTimes({
    totalSeconds: 272.49, bestLapSeconds: 66.1, gapSeconds: 0, finished: true, lapsDown: 0,
  });
  assert.deepEqual(finished, { time: "04:32.49", best: "01:06.10" });
  assert.equal(formatResultsRowTimes({
    totalSeconds: null, bestLapSeconds: 70, gapSeconds: 3.456, finished: false, lapsDown: 0,
  }).time, "+3.46s");
  assert.equal(formatResultsRowTimes({
    totalSeconds: null, bestLapSeconds: null, gapSeconds: 75, finished: false, lapsDown: 0,
  }).time, "+01:15.00");
  assert.equal(formatResultsRowTimes({
    totalSeconds: null, bestLapSeconds: null, gapSeconds: null, finished: false, lapsDown: 1,
  }).time, "+1 LAP");
  assert.equal(formatResultsRowTimes({
    totalSeconds: null, bestLapSeconds: null, gapSeconds: null, finished: false, lapsDown: 2,
  }).time, "+2 LAPS");
  const dnf = formatResultsRowTimes({ totalSeconds: null, bestLapSeconds: null, gapSeconds: null, finished: false });
  assert.deepEqual(dnf, { time: "DNF", best: "--:--.--" });
  // Legacy rows without `finished` stay finished when they carry a time.
  assert.equal(formatResultsRowTimes({ totalSeconds: 132, bestLapSeconds: 42, gapSeconds: 0 }).time, "02:12.00");
});

test("setCarLiveries collapses a car's placeholder liveries and keeps the selection in range", () => {
  const many = { id: "gt", name: "GT", liveries: ["DEFAULT", "A", "B", "C"] };
  const controller = new MenuController(menuOptions({ cars: [many, car] }));
  controller.continueFromStart();
  controller.activate("select-car");
  assert.equal(controller.activate("next-livery"), true);
  assert.equal(controller.getView().livery, "A");
  assert.equal(controller.setCarLiveries("gt", ["DEFAULT"]), true);
  assert.equal(controller.getView().livery, "DEFAULT");
  assert.deepEqual(controller.getView().car?.liveries, ["DEFAULT"]);
  assert.equal(controller.activate("next-livery"), false);
  assert.equal(controller.setCarLiveries("gt", ["DEFAULT"]), false);
  assert.equal(controller.setCarLiveries("missing", ["X"]), false);
  controller.activate("next-car");
  assert.deepEqual(controller.getView().car?.liveries, ["blue", "green"]);
});

/** A scene with one button per id, stacked top to bottom, so up/down walks them in order. */
function actionScene(actions: Record<string, MenuSceneAction>, extra: { horizontal?: null } = {}) {
  const ids = Object.keys(actions);
  return {
    screen: new UiScreenInstance(ids.map((id, index) => button(id, 0, index / 8)).join("")),
    actions,
    ...extra,
  };
}

function driver(controller: MenuController) {
  const input = new InputManager();
  return (menu: Partial<MenuInput> = {}, pause = false) => {
    const frame = input.poll(0);
    controller.update(1 / 60, {
      driving: { ...frame.driving, pausePressed: pause },
      menu: { ...frame.menu, ...menu },
    });
  };
}

test("MENU_SCREEN_SCRIPTS maps every front-end state to its original .UI script", () => {
  assert.deepEqual(MENU_SCREEN_SCRIPTS, {
    START: "UI/START.UI", MAIN_MENU: "UI/GAMEF.UI", MODE_SELECT: "UI/CMODE.UI", CAR_SELECT: "UI/CAR.UI",
    TRACK_SELECT: "UI/TRACK.UI", RACE_OPTIONS: "UI/ROPT.UI", OPTIONS: "UI/OPTS.UI", OPTIONS_GAME: "UI/GMOPT.UI",
    OPTIONS_AUDIO: "UI/AUDIO.UI", OPTIONS_DISPLAY: "UI/DISP.UI", OPTIONS_CONTROLS: "UI/CTRLS.UI",
    OPTIONS_CREDITS: "UI/CRED.UI", OPTIONS_LANGUAGE: "UI/LANG.UI", LOADING: null, IN_GAME: null,
    PAUSE: "UI/PAUSE.UI", RESULTS: "UI/RCRES.UI", RACE_END: "UI/RCEND.UI",
  });
  const controller = new MenuController(menuOptions());
  assert.equal(controller.getView().screenPath, "UI/START.UI");
  controller.continueFromStart();
  assert.equal(controller.getView().screenPath, "UI/GAMEF.UI");
  assert.equal(controller.getView().previousState, "START");
});

test("single player steps CMODE -> CAR (class page, car page) -> TRACK -> ROPT -> LOADING, and back unwinds it", () => {
  const cars = [
    { id: "ka", name: "Ka", liveries: ["red", "blue"], group: "COMPACT" },
    { id: "focus", name: "Focus", liveries: [], group: "COMPACT" },
    { id: "gt", name: "GT", liveries: [], group: "SUPER" },
  ];
  const tracks = [{ id: "club", name: "Club" }, { id: "dunes", name: "Dunes" }, { id: "port", name: "Port" }];
  const visited: MenuState[] = [];
  const controller = new MenuController(menuOptions({
    cars, tracks,
    createScene: state => {
      visited.push(state);
      switch (state) {
        case "MAIN_MENU":
          return actionScene({ BUTTON1: "quick-race", BUTTON2: "single-player", BUTTON4: "options" });
        case "MODE_SELECT":
          return actionScene({
            BUTTON1: { raceOptions: { mode: "RACING" }, then: "continue" },
            BUTTON2: { raceOptions: { mode: "RACING_BOOST" }, then: "continue" },
          });
        case "CAR_SELECT": {
          // GROUPWINDOW buttons exist only on the class page, as CAR.UI toggles DRAWABLE per page.
          const scene = actionScene({ BUTTON1: { carGroup: "COMPACT" }, BUTTON2: { carGroup: "SUPER" } });
          return {
            ...scene,
            update: view => {
              for (const id of ["BUTTON1", "BUTTON2"]) scene.screen.setNodeEnabled(id, view.carSelectPage === "GROUP");
            },
          };
        }
        case "RACE_OPTIONS":
          return actionScene({
            LAPS: { adjust: "laps" }, OPPS: { adjust: "opponents" }, FIELD: { adjust: "fieldType" },
            DIFF: { adjust: "difficulty" }, CATCH_UP_BUTTON: { adjust: "catchUp" }, RACE: "launch",
          });
        default:
          return undefined;
      }
    },
  }));
  const tick = driver(controller);
  tick({ anyKey: true });
  assert.equal(controller.getView().state, "MAIN_MENU");
  tick({ down: true });
  tick({ confirm: true });
  assert.equal(controller.getView().state, "MODE_SELECT");
  tick({ down: true });
  tick({ confirm: true });
  assert.equal(controller.getView().raceOptions.mode, "RACING_BOOST");

  // CAR.UI opens on the class page because the cars have two classes.
  let view = controller.getView();
  assert.equal(view.state, "CAR_SELECT");
  assert.equal(view.carSelectPage, "GROUP");
  assert.deepEqual(view.carGroups, ["COMPACT", "SUPER"]);
  tick({ down: true });
  tick({ confirm: true });
  view = controller.getView();
  assert.equal(view.carSelectPage, "ITEM");
  assert.equal(view.car?.id, "gt");
  assert.equal(view.carGroup, "SUPER");
  tick({ right: true });
  assert.equal(controller.getView().car?.id, "gt", "a one-car class has nothing to cycle");
  tick({ back: true });
  assert.equal(controller.getView().carSelectPage, "GROUP");
  assert.equal(controller.activate("previous-car-group"), true);
  assert.equal(controller.getView().car?.id, "ka");
  tick({ up: true });
  tick({ confirm: true });
  assert.equal(controller.getView().carSelectPage, "ITEM");
  tick({ right: true });
  assert.equal(controller.getView().car?.id, "focus");
  tick({ right: true });
  assert.equal(controller.getView().car?.id, "ka", "left/right cycle inside the selected class");
  assert.equal(controller.activate("next-livery"), true);
  assert.equal(controller.getView().livery, "blue");

  // fr3 DONE table: CAR_SELECT -> TRACK_SELECT -> RACE_OPTIONS.
  tick({ confirm: true });
  assert.equal(controller.getView().state, "TRACK_SELECT");
  assert.equal(controller.getView().trackSelectPage, "ITEM");
  tick({ right: true });
  tick({ right: true });
  assert.equal(controller.getView().track?.id, "port");
  tick({ left: true });
  assert.equal(controller.getView().track?.id, "dunes");
  tick({ confirm: true });
  assert.equal(controller.getView().state, "RACE_OPTIONS");

  tick({ right: true });
  assert.equal(controller.getView().raceOptions.laps, 4);
  tick({ down: true });
  tick({ left: true });
  assert.equal(controller.getView().raceOptions.opponents, 4);
  tick({ down: true });
  tick({ confirm: true });
  assert.equal(controller.getView().raceOptions.fieldType, "MATCH");
  tick({ down: true });
  tick({ left: true });
  assert.equal(controller.getView().raceOptions.difficulty, "EASY");
  tick({ down: true });
  tick({ right: true });
  assert.equal(controller.getView().raceOptions.catchUp, true);

  // Back unwinds the screen stack one original screen at a time.
  tick({ back: true });
  assert.equal(controller.getView().state, "TRACK_SELECT");
  tick({ back: true });
  view = controller.getView();
  assert.equal(view.state, "CAR_SELECT");
  assert.equal(view.carSelectPage, "ITEM");
  assert.equal(view.car?.id, "ka");
  tick({ confirm: true });
  tick({ confirm: true });
  assert.equal(controller.getView().state, "RACE_OPTIONS");
  assert.equal(controller.getView().raceOptions.laps, 4, "race settings survive back and forward");
  controller.drainCommands();
  tick({ down: true });
  tick({ down: true });
  tick({ down: true });
  tick({ down: true });
  tick({ down: true });
  tick({ confirm: true });
  assert.equal(controller.getView().state, "LOADING");
  const launch = controller.drainCommands().find(command => command.type === "LaunchRaceRequest");
  assert.ok(launch?.type === "LaunchRaceRequest");
  assert.deepEqual(launch.setup, {
    trackId: "dunes", carId: "ka", livery: "blue", laps: 4, difficulty: "EASY", mode: "RACING_BOOST",
    opponents: 4, fieldType: "MATCH", catchUp: true, transmission: "AUTO", opponentIds: undefined,
  });
  assert.ok(controller.failLoad(launch.requestId, "boom"));
  tick({ back: true });
  assert.equal(controller.getView().state, "MAIN_MENU");
  tick({ back: true });
  assert.equal(controller.getView().state, "START", "fr3: BACK from GAME_FLOW opens START");
  assert.deepEqual(
    [...new Set(visited)],
    ["START", "MAIN_MENU", "MODE_SELECT", "CAR_SELECT", "TRACK_SELECT", "RACE_OPTIONS", "LOADING"],
  );
});

test("each single-player screen backs out to the one that opened it, and launch still works straight from CAR_SELECT", () => {
  const controller = new MenuController(menuOptions({
    tracks: [{ id: "club", name: "Club" }, { id: "dunes", name: "Dunes" }],
  }));
  controller.continueFromStart();
  assert.ok(controller.activate("single-player"));
  assert.ok(controller.activate("continue"));
  assert.equal(controller.getView().state, "CAR_SELECT");
  assert.equal(controller.getView().carSelectPage, "ITEM", "no classes means no class page");
  assert.ok(controller.activate("back"));
  assert.equal(controller.getView().state, "MODE_SELECT");
  assert.ok(controller.activate("back"));
  assert.equal(controller.getView().state, "MAIN_MENU");

  // GAMEF's direct car-select entry skips CMODE, and back returns straight to the main menu.
  assert.ok(controller.activate("select-car"));
  assert.ok(controller.activate("select-track"));
  assert.equal(controller.getView().state, "TRACK_SELECT");
  assert.ok(controller.activate("race-options"));
  assert.ok(controller.activate("back"));
  assert.ok(controller.activate("back"));
  assert.equal(controller.getView().state, "CAR_SELECT");
  assert.ok(controller.activate("back"));
  assert.equal(controller.getView().state, "MAIN_MENU");
  assert.ok(controller.activate("select-car"));
  assert.ok(controller.activate("next-track"));
  assert.ok(controller.activate("launch"));
  const launch = controller.drainCommands().find(command => command.type === "LaunchRaceRequest");
  assert.ok(launch?.type === "LaunchRaceRequest");
  assert.equal(launch.setup.trackId, "dunes");
  assert.equal(controller.getView().state, "LOADING");
});

test("track rosters add a TRACK.UI group page whose roster buttons open the track page", () => {
  const tracks = [
    { id: "a1", name: "A1", group: "FR1" }, { id: "a2", name: "A2", group: "FR1" },
    { id: "b1", name: "B1", group: "FR2" },
  ];
  const controller = new MenuController(menuOptions({
    tracks, trackId: "a1",
    createScene: state => state === "TRACK_SELECT"
      ? actionScene({ BUTTON1: { trackGroup: "FR1" }, BUTTON2: { trackGroup: "FR2" } })
      : undefined,
  }));
  const tick = driver(controller);
  controller.continueFromStart();
  controller.activate("select-car");
  controller.activate("continue");
  let view = controller.getView();
  assert.equal(view.state, "TRACK_SELECT");
  assert.equal(view.trackSelectPage, "GROUP");
  assert.deepEqual(view.trackGroups, ["FR1", "FR2"]);
  tick({ down: true });
  tick({ confirm: true });
  view = controller.getView();
  assert.equal(view.trackSelectPage, "ITEM");
  assert.equal(view.track?.id, "b1");
  assert.equal(controller.activate("next-track"), false, "one track in roster FR2");
  tick({ back: true });
  assert.equal(controller.getView().trackSelectPage, "GROUP");
  assert.ok(controller.activate("next-track-group"));
  assert.equal(controller.getView().track?.id, "a1");
  assert.equal(controller.getView().trackGroup, "FR1");
  tick({ back: true });
  assert.equal(controller.getView().state, "CAR_SELECT");
});

test("OPTS.UI hub opens every sub-screen, each returns to the hub, and the hub returns to its opener", () => {
  let resets = 0;
  const controller = new MenuController(menuOptions({
    input: { getBinding: () => [], setBinding: () => undefined, resetBindings: () => { resets++; } },
    createScene: state => {
      switch (state) {
        case "OPTIONS":
          return actionScene({
            BUTTON1: "options-game", BUTTON2: "options-audio", BUTTON3: "options-display",
            BUTTON4: "options-controls", BUTTON5: "options-credits",
          });
        case "OPTIONS_AUDIO":
          return actionScene({
            ENGINE: { adjust: "engineVolume" }, SPEECH: { adjust: "speechVolume" },
            INGAMEMUSIC: { adjust: "raceMusicVolume" }, MENUMUSIC: { adjust: "menuMusicVolume" },
          });
        case "OPTIONS_GAME":
          return actionScene({ SAVE: { adjust: "autosave" }, GEARS: { adjust: "transmission" } });
        case "OPTIONS_DISPLAY":
          return actionScene({ SPEEDO: { adjust: "speedUnits" }, TRACKMAP: { adjust: "trackMap" } });
        case "OPTIONS_LANGUAGE":
          return actionScene({
            BUTTON1: { settings: { language: "en" }, then: "back" },
            BUTTON2: { settings: { language: "es" }, then: "back" },
          });
        default:
          return undefined;
      }
    },
  }));
  const tick = driver(controller);
  controller.continueFromStart();
  assert.ok(controller.activate("options"));
  assert.equal(controller.getView().inGameOptions, false);

  tick({ down: true });
  tick({ confirm: true });
  assert.equal(controller.getView().state, "OPTIONS_AUDIO");
  tick({ left: true });
  tick({ left: true });
  assert.equal(controller.getView().settings.engineVolume, .8);
  tick({ right: true });
  tick({ right: true });
  assert.equal(controller.getView().settings.engineVolume, 1);
  controller.drainCommands();
  tick({ right: true });
  assert.deepEqual(controller.drainCommands(), [], "a full slider does not move or play a sound");
  tick({ down: true });
  tick({ left: true });
  tick({ down: true });
  tick({ left: true });
  tick({ down: true });
  tick({ left: true });
  const audio = controller.getView().settings;
  assert.deepEqual([audio.speechVolume, audio.raceMusicVolume, audio.menuMusicVolume], [.9, .9, .9]);
  tick({ back: true });
  assert.equal(controller.getView().state, "OPTIONS");

  assert.ok(controller.activate("options-game"));
  tick({ confirm: true });
  assert.equal(controller.getView().settings.autosave, false);
  tick({ down: true });
  tick({ right: true });
  assert.equal(controller.getView().settings.transmission, "MANUAL");
  assert.ok(controller.activate("continue"), "DONE on a sub-screen returns to the hub");
  assert.equal(controller.getView().state, "OPTIONS");

  assert.ok(controller.activate("options-display"));
  tick({ right: true });
  assert.equal(controller.getView().settings.speedUnits, "KPH");
  tick({ down: true });
  tick({ left: true });
  assert.equal(controller.getView().settings.trackMap, false);
  tick({ back: true });

  assert.ok(controller.activate("options-controls"));
  assert.equal(controller.getView().screenPath, "UI/CTRLS.UI");
  assert.ok(controller.activate("reset-controls"));
  assert.equal(resets, 1);
  tick({ back: true });

  assert.ok(controller.activate("options-credits"));
  tick({ back: true });
  assert.ok(controller.activate("options-language"));
  tick({ down: true });
  tick({ confirm: true });
  assert.equal(controller.getView().settings.language, "es");
  assert.equal(controller.getView().state, "OPTIONS", "LANG buttons apply and return");
  assert.equal(controller.activate("reset-controls"), false, "reset-controls belongs to CTRLS only");
  tick({ back: true });
  assert.equal(controller.getView().state, "MAIN_MENU");

  const saved = controller.getView().settings;
  assert.equal(saved.autosave, false);
  assert.equal(saved.transmission, "MANUAL");
});

test("options opened from PAUSE are in-game, and back from any sub-screen returns to PAUSE through the hub", () => {
  const controller = new MenuController(menuOptions({ quickRaces: [preset] }));
  const tick = driver(controller);
  controller.continueFromStart();
  controller.activate("quick-race");
  const launch = controller.drainCommands().at(-1);
  assert.ok(launch?.type === "LaunchRaceRequest");
  controller.completeLoad(launch.requestId);
  tick({}, true);
  assert.equal(controller.getView().state, "PAUSE");
  assert.ok(controller.activate("options"));
  assert.equal(controller.getView().inGameOptions, true);
  assert.ok(controller.activate("options-audio"));
  assert.equal(controller.getView().inGameOptions, true);
  assert.ok(controller.adjust("masterVolume", -1));
  assert.equal(controller.getView().settings.masterVolume, .9);
  tick({ back: true });
  assert.equal(controller.getView().state, "OPTIONS");
  tick({ back: true });
  assert.equal(controller.getView().state, "PAUSE");
  assert.equal(controller.activate("quit"), true);
  assert.equal(controller.getView().state, "MAIN_MENU");
  assert.ok(controller.activate("options"));
  assert.equal(controller.getView().inGameOptions, false);
  tick({ back: true });
  assert.equal(controller.getView().state, "MAIN_MENU");
});

test("RCRES continues to RCEND, whose RETRY restarts and EXIT quits to the main menu", () => {
  const controller = new MenuController(menuOptions({
    quickRaces: [preset],
    createScene: state => {
      if (state === "RACE_END") return actionScene({ REPLAY: "standings", RETRY: "restart", EXIT: "quit" });
      return undefined;
    },
  }));
  const tick = driver(controller);
  controller.continueFromStart();
  controller.activate("quick-race");
  const launch = controller.drainCommands().at(-1);
  assert.ok(launch?.type === "LaunchRaceRequest");
  controller.completeLoad(launch.requestId);
  assert.ok(controller.finishRace([]));
  assert.equal(controller.getView().screenPath, "UI/RCRES.UI");
  tick({ confirm: true });
  assert.equal(controller.getView().state, "RACE_END");
  assert.equal(controller.getView().screenPath, "UI/RCEND.UI");

  tick({ down: true });
  tick({ confirm: true });
  const restart = controller.drainCommands().find(command => command.type === "RestartRace");
  assert.ok(restart?.type === "RestartRace");
  assert.deepEqual(restart.setup, launch.setup);
  assert.equal(controller.getView().state, "LOADING");
  controller.completeLoad(restart.requestId);
  controller.finishRace([]);
  controller.activate("continue");
  assert.equal(controller.getView().state, "RACE_END");
  controller.drainCommands();
  tick({ down: true });
  tick({ down: true });
  tick({ confirm: true });
  assert.equal(controller.getView().state, "MAIN_MENU");
  assert.deepEqual(controller.drainCommands().filter(c => c.type === "QuitToMenu"), [{ type: "QuitToMenu" }]);
  assert.equal(controller.activate("restart"), false);

  // select-car from the post-race screens leaves the race and backs out to the main menu.
  controller.activate("quick-race");
  const again = controller.drainCommands().find(command => command.type === "LaunchRaceRequest");
  assert.ok(again?.type === "LaunchRaceRequest");
  controller.completeLoad(again.requestId);
  controller.finishRace([]);
  assert.ok(controller.activate("select-car"));
  assert.equal(controller.getView().state, "CAR_SELECT");
  assert.ok(controller.drainCommands().some(c => c.type === "QuitToMenu"));
  assert.ok(controller.activate("back"));
  assert.equal(controller.getView().state, "MAIN_MENU");
});

test("value adjustments wrap race options, clamp sliders and reject actions outside their screen", () => {
  const controller = new MenuController(menuOptions());
  controller.continueFromStart();
  assert.equal(controller.activate("launch"), false, "launch belongs to the race-setup screens");
  assert.equal(controller.activate("options-audio"), false, "sub-screens open from the OPTS hub only");
  controller.updateRaceOptions({ laps: 9, opponents: 0 });
  assert.ok(controller.adjust("laps", 1));
  assert.equal(controller.getView().raceOptions.laps, 1);
  assert.ok(controller.adjust("opponents", -1));
  assert.equal(controller.getView().raceOptions.opponents, 5);
  assert.ok(controller.adjust("mode", 1));
  assert.equal(controller.getView().raceOptions.mode, "RACING_BOOST");
  controller.updateRaceOptions({ opponents: 99, fieldType: "BOGUS" as never, catchUp: "yes" as never });
  assert.equal(controller.getView().raceOptions.opponents, 5);
  assert.equal(controller.getView().raceOptions.fieldType, "MIX");
  assert.equal(controller.getView().raceOptions.catchUp, false);
  controller.updateSettings({ sfxVolume: 0 });
  assert.equal(controller.adjust("sfxVolume", -1), false);
  assert.ok(controller.adjust("sfxVolume", 1));
  assert.equal(controller.getView().settings.sfxVolume, .1);
  assert.ok(controller.adjust("language", 1));
  assert.equal(controller.getView().settings.language, "es");
  assert.ok(controller.adjust("language", 1));
  assert.equal(controller.getView().settings.language, "en");
  assert.equal(controller.adjust("carGroup", 1), false, "no classes configured");
});

test("pointerAction gives non-button graphics click actions; buttons with actions still win", () => {
  const calls: [number, number][] = [];
  const controller = new MenuController(menuOptions({
    createScene: state => state === "CAR_SELECT" ? {
      ...scene(["launch"]),
      pointerAction: (x: number, y: number): MenuSceneAction | undefined => {
        calls.push([x, y]);
        if (x > .5 && y < .25) return "next-livery";
        if (x > .5 && y > .5) return "continue";
        return undefined;
      },
    } : state === "MAIN_MENU" ? scene(["select-car"]) : undefined,
  }));
  const input = new InputManager();
  const click = (x: number, y: number) => {
    const frame = input.poll(0);
    controller.update(1 / 60, { driving: frame.driving, menu: { ...frame.menu, pointerClicked: true, pointerX: x, pointerY: y } });
  };
  click(.5, .5); // START
  click(.05, .05); // MAIN_MENU select-car button
  assert.equal(controller.getView().state, "CAR_SELECT");
  assert.equal(controller.getView().livery, "blue");
  click(.75, .1);
  assert.equal(controller.getView().livery, "green", "a click on the COLOUR prompt changes the livery");
  click(.3, .4);
  assert.equal(controller.getView().state, "CAR_SELECT", "an empty spot does nothing");
  // A click on the `launch` button is handled by the button; pointerAction is not consulted.
  const before = calls.length;
  click(.05, .05);
  assert.equal(calls.length, before);
  assert.equal(controller.getView().state, "LOADING");
});

test("pointer-only players walk CAR (bar, turntable halves) and TRACK pages through pointerAction", () => {
  const actionsFor = (state: MenuState): ((x: number) => MenuSceneAction | undefined) | undefined => {
    if (state === "CAR_SELECT") return x => x < .3 ? "previous-car" : x < .6 ? "next-car" : "continue";
    if (state === "TRACK_SELECT") return x => x < .3 ? "previous-track" : x < .6 ? "next-track" : "continue";
    return undefined;
  };
  const controller = new MenuController(menuOptions({
    tracks: [{ id: "club", name: "Club" }, { id: "coast", name: "Coast" }],
    createScene: state => {
      const action = actionsFor(state);
      if (action) return { screen: new UiScreenInstance(button("NOTHING", 0, 2)), actions: {}, pointerAction: action };
      if (state === "MAIN_MENU") return scene(["select-car"]);
      return undefined;
    },
  }));
  const input = new InputManager();
  const click = (x: number, y = .5) => {
    const frame = input.poll(0);
    controller.update(1 / 60, { driving: frame.driving, menu: { ...frame.menu, pointerClicked: true, pointerX: x, pointerY: y } });
  };
  click(.5);
  click(.05, .05);
  assert.equal(controller.getView().car?.id, "compact");
  click(.5);
  assert.equal(controller.getView().car?.id, "roadster");
  click(.1);
  assert.equal(controller.getView().car?.id, "compact");
  click(.9);
  assert.equal(controller.getView().state, "TRACK_SELECT");
  click(.5);
  assert.equal(controller.getView().track?.id, "coast");
  click(.9);
  assert.equal(controller.getView().state, "RACE_OPTIONS");
});
