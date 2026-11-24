// Tests of the what-if experiments' data side (web/js/whatif.js): unrolling, the list of experiments, the outcome
// (per original iteration, Δ, speedup); with the real analyzer (if built), the unrolled examples against blocks this test
// builds itself from the examples' objdump listings.
// Usage: node tests-js/web_whatif.mjs
import fs from 'node:fs';
import { instrRanges, unrollHex, experiments, outcome, formatDelta, formatSpeedup, weight, variantFragment } from '../web/js/whatif.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES, CLASSIC_EXAMPLES, SHOWCASE_EXAMPLES } from '../web/js/examples.js';
import { encodeState, decodeState } from '../web/js/url-state.js';
import { toolOutcome, bestOf, whatIfText, shownOutcome } from '../web/js/whatif-core.js';
import { whatIf as whatIfMarkdown } from '../web/js/markdown.js';
import { tableBytes } from './tables.mjs'; // the binary tables (the module reads no JSON tables)

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
  // under the variant's own Ports or Issue limit (a short steady state: 8 accumulators of the SKL dot product, 63.75 cycles
  // per 8 original iterations with Ports 64, 64.00 with minCycles 20000): the data keeps the simulated number and says
  // so (approx: {limit, shown}); the page, the Markdown and the text show the limit, marked
  {
    const acc8 = { id: 'acc8', label: '8 accumulators', per: 8, hex: '90', options: OPTS };
    const lim = (ports, deps = 4) => [{ name: 'Issue', tp: ports * 0.75 }, { name: 'Ports', tp: ports }, { name: 'Dependencies', tp: deps * 8 }];
    const b = { tp: 32, mode: 'loop' };
    const under = outcome(b, acc8, { tp: 63.75, mode: 'loop', limits: lim(64) });
    check(under.tp === 63.75 / 8 && under.approx?.limit === 'Ports' && under.approx.shown === 8 && JSON.stringify(shownOutcome(under, 32)) === JSON.stringify({ tp: 8, delta: -24, speedup: 4 }), 'outcome: under its own Ports limit: simulated in the data, shown at the limit', JSON.stringify(under));
    check(!outcome(b, acc8, { tp: 64, mode: 'loop', limits: lim(64) }).approx && outcome(b, acc8, { tp: 66, mode: 'loop', limits: lim(64) }).tp === 8.25, 'outcome: at or over the limit: as simulated');
    check(outcome(b, acc8, { tp: 63.75, mode: 'loop', limits: lim(60, 9) }).tp === 63.75 / 8, 'outcome: the chain\'s limit is not a floor (a simulation can be under it)');
    // further under than sampling (uiCA's model is under its own Ports limit by up to 10% on some loops): as simulated
    const far = outcome(b, acc8, { tp: 62, mode: 'loop', limits: lim(64) });
    check(far.tp === 62 / 8 && !far.approx, 'outcome: more than 1% under the limit: as simulated (the model, not sampling)', JSON.stringify(far));
    const t = toolOutcome({ ...b, code: 0 }, acc8, { code: 0, tp: 63.75, mode: 'loop', bottlenecks: ['Ports'], limits: lim(64) });
    check(t.tp === 7.97 && t.delta === -24.03 && t.speedup === 4.02 && t.approx?.limit === 'Ports' && t.approx.shown === 8, 'toolOutcome (the package JSON): the simulated number, with approx', JSON.stringify(t));
    const best = bestOf(32, [{ id: 'acc4', per: 4 }, acc8], new Map([['acc4', { tp: 32, limits: lim(32) }], ['acc8', { tp: 63.75, limits: lim(64) }]]));
    check(best?.n === 4, 'best number of accumulators: from the numbers shown (8 is not faster than 4)', JSON.stringify(best));
    const x = { code: 0, arch: 'SKL', tp: 32, variants: [{ id: 'acc8', label: '8 accumulators', ...t }] };
    check(/\| 8 accumulators \| +≈8\.00 \| +-24\.00 \| +4\.00x \| at its Ports limit \(simulated 7\.97\) \|/.test(whatIfMarkdown(x)), 'Markdown: ≈ and the simulated number', whatIfMarkdown(x));
    check(/8 accumulators +~8\.00 +-24\.00 +4\.00x  at its Ports limit \(simulated 7\.97\)/.test(whatIfText(x)), 'text: ~ and the simulated number', whatIfText(x));
  }
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
  for (const t of ['SKL', 'ZEN3']) await e.loadArch(t, tableBytes(t));
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
        if (x.estimate !== undefined) {
          const p = outcome(r, x, null), q = toolOutcome({ ...r, code: 0 }, x, null);
          check(Math.round(p.tp * 100) / 100 === q.tp && q.estimate, `${ex.id} on ${arch}: no chain: the package's row rounds the page's estimate`);
        }
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
