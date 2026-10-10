/* Runs after the pinned Boxedwine shell and before its generated runtime. */
"use strict";
(() => {
  const query = new URLSearchParams(location.search);
  const settings = query.get("mode") === "configure";
  const enabled = query.get("sound") === "true";
  const send = data => parent.postMessage({type:"fr3-runtime", ...data}, location.origin);
  Config.urlParams = "root=wine11&app=fr3&resolution=640x480&sound=" + enabled +
    (settings ? "&p=syscfg.exe&w=" + encodeURIComponent("/home/username/.wine/dosdevices/c:/files/CONFIG") : "&p=fr3.exe&args=" + encodeURIComponent("640 nomusic nostream" + (enabled ? "" : " nosound")));
  Config.showUploadDownload = false;
  const originalParams = getEmulatorParams;
  getEmulatorParams = function() {
    const params = originalParams();
    const wine = params.indexOf("/bin/wine");
    // Retain the WebGL DLL selection while suppressing unused installers.
    params.splice(wine, 0, "-env", "WINE_D3D_CONFIG=webgl=1,webgl_glsl_es=1,csmt=0",
      "-env", "WINEDLLOVERRIDES=mscoree,mshtml,winemenubuilder.exe=;ddraw,d3d9,d3d8,dxgi,wined3d,d3dxof,d3dx9_36,d3dx9_43=n,b");
    return params;
  };
  // No application-specific ahead-of-time cache is shipped in this preview.
  fetchServerJitCache = callback => callback();
  const manifest = fetch("../build.json").then(response => {
    if (!response.ok) throw new Error(`Build details: HTTP ${response.status}`);
    return response.json();
  });
  let failed = false;
  const fatal = error => {
    if (failed) return;
    failed = true;
    console.error(error);
    send({state:"error", status:"The game could not start. Try Restart or Game settings; download the log for details.", log:String(error)});
  };
  let downloaded = 0;
  // The upstream downloader otherwise leaves the launch dependency pending on HTTP errors.
  loadFile = async function(pathPrefix, filename, callback) {
    try {
      const build = await manifest;
      const entry = build.assets[filename];
      if (!entry) throw new Error(`Unexpected runtime asset: ${filename}`);
      const response = await fetch(pathPrefix + filename);
      if (!response.ok) throw new Error(`${filename}: HTTP ${response.status}`);
      send({status:`Loading ${filename === "fr3.zip" ? "game files" : "Windows compatibility runtime"}…`});
      const reader = response.body.getReader();
      const bytes = new Uint8Array(entry.bytes);
      let offset = 0;
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        if (offset + value.length > bytes.length) throw new Error(`${filename}: oversized download`);
        bytes.set(value, offset); offset += value.length; downloaded += value.length;
        const total = build.assets["fr3.zip"].bytes + build.assets["wine11.zip"].bytes;
        send({progress:Math.min(100, downloaded / total * 100)});
      }
      if (offset !== bytes.length) throw new Error(`${filename}: truncated download`);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2,"0")).join("");
      if (hash !== entry.sha256) throw new Error(`${filename}: checksum mismatch`);
      callback(bytes);
    } catch (error) { fatal(error); }
  };
  const originalPrint = Module.print;
  Module.print = text => {
    originalPrint(text);
    const output = document.getElementById("output");
    if (output.value.length > 40000) output.value = output.value.slice(-20000);
    send({log:String(text)});
  };
  Module.printErr = text => { console.error(text); send({log:String(text)}); };
  const originalStatus = Module.setStatus;
  Module.setStatus = text => { originalStatus(text); if (text) send({status:String(text)}); };
  Module.onAbort = reason => fatal(`Runtime aborted: ${reason}`);
  Module.onExit = code => send({state:"exited", status:`The game has closed (code ${code}). Press Play demo to start again.`});
  const originalBuild = buildBrowserFileSystem;
  buildBrowserFileSystem = function() {
    // The supplied Wine image already has a complete, initialized prefix.
    // ZIP DOS timestamps omit timezone information; Wine would otherwise
    // rebuild that prefix when wine.inf's emulated mtime differs by timezone.
    // Wine 11 explicitly supports "disable" in this timestamp file.
    FS.mkdirTree(ROOT + "/home/username/.wine");
    FS.writeFile(ROOT + "/home/username/.wine/.update-timestamp", "disable\n");
    originalBuild();
    document.getElementById("loading").style.display = "none";
    send({state:"running",status:settings ? "Opening game settings…" : "Click the game and press Enter to continue. First initialization may take several minutes."});
  };
  window.addEventListener("error", event => fatal(event.message));
  window.addEventListener("unhandledrejection", event => fatal(event.reason));
  window.addEventListener("keydown", event => {
    if (event.code === "Escape" && parent.document.fullscreenElement) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send({action:"exit-fullscreen"});
    }
  }, true);
  // Register before the emulator's capture handlers consume key events.
  const heldKeys = new Map();
  window.addEventListener("keydown", event => heldKeys.set(event.code, {
    key:event.key, code:event.code, location:event.location,
    keyCode:event.keyCode, which:event.which
  }), true);
  window.addEventListener("keyup", event => heldKeys.delete(event.code), true);
  window.addEventListener("blur", () => {
    const keys = [...heldKeys.values()];
    heldKeys.clear();
    for (const key of keys) window.dispatchEvent(new KeyboardEvent("keyup", {...key, bubbles:true}));
  });
  for (const canvas of document.querySelectorAll("canvas")) {
    canvas.tabIndex = 0;
    canvas.addEventListener("pointerdown", () => canvas.focus());
  }
})();
