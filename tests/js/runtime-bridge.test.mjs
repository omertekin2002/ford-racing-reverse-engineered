// Download checks and launcher messages in web/runtime-bridge.js.
import assert from "node:assert/strict";
import {test} from "node:test";
import {loadBridge, asset, streamResponse, settle, ORIGIN} from "./harness.mjs";

const CONFIG_DIR = encodeURIComponent("/home/username/.wine/dosdevices/c:/files/CONFIG");
const BASE = "root=wine11&app=fr3&resolution=640x480&sound=";

for (const [mode, sound, expected] of [
  ["play", true, `${BASE}true&p=fr3.exe&args=${encodeURIComponent("640 nomusic nostream")}`],
  ["play", false, `${BASE}false&p=fr3.exe&args=${encodeURIComponent("640 nomusic nostream nosound")}`],
  ["configure", true, `${BASE}true&p=syscfg.exe&w=${CONFIG_DIR}`],
  ["configure", false, `${BASE}false&p=syscfg.exe&w=${CONFIG_DIR}`],
]) {
  test(`Config.urlParams for mode=${mode} sound=${sound}`, () => {
    const bridge = loadBridge({mode, sound});
    assert.equal(bridge.context.Config.urlParams, expected);
    assert.equal(bridge.context.Config.showUploadDownload, false);
  });
}

test("getEmulatorParams inserts the two -env pairs before /bin/wine", () => {
  const bridge = loadBridge();
  const params = bridge.context.getEmulatorParams();
  assert.equal(bridge.calls.originalParams, 1);
  assert.equal(JSON.stringify(params), JSON.stringify([
    "-root", "/root", "-mount_zip", "/wine11.zip",
    "-env", "WINE_D3D_CONFIG=webgl=1,webgl_glsl_es=1,csmt=0",
    "-env", "WINEDLLOVERRIDES=mscoree,mshtml,winemenubuilder.exe=;ddraw,d3d9,d3d8,dxgi,wined3d,d3dxof,d3dx9_36,d3dx9_43=n,b",
    "/bin/wine", "fr3.exe",
  ]));
});

test("skips the upstream JIT cache", () => {
  const bridge = loadBridge();
  let called = 0;
  bridge.context.fetchServerJitCache(() => called++);
  assert.equal(called, 1);
});

// Two assets whose download progress adds up across both files.
const fixture = async (overrides = {}) => {
  const game = new Uint8Array(600).map((_, i) => i * 7);
  const wine = new Uint8Array(400).map((_, i) => 255 - i);
  return {
    game,
    manifest: {assets: {"fr3.zip": await asset(game, overrides), "wine11.zip": await asset(wine)}},
  };
};

const messagesFrom = bridge => bridge.messages.map(({data, targetOrigin}) => {
  assert.equal(targetOrigin, ORIGIN);
  assert.equal(data.type, "fr3-runtime");
  return data;
});

test("loadFile calls back with the verified bytes and reports progress", async () => {
  const {game, manifest} = await fixture();
  const bridge = loadBridge({manifest, files: {
    "assets/fr3.zip": streamResponse([game.subarray(0, 250), game.subarray(250)]),
  }});
  const received = await bridge.load("assets/", "fr3.zip");
  assert.equal(received.length, 1);
  assert.equal(Buffer.from(received[0]).equals(Buffer.from(game)), true);
  const data = messagesFrom(bridge);
  assert.equal(data[0].status, "Loading game files…");
  assert.deepEqual(data.slice(1).map(message => message.progress), [25, 60]);
  assert.equal(bridge.errors().length, 0);
  assert.equal(bridge.calls.originalLoadFile, 0);
});

test("loadFile labels the Wine download as the compatibility runtime", async () => {
  const wine = new Uint8Array([1, 2, 3]);
  const manifest = {assets: {"fr3.zip": {bytes: 0, sha256: ""}, "wine11.zip": await asset(wine)}};
  const bridge = loadBridge({manifest, files: {"wine11.zip": streamResponse([wine])}});
  const received = await bridge.load("", "wine11.zip");
  assert.equal(received.length, 1);
  assert.equal(bridge.data[0].status, "Loading Windows compatibility runtime…");
  assert.equal(bridge.data.at(-1).progress, 100);
});

const failures = [
  ["an unknown asset name", async () => {
    const {manifest} = await fixture();
    return {options: {manifest}, filename: "other.zip", reason: "Unexpected runtime asset: other.zip"};
  }],
  ["an HTTP error", async () => {
    const {manifest} = await fixture();
    return {options: {manifest, files: {"fr3.zip": streamResponse([], 404)}}, reason: "fr3.zip: HTTP 404"};
  }],
  ["an oversized body", async () => {
    const {game, manifest} = await fixture();
    return {options: {manifest, files: {"fr3.zip": streamResponse([game, new Uint8Array(1)])}}, reason: "fr3.zip: oversized download"};
  }],
  ["a truncated body", async () => {
    const {game, manifest} = await fixture();
    return {options: {manifest, files: {"fr3.zip": streamResponse([game.subarray(0, 599)])}}, reason: "fr3.zip: truncated download"};
  }],
  ["a checksum mismatch", async () => {
    const {game, manifest} = await fixture({sha256: "0".repeat(64)});
    return {options: {manifest, files: {"fr3.zip": streamResponse([game])}}, reason: "fr3.zip: checksum mismatch"};
  }],
  ["a tampered body", async () => {
    const {game, manifest} = await fixture();
    const tampered = game.slice();
    tampered[123] ^= 1;
    return {options: {manifest, files: {"fr3.zip": streamResponse([tampered])}}, reason: "fr3.zip: checksum mismatch"};
  }],
  ["a build.json HTTP error", async () => ({options: {manifest: 500}, reason: "Build details: HTTP 500"})],
  ["a failing build.json fetch", async () => ({options: {manifest: new Error("offline")}, reason: "offline"})],
];

for (const [name, setup] of failures) {
  test(`loadFile sends one error and never calls back for ${name}`, async () => {
    const {options, filename = "fr3.zip", reason} = await setup();
    const bridge = loadBridge(options);
    const received = await bridge.load("", filename);
    // A second failing download must not report the error again.
    const again = await bridge.load("", filename);
    assert.equal(received.length + again.length, 0);
    const errors = bridge.errors();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].type, "fr3-runtime");
    assert.equal(errors[0].status, "The game could not start. Try Restart or Game settings; download the log for details.");
    assert.match(errors[0].log, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(bridge.calls.originalLoadFile, 0);
  });
}

test("Module.onExit sends exited with the exit code", () => {
  const bridge = loadBridge();
  bridge.context.Module.onExit(3);
  const [message] = messagesFrom(bridge);
  assert.equal(message.state, "exited");
  assert.equal(message.status, "The game has closed (code 3). Press Play demo to start again.");
});

test("Module.onAbort reports a runtime error", () => {
  const bridge = loadBridge();
  bridge.context.Module.onAbort("out of memory");
  const [message] = messagesFrom(bridge);
  assert.equal(message.state, "error");
  assert.equal(message.log, "Runtime aborted: out of memory");
});

test("Module.print and setStatus forward to the launcher", () => {
  const bridge = loadBridge();
  bridge.context.Module.print("hello");
  bridge.context.Module.setStatus("");
  bridge.context.Module.setStatus("Downloading");
  assert.deepEqual([...bridge.calls.print], ["hello"]);
  assert.deepEqual([...bridge.calls.status], ["", "Downloading"]);
  const data = messagesFrom(bridge);
  assert.equal(data.length, 2);
  assert.equal(data[0].log, "hello");
  assert.equal(data[1].status, "Downloading");
});

for (const [mode, prefix] of [["play", "Starting Windows and the game."], ["configure", "Opening game settings…"]]) {
  test(`buildBrowserFileSystem disables Wine's prefix update and sends starting (${mode})`, async () => {
    const bridge = loadBridge({mode});
    bridge.context.buildBrowserFileSystem();
    await settle();
    assert.deepEqual([...bridge.directories], ["/root/home/username/.wine"]);
    assert.equal(bridge.written.length, 1);
    assert.equal(bridge.written[0][0], "/root/home/username/.wine/.update-timestamp");
    assert.equal(bridge.written[0][1], "disable\n");
    assert.equal(bridge.calls.originalBuild, 1);
    assert.equal(bridge.elements.loading.style.display, "none");
    const [message] = messagesFrom(bridge);
    assert.equal(message.state, "starting");
    assert.ok(message.status.startsWith(prefix), message.status);
    // It starts waiting for the first picture.
    assert.equal(bridge.calls.intervals.length, 1);
  });
}
