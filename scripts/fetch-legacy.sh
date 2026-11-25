#!/usr/bin/env bash
# The legacy files of a release (scripts/fetch-legacy.mjs): the engine files of the build that is live, from the site, for
# web/build.sh (WUICA_LEGACY_DIR). It only reads. Release steps: docs/PORTING.md, "Releases".
# Usage: scripts/fetch-legacy.sh DIR [--site URL] [--keep-previous]
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: scripts/fetch-legacy.sh DIR [--site URL] [--keep-previous]" >&2; exit 2; }
exec node "$(dirname "$0")/fetch-legacy.mjs" "$@"
