// The bound view: how busy each resource is, as a share of the predicted cycles (VTune's top-down levels, Advisor's roofs,
// MAQAO CQA's cycle summary), the next limit after the bottleneck, and which instructions use the selected resource
// (VTune's locator metrics: a shade on the rows of the uop table, and the top rows).
// Everything is derived from the response (no analysis), and only while the view is open.
//
// The model (no DOM) is bound-core.js, which the npm package shares; this file renders it.

import { h, sideTag } from './render.js';
import { colorInstr } from './asm-hl.js';
import { jumpToRow, finishJump } from './rowjump.js';
import { portSetBlame, setLine, markPorts } from './portset.js';
import { slotsLine } from './slots.js';
import { rangeGroup, onRange } from './trace-range-view.js'; // a cycle range of the trace replaces the steady state
import { boundModel, blame, topRows, defaultResource } from './bound-core.js';
import { setCopy } from './copy-view.js';
import { bound as boundText } from './markdown.js';

export { shortPort, boundModel, blame, topRows, defaultResource } from './bound-core.js';

const EPS = 0.005; // values are shown with two decimals
const GROUPS = Object.freeze([['front', 'front end'], ['issue', 'issue'], ['ports', 'ports'], ['deps', 'chain'], ['other', 'other']]);
const DETAILS_DELAY = 300; // ms after a result before its details are fetched (the port set, the issue slots)

const pct = (u) => `${Math.round(u * 100)}%`;
const f2 = (x) => Number(x).toFixed(2);

// ---- the view ----------------------------------------------------------------------------------------------------

// env: { onToggle(open) (the URL keeps whether the view is open), details (details.js: "Ports" drills down to the port
// set once they are there) }
export function createBound(env = {}) {
  let open = false;
  let selected = null; // the resource the user picked (kept while the response has it)
  let row = null, details = null, body = null, hint = null;
  let root = null, view = null;
  let shade_ = null;   // the shade of the table's rows: {b, name} (a decorator of its rows, vrows.js) or null
  let shadedTable = null;
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

  // a row of the table, shaded by its share (or not)
  function shadeRow(tr, k) {
    const th = tr.cells[0], x = shade_?.b.weights[k];
    if (x > 0) {
      th.style.setProperty('--bd', (x / shade_.b.max).toFixed(3));
      th.setAttribute('aria-description', `${pct(x / shade_.b.total)} of ${shade_.name}`);
      tr.classList.add('bd-hot');
    } else if (tr.classList.contains('bd-hot')) {
      th.style.removeProperty('--bd');
      th.removeAttribute('aria-description');
      tr.classList.remove('bd-hot');
    }
  }
  function clean() {
    shade_ = null;
    if (shadedTable?.vr) { shadedTable.vr.data.hot = []; shadedTable.vr.repaint('bd'); }
    markPorts(root, null);
  }

  function shade(b, name) {
    clean();
    const t = root?.querySelector('table.uops');
    if (!b || !t?.vr) return;
    shade_ = { b, name };
    shadedTable = t;
    // (keys.js: n and p go through these, hottest first)
    t.vr.data.hot = b.weights.map((x, row) => ({ row, weight: x / b.max })).filter((x) => x.weight > 0);
    if (!t.vr.decorators.has('bd')) t.vr.decorate('bd', shadeRow); else t.vr.repaint('bd');
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
    const shown = view?.shown ?? null;
    const side = view?.side ? view.side.toUpperCase() : null;
    setCopy('bound', m ? { what: 'the bound view', md: () => boundText(r, selected, { shown, side }) } : null);
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
        colorInstr(h('span', { class: 'bd-ins' }), shown?.[k] ?? r.rows[k].label), ' ', h('span', { class: 'bd-share', text: pct(share) }));
      btn.addEventListener('click', () => jumpToRow(root, k));
      return h('li', null, btn);
    });
    // what the shares are of (the headline can be per element), and in A–B whose block it is
    const cap = h('p', { class: 'ab-cap bd-cap' }, ...[sideTag(view), `${view?.side ? ' ' : ''}${f2(Number(r.tp))} cycles/iteration`].filter(Boolean));
    body.replaceChildren(...[cap, h('div', { class: 'bd-groups' }, groups, ps ? setLine(ps) : null, d?.issue ? slotsLine(d.issue) : null),
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
      shade_ = null; shadedTable = null; // the table was drawn anew
      paint();
      finishJump(root);
    },
    setOpen(o) { open = !!o; if (details) details.open = open; },
    open: () => open,
  };
}
