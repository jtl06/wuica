// Cost per source line (Compiler Explorer's line colouring, VTune's source view): after a block was imported from a
// Compiler Explorer link, the compiler's source lines next to the share of the binding resource (bound.js: blame of the
// bottleneck) that their instructions have. The lines come with the import (CE's asm[].source.line, main file only);
// the view shows only while the analyzed block is the imported one (same bytes, one row per imported instruction).
// Pasted assembly with .loc lines (asm-regions.js) has a source too: spans of bytes, file:line rows without the text.
// Opt-in (a row of the "more" section, there only after an import; its open state in the URL); a click on a line jumps
// to its costliest row.
//
// The first half has no DOM (tests-js/web_srcmap.mjs runs it under Node).

import { h } from './render.js';
import { boundModel, blame, defaultResource } from './bound.js';
import { jumpToRow } from './rowjump.js';
import { spanLines } from './asm-regions.js';

const CONTEXT = 1;      // source lines shown around the mapped ones
const MAX_LINES = 400;  // at most this many source lines

// src: {text, lines: [line | null per imported instruction], hex}. {resource, unit, lines: [{line, text, share, rows,
// top}], unmapped, total} or null (not the imported block, or nothing to attribute).
export function srcModel(response, src, hex) {
  const rows = response?.rows;
  if (!Array.isArray(rows) || !src || (src.hex && hex && src.hex !== hex)) return null;
  if (Array.isArray(src.spans)) src = { ...src, lines: spanLines(rows, src.spans) }; // pasted asm with .loc (asm-regions.js)
  if (!Array.isArray(src.lines)) return null;
  const instrRows = [];
  rows.forEach((x, row) => { if (x.kind === 'instr') instrRows.push(row); });
  if (instrRows.length !== src.lines.length || !src.lines.some((l) => l > 0)) return null;
  const m = boundModel(response);
  const resource = defaultResource(m);
  let b = resource ? blame(response, resource) : null;
  let unit = b?.unit ?? 'uops';
  let w = b?.weights ?? null;
  if (!w) { // nothing to attribute to the bottleneck: the issued uops
    const i = response.columns?.indexOf('Issued') ?? -1;
    if (i < 0) return null;
    w = rows.map((x) => Number(x.values?.[i]) || 0);
    unit = 'uops';
  }
  // the weight of an extra uop row goes to the instruction below it (it belongs to it)
  const lineOfRow = new Map();
  instrRows.forEach((row, k) => lineOfRow.set(row, src.lines[k] > 0 ? src.lines[k] : null));
  const per = new Map();
  let total = 0, unmapped = 0;
  let pending = 0;
  rows.forEach((x, row) => {
    const v = Number(w[row]) || 0;
    if (x.kind !== 'instr') { pending += v; return; }
    const value = v + pending;
    pending = 0;
    total += value;
    const line = lineOfRow.get(row);
    if (line === null) { unmapped += value; return; }
    const e = per.get(line) ?? { value: 0, rows: [], top: row, topValue: -1 };
    e.value += value;
    e.rows.push(row);
    if (value > e.topValue) { e.top = row; e.topValue = value; }
    per.set(line, e);
  });
  const noText = src.text == null; // pasted asm: no source text, its file:line instead, no context
  const text = String(src.text ?? '').split('\n');
  const ctx = noText ? 0 : CONTEXT;
  // the mapped lines with CONTEXT lines around each; a gap between two windows is one line {gap: n} (an inlined helper
  // far from the loop does not hide it); at most MAX_LINES source lines
  const mapped = [...per.keys()].sort((a, b) => a - b);
  const show = new Set();
  for (const l of mapped) for (let k = Math.max(1, l - ctx); k <= l + ctx && k <= Math.max(text.length, l); k++) show.add(k);
  const order = [...show].sort((a, b) => a - b).slice(0, MAX_LINES);
  const lines = [];
  order.forEach((line, k) => {
    if (k > 0 && line > order[k - 1] + 1) lines.push({ gap: line - order[k - 1] - 1 });
    const e = per.get(line);
    lines.push({ line, text: noText ? (src.file ? `${src.file}:${line}` : `line ${line}`) : text[line - 1] ?? '', share: e && total > 0 ? e.value / total : 0, rows: e?.rows ?? [], top: e ? e.top : -1 });
  });
  return { resource: resource === 'col:Div' ? 'Divider' : resource ?? 'Issued', unit, lines, unmapped: total > 0 ? unmapped / total : 0, total };
}

// ---- the view ----------------------------------------------------------------------------------------------------

const pct = (x) => `${Math.round(x * 100)}%`;

// env: { getSource() -> {text, lines, hex} | null, onToggle(open) }
export function createSrcMap(env) {
  let open = false;
  let row = null, details = null, body = null, hint = null;
  let root = null, view = null;

  function ensureRow() {
    if (row?.isConnected) return row;
    hint = h('span', { class: 'hint sm-hint' });
    details = h('details', { class: 'sm', id: 'srcmap' }, h('summary', { title: 'the share of the bottleneck per line of the imported source' }, 'per line', hint));
    details.open = open;
    let last = open;
    details.addEventListener('toggle', () => {
      if (details.open === last) return;
      last = open = details.open;
      env.onToggle?.(open);
      paint();
    });
    body = h('div', { class: 'sm-body' });
    details.append(body);
    row = h('div', { class: 'row', id: 'srcmap-row' }, h('div', { class: 'label', text: 'source' }), h('div', { class: 'field' }, details));
    // the last view (its tab is last: it comes only with an import, and the other tabs keep their places)
    document.getElementById('more')?.append(row);
    return row;
  }

  function paint() {
    const r = view?.response;
    const m = r && !r.error ? srcModel(r, env.getSource?.(), view.hex) : null;
    if (!m) { if (row) { row.hidden = true; body.replaceChildren(); } return; }
    ensureRow(); // only once there is an imported source
    row.hidden = false;
    const best = m.lines.reduce((a, x) => (x.share > (a?.share ?? 0) ? x : a), null);
    const src = m.lines.filter((x) => !x.gap);
    hint.textContent = best ? ` · line ${best.line} ${pct(best.share)}` : '';
    if (!open) { body.replaceChildren(); body.dataset.state = 'closed'; return; }
    const max = Math.max(...src.map((x) => x.share), 1e-9);
    const items = m.lines.map((x) => {
      if (x.gap) return h('li', { class: 'sm-l none sm-gap', title: `${x.gap} line${x.gap === 1 ? '' : 's'} without instructions of the block` }, h('span', { class: 'sm-no', text: '⋮' }));
      const fill = h('span', { class: 'sm-fill' });
      fill.style.width = `${((100 * x.share) / max).toFixed(1)}%`;
      const parts = [h('span', { class: 'sm-no', text: String(x.line) }), h('span', { class: 'sm-bar', 'aria-hidden': 'true' }, fill),
        h('span', { class: 'sm-pct', text: x.rows.length ? pct(x.share) : '' }), h('span', { class: 'sm-code', text: x.text })];
      if (!x.rows.length) return h('li', { class: 'sm-l none' }, ...parts);
      const b = h('button', { type: 'button', class: 'plain sm-l', title: `line ${x.line}: ${x.rows.length} instruction${x.rows.length === 1 ? '' : 's'}, ${pct(x.share)} of ${m.resource} (${m.unit})` }, ...parts);
      b.addEventListener('click', () => jumpToRow(root, x.top));
      return h('li', null, b);
    });
    body.replaceChildren(...[h('ol', { class: 'sm-list', 'aria-label': `source lines, share of ${m.resource}` }, items),
      m.unmapped > 0.005 ? h('p', { class: 'hint', text: `no line: ${pct(m.unmapped)}` }) : null].filter(Boolean));
    body.dataset.state = 'drawn';
  }

  return {
    decorate(target, v) { root = target; view = v; paint(); },
    setOpen(o) { open = !!o; if (details) details.open = open; },
    open: () => open,
  };
}
