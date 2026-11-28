import type { InputAction, InputFrame, InputManager } from "../input/inputManager";
import type { SpeedUnits } from "./hudModel";
import { UiScreenInstance, type UiDirection } from "./uiRuntime";

/**
 * Front-end screens, modelled on fr3.exe's `UI_MODULE_*` gameflow (gf_manag.c / gf_intrp.c).
 *
 * fr3.exe's DONE table (0x49b644) fixes the single-player order:
 * CAR_SELECT -> TRACK_SELECT -> RACE_OPTIONS -> race, and RACE_RESULTS (RCRES) -> RACE_END (RCEND).
 * BACK pops the module stack, except GAME_FLOW (GAMEF), whose BACK opens START.
 */
export type MenuState =
  | "START" | "MAIN_MENU"
  | "MODE_SELECT" | "CAR_SELECT" | "TRACK_SELECT" | "RACE_OPTIONS"
  | "OPTIONS" | "OPTIONS_GAME" | "OPTIONS_AUDIO" | "OPTIONS_DISPLAY" | "OPTIONS_CONTROLS"
  | "OPTIONS_CREDITS" | "OPTIONS_LANGUAGE"
  | "LOADING" | "IN_GAME" | "PAUSE" | "RESULTS" | "RACE_END";

/** The `.UI` script each state opens (`null` = drawn by code: the LOADING chaser and the race HUD). */
export const MENU_SCREEN_SCRIPTS: Readonly<Record<MenuState, string | null>> = {
  START: "UI/START.UI", // UI_MODULE_START
  MAIN_MENU: "UI/GAMEF.UI", // UI_MODULE_GAME_FLOW
  MODE_SELECT: "UI/CMODE.UI", // race type select (TXT_TITLE_RACE_MODE_SELECT)
  CAR_SELECT: "UI/CAR.UI", // UI_MODULE_CAR_SELECT
  TRACK_SELECT: "UI/TRACK.UI", // UI_MODULE_TRACK_SELECT
  RACE_OPTIONS: "UI/ROPT.UI", // UI_MODULE_RACE_OPTIONS
  OPTIONS: "UI/OPTS.UI", // UI_MODULE_OPTIONS
  OPTIONS_GAME: "UI/GMOPT.UI", // UI_MODULE_OPTIONS_GAME
  OPTIONS_AUDIO: "UI/AUDIO.UI", // UI_MODULE_OPTIONS_AUDIO
  OPTIONS_DISPLAY: "UI/DISP.UI", // UI_MODULE_OPTIONS_DISPLAY
  OPTIONS_CONTROLS: "UI/CTRLS.UI", // UI_MODULE_OPTIONS_CONTROLS_TYPE (ui_ctrls.c)
  OPTIONS_CREDITS: "UI/CRED.UI", // UI_MODULE_OPTIONS_CREDITS
  OPTIONS_LANGUAGE: "UI/LANG.UI", // UI_MODULE_LANGUAGE
  LOADING: null, // UI_MODULE_LOADING_RACE (0x4b7400 draws it directly)
  IN_GAME: null,
  PAUSE: "UI/PAUSE.UI", // UI_MODULE_PAUSE_OPTIONS_PLAYER_1
  RESULTS: "UI/RCRES.UI", // UI_MODULE_RACE_RESULTS
  RACE_END: "UI/RCEND.UI", // UI_MODULE_RACE_END
};

/** TITLE node text the exe sets from code, per screen. CAR_SELECT and TRACK_SELECT depend on the page. */
export const MENU_SCREEN_TITLES: Readonly<Partial<Record<MenuState, string>>> = {
  MAIN_MENU: "TXT_TITLE_MAIN_MENU",
  MODE_SELECT: "TXT_TITLE_RACE_MODE_SELECT",
  RACE_OPTIONS: "TXT_TITLE_RACE_SETTINGS",
  OPTIONS: "TXT_TITLE_OPTIONS",
  OPTIONS_GAME: "TXT_TITLE_OPTIONS_GAME",
  OPTIONS_AUDIO: "TXT_TITLE_OPTIONS_AUDIO",
  OPTIONS_DISPLAY: "TXT_TITLE_OPTIONS_DISPLAY",
  OPTIONS_CONTROLS: "TXT_TITLE_OPTIONS_CONTROL",
  OPTIONS_CREDITS: "TXT_TITLE_OPTIONS_CREDITS",
};

const OPTIONS_STATES: ReadonlySet<MenuState> = new Set<MenuState>([
  "OPTIONS", "OPTIONS_GAME", "OPTIONS_AUDIO", "OPTIONS_DISPLAY", "OPTIONS_CONTROLS", "OPTIONS_CREDITS",
  "OPTIONS_LANGUAGE",
]);
const RACE_SETUP_STATES: ReadonlySet<MenuState> = new Set<MenuState>([
  "MODE_SELECT", "CAR_SELECT", "TRACK_SELECT", "RACE_OPTIONS",
]);

export function isOptionsState(state: MenuState): boolean {
  return OPTIONS_STATES.has(state);
}

export interface MenuSettings {
  masterVolume: number;
  sfxVolume: number;
  engineVolume: number;
  /** AUDIO.UI SPEECH slider. */
  speechVolume: number;
  /** AUDIO.UI INGAMEMUSIC ("RACE MUSIC") slider. */
  raceMusicVolume: number;
  /** AUDIO.UI MENUMUSIC slider. */
  menuMusicVolume: number;
  /** DISP.UI SPEEDO. */
  speedUnits: SpeedUnits;
  /** GMOPT.UI GEARS. */
  transmission: "AUTO" | "MANUAL";
  /** GMOPT.UI SAVE (autosave). */
  autosave: boolean;
  /** DISP.UI TRACKMAP. */
  trackMap: boolean;
  /** DISP.UI POSSCREEN (POSN.UI position screen). */
  positionScreen: boolean;
  graphicsQuality: "LOW" | "MEDIUM" | "HIGH";
  fov: number;
  language: string;
}

export interface MenuCar {
  readonly id: string;
  readonly name: string;
  readonly liveries: readonly string[];
  /** Vehicle class shown on CAR.UI's GROUPWINDOW page. Two or more classes enable that page. */
  readonly group?: string;
  readonly ratings?: {
    speed: number; power: number; acceleration: number; handling: number; weight?: number; agility?: number;
  };
}

export interface MenuTrack {
  readonly id: string;
  readonly name: string;
  /** Track roster shown on TRACK.UI's GROUPWINDOW page. Two or more rosters enable that page. */
  readonly group?: string;
}

export type RaceMode = "RACING" | "RACING_BOOST";
export type RaceDifficulty = "EASY" | "MEDIUM" | "HARD";
export type RaceFieldType = "MIX" | "MATCH";

export interface RaceSetup {
  readonly trackId: string;
  readonly carId: string;
  readonly livery?: string;
  readonly laps: number;
  readonly difficulty: RaceDifficulty;
  readonly mode: RaceMode;
  readonly transmission: MenuSettings["transmission"];
  readonly opponentIds?: readonly string[];
  /** ROPT.UI OPPS: number of AI opponents. */
  readonly opponents?: number;
  /** ROPT.UI FIELD: opponents drive a mix of vehicles, or match the player's class. */
  readonly fieldType?: RaceFieldType;
  /** ROPT.UI CATCH_UP_BUTTON. */
  readonly catchUp?: boolean;
}

/** ROPT.UI values plus the race mode (CMODE.UI). */
export interface RaceOptions {
  readonly laps: number;
  readonly difficulty: RaceDifficulty;
  readonly mode: RaceMode;
  readonly opponents: number;
  readonly fieldType: RaceFieldType;
  readonly catchUp: boolean;
}

export interface RaceStanding {
  readonly carId: string;
  readonly carName: string;
  readonly totalSeconds: number | null;
  readonly bestLapSeconds: number | null;
  /** Finish gap to the winner, or an estimated gap for a racer still running on the lead lap. */
  readonly gapSeconds: number | null;
  /** False when the racer had not crossed the line when results froze (omitted = finished if `totalSeconds` set). */
  readonly finished?: boolean;
  /** Whole laps the unfinished racer still had to complete when results froze. */
  readonly lapsDown?: number;
}

export type MenuCommand =
  | { type: "LaunchRaceRequest"; requestId: number; setup: RaceSetup }
  | { type: "RestartRace"; requestId: number; setup: RaceSetup }
  | { type: "ResumeRace" }
  | { type: "QuitToMenu" }
  | { type: "CycleCamera" }
  | { type: "PlayUiSound"; sound: "move" | "confirm" | "back" }
  | { type: "SettingsChanged"; settings: Readonly<MenuSettings> }
  | { type: "TurntableCarRequest"; carId: string; livery?: string };

export type MenuAction =
  // GAMEF.UI
  | "quick-race" | "single-player" | "select-car" | "options"
  // CAR.UI / TRACK.UI / ROPT.UI / CMODE.UI
  | "previous-car" | "next-car" | "previous-livery" | "next-livery"
  | "previous-car-group" | "next-car-group"
  | "previous-track" | "next-track" | "previous-track-group" | "next-track-group"
  | "select-track" | "race-options" | "launch"
  // OPTS.UI hub
  | "options-game" | "options-audio" | "options-display" | "options-controls" | "options-credits"
  | "options-language"
  // CTRLS.UI
  | "reset-controls"
  // Generic: advance to the next screen in the flow (fr3's UI_MODULE_STATE_DONE), or go back.
  | "continue" | "back"
  // PAUSE.UI / RCRES.UI / RCEND.UI
  | "resume" | "restart" | "camera" | "quit" | "standings";

/** Values a focused row changes with left/right (ROPT LEFTARROW/RIGHTARROW, AUDIO sliders, GMOPT/DISP rows). */
export type MenuValueKey =
  | "car" | "livery" | "carGroup" | "track" | "trackGroup"
  | "laps" | "difficulty" | "mode" | "opponents" | "fieldType" | "catchUp"
  | "masterVolume" | "sfxVolume" | "engineVolume" | "speechVolume" | "raceMusicVolume" | "menuMusicVolume"
  | "speedUnits" | "transmission" | "autosave" | "trackMap" | "positionScreen" | "graphicsQuality" | "fov"
  | "language";

export type MenuSceneAction = MenuAction
  /** Apply settings on confirm/click, then optionally run `then` (e.g. LANG.UI buttons: `then: "back"`). */
  | { settings: Partial<MenuSettings>; then?: MenuAction }
  /** Apply race options on confirm/click, then optionally run `then` (e.g. CMODE buttons: `then: "continue"`). */
  | { raceOptions: Partial<RaceOptions>; then?: MenuAction }
  /** Left/right change the value; confirm/click steps it forward. */
  | { adjust: MenuValueKey }
  /** CAR.UI GROUPWINDOW class button: pick the class and open the car page. */
  | { carGroup: string }
  /** TRACK.UI GROUPWINDOW roster button: pick the roster and open the track page. */
  | { trackGroup: string };

export interface MenuScene {
  readonly screen: UiScreenInstance;
  readonly actions: Readonly<Partial<Record<string, MenuSceneAction>>>;
  /**
   * What left/right change when the focused node has no `adjust` action. Defaults: the car on CAR_SELECT's car
   * page, the track on TRACK_SELECT's track page, otherwise focus navigation. `null` forces focus navigation.
   */
  readonly horizontal?: MenuValueKey | null;
  update?(view: MenuView): void;
  /**
   * Pointer-only controls that are not UI_TYPE_BUTTONs (CAR.UI's CARNAME bar / COLOUR prompt / turntable,
   * TRACK.UI's TRACKNAME bar, AUDIO.UI's slider bars): the action for a click (UI space) that hit no button
   * with an action of its own.
   */
  pointerAction?(x: number, y: number): MenuSceneAction | undefined;
}

/** CAR.UI and TRACK.UI each have a GROUPWINDOW page (class/roster) and an item page (CARINFOWINDOW/TRACKINFOWINDOW). */
export type MenuSelectPage = "GROUP" | "ITEM";

export interface MenuView {
  readonly state: MenuState;
  /** The state this one was opened from (for exit animations); undefined at boot. */
  readonly previousState?: MenuState;
  /** `.UI` script for `state` (see MENU_SCREEN_SCRIPTS). */
  readonly screenPath: string | null;
  /** True for OPTS.UI and its sub-screens opened from PAUSE: show IN_GAME_DARK_STRIP, no background. */
  readonly inGameOptions: boolean;
  readonly car?: MenuCar;
  readonly track?: MenuTrack;
  readonly livery?: string;
  readonly carGroup?: string;
  readonly carGroups: readonly string[];
  readonly carSelectPage: MenuSelectPage;
  readonly trackGroup?: string;
  readonly trackGroups: readonly string[];
  readonly trackSelectPage: MenuSelectPage;
  readonly settings: Readonly<MenuSettings>;
  readonly raceOptions: Readonly<RaceOptions>;
  readonly progress: number;
  readonly standings: readonly RaceStanding[];
  readonly loadingError?: string;
}

type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

export interface MenuControllerOptions {
  readonly cars: readonly MenuCar[];
  readonly trackId: string;
  readonly tracks?: readonly MenuTrack[];
  readonly quickRaces?: readonly RaceSetup[];
  readonly languages: readonly string[];
  readonly storage?: SettingsStorage;
  readonly storageKey?: string;
  readonly input?: Pick<InputManager, "getBinding" | "setBinding"> & Partial<Pick<InputManager, "resetBindings">>;
  readonly createScene?: (state: MenuState, view: MenuView) => MenuScene | undefined;
}

const directions: readonly UiDirection[] = ["up", "down", "left", "right"];
const volumeKeys = [
  "masterVolume", "sfxVolume", "engineVolume", "speechVolume", "raceMusicVolume", "menuMusicVolume",
] as const;
const toggleKeys = ["autosave", "trackMap", "positionScreen"] as const;
const difficulties: readonly RaceDifficulty[] = ["EASY", "MEDIUM", "HARD"];
const modes: readonly RaceMode[] = ["RACING", "RACING_BOOST"];
const fieldTypes: readonly RaceFieldType[] = ["MIX", "MATCH"];
const qualities: readonly MenuSettings["graphicsQuality"][] = ["LOW", "MEDIUM", "HIGH"];
export const MAX_LAPS = 9;
export const MAX_OPPONENTS = 5;
const VOLUME_STEP = 0.1;
const FOV_STEP = 5;

const optionsSubScreens = [
  "options-game", "options-audio", "options-display", "options-controls", "options-credits", "options-language",
] as const;
const optionsSubScreenState: Record<(typeof optionsSubScreens)[number], MenuState> = {
  "options-game": "OPTIONS_GAME",
  "options-audio": "OPTIONS_AUDIO",
  "options-display": "OPTIONS_DISPLAY",
  "options-controls": "OPTIONS_CONTROLS",
  "options-credits": "OPTIONS_CREDITS",
  "options-language": "OPTIONS_LANGUAGE",
};
const optionsSubActions: readonly MenuAction[] = ["continue", "back"];

const allowedActions: Record<MenuState, readonly MenuAction[]> = {
  START: ["continue"],
  MAIN_MENU: ["quick-race", "single-player", "select-car", "options", "back"],
  MODE_SELECT: ["continue", "back"],
  CAR_SELECT: [
    "previous-car", "next-car", "previous-livery", "next-livery", "previous-car-group", "next-car-group",
    "previous-track", "next-track", "select-track", "race-options", "continue", "launch", "options", "back",
  ],
  TRACK_SELECT: [
    "previous-track", "next-track", "previous-track-group", "next-track-group", "race-options", "continue",
    "launch", "back",
  ],
  RACE_OPTIONS: ["launch", "continue", "back"],
  OPTIONS: [...optionsSubScreens, "back"],
  OPTIONS_GAME: optionsSubActions,
  OPTIONS_AUDIO: optionsSubActions,
  OPTIONS_DISPLAY: optionsSubActions,
  OPTIONS_CONTROLS: [...optionsSubActions, "reset-controls"],
  OPTIONS_CREDITS: optionsSubActions,
  OPTIONS_LANGUAGE: optionsSubActions,
  LOADING: ["back"],
  IN_GAME: [],
  PAUSE: ["resume", "restart", "camera", "options", "quit", "back"],
  RESULTS: ["continue", "restart", "quick-race", "select-car", "quit", "back"],
  RACE_END: ["standings", "restart", "quick-race", "select-car", "quit", "back"],
};

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? value as T : fallback;
}

function cycle<T>(options: readonly T[], current: T, delta: number): T {
  const index = Math.max(0, options.indexOf(current));
  return options[(index + delta + options.length * Math.abs(delta)) % options.length]!;
}

function wrapInt(value: number, min: number, max: number, delta: number): number {
  const span = max - min + 1;
  return min + ((((value - min + delta) % span) + span) % span);
}

function settingsStorage(storage?: SettingsStorage): SettingsStorage | undefined {
  try {
    return storage ?? globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function validateSettings(
  current: MenuSettings,
  values: Partial<MenuSettings>,
  languages: readonly string[],
): MenuSettings {
  const next = { ...current };
  for (const key of volumeKeys) next[key] = numberInRange(values[key], 0, 1, current[key]);
  for (const key of toggleKeys) if (typeof values[key] === "boolean") next[key] = values[key];
  next.fov = numberInRange(values.fov, 30, 120, current.fov);
  next.speedUnits = oneOf(values.speedUnits, ["MPH", "KPH"], current.speedUnits);
  next.transmission = oneOf(values.transmission, ["AUTO", "MANUAL"], current.transmission);
  next.graphicsQuality = oneOf(values.graphicsQuality, qualities, current.graphicsQuality);
  if (values.language !== undefined && languages.includes(values.language)) next.language = values.language;
  return next;
}

function validateRaceOptions(current: RaceOptions, values: Partial<RaceOptions>): RaceOptions {
  return {
    laps: Math.trunc(numberInRange(values.laps, 1, MAX_LAPS, current.laps)),
    difficulty: oneOf(values.difficulty, difficulties, current.difficulty),
    mode: oneOf(values.mode, modes, current.mode),
    opponents: Math.trunc(numberInRange(values.opponents, 0, MAX_OPPONENTS, current.opponents)),
    fieldType: oneOf(values.fieldType, fieldTypes, current.fieldType),
    catchUp: typeof values.catchUp === "boolean" ? values.catchUp : current.catchUp,
  };
}

/** Distinct `group` values in first-seen order; fewer than two disables the GROUP page. */
function groupsOf(items: readonly { group?: string }[]): string[] {
  const groups: string[] = [];
  for (const item of items) if (item.group !== undefined && !groups.includes(item.group)) groups.push(item.group);
  return groups.length >= 2 ? groups : [];
}

/** Step `index` to the next item sharing its group (all items when grouping is off). */
function stepInGroup(items: readonly { group?: string }[], index: number, delta: number, grouped: boolean): number {
  const group = items[index]?.group;
  const members = items.map((_, i) => i).filter(i => !grouped || items[i]!.group === group);
  if (members.length < 2) return index;
  const at = Math.max(0, members.indexOf(index));
  return members[wrapInt(at, 0, members.length - 1, delta)]!;
}

export class MenuController {
  private state: MenuState = "START";
  private previousState?: MenuState;
  /** Screens beneath the current one; BACK pops it (fr3's UI module stack). */
  private history: MenuState[] = [];
  private scene?: MenuScene;
  private settings: MenuSettings;
  private carIndex = 0;
  private trackIndex = 0;
  private liveryIndex = 0;
  private carPage: MenuSelectPage = "ITEM";
  private trackPage: MenuSelectPage = "ITEM";
  private readonly liveryOverrides = new Map<string, readonly string[]>();
  private readonly tracks: readonly MenuTrack[];
  private readonly carGroups: readonly string[];
  private readonly trackGroups: readonly string[];
  private quickRaceIndex = 0;
  private requestId = 0;
  private activeSetup?: RaceSetup;
  private loadingProgress = 0;
  private loadingError?: string;
  private standings: readonly RaceStanding[] = [];
  private raceOptions: RaceOptions = {
    laps: 3, difficulty: "MEDIUM", mode: "RACING", opponents: MAX_OPPONENTS, fieldType: "MIX", catchUp: false,
  };
  private readonly storage?: SettingsStorage;
  private readonly storageKey: string;
  private commands: MenuCommand[] = [];

  constructor(private readonly options: MenuControllerOptions) {
    this.tracks = options.tracks && options.tracks.length > 0
      ? options.tracks
      : [{ id: options.trackId, name: options.trackId }];
    const initialTrack = this.tracks.findIndex(t => t.id.toLowerCase() === options.trackId.toLowerCase());
    this.trackIndex = initialTrack >= 0 ? initialTrack : 0;
    this.carGroups = groupsOf(options.cars);
    this.trackGroups = groupsOf(this.tracks);
    this.storage = settingsStorage(options.storage);
    this.storageKey = options.storageKey ?? "racing.menu.settings.v1";
    this.settings = {
      masterVolume: 1, sfxVolume: 1, engineVolume: 1, speechVolume: 1, raceMusicVolume: 1, menuMusicVolume: 1,
      speedUnits: "MPH", transmission: "AUTO", autosave: true, trackMap: true, positionScreen: true,
      graphicsQuality: "HIGH", fov: 65, language: options.languages[0] ?? "en",
    };
    try {
      const value: unknown = JSON.parse(this.storage?.getItem(this.storageKey) ?? "null");
      if (value && typeof value === "object") {
        this.settings = validateSettings(this.settings, value, options.languages);
      }
    } catch {
      // Unavailable or malformed storage leaves the defaults in place.
    }
    this.open("START");
  }

  get screen(): UiScreenInstance | undefined {
    return this.scene?.screen;
  }

  rebuildScene(): void {
    this.open(this.state);
  }

  /**
   * Replace the selectable liveries of a car, e.g. collapsing placeholder liveries once its model shows it has
   * no texture variants. Keeps the current selection in range and refreshes the active scene.
   */
  setCarLiveries(carId: string, liveries: readonly string[]): boolean {
    const car = this.options.cars.find(c => c.id === carId);
    if (!car || !liveries.length) return false;
    const current = this.liveryOverrides.get(carId) ?? car.liveries;
    if (current.length === liveries.length && current.every((l, i) => l === liveries[i])) return false;
    this.liveryOverrides.set(carId, [...liveries]);
    if (this.options.cars[this.carIndex]?.id === carId && this.liveryIndex >= liveries.length) this.liveryIndex = 0;
    this.refreshScene();
    return true;
  }

  private carAt(index: number): MenuCar | undefined {
    const car = this.options.cars[index];
    const override = car && this.liveryOverrides.get(car.id);
    return car && override ? { ...car, liveries: override } : car;
  }

  getView(): MenuView {
    const car = this.carAt(this.carIndex);
    const track = this.tracks[this.trackIndex];
    return {
      state: this.state,
      previousState: this.previousState,
      screenPath: MENU_SCREEN_SCRIPTS[this.state],
      inGameOptions: isOptionsState(this.state) && this.history.includes("PAUSE"),
      car,
      track,
      livery: car?.liveries[this.liveryIndex],
      carGroup: this.carGroups.length ? car?.group : undefined,
      carGroups: [...this.carGroups],
      carSelectPage: this.carPage,
      trackGroup: this.trackGroups.length ? track?.group : undefined,
      trackGroups: [...this.trackGroups],
      trackSelectPage: this.trackPage,
      settings: { ...this.settings },
      raceOptions: { ...this.raceOptions },
      progress: this.loadingProgress,
      standings: this.standings.map(row => ({ ...row })),
      loadingError: this.loadingError,
    };
  }

  drainCommands(): MenuCommand[] {
    const commands = this.commands;
    this.commands = [];
    return commands;
  }

  update(dt: number, frame: InputFrame): void {
    this.screen?.update(dt);
    if (this.state === "IN_GAME") {
      if (frame.driving.pausePressed) this.reset("PAUSE");
      return;
    }

    const input = frame.menu;
    if (this.state === "START") {
      if (input.anyKey || input.pointerClicked || input.confirm) this.continueFromStart();
      return;
    }

    if (input.back) {
      this.activate("back");
      return;
    }
    if (this.state === "PAUSE" && frame.driving.pausePressed) {
      this.activate("resume");
      return;
    }

    const screen = this.screen;
    const focused = screen?.getFocusedId() ?? null;
    const horizontal = input.left ? -1 : input.right ? 1 : 0;
    const valueKey = horizontal ? this.horizontalKey(focused) : undefined;
    if (valueKey) {
      this.adjust(valueKey, horizontal);
    } else if (screen) {
      const direction = directions.find(key => input[key]);
      if (direction) screen.moveFocus(direction);
    }
    if (screen && input.pointerMoved) screen.pointerMove(input.pointerX, input.pointerY);
    if (screen && focused !== screen.getFocusedId()) this.commands.push({ type: "PlayUiSound", sound: "move" });

    if (input.pointerClicked) {
      const id = screen?.pointerClick(input.pointerX, input.pointerY);
      const action = (id ? this.scene?.actions[id] : undefined)
        ?? this.scene?.pointerAction?.(input.pointerX, input.pointerY);
      if (action) this.runSceneAction(action);
    } else if (input.confirm) {
      const id = screen?.getFocusedId();
      const action = id ? this.scene?.actions[id] : undefined;
      if (action) this.runSceneAction(action);
      else this.confirmDefault();
    }
  }

  continueFromStart(): void {
    if (this.state !== "START") return;
    this.commands.push({ type: "PlayUiSound", sound: "confirm" });
    this.reset("MAIN_MENU");
  }

  activate(action: MenuAction): boolean {
    if (!allowedActions[this.state].includes(action)) return false;
    if (this.state === "START") {
      this.continueFromStart();
      return true;
    }
    const sound = { type: "PlayUiSound", sound: action === "back" ? "back" : "confirm" } as const;
    const soundIndex = this.commands.length;
    switch (action) {
      case "quick-race": {
        const presets = this.options.quickRaces ?? [];
        const setup = presets[this.quickRaceIndex];
        if (!setup) return false;
        this.quickRaceIndex = (this.quickRaceIndex + 1) % presets.length;
        this.launch({ ...setup, transmission: this.settings.transmission }, false);
        break;
      }
      case "single-player":
        this.go("MODE_SELECT");
        break;
      case "select-car":
        if (!this.options.cars.length) return false;
        this.openCarSelect();
        break;
      case "previous-car":
      case "next-car":
        if (!this.adjust("car", action === "next-car" ? 1 : -1, false)) return false;
        break;
      case "previous-livery":
      case "next-livery":
        if (!this.adjust("livery", action === "next-livery" ? 1 : -1, false)) return false;
        break;
      case "previous-car-group":
      case "next-car-group":
        if (!this.adjust("carGroup", action === "next-car-group" ? 1 : -1, false)) return false;
        break;
      case "previous-track":
      case "next-track":
        if (!this.adjust("track", action === "next-track" ? 1 : -1, false)) return false;
        break;
      case "previous-track-group":
      case "next-track-group":
        if (!this.adjust("trackGroup", action === "next-track-group" ? 1 : -1, false)) return false;
        break;
      case "select-track":
        this.openTrackSelect();
        break;
      case "race-options":
        this.go("RACE_OPTIONS");
        break;
      case "continue":
        if (!this.continueFlow()) return false;
        break;
      case "launch": {
        const { car, track, livery } = this.getView();
        if (!car) return false;
        this.launch({
          trackId: track?.id ?? this.options.trackId, carId: car.id, livery,
          ...this.raceOptions, transmission: this.settings.transmission,
        }, false);
        break;
      }
      case "options":
        this.go("OPTIONS");
        break;
      case "options-game":
      case "options-audio":
      case "options-display":
      case "options-controls":
      case "options-credits":
      case "options-language":
        this.go(optionsSubScreenState[action]);
        break;
      case "reset-controls":
        if (!this.options.input?.resetBindings) return false;
        this.options.input.resetBindings();
        this.refreshScene();
        break;
      case "resume":
        this.resume();
        break;
      case "restart":
        if (!this.activeSetup) return false;
        this.launch(this.activeSetup, true);
        break;
      case "camera":
        this.commands.push({ type: "CycleCamera" });
        break;
      case "quit":
        this.releaseRace();
        this.reset("MAIN_MENU");
        break;
      case "standings":
        this.go("RESULTS");
        break;
      case "back":
        if (!this.back()) return false;
        break;
    }
    this.commands.splice(soundIndex, 0, sound);
    return true;
  }

  /**
   * Step a value by `delta` (left = -1, right = +1). Lists and enums wrap, volumes and FOV clamp, toggles flip.
   * Returns false (and plays nothing) when the value cannot change.
   */
  adjust(key: MenuValueKey, delta: number, playSound = true): boolean {
    const step = delta < 0 ? -1 : 1;
    const changed = this.applyAdjust(key, step);
    if (changed && playSound) this.commands.push({ type: "PlayUiSound", sound: "move" });
    return changed;
  }

  private applyAdjust(key: MenuValueKey, step: number): boolean {
    switch (key) {
      case "car": {
        const next = stepInGroup(this.options.cars, this.carIndex, step, this.carGroups.length > 0);
        if (next === this.carIndex) return false;
        this.carIndex = next;
        this.liveryIndex = 0;
        this.previewCar();
        return true;
      }
      case "livery": {
        const count = this.carAt(this.carIndex)?.liveries.length ?? 0;
        if (count < 2) return false;
        this.liveryIndex = wrapInt(this.liveryIndex, 0, count - 1, step);
        this.previewCar();
        return true;
      }
      case "carGroup": {
        if (!this.carGroups.length) return false;
        const group = cycle(this.carGroups, this.options.cars[this.carIndex]?.group, step);
        return this.selectCarGroup(group, false);
      }
      case "track": {
        const next = stepInGroup(this.tracks, this.trackIndex, step, this.trackGroups.length > 0);
        if (next === this.trackIndex) return false;
        this.trackIndex = next;
        this.refreshScene();
        return true;
      }
      case "trackGroup": {
        if (!this.trackGroups.length) return false;
        const group = cycle(this.trackGroups, this.tracks[this.trackIndex]?.group, step);
        return this.selectTrackGroup(group, false);
      }
      case "laps":
        return this.setRaceOptions({ laps: wrapInt(this.raceOptions.laps, 1, MAX_LAPS, step) });
      case "opponents":
        return this.setRaceOptions({ opponents: wrapInt(this.raceOptions.opponents, 0, MAX_OPPONENTS, step) });
      case "difficulty":
        return this.setRaceOptions({ difficulty: cycle(difficulties, this.raceOptions.difficulty, step) });
      case "mode":
        return this.setRaceOptions({ mode: cycle(modes, this.raceOptions.mode, step) });
      case "fieldType":
        return this.setRaceOptions({ fieldType: cycle(fieldTypes, this.raceOptions.fieldType, step) });
      case "catchUp":
        return this.setRaceOptions({ catchUp: !this.raceOptions.catchUp });
      case "masterVolume":
      case "sfxVolume":
      case "engineVolume":
      case "speechVolume":
      case "raceMusicVolume":
      case "menuMusicVolume": {
        const value = Math.round((this.settings[key] + step * VOLUME_STEP) * 100) / 100;
        return this.setSettings({ [key]: Math.max(0, Math.min(1, value)) });
      }
      case "fov":
        return this.setSettings({ fov: this.settings.fov + step * FOV_STEP });
      case "speedUnits":
        return this.setSettings({ speedUnits: cycle(["MPH", "KPH"] as const, this.settings.speedUnits, step) });
      case "transmission":
        return this.setSettings({
          transmission: cycle(["AUTO", "MANUAL"] as const, this.settings.transmission, step),
        });
      case "graphicsQuality":
        return this.setSettings({ graphicsQuality: cycle(qualities, this.settings.graphicsQuality, step) });
      case "autosave":
      case "trackMap":
      case "positionScreen":
        return this.setSettings({ [key]: !this.settings[key] });
      case "language":
        if (this.options.languages.length < 2) return false;
        return this.setSettings({ language: cycle(this.options.languages, this.settings.language, step) });
    }
  }

  updateSettings(values: Partial<MenuSettings>): void {
    this.settings = validateSettings(this.settings, values, this.options.languages);
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify(this.settings));
    } catch {
      // Settings still apply for the current session.
    }
    this.commands.push({ type: "SettingsChanged", settings: { ...this.settings } });
    this.refreshScene();
  }

  updateRaceOptions(options: Partial<RaceOptions>): void {
    this.raceOptions = validateRaceOptions(this.raceOptions, options);
    this.refreshScene();
  }

  getBinding(action: InputAction): readonly string[] {
    return this.options.input?.getBinding(action) ?? [];
  }

  setBinding(action: InputAction, codes: readonly string[]): void {
    this.options.input?.setBinding(action, codes);
    this.refreshScene();
  }

  /** True while `requestId` is still the active, unfailed LOADING request. */
  acceptsLoad(requestId: number): boolean {
    return this.isCurrentLoad(requestId) && this.loadingError === undefined;
  }

  setLoadProgress(requestId: number, progress: number): boolean {
    if (!this.acceptsLoad(requestId)) return false;
    this.loadingProgress = numberInRange(progress, this.loadingProgress, 1, this.loadingProgress);
    this.refreshScene();
    return true;
  }

  completeLoad(requestId: number): boolean {
    if (!this.acceptsLoad(requestId)) return false;
    this.loadingProgress = 1;
    this.reset("IN_GAME");
    return true;
  }

  failLoad(requestId: number, message: string): boolean {
    if (!this.acceptsLoad(requestId)) return false;
    this.loadingError = message;
    this.refreshScene();
    return true;
  }

  /** The race finished: show RCRES.UI (results); its DONE opens RCEND.UI (retry / exit). */
  finishRace(standings: readonly RaceStanding[]): boolean {
    if (this.state !== "IN_GAME") return false;
    this.standings = standings.map(row => ({ ...row }));
    this.reset("RESULTS");
    return true;
  }

  private open(state: MenuState): void {
    if (state !== this.state) this.previousState = this.state;
    this.state = state;
    this.scene = this.options.createScene?.(state, this.getView());
    this.refreshScene();
  }

  /** Open `state` on top of the current screen; BACK returns here. */
  private go(state: MenuState): void {
    this.history.push(this.state);
    this.open(state);
  }

  /** Open `state` as a new root (START, MAIN_MENU and the race screens). */
  private reset(state: MenuState): void {
    this.history = [];
    this.open(state);
  }

  private refreshScene(): void {
    this.scene?.update?.(this.getView());
  }

  private runSceneAction(action: MenuSceneAction): boolean {
    if (typeof action === "string") return this.activate(action);
    if ("adjust" in action) return this.adjust(action.adjust, 1);
    if ("carGroup" in action) return this.selectCarGroup(action.carGroup, true);
    if ("trackGroup" in action) return this.selectTrackGroup(action.trackGroup, true);
    if ("settings" in action) {
      if (this.state === "IN_GAME" || this.state === "LOADING") return false;
      this.commands.push({ type: "PlayUiSound", sound: "confirm" });
      this.updateSettings(action.settings);
    } else {
      if (!RACE_SETUP_STATES.has(this.state)) return false;
      this.commands.push({ type: "PlayUiSound", sound: "confirm" });
      this.updateRaceOptions(action.raceOptions);
    }
    if (action.then) this.activate(action.then);
    return true;
  }

  /** Confirm with nothing actionable focused: CAR/TRACK pages advance, RCRES continues to RCEND. */
  private confirmDefault(): void {
    if (this.state === "CAR_SELECT" || this.state === "TRACK_SELECT" || this.state === "MODE_SELECT"
      || this.state === "RESULTS") {
      this.activate("continue");
    } else if (this.state === "RACE_OPTIONS") {
      this.activate("launch");
    }
  }

  private horizontalKey(focused: string | null): MenuValueKey | undefined {
    const action = focused ? this.scene?.actions[focused] : undefined;
    if (action && typeof action === "object" && "adjust" in action) return action.adjust;
    if (this.scene?.horizontal !== undefined) return this.scene.horizontal ?? undefined;
    if (this.state === "CAR_SELECT" && this.carPage === "ITEM") return "car";
    if (this.state === "TRACK_SELECT" && this.trackPage === "ITEM") return "track";
    return undefined;
  }

  /** fr3's UI_MODULE_STATE_DONE for the current screen. */
  private continueFlow(): boolean {
    switch (this.state) {
      case "MODE_SELECT":
        if (!this.options.cars.length) return false;
        this.openCarSelect();
        return true;
      case "CAR_SELECT":
        if (this.carPage === "GROUP") return this.selectCarGroup(this.options.cars[this.carIndex]?.group, true);
        this.openTrackSelect();
        return true;
      case "TRACK_SELECT":
        if (this.trackPage === "GROUP") return this.selectTrackGroup(this.tracks[this.trackIndex]?.group, true);
        this.go("RACE_OPTIONS");
        return true;
      case "RACE_OPTIONS":
        return this.activate("launch");
      case "RESULTS":
        this.reset("RACE_END");
        return true;
      default:
        // Options sub-screens: DONE returns to the hub, like BACK.
        return isOptionsState(this.state) && this.back();
    }
  }

  private openCarSelect(): void {
    this.carPage = this.carGroups.length ? "GROUP" : "ITEM";
    if (this.state === "RESULTS" || this.state === "RACE_END") {
      this.releaseRace();
      this.history = ["MAIN_MENU"];
      this.open("CAR_SELECT");
    } else {
      this.go("CAR_SELECT");
    }
    this.previewCar();
  }

  private openTrackSelect(): void {
    this.trackPage = this.trackGroups.length ? "GROUP" : "ITEM";
    this.go("TRACK_SELECT");
  }

  /** Pick a class on CAR.UI's GROUPWINDOW (or cycle it) and keep the selected car inside that class. */
  private selectCarGroup(group: string | undefined, openItemPage: boolean): boolean {
    if (this.state !== "CAR_SELECT") return false;
    const cars = this.options.cars;
    if (this.carGroups.length && group !== undefined && cars[this.carIndex]?.group !== group) {
      const first = cars.findIndex(car => car.group === group);
      if (first < 0) return false;
      this.carIndex = first;
      this.liveryIndex = 0;
    }
    if (openItemPage) this.carPage = "ITEM";
    this.previewCar();
    return true;
  }

  /** Pick a roster on TRACK.UI's GROUPWINDOW (or cycle it) and keep the selected track inside that roster. */
  private selectTrackGroup(group: string | undefined, openItemPage: boolean): boolean {
    if (this.state !== "TRACK_SELECT") return false;
    if (this.trackGroups.length && group !== undefined && this.tracks[this.trackIndex]?.group !== group) {
      const first = this.tracks.findIndex(track => track.group === group);
      if (first < 0) return false;
      this.trackIndex = first;
    }
    if (openItemPage) this.trackPage = "ITEM";
    this.refreshScene();
    return true;
  }

  private setRaceOptions(values: Partial<RaceOptions>): boolean {
    const before = this.raceOptions;
    this.updateRaceOptions(values);
    return (Object.keys(values) as (keyof RaceOptions)[]).some(key => before[key] !== this.raceOptions[key]);
  }

  private setSettings(values: Partial<MenuSettings>): boolean {
    const next = validateSettings(this.settings, values, this.options.languages);
    if ((Object.keys(values) as (keyof MenuSettings)[]).every(key => next[key] === this.settings[key])) return false;
    this.updateSettings(values);
    return true;
  }

  private previewCar(): void {
    const { car, livery } = this.getView();
    if (car) this.commands.push({ type: "TurntableCarRequest", carId: car.id, livery });
    this.refreshScene();
  }

  private launch(setup: RaceSetup, restart: boolean): void {
    this.activeSetup = { ...setup, opponentIds: setup.opponentIds && [...setup.opponentIds] };
    this.standings = [];
    this.loadingProgress = 0;
    this.loadingError = undefined;
    const requestId = ++this.requestId;
    this.commands.push({
      type: restart ? "RestartRace" : "LaunchRaceRequest",
      requestId,
      setup: { ...this.activeSetup, opponentIds: this.activeSetup.opponentIds && [...this.activeSetup.opponentIds] },
    });
    this.reset("LOADING");
  }

  private isCurrentLoad(requestId: number): boolean {
    return this.state === "LOADING" && requestId === this.requestId;
  }

  private resume(): void {
    this.commands.push({ type: "ResumeRace" });
    this.reset("IN_GAME");
  }

  private releaseRace(): void {
    if (this.activeSetup) this.commands.push({ type: "QuitToMenu" });
    this.activeSetup = undefined;
    this.standings = [];
    this.loadingProgress = 0;
    this.loadingError = undefined;
  }

  private back(): boolean {
    switch (this.state) {
      case "MAIN_MENU":
        // fr3: BACK from UI_MODULE_GAME_FLOW opens UI_MODULE_START.
        this.reset("START");
        return true;
      case "CAR_SELECT":
        if (this.carPage === "ITEM" && this.carGroups.length) {
          this.carPage = "GROUP";
          this.refreshScene();
          return true;
        }
        break;
      case "TRACK_SELECT":
        if (this.trackPage === "ITEM" && this.trackGroups.length) {
          this.trackPage = "GROUP";
          this.refreshScene();
          return true;
        }
        break;
      case "PAUSE":
        this.resume();
        return true;
      case "LOADING":
        this.releaseRace();
        this.reset("MAIN_MENU");
        return true;
      case "RESULTS":
        // RCRES has only the continue prompt; Esc moves on to RCEND as well.
        this.reset("RACE_END");
        return true;
      case "RACE_END":
        // Esc on RCEND acts as EXIT.
        this.releaseRace();
        this.reset("MAIN_MENU");
        return true;
      case "START":
      case "IN_GAME":
        return false;
      default:
        break;
    }
    const previous = this.history.pop();
    if (previous === "PAUSE") {
      this.reset("PAUSE");
      return true;
    }
    if (previous) {
      this.open(previous);
      return true;
    }
    if (RACE_SETUP_STATES.has(this.state) || isOptionsState(this.state)) {
      this.reset("MAIN_MENU");
      return true;
    }
    return false;
  }
}
