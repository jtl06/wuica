// Tests of the data side of the trace view (web/js/trace.js, the part without DOM).
//   node tests-js/web_trace.mjs [EVERY_NTH=4] [WASM]
//  1. a small hand-made trace with every granularity of event (exact values);
//  2. the reference's traces (the `json` of fixtures/generated/*sim_fixtures.jsonl.gz, if present): every event
//     lands on a row, the stages are in order, the dependencies resolve, and the steady-state rounds give the
//     reference's throughput;
//  3. the real module (if built): a 50-instruction loop with its trace, and the time the model takes.
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { buildModel, relevantRounds, rangeChoices, selectRows, cycleSpan, uopDetails, tableRows, toTSV, TABLE_HEAD, STAGES, uopKey, traceEstimate, TRACE_LIMIT,
import { tableBytes } from './tables.mjs'; // the binary tables (the module reads no JSON tables)
  rowGroups, rowOfGroup, groupKey, waitBreakdown, uopWaits, waitText, abWindow, roundStart, roundEnds } from '../web/js/trace.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);
const every = Number(process.argv[2] || 4);

// --- 1. a hand-made trace ---------------------------------------------------------------------------------------------
{
  const U = (rnd, instrID, lamUopID, fUopID, uopID, extra = {}) => ({ rnd, instrID, lamUopID, ...(fUopID === undefined ? {} : { fUopID }), ...(uopID === undefined ? {} : { uopID }), ...extra });
  const trace = {
    parameters: { uArchName: 'TEST', allPorts: ['0', '1', '5', 'a'] },
    instructions: [
      { asm: 'push rax', instrID: 0, opcode: '50' },
      { asm: 'xor eax, eax', instrID: 1, opcode: '31C0' },
      { asm: 'dec r15', instrID: 2, opcode: '49FFCF', macroFusedWithNextInstr: true },
      { asm: 'jnz 0x0', instrID: 3, opcode: '7500' },
    ],
    cycles: [
      { cycle: 0, addedToIQ: [{ rnd: 0, instr: 0 }, { rnd: 0, instr: 1 }],
        addedToIDQ: [U(0, 0, 0, undefined, undefined, { stackSyncUop: true, source: 'MITE' }), U(0, 0, 1, undefined, undefined, { source: 'MITE' })] },
      { cycle: 1, removedFromIQ: [{ rnd: 0, instr: 0 }], addedToIDQ: [U(0, 1, 0, undefined, undefined, { source: 'MITE' }), U(0, 2, 0, undefined, undefined, { source: 'MITE' })] },
      { cycle: 2, removedFromIDQ: [U(0, 0, 0, 0, undefined, { stackSyncUop: true }), U(0, 0, 1, 0)], addedToRB: [U(0, 0, 0, 0, undefined, { stackSyncUop: true }), U(0, 0, 1, 0), U(0, 1, 0, 0)],
        addedToRS: [U(0, 0, 0, 0, 0, { stackSyncUop: true, dependsOn: [] }), U(0, 0, 1, 0, 0, { dependsOn: [] }), U(0, 0, 1, 0, 1, { dependsOn: [U(0, 0, 0, 0, 0, { stackSyncUop: true })] })],
        executed: [U(0, 1, 0, 0, 0)] },
      { cycle: 3, readyForDispatch: [U(0, 0, 0, 0, 0, { stackSyncUop: true }), U(0, 0, 1, 0, 0)], dispatched: { Port0: U(0, 0, 0, 0, 0, { stackSyncUop: true }), Porta: U(0, 0, 1, 0, 0) },
        addedToRB: [U(0, 2, 0, 0)], removedFromIDQ: [U(0, 2, 0, 0)], addedToRS: [U(0, 2, 0, 0, 0, { dependsOn: [] })] },
      { cycle: 4, executed: [U(0, 0, 0, 0, 0, { stackSyncUop: true })], readyForDispatch: [U(0, 0, 1, 0, 1)], dispatched: { Port1: U(0, 0, 1, 0, 1) } },
      { cycle: 5, executed: [U(0, 0, 1, 0, 0)] },
      { cycle: 6, executed: [U(0, 0, 1, 0, 1)], removedFromRB: [U(0, 0, 0, 0, undefined, { stackSyncUop: true })] },
      { cycle: 7, removedFromRB: [U(0, 0, 1, 0), U(0, 1, 0, 0)] },
    ],
  };
  const m = buildModel(trace, { portNames: { a: 'ALU0' } });
  const keys = m.uops.map((u) => u.key);
  check(JSON.stringify(keys) === JSON.stringify(['0/0/0/0/0', '0/0/1/0/0', '0/0/1/0/1', '0/1/0/0/0', '0/2/0/0/0']), 'mini: one row per unfused uop, in program order', JSON.stringify(keys));
  const [sync, st1, st2, xor, dec] = m.uops;
  check(sync.kind === 'stackSync' && st1.kind === 'instr' && sync.iq === null && st1.iq === 0, 'mini: stack-sync uop by its flag; predecode only for the instruction\'s own uops', JSON.stringify([sync.kind, sync.iq, st1.iq]));
  check(st1.idq === 0 && st2.idq === 0 && st1.issued === 2 && st2.issued === 2 && st1.retired === 7 && st2.retired === 7, 'mini: the laminated and fused events reach both uops of a micro-fused pair');
  check(st1.port === 'a' && st1.dispatched === 3 && st1.executed === 5 && st2.port === '1' && st2.ready === 4 && st2.executed === 6, 'mini: unfused events');
  check(st2.deps.length === 1 && st2.deps[0] === 0 && sync.users.includes(2), 'mini: dependsOn resolves to the row; reverse edges');
  check(xor.inRS === false && xor.executed === 2 && xor.issued === 2 && xor.port === null && uopDetails(m, 3).eliminated, 'mini: an eliminated uop (executed at issue, never in the scheduler)');
  check(dec.retired === null && dec.executed === null && dec.inRS, 'mini: a uop cut off by the end of the trace has no later stages');
  check(m.labels[2] === 'dec r15 + jnz 0x0', 'mini: the macro-fused branch is shown with its instruction', m.labels[2]);
  check(st1.n === 1 && st1.of === 2 && st2.n === 2 && sync.of === 1, 'mini: uop n of m within the instruction');
  check(m.ports.map((p) => `${p.id}:${p.name}:${p.used}`).join(',') === '0:Port 0:1,1:Port 1:1,5:Port 5:0,a:ALU0:1', 'mini: ports in allPorts order, named, with their use', JSON.stringify(m.ports));
  check(m.dispatchedAt[3][3] === 1 && m.dispatchedAt[0][3] === 0 && m.dispatchedAt[1][4] === 2 && m.dispatchedAt[2].every((x) => x === -1), 'mini: dispatches per port and cycle');
  const d = uopDetails(m, 2);
  check(d.portName === 'Port 1' && d.stages.find((s) => s.field === 'dispatched').cycle === 4 && d.waitOperands === 2 && d.waitPort === 0 && uopDetails(buildModel(trace, { issueDispatchDelay: 1 }), 2).waitOperands === 1 && d.deps[0].label === 'stack sync uop', 'mini: details of a uop', JSON.stringify(d));
  const rows = selectRows(m, 0, 0);
  const t = tableRows(m, rows);
  check(t.length === 5 && t.every((r) => r.length === TABLE_HEAD.length) && t[3][2] === 'none (eliminated)' && t[1][2] === 'ALU0' && t[2][TABLE_HEAD.length - 1] === 'stack sync uop [it 0]', 'mini: table rows', JSON.stringify(t));
  check(toTSV(m, rows).split('\n').length === 7 && toTSV(m, rows).startsWith('iteration\tinstruction\tport\tpredecoded'), 'mini: tab-separated text');
  check(JSON.stringify(cycleSpan(m, rows)) === '[1,7]', 'mini: the cycles of the rows', JSON.stringify(cycleSpan(m, rows)));
  check(uopKey({ rnd: 1, instrID: 2, lamUopID: 0, fUopID: 0 }) === '1/2/0/0/-', 'mini: keys');
  let threw = false; try { buildModel({}); } catch { threw = true; }
  check(threw, 'mini: not a trace');
  check(traceEstimate(50, { minIterations: 10, minCycles: 500 }) < TRACE_LIMIT && traceEstimate(3000, { minIterations: 20, minCycles: 500 }) > TRACE_LIMIT, 'size guard');

  // the uop table's rows as groups of the trace: the stack-sync row is the push's; the macro-fused jnz is the dec's
  const rows4 = [{ kind: 'stackSync' }, { kind: 'instr', label: 'push rax' }, { kind: 'instr', label: 'xor eax, eax' }, { kind: 'instr', label: 'dec r15' }, { kind: 'instr', label: 'jnz 0x0', notes: 'M' }];
  const g = rowGroups(rows4);
  check(g.map((x) => `${groupKey(x)}${x.fused ? '+' : ''}`).join() === '0/stackSync,0/instr,1/instr,2/instr,2/instr+', 'mini: table rows as instructions of the trace', JSON.stringify(g));
  check(rowOfGroup(g, { instrID: 2, kind: 'instr' }) === 3 && rowOfGroup(g, { instrID: 0, kind: 'stackSync' }) === 0 && rowOfGroup(g, { instrID: 9, kind: 'instr' }) === -1 && rowOfGroup(g, null) === -1 && rowGroups(null).length === 0, 'mini: the row of an instruction');
  check(m.uops.every((u) => g.some((x) => !x.fused && groupKey(x) === groupKey(u))), 'mini: every uop belongs to a row');

  // the wait breakdown (cycles per uop): exact values
  const wb = waitBreakdown(m, 0, 0);
  const pick = (k) => { const w = wb.get(k); return w && ['queue', 'delay', 'operands', 'port', 'exec', 'retire', 'n'].map((p) => w[p]).join(); };
  check(pick('0/stackSync') === '2,0,1,0,1,2,1' && pick('0/instr') === '2,0,1.5,0,2,1.5,2' && pick('1/instr') === '1,0,0,0,0,5,1' && !wb.has('2/instr') && wb.max === 7,
    'mini: waits per instruction (queue, delay, operands, port, execute, retire; the eliminated xor only waits to retire; the unretired dec is left out)', JSON.stringify([...wb]));
  const wb1 = waitBreakdown(buildModel(trace, { issueDispatchDelay: 1 }), 0, 0);
  check(wb1.get('0/instr').delay === 1 && wb1.get('0/instr').operands === 0.5, 'mini: the issue → dispatch delay is its own part', JSON.stringify(wb1.get('0/instr')));
  check(waitText(wb.get('1/instr')) === 'queue 1.0 · delay 0.0 · operands 0.0 · port 0.0 · execute 0.0 · retire 5.0', 'mini: the text', waitText(wb.get('1/instr')));
  check(uopWaits({ ...m.uops[0], idq: null }, 0).queue === null && uopWaits(m.uops[4], 0) === null, 'mini: no front-end event: the queue is unknown; an unfinished uop has none');
  check(roundStart(m, 0) === 2 && roundStart(m, 5) === null && roundEnds(m, 0, 0).size === 0, 'mini: the start of a round; a round that did not retire has no end');
}

// --- 2. the reference's traces ----------------------------------------------------------------------------------------
function rawEvents(trace) { // the number of distinct units per level, straight from the JSON
  const lam = new Set(), fused = new Set(), un = new Set();
  let dispatched = 0;
  for (const cy of trace.cycles) {
    for (const k of ['addedToIDQ']) for (const r of cy[k] ?? []) lam.add(`${r.rnd}/${r.instrID}/${r.lamUopID}`);
    for (const k of ['removedFromIDQ', 'addedToRB', 'removedFromRB']) for (const r of cy[k] ?? []) { lam.add(`${r.rnd}/${r.instrID}/${r.lamUopID}`); fused.add(`${r.rnd}/${r.instrID}/${r.lamUopID}/${r.fUopID}`); }
    const unf = [...(cy.addedToRS ?? []), ...(cy.readyForDispatch ?? []), ...Object.values(cy.dispatched ?? {}), ...(cy.executed ?? [])];
    dispatched += Object.keys(cy.dispatched ?? {}).length;
    for (const r of unf) { lam.add(`${r.rnd}/${r.instrID}/${r.lamUopID}`); fused.add(`${r.rnd}/${r.instrID}/${r.lamUopID}/${r.fUopID}`); un.add(`${r.rnd}/${r.instrID}/${r.lamUopID}/${r.fUopID}/${r.uopID}`); }
  }
  return { lam, fused, un, dispatched };
}

const sets = ['sim_fixtures', 'extra_sim_fixtures'].filter((s) => fs.existsSync(new URL(`fixtures/generated/${s}.jsonl.gz`, root)));
if (sets.length === 0) console.log('fixtures/generated is missing: the reference traces are skipped');
let waitN = 0, waitBad = 0;
const waitBadEx = [];
let cases = 0, tpFar = 0, tpSame = 0, tpWide = 0, tpWideSame = 0, kinds = new Set(), order = 0, orderBad = [], maxMs = 0;
const tpDiff = [];
let ii = 0;
for (const set of sets) {
  const rl = readline.createInterface({ input: fs.createReadStream(new URL(`fixtures/generated/${set}.jsonl.gz`, root)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (ii++ % every) continue;
    const c = JSON.parse(line);
    let trace = c.json;
    if (!trace) continue;
    if (typeof trace === 'string') trace = JSON.parse(trace);
    cases++;
    const t0 = performance.now();
    const m = buildModel(trace);
    maxMs = Math.max(maxMs, performance.now() - t0);
    const raw = rawEvents(trace);
    // every unit of the JSON is in the model: unfused uops are rows; fused uops without unfused uops and laminated
    // uops without fused uops are rows too
    const fusedWithRows = new Set([...raw.un].map((k) => k.slice(0, k.lastIndexOf('/'))));
    const lamWithFused = new Set([...raw.fused].map((k) => k.slice(0, k.lastIndexOf('/'))));
    const expectRows = raw.un.size + [...raw.fused].filter((k) => !fusedWithRows.has(k)).length + [...raw.lam].filter((k) => !lamWithFused.has(k)).length;
    if (m.uops.length !== expectRows) check(false, `${c.file}/${c.arch}: rows`, `${m.uops.length} != ${expectRows}`);
    const used = m.ports.reduce((a, p) => a + p.used, 0);
    if (used !== raw.dispatched) check(false, `${c.file}/${c.arch}: dispatches`, `${used} != ${raw.dispatched}`);
    for (const u of m.uops) {
      // the waits of a finished uop add up to retired − (IDQ or predecode), or to retired − issued without those
      const w = uopWaits(u, m.issueDispatchDelay);
      if (w) {
        const sum = w.delay + w.operands + w.port + w.exec + w.retire;
        const fe = u.idq ?? u.iq;
        if (sum !== u.retired - u.issued || (w.queue !== null && w.queue + sum !== u.retired - fe) || (fe === null) !== (w.queue === null)) { waitBad++; if (waitBadEx.length < 3) waitBadEx.push(`${c.file}/${c.arch} ${u.key} ${JSON.stringify(w)}`); }
        waitN++;
      }
      kinds.add(u.kind);
      if (u.deps.length !== u.depKeys.length) check(false, `${c.file}/${c.arch}: a dependency does not resolve`, u.key);
      // the stages are in order
      const seq = ['iq', 'idq', 'issued', 'ready', 'dispatched', 'executed', 'retired'].map((f) => u[f]).filter((x) => x !== null);
      order++;
      if (seq.some((x, k) => k > 0 && x < seq[k - 1])) { if (orderBad.length < 3) orderBad.push(`${c.file}/${c.arch} ${u.key} ${JSON.stringify(seq)}`); }
      if (u.dispatched !== null && (u.port === null || (u.executed !== null && u.executed <= u.dispatched))) check(false, `${c.file}/${c.arch}: dispatch`, u.key);
      if (u.retired !== null && u.executed !== null && u.retired <= u.executed) check(false, `${c.file}/${c.arch}: retired after executed`, u.key);
    }
    const rr = relevantRounds(m);
    // (relative for very slow loops: e.g. x_zmm_mask on ADL-P, about 14,500 cycles per iteration in 10 rounds, where the
    // steady-state rounds of the trace give 14531.67 and uiCA 14531.5)
    if (rr.tp === null || Math.abs(rr.tp - c.TP) > Math.max(0.0201, 1e-4 * c.TP)) tpFar++;
    if (rr.tp === c.TP) tpSame++; else if (tpDiff.length < 5) tpDiff.push(`${c.file}/${c.arch} ${rr.tp} vs ${c.TP} (rounds ${rr.first}-${rr.last} of ${rr.n})`);
    if (rr.last - rr.first >= 5) { tpWide++; if (rr.tp === c.TP) tpWideSame++; }
    const ch = rangeChoices(m);
    if (!(ch[0].id === 'steady' && ch[0].from === rr.first && ch[0].to - ch[0].from <= 2 && ch.at(-1).id === 'all' && ch.at(-1).from === 0)) check(false, `${c.file}/${c.arch}: range choices`, JSON.stringify(ch));
    const rows = selectRows(m, ch[0].from, ch[0].to);
    if (!(rows.length > 0 && Array.from(rows).every((i) => m.uops[i].rnd >= ch[0].from && m.uops[i].rnd <= ch[0].to))) check(false, `${c.file}/${c.arch}: rows of the default range`);
  }
}
if (cases) {
  check(orderBad.length === 0, `reference traces: the stages of every uop are in order (${order} uops)`, orderBad.join('\n'));
  check(kinds.has('stackSync') && kinds.has('instr'), 'reference traces: stack-sync uops are recognized', [...kinds].join());
  check(waitN > 1000 && waitBad === 0, `reference traces: the waits of every finished uop add up to its time from the IDQ to retirement (${waitN} uops)`, waitBadEx.join('\n'));
  // The trace ends one cycle before uiCA's simulation does, so the last round can be one short; nearly all agree.
  check(tpSame / cases >= 0.99 && tpFar === 0, `reference traces: the steady-state rounds give uiCA's throughput (${tpSame}/${cases} equal, ${tpFar} off by more than 0.02 or 0.01 %)`, tpDiff.join('\n'));
  console.log(`${cases} reference traces (every ${every}th): throughput from the steady-state rounds equals uiCA's in ${tpSame} (${tpWideSame}/${tpWide} with ≥5 rounds); slowest model ${maxMs.toFixed(1)} ms`);
  if (tpDiff.length) console.log('  differ, e.g.: ' + tpDiff.slice(0, 3).join('; '));
}

// --- 3. the real module ----------------------------------------------------------------------------------------------------
const wasmPath = process.argv[3] || new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (fs.existsSync(wasmPath) && fs.existsSync(new URL('data/uarch.json', root))) {
  const { WasmEngine, makeRequest } = await import('../web/js/engine.js');
  const e = await WasmEngine.create(fs.readFileSync(wasmPath));
  const uarch = fs.readFileSync(new URL('data/uarch.json', root));
  await e.loadUarch(uarch);
  const configs = JSON.parse(new TextDecoder().decode(uarch)).configs;
  // 48 instructions of 12 kinds (loads, stores, eliminated moves, push/pop, AVX) and a fused dec/jnz
  const pat = ['4801d8', '480fafca', 'c5f458c2', '488b16', '488907', '4531c0', '4d89d1', '50', '59', '90', '4883c001', 'c5fc59c8'];
  let body = '';
  for (let i = 0; i < 48; i++) body += pat[i % pat.length];
  body += '49ffcf';
  const rel = (0x100000000 - (body.length / 2 + 6)).toString(16).padStart(8, '0').match(/../g).reverse().join('');
  const hex = body + '0f85' + rel;
  // the LSD (Haswell): its uops have no IDQ (or predecode) event, so their queue time is unknown, not 0
  {
    await e.loadArch(configs.HSW.name, tableBytes(configs.HSW.name));
    const r = await e.analyze(makeRequest('f3480fb80cc74801ca48ffc04839f072ef', 'HSW', { includeTrace: true })); // popcnt loop
    const m = buildModel(r.trace, { issueDispatchDelay: configs.HSW.issueDispatchDelay, retireWidth: configs.HSW.retireWidth });
    const wb = waitBreakdown(m);
    check(m.uops.every((u) => u.idq === null && u.iq === null) && wb.size > 0 && [...wb.values()].every((w) => w.queue === null && w.nq === 0 && w.total > 0), 'HSW (LSD): the queue wait is unknown; the other parts are there', JSON.stringify([...wb]));
  }
  for (const arch of ['SKL', 'ZEN3']) {
    await e.loadArch(configs[arch].name, tableBytes(configs[arch].name));
    const r = await e.analyze(makeRequest(hex, arch, { includeTrace: true }));
    check(!r.error && r.trace && r.trace.instructions.length === 50, `${arch}: the analyzer returns a trace with includeTrace`, r.error);
    if (!r.trace) continue;
    const t0 = performance.now();
    const m = buildModel(r.trace, { portNames: configs[arch].portNames ?? null, retireWidth: configs[arch].retireWidth });
    const ms = performance.now() - t0;
    check(m.relevant.tp === r.tp, `${arch}: the steady-state rounds give the response's throughput`, `${m.relevant.tp} vs ${r.tp}`);
    const all = selectRows(m, 0, m.nRounds - 1);
    check(all.length > 500 && m.labels[48].startsWith('dec r15 + jnz 0x'), `${arch}: rows and labels`, `${all.length} ${m.labels[48]}`);
    if (arch === 'ZEN3') check(m.ports.some((p) => p.name === 'ALU0') && m.ports.every((p) => !p.name.startsWith('Port ')), 'ZEN3: port names from uarch.json');
    // the rows of the response are the trace's instructions (same text), and every uop has its row
    const groups = rowGroups(r.rows);
    const labelOk = r.rows.every((x, i) => x.kind !== 'instr' || groups[i].fused || m.instructions[groups[i].instrID].asm === x.label);
    check(labelOk && m.uops.every((u) => rowOfGroup(groups, u) >= 0) && groups.filter((x) => x.fused).length === 1, `${arch}: every row is its instruction in the trace; every uop has a row`);
    const wb = waitBreakdown(m);
    check(wb.size > 40 && [...wb.values()].every((w) => w.n > 0 && w.total > 0 && w.queue !== null) && wb.from === m.relevant.first, `${arch}: the waits of every instruction`);
    const w2 = abWindow(m, m, { choice: 'steady' });
    check(w2.a.from === m.relevant.first && w2.a.to === w2.a.from + 2 && w2.a.origin === w2.b.origin && w2.lo <= 0 && w2.hi > 0, `${arch}: an A–B window of a block with itself`, JSON.stringify(w2));
    const w3 = abWindow(m, m, { choice: 'steady', scale: 2 });
    check(w3.b.from === Math.floor(w3.a.from / 2) && w3.b.to === w3.b.from + 1, `${arch}: B unrolled ×2: half the iterations from half the index`, JSON.stringify(w3));
    // A does more per iteration than B (B 1/2: twice the iterations), and a ratio that is not whole (B 3/2 of A)
    const w4 = abWindow(m, m, { choice: 'steady', scale: 0.5 });
    check(w4.a.to - w4.a.from === 2 && w4.b.from === Math.min(Math.floor(w4.a.from / 0.5), m.nRounds - 1) && w4.b.to - w4.b.from + 1 === Math.min(6, m.nRounds - w4.b.from), `${arch}: A does twice B's work: B shows twice the iterations`, JSON.stringify(w4));
    const w5 = abWindow(m, m, { choice: 'steady', scale: 1.5 });
    check(w5.b.from === Math.floor(w5.a.from / 1.5) && w5.b.to - w5.b.from + 1 === 2, `${arch}: B does 1.5 of A's work: 3 of A over 2 of B`, JSON.stringify(w5));
    console.log(`${arch} 50-instruction loop: trace ${(JSON.stringify(r.trace).length / 1024).toFixed(0)} KiB, ${r.trace.cycles.length} cycles, ${m.uops.length} uops; model ${ms.toFixed(1)} ms`);
  }
} else {
  console.log('the analyzer is not built: the real-module part is skipped');
}

void STAGES;
console.log(`${count} trace checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
