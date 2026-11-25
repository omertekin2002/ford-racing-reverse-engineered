import { AudioEngine } from "./audio/audioEngine.js";
import { DemoAssets, demoTrackDirectory } from "./demoAssets.js";
import { InputManager } from "./input/inputManager.js";
import { lookAtLH, perspectiveLH, type Vec3 } from "./math/mat4.js";
import { GlContext } from "./render/glContext.js";
import { SceneRenderer, type CompiledModel, type ViewportRect } from "./render/sceneRenderer.js";
import { UiBatchBuilder, UiRenderer, type UiColor } from "./render/uiRenderer.js";

const preview = { x: 0, y: 0.105, width: 1, height: 0.79 };
const controls = [
  { label: "PREV", key: "previous" },
  { label: "NEXT", key: "next" },
  { label: "LIVERY", key: "livery" },
  { label: "TRACK / CAR", key: "track" },
] as const;
type InspectorAction = typeof controls[number]["key"];

export interface InspectorSnapshot {
  status: string;
  fps: number;
  running: boolean;
  model: string | null;
  livery: string | null;
  triangles: number;
  muted: boolean;
}

interface InspectorOptions {
  sound?: boolean;
  onStatus?: (status: string) => void;
  onError?: (error: Error) => void;
}

interface Selection {
  carIndex: number;
  liveryIndex: number;
  track: boolean;
}
interface DisplayedModel {
  model: CompiledModel;
  label: string;
  livery: string | null;
  track: boolean;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** Inspect models from a local asset set in a standalone WebGL2 view. */
export class FordRacing3App {
  private readonly gl: GlContext;
  private readonly scene: SceneRenderer;
  private readonly ui: UiRenderer;
  private readonly audio: AudioEngine;
  private readonly input = new InputManager();
  private readonly view: Window;
  private readonly previousTabIndex: string | null;
  private selection: Selection = { carIndex: 0, liveryIndex: 0, track: false };
  private displayed?: DisplayedModel;
  private request = 0;
  private frame?: number;
  private lastTime?: number;
  private angle = 0;
  private fps = 0;
  private cursor = -1;
  private status = "Preparing model inspector";
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly assets: DemoAssets,
    private readonly options: InspectorOptions = {},
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
    this.setMuted(options.sound !== true);
    this.previousTabIndex = canvas.getAttribute("tabindex");
    if (this.previousTabIndex === null) canvas.tabIndex = 0;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
  }

  async prepare(): Promise<void> {
    if (!this.assets.installedCars.length) throw new Error("No installed car models were found");
    await this.select(this.selection);
  }

  start(): void {
    if (this.disposed || this.frame !== undefined || this.gl.gl.isContextLost()) return;
    this.input.attach(this.canvas, this.canvas);
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
    this.angle = 0;
    this.start();
  }

  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
  }

  getSnapshot(): InspectorSnapshot {
    return {
      status: this.status,
      fps: this.fps,
      running: this.frame !== undefined,
      model: this.displayed?.label ?? null,
      livery: this.displayed?.livery ?? null,
      triangles: (this.displayed?.model.geometry.indices.length ?? 0) / 3,
      muted: this.audio.muted,
    };
  }

  async inspectCar(carIndex: number, liveryIndex = 0): Promise<void> {
    const car = this.assets.installedCars[carIndex];
    if (!car || !Number.isInteger(carIndex)) throw new RangeError("Car index is out of range");
    if (!Number.isInteger(liveryIndex) || liveryIndex < 0 || liveryIndex >= Math.max(1, car.car.liveries.length)) {
      throw new RangeError("Livery index is out of range");
    }
    await this.select({ carIndex, liveryIndex, track: false });
  }

  async inspectTrack(): Promise<void> {
    await this.select({ ...this.selection, track: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.request++;
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    if (this.previousTabIndex === null) this.canvas.removeAttribute("tabindex");
    this.ui.dispose();
    this.scene.dispose();
    this.gl.dispose();
    this.displayed = undefined;
    void this.audio.dispose();
  }

  private setStatus(status: string): void {
    this.status = status;
    this.options.onStatus?.(status);
  }

  private async select(selection: Selection): Promise<void> {
    if (this.disposed || this.gl.gl.isContextLost()) throw new Error("Model inspector is unavailable");
    const request = ++this.request;
    this.selection = selection;
    const car = this.assets.installedCars[selection.carIndex]!;
    const label = selection.track ? "ENGAF" : car.car.id;
    const livery = selection.track ? undefined : car.car.liveries[selection.liveryIndex];
    this.setStatus(`Loading ${label}`);
    try {
      const { xbx, textures, binInfo, scene } = await this.assets.load3dBundle(
        selection.track ? demoTrackDirectory : car.shapeFolder,
      );
      if (request !== this.request || this.gl.gl.isContextLost()) return;
      const model = this.scene.compileModel(xbx, textures, binInfo, scene, { livery: livery?.type });
      this.displayed?.model.dispose();
      this.displayed = { model, label, livery: livery?.stem ?? null, track: selection.track };
      this.angle = 0;
    } catch (cause) {
      if (request !== this.request) return;
      this.setStatus(`Could not load ${label}`);
      throw asError(cause);
    }
    this.setStatus(`Inspecting ${label}`);
  }

  private activate(key: InspectorAction): void {
    const { carIndex, liveryIndex, track } = this.selection;
    const count = this.assets.installedCars.length;
    const liveries = this.assets.installedCars[carIndex]?.car.liveries.length || 1;
    let load: Promise<void>;
    switch (key) {
      case "previous":
        load = this.inspectCar((carIndex + count - 1) % count);
        break;
      case "next":
        load = this.inspectCar((carIndex + 1) % count);
        break;
      case "livery":
        load = this.inspectCar(carIndex, (liveryIndex + 1) % liveries);
        break;
      case "track":
        load = track ? this.inspectCar(carIndex, liveryIndex) : this.inspectTrack();
        break;
    }
    void load.catch(error => this.options.onError?.(asError(error)));
    if (!this.audio.muted) void this.audio.resume().then(ready => {
      if (ready && !this.disposed) this.audio.playMenu("navigate");
    });
  }

  private readonly onContextLost = (): void => {
    this.request++;
    this.stop();
    this.setStatus("WebGL2 context lost");
    this.options.onError?.(new Error("WebGL2 context lost. Mount the inspector again to continue."));
  };

  private readonly tick = (now: number): void => {
    const elapsed = this.lastTime === undefined ? 0 : (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (elapsed > 0) this.fps += (1 / elapsed - this.fps) * Math.min(elapsed * 6, 1);
    const dt = Math.min(elapsed, 0.1);
    this.angle = (this.angle + dt * (this.displayed?.track ? 0.22 : 0.55)) % (2 * Math.PI);

    try {
      const { menu } = this.input.poll(dt);
      if (menu.pointerMoved || menu.pointerClicked) {
        this.cursor = menu.pointerY >= 0.895 ? Math.min(controls.length - 1, Math.floor(menu.pointerX * controls.length)) : -1;
      }
      if (menu.pointerClicked && this.cursor >= 0) this.activate(controls[this.cursor]!.key);
      else if (menu.left) this.activate("previous");
      else if (menu.right) this.activate("next");
      else if (menu.up || menu.down) this.activate("livery");
      else if (menu.confirm) this.activate("track");

      this.render();
    } catch (cause) {
      this.stop();
      this.setStatus("Could not render model inspector");
      this.options.onError?.(asError(cause));
    }
    if (this.frame !== undefined) this.frame = this.view.requestAnimationFrame(this.tick);
  };

  private render(): void {
    const gl = this.gl.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (!width || !height || gl.isContextLost()) return;
    gl.clearColor(0.042, 0.058, 0.075, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.displayed) {
      if (this.displayed.track) this.renderTrack(this.displayed.model, width, height);
      else this.scene.renderCarTurntable(this.displayed.model, this.angle, preview, width, height);
    }

    const font = this.assets.fonts[0];
    if (!font) return;
    const batch = new UiBatchBuilder(width, height);
    const highlight: UiColor = [0.18, 0.79, 0.75, 1];
    batch.solidQuad({ x: 0, y: 0.101, width: 1, height: 0.004 }, highlight);
    batch.text({ x: 0.035, y: 0, width: 0.43, height: 0.1 }, font, "MODEL INSPECTOR",
      { justify: 1, colour: highlight, scale: 0.8 });
    const subtitle = this.displayed
      ? [this.displayed.label, this.displayed.livery].filter(Boolean).join(" / ").replaceAll("_", " ")
      : this.status;
    batch.text({ x: 0.43, y: 0, width: 0.535, height: 0.1 }, font, subtitle,
      { justify: 2, scale: 0.72 });
    controls.forEach(({ label }, index) => {
      const rect = { x: index / controls.length, y: 0.895, width: 1 / controls.length, height: 0.105 };
      if (index === this.cursor) batch.solidQuad(rect, [0.10, 0.20, 0.24, 1]);
      batch.text(rect, font, label, { colour: index === this.cursor ? highlight : undefined, scale: 0.77 });
    });
    this.ui.render(batch.build(), width, height);
  }

  private renderTrack(model: CompiledModel, width: number, height: number): void {
    const rect: ViewportRect = { x: 0, y: preview.y * height, width, height: preview.height * height };
    const { min, max } = model.bounds;
    const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const radius = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const aspect = rect.width / rect.height;
    const fov = Math.PI / 3;
    const halfAngle = Math.min(fov / 2, Math.atan(Math.tan(fov / 2) * aspect));
    const distance = radius / Math.sin(halfAngle);
    const eye: Vec3 = [
      center[0] + Math.sin(this.angle) * distance * 0.72,
      center[1] + distance * 0.69,
      center[2] + Math.cos(this.angle) * distance * 0.72,
    ];
    this.scene.renderScene(lookAtLH(eye, center, [0, 1, 0]),
      perspectiveLH(fov, aspect, radius / 1000, distance + 2 * radius), model, [],
      this.assets.tables.fog ? { ...this.assets.tables.fog, density: 0 } : undefined, rect);
  }
}
