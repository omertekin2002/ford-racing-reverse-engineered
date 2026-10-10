#!/bin/bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "$0")" && pwd)
VERSION=0.1.0-preview
PAYLOAD=87cc71d881a2723784097108ce2923fe8d0384ea6a8b03fad3e95c5cda52e8b3
ACTION=game
case "${1:-}" in
    --help|-h)
        cat <<'HELP'
Ford Racing 3 Demo — Wine compatibility release
Usage: launch.sh [--configure | --desktop | --fullscreen | --winecfg | --verify | --version] [game arguments]
  --configure   Open the original display/audio/game settings.
  --winecfg     Open Wine settings for this game's separate prefix.
  --verify      Check the packaged files without starting Wine.
  --version     Print the package and Wine versions.
Environment: FR3_DATA_HOME selects a writable absolute directory;
FR3_WINE selects an alternative Wine executable. Logs: FR3_DATA_HOME/last-run.log.
HELP
        exit 0 ;;
    --verify)
        cd "$ROOT"
        if command -v sha256sum >/dev/null 2>&1; then
            exec sha256sum -c MANIFEST.sha256
        fi
        exec shasum -a 256 -c MANIFEST.sha256 ;;
    --version)
        printf 'Ford Racing 3 Demo %s\n' "$VERSION"
        exec "${FR3_WINE:-$ROOT/runtime/bin/wine}" --version ;;
    --configure) ACTION=config; shift ;;
    --winecfg) ACTION=winecfg; shift ;;
    --desktop) ACTION=desktop; shift ;;
    --fullscreen) ACTION=fullscreen; shift ;;
esac

case "$(uname -s)" in
    Linux)
        if [ "$(uname -m)" != x86_64 ]; then
            printf 'This Linux package requires an x86_64 computer.\n' >&2; exit 1
        fi
        if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
            printf 'Start this game from a graphical desktop session.\n' >&2; exit 1
        fi
        STATE=${FR3_DATA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/ford-racing-3-demo}
        DESKTOP=${FR3_VIRTUAL_DESKTOP:-1}
        ;;
    Darwin)
        STATE=${FR3_DATA_HOME:-$HOME/Library/Application Support/Ford Racing 3 Demo}
        DESKTOP=${FR3_VIRTUAL_DESKTOP:-0}
        ;;
    *) printf 'Supported platforms: macOS and Linux x86_64.\n' >&2; exit 1 ;;
esac
case "$STATE" in /*) ;; *) printf 'FR3_DATA_HOME must be an absolute path.\n' >&2; exit 1 ;; esac
WINE=${FR3_WINE:-$ROOT/runtime/bin/wine}
if [ ! -x "$WINE" ]; then
    printf 'Wine executable unavailable: %s\n' "$WINE" >&2; exit 1
fi

mkdir -p "$STATE"
if [ ! -f "$STATE/game/.fr3-payload" ]; then
    if [ -e "$STATE/game" ]; then
        printf 'Existing game directory has no package marker: %s\nChoose another FR3_DATA_HOME to preserve those files.\n' "$STATE/game" >&2
        exit 1
    fi
    if ! mkdir "$STATE/.install-lock" 2>/dev/null; then
        printf 'Another first launch is copying game files. Try again after it finishes.\n' >&2; exit 1
    fi
    STAGED="$STATE/.game.$$"
    cleanup() { rm -rf -- "$STAGED"; rmdir "$STATE/.install-lock" 2>/dev/null || true; }
    trap cleanup EXIT
    cp -R "$ROOT/game" "$STAGED"
    chmod -R u+w "$STAGED"
    printf '%s\n' "$PAYLOAD" > "$STAGED/.fr3-payload"
    mv "$STAGED" "$STATE/game"
    cleanup
    trap - EXIT
elif [ "$(cat "$STATE/game/.fr3-payload")" != "$PAYLOAD" ]; then
    printf 'The installed game belongs to a different demo build. Choose another FR3_DATA_HOME.\n' >&2
    exit 1
fi

export WINEPREFIX="$STATE/prefix"
export WINEARCH=win64
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-$STATE/cache}
export WINEDEBUG=${WINEDEBUG:--all}
# This demo does not use .NET or HTML. Avoid unrelated first-run downloads.
export WINEDLLOVERRIDES="mscoree,mshtml=;winemenubuilder.exe=d${WINEDLLOVERRIDES:+;$WINEDLLOVERRIDES}"
mkdir -p "$XDG_CACHE_HOME"
cd "$STATE/game"
exec > "$STATE/last-run.log" 2>&1
printf 'Ford Racing 3 Demo %s\n' "$VERSION"
"$WINE" --version
if [ ! -f "$WINEPREFIX/system.reg" ]; then
    "$WINE" wineboot.exe -u
fi
SIZE=${FR3_DESKTOP_SIZE:-800x600}
if [[ ! "$SIZE" =~ ^[0-9]+x[0-9]+$ ]]; then
    printf 'FR3_DESKTOP_SIZE must have the form 800x600.\n' >&2; exit 1
fi
case "$ACTION" in
    config)
        cd "$STATE/game/CONFIG"
        if [ "$DESKTOP" = 1 ]; then
            exec "$WINE" explorer.exe "/desktop=FordRacing3,$SIZE" "$STATE/game/CONFIG/syscfg.exe" "$@"
        fi
        exec "$WINE" "$STATE/game/CONFIG/syscfg.exe" "$@" ;;
    winecfg) exec "$WINE" winecfg.exe "$@" ;;
    desktop) DESKTOP=1 ;;
    fullscreen) DESKTOP=0 ;;
esac
if [ "$DESKTOP" = 1 ]; then
    exec "$WINE" explorer.exe "/desktop=FordRacing3,$SIZE" "$STATE/game/fr3.exe" "$@"
fi
exec "$WINE" "$STATE/game/fr3.exe" "$@"
