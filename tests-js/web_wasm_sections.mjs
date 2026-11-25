// The WebAssembly modules as they are shipped (build-wasm.sh, web/build.sh): no name section in any of them (it is a quarter
// of the analyzer and nothing that runs reads it), and the analyzer's copy with names (wuica_wasm.debug.wasm, for profiles
// and stack traces) is the same module: every section but the custom ones byte for byte, so a frame's function index and
// code offset mean the same in both.
// Usage: node tests-js/web_wasm_sections.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { engineRel } from './dist-files.mjs';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);
const file = (p) => new URL(p, root);

// the sections of a module: [{id, name (custom sections), bytes}]
function sections(bytes) {
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x6d736100) throw new Error('not a WebAssembly module');
  let p = 8;
  const leb = () => { let r = 0, s = 0, x; do { x = bytes[p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return r; };
  const out = [];
  while (p < bytes.length) {
    const id = bytes[p++]; const size = leb(); const start = p;
    let name = null;
    if (id === 0) { const n = leb(); name = bytes.subarray(p, p + n).toString(); }
    out.push({ id, name, bytes: bytes.subarray(start, start + size) });
    p = start + size;
  }
  if (p !== bytes.length) throw new Error('truncated module');
  return out;
}

const WASM = 'target/wasm32-unknown-unknown/release/wuica_wasm.wasm';
const DEBUG = 'target/wasm32-unknown-unknown/release/wuica_wasm.debug.wasm';
const shipped = fs.readFileSync(file(WASM));
const s = sections(shipped);
const customs = s.filter((x) => x.id === 0).map((x) => x.name);
check(!customs.includes('name') && !customs.includes('producers'), `${WASM}: no name or producers section`, customs.join());
check(s.some((x) => x.id === 10) && s.some((x) => x.id === 11), `${WASM}: has its code and data`);

if (fs.existsSync(file(DEBUG))) {
  const n = sections(fs.readFileSync(file(DEBUG)));
  const nameSec = n.find((x) => x.id === 0 && x.name === 'name');
  check(nameSec && nameSec.bytes.length > 100000, `${DEBUG}: has the name section`, String(nameSec?.bytes.length));
  const core = (list) => list.filter((x) => x.id !== 0);
  const a = core(s), b = core(n);
  check(a.length === b.length && a.every((x, i) => x.id === b[i].id && Buffer.compare(x.bytes, b[i].bytes) === 0),
    `${DEBUG} is ${WASM} with names: the same sections apart from the custom ones`);
  // the custom sections come after the code and data (the code offsets in a stack trace are the same in both files)
  const lastCore = (list) => list.findLastIndex((x) => x.id !== 0);
  check(n.findIndex((x) => x.id === 0) > lastCore(n), `${DEBUG}: the custom sections are at the end`);
} else {
  console.log(`(${DEBUG} missing: built elsewhere; its comparison is skipped)`);
}

// what the site serves
const dist = 'web/dist/';
if (fs.existsSync(file(dist + 'manifest.json'))) {
  // (the analyzer's name holds a hash of its content: the manifest's, dist-files.mjs)
  const analyzer = engineRel(fileURLToPath(file(dist)), 'wuica_wasm.wasm');
  check(Buffer.compare(fs.readFileSync(file(dist + analyzer)), shipped) === 0, `${dist}${analyzer} is ${WASM}`);
  for (const m of [analyzer, 'wuica_asm.wasm', 'wuica_mca.wasm']) {
    if (!fs.existsSync(file(dist + m))) continue;
    const c = sections(fs.readFileSync(file(dist + m))).filter((x) => x.id === 0).map((x) => x.name);
    check(!c.includes('name'), `${dist}${m}: no name section`, c.join());
  }
}

console.log(`${count} module section checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
