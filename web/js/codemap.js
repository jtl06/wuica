// The code layout map: the block's bytes on 64-byte cache lines at the chosen alignment offset, with the 16-byte
// (predecode) and 32-byte (DSB window) boundaries, one box per instruction; macro-fused pairs share a tone, JCC-erratum
// rows (note J) are marked. Arrow keys move through the instructions, Enter (or a click) jumps to the row in the uop
// table; two buttons shift the alignment offset (a new analysis). Drawn only while open.
//
// The first half has no DOM (tests-js/web_codemap.mjs runs it under Node).

import { h } from './render.js';
import { jumpToRow } from './rowjump.js';

const LINE = 64;
const hex2 = (n) => `0x${n.toString(16).padStart(2, '0')}`;

// {bytes, offset, lines: [{addr, segs: [{i, from, to}]}], instrs: [{row, label, start, end, fused, jcc, tone, cross16,
//  cross32, cross64}], counts: {cross16, cross32, cross64}} or null. Addresses are relative to the start of the first
// cache line: the block starts at `offset` (the alignment offset, 0–63).
export function codeMapModel(response, hex, offset = 0) {
  const rows = response?.rows;
  if (!Array.isArray(rows)) return null;
  const off = Math.max(0, Math.min(63, Number(offset) || 0));
  const instrs = [];
  let at = off;
  rows.forEach((x, row) => {
    if (x.kind !== 'instr') return;
    const len = String(x.opcode ?? '').length / 2;
    if (!len) return;
    instrs.push({ row, label: x.label, start: at, end: at + len, fused: x.notes === 'M', jcc: x.notes === 'J' });
    at += len;
  });
  if (!instrs.length || instrs.map((i) => rows[i.row].opcode).join('').toLowerCase() !== String(hex ?? '').toLowerCase()) return null;
  // tones alternate; the second instruction of a macro-fused pair takes the tone of the first
  let tone = 0;
  instrs.forEach((ins, k) => {
    if (k > 0 && !ins.fused) tone ^= 1;
    ins.tone = tone;
    const crosses = (n) => Math.floor(ins.start / n) !== Math.floor((ins.end - 1) / n);
    ins.cross16 = crosses(16); ins.cross32 = crosses(32); ins.cross64 = crosses(64);
  });
  const first = Math.floor(off / LINE), last = Math.floor((at - 1) / LINE);
  const lines = [];
  for (let l = first; l <= last; l++) lines.push({ addr: l * LINE, segs: [] });
  instrs.forEach((ins, i) => {
    for (let l = Math.floor(ins.start / LINE); l <= Math.floor((ins.end - 1) / LINE); l++) {
      lines[l - first].segs.push({ i, from: Math.max(ins.start, l * LINE) - l * LINE, to: Math.min(ins.end, (l + 1) * LINE) - l * LINE });
    }
  });
  const count = (k) => instrs.filter((x) => x[k]).length;
  return { bytes: at - off, offset: off, lines, instrs, counts: { cross16: count('cross16'), cross32: count('cross32'), cross64: count('cross64') } };
}

// ---- the view ----------------------------------------------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...children) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined && v !== false) e.setAttribute(k, String(v));
  for (const c of children) if (c) e.append(c);
  return e;
}
const CELL = 10, ROW = 16, BOX = 12, LEFT = 34, TOP = 12;

// env: { onToggle(open), setAlign(offset) }
export function createCodeMap(env = {}) {
  let open = false;
  let row = null, details = null, body = null, hint = null;
  let root = null, view = null, model = null, sel = 0, key = '';

  function ensureRow() {
    if (row?.isConnected) return row;
    hint = h('span', { class: 'hint ly-hint' });
    details = h('details', { class: 'ly', id: 'codemap' }, h('summary', { title: 'the bytes of the block on 64-byte cache lines' }, 'cache lines', hint));
    details.open = open;
    let last = open;
    details.addEventListener('toggle', () => {
      if (details.open === last) return;
      last = open = details.open;
      env.onToggle?.(open);
      key = '';
      paint();
    });
    body = h('div', { class: 'ly-body' });
    details.append(body);
    row = h('div', { class: 'row', id: 'codemap-row' }, h('div', { class: 'label', text: 'bytes' }), h('div', { class: 'field' }, details));
    const more = document.getElementById('more');
    const before = document.getElementById('sweep-row');
    if (before?.parentNode === more) more.insertBefore(row, before); else more?.append(row);
    return row;
  }

  function describe(ins) {
    const marks = [ins.cross64 ? 'crosses a cache line' : ins.cross32 ? 'crosses a 32-byte boundary' : ins.cross16 ? 'crosses a 16-byte boundary' : null,
      ins.fused ? 'macro-fused with the previous instruction' : null, ins.jcc ? 'JCC erratum: not in the DSB' : null].filter(Boolean);
    return `${ins.label} · ${hex2(ins.start)}–${hex2(ins.end - 1)} (${ins.end - ins.start} B)${marks.length ? ' · ' + marks.join(' · ') : ''}`;
  }

  function draw() {
    const m = model;
    const W = LEFT + LINE * CELL + 2;
    const H = TOP + m.lines.length * ROW;
    const svg = s('svg', { class: 'ly-map', viewBox: `0 0 ${W} ${H}`, role: 'listbox', tabindex: '0', 'aria-label': 'instructions on the cache lines; arrow keys move, Enter shows the row', 'aria-activedescendant': `ly-i${sel}` });
    svg.style.maxWidth = `${W * 1.25}px`;
    const axis = s('g', { class: 'ly-axis', 'aria-hidden': 'true' });
    for (const b of [0, 16, 32, 48]) axis.append(s('text', { x: LEFT + b * CELL + 1, y: TOP - 3 }, document.createTextNode(String(b))));
    svg.append(axis);
    const grid = s('g', { class: 'ly-grid', 'aria-hidden': 'true' });
    m.lines.forEach((ln, k) => {
      const y = TOP + k * ROW;
      grid.append(s('rect', { class: 'ly-line', x: LEFT, y: y + 1, width: LINE * CELL, height: BOX + 2 }));
      grid.append(s('text', { class: 'ly-addr', x: LEFT - 4, y: y + BOX - 1, 'text-anchor': 'end' }, document.createTextNode(ln.addr.toString(16).padStart(3, '0'))));
    });
    svg.append(grid);
    const boxes = s('g', { class: 'ly-boxes' });
    const groups = m.instrs.map((ins, i) => s('g', {
      id: `ly-i${i}`, role: 'option', 'aria-selected': String(i === sel), 'data-i': i, 'aria-label': describe(ins),
      class: ['ly-ins', `t${ins.tone}`, ins.jcc ? 'jcc' : '', ins.cross64 ? 'split' : '', i === sel ? 'sel' : ''].filter(Boolean).join(' '),
    }, s('title', null, document.createTextNode(describe(ins)))));
    m.lines.forEach((ln, k) => {
      const y = TOP + k * ROW + 2;
      for (const sg of ln.segs) groups[sg.i].append(s('rect', { x: LEFT + sg.from * CELL + 0.5, y, width: (sg.to - sg.from) * CELL - 1, height: BOX }));
    });
    for (const g of groups) boxes.append(g);
    svg.append(boxes);
    const bounds = s('g', { class: 'ly-bounds', 'aria-hidden': 'true' });
    for (const b of [16, 32, 48]) bounds.append(s('line', { class: b === 32 ? 'b32' : 'b16', x1: LEFT + b * CELL, x2: LEFT + b * CELL, y1: TOP, y2: H }));
    svg.append(bounds);

    const select = (i, jump = false) => {
      sel = Math.max(0, Math.min(m.instrs.length - 1, i));
      for (const g of svg.querySelectorAll('.ly-ins.sel')) { g.classList.remove('sel'); g.setAttribute('aria-selected', 'false'); }
      const g = groups[sel];
      g.classList.add('sel'); g.setAttribute('aria-selected', 'true');
      svg.setAttribute('aria-activedescendant', `ly-i${sel}`);
      info.textContent = describe(m.instrs[sel]);
      if (jump) jumpToRow(root, m.instrs[sel].row);
    };
    svg.addEventListener('click', (e) => { const g = e.target.closest?.('.ly-ins'); if (g) select(Number(g.dataset.i), true); });
    svg.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -Infinity, End: Infinity }[e.key];
      if (step !== undefined) { e.preventDefault(); select(Number.isFinite(step) ? sel + step : step < 0 ? 0 : m.instrs.length - 1); groups[sel].scrollIntoView?.({ block: 'nearest' }); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(sel, true); }
    });
    const info = h('p', { class: 'ly-info code', 'aria-live': 'polite', text: describe(m.instrs[sel]) });

    const shift = (d) => {
      const b = h('button', { type: 'button', class: 'plain ly-shift', 'aria-label': `alignment offset ${d < 0 ? '−' : '+'}1`, title: `alignment offset ${d < 0 ? '−' : '+'}1 (a new analysis)`, text: d < 0 ? '◂' : '▸', disabled: !env.setAlign || (d < 0 ? m.offset <= 0 : m.offset >= 63) });
      b.addEventListener('click', () => env.setAlign?.(m.offset + d));
      return b;
    };
    const c = m.counts;
    const tools = h('div', { class: 'ly-tools' },
      h('span', { class: 'ly-off' }, shift(-1), h('span', { class: 'ly-offv', title: 'alignment offset: the position of the first byte in its cache line', text: `offset ${m.offset}` }), shift(1)),
      h('span', { class: 'ly-legend' },
        h('span', { class: 'ly-k b16', title: 'instructions that cross a 16-byte boundary (predecoder blocks)', text: `16B ${c.cross16}` }),
        h('span', { class: 'ly-k b32', title: 'instructions that cross a 32-byte boundary (DSB windows)', text: `32B ${c.cross32}` }),
        h('span', { class: 'ly-k b64', title: 'instructions split across two cache lines', text: `64B ${c.cross64}` })));
    body.replaceChildren(tools, h('div', { class: 'ly-wrap' }, svg), info);
  }

  function paint() {
    if (!row) return;
    const r = view?.response;
    model = r && !r.error ? codeMapModel(r, view.hex, view.request?.alignmentOffset ?? 0) : null;
    row.hidden = !model;
    if (!model) { body.replaceChildren(); return; }
    const n = model.lines.length;
    hint.textContent = ` · ${model.bytes} B, ${n} line${n === 1 ? '' : 's'}`;
    if (!open) { body.replaceChildren(); body.dataset.state = 'closed'; return; }
    const k = `${view.hex}|${model.offset}|${r.rows.map((x) => x.notes).join('')}`;
    if (k === key && body.firstChild) return;
    if (k.split('|')[0] !== key.split('|')[0]) sel = 0;
    sel = Math.min(sel, model.instrs.length - 1);
    key = k;
    draw();
    body.dataset.state = 'drawn';
  }

  return {
    decorate(target, v) { root = target; view = v; ensureRow(); paint(); },
    setOpen(o) { open = !!o; if (details) details.open = open; },
    open: () => open,
  };
}
