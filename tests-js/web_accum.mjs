// Tests of the "N accumulators" what-if (web/js/accum.js, whatif.js; the MCP tool's copy in packages/wuica/lib/whatif.js):
// the chain's register, the renaming, the refusals (memory, flags, implicit operands); with the analyzer and the
// assembler, the CRC loop of the 0.1.4 dogfood run: 3 streams are the best on ZEN3 and 4 add nothing (measured: 3.0x,
// no gain from 4), and the dot product's vaddss chain; the page's numbers are the MCP tool's.
// Usage: node tests-js/web_accum.mjs
import fs from 'node:fs';
import { family, chainRegisters, accumulatorText, bestAccumulators, ACCUMULATORS } from '../web/js/accum.js';
import { experiments, outcome, bestOf } from '../web/js/whatif.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { WasmAssembler } from '../web/js/assembler.js';
import { withRegions } from '../web/js/asm-regions.js';
import { whatIf } from '../packages/wuica/lib/whatif.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);
const j = JSON.stringify;
const hexOf = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const instr = (label, opcode, notes = '') => ({ kind: 'instr', label, opcode, notes, values: [] });
const edge = (from, to, operand, carried = false) => ({ from, to, operand, latency: 3, carried });
// crc32 rax, [rdi+rdx]; crc32 rax, [rdi+rdx+8]; add rdx, 16; cmp rdx, rsi; jb (gcc's crc loop, unrolled ×2)
const CRC_HEX = 'f2480f38f10417' + 'f2480f38f1441708' + '4883c210' + '4839f2' + '72e8';
const CRC = {
  tp: 6, mode: 'loop', bottlenecks: ['Dependencies'], limits: [{ name: 'Dependencies', tp: 6 }],
  rows: [instr('crc32 rax, qword ptr [rdi+rdx*1]', 'F2480F38F10417'), instr('crc32 rax, qword ptr [rdi+rdx*1+0x8]', 'F2480F38F1441708'),
    instr('add rdx, 0x10', '4883C210'), instr('cmp rdx, rsi', '4839F2'), instr('jb 0xffffffffffffffe8', '72E8', 'M')],
  criticalPath: { ratio: 6, edges: [edge(0, 1, 'RAX'), edge(1, 0, 'RAX', true)] },
};

// --- without the analyzer ----------------------------------------------------------------------------------------------
{
  check(j(family('EAX')) === j({ kind: 'gpr', base: 'rax', size: 1 }) && family('ymm3').base === 'v3' && family('r9b').base === 'r9' && family('mem') === null, 'register families');
  check(j(chainRegisters(CRC)) === j({ ok: true, bases: ['rax'], names: ['rax'] }), 'the chain: rax');
  check(/memory/.test(chainRegisters({ criticalPath: { edges: [edge(0, 0, 'mem', true)] } }).reason), 'refused: a chain through memory');
  check(/flags/.test(chainRegisters({ criticalPath: { edges: [edge(0, 0, 'flags (C)', true)] } }).reason), 'refused: a chain through the flags');
  check(!chainRegisters({}).ok, 'no chain');
  const a3 = accumulatorText(CRC, CRC_HEX, 3);
  const lines = a3.text.trim().split('\n').map((l) => l.trim());
  check(a3.ok && lines.length === 3 * 3 + 2 && lines[0].startsWith('.byte 0xf2') && lines[3] === 'crc32 r8, qword ptr [rdi+rdx*1]' && lines[4] === 'crc32 r8, qword ptr [rdi+rdx*1+0x8]'
    && lines[6] === 'crc32 r9, qword ptr [rdi+rdx*1]' && lines[5] === '.byte 0x48, 0x83, 0xc2, 0x10' && j(a3.renamed) === j([{ from: 'rax', to: ['r8', 'r9'] }]),
  '3 accumulators: copy 1 as it is (bytes), copies 2 and 3 on r8 and r9, the fused cmp/jb once', a3.text);
  check(a3.text.split('\n').filter((l) => /0x48, 0x83, 0xc2/.test(l)).length === 3 && /\.byte 0x48, 0x39, 0xf2\n {2}\.byte 0x72, 0xe8\n$/.test(a3.text), 'the pointer add in every copy, the branch with its compare once');
  const div = { ...CRC, rows: [instr('div ecx', 'F7F1'), instr('add eax, edx', '01D0'), instr('dec r8', '49FFC8'), instr('jnz 0x0', '75F7', 'M')], criticalPath: { edges: [edge(1, 0, 'EAX', true), edge(0, 1, 'EAX')] } };
  check(/implicit/.test(accumulatorText(div, 'f7f101d049ffc875f7', 2).reason), 'refused: the chain register is an implicit operand of div');
  const ah = { ...CRC, rows: [instr('add ah, bl', '00DC'), instr('dec r8', '49FFC8'), instr('jnz 0x0', '75F9', 'M')], criticalPath: { edges: [edge(0, 0, 'AH', true)] } };
  check(!accumulatorText(ah, '00dc49ffc875f9', 2).ok, 'refused: ah has no form in r8..');
  const ptr = { ...CRC, criticalPath: { edges: [edge(2, 2, 'RDX', true)] } };
  check(/induction variable rdx/.test(accumulatorText(ptr, CRC_HEX, 2).reason), 'refused: a chain through the pointer (used in an address) is not an accumulator');
  const notLoop = accumulatorText({ ...CRC, mode: 'unroll' }, CRC_HEX, 2);
  check(!notLoop.ok && /not a loop/.test(notLoop.reason), 'only loops');
  // 15 general registers: 8 accumulators of rax are fine; a loop that uses most of them runs out
  check(accumulatorText(CRC, CRC_HEX, 8).ok, '8 accumulators of rax');
  check(j(bestAccumulators(new Map([[1, 6], [2, 3], [3, 2], [4, 2], [8, 2.01]]))) === j({ n: 3, tp: 2 }) && j(bestAccumulators(new Map([[1, 2], [2, 2.01]]))) === j({ n: 1, tp: 2 }), 'best N: the smallest within 1%');
  const exps = experiments(CRC, CRC_HEX, {});
  check(exps.filter((x) => /^acc/.test(x.id)).map((x) => x.id).join() === ACCUMULATORS.map((n) => `acc${n}`).join() && exps.find((x) => x.id === 'acc2').per === 2 && !exps.find((x) => x.id === 'acc2').hex, 'experiments: the accumulator rows, as text until assembled', exps.map((x) => x.id).join());
  const e2 = experiments({ ...CRC, criticalPath: { edges: [edge(0, 0, 'mem', true)] } }, CRC_HEX, {});
  const accRow = e2.find((x) => x.id === 'acc');
  check(accRow && /memory/.test(outcome({ tp: 6, mode: 'loop' }, accRow, null).error), 'experiments: one row with the reason when it cannot be done');
  check(j(bestOf(6, exps, new Map([['acc2', { tp: 6, mode: 'loop' }], ['acc3', { tp: 6, mode: 'loop' }]]))) === j({ n: 3, tp: 2 }), 'bestOf: per original iteration');
}

// --- with the analyzer and the assembler ----------------------------------------------------------------------------------
const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
const asmPath = new URL('assembler/dist/wuica_asm.wasm', root);
if (!fs.existsSync(wasm) || !fs.existsSync(asmPath) || !fs.existsSync(new URL('data/uarch.json', root))) {
  console.log('(analyzer, assembler or data/ missing: only the hand-written cases)');
} else {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
  for (const t of ['SKL', 'ZEN3']) await e.loadArch(t, fs.readFileSync(new URL(`data/arch/${t}.json`, root)));
  const A = withRegions(await WasmAssembler.create(fs.readFileSync(asmPath)));
  const assembleHex = async (t) => { const r = await A.assemble(t, 'intel'); return r.ok ? hexOf(r.bytes) : null; };
  // as the page and the MCP tool run them: per original iteration
  const run = async (hex, arch) => {
    const base = await e.analyze(makeRequest(hex, arch));
    const tps = new Map([[1, base.tp]]);
    for (const x of experiments(base, hex, {}).filter((y) => /^acc\d+$/.test(y.id))) {
      const h = await assembleHex(x.text);
      const r = await e.analyze(makeRequest(h, arch));
      check(r.mode === 'loop', `${x.label} on ${arch}: a loop`);
      tps.set(x.per, r.tp / x.per);
    }
    return { base, tps, best: bestAccumulators(tps) };
  };
  const z = await run(CRC_HEX, 'ZEN3');
  check(z.base.tp === 6 && z.tps.get(2) === 3 && z.tps.get(3) === 2 && z.tps.get(4) === 2 && z.best.n === 3, 'CRC on ZEN3: 6 → 3 → 2 cycles per iteration; 3 streams are the best, 4 add nothing (as measured)', j([...z.tps]));
  // the dot product's eight vaddss into xmm0 (gcc -O3 without -ffast-math): the accumulators cut the chain
  const DOT = `.L22:\n  vmovups ymm1, [rsi+rax]\n  vmulps ymm1, ymm1, [rdi+rax]\n  add rax, 32\n  vshufps xmm3, xmm1, xmm1, 85\n  vaddss xmm0, xmm0, xmm1\n  vaddss xmm0, xmm0, xmm3\n  vunpckhps xmm3, xmm1, xmm1\n  vaddss xmm0, xmm0, xmm3\n  cmp rcx, rax\n  jne .L22\n`;
  const dotHex = await assembleHex(DOT);
  const d = await run(dotHex, 'ZEN3');
  check(d.tps.get(2) < d.base.tp && d.tps.get(4) < d.tps.get(2) && d.best.n > 1, 'dot product on ZEN3: more accumulators, fewer cycles per iteration', j([...d.tps]));
  // the MCP tool's what_if gives the same numbers, with the best N
  const analyze = async (arch, req) => { const r = await e.analyze(makeRequest(req.hex, arch, req.options ?? {})); return { code: 0, arch, ...r }; };
  const w = await whatIf(analyze, 'ZEN3', { hex: CRC_HEX }, ['acc2', 'acc3', 'acc4', 'acc8', 'unroll2'], { assemble: async (t) => { const h = await assembleHex(t); return h ? { code: 0, hex: h } : { code: 2, error: 'x' } } });
  const v = Object.fromEntries(w.variants.map((x) => [x.id, x]));
  check(v.acc2.tp === 3 && v.acc3.tp === 2 && v.acc4.tp === 2 && v.acc3.speedup === 3 && v.unroll2.tp === 6 && w.accumulators.best === 3 && j(v.acc3.renamed) === j([{ from: 'rax', to: ['r8', 'r9'] }]),
    'what_if: acc2..acc8 per original iteration, the best N, the renamed registers; unroll ×2 alone gives nothing', j(w));
  const noAsm = await whatIf(analyze, 'ZEN3', { hex: CRC_HEX }, ['acc2']);
  check(/no assembler/.test(noAsm.variants[0].error), 'what_if without an assembler: the accumulator variants say so');
}

console.log(`${count} accumulator checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
