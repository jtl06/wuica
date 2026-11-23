// The bound view: how busy each resource is, as a share of the predicted cycles (VTune's top-down levels, Advisor's roofs,
// MAQAO CQA's cycle summary), the next limit after the bottleneck, and which instructions use the selected resource
// (VTune's locator metrics: a shade on the rows of the uop table, and the top rows).
// Everything is derived from the response (no analysis), and only while the view is open.
//
// The first half has no DOM (tests-js/web_bound.mjs runs it under Node).

import { h, columnKind } from './render.js';
import { jumpToRow, finishJump } from './rowjump.js';
import { portSetBlame, setLine, markPorts } from './portset.js';
import { slotsLine } from './slots.js';
import { rangeGroup, onRange } from './trace-range-view.js'; // a cycle range of the trace replaces the steady state

const EPS = 0.005; // values are shown with two decimals
const GROUPS = Object.freeze([['front', 'front end'], ['issue', 'issue'], ['ports', 'ports'], ['deps', 'chain'], ['other', 'other']]);
const LIMIT_GROUP = { Issue: 'issue', Ports: 'ports', Dependencies: 'deps' }; // the rest: front end
const FE_COLUMN = { DSB: 'DSB', LSD: 'LSD', MS: 'MS' };
const SATURATED = 0.95; // "Ports": the ports at least this busy relative to the busiest one
const DETAILS_DELAY = 300; // ms after a result before its details are fetched (the port set, the issue slots)

const sum = (a) => a.reduce((s, x) => s + x, 0);
const pct = (u) => `${Math.round(u * 100)}%`;
const f2 = (x) => Number(x).toFixed(2);

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
  const binding = bottlenecks.filter((b) => items.some((x) => x.id === b));
  if (!binding.length) for (const x of limits) if (x.cycles >= max - EPS) binding.push(x.id);
  const bindValue = Math.max(...binding.map((b) => items.find((x) => x.id === b).cycles), 0);
  let next = null;
  for (const x of limits) if (!binding.includes(x.id) && x.cycles < bindValue - EPS && (!next || x.cycles > next.tp)) next = { name: x.name, tp: x.cycles };
  if (next) next.speedup = next.tp > 0 ? tp / next.tp : Infinity;
  return { tp, items, binding, next, gap };
}

// The share of each row of the response in a resource: {weights, total, unit} or null (nothing to attribute).
//   col:<name>  the row's uops on that port (or cycles on the divider)
//   Ports       its uops on the saturated ports (at least 95 % as busy as the busiest port)
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
    return finish(w, unit, hot.map((p) => shortPort(p.name)));
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

function finish(w, unit, ports) {
  let total = 0, max = 0;
  for (const x of w) { total += x; if (x > max) max = x; }
  if (!(total > 0)) return null;
  return { weights: w, total, max, unit, ports };
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

// ---- the view ----------------------------------------------------------------------------------------------------

// env: { onToggle(open) (the URL keeps whether the view is open), details (details.js: "Ports" drills down to the port
// set once they are there) }
export function createBound(env = {}) {
  let open = false;
  let selected = null; // the resource the user picked (kept while the response has it)
  let row = null, details = null, body = null, hint = null;
  let root = null, view = null;
  let shaded = [];     // the cells that carry a shade
  let detailsTimer = 0;
  onRange(() => { if (open) paint(); });

  function ensureRow() {
    if (row?.isConnected) return row;
    hint = h('span', { class: 'hint bd-next' });
    details = h('details', { class: 'bd', id: 'bound' }, h('summary', { title: 'how busy each resource is, and which instructions use it' }, 'by resource', hint));
    details.open = open;
    let last = open;
    details.addEventListener('toggle', () => {
      if (details.open === last) return;
      last = open = details.open;
      env.onToggle?.(open);
      paint();
    });
    body = h('div', { class: 'bd-body' });
    details.append(body);
    row = h('div', { class: 'row', id: 'bound-row' }, h('div', { class: 'label', text: 'bound' }), h('div', { class: 'field' }, details));
    const more = document.getElementById('more');
    const before = document.getElementById('sweep-row');
    if (before?.parentNode === more) more.insertBefore(row, before); else more?.prepend(row);
    return row;
  }

  function clean() {
    for (const th of shaded) {
      th.style.removeProperty('--bd');
      th.removeAttribute('aria-description');
      th.parentElement?.classList.remove('bd-hot');
    }
    shaded = [];
    markPorts(root, null);
  }

  function shade(b, name) {
    clean();
    const trs = root?.querySelector('table.uops')?.tBodies[0]?.rows;
    if (!b || !trs) return;
    for (let k = 0; k < trs.length && k < b.weights.length; k++) {
      const x = b.weights[k];
      if (!(x > 0)) continue;
      const th = trs[k].cells[0];
      th.style.setProperty('--bd', (x / b.max).toFixed(3));
      th.setAttribute('aria-description', `${pct(x / b.total)} of ${name}`);
      trs[k].classList.add('bd-hot');
      shaded.push(th);
    }
  }

  function bar(it, sel) {
    const fill = h('span', { class: 'bd-fill' });
    fill.style.width = `${Math.min(100, it.util * 100).toFixed(1)}%`;
    const b = h('button', {
      type: 'button', class: ['bd-item', it.bottleneck ? 'is-bn' : '', it.util > 1 + EPS ? 'over' : '', it.group === 'other' ? 'na' : ''].filter(Boolean).join(' '),
      'aria-pressed': String(sel), title: it.title, 'data-id': it.id, disabled: it.group === 'other',
    }, h('span', { class: 'bd-name', text: it.name }), h('span', { class: 'bd-bar', 'aria-hidden': 'true' }, fill), h('span', { class: 'bd-pct', text: pct(it.util) }));
    b.addEventListener('click', () => { selected = it.id; paint(); });
    return b;
  }

  function paint() {
    if (!row) return;
    const r = view?.response;
    const m = r && !r.error ? boundModel(r) : null;
    row.hidden = !m;
    if (!m) { clean(); return; }
    hint.textContent = m.next ? ` · next ${m.next.name} ≤×${m.next.speedup.toFixed(1)}` : '';
    hint.title = m.next ? `without the bottleneck, at best ${f2(m.next.tp)} cycles/iteration (the next limit): up to ${m.next.speedup.toFixed(2)}× faster` : '';
    if (!open) { body.replaceChildren(); clean(); if (root) root.dataset.bound = 'closed'; return; }
    const rg = rangeGroup(view);
    if (rg) { body.replaceChildren(rg); clean(); if (root) root.dataset.bound = 'range'; return; }
    if (!m.items.some((x) => x.id === selected && x.group !== 'other')) selected = defaultResource(m);
    const groups = [];
    for (const [g, label] of GROUPS) {
      const its = m.items.filter((x) => x.group === g);
      if (!its.length) continue;
      groups.push(h('div', { class: 'bd-group', role: 'group', 'aria-label': label }, h('span', { class: 'bd-g', text: label }), h('span', { class: 'bd-items' }, its.map((x) => bar(x, x.id === selected)))));
    }
    // Ports: the port set behind the limit, from the details (fetched once, when Ports is selected)
    // and the issue slots per cause (slots.js); the details are fetched once, while the view is open
    const d = env.details?.peek(view);
    // (after a pause: while results follow each other, e.g. typing in live mode, no analysis is added to each)
    if (env.details && d === undefined && !r.mock) {
      const v = view;
      clearTimeout(detailsTimer);
      const current = () => view === v && open && !document.body.classList.contains('ab-on'); // (not drawn in A–B mode)
      detailsTimer = setTimeout(() => { if (current()) env.details.get(v).then((x) => { if (x && current()) paint(); }); }, DETAILS_DELAY);
    }
    const ps = selected === 'Ports' ? portSetBlame(r, d?.ports) : null;
    const b = ps ?? (selected ? blame(r, selected) : null);
    const it = m.items.find((x) => x.id === selected);
    const name = it ? (b?.ports ? `${it.name} (${b.ports.join(' ')})` : it.name) : '';
    const top = topRows(b, 5);
    const list = top.map(({ row: k, share }) => {
      const btn = h('button', { type: 'button', class: 'plain bd-row', title: `${r.rows[k].label}: ${f2(b.weights[k])} of ${f2(b.total)} ${b.unit} (${pct(share)} of ${name})` },
        h('span', { class: 'bd-ins', text: r.rows[k].label }), ' ', h('span', { class: 'bd-share', text: pct(share) }));
      btn.addEventListener('click', () => jumpToRow(root, k));
      return h('li', null, btn);
    });
    body.replaceChildren(...[h('div', { class: 'bd-groups' }, groups, ps ? setLine(ps) : null, d?.issue ? slotsLine(d.issue) : null),
      top.length ? h('div', { class: 'bd-top' }, h('span', { class: 'bd-g', text: 'top', title: `the instructions with the largest share of ${name}; the uop table is shaded by the share` }), h('ol', { class: 'bd-list' }, list)) : null].filter(Boolean));
    shade(b, name);
    if (ps) markPorts(root, d.ports.ports);
    if (root?.dataset) root.dataset.bound = selected ?? '';
  }

  return {
    // after the result view is drawn (app.js: draw)
    decorate(target, v) {
      root = target;
      view = v;
      ensureRow();
      shaded = []; // the table was drawn anew
      paint();
      finishJump(root);
    },
    setOpen(o) { open = !!o; if (details) details.open = open; },
    open: () => open,
  };
}
