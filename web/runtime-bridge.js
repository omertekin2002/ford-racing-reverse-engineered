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
  Module.onExit = code => {
    clearInterval(pictureTimer);
    send({state:"exited", status:`The game has closed (code ${code}). Press Play demo to start again.`});
  };
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
    send({state:"starting",status:settings ? "Opening game settings… The screen stays black until the settings window appears." :
      "Starting Windows and the game. This takes a few minutes; the screen stays black until the game appears."});
    waitForPicture();
  };
  // Wine and the game start minutes after the files are mounted. Report
  // "running" only once a detailed frame has been presented: the black
  // screen and Wine's plain desktop, shown first, are a single colour.
  let pictureTimer;
  const detailed = (pixels, width, height) => {
    const colours = new Set();
    for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) {
      const i = ((y * height / 24 | 0) * width + (x * width / 32 | 0)) * 4;
      colours.add((pixels[i] >> 4) << 8 | (pixels[i + 1] >> 4) << 4 | pixels[i + 2] >> 4);
    }
    return colours.size >= 8;
  };
  // Software frames (Wine's desktop, dialogs) are copied to an opaque 2D canvas.
  const sample = document.createElement("canvas");
  const softwareFrame = () => {
    const canvas = document.getElementById("boxedwine-webgl-canvas-0");
    if (!canvas?.width || !canvas.height || getComputedStyle(canvas).visibility === "hidden") return false;
    sample.width = canvas.width; sample.height = canvas.height;
    const context = sample.getContext("2d", {willReadFrequently:true});
    context.drawImage(canvas, 0, 0);
    return detailed(context.getImageData(0, 0, sample.width, sample.height).data, sample.width, sample.height);
  };
  // Direct3D renders straight into the emulator's WebGL2 canvas. Copying it
  // to a 2D canvas reads back black (probably zero alpha), so read its
  // preserved drawing buffer instead, restoring the state readPixels needs.
  const glFrame = () => {
    if (typeof GL === "undefined" || !GL.contexts) return false;
    return GL.contexts.some(context => {
      const gl = context?.GLctx;
      if (!(gl instanceof WebGL2RenderingContext) || !gl.drawingBufferWidth || !gl.drawingBufferHeight) return false;
      const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
      const framebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
      const buffer = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
      const store = [gl.PACK_ALIGNMENT, gl.PACK_ROW_LENGTH, gl.PACK_SKIP_PIXELS, gl.PACK_SKIP_ROWS].map(name => [name, gl.getParameter(name)]);
      const pixels = new Uint8Array(width * height * 4);
      try {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        for (const [name] of store) gl.pixelStorei(name, name === gl.PACK_ALIGNMENT ? 4 : 0);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      } finally {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
        for (const [name, value] of store) gl.pixelStorei(name, value);
      }
      return detailed(pixels, width, height);
    });
  };
  const pictureShown = () => {
    try { return softwareFrame() || glFrame(); } catch { return false; }
  };
  const waitForPicture = () => {
    const started = Date.now();
    pictureTimer = setInterval(() => {
      if (failed) return clearInterval(pictureTimer);
      if (pictureShown()) {
        clearInterval(pictureTimer);
        send({state:"running", status:settings ? "Choose your settings, then press OK and Play demo." :
          "The game is loading. Click it and press Enter when it shows PRESS ANY KEY."});
      } else if (Date.now() - started > 10 * 60 * 1000) {
        // Never leave the launcher locked if detection misses the picture.
        clearInterval(pictureTimer);
        send({state:"running", status:"This is taking longer than usual. If the screen stays black, use Restart or download the log."});
      }
    }, 1000);
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
