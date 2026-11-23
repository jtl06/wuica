// The instruction card (uops.info's table row and Compiler Explorer's opcode tooltip, for the instruction at hand): the
// selected row of the uop table (a click or Enter, as trace-link.js selects it) or the focused one gets a compact card
// under the table: its uops, allowed ports (1*p0156+1*p23), latency per operand pair, throughput from its ports, the
// link to uops.info, and its front-end facts (length, where it sits, boundaries it crosses, LCP, microcode, fusion). The
// allowed ports, latencies and LCP need the details of the result (details.js: one more analysis, the first time a card
// is shown); until then, and without them (mock), the card shows what the response has.
// Also the front-end badges of the Notes column (from the response only, no analysis): µ microcoded (uops from the MS),
// 64 the instruction crosses a 64-byte line at the alignment offset. They are drawn with CSS (data-hz), so the cells'
// text stays the note.
//
// The first half has no DOM (tests-js/web_icard.mjs runs it under Node).

import { h, fmt } from './render.js';
import { portString, portThroughput, latencyPairs } from './details.js';
import { boundModel, blame, defaultResource } from './bound.js';
import { portSetBlame } from './portset.js';
import { chainInfo } from './insight.js';

const f2 = (x) => Number(x).toFixed(2);
const colIndex = (r, name) => (Array.isArray(r?.columns) ? r.columns.indexOf(name) : -1);
const val = (r, row, name) => { const i = colIndex(r, name); return i < 0 ? 0 : Number(r.rows[row]?.values?.[i]) || 0; };

// Where each instruction row starts: {row -> {offset, length}} at the alignment offset (bytes in program order).
export function layout(response, alignmentOffset = 0) {
  const out = new Map();
  let at = Math.max(0, Number(alignmentOffset) || 0);
  (response?.rows ?? []).forEach((x, row) => {
    if (x.kind !== 'instr') return;
    const length = String(x.opcode ?? '').length / 2;
    out.set(row, { offset: at, length });
    at += length;
  });
  return out;
}
const crosses = (offset, length) => [16, 32, 64].filter((b) => length > 0 && Math.floor(offset / b) !== Math.floor((offset + length - 1) / b));

// The badges of each row: [{row, hz: 'µ 64', title}] for the rows that have any.
export function hazards(response, alignmentOffset = 0) {
  const lay = layout(response, alignmentOffset);
  const out = [];
  for (const [row, { offset, length }] of lay) {
    const ms = val(response, row, 'MS');
    const marks = [], titles = [];
    if (ms > 0) { marks.push('µ'); titles.push(`microcoded: ${fmt(ms)} uops/iteration from the microcode sequencer`); }
    if (crosses(offset, length).includes(64)) { marks.push('64'); titles.push(`crosses a 64-byte line (bytes ${offset}–${offset + length - 1} at alignment ${Number(alignmentOffset) || 0})`); }
    if (marks.length) out.push({ row, hz: marks.join(' '), title: titles.join('\n') });
  }
  return out;
}

// What the card shows for a row: null for the extra uops. det: the row's details (or null).
export function cardModel(response, row, det, alignmentOffset = 0) {
  const x = response?.rows?.[row];
  if (!x || x.kind !== 'instr') return null;
  const lay = layout(response, alignmentOffset).get(row) ?? { offset: 0, length: 0 };
  const offset = det?.offset ?? lay.offset;
  const length = det?.length ?? lay.length;
  const m = {
    label: x.label, url: typeof x.url === 'string' && x.url.startsWith('https://www.uops.info/') ? x.url : null, instrStr: x.instrStr ?? null,
    issued: val(response, row, 'Issued'), executed: val(response, row, 'Exec.'), ms: val(response, row, 'MS'),
    offset, length, crosses: det?.crosses ?? crosses(offset, length), fused: x.notes === 'M', unsupported: x.notes === 'X',
    details: !!det,
  };
  if (det) {
    m.ports = portString(det.portData);
    m.tp = portThroughput(det);
    m.tpTable = det.tpTable ?? null;
    m.uops = det.uops; m.fusedUops = det.retireSlots; m.mite = det.uopsMITE; m.msUops = det.uopsMS;
    m.lat = latencyPairs(det);
    m.lcp = !!det.lcp; m.microcoded = !!det.microcoded; m.complex = !!det.complexDecoder;
    m.fusedNext = !!det.macroFusedWithNext; m.fused = m.fused || !!det.macroFusedWithPrev; m.div = det.divCycles || 0;
    m.loads = (det.uopList ?? []).filter((u) => u.load).length; m.stores = (det.uopList ?? []).filter((u) => u.storeData).length;
    m.eliminable = !!det.mayBeEliminated;
  } else {
    m.microcoded = m.ms > 0;
  }
  return m;
}

// The row's share of the bottleneck (bound.js's blame; for Ports the port set of the details, if there): {resource,
// share, unit} or null
export function bottleneckShare(response, row, details = null) {
  const res = defaultResource(boundModel(response));
  if (!res) return null;
  const b = (res === 'Ports' ? portSetBlame(response, details?.ports) : null) ?? blame(response, res);
  if (!b || !(b.total > 0)) return null;
  return { resource: res, share: (b.weights[row] ?? 0) / b.total, unit: b.unit };
}

// the front-end facts as short tags: [{text, title}]
export function frontTags(m) {
  const t = [{ text: `${m.length} B`, title: `${m.length} bytes` }, { text: `@${m.offset}`, title: `at byte ${m.offset} of its 64-byte line (alignment offset + position)` }];
  for (const b of m.crosses) t.push({ text: `✂${b}`, title: `crosses a ${b}-byte boundary` });
  if (m.lcp) t.push({ text: 'LCP', title: 'length-changing prefix: the predecoder stalls' });
  if (m.microcoded) t.push({ text: 'µcode', title: 'uops from the microcode sequencer (MS)' });
  if (m.complex) t.push({ text: 'complex', title: 'needs the complex decoder' });
  if (m.fusedNext) t.push({ text: 'fuses→', title: 'macro-fused with the next instruction' });
  if (m.fused) t.push({ text: '←fused', title: 'macro-fused with the previous instruction' });
  if (m.eliminable) t.push({ text: 'elim', title: 'can be eliminated at rename (move elimination, zero idiom)' });
  return t;
}

// ---- the view ----------------------------------------------------------------------------------------------------

const MAX_LAT = 6;
const STICK_ROWS = 24; // a longer table: the card sticks to the bottom of the window

// env: { details (createDetails), getSel() -> row | -1 }
export function createICard(env) {
  let root = null, view = null, card = null, shown = -1, closed = false;
  const bound = new WeakSet();

  const table = () => root?.querySelector('table.uops');
  const trs = () => table()?.tBodies[0]?.rows ?? [];
  const rowOf = (tr) => (tr && tr.parentElement?.parentElement === table() && tr.parentElement.tagName === 'TBODY' ? tr.sectionRowIndex : -1);
  const align = () => Number(view?.request?.alignmentOffset) || 0;
  const ok = () => !!view?.response && !view.response.error && Array.isArray(view.response.rows);

  function badges() {
    const rows = trs();
    for (const { row, hz, title } of hazards(view.response, align())) {
      const td = rows[row]?.querySelector('td.note');
      if (!td) continue;
      td.dataset.hz = hz;
      td.title = [td.title, title].filter(Boolean).join('\n');
    }
  }

  function ensureCard() {
    if (card?.isConnected) return card;
    const wrap = table()?.closest('.table-wrap');
    if (!wrap) return null;
    card = h('div', { class: trs().length > STICK_ROWS ? 'ic stick' : 'ic', id: 'icard', role: 'region', 'aria-label': 'instruction', 'aria-live': 'polite', hidden: true });
    wrap.after(card);
    return card;
  }

  function hide() {
    shown = -1;
    if (card) { card.hidden = true; card.replaceChildren(); }
    if (root) root.dataset.icard = '';
  }

  function line(k, title, ...content) {
    return h('div', { class: 'ic-l' }, h('span', { class: 'ic-k', text: k, title }), h('span', { class: 'ic-v' }, ...content));
  }

  function paint(row) {
    const c = ensureCard();
    if (!c) return;
    const r = view.response;
    const det = env.details?.peek(view);
    const m = cardModel(r, row, det?.rows?.[row] ?? null, align());
    if (!m) { hide(); return; }
    shown = row;
    const close = h('button', { type: 'button', class: 'plain ic-x', 'aria-label': 'close', title: 'close (Esc)', text: '×' });
    close.addEventListener('click', () => { closed = true; hide(); });
    const head = h('div', { class: 'ic-h' }, h('span', { class: 'ic-ins code', text: m.label }),
      m.url ? h('a', { href: m.url, rel: 'noopener noreferrer', target: '_blank', class: 'ic-link', title: m.instrStr ? `${m.instrStr} on uops.info` : 'uops.info', text: 'uops.info ↗' }) : null,
      close);
    const lines = [head];
    if (m.details) {
      if (m.ports) lines.push(line('ports', 'allowed ports: uops*ports (uops.info notation)', h('span', { class: 'code', text: m.ports }),
        m.tp > 0 ? h('span', { class: 'ic-tp', title: `cycles per instruction from its ports alone${m.tpTable ? `; table limit ${f2(m.tpTable)}` : ''}`, text: ` tp ${f2(m.tp)}` }) : null));
      lines.push(line('uops', 'unfused · fused (issue slots) · from the legacy decoders · from the microcode sequencer',
        `${m.uops}`, h('span', { class: 'ic-d', text: ` · ${m.fusedUops} fused · MITE ${m.mite}${m.msUops ? ` · MS ${m.msUops}` : ''}${m.div ? ` · div ${m.div}` : ''}${m.loads ? ` · ${m.loads} load${m.loads > 1 ? 's' : ''}` : ''}${m.stores ? ` · ${m.stores} store${m.stores > 1 ? 's' : ''}` : ''}` })));
      if (m.lat.length) {
        const shownLat = m.lat.slice(0, MAX_LAT);
        lines.push(line('lat', 'latency per operand pair, cycles: input→output' + (m.lat.length > MAX_LAT ? `\n${m.lat.map((l) => `${l.from}→${l.to} ${l.cycles}`).join('\n')}` : ''),
          ...shownLat.map((l, k) => h('span', { class: 'ic-lat' }, k ? ' · ' : '', h('span', { class: 'code', text: `${l.from}→${l.to}` }), ` ${l.cycles}`)),
          m.lat.length > MAX_LAT ? h('span', { class: 'ic-d', text: ` · +${m.lat.length - MAX_LAT}` }) : null));
      }
    } else {
      lines.push(line('uops', 'per iteration: issued · executed', `${fmt(m.issued) || 0}`, h('span', { class: 'ic-d', text: ` · ${fmt(m.executed) || 0} exec` })));
      if (env.details && !r.mock) lines.push(h('div', { class: 'ic-l hint', text: '…' }));
    }
    const on = chainInfo(r)?.onChain.get(row);
    if (on?.length) lines.push(line('chain', 'on the critical loop-carried chain: reads … from …, cycles (↻: from the previous iteration)',
      ...on.map((x, k) => h('span', { class: 'ic-lat' }, k ? ' · ' : '', h('span', { class: 'code', text: `${x.operand} ← ${x.fromLabel}` }), ` ${x.latency}${x.carried ? ' ↻' : ''}`))));
    const sh = bottleneckShare(r, row, det);
    if (sh) lines.push(line('share', `its share of the bottleneck (${sh.resource}, by ${sh.unit})`, `${Math.round(sh.share * 100)}%`, h('span', { class: 'ic-d', text: ` of ${sh.resource}` })));
    lines.push(line('front', 'front end', ...frontTags(m).map((t, k) => h('span', { class: 'ic-t', title: t.title }, k ? ' ' : '', t.text))));
    c.replaceChildren(...lines);
    c.hidden = false;
    c.dataset.row = String(row);
    if (root) root.dataset.icard = m.details ? 'details' : 'basic';
    if (!det && env.details && det === undefined) {
      const v = view;
      env.details.get(v).then((d) => { if (v === view && shown === row && d) paint(row); else if (v === view && shown === row) paintPlain(row); });
    }
  }
  // details could not be had: drop the "…"
  function paintPlain(row) { card?.querySelector('.ic-l.hint')?.remove(); if (root && shown === row) root.dataset.icard = 'basic'; }

  function show(row) {
    if (!ok() || row < 0 || row >= view.response.rows.length) { hide(); return; }
    closed = false;
    paint(row);
  }

  function bind(target) {
    if (bound.has(target)) return;
    bound.add(target);
    // after trace-link.js (registered earlier on the same root) selected the row
    target.addEventListener('click', (e) => {
      const tr = e.target.closest?.('tr');
      if (rowOf(tr) < 0 || e.target.closest('a, button, input, select, textarea, label, summary')) return;
      const sel = env.getSel?.() ?? -1;
      if (sel >= 0) show(sel);
    });
    target.addEventListener('focusin', (e) => {
      const tr = e.target.closest?.('tr');
      const row = rowOf(tr);
      if (row >= 0 && e.target === tr && !closed) show(row);
    });
    target.addEventListener('keydown', (e) => {
      const tr = e.target.closest?.('tr');
      if (rowOf(tr) < 0 || e.target !== tr) return;
      if (e.key === 'Escape') { closed = true; hide(); }
      else if (e.key === 'Enter' || e.key === ' ') { closed = false; show(rowOf(tr)); }
    });
  }

  return {
    // after the result view is drawn (views.js)
    decorate(target, v) {
      root = target;
      view = v;
      card = null;
      shown = -1;
      if (!ok() || !table()) return;
      bind(root);
      badges();
      const sel = env.getSel?.() ?? -1;
      if (sel >= 0 && !closed) show(sel);
    },
    shown: () => shown,
  };
}
