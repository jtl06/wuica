#!/usr/bin/env bash
# The smoke test of the live site and API after a deploy (scripts/smoke-live.mjs: the version, the service worker's cache,
# one analysis in headless Chrome, the bytes on the wire against tests-js/budgets.mjs; /healthz, /api/version, analyze,
# compare, MCP tools/list and what_if). It only reads; it deploys nothing.
# Usage: scripts/smoke-live.sh VERSION [--site URL] [--api URL] [--chrome PATH] [--no-site] [--no-api] [--no-legacy]
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -ge 1 ] || { echo "usage: scripts/smoke-live.sh VERSION [--site URL] [--api URL] [--chrome PATH] [--no-site] [--no-api] [--no-legacy]" >&2; exit 2; }
exec node scripts/smoke-live.mjs "$@"
