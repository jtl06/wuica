// Tests of the cycle range of the trace (web/js/trace-range.js): the port shares and the issue slots of a range, on a
// hand-made trace, and (if the analyzer has been built) on the built-in examples against the steady-state numbers of the
// analysis; the page's range (set, clear, subscribers).
// Usage: node tests-js/web_trace_range.mjs
import fs from 'node:fs';
import { buildModel, loadTrace } from '../web/js/trace.js';
import { issueLog } from '../web/js/trace-issue.js';
import { clampRange, issuedPerCycle, rangeStats, rangeSlotParts, steadyShares, traceRange, flush } from '../web/js/trace-range.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES, CLASSIC_EXAMPLES } from '../web/js/examples.js';
import { tableBytes } from './tables.mjs'; // the binary tables (the module reads no JSON tables)

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// --- a hand-made trace: 8 cycles, ports 0 and 1, issue width 2 --------------------------------------------------------------
{
  const uop = (rnd, instrID, fUopID, uopID) => ({ rnd, instrID, lamUopID: 0, fUopID, uopID });
  // round r: instruction 0 (two unfused uops in one fused uop) and instruction 1 (one uop), issued in cycle 2r / 2r+1
  const cycles = [];
  for (let c = 0; c < 8; c++) cycles.push({ cycle: c });
  for (let r = 0; r < 3; r++) {
    const c = 2 * r;
    (cycles[c].addedToRB ??= []).push(uop(r, 0, 0, null)); // one fused uop: one slot
    (cycles[c + 1].addedToRB ??= []).push(uop(r, 1, 0, null));
    (cycles[c + 1].addedToRS ??= []).push({ ...uop(r, 0, 0, 0), dependsOn: [] }, { ...uop(r, 0, 0, 1), dependsOn: [] });
    (cycles[c + 2].addedToRS ??= []).push({ ...uop(r, 1, 0, 0), dependsOn: [] });
    cycles[c + 1].dispatched = { Port0: uop(r, 0, 0, 0), Port1: uop(r, 0, 0, 1) };
    if (r < 2) cycles[c + 2].dispatched = { Port0: uop(r, 1, 0, 0) };
  }
  const trace = { parameters: { allPorts: ['0', '1'], issueWidth: 2 }, instructions: [{ asm: 'a' }, { asm: 'b' }], cycles };
  const m = buildModel(trace);
  check(m.nCycles === 8 && m.ports.map((p) => p.used).join() === '5,3', 'model: dispatches per port', m.ports.map((p) => p.used).join());
  check([...issuedPerCycle(m)].join() === '1,1,1,1,1,1,0,0', 'issued fused uops per cycle (two unfused uops of one fused uop: one slot)', [...issuedPerCycle(m)].join());
  check(clampRange(m, 5, -3).join() === '0,5' && clampRange(m, 6, 99).join() === '6,7' && clampRange(m, 9, 12) === null && clampRange(null, 0, 1) === null, 'clamp');

  // port 0 dispatches in cycles 1, 2, 3, 4, 5 (instruction 0 of rounds 0..2, instruction 1 of rounds 0, 1); port 1 in 1, 3, 5
  const all = rangeStats(m, 0, 7);
  check(all.cycles === 8 && all.ports.map((p) => `${p.name}:${p.uops}`).join() === 'Port 0:5,Port 1:3' && near(all.ports[0].share, 5 / 8), 'all cycles: uops and shares', JSON.stringify(all.ports));
  const r = rangeStats(m, 4, 2);
  check(r.a === 2 && r.b === 4 && r.cycles === 3 && r.ports[0].uops === 3 && r.ports[1].uops === 1 && near(r.ports[1].share, 1 / 3) && r.ports[0].share === 1, 'a range given backwards', JSON.stringify(r));
  check(rangeStats(m, 6, 6).ports.map((p) => p.uops).join() === '0,0', 'one cycle without dispatches');
  // without an issue log: every lost slot is "unknown"
  check(all.slots.width === 2 && all.slots.issued === 6 && all.slots.unknown === 10 && all.slots.logged === 0, 'slots without a log', JSON.stringify(all.slots));
  // with a log of cycles 2..5 (as the analyzer gives it for the steady state): its causes there, unknown elsewhere
  m.issue = issueLog({ issue: { width: 2, first: 2, issued: [1, 1, 1, 2], cause: 'FRS.', slots: {} } });
  const s = rangeStats(m, 1, 6).slots;
  check(s.logged === 4 && s.issued === 1 + 5 + 0 && s.frontEnd === 1 && s.rob === 1 && s.rs === 1 && s.other === 0 && s.unknown === 1 + 2, 'slots: causes from the log where it covers the cycle', JSON.stringify(s));
  const parts = rangeSlotParts(s);
  check(parts.map((p) => p.key).join() === 'issued,frontEnd,rob,rs,unknown' && near(parts.reduce((t, p) => t + p.share, 0), 1) && near(parts[0].share, 6 / 12), 'slot parts: the empty ones left out, shares of all slots', JSON.stringify(parts));
  check(rangeSlotParts(null).length === 0, 'slot parts: none');

  // steady-state shares from a response: per port column, uops per iteration / tp; not the divider, not the counts
  const ss = steadyShares({ tp: 2, columns: ['DSB', 'Issued', 'Port 0', 'ALU1', 'Div'], rows: [{ values: [1, 1, 1, 0.5, 4] }, { values: [0, 1, 0.5, 0.5, 0] }] });
  check([...ss.keys()].join() === 'Port 0,ALU1' && ss.get('Port 0') === 0.75 && ss.get('ALU1') === 0.5 && steadyShares(null).size === 0, 'steady shares', JSON.stringify([...ss]));

  // the page's range: one at a time, per model; subscribers once per change
  const seen = [];
  const off = traceRange.subscribe((x) => seen.push(x ? `${x.a}-${x.b}` : 'none'));
  const view = {};
  traceRange.set(view, m, 6, 2);
  traceRange.set(view, m, 2, 6); // the same: no call
  flush();
  check(seen.join() === '2-6' && traceRange.of(view)?.a === 2 && traceRange.of({}) === null, 'range: set, kept for its run', seen.join());
  traceRange.clear({}); // another model: kept
  flush();
  check(traceRange.get() !== null && seen.length === 1, 'range: clear(model) of another trace keeps it');
  traceRange.set(view, m, 20, 30); // outside the trace: cleared
  flush();
  check(traceRange.get() === null && seen.join() === '2-6,none', 'range: none outside the trace', seen.join());
  off();
}

// --- the examples: the range of the steady state against the analysis ------------------------------------------------------
const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (!fs.existsSync(wasm) || !fs.existsSync(new URL('data/uarch.json', root))) {
  console.log('(analyzer or data/ missing: only the hand-made trace)');
} else {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  const uarchBytes = fs.readFileSync(new URL('data/uarch.json', root));
  await e.loadUarch(uarchBytes);
  const uarch = JSON.parse(uarchBytes);
  const archs = ['SKL', 'ADL-P', 'ZEN3'].filter((a) => uarch.configs[a]);
  let cases = 0, diffs = 0, sumDiff = 0;
  const close = []; // [what, port, trace share, steady share]
  for (const arch of archs) {
    const cfg = uarch.configs[arch];
    await e.loadArch(cfg.name, tableBytes(cfg.name));
    for (const b of [...EXAMPLES, ...CLASSIC_EXAMPLES]) {
      const request = makeRequest(b.hex, arch);
      const r = await e.analyze(request);
      if (r.error) continue;
      const { model } = await loadTrace({ response: r, request }, { analyze: (q) => e.analyze(q), config: () => cfg });
      const log = model.issue;
      const what = `${b.id} ${arch}`;
      if (!log) continue;
      const d = (await e.analyze({ ...request, details: true })).details.issue;
      cases++;
      // the whole issue log (the analyzer's steady-state window): the slots of the analysis, summed over its cycles
      const st = rangeStats(model, log.first, log.first + log.issued.length - 1);
      if (d.cycles === log.issued.length) {
        const s = st.slots;
        const want = (k) => d.slots[k] * d.iterations; // the response has them per iteration
        const ok = s.logged === s.cycles && s.unknown === 0 && ['issued', 'frontEnd', 'rob', 'rs', 'other'].every((k) => Math.abs(s[k] - want(k)) <= 0.01 * d.iterations + 1e-9);
        check(ok, `${what}: the slots of the steady state are the analysis' slots`, JSON.stringify([s, d.slots, d.iterations]));
      }
      // the issued slots outside the log come from the trace's own fused uops: the same where both are known
      const iss = issuedPerCycle(model);
      check(log.issued.every((n, k) => log.first + k >= model.nCycles || iss[log.first + k] === n), `${what}: issued per cycle, trace = log`);
      // ports: uops per cycle in the window against uops per iteration / tp of the analysis. uiCA counts the uops of the
      // steady-state iterations, the range the dispatches in its cycles, and the dispatch of a deep loop runs ahead of its
      // retirement, so they agree only roughly (exactly, for a loop that repeats every iteration).
      const ss = steadyShares(r);
      for (const p of st.ports) {
        check(ss.has(p.name), `${what}: port ${p.name} is a column of the uop table`);
        const x = Math.abs(p.share - (ss.get(p.name) ?? 0));
        diffs++; sumDiff += x;
        close.push([what, p.name, p.share, ss.get(p.name)]);
      }
    }
  }
  check(cases >= 30, 'examples traced', String(cases));
  check(sumDiff / diffs < 0.1, 'ports: the steady-state window agrees with the analysis on average (within 10 points)', (sumDiff / diffs).toFixed(4));
  // loops that repeat exactly: within rounding (the page shows whole percent; 0.02: room for changes of the model)
  for (const [what, port, a, b] of close) {
    if (!/^(chain|saxpy|memcpy|gemm|popcnt) SKL$/.test(what)) continue;
    check(Math.abs(a - b) <= 0.02, `${what}: ${port} within rounding of the steady state`, `${a.toFixed(3)} vs ${b.toFixed(3)}`);
  }
}

console.log(`${count} trace range checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
