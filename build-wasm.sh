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
# llvm-objcopy (from the same LLVM as llvm-ar) removes the name section from the module that is shipped (see the end)
objcopy="${LLVM_OBJCOPY:-}"
if [ -z "$objcopy" ]; then
   for o in "$(dirname "${AR_wasm32_unknown_unknown:-llvm-ar}")/llvm-objcopy" "$(command -v llvm-objcopy || true)"; do
      if [ -n "$o" ] && [ -x "$o" ] && [ ! -d "$o" ]; then objcopy="$o"; break; fi
   done
fi
[ -n "$objcopy" ] || { echo "no llvm-objcopy found next to llvm-ar or on the PATH; set LLVM_OBJCOPY"; exit 1; }
# do not embed local paths (they contain the user name) in panic messages: map them to neutral prefixes
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}/registry/src=/cargo-registry\x1f--remap-path-prefix=$PWD=/wuica\x1f--remap-path-prefix=$HOME=/home"
export CARGO_ENCODED_RUSTFLAGS="$(printf '%b' "$CARGO_ENCODED_RUSTFLAGS")"
export CFLAGS_wasm32_unknown_unknown="-ffile-prefix-map=$PWD=/wuica"
# the release profile with one codegen unit (only for this build; the output stays in target/wasm32-unknown-unknown/release):
# ~1.5% faster and ~20 kB smaller (gzip) than the default 16 units. Measured and not kept: opt-level 2 (no gain), "s" (25%
# slower), +simd128 (no gain; measured again in round 3: within 0.5%), wasm-opt -O3/-O4 (no gain on the fixture run, a few %
# worse on the real-code blocks; its size reduction is the name section it drops, which llvm-objcopy --remove-section=name does
# too: 4.24 -> 3.03 MB, 616 -> 556 kB with brotli, no change in compile time).
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
cargo build -p wuica-wasm --target wasm32-unknown-unknown --release
out=target/wasm32-unknown-unknown/release
# The name section (the function names, from the linker) is 1.21 of the 4.31 MB, 60 kB of the 630 kB with brotli -q 11 and
# 94 kB of 841 kB with -q 4 (0.1.8). Nothing that runs reads it: a trap's message ("unreachable", "memory access out of bounds"),
# which the page, the npm package and the server report, is the same without it; only the frames of a stack trace and a
# profile lose the names, and they keep the function index and the code offset, which are the same in both files because the
# name section is the last one. So the module that is shipped (wuica_wasm.wasm, which web/build.sh, packages/wuica/build.sh
# and the tests read) has no name section and no producers section; the same module with them is kept beside it as
# wuica_wasm.debug.wasm, for `node --cpu-prof` and to name the frames of a stack trace (wasm-function[N] is function N there).
# The compile time is the same (V8 reads the names only for a stack trace). If cargo did not link again, wuica_wasm.wasm is
# still the stripped file of the last run and wuica_wasm.debug.wasm its copy with names. New files are written and moved
# into place: the file cargo links is a hard link of the one in its build directory.
rm -f "$out"/.wuica_wasm.*.tmp
if "$objcopy" --dump-section name="$out/.wuica_wasm.name.tmp" "$out/wuica_wasm.wasm" "$out/.wuica_wasm.copy.tmp" 2>/dev/null; then
   cp "$out/wuica_wasm.wasm" "$out/.wuica_wasm.debug.tmp"
   "$objcopy" --remove-section=name --remove-section=producers "$out/.wuica_wasm.debug.tmp" "$out/.wuica_wasm.stripped.tmp"
   mv "$out/.wuica_wasm.debug.tmp" "$out/wuica_wasm.debug.wasm"
   mv "$out/.wuica_wasm.stripped.tmp" "$out/wuica_wasm.wasm"
elif [ ! -f "$out/wuica_wasm.debug.wasm" ]; then
   echo "error: $out/wuica_wasm.wasm has no name section and wuica_wasm.debug.wasm is missing; delete it and build again" >&2; exit 1
fi
rm -f "$out"/.wuica_wasm.*.tmp
for f in "$out/wuica_wasm.wasm" "$out/wuica_wasm.debug.wasm"; do
   if strings "$f" | grep -q "$HOME"; then echo "error: $f contains local paths" >&2; exit 1; fi
done
ls -l "$out/wuica_wasm.wasm" "$out/wuica_wasm.debug.wasm"
