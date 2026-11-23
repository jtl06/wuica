// Tests of web/js/asm-text.js: machine code -> assembly text that the page's assembler turns back into exactly the
// same bytes. With the real decoder (wuica_wasm.wasm) and the real assembler (assembler/dist/wuica_asm.wasm), every
// block of the decoder fixtures (fixtures/decode_fixtures*.jsonl.gz), the SHA-256 showcase and the functions of the
// recorded Compiler Explorer answers go bytes -> assembly -> bytes, and must come back identical. Prints how many
// instructions became .byte lines, by kind.   Usage: node tests-js/web_asm_text.mjs [WASM] [ASM_WASM]
import fs from 'node:fs';
import zlib from 'node:zlib';
import { WasmEngine } from '../web/js/engine.js';
import { WasmAssembler } from '../web/js/assembler.js';
import { bytesToAsm, hexListing, createConverter, llvmSyntax, MAX_INSTRUCTIONS, SAME } from '../web/js/asm-text.js';
import { parseHexInput, hexToBytes, toHex } from '../web/js/hex-input.js';
import { parseListing, extractRange } from '../web/js/godbolt.js';
import { SHA256_BLOCK_HEX } from '../web/js/showcase.js';
import { EXAMPLES, CLASSIC_EXAMPLES } from '../web/js/examples.js';

const root = new URL('..', import.meta.url);
const wasmPath = process.argv[2] || new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
const asmPath = process.argv[3] || new URL('assembler/dist/wuica_asm.wasm', root);
if (!fs.existsSync(wasmPath) || !fs.existsSync(asmPath)) { console.log('the analyzer or the assembler module is missing: skipped'); process.exit(0); }

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const engine = await WasmEngine.create(fs.readFileSync(wasmPath));
const assembler = await WasmAssembler.create(fs.readFileSync(asmPath));
const io = { decode: (hex) => engine.decode(hex, 'ALL'), assemble: (text) => assembler.assemble(text, 'intel') };
const same = (a, b) => toHex(a) === toHex(b);
const back = async (text) => { const r = await assembler.assemble(text, 'intel'); return r.ok ? r.bytes : null; };

// --- small cases -----------------------------------------------------------------------------------------------------------
{
  const loop = hexToBytes('4883c00149ffcf75f7');
  const r = await bytesToAsm(loop, io);
  check(r.ok && r.text === 'loop:\n  add rax, 0x1\n  dec r15\n  jnz loop\n' && r.fallback.length === 0 && r.stage === 0, 'a loop: labels, Intel syntax, no .byte', JSON.stringify(r));

  // a forward branch inside the block, one to the end, one out of it
  const fwd = hexToBytes('85c074064883c001eb0a48ffc875f1e9dcffffff');
  const f = await bytesToAsm(fwd, io);
  const ft = f.text ?? '';
  check(f.ok && same(await back(ft), fwd), 'branches: the text assembles to the same bytes', ft);
  check(/^loop:\n/.test(ft) && /\n {2}jz L1\n/.test(ft) && /\n {2}jmp L2\n/.test(ft) && /\nL1:\n {2}dec rax\n {2}jnz loop\n/.test(ft), 'branches: targets inside the block are labels', ft);
  check(/\n {2}\.byte 0xe9, 0xdc, 0xff, 0xff, 0xff {2}# jmp -0x10\nL2:\n$/.test(ft) && f.fallback.length === 1, 'branches: a branch out of the block is a .byte line with its disassembly', ft);

  // a long branch whose target would fit a short one: {disp32}
  const long = hexToBytes('4883c0010f85f6ffffff');
  const l = await bytesToAsm(long, io);
  check(l.ok && l.text === 'loop:\n  add rax, 0x1\n  {disp32} jnz loop\n' && l.fallback.length === 0, 'a long branch keeps its length', JSON.stringify(l));

  // another encoding of the same instruction: a pseudo-prefix or the .s form if there is one, .byte otherwise
  const enc = hexToBytes('c4e1785810' + '8b4000' + '4189c0' + '448bc0' + '03fa');
  const e = await bytesToAsm(enc, io);
  check(e.ok && same(await back(e.text), enc) && /\{vex3\} vaddps xmm2, xmm0, xmmword ptr \[rax\]/.test(e.text) && /\{disp8\} mov eax, dword ptr \[rax\]/.test(e.text)
    && /\n {2}mov r8d, eax\n/.test(e.text) && /\n {2}mov\.s r8d, eax\n/.test(e.text) && /\.byte 0x03, 0xfa {2}# add edi, edx/.test(e.text) && e.fallback.length === 1, 'other encodings: {vex3}, {disp8}, mov.s; add (03 /r) as .byte', e.text);

  // a call of another function in an object file (the displacement is a relocation's placeholder, 0)
  const call = await bytesToAsm(hexToBytes('55e80000000090c3'), io);
  check(call.ok && call.text === '  push rbp\n  call ext\n  nop\n  ret\n', 'a call with an unresolved displacement is a call of a symbol', JSON.stringify(call));

  // bytes the decoder cannot decode
  const bad = hexToBytes('9006ffff90');
  const b = await bytesToAsm(bad, io);
  check(b.ok && same(await back(b.text), bad) && /\.byte 0x06/.test(b.text), 'undecodable bytes are .byte lines', JSON.stringify(b));

  check(llvmSyntax('lea r12, ptr [rcx+0x8]') === 'lea r12, [rcx+0x8]' && llvmSyntax('movzx eax, byte ptr [rax]') === 'movzx eax, byte ptr [rax]'
    && llvmSyntax('nop word ptr [rax+rax*1], ax') === 'nop word ptr [rax+rax*1]' && llvmSyntax('xlat') === 'xlatb', 'XED\'s syntax where LLVM reads it differently');

  const big = await bytesToAsm(new Uint8Array(MAX_INSTRUCTIONS + 1).fill(0x90), io);
  check(!big.ok && big.why === 'too large', 'above the size limit: no conversion', JSON.stringify(big));
  check(!(await bytesToAsm(new Uint8Array(0), io)).ok, 'no bytes: no conversion');

  // the listing for a switch to hex reads back as the same bytes
  const lst = hexListing(fwd, await engine.decode(toHex(fwd), 'ALL'));
  check(same(parseHexInput(lst).bytes, fwd) && /^ {3}0:  85 c0 +test eax, eax$/m.test(lst) && /jz 0xa$/m.test(lst), 'hex listing: reads back as the same bytes', lst);
}

// --- the page's conversions (createConverter) ----------------------------------------------------------------------------
{
  const conv = createConverter({ decoder: async () => engine, assembler: async () => assembler });
  const ex = EXAMPLES[0];
  check(await conv.convert({ mode: 'hex', syntax: 'intel', text: ex.text.hex }, 'asm', ex.text.intel) === SAME, 'switch: the other box already has the same code: kept (marked as the same code)');
  check(await conv.convert({ mode: 'asm', syntax: 'att', text: ex.text.att }, 'hex', ex.text.hex) === SAME, 'switch: the same in the other direction (AT&T)');
  const toAsm = await conv.convert({ mode: 'hex', syntax: 'att', text: CLASSIC_EXAMPLES[0].text.hex }, 'asm', ex.text.intel);
  check(toAsm?.syntax === 'intel' && same((await assembler.assemble(toAsm.text, 'intel')).bytes, parseHexInput(CLASSIC_EXAMPLES[0].text.hex).bytes), 'switch: hex -> asm (Intel)', JSON.stringify(toAsm));
  const toHexR = await conv.convert({ mode: 'asm', syntax: 'intel', text: 'loop:\n  add rax, 1\n  dec r15\n  jnz loop\n' }, 'hex', '');
  check(toHexR?.mode === 'hex' && toHexR.text === '   0:  48 83 c0 01    add rax, 0x1\n   4:  49 ff cf       dec r15\n   7:  75 f7          jnz 0x0\n', 'switch: asm -> hex (a listing)', JSON.stringify(toHexR));
  check(await conv.convert({ mode: 'hex', syntax: 'intel', text: 'zz' }, 'asm', '') === null && await conv.convert({ mode: 'asm', syntax: 'intel', text: 'frobnicate' }, 'hex', '') === null
    && await conv.convert({ mode: 'hex', syntax: 'intel', text: '  ' }, 'asm', '') === null, 'switch: nothing to convert (empty, not hex, not assembly): null');
  const none = createConverter({ decoder: async () => null, assembler: async () => assembler });
  check(await none.fromBytes(hexToBytes('90')) === null, 'no decoder (mock mode): no conversion');
}

// --- round trips -----------------------------------------------------------------------------------------------------------
const blocks = new Map(); // hex -> source
for (const f of ['decode_fixtures.jsonl.gz', 'decode_fixtures_extra.jsonl.gz']) {
  for (const l of zlib.gunzipSync(fs.readFileSync(new URL(`fixtures/${f}`, root))).toString().trim().split('\n')) {
    const c = JSON.parse(l);
    if (!blocks.has(c.hex)) blocks.set(c.hex, `${f}: ${c.file}`);
  }
}
blocks.set(SHA256_BLOCK_HEX.replace(/\s+/g, ''), 'showcase: SHA-256');
for (const name of fs.readdirSync(new URL('tests-js/fixtures/godbolt/', root)).filter((n) => /^compile-.*\.json$/.test(n))) {
  const listing = parseListing(JSON.parse(fs.readFileSync(new URL(`tests-js/fixtures/godbolt/${name}`, root), 'utf8')));
  if (!listing.binary) continue;
  for (const fn of listing.functions) {
    const first = fn.items.findIndex((it) => it.kind === 'instr');
    const ext = extractRange(fn, first, fn.items.length - 1, listing);
    const p = parseHexInput(ext.text);
    if (p.ok) blocks.set(p.hex, `${name}: ${fn.name}`);
  }
}
let n = 0, fallback = 0, bad = 0, ms = 0;
const kinds = new Map(), stages = [0, 0, 0, 0];
for (const [hex, source] of blocks) {
  const bytes = hexToBytes(hex);
  const t0 = performance.now();
  const r = await bytesToAsm(bytes, io);
  ms += performance.now() - t0;
  if (!r.ok) { bad++; if (bad <= 5) console.log(`not converted: ${source}: ${r.why}`); continue; }
  const again = await back(r.text);
  if (!again || !same(again, bytes)) { bad++; if (bad <= 5) console.log(`not the same bytes: ${source}`); continue; }
  n += r.instructions;
  stages[r.stage]++;
  fallback += r.fallback.length;
  for (const f of r.fallback) {
    const k = f.asm.replace(/ .*/, '') + (/^\S+ [a-z0-9]+, [a-z0-9]+$/.test(f.asm) ? ' reg, reg' : '');
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
}
check(bad === 0, `round trip: every block comes back as the same bytes (${blocks.size} blocks)`, `${bad} did not`);
check(stages[2] === 0 && stages[3] === 0, 'round trip: no block needed its branches (or everything) as bytes', JSON.stringify(stages));
console.log(`${blocks.size} blocks, ${n} instructions (${(ms / 1000).toFixed(1)} s): ${fallback} as .byte (${(100 * fallback / Math.max(1, n)).toFixed(1)}%); blocks by stage ${stages.join(' / ')}`);
console.log(`.byte by kind: ${[...kinds].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, c]) => `${k} ${c}`).join(', ')}`);
console.log(`${count} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
