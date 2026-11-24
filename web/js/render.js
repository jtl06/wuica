// Builds the result view. All text goes in through textContent: responses, fragments and diagnostics are data.

import { columnKind } from './bound-core.js';
import { caveats } from './caveats.js';
import { formatListing } from './listing.js';
import { accuracyNote } from './archs.js';
import { VRows, ALL_UP_TO } from './vrows.js';
import { colorInstr } from './asm-hl.js';

const UOPS_INFO = 'https://www.uops.info/';

export const NOTES = Object.freeze({
  M: 'macro-fused with the previous instruction',
  J: 'block not in the DSB (uop cache) because of the JCC erratum',
  X: 'instruction not supported (no data)',
});

// children: nodes, text, or arrays of them, nested to any depth (a list built with flatMap can hold a part that is a list
// itself; String() of a node would put "[object HTMLSpanElement]" into the page)
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
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

export { columnKind }; // (bound-core.js: the page and the npm package share it)

export function row(label, ...content) {
  return h('div', { class: 'row' }, h('div', { class: 'label', text: label }), h('div', { class: 'field' }, ...content));
}
// a row whose label is for screen readers only: its content says what it is (the throughput line)
function leadRow(label, ...content) {
  return h('div', { class: 'row lead' }, h('div', { class: 'label', text: label }), h('div', { class: 'field' }, ...content));
}

function sep() { return h('span', { class: 'sep', text: ' · ' }); }

// Copies text to the clipboard; true if it worked. Falls back to a hidden text area where the API is refused.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
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
// text: the text, or a function that makes it. The text goes into the page when the block is opened: a long block's
// listing and report are hundreds of kB, which the page would lay out on every result even while they are closed.
function textBlock(cls, summary, text, open, onToggle) {
  let made = null;
  const get = () => (made ??= typeof text === 'function' ? text() : text);
  const pre = h('pre', { class: cls, tabindex: '0', 'aria-label': summary });
  const d = h('details', { class: `${cls}-wrap text-block`, open },
    h('summary', { text: summary }),
    copyButton(get, summary),
    pre);
  const fill = () => { if (!pre.firstChild && (d.open || typeof text !== 'function')) pre.textContent = get(); };
  fill();
  let last = !!open; // the toggle event also fires for the initial state: report changes only
  d.addEventListener('toggle', () => { fill(); if (d.open !== last) { last = d.open; onToggle(d.open); } });
  return d;
}

const spacedHex = (hex, max = 48) => (hex.slice(0, 2 * max).match(/../g) ?? []).join(' ') + (hex.length > 2 * max ? ' …' : '');

// A cycle count: two decimals, three significant digits below 0.1 (per element; as ab-diff.js cycles)
// A–B: the tag of the side a view shows ("A", "B"; ab.css .ab-tag), or null outside A–B (view.side: 'a' | 'b')
export const sideTag = (view) => (view?.side === 'a' || view?.side === 'b' ? h('span', { class: `ab-tag${view.side === 'b' ? ' b' : ''}`, text: view.side.toUpperCase() }) : null);
export const cyc = (v) => { const a = Math.abs(v); return a !== 0 && a < 0.1 ? v.toPrecision(3) : v.toFixed(2); };

// one compact item per limit: name, value and a small bar (relative to the largest); w: elements per iteration
function limitsView(r, w = 1) {
  const max = Math.max(r.tp || 0, ...r.limits.map((l) => l.tp || 0), 1e-9);
  const box = h('ul', { class: 'limits' });
  for (const l of r.limits) {
    const hot = r.bottlenecks.includes(l.name) ? ' is-bottleneck' : '';
    const gauge = h('span', { class: 'gauge', 'aria-hidden': 'true' }, h('span'));
    gauge.firstChild.style.width = `${Math.min(100, (100 * l.tp) / max).toFixed(1)}%`;
    box.append(h('li', { class: 'lim' + hot, title: `${Number(l.tp).toFixed(2)} cycles/iteration${w > 1 ? ` (${cyc(l.tp / w)} per element)` : ''} if ${l.name} were the only bottleneck` },
      h('span', { class: 'name', text: l.name }), ' ', h('span', { class: 'val', text: cyc(Number(l.tp) / w) }), gauge));
  }
  return box;
}

// A column's header as shown: "Port 0" as "P0" (the table fits more ports; the full name in the title and data-col)
export const shortColumn = (name) => { const m = /^Port (\w+)$/.exec(name); return m ? `P${m[1]}` : name; };
// A port column's group and number ("Port 5" -> P, 5; "ALU2" -> ALU, 2; "FP3" -> FP, 3), or null (Div, the counts):
// the header shows the group's name once, over its numbers, so a column is one number wide
export function columnGroup(name) {
  const m = /^Port (\w)$/.exec(name) ?? /^([A-Z]+)(\d)$/.exec(name);
  return m ? { group: name.startsWith('Port ') ? 'P' : m[1], n: m[name.startsWith('Port ') ? 1 : 2] } : null;
}

// The instruction column gives way when the ports would not fit: it is cut (with … ; the whole text in its tooltip) to
// the width the table's wrap has, and grows back when there is room (a resize, the input folded). Observed per wrap.
// The uop table cuts its instruction column; A–B's Δ table (ab.js) its two instruction columns, each as much.
const MIN_INSTR_PX = { uops: 120, 'ab-diff': 80 };
const fitting = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
  for (const e of entries) requestAnimationFrame(() => fitInstr(e.target)); // (outside the observer's delivery)
}) : null;
// Measured, not computed: the instructions' texts (style.css caps them, not the cells: a table cell's max-width does not
// bind its column) start uncut and are cut until nothing sticks out of the wrap (scrollWidth also counts what overflows
// the table: borders, a group's name over a narrow last column, rounding), a few times at most.
export function fitInstr(wrap) {
  const t = wrap?.querySelector?.(':scope > table.uops, :scope > table.ab-diff');
  if (!t || !wrap.isConnected || wrap.clientWidth === 0) return;
  const kind = t.classList.contains('uops') ? 'uops' : 'ab-diff';
  const texts = [...t.querySelectorAll(kind === 'uops' ? 'tbody th.first > :first-child' : 'tbody td.ab-i > span:first-child')];
  if (!texts.length) return;
  const n = kind === 'uops' ? 1 : 2; // (the columns that give way)
  t.style.removeProperty('--ins-max');
  for (let i = 0; i < 8; i++) {
    const over = t.scrollWidth - wrap.clientWidth;
    if (over <= 0) return;
    const w = Math.max(...texts.map((x) => x.getBoundingClientRect().width));
    if (w <= MIN_INSTR_PX[kind]) return;
    t.style.setProperty('--ins-max', `${Math.max(MIN_INSTR_PX[kind], Math.floor(w - over / n - 1))}px`);
  }
}
export function watchFit(wrap) { if (fitting && wrap) { fitting.observe(wrap); const t = wrap.querySelector(':scope > table'); if (t) fitting.observe(t); } return wrap; }

// limit: the number of rows drawn (a long block draws its first rows; a button draws the rest); the totals are of all rows.
// shown: the label shown for each row instead of its own, or null (branch targets as labels: branch-label.js)
export function uopTable(r, hideEmpty, limit = Infinity, { shown = null } = {}) { // (also used by the A–B view, ab.js)
  const n = r.columns.length;
  const totals = new Array(n).fill(0);
  for (const x of r.rows) for (let i = 0; i < n; i++) totals[i] += Number(x.values?.[i]) || 0;
  const kinds = r.columns.map(columnKind);
  const cols = [];
  for (let i = 0; i < n; i++) if (!hideEmpty || totals[i] !== 0) cols.push(i);
  // a thin line where a group of columns starts
  const groupStart = new Set();
  cols.forEach((i, k) => { if (k === 0 || kinds[i] !== kinds[cols[k - 1]]) groupStart.add(i); });
  const cls = (i, extra = '') => [extra, groupStart.has(i) ? 'grp' : ''].filter(Boolean).join(' ') || null;

  const head = h('tr', null,
    h('th', { scope: 'col', class: 'first', text: 'Instruction' }),
    h('th', { scope: 'col', class: 'note', text: 'Notes' }),
    cols.map((i, k) => {
      const name = r.columns[i], g = columnGroup(name);
      if (!g) return h('th', { scope: 'col', class: cls(i), 'data-col': name, text: name });
      const first = k === 0 || columnGroup(r.columns[cols[k - 1]])?.group !== g.group;
      return h('th', { scope: 'col', class: cls(i, 'pg'), 'data-col': name, title: name }, first ? h('span', { class: 'cg', text: g.group }) : null, g.n);
    }));

  // a row of the model (vrows.js draws the rows near the view of a long table)
  const make = (k) => {
    const x = r.rows[k];
    const extra = x.kind !== 'instr';
    const text = shown?.[k] ?? x.label;
    let label = text;
    if (!extra && typeof x.url === 'string' && x.url.startsWith(UOPS_INFO)) {
      label = h('a', { href: x.url, rel: 'noopener noreferrer', target: '_blank', title: `${x.label}\n${x.instrStr ? `${x.instrStr} on uops.info` : 'uops.info'}`, text });
    } else label = h('span', { title: x.label, text }); // (the whole instruction: the column can be cut, on phones)
    if (!extra && x.notes !== 'X') colorInstr(label, text); // (in colour: an instruction with data; the text stays)
    const tr = h('tr', { class: [extra ? 'extra' : '', x.notes === 'X' ? 'unsupported' : ''].filter(Boolean).join(' ') || null },
      h('th', { scope: 'row', class: 'first' }, label),
      h('td', { class: 'note', title: NOTES[x.notes] ?? null, text: x.notes ?? '' }));
    for (const i of cols) {
      const v = Number(x.values?.[i]) || 0;
      const td = h('td', { class: cls(i, kinds[i] === 'port' && v !== 0 ? 'heat' : ''), text: fmt(v) });
      if (kinds[i] === 'port' && v !== 0) td.style.setProperty('--h', Math.min(1, Math.max(0.12, v)).toFixed(2));
      tr.append(td);
    }
    return tr;
  };
  // a long table (drawn in a window): the widest text of each column, in a row that takes no height (visibility:
  // collapse), so the columns keep their width whichever rows are drawn (the port fit, fitInstr, measures its
  // instruction too); a short one draws all its rows anyway
  const body = h('tbody');
  if (r.rows.length > ALL_UP_TO) {
    const widest = (texts) => texts.reduce((a, t) => (t.length > a.length ? t : a), '');
    const label = widest(r.rows.map((x, k) => String(shown?.[k] ?? x.label ?? '')));
    body.append(h('tr', { class: 'vr-size', 'aria-hidden': 'true' },
      h('th', { class: 'first' }, h('span', { text: label })),
      h('td', { class: 'note', text: widest(r.rows.map((x) => String(x.notes ?? ''))) }),
      cols.map((i) => h('td', { class: cls(i), text: widest(r.rows.map((x) => fmt(Number(x.values?.[i]) || 0))) }))));
  }
  const vr = new VRows(body, r.rows.length, make);

  const foot = h('tr', null,
    h('th', { scope: 'row', class: 'first', text: 'Total' }),
    h('td', { class: 'note' }),
    cols.map((i) => h('td', { class: cls(i), text: fmt(totals[i]) })));

  const table = h('table', { class: 'grid uops' }, h('thead', null, head), body, h('tfoot', null, foot));
  table.vr = vr;
  return { table, hidden: n - cols.length, notes: new Set(r.rows.map((x) => x.notes).filter((k) => NOTES[k])), more: 0 };
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
//   inputMode,                'asm' | 'hex': the listing remembers its open state per input mode
//   elapsedMs,                (the cycle-by-cycle trace is drawn by app.js below the result, full width)
//   ui: { hideEmpty, reportOpen, listingOpen: {asm, hex} (null: closed) }, onUi(name, value)
//   config,                   the CPU's configuration in uarch.json (configs[archKey]), for the caveats (optional)
// }
// Known blind spots of the model that the block meets (caveats.js): one small line, the details in the tooltips.
function caveatLine(r, config) {
  const cv = caveats(r, config);
  if (!cv.length) return null;
  return h('div', { class: 'cv-line' }, h('span', { class: 'k', text: 'not modelled' }), ' ',
    cv.flatMap((c, k) => [k ? ' · ' : '', h('span', { class: 'cv', 'data-cv': c.id, title: c.title, text: c.text })]));
}

// When uiCA names no bottleneck: the largest limit(s) and their value ("Ports 4.00"), the nearest bound (the npm
// package's insights.largest), or '' if there are no limits.
export function nearestLimit(r, w = 1) {
  const lims = (r?.limits ?? []).map((l) => ({ name: l.name, tp: Number(l.tp) })).filter((l) => Number.isFinite(l.tp));
  if (!lims.length) return '';
  const max = Math.max(...lims.map((l) => l.tp));
  return `${lims.filter((l) => l.tp >= max - 0.005).map((l) => l.name).join(', ')} ${w > 1 ? cyc(max / w) : max.toFixed(2)}`;
}

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
    const w = view.work > 1 ? view.work : 1; // elements per iteration (url-state.js aWork): then per element
    // code this CPU cannot run (caveats.js cannotRun, app.js): the number struck, why under it
    const bad = view.invalid ?? null;
    const mode = r.mode === 'loop' ? h('span', { class: 'tag', title: 'ends in a branch: analyzed as a loop', text: 'loop' })
      : r.mode === 'unroll' ? h('span', { class: 'tag', title: 'no branch at the end: analyzed as if repeated back to back', text: 'unrolled' })
        : h('span', { class: 'tag', text: String(r.mode) });
    // as lean as uiCA's own output: the cpu and loop/unrolled; the counts and the time in the tooltip
    const instrs = r.rows.filter((x) => x.kind === 'instr').length;
    const details = [`${instrs} instruction${instrs === 1 ? '' : 's'}`, `${view.byteCount} byte${view.byteCount === 1 ? '' : 's'}`,
      view.elapsedMs !== null && view.elapsedMs !== undefined && !mock ? `${view.elapsedMs < 10 ? view.elapsedMs.toFixed(1) : Math.round(view.elapsedMs)} ms` : null,
      view.experimental ? 'prototype model: less validated' : null, view.experimental ? accuracyNote(view.archKey) || null : null].filter(Boolean).join(' · ');
    // one line: the throughput, loop/unrolled and the cpu, the bottleneck
    const bnKey = r.bottlenecks.length > 1 ? 'bottlenecks' : 'bottleneck';
    out.push(leadRow('throughput',
      h('div', { class: 'tp' },
        h('span', { class: 'tp-main' },
          h('span', { class: `value${bad ? ' invalid' : ''}`, title: bad ? `not a result: ${bad.title} (${Number(r.tp).toFixed(2)} cycles/iteration as computed)` : w > 1 ? `${Number(r.tp).toFixed(2)} cycles/iteration ÷ ${w}` : null, text: w > 1 ? cyc(Number(r.tp) / w) : Number(r.tp).toFixed(2) }), ' ',
          h('span', { class: `unit${view.workFlag ? ' caveat' : ''}`, title: view.workFlag ? 'the code changed since its elements per iteration were set' : null, text: `${w > 1 ? 'cycles/element' : 'cycles/iteration'}${view.workFlag ? '?' : ''}` })),
        h('span', { class: 'meta', title: details }, mode, sep(), h('span', { class: view.experimental ? 'caveat' : null, text: view.archTitle })),
        alignButton(view.alignTag),
        copyAllButton(),
        h('span', { class: 'bn-line' }, h('span', { class: 'k', text: bnKey }), ' ',
          r.bottlenecks.length ? h('span', { class: 'bn', text: r.bottlenecks.join(', ') })
            : h('span', { class: 'hint', title: `no single limit explains the throughput${nearestLimit(r, w) ? `; the nearest is ${nearestLimit(r, w)} (the API's insights.largest)` : ''}`,
              text: nearestLimit(r, w) ? `unknown · nearest ${nearestLimit(r, w)}` : 'unknown' }))),
      mock ? h('div', { class: 'mock-tag', text: mockLine(mock, view.archKey) }) : null,
      caveatLine(r, view.config),
      bad ? h('div', { class: 'caveat cannot-run', role: 'alert', title: bad.title, text: `not a result for ${view.archKey}: ${invalidText(bad)}` }) : null));

    if (r.limits.length) {
      out.push(h('div', { class: 'row', title: 'cycles/iteration if each were the only bottleneck' },
        h('div', { class: 'label', text: 'limits' }), h('div', { class: 'field' }, limitsView(r, w))));
    }

    // empty columns are left out, as in uiCA's table
    const { table } = uopTable(r, view.ui.hideEmpty ?? true, Infinity, { shown: view.shown });
    out.push(leadRow('uops', // the table says what it is: it gets the whole width
      h('div', { class: 'table-tools' }), // filled by other views (e.g. the cost toggle of insight-view.js); empty otherwise
      watchFit(h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Uops per instruction, average per iteration',
        title: 'average uops per iteration' }, table))));

    const listingOpen = view.ui.listingOpen?.[view.inputMode] ?? false; // collapsed until opened
    out.push(h('div', { class: 'row text-row' }, h('div', { class: 'label', text: 'text' }), h('div', { class: 'field' },
      textBlock('listing', 'objdump', r.rows.length > ALL_UP_TO ? () => formatListing(r.rows, view.shown).text : formatListing(r.rows, view.shown).text, listingOpen, (open) => view.onUi('listingOpen', { ...view.ui.listingOpen, [view.inputMode]: open })),
      textBlock('report', 'uiCA report', typeof r.text !== 'string' ? '' : r.rows.length > ALL_UP_TO ? () => r.text : r.text, view.ui.reportOpen, (open) => view.onUi('reportOpen', open)))));
  }

  root.replaceChildren(...out);
}

// The alignment offset when it is not the default (app.js alignTag: {offset, reset}): a small tag next to the headline
// that sets it back; null for none
export function alignButton(tag) {
  if (!tag) return null;
  const b = h('button', { type: 'button', class: 'plain align-tag', title: `the code at alignment offset ${tag.offset} (not 0): click to set it back`, 'aria-label': `alignment offset ${tag.offset}: set back to 0` },
    `offset ${tag.offset} `, h('span', { 'aria-hidden': 'true', text: '×' }));
  b.addEventListener('click', () => tag.reset());
  return b;
}

// Why a CPU cannot run the code (caveats.js cannotRun): "needs AVX-512 · 12 undecodable positions skipped"
export function invalidText(bad) {
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  return [bad.needs.length ? `needs ${bad.needs.join(', ')}` : '', bad.decodeErrors ? `${n(bad.decodeErrors, 'undecodable position', 'undecodable positions')} skipped` : '',
    bad.unsupported ? `${n(bad.unsupported, 'instruction', 'instructions')} not supported` : ''].filter(Boolean).join(' · ');
}

// The control that copies the whole result (copy-view.js, the provider 'all')
// The assembler's messages under a code box: a list that scrolls by itself (style.css .messages: a few lines high, so a
// long list never pushes the box's controls away or draws over them), with their count when there are more than a few.
// items: [{line, column, severity, message}]; select(line) when a message with a line is clicked.
export function messageList(items, select) {
  const list = h('ul', { tabindex: items.length > 4 ? '0' : null, 'aria-label': `${items.length} message${items.length === 1 ? '' : 's'}` });
  for (const d of items) {
    const text = `${d.line ? `line ${d.line}${d.column ? ':' + d.column : ''}: ` : ''}${d.severity === 'warning' ? 'warning: ' : ''}${d.message}`;
    const li = h('li', { class: d.severity === 'error' ? null : d.severity });
    if (d.line) {
      const b = h('button', { type: 'button', class: 'plain', title: `select line ${d.line}`, text });
      b.addEventListener('click', () => select(d.line));
      li.append(b);
    } else li.textContent = text;
    list.append(li);
  }
  const errors = items.filter((d) => d.severity === 'error').length;
  const count = items.length > 4 ? h('p', { class: 'msg-count', text: `${items.length} messages${errors && errors < items.length ? ` (${errors} error${errors === 1 ? '' : 's'})` : ''}` }) : null;
  return [count, list].filter(Boolean);
}

export function copyAllButton() {
  const b = h('button', { type: 'button', class: 'plain copy-all', title: 'copy the whole result as Markdown: the headline, the CPUs, the limits, the caveats, the uop table, the code and the link', text: 'copy all' });
  b.addEventListener('click', () => document.dispatchEvent(new CustomEvent('wuica:copy', { detail: { tab: 'all', format: 'md' } })));
  return b;
}

export function renderEmpty(root, text = '') {
  root.replaceChildren(...(text ? [h('p', { class: 'empty', text })] : []));
}

export function renderFailure(root, text) {
  root.replaceChildren(h('div', { class: 'error-box', role: 'alert', text }));
}
