#!/usr/bin/env bash
# Sets up (or updates) the check runner, a Linux host on which scripts/check-remote.sh runs the full check of any commit
# (see docs/PORTING.md, "Check runner"). Run it here, in a checkout on the development machine: it works over ssh, needs
# no root on the runner and does only light work (downloads, unpacking); the first check does the builds.
#
#   scripts/runner-setup.sh [--host HOST] [--chrome-update] [--no-chrome] [--more-sim]
#
#   --host HOST       the runner's ssh host alias (default: $WUICA_RUNNER, else diomedea)
#   --chrome-update   install the current Chrome for Testing stable build even if one is installed
#   --no-chrome       no Chrome
#   --more-sim        also copy this checkout's fixtures/generated/more_sim_fixtures.jsonl.gz (not in the CI data asset;
#                     with it, `full` runs the simulation fixtures of the set 'more', as here)
#
# On the runner everything lives under $WUICA_RUNNER_DIR (default /data/projects/wuica-check):
#   repo.git/        a bare repository; check-remote.sh pushes the commit to check to refs/check/<sha>
#   tree/            the one worktree the checks run in (made by the first check; target/ and node_modules/ persist)
#   assets/<tag>/    the CI data asset of each tag named in a ci/data-asset.txt (data/, fixtures/generated/, the assembler
#                    and llvm-mca modules), fetched and checked by the first check that needs it
#   extra/           files beside the asset (--more-sim)
#   chrome/          Chrome for Testing: <version>/ (SOURCE.txt: URL, sha256), current -> <version>, and chrome/chrome, the
#                    wrapper the check runs
#   runs/<id>/       each run's output, exit status, results.json and logs (the last 30 are kept)
# Toolchains stay where they are: rustup in the home directory (this adds the target wasm32-unknown-unknown), the system's
# Node (22 or later), clang (with the wasm32 target) and its llvm-ar and llvm-objcopy.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
host="${WUICA_RUNNER:-diomedea}"
dir="${WUICA_RUNNER_DIR:-/data/projects/wuica-check}"
chrome=1 chrome_update=0 more_sim=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) host="${2:?--host needs a host}"; shift 2 ;;
    --chrome-update) chrome_update=1; shift ;;
    --no-chrome) chrome=0; shift ;;
    --more-sim) more_sim=1; shift ;;
    *) echo "usage: scripts/runner-setup.sh [--host HOST] [--chrome-update] [--no-chrome] [--more-sim]" >&2; exit 2 ;;
  esac
done
remote="$root/scripts/runner-remote.sh"
q() { printf ' %q' "$@"; }

echo "runner-setup: $host:$dir"
ssh "$host" "bash -s --$(q setup "$dir" "$chrome" "$chrome_update")" < "$remote"

# the data asset of this checkout's ci/data-asset.txt (a check fetches another tag when its commit names one)
get() { sed -n "s/^$1=//p" "$root/ci/data-asset.txt"; }
ssh "$host" "bash -s --$(q asset "$dir" "$(get tag)" "$(get file)" "$(get sha256)")" < "$remote"
echo "data asset: $(get tag) ($(get files) files)"

if [ "$more_sim" = 1 ]; then
  f="$root/fixtures/generated/more_sim_fixtures.jsonl.gz"
  [ -f "$f" ] || { echo "runner-setup: $f is missing" >&2; exit 1; }
  ssh "$host" "mkdir -p $(printf %q "$dir/extra/fixtures/generated")"
  rsync -aL "$f" "$host:$dir/extra/fixtures/generated/"
  echo "extra: fixtures/generated/more_sim_fixtures.jsonl.gz"
fi
echo "runner-setup: done; scripts/check-remote.sh runs a check there"
