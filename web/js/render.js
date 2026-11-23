// Builds the result view. All text goes in through textContent: responses, fragments and diagnostics are data.

import { formatListing } from './listing.js';

const FRONT_END = ['MITE', 'MS', 'DSB', 'LSD'];
const COUNTS = ['Issued', 'Exec.'];
const UOPS_INFO = 'https://www.uops.info/';

export const NOTES = Object.freeze({
  M: 'macro-fused with the previous instruction',
  J: 'block not in the DSB (uop cache) because of the JCC erratum',
  X: 'instruction not supported (no data)',
});
const LEGEND = Object.freeze({ M: 'macro-fused', J: 'JCC erratum', X: 'no data' });

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// uiCA prints the table values with up to two decimals and leaves zeros blank.
export function fmt(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) return '';
  return String(Math.round(v * 100) / 100);
}

export function columnKind(name) {
  if (FRONT_END.includes(name)) return 'front';
  if (COUNTS.includes(name)) return 'count';
  return 'port'; // "Port 0", "ALU0", "FP2", "Div", ...: every other column is an execution resource
}

function row(label, ...content) {
  return h('div', { class: 'row' }, h('div', { class: 'label', text: label }), h('div', { class: 'field' }, ...content));
}

function sep() { return h('span', { class: 'sep', text: ' · ' }); }

// Copies text to the clipboard; true if it worked. Falls back to a hidden text area where the API is refused.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const active = document.activeElement;
    const t = h('textarea', { readonly: true, 'aria-hidden': 'true', tabindex: '-1' });
    t.value = text;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.append(t);
    t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    t.remove();
    active?.focus?.();
    return ok;
  }
}

function copyButton(getText, what) {
  const b = h('button', { type: 'button', class: 'plain copy', 'aria-label': `Copy ${what}`, text: 'copy' });
  b.addEventListener('click', async () => {
    const ok = await copyText(getText());
    b.textContent = ok ? 'copied' : 'copy failed';
    setTimeout(() => { b.textContent = 'copy'; }, 1500);
  });
  return b;
}

// A collapsible block of plain text with a copy button; `open` is kept by the caller across redraws.
function textBlock(cls, summary, text, open, onToggle) {
  const d = h('details', { class: `${cls}-wrap text-block`, open },
    h('summary', { text: summary }),
    copyButton(() => text, summary),
    h('pre', { class: cls, tabindex: '0', 'aria-label': summary, text }));
  let last = !!open; // the toggle event also fires for the initial state: report changes only
  d.addEventListener('toggle', () => { if (d.open !== last) { last = d.open; onToggle(d.open); } });
  return d;
}

const spacedHex = (hex, max = 48) => (hex.slice(0, 2 * max).match(/../g) ?? []).join(' ') + (hex.length > 2 * max ? ' …' : '');

function limitsView(r) {
  const max = Math.max(r.tp || 0, ...r.limits.map((l) => l.tp || 0), 1e-9);
  const box = h('div', { class: 'limits' });
  for (const l of r.limits) {
    const hot = r.bottlenecks.includes(l.name) ? ' is-bottleneck' : '';
    const gauge = h('span', { class: 'gauge' + hot, 'aria-hidden': 'true' }, h('span'));
    gauge.firstChild.style.width = `${Math.min(100, (100 * l.tp) / max).toFixed(1)}%`;
    box.append(
      h('span', { class: 'name' + hot, text: l.name, title: `${Number(l.tp).toFixed(2)} cycles/iteration if ${l.name} were the only bottleneck` }),
      h('span', { class: 'val' + hot, text: Number(l.tp).toFixed(2) }),
      gauge,
    );
  }
  return box;
}

function uopTable(r, hideEmpty) {
  const n = r.columns.length;
  const totals = new Array(n).fill(0);
  for (const x of r.rows) for (let i = 0; i < n; i++) totals[i] += Number(x.values?.[i]) || 0;
  const kinds = r.columns.map(columnKind);
  const shown = [];
  for (let i = 0; i < n; i++) if (!hideEmpty || totals[i] !== 0) shown.push(i);
  // a thin line where a group of columns starts
  const groupStart = new Set();
  shown.forEach((i, k) => { if (k === 0 || kinds[i] !== kinds[shown[k - 1]]) groupStart.add(i); });
  const cls = (i, extra = '') => [extra, groupStart.has(i) ? 'grp' : ''].filter(Boolean).join(' ') || null;

  const head = h('tr', null,
    h('th', { scope: 'col', class: 'first', text: 'Instruction' }),
    h('th', { scope: 'col', class: 'note', text: 'Notes' }),
    shown.map((i) => h('th', { scope: 'col', class: cls(i), text: r.columns[i] })));

  const body = h('tbody');
  for (const x of r.rows) {
    const extra = x.kind !== 'instr';
    let label = x.label;
    if (!extra && typeof x.url === 'string' && x.url.startsWith(UOPS_INFO)) {
      label = h('a', { href: x.url, rel: 'noopener noreferrer', target: '_blank', title: x.instrStr ? `${x.instrStr} on uops.info` : 'uops.info', text: x.label });
    }
    const tr = h('tr', { class: [extra ? 'extra' : '', x.notes === 'X' ? 'unsupported' : ''].filter(Boolean).join(' ') || null },
      h('th', { scope: 'row', class: 'first' }, label),
      h('td', { class: 'note', title: NOTES[x.notes] ?? null, text: x.notes ?? '' }));
    for (const i of shown) {
      const v = Number(x.values?.[i]) || 0;
      const td = h('td', { class: cls(i, kinds[i] === 'port' && v !== 0 ? 'heat' : ''), text: fmt(v) });
      if (kinds[i] === 'port' && v !== 0) td.style.setProperty('--h', Math.min(1, Math.max(0.12, v)).toFixed(2));
      tr.append(td);
    }
    body.append(tr);
  }

  const foot = h('tr', null,
    h('th', { scope: 'row', class: 'first', text: 'Total' }),
    h('td', { class: 'note' }),
    shown.map((i) => h('td', { class: cls(i), text: fmt(totals[i]) })));

  const table = h('table', { class: 'grid uops' }, h('thead', null, head), body, h('tfoot', null, foot));
  return { table, hidden: n - shown.length, notes: new Set(r.rows.map((x) => x.notes).filter((k) => NOTES[k])) };
}

function mockLine(m, archKey) {
  if (m.synthetic) return 'mock data: synthetic, not a prediction';
  if (m.exact) return `mock data: recorded on ${m.arch}; options ignored`;
  if (m.sameCode) return `mock data: recorded on ${m.arch}, not ${archKey}`;
  return `mock data: another block (${m.arch}), not a prediction`;
}

// view: {
//   response,                 a response of docs/WASM-API.md (success or {error})
//   archKey, archTitle, experimental,
//   byteCount, hex,           the machine code that was analyzed
//   inputMode,                'asm' | 'hex': the listing starts open for assembly (it shows what it assembled to)
//   elapsedMs,
//   ui: { hideEmpty, reportOpen, listingOpen: {asm, hex} (null: by inputMode) }, onUi(name, value)
// }
export function renderResult(root, view) {
  const r = view.response;
  const out = [];
  const code = h('span', { class: 'code', text: `${view.byteCount} byte${view.byteCount === 1 ? '' : 's'}` });

  if (!r || typeof r !== 'object' || 'error' in r || !Array.isArray(r.rows) || !Array.isArray(r.columns)) {
    let message = 'Analysis failed: unexpected response';
    if (r && typeof r === 'object' && 'error' in r) {
      // `trapped`: the analyzer itself crashed on this input (engine.js restarts it)
      message = r.trapped ? `Analyzer crashed on this input${r.detail ? ' (' + r.detail + ')' : ''}; restarted`
        : `Analysis failed: ${r.error}`;
    }
    out.push(h('div', { class: 'error-box', role: 'alert' }, message));
    out.push(row('input', h('span', { class: 'meta' }, view.archTitle, sep(), code,
      view.hex ? [': ', h('span', { class: 'code', text: spacedHex(view.hex) })] : null)));
  } else {
    const mock = r.mock ? { ...r.mock, sameCode: r.mock.hex === view.hex } : null;
    const mode = r.mode === 'loop' ? h('span', { class: 'tag', title: 'ends in a branch: analyzed as a loop', text: 'loop' })
      : r.mode === 'unroll' ? h('span', { class: 'tag', title: 'no branch at the end: analyzed as if repeated back to back', text: 'unrolled' })
        : h('span', { class: 'tag', text: String(r.mode) });
    const instrs = r.rows.filter((x) => x.kind === 'instr').length;
    out.push(row('throughput',
      h('div', { class: 'tp' },
        h('span', { class: 'value', text: Number(r.tp).toFixed(2) }),
        h('span', { class: 'unit', text: 'cycles/iteration' })),
      h('div', { class: 'meta' }, mode, sep(), view.archTitle, sep(), `${instrs} instruction${instrs === 1 ? '' : 's'}`, sep(), code,
        view.elapsedMs !== null && !mock ? [sep(), `${view.elapsedMs < 10 ? view.elapsedMs.toFixed(1) : Math.round(view.elapsedMs)} ms`] : null),
      mock ? h('div', { class: 'mock-tag', text: mockLine(mock, view.archKey) }) : null,
      view.experimental ? h('div', { class: 'caveat', text: 'prototype model: less validated' }) : null,
      r.decodeErrors > 0 ? h('div', { class: 'caveat', role: 'alert',
        text: `${r.decodeErrors} undecodable position${r.decodeErrors === 1 ? '' : 's'} skipped` }) : null));

    out.push(row(r.bottlenecks.length > 1 ? 'bottlenecks' : 'bottleneck',
      r.bottlenecks.length ? h('span', { class: 'bn', text: r.bottlenecks.join(', ') })
        : h('span', { class: 'hint', title: 'no single limit explains the throughput', text: 'unknown' })));

    if (r.limits.length) {
      out.push(h('div', { class: 'row', title: 'cycles/iteration if each were the only bottleneck' },
        h('div', { class: 'label', text: 'limits' }), h('div', { class: 'field' }, limitsView(r))));
    }

    const { table, hidden, notes } = uopTable(r, view.ui.hideEmpty);
    const toggle = h('input', { type: 'checkbox', id: 'hide-empty', checked: view.ui.hideEmpty });
    toggle.checked = view.ui.hideEmpty;
    toggle.addEventListener('change', () => view.onUi('hideEmpty', toggle.checked));
    out.push(row('uops',
      h('div', { class: 'table-tools' },
        h('label', null, toggle, ` hide empty columns${hidden ? ` (${hidden})` : ''}`)),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Uops per instruction, average per iteration',
        title: 'average uops per iteration' }, table),
      notes.size ? h('p', { class: 'legend' },
        [...notes].map((k) => h('span', { title: NOTES[k] }, h('b', { text: k }), ` ${LEGEND[k]}`))) : null));

    const listingOpen = view.ui.listingOpen?.[view.inputMode] ?? view.inputMode === 'asm';
    out.push(row('text',
      textBlock('listing', 'objdump', formatListing(r.rows).text, listingOpen, (open) => view.onUi('listingOpen', { ...view.ui.listingOpen, [view.inputMode]: open })),
      textBlock('report', 'uiCA report', typeof r.text === 'string' ? r.text : '', view.ui.reportOpen, (open) => view.onUi('reportOpen', open))));
    if (view.trace) out.push(row('trace', view.trace)); // the cycle-by-cycle trace panel (trace.js)
  }

  root.replaceChildren(...out);
}

export function renderEmpty(root, text = '') {
  root.replaceChildren(...(text ? [h('p', { class: 'empty', text })] : []));
}

export function renderFailure(root, text) {
  root.replaceChildren(h('div', { class: 'error-box', role: 'alert', text }));
}
