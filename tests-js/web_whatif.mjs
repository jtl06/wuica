// Tests of the what-if experiments' data side (web/js/whatif.js): unrolling, the list of experiments, the outcome
// (per original iteration, Δ, speedup); with the real analyzer (if built), the unrolled examples against blocks this test
// builds itself from the examples' objdump listings.
// Usage: node tests-js/web_whatif.mjs
import fs from 'node:fs';
import { instrRanges, unrollHex, experiments, outcome, formatDelta, formatSpeedup, weight, variantFragment } from '../web/js/whatif.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES, CLASSIC_EXAMPLES, SHOWCASE_EXAMPLES } from '../web/js/examples.js';
import { encodeState, decodeState } from '../web/js/url-state.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);

const instr = (label, opcode, notes = '') => ({ kind: 'instr', label, opcode, notes, values: [] });
const CHAIN_HEX = '4883c0014883c00149ffcf75f3';
const CHAIN = {
  tp: 2, mode: 'loop', bottlenecks: ['Dependencies'],
  limits: [{ name: 'DSB', tp: 1 }, { name: 'Issue', tp: 0.75 }, { name: 'Ports', tp: 1 }, { name: 'Dependencies', tp: 2 }],
  rows: [instr('add rax, 0x1', '4883C001'), instr('add rax, 0x1', '4883C001'), instr('dec r15', '49FFCF'), instr('jnz 0x0', '75F3', 'M')],
};
const OPTS = { alignmentOffset: 0, initPolicy: 'diff', simpleFrontEnd: false, noMicroFusion: false, noMacroFusion: false, minIterations: 10, minCycles: 500 };

// --- hand-written -----------------------------------------------------------------------------------------------------
{
  const ins = instrRanges(CHAIN, CHAIN_HEX);
  check(ins.map((i) => `${i.start}-${i.end}`).join() === '0-4,4-8,8-11,11-13' && ins[3].fused, 'ranges of the instructions');
  check(instrRanges(CHAIN, CHAIN_HEX + '06') === null, 'ranges: bytes that are not instructions');
  const u2 = unrollHex(CHAIN, CHAIN_HEX, 2);
  check(u2.ok && u2.hex === '4883c0014883c001' + '4883c0014883c001' + '49ffcf75f3' && u2.tail === 2, 'unroll ×2: the body twice, the macro-fused dec/jnz once', JSON.stringify(u2));
  // a branch that is not fused: only the branch stays at the end
  const plain = { ...CHAIN, rows: CHAIN.rows.map((x, i) => (i === 3 ? { ...x, notes: '' } : x)) };
  const p2 = unrollHex(plain, CHAIN_HEX, 2);
  check(p2.ok && p2.hex === '4883c0014883c00149ffcf'.repeat(2) + '75f3' && p2.tail === 1, 'unroll: an unfused branch alone at the end', JSON.stringify(p2));
  check(!unrollHex({ ...CHAIN, mode: 'unroll' }, CHAIN_HEX, 2).ok, 'unroll: only loops');
  check(!unrollHex({ ...CHAIN, rows: [instr('dec r15', '49FFCF'), instr('jnz 0x0', '75F3', 'M')] }, '49ffcf75f3', 2).ok, 'unroll: nothing but the branch');

  const exps = experiments(CHAIN, CHAIN_HEX, OPTS);
  check(exps.map((x) => x.id).join() === 'unroll2,unroll4,unroll8,simpleFrontEnd,noMacroFusion,noMicroFusion,nochain', 'experiments: unroll, the model switches, no chain', exps.map((x) => x.id).join());
  check(exps[3].label === 'simple front end' && exps[3].options.simpleFrontEnd === true && exps[3].per === 1 && exps[3].hex === CHAIN_HEX, 'experiment: ideal front end');
  const on = experiments(CHAIN, CHAIN_HEX, { ...OPTS, simpleFrontEnd: true, noMacroFusion: true });
  check(on[3].label === 'detailed front end' && on[3].options.simpleFrontEnd === false && on[4].label === 'macro-fusion' && on[4].options.noMacroFusion === false, 'experiments: a switch that is on is switched off');
  const nc = exps.at(-1);
  check(nc.estimate === 1 && /DSB, Ports/.test(nc.title), 'no chain: the largest other limit (all of them named)', JSON.stringify(nc));
  check(!experiments({ ...CHAIN, limits: CHAIN.limits.slice(0, 3) }, CHAIN_HEX, OPTS).some((x) => x.id === 'nochain'), 'no chain: only if the chain is a limit');
  check(experiments({ ...CHAIN, mode: 'unroll' }, CHAIN_HEX, OPTS).every((x) => !x.id.startsWith('unroll')), 'no unrolling of a block that is not a loop');

  const base = { tp: 2, mode: 'loop' };
  const o = outcome(base, exps[1], { tp: 4, mode: 'loop' });
  check(o.tp === 1 && o.delta === -1 && o.speedup === 2, 'outcome: per original iteration', JSON.stringify(o));
  check(outcome(base, exps[1], undefined) === null && outcome(base, exps[1], { error: 'x' }).error === 'x', 'outcome: pending and error');
  check(/not comparable/.test(outcome(base, exps[3], { tp: 1, mode: 'unroll' }).error), 'outcome: another mode is not comparable');
  check(outcome(base, nc, undefined).tp === 1 && outcome(base, nc).estimate, 'outcome: the estimate needs no result');
  check(formatDelta(-1) === '−1.00' && formatDelta(0.001) === '0.00' && formatDelta(0.5) === '+0.50' && formatSpeedup(2) === '×2.00', 'formatting');
  check(weight(exps[1], 13) === (u2.hex.length / 2 + 2 * 8) / 13 && weight(nc, 13) === 0, 'weight: relative size of the analysis');
  // the link of a variant: a hex fragment the page reads back
  const s = decodeState(variantFragment({ ...exps[0], options: exps[3].options }, 'ZEN3'));
  check(s.mode === 'hex' && s.arch === 'ZEN3' && s.simpleFrontEnd === true && s.text === exps[0].hex, 'link: the variant as a hex fragment', JSON.stringify(s));
  const f = encodeState({ text: 'x', whatif: true });
  check(/(^|&)whatif=1(&|$)/.test(f) && decodeState(f).whatif === true && decodeState(encodeState({ text: 'x' })).whatif === false, 'url: whatif=1');
}

// --- the examples, against blocks built from their listings ------------------------------------------------------------------
const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (!fs.existsSync(wasm) || !fs.existsSync(new URL('data/uarch.json', root))) {
  console.log('(analyzer or data/ missing: only the hand-written cases)');
} else {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
  for (const t of ['SKL', 'ZEN3']) await e.loadArch(t, fs.readFileSync(new URL(`data/arch/${t}.json`, root)));
  // the largest variant: SHA-256 (11,602 bytes) unrolled ×8; its link must carry the whole code
  {
    const sha = SHOWCASE_EXAMPLES[0];
    const r = await e.analyze(makeRequest(sha.hex, 'SKL'));
    const x8 = experiments(r, sha.hex, OPTS).find((x) => x.id === 'unroll8');
    const back = decodeState(variantFragment(x8, 'SKL'));
    check(x8.hex.length > 180000 && back.text === x8.hex && back.mode === 'hex', 'link: SHA-256 unrolled ×8 decodes back to the variant', String(x8.hex.length));
  }
  for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES]) {
    for (const arch of ['SKL', 'ZEN3']) {
      const r = await e.analyze(makeRequest(ex.hex, arch));
      // the listing: one instruction per line; the last is the loop's branch
      const lines = ex.text.hex.trimEnd().split('\n').map((l) => l.split(/:\s+/)[1].split(/\s{2,}/)[0].replace(/ /g, ''));
      const fused = r.rows.at(-1).notes === 'M';
      const k = lines.length - (fused ? 2 : 1);
      const body = lines.slice(0, k).join(''), tail = lines.slice(k).join('');
      for (const x of experiments(r, ex.hex, OPTS)) {
        if (!x.id.startsWith('unroll')) continue;
        check(x.hex === body.repeat(x.per) + tail, `${ex.id} on ${arch}: ${x.label} is the body ${x.per} times and the branch`, x.hex);
        const u = await e.analyze(makeRequest(x.hex, arch));
        const n = u.rows.filter((y) => y.kind === 'instr').length;
        check(u.mode === 'loop' && n === k * x.per + (lines.length - k) && Number.isFinite(u.tp), `${ex.id} on ${arch}: ${x.label} is analyzed as a loop of ${k * x.per + lines.length - k} instructions`, `${u.mode} ${n} ${u.tp}`);
      }
    }
  }
}

console.log(`${count} what-if checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
