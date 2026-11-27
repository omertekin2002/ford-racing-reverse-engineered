# FR3AddOns 0.9 — plugin for Ford Racing 3 (PC)

FR3AddOns makes Ford Racing 3 run well on current Windows and lets it take add-on cars and
tracks. The game's files are not changed: the plugin patches the game in memory each time it
starts.

- **Add-on content**:
  - a **Custom Tracks** location;
  - new display names;
  - track and car pages beyond the menu rows;
  - room for big tracks with many textures;
  - two extra car classes;
  - typed profile names (with a matching `KEYBD.UI`).
- **Display**:
  - borderless or windowed play at any resolution;
  - widescreen without stretching;
  - races above the game's 122 fps cap that still play exactly as at the cap;
  - anisotropic filtering and antialiasing.
- **Free camera** in races, with pause and HUD hiding.
- **Controllers**: Xbox-style (XInput) pads with separate trigger pedals and rumble, usable in
  every menu.
- **Fixes**:
  - focus loss in a window;
  - crash sounds that stay silent;
  - tunnel reverb, which the PC game never turned on;
  - no administrator rights needed.

---

## Requirements

- Ford Racing 3 for PC. Made for `fr3.exe` of April 2005. The October 2004 versions are matched
  by signature (tested in races with a modded October 2004 install).
- An **ASI loader** that loads `.asi` files from the game folder, installed as `dinput8.dll`.
  Tested with Ultimate ASI Loader v9.7.4 (x86), from its GitHub releases page; rename its DLL
  to `dinput8.dll`.

## Install

1. Put the ASI loader's `dinput8.dll` next to `fr3.exe`.
2. Copy `FR3AddOns.asi` and `FR3AddOns.ini` next to `fr3.exe`, or together into its `SCRIPTS\`
   folder (Ultimate ASI Loader loads both places; the ini always sits next to the plugin).
3. Start the game. `FR3AddOns.log` (next to the plugin) lists every patch it applied.

`CONFIG\syscfg.exe` is no longer needed: `FR3AddOns.ini` holds the graphics settings.

## Uninstall

Delete these:

- `FR3AddOns.asi`, `FR3AddOns.ini`, `FR3AddOns.log` (next to `fr3.exe` or in `SCRIPTS\`);
- `data\ascii\ctrllers\fr3addons.cdb` (the controller table the plugin writes);
- `dinput8.dll`, if no other plugin uses it.

---

## Always on

- **Registry**: read-only access, so the game starts without administrator rights.
- **Save folder**: `SAVEDATA\AUTOSAVE` is created when missing (without it the first save stopped
  the game).
- **Save size**: saves of any size. The game kept its save in a fixed 128 KB block, so with many
  added tracks or cars (the Shuffle mod: 40 tracks) saving crashed the game and left an empty
  autosave; a bigger save file crashed it at load. Some car / track counts also stopped the game
  at start-up ("non unique id has been generated"). Saves that fit the old size are unchanged.
- **Records of removed cars**: a saved record naming a car no longer in `CARDATA.DAT` crashed the
  track records screen; it now shows "UNKNOWN CAR".
- **Record names**: a record copied the profile name through `printf`, so a `%` in a name read
  the stack, and names of 4+ letters were left unterminated; records now store 3 characters.
- **Already widescreen-patched exe** (e.g. the one of the Ford Racing 3 Shuffle mod): its
  patch is taken out in memory (`UndoExeWidescreen`) and the plugin's `Widescreen` applies, menus
  included. The exe file is not changed.
- **Menu trails**: with pillarboxed menus the side bars stay black (switching cars left trails
  there, as the game never clears the screen in menus).
- **OK button glyph** on the name screen: round at any resolution (the original sized it for
  640x480, so it was a thin sliver at 1080p).
- **Sound device**: music and the announcer play on the same device as the sound effects (the one chosen in `syscfg.exe`, else the Windows default); before, DirectMusic always took the Windows default.
- **+1 / −1 of Driving Skills and the other gate modes**: drawn at their own shape and flying smoothly to the gate counter (they were squeezed and jumped across the screen on wide screens).
- **Lines on wide screens**: the line grid of the competition menu and the race minimap's track
  outline sit with the pictures around them, as on 4:3 (the grid spread over the whole screen
  width; the outline grew thicker with the screen width).

## Settings (`FR3AddOns.ini`)

Lines starting with `;` are comments. Restart the game after a change.

**[Display]**

| key | default | |
|---|---|---|
| `WindowMode` | borderless | `borderless`, `windowed`, `fullscreen`, or `game` (leave it to the game) |
| `Width`, `Height` | 0, 0 | render size; 0 = the monitor's size |
| `VSync` | 1 | one frame per screen refresh, without tearing: in fullscreen the driver's vsync (as the game), in a window the desktop compositor (a window never tears); 0 = present at once |
| `RefreshRate` | 0 | fullscreen switches the screen to this rate (0 = the highest it offers); in every mode the frame rate stays at or below it |
| `FrameCap` | 0 | highest frame rate in every mode; 0 = the refresh rate; -1 = the game's own race timing. See "Frame rates" |
| `Anisotropy` | 16 | texture filtering 2–16; 0 = off |
| `MSAA` | 4 | antialiasing 2, 4 or 8; 0 = off |
| `FOV` | 1.0 | race camera field of view, 0.5–2.0 |
| `Widescreen` | 1 | wider view on wide screens instead of stretching, and the three options below |
| `UndoExeWidescreen` | 1 | an exe that already has a widescreen hex patch: 1 = take it out in memory and use this plugin's widescreen; 0 = keep it (`Widescreen` is then off) |
| `Menus` | pillarbox | menus at 4:3 in the middle, or `stretch` |
| `HUD` | anchored | HUD at its own shape, pinned to the screen edges (the bumper view's two dials stay a pair at the bottom centre); `centered`; `stretch` |
| `Backgrounds` | pillarbox | full-screen pictures and movies: `pillarbox`, `crop`, `stretch` |
| `FreeMouse` | 1 | windowed / borderless: the Windows cursor drives the menus and is not captured |
| `DPIAware` | 1 | sharp window on scaled displays |

**Frame rates.** The game moves everything once per frame by a fixed time step and caps itself at
122 fps; at any other frame rate its physics, the AI drivers and the cameras drive differently (the
AI launched 16% quicker at 240 fps with the previous FR3AddOns, and slower at 60). At any frame
rate the race now runs exactly as at 122 fps - same game speed, physics, AI, input and sound - and
only the drawing follows the screen, with every car and camera placed between its last two
positions, so motion is smooth at any refresh rate. The frame rate never goes above `FrameCap`,
`RefreshRate` or (with `VSync=1`, or with neither set) the screen's refresh, in any window mode;
menus and the pause screen follow the same limit up to the game's own 122 fps. With `VSync=1` in
a window the frames follow the desktop compositor (when the graphics card cannot draw every
refresh, as fast as it can); a limit below the refresh rate or `VSync=0` uses a frame limiter.
Camera changes, looking back and replay camera cuts still cut at once. Smoke, sparks, skid marks
and the free camera move at the game's 122 steps per second.

**[Input]**

| key | default | |
|---|---|---|
| `XInput` | 1 | Xbox-style pads appear as "XInput Controller 1–4" in Options ▸ Controls (plug in any time) |
| `SplitPedals` | 1 | RT accelerates, LT brakes, both at once allowed (the original: one combined axis) |
| `Rumble`, `RumbleStrength` | 1, 1.0 | vibration on collisions, kerbs and gear changes (strength 0–2) |
| `PadInMenus` | 1 | until a profile drives with the pad, pad 1 works the menus as Enter / Esc / arrows |
| `StickDeadZone` | 0.15 | radial dead zone of the sticks |
| `SteeringDeadZone` | 0.02 | the game's pad steering dead zone (original 0.10) |
| `TriggerDeadZone` | 0.05 | trigger dead zone |
| `PauseOnFocusLoss` | 1 | windowed / borderless: switching away pauses the race |

Pick "XInput Controller 1" once for Player One in Options ▸ Controls. Its layout:

- RT accelerate, LT brake;
- A handbrake, B boost, X look back, Y camera;
- LB / RB gears, Start pause.

**[Graphics]** — replaces syscfg's settings

| key | default | |
|---|---|---|
| `DynamicShadows`, `EnvironmentMapping`, `DepthOfField`, `HeatHaze`, `SpecularBloom` | 1 | the five effects (the original with no settings: all off) |
| `ModelDetail`, `VisualRange` | 2 | 0–2 (2 = highest) |
| `LodDistance` | 1.0 | distance at which models switch to simpler versions (2.0 = twice as far). With `Widescreen` or `FOV` the original 4:3 distances are kept. |
| `ModelLod` | -1 | 0 = always the most detailed model; -1 = the game picks |

**[Limits]** — for add-on content

| key | default | |
|---|---|---|
| `TextEnums` | 1 | brand-new display names, text from `LANGUAGE\ADDON.DAT` / `ADDON_xx.DAT` |
| `Graphics` | 1 | 1024 menu pictures instead of 240 |
| `CustomTracks`, `CustomTracksName` | 1, CUSTOM TRACKS | the unused ARENA location becomes "Custom Tracks", open to every car class |
| `TrackPages`, `CarPages` | 1, 1 | more than 6 tracks per location / 16 cars per class, in pages. Tracks: LEFT/RIGHT past the end of the row. Cars: UP on the top row / DOWN on the bottom row, PgUp/PgDn, `[` / `]` or the mouse wheel (`CarPages=0` shows the first 16); `PAGE x/y` and `PGUP/PGDN PAGE` show where `UI\CAR.UI` has the text objects `FR3_PAGE_COUNTER` and `FR3_PAGE_HELPER_TEXT` (the Ford Racing 3 Shuffle mod ships them) |
| `TrackTextures` | 1 | tracks with more textures than any original one (over 256), e.g. converted Gran Turismo courses |
| `ProfileName` | 12 | typed profile names of up to this many characters where `UI\KEYBD.UI` has a `PROFILE_NAME_TEXTBOX` (otherwise the original 3 initials); an empty box falls back to the initials (OK keeps the focus: Enter or pad A commits); 0 = off |

**[Classes]** — extra car classes (none by default)

| key | | |
|---|---|---|
| `Class6`, `Class7` | `NAME,STOCK[,SAMPLE]` | `NAME` is used in `CARDATA.DAT` `:CAR_GROUP_TYPE` (and `:TIME_CAR_GROUP_TYPE`). `STOCK` (CLASSIC, MODERN, OFFROAD, PERFORMANCE, VINTAGE) gives its track locations, AI tuning, time targets and difficulty. Menu label: `TXT_CAR_THEME_<NAME>` in `LANGUAGE\ADDON.DAT` or the TLATE files. `SAMPLE`: an announcer sample number (default: the stock class's line). `UI\CAR.UI` needs a `BUTTONk` per class that has cars. |
| `OwnRecords` | 1 | 1: each extra class has its own track records, shown on its own leaderboards (on the off-road locations, TRACK.UI's records panel and DHSC start at OFF-ROAD and cycle through every class when a class falls back to OFFROAD). The save layout changes, so saves made without these classes do not load (those of FR3ClassExtender with the same classes do). 0: records shared with the `STOCK` class, retail save layout |

**[Rules]** — changes to the game's own rules (all 0 = original)

| key | |
|---|---|
| `VintageAllModes` | Vintage cars in every mode (originally not in Overtake, Duel, Drafting, Relay, Driving Skills, Seconds Out, Time Attack) |
| `DuelAllCars` | every car available in Duel |
| `OffroadSkills` | Alaska and Pacific tracks in Driving Skills and Seconds Out (they need `GATE\MAIN` and `BONUS` files) |

**[Audio]**

| key | default | |
|---|---|---|
| `Voices` | 64 | sounds playing at once (original 16: engine and tyre noise left crash sounds without a voice) |
| `RestartRewind` | 1 | a sound started again always plays from its start (finished crash sounds could stay silent) |
| `PitchFloor` | 1000 | a voice the game sets below this pitch (Hz) plays at its own pitch instead; on current Windows scrapes and similar sounds otherwise drop to inaudible rates. 0 = off |
| `TunnelReverb` | 1 | the player's car sounds reverberate in tunnels and underpasses: the zones in each track's `DATA\ASCII\SOUND\<group>\<track>\REVERB.DAT` (spheres `x, y, z, radius`). The PC game tests them every frame but never turned the effect on. 0 = off |
| `SpeechFallback` | auto | the announcer through DirectSound instead of DirectMusic: `auto` on Wine / Proton (where DirectMusic leaves it silent), `on`, `off` |
| `TunnelReverbMix`, `TunnelReverbTime` | -8, 1500 | reverb level in dB (-30 to -1; the engine itself stays at full level) and reverb time in ms (100–3000) |

**[Freecam]** — off by default

| key | default | |
|---|---|---|
| `Enabled` | 0 | the free camera |
| `ToggleKey`, `ResetKey`, `HudKey`, `PauseKey` | F10, F11, F9, F7 | on/off, back to the game camera, hide the HUD, freeze the race |
| `PauseTurnsOn` | 1 | pausing also turns the camera on |
| `FovUpKey`, `FovDownKey`, `FOV`, `FovStep` | PAGEUP, PAGEDOWN, 60, 5 | horizontal field of view in degrees |
| `RollLeftKey`, `RollRightKey`, `RollResetKey`, `RollSpeed` | Z, C, X, 90 | roll, degrees per second |
| `MoveSpeed`, `SprintSpeed`, `SlowSpeed` | 28, 95, 7 | m/s; W/S/A/D move, Q up, E or Ctrl down, Shift faster, Alt slower |
| `MouseSensitivity`, `InvertMouseY`, `MaxPitch`, `LevelMovement` | 0.002, 0, 88, 0 | mouse look; `LevelMovement=1` keeps W/S level |
| `FarClip`, `ViewRangeScale` | 30000, 4 | draw distance (m) and scenery radius while the camera is on (restored when it is off) |

**[FR2Tracks]** — tracks ported from Ford Racing 2 (their track folder holds `FR2PORT.TXT`)

| key | default | |
|---|---|---|
| `Grid` | 1 | Ford Racing 2's start grid on those tracks: 15 m between cars, the first 20 m behind the line (Ford Racing 3: 20 m and 10 m) |

---

## Good to know

- After adding cars or tracks, start with a new profile: old saves do not load.
- Above 122 fps, smoke, sparks, skid marks, wheel spin and the free camera still move at the
  game's 122 steps per second (only cars and cameras are placed in between).
- Not tested in game: exclusive fullscreen.
- Changes: `FR3AddOns_CHANGES.md`.
