// The bound model of a response, without the DOM: how busy each resource is as a share of the predicted cycles, the
// binding resource, the next limit after it, which instructions use a resource (blame), and the compact form of all
// that the npm package returns as `insights` (REST, MCP, the CLI's -json). One module for the page (bound.js, icard.js,
// srcmap.js render it) and the package (its copy in packages/wuica/lib/web, web-modules.json).

import { caveats } from './caveats.js';

const EPS = 0.005; // values are shown with two decimals
const LIMIT_GROUP = { Issue: 'issue', Ports: 'ports', Dependencies: 'deps' }; // the rest: front end
const FE_COLUMN = { DSB: 'DSB', LSD: 'LSD', MS: 'MS' };
const SATURATED = 0.95; // "Ports": the ports at least this busy relative to the busiest one
const FRONT_END = ['MITE', 'MS', 'DSB', 'LSD'];
const COUNTS = ['Issued', 'Exec.'];

const sum = (a) => a.reduce((s, x) => s + x, 0);
const pct = (u) => `${Math.round(u * 100)}%`;
const f2 = (x) => Number(x).toFixed(2);
const round = (x) => Math.round(x * 100) / 100;

// The kind of a column of the uop table: 'front' (uops from the decoders, the DSB, the LSD, the MS), 'count' (issued,
// executed), 'port' ("Port 0", "ALU0", "FP2", "Div", ...: every other column is an execution resource).
export function columnKind(name) {
  if (FRONT_END.includes(name)) return 'front';
  if (COUNTS.includes(name)) return 'count';
  return 'port';
}

// "Port 0" -> "p0"; Zen 3's names (ALU0, FP2, ...) and Div as they are
export function shortPort(name) {
  const m = /^Port (\w+)$/.exec(name);
  return m ? `p${m[1]}` : name === 'Div' ? 'div' : name;
}

function columnTotal(r, i) {
  let t = 0;
  for (const x of r.rows) t += Number(x.values?.[i]) || 0;
  return t;
}

// The resources of a response:
// {tp, items: [{id, name, title, group, cycles, util, limit, bottleneck}], binding: [ids], next: {name, tp, speedup} | null,
//  gap}. util = cycles / tp (1: busy every cycle; above 1: uiCA's bound is above the simulated throughput).
// binding: the bottlenecks uiCA names that are resources here (the divider: its Div column); when it names none, the
// largest limit(s), the nearest bound. A bottleneck without a limit of its own ("Scheduling") binds nothing here: no
// resource is marked and there is no next limit (until 0.1.9 the page then took the largest limits as binding and showed
// the next limit below them, which is no bound once the scheduling goes; the package's insights had it right).
// next: the largest limit below the binding one; speedup = tp / next.tp is an upper bound (the next limit is a lower
// bound of the cycles). gap: cycles that no single limit explains (interactions), 0 if none.
export function boundModel(r) {
  const tp = Number(r?.tp);
  if (!(tp > 0) || !Array.isArray(r.limits) || !Array.isArray(r.columns) || !Array.isArray(r.rows)) return null;
  const bottlenecks = Array.isArray(r.bottlenecks) ? r.bottlenecks : [];
  const items = [];
  for (const l of r.limits) {
    const c = Number(l.tp);
    if (!Number.isFinite(c)) continue;
    items.push({
      id: l.name, name: l.name, group: LIMIT_GROUP[l.name] ?? 'front', cycles: c, util: c / tp, limit: true,
      bottleneck: bottlenecks.includes(l.name),
      title: `${l.name}: ${f2(c)} cycles/iteration if it were the only bottleneck (${pct(c / tp)} of ${f2(tp)})`,
    });
  }
  r.columns.forEach((name, i) => {
    if (columnKind(name) !== 'port') return;
    const c = columnTotal(r, i);
    if (c <= 0) return;
    const div = name === 'Div';
    items.push({
      id: `col:${name}`, name: shortPort(name), group: 'ports', cycles: c, util: c / tp, limit: false, bottleneck: false,
      title: div ? `divider: busy ${f2(c)} cycles/iteration (${pct(c / tp)})` : `${name}: ${f2(c)} uops/iteration, busy ${pct(c / tp)} of the cycles`,
    });
  });
  const limits = items.filter((x) => x.limit);
  const max = limits.length ? Math.max(...limits.map((x) => x.cycles)) : 0;
  const gap = limits.length && tp - max > EPS ? tp - max : 0;
  if (gap) {
    items.push({ id: 'other', name: 'unexplained', group: 'other', cycles: gap, util: gap / tp, limit: false, bottleneck: false,
      title: `${f2(gap)} cycles/iteration that no single limit explains (interactions between front end, ports and dependencies)` });
  }
  const binding = bottlenecks.map((b) => resourceId(r, b)).filter((b) => items.some((x) => x.id === b));
  if (!bottlenecks.length) for (const x of limits) if (x.cycles >= max - EPS) binding.push(x.id);
  const bindValue = Math.max(...binding.map((b) => items.find((x) => x.id === b).cycles), 0);
  /** @type {{name: string, tp: number, speedup?: number} | null} */
  let next = null;
  for (const x of limits) if (!binding.includes(x.id) && x.cycles < bindValue - EPS && (!next || x.cycles > next.tp)) next = { name: x.name, tp: x.cycles };
  if (next) next.speedup = next.tp > 0 ? tp / next.tp : Infinity;
  return { tp, items, binding, next, gap };
}

// The resource of a bottleneck's name: the divider (no limit of its own) is its Div column
const resourceId = (r, name) => (name === 'Divider' && r.columns.includes('Div') ? 'col:Div' : name);

// The share of each row of the response in a resource: {weights, total, max, unit, ports, portColumns} or null (nothing
// to attribute).
//   col:<name>  the row's uops on that port (or cycles on the divider)
//   Ports       its uops on the saturated ports (at least 95 % as busy as the busiest port); ports: their short names,
//               portColumns: the columns
//   Issue       its issued (fused) uops; DSB, LSD, MS: its uops from there
//   Decoder     its uops from the legacy decoders (MITE); every instruction once if none come from there
//   Predecoder  its bytes
//   Dependencies  the latency of the chain's edges that start at it
export function blame(r, id) {
  const n = r.rows.length;
  const w = new Float64Array(n);
  const col = (name) => r.columns.indexOf(name);
  const fromColumn = (i) => { for (let k = 0; k < n; k++) w[k] = Number(r.rows[k].values?.[i]) || 0; };
  let unit = 'uops';
  if (id.startsWith('col:')) {
    const i = col(id.slice(4));
    if (i < 0) return null;
    fromColumn(i);
    if (id === 'col:Div') unit = 'cycles';
  } else if (id === 'Ports') {
    const ports = r.columns.map((name, i) => ({ i, name, t: columnKind(name) === 'port' && name !== 'Div' ? columnTotal(r, i) : 0 })).filter((p) => p.t > 0);
    if (!ports.length) return null;
    const top = Math.max(...ports.map((p) => p.t));
    const hot = ports.filter((p) => p.t >= SATURATED * top);
    for (let k = 0; k < n; k++) w[k] = sum(hot.map((p) => Number(r.rows[k].values?.[p.i]) || 0));
    return finish(w, unit, hot.map((p) => p.name));
  } else if (id === 'Issue') {
    const i = col('Issued');
    if (i < 0) return null;
    fromColumn(i);
  } else if (FE_COLUMN[id]) {
    const i = col(FE_COLUMN[id]);
    if (i < 0) return null;
    fromColumn(i);
  } else if (id === 'Decoder') {
    const i = col('MITE');
    if (i >= 0 && columnTotal(r, i) > 0) fromColumn(i);
    else { unit = 'instructions'; r.rows.forEach((x, k) => { w[k] = x.kind === 'instr' && x.notes !== 'M' ? 1 : 0; }); }
  } else if (id === 'Predecoder') {
    unit = 'bytes';
    r.rows.forEach((x, k) => { w[k] = x.kind === 'instr' ? String(x.opcode ?? '').length / 2 : 0; });
  } else if (id === 'Dependencies') {
    const edges = r.criticalPath?.edges;
    if (!Array.isArray(edges) || !edges.length) return null;
    unit = 'cycles';
    for (const e of edges) if (e.from >= 0 && e.from < n) w[e.from] += Number(e.latency) || 0;
  } else {
    return null;
  }
  return finish(w, unit, null);
}

function finish(w, unit, columns) {
  let total = 0, max = 0;
  for (const x of w) { total += x; if (x > max) max = x; }
  if (!(total > 0)) return null;
  return { weights: w, total, max, unit, ports: columns ? columns.map(shortPort) : null, portColumns: columns };
}

// The rows with the largest shares: [{row, share}], largest first (ties: in table order).
export function topRows(b, count = 5) {
  if (!b) return [];
  const out = [];
  b.weights.forEach((x, row) => { if (x > 0) out.push({ row, share: x / b.total }); });
  out.sort((a, c) => c.share - a.share || a.row - c.row);
  return out.slice(0, count);
}

// The resource selected by default: the first bottleneck (or the largest limit).
export const defaultResource = (m) => m?.binding[0] ?? null;

// The package's insights (the bound model in its compact form):
// {utilization, binding, largest?, next?, unexplained?, chain?, hot?, caveats?} or null.
//   utilization: {limit or port column: cycles / tp} (1 = busy every cycle; above 1: uiCA's bound is above the simulation)
//   binding: the bottlenecks uiCA names (the response's `bottlenecks`; [] when it names none: no single limit explains
//            tp, the page says "unknown")
//   largest: when uiCA names none, the largest limit(s): the nearest bound, which alone does not reach tp
//   next: {limit, tp, maxSpeedup}: the largest limit below the binding one; tp / next.tp is an upper bound of the speedup
//   unexplained: cycles per iteration that no single limit explains
//   chain: the critical loop-carried chain: [{index, instr, operand, latency, carried}] (index into `instructions`)
//   hot: {resource, ports?, instructions: [{index, instr, share}]}: the largest shares of the binding resource (top 5)
//   caveats: [{id, text, title, instructions: [index]}]: known blind spots the block meets (caveats.js); absent if none
// config: the CPU's configuration in uarch.json (configs[r.arch]), for the caveats; without it, split warns as on a CPU
// without a split-load cost.
/** @param {any} r @param {{splitLoadCycles?: number} | null} [config] */
export function insights(r, config = null) {
  const m = boundModel(r);
  if (!m) return null;
  const tp = m.tp;
  const utilization = {};
  for (const l of r.limits) utilization[l.name] = round(l.tp / tp);
  for (const x of m.items) if (x.id.startsWith('col:')) utilization[x.id.slice(4)] = round(x.util);
  const binding = [...(r.bottlenecks ?? [])];
  const largest = binding.length ? [] : m.binding;
  /** @type {Record<string, any>} */
  const out = { utilization, binding };
  if (largest.length) out.largest = largest;
  if (m.next) out.next = { limit: m.next.name, tp: m.next.tp, maxSpeedup: m.next.tp > 0 ? round(tp / m.next.tp) : null };
  if (m.gap) out.unexplained = round(m.gap);
  const edges = r.criticalPath?.edges;
  if (Array.isArray(edges) && edges.length) {
    out.chain = edges.map((e) => ({ index: e.from, instr: r.rows[e.from]?.label, operand: String(e.operand).toLowerCase(), latency: e.latency, carried: !!e.carried }));
  }
  const top = binding.length ? binding : largest;
  if (top[0]) {
    const b = blame(r, resourceId(r, top[0]));
    if (b) {
      const instructions = topRows(b).map((x) => ({ index: x.row, instr: r.rows[x.row].label, share: round(x.share) }));
      out.hot = { resource: top[0], ...(b.portColumns ? { ports: b.portColumns } : {}), instructions };
    }
  }
  const cv = caveats(r, config);
  if (cv.length) out.caveats = cv.map((c) => ({ id: c.id, text: c.text, title: c.title, instructions: c.rows }));
  return out;
}
