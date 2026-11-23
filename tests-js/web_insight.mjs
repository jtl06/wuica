// Tests of the insight views' data handling (web/js/insight.js): the critical chain, the units of the cost column, the
// hex edits (removal, NOPs of the same length) and the Δ computation; with the real analyzer, if it has been built,
// also the response's criticalPath and the cost column of the built-in examples against independent analyses.
// Usage: node tests-js/web_insight.mjs
import fs from 'node:fs';
import {
  chainInfo, chainTitle, operandName, costUnits, editHex, nopHex, costJobs, costCells, delta, formatDelta, costKey,
} from '../web/js/insight.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { summarize } from '../web/js/compare.js';
import { EXAMPLES } from '../web/js/examples.js';
import { DEFAULT_STATE, encodeState, decodeState } from '../web/js/url-state.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);

const instr = (label, opcode, notes = '') => ({ kind: 'instr', label, opcode: opcode.toUpperCase(), notes, values: [] });
const extra = (kind) => ({ kind, label: kind === 'regMerge' ? '<Register Merge Uop>' : '<Stack Sync Uop>', notes: '', values: [] });

// the "chain" example: add rax, 1; add rax, 1; dec r15; jnz (macro-fused with dec)
const CHAIN_HEX = '4883c0014883c00149ffcf75f3';
const CHAIN = {
  tp: 2, mode: 'loop', bottlenecks: ['Dependencies'],
  rows: [instr('add rax, 0x1', '4883c001'), instr('add rax, 0x1', '4883c001'), instr('dec r15', '49ffcf'), instr('jnz 0x0', '75f3', 'M')],
  criticalPath: { ratio: 2, edges: [{ from: 0, to: 1, operand: 'RAX', latency: 1, carried: false }, { from: 1, to: 0, operand: 'RAX', latency: 1, carried: true }] },
};

// --- the chain -----------------------------------------------------------------------------------------------------
{
  const c = chainInfo(CHAIN);
  check(c && c.ratio === 2 && c.iterations === 1, 'chain: ratio and iterations', JSON.stringify(c));
  check(c.steps.map((s) => `${s.row}${s.arrow}`).join(' ') === '0→ 1↻', 'chain: steps in order, the carried edge is ↻', JSON.stringify(c.steps));
  check([...c.onChain.keys()].join() === '1,0' && c.onChain.get(0)[0].carried && c.onChain.get(1)[0].operand === 'rax', 'chain: the rows on it and what they read');
  check(c.lines[0] === 'rax ← add rax, 0x1 (1 cycle)' && c.lines[1] === 'rax ← add rax, 0x1 (1 cycle, previous iteration)', 'chain: tooltip lines', JSON.stringify(c.lines));
  const t = chainTitle(c, 0);
  check(/^critical dependency chain: 2\.00 cycles\/iteration\nreads rax from add rax, 0x1 \(1 cycle, previous iteration\)\n/.test(t), 'chain: the title of a row', t);
  check(chainInfo({ ...CHAIN, criticalPath: undefined }) === null && chainInfo({ ...CHAIN, criticalPath: { ratio: 1, edges: [] } }) === null, 'chain: none without a criticalPath');
  check(chainInfo({ ...CHAIN, criticalPath: { ratio: 1, edges: [{ from: 0, to: 1, operand: 'RAX', latency: 1, carried: true }] } }) === null, 'chain: an open path is rejected');
  check(chainInfo({ ...CHAIN, criticalPath: { ratio: 1, edges: [{ from: 0, to: 9, operand: 'RAX', latency: 1, carried: true }, { from: 9, to: 0, operand: 'RAX', latency: 1, carried: false }] } }) === null, 'chain: rows that do not exist are rejected');
  check(operandName('RAX') === 'rax' && operandName('mem') === 'mem' && operandName('flags') === 'flags' && operandName('YMM1') === 'ymm1', 'chain: operand names');
}

// --- NOPs ----------------------------------------------------------------------------------------------------------
{
  const expect = ['90', '6690', '0f1f00', '0f1f4000', '0f1f440000', '660f1f440000', '0f1f8000000000', '0f1f840000000000', '660f1f840000000000',
    '662e0f1f840000000000', '66662e0f1f840000000000'];
  check(expect.every((h, i) => nopHex(i + 1) === h), 'nop: the recommended sequences for 1–11 bytes', expect.map((_, i) => nopHex(i + 1)).join(' '));
  check([...Array(15)].every((_, i) => nopHex(i + 1).length === 2 * (i + 1)), 'nop: every length up to 15 bytes');
  check(nopHex(15) === '666666666666' + '2e0f1f840000000000' && nopHex(16) === nopHex(15) + '90' && nopHex(22) === nopHex(15) + nopHex(7) && nopHex(0) === '', 'nop: longer than 15 bytes: more than one');
}

// --- units and hex edits ---------------------------------------------------------------------------------------------
{
  const u = costUnits(CHAIN, CHAIN_HEX);
  check(u.ok && u.units.length === 4, 'units: the chain example', JSON.stringify(u));
  check(u.units.map((x) => `${x.rows.join('+')}:${x.start}-${x.end}${x.fixed ? 'F' : ''}`).join(' ') === '0:0-4 1:4-8 2:8-11 3:11-13F', 'units: offsets; the loop branch is fixed, its fused partner a unit of its own', u.units.map((x) => `${x.rows}:${x.start}-${x.end}`).join(' '));
  check(editHex(CHAIN_HEX, u.units[0]) === '4883c00149ffcf75f3' && editHex(CHAIN_HEX, u.units[2]) === '4883c0014883c00175f3', 'edit: removal');
  check(editHex(CHAIN_HEX, u.units[0], 'nop') === '0f1f40004883c00149ffcf75f3' && editHex(CHAIN_HEX, u.units[2], 'nop') === '4883c0014883c0010f1f0075f3', 'edit: NOPs of the same length');
  check(editHex(CHAIN_HEX.toUpperCase(), u.units[1]) === '4883c00149ffcf75f3', 'edit: case of the input');
  const jobs = costJobs(u.units, CHAIN_HEX);
  check(jobs.map((j) => `${j.unit}:${j.hex}`).join(' ') === '0:4883c00149ffcf75f3 1:4883c00149ffcf75f3 2:4883c0014883c00175f3', 'jobs: not for the loop branch', JSON.stringify(jobs));
  check(costJobs(u.units, CHAIN_HEX, 'nop').every((j) => j.hex.length === CHAIN_HEX.length), 'jobs: the NOP variant keeps the length');

  // a fused pair in the middle, inserted uops, an unrolled block (no fixed unit)
  const mid = { tp: 3, mode: 'unroll', rows: [extra('regMerge'), instr('add ah, bl', '00dc'), instr('cmp rax, rbx', '4839d8'), instr('jz 0x7', '7400', 'M'), extra('stackSync'), instr('push rax', '50')] };
  const m = costUnits(mid, '00dc4839d8740050');
  check(m.ok && m.units.map((x) => `${x.rows.join('+')}${x.fixed ? 'F' : ''}`).join(' ') === '1 2+3 5', 'units: a fused pair is one unit; inserted uops are not; nothing fixed when unrolled', JSON.stringify(m.units));
  check(editHex('00dc4839d8740050', m.units[1]) === '00dc50' && editHex('00dc4839d8740050', m.units[1], 'nop') === '00dc' + nopHex(5) + '50', 'edit: a fused pair goes together');
  check(costJobs(costUnits({ tp: 1, mode: 'unroll', rows: [instr('nop', '90')] }, '90').units, '90').length === 0, 'jobs: none that would leave no code');
  check(!costUnits(CHAIN, CHAIN_HEX + '06').ok && /not instructions/.test(costUnits(CHAIN, CHAIN_HEX + '06').reason), 'units: not with undecodable bytes');
  check(!costUnits({ rows: [extra('regMerge')] }, '').ok && !costUnits({ error: 'x' }, '').ok, 'units: none without instructions');
}

// --- Δ ---------------------------------------------------------------------------------------------------------------
{
  check(delta(1, 2) === -1 && delta(2.25, 2) === 0.25 && delta(1.1 + 0.2, 1.3) === 0 && delta(0.1 + 0.2, 0.3) === 0 && delta(3.3, 1.1) === 2.2, 'delta: at two decimals');
  check(formatDelta(-1) === '−1.00' && formatDelta(0.25) === '+0.25' && formatDelta(0) === '0.00', 'delta: formatting (minus sign)');
  const u = costUnits(CHAIN, CHAIN_HEX);
  const res = new Map([[0, { tp: 1, mode: 'loop' }], [1, { tp: 1, mode: 'loop' }]]);
  let cells = costCells(CHAIN, u, res);
  check(cells.map((c) => c.kind).join() === 'value,value,pending,fixed' && cells[0].text === '−1.00' && cells[3].text === '—', 'cells: values, pending, the loop branch', JSON.stringify(cells));
  check(cells[0].top && cells[1].top && !cells[2].top, 'cells: equal largest savings are all marked');
  res.set(2, { tp: 2.25, mode: 'loop' });
  cells = costCells(CHAIN, u, res);
  check(cells[2].text === '+0.25' && cells[2].delta === 0.25 && !cells[2].top && /2\.25 cycles\/iteration/.test(cells[2].title), 'cells: a positive Δ', JSON.stringify(cells[2]));
  res.set(0, { tp: 0.5, mode: 'loop' });
  cells = costCells(CHAIN, u, res);
  check(cells[0].top && !cells[1].top, 'cells: only the largest saving is marked');
  res.set(1, { error: 'boom' });
  res.set(0, { tp: 1, mode: 'unroll' });
  cells = costCells(CHAIN, u, res);
  check(cells[0].kind === 'na' && /unrolled/.test(cells[0].title) && cells[1].kind === 'na' && /boom/.test(cells[1].title) && !cells.some((c) => c.top), 'cells: another mode or an error give no value');
  const none = costCells(CHAIN, u, new Map([[0, { tp: 2, mode: 'loop' }], [1, { tp: 3, mode: 'loop' }], [2, { tp: 2, mode: 'loop' }]]));
  check(!none.some((c) => c.top) && none[0].text === '0.00', 'cells: no saving, nothing marked');
  const mid = { tp: 3, mode: 'unroll', rows: [extra('regMerge'), instr('add ah, bl', '00dc'), instr('cmp rax, rbx', '4839d8'), instr('jz 0x7', '7400', 'M')] };
  const mc = costCells(mid, costUnits(mid, '00dc4839d87400'), new Map([[1, { tp: 2, mode: 'unroll' }]]), 'nop');
  check(mc[0].kind === 'none' && mc[0].text === '' && mc[3].kind === 'with' && mc[3].text === '↑' && /NOPs together/.test(mc[3].title) && /macro-fused instruction below/.test(mc[2].title), 'cells: inserted uops and the second of a fused pair', JSON.stringify(mc));
  check(costKey('AB', 'SKL', { b: 1, a: 2 }, 'nop') === costKey('ab', 'SKL', { a: 2, b: 1, includeTrace: true }, 'nop') && costKey('ab', 'SKL', {}, 'nop') !== costKey('ab', 'SKL', {}, 'remove'), 'keys');
}

// --- URL state -------------------------------------------------------------------------------------------------------
{
  const f = encodeState({ ...DEFAULT_STATE, mode: 'hex', cmpSweep: true, cost: true, costNop: true });
  check(f === 'v=1&cmpsweep=1&cost=1&costnop=1', 'url: the cost column is remembered', f);
  const s = decodeState(f);
  check(s.cost && s.costNop && !decodeState('v=1').cost, 'url: and restored');
  // the trace (open), the wait column and the selected row of the uop table
  const t = { ...DEFAULT_STATE, mode: 'hex', text: '90', trace: true, waits: true, sel: 12 };
  const tf = encodeState(t);
  check(tf === 'v=1&trace=1&waits=1&sel=12&c=OTA' && JSON.stringify(decodeState(tf)) === JSON.stringify(t), 'url: the open trace, the wait column and the selected row', tf);
  check(decodeState('v=1&c=OTA').sel === -1 && !decodeState('v=1&c=OTA').trace && decodeState('v=1&sel=-3').sel === -1 && decodeState('v=1&sel=x').sel === -1 && decodeState('v=1&sel=9999999').sel === 1000000
    && encodeState({ ...DEFAULT_STATE, mode: 'hex', sel: -1 }) === 'v=1&m=hex', 'url: old links select nothing; bad selections are ignored');
}

// --- with the real analyzer ------------------------------------------------------------------------------------------
const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (!fs.existsSync(wasm) || !fs.existsSync(new URL('data/uarch.json', root))) {
  console.log('real analyzer or data missing: skipped those checks');
} else {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
  for (const t of ['SKL', 'ZEN3', 'ADL-P']) await e.loadArch(t, fs.readFileSync(new URL(`data/arch/${t}.json`, root)));
  const chainEx = EXAMPLES.find((x) => x.id === 'chain');
  const r = await e.analyze(makeRequest(chainEx.hex, 'SKL'));
  check(JSON.stringify(r.criticalPath) === JSON.stringify(CHAIN.criticalPath), 'real: the criticalPath of the chain example', JSON.stringify(r.criticalPath));
  check(r.rows.map((x) => x.notes).join() === ',,,M' && chainInfo(r).steps.length === 2, 'real: the chain example is what the tests above assume');
  // the loop branch's displacement does not matter (it is not adjusted when code is removed)
  const other = await e.analyze(makeRequest(chainEx.hex.slice(0, -2) + '80', 'SKL'));
  check(other.tp === r.tp && other.mode === 'loop', 'real: the displacement of the loop branch does not change the result');

  // a macro-fused pair in the middle (cmp rax, rbx; jz +0; add rax, 1; dec r15; jnz): removed together
  {
    const mid = '4839d874004883c00149ffcf75f2';
    const base = await e.analyze(makeRequest(mid, 'SKL'));
    const u = costUnits(base, mid);
    check(base.rows.map((x) => x.notes).join() === ',M,,,M' && u.units.map((x) => x.rows.join('+')).join(' ') === '0+1 2 3 4', 'real: a fused pair in the middle is one unit', JSON.stringify(u.units));
    const results = new Map();
    for (const j of costJobs(u.units, mid)) results.set(j.unit, summarize(await e.analyze(makeRequest(j.hex, 'SKL'))));
    const cells = costCells(base, u, results);
    const pair = await e.analyze(makeRequest('4883c00149ffcf75f2', 'SKL')); // hard-coded: without cmp and jz
    check(cells[0].delta === delta(pair.tp, base.tp) && cells[1].text === '↑' && cells[4].text === '—', 'real: the pair\'s Δ is that of the block without both', JSON.stringify([cells.map((c) => c.text), pair.tp, base.tp]));
  }
  // an unrolled block: every instruction can go; undecodable bytes: no cost column
  {
    const un = '4801d84801c3';
    const base = await e.analyze(makeRequest(un, 'SKL'));
    const u = costUnits(base, un);
    check(base.mode === 'unroll' && u.ok && u.units.every((x) => !x.fixed) && costJobs(u.units, un).map((j) => j.hex).join() === '4801c3,4801d8', 'real: an unrolled block');
    const bad = await e.analyze(makeRequest('4801d806', 'SKL'));
    check(bad.decodeErrors > 0 && !costUnits(bad, '4801d806').ok, 'real: no cost column with undecodable bytes', JSON.stringify(bad.rows?.map((x) => x.opcode)));
  }

  // the cost column of every example, against independent analyses of the modified blocks
  for (const ex of EXAMPLES) {
    for (const variant of ['remove', 'nop']) {
      const base = await e.analyze(makeRequest(ex.hex, ex.arch));
      const u = costUnits(base, ex.hex);
      const results = new Map();
      for (const j of costJobs(u.units, ex.hex, variant)) results.set(j.unit, summarize(await e.analyze(makeRequest(j.hex, ex.arch))));
      const cells = costCells(base, u, results, variant);
      // independently: drop (or overwrite) the bytes of each instruction row, from its opcode
      let ok = true;
      const instrs = base.rows.map((x, i) => [x, i]).filter(([x]) => x.kind === 'instr');
      let at = 0;
      const span = new Map(instrs.map(([x, i]) => { const s = [at, at + x.opcode.length / 2]; at = s[1]; return [i, s]; }));
      for (const [x, i] of instrs) {
        const c = cells[i];
        const last = i === instrs[instrs.length - 1][1];
        const next = base.rows[i + 1];
        if (last) { ok &&= c.text === '—'; continue; }
        if (x.notes === 'M' && !last) { ok &&= c.text === '↑'; continue; }
        let [s, t] = span.get(i);
        if (next?.notes === 'M' && i + 1 !== instrs[instrs.length - 1][1]) t = span.get(i + 1)[1];
        const h = ex.hex.slice(0, 2 * s) + (variant === 'nop' ? nopHex(t - s) : '') + ex.hex.slice(2 * t);
        const m = await e.analyze(makeRequest(h, ex.arch));
        const want = m.mode === base.mode ? (Math.round(m.tp * 100) - Math.round(base.tp * 100)) / 100 : null;
        if (want === null ? c.kind !== 'na' : c.delta !== want) { ok = false; console.log(ex.id, variant, i, c, m.tp, base.tp); }
      }
      if (process.env.SHOW) console.log(ex.id, variant, base.tp, cells.map((c) => c.text).join(" "));
      check(ok && cells.some((c) => c.kind === 'value'), `real: cost column of "${ex.id}" (${variant}) equals independent analyses`, cells.map((c) => c.text).join(' '));
    }
  }
}

console.log(`${count} insight checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
