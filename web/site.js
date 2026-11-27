"use strict";
const screen = document.getElementById("screen");
const status = document.getElementById("status");
const progress = document.getElementById("progress");
const playNative = document.getElementById("play-native");
const restart = document.getElementById("restart");
const fullscreen = document.getElementById("fullscreen");
const sound = document.getElementById("sound");
let frame;
let logs = [];

function launch() {
  logs = [];
  frame?.remove();
  frame = document.createElement("iframe");
  frame.title = "Ford Racing 3 Shuffle native WebGL2";
  frame.allow = "autoplay; fullscreen; gamepad";
  frame.src = `native.html?sound=${sound.checked}`;
  screen.replaceChildren(frame);
  status.textContent = "Loading game manifest…";
  progress.hidden = false;
  progress.removeAttribute("value");
  if (playNative) playNative.disabled = true;
  restart.disabled = false;
  fullscreen.disabled = false;
  frame.addEventListener("load", () => frame.contentWindow.focus());
}

playNative?.addEventListener("click", () => launch());
restart.addEventListener("click", () => launch());
fullscreen.addEventListener("click", async () => {
  try { await screen.requestFullscreen(); frame?.contentWindow.focus(); }
  catch { status.textContent = "Fullscreen is unavailable. You can still play in the window."; }
});
sound.addEventListener("change", () => {
  if (frame) status.textContent = "Press Restart to apply the sound setting.";
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
  if (data.state === "starting") progress.removeAttribute("value");
  if (data.state === "running" || data.state === "error" || data.state === "exited") {
    progress.hidden = true;
    if (playNative) playNative.disabled = false;
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
  if (!build || typeof build.assets !== "object" || !build.assets) throw new Error("malformed build");
  const files = typeof build.original_game_files === "number" ? build.original_game_files : null;
  if (!frame) {
    status.textContent = files
      ? `Ready — streams ${files.toLocaleString()} game files on demand.`
      : "Ready to stream assets on demand.";
  }
}).catch(() => {
  status.textContent = "Game assets are missing. Build the site before serving it.";
  if (playNative) playNative.disabled = true;
});
