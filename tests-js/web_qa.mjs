// Checks of the page's modules in Node with the real assembler and analyzer, and fuzzing of the pure parsers:
// - every example: its Intel and AT&T text assemble (LLVM, web/dist's module) to exactly its machine code, and it is
//   analyzed without failure on every microarchitecture of the menu
// - url-state.js: random states survive encodeState/decodeState; random fragments never throw and give valid states
// - hex-input.js: random text never throws; random bytes written in the accepted styles parse back to themselves
//
//   node tests-js/web_qa.mjs [--seed N]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLES, CLASSIC_EXAMPLES, SHOWCASE_EXAMPLES } from '../web/js/examples.js';
import { WasmAssembler } from '../web/js/assembler.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { DEFAULT_STATE, LIMITS, encodeState, decodeState } from '../web/js/url-state.js';
import { parseHexInput, toHex } from '../web/js/hex-input.js';
import { rng, ARCHS } from './fuzz-cases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(ROOT, 'web/dist');
const args = process.argv.slice(2);
const SEED = args.includes('--seed') ? Number(args[args.indexOf('--seed') + 1]) : 1;
let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + String(detail).slice(0, 1000) : ''}`); } return cond; }
if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }

// ---- the examples with the real modules
const all = [...EXAMPLES, ...CLASSIC_EXAMPLES];
const engine = await WasmEngine.create(fs.readFileSync(path.join(dist, 'wuica_wasm.wasm')));
const uarchBytes = fs.readFileSync(path.join(dist, 'data/uarch.json'));
await engine.loadUarch(uarchBytes);
const configs = JSON.parse(uarchBytes).configs;
const loadTable = async (arch) => {
  const table = configs[arch].name;
  if (!engine.hasArch(table)) await engine.loadArch(table, fs.readFileSync(path.join(dist, 'data/arch', `${table}.json`)));
};
if (fs.existsSync(path.join(dist, 'wuica_asm.wasm'))) {
  // the text gives the listed machine code, or an encoding of the same instructions with the same result (LLVM picks
  // "add r10, rcx" = 49 01 ca where the listing of the example "avx", from the reference's corpus, has 4c 03 d1)
  const asm = await WasmAssembler.create(fs.readFileSync(path.join(dist, 'wuica_asm.wasm')));
  await loadTable('SKL');
  for (const ex of all) {
    for (const syntax of ['intel', 'att']) {
      const r = await asm.assemble(ex.text[syntax], syntax);
      const hex = r.ok ? toHex(r.bytes) : null;
      const same = hex === ex.hex || (hex !== null && hex.length === ex.hex.length
        && (await engine.analyze(makeRequest(hex, 'SKL'))).text === (await engine.analyze(makeRequest(ex.hex, 'SKL'))).text);
      check(same && r.diagnostics.length === 0, `example ${ex.id}: the ${syntax} text assembles to its machine code`, JSON.stringify([hex, ex.hex, r.diagnostics]));
    }
  }
  // a byte order mark at the start is dropped; ';' is not a comment: the error says so
  const bom = await asm.assemble('\uFEFFadd rax, rbx\n', 'intel');
  check(bom.ok && toHex(bom.bytes) === '4801d8', 'assembler: a byte order mark at the start is dropped', JSON.stringify(bom));
  const semi = await asm.assemble('add rax, 1 ; one more\nnop\n', 'intel');
  check(!semi.ok && semi.diagnostics[0].line === 1 && /^invalid instruction mnemonic 'one' \(';' separates instructions; comments start with '#'\)$/.test(semi.diagnostics[0].message),
    "assembler: an error after ';' explains that it is not a comment", JSON.stringify(semi.diagnostics));
  const other = await asm.assemble('frobnicate rax\n', 'intel');
  check(!other.ok && !/separates/.test(other.diagnostics[0].message), "assembler: other errors get no ';' hint", JSON.stringify(other.diagnostics));
} else console.log('(no assembler in web/dist: the examples were not assembled)');
const t0 = performance.now();
for (const arch of ARCHS) {
  await loadTable(arch);
  for (const ex of [...all, ...SHOWCASE_EXAMPLES]) {
    const r = await engine.analyze(makeRequest(ex.hex, arch));
    // SNB and IVB do not decode AVX2, FMA and BMI2 (as in uiCA): those positions are skipped
    check(r.error === undefined && r.tp > 0 && (r.decodeErrors === 0 || ['SNB', 'IVB'].includes(arch)), `example ${ex.id} on ${arch}: a result`, JSON.stringify([r.error ?? r.tp, r.decodeErrors]));
  }
}
console.log(`examples: ${all.length + SHOWCASE_EXAMPLES.length} on ${ARCHS.length} microarchitectures in ${Math.round(performance.now() - t0)} ms`);

// ---- url-state.js
const r = rng(SEED);
const pick = (a) => a[Math.floor(r() * a.length)];
const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const CHARS = ['a', 'Z', '0', ' ', '\n', '\t', '#', '&', '=', '%', '+', '/', '?', 'é', '✓', '漢', '😀', '\u0000', '\\', '"', "'", '<', '>'];
const text = (n) => Array.from({ length: n }, () => pick(CHARS)).join('');
for (let i = 0; i < 500; i++) {
  const ab = r() < 0.3;
  const arch = pick(ARCHS);
  // as app.js writes it: the checked CPUs include the focused one
  const cpus = r() < 0.2 ? 'all' : r() < 0.5 ? '' : ARCHS.filter((k) => k === arch || r() < 0.2).join(',');
  const s = {
    ...DEFAULT_STATE, mode: pick(['asm', 'hex']), syntax: pick(['intel', 'att']), arch, cpus, text: text(int(0, 60)),
    alignmentOffset: int(...LIMITS.alignmentOffset), initPolicy: pick(['diff', 'same', 'stack']), simpleFrontEnd: r() < 0.5,
    noMicroFusion: r() < 0.5, noMacroFusion: r() < 0.5, minIterations: int(...LIMITS.minIterations), minCycles: int(...LIMITS.minCycles),
    cmpSweep: r() < 0.3, cost: r() < 0.3, costNop: false,
    ab, bMode: pick(['asm', 'hex']), bSyntax: pick(['intel', 'att']), bArch: pick(['', ...ARCHS]), bText: text(int(0, 30)), aWork: int(...LIMITS.aWork), bWork: int(...LIMITS.bWork),
  };
  if (s.mode === 'hex') s.syntax = 'intel';         // the syntax is only kept for assembly
  if (s.cpus === s.arch) s.cpus = '';               // one CPU: no list
  if (!ab) Object.assign(s, { bMode: 'asm', bSyntax: 'intel', bArch: '', bText: '', aWork: 1, bWork: 1 }); // side B only in A–B mode
  else if (s.bMode === 'hex') s.bSyntax = 'intel';
  if (s.cost) s.costNop = r() < 0.5;
  const f = encodeState(s);
  const back = decodeState(f);
  const want = { ...s };
  if (!check(/^[A-Za-z0-9=&_,%.-]*$/.test(f) && JSON.stringify(back) === JSON.stringify(want), `url: random state ${i} round trips`, JSON.stringify({ f, want, back }))) break;
}
const PIECES = ['v=1', 'v=2', 'm=asm', 'm=hex', 's=att', 'a=SKL', 'a=%ZZ', 'a=' + 'X'.repeat(40), 'as=all', 'as=,,,', 'as=%E0', 'al=-1', 'al=1e3', 'al=0x10',
  'mi=', 'mc=99999999999999999999', 'ip=stack', 'sfe=1', 'c=', 'c=!!', 'c=____', 'c=YWJj', 'c=%', 'ab=1', 'bm=asm', 'bk=0', 'bk=65', 'aw=0', 'bw=70000', 'aw=12', 'bc=YQ', 'ba=ICL', 'cost=1', '=', '&', '==', 'x'];
let threw = 0;
for (let i = 0; i < 3000; i++) {
  const f = Array.from({ length: int(0, 8) }, () => pick(PIECES)).join(pick(['&', '&&', '']));
  let s;
  try { s = decodeState((r() < 0.5 ? '#' : '') + f); } catch (e) { threw++; if (threw <= 3) console.log(`FAIL url: decodeState threw on ${JSON.stringify(f)}: ${e}`); continue; }
  if (s === null) continue;
  const valid = ['asm', 'hex'].includes(s.mode) && ['intel', 'att'].includes(s.syntax) && /^[A-Za-z0-9_-]{1,32}$/.test(s.arch) && typeof s.text === 'string'
    && Number.isInteger(s.alignmentOffset) && s.alignmentOffset >= 0 && s.alignmentOffset <= 63 && Number.isInteger(s.minIterations) && s.minIterations >= 1
    && Number.isInteger(s.minCycles) && s.minCycles >= 1 && ['diff', 'same', 'stack'].includes(s.initPolicy) && [s.aWork, s.bWork].every((w) => Number.isInteger(w) && w >= 1 && w <= 65536);
  if (!check(valid, `url: random fragment ${JSON.stringify(f)} gives a valid state`, JSON.stringify(s))) break;
}
check(threw === 0, 'url: decodeState never throws', `${threw} times`);

// ---- hex-input.js
let hexThrew = 0;
const HEXCHARS = ['0', '9', 'a', 'f', 'F', 'g', 'x', 'h', ' ', '\n', ':', ',', ';', '#', '/', '\\', '{', '}', '[', ']', '<', '>', '+', '.', 'é', '✓'];
for (let i = 0; i < 5000; i++) {
  const t = Array.from({ length: int(0, 80) }, () => pick(HEXCHARS)).join('');
  try {
    const p = parseHexInput(t);
    if (!check(p && (p.ok ? p.bytes instanceof Uint8Array && p.hex === toHex(p.bytes) : typeof p.message === 'string' && p.message !== ''), `hex: random text gives a result or a message`, JSON.stringify([t, p]))) break;
  } catch (e) { hexThrew++; if (hexThrew <= 3) console.log(`FAIL hex: parseHexInput threw on ${JSON.stringify(t)}: ${e}`); }
}
check(hexThrew === 0, 'hex: parseHexInput never throws', `${hexThrew} times`);
const STYLES = [
  (b) => b.map((x) => x.toString(16).padStart(2, '0')).join(''),
  (b) => b.map((x) => x.toString(16).padStart(2, '0')).join(' '),
  (b) => b.map((x) => '0x' + x.toString(16).padStart(2, '0')).join(', '),
  (b) => b.map((x) => '\\x' + x.toString(16).padStart(2, '0')).join(''),
  (b) => b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ') + '  ; a comment',
];
for (let i = 0; i < 500; i++) {
  const bytes = Array.from({ length: int(1, 40) }, () => int(0, 255));
  const style = int(0, STYLES.length - 1);
  const p = parseHexInput(STYLES[style](bytes));
  if (!check(p.ok && p.hex === toHex(bytes), `hex: random bytes in style ${style} parse back`, JSON.stringify([STYLES[style](bytes), p]))) break;
}

console.log(`${count} qa checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
