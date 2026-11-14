// Loads the unmodified browser launcher scripts into a Node `vm` context
// with small hand-written stand-ins for the browser and Boxedwine globals.
import {readFileSync} from "node:fs";
import {webcrypto} from "node:crypto";
import vm from "node:vm";

export const ORIGIN = "https://preview.example";

const source = name => {
  const url = new URL(`../../web/${name}`, import.meta.url);
  return {code: readFileSync(url, "utf8"), filename: url.pathname};
};

// Wait until every queued promise reaction has run.
export const settle = () => new Promise(resolve => setImmediate(resolve));

class Listeners {
  constructor() { this.handlers = new Map(); }
  add(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }
  dispatch(type, event = {}) {
    const results = (this.handlers.get(type) || []).map(handler => handler(event));
    return Promise.all(results);
  }
  count(type) { return (this.handlers.get(type) || []).length; }
}

export class FakeElement {
  constructor(tagName, id = "", initial = {}) {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.listeners = new Listeners();
    this.attributes = new Map();
    this.textContent = "";
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.children = [];
    this.removed = false;
    this.clicks = 0;
    this.style = {};
    if (this.tagName === "IFRAME") this.contentWindow = {focused: 0, focus() { this.focused++; }};
    Object.assign(this, initial);
  }
  get value() { return this.attributes.get("value"); }
  set value(value) { this.attributes.set("value", value); }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, handler) { this.listeners.add(type, handler); }
  dispatch(type, event = {}) { return this.listeners.dispatch(type, event); }
  click() { this.clicks++; return this.dispatch("click"); }
  remove() { this.removed = true; }
  replaceChildren(...children) { this.children = children; }
  async requestFullscreen() {}
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});

// Build the state web/index.html gives each element before site.js runs.
const launcherElements = () => {
  const elements = {
    screen: new FakeElement("div", "screen"),
    status: new FakeElement("p", "status", {textContent: "Ready when you are. The first download is about 133 MB."}),
    progress: new FakeElement("progress", "progress", {hidden: true}),
    play: new FakeElement("button", "play"),
    configure: new FakeElement("button", "configure"),
    restart: new FakeElement("button", "restart", {disabled: true}),
    fullscreen: new FakeElement("button", "fullscreen", {disabled: true}),
    sound: new FakeElement("input", "sound"),
    log: new FakeElement("button", "log"),
  };
  elements.progress.value = 0;
  return elements;
};

/**
 * Run web/site.js. Options:
 *   isolated        window.crossOriginIsolated (default true)
 *   secure          window.isSecureContext (default true)
 *   serviceWorker   false to omit navigator.serviceWorker; otherwise an object
 *                   overriding the fake's {controller}
 *   reloadFlag      initial sessionStorage "fr3-isolation-reload" value
 *   build           build.json body, or a number for an HTTP error status
 */
export function loadSite(options = {}) {
  const {isolated = true, secure = true, reloadFlag, serviceWorker = {}} = options;
  const build = options.build ?? {assets: {"fr3.zip": {bytes: 98_000_000}, "wine11.zip": {bytes: 34_200_001}}};
  const elements = launcherElements();
  const created = [];
  const windowListeners = new Listeners();
  const storage = new Map(reloadFlag === undefined ? [] : [["fr3-isolation-reload", reloadFlag]]);
  const blobs = [];
  const objectUrls = {created: [], revoked: []};
  const fetches = [];
  let reloads = 0;
  const document = {
    fullscreenElement: null,
    exited: 0,
    getElementById: id => elements[id] ?? null,
    createElement: tag => { const element = new FakeElement(tag); created.push(element); return element; },
    async exitFullscreen() { this.exited++; },
  };
  const worker = serviceWorker === false ? undefined : {
    controller: {},
    registered: [],
    listeners: new Listeners(),
    async register(url, opts) { this.registered.push([url, opts]); },
    ready: Promise.resolve(),
    addEventListener(type, handler) { this.listeners.add(type, handler); },
    ...serviceWorker,
  };
  const navigator = worker ? {serviceWorker: worker} : {};
  const context = {
    document,
    navigator,
    crossOriginIsolated: isolated,
    isSecureContext: secure,
    WebAssembly,
    location: {origin: ORIGIN, reload() { reloads++; }},
    sessionStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    addEventListener: (type, handler) => windowListeners.add(type, handler),
    fetch: async url => {
      fetches.push(url);
      return typeof build === "number" ? jsonResponse(null, build) : jsonResponse(build);
    },
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts?.type; blobs.push(this); } },
    URL: {
      createObjectURL: blob => { const url = `blob:${ORIGIN}/${objectUrls.created.length}`; objectUrls.created.push([url, blob]); return url; },
      revokeObjectURL: url => objectUrls.revoked.push(url),
    },
    setTimeout: callback => { callback(); return 0; },
    console,
  };
  context.window = context;
  vm.createContext(context);
  const {code, filename} = source("site.js");
  vm.runInContext(code, context, {filename});
  const site = {
    ...elements,
    context,
    document,
    created,
    blobs,
    objectUrls,
    fetches,
    storage,
    worker,
    get reloads() { return reloads; },
    get frame() { return created.filter(element => element.tagName === "IFRAME").at(-1); },
    // Post a message to the launcher; defaults come from the current frame.
    message(data, {origin = ORIGIN, source = site.frame?.contentWindow} = {}) {
      return windowListeners.dispatch("message", {origin, source, data});
    },
    runtime(data, options) { return site.message({type: "fr3-runtime", ...data}, options); },
  };
  return site;
}

const sha256 = async bytes => Buffer.from(await webcrypto.subtle.digest("SHA-256", bytes)).toString("hex");

export const asset = async (bytes, overrides = {}) => ({bytes: bytes.length, sha256: await sha256(bytes), ...overrides});

// A Response whose body is read through getReader() in the given chunks.
export const streamResponse = (chunks, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  body: {getReader() {
    const queue = [...chunks];
    return {read: async () => queue.length ? {done: false, value: queue.shift()} : {done: true, value: undefined}};
  }},
});

/**
 * Run web/runtime-bridge.js. Options:
 *   mode, sound   game.html query parameters
 *   manifest      ../build.json body, or a number for an HTTP error status
 *   files         {url: response} returned by fetch for asset downloads
 */
export function loadBridge(options = {}) {
  const {mode = "play", sound = true, manifest = {assets: {}}, files = {}} = options;
  const messages = [];
  const fetches = [];
  const calls = {originalParams: 0, originalBuild: 0, originalLoadFile: 0, print: [], status: [], intervals: [], cleared: []};
  const written = [];
  const directories = [];
  const elements = {output: {value: ""}, loading: {style: {}}};
  const context = {
    location: {origin: ORIGIN, search: `?mode=${mode}&sound=${sound}`},
    parent: {postMessage: (data, targetOrigin) => messages.push({data, targetOrigin})},
    URLSearchParams,
    crypto: webcrypto,
    fetch: async url => {
      fetches.push(url);
      if (url === "../build.json") {
        if (manifest instanceof Error) throw manifest;
        return typeof manifest === "number" ? jsonResponse(null, manifest) : jsonResponse(manifest);
      }
      if (!(url in files)) throw new Error(`unexpected fetch ${url}`);
      return files[url];
    },
    Config: {},
    Module: {
      print: text => calls.print.push(text),
      setStatus: text => calls.status.push(text),
    },
    getEmulatorParams: () => {
      calls.originalParams++;
      return ["-root", "/root", "-mount_zip", "/wine11.zip", "/bin/wine", "fr3.exe"];
    },
    loadFile: () => { calls.originalLoadFile++; },
    buildBrowserFileSystem: () => { calls.originalBuild++; },
    fetchServerJitCache: () => { throw new Error("upstream JIT cache fetch"); },
    FS: {
      mkdirTree: path => directories.push(path),
      writeFile: (path, data) => written.push([path, data]),
    },
    ROOT: "/root",
    document: {
      getElementById: id => elements[id] ?? null,
      createElement: () => ({getContext: () => null}),
      querySelectorAll: () => [],
    },
    addEventListener: () => {},
    setInterval: callback => { calls.intervals.push(callback); return calls.intervals.length; },
    clearInterval: id => calls.cleared.push(id),
    console: {error: () => {}, log: () => {}},
  };
  context.window = context;
  vm.createContext(context);
  const {code, filename} = source("runtime-bridge.js");
  vm.runInContext(code, context, {filename});
  return {
    context,
    messages,
    fetches,
    calls,
    written,
    directories,
    elements,
    get data() { return messages.map(message => message.data); },
    errors() { return messages.map(message => message.data).filter(data => data.state === "error"); },
    // Call the wrapped loadFile and resolve with the bytes it calls back with
    // (an array of every callback argument).
    async load(pathPrefix, filename) {
      const received = [];
      await context.loadFile(pathPrefix, filename, bytes => received.push(bytes));
      await settle();
      return received;
    },
  };
}
