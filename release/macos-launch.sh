#!/bin/bash
set -euo pipefail
RESOURCES=$(cd -- "$(dirname -- "$0")/../Resources" && pwd)
if ! /bin/bash "$RESOURCES/launch.sh" "$@"; then
    /usr/bin/osascript -e 'display alert "Ford Racing 3 Demo could not start" message "See last-run.log in ~/Library/Application Support/Ford Racing 3 Demo. The release notes describe macOS requirements." as critical' >/dev/null 2>&1 || true
    exit 1
fi
