#!/usr/bin/env bash
# Builds what is out of date and runs all test suites in parallel, with one summary table at the end (see docs/PORTING.md,
# "Checks"). The work is done by scripts/check.mjs; this wrapper sets up PATH and sccache, and runs the check on another
# host with --remote.
#
#   scripts/check.sh [quick|full] [--only PATTERN] [--jobs N] [--chrome-jobs N] [--list] [--remote HOST]
#
#   quick (default)  subsets, about a minute: before every commit of work in progress
#   full             everything: the gate before a commit to main or a deploy
#   --only PATTERN   only the suites whose name matches (a regular expression; --list shows the names)
#   --remote HOST    copy the tree to ~/wuica-check on HOST (rsync), and run the check there under a perfq lease (shared);
#                    the WebAssembly module is built here and copied (the host needs no wasm32 target)
#
# Logs: target/check/<suite>.log. Exit status 1 if a suite failed.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# cargo: not on the default PATH on the development Mac; ~/.cargo/bin elsewhere
for d in "$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin" "$HOME/.cargo/bin"; do
  if [ -d "$d" ]; then PATH="$d:$PATH"; fi
done
export PATH
# a shared compiler cache, if installed (not required)
if [ -z "${RUSTC_WRAPPER:-}" ] && command -v sccache >/dev/null 2>&1; then
  export RUSTC_WRAPPER="$(command -v sccache)"
fi

remote=""
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) remote="${2:?--remote needs a host}"; shift 2 ;;
    --remote=*) remote="${1#--remote=}"; shift ;;
    *) args+=("$1"); shift ;;
  esac
done

if [ -z "$remote" ]; then
  exec node scripts/check.mjs ${args[@]+"${args[@]}"}
fi

# ---- remote: build the WebAssembly module here (if out of date), copy the tree, run the check there under a lease
dir="wuica-check"
node scripts/check.mjs --wasm-only >/dev/null || { echo "check: building the WebAssembly module failed (target/check/build_wasm.log)" >&2; exit 1; }
echo "check: copying the tree to $remote:~/$dir"
ssh "$remote" "mkdir -p ~/$dir/target/wasm32-unknown-unknown/release ~/$dir/fixtures"
# data/ and fixtures/generated/ are symlinks to the host's own copies; target dirs, dist/ and node_modules/ stay on the host
rsync -a --delete \
  --exclude '/target*' --exclude 'node_modules' --exclude '.claude' --exclude '.git' --exclude '.DS_Store' \
  --exclude '/data' --exclude '/fixtures/generated' --exclude '/web/dist' --exclude '/packages/wuica/dist' \
  ./ "$remote:$dir/"
rsync -a target/wasm32-unknown-unknown/release/wuica_wasm.wasm "$remote:$dir/target/wasm32-unknown-unknown/release/"
ssh "$remote" "cd ~/$dir && ln -sfn ~/wuica/data data && ln -sfn ~/wuica/fixtures/generated fixtures/generated"

quoted=""
for a in ${args[@]+"${args[@]}"}; do quoted+=" $(printf '%q' "$a")"; done
echo "check: running on $remote under a perfq lease (waits while the host is busy)"
exec "$HOME/perfq/perfq" ssh "$remote" --est 10m --mode shared -- "cd ~/$dir && bash scripts/check.sh --no-wasm-build$quoted"
