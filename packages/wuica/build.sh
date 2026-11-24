#!/usr/bin/env bash
# Builds the contents of the npm package that are generated from the rest of the repository:
#   dist/wuica_wasm.wasm.br         the analyzer (crates/wuica-wasm), brotli-compressed
#   dist/wuica_asm.wasm.br          the assembler (assembler/dist), brotli-compressed
#   dist/data/uarch.json.br         the configurations (data/uarch.json)
#   dist/data/arch/<NAME>.bin.br    the instruction tables in their binary form (tools/encode-tables.sh, from
#                                   data/arch/*.json; crates/wuica-core/src/table_bin.rs)
#   dist/manifest.json              size and sha256 of each file (a table also with its JSON's: `source`); tables: the
#                                   format and one sha256 of the JSON tables (whatever form is shipped); uiCA: the
#                                   reference whose data and model these are, from ci/data-asset.txt (uica_commit), the
#                                   one place it is written down
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
TABLES="$(mktemp -d)"
trap 'rm -rf "$TABLES"' EXIT
"$ROOT/tools/encode-tables.sh" "$DATA/arch" "$TABLES"

# brotli (quality 11, 24-bit window) with Node's zlib, so no extra tool is needed; Node decompresses it at run time.
UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-8}" node --input-type=module - "$PKG/dist" "$WASM" "$ASM_WASM" "$DATA" "$ROOT/ci/data-asset.txt" "$TABLES" <<'EOF'
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib'; import crypto from 'node:crypto';
const [out, wasm, asmWasm, data, asset, tables] = process.argv.slice(2);
// "uica_commit=640e40e (improve-r9)": the commit and its branch
const m = /^uica_commit=([0-9a-f]{7,40})(?:\s+\(([^)]+)\))?\s*$/m.exec(fs.readFileSync(asset, 'utf8'));
if (!m) throw new Error(`${asset}: no uica_commit line`);
const files = [[wasm, 'wuica_wasm.wasm'], [asmWasm, 'wuica_asm.wasm'], [path.join(data, 'uarch.json'), 'data/uarch.json']];
// the tables in their binary form, each with the JSON it was made from (its source)
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sources = {};
for (const f of fs.readdirSync(path.join(data, 'arch')).filter((f) => f.endsWith('.json')).sort()) {
  const name = f.slice(0, -5), json = fs.readFileSync(path.join(data, 'arch', f));
  if (!fs.existsSync(path.join(tables, `${name}.bin`))) throw new Error(`${name}.bin was not written`);
  files.push([path.join(tables, `${name}.bin`), `data/arch/${name}.bin`]);
  sources[`data/arch/${name}.bin`] = { file: `data/arch/${f}`, size: json.length, sha256: sha(json) };
}
const { BROTLI_PARAM_QUALITY: Q, BROTLI_PARAM_LGWIN: W, BROTLI_PARAM_SIZE_HINT: S } = zlib.constants;
// tables.sha256: of the JSON tables (the sha256 of "<name>.json <sha256>\n" lines in name order), the same whichever form
// is shipped; format: the binary form's magic and version
const tablesSha = sha(Object.values(sources).map((s) => `${path.basename(s.file)} ${s.sha256}\n`).join(''));
const manifest = { uiCA: { repository: 'https://github.com/jtl06/uiCA', commit: m[1], ...(m[2] ? { branch: m[2] } : {}) },
  tables: { format: 'WUICATBL 1', sha256: tablesSha }, files: {} };
let raw = 0, packed = 0;
// compressed in parallel on libuv's thread pool (largest first); the manifest keeps the order of `files`
const brotli = (bytes) => new Promise((ok, fail) => zlib.brotliCompress(bytes, { params: { [Q]: 11, [W]: 24, [S]: bytes.length } }, (e, r) => (e ? fail(e) : ok(r))));
const inputs = files.map(([src, name]) => ({ name, bytes: fs.readFileSync(src) }));
const packedFiles = new Map();
await Promise.all([...inputs].sort((a, b) => b.bytes.length - a.bytes.length).map(async ({ name, bytes }) => packedFiles.set(name, await brotli(bytes))));
for (const { name, bytes } of inputs) {
  const br = packedFiles.get(name);
  fs.writeFileSync(path.join(out, name + '.br'), br);
  manifest.files[name] = { size: bytes.length, sha256: sha(bytes), ...(sources[name] ? { source: sources[name] } : {}) };
  raw += bytes.length; packed += br.length;
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`${files.length} files: ${(raw / 1e6).toFixed(1)} MB -> ${(packed / 1e6).toFixed(2)} MB (brotli)`);
EOF

cp "$ROOT/LICENSE" "$PKG/LICENSE"
cp "$ROOT/third_party/xed/LICENSE" "$PKG/licenses/LICENSE-XED.txt"
cp "$ROOT/assembler/LICENSE-LLVM.txt" "$PKG/licenses/LICENSE-LLVM.txt"

if [ "${1:-}" = "--pack" ]; then
  (cd "$PKG" && npm pack)
fi
