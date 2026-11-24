#!/usr/bin/env bash
# The binary instruction tables that the npm package, the web page and the server ship: IN_DIR/<NAME>.json ->
# OUT_DIR/<NAME>.bin (crates/wuica-core/src/table_bin.rs; each is checked to read back into the same tables as its JSON).
#   tools/encode-tables.sh [IN_DIR [OUT_DIR]]     (default: data/arch, target/tables)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IN="${1:-$ROOT/data/arch}"
OUT="${2:-$ROOT/target/tables}"
# cargo: not on the default PATH on the development Mac; ~/.cargo/bin elsewhere (as scripts/check.sh)
for d in "$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin" "$HOME/.cargo/bin"; do
  if [ -d "$d" ]; then PATH="$d:$PATH"; fi
done
command -v cargo > /dev/null || { echo "tools/encode-tables.sh: cargo not found" >&2; exit 1; }
mkdir -p "$OUT"
(cd "$ROOT" && cargo run --release --quiet -p wuica-core --example encode_tables -- "$IN" "$OUT") > /dev/null
ls "$OUT"/*.bin > /dev/null
