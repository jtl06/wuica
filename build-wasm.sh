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
   # llvm-ar next to clang (Homebrew), next to the file clang links to (Debian/Ubuntu: /usr/bin/clang -> /usr/lib/llvm-N/bin),
   # or on the PATH
   cc="$(command -v "$CC_wasm32_unknown_unknown" || echo "$CC_wasm32_unknown_unknown")"
   for ar in "$(dirname "$cc")/llvm-ar" "$(dirname "$(readlink -f "$cc" 2>/dev/null || echo "$cc")")/llvm-ar" "$(command -v llvm-ar || true)"; do
      if [ -n "$ar" ] && [ -x "$ar" ] && [ ! -d "$ar" ]; then export AR_wasm32_unknown_unknown="$ar"; break; fi
   done
fi
# do not embed local paths (they contain the user name) in panic messages: map them to neutral prefixes
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}/registry/src=/cargo-registry\x1f--remap-path-prefix=$PWD=/wuica\x1f--remap-path-prefix=$HOME=/home"
export CARGO_ENCODED_RUSTFLAGS="$(printf '%b' "$CARGO_ENCODED_RUSTFLAGS")"
export CFLAGS_wasm32_unknown_unknown="-ffile-prefix-map=$PWD=/wuica"
# the release profile with one codegen unit (only for this build; the output stays in target/wasm32-unknown-unknown/release):
# ~1.5% faster and ~20 kB smaller (gzip) than the default 16 units. Measured and not kept: opt-level 2 (no gain), "s" (25%
# slower), +simd128 (no gain; measured again in round 3: within 0.5%), wasm-opt -O3/-O4 (no gain on the fixture run, a few %
# worse on the real-code blocks; its size reduction is the name section it drops, which llvm-objcopy --remove-section=name does
# too: 4.24 -> 3.03 MB, 616 -> 556 kB with brotli, no change in compile time; not done: the names are kept).
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
cargo build -p wuica-wasm --target wasm32-unknown-unknown --release
if strings target/wasm32-unknown-unknown/release/wuica_wasm.wasm | grep -q "$HOME"; then
   echo "error: the module contains local paths" >&2; exit 1
fi
ls -l target/wasm32-unknown-unknown/release/wuica_wasm.wasm
