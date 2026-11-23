// Tests of the arc latencies and the slack per instruction (web/js/deps-slack.js): register names, latencies from the
// details, slack on hand-made graphs; with the real analyzer (if built) every example on three CPUs: the chain's
// instructions have slack 0, the latencies fit the chain (no cycle heavier than it), and each finite slack is exact (one
// cycle more breaks the period, the slack itself does not); the sliced version gives the same.
// Usage: node tests-js/web_deps_slack.mjs
import fs from 'node:fs';
import { canonReg, edgeLatency, annotateLatencies, slackOf, slackOfAsync, fmtSlack } from '../web/js/deps-slack.js';
import { depGraph } from '../web/js/deps.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);

check(['EAX', 'AX', 'AL', 'AH', 'RAX', '[RAX]'].every((r) => canonReg(r) === 'RAX') && canonReg('R8D') === 'R8' && canonReg('R10B') === 'R10'
  && canonReg('XMM3') === 'V3' && canonReg('YMM3') === 'V3' && canonReg('SIL') === 'RSI' && canonReg('flags (C)') === 'flags (C)', 'register names');

const det = (outs, ins, extra = {}) => ({ uopList: [{ inputs: ins, outputs: outs }], ...extra });
check(edgeLatency(det([['YMM0', 4]], ['YMM0', 'YMM4']), det([['YMM0', 4]], ['YMM0', 'pseudo'])) === 4, 'latency: the output the consumer reads');
check(edgeLatency(det([['RAX', 1], ['flags (C)', 1]], ['RAX']), det([], ['flags (C)'])) === 1, 'latency: flags');
check(edgeLatency(det([['EAX', 3]], ['ECX']), det([], ['[RAX]'])) === 3, 'latency: an address register, partial names');
check(edgeLatency(det([['R14D', 1]], ['EDX'], { mayBeEliminated: true }), det([], ['R14D'])) === 0, 'latency: an eliminable move is 0');
check(edgeLatency(det([['RDX', 5], ['flags (C)', 9]], []), det([], ['RBX'])) === 5 && edgeLatency(null, det([], [])) === null, 'latency: no match: the largest register output; no details: null');

// hand-made: a 2-cycle (0 -> 1 -> 0 carried, 3 + 3 = 6 per iteration), a self-loop on 2 (1 per iteration), 3 off any cycle
{
  const g = { nodes: [0, 1, 2, 3].map((row) => ({ row, label: `i${row}` })), edges: [
    { a: 0, b: 1, dist: 0, lat: 3 }, { a: 1, b: 0, dist: 1, lat: 3 }, { a: 2, b: 2, dist: 1, lat: 1 }, { a: 1, b: 3, dist: 0, lat: 2 }, { a: 2, b: 0, dist: 0, lat: 1 }] };
  const r = slackOf(g, 6);
  check(r && [...r.slack].map(fmtSlack).join() === '0,0,5,∞', 'slack: chain 0, self-loop P - 1, off the cycles ∞', JSON.stringify(r && [...r.slack]));
  check(slackOf(g, 5) === null, 'slack: a period shorter than the heaviest cycle: null');
  check(slackOf({ ...g, edges: [...g.edges, { a: 3, b: 3, dist: 0, lat: null }] }, 6) === null && slackOf(g, 0) === null, 'slack: unknown latency or no period: null');
  const p = slackOf(g, 6, { budget: 1 });
  check(p.partial && Number.isNaN(p.slack[0]) && p.slack[3] === Infinity && fmtSlack(p.slack[0]) === '', 'slack: over the budget: not computed (NaN, shown empty)');
  // a fractional period: a cycle of 3 over two iterations
  const h = { nodes: [{ row: 0 }, { row: 1 }], edges: [{ a: 0, b: 1, dist: 1, lat: 1 }, { a: 1, b: 0, dist: 1, lat: 2 }, { a: 0, b: 0, dist: 1, lat: 1 }] };
  const q = slackOf(h, 1.5);
  check(q && q.slack[0] === 0 && q.slack[1] === 0 && fmtSlack(0.5) === '0.5', 'slack: a fractional period', JSON.stringify(q && [...q.slack]));
}

// with the analyzer
const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
const distWasm = new URL('web/dist/wuica_wasm.wasm', root);
const wasmPath = fs.existsSync(distWasm) ? distWasm : fs.existsSync(wasm) ? wasm : null;
const dataDir = new URL('data/', root);
if (!wasmPath || !fs.existsSync(new URL('uarch.json', dataDir))) {
  console.log('(no analyzer or data: the examples are skipped)');
} else {
  const { WasmEngine, makeRequest } = await import('../web/js/engine.js');
  const { EXAMPLES, CLASSIC_EXAMPLES } = await import('../web/js/examples.js');
  const engine = await WasmEngine.create(fs.readFileSync(wasmPath));
  const uarchBytes = fs.readFileSync(new URL('uarch.json', dataDir));
  await engine.loadUarch(uarchBytes);
  const configs = JSON.parse(uarchBytes).configs;
  let withChain = 0;
  for (const arch of ['SKL', 'ZEN3', 'ADL-P']) {
    const table = configs[arch].name;
    if (!engine.hasArch(table)) await engine.loadArch(table, fs.readFileSync(new URL(`arch/${table}.json`, dataDir)));
    for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES]) {
      const req = makeRequest(ex.hex, arch);
      const r = await engine.analyze(req);
      const t = await engine.analyze({ ...req, includeTrace: true, details: true });
      const g = annotateLatencies(depGraph(r, t.trace), r, t.details);
      const tag = `${arch} ${ex.id}`;
      check(g && g.edges.every((e) => Number.isFinite(e.lat) && e.lat >= 0), `${tag}: every arc has a latency`, JSON.stringify(g?.edges));
      for (const c of r.criticalPath?.edges ?? []) {
        const e = g.edges.find((x) => g.nodes[x.a].row === c.from && g.nodes[x.b].row === c.to && (x.dist > 0) === c.carried);
        check(e && e.lat >= c.latency, `${tag}: the chain's edges carry its latency`, JSON.stringify([c, e]));
      }
      const P = r.criticalPath?.ratio;
      if (!(P > 0)) { check(slackOf(g, P) === null, `${tag}: no chain, no slack`); continue; }
      withChain++;
      const s = slackOf(g, P);
      check(s && !s.partial, `${tag}: the latencies fit the chain (${P} cycles/iteration)`);
      if (!s) continue;
      const crit = new Set(); for (const e of g.edges) if (e.critical) { crit.add(e.a); crit.add(e.b); }
      check([...crit].every((i) => s.slack[i] === 0), `${tag}: the chain's instructions have slack 0`, JSON.stringify([...s.slack]));
      const a = await slackOfAsync(g, P, { slice: 0, pause: async () => {} });
      check(a && [...a.slack].join() === [...s.slack].join(), `${tag}: sliced = whole`);
      // exactness: an instruction delayed by its slack keeps the period, by one cycle more it does not
      s.slack.forEach((x, i) => {
        if (!Number.isFinite(x)) return;
        const delayed = (d) => ({ ...g, edges: g.edges.map((e) => (e.a === i ? { ...e, lat: e.lat + d } : e)) });
        check(slackOf(delayed(x), P) !== null && slackOf(delayed(x + 1), P) === null, `${tag}: the slack of ${g.nodes[i].label} (${x}) is exact`);
      });
    }
  }
  check(withChain >= 20, 'examples with a chain', String(withChain));
  // dot1 on SKL: the four FMAs are the chain (16 cycles), the counter add rax, 32 could wait 15 cycles, the loads are off every cycle
  {
    const ex = CLASSIC_EXAMPLES.find((e) => e.id === 'dot1');
    const req = makeRequest(ex.hex, 'SKL');
    const r = await engine.analyze(req);
    const t = await engine.analyze({ ...req, includeTrace: true, details: true });
    const g = annotateLatencies(depGraph(r, t.trace), r, t.details);
    const s = slackOf(g, r.criticalPath.ratio);
    const by = (re) => g.nodes.map((n, i) => [n.label, s.slack[i]]).filter(([l]) => re.test(l)).map(([, x]) => fmtSlack(x));
    check(by(/^vfmadd/).join() === '0,0,0,0' && by(/^add rax/).join() === '15' && by(/^vmovups/).every((x) => x === '∞'), 'dot1 SKL: FMAs 0, add 15, loads ∞', JSON.stringify(g.nodes.map((n, i) => [n.label, fmtSlack(s.slack[i])])));
    const fma = g.edges.filter((e) => e.critical);
    check(fma.length === 4 && fma.every((e) => e.lat === 4), 'dot1 SKL: the chain\'s arcs are 4 cycles each');
  }
}

console.log(`${count} deps slack checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
