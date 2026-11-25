import { AudioEngine, type CountdownStep, type EngineLayer, type EngineLayerRole, type TyreSurface } from "./audio/audioEngine.js";
import { DemoAssets, demoTrackDirectory } from "./demoAssets.js";
import type { ResolvedCarConfig } from "./formats/databases.js";
import type { PcgEntry } from "./formats/pcg.js";
import { lookupTranslation } from "./formats/tlate.js";
import { AiDriver, type AiObstacle, type CarControlOutput } from "./game/aiDriver.js";
import { CameraController, cameraPresetFromDefinition, type CameraMode, type CameraView } from "./game/cameraController.js";
import { RaceManager, type RaceMode, type RaceObservation, type RacePhase } from "./game/raceManager.js";
import { InputManager, type DrivingInput, type InputFrame } from "./input/inputManager.js";
import { clamp, mat4FromQuatTranslation } from "./math/mat4.js";
import { resolveCarCollision } from "./physics/collision.js";
import { TrackSpatial } from "./physics/trackSpatial.js";
import { VehiclePhysics } from "./physics/vehiclePhysics.js";
import { GlContext } from "./render/glContext.js";
import { SceneRenderer, type CarInstance, type CompiledModel, type ViewportRect } from "./render/sceneRenderer.js";
import { UiBatchBuilder, UiRenderer, type HudState, type UiColor } from "./render/uiRenderer.js";
import { formatRaceTime } from "./ui/hudModel.js";
import {
  MenuController, type MenuCar, type MenuCommand, type MenuScene, type MenuSceneAction,
  type MenuSettings, type MenuState, type MenuView, type RaceSetup, type RaceStanding,
} from "./ui/menuController.js";
import { UiScreenInstance } from "./ui/uiRuntime.js";

export interface EngineSnapshot {
  status: string;
  fps: number;
  running: boolean;
  state: MenuState;
  phase: RacePhase | null;
  carId: string | null;
  livery: string | null;
  speedMph: number;
  speedKph: number;
  gear: number;
  rpm: number;
  lap: number;
  laps: number;
  position: number;
  participants: number;
  boostCharges: number;
  boostActive: boolean;
  cameraMode: CameraMode;
  muted: boolean;
}

export interface EngineAppOptions {
  sound?: boolean;
  onStatus?: (status: string) => void;
  onError?: (error: Error) => void;
}

interface RacerSlot {
  id: string;
  carId: string;
  carName: string;
  isPlayer: boolean;
  config: ResolvedCarConfig;
  physics: VehiclePhysics;
  ai?: AiDriver;
  model: CompiledModel;
  lastGear: number;
  lastLap: number;
  lastBoostActive: boolean;
}

interface ActiveRace {
  setup: RaceSetup;
  trackModel: CompiledModel;
  spatial: TrackSpatial;
  race: RaceManager;
  racers: RacerSlot[];
  camera: CameraController;
  cameraView: CameraView;
  courseMap: readonly { x: number; z: number }[];
  lastCountdown?: CountdownStep;
  finishHoldTimer: number;
  finishedReported: boolean;
}

const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
const RACE_MODES: readonly RaceMode[] = ["RACING_BOOST", "RACING"];
const TURNTABLE_RECT: ViewportRect = { x: 0.04, y: 0.16, width: 0.56, height: 0.62 };

const PANEL_DARK: UiColor = [0.03, 0.06, 0.09, 0.86];
const PANEL_SCRIM: UiColor = [0.02, 0.04, 0.07, 0.68];
const PANEL_CARD: UiColor = [0.05, 0.10, 0.15, 0.92];
const ACCENT: UiColor = [0.99, 0.85, 0.32, 1];
const CYAN: UiColor = [0.24, 0.86, 0.82, 1];
const INK: UiColor = [0.91, 0.96, 0.99, 1];
const MUTED: UiColor = [0.62, 0.73, 0.81, 1];
const BAR_BG: UiColor = [0.12, 0.19, 0.25, 0.95];

const EMPTY_DRIVING: DrivingInput = {
  throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false,
  gearUpPressed: false, gearDownPressed: false, cameraNextPressed: false,
  lookBack: false, pausePressed: false, resetPressed: false, isAnalogSteer: false,
};

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function normalizeRgba(c: readonly [number, number, number, number]): UiColor {
  return [c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255];
}

function countdownLabelToStep(label: "3" | "2" | "1" | "GO!" | null): CountdownStep | undefined {
  if (label === "3") return 3;
  if (label === "2") return 2;
  if (label === "1") return 1;
  if (label === "GO!") return "GO";
  return undefined;
}

function surfaceToTyreSurface(surfaceName: string): TyreSurface {
  const s = surfaceName.toLowerCase();
  if (s.includes("grass")) return "grass";
  if (s.includes("gravel") || s.includes("stone")) return "gravel";
  if (s.includes("sand")) return "sand";
  if (s.includes("mud") || s.includes("dirt")) return "dirt";
  if (s.includes("snow") || s.includes("ice")) return "ice";
  if (s.includes("wet") || s.includes("stream")) return "wet";
  return "asphalt";
}

function computeCarRatings(cfg: ResolvedCarConfig): NonNullable<MenuCar["ratings"]> {
  const maxTorque = Math.max(100, ...cfg.engine.torque) * (cfg.engine.fields.TORQUE_MODIFIER ?? 1);
  const maxRpm = cfg.engine.fields.MAX_RPM ?? 6500;
  const peakPower = (maxTorque * maxRpm) / 5252000;
  const totalMass = Math.max(800, cfg.body.masses.reduce((s, m) => s + m.mass, 0) + (cfg.setup.ballast?.mass ?? 0));
  const grip = ((cfg.frontTyre.fields.ROAD_MAGIC_GRIP_NUMBER ?? 45) + (cfg.rearTyre.fields.ROAD_MAGIC_GRIP_NUMBER ?? 45)) * 0.5;
  return {
    speed: clamp((peakPower / 2.2) * 0.65 + (maxRpm / 9000) * 0.35, 0.18, 1),
    power: clamp(peakPower / 2.3, 0.15, 1),
    acceleration: clamp((peakPower / (totalMass / 1400)) / 2.0, 0.15, 1),
    handling: clamp((grip - 25) / 45, 0.2, 1),
  };
}

function formatCarDisplayName(assets: DemoAssets, cfg: ResolvedCarConfig): string {
  const enumKey = cfg.car.fields.INGAME_TEXT_ENUM;
  if (typeof enumKey === "string") {
    const localized = lookupTranslation(assets.translation, enumKey);
    if (localized) return localized;
  }
  return cfg.car.id.replaceAll("_", " ");
}

/** Complete playable WebGL2 Ford Racing 3 demo runtime (menus, 3D turntable, 6-car ENGAF race, HUD, audio). */
export class FordRacing3App {
  private readonly gl: GlContext;
  private readonly scene: SceneRenderer;
  private readonly ui: UiRenderer;
  private readonly audio: AudioEngine;
  private readonly input = new InputManager();
  private readonly menu: MenuController;
  private readonly view: Window;
  private readonly previousTabIndex: string | null;

  private readonly pcgCache = new Map<string, PcgEntry | null>();
  private readonly carConfigs = new Map<string, ResolvedCarConfig>();
  private readonly compiledModels = new Map<string, CompiledModel>();

  private turntableModel?: CompiledModel;
  private turntableKey = "";
  private turntableAngle = 0;
  private turntableRequest = 0;

  private activeRace?: ActiveRace;
  private trackSpatialCache?: TrackSpatial;
  private trackModelCache?: CompiledModel;
  private loadRequestSeq = 0;
  private audioLoaded = false;

  private frame?: number;
  private lastTime?: number;
  private clock = 0;
  private fps = 0;
  private status = "Initializing engine";
  private disposed = false;

  private overlayButtons: { rect: ViewportRect; label: string; active?: boolean; onClick: () => void }[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly assets: DemoAssets,
    private readonly options: EngineAppOptions = {},
  ) {
    const view = canvas.ownerDocument.defaultView;
    if (!view) throw new Error("The canvas requires a browser window");
    this.view = view;
    this.gl = new GlContext(canvas);
    try {
      this.scene = new SceneRenderer(this.gl);
      this.ui = new UiRenderer(this.gl);
    } catch (error) {
      this.gl.dispose();
      throw error;
    }
    this.audio = new AudioEngine({ unlockTarget: canvas });
    this.setMuted(options.sound === false);

    for (const cfg of assets.installedCars) {
      this.carConfigs.set(cfg.car.id, cfg);
    }

    const menuCars: MenuCar[] = assets.installedCars.map(cfg => ({
      id: cfg.car.id,
      name: formatCarDisplayName(assets, cfg),
      liveries: cfg.car.liveries.map(l => l.type),
      ratings: computeCarRatings(cfg),
    }));

    // Build Quick Race presets in fr3.exe's exact rotation order (QRACE_5 -> QRACE_6 -> QRACE_4 -> 1..3).
    const quickRaces: RaceSetup[] = assets.quickRaces
      .map(preset => {
        const player = preset.participants.find(p => p.control === "PLAYER_ACTIVE") ?? preset.participants[0];
        const opponents = preset.participants
          .filter(p => p !== player && this.carConfigs.has(p.carId))
          .map(p => p.carId);
        const carId = player && this.carConfigs.has(player.carId) ? player.carId : menuCars[0]!.id;
        return {
          trackId: preset.trackId || "ENGAF",
          carId,
          laps: Math.max(1, preset.laps || 2),
          difficulty: "MEDIUM" as const,
          mode: (preset.gameplayId === "RACING" ? "RACING" : "RACING_BOOST") as RaceMode,
          transmission: "AUTO" as const,
          opponentIds: opponents,
        };
      })
      .filter(p => this.carConfigs.has(p.carId));

    this.menu = new MenuController({
      cars: menuCars,
      trackId: "ENGAF",
      quickRaces,
      languages: assets.languages,
      input: this.input,
      createScene: (state, viewState) => this.buildScene(state, viewState),
    });

    this.previousTabIndex = canvas.getAttribute("tabindex");
    if (this.previousTabIndex === null) canvas.tabIndex = 0;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
  }

  async prepare(): Promise<void> {
    if (!this.assets.installedCars.length) throw new Error("No installed car models were found");
    this.setStatus("Loading interface graphics");
    await this.preloadCoreSprites();
    this.applySettings(this.menu.getView().settings);
    this.setStatus("Press any key or click to start");
  }

  start(): void {
    if (this.disposed || this.frame !== undefined || this.gl.gl.isContextLost()) return;
    this.input.attach(this.view, this.canvas);
    this.canvas.focus();
    this.frame = this.view.requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.frame !== undefined) this.view.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.lastTime = undefined;
    this.fps = 0;
    this.input.detach();
  }

  restart(): void {
    if (this.activeRace) {
      this.menu.activate("restart");
      this.processCommands();
      return;
    }
    this.start();
  }

  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
  }

  continueFromStart(): void {
    this.menu.continueFromStart();
    this.processCommands();
  }

  launchQuickRace(): void {
    if (this.menu.getView().state === "START") this.menu.continueFromStart();
    this.menu.activate("quick-race");
    this.processCommands();
  }

  launchCarRace(carId?: string): void {
    if (this.menu.getView().state === "START") this.menu.continueFromStart();
    if (carId && this.carConfigs.has(carId)) {
      const idx = this.assets.installedCars.findIndex(c => c.car.id === carId);
      if (idx >= 0) {
        if (this.menu.getView().state !== "CAR_SELECT") this.menu.activate("select-car");
        for (let i = 0; i < this.assets.installedCars.length; i++) {
          if (this.menu.getView().car?.id === carId) break;
          this.menu.activate("next-car");
        }
      }
    }
    if (this.menu.getView().state === "CAR_SELECT") this.menu.activate("launch");
    else this.menu.activate("quick-race");
    this.processCommands();
  }

  togglePause(): void {
    const st = this.menu.getView().state;
    if (st === "IN_GAME") {
      this.menu.update(0, {
        driving: { ...EMPTY_DRIVING, pausePressed: true },
        menu: { up: false, down: false, left: false, right: false, confirm: false, back: false, anyKey: false, pointerX: 0, pointerY: 0, pointerMoved: false, pointerClicked: false },
      });
      this.processCommands();
    } else if (st === "PAUSE") {
      this.menu.activate("resume");
      this.processCommands();
    }
  }

  cycleCamera(): void {
    this.activeRace?.camera.nextMode();
  }

  getSnapshot(): EngineSnapshot {
    const view = this.menu.getView();
    const race = this.activeRace;
    const player = race?.racers[0];
    const standing = race?.race.standings.find(s => s.isPlayer);
    return {
      status: this.status,
      fps: Math.round(this.fps),
      running: this.frame !== undefined,
      state: view.state,
      phase: race?.race.phase ?? null,
      carId: player?.carId ?? view.car?.id ?? null,
      livery: view.livery ?? null,
      speedMph: player?.physics.state.speedMph ?? 0,
      speedKph: player?.physics.state.speedKph ?? 0,
      gear: player?.physics.state.gear ?? 1,
      rpm: player?.physics.state.rpm ?? 0,
      lap: standing?.lap ?? 1,
      laps: race?.setup.laps ?? view.raceOptions.laps,
      position: standing?.place ?? 1,
      participants: race?.racers.length ?? 0,
      boostCharges: player?.physics.state.boostCharges ?? 0,
      boostActive: player?.physics.state.boostActive ?? false,
      cameraMode: race?.camera.mode ?? "CHASE_FAR",
      muted: this.audio.muted,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadRequestSeq++;
    this.turntableRequest++;
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    if (this.previousTabIndex === null) this.canvas.removeAttribute("tabindex");
    for (const model of this.compiledModels.values()) model.dispose();
    this.compiledModels.clear();
    this.trackModelCache?.dispose();
    this.trackModelCache = undefined;
    this.turntableModel = undefined;
    this.activeRace = undefined;
    this.ui.dispose();
    this.scene.dispose();
    this.gl.dispose();
    void this.audio.dispose();
  }

  private setStatus(status: string): void {
    this.status = status;
    this.options.onStatus?.(status);
  }

  private readonly onContextLost = (): void => {
    this.loadRequestSeq++;
    this.stop();
    this.setStatus("WebGL2 context lost");
    this.options.onError?.(new Error("WebGL2 context lost. Press Restart to reload."));
  };

  private async preloadCoreSprites(): Promise<void> {
    const refs = [
      "GRAPHICS\\GAME\\STARTUS.PSD",
      "GRAPHICS\\GAME\\BKGNDS\\GAMEF.PSD",
      "GRAPHICS\\GAME\\BKGNDS\\FORD.PSD",
      "GRAPHICS\\GAME\\BKGNDS\\49.PSD",
      "GRAPHICS\\GAME\\COMMON\\PAUSE.PSD",
      "GRAPHICS\\GAME\\COMMON\\RES_TOP.PSD",
      "GRAPHICS\\GAME\\COMMON\\LAUREL.PSD",
      "GRAPHICS\\GAME\\COMMON\\CHEQFLAG.PSD",
      "GRAPHICS\\GAME\\COMMON\\FORDRACE.PSD",
      "GRAPHICS\\GAME\\COMMON\\TITLEBAR.PSD",
    ];
    await Promise.all(refs.map(ref => this.cachePcg(ref)));
  }

  private async cachePcg(texturePath: string): Promise<PcgEntry | null> {
    const key = texturePath.toLowerCase();
    if (this.pcgCache.has(key)) return this.pcgCache.get(key) ?? null;
    try {
      const entry = (await this.assets.getPcgEntry(texturePath)) ?? null;
      this.pcgCache.set(key, entry);
      return entry;
    } catch {
      this.pcgCache.set(key, null);
      return null;
    }
  }

  private async loadSpcAudioOnce(): Promise<void> {
    if (this.audioLoaded || this.disposed) return;
    this.audioLoaded = true;
    const ready = await this.audio.resume();
    if (!ready || this.disposed) return;
    try {
      const [engBank, miscBank] = await Promise.all([
        this.assets.loadSpc("SND/ENGINE1.SPC").catch(() => null),
        this.assets.loadSpc("SND/misc.spc").catch(() => null),
      ]);
      if (this.disposed) return;
      if (engBank && engBank.entries.length > 0) {
        const roles: readonly EngineLayerRole[] = [
          "TICKOVER", "LOW_UNLOADED", "LOW_LOADED", "HIGH_UNLOADED", "HIGH_LOADED",
        ];
        const layers: EngineLayer[] = [];
        for (let i = 0; i < Math.min(engBank.entries.length, roles.length); i++) {
          const e = engBank.entries[i]!;
          const buffer = await this.audio.decodeWave(e.wave.riff);
          if (!buffer) continue;
          const smpl = e.wave.smplLoops[0];
          layers.push({
            role: roles[i]!,
            buffer,
            referenceRpm: 1200 + i * 1400,
            loop: smpl ? {
              loopStartFrame: smpl.startFrame,
              loopEndFrame: smpl.endFrameInclusive,
              sampleRate: e.wave.format.sampleRate,
            } : undefined,
          });
        }
        if (layers.length > 0) this.audio.setEngineBank({ layers });
      }
      if (miscBank) {
        for (const e of miscBank.entries) {
          const n = e.name.toLowerCase();
          if (!n.includes("skid") && !n.includes("crash")) continue;
          const buffer = await this.audio.decodeWave(e.wave.riff);
          if (!buffer) continue;
          if (n.includes("skid")) this.audio.setSkidSample({ buffer });
          else if (n.includes("crash")) this.audio.setEffectSample("collision", buffer);
        }
      }
    } catch {
      // Keep procedural audio fallback active cleanly.
    }
  }

  private buildScene(state: MenuState, view: MenuView): MenuScene | undefined {
    const loadScript = (path: string) => UiScreenInstance.load(path, {
      readFile: this.assets.readUiScript,
      translation: this.assets.translation,
      viewport: { width: 640, height: 480 },
    });

    if (state === "START") {
      const screen = loadScript("UI/START.UI");
      const pressKey = lookupTranslation(this.assets.translation, "TXT_PRESS_ANY_KEY") ?? "PRESS ANY KEY";
      screen.setNodeTextRaw("BUTTON1", pressKey);
      screen.setNodeTextRaw("VERSION", "NATIVE WEBGL2 ENGINE");
      return { screen, actions: {} };
    }

    if (state === "MAIN_MENU") {
      const screen = loadScript("UI/GAMEF.UI");
      const labels: [string, string, MenuSceneAction][] = [
        ["BUTTON1", "TXT_MENU_BUTTON_QUICKRACE", "quick-race"],
        ["BUTTON2", "TXT_MENU_BUTTON_SINGLE_PLAYER", "select-car"],
        ["BUTTON3", "TXT_MENU_BUTTON_OPTIONS", "options"],
      ];
      const actions: Record<string, MenuSceneAction> = {};
      for (const id of ["BUTTON1", "BUTTON2", "BUTTON3", "BUTTON4", "BUTTON5", "BUTTON6"]) {
        screen.setNodeVisible(id, false);
        screen.setNodeEnabled(id, false);
      }
      for (const [id, textKey, action] of labels) {
        screen.setNodeVisible(id, true);
        screen.setNodeEnabled(id, true);
        screen.setNodeText(id, textKey);
        actions[id] = action;
      }
      screen.setFocus("BUTTON1");
      return { screen, actions };
    }

    if (state === "PAUSE") {
      const screen = loadScript("UI/PAUSE.UI");
      for (const hide of ["EXITREPLAY", "RULES"]) {
        screen.setNodeVisible(hide, false);
        screen.setNodeEnabled(hide, false);
      }
      screen.setFocus("RESUME");
      return {
        screen,
        actions: {
          RESUME: "resume",
          RESTART: "restart",
          OPTIONS: "options",
          RETIRE: "quit",
          EXIT: "quit",
        },
      };
    }

    if (state === "OPTIONS") {
      const screen = loadScript("UI/OPTS.UI");
      for (const id of ["BUTTON1", "BUTTON2", "BUTTON3", "BUTTON4", "BUTTON5"]) {
        screen.setNodeVisible(id, false);
        screen.setNodeEnabled(id, false);
      }
      return { screen, actions: {} };
    }

    if (state === "CAR_SELECT") {
      const screen = loadScript("UI/CAR.UI");
      screen.setNodeTextRaw("CARNAME", view.car?.name ?? "");
      return {
        screen,
        actions: {},
        update: next => screen.setNodeTextRaw("CARNAME", next.car?.name ?? ""),
      };
    }

    if (state === "RESULTS" || state === "RACE_END") {
      const screen = loadScript("UI/RCRES.UI");
      return { screen, actions: {} };
    }

    return undefined;
  }

  private async getOrCompileModel(dir: string, livery?: string): Promise<CompiledModel> {
    const key = `${dir.toLowerCase()}::${(livery ?? "").toLowerCase()}`;
    const existing = this.compiledModels.get(key);
    if (existing && !existing.isDisposed) return existing;
    const bundle = await this.assets.load3dBundle(dir);
    const compiled = this.scene.compileModel(bundle.xbx, bundle.textures, bundle.binInfo, bundle.scene, { livery });
    this.compiledModels.set(key, compiled);
    return compiled;
  }

  private async loadTurntableCar(carId: string, livery?: string): Promise<void> {
    const cfg = this.carConfigs.get(carId);
    if (!cfg || this.disposed || this.gl.gl.isContextLost()) return;
    const key = `${cfg.shapeFolder}::${livery ?? ""}`;
    if (key === this.turntableKey && this.turntableModel && !this.turntableModel.isDisposed) return;
    const req = ++this.turntableRequest;
    this.setStatus(`Loading ${formatCarDisplayName(this.assets, cfg)}`);
    try {
      const model = await this.getOrCompileModel(cfg.shapeFolder, livery);
      if (req !== this.turntableRequest || this.disposed) return;
      this.turntableModel = model;
      this.turntableKey = key;
      this.setStatus(`Select Car: ${formatCarDisplayName(this.assets, cfg)}`);
    } catch (cause) {
      if (req === this.turntableRequest) this.options.onError?.(asError(cause));
    }
  }

  private applySettings(settings: Readonly<MenuSettings>): void {
    this.audio.setVolume("master", settings.masterVolume);
    this.audio.setVolume("sfx", settings.sfxVolume);
    this.audio.setVolume("engine", settings.engineVolume);
    if (settings.language !== this.assets.language && this.assets.languages.includes(settings.language)) {
      this.assets.setLanguage(settings.language);
      this.menu.rebuildScene();
    }
    if (this.activeRace) {
      this.activeRace.racers[0]!.physics.automatic = settings.transmission === "AUTO";
    }
  }

  private processCommands(): void {
    const commands = this.menu.drainCommands();
    for (const cmd of commands) {
      this.handleCommand(cmd);
    }
  }

  private handleCommand(cmd: MenuCommand): void {
    switch (cmd.type) {
      case "PlayUiSound":
        void this.loadSpcAudioOnce();
        this.audio.playMenu(cmd.sound === "move" ? "navigate" : cmd.sound);
        break;
      case "SettingsChanged":
        this.applySettings(cmd.settings);
        break;
      case "TurntableCarRequest":
        void this.loadTurntableCar(cmd.carId, cmd.livery);
        break;
      case "LaunchRaceRequest":
      case "RestartRace":
        void this.loadRace(cmd.requestId, cmd.setup);
        break;
      case "ResumeRace":
        this.setStatus("Racing on ENGAF");
        break;
      case "CycleCamera":
        this.activeRace?.camera.nextMode();
        break;
      case "QuitToMenu":
        this.activeRace = undefined;
        this.audio.update({ rpm: 0, speedMps: 0, tyreSlip: 0 });
        this.setStatus("Main menu");
        break;
    }
  }

  private async loadRace(requestId: number, setup: RaceSetup): Promise<void> {
    const seq = ++this.loadRequestSeq;
    this.setStatus("Loading ENGAF track and cars…");
    this.menu.setLoadProgress(requestId, 0.08);
    try {
      const trackBundle = await this.assets.load3dBundle(demoTrackDirectory);
      if (seq !== this.loadRequestSeq || this.disposed) return;
      this.menu.setLoadProgress(requestId, 0.35);

      if (!this.trackModelCache || this.trackModelCache.isDisposed) {
        this.trackModelCache = this.scene.compileModel(
          trackBundle.xbx, trackBundle.textures, trackBundle.binInfo, trackBundle.scene,
        );
      }
      if (!this.trackSpatialCache) {
        const defaultSurfaceName = this.assets.tables.tracks.get("engaf")?.DEFAULT_TRACK_SURFACE;
        this.trackSpatialCache = new TrackSpatial(
          trackBundle.xbx, trackBundle.scene, this.assets.tables.racingLine,
          { surfaces: this.assets.tables.surfaces, defaultSurfaceName },
        );
      }
      this.menu.setLoadProgress(requestId, 0.52);

      const playerCfg = this.carConfigs.get(setup.carId) ?? this.assets.installedCars[0]!;
      const opponentPool = (setup.opponentIds ?? []).filter(id => this.carConfigs.has(id));
      const fallbackPool = this.assets.installedCars
        .map(c => c.car.id)
        .filter(id => id !== playerCfg.car.id);
      const opponentIds: string[] = [];
      for (const id of [...opponentPool, ...fallbackPool]) {
        if (opponentIds.length >= 5) break;
        opponentIds.push(id);
      }

      const lineupCfgs = [playerCfg, ...opponentIds.map(id => this.carConfigs.get(id)!)];
      const models: CompiledModel[] = [];
      for (let i = 0; i < lineupCfgs.length; i++) {
        const cfg = lineupCfgs[i]!;
        const livery = i === 0
          ? (setup.livery ?? cfg.car.liveries[0]?.type)
          : cfg.car.liveries[i % Math.max(1, cfg.car.liveries.length)]?.type;
        models.push(await this.getOrCompileModel(cfg.shapeFolder, livery));
        if (seq !== this.loadRequestSeq || this.disposed) return;
        this.menu.setLoadProgress(requestId, 0.52 + ((i + 1) / lineupCfgs.length) * 0.42);
      }

      const spatial = this.trackSpatialCache;
      const racingLine = this.assets.tables.racingLine;
      const ground = (x: number, z: number) => {
        const p = spatial.queryProgress(x, z);
        const h = spatial.queryGround(x, p.point[1] + 4, z);
        return h.hit ? h.height : p.point[1];
      };

      const entrants = lineupCfgs.map((cfg, index) => ({
        id: index === 0 ? "player" : `ai-${index}`,
        carId: cfg.car.id,
        isPlayer: index === 0,
      }));
      const race = new RaceManager({
        line: racingLine,
        entrants,
        laps: setup.laps,
        mode: setup.mode,
        ground,
        startU: 0.02,
        introSeconds: 1.4,
      });

      const difficulty = this.assets.tables.game.difficulty[setup.difficulty];
      const trackDiff = this.assets.tables.tracks.get("engaf")?.difficulty[setup.difficulty];
      const automatic = setup.transmission === "AUTO";

      const racers: RacerSlot[] = lineupCfgs.map((cfg, index) => {
        const gridSlot = race.grid[index]!;
        const yaw = Math.atan2(gridSlot.forward[0], gridSlot.forward[2]);
        const physics = new VehiclePhysics(cfg, spatial, {
          position: [gridSlot.position[0], gridSlot.position[1] + 0.05, gridSlot.position[2]],
          yaw,
          automatic: index === 0 ? automatic : true,
        });
        const packSlot = ((index - 1) / 4) * 2 - 1;
        return {
          id: entrants[index]!.id,
          carId: cfg.car.id,
          carName: formatCarDisplayName(this.assets, cfg),
          isPlayer: index === 0,
          config: cfg,
          physics,
          ai: index === 0 ? undefined : new AiDriver(racingLine, {
            difficulty,
            trackScales: trackDiff,
            packSlot,
            mode: setup.mode,
          }),
          model: models[index]!,
          lastGear: physics.state.gear,
          lastLap: 1,
          lastBoostActive: false,
        };
      });

      const presets: Partial<Record<CameraMode, ReturnType<typeof cameraPresetFromDefinition>>> = {};
      const camDefs = this.assets.tables.cameras;
      if (camDefs[0]) presets.INTRO = cameraPresetFromDefinition("INTRO", camDefs[0]);
      if (camDefs[7]) presets.CHASE_FAR = cameraPresetFromDefinition("CHASE_FAR", camDefs[7]);
      if (camDefs[8]) presets.CHASE_NEAR = cameraPresetFromDefinition("CHASE_NEAR", camDefs[8]);
      if (camDefs[9]) presets.HOOD = cameraPresetFromDefinition("HOOD", camDefs[9]);
      if (camDefs[5]) presets.LOOK_BACK = cameraPresetFromDefinition("LOOK_BACK", camDefs[5]);
      const camera = new CameraController({ ground, presets });
      const ps = racers[0]!.physics.state;
      const gl = this.gl.gl;
      const aspect = gl.drawingBufferHeight > 0 ? gl.drawingBufferWidth / gl.drawingBufferHeight : 16 / 9;
      const cameraView = camera.update(0, {
        car: { position: ps.position, forward: ps.forward, rotation: ps.orientation, speed: ps.speedMps },
        aspect,
        phase: race.phase,
        phaseElapsed: race.phaseElapsed,
      });
      const courseMap = racingLine.points.map(pt => ({ x: pt.position[0], z: pt.position[2] }));

      this.activeRace = {
        setup,
        trackModel: this.trackModelCache,
        spatial,
        race,
        racers,
        camera,
        cameraView,
        courseMap,
        finishHoldTimer: 0,
        finishedReported: false,
      };
      this.menu.setLoadProgress(requestId, 1);
      this.menu.completeLoad(requestId);
      void this.loadSpcAudioOnce();
      this.setStatus(`Racing ${formatCarDisplayName(this.assets, playerCfg)} on ENGAF`);
    } catch (cause) {
      if (seq !== this.loadRequestSeq) return;
      const err = asError(cause);
      this.menu.failLoad(requestId, err.message);
      this.setStatus(`Load failed: ${err.message}`);
      this.options.onError?.(err);
    }
  }

  private readonly tick = (now: number): void => {
    const elapsed = this.lastTime === undefined ? 0 : (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (elapsed > 0) this.fps += (1 / elapsed - this.fps) * Math.min(elapsed * 6, 1);
    const dt = Math.min(elapsed, 0.05);
    this.clock += dt;

    try {
      const frame = this.input.poll(dt);
      const stateBefore = this.menu.getView().state;

      if (frame.menu.anyKey || frame.menu.pointerClicked) {
        void this.loadSpcAudioOnce();
      }

      if (stateBefore === "IN_GAME" && this.activeRace) {
        if (frame.driving.pausePressed) {
          this.menu.update(dt, frame);
          this.processCommands();
          this.audio.update({ rpm: 0, speedMps: 0, tyreSlip: 0 });
        } else {
          this.stepRace(dt, frame.driving);
        }
      } else {
        this.stepMenu(dt, frame);
      }

      this.render();
    } catch (cause) {
      this.stop();
      this.setStatus("Engine error");
      this.options.onError?.(asError(cause));
    }

    if (this.frame !== undefined) this.frame = this.view.requestAnimationFrame(this.tick);
  };

  private stepMenu(dt: number, frame: InputFrame): void {
    const view = this.menu.getView();
    if (view.state === "CAR_SELECT") {
      this.turntableAngle = (this.turntableAngle + dt * 0.6) % (2 * Math.PI);
    }

    if (frame.menu.pointerClicked && this.overlayButtons.length > 0) {
      const px = frame.menu.pointerX;
      const py = frame.menu.pointerY;
      for (const btn of this.overlayButtons) {
        if (px >= btn.rect.x && px <= btn.rect.x + btn.rect.width && py >= btn.rect.y && py <= btn.rect.y + btn.rect.height) {
          btn.onClick();
          this.audio.playMenu("confirm");
          this.processCommands();
          return;
        }
      }
    }

    if (view.state === "CAR_SELECT") {
      if (frame.menu.left) this.menu.activate("previous-car");
      else if (frame.menu.right) this.menu.activate("next-car");
      else if (frame.menu.up) this.menu.activate("previous-livery");
      else if (frame.menu.down) this.menu.activate("next-livery");
      else if (frame.menu.confirm) this.menu.activate("launch");
      else if (frame.menu.back) this.menu.activate("back");
      this.processCommands();
      return;
    }

    if (view.state === "OPTIONS") {
      if (frame.menu.back) {
        this.menu.activate("back");
        this.processCommands();
      }
      return;
    }

    if (view.state === "RESULTS" || view.state === "RACE_END") {
      if (frame.menu.confirm) this.menu.activate("restart");
      else if (frame.menu.back) this.menu.activate("quit");
      this.processCommands();
      return;
    }

    this.menu.update(dt, frame);
    this.processCommands();
  }

  private stepRace(dt: number, driving: DrivingInput): void {
    const active = this.activeRace;
    if (!active) return;

    const mobile = active.race.canMove;
    const playerSlot = active.racers[0]!;
    const racingLine = this.assets.tables.racingLine;
    const playerStand = active.race.standings.find(s => s.isPlayer);
    const playerProgressTotal = playerStand?.progress ?? 0;

    const tracks = active.racers.map(r => {
      const p = active.spatial.queryProgress(r.physics.state.position[0], r.physics.state.position[2]);
      return { u: p.interpolant, lateralOffset: p.lateralOffset, speed: r.physics.state.speedMps };
    });

    const observations: RaceObservation[] = [];

    for (let i = 0; i < active.racers.length; i++) {
      const r = active.racers[i]!;
      const tr = tracks[i]!;
      const st = r.physics.state;
      const standing = active.race.standings.find(s => s.id === r.id);

      let ctrl: DrivingInput;
      if (!mobile) {
        ctrl = {
          ...EMPTY_DRIVING,
          throttle: r.isPlayer ? driving.throttle : 0.45,
          brake: 1,
          handbrake: true,
        };
      } else if (r.isPlayer && active.race.phase !== "FINISHED") {
        ctrl = driving;
      } else {
        const ai = r.ai ?? (r.ai = new AiDriver(racingLine, {
          difficulty: this.assets.tables.game.difficulty[active.setup.difficulty],
          mode: active.setup.mode,
        }));
        const obstacles: AiObstacle[] = tracks
          .filter((_, idx) => idx !== i)
          .map(o => ({ u: o.u, lateralOffset: o.lateralOffset, speed: o.speed }));
        const referenceGap = ((standing?.progress ?? 0) - playerProgressTotal) * racingLine.length;
        const aiOut = ai.update(dt, {
          car: {
            position: st.position,
            forward: st.forward,
            rotation: st.orientation,
            speed: st.speedMps,
            blocked: st.lastImpactImpulse > 400 && st.speedMps < 1.5,
          },
          track: { u: tr.u, lateralOffset: tr.lateralOffset },
          obstacles,
          referenceGap,
          boostCharges: st.boostCharges,
          boostActive: st.boostActive,
        });
        let finalOut: CarControlOutput = aiOut;
        if (r.isPlayer) {
          finalOut = active.race.finishControl({
            throttle: driving.throttle,
            brake: driving.brake,
            steer: driving.steer,
            handbrake: driving.handbrake,
            boost: false,
            powerMultiplier: 1,
            driveDirection: 1,
          }, aiOut);
        }
        ctrl = {
          ...EMPTY_DRIVING,
          throttle: finalOut.throttle,
          brake: finalOut.brake,
          steer: finalOut.steer,
          handbrake: finalOut.handbrake,
          boost: finalOut.boost,
          isAnalogSteer: true,
        };
      }

      r.physics.step(dt, ctrl);

      if (!mobile) {
        const gridSlot = active.race.grid[i]!;
        r.physics.setPose(
          [gridSlot.position[0], gridSlot.position[1] + 0.05, gridSlot.position[2]],
          Math.atan2(gridSlot.forward[0], gridSlot.forward[2]),
        );
      }

      const after = r.physics.state;
      const prog = active.spatial.queryProgress(after.position[0], after.position[2]);
      observations.push({
        id: r.id,
        car: { position: after.position, forward: after.forward, rotation: after.orientation, speed: after.speedMps },
        track: { u: prog.interpolant, lateralOffset: prog.lateralOffset },
      });
    }

    if (mobile) {
      for (let a = 0; a < active.racers.length; a++) {
        for (let b = a + 1; b < active.racers.length; b++) {
          const impulse = resolveCarCollision(active.racers[a]!.physics, active.racers[b]!.physics);
          if (impulse > 150 && (a === 0 || b === 0)) {
            this.audio.playCollision(impulse);
          }
        }
      }
    }

    active.race.update(dt, observations);

    const step = countdownLabelToStep(active.race.countdownLabel);
    if (step !== active.lastCountdown && step !== undefined) {
      active.lastCountdown = step;
      this.audio.playCountdown(step);
    }

    for (const s of active.race.standings) {
      const slot = active.racers.find(r => r.id === s.id);
      if (slot && s.lap > slot.lastLap) {
        slot.lastLap = s.lap;
        if (active.setup.mode === "RACING_BOOST") {
          slot.physics.replenishBoost(s.completedLaps, active.setup.laps);
        }
      }
    }

    const ps = playerSlot.physics.state;
    if (ps.gear !== playerSlot.lastGear && mobile) {
      this.audio.playGearShift();
    }
    playerSlot.lastGear = ps.gear;
    if (ps.boostActive && !playerSlot.lastBoostActive) {
      this.audio.playBoost();
    }
    playerSlot.lastBoostActive = ps.boostActive;
    if (ps.lastImpactImpulse > 150) {
      this.audio.playCollision(ps.lastImpactImpulse);
    }

    const maxSlip = Math.max(...ps.wheels.map(w => Math.abs(w.slipRatio) + Math.abs(w.slipAngle) * 0.6));
    const surface = surfaceToTyreSurface(ps.wheels.find(w => w.grounded)?.surfaceName ?? "tarmac");
    this.audio.update({
      rpm: ps.rpm,
      idleRpm: playerSlot.config.engine.fields.TICKOVER_RPM ?? 1000,
      redlineRpm: ps.redlineRpm,
      throttle: ps.throttle,
      speedMps: ps.speedMps,
      tyreSlip: mobile ? clamp((maxSlip - 0.18) * 1.4, 0, 1) : 0,
      surface,
    });

    const gl = this.gl.gl;
    const aspect = gl.drawingBufferHeight > 0 ? gl.drawingBufferWidth / gl.drawingBufferHeight : 16 / 9;
    active.cameraView = active.camera.update(dt, {
      car: { position: ps.position, forward: ps.forward, rotation: ps.orientation, speed: ps.speedMps },
      aspect,
      phase: active.race.phase,
      phaseElapsed: active.race.phaseElapsed,
      cameraNextPressed: driving.cameraNextPressed,
      lookBack: driving.lookBack,
    });

    if (active.race.phase === "FINISHED" && !active.finishedReported) {
      active.finishHoldTimer += dt;
      if (active.finishHoldTimer >= 2.2) {
        active.finishedReported = true;
        const standings = active.race.standings;
        const leaderTime = standings[0]?.finishTime ?? null;
        const resultRows: RaceStanding[] = standings.map(s => {
          const racer = active.racers.find(r => r.id === s.id);
          return {
            carId: s.carId,
            carName: racer?.carName ?? s.carId,
            totalSeconds: s.finishTime ?? s.totalRaceTime,
            bestLapSeconds: s.bestLapTime,
            gapSeconds: leaderTime !== null && s.finishTime !== null ? Math.max(0, s.finishTime - leaderTime) : null,
          };
        });
        this.menu.finishRace(resultRows);
        this.audio.update({ rpm: 0, speedMps: 0, tyreSlip: 0 });
        this.setStatus("Race finished");
      }
    }
  }

  private render(): void {
    const gl = this.gl.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (!width || !height || gl.isContextLost()) return;

    const view = this.menu.getView();
    const inRaceRender = this.activeRace !== undefined
      && (view.state === "IN_GAME" || view.state === "PAUSE" || view.state === "RESULTS" || view.state === "RACE_END");

    if (inRaceRender && this.activeRace) {
      this.renderRace3d(this.activeRace, width, height);
    } else {
      gl.viewport(0, 0, width, height);
      gl.clearColor(0.03, 0.05, 0.08, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    if (view.state === "IN_GAME" && this.activeRace) {
      this.renderRaceHud(this.activeRace, view.settings, width, height);
      return;
    }

    this.renderMenuUi(view, width, height);
  }

  private renderRace3d(active: ActiveRace, width: number, height: number): void {
    const camView = active.cameraView;
    const carInstances: CarInstance[] = [];
    for (let i = 0; i < active.racers.length; i++) {
      const r = active.racers[i]!;
      if (i === 0 && !camView.showPlayerCar) continue;
      const st = r.physics.state;
      const ground = active.spatial.queryGround(st.position[0], st.position[1] + 1.5, st.position[2]);
      const avgSpin = (st.wheels[0].spinAngle + st.wheels[1].spinAngle + st.wheels[2].spinAngle + st.wheels[3].spinAngle) * 0.25;
      const avgAngVel = Math.max(...st.wheels.map(w => Math.abs(w.angularVel)));
      carInstances.push({
        model: r.model,
        transform: mat4FromQuatTranslation(st.orientation, st.position),
        wheelSpeed: avgAngVel,
        wheelSpin: avgSpin,
        steeringAngle: st.steerAngleRad,
        headlights: (this.assets.tables.trackConfig.CAR_HEADLIGHT_STRENGTH ?? 0) > 0.1,
        braking: st.brake > 0.1,
        reversing: st.gear < 0,
        exhaust: st.boostActive,
        groundY: ground.hit ? ground.height : st.position[1] - 0.3,
      });
    }
    this.scene.renderScene(
      camView.viewMatrix,
      camView.projMatrix,
      active.trackModel,
      carInstances,
      this.assets.tables.fog ?? undefined,
      { x: 0, y: 0, width, height },
    );
  }

  private renderRaceHud(active: ActiveRace, settings: Readonly<MenuSettings>, width: number, height: number): void {
    const player = active.racers[0]!;
    const ps = player.physics.state;
    const standings = active.race.standings;
    const playerStanding = standings.find(s => s.isPlayer) ?? standings[0]!;

    const hudState: HudState = {
      speedMps: ps.speedMps,
      speedUnit: settings.speedUnits,
      rpm: ps.rpm,
      redlineRpm: ps.redlineRpm,
      gear: ps.gear,
      boost: ps.boostActive ? ps.boostTimer / 7 : 0,
      boostCharges: ps.boostCharges,
      maxBoostCharges: 2,
      position: playerStanding.place,
      participants: active.racers.length,
      lap: playerStanding.lap,
      laps: active.setup.laps,
      lapTime: playerStanding.lapTime,
      bestTime: playerStanding.bestLapTime ?? undefined,
      totalTime: active.race.elapsedRaceTime,
      countdown: countdownLabelToStep(active.race.countdownLabel),
      wrongWay: playerStanding.wrongWay,
      map: {
        course: active.courseMap,
        player: { x: ps.position[0], z: ps.position[2] },
        opponents: active.racers.slice(1).map(r => ({ x: r.physics.state.position[0], z: r.physics.state.position[2] })),
      },
    };

    const bodyFont = this.assets.fonts[2] ?? this.assets.fonts[0]!;
    const displayFont = this.assets.fonts[4] ?? this.assets.fonts[0]!;
    this.ui.renderHud(hudState, width, height, { body: bodyFont, display: displayFont });
  }

  private renderMenuUi(view: MenuView, width: number, height: number): void {
    const batch = new UiBatchBuilder(width, height);
    const fonts = this.assets.fonts;
    const fontFor = (slot: number) => fonts[slot] ?? fonts[2] ?? fonts[0]!;
    this.overlayButtons = [];

    if (view.state === "PAUSE" || view.state === "RESULTS" || view.state === "RACE_END") {
      batch.solidQuad({ x: 0, y: 0, width: 1, height: 1 }, PANEL_SCRIM);
    }

    const activeScreen = this.menu.screen;
    if (activeScreen) {
      const items = activeScreen.getDrawItems();
      for (const item of items) {
        if (item.textureRef) {
          const entry = this.pcgCache.get(item.textureRef.registeredKey)
            ?? this.pcgCache.get(item.textureRef.registeredKey.replaceAll("/", "\\"));
          if (entry) {
            batch.graphic(item.rect, entry, {
              colour: normalizeRgba(item.color),
              flipGraphic: item.flip,
            });
          } else {
            void this.cachePcg(item.textureRef.registeredKey);
          }
        }
        if (item.text) {
          const font = fontFor(item.font);
          let color = normalizeRgba(item.textColor);
          if (view.state === "START" && item.id === "BUTTON1") {
            const pulse = 0.55 + 0.45 * Math.sin(this.clock * 4);
            color = [color[0], color[1], color[2], color[3] * pulse];
          }
          if (item.highlighted && item.buttonId && view.state !== "START") {
            batch.solidQuad(
              { x: item.rect.x, y: item.rect.y, width: Math.min(item.rect.width, 1 - item.rect.x), height: item.rect.height },
              [0.08, 0.22, 0.34, 0.72],
            );
          }
          batch.text(
            {
              x: item.rect.x + item.justifyOffset[0],
              y: item.rect.y + item.justifyOffset[1],
              width: item.rect.width,
              height: item.rect.height,
            },
            font,
            item.text,
            {
              justify: item.textJustify,
              wordWrap: item.wordWrap,
              colour: color,
              scale: 1,
              shadow: true,
            },
          );
        }
      }
    }

    if (view.state === "CAR_SELECT") {
      this.ui.render(batch.build(), width, height);
      batch.clear();
      if (this.turntableModel && !this.turntableModel.isDisposed) {
        this.scene.renderCarTurntable(this.turntableModel, this.turntableAngle, TURNTABLE_RECT, width, height);
      }
      this.drawCarSelectOverlay(batch, view);
    } else if (view.state === "OPTIONS") {
      this.drawOptionsOverlay(batch, view);
    } else if (view.state === "LOADING") {
      this.drawLoadingOverlay(batch, view);
    } else if (view.state === "RESULTS" || view.state === "RACE_END") {
      this.drawResultsOverlay(batch, view);
    }

    this.ui.render(batch.build(), width, height);
  }

  private addButton(
    batch: UiBatchBuilder,
    rect: ViewportRect,
    label: string,
    onClick: () => void,
    scale: number,
    accent = false,
  ): void {
    const font = this.assets.fonts[2] ?? this.assets.fonts[0]!;
    batch.solidQuad(rect, accent ? [0.14, 0.46, 0.34, 0.94] : [0.08, 0.15, 0.22, 0.92]);
    batch.text(rect, font, label, {
      justify: 0,
      colour: accent ? ACCENT : INK,
      scale,
      shadow: true,
    });
    this.overlayButtons.push({ rect, label, active: accent, onClick });
  }

  private drawCarSelectOverlay(batch: UiBatchBuilder, view: MenuView): void {
    const fTitle = this.assets.fonts[3] ?? this.assets.fonts[0]!;
    const fBody = this.assets.fonts[2] ?? this.assets.fonts[0]!;
    const s = 0.78;

    batch.solidQuad({ x: 0, y: 0, width: 1, height: 0.11 }, PANEL_DARK);
    batch.text({ x: 0.04, y: 0.02, width: 0.65, height: 0.07 }, fTitle, view.car?.name ?? "SELECT CAR", {
      justify: 1, colour: ACCENT, scale: s * 1.15,
    });
    batch.text({ x: 0.68, y: 0.02, width: 0.28, height: 0.07 }, fBody, "TRACK: ENGLAND A (ENGAF)", {
      justify: 2, colour: CYAN, scale: s * 0.9,
    });

    const px = 0.63;
    const pw = 0.33;
    batch.solidQuad({ x: px, y: 0.15, width: pw, height: 0.68 }, PANEL_CARD);
    const ratings = view.car?.ratings ?? { speed: 0.5, power: 0.5, acceleration: 0.5, handling: 0.5 };
    const statRows: [string, number][] = [
      ["TOP SPEED", ratings.speed],
      ["POWER", ratings.power],
      ["ACCEL", ratings.acceleration],
      ["HANDLING", ratings.handling],
    ];
    statRows.forEach(([label, val], idx) => {
      const y = 0.18 + idx * 0.075;
      batch.text({ x: px + 0.02, y, width: pw - 0.04, height: 0.03 }, fBody, label, {
        justify: 1, colour: MUTED, scale: s * 0.8,
      });
      batch.solidQuad({ x: px + 0.02, y: y + 0.032, width: pw - 0.04, height: 0.022 }, BAR_BG);
      batch.solidQuad({ x: px + 0.02, y: y + 0.032, width: (pw - 0.04) * clamp(val, 0.05, 1), height: 0.022 }, CYAN);
    });

    const { difficulty, laps, mode } = view.raceOptions;
    const tx = view.settings.transmission;
    this.addButton(batch, { x: px + 0.02, y: 0.50, width: pw - 0.04, height: 0.055 }, `MODE: ${mode.replace("_", " ")}`, () => {
      const next = RACE_MODES[(RACE_MODES.indexOf(mode) + 1) % RACE_MODES.length]!;
      this.menu.updateRaceOptions({ mode: next });
    }, s * 0.85);
    this.addButton(batch, { x: px + 0.02, y: 0.565, width: pw - 0.04, height: 0.055 }, `DIFFICULTY: ${difficulty}`, () => {
      const next = DIFFICULTIES[(DIFFICULTIES.indexOf(difficulty) + 1) % DIFFICULTIES.length]!;
      this.menu.updateRaceOptions({ difficulty: next });
    }, s * 0.85);
    this.addButton(batch, { x: px + 0.02, y: 0.63, width: pw - 0.04, height: 0.055 }, `LAPS: ${laps}`, () => {
      this.menu.updateRaceOptions({ laps: laps >= 9 ? 1 : laps + 1 });
    }, s * 0.85);
    this.addButton(batch, { x: px + 0.02, y: 0.695, width: pw - 0.04, height: 0.055 }, `GEARS: ${tx}`, () => {
      this.menu.updateSettings({ transmission: tx === "AUTO" ? "MANUAL" : "AUTO" });
    }, s * 0.85);
    this.addButton(batch, { x: px + 0.02, y: 0.76, width: pw - 0.04, height: 0.055 }, `LIVERY: ${view.livery ?? "DEFAULT"}`, () => {
      this.menu.activate("next-livery");
    }, s * 0.85);

    this.addButton(batch, { x: 0.04, y: 0.86, width: 0.14, height: 0.08 }, "< PREV CAR", () => this.menu.activate("previous-car"), s * 0.9);
    this.addButton(batch, { x: 0.20, y: 0.86, width: 0.14, height: 0.08 }, "NEXT CAR >", () => this.menu.activate("next-car"), s * 0.9);
    this.addButton(batch, { x: 0.36, y: 0.86, width: 0.14, height: 0.08 }, "BACK", () => this.menu.activate("back"), s * 0.9);
    this.addButton(batch, { x: 0.63, y: 0.86, width: 0.33, height: 0.08 }, "START RACE (ENTER)", () => this.menu.activate("launch"), s * 1.0, true);
  }

  private drawOptionsOverlay(batch: UiBatchBuilder, view: MenuView): void {
    const fTitle = this.assets.fonts[3] ?? this.assets.fonts[0]!;
    const s = 0.80;
    const st = view.settings;
    batch.solidQuad({ x: 0.16, y: 0.14, width: 0.68, height: 0.72 }, PANEL_CARD);
    batch.text({ x: 0.20, y: 0.17, width: 0.60, height: 0.07 }, fTitle, "OPTIONS", {
      justify: 0, colour: ACCENT, scale: s * 1.15,
    });

    this.addButton(batch, { x: 0.22, y: 0.27, width: 0.56, height: 0.07 }, `SPEED UNITS: ${st.speedUnits}`, () => {
      this.menu.updateSettings({ speedUnits: st.speedUnits === "MPH" ? "KPH" : "MPH" });
    }, s * 0.9);
    this.addButton(batch, { x: 0.22, y: 0.36, width: 0.56, height: 0.07 }, `TRANSMISSION: ${st.transmission}`, () => {
      this.menu.updateSettings({ transmission: st.transmission === "AUTO" ? "MANUAL" : "AUTO" });
    }, s * 0.9);
    this.addButton(batch, { x: 0.22, y: 0.45, width: 0.56, height: 0.07 }, `SOUND: ${this.audio.muted ? "OFF" : "ON"} (${Math.round(st.masterVolume * 100)}%)`, () => {
      this.setMuted(!this.audio.muted);
    }, s * 0.9);
    this.addButton(batch, { x: 0.22, y: 0.54, width: 0.56, height: 0.07 }, `LANGUAGE: ${st.language}`, () => {
      const langs = this.assets.languages;
      const next = langs[(langs.indexOf(st.language) + 1) % langs.length] ?? "EN";
      this.menu.updateSettings({ language: next });
    }, s * 0.9);
    this.addButton(batch, { x: 0.30, y: 0.72, width: 0.40, height: 0.08 }, "BACK (ESC)", () => this.menu.activate("back"), s * 0.95, true);
  }

  private drawLoadingOverlay(batch: UiBatchBuilder, view: MenuView): void {
    const fTitle = this.assets.fonts[3] ?? this.assets.fonts[0]!;
    const fBody = this.assets.fonts[2] ?? this.assets.fonts[0]!;
    const s = 0.82;
    batch.solidQuad({ x: 0.14, y: 0.34, width: 0.72, height: 0.30 }, PANEL_CARD);
    batch.text({ x: 0.18, y: 0.38, width: 0.64, height: 0.07 }, fTitle, "LOADING RACE…", {
      justify: 0, colour: ACCENT, scale: s * 1.1,
    });
    batch.solidQuad({ x: 0.20, y: 0.49, width: 0.60, height: 0.045 }, BAR_BG);
    batch.solidQuad({ x: 0.20, y: 0.49, width: 0.60 * clamp(view.progress, 0.02, 1), height: 0.045 }, CYAN);
    batch.text({ x: 0.18, y: 0.56, width: 0.64, height: 0.05 }, fBody, view.loadingError ?? this.status, {
      justify: 0, colour: INK, scale: s * 0.85,
    });
  }

  private drawResultsOverlay(batch: UiBatchBuilder, view: MenuView): void {
    const fTitle = this.assets.fonts[3] ?? this.assets.fonts[0]!;
    const fBody = this.assets.fonts[2] ?? this.assets.fonts[0]!;
    const s = 0.78;

    batch.solidQuad({ x: 0.10, y: 0.10, width: 0.80, height: 0.78 }, PANEL_CARD);
    batch.text({ x: 0.14, y: 0.13, width: 0.72, height: 0.07 }, fTitle, "RACE RESULTS — ENGAF", {
      justify: 0, colour: ACCENT, scale: s * 1.15,
    });

    view.standings.slice(0, 6).forEach((row, idx) => {
      const y = 0.23 + idx * 0.075;
      batch.solidQuad({ x: 0.14, y, width: 0.72, height: 0.062 }, idx === 0 ? [0.14, 0.27, 0.22, 0.9] : [0.06, 0.11, 0.16, 0.88]);
      const timeStr = row.totalSeconds !== null ? (formatRaceTime(row.totalSeconds) ?? "--:--.--") : "--:--.--";
      const bestStr = row.bestLapSeconds !== null ? `BEST ${formatRaceTime(row.bestLapSeconds)}` : "";
      batch.text({ x: 0.16, y, width: 0.40, height: 0.062 }, fBody, `${idx + 1}. ${row.carName}`, {
        justify: 1, colour: idx === 0 ? ACCENT : INK, scale: s * 0.88,
      });
      batch.text({ x: 0.56, y, width: 0.28, height: 0.062 }, fBody, `${timeStr}  ${bestStr}`, {
        justify: 2, colour: CYAN, scale: s * 0.82,
      });
    });

    this.addButton(batch, { x: 0.14, y: 0.76, width: 0.22, height: 0.08 }, "RETRY RACE", () => this.menu.activate("restart"), s * 0.9, true);
    this.addButton(batch, { x: 0.39, y: 0.76, width: 0.22, height: 0.08 }, "NEXT QUICK RACE", () => this.menu.activate("quick-race"), s * 0.85);
    this.addButton(batch, { x: 0.64, y: 0.76, width: 0.22, height: 0.08 }, "MAIN MENU", () => this.menu.activate("quit"), s * 0.9);
  }
}
