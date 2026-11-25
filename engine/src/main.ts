import { FordRacing3App, type EngineSnapshot } from "./app.js";
import { DemoAssets } from "./demoAssets.js";
import type { VirtualFileSystem } from "./vfs/types.js";
import { ZipVfs } from "./vfs/zipVfs.js";

export type NativeEngineOptions = {
  canvas: HTMLCanvasElement;
  sound?: boolean;
  onProgress?: (fraction: number, status: string) => void;
  onStatus?: (status: string) => void;
  onError?: (err: Error) => void;
} & ({ zipUrl: string; vfs?: never } | { zipUrl?: never; vfs: VirtualFileSystem });

export interface NativeEngineController {
  dispose(): void;
  restart(): void;
  setMuted(muted: boolean): void;
  getSnapshot(): EngineSnapshot;
  continueFromStart(): void;
  launchQuickRace(): void;
  launchCarRace(carId?: string): void;
  togglePause(): void;
  cycleCamera(): void;
}

export interface NativeEngineDiagnostics {
  getSnapshot(): EngineSnapshot;
  continueFromStart(): void;
  launchQuickRace(): void;
  launchCarRace(carId?: string): void;
  togglePause(): void;
  cycleCamera(): void;
}

declare global {
  interface Window {
    __fr3?: NativeEngineDiagnostics;
  }
}

async function downloadZip(
  url: string, progress: (fraction: number, status: string) => void,
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download asset archive (HTTP ${response.status})`);
  if (!response.body) return new Uint8Array(await response.arrayBuffer());

  const expected = Number(response.headers.get("Content-Length"));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (expected > 0) progress(Math.min(1, total / expected) * 0.8, "Downloading asset archive");
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function observeCanvasSize(canvas: HTMLCanvasElement, view: Window): () => void {
  const originalWidth = canvas.style.width;
  const originalHeight = canvas.style.height;
  const originalWidthAttribute = canvas.getAttribute("width");
  const originalHeightAttribute = canvas.getAttribute("height");
  let pinnedWidth = false;
  let pinnedHeight = false;
  const resize = () => {
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (!cssWidth || !cssHeight) return;
    const dpr = Math.min(view.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (width !== canvas.width) canvas.width = width;
    if (height !== canvas.height) canvas.height = height;
    if (canvas.clientWidth !== cssWidth) {
      canvas.style.width = `${cssWidth}px`;
      pinnedWidth = true;
    }
    if (canvas.clientHeight !== cssHeight) {
      canvas.style.height = `${cssHeight}px`;
      pinnedHeight = true;
    }
  };

  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  view.addEventListener("resize", resize);
  return () => {
    observer.disconnect();
    view.removeEventListener("resize", resize);
    if (pinnedWidth) canvas.style.width = originalWidth;
    if (pinnedHeight) canvas.style.height = originalHeight;
    if (originalWidthAttribute === null) canvas.removeAttribute("width");
    else canvas.setAttribute("width", originalWidthAttribute);
    if (originalHeightAttribute === null) canvas.removeAttribute("height");
    else canvas.setAttribute("height", originalHeightAttribute);
  };
}

/** Mount the playable WebGL2 Ford Racing 3 engine from an asset ZIP URL or mounted VFS. */
export async function mountNativeEngine(options: NativeEngineOptions): Promise<NativeEngineController> {
  const { canvas, onProgress, onStatus, onError } = options;
  const progress = (fraction: number, status: string) => {
    onProgress?.(fraction, status);
    onStatus?.(status);
  };
  let cleanupSize: (() => void) | undefined;
  let app: FordRacing3App | undefined;
  try {
    const view = canvas.ownerDocument.defaultView;
    if (!view) throw new Error("The canvas requires a browser window");
    let vfs: VirtualFileSystem;
    if (options.zipUrl !== undefined) {
      progress(0, "Downloading asset archive");
      vfs = new ZipVfs(await downloadZip(options.zipUrl, (fraction, status) => onProgress?.(fraction, status)));
    } else {
      vfs = options.vfs;
    }
    progress(0.82, "Parsing demo databases & UI scripts");
    const assets = await DemoAssets.load(vfs);
    progress(0.94, "Initializing WebGL2 engine");
    cleanupSize = observeCanvasSize(canvas, view);
    const engine = new FordRacing3App(canvas, assets, options);
    app = engine;
    await engine.prepare();
    engine.start();
    onProgress?.(1, engine.getSnapshot().status);

    const diagnostics: NativeEngineDiagnostics = {
      getSnapshot: () => engine.getSnapshot(),
      continueFromStart: () => engine.continueFromStart(),
      launchQuickRace: () => engine.launchQuickRace(),
      launchCarRace: (carId?: string) => engine.launchCarRace(carId),
      togglePause: () => engine.togglePause(),
      cycleCamera: () => engine.cycleCamera(),
    };
    view.__fr3 = diagnostics;
    return {
      dispose() {
        engine.dispose();
        cleanupSize?.();
        cleanupSize = undefined;
        if (view.__fr3 === diagnostics) delete view.__fr3;
      },
      restart: () => engine.restart(),
      setMuted: muted => engine.setMuted(muted),
      ...diagnostics,
    };
  } catch (cause) {
    app?.dispose();
    cleanupSize?.();
    const error = cause instanceof Error ? cause : new Error(String(cause));
    onError?.(error);
    throw error;
  }
}
