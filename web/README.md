# Ford Racing 3 Shuffle — Native WebGL2

This folder is a static site for the independent TypeScript + WebGL2 engine running against the Ford Racing 3 Shuffle game files (`runtime/game/` + `runtime/game-manifest.json`, with optional `runtime/fr3.zip`).

To test locally:

```sh
python3 -m http.server 8000 --directory .
```

Open `http://localhost:8000/`, press **Play**, click the game canvas and press Enter through the introduction. Select **Quick Race** or **Single Player** to pick cars and tracks. Arrow keys drive, Space is the handbrake, Right Ctrl boosts and P pauses.

Serve over HTTP or HTTPS; opening `index.html` as a local `file://` URL cannot fetch the manifest or assets.
