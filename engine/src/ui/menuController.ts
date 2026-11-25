import type { InputAction, InputFrame, InputManager } from "../input/inputManager";
import type { SpeedUnits } from "./hudModel";
import { UiScreenInstance, type UiDirection } from "./uiRuntime";

export type MenuState =
  | "START" | "MAIN_MENU" | "CAR_SELECT" | "OPTIONS" | "LOADING"
  | "IN_GAME" | "PAUSE" | "RACE_END" | "RESULTS";

export interface MenuSettings {
  masterVolume: number;
  sfxVolume: number;
  engineVolume: number;
  speedUnits: SpeedUnits;
  transmission: "AUTO" | "MANUAL";
  graphicsQuality: "LOW" | "MEDIUM" | "HIGH";
  fov: number;
  language: string;
}

export interface MenuCar {
  readonly id: string;
  readonly name: string;
  readonly liveries: readonly string[];
  readonly ratings?: { speed: number; power: number; acceleration: number; handling: number };
}

export interface RaceSetup {
  readonly trackId: string;
  readonly carId: string;
  readonly livery?: string;
  readonly laps: number;
  readonly difficulty: "EASY" | "MEDIUM" | "HARD";
  readonly mode: "RACING" | "RACING_BOOST";
  readonly transmission: MenuSettings["transmission"];
  readonly opponentIds?: readonly string[];
}

export interface RaceStanding {
  readonly carId: string;
  readonly carName: string;
  readonly totalSeconds: number | null;
  readonly bestLapSeconds: number | null;
  readonly gapSeconds: number | null;
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
  | "quick-race" | "select-car" | "previous-car" | "next-car"
  | "previous-livery" | "next-livery" | "launch" | "options"
  | "back" | "resume" | "restart" | "camera" | "quit" | "standings";

export type MenuSceneAction = MenuAction
  | { settings: Partial<MenuSettings> }
  | { raceOptions: Partial<MenuView["raceOptions"]> };

export interface MenuScene {
  readonly screen: UiScreenInstance;
  readonly actions: Readonly<Partial<Record<string, MenuSceneAction>>>;
  update?(view: MenuView): void;
}

export interface MenuView {
  readonly state: MenuState;
  readonly car?: MenuCar;
  readonly livery?: string;
  readonly settings: Readonly<MenuSettings>;
  readonly raceOptions: Readonly<Pick<RaceSetup, "difficulty" | "laps" | "mode">>;
  readonly progress: number;
  readonly standings: readonly RaceStanding[];
  readonly loadingError?: string;
}

type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

export interface MenuControllerOptions {
  readonly cars: readonly MenuCar[];
  readonly trackId: string;
  readonly quickRaces?: readonly RaceSetup[];
  readonly languages: readonly string[];
  readonly storage?: SettingsStorage;
  readonly storageKey?: string;
  readonly input?: Pick<InputManager, "getBinding" | "setBinding">;
  readonly createScene?: (state: MenuState, view: MenuView) => MenuScene | undefined;
}

const directions: readonly UiDirection[] = ["up", "down", "left", "right"];
const volumeKeys = ["masterVolume", "sfxVolume", "engineVolume"] as const;
const allowedActions: Record<MenuState, readonly MenuAction[]> = {
  START: [],
  MAIN_MENU: ["quick-race", "select-car", "options"],
  CAR_SELECT: ["previous-car", "next-car", "previous-livery", "next-livery", "launch", "options", "back"],
  OPTIONS: ["back"],
  LOADING: ["back"],
  IN_GAME: [],
  PAUSE: ["resume", "restart", "camera", "options", "quit", "back"],
  RACE_END: ["standings", "restart", "quick-race", "select-car", "quit", "back"],
  RESULTS: ["restart", "quick-race", "select-car", "quit", "back"],
};

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
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
  next.fov = numberInRange(values.fov, 30, 120, current.fov);
  if (values.speedUnits === "MPH" || values.speedUnits === "KPH") next.speedUnits = values.speedUnits;
  if (values.transmission === "AUTO" || values.transmission === "MANUAL") next.transmission = values.transmission;
  if (values.graphicsQuality === "LOW" || values.graphicsQuality === "MEDIUM" || values.graphicsQuality === "HIGH") {
    next.graphicsQuality = values.graphicsQuality;
  }
  if (values.language !== undefined && languages.includes(values.language)) next.language = values.language;
  return next;
}

export class MenuController {
  private state: MenuState = "START";
  private scene?: MenuScene;
  private settings: MenuSettings;
  private optionsReturn: MenuState = "MAIN_MENU";
  private carIndex = 0;
  private liveryIndex = 0;
  private quickRaceIndex = 0;
  private requestId = 0;
  private activeSetup?: RaceSetup;
  private loadingProgress = 0;
  private loadingError?: string;
  private standings: readonly RaceStanding[] = [];
  private raceOptions: MenuView["raceOptions"] = { laps: 3, difficulty: "MEDIUM", mode: "RACING" };
  private readonly storage?: SettingsStorage;
  private readonly storageKey: string;
  private commands: MenuCommand[] = [];

  constructor(private readonly options: MenuControllerOptions) {
    this.storage = settingsStorage(options.storage);
    this.storageKey = options.storageKey ?? "racing.menu.settings.v1";
    this.settings = {
      masterVolume: 1, sfxVolume: 1, engineVolume: 1, speedUnits: "MPH",
      transmission: "AUTO", graphicsQuality: "HIGH", fov: 65, language: options.languages[0] ?? "en",
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

  getView(): MenuView {
    const car = this.options.cars[this.carIndex];
    return {
      state: this.state,
      car,
      livery: car?.liveries[this.liveryIndex],
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
      if (frame.driving.pausePressed) this.open("PAUSE");
      return;
    }

    const input = frame.menu;
    if (this.state === "START") {
      if (input.anyKey || input.pointerClicked || input.confirm) this.continueFromStart();
      return;
    }

    const screen = this.screen;
    if (input.back) {
      this.activate("back");
      return;
    }
    if (!screen) return;

    const oldFocus = screen.getFocusedId();
    const direction = directions.find(key => input[key]);
    if (direction) screen.moveFocus(direction);
    if (input.pointerMoved) screen.pointerMove(input.pointerX, input.pointerY);
    if (oldFocus !== screen.getFocusedId()) this.commands.push({ type: "PlayUiSound", sound: "move" });

    const id = input.pointerClicked ? screen.pointerClick(input.pointerX, input.pointerY)
      : input.confirm ? screen.getFocusedId() : null;
    if (!id) return;
    const action = this.scene?.actions[id];
    if (typeof action === "string") {
      this.activate(action);
    } else if (action && this.state === "OPTIONS" && "settings" in action) {
      this.commands.push({ type: "PlayUiSound", sound: "confirm" });
      this.updateSettings(action.settings);
    } else if (action && this.state === "CAR_SELECT" && "raceOptions" in action) {
      this.commands.push({ type: "PlayUiSound", sound: "confirm" });
      this.updateRaceOptions(action.raceOptions);
    }
  }

  continueFromStart(): void {
    if (this.state !== "START") return;
    this.commands.push({ type: "PlayUiSound", sound: "confirm" });
    this.open("MAIN_MENU");
  }

  activate(action: MenuAction): boolean {
    if (!allowedActions[this.state].includes(action)) return false;
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
      case "select-car":
        if (!this.options.cars.length) return false;
        if (this.state === "RACE_END" || this.state === "RESULTS") this.releaseRace();
        this.open("CAR_SELECT");
        this.previewCar();
        break;
      case "previous-car":
      case "next-car": {
        const count = this.options.cars.length;
        this.carIndex = (this.carIndex + (action === "next-car" ? 1 : -1) + count) % count;
        this.liveryIndex = 0;
        this.previewCar();
        break;
      }
      case "previous-livery":
      case "next-livery": {
        const count = this.options.cars[this.carIndex]?.liveries.length ?? 0;
        if (count < 2) return false;
        this.liveryIndex = (this.liveryIndex + (action === "next-livery" ? 1 : -1) + count) % count;
        this.previewCar();
        break;
      }
      case "launch": {
        const { car, livery } = this.getView();
        if (!car) return false;
        this.launch({
          trackId: this.options.trackId, carId: car.id, livery,
          ...this.raceOptions, transmission: this.settings.transmission,
        }, false);
        break;
      }
      case "options":
        this.optionsReturn = this.state;
        this.open("OPTIONS");
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
        this.open("MAIN_MENU");
        break;
      case "standings":
        this.open("RESULTS");
        break;
      case "back":
        if (!this.back()) return false;
        break;
    }
    this.commands.splice(soundIndex, 0, sound);
    return true;
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

  updateRaceOptions(options: Partial<MenuView["raceOptions"]>): void {
    const current = this.raceOptions;
    const { difficulty, mode } = options;
    this.raceOptions = {
      laps: Math.trunc(numberInRange(options.laps, 1, 9, current.laps)),
      difficulty: difficulty === "EASY" || difficulty === "MEDIUM" || difficulty === "HARD"
        ? difficulty : current.difficulty,
      mode: mode === "RACING" || mode === "RACING_BOOST" ? mode : current.mode,
    };
    this.refreshScene();
  }

  getBinding(action: InputAction): readonly string[] {
    return this.options.input?.getBinding(action) ?? [];
  }

  setBinding(action: InputAction, codes: readonly string[]): void {
    this.options.input?.setBinding(action, codes);
    this.refreshScene();
  }

  setLoadProgress(requestId: number, progress: number): boolean {
    if (!this.isCurrentLoad(requestId) || this.loadingError !== undefined) return false;
    this.loadingProgress = numberInRange(progress, this.loadingProgress, 1, this.loadingProgress);
    this.refreshScene();
    return true;
  }

  completeLoad(requestId: number): boolean {
    if (!this.isCurrentLoad(requestId) || this.loadingError !== undefined) return false;
    this.loadingProgress = 1;
    this.open("IN_GAME");
    return true;
  }

  failLoad(requestId: number, message: string): boolean {
    if (!this.isCurrentLoad(requestId) || this.loadingError !== undefined) return false;
    this.loadingError = message;
    this.refreshScene();
    return true;
  }

  finishRace(standings: readonly RaceStanding[]): boolean {
    if (this.state !== "IN_GAME") return false;
    this.standings = standings.map(row => ({ ...row }));
    this.open("RACE_END");
    return true;
  }

  private open(state: MenuState): void {
    this.state = state;
    this.scene = this.options.createScene?.(state, this.getView());
    this.refreshScene();
  }

  private refreshScene(): void {
    this.scene?.update?.(this.getView());
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
    this.open("LOADING");
  }

  private isCurrentLoad(requestId: number): boolean {
    return this.state === "LOADING" && requestId === this.requestId;
  }

  private resume(): void {
    this.commands.push({ type: "ResumeRace" });
    this.open("IN_GAME");
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
      case "CAR_SELECT":
        this.open("MAIN_MENU");
        return true;
      case "OPTIONS":
        this.open(this.optionsReturn);
        return true;
      case "PAUSE":
        this.resume();
        return true;
      case "LOADING":
        this.releaseRace();
        this.open("MAIN_MENU");
        return true;
      case "RACE_END":
        this.open("RESULTS");
        return true;
      case "RESULTS":
        this.open("RACE_END");
        return true;
      default:
        return false;
    }
  }
}
