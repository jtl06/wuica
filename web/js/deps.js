// The dependency arcs: which instruction feeds which, as the simulation renamed them (uiCA's "Dependencies" view, OSACA's
// dependency graph, perf annotate's jump arrows): one line per instruction, an arc from each producer to its consumer
// (solid: the same iteration; dashed: into the next one), the critical chain highlighted. The edges come from the trace
// (the `dependsOn` of the uops of one steady-state iteration): register, flag and address dependencies; eliminated moves
// pass their producer on; dependencies through memory appear where they are on the critical chain (criticalPath). Arrow keys move through the instructions, Enter jumps to the row in the uop table. The trace is
// requested only when the view is opened; a large one waits for a click.
//
// The first half has no DOM (tests-js/web_deps.mjs runs it under Node).

import { h } from './render.js';
import { jumpToRow } from './rowjump.js';
import { annotateLatencies, slackOfAsync, fmtSlack } from './deps-slack.js'; // latency per arc, slack per instruction
import { setCopy } from './copy-view.js';
import { depsMd } from './md-views.js';

// as the trace view (trace.js): a trace grows with instructions × iterations; above this many uops it waits for a click
const TRACE_LIMIT = 20000;
const traceEstimate = (instrs, request) => Math.max(instrs * Math.max(1, request?.minIterations ?? 10), 4 * (request?.minCycles ?? 500));

// {nodes: [{row, label}], edges: [{a, b, dist, critical}], round, lanes} or null.
//   a, b: indices into nodes (producer, consumer); dist: iterations between them (0: the same iteration)
//   round: the iteration whose uops were read (the middle of the simulation)
export function depGraph(response, trace) {
  const rows = response?.rows;
  if (!Array.isArray(rows) || !Array.isArray(trace?.cycles) || !Array.isArray(trace?.instructions)) return null;
  const nodes = [];
  rows.forEach((x, row) => { if (x.kind === 'instr') nodes.push({ row, label: x.label }); });
  if (nodes.length !== trace.instructions.length) return null;
  let last = -1;
  for (const c of trace.cycles) for (const u of c.addedToRS ?? []) if (u.rnd > last) last = u.rnd;
  if (last < 0) return { nodes, edges: [], round: null, lanes: 0 };
  const round = Math.floor(last / 2);
  const seen = new Map();
  for (const c of trace.cycles) {
    for (const u of c.addedToRS ?? []) {
      if (u.rnd !== round) continue;
      for (const d of u.dependsOn ?? []) {
        const dist = round - d.rnd;
        if (dist < 0 || (dist === 0 && d.instrID === u.instrID)) continue; // within one instruction (its own uops)
        const k = `${d.instrID}>${u.instrID}>${dist}`;
        if (!seen.has(k) && d.instrID >= 0 && d.instrID < nodes.length && u.instrID >= 0 && u.instrID < nodes.length) seen.set(k, { a: d.instrID, b: u.instrID, dist, critical: false });
      }
    }
  }
  const edges = [...seen.values()].sort((x, y) => x.b - y.b || x.a - y.a || x.dist - y.dist);
  // the critical chain (response.criticalPath, rows of the uop table)
  const k = new Map(nodes.map((n, i) => [n.row, i]));
  // (a value passed through memory is not in the trace's dependsOn: such an edge of the chain is added, marked `mem`)
  for (const e of response.criticalPath?.edges ?? []) {
    const a = k.get(e.from), b = k.get(e.to);
    if (a === undefined || b === undefined) continue;
    let found = false;
    for (const x of edges) if (x.a === a && x.b === b && (x.dist > 0) === !!e.carried) { x.critical = true; found = true; }
    if (!found) edges.push({ a, b, dist: e.carried ? 1 : 0, critical: true, mem: String(e.operand).toLowerCase() === 'mem' });
  }
  // lanes: the shortest arcs nearest to the text; an arc takes the first lane free over its whole span
  const busy = [];
  const order = edges.map((e, i) => i).sort((i, j) => span(edges[i]) - span(edges[j]) || Math.min(edges[i].a, edges[i].b) - Math.min(edges[j].a, edges[j].b));
  for (const i of order) {
    const e = edges[i];
    const lo = Math.min(e.a, e.b), hi = Math.max(e.a, e.b);
    let lane = 0;
    for (;; lane++) {
      const l = busy[lane] ?? (busy[lane] = []);
      if (!l.some(([x, y]) => lo <= y && x <= hi)) { l.push([lo, hi]); break; }
    }
    e.lane = lane;
  }
  return { nodes, edges, round, lanes: busy.length };
}
const span = (e) => Math.abs(e.a - e.b);

// What a node reads and feeds: {reads: [{node, dist, critical}], feeds: [...]}
export function neighbours(g, i) {
  return {
    reads: g.edges.filter((e) => e.b === i).map((e) => ({ node: e.a, dist: e.dist, critical: e.critical })),
    feeds: g.edges.filter((e) => e.a === i).map((e) => ({ node: e.b, dist: e.dist, critical: e.critical })),
  };
}

// ---- the view ----------------------------------------------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...children) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined && v !== false) e.setAttribute(k, String(v));
  for (const c of children) if (c) e.append(c);
  return e;
}
const ROW = 18, CH = 7.25, LABEL = 38, PAD = 8, SL = 4 * CH; // SL: the slack column
const short = (t, n = LABEL) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const isCancel = (e) => e?.name === 'CancelledError';
const yieldToPage = () => new Promise((r) => setTimeout(r, 0));

// env: { engine(), onToggle(open) }
export function createDeps(env) {
  let open = false;
  let row = null, details = null, body = null, hint = null;
  let root = null, view = null;
  let cache = { key: null, graph: null, error: null }; // the graph of the last trace
  let pending = null, forcedKey = null, sel = 0;

  function ensureRow() {
    if (row?.isConnected) return row;
    hint = h('span', { class: 'hint dp-hint' });
    details = h('details', { class: 'dp', id: 'deps' }, h('summary', { title: 'which instruction feeds which, in one iteration of the simulation' }, 'dependency arcs', hint));
    details.open = open;
    let last = open;
    details.addEventListener('toggle', () => {
      if (details.open === last) return;
      last = open = details.open;
      env.onToggle?.(open);
      update();
    });
    body = h('div', { class: 'dp-body' });
    details.append(body);
    row = h('div', { class: 'row', id: 'deps-row' }, h('div', { class: 'label', text: 'deps' }), h('div', { class: 'field' }, details));
    const more = document.getElementById('more');
    const before = document.getElementById('sweep-row');
    if (before?.parentNode === more) more.insertBefore(row, before); else more?.append(row);
    return row;
  }

  const keyOf = (v) => JSON.stringify([v.hex, v.archKey, v.request]);

  async function load(v, key) {
    if (pending === key) return;
    pending = key;
    body.dataset.state = 'loading';
    body.replaceChildren(h('p', { class: 'hint', text: 'tracing…' }));
    let graph = null, error = null;
    try {
      const e = env.engine();
      if (e.depGraph) { // made in the analyzer's worker: the page does not receive the trace (engine-rpc.js)
        const made = await e.depGraph(v.request);
        if (made?.error) error = made.error; else graph = made?.graph ?? null;
      } else {
        const res = await e.analyze({ ...v.request, includeTrace: true, details: true });
        await yieldToPage(); // a large trace: receiving it, building the graph and drawing it are separate tasks
        if (res?.error) error = res.error; else graph = depGraph(v.response, res.trace);
        await yieldToPage();
        if (graph) annotateLatencies(graph, v.response, res.details);
      }
      if (graph) {
        await yieldToPage();
        graph.slack = await slackOfAsync(graph, v.response.criticalPath?.ratio, { slice: 12 });
        if (pending !== key) return;
      }
      if (!graph && !error) error = 'the trace does not match the table';
    } catch (e) {
      if (isCancel(e)) { pending = null; if (view === v) update(); return; }
      error = e?.message ?? String(e);
    }
    if (pending !== key) return;
    pending = null;
    cache = { key, graph, error };
    if (view && keyOf(view) === key) { sel = 0; paint(); }
  }

  function draw(g) {
    const n = g.nodes.length;
    const lane = g.lanes > 40 ? Math.max(2, 240 / g.lanes) : 6;
    const X0 = LABEL * CH + SL + PAD;
    const slack = g.slack?.slack ?? null;
    const onChain = new Set();
    for (const e of g.edges) if (e.critical) { onChain.add(e.a); onChain.add(e.b); }
    const latText = (e) => (e.lat === null || e.lat === undefined ? '' : String(+Number(e.lat).toFixed(2)));
    const W = X0 + (g.lanes + 1) * lane + 10;
    const H = n * ROW + 4;
    const y = (i) => i * ROW + ROW / 2 + 2;
    const svg = s('svg', { class: 'dp-map', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'listbox', tabindex: '0',
      'aria-label': 'instructions and their dependencies; arrow keys move, Enter shows the row', 'aria-activedescendant': `dp-i${sel}` });
    const defs = s('defs', null, s('marker', { id: 'dp-arrow', viewBox: '0 0 6 6', refX: 5, refY: 3, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L6,3 L0,6 z', class: 'dp-head' })));
    svg.append(defs);
    const labels = g.nodes.map((nd, i) => {
      const sv = slack ? fmtSlack(slack[i]) : '';
      const gEl = s('g', { id: `dp-i${i}`, class: 'dp-node' + (onChain.has(i) ? ' crit' : ''), role: 'option', 'aria-selected': String(i === sel), 'data-i': i, 'aria-label': `${nd.label}${sv ? `, slack ${sv}` : ''}` },
        s('rect', { class: 'dp-hit', x: 0, y: i * ROW + 2, width: X0, height: ROW }),
        s('text', { x: 4, y: y(i) + 4 }, document.createTextNode(short(nd.label))));
      return gEl;
    });
    const arcTitle = (e) => s('title', null, document.createTextNode(`${g.nodes[e.a].label} → ${g.nodes[e.b].label}${e.mem ? ' (through memory)' : ''}${e.dist ? ` (${e.dist === 1 ? 'next iteration' : e.dist + ' iterations later'})` : ''}${latText(e) ? ` · ${e.critical ? '' : '≈'}${latText(e)} cycles` : ''}${e.critical ? ' · critical chain' : ''}`));
    const lazyTitles = n > 500; // a large graph: an arc gets its tooltip when the pointer first comes over it
    const arcs = g.edges.map((e, k) => {
      const x = X0 + (e.lane + 1) * lane;
      const p = s('path', {
        class: ['dp-arc', e.dist ? 'carried' : '', e.critical ? 'crit' : ''].filter(Boolean).join(' '),
        d: e.a === e.b ? `M${X0 - 2},${y(e.a) - 3} H${x} V${y(e.b) + 3} H${X0 - 2}` : `M${X0 - 2},${y(e.a)} H${x} V${y(e.b)} H${X0 - 2}`,
        'marker-end': 'url(#dp-arrow)', 'data-a': e.a, 'data-b': e.b, 'data-k': k,
      }, lazyTitles ? null : arcTitle(e));
      return p;
    });
    if (lazyTitles) svg.addEventListener('pointerover', (ev) => { const p = ev.target.closest?.('.dp-arc'); if (p && !p.firstChild) p.append(arcTitle(g.edges[Number(p.dataset.k)])); });
    // the latency of an arc, next to its vertical part: the chain's always, the selected instruction's while selected
    const latLabel = (e, cls) => {
      const t = latText(e);
      if (!t) return null;
      // neighbouring lanes are close: labels of even lanes go left of the arc, of odd lanes right, so they do not run together
      const x = X0 + (e.lane + 1) * lane, left = e.lane % 2 === 0;
      return s('text', { class: `dp-lat ${cls}`, x: left ? x - 2 : x + 2, 'text-anchor': left ? 'end' : 'start', y: (y(e.a) + y(e.b)) / 2 + 4, 'aria-hidden': 'true' }, document.createTextNode(t));
    };
    const latsCrit = s('g', { class: 'dp-lats' }, ...g.edges.filter((e) => e.critical).map((e) => latLabel(e, 'crit')).filter(Boolean));
    const latsSel = s('g', { class: 'dp-lats sel' });
    // a large graph: only the instructions near the view are in the page, with the arcs that pass there (a graph of
    // thousands of instructions is tens of thousands of SVG elements, which the page laid out whenever the tab came back)
    const windowed = n > 300;
    const gArcs = s('g', { class: 'dp-arcs' }, ...(windowed ? [] : arcs)), gNodes = s('g', { class: 'dp-nodes' }, ...(windowed ? [] : labels));
    svg.append(gArcs, latsCrit, latsSel, gNodes);
    let wa = -1, wb = -1;
    const win = () => {
      if (!windowed || !svg.isConnected) return;
      const r = svg.getBoundingClientRect();
      if (!r.height) return;
      const wrap = svg.parentElement;
      const box = wrap && wrap.scrollHeight > wrap.clientHeight + 1 ? wrap.getBoundingClientRect() : { top: 0, bottom: innerHeight };
      const top = Math.max(box.top, 0), bottom = Math.min(box.bottom, innerHeight);
      const a = Math.max(0, Math.floor((top - r.top) / ROW) - 40), b = Math.min(n, Math.ceil((bottom - r.top) / ROW) + 40);
      if (a >= wa && b <= wb && wb - wa < 4 * (b - a + 80)) return;
      wa = Math.max(0, a - 40); wb = Math.min(n, b + 40);
      gNodes.replaceChildren(...labels.slice(wa, wb));
      gArcs.replaceChildren(...arcs.filter((p, k) => { const e = g.edges[k]; return Math.max(e.a, e.b) >= wa && Math.min(e.a, e.b) < wb; }));
    };
    let winFrame = 0;
    const winSoon = () => { if (!winFrame) winFrame = requestAnimationFrame(() => { winFrame = 0; win(); }); };
    if (windowed) {
      document.addEventListener('scroll', winSoon, { capture: true, passive: true });
      if (typeof ResizeObserver === 'function') new ResizeObserver(winSoon).observe(svg);
    }

    const info = h('p', { class: 'dp-info' });
    const describe = (i) => {
      const nb = neighbours(g, i);
      const name = (x) => `${short(g.nodes[x.node].label, 28)}${x.dist ? ' ↻' : ''}`;
      const sv = slack ? fmtSlack(slack[i]) : '';
      info.replaceChildren(...[h('span', { class: 'code', text: g.nodes[i].label }),
        sv ? h('span', { class: 'dp-s', title: 'slack: cycles it could be delayed in every iteration without lengthening the chain', text: ` slack ${sv}` }) : null,
        nb.reads.length ? h('span', { class: 'dp-r' }, ' ← ', nb.reads.map(name).join(', ')) : null,
        nb.feeds.length ? h('span', { class: 'dp-f' }, ' → ', nb.feeds.map(name).join(', ')) : null].filter(Boolean)); // (replaceChildren writes a null as "null")
    };
    const select = (i, jump = false) => {
      sel = Math.max(0, Math.min(n - 1, i));
      for (const x of labels) { const on = Number(x.dataset.i) === sel; x.classList.toggle('sel', on); x.setAttribute('aria-selected', String(on)); }
      for (const p of arcs) p.classList.toggle('on', Number(p.dataset.a) === sel || Number(p.dataset.b) === sel);
      latsSel.replaceChildren(...g.edges.filter((e) => e.a === sel || e.b === sel).map((e) => latLabel(e, 'on')).filter(Boolean));
      svg.classList.add('picking');
      svg.setAttribute('aria-activedescendant', `dp-i${sel}`);
      describe(sel);
      if (jump) jumpToRow(root, g.nodes[sel].row);
    };
    // instruction i in view (drawn first, in a large graph)
    const reveal = (i) => {
      if (!windowed) { labels[i].scrollIntoView?.({ block: 'nearest' }); return; }
      const wrap = svg.parentElement;
      if (wrap && wrap.scrollHeight > wrap.clientHeight + 1) {
        const yi = i * ROW;
        if (yi < wrap.scrollTop) wrap.scrollTop = yi; else if (yi + ROW > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = yi + ROW - wrap.clientHeight;
      }
      win();
      labels[i].scrollIntoView?.({ block: 'nearest' });
    };
    svg.addEventListener('click', (e) => { const x = e.target.closest?.('.dp-node'); if (x) select(Number(x.dataset.i), true); });
    svg.addEventListener('keydown', (e) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (step) { e.preventDefault(); select(sel + step); reveal(sel); }
      else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); select(e.key === 'Home' ? 0 : n - 1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(sel, true); }
    });
    describe(sel);
    const c = g.edges.filter((e) => e.dist).length;
    const legend = h('p', { class: 'dp-legend hint' },
      h('span', { class: 'dp-k same', title: 'arcs of a value produced and used in the same iteration', text: `→ ${g.edges.length - c} same iteration` }),
      h('span', { class: 'dp-k carried', title: 'arcs of a value carried into a later iteration', text: `↻ ${c} carried` }),
      g.edges.some((e) => e.critical) ? h('span', { class: 'dp-k crit', title: 'the critical loop-carried chain, its latency per iteration; the numbers on the arcs are latencies in cycles', text: g.slack ? `chain ${+Number(g.slack.period).toFixed(2)}` : 'chain' }) : null,
      slack ? h('span', { class: 'dp-k sl', title: `slack (the column left of the arcs): cycles an instruction could be delayed in every iteration without lengthening the chain; 0 on the chain, ∞ off every loop-carried cycle${g.slack.partial ? '; too large a graph to compute' : ''}`, text: 'slack' }) : null);
    body.replaceChildren(legend, h('div', { class: 'dp-wrap' }, svg), info);
    winSoon();
    // the slack column (a large graph: in a task of its own)
    const addSlack = (from, to) => { for (let i = from; i < to; i++) {
      const sv = fmtSlack(slack[i]);
      if (sv) labels[i].append(s('text', { class: 'dp-sl' + (sv === '0' ? ' zero' : ''), x: LABEL * CH + SL - 2, y: y(i) + 4, 'text-anchor': 'end' }, document.createTextNode(sv)));
    } };
    const STEP = 500; // a large graph: in tasks of their own, STEP instructions each
    const more = (from) => setTimeout(() => { if (!svg.isConnected) return; addSlack(from, Math.min(n, from + STEP)); if (from + STEP < n) more(from + STEP); }, 0);
    if (slack) { if (n > STEP) more(0); else addSlack(0, n); }
  }

  function paint() {
    if (!row || !open) return;
    const { graph, error } = cache;
    if (error) { body.replaceChildren(h('p', { class: 'caveat', text: `no dependencies: ${error}` })); body.dataset.state = 'error'; return; }
    if (!graph) return;
    setCopy('deps', { what: 'the dependencies', md: () => depsMd(graph) });
    const c = graph.edges.filter((e) => e.dist).length;
    hint.textContent = ` · ${graph.edges.length} edge${graph.edges.length === 1 ? '' : 's'}, ${c} ↻`;
    draw(graph);
    body.dataset.state = 'done';
  }

  function update() {
    ensureRow();
    const v = view;
    const r = v?.response;
    const ok = r && !r.error && Array.isArray(r.rows) && !r.mock && v.request;
    row.hidden = !ok;
    if (!ok || cache.key !== keyOf(v)) setCopy('deps', null); // (until this result's graph is drawn)
    if (!ok) return;
    const key = keyOf(v);
    if (cache.key !== key) hint.textContent = '';
    // closed (another tab): the drawn graph of this result stays, so the tab comes back without drawing it again
    if (!open) { if (!(cache.key === key && body.dataset.state === 'done')) { body.replaceChildren(); body.dataset.state = 'closed'; } return; }
    if (cache.key === key) { if (body.dataset.state !== 'done' || !body.firstChild) paint(); return; }
    const instrs = r.rows.filter((x) => x.kind === 'instr').length;
    const est = traceEstimate(instrs, v.request);
    if (est > TRACE_LIMIT && forcedKey !== key) {
      const b = h('button', { type: 'button', class: 'plain', text: `trace ${instrs.toLocaleString('en-US')} instructions` , title: `a trace of about ${est.toLocaleString('en-US')} uops`, 'data-gate': '' });
      b.addEventListener('click', () => { forcedKey = key; update(); });
      body.replaceChildren(h('p', null, b));
      body.dataset.state = 'waiting';
      return;
    }
    load(v, key);
  }

  return {
    decorate(target, v) { root = target; view = v; update(); },
    setOpen(o) { open = !!o; if (details) details.open = open; },
    open: () => open,
  };
}
