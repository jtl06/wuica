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

// The range menu: [{id, label, from, to}]; the first entry is the default (a few iterations of the steady state).
export function rangeChoices(model, few = 3) {
  const { first, last } = model.relevant;
  const out = [];
  const to = Math.min(model.nRounds - 1, first + few - 1);
  const it = (a, b) => (a === b ? `iteration ${a}` : `iterations ${a}–${b}`);
  out.push({ id: 'steady', label: `steady state: ${it(first, to)}`, from: first, to });
  if (last > to) out.push({ id: 'relevant', label: `all steady-state: ${it(first, last)}`, from: first, to: last });
  out.push({ id: 'all', label: `all: ${it(0, Math.max(0, model.nRounds - 1))}`, from: 0, to: Math.max(0, model.nRounds - 1) });
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

export function toTSV(model, rows) {
  const clean = (s) => String(s).replace(/[\t\n]/g, ' ');
  return [TABLE_HEAD, ...tableRows(model, rows)].map((r) => r.map(clean).join('\t')).join('\n') + '\n';
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

const COLOR_VARS = ['background', 'surface', 'text', 'subtle', 'description', 'accent', 'accent-dim', 'border', 'heading', 'code', 'external', 'caveat'];
const ROW_H = 16, PORT_H = 9, AXIS_H = 18, HEAD_GAP = 6, PAD = 24;
const MIN_SCALE = 0.25, MAX_SCALE = 48;
let idSeq = 0;

// The legend: [class of the swatch, text]. The swatches are drawn by trace.css with the same colours.
const LEGEND = [
  ['q', 'in the IDQ (front end → issue)'],
  ['sched', 'issued: the issue → dispatch delay'],
  ['dep', 'not ready: waiting for operands'],
  ['port', 'ready, waiting for a port'],
  ['exec', 'dispatched → executed (port number on the bar)'],
  ['rob', 'executed, waiting to retire'],
  ['ret', 'retired'],
  ['elim', 'eliminated (no port)'],
];

class Viewer {
  constructor(model, state, { onState }) {
    this.model = model;
    this.state = state; // {range, mode, scale, scrollLeft, scrollTop}: kept by the panel across re-renders
    this.onState = onState;
    this.choices = rangeChoices(model);
    if (!this.choices.some((c) => c.id === state.range)) state.range = this.choices[0].id;
    this.ports = model.ports.map((p, i) => ({ ...p, i })).filter((p) => p.used > 0);
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
    this.zoomTools = el('span', { class: 'trace-zoomtools' },
      zoomBtn('−', 'zoom out', () => this.zoomBy(1 / 1.6)),
      zoomBtn('+', 'zoom in', () => this.zoomBy(1.6)),
      zoomBtn('fit', 'fit the cycles to the width', () => this.fit()),
      this.zoomLabel);
    const tools = el('div', { class: 'trace-tools' },
      el('label', { class: 'inline' }, 'show ', this.rangeSel),
      el('span', { class: 'trace-mode', role: 'radiogroup', 'aria-label': 'view' },
        el('label', null, this.modeChart, ' chart'), el('label', null, this.modeTable, ' table')),
      this.zoomTools);

    this.canvas = el('canvas', { class: 'trace-canvas', tabindex: '0', role: 'application',
      'aria-roledescription': 'trace timeline',
      'aria-label': 'Timeline of the uops by cycle. Arrow keys move between uops and show their details; + and − zoom. The table view lists the same events.',
      'aria-describedby': `${id}-live` });
    this.sizer = el('div', { class: 'trace-sizer' }, this.canvas);
    this.scroller = el('div', { class: 'trace-scroll' }, this.sizer);
    this.tip = el('div', { class: 'trace-tip', role: 'tooltip', id: `${id}-tip`, hidden: true });
    this.live = el('p', { class: 'trace-live', id: `${id}-live`, 'aria-live': 'polite' });
    this.probe = el('span', { class: 'trace-probe', 'aria-hidden': 'true' });
    this.chart = el('div', { class: 'trace-chart' }, this.scroller, this.tip, this.probe);
    this.legend = el('ul', { class: 'trace-legend', 'aria-label': 'legend' },
      LEGEND.map(([k, t]) => el('li', null, el('span', { class: `sw sw-${k}`, 'aria-hidden': 'true' }), t)));
    this.note = el('p', { class: 'trace-note hint' });
    this.tableBox = el('div', { class: 'trace-tablebox', hidden: true });
    this.root = el('div', { class: 'trace-viewer' }, tools, this.chart, this.legend, this.note, this.tableBox, this.live);

    this.scroller.addEventListener('scroll', () => {
      this.state.scrollLeft = this.scroller.scrollLeft;
      this.state.scrollTop = this.scroller.scrollTop;
      if (!this.pinned && this.active >= 0 && this.pointer) this.hoverAt(this.pointer.x, this.pointer.y);
      this.paint();
    }, { passive: true });
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerleave', () => { this.pointer = null; if (!this.pinned) { this.setActive(-1); this.portHover = null; this.paint(); } });
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return; // a plain wheel scrolls
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left);
    }, { passive: false });
    this.canvas.addEventListener('keydown', (e) => this.onKey(e));
    this.canvas.addEventListener('blur', () => { if (this.pinned) { this.pinned = false; this.setActive(-1); this.paint(); } });
    this.resizer = new ResizeObserver(() => this.layout());
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
  }

  // called when the element is (again) in the document: the scroll position is lost when it is moved
  attached() {
    this.layout();
    this.scroller.scrollLeft = this.state.scrollLeft ?? 0;
    this.scroller.scrollTop = this.state.scrollTop ?? 0;
    this.paint();
  }

  setMode(mode) {
    this.state.mode = mode;
    this.chart.hidden = mode === 'table';
    this.legend.hidden = mode === 'table';
    this.zoomTools.hidden = mode === 'table';
    this.tableBox.hidden = mode !== 'table';
    if (mode === 'table') this.renderTable(); else { this.tableBox.replaceChildren(); this.attached(); }
    this.onState();
  }

  setRange(id, { keepScale }) {
    const c = this.choices.find((x) => x.id === id) ?? this.choices[0];
    this.state.range = c.id;
    this.rangeSel.value = c.id;
    this.rows = selectRows(this.model, c.from, c.to);
    this.rowSet = new Set(this.rows);
    this.rowOf = new Map(Array.from(this.rows, (u, r) => [u, r]));
    [this.c0, this.c1] = cycleSpan(this.model, this.rows);
    this.active = -1;
    this.pinned = false;
    this.tip.hidden = true;
    const hiddenPorts = this.model.ports.length - this.ports.length;
    const { first, last, tp } = this.model.relevant;
    this.note.textContent = `${this.rows.length} uops in cycles ${this.c0}–${this.c1}. Steady state (what the throughput is computed from): iterations ${first}–${last}`
      + (tp !== null ? `, ${tp} cycles per iteration` : '') + '.' + (hiddenPorts ? ` ${hiddenPorts} port${hiddenPorts === 1 ? '' : 's'} without uops not shown.` : '');
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
  gutter() { return Math.round(Math.min(280, Math.max(130, this.viewW * 0.34))); }
  headH() { return AXIS_H + this.ports.length * PORT_H + HEAD_GAP; }
  x(c) { return this.G + (c - this.c0) * this.scale - this.sl; }
  cycleAt(px) { return Math.floor((px - this.G + this.sl) / this.scale) + this.c0; }

  layout() {
    if (!this.scroller.isConnected || this.chart.hidden) return;
    const w = this.scroller.clientWidth;
    if (!w) return;
    this.viewW = w;
    this.G = this.gutter();
    const span = this.c1 - this.c0 + 1;
    if (this.state.scale === null || this.state.fit !== false) { this.state.scale = this.fitScale(); this.state.fit = true; } // follows the width until zoomed
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.state.scale));
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
    this.state.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * f));
    this.state.fit = false;
    this.layout();
    this.scroller.scrollLeft = Math.max(0, c * this.scale - (ax - this.G));
    this.paint();
  }

  fit() { this.state.fit = true; this.layout(); this.scroller.scrollLeft = 0; }

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
    const hoverCycle = this.pointer && this.pointer.x > G ? this.cycleAt(this.pointer.x) : null;

    // body
    ctx.save();
    ctx.beginPath(); ctx.rect(0, H, W, Hv - H); ctx.clip();
    for (let r = rA; r < rB; r++) {
      const u = this.rows[r];
      if (u === activeU || related.has(u)) {
        ctx.fillStyle = C['accent-dim'];
        ctx.fillRect(0, rowY(r), W, ROW_H);
      }
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(G, H, W - G, Hv - H); ctx.clip();
    ctx.fillStyle = C.border;
    for (let c = Math.ceil(cA / step) * step; c <= cB; c += step) ctx.fillRect(Math.round(this.x(c)), H, 1, Hv - H);
    if (hoverCycle !== null && hoverCycle >= this.c0 && hoverCycle <= this.c1) {
      ctx.globalAlpha = 0.6; ctx.fillStyle = C['accent-dim']; ctx.fillRect(this.x(hoverCycle), 0, Math.max(1, s), Hv); ctx.globalAlpha = 1;
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
    for (let c = Math.ceil(cA / step) * step; c <= cB; c += step) {
      const x = Math.round(this.x(c));
      ctx.fillStyle = C.border; ctx.fillRect(x, AXIS_H - 5, 1, 5);
      ctx.fillStyle = C.subtle; ctx.fillText(String(c), x + 2, AXIS_H / 2 - 1);
    }
    for (let p = 0; p < this.ports.length; p++) this.drawPortStrip(ctx, this.ports[p], AXIS_H + p * PORT_H, cA, cB);
    if (hoverCycle !== null && hoverCycle >= this.c0 && hoverCycle <= this.c1) {
      ctx.globalAlpha = 0.6; ctx.fillStyle = C['accent-dim']; ctx.fillRect(this.x(hoverCycle), 0, Math.max(1, s), H); ctx.globalAlpha = 1;
    }
    ctx.restore();
    // port names and their use in the shown cycles
    ctx.fillStyle = C.subtle;
    ctx.fillText('cycle', 6, AXIS_H / 2 - 1);
    ctx.font = `10px ${C.font.slice(5)}`;
    const span = this.c1 - this.c0 + 1;
    for (let p = 0; p < this.ports.length; p++) {
      const port = this.ports[p];
      const y = AXIS_H + p * PORT_H + PORT_H / 2;
      const n = m.prefix[port.i][this.c1 + 1] - m.prefix[port.i][this.c0];
      ctx.fillStyle = C.subtle;
      ctx.textAlign = 'left';
      ctx.fillText(port.short, 6, y);
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round((100 * n) / span)}%`, G - 6, y);
    }
    ctx.textAlign = 'left';
    ctx.font = C.font;
    ctx.fillStyle = C.border;
    ctx.fillRect(0, H - 1, W, 1);
    ctx.fillRect(G - 1, 0, 1, Hv);
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
        const a = Math.max(this.c0, Math.floor((x - this.G + this.sl) / s) + this.c0);
        const b = Math.min(this.c1 + 1, Math.floor((x + 1 - this.G + this.sl) / s) + this.c0);
        if (b <= a) continue;
        const f = (pre[b] - pre[a]) / (b - a);
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
    // front end: predecoded -> IDQ (faint), IDQ -> issued
    if (u.iq !== null && u.idq !== null) line(u.iq, u.idq, C.subtle, 0.45);
    const fe = u.idq ?? u.iq;
    line(fe, u.issued, C.subtle);
    if (u.idq !== null) { ctx.fillStyle = C.subtle; ctx.fillRect(X(u.idq), y + 4, Math.max(1, Math.min(2, s)), ROW_H - 8); }
    const end = this.c1 + 1;
    if (u.inRS || u.dispatched !== null) {
      const ready = u.ready ?? (u.dispatched !== null ? u.dispatched : end);
      const disp = u.dispatched ?? end;
      const sched = u.issued === null ? null : Math.min(ready, u.issued + this.model.issueDispatchDelay);
      if (sched !== null && sched > u.issued) { // the fixed delay between issue and the earliest dispatch
        ctx.fillStyle = C.subtle; ctx.globalAlpha = 0.55;
        ctx.fillRect(X(u.issued), y + 6, (sched - u.issued) * s, ROW_H - 12);
        ctx.globalAlpha = 1;
      }
      if (sched !== null && ready > sched) { // not ready: waiting for operands
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
    if (y >= AXIS_H && y < AXIS_H + this.ports.length * PORT_H && x > this.G) {
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
    this.setActive(y >= H ? this.rowAt(y) : -1, { x, y });
    this.paint();
  }

  onPointerDown(e) {
    this.canvas.focus({ preventScroll: true });
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
    if (row >= 0 && row === this.active && this.pinned) { this.pinned = false; return; }
    if (row >= 0) { this.pinned = true; this.setActive(row, { x, y }); this.paint(); }
  }

  onKey(e) {
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
    if (r < 0 && !(at && at.portCycle)) { this.tip.hidden = true; this.canvas.removeAttribute('aria-activedescendant'); return; }
    if (changed || at?.portCycle || !this.tip.hidden || announce) this.showTip(r, at);
    if (announce && r >= 0) this.live.textContent = this.tipText(r);
  }

  showTip(r, at) {
    const m = this.model;
    const tip = this.tip;
    tip.replaceChildren();
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
      tip.append(el('p', { class: 'tt-sub', text: `iteration ${d.rnd}${kind}` }));
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

// The panel in the result view: a <details> that loads the trace when it is opened.
//   analyze(request) -> promise of a response (the engine's analyze)
// update(view) is called on every redraw of the result with the shown view ({response, request, archKey, ...});
// it returns the element to put into the result (always the same element).
export function createTracePanel({ analyze, config = () => null }) {
  const body = el('div', { class: 'trace-body' });
  const summary = el('summary', null, 'Cycle-by-cycle trace ', el('span', { class: 'hint', text: 'every uop of a few iterations, by cycle' }));
  const details = el('details', { class: 'trace-panel' }, summary, body);
  const state = { range: 'steady', mode: 'chart', scale: null, fit: true, scrollLeft: 0, scrollTop: 0 };
  let view = null, viewer = null, loading = null, force = false;

  const message = (text, ...extra) => { viewer?.destroy(); viewer = null; body.replaceChildren(el('p', { class: 'trace-msg', text }, ...extra)); };
  const button = (text, f) => { const b = el('button', { type: 'button', class: 'plain', text }); b.addEventListener('click', f); return b; };

  function show(v, trace) {
    let model;
    const t0 = performance.now();
    const cfg = config(v);
    try { model = buildModel(trace, { portNames: cfg?.portNames ?? null, retireWidth: cfg?.retireWidth ?? null, issueDispatchDelay: cfg?.issueDispatchDelay ?? null }); } catch (e) { message(`The trace could not be read: ${e?.message ?? e}`); return; }
    const buildMs = performance.now() - t0;
    viewer?.destroy();
    viewer = new Viewer(model, state, { onState: () => {} });
    viewer.root.dataset.buildMs = buildMs.toFixed(1);
    body.replaceChildren(viewer.root);
    details.wuicaTrace = viewer; // for tests
    viewer.attached();
  }

  function load() {
    const v = view;
    if (!v || !details.open) return;
    if (viewer && viewer.view === v) return;
    if (loading && loading.view === v) return;
    const r = v.response;
    if (r?.trace) { show(v, r.trace); viewer.view = v; return; }
    if (r?.mock) { message('The mock engine (?mock=1) has no traces.'); return; }
    const instrs = (r?.rows ?? []).filter((x) => x.kind === 'instr').length;
    const est = traceEstimate(instrs, v.request);
    if (est > TRACE_LIMIT && !force) {
      message(`The trace of ${instrs} instructions × ${v.request?.minIterations ?? 10} iterations would be very large. `,
        button('load it anyway', () => { force = true; load(); }));
      return;
    }
    message('simulating again with the trace…');
    body.firstChild.classList.add('loading');
    const p = { view: v };
    loading = p;
    (async () => {
      try {
        const res = await analyze({ ...v.request, includeTrace: true });
        if (view !== v || loading !== p) return;
        loading = null;
        if (!res || res.error) { message(`The trace could not be made: ${res?.error ?? 'no response'}`, ' ', button('try again', load)); return; }
        if (!res.trace) { message('The analyzer returned no trace.'); return; }
        show(v, res.trace);
        viewer.view = v;
      } catch (e) {
        if (view !== v || loading !== p) return;
        loading = null;
        const cancelled = e?.name === 'CancelledError';
        message(cancelled ? 'The trace was cancelled. ' : `The trace could not be made: ${e?.message ?? e}. `, button('try again', load));
      }
    })();
  }

  details.addEventListener('toggle', () => { if (details.open) load(); });

  return {
    element: details,
    // the result view was redrawn (view: the shown run; the same object while the run is the same)
    update(v) {
      if (v !== view) {
        view = v;
        force = false;
        loading = null;
        if (viewer) { viewer.destroy(); viewer = null; }
        state.scale = null; state.fit = true; state.scrollLeft = 0; state.scrollTop = 0;
        body.replaceChildren();
        if (details.open) load();
      }
      // after renderResult has put the element into the page: restore the scroll position
      queueMicrotask(() => { if (viewer && details.isConnected) viewer.attached(); });
      return details;
    },
    get open() { return details.open; },
  };
}
