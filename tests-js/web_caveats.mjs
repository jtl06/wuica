// Tests of the warnings for the model's known blind spots (web/js/caveats.js; the API's insights.caveats): a read-modify-
// write to an indexed address, an exit before the loop's branch, loads that may split a cache line. With the analyzer,
// the loops of the dogfood runs (tests-js/fixtures/caveats): on SKL (no split-load cost in the model) gcc's FIR (3.7
// split loads per iteration measured) and the winning variant (1.5) warn, the all-shuffle variant (0) does not; on ZEN3
// (splitLoadCycles 2: the model charges them) none of them does; the histogram warns; the scan loop has an exit.
// Usage: node tests-js/web_caveats.mjs
import fs from 'node:fs';
import { caveats, memOperand } from '../web/js/caveats.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { WasmAssembler } from '../web/js/assembler.js';
import { EXAMPLES, CLASSIC_EXAMPLES, SHOWCASE_EXAMPLES } from '../web/js/examples.js';

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
  check(ids(loop('movzx edx, byte ptr [rdi]', 'mov eax, dword ptr [rsp+rdx*4]', 'add eax, 0x1', 'mov dword ptr [rsp+rdx*4], eax', 'jnz 0x0')) === 'rmw-index', 'rmw-index: a load and a store to the same indexed address, its index loaded');
  // only where a register of the address is written other than by advancing it by a constant
  check(ids(loop('mov eax, dword ptr [rsp+rdx*4]', 'add eax, 0x1', 'mov dword ptr [rsp+rdx*4], eax', 'add rdx, 0x1', 'jnz 0x0')) === '', 'no rmw-index: the index advances by a constant');
  check(ids(loop('add dword ptr [rdi+rcx*4], eax', 'dec r8', 'jnz 0x0')) === '', 'no rmw-index: a loop-invariant address (the model has its chain through memory)');
  check(ids(loop('lea rsi, ptr [rsi+0x4]', 'add dword ptr [rsi+rax*4], 0x1', 'jnz 0x0')) === '' && ids(loop('lea rsi, ptr [rsi+rcx*1]', 'add dword ptr [rsi+rax*4], 0x1', 'jnz 0x0')) === 'rmw-index', 'lea r, [r+imm] advances by a constant; lea r, [r+rcx] does not');
  check(ids(loop('mov rax, qword ptr [rdi]', 'add dword ptr [rsi+rax*4], 0x1', 'jnz 0x0')) === 'rmw-index' && ids(loop('imul rax, rax', 'inc dword ptr [rsi+rax*4]', 'jnz 0x0')) === 'rmw-index', 'rmw-index: the index loaded or computed');
  check(ids(loop('add edx, dword ptr [rdi+rax*4]', 'mov dword ptr [rsi+rax*4], edx', 'inc rax', 'jnz 0x0')) === '', 'not for a load and a store to different arrays (the prefix sum)');
  check(ids(loop('inc dword ptr [rdi]', 'jnz 0x0')) === '', 'not for a read-modify-write without an index');
  check(ids(loop('mov dword ptr [rsp+rdx*4], eax', 'jnz 0x0')) === '', 'not for a plain store');
  // exits
  check(ids(loop('add rdx, 0x20', 'cmp rdx, rsi', 'jnb 0x20', 'vpcmpeqb ymm0, ymm1, ymmword ptr [rdi+rdx*1]', 'vpmovmskb ecx, ymm0', 'test ecx, ecx', 'jz 0x0')) === 'exit', 'exit: a jnb before the loop\'s jz');
  check(ids(loop('add rax, 0x1', 'dec rcx', 'jnz 0x0')) === '' && ids({ mode: 'unroll', rows: [instr('jz 0x4'), instr('add rax, rbx')] }) === '', 'no exit: one branch; not a loop');
  // a branch within the block (an if/else; a second back edge, clang's sum_mod remainder loop): both paths
  const ifelse = ['mov rax, qword ptr [rdi+rcx*8]', 'test rax, rax', 'jz 0x2', 'add rdx, rax', 'add rcx, 0x1', 'cmp rcx, rsi', 'jnz 0x0'];
  const pc = caveats(loop(...ifelse));
  check(pc.length === 1 && pc[0].id === 'paths' && pc[0].text === 'both paths' && j(pc[0].rows) === '[2]' && /^both sides of the branch at instruction 3 \(jz\) are simulated, one after the other; a real iteration takes one/.test(pc[0].title) && /# wuica-begin and # wuica-end/.test(pc[0].title), 'paths: a forward branch inside the loop (not an exit), by instruction', j(pc));
  const pl = caveats({ ...loop(...ifelse), loop: { lines: [10, 11, 12, 13, 14, 15, 16] } });
  check(/^both sides of the branch at line 12 \(jz\)/.test(pl[0]?.title), 'paths: by source line when the response has the lines of the span (the package\'s loop.lines)', j(pl));
  check(ids(loop('xor edx, edx', 'div rcx', 'add r8, rdx', 'jnz 0xfffffffffffffffd', 'add rdi, 0x1', 'jnz 0x0')) === 'paths', 'paths: a second back edge to the top of the span');
  check(ids(loop('add rdx, 0x20', 'cmp rdx, rsi', 'jnb 0x20', 'jz 0x1', 'nop', 'test ecx, ecx', 'jz 0x0')) === 'paths,exit', 'paths and exit together: an exit and a branch inside');
  // split loads
  const fir = caveats(loop('vmovups ymm1, ymmword ptr [rdi+rax*4]', 'vfmadd231ps ymm0, ymm15, ymmword ptr [rdi+rax*4+0x4]', 'vfmadd231ps ymm0, ymm14, ymmword ptr [rdi+rax*4+0x20]', 'vmovups ymmword ptr [rdx+rax*4+0x4], ymm0', 'jnz 0x0'));
  check(fir.length === 1 && fir[0].id === 'split' && j(fir[0].rows) === '[1]' && fir[0].text === 'split loads? (1)', 'split: a ymm load at +4; not at +0 or +32, not a store', j(fir));
  check(ids(loop('mov eax, dword ptr [rdi+0x2]', 'movzx ecx, byte ptr [rdi+0x3]', 'jnz 0x0')) === 'split' && caveats(loop('mov eax, dword ptr [rdi+0x2]', 'movzx ecx, byte ptr [rdi+0x3]', 'jnz 0x0'))[0].rows.length === 1, 'split: a dword at +2; a byte never');
  check(ids({ rows: [] }) === '' && ids(null) === '', 'nothing: no caveats');
  // per CPU: with a split-load cost (splitLoadCycles > 0) the model charges crossings where the address advances by an
  // immediate; only a load with an address register written otherwise warns
  const SPLIT = { splitLoadCycles: 2 }, STOCK = { splitLoadCycles: 0 };
  const firRows = ['vfmadd231ps ymm0, ymm15, ymmword ptr [rdi+rax*4+0x4]', 'add rax, 0x8', 'cmp rax, rcx', 'jnz 0x0'];
  check(ids(loop(...firRows)) === 'split' && caveats(loop(...firRows), STOCK).length === 1 && caveats(loop(...firRows), SPLIT).length === 0, 'split cost: a load advanced by add rax, imm is modelled; stock (or no configuration): it warns');
  check(caveats(loop('vmovups ymm0, ymmword ptr [rdi+0x4]', 'jnz 0x0'), SPLIT).length === 0, 'split cost: a load at a constant address (register not written) is modelled');
  check(caveats(loop('mov eax, dword ptr [rsi+rdx*4+0x2]', 'inc rdx', 'sub esi, 0x40', 'jnz 0x0'), SPLIT).length === 0, 'split cost: inc and sub of an immediate (64 and 32 bits) keep a register followed');
  const chase = loop('vmovups ymm0, ymmword ptr [rdi+0x4]', 'mov rdi, qword ptr [rdi+0x40]', 'test rdi, rdi', 'jnz 0x0');
  const cc = caveats(chase, SPLIT);
  check(cc.length === 1 && cc[0].id === 'split' && j(cc[0].rows) === '[0]' && cc[0].text === 'split loads? (1)' && /rdi is written otherwise here \(mov rdi, qword ptr \[rdi\+0x40\]\)/.test(cc[0].title) && !/at an offset that is not a multiple of the width \(vmovups[^)]*\): some cross/.test(cc[0].title), 'split cost: a pointer chase (mov rdi, [rdi+...]) is not followed: it warns, worded for that', j(cc));
  check(caveats(chase, STOCK)[0].title !== cc[0].title && /some cross a 64-byte line, which costs extra; not modelled$/.test(caveats(chase, STOCK)[0].title), 'the same response: stock wording without a split-load cost (kept per cost)');
  check(caveats(loop('mov eax, dword ptr [rsi+0x2]', 'lea rsi, ptr [rsi+0x40]', 'jnz 0x0'), SPLIT).length === 1, 'split cost: lea is not an add of an immediate');
  check(caveats(loop('mov eax, dword ptr [rsi+rdx*4+0x2]', 'add dx, 0x1', 'jnz 0x0'), SPLIT).length === 1, 'split cost: a 16-bit add is not followed');
  check(caveats(loop('mov eax, dword ptr [rsi+rcx*4+0x2]', 'add rcx, rbx', 'jnz 0x0'), SPLIT).length === 1 && caveats(loop('mov eax, dword ptr [rsi+0x2]', 'rep movsb byte ptr [rdi], byte ptr [rsi]', 'jnz 0x0'), SPLIT).length === 1, 'split cost: add of a register; an implicit write (rep movsb: rsi)');
  check(caveats(loop('mov eax, dword ptr [rsi+0x2]', 'cmp rsi, rdi', 'test rsi, rsi', 'push rsi', 'jnz 0x0'), SPLIT).length === 0, 'split cost: cmp, test and push only read the register');
  check(caveats(loop('mov eax, dword ptr [rsi+0x2]', 'xchg rdi, rsi', 'jnz 0x0'), SPLIT).length === 1, 'split cost: xchg writes both registers');
  // review round 1: a forward branch inside the loop (an if) is not an exit; lea is not an access; xchg is a read-modify-write
  const op = (label, opcode) => ({ kind: 'instr', label, opcode, notes: '', values: [] });
  const ifLoop = { mode: 'loop', rows: [op('mov eax, dword ptr [rdi]', '8b07'), op('test eax, eax', '85c0'), op('jle 0x5', '7e03'), op('add rbx, rax', '4801c3'), op('add rdi, 0x4', '4883c704'), op('dec rcx', '48ffc9'), op('jnz 0xffffffffffffffeb', '75eb')] };
  check(ids(ifLoop) === 'paths', 'an if inside the loop (jle to a later instruction of the loop): not an exit, both paths', j(caveats(ifLoop)));
  const out = { ...ifLoop, rows: ifLoop.rows.map((x, k) => (k === 2 ? op('jle 0x12', '7e10') : x)) };
  check(ids(out) === 'exit', 'a branch past the end of the loop: an exit');
  check(ids(loop('lea rdx, ptr [rdi+rax*4]', 'mov dword ptr [rdi+rax*4], ecx', 'inc rax', 'jnz 0x0')) === '', 'lea with an indexed address and a store to it: not a read-modify-write');
  check(memOperand('lea rdx, ptr [rdi+rax*4+0x3]') === null, 'lea: no memory access (not a split load either)');
  const ld = 'movzx eax, byte ptr [rdi]'; // the index from the data
  check(ids(loop(ld, 'xchg dword ptr [rsi+rax*4], edx', 'jnz 0x0')) === 'rmw-index' && ids(loop(ld, 'xchg edx, dword ptr [rsi+rax*4]', 'jnz 0x0')) === 'rmw-index', 'xchg with an indexed address: a read-modify-write');
  check(ids(loop(ld, 'lock cmpxchg dword ptr [rsi+rax*4], edx', 'jnz 0x0')) === 'rmw-index' && ids(loop(ld, 'lock xadd dword ptr [rsi+rax*4], edx', 'jnz 0x0')) === 'rmw-index', 'cmpxchg and xadd (lock): read-modify-writes');
}

// --- the dogfood loops ---------------------------------------------------------------------------------------------
const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
const asmPath = new URL('assembler/dist/wuica_asm.wasm', root);
if (!fs.existsSync(wasm) || !fs.existsSync(asmPath) || !fs.existsSync(new URL('data/uarch.json', root))) {
  console.log('(analyzer, assembler or data/ missing: only the hand-written cases)');
} else {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  const uarchBytes = fs.readFileSync(new URL('data/uarch.json', root));
  await e.loadUarch(uarchBytes);
  const uarch = JSON.parse(uarchBytes.toString('utf8'));
  for (const arch of ['ZEN3', 'SKL']) await e.loadArch(uarch.configs[arch].name, fs.readFileSync(new URL(`data/arch/${uarch.configs[arch].name}.json`, root)));
  check(uarch.configs.ZEN3.splitLoadCycles > 0 && !(uarch.configs.SKL.splitLoadCycles > 0), 'data: ZEN3 has a split-load cost, SKL none', `${uarch.configs.ZEN3.splitLoadCycles} ${uarch.configs.SKL.splitLoadCycles}`);
  const a = await WasmAssembler.create(fs.readFileSync(asmPath));
  const of = async (name, arch) => {
    const r = await a.assemble(fs.readFileSync(new URL(`tests-js/fixtures/caveats/${name}`, root), 'utf8'), 'intel');
    const resp = await e.analyze(makeRequest([...r.bytes].map((b) => b.toString(16).padStart(2, '0')).join(''), arch));
    return caveats(resp, uarch.configs[resp.arch]);
  };
  // saxpy (the built-in example), a copy, a loop-invariant address, an index advanced by lea: no store-forwarding caveat
  const NO_RMW = { 'saxpy.s': '', 'memcpy.s': '', 'invariant.s': '', 'lea_induction.s': '' };
  // the loop-invariant address: the model has the chain through memory (it charges the store forwarding)
  for (const arch of ['SKL', 'ZEN3']) {
    const r = await a.assemble(fs.readFileSync(new URL('tests-js/fixtures/caveats/invariant.s', root), 'utf8'), 'intel');
    const resp = await e.analyze(makeRequest([...r.bytes].map((b) => b.toString(16).padStart(2, '0')).join(''), arch));
    check(resp.criticalPath?.edges?.some((x) => x.operand === 'mem' && x.carried), `${arch}: a loop-invariant read-modify-write is a chain through memory in the model`, j(resp.criticalPath));
  }
  const want = {
    SKL: { 'fir8.s': 'split', 'fir8_s.s': 'split', 'fir8_s2.s': '', 'hist_b.s': 'rmw-index', 'hist_c.s': 'rmw-index', 'scan_a.s': 'exit', 'psum.s': '', ...NO_RMW },
    // the FIR loads advance by add rax, imm: the model charges their crossings
    ZEN3: { 'fir8.s': '', 'fir8_s.s': '', 'fir8_s2.s': '', 'hist_b.s': 'rmw-index', 'hist_c.s': 'rmw-index', 'scan_a.s': 'exit', 'psum.s': '', ...NO_RMW },
  };
  for (const [arch, cases] of Object.entries(want)) {
    for (const [name, id] of Object.entries(cases)) {
      const c = await of(name, arch);
      check(c.map((x) => x.id).join() === id, `${arch} ${name}: ${id || 'no caveats'}`, j(c.map((x) => [x.id, x.text])));
    }
  }
  // the built-in examples: none shows a caveat (none has a data-dependent indexed read-modify-write, an exit before
  // its branch, or a load off its width); saxpy's load and store to [rsi+rax*4] (rax += 8) is not one
  const shown = [];
  for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES, ...SHOWCASE_EXAMPLES]) {
    for (const arch of ['SKL', 'ZEN3']) {
      const resp = await e.analyze(makeRequest(ex.hex, arch));
      const c = caveats(resp, uarch.configs[resp.arch]);
      if (c.length) shown.push(`${ex.id} ${arch}: ${c.map((x) => x.id).join()}`);
    }
  }
  check(shown.length === 0 && [...EXAMPLES, ...CLASSIC_EXAMPLES].some((x) => x.id === 'saxpy'), 'the built-in examples: no caveats (saxpy included)', shown.join('; '));
  const firN = (await of('fir8.s', 'SKL'))[0].rows.length, winN = (await of('fir8_s.s', 'SKL'))[0].rows.length;
  check(firN === 7 && winN === 3, 'SKL FIR: 7 loads off their width in gcc\'s, 3 in the winner (measured 3.7 and 1.5 split loads per iteration)', `${firN} ${winN}`);
}

console.log(`${count} caveat checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
