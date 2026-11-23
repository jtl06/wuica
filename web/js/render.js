// Builds the result view. All text goes in through textContent: responses, fragments and diagnostics are data.

const FRONT_END = ['MITE', 'MS', 'DSB', 'LSD'];
const COUNTS = ['Issued', 'Exec.'];
const UOPS_INFO = 'https://www.uops.info/';

export const NOTES = Object.freeze({
  M: 'macro-fused with the previous instruction',
  J: 'block not in the DSB (uop cache) because of the JCC erratum',
  X: 'instruction not supported (no data)',
});

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

function limitsView(r) {
  const max = Math.max(r.tp || 0, ...r.limits.map((l) => l.tp || 0), 1e-9);
  const box = h('div', { class: 'limits' });
  for (const l of r.limits) {
    const hot = r.bottlenecks.includes(l.name) ? ' is-bottleneck' : '';
    const gauge = h('span', { class: 'gauge' + hot, 'aria-hidden': 'true' }, h('span'));
    gauge.firstChild.style.width = `${Math.min(100, (100 * l.tp) / max).toFixed(1)}%`;
    box.append(
      h('span', { class: 'name' + hot, text: l.name }),
      h('span', { class: 'val' + hot, text: Number(l.tp).toFixed(2) }),
      gauge,
    );
  }
  return box;
}

export function uopTable(r, hideEmpty) { // (also used by the A–B view, ab.js)
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
  return { table, hidden: n - shown.length };
}

function mockLine(m, archKey) {
  if (m.synthetic) return `mock data: a synthetic result that only exercises this page; not a prediction`;
  if (m.exact) return `mock data: the reference's recorded result for this code on ${m.arch}; options are ignored`;
  if (m.sameCode) return `mock data: recorded for this code on ${m.arch}, not on ${archKey}; not a prediction for ${archKey}`;
  return `mock data: a recorded sample (another block, ${m.arch}); NOT a prediction for your input`;
}

// view: {
//   response,                 a response of docs/WASM-API.md (success or {error})
//   archKey, archTitle, experimental,
//   byteCount, hex,           the machine code that was analyzed
//   elapsedMs,
//   ui: { hideEmpty, reportOpen }, onUi(name, value)
// }
export function renderResult(root, view) {
  const r = view.response;
  const out = [];
  const code = h('span', { class: 'code', text: `${view.byteCount} byte${view.byteCount === 1 ? '' : 's'}` });

  if (!r || typeof r !== 'object' || 'error' in r || !Array.isArray(r.rows) || !Array.isArray(r.columns)) {
    let message = 'Analysis failed: the analyzer returned an unexpected response.';
    if (r && typeof r === 'object' && 'error' in r) {
      // `trapped`: the analyzer itself crashed on this input (engine.js restarts it)
      message = r.trapped ? `The analysis failed for this input (the analyzer stopped${r.detail ? ': ' + r.detail : ''}; it has been restarted).`
        : `Analysis failed: ${r.error}`;
    }
    out.push(h('div', { class: 'error-box', role: 'alert' }, message));
    out.push(row('input', h('span', { class: 'meta' }, view.archTitle, sep(), code)));
  } else {
    const mock = r.mock ? { ...r.mock, sameCode: r.mock.hex === view.hex } : null;
    const mode = r.mode === 'loop' ? 'analyzed as a loop (the block ends in a branch)'
      : r.mode === 'unroll' ? 'analyzed unrolled (as if the block were repeated back to back)' : `mode: ${r.mode}`;
    const instrs = r.rows.filter((x) => x.kind === 'instr').length;
    out.push(row('throughput',
      h('div', { class: 'tp' },
        h('span', { class: 'value', text: Number(r.tp).toFixed(2) }),
        h('span', { class: 'unit', text: 'cycles per iteration' })),
      h('div', { class: 'meta' }, mode),
      h('div', { class: 'meta' }, view.archTitle, sep(), `${instrs} instruction${instrs === 1 ? '' : 's'}`, sep(), code,
        view.elapsedMs !== null && !mock ? [sep(), `${view.elapsedMs < 10 ? view.elapsedMs.toFixed(1) : Math.round(view.elapsedMs)} ms`] : null),
      mock ? h('div', { class: 'mock-tag', text: mockLine(mock, view.archKey) }) : null,
      view.experimental ? h('div', { class: 'caveat', text: 'experimental model: less validated than the stock Intel models' }) : null,
      r.decodeErrors > 0 ? h('div', { class: 'caveat', role: 'alert',
        text: `${r.decodeErrors} position${r.decodeErrors === 1 ? '' : 's'} could not be decoded and ${r.decodeErrors === 1 ? 'was' : 'were'} skipped; only the decoded instructions are analyzed` }) : null));

    out.push(row(r.bottlenecks.length > 1 ? 'bottlenecks' : 'bottleneck',
      r.bottlenecks.length ? h('span', { class: 'bn', text: r.bottlenecks.join(', ') })
        : h('span', { class: 'hint', text: 'unknown (no single limit explains the throughput)' })));

    if (r.limits.length) {
      out.push(row('limits', limitsView(r),
        h('p', { class: 'hint', text: 'cycles per iteration if the given property were the only bottleneck' })));
    }

    const { table, hidden } = uopTable(r, view.ui.hideEmpty);
    const toggle = h('input', { type: 'checkbox', id: 'hide-empty', checked: view.ui.hideEmpty });
    toggle.checked = view.ui.hideEmpty;
    toggle.addEventListener('change', () => view.onUi('hideEmpty', toggle.checked));
    out.push(row('uops',
      h('div', { class: 'table-tools' },
        h('span', { text: 'average per iteration, by instruction' }),
        h('label', null, toggle, ` hide empty columns${hidden ? ` (${hidden} hidden)` : ''}`)),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Uops per instruction' }, table),
      h('p', { class: 'legend' },
        Object.entries(NOTES).map(([k, v]) => h('span', null, h('b', { text: k }), ` ${v}`)))));

    const report = h('details', { class: 'report-wrap', open: view.ui.reportOpen },
      h('summary', { text: 'Plain text report' }),
      h('pre', { class: 'report', tabindex: '0', text: typeof r.text === 'string' ? r.text : '' }));
    report.addEventListener('toggle', () => view.onUi('reportOpen', report.open));
    out.push(row('report', report));
  }

  root.replaceChildren(...out);
}

export function renderEmpty(root, text) {
  root.replaceChildren(h('p', { class: 'empty', text }));
}

export function renderFailure(root, text) {
  root.replaceChildren(h('div', { class: 'error-box', role: 'alert', text }));
}
