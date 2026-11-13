// Launcher state transitions in web/site.js.
import assert from "node:assert/strict";
import {test} from "node:test";
import {loadSite, settle} from "./harness.mjs";

const BROWSER_MESSAGE = "This browser cannot run the game. Try a recent desktop Chrome, Edge or Firefox.";
const MISSING_ASSETS = "Game assets are missing. Build the site before serving it.";

test("reports the download size from build.json once ready", async () => {
  const site = loadSite();
  await settle();
  assert.deepEqual(site.fetches, ["build.json"]);
  // 98 MB + 34.200001 MB rounds up.
  assert.equal(site.status.textContent, "Ready when you are. The first download is about 133 MB.");
  assert.equal(site.play.disabled, false);
  assert.equal(site.configure.disabled, false);
});

test("disables Play and Game settings when build.json is missing", async () => {
  const site = loadSite({build: 404});
  await settle();
  assert.equal(site.status.textContent, MISSING_ASSETS);
  assert.equal(site.play.disabled, true);
  assert.equal(site.configure.disabled, true);
});

test("disables Play and Game settings when build.json is malformed", async () => {
  const site = loadSite({build: {}});
  await settle();
  assert.equal(site.status.textContent, MISSING_ASSETS);
  assert.equal(site.play.disabled, true);
  assert.equal(site.configure.disabled, true);
});

test("an isolated page clears the isolation reload marker", async () => {
  const site = loadSite({reloadFlag: "1"});
  await settle();
  assert.equal(site.storage.has("fr3-isolation-reload"), false);
  assert.deepEqual(site.worker.registered, []);
});

test("without isolation, the first attempt registers the worker and reloads once", async () => {
  const site = loadSite({isolated: false});
  assert.equal(site.play.disabled, true);
  assert.equal(site.configure.disabled, true);
  await settle();
  assert.equal(site.worker.registered.length, 1);
  const [url, options] = site.worker.registered[0];
  assert.equal(url, "isolation-worker.js");
  assert.equal(options.scope, "./");
  assert.equal(site.storage.get("fr3-isolation-reload"), "1");
  assert.equal(site.reloads, 1);
  // Not isolated yet, so the ready message is withheld.
  assert.equal(site.status.textContent, "Ready when you are. The first download is about 133 MB.");
  assert.equal(site.play.disabled, true);
  await site.play.click();
  assert.equal(site.status.textContent, BROWSER_MESSAGE);
  assert.equal(site.frame, undefined);
});

test("without isolation, waits for the worker to take control before reloading", async () => {
  const site = loadSite({isolated: false, serviceWorker: {controller: null}});
  await settle();
  assert.equal(site.reloads, 0);
  assert.equal(site.worker.listeners.count("controllerchange"), 1);
  await site.worker.listeners.dispatch("controllerchange");
  await settle();
  assert.equal(site.reloads, 1);
});

test("a second isolation attempt shows the unavailable message instead of reloading", async () => {
  const site = loadSite({isolated: false, reloadFlag: "1"});
  await settle();
  assert.equal(site.reloads, 0);
  assert.equal(site.status.textContent,
    "Browser isolation is unavailable. Close this tab and try a recent desktop Chrome, Edge or Firefox.");
  assert.equal(site.play.disabled, true);
  assert.equal(site.configure.disabled, true);
  await site.configure.click();
  assert.equal(site.status.textContent, BROWSER_MESSAGE);
  assert.equal(site.frame, undefined);
});

for (const [name, options] of [
  ["an insecure context", {secure: false}],
  ["a missing service worker", {serviceWorker: false}],
]) {
  test(`shows the error for ${name}`, async () => {
    const site = loadSite({isolated: false, ...options});
    await settle();
    assert.equal(site.status.textContent, "Use HTTPS or localhost in a recent desktop browser.");
    assert.equal(site.play.disabled, true);
    assert.equal(site.configure.disabled, true);
    assert.equal(site.reloads, 0);
    await site.play.click();
    assert.equal(site.status.textContent, BROWSER_MESSAGE);
    assert.equal(site.frame, undefined);
  });
}

test("refuses to launch without WebAssembly", async () => {
  const site = loadSite();
  await settle();
  site.context.WebAssembly = undefined;
  await site.play.click();
  assert.equal(site.status.textContent, BROWSER_MESSAGE);
  assert.equal(site.frame, undefined);
  assert.equal(site.play.disabled, false);
});

const assertLaunched = (site, src) => {
  assert.equal(site.frame.src, src);
  assert.equal(site.frame.allow, "autoplay; fullscreen; cross-origin-isolated");
  assert.deepEqual(site.screen.children, [site.frame]);
  assert.equal(site.status.textContent, "Loading the game. The first launch can take several minutes…");
  assert.equal(site.progress.hidden, false);
  assert.equal(site.progress.hasAttribute("value"), false, "progress should be indeterminate");
  assert.equal(site.play.disabled, true);
  assert.equal(site.configure.disabled, true);
  assert.equal(site.restart.disabled, false);
  assert.equal(site.fullscreen.disabled, false);
};

for (const [button, mode, title] of [["play", "play", "Ford Racing 3 demo"], ["configure", "configure", "Ford Racing 3 settings"]]) {
  for (const checked of [true, false]) {
    test(`${button} launches mode=${mode} with sound=${checked}`, async () => {
      const site = loadSite();
      await settle();
      site.sound.checked = checked;
      await site[button].click();
      assertLaunched(site, `runtime/game.html?mode=${mode}&sound=${checked}`);
      assert.equal(site.frame.title, title);
      await site.frame.dispatch("load");
      assert.equal(site.frame.contentWindow.focused, 1);
    });
  }
}

test("Restart reuses the last mode and replaces the frame", async () => {
  const site = loadSite();
  await settle();
  await site.configure.click();
  const first = site.frame;
  await site.runtime({log: "old line"});
  await site.runtime({state: "running"});
  site.sound.checked = true;
  await site.restart.click();
  assert.notEqual(site.frame, first);
  assert.equal(first.removed, true);
  assertLaunched(site, "runtime/game.html?mode=configure&sound=true");
  // Restart starts a fresh log.
  await site.log.click();
  assert.equal(site.blobs.at(-1).parts.join(""), "");
  // Play switches the mode Restart reuses.
  await site.play.click();
  await site.restart.click();
  assert.equal(site.frame.src, "runtime/game.html?mode=play&sound=true");
});

test("ignores messages before any frame exists", async () => {
  const site = loadSite();
  await settle();
  await site.message({type: "fr3-runtime", status: "spoofed"}, {source: {}});
  assert.equal(site.status.textContent, "Ready when you are. The first download is about 133 MB.");
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
    await site.play.click();
    await site.message(data, options);
    assert.equal(site.status.textContent, "Loading the game. The first launch can take several minutes…");
    assert.equal(site.play.disabled, true);
    assert.equal(site.configure.disabled, true);
    assert.equal(site.progress.hidden, false);
  });
}

test("progress messages set the value; starting makes it indeterminate", async () => {
  const site = loadSite();
  await settle();
  await site.play.click();
  await site.runtime({progress: 42.5, status: "Loading game files…"});
  assert.equal(site.progress.value, 42.5);
  assert.equal(site.progress.hidden, false);
  assert.equal(site.status.textContent, "Loading game files…");
  await site.runtime({state: "starting", status: "Starting Windows"});
  assert.equal(site.progress.hasAttribute("value"), false);
  assert.equal(site.progress.hidden, false);
  // Play stays disabled until the runtime is running.
  assert.equal(site.play.disabled, true);
  assert.equal(site.configure.disabled, true);
});

for (const state of ["running", "error", "exited"]) {
  test(`state ${state} hides progress and re-enables Play and Game settings`, async () => {
    const site = loadSite();
    await settle();
    await site.play.click();
    await site.runtime({progress: 80});
    await site.runtime({state, status: `now ${state}`});
    assert.equal(site.progress.hidden, true);
    assert.equal(site.play.disabled, false);
    assert.equal(site.configure.disabled, false);
    assert.equal(site.restart.disabled, false);
    assert.equal(site.status.textContent, `now ${state}`);
  });
}

test("the log buffer keeps the last 500 lines and Download log contains them", async () => {
  const site = loadSite();
  await settle();
  await site.play.click();
  for (let i = 0; i < 510; i++) await site.runtime({log: `line ${i}`});
  await site.runtime({log: 7});  // non-string logs are ignored
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
  assert.equal(site.status.textContent, "Ready when you are. The first download is about 133 MB.");
  await site.play.click();
  site.sound.checked = true;
  await site.sound.dispatch("change");
  assert.equal(site.status.textContent, "Sound effects setting changed. Press Restart to apply it.");
});

test("exit-fullscreen leaves fullscreen only when the player is fullscreen", async () => {
  const site = loadSite();
  await settle();
  await site.play.click();
  await site.runtime({action: "exit-fullscreen"});
  assert.equal(site.document.exited, 0);
  site.document.fullscreenElement = site.screen;
  await site.runtime({action: "exit-fullscreen", state: "running"});
  assert.equal(site.document.exited, 1);
  // The action returns before any state handling.
  assert.equal(site.play.disabled, true);
});
