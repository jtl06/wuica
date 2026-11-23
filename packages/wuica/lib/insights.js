// What the web page's bound view shows (web/js/bound.js), for the compact form (summarize(), the MCP `analyze` JSON):
// how busy each resource is as a share of the predicted cycles, the next limit after the bottleneck, the critical chain,
// and the instructions with the largest share of the binding resource. Derived from the response only (no analysis).
// tests-js/web_bound.mjs checks that it agrees with the page on the built-in examples.

const FRONT = new Set(['MITE', 'MS', 'DSB', 'LSD']);
const COUNTS = new Set(['Issued', 'Exec.']);
const isPort = (c) => !FRONT.has(c) && !COUNTS.has(c);
const EPS = 0.005;
const SATURATED = 0.95;
const round = (x) => Math.round(x * 100) / 100;

const total = (r, i) => r.rows.reduce((s, x) => s + (Number(x.values?.[i]) || 0), 0);

// The weight of each row in a resource (as the page's blame()), or null.
function weights(r, id) {
  const col = (name) => r.columns.indexOf(name);
  const fromColumn = (i) => (i < 0 ? null : r.rows.map((x) => Number(x.values?.[i]) || 0));
  if (id === 'Ports') {
    const ports = r.columns.map((c, i) => ({ i, t: isPort(c) && c !== 'Div' ? total(r, i) : 0 })).filter((p) => p.t > 0);
    if (!ports.length) return null;
    const top = Math.max(...ports.map((p) => p.t));
    const hot = ports.filter((p) => p.t >= SATURATED * top);
    return { w: r.rows.map((x) => hot.reduce((s, p) => s + (Number(x.values?.[p.i]) || 0), 0)), ports: hot.map((p) => r.columns[p.i]) };
  }
  if (id === 'Issue') return { w: fromColumn(col('Issued')) };
  if (FRONT.has(id)) return { w: fromColumn(col(id)) };
  if (id === 'Decoder') {
    const i = col('MITE');
    if (i >= 0 && total(r, i) > 0) return { w: fromColumn(i) };
    return { w: r.rows.map((x) => (x.kind === 'instr' && x.notes !== 'M' ? 1 : 0)) };
  }
  if (id === 'Predecoder') return { w: r.rows.map((x) => (x.kind === 'instr' ? String(x.opcode ?? '').length / 2 : 0)) };
  if (id === 'Divider') return { w: fromColumn(col('Div')) };
  if (id === 'Dependencies') {
    const edges = r.criticalPath?.edges;
    if (!Array.isArray(edges) || !edges.length) return null;
    const w = r.rows.map(() => 0);
    for (const e of edges) if (e.from >= 0 && e.from < w.length) w[e.from] += Number(e.latency) || 0;
    return { w };
  }
  return null;
}

// {utilization, binding, largest?, next?, unexplained?, chain?, hot?} or null.
//   utilization: {limit or port column: cycles / tp} (1 = busy every cycle; above 1: uiCA's bound is above the simulation)
//   binding: the bottleneck(s) uiCA names (the response's `bottlenecks`; [] when it names none: no single limit explains
//            tp, the page says "unknown")
//   largest: when uiCA names none, the largest limit(s): the nearest bound, which alone does not reach tp
//   next: {limit, tp, maxSpeedup}: the largest limit below the binding one; tp / next.tp is an upper bound of the speedup
//   unexplained: cycles per iteration that no single limit explains
//   chain: the critical loop-carried chain: [{index, instr, operand, latency, carried}] (index into `instructions`)
//   hot: {resource, ports?, instructions: [{index, instr, share}]}: the largest shares of the binding resource (top 5)
export function insights(r) {
  const tp = Number(r?.tp);
  if (!(tp > 0) || !Array.isArray(r.limits) || !Array.isArray(r.rows) || !Array.isArray(r.columns)) return null;
  const utilization = {};
  for (const l of r.limits) utilization[l.name] = round(l.tp / tp);
  r.columns.forEach((c, i) => { if (isPort(c)) { const t = total(r, i); if (t > 0) utilization[c] = round(t / tp); } });
  const limits = r.limits.map((l) => ({ name: l.name, tp: Number(l.tp) }));
  const max = limits.length ? Math.max(...limits.map((l) => l.tp)) : 0;
  // the cycles of a bottleneck: its limit; the divider (no limit of its own): the Div column
  const divCol = r.columns.indexOf('Div');
  const valueOf = (name) => limits.find((l) => l.name === name)?.tp ?? (name === 'Divider' && divCol >= 0 ? total(r, divCol) : 0);
  const binding = [...(r.bottlenecks ?? [])];
  const largest = binding.length ? [] : limits.filter((l) => l.tp >= max - EPS).map((l) => l.name);
  const top = binding.length ? binding : largest;
  const bindValue = Math.max(0, ...top.map(valueOf));
  let next = null;
  for (const l of limits) if (!top.includes(l.name) && l.tp < bindValue - EPS && (!next || l.tp > next.tp)) next = { limit: l.name, tp: l.tp };
  const out = { utilization, binding };
  if (largest.length) out.largest = largest;
  if (next) out.next = { ...next, maxSpeedup: next.tp > 0 ? round(tp / next.tp) : null };
  if (limits.length && tp - max > EPS) out.unexplained = round(tp - max);
  const edges = r.criticalPath?.edges;
  if (Array.isArray(edges) && edges.length) {
    out.chain = edges.map((e) => ({ index: e.from, instr: r.rows[e.from]?.label, operand: String(e.operand).toLowerCase(), latency: e.latency, carried: !!e.carried }));
  }
  if (top[0]) {
    const b = weights(r, top[0]);
    const sum = b?.w?.reduce((s, x) => s + x, 0) ?? 0;
    if (b?.w && sum > 0) {
      const shares = b.w.map((x, index) => ({ index, share: x / sum })).filter((x) => x.share > 0)
        .sort((a, c) => c.share - a.share || a.index - c.index).slice(0, 5)
        .map((x) => ({ index: x.index, instr: r.rows[x.index].label, share: round(x.share) }));
      out.hot = { resource: top[0], ...(b.ports ? { ports: b.ports } : {}), instructions: shares };
    }
  }
  return out;
}
