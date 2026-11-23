// Latencies and slack for the dependency arcs (deps.js). No DOM (tests-js/web_deps_slack.mjs runs it under Node).
//
// Latency of an arc (producer → consumer): the edges of the critical chain carry the simulator's own latency
// (response.criticalPath); every other arc gets the latency of the producer's output that the consumer reads, from the
// instruction data of the response with details (docs/WASM-API.md, details.rows[].uopList: outputs with their latency,
// inputs), registers compared by their full register (EAX = RAX, XMM1 = YMM1). If no output matches (an implicit operand),
// the producer's largest latency; flags only if it writes no register.
//
// The chain's latencies are the simulator's; the others are estimates (shown with ≈). On the chain's edges of the
// examples on SKL, ZEN3 and ADL-P the estimate equals the simulator's latency on 41 of 48 (1,384 of 1,392 with SHA-256);
// the others are memory edges and special cases such as pointer chasing and the stack pointer's sync uop.
//
// Slack of an instruction: how many cycles it could be delayed in every iteration without making the loop-carried chain
// longer. With P the chain's cycles per iteration and each arc weighted latency − P × iterations crossed, no cycle of
// the graph weighs more than 0 (the chain weighs 0); the slack of an instruction is minus the heaviest cycle through it:
// 0 on the chain, Infinity if it is on no loop-carried cycle (delaying it never lengthens the chain).

const GPR8 = { AL: 'RAX', AH: 'RAX', BL: 'RBX', BH: 'RBX', CL: 'RCX', CH: 'RCX', DL: 'RDX', DH: 'RDX', SIL: 'RSI', DIL: 'RDI', BPL: 'RBP', SPL: 'RSP' };
const GPR16 = { AX: 'RAX', BX: 'RBX', CX: 'RCX', DX: 'RDX', SI: 'RSI', DI: 'RDI', BP: 'RBP', SP: 'RSP' };

// "RAX" for EAX/AX/AL, "R8" for R8D, "V1" for XMM1/YMM1/ZMM1; address registers without brackets; flags as they are
export function canonReg(name) {
  let r = String(name ?? '').trim();
  if (r.startsWith('flags')) return r;
  r = r.replace(/^\[|\]$/g, '').toUpperCase();
  if (GPR8[r]) return GPR8[r];
  if (GPR16[r]) return GPR16[r];
  let m = /^E(AX|BX|CX|DX|SI|DI|BP|SP)$/.exec(r);
  if (m) return 'R' + m[1];
  m = /^(R\d+)[DWB]$/.exec(r);
  if (m) return m[1];
  m = /^[XYZ]MM(\d+)$/.exec(r);
  if (m) return 'V' + m[1];
  return r;
}

// an instruction's outputs {reg: latency} and inputs (Set of regs) from its details row (uopList); pseudo values skipped
function operands(det) {
  const out = new Map(), inp = new Set();
  for (const u of det?.uopList ?? []) {
    for (const x of u.inputs ?? []) if (x !== 'pseudo') inp.add(canonReg(x));
    for (const o of u.outputs ?? []) {
      if (!Array.isArray(o) || o[0] === 'pseudo') continue;
      const k = canonReg(o[0]);
      out.set(k, Math.max(out.get(k) ?? 0, Number(o[1]) || 0));
    }
  }
  // an instruction without uops of its own (a folded or eliminated one): its latency pairs
  if (!out.size) {
    for (const l of det?.latencies ?? []) {
      const k = canonReg(l.to);
      out.set(k, Math.max(out.get(k) ?? 0, Number(l.cycles) || 0));
      if (l.from !== 'mem') inp.add(canonReg(l.from));
    }
  }
  return { out, inp };
}

// the latency of producer → consumer from their details rows, or null without details
export function edgeLatency(prodDet, consDet) {
  if (!prodDet) return null;
  if (prodDet.mayBeEliminated) return 0; // a move that renaming can eliminate: 0, as in uiCA's chain
  const p = operands(prodDet), c = operands(consDet);
  let lat = -1;
  for (const [reg, l] of p.out) if (c.inp.has(reg)) lat = Math.max(lat, l);
  if (lat >= 0) return lat;
  const regs = [...p.out].filter(([reg]) => !reg.startsWith('flags'));
  for (const [, l] of regs.length ? regs : [...p.out]) lat = Math.max(lat, l);
  return lat >= 0 ? lat : null;
}

// Sets e.lat on every edge of a graph of depGraph() (deps.js): the chain's own latency, else from the details (null: unknown).
export function annotateLatencies(graph, response, details) {
  if (!graph) return graph;
  const rows = Array.isArray(details?.rows) && details.rows.length === response?.rows?.length ? details.rows : null;
  for (const e of graph.edges) {
    e.lat = rows ? edgeLatency(rows[graph.nodes[e.a].row], rows[graph.nodes[e.b].row]) : null;
  }
  const idx = new Map(graph.nodes.map((n, i) => [n.row, i]));
  const chain = new Map(); // "a>b>carried" -> the largest latency of the chain's edges there
  for (const c of response?.criticalPath?.edges ?? []) {
    const a = idx.get(c.from), b = idx.get(c.to);
    if (a === undefined || b === undefined) continue;
    const k = `${a}>${b}>${!!c.carried}`;
    chain.set(k, Math.max(chain.get(k) ?? 0, Number(c.latency) || 0));
  }
  for (const e of graph.edges) {
    const l = chain.get(`${e.a}>${e.b}>${e.dist > 0}`);
    if (e.critical && l !== undefined) e.lat = l;
  }
  return graph;
}

// Tarjan's strongly connected components, iterative: comp[i] (component number), and the size of each
function components(n, succ) {
  const index = new Int32Array(n).fill(-1), low = new Int32Array(n), comp = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n), stack = [], sizes = [];
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] >= 0) continue;
    const work = [[s, 0]];
    index[s] = low[s] = next++; stack.push(s); onStack[s] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const v = top[0];
      if (top[1] < succ[v].length) {
        const w = succ[v][top[1]++].b;
        if (index[w] < 0) { index[w] = low[w] = next++; stack.push(w); onStack[w] = 1; work.push([w, 0]); }
        else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        work.pop();
        if (work.length) { const u = work[work.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
        if (low[v] === index[v]) {
          const c = sizes.length; let size = 0, w;
          do { w = stack.pop(); onStack[w] = 0; comp[w] = c; size++; } while (w !== v);
          sizes.push(size);
        }
      }
    }
  }
  return { comp, sizes };
}

// a binary min-heap of [key, node]
function heap() {
  const a = [];
  return {
    get size() { return a.length; },
    push(k, v) { a.push([k, v]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } },
    pop() {
      const top = a[0], last = a.pop();
      if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
      return top;
    },
  };
}

const EPS = 1e-9;
export const SLACK_BUDGET = 4e6; // nodes × edges of the components searched; above it the slack is not computed

// {slack: Float64Array (Infinity: on no loop-carried cycle; NaN: not computed), period} or null (no latencies, no
// chain, or a cycle heavier than the chain: the latencies do not fit the period)
export function slackOf(graph, period, opts = {}) {
  const it = slackSteps(graph, period, opts);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

// the same in slices of about `slice` ms, for large graphs (the page stays responsive); pause() yields to the page
export async function slackOfAsync(graph, period, { slice = 25, pause = () => new Promise((r) => setTimeout(r, 0)), ...opts } = {}) {
  const it = slackSteps(graph, period, opts);
  let t0 = performance.now();
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    if (performance.now() - t0 > slice) { await pause(); t0 = performance.now(); }
  }
}

// the work, as a generator that yields every so often
function* slackSteps(graph, period, { budget = SLACK_BUDGET } = {}) {
  const n = graph?.nodes?.length ?? 0;
  const P = Number(period);
  if (!n || !(P > 0) || graph.edges.some((e) => e.lat === null || e.lat === undefined)) return null;
  const succ = Array.from({ length: n }, () => []), pred = Array.from({ length: n }, () => []);
  for (const e of graph.edges) { const x = { a: e.a, b: e.b, w: e.lat - P * e.dist }; succ[e.a].push(x); pred[e.b].push(x); }
  // potentials: the heaviest path from anywhere (Bellman-Ford with a queue); a cycle heavier than 0 never settles
  const pi = new Float64Array(n), inQ = new Uint8Array(n).fill(1), count = new Int32Array(n);
  const q = [...Array(n).keys()];
  for (let h = 0; h < q.length; h++) {
    const v = q[h]; inQ[v] = 0;
    for (const x of succ[v]) {
      if (pi[v] + x.w > pi[x.b] + EPS) {
        pi[x.b] = pi[v] + x.w;
        if (!inQ[x.b]) { if (++count[x.b] > n) return null; inQ[x.b] = 1; q.push(x.b); }
      }
    }
    if (h > 64 && h * 2 > q.length) { q.splice(0, h + 1); h = -1; } // keep the queue short
    if ((h & 1023) === 0) yield;
  }
  const { comp, sizes } = components(n, succ);
  const slack = new Float64Array(n).fill(Infinity);
  // the work per component: its nodes × its edges
  const edgesIn = new Float64Array(sizes.length);
  for (const e of graph.edges) if (comp[e.a] === comp[e.b]) edgesIn[comp[e.a]]++;
  let work = 0;
  for (let c = 0; c < sizes.length; c++) if (edgesIn[c] > 0) work += sizes[c] * edgesIn[c];
  if (work > budget) { for (let v = 0; v < n; v++) if (edgesIn[comp[v]] > 0) slack[v] = NaN; return { slack, period: P, partial: true }; }
  // reduced costs ≥ 0: the cheapest way around back to v is minus the heaviest cycle through it
  const cost = (x) => Math.max(0, -(x.w + pi[x.a] - pi[x.b]));
  const dist = new Float64Array(n).fill(Infinity);
  for (let v = 0; v < n; v++) {
    if (!(edgesIn[comp[v]] > 0)) continue;
    const touched = [v];
    dist[v] = 0;
    const hp = heap();
    hp.push(0, v);
    let best = Infinity;
    while (hp.size) {
      const [d, u] = hp.pop();
      if (d > dist[u] || d >= best) continue;
      for (const x of succ[u]) {
        if (comp[x.b] !== comp[v]) continue;
        const nd = d + cost(x);
        if (x.b === v) { if (nd < best) best = nd; continue; }
        if (nd < dist[x.b]) { if (dist[x.b] === Infinity) touched.push(x.b); dist[x.b] = nd; hp.push(nd, x.b); }
      }
    }
    for (const t of touched) dist[t] = Infinity;
    slack[v] = best < EPS ? 0 : best;
    yield;
  }
  return { slack, period: P, partial: false };
}

// "3", "1.5", "∞", "" (not computed)
export function fmtSlack(x) {
  if (Number.isNaN(x)) return '';
  if (x === Infinity) return '∞';
  const r = Math.round(x * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
