// Tests of the warnings for the model's known blind spots (web/js/caveats.js; the API's insights.caveats): a read-modify-
// write to an indexed address, an exit before the loop's branch, loads that may split a cache line. With the analyzer,
// the loops of the dogfood runs (tests-js/fixtures/caveats): gcc's FIR (3.7 split loads per iteration measured) and the
// winning variant (1.5) warn, the all-shuffle variant (0) does not; the histogram warns; the scan loop has an exit.
// Usage: node tests-js/web_caveats.mjs
import fs from 'node:fs';
import { caveats, memOperand } from '../web/js/caveats.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { WasmAssembler } from '../web/js/assembler.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);
const j = JSON.stringify;
const ids = (r) => caveats(r).map((c) => c.id).join();
const instr = (label) => ({ kind: 'instr', label, opcode: '90', notes: '', values: [] });
const loop = (...labels) => ({ mode: 'loop', rows: labels.map(instr) });

// --- hand-written ----------------------------------------------------------------------------------------------------
{
  check(j(memOperand('inc dword ptr [rsp+rdx*4]')) === j({ mnemonic: 'inc', first: true, size: 4, base: 'rsp', index: 'rdx', disp: 0, text: '[rsp+rdx*4]' }), 'memory operand: base, index');
  const m = memOperand('vfmadd231ps ymm0, ymm15, ymmword ptr [rdi+rax*4+0x4]');
  check(!m.first && m.size === 32 && m.disp === 4 && m.index === 'rax', 'memory operand: a load, its width and offset', j(m));
  check(memOperand('mov rax, qword ptr [rip+0x10]') === null && memOperand('add rax, rbx') === null && memOperand('nop') === null, 'memory operand: none (RIP-relative: a constant)');
  check(memOperand('mov dword ptr [rsi-0x8], eax').disp === -8, 'memory operand: a negative offset');

  // the histogram: inc dword ptr [rsp+rdx*4] (4 tables)
  const hist = loop('movzx edx, byte ptr [rdi]', 'inc dword ptr [rsp+rdx*4]', 'inc rdi', 'cmp rdi, rsi', 'jnz 0x0');
  const hc = caveats(hist);
  check(hc.length === 1 && hc[0].id === 'rmw-index' && j(hc[0].rows) === '[1]' && /inc dword ptr \[rsp\+rdx\*4\]/.test(hc[0].title), 'rmw-index: the histogram\'s inc', j(hc));
  check(ids(loop('mov eax, dword ptr [rsp+rdx*4]', 'add eax, 0x1', 'mov dword ptr [rsp+rdx*4], eax', 'jnz 0x0')) === 'rmw-index', 'rmw-index: a load and a store to the same indexed address');
  check(ids(loop('add edx, dword ptr [rdi+rax*4]', 'mov dword ptr [rsi+rax*4], edx', 'inc rax', 'jnz 0x0')) === '', 'not for a load and a store to different arrays (the prefix sum)');
  check(ids(loop('inc dword ptr [rdi]', 'jnz 0x0')) === '', 'not for a read-modify-write without an index');
  check(ids(loop('mov dword ptr [rsp+rdx*4], eax', 'jnz 0x0')) === '', 'not for a plain store');
  // exits
  check(ids(loop('add rdx, 0x20', 'cmp rdx, rsi', 'jnb 0x20', 'vpcmpeqb ymm0, ymm1, ymmword ptr [rdi+rdx*1]', 'vpmovmskb ecx, ymm0', 'test ecx, ecx', 'jz 0x0')) === 'exit', 'exit: a jnb before the loop\'s jz');
  check(ids(loop('add rax, 0x1', 'dec rcx', 'jnz 0x0')) === '' && ids({ mode: 'unroll', rows: [instr('jz 0x4'), instr('add rax, rbx')] }) === '', 'no exit: one branch; not a loop');
  // split loads
  const fir = caveats(loop('vmovups ymm1, ymmword ptr [rdi+rax*4]', 'vfmadd231ps ymm0, ymm15, ymmword ptr [rdi+rax*4+0x4]', 'vfmadd231ps ymm0, ymm14, ymmword ptr [rdi+rax*4+0x20]', 'vmovups ymmword ptr [rdx+rax*4+0x4], ymm0', 'jnz 0x0'));
  check(fir.length === 1 && fir[0].id === 'split' && j(fir[0].rows) === '[1]' && fir[0].text === 'split loads? (1)', 'split: a ymm load at +4; not at +0 or +32, not a store', j(fir));
  check(ids(loop('mov eax, dword ptr [rdi+0x2]', 'movzx ecx, byte ptr [rdi+0x3]', 'jnz 0x0')) === 'split' && caveats(loop('mov eax, dword ptr [rdi+0x2]', 'movzx ecx, byte ptr [rdi+0x3]', 'jnz 0x0'))[0].rows.length === 1, 'split: a dword at +2; a byte never');
  check(ids({ rows: [] }) === '' && ids(null) === '', 'nothing: no caveats');
  // review round 1: a forward branch inside the loop (an if) is not an exit; lea is not an access; xchg is a read-modify-write
  const op = (label, opcode) => ({ kind: 'instr', label, opcode, notes: '', values: [] });
  const ifLoop = { mode: 'loop', rows: [op('mov eax, dword ptr [rdi]', '8b07'), op('test eax, eax', '85c0'), op('jle 0x5', '7e03'), op('add rbx, rax', '4801c3'), op('add rdi, 0x4', '4883c704'), op('dec rcx', '48ffc9'), op('jnz 0xffffffffffffffeb', '75eb')] };
  check(ids(ifLoop) === '', 'an if inside the loop (jle to a later instruction of the loop): not an exit', j(caveats(ifLoop)));
  const out = { ...ifLoop, rows: ifLoop.rows.map((x, k) => (k === 2 ? op('jle 0x12', '7e10') : x)) };
  check(ids(out) === 'exit', 'a branch past the end of the loop: an exit');
  check(ids(loop('lea rdx, ptr [rdi+rax*4]', 'mov dword ptr [rdi+rax*4], ecx', 'inc rax', 'jnz 0x0')) === '', 'lea with an indexed address and a store to it: not a read-modify-write');
  check(memOperand('lea rdx, ptr [rdi+rax*4+0x3]') === null, 'lea: no memory access (not a split load either)');
  check(ids(loop('xchg dword ptr [rsi+rax*4], edx', 'inc rax', 'jnz 0x0')) === 'rmw-index' && ids(loop('xchg edx, dword ptr [rsi+rax*4]', 'jnz 0x0')) === 'rmw-index', 'xchg with an indexed address: a read-modify-write');
  check(ids(loop('lock cmpxchg dword ptr [rsi+rax*4], edx', 'jnz 0x0')) === 'rmw-index' && ids(loop('lock xadd dword ptr [rsi+rax*4], edx', 'jnz 0x0')) === 'rmw-index', 'cmpxchg and xadd (lock): read-modify-writes');
}

// --- the dogfood loops ---------------------------------------------------------------------------------------------
const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
const asmPath = new URL('assembler/dist/wuica_asm.wasm', root);
if (!fs.existsSync(wasm) || !fs.existsSync(asmPath) || !fs.existsSync(new URL('data/uarch.json', root))) {
  console.log('(analyzer, assembler or data/ missing: only the hand-written cases)');
} else {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
  await e.loadArch('ZEN3', fs.readFileSync(new URL('data/arch/ZEN3.json', root)));
  const a = await WasmAssembler.create(fs.readFileSync(asmPath));
  const of = async (name) => {
    const r = await a.assemble(fs.readFileSync(new URL(`tests-js/fixtures/caveats/${name}`, root), 'utf8'), 'intel');
    return caveats(await e.analyze(makeRequest([...r.bytes].map((b) => b.toString(16).padStart(2, '0')).join(''), 'ZEN3')));
  };
  const want = { 'fir8.s': 'split', 'fir8_s.s': 'split', 'fir8_s2.s': '', 'hist_b.s': 'rmw-index', 'scan_a.s': 'exit', 'psum.s': '' };
  for (const [name, id] of Object.entries(want)) {
    const c = await of(name);
    check(c.map((x) => x.id).join() === id, `${name}: ${id || 'no caveats'}`, j(c.map((x) => [x.id, x.text])));
  }
  const firN = (await of('fir8.s'))[0].rows.length, winN = (await of('fir8_s.s'))[0].rows.length;
  check(firN === 7 && winN === 3, 'FIR: 7 loads off their width in gcc\'s, 3 in the winner (measured 3.7 and 1.5 split loads per iteration)', `${firN} ${winN}`);
}

console.log(`${count} caveat checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
