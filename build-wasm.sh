#!/usr/bin/env bash
# Builds the WebAssembly module (target/wasm32-unknown-unknown/release/wuica_wasm.wasm).
# The C part (XED) needs a clang that has the wasm32 target; Apple's clang does not, Homebrew's llvm does.
set -e
if [ -z "$CC_wasm32_unknown_unknown" ]; then
   for c in /opt/homebrew/opt/llvm/bin/clang /usr/local/opt/llvm/bin/clang clang; do
      if "$c" --print-targets 2>/dev/null | grep -q wasm32; then export CC_wasm32_unknown_unknown="$c"; break; fi
   done
fi
[ -n "$CC_wasm32_unknown_unknown" ] || { echo "no clang with the wasm32 target found; set CC_wasm32_unknown_unknown"; exit 1; }
if [ -z "$AR_wasm32_unknown_unknown" ]; then
   ar="$(dirname "$CC_wasm32_unknown_unknown")/llvm-ar"
   [ -x "$ar" ] && export AR_wasm32_unknown_unknown="$ar"
fi
cargo build -p wuica-wasm --target wasm32-unknown-unknown --release
ls -l target/wasm32-unknown-unknown/release/wuica_wasm.wasm
