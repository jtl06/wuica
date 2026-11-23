// A cycle range of the trace (VTune's timeline selection): what the ports and the issue slots did in just those cycles,
// for the bound view (bound.js) and the trace's head (trace.js). The range is chosen in the trace (trace-range-view.js);
// this module keeps it (one range on the page, for the run and trace it was chosen on) and tells its subscribers once
// per animation frame.
//
// No DOM (tests-js/web_trace_range.mjs runs it under Node).

import { columnKind } from './render.js';

// the issue slots of a range: the keys of slots.js, and slots lost outside the issue log (no cause known there)
export const RANGE_SLOTS = Object.freeze([
  ['issued', 'issued', 'slots that issued a uop'],
  ['frontEnd', 'front end', 'lost: the front end delivered too few uops (the IDQ ran empty)'],
  ['rob', 'ROB', 'lost: the reorder buffer was full'],
  ['rs', 'RS', 'lost: the scheduler (reservation station) was full'],
  ['other', 'other', 'lost: the next uop did not fit into the cycle, a serializing instruction, or merge uops'],
  ['unknown', 'lost', 'lost: outside the steady state, where the simulation logs no cause'],
]);
const CAUSE_KEY = { F: 'frontEnd', R: 'rob', S: 'rs', O: 'other', '.': 'other' };

// a..b within the trace's cycles, in order: [lo, hi], or null
export function clampRange(model, a, b) {
  if (!model || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const lo = Math.max(0, Math.min(a, b)), hi = Math.min(model.nCycles - 1, Math.max(a, b));
  return hi >= lo ? [Math.floor(lo), Math.floor(hi)] : null;
}

// the fused uops the trace issues in each cycle (Int32Array(nCycles)), once per model
const issuedCache = new WeakMap();
export function issuedPerCycle(model) {
  let out = issuedCache.get(model);
  if (out) return out;
  out = new Int32Array(model.nCycles);
  let last = null;
  for (const u of model.uops) { // in order: the unfused uops of one fused uop are next to each other
    if (u.issued === null || u.fUopID === null || u.issued < 0 || u.issued >= model.nCycles) continue;
    const k = `${u.rnd}/${u.instrID}/${u.lamUopID}/${u.fUopID}`;
    if (k === last) continue;
    last = k;
    out[u.issued]++;
  }
  issuedCache.set(model, out);
  return out;
}

// The cycles a..b (inclusive, clamped to the trace) of a trace model (trace.js buildModel; model.issue: the issue log of
// trace-issue.js, or null):
//   {a, b, cycles,
//    ports: [{id, name, short, uops, share}]  the ports with uops in the trace; share = cycles with a dispatch / cycles
//    slots: {width, cycles, logged, issued, frontEnd, rob, rs, other, unknown} | null  issue slots, in slots (width ×
//           cycles in all); the cause of the lost ones from the issue log where it covers the cycle (logged: how many do)}
// or null if the range has no cycle of the trace.
export function rangeStats(model, a, b) {
  const r = clampRange(model, a, b);
  if (!r) return null;
  const [lo, hi] = r, n = hi - lo + 1;
  const ports = [];
  model.ports.forEach((p, i) => {
    if (!(p.used > 0)) return;
    const pre = model.prefix[i];
    const uops = pre[hi + 1] - pre[lo];
    ports.push({ id: p.id, name: p.name, short: p.short, uops, share: uops / n });
  });
  const log = model.issue ?? null;
  const width = Number(model.params?.issueWidth) || log?.width || 0;
  let slots = null;
  if (width > 0) {
    const iss = issuedPerCycle(model);
    slots = { width, cycles: n, logged: 0, issued: 0, frontEnd: 0, rob: 0, rs: 0, other: 0, unknown: 0 };
    for (let c = lo; c <= hi; c++) {
      const k = log ? c - log.first : -1;
      if (log && k >= 0 && k < log.issued.length) {
        const got = Math.min(width, log.issued[k]);
        slots.logged++;
        slots.issued += got;
        slots[CAUSE_KEY[log.cause[k]] ?? 'other'] += width - got;
      } else {
        const got = Math.min(width, iss[c]);
        slots.issued += got;
        slots.unknown += width - got;
      }
    }
  }
  return { a: lo, b: hi, cycles: n, ports, slots };
}

// [{key, name, title, slots, share}] of the slots of rangeStats, the empty parts left out
export function rangeSlotParts(slots) {
  if (!slots) return [];
  const total = slots.width * slots.cycles;
  if (!(total > 0)) return [];
  return RANGE_SLOTS.map(([key, name, title]) => ({ key, name, title, slots: slots[key], share: slots[key] / total })).filter((p) => p.slots > 0);
}

// The steady-state share of each port from the response (as the bound view has it: uops per iteration / cycles per
// iteration), by the column name; a Map, empty without a usable response.
export function steadyShares(response) {
  const out = new Map();
  const tp = Number(response?.tp);
  if (!(tp > 0) || !Array.isArray(response.columns) || !Array.isArray(response.rows)) return out;
  response.columns.forEach((name, i) => {
    if (columnKind(name) !== 'port' || name === 'Div') return; // the divider: busy cycles, not dispatches
    let t = 0;
    for (const x of response.rows) t += Number(x.values?.[i]) || 0;
    out.set(name, t / tp);
  });
  return out;
}

// ---- the range of the page ------------------------------------------------------------------------------------------

// {view, model, a, b} (a <= b, within the trace) or null; view: the run the trace was made for (the result view)
let current = null;
const subscribers = new Set();
let scheduled = false;
const frame = (f) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(f) : setTimeout(f, 0));
function notify() {
  if (scheduled) return;
  scheduled = true;
  frame(flush);
}
// calls the subscribers now (tests; the frame that was scheduled finds nothing to do)
export function flush() {
  if (!scheduled) return;
  scheduled = false;
  for (const f of subscribers) f(current);
}

export const traceRange = {
  get: () => current,
  // the range of a run's trace model; null clears
  set(view, model, a, b) {
    const r = clampRange(model, a, b);
    if (!r) return this.clear();
    if (current && current.view === view && current.model === model && current.a === r[0] && current.b === r[1]) return current;
    current = { view, model, a: r[0], b: r[1] };
    notify();
    return current;
  },
  clear(model = null) {
    if (!current || (model && current.model !== model)) return null;
    current = null;
    notify();
    return null;
  },
  // f(range | null) after each change (once per frame); returns the unsubscribe function
  subscribe(f) { subscribers.add(f); return () => subscribers.delete(f); },
  // the range if it belongs to this run
  of(view) { return current && current.view === view ? current : null; },
};
