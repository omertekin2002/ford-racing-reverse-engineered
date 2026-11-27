// Launcher state transitions in web/site.js (Native WebGL2 Shuffle launcher).
import assert from "node:assert/strict";
import {test} from "node:test";
import {loadSite, settle} from "./harness.mjs";

const MISSING_ASSETS = "Game assets are missing. Build the site before serving it.";

test("reports the ready file count from build.json once loaded", async () => {
  const site = loadSite();
  await settle();
  assert.deepEqual(site.fetches, ["build.json"]);
  assert.equal(site.status.textContent, `Ready — streams ${(4446).toLocaleString()} game files on demand.`);
  assert.equal(site.playNative.disabled, false);
});

test("reports generic ready status when build.json omits original_game_files", async () => {
  const site = loadSite({build: {assets: {"fr3-engine.js": {bytes: 1000}}}});
  await settle();
  assert.equal(site.status.textContent, "Ready to stream assets on demand.");
  assert.equal(site.playNative.disabled, false);
});

test("disables Play when build.json is missing", async () => {
  const site = loadSite({build: 404});
  await settle();
  assert.equal(site.status.textContent, MISSING_ASSETS);
  assert.equal(site.playNative.disabled, true);
});

test("disables Play when build.json is malformed", async () => {
  const site = loadSite({build: {}});
  await settle();
  assert.equal(site.status.textContent, MISSING_ASSETS);
  assert.equal(site.playNative.disabled, true);
});

const assertNativeLaunched = (site, sound) => {
  assert.equal(site.frame.src, `native.html?sound=${sound}`);
  assert.equal(site.frame.title, "Ford Racing 3 Shuffle native WebGL2");
  assert.equal(site.frame.allow, "autoplay; fullscreen; gamepad");
  assert.deepEqual(site.screen.children, [site.frame]);
  assert.equal(site.status.textContent, "Loading game manifest…");
  assert.equal(site.progress.hidden, false);
  assert.equal(site.progress.hasAttribute("value"), false, "progress should be indeterminate");
  assert.equal(site.playNative.disabled, true);
  assert.equal(site.restart.disabled, false);
  assert.equal(site.fullscreen.disabled, false);
};

for (const checked of [true, false]) {
  test(`Play launches the native WebGL2 engine with sound=${checked}`, async () => {
    const site = loadSite();
    await settle();
    site.sound.checked = checked;
    await site.playNative.click();
    assertNativeLaunched(site, checked);
    await site.frame.dispatch("load");
    assert.equal(site.frame.contentWindow.focused, 1);
  });
}

test("Play launches without browser isolation or WebAssembly", async () => {
  const site = loadSite({isolated: false, reloadFlag: "1"});
  await settle();
  site.context.WebAssembly = undefined;
  await site.playNative.click();
  assertNativeLaunched(site, false);
});

test("progress messages set the value; starting makes it indeterminate", async () => {
  const site = loadSite();
  await settle();
  await site.playNative.click();
  await site.runtime({progress: 60, status: "Loading track…"});
  assert.equal(site.progress.value, 60);
  assert.equal(site.progress.hidden, false);
  assert.equal(site.status.textContent, "Loading track…");
  await site.runtime({state: "starting", status: "Initializing WebGL2"});
  assert.equal(site.progress.hasAttribute("value"), false);
  assert.equal(site.progress.hidden, false);
  assert.equal(site.playNative.disabled, true);
});

for (const state of ["running", "error", "exited"]) {
  test(`state ${state} hides progress and re-enables Play`, async () => {
    const site = loadSite();
    await settle();
    await site.playNative.click();
    await site.runtime({progress: 80});
    await site.runtime({state, status: `now ${state}`});
    assert.equal(site.progress.hidden, true);
    assert.equal(site.playNative.disabled, false);
    assert.equal(site.restart.disabled, false);
    assert.equal(site.status.textContent, `now ${state}`);
  });
}

test("Restart relaunches the native engine in a fresh frame and clears logs", async () => {
  const site = loadSite();
  await settle();
  site.sound.checked = true;
  await site.playNative.click();
  const first = site.frame;
  await site.runtime({log: "old line"});
  await site.runtime({state: "running"});
  site.sound.checked = false;
  await site.sound.dispatch("change");
  assert.equal(site.status.textContent, "Press Restart to apply the sound setting.");
  await site.restart.click();
  assert.notEqual(site.frame, first);
  assert.equal(first.removed, true);
  assertNativeLaunched(site, false);
  await site.log.click();
  assert.equal(site.blobs.at(-1).parts.join(""), "");
});

test("ignores messages before any frame exists", async () => {
  const site = loadSite();
  await settle();
  await site.message({type: "fr3-runtime", status: "spoofed"}, {source: {}});
  assert.equal(site.status.textContent, `Ready — streams ${(4446).toLocaleString()} game files on demand.`);
});

for (const [name, data, options] of [
  ["another origin", {type: "fr3-runtime", status: "spoofed", state: "running"}, {origin: "https://evil.example"}],
  ["another source", {type: "fr3-runtime", status: "spoofed", state: "running"}, {source: {}}],
  ["another message type", {type: "other", status: "spoofed", state: "running"}, {}],
  ["no data", null, {}],
]) {
  test(`ignores messages from ${name}`, async () => {
    const site = loadSite();
    await settle();
    await site.playNative.click();
    await site.message(data, options);
    assert.equal(site.status.textContent, "Loading game manifest…");
    assert.equal(site.playNative.disabled, true);
    assert.equal(site.progress.hidden, false);
  });
}

test("the log buffer keeps the last 500 lines and Download log contains them", async () => {
  const site = loadSite();
  await settle();
  await site.playNative.click();
  for (let i = 0; i < 510; i++) await site.runtime({log: `line ${i}`});
  await site.runtime({log: 7});
  await site.log.click();
  const blob = site.blobs.at(-1);
  assert.equal(blob.type, "text/plain");
  const lines = blob.parts.join("").split("\n");
  assert.equal(lines.length, 500);
  assert.equal(lines[0], "line 10");
  assert.equal(lines.at(-1), "line 509");
  const link = site.created.at(-1);
  assert.equal(link.tagName, "A");
  assert.equal(link.download, "ford-racing-3-browser.log");
  assert.equal(link.clicks, 1);
  const [[url, linked]] = site.objectUrls.created;
  assert.equal(link.href, url);
  assert.equal(linked, blob);
  assert.deepEqual(site.objectUrls.revoked, [url]);
});

test("changing sound with a running frame asks for Restart", async () => {
  const site = loadSite();
  await settle();
  await site.sound.dispatch("change");
  assert.equal(site.status.textContent, `Ready — streams ${(4446).toLocaleString()} game files on demand.`);
  await site.playNative.click();
  site.sound.checked = true;
  await site.sound.dispatch("change");
  assert.equal(site.status.textContent, "Press Restart to apply the sound setting.");
});

test("exit-fullscreen leaves fullscreen only when the player is fullscreen", async () => {
  const site = loadSite();
  await settle();
  await site.playNative.click();
  await site.runtime({action: "exit-fullscreen"});
  assert.equal(site.document.exited, 0);
  site.document.fullscreenElement = site.screen;
  await site.runtime({action: "exit-fullscreen", state: "running"});
  assert.equal(site.document.exited, 1);
  assert.equal(site.playNative.disabled, true);
});
