// Tests of the bound view's data side (web/js/bound.js): the utilization of each resource, the next limit, and the
// share of each instruction in a resource; on hand-written responses, and (if the analyzer has been built) on the
// built-in examples on every CPU, against values this test derives from the uiCA text report.
// Usage: node tests-js/web_bound.mjs
import fs from 'node:fs';
import { boundModel, blame, topRows, shortPort, defaultResource } from '../web/js/bound.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES, CLASSIC_EXAMPLES } from '../web/js/examples.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);
const near = (a, b) => Math.abs(a - b) < 1e-9;

const COLS = ['MITE', 'MS', 'DSB', 'LSD', 'Issued', 'Exec.', 'Port 0', 'Port 1', 'Port 2', 'Port 3', 'Port 4', 'Port 5', 'Port 6', 'Port 7'];
const instr = (label, opcode, values, notes = '') => ({ kind: 'instr', label, opcode, notes, values });
// the "chain" example on SKL (values rounded): add rax, 1; add rax, 1; dec r15; jnz
const CHAIN = {
  tp: 2, mode: 'loop', bottlenecks: ['Dependencies'],
  limits: [{ name: 'DSB', tp: 1 }, { name: 'Issue', tp: 0.75 }, { name: 'Ports', tp: 1 }, { name: 'Dependencies', tp: 2 }],
  columns: COLS,
  rows: [
    instr('add rax, 0x1', '4883C001', [0, 0, 1, 0, 1, 1, 0.25, 0.25, 0, 0, 0, 0.25, 0.25, 0]),
    instr('add rax, 0x1', '4883C001', [0, 0, 1, 0, 1, 1, 0.25, 0.25, 0, 0, 0, 0.25, 0.25, 0]),
    instr('dec r15', '49FFCF', [0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0]),
    instr('jnz 0x0', '75F3', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'M'),
  ],
  criticalPath: { ratio: 2, edges: [{ from: 0, to: 1, operand: 'RAX', latency: 1, carried: false }, { from: 1, to: 0, operand: 'RAX', latency: 1, carried: true }] },
};

// --- hand-written ----------------------------------------------------------------------------------------------------
{
  check(shortPort('Port 0') === 'p0' && shortPort('Port A') === 'pA' && shortPort('ALU2') === 'ALU2' && shortPort('Div') === 'div', 'port names');
  const m = boundModel(CHAIN);
  const ids = m.items.map((x) => x.id);
  check(ids.join() === 'DSB,Issue,Ports,Dependencies,col:Port 0,col:Port 1,col:Port 5,col:Port 6', 'items: the limits in order, then the used ports', ids.join());
  check(m.items.find((x) => x.id === 'Dependencies').util === 1 && m.items.find((x) => x.id === 'Issue').util === 0.375, 'utilization = limit / tp');
  check(near(m.items.find((x) => x.id === 'col:Port 6').util, 0.75) && m.items.find((x) => x.id === 'col:Port 6').group === 'ports', 'a port: its uops / tp');
  check(m.binding.join() === 'Dependencies' && defaultResource(m) === 'Dependencies', 'binding: the bottleneck');
  check(m.next.name === 'DSB' && m.next.tp === 1 && m.next.speedup === 2, 'next: the largest limit below the bottleneck (the first of equal ones)', JSON.stringify(m.next));
  check(m.gap === 0 && !ids.includes('other'), 'no gap when a limit explains tp');
  check(m.items.find((x) => x.id === 'DSB').group === 'front' && m.items.find((x) => x.id === 'Issue').group === 'issue' && m.items.find((x) => x.id === 'Dependencies').group === 'deps', 'groups');

  const dep = blame(CHAIN, 'Dependencies');
  check(dep.unit === 'cycles' && dep.total === 2 && [...dep.weights].join() === '1,1,0,0', 'blame: the chain, by the latency of the edges that start at a row', JSON.stringify(dep));
  const top = topRows(dep);
  check(top.length === 2 && top[0].row === 0 && top[0].share === 0.5 && top[1].row === 1, 'top rows: ties in table order', JSON.stringify(top));
  const p6 = blame(CHAIN, 'col:Port 6');
  check([...p6.weights].join() === '0.25,0.25,1,0' && p6.total === 1.5, 'blame: a port column');
  const ports = blame(CHAIN, 'Ports');
  check(ports.ports.join() === 'p6' && [...ports.weights].join() === '0.25,0.25,1,0', 'blame: Ports = the saturated ports', JSON.stringify(ports));
  check([...blame(CHAIN, 'Issue').weights].join() === '1,1,1,0', 'blame: Issue = issued uops');
  check([...blame(CHAIN, 'DSB').weights].join() === '1,1,1,0', 'blame: DSB = uops from the DSB');
  check([...blame(CHAIN, 'Predecoder').weights].join() === '4,4,3,2' && blame(CHAIN, 'Predecoder').unit === 'bytes', 'blame: Predecoder = bytes');
  const dec = blame(CHAIN, 'Decoder');
  check(dec.unit === 'instructions' && [...dec.weights].join() === '1,1,1,0', 'blame: Decoder without MITE uops = instructions, a macro-fused one counts with its partner');
  check(blame(CHAIN, 'LSD') === null && blame(CHAIN, 'other') === null && blame(CHAIN, 'col:Port 9') === null, 'blame: nothing to attribute');

  // no limit explains tp: a gap, and the binding one is the largest limit
  const g = boundModel({ ...CHAIN, tp: 2.5, bottlenecks: [] });
  check(near(g.gap, 0.5) && g.items.at(-1).id === 'other' && g.items.at(-1).group === 'other' && near(g.items.at(-1).util, 0.2), 'gap: an "unexplained" item', JSON.stringify(g.items.at(-1)));
  check(g.binding.join() === 'Dependencies' && g.next.speedup === 2.5, 'gap: the binding limit is the largest; speedup relative to tp');
  // a limit above tp (uiCA's bound is pessimistic there)
  const o = boundModel({ ...CHAIN, tp: 1.5, bottlenecks: ['DSB'] });
  check(near(o.items.find((x) => x.id === 'Dependencies').util, 4 / 3) && o.gap === 0, 'a limit above tp: utilization above 1, no gap');
  check(o.binding.join() === 'DSB' && o.next.name === 'Issue' && o.next.speedup === 2, 'next: below the binding one (Dependencies, above it, is not next)', JSON.stringify(o.next));
  check(boundModel({ ...CHAIN, limits: [{ name: 'Dependencies', tp: 2 }] }).next === null, 'a single limit: no next');
  // several bottlenecks
  const two = boundModel({ ...CHAIN, bottlenecks: ['Dependencies', 'Ports'] });
  check(two.binding.join() === 'Dependencies,Ports' && two.next.name === 'DSB', 'several bottlenecks: next below the largest');
  check(boundModel({ error: 'x' }) === null && boundModel({ ...CHAIN, tp: 0 }) === null, 'no model for errors');
  // a divider column
  const div = boundModel({ ...CHAIN, columns: [...COLS, 'Div'], rows: CHAIN.rows.map((x, i) => ({ ...x, values: [...x.values, i === 2 ? 3 : 0] })) });
  check(div.items.at(-1).id === 'col:Div' && div.items.at(-1).name === 'div' && div.items.at(-1).util === 1.5, 'the divider: busy cycles / tp');
  check(blame({ ...CHAIN, columns: [...COLS, 'Div'], rows: CHAIN.rows.map((x, i) => ({ ...x, values: [...x.values, i === 2 ? 3 : 0] })) }, 'Ports').ports.join() === 'p6', 'Ports: the divider is not a port');
}

// --- the URL: whether the view is open --------------------------------------------------------------------------------
{
  const { encodeState, decodeState } = await import('../web/js/url-state.js');
  const f = encodeState({ text: 'x', bound: true });
  check(/(^|&)bound=1(&|$)/.test(f) && decodeState(f).bound === true, 'url: bound=1', f);
  check(!/bound/.test(encodeState({ text: 'x' })) && decodeState(encodeState({ text: 'x' })).bound === false && decodeState('v=1&bound=0&c=eA').bound === false, 'url: closed by default; old links stay closed');
}

// --- the examples on every CPU, against the text report -----------------------------------------------------------------
const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (!fs.existsSync(wasm) || !fs.existsSync(new URL('data/uarch.json', root))) {
  console.log('(analyzer or data/ missing: only the hand-written cases)');
} else {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  const uarchBytes = fs.readFileSync(new URL('data/uarch.json', root));
  await e.loadUarch(uarchBytes);
  const uarch = JSON.parse(uarchBytes);
  const archs = Object.keys(uarch.configs).filter((k) => !k.includes('_'));
  for (const t of new Set(archs.map((a) => uarch.configs[a].name))) await e.loadArch(t, fs.readFileSync(new URL(`data/arch/${t}.json`, root)));
  let cases = 0;
  for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES]) {
    for (const arch of archs) {
      const r = await e.analyze(makeRequest(ex.hex, arch));
      if (r.error) continue;
      cases++;
      const m = boundModel(r);
      // the text report: "Throughput (in cycles per iteration): X", the limits ("  - Name: X") and the "Total" line of the
      // table, whose fourth cell holds the port (and divider) totals with two decimals
      const tp = Number(/Throughput \(in cycles per iteration\): ([\d.]+)/.exec(r.text)[1]);
      const repLimits = [...r.text.matchAll(/^ {2}- (\w+): ([\d.]+)$/gm)].map((x) => [x[1], Number(x[2])]);
      const totalCells = (r.text.split('\n').find((l) => /│ Total$/.test(l)) ?? '').split('│');
      const portTotals = (totalCells[4] ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
      const ports = m.items.filter((x) => x.id.startsWith('col:'));
      let ok = near(m.tp, tp) && ports.length === portTotals.length
        && Math.abs(ports.reduce((s, x) => s + x.cycles, 0) - portTotals.reduce((s, x) => s + x, 0)) <= 0.0051 * ports.length
        && ports.every((x) => near(x.util, x.cycles / tp));
      const lim = m.items.filter((x) => x.limit);
      ok &&= lim.length === repLimits.length && lim.every((x, i) => x.name === repLimits[i][0] && near(x.util, repLimits[i][1] / tp));
      const max = Math.max(...repLimits.map((l) => l[1]));
      ok &&= tp - max > 0.005 ? near(m.gap, tp - max) : m.gap === 0;
      // every resource with a blame: shares sum to 1
      for (const it of m.items) {
        const b = blame(r, it.id);
        if (b) ok &&= near([...b.weights].reduce((s, x) => s + x, 0) / b.total, 1) && b.weights.length === r.rows.length;
      }
      check(ok, `${ex.id} on ${arch}: utilization from the report`, JSON.stringify({ tp, items: m.items.map((x) => [x.id, x.cycles]), repLimits, portTotals }));
    }
  }
  check(cases > 150, 'examples analyzed', String(cases));
}

console.log(`${count} bound checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
