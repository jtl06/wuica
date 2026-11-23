// Tests of the dependency arcs' data side (web/js/deps.js): the edges of one steady-state iteration from a trace, the
// critical chain, the lanes of the arcs; with the real analyzer (if built), every example on two CPUs against edges this
// test reads from the trace itself.
// Usage: node tests-js/web_deps.mjs
import fs from 'node:fs';
import { depGraph, neighbours } from '../web/js/deps.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES, CLASSIC_EXAMPLES } from '../web/js/examples.js';
import { encodeState, decodeState } from '../web/js/url-state.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);

const instr = (label) => ({ kind: 'instr', label, opcode: '90', notes: '', values: [] });
const uop = (rnd, instrID, deps = []) => ({ rnd, instrID, lamUopID: 0, fUopID: 0, uopID: 0, dependsOn: deps.map(([r, i]) => ({ rnd: r, instrID: i, lamUopID: 0, fUopID: 0, uopID: 0 })) });

// a hand-made trace: three instructions, rounds 0..4 (the middle one, 2, is read):
//   i1 reads i0 (same iteration) and i1 of the previous one; i2 reads itself two iterations back; i0 reads its own other uop
{
  const rows = [{ kind: 'regMerge', label: '<Register Merge Uop>', notes: '', values: [] }, instr('a'), instr('b'), instr('c')];
  const cycles = [];
  for (let r = 0; r <= 4; r++) {
    cycles.push({ cycle: r, addedToRS: [uop(r, 0, [[r, 0]]), uop(r, 1, [[r, 0], [r - 1, 1]]), uop(r, 2, [[r - 2, 2]])] });
  }
  const trace = { instructions: [{}, {}, {}], cycles };
  const response = { rows, criticalPath: { ratio: 1, edges: [{ from: 2, to: 2, operand: 'RAX', latency: 1, carried: true }] } };
  const g = depGraph(response, trace);
  check(g.round === 2 && g.nodes.map((n) => n.row).join() === '1,2,3', 'nodes: the instruction rows; the middle round', JSON.stringify(g));
  check(g.edges.map((e) => `${e.a}>${e.b}:${e.dist}`).join() === '0>1:0,1>1:1,2>2:2', 'edges: same iteration, carried, two iterations; none within one instruction', JSON.stringify(g.edges));
  check(g.edges.map((e) => e.critical).join() === 'false,true,false', 'the critical chain (row 2 -> row 2, carried) is marked', JSON.stringify(g.edges));
  check(g.lanes === 2 && g.edges[1].lane === 0 && g.edges[2].lane === 0 && g.edges[0].lane === 1, 'lanes: the short arcs first, overlapping ones apart', JSON.stringify(g.edges));
  const nb = neighbours(g, 1);
  check(nb.reads.map((x) => `${x.node}:${x.dist}`).join() === '0:0,1:1' && nb.feeds.map((x) => `${x.node}:${x.dist}`).join() === '1:1', 'neighbours: reads and feeds', JSON.stringify(nb));
  check(depGraph(response, { ...trace, instructions: [{}, {}] }) === null && depGraph({ error: 'x' }, trace) === null, 'no graph when the trace does not match the table');
  check(depGraph(response, { instructions: [{}, {}, {}], cycles: [] }).edges.length === 0, 'no uops: no edges');
  const f = encodeState({ text: 'x', deps: true });
  check(/(^|&)deps=1(&|$)/.test(f) && decodeState(f).deps === true && decodeState(encodeState({ text: 'x' })).deps === false, 'url: deps=1');
}

const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (fs.existsSync(wasm) && fs.existsSync(new URL('data/uarch.json', root))) {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
  for (const t of ['SKL', 'ZEN3']) await e.loadArch(t, fs.readFileSync(new URL(`data/arch/${t}.json`, root)));
  for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES]) {
    for (const arch of ['SKL', 'ZEN3']) {
      const r = await e.analyze(makeRequest(ex.hex, arch, { includeTrace: true }));
      const g = depGraph(r, r.trace);
      // independently: every dependsOn of the uops of the middle round, by instruction, without repeats
      const rounds = r.trace.cycles.flatMap((c) => (c.addedToRS ?? []).map((u) => u.rnd));
      const mid = Math.floor(Math.max(...rounds) / 2);
      const want = new Set();
      for (const c of r.trace.cycles) for (const u of c.addedToRS ?? []) if (u.rnd === mid) for (const d of u.dependsOn ?? []) if (!(d.rnd === mid && d.instrID === u.instrID)) want.add(`${d.instrID}>${u.instrID}:${mid - d.rnd}`);
      const got = new Set(g.edges.map((x) => `${x.a}>${x.b}:${x.dist}`));
      // the edges of the critical chain that the trace does not have (through memory) are added
      const rowToNode = new Map(g.nodes.map((n, i) => [n.row, i]));
      const cpEdges = r.criticalPath?.edges ?? [];
      const extra = cpEdges.filter((x) => ![...want].some((k) => { const [ab, d] = k.split(':'); return ab === `${rowToNode.get(x.from)}>${rowToNode.get(x.to)}` && (Number(d) > 0) === x.carried; }));
      for (const x of extra) want.add(`${rowToNode.get(x.from)}>${rowToNode.get(x.to)}:${x.carried ? 1 : 0}`);
      check(got.size === want.size && [...want].every((k) => got.has(k)), `${ex.id} on ${arch}: the edges of the middle iteration`, JSON.stringify([[...got], [...want]]));
      check(extra.every((x) => x.operand === 'mem') && g.edges.filter((x) => x.mem).length === extra.length, `${ex.id} on ${arch}: only memory edges of the chain are added`, JSON.stringify(extra));
      const cp = cpEdges.map((x) => `${rowToNode.get(x.from)}>${rowToNode.get(x.to)}:${x.carried ? 'c' : 's'}`);
      const marked = g.edges.filter((x) => x.critical).map((x) => `${x.a}>${x.b}:${x.dist ? 'c' : 's'}`);
      check(cp.every((k) => marked.includes(k)), `${ex.id} on ${arch}: the critical chain is marked on the arcs`, JSON.stringify([cp, marked]));
      // lanes: arcs in the same lane never overlap
      const ok = g.edges.every((a, i) => g.edges.every((b, j) => i === j || a.lane !== b.lane || Math.max(a.a, a.b) < Math.min(b.a, b.b) || Math.max(b.a, b.b) < Math.min(a.a, a.b)));
      check(ok && g.lanes === new Set(g.edges.map((x) => x.lane)).size, `${ex.id} on ${arch}: lanes do not overlap`);
    }
  }
}

console.log(`${count} dependency checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
