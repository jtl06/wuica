// The cycle-by-cycle trace view: a timeline of every uop (rows) over the cycles (x), with the port usage above
// it, a tooltip per uop and a plain table of the same events. Self-contained: app.js creates one panel
// (createTracePanel) and passes its element to the result view; the panel asks for the trace (an analysis with
// "includeTrace": true, docs/WASM-API.md) only when it is opened.
//
// The first half of the file has no DOM (buildModel and the functions after it; tests-js/web_trace.mjs runs it
// under Node). The data is uiCA's -json output: {parameters, instructions, cycles: [{cycle, addedToIQ, ...}]}.
// Events come at four granularities, and every row (an unfused uop) gets the events of the units it belongs to:
//   instruction instance  addedToIQ / removedFromIQ  {rnd, instr}
//   laminated uop         addedToIDQ                 {rnd, instrID, lamUopID, source}
//   fused uop             removedFromIDQ, addedToRB (issued), removedFromRB (retired)   + fUopID
//   unfused uop           addedToRS (+ dependsOn), readyForDispatch, dispatched {PortX: uop}, executed   + uopID
// lamUopID counts the register-merge uops, then the stack-sync uops (flags regMergeUop / stackSyncUop), then the
// instruction's own uops. Every stage can be missing: eliminated uops (zero idioms, moves, nops) are executed
// when they are issued and never enter the scheduler; the LSD issues without an IDQ entry; the last rounds are
// cut off by the end of the simulation.

import { ISSUE_H, issueLog, issueShare, drawIssueStrip, issueText } from './trace-issue.js'; // the issue strip (details)
import { attachRange } from './trace-range-view.js'; // a cycle range for the bound view (viewer.ext: its hooks)
import { setCopy, waitCopy } from './copy-view.js';
import { traceRange } from './markdown.js';

// ---- the model (no DOM) ----------------------------------------------------------------------------------------

const lamKey = (r) => `${r.rnd}/${r.instrID}/${r.lamUopID}`;
const fusedKey = (r) => `${r.rnd}/${r.instrID}/${r.lamUopID}/${r.fUopID}`;
export const uopKey = (r) => `${r.rnd}/${r.instrID}/${r.lamUopID}/${r.fUopID ?? '-'}/${r.uopID ?? '-'}`;

// The stages of a uop, in order: [field, name in the table and tooltip].
export const STAGES = Object.freeze([
  ['iq', 'predecoded'], ['idq', 'IDQ'], ['issued', 'issued'], ['ready', 'ready'],
  ['dispatched', 'dispatched'], ['executed', 'executed'], ['retired', 'retired'],
]);

function list(v) { return Array.isArray(v) ? v : []; }

// trace: the `trace` of a response; portNames, retireWidth, issueDispatchDelay: from configs[arch] of uarch.json
// (Zen 3 names its ports by letters), or null. A uop is ready issueDispatchDelay cycles after its issue at the
// earliest (uiCA's Scheduler); only what goes beyond that is waiting.
export function buildModel(trace, { portNames = null, retireWidth = null, issueDispatchDelay = null } = {}) {
  if (!trace || !Array.isArray(trace.cycles) || !Array.isArray(trace.instructions)) throw new Error('not a trace');
  const params = trace.parameters ?? {};
  const instructions = trace.instructions;
  const nInstr = instructions.length;

  // labels: a macro-fused branch has no uops of its own; it is shown with the instruction it is fused with
  const labels = instructions.map((x, i) => {
    let s = String(x.asm ?? `instruction ${i}`);
    if (x.macroFusedWithNextInstr && instructions[i + 1]) s += ` + ${instructions[i + 1].asm}`;
    return s;
  });

  const iq = new Map(), lams = new Map(), fused = new Map(), unfused = new Map();
  const obj = (m, k, init) => { let o = m.get(k); if (!o) { o = init(); m.set(k, o); } return o; };
  const lamOf = (r) => obj(lams, lamKey(r), () => ({ rnd: r.rnd, instrID: r.instrID, lamUopID: r.lamUopID, kind: r.regMergeUop ? 'regMerge' : r.stackSyncUop ? 'stackSync' : 'instr', idq: null, source: null }));
  const fusedOf = (r) => { lamOf(r); return obj(fused, fusedKey(r), () => ({ ...r, issued: null, retired: null, retireIdx: null, idqOut: null, n: 0 })); };
  const uopOf = (r) => { fusedOf(r); return obj(unfused, uopKey(r), () => ({ rs: null, ready: null, dispatched: null, port: null, executed: null, deps: [] })); };

  const nCycles = trace.cycles.length;
  const portIds = Array.isArray(params.allPorts) ? params.allPorts.map(String) : [];
  const portIndex = new Map(portIds.map((p, i) => [p, i]));
  const dispatchedAt = []; // per port: Int32Array(nCycles), the uop's key until resolved, -1 if none
  const portKeys = [];
  for (const cy of trace.cycles) {
    const c = cy.cycle;
    for (const r of list(cy.addedToIQ)) obj(iq, `${r.rnd}/${r.instr}`, () => ({ in: null, out: null })).in = c;
    for (const r of list(cy.removedFromIQ)) obj(iq, `${r.rnd}/${r.instr}`, () => ({ in: null, out: null })).out = c;
    for (const r of list(cy.addedToIDQ)) { const l = lamOf(r); l.idq = c; l.source = r.source ?? null; }
    for (const r of list(cy.removedFromIDQ)) fusedOf(r).idqOut = c;
    for (const r of list(cy.addedToRB)) fusedOf(r).issued = c;
    list(cy.removedFromRB).forEach((r, i) => { const f = fusedOf(r); f.retired = c; f.retireIdx = i; });
    for (const r of list(cy.addedToRS)) { const u = uopOf(r); u.rs = c; u.deps = list(r.dependsOn).map(uopKey); }
    for (const r of list(cy.readyForDispatch)) uopOf(r).ready = c;
    for (const [name, r] of Object.entries(cy.dispatched ?? {})) {
      const p = name.startsWith('Port') ? name.slice(4) : name;
      const u = uopOf(r); u.dispatched = c; u.port = p;
      if (!portIndex.has(p)) { portIndex.set(p, portIds.length); portIds.push(p); }
      portKeys.push([portIndex.get(p), c, uopKey(r)]);
    }
    for (const r of list(cy.executed)) uopOf(r).executed = c;
  }

  // the rows: every unfused uop; a fused uop without unfused uops, and a laminated uop that was never issued,
  // get a row of their own
  const rowsOfFused = new Map();
  for (const k of unfused.keys()) {
    const fk = k.slice(0, k.lastIndexOf('/'));
    obj(rowsOfFused, fk, () => []).push(k);
  }
  const fusedOfLam = new Map();
  for (const [fk, f] of fused) obj(fusedOfLam, lamKey(f), () => []).push(fk);

  const uops = [];
  const push = (lam, f, u, key) => {
    const ii = iq.get(`${lam.rnd}/${lam.instrID}`);
    uops.push({
      key, rnd: lam.rnd, instrID: lam.instrID, lamUopID: lam.lamUopID, fUopID: f ? f.fUopID : null, uopID: u ? Number(key.slice(key.lastIndexOf('/') + 1)) : null,
      kind: lam.kind, source: lam.source,
      iq: lam.kind === 'instr' && ii ? ii.in : null,
      idq: lam.idq, issued: f ? f.issued : null, retired: f ? f.retired : null, retireIdx: f ? f.retireIdx : null,
      ready: u ? u.ready : null, dispatched: u ? u.dispatched : null, port: u ? u.port : null, executed: u ? u.executed : null,
      inRS: !!(u && u.rs !== null), depKeys: u ? u.deps : [],
      deps: [], users: [], n: 0, of: 0,
    });
  };
  for (const lam of lams.values()) {
    const fks = fusedOfLam.get(lamKey(lam));
    if (!fks) { push(lam, null, null, `${lamKey(lam)}/-/-`); continue; }
    for (const fk of fks) {
      const f = fused.get(fk);
      const ks = rowsOfFused.get(fk);
      if (!ks) { push(lam, f, null, `${fk}/-`); continue; }
      for (const k of ks) push(lam, f, unfused.get(k), k);
    }
  }
  const num = (v) => (v === null ? -1 : v);
  uops.sort((a, b) => a.rnd - b.rnd || a.instrID - b.instrID || a.lamUopID - b.lamUopID || num(a.fUopID) - num(b.fUopID) || num(a.uopID) - num(b.uopID));
  const index = new Map(uops.map((u, i) => [u.key, i]));
  for (let i = 0; i < uops.length; i++) {
    const u = uops[i];
    u.deps = u.depKeys.map((k) => index.get(k) ?? -1).filter((j) => j >= 0);
    for (const j of u.deps) uops[j].users.push(i);
  }
  // uop n of m within its group (an instruction instance's own uops, or its merge / sync uops)
  for (let i = 0; i < uops.length;) {
    let j = i;
    const same = (a, b) => a.rnd === b.rnd && a.instrID === b.instrID && a.kind === b.kind;
    while (j < uops.length && same(uops[j], uops[i])) j++;
    for (let k = i; k < j; k++) { uops[k].n = k - i + 1; uops[k].of = j - i; }
    i = j;
  }

  // dispatches per port and cycle (the uop index, -1 for none), and prefix sums for the zoomed-out strips
  for (let p = 0; p < portIds.length; p++) dispatchedAt.push(new Int32Array(nCycles).fill(-1));
  for (const [p, c, k] of portKeys) if (c >= 0 && c < nCycles) dispatchedAt[p][c] = index.get(k) ?? -1;
  const prefix = dispatchedAt.map((a) => {
    const s = new Int32Array(nCycles + 1);
    for (let c = 0; c < nCycles; c++) s[c + 1] = s[c] + (a[c] >= 0 ? 1 : 0);
    return s;
  });
  const ports = portIds.map((id, i) => ({ id, name: portNames?.[id] ?? `Port ${id}`, short: portNames?.[id] ?? id, used: prefix[i][nCycles] }));

  let nRounds = 0;
  for (const u of uops) nRounds = Math.max(nRounds, u.rnd + 1);
  const model = { params, instructions, labels, uops, index, ports, dispatchedAt, prefix, nCycles, nRounds, nInstr,
    retireWidth: retireWidth ?? ((params.issueWidth ?? 4) > 4 ? 8 : 4), issueDispatchDelay: issueDispatchDelay ?? 0 };
  model.relevant = relevantRounds(model);
  return model;
}

// The rounds uiCA computes the throughput from (uiCA.py, after the simulation loop): the rounds are counted by
// the retired fused uops that have unfused uops; the last round may be incomplete; the first half is warm-up.
// The trace ends one cycle before the simulation (uiCA writes it up to clock - 1), so what retired in that last
// cycle is inferred: the oldest fused uops whose unfused uops have all executed retire then, up to the retire
// width (as in ReorderBuffer.retireUops).
export function relevantRounds(model) {
  const { uops, instructions } = model;
  let n = 0;
  for (const u of uops) if (u.retired !== null && u.uopID !== null) n = Math.max(n, u.rnd + 1);
  const head = []; // the oldest fused uops still in the reorder buffer at the end of the trace
  for (const u of uops) {
    if (u.issued === null) break; // issue is in order: nothing after this is in the buffer
    if (u.retired !== null) continue;
    const f = `${u.rnd}/${u.instrID}/${u.lamUopID}/${u.fUopID}`;
    if (head.at(-1)?.f !== f) { if (head.length === model.retireWidth) break; head.push({ f, u, done: true, unfused: false }); }
    if (u.uopID !== null) { head.at(-1).unfused = true; if (u.executed === null) head.at(-1).done = false; }
  }
  const late = []; // what retires in the cycle after the trace: {uop, retired, retireIdx}
  for (const g of head) { if (!g.done) break; late.push({ ...g.u, retired: model.nCycles, retireIdx: late.length }); if (g.unfused) n = Math.max(n, g.u.rnd + 1); }
  let last = Math.max(0, n - 2);
  const first = Math.min(last, Math.floor(n / 2));
  // the last instruction that is decoded (not the macro-fused branch)
  let lastInstr = instructions.length - 1;
  if (lastInstr > 0 && instructions[lastInstr - 1].macroFusedWithNextInstr) lastInstr--;
  const lastFused = new Map(); // round -> its last retired fused uop of lastInstr (with unfused uops)
  for (const u of [...uops, ...late]) {
    if (u.instrID !== lastInstr || u.retired === null || u.uopID === null || u.kind !== 'instr') continue;
    const prev = lastFused.get(u.rnd);
    if (!prev || u.lamUopID > prev.lamUopID || (u.lamUopID === prev.lamUopID && u.fUopID >= prev.fUopID)) lastFused.set(u.rnd, u);
  }
  if (last - first > 10) {
    for (let r = last; r > last - 5; r--) {
      if (lastFused.get(first)?.retireIdx === lastFused.get(r)?.retireIdx) { last = r; break; }
    }
  }
  let tp = null;
  const a = lastFused.get(first), b = lastFused.get(last);
  if (a && b) tp = first === last ? b.retired : pyRound2((b.retired - a.retired) / (last - first));
  return { first, last, n, tp };
}

// Python's round(x, 2): ties go to the even neighbour (uiCA prints round((a - b) / n, 2)).
function pyRound2(x) {
  const s = x * 100, f = Math.floor(s);
  if (s - f === 0.5) return (f % 2 === 0 ? f : f + 1) / 100;
  return Math.round(s) / 100;
}

const its = (a, b) => (a === b ? `iteration ${a}` : `iterations ${a}–${b}`);
// The steady state's iterations, as the range menu and the legend both say them (one text for both)
export function steadyText(model) { return its(model.relevant.first, model.relevant.last); }
// The legend's note: what the steady state is (hiddenPorts: ports without uops, not drawn)
export function aboutText(model, hiddenPorts = 0) {
  const { tp } = model.relevant;
  return `Steady state (what the throughput is computed from): ${steadyText(model)}` + (tp !== null ? `, ${tp} cycles per iteration` : '') + '.'
    + (hiddenPorts ? ` ${hiddenPorts} port${hiddenPorts === 1 ? '' : 's'} without uops not shown.` : '');
}

// The range menu: [{id, label, from, to}]; the first entry is the default (a few iterations of the steady state: said
// as a part of it when the steady state is longer, so that the menu and the legend name one range for it).
export function rangeChoices(model, few = 3) {
  const { first, last } = model.relevant;
  const out = [];
  const to = Math.min(model.nRounds - 1, first + few - 1);
  out.push({ id: 'steady', label: `steady state: ${its(first, to)}${last > to ? ` of ${first}–${last}` : ''}`, from: first, to });
  if (last > to) out.push({ id: 'relevant', label: `all steady-state: ${steadyText(model)}`, from: first, to: last });
  out.push({ id: 'all', label: `all: ${its(0, Math.max(0, model.nRounds - 1))}`, from: 0, to: Math.max(0, model.nRounds - 1) });
  return out;
}

// The uops of the rounds from..to (indices into model.uops, in order).
export function selectRows(model, from, to) {
  const out = [];
  model.uops.forEach((u, i) => { if (u.rnd >= from && u.rnd <= to) out.push(i); });
  return Int32Array.from(out);
}

// The cycles the rows span: [first, last] (inclusive), from the first issue to the last retirement. The front
// end usually runs far ahead (uops wait in the IDQ for a long time when the back end is the bottleneck): that wait
// is drawn from the left edge, it does not stretch the range. A row that was never issued counts with its first
// event.
export function cycleSpan(model, rows) {
  let lo = Infinity, hi = -Infinity;
  for (const i of rows) {
    const u = model.uops[i];
    const start = u.issued ?? u.idq ?? u.iq;
    if (start !== null && start < lo) lo = start;
    for (const [f] of STAGES) { const c = u[f]; if (c !== null && c > hi) hi = c; }
  }
  if (lo === Infinity) return [0, Math.max(0, model.nCycles - 1)];
  return [Math.max(0, lo - 1), Math.min(model.nCycles - 1, hi + 1)];
}

// The time a row shows from when its wait for operands is shortened (waits 'short'): STUB_C cycles of it, and room for
// its length written left of it.
export const STUB_C = 3;
const shortened = (u, delay, waits) => {
  if (waits === 'full' || u.issued === null) return false;
  const ready = u.ready ?? u.dispatched;
  if (ready === null) return false;
  return ready - Math.min(ready, u.issued + (delay ?? 0)) > STUB_C;
};
// The cycles the rows span as drawn: as cycleSpan, but a row whose wait for operands is shortened starts just before it
// is ready (its issue and front end, far to the left, are not drawn): the cycles where the uops run fill the width.
export function shownSpan(model, rows, waits = 'short') {
  if (waits === 'full') return cycleSpan(model, rows);
  let lo = Infinity, hi = -Infinity;
  for (const i of rows) {
    const u = model.uops[i];
    const start = shortened(u, model.issueDispatchDelay, waits) ? (u.ready ?? u.dispatched) - 3 * STUB_C : (u.issued ?? u.idq ?? u.iq);
    if (start !== null && start < lo) lo = start;
    for (const [f] of STAGES) { const c = u[f]; if (c !== null && c > hi) hi = c; }
  }
  if (lo === Infinity) return [0, Math.max(0, model.nCycles - 1)];
  return [Math.max(0, lo - 1), Math.min(model.nCycles - 1, hi + 1)];
}

// A port's group: "P" for Intel's numbered ports, the name without its number otherwise (ALU0 -> ALU, (SA1) -> SA)
export function portGroupName(name) {
  if (/^Port \w+$/.test(name)) return 'P';
  return /^\(?([A-Za-z]+)\d*\)?$/.exec(String(name))?.[1] ?? String(name);
}
// The groups of the ports (used ones), each with the prefix sums of its busy ports per cycle: [{name, ports, pre}]
export function portGroups(model, ports) {
  const by = new Map();
  for (const p of ports) { const g = portGroupName(p.name); (by.get(g) ?? by.set(g, []).get(g)).push(p); }
  return [...by].map(([name, ps]) => {
    const pre = new Int32Array(model.nCycles + 1);
    for (let c = 0; c < model.nCycles; c++) { let n = 0; for (const p of ps) if (model.dispatchedAt[p.i][c] >= 0) n++; pre[c + 1] = pre[c] + n; }
    return { name, short: name, ports: ps, pre };
  });
}

// The labels of the instructions as the uop table shows them (branch targets as labels: branch-label.js; the analyzer
// writes a branch's target as if it were at address 0). rows: the response's rows; shown: the label shown for each row
// or null (the view's `shown`). The analyzer's own labels stay in model.asmLabels. Does nothing if the rows do not
// match the trace's instructions one to one.
export function applyShownLabels(model, rows, shown) {
  if (!model || !Array.isArray(rows) || !Array.isArray(shown)) return;
  const names = rows.flatMap((r, i) => (r?.kind === 'instr' ? [shown[i] ?? null] : []));
  const ins = model.instructions;
  if (names.length !== ins.length || names.every((x) => x === null)) return;
  model.asmLabels ??= model.labels;
  model.labels = ins.map((x, i) => {
    let s = names[i] ?? String(x.asm ?? `instruction ${i}`);
    if (x.macroFusedWithNextInstr && ins[i + 1]) s += ` + ${names[i + 1] ?? ins[i + 1].asm}`;
    return s;
  });
}

// Two traces in their windows are the same: the same uops with the same events, relative to each window's origin
// (the instructions compared as the analyzer wrote them: the two sides' texts can name their labels differently)
export function sameTrace(ma, wa, mb, wb) {
  const ra = selectRows(ma, wa.from, wa.to), rb = selectRows(mb, wb.from, wb.to);
  const la = ma.asmLabels ?? ma.labels, lb = mb.asmLabels ?? mb.labels;
  if (ra.length !== rb.length || la.length !== lb.length || la.some((l, k) => l !== lb[k])) return false;
  for (let k = 0; k < ra.length; k++) {
    const a = ma.uops[ra[k]], b = mb.uops[rb[k]];
    if (a.instrID !== b.instrID || a.n !== b.n || a.kind !== b.kind || a.port !== b.port) return false;
    for (const [f] of STAGES) if ((a[f] === null) !== (b[f] === null) || (a[f] !== null && a[f] - wa.origin !== b[f] - wb.origin)) return false;
  }
  return true;
}

export function uopLabel(model, i) {
  const u = model.uops[i];
  const base = u.kind === 'regMerge' ? 'register merge uop' : u.kind === 'stackSync' ? 'stack sync uop' : model.labels[u.instrID];
  return u.of > 1 ? `${base} (uop ${u.n}/${u.of})` : base;
}

export function portName(model, id) {
  return id === null ? null : (model.ports.find((p) => p.id === id)?.name ?? `Port ${id}`);
}

// What the tooltip and the table show for a uop.
export function uopDetails(model, i, shown = null) {
  const u = model.uops[i];
  const stages = STAGES.map(([f, name]) => ({ field: f, name, cycle: u[f] }));
  const deps = u.deps.map((j) => {
    const d = model.uops[j];
    return { index: j, label: uopLabel(model, j), rnd: d.rnd, executed: d.executed, shown: shown ? shown.has(j) : true };
  });
  const eliminated = !u.inRS && u.dispatched === null && u.executed !== null && u.executed === u.issued;
  return {
    key: u.key, label: uopLabel(model, i), instruction: model.labels[u.instrID], kind: u.kind, rnd: u.rnd,
    port: u.port, portName: portName(model, u.port), source: u.source, stages, deps, eliminated,
    waitOperands: u.ready !== null && u.issued !== null ? Math.max(0, u.ready - u.issued - model.issueDispatchDelay) : null,
    issueDispatchDelay: model.issueDispatchDelay,
    waitPort: u.dispatched !== null && u.ready !== null ? u.dispatched - u.ready : null,
    users: u.users.length,
  };
}

export const TABLE_HEAD = Object.freeze(['iteration', 'instruction', 'port', ...STAGES.map((s) => s[1]), 'waited for']);

// The rows of the plain table (strings; empty for a stage that did not happen).
export function tableRows(model, rows) {
  const out = [];
  for (const i of rows) {
    const u = model.uops[i];
    const dep = u.deps.map((j) => `${uopLabel(model, j)} [it ${model.uops[j].rnd}]`).join('; ');
    out.push([String(u.rnd), uopLabel(model, i), portName(model, u.port) ?? (u.executed !== null && !u.inRS ? 'none (eliminated)' : ''),
      ...STAGES.map(([f]) => (u[f] === null ? '' : String(u[f]))), dep]);
  }
  return out;
}

// The copy control of the trace tab (copy-view.js): the shown rows of the viewers (A–B: A's, then B's) as tables
const csvOf = (head, rows) => [head, ...rows].map((r) => r.map((c) => (/[",\n\r]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\r\n') + '\r\n';
function copyTrace(viewers) {
  const live = viewers.filter(Boolean);
  if (!live.length) { setCopy('trace', null); return; }
  const cap = (v) => `${v.tag ? `${v.tag}: ` : ''}${v.rows.length} uops, cycles ${v.c0}–${v.c1}`;
  setCopy('trace', {
    what: 'the trace (the shown rows)',
    md: () => live.map((v) => traceRange([...TABLE_HEAD], tableRows(v.model, v.rows), cap(v))).join('\n'),
    csv: () => live.map((v) => csvOf(TABLE_HEAD, tableRows(v.model, v.rows))).join('\r\n'),
  });
}

export function toTSV(model, rows) {
  const clean = (s) => String(s).replace(/[\t\n]/g, ' ');
  return [TABLE_HEAD, ...tableRows(model, rows)].map((r) => r.map(clean).join('\t')).join('\n') + '\n';
}

// ---- the uop table and the trace (no DOM) ----------------------------------------------------------------------
// The rows of the uop table (response.rows) are in program order: the register-merge and stack-sync rows come before
// the instruction they belong to (their uops carry that instruction's instrID and their own kind); the second
// instruction of a macro-fused pair has a row but no uops of its own (they are the first one's).

// Per table row: {instrID, kind, fused}; `fused`: the second of a macro-fused pair (its uops: the row before).
export function rowGroups(rows) {
  const out = [];
  let k = 0; // the instruction's index among the rows of kind "instr" = its instrID in the trace
  for (const x of Array.isArray(rows) ? rows : []) {
    if (x?.kind === 'instr') {
      out.push(x.notes === 'M' && k > 0 ? { instrID: k - 1, kind: 'instr', fused: true } : { instrID: k, kind: 'instr', fused: false });
      k++;
    } else {
      out.push({ instrID: k, kind: x?.kind === 'regMerge' || x?.kind === 'stackSync' ? x.kind : 'instr', fused: false });
    }
  }
  return out;
}
export const groupKey = (g) => (g ? `${g.instrID}/${g.kind}` : null);
export const groupOfUop = (u) => ({ instrID: u.instrID, kind: u.kind, fused: false });
// the table row of a group (not the fused second instruction), or -1
export function rowOfGroup(groups, g) {
  const k = groupKey(g);
  if (k === null) return -1;
  for (let i = 0; i < groups.length; i++) if (!groups[i].fused && groupKey(groups[i]) === k) return i;
  return -1;
}

// Where the uops of each instruction spent their time, in cycles per uop, averaged over the uops of the rounds
// from..to that have all their stages (issued and retired within the trace). The parts are the bars of the timeline
// (drawUop), so they add up to retired − (IDQ or predecode):
//   queue     in the IDQ until issued (front end → issue); unknown when the trace has neither event (the LSD)
//   delay     the fixed issue → dispatch delay of the scheduler (issueDispatchDelay)
//   operands  beyond that, not ready: waiting for operands
//   port      ready, waiting for a port
//   exec      dispatched → executed
//   retire    executed, waiting to retire
// Eliminated uops (and fused uops without unfused uops) only wait to retire.
// Returns Map groupKey -> {n, nq, rounds, queue, delay, operands, port, exec, retire, total} (queue: over the nq uops
// with a front-end event; null if none), plus .from, .to and .max (the largest total).
export const WAIT_PARTS = Object.freeze([
  ['queue', 'queue'], ['delay', 'delay'], ['operands', 'operands'], ['port', 'port'], ['exec', 'execute'], ['retire', 'retire'],
]);
export function uopWaits(u, delay) {
  if (u.issued === null || u.retired === null) return null;
  const fe = u.idq ?? u.iq;
  const w = { queue: fe !== null && fe <= u.issued ? u.issued - fe : null, delay: 0, operands: 0, port: 0, exec: 0, retire: 0 };
  if ((u.inRS || u.dispatched !== null) && u.dispatched !== null && u.executed !== null) {
    const ready = u.ready ?? u.dispatched;
    const sched = Math.min(ready, u.issued + delay);
    w.delay = Math.max(0, sched - u.issued);
    w.operands = Math.max(0, ready - sched);
    w.port = Math.max(0, u.dispatched - ready);
    w.exec = Math.max(0, u.executed - u.dispatched);
    w.retire = Math.max(0, u.retired - u.executed);
  } else if (u.inRS || u.dispatched !== null) {
    return null; // in the scheduler but not executed: not complete
  } else {
    const done = u.executed ?? u.issued;
    w.exec = Math.max(0, done - u.issued);
    w.retire = Math.max(0, u.retired - done);
  }
  return w;
}
export function waitBreakdown(model, from = model.relevant.first, to = model.relevant.last) {
  const acc = new Map();
  for (const u of model.uops) {
    if (u.rnd < from || u.rnd > to) continue;
    const w = uopWaits(u, model.issueDispatchDelay);
    if (!w) continue;
    const k = groupKey(u);
    let a = acc.get(k);
    if (!a) { a = { n: 0, nq: 0, rounds: new Set(), queue: 0, delay: 0, operands: 0, port: 0, exec: 0, retire: 0 }; acc.set(k, a); }
    a.n++;
    a.rounds.add(u.rnd);
    if (w.queue !== null) { a.nq++; a.queue += w.queue; }
    for (const p of ['delay', 'operands', 'port', 'exec', 'retire']) a[p] += w[p];
  }
  /** @type {Map<any, any> & {from?: number, to?: number, max?: number}} */
  const out = new Map();
  let max = 0;
  for (const [k, a] of acc) {
    const r = { n: a.n, nq: a.nq, rounds: a.rounds.size, queue: a.nq ? a.queue / a.nq : null };
    for (const p of ['delay', 'operands', 'port', 'exec', 'retire']) r[p] = a[p] / a.n;
    r.total = (r.queue ?? 0) + r.delay + r.operands + r.port + r.exec + r.retire;
    max = Math.max(max, r.total);
    out.set(k, r);
  }
  out.from = from; out.to = to; out.max = max;
  return out;
}
export function waitText(w) {
  const f = (v) => (v === null ? '—' : v.toFixed(1));
  return WAIT_PARTS.map(([p, name]) => `${name} ${f(w[p])}`).join(' · ');
}

// The cycle in which round rnd starts (its first issue; the first event if none was issued), or null.
export function roundStart(model, rnd) {
  let lo = Infinity, any = Infinity;
  for (const u of model.uops) {
    if (u.rnd !== rnd) continue;
    if (u.issued !== null && u.issued < lo) lo = u.issued;
    const e = u.issued ?? u.idq ?? u.iq;
    if (e !== null && e < any) any = e;
  }
  return lo < Infinity ? lo : any < Infinity ? any : null;
}
// The cycle in which each of the rounds from..to retired its last uop (null if not within the trace).
export function roundEnds(model, from, to) {
  const out = new Map();
  const open = new Set();
  for (const u of model.uops) {
    if (u.rnd < from || u.rnd > to) continue;
    if (u.retired === null) open.add(u.rnd);
    else out.set(u.rnd, Math.max(out.get(u.rnd) ?? -1, u.retired));
  }
  for (const r of open) out.delete(r);
  return out;
}

// A–B: the rounds of both traces on one time axis. scale: one iteration of B does the work of `scale` iterations of
// A (B unrolled), so B shows iteration floor(k / scale) on and ceil(n / scale) iterations. choice: 'steady' (n
// iterations from the earlier of the two steady states) or 'all' (both from cycle 0). Returns {a: {from, to, origin},
// b: {...}, lo, hi}: the cycle where each side's first shown round starts is cycle 0 of the axis; lo..hi (relative
// cycles) covers the rows of both.
export function abWindow(ma, mb, { choice = 'steady', scale = 1, n = 3, span = cycleSpan } = {}) {
  // scale: iterations of A per iteration of B (B's elements per iteration over A's): any ratio, either way
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  let a, b;
  if (choice === 'all') {
    a = { from: 0, to: Math.max(0, ma.nRounds - 1), origin: 0 };
    b = { from: 0, to: Math.max(0, mb.nRounds - 1), origin: 0 };
  } else {
    const kA = Math.max(0, Math.min(ma.relevant.first, Math.ceil(mb.relevant.first * s), ma.nRounds - 1));
    const kB = Math.max(0, Math.min(Math.floor(kA / s), mb.nRounds - 1));
    a = { from: kA, to: Math.min(ma.nRounds - 1, kA + n - 1) };
    b = { from: kB, to: Math.min(mb.nRounds - 1, kB + Math.max(1, Math.ceil(n / s)) - 1) };
    a.origin = roundStart(ma, kA) ?? 0;
    b.origin = roundStart(mb, kB) ?? 0;
  }
  let lo = Infinity, hi = -Infinity;
  for (const [m, w] of [[ma, a], [mb, b]]) {
    const [c0, c1] = span(m, selectRows(m, w.from, w.to));
    lo = Math.min(lo, c0 - w.origin);
    hi = Math.max(hi, c1 - w.origin);
  }
  if (!(lo <= hi)) { lo = 0; hi = 0; }
  return { a, b, lo, hi };
}

// A trace grows with instructions x iterations; above this many uops it is not requested without asking.
export const TRACE_LIMIT = 20000;
export function traceEstimate(instrCount, request) {
  return Math.max(instrCount * Math.max(1, request?.minIterations ?? 10), 4 * (request?.minCycles ?? 500));
}

// ---- the view (DOM) --------------------------------------------------------------------------------------------

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

const COLOR_VARS = ['background', 'surface', 'text', 'subtle', 'description', 'accent', 'accent-dim', 'border', 'heading', 'code', 'external', 'caveat', 'date'];
const ROW_H = 16, PORT_H = 9, AXIS_H = 18, HEAD_GAP = 6, PAD = 24;
const MIN_SCALE = 0.25, MAX_SCALE = 48;
let idSeq = 0;

// The legend: [class of the swatch, text, (A–B only)]. The swatches are drawn by trace.css with the same colours.
const LEGEND = [
  ['heat', 'ports busy (darker: more of the group)'],
  ['num', 'iteration'],
  ['q', 'front end → issue'],
  ['sched', 'issue → dispatch delay'],
  ['dep', 'waiting for operands'],
  ['stub', 'that wait, shortened: its cycles'],
  ['port', 'waiting for a port'],
  ['exec', 'executing (port on the bar)'],
  ['rob', 'waiting to retire'],
  ['ret', 'retired'],
  ['elim', 'eliminated (no port)'],
  ['end', 'an iteration\'s last uop retired', true],
];

export function legendElement({ ab = false } = {}) {
  return el('ul', { class: 'trace-legend', 'aria-label': 'legend' },
    LEGEND.filter((x) => ab || !x[2]).map(([k, t]) => el('li', null, el('span', { class: `sw sw-${k}`, 'aria-hidden': 'true', text: k === 'num' ? '7' : k === 'stub' ? '9' : null }), t)));
}

// The view's controls (single and A–B): the port strip compact or full, the waits shortened or full, the legend in a
// popover. state: {strip, waits}; onChange(): redraw. Returns {el: the controls, pop: the legend's popover}.
let popSeq = 0;
export function traceControls(state, onChange, { ab = false, extra = [] } = {}) {
  const toggle = (text, title, key, on, off) => {
    const b = el('button', { type: 'button', class: 'trace-toggle', title, 'aria-pressed': String(state[key] === on), text });
    b.addEventListener('click', () => { state[key] = state[key] === on ? off : on; b.setAttribute('aria-pressed', String(state[key] === on)); onChange(key); });
    return b;
  };
  const strip = toggle('all ports', 'every port of the strip (else one row per group of ports)', 'strip', 'full', 'compact');
  const waits = toggle('full waits', 'the whole wait for operands (else shortened, with its cycles written)', 'waits', 'full', 'short');
  const id = `trace-legend-${++popSeq}`;
  const pop = el('div', { class: 'trace-legend-pop', id, role: 'dialog', 'aria-label': 'legend', hidden: true }, legendElement({ ab }));
  const key = el('button', { type: 'button', class: 'trace-zoom trace-keybtn', 'aria-label': 'legend', title: 'what the marks mean', 'aria-expanded': 'false', 'aria-controls': id, text: '?' });
  const close = () => { pop.hidden = true; key.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!pop.contains(e.target) && e.target !== key) close(); };
  key.addEventListener('click', () => {
    if (!pop.hidden) { close(); return; }
    pop.hidden = false; key.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
  });
  for (const t of [key, pop]) t.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { e.stopPropagation(); close(); key.focus(); } });
  return { el: el('span', { class: 'trace-toggles' }, strip, waits, ...extra, key), pop, key, strip, waits };
}

// The shared time axis of the two viewers of an A–B trace (createABTracePanel): one scale, one gutter width, one
// horizontal scroll position; lo..hi: the cycles shown, relative to each viewer's origin.
class TimeSync {
  constructor(lo, hi) { this.lo = lo; this.hi = hi; this.scale = null; this.fit = true; this.viewW = 0; this.viewers = []; this.hover = null; this.busy = false; }
  span() { return this.hi - this.lo + 1; }
  gutter() { return Math.round(Math.min(280, Math.max(130, this.viewW * 0.34))); }
  fitScale() {
    const floor = this.viewW < 560 ? 2 : MIN_SCALE;
    return Math.min(MAX_SCALE, Math.max(floor, (this.viewW - this.gutter() - PAD) / this.span()));
  }
  relayout() {
    if (this.busy) return;
    this.busy = true;
    try {
      const ws = this.viewers.map((v) => v.scroller.clientWidth).filter((w) => w > 0);
      if (!ws.length) return;
      this.viewW = Math.min(...ws);
      if (this.scale === null || this.fit) { this.scale = this.fitScale(); this.fit = true; }
      for (const v of this.viewers) v.layout();
    } finally { this.busy = false; }
  }
  scrollTo(left, from = null) {
    for (const v of this.viewers) if (v !== from && Math.abs(v.scroller.scrollLeft - left) >= 1) v.scroller.scrollLeft = left;
  }
  paintOthers(from) { for (const v of this.viewers) if (v !== from) v.paint(); }
}

export class Viewer {
  /** @type {number} the first and last cycle shown (draw) */ c0;
  /** @type {number} */ c1;
  /** @type {{destroy(): void, range(): any, draw(ctx: CanvasRenderingContext2D): void, down(e: PointerEvent): boolean, key(e: KeyboardEvent): boolean} | undefined} a cycle range's hooks (trace-range-view.js) */ ext;
  // options: onState(); onHoverGroup(group | null), onPickGroup(group): a uop row under the pointer / clicked (or
  // Enter), as its instruction's group (rowGroups); for an A–B trace: sync (a TimeSync), fixed {from, to, origin}
  // (the rounds shown and the cycle that is 0 on the axis), tag ('A' / 'B')
  constructor(model, state, { onState = () => {}, onHoverGroup = null, onPickGroup = null, sync = null, fixed = null, tag = null, compare = null } = {}) {
    this.model = model;
    this.state = state; // {range, mode, scale, scrollLeft, scrollTop}: kept by the panel across re-renders
    this.onState = onState;
    this.onHoverGroup = onHoverGroup;
    this.onPickGroup = onPickGroup;
    this.sync = sync;
    this.fixed = fixed;
    this.tag = tag;
    this.origin = fixed ? fixed.origin : 0;
    this.linkKey = null; // the instruction (groupKey) under the pointer in the uop table
    this.selKey = null;  // the selected instruction
    this.hoverKey = null;
    this.ends = fixed ? roundEnds(model, fixed.from, fixed.to) : null;
    this.choices = rangeChoices(model);
    if (!this.choices.some((c) => c.id === state.range)) state.range = this.choices[0].id;
    this.ports = model.ports.map((p, i) => ({ ...p, i })).filter((p) => p.used > 0);
    this.groups = portGroups(model, this.ports); // the compact strip: one row per group (state.strip 'compact')
    this.compare = compare; // A–B: B's viewer compares its ports' use with A's (the viewer here)
    if (state.strip !== 'full') state.strip = 'compact';
    if (state.waits !== 'full') state.waits = 'short';
    this.active = -1; // the row (index into this.rows) under the pointer or the keyboard focus
    this.pinned = false;
    this.portHover = null; // [port index, cycle]
    this.colors = null;
    this.frame = 0;
    this.labelCache = new Map();
    this.build();
    this.setRange(state.range, { keepScale: state.scale !== null });
  }

  // ---- DOM ----
  build() {
    const id = `trace-${++idSeq}`;
    this.rangeSel = el('select', { id: `${id}-range` }, this.choices.map((c) => el('option', { value: c.id, text: c.label })));
    this.rangeSel.value = this.state.range;
    this.rangeSel.addEventListener('change', () => this.setRange(this.rangeSel.value, { keepScale: false }));
    const zoomBtn = (text, label, f) => { const b = el('button', { type: 'button', class: 'trace-zoom', 'aria-label': label, title: label, text }); b.addEventListener('click', f); return b; };
    this.zoomLabel = el('span', { class: 'trace-scale', 'aria-live': 'polite' });
    const modeName = `${id}-mode`;
    this.modeChart = el('input', { type: 'radio', name: modeName, value: 'chart' });
    this.modeTable = el('input', { type: 'radio', name: modeName, value: 'table' });
    this.modeChart.checked = this.state.mode !== 'table';
    this.modeTable.checked = this.state.mode === 'table';
    for (const r of [this.modeChart, this.modeTable]) r.addEventListener('change', () => { if (r.checked) this.setMode(r.value); });
    this.controls = this.fixed ? null : traceControls(this.state, (k) => this.restyle(k));
    this.zoomTools = el('span', { class: 'trace-zoomtools' },
      zoomBtn('−', 'zoom out', () => this.zoomBy(1 / 1.6)),
      zoomBtn('+', 'zoom in', () => this.zoomBy(1.6)),
      zoomBtn('fit', 'fit the cycles to the width', () => this.fit()),
      this.zoomLabel, this.controls?.el);
    const tools = el('div', { class: 'trace-tools' },
      el('label', { class: 'inline' }, 'show ', this.rangeSel),
      el('span', { class: 'trace-mode', role: 'radiogroup', 'aria-label': 'view' },
        el('label', null, this.modeChart, ' chart'), el('label', null, this.modeTable, ' table')),
      this.zoomTools);

    this.canvas = el('canvas', { class: 'trace-canvas', tabindex: '0', role: 'application',
      'aria-roledescription': 'trace timeline',
      'aria-label': 'Timeline of the uops by cycle. Arrow keys move between uops and show their details; Enter selects the instruction in the uop table; + and − zoom. The table view lists the same events.',
      'aria-describedby': `${id}-live` });
    this.sizer = el('div', { class: 'trace-sizer' }, this.canvas);
    this.scroller = el('div', { class: 'trace-scroll' }, this.sizer);
    this.tip = el('div', { class: 'trace-tip', role: 'tooltip', id: `${id}-tip`, hidden: true });
    this.live = el('p', { class: 'trace-live', id: `${id}-live`, 'aria-live': 'polite' });
    this.probe = el('span', { class: 'trace-probe', 'aria-hidden': 'true' });
    this.chart = el('div', { class: 'trace-chart' }, this.scroller, this.tip, this.probe);
    this.legend = this.controls?.pop ?? el('span', { hidden: true }); // (A–B: the panel's)
    this.note = el('p', { class: 'trace-note hint' }); // one line: what is shown; the explanations in the legend's popover
    this.about = el('p', { class: 'trace-about hint' });
    this.controls?.pop.append(this.about);
    this.tableBox = el('div', { class: 'trace-tablebox', hidden: true });
    this.root = this.fixed
      ? el('div', { class: 'trace-viewer', 'data-tag': this.tag }, this.chart, this.tableBox, this.live) // A–B: the panel has the tools and the legend
      : el('div', { class: 'trace-viewer' }, tools, this.legend, this.chart, this.note, this.tableBox, this.live);
    if (this.tag) this.canvas.setAttribute('aria-label', `${this.tag}: timeline of the uops by cycle. Arrow keys move between uops; + and − zoom.`);
    if (!this.fixed) attachRange(this, tools); // trace-range-view.js

    this.scroller.addEventListener('scroll', () => {
      this.state.scrollLeft = this.scroller.scrollLeft;
      this.state.scrollTop = this.scroller.scrollTop;
      if (this.sync) { this.sync.scrollTo(this.scroller.scrollLeft, this); this.sync.follow?.(this); }
      if (!this.pinned && this.active >= 0 && this.pointer) this.hoverAt(this.pointer.x, this.pointer.y);
      this.paint();
    }, { passive: true });
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.pointer = null;
      if (this.sync) { this.sync.hover = null; this.sync.paintOthers(this); }
      if (!this.pinned) { this.setActive(-1); this.portHover = null; this.paint(); }
    });
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return; // a plain wheel scrolls
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left);
    }, { passive: false });
    this.canvas.addEventListener('keydown', (e) => this.onKey(e));
    this.canvas.addEventListener('blur', () => { if (this.pinned) { this.pinned = false; this.setActive(-1); this.paint(); } });
    this.resizer = new ResizeObserver(() => (this.sync ? this.sync.relayout() : this.layout()));
    this.resizer.observe(this.scroller);
    const repaintColors = () => { this.colors = null; this.patterns = null; this.paint(); };
    this.themeObserver = new MutationObserver(repaintColors);
    this.themeObserver.observe(document.documentElement, { attributes: true });
    if (document.body) this.themeObserver.observe(document.body, { attributes: true });
    this.mq = matchMedia('(prefers-color-scheme: dark)');
    this.mq.addEventListener?.('change', repaintColors);
    this.repaintColors = repaintColors;
  }

  destroy() {
    this.resizer.disconnect();
    this.themeObserver.disconnect();
    this.mq.removeEventListener?.('change', this.repaintColors);
    cancelAnimationFrame(this.frame);
    this.ext?.destroy();
  }

  // called when the element is (again) in the document: the scroll position is lost when it is moved
  attached() {
    if (this.sync) this.sync.relayout(); else this.layout();
    this.scroller.scrollLeft = this.state.scrollLeft ?? 0;
    this.scroller.scrollTop = this.state.scrollTop ?? 0;
    this.paint();
  }

  // a control changed: the strip (redraw with the other head) or the waits (another span: fitted again)
  restyle(key) {
    if (key === 'waits') { this.setRange(this.state.range, { keepScale: false }); return; }
    this.labelCache.clear();
    this.layout();
    this.onState();
  }

  setMode(mode) {
    this.state.mode = mode;
    this.chart.hidden = mode === 'table';
    if (mode === 'table' && this.controls) { this.legend.hidden = true; this.controls.key.setAttribute('aria-expanded', 'false'); }
    this.zoomTools.hidden = mode === 'table';
    this.tableBox.hidden = mode !== 'table';
    if (mode === 'table') this.renderTable(); else { this.tableBox.replaceChildren(); this.attached(); }
    this.onState();
  }

  setRange(id, { keepScale }) {
    const c = this.fixed ? { id: 'fixed', ...this.fixed } : this.choices.find((x) => x.id === id) ?? this.choices[0];
    if (!this.fixed) { this.state.range = c.id; this.rangeSel.value = c.id; }
    this.rows = selectRows(this.model, c.from, c.to);
    this.rowSet = new Set(this.rows);
    this.rowOf = new Map(Array.from(this.rows, (u, r) => [u, r]));
    if (this.fixed) [this.c0, this.c1] = [this.origin + this.sync.lo, this.origin + this.sync.hi];
    else [this.c0, this.c1] = shownSpan(this.model, this.rows, this.state.waits);
    this.active = -1;
    this.pinned = false;
    this.tip.hidden = true;
    const hiddenPorts = this.model.ports.length - this.ports.length;
    const shownIts = [...new Set(Array.from(this.rows, (i) => this.model.uops[i].rnd))];
    this.note.textContent = `${this.rows.length} uops · cycles ${this.c0}–${this.c1}` + (shownIts.length ? ` · iteration${shownIts.length === 1 ? '' : 's'} ${shownIts[0]}${shownIts.length > 1 ? `–${shownIts.at(-1)}` : ''}` : '');
    this.about.textContent = aboutText(this.model, hiddenPorts);
    if (!keepScale) { this.state.scale = null; this.state.fit = true; this.state.scrollLeft = 0; this.state.scrollTop = 0; }
    this.setMode(this.state.mode === 'table' ? 'table' : 'chart'); // (re)renders the table or lays out the chart
  }

  renderTable() {
    const m = this.model;
    const head = el('tr', null, TABLE_HEAD.map((t) => el('th', { scope: 'col', text: t })));
    const body = el('tbody');
    const rows = tableRows(m, this.rows);
    const frag = document.createDocumentFragment();
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      r.forEach((v, k) => {
        const c = document.createElement(k === 1 ? 'th' : 'td');
        if (k === 1) c.setAttribute('scope', 'row');
        c.textContent = v;
        tr.append(c);
      });
      frag.append(tr);
    });
    body.append(frag);
    const copy = el('button', { type: 'button', text: 'Copy as tab-separated text' });
    copy.addEventListener('click', async () => {
      const text = toTSV(m, this.rows);
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch {
        const t = el('textarea', { readonly: true, 'aria-hidden': 'true', tabindex: '-1', class: 'trace-copybuf' });
        t.value = text; document.body.append(t); t.select();
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        t.remove(); copy.focus();
      }
      copy.textContent = ok ? 'Copied' : 'Could not copy: select the table';
      setTimeout(() => { copy.textContent = 'Copy as tab-separated text'; }, 1600);
    });
    const caption = el('caption', { text: `Events of ${rows.length} uops (cycle numbers; empty: did not happen within the simulated cycles)` });
    const table = el('table', { class: 'grid trace-table' }, caption, el('thead', null, head), body);
    this.tableBox.replaceChildren(el('div', { class: 'trace-tabletools' }, copy),
      el('div', { class: 'table-wrap trace-tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Trace events' }, table));
  }

  // ---- geometry ----
  gutter() { return this.sync ? this.sync.gutter() : Math.round(Math.min(280, Math.max(130, this.viewW * 0.34))); }
  // the cycles that have data: c0..c1 can reach beyond the trace in an A–B view
  dataC(c) { return Math.max(0, Math.min(this.model.nCycles - 1, c)); }
  // the rows of the strip: one per group of ports (compact) or one per port (full)
  stripRows() { return this.state.strip === 'full' ? this.ports : this.groups; }
  headH() { return AXIS_H + this.stripRows().length * PORT_H + (this.model.issue ? ISSUE_H : 0) + HEAD_GAP; }
  // the share (%) of each strip row's capacity used in cycles a..b: Map name -> percent
  stripShares(a, b) {
    const out = new Map(), m = this.model, n = b - a + 1;
    if (this.state.strip === 'full') for (const p of this.ports) out.set(p.short, Math.round((100 * (m.prefix[p.i][b + 1] - m.prefix[p.i][a])) / n));
    else for (const g of this.groups) out.set(g.name, Math.round((100 * (g.pre[b + 1] - g.pre[a])) / (n * g.ports.length)));
    return out;
  }
  x(c) { return this.G + (c - this.c0) * this.scale - this.sl; }
  cycleAt(px) { return Math.floor((px - this.G + this.sl) / this.scale) + this.c0; }

  layout() {
    if (!this.scroller.isConnected || this.chart.hidden) return;
    const w = this.scroller.clientWidth;
    if (!w) return;
    this.viewW = w;
    this.G = this.gutter();
    const span = this.c1 - this.c0 + 1;
    if (this.sync) {
      if (this.sync.scale === null) return; // laid out by sync.relayout()
      this.scale = this.sync.scale;
    } else {
      if (this.state.scale === null || this.state.fit !== false) { this.state.scale = this.fitScale(); this.state.fit = true; } // follows the width until zoomed
      this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.state.scale));
    }
    const H = this.headH();
    this.sizer.style.width = `${Math.ceil(this.G + span * this.scale + PAD)}px`;
    const contentH = H + this.rows.length * ROW_H + 4;
    this.sizer.style.height = `${contentH}px`;
    // the scroller is as tall as the content, up to a limit (set in trace.css)
    this.scroller.style.height = `${contentH + (this.sizer.offsetWidth > w ? 16 : 0)}px`;
    const vw = this.scroller.clientWidth, vh = this.scroller.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.viewW = vw; this.viewH = vh;
    this.canvas.style.width = `${vw}px`;
    this.canvas.style.height = `${vh}px`;
    if (this.canvas.width !== Math.round(vw * dpr) || this.canvas.height !== Math.round(vh * dpr)) {
      this.canvas.width = Math.round(vw * dpr);
      this.canvas.height = Math.round(vh * dpr);
    }
    this.dpr = dpr;
    this.zoomLabel.textContent = this.scale >= 0.95 ? `${+this.scale.toFixed(1)} px per cycle` : `${+(1 / this.scale).toFixed(1)} cycles per px`;
    this.paint();
  }

  fitScale() {
    const span = this.c1 - this.c0 + 1;
    // on a narrow screen, at least 2 px per cycle (it scrolls sideways) rather than an unreadable fit
    const floor = this.viewW < 560 ? 2 : MIN_SCALE;
    return Math.min(MAX_SCALE, Math.max(floor, (this.viewW - this.gutter() - PAD) / span));
  }

  zoomBy(f, anchorX = null) {
    const ax = anchorX ?? (this.G + (this.viewW - this.G) / 2);
    const c = (ax - this.G + this.scroller.scrollLeft) / this.scale; // cycles from c0 under the anchor
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * f));
    if (this.sync) {
      this.sync.scale = scale; this.sync.fit = false;
      this.sync.relayout();
      const left = Math.max(0, c * this.scale - (ax - this.G));
      this.scroller.scrollLeft = left;
      this.sync.scrollTo(this.scroller.scrollLeft, this);
      return;
    }
    this.state.scale = scale;
    this.state.fit = false;
    this.layout();
    this.scroller.scrollLeft = Math.max(0, c * this.scale - (ax - this.G));
    this.paint();
  }

  fit() {
    if (this.sync) { this.sync.fit = true; this.sync.relayout(); this.sync.scrollTo(0); return; }
    this.state.fit = true; this.layout(); this.scroller.scrollLeft = 0;
  }

  // ---- colours ----
  readColors() {
    const out = {};
    for (const v of COLOR_VARS) {
      this.probe.style.color = `var(--${v})`;
      out[v] = getComputedStyle(this.probe).color;
    }
    this.probe.style.color = '';
    out.font = `12px ${getComputedStyle(this.root).fontFamily}`;
    this.colors = out;
    // stripes for "waiting for operands"
    const p = document.createElement('canvas');
    const n = Math.round(6 * (this.dpr || 1));
    p.width = p.height = n;
    const g = p.getContext('2d');
    g.strokeStyle = out.caveat;
    g.lineWidth = Math.max(1, n / 5);
    g.beginPath(); g.moveTo(0, n); g.lineTo(n, 0); g.moveTo(-n / 2, n / 2); g.lineTo(n / 2, -n / 2); g.moveTo(n / 2, n * 1.5); g.lineTo(n * 1.5, n / 2); g.stroke();
    this.patterns = { dep: this.canvas.getContext('2d').createPattern(p, 'repeat') };
  }

  paint() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  // ---- drawing ----
  draw() {
    if (!this.viewW || this.chart.hidden || !this.canvas.isConnected) return;
    const t0 = performance.now();
    // the theme can change in ways no observer sees (e.g. a stylesheet): one property is checked on every draw
    if (this.colors) { this.probe.style.color = 'var(--surface)'; if (getComputedStyle(this.probe).color !== this.colors.surface) this.colors = null; }
    if (!this.colors) this.readColors();
    const C = this.colors, m = this.model, ctx = this.canvas.getContext('2d');
    const dpr = this.dpr, W = this.viewW, Hv = this.viewH, G = this.G, H = this.headH(), s = this.scale;
    this.sl = this.scroller.scrollLeft;
    const st = this.scroller.scrollTop;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = C.font;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.surface;
    ctx.fillRect(0, 0, W, Hv);

    const cA = Math.max(this.c0, this.cycleAt(G)), cB = Math.min(this.c1, this.cycleAt(W) + 1);
    let step = 1;
    for (const k of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) { step = k; if (k * s >= 44) break; }
    const rA = Math.max(0, Math.floor(st / ROW_H) - 1), rB = Math.min(this.rows.length, Math.ceil((st + Hv - H) / ROW_H) + 1);
    const rowY = (r) => H + r * ROW_H - st;
    const activeU = this.active >= 0 ? this.rows[this.active] : -1;
    const related = new Set();
    if (activeU >= 0) { for (const j of m.uops[activeU].deps) related.add(j); }
    // the cycle under the pointer (in an A–B view: also under the pointer in the other view, at the same place on the axis)
    let hoverCycle = this.pointer && this.pointer.x > G ? this.cycleAt(this.pointer.x) : null;
    if (hoverCycle === null && this.sync?.hover !== null && this.sync?.hover !== undefined) hoverCycle = this.sync.hover + this.origin;
    const linked = this.linkKey ?? this.selKey; // the instruction of the uop table under the pointer, or the selected one

    // body
    ctx.save();
    ctx.beginPath(); ctx.rect(0, H, W, Hv - H); ctx.clip();
    for (let r = rA; r < rB; r++) {
      const u = this.rows[r];
      const mine = linked !== null && groupKey(m.uops[u]) === linked;
      if (u === activeU || related.has(u) || mine) {
        ctx.fillStyle = C['accent-dim'];
        ctx.fillRect(0, rowY(r), W, ROW_H);
      }
      if (mine) { ctx.fillStyle = C.accent; ctx.fillRect(0, rowY(r), 3, ROW_H); }
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(G, H, W - G, Hv - H); ctx.clip();
    ctx.fillStyle = C.border;
    for (let c = this.origin + Math.ceil((cA - this.origin) / step) * step; c <= cB; c += step) ctx.fillRect(Math.round(this.x(c)), H, 1, Hv - H);
    if (hoverCycle !== null && hoverCycle >= this.c0 && hoverCycle <= this.c1) {
      ctx.globalAlpha = 0.6; ctx.fillStyle = C['accent-dim']; ctx.fillRect(this.x(hoverCycle), 0, Math.max(1, s), Hv); ctx.globalAlpha = 1;
    }
    if (this.ends) { // A–B: where each shown iteration retired its last uop
      ctx.fillStyle = this.tag === 'B' ? C.code : C.accent;
      ctx.globalAlpha = 0.7;
      for (const c of this.ends.values()) if (c >= cA - 1 && c <= cB + 1) ctx.fillRect(Math.round(this.x(c + 1)) - 1, H, 2, Hv - H);
      ctx.globalAlpha = 1;
    }
    for (let r = rA; r < rB; r++) this.drawUop(ctx, this.rows[r], rowY(r));
    if (activeU >= 0) this.drawDeps(ctx, activeU, rowY);
    ctx.restore();
    // round separators and labels in the gutter
    let prevRnd = r0Rnd(this, rA);
    for (let r = rA; r < rB; r++) {
      const u = m.uops[this.rows[r]];
      const y = rowY(r);
      if (r === 0 || u.rnd !== prevRnd) {
        ctx.fillStyle = C.border; ctx.fillRect(0, Math.round(y), W, 1);
      }
      this.drawLabel(ctx, this.rows[r], y, r === 0 || u.rnd !== prevRnd);
      prevRnd = u.rnd;
    }
    ctx.restore();

    // head: axis and port strips
    ctx.fillStyle = C.surface;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.rect(G, 0, W - G, H); ctx.clip();
    ctx.fillStyle = C.subtle;
    ctx.textAlign = 'left';
    for (let c = this.origin + Math.ceil((cA - this.origin) / step) * step; c <= cB; c += step) {
      const x = Math.round(this.x(c));
      ctx.fillStyle = C.border; ctx.fillRect(x, AXIS_H - 5, 1, 5);
      ctx.fillStyle = C.subtle; ctx.fillText(String(c - this.origin), x + 2, AXIS_H / 2 - 1);
    }
    const dA = Math.max(cA, 0), dB = Math.min(cB, m.nCycles - 1);
    const strip = this.stripRows(), full = this.state.strip === 'full';
    for (let p = 0; p < strip.length; p++) (full ? this.drawPortStrip(ctx, strip[p], AXIS_H + p * PORT_H, dA, dB) : this.drawGroupStrip(ctx, strip[p], AXIS_H + p * PORT_H, dA, dB));
    if (m.issue) drawIssueStrip(this, ctx, m.issue, AXIS_H + strip.length * PORT_H, dA, dB);
    if (hoverCycle !== null && hoverCycle >= this.c0 && hoverCycle <= this.c1) {
      ctx.globalAlpha = 0.6; ctx.fillStyle = C['accent-dim']; ctx.fillRect(this.x(hoverCycle), 0, Math.max(1, s), H); ctx.globalAlpha = 1;
    }
    ctx.restore();
    // port names and their use in the shown cycles
    if (this.tag) { // A–B: the side and its iterations
      const tw = Math.max(16, ctx.measureText(this.tag).width + 6);
      ctx.fillStyle = this.tag === 'B' ? C.code : C.accent;
      ctx.fillRect(4, 2, tw, AXIS_H - 5);
      ctx.fillStyle = C.background; ctx.textAlign = 'center'; ctx.fillText(this.tag, 4 + tw / 2, AXIS_H / 2 - 1);
      ctx.textAlign = 'left'; ctx.fillStyle = C.subtle;
      const f = this.fixed;
      ctx.fillText(this.fitText(ctx, f.from === f.to ? `it ${f.from}` : `it ${f.from}–${f.to}`, G - tw - 16), tw + 10, AXIS_H / 2 - 1);
    } else {
      ctx.fillStyle = C.subtle;
      ctx.fillText('cycle', 6, AXIS_H / 2 - 1);
    }
    ctx.font = `10px ${C.font.slice(5)}`;
    const R = this.ext?.range(); // a selected cycle range: the shares are its own
    const span = R ? R.b - R.a + 1 : this.c1 - this.c0 + 1;
    const pc0 = R ? R.a : this.dataC(this.c0), pc1 = R ? R.b : this.dataC(this.c1);
    const shares = this.stripShares(pc0, pc1);
    // A–B: B's rows whose use differs from A's (in A's own window of the same length) say by how much
    const other = this.compare && !R ? this.compare.stripShares(this.compare.dataC(this.compare.c0), this.compare.dataC(this.compare.c1)) : null;
    for (let p = 0; p < strip.length; p++) {
      const name = strip[p].short;
      const y = AXIS_H + p * PORT_H + PORT_H / 2;
      const pct = shares.get(name) ?? 0, d = other ? pct - (other.get(name) ?? 0) : 0;
      ctx.fillStyle = Math.abs(d) >= 2 ? C.text : C.subtle;
      ctx.textAlign = 'left';
      ctx.fillText(name, 6, y);
      ctx.textAlign = 'right';
      ctx.fillText(`${pct}%`, G - 6, y);
      if (Math.abs(d) >= 2) { // (in A's colour: what A had)
        const pw = ctx.measureText(`${pct}%`).width;
        ctx.fillStyle = C.heading;
        ctx.fillText(`${d > 0 ? '+' : '−'}${Math.abs(d)}`, G - 10 - pw, y);
      }
    }
    if (m.issue) { // the issue strip: the share of the issue slots used in the shown cycles
      const y = AXIS_H + strip.length * PORT_H + ISSUE_H / 2;
      const f = issueShare(m.issue, pc0, pc1);
      ctx.fillStyle = C.subtle;
      ctx.textAlign = 'left';
      ctx.fillText('issue', 6, y);
      ctx.textAlign = 'right';
      if (f !== null) ctx.fillText(`${Math.round(100 * f)}%`, G - 6, y);
    }
    ctx.textAlign = 'left';
    ctx.font = C.font;
    ctx.fillStyle = C.border;
    ctx.fillRect(0, H - 1, W, 1);
    ctx.fillRect(G - 1, 0, 1, Hv);
    this.ext?.draw(ctx);
    this.lastDrawMs = performance.now() - t0;
    this.root.dataset.drawMs = this.lastDrawMs.toFixed(2);
  }

  drawPortStrip(ctx, port, y, cA, cB) {
    const C = this.colors, m = this.model, s = this.scale;
    const used = m.dispatchedAt[port.i], pre = m.prefix[port.i];
    const h = PORT_H - 2;
    ctx.fillStyle = C.border;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(this.x(this.c0), y + h / 2, (this.c1 - this.c0 + 1) * s, 1);
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.accent;
    const hot = this.portHover && this.portHover[0] === port.i ? this.portHover[1] : null;
    const activeU = this.active >= 0 ? this.rows[this.active] : -1;
    if (s >= 1.5) {
      for (let c = cA; c <= cB; c++) {
        const u = used[c];
        if (u < 0) continue;
        ctx.globalAlpha = this.rowSet.has(u) ? 1 : 0.35; // dispatches of uops outside the shown iterations: fainter
        ctx.fillStyle = u === activeU || c === hot ? C.heading : C.accent;
        ctx.fillRect(this.x(c), y, Math.max(1, s - (s >= 4 ? 1 : 0)), h);
      }
    } else {
      // several cycles per pixel: the share of cycles with a dispatch
      const x0 = Math.max(this.G, Math.floor(this.x(cA))), x1 = Math.ceil(this.x(cB + 1));
      for (let x = x0; x < x1; x++) {
        const a = Math.max(this.c0, 0, Math.floor((x - this.G + this.sl) / s) + this.c0);
        const b = Math.min(this.c1 + 1, m.nCycles, Math.floor((x + 1 - this.G + this.sl) / s) + this.c0);
        if (b <= a) continue;
        const f = (pre[b] - pre[a]) / (b - a);
        if (f <= 0) continue;
        ctx.globalAlpha = 0.2 + 0.8 * f;
        ctx.fillRect(x, y, 1, h);
      }
    }
    ctx.globalAlpha = 1;
  }

  // a group of ports per cycle: the share of its ports busy (darker: more)
  drawGroupStrip(ctx, g, y, cA, cB) {
    const C = this.colors, s = this.scale, n = g.ports.length, h = PORT_H - 2;
    ctx.fillStyle = C.border; ctx.globalAlpha = 0.5;
    ctx.fillRect(this.x(this.c0), y + h / 2, (this.c1 - this.c0 + 1) * s, 1);
    ctx.fillStyle = C.accent;
    const hot = this.portHover && this.portHover[0] === g ? this.portHover[1] : null;
    if (s >= 1.5) {
      for (let c = cA; c <= cB; c++) {
        const k = g.pre[c + 1] - g.pre[c];
        if (!k) continue;
        ctx.globalAlpha = 0.25 + (0.75 * k) / n;
        ctx.fillStyle = c === hot ? C.heading : C.accent;
        ctx.fillRect(this.x(c), y, Math.max(1, s - (s >= 4 ? 1 : 0)), h);
      }
    } else {
      const x0 = Math.max(this.G, Math.floor(this.x(cA))), x1 = Math.ceil(this.x(cB + 1));
      for (let x = x0; x < x1; x++) {
        const a = Math.max(this.c0, 0, Math.floor((x - this.G + this.sl) / s) + this.c0);
        const b = Math.min(this.c1 + 1, this.model.nCycles, Math.floor((x + 1 - this.G + this.sl) / s) + this.c0);
        if (b <= a) continue;
        const f = (g.pre[b] - g.pre[a]) / ((b - a) * n);
        if (f <= 0) continue;
        ctx.globalAlpha = 0.2 + 0.8 * f;
        ctx.fillRect(x, y, 1, h);
      }
    }
    ctx.globalAlpha = 1;
  }

  drawUop(ctx, i, y) {
    const C = this.colors, u = this.model.uops[i], s = this.scale;
    const mid = Math.round(y + ROW_H / 2) + 0.5;
    const X = (c) => this.x(c);
    const line = (a, b, color, alpha = 1) => {
      if (a === null || b === null || b <= a) return;
      ctx.globalAlpha = alpha; ctx.fillStyle = color;
      ctx.fillRect(X(a), mid - 0.5, (b - a) * s, 1);
      ctx.globalAlpha = 1;
    };
    const end = this.c1 + 1;
    // a long wait for operands, shortened (waits 'short'): its last cycles hatched, its length written left of them; the
    // issue and the front end before it are not drawn
    const cut = (u.inRS || u.dispatched !== null) && shortened(u, this.model.issueDispatchDelay, this.state.waits);
    // front end: predecoded -> IDQ (faint), IDQ -> issued
    if (!cut) {
      if (u.iq !== null && u.idq !== null) line(u.iq, u.idq, C.subtle, 0.45);
      const fe = u.idq ?? u.iq;
      line(fe, u.issued, C.subtle);
      if (u.idq !== null) { ctx.fillStyle = C.subtle; ctx.fillRect(X(u.idq), y + 4, Math.max(1, Math.min(2, s)), ROW_H - 8); }
    }
    if (u.inRS || u.dispatched !== null) {
      const ready = u.ready ?? (u.dispatched !== null ? u.dispatched : end);
      const disp = u.dispatched ?? end;
      const sched = u.issued === null ? null : Math.min(ready, u.issued + this.model.issueDispatchDelay);
      if (cut) {
        const x1 = X(ready), w = Math.max(STUB_C * s, 10), x0 = x1 - w;
        ctx.fillStyle = this.patterns.dep;
        ctx.fillRect(x0, y + 4, w, ROW_H - 8);
        ctx.globalAlpha = 0.9; ctx.fillStyle = C.caveat;
        ctx.fillRect(x0, y + ROW_H - 5, w, 1);
        ctx.fillRect(x0, y + 4, 1, ROW_H - 8);
        ctx.globalAlpha = 1;
        ctx.textAlign = 'right';
        ctx.fillText(String(ready - sched), x0 - 2, mid);
        ctx.textAlign = 'left';
      } else if (sched !== null && sched > u.issued) { // the fixed delay between issue and the earliest dispatch
        ctx.fillStyle = C.subtle; ctx.globalAlpha = 0.55;
        ctx.fillRect(X(u.issued), y + 6, (sched - u.issued) * s, ROW_H - 12);
        ctx.globalAlpha = 1;
      }
      if (!cut && sched !== null && ready > sched) { // not ready: waiting for operands
        ctx.fillStyle = this.patterns.dep;
        ctx.fillRect(X(sched), y + 4, (ready - sched) * s, ROW_H - 8);
        ctx.globalAlpha = 0.9; ctx.fillStyle = C.caveat;
        ctx.fillRect(X(sched), y + ROW_H - 5, (ready - sched) * s, 1);
        ctx.globalAlpha = 1;
      }
      if (u.ready !== null && disp > u.ready) {
        ctx.fillStyle = C.external; ctx.globalAlpha = 0.85;
        ctx.fillRect(X(u.ready), y + 5, (disp - u.ready) * s, ROW_H - 10);
        ctx.globalAlpha = 1;
      }
      if (u.dispatched !== null) {
        const ex = u.executed ?? end;
        const w = Math.max(1, Math.max(ex - u.dispatched, 1) * s - (s >= 4 ? 1 : 0));
        ctx.fillStyle = C.accent;
        ctx.fillRect(X(u.dispatched), y + 2, w, ROW_H - 4);
        if (s >= 8 && u.port !== null) {
          const name = this.portShort(u.port);
          if (ctx.measureText(name).width <= w - 2) {
            ctx.fillStyle = C.background;
            ctx.fillText(name, X(u.dispatched) + 1.5, mid);
          }
        }
      }
    } else if (u.executed !== null && u.issued !== null) {
      // eliminated: executed when issued
      const cx = X(u.issued) + Math.max(s, 6) / 2, r = 3.5;
      ctx.strokeStyle = C.accent; ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.moveTo(cx, mid - r); ctx.lineTo(cx + r, mid); ctx.lineTo(cx, mid + r); ctx.lineTo(cx - r, mid); ctx.closePath(); ctx.stroke();
    }
    // waiting to retire, retired
    if (u.executed !== null) line(Math.max(u.executed, u.dispatched !== null ? u.dispatched + 1 : u.executed), u.retired, C.description, 0.8);
    if (u.retired !== null) {
      ctx.fillStyle = C.heading;
      ctx.fillRect(X(u.retired), y + 2, Math.max(2, Math.min(3, s)), ROW_H - 4);
    }
  }

  drawDeps(ctx, i, rowY) {
    const C = this.colors, m = this.model, u = m.uops[i], s = this.scale;
    const r = this.rowOf.get(i);
    const to = u.ready ?? u.dispatched ?? u.issued;
    if (to === null) return;
    const ty = rowY(r) + ROW_H / 2, tx = this.x(to);
    ctx.strokeStyle = C.heading; ctx.fillStyle = C.heading; ctx.lineWidth = 1.25;
    for (const j of u.deps) {
      const rj = this.rowOf.get(j);
      if (rj === undefined) continue;
      const d = m.uops[j];
      const from = d.executed ?? d.dispatched;
      if (from === null) continue;
      const fx = this.x(from) + Math.min(s, 2), fy = rowY(rj) + ROW_H / 2;
      ctx.beginPath(); ctx.moveTo(fx, fy);
      ctx.bezierCurveTo(fx + 12, fy, tx - 12, ty, tx, ty);
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx - 5, ty - 3); ctx.lineTo(tx - 5, ty + 3); ctx.closePath(); ctx.fill();
    }
  }

  portShort(id) {
    const p = this.model.ports.find((q) => q.id === id);
    return p ? p.short : id;
  }

  drawLabel(ctx, i, y, firstOfRound) {
    const C = this.colors, m = this.model, u = m.uops[i];
    const G = this.G;
    ctx.fillStyle = C.surface;
    const mid = y + ROW_H / 2;
    if (firstOfRound) { ctx.fillStyle = C.heading; ctx.fillText(String(u.rnd), 6, mid); }
    let text, color;
    if (u.n > 1) { text = `↳ uop ${u.n}/${u.of}`; color = C.subtle; }
    else if (u.kind === 'regMerge') { text = 'merge uop'; color = C.subtle; }
    else if (u.kind === 'stackSync') { text = 'stack sync uop'; color = C.subtle; }
    else { text = m.labels[u.instrID]; color = C.code; }
    const x0 = 34;
    ctx.fillStyle = color;
    ctx.fillText(this.fitText(ctx, text, G - x0 - 6), x0 + (u.n > 1 ? 8 : 0), mid);
  }

  fitText(ctx, text, w) {
    const k = `${w}|${text}`;
    let v = this.labelCache.get(k);
    if (v === undefined) {
      v = text;
      if (ctx.measureText(v).width > w) {
        let lo = 0, hi = text.length;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, mid) + '…').width <= w) lo = mid; else hi = mid - 1; }
        v = text.slice(0, lo) + '…';
      }
      this.labelCache.set(k, v);
    }
    return v;
  }

  // ---- interaction ----
  rowAt(y) {
    const H = this.headH();
    if (y < H) return -1;
    const r = Math.floor((y - H + this.scroller.scrollTop) / ROW_H);
    return r >= 0 && r < this.rows.length ? r : -1;
  }

  onPointerMove(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    this.pointer = { x, y };
    if (this.sync) { this.sync.hover = x > this.G ? this.cycleAt(x) - this.origin : null; this.sync.paintOthers(this); }
    if (this.drag) {
      this.scroller.scrollLeft = this.drag.sl - (e.clientX - this.drag.x);
      this.scroller.scrollTop = this.drag.st - (e.clientY - this.drag.y);
      if (Math.abs(e.clientX - this.drag.x) + Math.abs(e.clientY - this.drag.y) > 4) this.drag.moved = true;
      return;
    }
    if (this.pinned) { this.paint(); return; }
    this.hoverAt(x, y);
  }

  hoverAt(x, y) {
    const H = this.headH();
    this.portHover = null;
    const strip = this.stripRows();
    if (this.state.strip !== 'full' && y >= AXIS_H && y < AXIS_H + strip.length * PORT_H && x > this.G) {
      const g = strip[Math.floor((y - AXIS_H) / PORT_H)], c = this.cycleAt(x);
      if (g && c >= this.c0 && c <= this.c1 && c >= 0 && c < this.model.nCycles) {
        this.portHover = [g, c];
        const busy = g.ports.map((p) => [p, this.model.dispatchedAt[p.i][c]]).filter(([, u]) => u >= 0);
        const text = busy.length ? busy.map(([p, u]) => `${p.short}: ${uopLabel(this.model, u)}`).join(' · ') : 'none busy';
        this.setActive(-1, { x, y, textTip: [`${g.name} (${busy.length} of ${g.ports.length} busy), cycle ${c}`, text] });
        this.paint();
        return;
      }
    }
    if (this.state.strip === 'full' && y >= AXIS_H && y < AXIS_H + this.ports.length * PORT_H && x > this.G) {
      const p = this.ports[Math.floor((y - AXIS_H) / PORT_H)];
      const c = this.cycleAt(x);
      if (p && c >= this.c0 && c <= this.c1) {
        this.portHover = [p.i, c];
        const u = this.model.dispatchedAt[p.i][c];
        const r = u >= 0 ? this.rowOf.get(u) : undefined;
        this.setActive(r ?? -1, { x, y, portCycle: [p, c, u] });
        this.paint();
        return;
      }
    }
    const iy = AXIS_H + strip.length * PORT_H;
    if (this.model.issue && y >= iy && y < iy + ISSUE_H && x > this.G) {
      const c = this.cycleAt(x);
      const text = issueText(this.model.issue, c);
      if (text) { this.setActive(-1, { x, y, issueCycle: [c, text] }); this.paint(); return; }
    }
    this.setActive(y >= H ? this.rowAt(y) : -1, { x, y });
    this.paint();
  }

  onPointerDown(e) {
    this.canvas.focus({ preventScroll: true });
    if (this.ext?.down(e)) return; // a drag over the head selects cycles
    if (e.pointerType === 'mouse' && e.button === 0) {
      this.drag = { x: e.clientX, y: e.clientY, sl: this.scroller.scrollLeft, st: this.scroller.scrollTop, moved: false };
      this.canvas.setPointerCapture?.(e.pointerId);
      const up = (ev) => {
        this.canvas.removeEventListener('pointerup', up);
        this.canvas.releasePointerCapture?.(ev.pointerId);
        const moved = this.drag?.moved;
        this.drag = null;
        if (!moved) this.clickAt(ev);
      };
      this.canvas.addEventListener('pointerup', up);
    } else {
      this.clickAt(e);
    }
  }

  clickAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const row = this.rowAt(y);
    if (row >= 0) this.pick(row);
    if (row >= 0 && row === this.active && this.pinned) { this.pinned = false; return; }
    if (row >= 0) { this.pinned = true; this.setActive(row, { x, y }); this.paint(); }
  }

  // a row was clicked (or Enter): its instruction is selected; the page links it to the uop table
  pick(r) {
    const g = groupOfUop(this.model.uops[this.rows[r]]);
    this.selKey = groupKey(g);
    this.paint();
    this.onPickGroup?.(g);
  }

  // the uop table's row under the pointer (key: groupKey, or null)
  setLink(key) { if (key !== this.linkKey) { this.linkKey = key; this.paint(); } }
  setSel(key) { if (key !== this.selKey) { this.selKey = key; this.paint(); } }
  // scrolls to the first row of an instruction; false if it has none among the shown rows
  revealGroup(key) {
    for (let r = 0; r < this.rows.length; r++) {
      if (groupKey(this.model.uops[this.rows[r]]) !== key) continue;
      if (this.state.mode === 'table') { // the event table: its rows are this.rows
        const trs = this.tableBox.querySelector('tbody')?.rows ?? [];
        for (const t of this.tableBox.querySelectorAll('tr.tl-sel')) t.classList.remove('tl-sel');
        for (let k = r; k < this.rows.length; k++) if (groupKey(this.model.uops[this.rows[k]]) === key) trs[k]?.classList.add('tl-sel');
        trs[r]?.scrollIntoView({ block: 'nearest' });
        return true;
      }
      this.reveal(r);
      this.paint();
      return true;
    }
    return false;
  }

  onKey(e) {
    if (this.ext?.key(e)) return; // [ ] Esc: the cycle range
    const n = this.rows.length;
    const page = Math.max(1, Math.floor((this.viewH - this.headH()) / ROW_H) - 1);
    let r = this.active;
    switch (e.key) {
      case 'ArrowDown': r = Math.min(n - 1, r + 1); break;
      case 'ArrowUp': r = r < 0 ? 0 : Math.max(0, r - 1); break;
      case 'PageDown': r = Math.min(n - 1, Math.max(0, r) + page); break;
      case 'PageUp': r = Math.max(0, r - page); break;
      case 'Home': r = 0; break;
      case 'End': r = n - 1; break;
      case 'ArrowRight': this.scroller.scrollLeft += (e.shiftKey ? 0.8 * (this.viewW - this.G) : 4 * this.scale); e.preventDefault(); return;
      case 'ArrowLeft': this.scroller.scrollLeft -= (e.shiftKey ? 0.8 * (this.viewW - this.G) : 4 * this.scale); e.preventDefault(); return;
      case '+': case '=': this.zoomBy(1.6); e.preventDefault(); return;
      case '-': case '_': this.zoomBy(1 / 1.6); e.preventDefault(); return;
      case '0': this.fit(); e.preventDefault(); return;
      case 'Escape': this.pinned = false; this.setActive(-1); this.paint(); return;
      case 'Enter': if (r >= 0) { this.pick(r); e.preventDefault(); } return;
      default: return;
    }
    e.preventDefault();
    if (n === 0) return;
    this.pinned = true;
    this.reveal(r);
    this.setActive(r, null, { announce: true });
    this.paint();
  }

  // scrolls row r (and its dispatch, or its first event) into view
  reveal(r) {
    const H = this.headH();
    const top = r * ROW_H, vis = this.viewH - H;
    if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
    else if (top + ROW_H > this.scroller.scrollTop + vis) this.scroller.scrollTop = top + ROW_H - vis;
    const u = this.model.uops[this.rows[r]];
    const c = u.dispatched ?? u.issued ?? u.idq ?? u.iq;
    if (c !== null) {
      const x = (c - this.c0) * this.scale, w = this.viewW - this.G;
      if (x < this.scroller.scrollLeft + 8 || x > this.scroller.scrollLeft + w - 40) this.scroller.scrollLeft = Math.max(0, x - w / 3);
    }
    this.sl = this.scroller.scrollLeft;
  }

  setActive(r, at = null, { announce = false } = {}) {
    const changed = r !== this.active;
    this.active = r;
    const hk = r >= 0 ? groupKey(this.model.uops[this.rows[r]]) : null;
    if (hk !== this.hoverKey) { this.hoverKey = hk; this.onHoverGroup?.(r >= 0 ? groupOfUop(this.model.uops[this.rows[r]]) : null); }
    if (r < 0 && !(at && (at.portCycle || at.issueCycle || at.textTip))) { this.tip.hidden = true; this.canvas.removeAttribute('aria-activedescendant'); return; }
    if (changed || at?.portCycle || at?.issueCycle || at?.textTip || !this.tip.hidden || announce) this.showTip(r, at);
    if (announce && r >= 0) this.live.textContent = this.tipText(r);
  }

  showTip(r, at) {
    const m = this.model;
    const tip = this.tip;
    tip.replaceChildren();
    if (at?.textTip) {
      tip.append(el('p', { class: 'tt-head', text: at.textTip[0] }), el('p', { class: 'tt-sub', text: at.textTip[1] }));
      tip.dataset.key = ''; this.placeTip(at); tip.hidden = false; return;
    }
    if (at?.issueCycle) {
      tip.append(el('p', { class: 'tt-head', text: `issue, cycle ${at.issueCycle[0]}` }), el('p', { class: 'tt-sub', text: at.issueCycle[1] }));
      tip.dataset.key = ''; this.placeTip(at); tip.hidden = false; return;
    }
    if (at?.portCycle) {
      const [p, c, u] = at.portCycle;
      tip.append(el('p', { class: 'tt-head', text: `${p.name}, cycle ${c}` }));
      if (u < 0) tip.append(el('p', { class: 'tt-sub', text: 'no uop dispatched' }));
      else tip.append(el('p', { class: 'tt-sub', text: `dispatched: ${uopLabel(m, u)} (iteration ${m.uops[u].rnd})${this.rowSet.has(u) ? '' : ', not shown'}` }));
      if (r < 0) { tip.dataset.key = ''; this.placeTip(at); tip.hidden = false; return; }
    }
    const i = this.rows[r];
    const d = uopDetails(m, i, this.rowSet);
    tip.dataset.key = d.key;
    if (!at?.portCycle) {
      tip.append(el('p', { class: 'tt-head', text: d.label }));
      const kind = d.kind === 'instr' ? '' : ` · belongs to ${d.instruction}`;
      tip.append(el('p', { class: 'tt-sub', text: `iteration ${d.rnd} (the number in the margin)${kind}` }));
    }
    const dl = el('dl', { class: 'tt-stages' });
    const add = (name, value, field) => { dl.append(el('dt', { text: name }), el('dd', { 'data-stage': field, text: value })); };
    add('port', d.portName ?? (d.eliminated ? 'none (eliminated)' : '—'), 'port');
    for (const st of d.stages) {
      if (st.cycle === null && (st.field === 'iq' || st.field === 'idq')) continue;
      let v = st.cycle === null ? '—' : String(st.cycle);
      if (st.field === 'idq' && d.source && st.cycle !== null) v += ` (${d.source})`;
      add(st.name, v, st.field);
    }
    tip.append(dl);
    const notes = [];
    const cyc = (n) => `${n} cycle${n === 1 ? '' : 's'}`;
    if (d.waitOperands) notes.push(d.deps.length ? `waited ${cyc(d.waitOperands)} for operands` : `not ready for ${cyc(d.waitOperands)}`);
    if (d.waitPort) notes.push(`${notes.length ? '' : 'waited '}${cyc(d.waitPort)} for a port`);
    if (d.waitOperands !== null && d.issueDispatchDelay) notes.push(notes.length ? `beyond the ${d.issueDispatchDelay}-cycle issue → dispatch delay` : `dispatched as early as possible (${d.issueDispatchDelay} cycles after issue)`);
    if (notes.length) tip.append(el('p', { class: 'tt-wait', text: notes.join(', ') }));
    if (d.deps.length) {
      tip.append(el('p', { class: 'tt-sub', text: 'depends on:' }));
      tip.append(el('ul', { class: 'tt-deps' }, d.deps.map((x) => el('li', { text: `${x.label} [it ${x.rnd}]${x.executed !== null ? `, executed ${x.executed}` : ''}${x.shown ? '' : ' (not shown)'}` }))));
    } else if (d.kind === 'instr' || d.kind === 'stackSync' || d.kind === 'regMerge') {
      tip.append(el('p', { class: 'tt-sub', text: d.eliminated ? 'eliminated at rename: no execution port' : 'no inputs from earlier uops' }));
    }
    this.placeTip(at ?? this.anchorOf(r));
    tip.hidden = false;
  }

  anchorOf(r) {
    const u = this.model.uops[this.rows[r]];
    const c = u.dispatched ?? u.issued ?? u.idq ?? this.c0;
    return { x: Math.max(this.G, Math.min(this.viewW - 10, this.x(c))), y: this.headH() + r * ROW_H - this.scroller.scrollTop + ROW_H };
  }

  placeTip(at) {
    const tip = this.tip;
    tip.hidden = false;
    const cw = this.chart.clientWidth, ch = this.chart.clientHeight;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = at.x + 14, y = at.y + 14;
    if (x + tw > cw) x = Math.max(0, at.x - tw - 14);
    if (y + th > ch && at.y - th - 8 >= 0) y = at.y - th - 8;
    tip.style.left = `${Math.max(0, x)}px`;
    tip.style.top = `${Math.max(0, y)}px`;
  }

  tipText(r) {
    const d = uopDetails(this.model, this.rows[r], this.rowSet);
    const parts = [`${d.label}, iteration ${d.rnd}`, `port ${d.portName ?? 'none'}`];
    for (const st of d.stages) if (st.cycle !== null) parts.push(`${st.name} ${st.cycle}`);
    if (d.deps.length) parts.push(`depends on ${d.deps.map((x) => `${x.label} of iteration ${x.rnd}`).join(', ')}`);
    return parts.join('; ');
  }

  // for tests: the point (in canvas coordinates) on row r at cycle c
  pointOf(r, c) { return { x: this.x(c) + this.scale / 2, y: this.headH() + r * ROW_H - this.scroller.scrollTop + ROW_H / 2 }; }
}

function r0Rnd(v, rA) { return rA > 0 ? v.model.uops[v.rows[rA - 1]].rnd : -1; }

// Whether a run's trace is too large to request without asking: null, or {instrs, iterations}.
export function traceGuard(side) {
  const r = side?.response;
  if (r?.trace) return null;
  const instrs = (r?.rows ?? []).filter((x) => x.kind === 'instr').length;
  return traceEstimate(instrs, side?.request) > TRACE_LIMIT ? { instrs, iterations: side?.request?.minIterations ?? 10 } : null;
}

// The model of a run's trace (side: {response, request, archKey}; the response has the trace if it was made with it,
// otherwise the run is analyzed again with includeTrace). Resolves to {model, buildMs}; throws on failure.
// traceModel(request, opts): the model made by the analyzer's worker (engine-rpc.js), or null where there is no worker.
export async function loadTrace(side, { analyze, config = (_side) => null, traceModel = null }) {
  const r = side.response;
  let trace = r?.trace;
  let details = r?.details ?? null;
  const cfg0 = config(side);
  const opts = { portNames: cfg0?.portNames ?? null, retireWidth: cfg0?.retireWidth ?? null, issueDispatchDelay: cfg0?.issueDispatchDelay ?? null };
  const made = !trace && traceModel ? await traceModel({ ...side.request, includeTrace: true, details: true }, opts) : null;
  if (made) {
    const res = made.response;
    if (!res || res.error) throw new Error(`The trace could not be made: ${res?.error ?? 'no response'}`);
    if (!made.model) throw new Error('The analyzer returned no trace.');
    made.model.issue = issueLog(res.details ?? null);
    applyShownLabels(made.model, r?.rows, side.shown);
    return { model: made.model, buildMs: made.model.buildMs ?? 0 };
  }
  if (!trace) {
    const res = await analyze({ ...side.request, includeTrace: true, details: true }); // details: the issue strip
    if (!res || res.error) throw new Error(`The trace could not be made: ${res?.error ?? 'no response'}`);
    if (!res.trace) throw new Error('The analyzer returned no trace.');
    trace = res.trace;
    details = res.details ?? null;
  }
  const cfg = config(side);
  const t0 = performance.now();
  let model;
  try { model = buildModel(trace, { portNames: cfg?.portNames ?? null, retireWidth: cfg?.retireWidth ?? null, issueDispatchDelay: cfg?.issueDispatchDelay ?? null }); } catch (e) { throw new Error(`The trace could not be read: ${e?.message ?? e}`); }
  model.issue = issueLog(details);
  applyShownLabels(model, r?.rows, side.shown);
  return { model, buildMs: performance.now() - t0 };
}

const button = (text, f) => { const b = el('button', { type: 'button', class: 'plain', text }); b.addEventListener('click', f); return b; };
// the button past a size limit: the result's tabs press it when the view is picked (workspace.js)
const gate = (b) => { b.dataset.gate = ''; return b; };

// The panel in the result view: a <details> that shows the trace when it is opened. The trace of the shown run is
// loaded once, when the panel is opened or something else asks for it (want(): the wait column), and shared.
//   analyze(request) -> promise of a response (the engine's analyze); config(view) -> configs[arch] of uarch.json
//   onToggle(open): the panel was opened or closed; onHoverGroup(group | null), onPickGroup(group): a uop row of the
//   trace under the pointer / clicked, as its instruction (rowGroups); onTrace(): the state of the trace changed
// update(view) is called on every redraw of the result with the shown view ({response, request, archKey, ...});
// it returns the element to put into the result (always the same element).
export function createTracePanel({ analyze, config = (_view) => null, traceModel = null, onToggle = null, onHoverGroup = null, onPickGroup = null, onTrace = null }) {
  const body = el('div', { class: 'trace-body' });
  const summary = el('summary', { title: 'every uop of a few iterations, by cycle' }, 'cycle by cycle');
  const details = el('details', { class: 'trace-panel' }, summary, body);
  const state = { range: 'steady', mode: 'chart', scale: null, fit: true, scrollLeft: 0, scrollTop: 0 };
  let view = null, viewer = null;
  let tr = null;      // the trace of `view`: {view, state: 'idle' | 'loading' | 'ready' | 'error' | 'large' | 'mock', model, error, force}
  let linkKey = null, selKey = null;
  let pending = null; // {view, key}: scroll to this instruction once the trace is shown
  let lastOpen = false;

  // (no viewer: nothing to copy; while the trace is made, its control says so)
  const message = (text, ...extra) => { viewer?.destroy(); viewer = null; details.wuicaTrace = null; setCopy('trace', null); body.replaceChildren(el('p', { class: 'trace-msg', text }, ...extra)); };

  function want(force = false) {
    const v = view;
    if (!v) return;
    if (!tr || tr.view !== v) tr = { view: v, state: 'idle', model: null, error: null, force: false };
    if (force) tr.force = true;
    if (tr.state === 'loading' || tr.state === 'ready') return;
    if (v.response?.mock && !v.response?.trace) { tr.state = 'mock'; changed(); return; }
    if (traceGuard(v) && !tr.force) { tr.state = 'large'; changed(); return; }
    const t = tr;
    t.state = 'loading';
    changed();
    loadTrace(v, { analyze, config, traceModel }).then(({ model, buildMs }) => {
      if (tr !== t) return;
      t.state = 'ready'; t.model = model; t.buildMs = buildMs;
      changed();
    }, (e) => {
      if (tr !== t) return;
      t.state = 'error'; t.error = e;
      changed();
    });
  }

  function changed() { render(); onTrace?.(); }

  // (only while the panel is on the page: the panel of the other mode keeps its last view and loads nothing)
  function render() {
    if (!details.open || !details.isConnected) return;
    if (!tr || tr.view !== view || tr.state === 'idle') { if (view) want(); return; }
    if (tr.state === 'ready') {
      if (viewer && viewer.model === tr.model) return;
      viewer?.destroy();
      viewer = new Viewer(tr.model, state, { onHoverGroup: (g) => onHoverGroup?.(g), onPickGroup: (g) => { selKey = groupKey(g); onPickGroup?.(g); } });
      copyTrace([viewer]);
      viewer.view = view;
      viewer.linkKey = linkKey; viewer.selKey = selKey;
      viewer.root.dataset.buildMs = tr.buildMs.toFixed(1);
      body.replaceChildren(viewer.root);
      details.wuicaTrace = viewer; // for tests
      if (details.isConnected) viewer.attached();
      applyPending();
      return;
    }
    if (tr.state === 'mock') { message('The mock engine (?mock=1) has no traces.'); return; }
    if (tr.state === 'large') {
      const g = traceGuard(view);
      message(`The trace of ${g.instrs} instructions × ${g.iterations} iterations would be very large. `, gate(button('load it anyway', () => want(true))));
      return;
    }
    if (tr.state === 'loading') { message('simulating again with the trace…'); body.firstChild.classList.add('loading'); waitCopy('trace', 'the trace'); return; }
    const e = tr.error;
    const retry = () => { if (tr) tr.state = 'idle'; want(); };
    message(e?.name === 'CancelledError' ? 'The trace was cancelled. ' : `${String(e?.message ?? e).replace(/^(?!The trace)/, 'The trace could not be made: ')} `, button('try again', retry));
  }

  function applyPending() {
    if (!pending || !viewer || pending.view !== view) return;
    const { key } = pending;
    pending = null;
    if (viewer.revealGroup(key) && details.isConnected) viewer.root.scrollIntoView({ block: 'nearest' });
  }

  details.addEventListener('toggle', () => {
    if (details.open) render();
    if (details.open !== lastOpen) { lastOpen = details.open; onToggle?.(details.open); }
  });

  return {
    element: details,
    // the result view was redrawn (view: the shown run; the same object while the run is the same)
    update(v) {
      if (v !== view) {
        view = v;
        tr = null;
        linkKey = null;
        if (pending && pending.view !== v) pending = null;
        if (viewer) { viewer.destroy(); viewer = null; details.wuicaTrace = null; }
        setCopy('trace', null); // (the old result's trace: never copied for this one)
        state.scale = null; state.fit = true; state.scrollLeft = 0; state.scrollTop = 0;
        body.replaceChildren();
        render();
      }
      // after renderResult has put the element into the page: load (if open), restore the scroll position
      queueMicrotask(() => { if (!details.isConnected) return; if (viewer) viewer.attached(); else render(); });
      return details;
    },
    get open() { return details.open; },
    get view() { return view; },
    setOpen(open) { lastOpen = !!open; if (details.open !== !!open) details.open = !!open; },
    // the trace of the shown run: {state, model} (state 'none' before the first run); want(force) loads it
    trace() { return tr && tr.view === view ? { state: tr.state, model: tr.model, error: tr.error } : { state: view ? 'idle' : 'none', model: null }; },
    want,
    // the uop table's row under the pointer (a group of rowGroups, or null)
    highlight(g) { linkKey = groupKey(g); viewer?.setLink(linkKey); },
    // the selected instruction (or null); reveal: open the panel and scroll the trace to it
    select(g, { reveal = false } = {}) {
      selKey = groupKey(g);
      viewer?.setSel(selKey);
      if (!reveal || selKey === null) return;
      pending = { view, key: selKey };
      if (!details.open) return; // the trace is another tab: it scrolls there when it is opened (render: applyPending)
      applyPending();
    },
  };
}

// A–B: the traces of both blocks stacked, on one time axis (same scale, cycle 0 = where the same iteration starts on
// each side; abWindow), scrolled and zoomed together. A <details> like the single panel; both traces are loaded when it
// is opened. view: the A–B view of ab.js ({a, b, scale}; each side {response, request, archKey}).
export function createABTracePanel({ analyze, config = (_side) => null, traceModel = null, onToggle = null }) {
  const body = el('div', { class: 'trace-body' });
  const summary = el('summary', { title: 'A and B on one time axis' }, 'cycle by cycle');
  const details = el('details', { class: 'trace-panel trace-ab' }, summary, body);
  const ui = { range: 'steady', strip: 'compact', waits: 'short', lock: true };
  let view = null, job = null; // job: {view, state, models, error, force}
  let viewers = [], sync = null, lastOpen = false;
  const usable = (s) => !!s && !!s.request && !!s.response && typeof s.response === 'object' && !('error' in s.response) && Array.isArray(s.response.rows);

  const message = (text, ...extra) => { destroy(); setCopy('trace', null); body.replaceChildren(el('p', { class: 'trace-msg', text }, ...extra)); };
  function destroy() { for (const v of viewers) v.destroy(); viewers = []; sync = null; details.wuicaTraces = null; }

  function want(force = false) {
    const v = view;
    if (!v) return;
    if (!job || job.view !== v) job = { view: v, state: 'idle', models: null, error: null, force: false };
    if (force) job.force = true;
    if (job.state === 'loading' || job.state === 'ready') return;
    if (!usable(v.a) || !usable(v.b)) { job.state = 'missing'; render(); return; }
    if ((v.a.response.mock && !v.a.response.trace) || (v.b.response.mock && !v.b.response.trace)) { job.state = 'mock'; render(); return; }
    if ((traceGuard(v.a) || traceGuard(v.b)) && !job.force) { job.state = 'large'; render(); return; }
    const j = job;
    j.state = 'loading';
    render();
    (async () => {
      try {
        const a = await loadTrace(v.a, { analyze, config, traceModel });
        if (job !== j) return;
        const b = await loadTrace(v.b, { analyze, config, traceModel });
        if (job !== j) return;
        j.state = 'ready'; j.models = { a: a.model, b: b.model };
      } catch (e) {
        if (job !== j) return;
        j.state = 'error'; j.error = e;
      }
      render();
    })();
  }

  function render() {
    if (!details.open || !details.isConnected) return;
    if (!job || job.view !== view || job.state === 'idle') { if (view) want(); return; }
    if (job.state === 'ready') { if (!viewers.length) build(); return; }
    if (job.state === 'missing') { message('Both sides need a result.'); return; }
    if (job.state === 'mock') { message('The mock engine (?mock=1) has no traces.'); return; }
    if (job.state === 'large') { message('The traces would be very large. ', gate(button('load them anyway', () => want(true)))); return; }
    if (job.state === 'loading') { message('simulating both again with the trace…'); body.firstChild.classList.add('loading'); waitCopy('trace', 'the trace'); return; }
    const e = job.error;
    message(e?.name === 'CancelledError' ? 'The trace was cancelled. ' : `${String(e?.message ?? e).replace(/^(?!The trace)/, 'The trace could not be made: ')} `,
      button('try again', () => { if (job) job.state = 'idle'; want(); }));
  }

  // The rows of A that are B's (the same relative iteration, the instruction the diff aligns with, the same uop of it),
  // and back: for scrolling the two lists together. align: A's instruction index -> B's (null: the same index).
  function rowMaps(va, vb, align) {
    const key = (v, u, map) => `${u.rnd - v.fixed.from}/${map ? map.get(u.instrID) : u.instrID}/${u.n}/${u.kind}`;
    const inv = align ? new Map([...align].map(([a, b]) => [b, a])) : null;
    const index = (v, map) => { const out = new Map(); v.rows.forEach((i, r) => { const k = key(v, v.model.uops[i], map); if (!out.has(k)) out.set(k, r); }); return out; };
    const inB = index(vb, null), inA = index(va, null);
    return {
      aToB: Int32Array.from(va.rows, (i) => inB.get(key(va, va.model.uops[i], align)) ?? -1),
      bToA: Int32Array.from(vb.rows, (i) => inA.get(key(vb, vb.model.uops[i], inv)) ?? -1),
    };
  }
  // A's instruction index -> B's, from the comparison's alignment (ab-diff.js: one unit per instruction)
  function alignment(v) {
    const rows = v?.cmp?.diff?.rows;
    if (!rows) return null;
    const map = new Map();
    let ia = 0, ib = 0;
    for (const r of rows) { const a = r.a ? ia++ : null, b = r.b ? ib++ : null; if (a !== null && b !== null) map.set(a, b); }
    return map;
  }

  function build() {
    destroy();
    const { a: ma, b: mb } = job.models;
    const span = (m, rows) => shownSpan(m, rows, ui.waits);
    const w = abWindow(ma, mb, { choice: ui.range, scale: view.scale ?? 1, span });
    sync = new TimeSync(w.lo, w.hi);
    // the same trace on both sides (the same code, or code that runs the same): shown once, and said
    const same = sameTrace(ma, w.a, mb, w.b);
    const st = () => ({ range: 'fixed', mode: 'chart', scale: null, fit: true, scrollLeft: 0, scrollTop: 0, strip: ui.strip, waits: ui.waits });
    const va = new Viewer(ma, st(), { sync, fixed: w.a, tag: same ? 'A = B' : 'A' });
    const vb = same ? null : new Viewer(mb, st(), { sync, fixed: w.b, tag: 'B', compare: va });
    viewers = vb ? [va, vb] : [va];
    copyTrace(viewers);
    sync.viewers = viewers;

    // scrolled together when the rows line up (the diff's alignment), unless unlocked
    let maps = null, following = false;
    if (vb) {
      maps = rowMaps(va, vb, alignment(view));
      sync.follow = (from) => {
        if (!ui.lock || following) return;
        const to = from === va ? vb : va, map = from === va ? maps.aToB : maps.bToA;
        const top = from.scroller.scrollTop, r = Math.floor(top / ROW_H);
        let k = Math.max(0, r);
        while (k < map.length && map[k] < 0) k++;
        if (k >= map.length) return;
        const t = map[k] * ROW_H + (k === r ? top - r * ROW_H : 0);
        if (Math.abs(to.scroller.scrollTop - t) < 1) return;
        following = true;
        to.scroller.scrollTop = t;
        requestAnimationFrame(() => { following = false; });
      };
    }

    const sel = el('select', { class: 'trace-ab-range' }, el('option', { value: 'steady', text: 'steady state' }), el('option', { value: 'all', text: 'all iterations' }));
    sel.value = ui.range;
    sel.addEventListener('change', () => { ui.range = sel.value === 'all' ? 'all' : 'steady'; build(); });
    const label = el('span', { class: 'trace-scale', 'aria-live': 'polite' });
    const zoomBtn = (text, aria, f) => { const b = el('button', { type: 'button', class: 'trace-zoom', 'aria-label': aria, title: aria, text }); b.addEventListener('click', f); return b; };
    const lock = vb ? el('button', { type: 'button', class: 'trace-toggle trace-lock', title: 'scroll A and B together (their rows line up)', 'aria-pressed': String(ui.lock), text: '⇅' }) : null;
    lock?.addEventListener('click', () => { ui.lock = !ui.lock; lock.setAttribute('aria-pressed', String(ui.lock)); if (ui.lock) sync.follow(va); });
    const controls = traceControls(ui, (k) => {
      if (k === 'waits') { build(); return; }
      for (const v of viewers) { v.state.strip = ui.strip; v.labelCache.clear(); }
      sync.relayout();
    }, { ab: true, extra: lock ? [lock] : [] });
    const tools = el('div', { class: 'trace-tools' },
      el('label', { class: 'inline' }, 'show ', sel),
      el('span', { class: 'trace-zoomtools' },
        zoomBtn('−', 'zoom out', () => va.zoomBy(1 / 1.6)), zoomBtn('+', 'zoom in', () => va.zoomBy(1.6)), zoomBtn('fit', 'fit the cycles to the width', () => va.fit()), label, controls.el));
    const relayout = sync.relayout.bind(sync);
    sync.relayout = () => {
      relayout();
      if (sync?.scale) label.textContent = sync.scale >= 0.95 ? `${+sync.scale.toFixed(1)} px per cycle` : `${+(1 / sync.scale).toFixed(1)} cycles per px`;
    };
    const note = same ? el('p', { class: 'trace-same hint', text: 'A and B: the same trace' }) : null;
    body.replaceChildren(el('div', { class: 'trace-viewer trace-ab-view' }, tools, controls.pop, note, ...viewers.map((v) => v.root)));
    details.wuicaTraces = { a: va, b: vb ?? va, same, sync, window: w, maps, ui, controls }; // for tests
    if (details.isConnected) attached();
  }

  function attached() {
    if (!sync) return;
    sync.relayout();
    for (const v of viewers) { v.scroller.scrollLeft = v.state.scrollLeft ?? 0; v.scroller.scrollTop = v.state.scrollTop ?? 0; v.paint(); }
  }

  details.addEventListener('toggle', () => {
    if (details.open) render();
    if (details.open !== lastOpen) { lastOpen = details.open; onToggle?.(details.open); }
  });

  return {
    element: details,
    update(v) {
      if (v !== view) {
        view = v;
        job = null;
        destroy();
        setCopy('trace', null);
        body.replaceChildren();
        render();
      }
      queueMicrotask(() => { if (!details.isConnected) return; if (sync) attached(); else render(); });
      return details;
    },
    get open() { return details.open; },
    setOpen(open) { lastOpen = !!open; if (details.open !== !!open) details.open = !!open; },
  };
}
