#!/usr/bin/env bash
# Builds the contents of the npm package that are generated from the rest of the repository:
#   dist/wuica_wasm.wasm.br         the analyzer (crates/wuica-wasm), brotli-compressed
#   dist/wuica_asm.wasm.br          the assembler (assembler/dist), brotli-compressed
#   dist/data/uarch.json.br         the configurations (data/uarch.json)
#   dist/data/arch/<NAME>.json.br   the instruction tables (data/arch/*.json)
#   dist/web/*.js                   the web page's modules for pasted assembly (web/js: loop-find.js, asm-regions.js,
#                                   assembler.js; caveats.js, accum.js), so the API reads assembly as the page does
#   LICENSE, licenses/              the license texts (AGPL-3.0, Intel XED, LLVM)
# Then `npm pack` in this directory makes the tarball (`./build.sh --pack` does both).
#
# Environment: WUICA_WASM (analyzer module; default target/wasm32-unknown-unknown/release/wuica_wasm.wasm, built
# with ./build-wasm.sh if missing), WUICA_ASM_WASM (default assembler/dist/wuica_asm.wasm), WUICA_DATA (default data).
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$PKG/../.." && pwd)"
WASM="${WUICA_WASM:-$ROOT/target/wasm32-unknown-unknown/release/wuica_wasm.wasm}"
ASM_WASM="${WUICA_ASM_WASM:-$ROOT/assembler/dist/wuica_asm.wasm}"
DATA="${WUICA_DATA:-$ROOT/data}"
# the web page's DOM-free modules the library uses (scripts/check.mjs hashes them for the package's stamp)
WEB_MODULES="loop-find.js asm-regions.js assembler.js"

if [ ! -f "$WASM" ]; then
  echo "building the analyzer module (./build-wasm.sh)"
  (cd "$ROOT" && ./build-wasm.sh)
fi
for f in "$WASM" "$ASM_WASM" "$DATA/uarch.json"; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }
done
ls "$DATA"/arch/*.json > /dev/null

rm -rf "$PKG/dist" "$PKG/licenses"
mkdir -p "$PKG/dist/data/arch" "$PKG/licenses"

# brotli (quality 11, 24-bit window) with Node's zlib, so no extra tool is needed; Node decompresses it at run time.
UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-8}" node --input-type=module - "$PKG/dist" "$WASM" "$ASM_WASM" "$DATA" <<'EOF'
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib'; import crypto from 'node:crypto';
const [out, wasm, asmWasm, data] = process.argv.slice(2);
const files = [[wasm, 'wuica_wasm.wasm'], [asmWasm, 'wuica_asm.wasm'], [path.join(data, 'uarch.json'), 'data/uarch.json']];
for (const f of fs.readdirSync(path.join(data, 'arch')).filter((f) => f.endsWith('.json')).sort()) files.push([path.join(data, 'arch', f), 'data/arch/' + f]);
const { BROTLI_PARAM_QUALITY: Q, BROTLI_PARAM_LGWIN: W, BROTLI_PARAM_SIZE_HINT: S } = zlib.constants;
const manifest = { files: {} };
let raw = 0, packed = 0;
// compressed in parallel on libuv's thread pool (largest first); the manifest keeps the order of `files`
const brotli = (bytes) => new Promise((ok, fail) => zlib.brotliCompress(bytes, { params: { [Q]: 11, [W]: 24, [S]: bytes.length } }, (e, r) => (e ? fail(e) : ok(r))));
const inputs = files.map(([src, name]) => ({ name, bytes: fs.readFileSync(src) }));
const packedFiles = new Map();
await Promise.all([...inputs].sort((a, b) => b.bytes.length - a.bytes.length).map(async ({ name, bytes }) => packedFiles.set(name, await brotli(bytes))));
for (const { name, bytes } of inputs) {
  const br = packedFiles.get(name);
  fs.writeFileSync(path.join(out, name + '.br'), br);
  manifest.files[name] = { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  raw += bytes.length; packed += br.length;
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`${files.length} files: ${(raw / 1e6).toFixed(1)} MB -> ${(packed / 1e6).toFixed(2)} MB (brotli)`);
EOF

mkdir -p "$PKG/dist/web"
for f in $WEB_MODULES; do cp "$ROOT/web/js/$f" "$PKG/dist/web/$f"; done

cp "$ROOT/LICENSE" "$PKG/LICENSE"
cp "$ROOT/third_party/xed/LICENSE" "$PKG/licenses/LICENSE-XED.txt"
cp "$ROOT/assembler/LICENSE-LLVM.txt" "$PKG/licenses/LICENSE-LLVM.txt"

if [ "${1:-}" = "--pack" ]; then
  (cd "$PKG" && npm pack)
fi
