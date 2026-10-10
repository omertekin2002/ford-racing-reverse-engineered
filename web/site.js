"use strict";
const screen = document.getElementById("screen");
const status = document.getElementById("status");
const progress = document.getElementById("progress");
const play = document.getElementById("play");
const configure = document.getElementById("configure");
const restart = document.getElementById("restart");
const fullscreen = document.getElementById("fullscreen");
const sound = document.getElementById("sound");
let frame;
let mode = "play";
let logs = [];
let isolationReady = window.crossOriginIsolated;
if (isolationReady) sessionStorage.removeItem("fr3-isolation-reload");

async function prepareIsolation() {
  if (isolationReady) return;
  play.disabled = configure.disabled = true;
  try {
    if (!window.isSecureContext || !("serviceWorker" in navigator)) throw new Error("Use HTTPS or localhost in a recent desktop browser.");
    await navigator.serviceWorker.register("isolation-worker.js", {scope:"./"});
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, {once:true}));
    }
    if (sessionStorage.getItem("fr3-isolation-reload") !== "1") {
      sessionStorage.setItem("fr3-isolation-reload", "1");
      location.reload();
    } else {
      throw new Error("Browser isolation is unavailable. Close this tab and try a recent desktop Chrome, Edge or Firefox.");
    }
  } catch (error) { status.textContent = String(error.message || error); }
}
prepareIsolation();

function launch(nextMode = "play") {
  if (!isolationReady || !window.WebAssembly) {
    status.textContent = "This browser cannot run the game. Try a recent desktop Chrome, Edge or Firefox.";
    return;
  }
  mode = nextMode;
  logs = [];
  frame?.remove();
  frame = document.createElement("iframe");
  frame.title = nextMode === "configure" ? "Ford Racing 3 settings" : "Ford Racing 3 demo";
  frame.allow = "autoplay; fullscreen; cross-origin-isolated";
  frame.src = `runtime/game.html?mode=${mode}&sound=${sound.checked}`;
  screen.replaceChildren(frame);
  status.textContent = "Loading the game. The first launch can take several minutes…";
  progress.hidden = false;
  progress.removeAttribute("value");
  play.disabled = true;
  configure.disabled = true;
  restart.disabled = false;
  fullscreen.disabled = false;
  // A long first launch should remain recoverable through Restart.
  frame.addEventListener("load", () => frame.contentWindow.focus());
}
play.addEventListener("click", () => launch());
configure.addEventListener("click", () => launch("configure"));
restart.addEventListener("click", () => launch(mode));
fullscreen.addEventListener("click", async () => {
  try { await screen.requestFullscreen(); frame?.contentWindow.focus(); }
  catch { status.textContent = "Fullscreen is unavailable. You can still play in the window."; }
});
sound.addEventListener("change", () => {
  if (frame) status.textContent = "Sound effects setting changed. Press Restart to apply it.";
});
window.addEventListener("message", event => {
  if (!frame || event.origin !== location.origin || event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || data.type !== "fr3-runtime") return;
  if (data.action === "exit-fullscreen" && document.fullscreenElement === screen) {
    document.exitFullscreen().catch(() => { status.textContent = "Use the browser's fullscreen control to exit."; });
    return;
  }
  if (typeof data.log === "string") { logs.push(data.log); if (logs.length > 500) logs.shift(); }
  if (typeof data.status === "string") status.textContent = data.status;
  if (typeof data.progress === "number") { progress.hidden = false; progress.value = data.progress; }
  if (data.state === "running" || data.state === "error" || data.state === "exited") {
    progress.hidden = true;
    play.disabled = false;
    configure.disabled = false;
  }
});
document.getElementById("log").addEventListener("click", () => {
  const blob = new Blob([logs.join("\n")], {type:"text/plain"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = "ford-racing-3-browser.log"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
fetch("build.json").then(response => {
  if (!response.ok) throw new Error("missing build");
  return response.json();
}).then(build => {
  const mb = Object.values(build.assets).reduce((n, asset) => n + asset.bytes, 0) / 1e6;
  if (!frame && isolationReady) status.textContent = `Ready when you are. The first download is about ${Math.ceil(mb)} MB.`;
}).catch(() => { status.textContent = "Game assets are missing. Build the site before serving it."; play.disabled = configure.disabled = true; });
