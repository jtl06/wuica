// A–B mode: two versions of a block side by side. Side A is the page's own editor (#code, with the format,
// examples, cpu and options above it); this module adds the "single / A–B" switch, side B next to A (its own
// input format, optionally its own cpu), swap and copy, and the comparison view (headline, bottlenecks, limits,
// an instruction-by-instruction diff and the two uop tables).
//
// Its state is part of the page's state (url-state.js: ab, bMode, bSyntax, bArch, bText, bScale), so a link
// carries both sides. The page (app.js) runs the analyses: inputs() gets the machine code of both sides,
// analyze() runs them, draw() shows the result. All text goes in through textContent.

import { h, uopTable, NOTES } from './render.js';
import { compareResponses, signed } from './ab-diff.js';
import { parseHexInput, toHex } from './hex-input.js';

const PLACEHOLDERS = {
  hex: '48 83 c0 02 49 ff cf 75 f7',
  asm: 'loop:\n  add rax, 2\n  dec r15\n  jnz loop',
};
const STATUS_MARK = { same: '', changed: '•', modified: '~', added: '+', removed: '−' };
const STATUS_TEXT = {
  same: 'same', changed: 'same instruction, other uops', modified: 'changed operands', added: 'only in B', removed: 'only in A',
};

const two = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '–');
function percent(p) {
  if (p === null || !Number.isFinite(p)) return '';
  const a = Math.abs(p);
  return `${p < 0 ? '−' : '+'}${a < 10 ? a.toFixed(1) : String(Math.round(a))}%`;
}
const sign2 = (v) => (Math.abs(v) < 0.005 ? '0' : `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)}`); // cycle counts
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ok =(r) => !!r && typeof r === 'object' && !('error' in r) && Array.isArray(r.rows) && Array.isArray(r.columns);

// api (from app.js):
//   state, el: {code, body}, archItems() -> Map, archTitle(key), ensureAssembler(), ensureTable(key),
//   machineCodeA(runId) -> bytes | null (shows A's messages), getA() / setA({mode, syntax, text}, {run}),
//   changed({rerun}), toggled() (the mode changed), writeControls(), openImport(side), watchPaste(textarea, side)
export function createAB(api) {
  const { state } = api;
  const buffers = { hex: '', asm: '' }; // B's text of each input mode
  const ui = { hideEmpty: true, onlyChanges: false, reportOpen: false };
  let shown = null; // the view on the page

  // ---- the switch ----------------------------------------------------------------------------------------------
  const rSingle = h('input', { type: 'radio', name: 'compare', value: 'single', id: 'cmp-single' });
  const rAB = h('input', { type: 'radio', name: 'compare', value: 'ab', id: 'cmp-ab' });
  const swap = h('button', { type: 'button', id: 'ab-swap', title: 'exchange the two sides: code, input format and cpu' }, 'swap A ⇄ B');
  const copy = h('button', { type: 'button', id: 'ab-copy', title: 'replace B with a copy of A, to start an optimization' }, 'copy A → B');
  const switchRow = h('div', { class: 'row ab-switch' },
    h('div', { class: 'label', id: 'l-compare', text: 'compare' }),
    h('div', { class: 'field wrap' },
      h('div', { class: 'choice', role: 'radiogroup', 'aria-labelledby': 'l-compare' },
        h('label', null, rSingle, 'single'), h('label', null, rAB, 'A–B')),
      h('span', { class: 'ab-tools ab-only' }, swap, copy)));
  const heading = document.getElementById('h-input');
  if (heading) heading.after(switchRow); else api.el.code.closest('section')?.prepend(switchRow);

  // ---- side A: a caption over the page's editor ----------------------------------------------------------------
  // The editor's own elements go into a column (display: contents outside A–B mode: the layout does not change).
  const field = api.el.code.parentElement;
  const aCol = h('div', { class: 'field ab-a-col' });
  aCol.append(...field.childNodes);
  field.append(aCol);
  const aDesc = h('span', { class: 'ab-desc' });
  const aHead = h('div', { class: 'ab-head ab-a ab-only' }, h('span', { class: 'ab-tag', text: 'A' }), aDesc);
  aCol.insertBefore(aHead, api.el.code);

  // ---- side B ----------------------------------------------------------------------------------------------------
  const bAsm = h('input', { type: 'radio', name: 'b-mode', value: 'asm', id: 'b-mode-asm' });
  const bHex = h('input', { type: 'radio', name: 'b-mode', value: 'hex', id: 'b-mode-hex' });
  const bSyntax = h('select', { id: 'b-syntax' }, h('option', { value: 'intel', text: 'Intel' }), h('option', { value: 'att', text: 'AT&T' }));
  const bSyntaxWrap = h('label', { class: 'inline' }, 'syntax', bSyntax);
  const bArch = h('select', { id: 'b-arch' });
  const bScale = h('input', { type: 'number', id: 'b-scale', min: 1, max: 64, step: 1, inputmode: 'numeric', value: 1 });
  const bImport = h('button', { type: 'button', class: 'plain', id: 'b-import', title: 'import B from a Compiler Explorer link (fetches from godbolt.org)' }, 'Compiler Explorer…');
  const bCode = h('textarea', { id: 'code-b', rows: 9, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', wrap: 'off', 'aria-describedby': 'b-messages' });
  const bMessages = h('div', { id: 'b-messages', class: 'messages', 'aria-live': 'polite' });
  const bSide = h('div', { class: 'ab-b ab-only', role: 'group', 'aria-labelledby': 'ab-b-tag' },
    h('div', { class: 'ab-head' },
      h('span', { class: 'ab-tag', id: 'ab-b-tag', text: 'B' }),
      h('div', { class: 'choice', role: 'radiogroup', 'aria-label': 'input format of B' }, h('label', null, bAsm, 'asm'), h('label', null, bHex, 'hex')),
      bSyntaxWrap,
      h('label', { class: 'inline' }, 'cpu', bArch),
      h('label', { class: 'inline', title: 'one iteration of B does the work of this many iterations of A (B is unrolled): B\'s cycles are divided by it' }, 'unrolled ×', bScale),
      bImport),
    bCode, bMessages);
  field.append(bSide);
  api.watchPaste?.(bCode, 'B');

  // ---- state <-> controls -------------------------------------------------------------------------------------------
  const archOk = (k) => !!k && api.archItems().has(k);
  const archB = () => (archOk(state.bArch) ? state.bArch : state.arch);
  let archCount = -1;

  function fillArchs() {
    const items = api.archItems();
    if (items.size !== archCount) {
      archCount = items.size;
      const same = h('option', { value: '' });
      const groups = new Map();
      for (const it of items.values()) {
        const g = it.experimental ? 'Experimental' : 'Intel';
        if (!groups.has(g)) groups.set(g, h('optgroup', { label: g }));
        groups.get(g).append(h('option', { value: it.key, text: it.title }));
      }
      bArch.replaceChildren(same, ...groups.values());
    }
    bArch.options[0].textContent = `same as A (${state.arch})`;
    bArch.disabled = items.size === 0;
  }

  function paint() {
    document.body.classList.toggle('ab-on', state.ab);
    field.classList.toggle('ab-grid', state.ab);
    rSingle.checked = !state.ab;
    rAB.checked = state.ab;
    bAsm.checked = state.bMode === 'asm';
    bHex.checked = state.bMode === 'hex';
    bSyntax.value = state.bSyntax;
    bSyntaxWrap.hidden = state.bMode !== 'asm';
    if (bCode.value !== state.bText) bCode.value = state.bText;
    buffers[state.bMode] = state.bText;
    bCode.placeholder = PLACEHOLDERS[state.bMode];
    bCode.setAttribute('aria-label', `B: ${state.bMode === 'asm' ? 'assembly code' : 'machine code (hex)'}`);
    fillArchs();
    bArch.value = archOk(state.bArch) ? state.bArch : '';
    bScale.value = state.bScale;
    aDesc.textContent = `${state.mode === 'asm' ? `assembly (${state.syntax === 'att' ? 'AT&T' : 'Intel'})` : 'machine code'} · ${state.arch} · set above`;
  }

  function setB({ mode, syntax, text }) {
    state.bMode = mode === 'asm' ? 'asm' : 'hex';
    if (syntax) state.bSyntax = syntax === 'att' ? 'att' : 'intel';
    state.bText = text;
    buffers[state.bMode] = text;
    clearB();
  }

  function setActive(on) {
    if (on === state.ab) return;
    state.ab = on;
    if (on && state.bText.trim() === '') setB(api.getA()); // start from a copy of A
    paint();
    api.toggled();
  }

  rSingle.addEventListener('change', () => { if (rSingle.checked) setActive(false); });
  rAB.addEventListener('change', () => { if (rAB.checked) setActive(true); });
  const setBMode = (mode) => {
    if (mode === state.bMode) return;
    buffers[state.bMode] = bCode.value;
    state.bMode = mode;
    state.bText = buffers[mode];
    clearB();
    paint();
    if (mode === 'asm') api.ensureAssembler();
    api.changed();
  };
  bAsm.addEventListener('change', () => setBMode('asm'));
  bHex.addEventListener('change', () => setBMode('hex'));
  bSyntax.addEventListener('change', () => { state.bSyntax = bSyntax.value === 'att' ? 'att' : 'intel'; api.changed(); });
  bArch.addEventListener('change', () => {
    state.bArch = bArch.value;
    if (archOk(state.bArch)) api.ensureTable(state.bArch).catch(() => {}); // reported when it runs
    api.changed({ rerun: true });
  });
  bScale.addEventListener('change', () => {
    const n = Number(bScale.value);
    state.bScale = Number.isInteger(n) ? Math.min(64, Math.max(1, n)) : 1;
    bScale.value = state.bScale;
    api.changed({ rerun: true });
  });
  bCode.addEventListener('input', () => { state.bText = buffers[state.bMode] = bCode.value; api.changed(); });
  bImport.addEventListener('click', () => api.openImport?.('B'));
  copy.addEventListener('click', () => {
    setB(api.getA());
    paint();
    api.changed({ rerun: true });
    bCode.focus();
  });
  swap.addEventListener('click', () => {
    const a = api.getA();
    const b = { mode: state.bMode, syntax: state.bSyntax, text: state.bText };
    if (archOk(state.bArch) && state.bArch !== state.arch) [state.arch, state.bArch] = [state.bArch, state.arch];
    setB(a);
    api.setA(b, { run: false });
    paint();
    api.changed({ rerun: true });
  });

  // ---- messages under B ---------------------------------------------------------------------------------------------
  function clearB() {
    bMessages.replaceChildren();
    bCode.removeAttribute('aria-invalid');
  }
  function selectLine(line) {
    const lines = bCode.value.split('\n');
    if (line < 1 || line > lines.length) return;
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    bCode.focus();
    bCode.setSelectionRange(start, start + lines[line - 1].length);
  }
  function showB(items) {
    const list = h('ul');
    for (const d of items) {
      const text = `${d.line ? `line ${d.line}${d.column ? ':' + d.column : ''}: ` : ''}${d.severity === 'warning' ? 'warning: ' : ''}${d.message}`;
      const li = h('li', { class: d.severity === 'error' ? null : d.severity });
      if (d.line) {
        const b = h('button', { type: 'button', class: 'plain', title: `select line ${d.line}`, text });
        b.addEventListener('click', () => selectLine(d.line));
        li.append(b);
      } else li.textContent = text;
      list.append(li);
    }
    bMessages.replaceChildren(list);
    if (items.some((d) => d.severity === 'error')) bCode.setAttribute('aria-invalid', 'true');
  }

  async function machineCodeB(current) {
    clearB();
    const text = bCode.value;
    if (state.bMode === 'hex') {
      const p = parseHexInput(text);
      if (!p.ok) { showB([{ line: p.line ?? null, severity: 'error', message: p.message }]); return null; }
      return p.bytes;
    }
    if (text.trim() === '') { showB([{ severity: 'error', message: 'No code: enter assembly' }]); return null; }
    const assembler = await api.ensureAssembler();
    if (!current()) return null;
    if (!assembler) { showB([{ severity: 'error', message: 'The assembler is not available: switch B to machine code (hex)' }]); return null; }
    const r = await assembler.assemble(text, state.bSyntax);
    if (!current()) return null;
    const items = [...r.diagnostics];
    if (r.ok && r.bytes.length === 0) items.push({ severity: 'error', message: 'The assembly produced no machine code' });
    if (r.ok && r.bytes.length) {
      const shownHex = toHex(r.bytes.subarray(0, 48)).match(/../g).join(' ');
      items.push({ severity: 'note', message: `assembled${assembler.mock ? ' (mock assembler)' : ''}: ${plural(r.bytes.length, 'byte')}: ${shownHex}${r.bytes.length > 48 ? ' …' : ''}` });
    }
    showB(items);
    return r.ok && r.bytes.length ? r.bytes : null;
  }

  // ---- running ----------------------------------------------------------------------------------------------------------

  // The machine code of both sides ({a: {bytes, arch} | null, b: ...}), or null if neither side has any (the
  // messages say why).
  async function inputs(runId, current) {
    const a = await api.machineCodeA(runId);
    if (!current()) return null;
    const b = await machineCodeB(current);
    if (!current() || (!a && !b)) return null;
    return { a: a ? { bytes: a, arch: state.arch } : null, b: b ? { bytes: b, arch: archB() } : null };
  }

  // analyzeFn(hex, archKey) -> response. One side failing does not stop the other.
  async function analyze(input, analyzeFn, current) {
    const side = async (x) => {
      if (!x) return null;
      const hex = toHex(x.bytes);
      const t0 = performance.now();
      let response;
      try {
        response = await analyzeFn(hex, x.arch);
      } catch (e) {
        if (e?.name === 'CancelledError' || !current()) throw e;
        response = { error: e?.message ?? String(e) };
      }
      const item = api.archItems().get(x.arch);
      return { response, elapsedMs: performance.now() - t0, hex, byteCount: x.bytes.length, archKey: x.arch,
        archTitle: api.archTitle(x.arch), experimental: !!item?.experimental };
    };
    const a = await side(input.a);
    if (!current()) return null;
    const b = await side(input.b);
    return { a, b, scale: state.bScale, cmp: compareResponses(a?.response, b?.response, { scale: state.bScale }) };
  }

  function summary(view) {
    const t = view.cmp.tp;
    if (!t) return 'compared: one side has no result';
    return `A ${two(t.a)} · B ${two(t.b)} cycles per iteration${t.verdict === 'same' ? ' (the same)' : ` (Δ ${sign2(t.delta)}, ${percent(t.pct)})`}`;
  }

  // what a result depends on, besides side A and the options (app.js adds this to its own key)
  const key = () => (state.ab ? JSON.stringify([state.bMode, state.bMode === 'asm' ? state.bSyntax : '', bCode.value, archB(), state.bScale]) : '');

  // ---- the view -----------------------------------------------------------------------------------------------------------
  const row = (label, ...content) => h('div', { class: 'row' }, h('div', { class: 'label', text: label }), h('div', { class: 'field' }, ...content));
  const sep = () => h('span', { class: 'sep', text: ' · ' });
  const tag = (t) => h('span', { class: 'ab-tag', text: t });

  function sideMeta(t, s) {
    if (!s) return h('div', { class: 'meta' }, tag(t), ' no input: see the messages under the input');
    const r = s.response;
    if (!ok(r)) {
      const msg = r?.trapped ? `the analyzer stopped on this input${r.detail ? ': ' + r.detail : ''} (it has been restarted)` : `analysis failed: ${r?.error ?? 'unexpected response'}`;
      return h('div', { class: 'error-box ab-side-error', role: 'alert' }, `${t}: ${msg}`);
    }
    const instrs = r.rows.filter((x) => x.kind === 'instr').length;
    return h('div', { class: 'meta' }, tag(t), ' ', s.archTitle, sep(), plural(instrs, 'instruction'), sep(), plural(s.byteCount, 'byte'),
      sep(), r.mode === 'loop' ? 'loop' : 'unrolled', r.mock ? null : [sep(), `${s.elapsedMs < 10 ? s.elapsedMs.toFixed(1) : Math.round(s.elapsedMs)} ms`],
      r.mock ? h('span', { class: 'mock-tag', text: ' · mock data' }) : null,
      s.experimental ? h('span', { class: 'caveat', text: ' · experimental model' }) : null,
      r.decodeErrors > 0 ? h('span', { class: 'caveat', text: ` · ${r.decodeErrors} undecodable position${r.decodeErrors === 1 ? '' : 's'} skipped` }) : null);
  }

  function headline(view) {
    const { a, b, cmp } = view;
    const t = cmp.tp;
    const val = (s, raw) => (ok(s?.response) ? h('span', { class: 'value', text: two(raw) }) : h('span', { class: 'value ab-none', text: '–' }));
    const scaled = view.scale !== 1 && t;
    const big = h('div', { class: 'ab-tp' },
      tag('A'), val(a, a && ok(a.response) ? Number(a.response.tp) : null),
      h('span', { class: 'ab-arrow', 'aria-hidden': 'true', text: '→' }),
      tag('B'), val(b, b && ok(b.response) ? Number(b.response.tp) : null),
      h('span', { class: 'unit', text: 'cycles per iteration' }));
    const out = [big];
    if (t) {
      const sentence = t.verdict === 'same'
        ? `Δ = 0: the same throughput`
        : `Δ = ${sign2(t.delta)} cycles (${percent(t.pct)}) · B is ${t.speedup >= 1 ? `${t.speedup.toFixed(2)}× faster` : `${(1 / t.speedup).toFixed(2)}× slower`}`;
      out.push(h('div', { class: `ab-delta ab-${t.verdict}`, 'data-verdict': t.verdict },
        h('span', { class: 'ab-verdict', text: t.verdict === 'better' ? 'B better' : t.verdict === 'worse' ? 'B worse' : 'no change' }), ' ', sentence));
      if (scaled) out.push(h('div', { class: 'hint', text: `B is unrolled ×${view.scale}: B's ${two(t.bRaw)} cycles per iteration are ${two(t.b)} per iteration of A; the comparison uses that` }));
      // the same text in one line, for screen readers and for copying
      out.push(h('p', { class: 'ab-sr', text: `A: ${two(t.a)} cycles, B: ${two(t.b)} cycles, Δ = ${t.verdict === 'same' ? '0' : `${sign2(t.delta)} (${percent(t.pct)})`}` }));
    }
    out.push(sideMeta('A', a), sideMeta('B', b));
    if (a && b && a.archKey !== b.archKey) out.push(h('div', { class: 'hint', text: `different microarchitectures: A on ${a.archKey}, B on ${b.archKey}` }));
    return row('throughput', ...out);
  }

  function bottlenecks(cmp) {
    const bn = cmp.bottlenecks;
    const list = (names, cls) => (names.length ? names.flatMap((n, k) => [k ? ', ' : '', h('span', { class: cls(n), text: n })]) : h('span', { class: 'hint', text: 'unknown' }));
    if (bn.same) return row(bn.a.length > 1 ? 'bottlenecks' : 'bottleneck', h('span', { class: 'bn', text: bn.a.join(', ') || 'unknown' }), h('span', { class: 'hint', text: ' (both)' }));
    return row('bottleneck',
      h('div', { class: 'ab-bn' },
        tag('A'), ' ', list(bn.a, (n) => (bn.b.includes(n) ? 'bn' : 'bn ab-gone')),
        h('span', { class: 'ab-arrow', 'aria-hidden': 'true', text: ' → ' }),
        tag('B'), ' ', list(bn.b, (n) => (bn.a.includes(n) ? 'bn' : 'bn ab-new'))),
      h('p', { class: 'hint', text: [bn.gone.length ? `no longer: ${bn.gone.join(', ')}` : '', bn.new.length ? `new: ${bn.new.join(', ')}` : ''].filter(Boolean).join(' · ') }));
  }

  function deltaCell(d, { lowerIsBetter = true, cycles = false } = {}) {
    const cls = d === 0 ? 'ab-d' : `ab-d ${(d < 0) === lowerIsBetter ? 'ab-better' : 'ab-worse'}`;
    return h('td', { class: cls, text: cycles ? (d === 0 ? '' : sign2(d)) : signed(d) });
  }

  function limits(cmp) {
    const max = Math.max(1e-9, ...cmp.limits.flatMap((l) => [l.a ?? 0, l.b ?? 0]));
    const gauge = (v, hot) => {
      const g = h('span', { class: 'gauge' + (hot ? ' is-bottleneck' : ''), 'aria-hidden': 'true' }, h('span'));
      g.firstChild.style.width = `${Math.min(100, (100 * (v ?? 0)) / max).toFixed(1)}%`;
      return g;
    };
    const body = h('tbody');
    for (const l of cmp.limits) {
      body.append(h('tr', null,
        h('th', { scope: 'row', class: 'first', text: l.name }),
        h('td', { class: l.bottleneckA ? 'is-bottleneck' : null, text: two(l.a) }), h('td', { class: 'ab-g' }, gauge(l.a, l.bottleneckA)),
        h('td', { class: l.bottleneckB ? 'is-bottleneck' : null, text: two(l.b) }), h('td', { class: 'ab-g' }, gauge(l.b, l.bottleneckB)),
        l.delta === null ? h('td', { class: 'ab-d' }) : deltaCell(l.delta, { cycles: true })));
    }
    const table = h('table', { class: 'grid ab-limits' },
      h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'first', text: 'limit' }), h('th', { scope: 'col', text: 'A' }), h('th', { scope: 'col' }),
        h('th', { scope: 'col', text: 'B' }), h('th', { scope: 'col' }), h('th', { scope: 'col', text: 'Δ' }))), body);
    return row('limits', h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Limits of A and B' }, table),
      h('p', { class: 'hint', text: 'cycles per iteration if the given property were the only bottleneck; the highlighted ones are the bottlenecks' }));
  }

  function instrCell(u) {
    if (!u) return h('td', { class: 'ab-i ab-empty' });
    const extras = u.extras.length ? h('span', { class: 'ab-x', title: `includes ${u.extras.length} uop${u.extras.length === 1 ? '' : 's'} the renamer inserts before it (${u.extras.join(', ')})`, text: ` +${u.extras.length}` }) : null;
    const note = u.notes ? h('span', { class: 'ab-note', title: NOTES[u.notes] ?? null, text: ` ${u.notes}` }) : null;
    return h('td', { class: 'ab-i' }, h('span', { text: u.label }), note, extras);
  }

  function diff(view, archA, archB) {
    const d = view.cmp.diff;
    const counts = Object.entries(d.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${STATUS_TEXT[k]}`).join(' · ');
    const only = h('input', { type: 'checkbox', id: 'ab-only-changes', checked: ui.onlyChanges });
    only.checked = ui.onlyChanges;
    only.addEventListener('change', () => { ui.onlyChanges = only.checked; draw(shown); });
    const head = h('tr', null, h('th', { scope: 'col', class: 'ab-m first', 'aria-label': 'change' }),
      h('th', { scope: 'col', class: 'ab-i', text: 'A' }), h('th', { scope: 'col', class: 'ab-i', text: 'B' }),
      d.columns.map((c, k) => h('th', { scope: 'col', class: k === 0 || (k === 1 && d.columns[0].name === 'Issued') ? 'grp' : null, text: c.name === 'Issued' ? 'Δ uops' : c.name })));
    const body = h('tbody');
    let hidden = 0;
    for (const r of d.rows) {
      if (ui.onlyChanges && r.status === 'same') { hidden++; continue; }
      body.append(h('tr', { class: `ab-${r.status}`, title: STATUS_TEXT[r.status] },
        h('td', { class: 'ab-m first', text: STATUS_MARK[r.status] }),
        instrCell(r.a), instrCell(r.b),
        r.deltas.map((v, k) => {
          const td = deltaCell(v);
          if (k === 0 || (k === 1 && d.columns[0].name === 'Issued')) td.classList.add('grp');
          return td;
        })));
    }
    const foot = h('tr', null, h('td', { class: 'ab-m first' }), h('th', { scope: 'row', class: 'ab-i', text: 'Total' }), h('td', { class: 'ab-i' }),
      d.totals.map((v, k) => {
        const td = deltaCell(v);
        if (k === 0 || (k === 1 && d.columns[0].name === 'Issued')) td.classList.add('grp');
        return td;
      }));
    const table = h('table', { class: 'grid ab-diff' }, h('thead', null, head), body, h('tfoot', null, foot));
    return row('diff',
      h('div', { class: 'table-tools' }, h('span', { text: counts || 'no instructions' }),
        h('label', null, only, ` only differences${hidden ? ` (${hidden} hidden)` : ''}`)),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Instruction-by-instruction difference of A and B' }, table),
      h('p', { class: 'legend' },
        Object.entries(STATUS_MARK).filter(([k]) => k !== 'same').map(([k, m]) => h('span', null, h('b', { text: m }), ` ${STATUS_TEXT[k]}`)),
        h('span', { text: 'values: B − A, average uops per iteration' })),
      d.portsComparable ? null : h('p', { class: 'hint', text: `A (${archA}) and B (${archB}) have different execution ports: only the uop counts are compared` }));
  }

  function uops(view) {
    const toggle = h('input', { type: 'checkbox', id: 'ab-hide-empty', checked: ui.hideEmpty });
    toggle.checked = ui.hideEmpty;
    toggle.addEventListener('change', () => { ui.hideEmpty = toggle.checked; draw(shown); });
    const side = (t, s) => {
      if (!s || !ok(s.response)) return h('div', { class: 'ab-col' }, h('div', { class: 'ab-cap' }, tag(t), ' no result'));
      const { table } = uopTable(s.response, ui.hideEmpty);
      return h('div', { class: 'ab-col' }, h('div', { class: 'ab-cap' }, tag(t), ` ${s.archKey} · ${two(Number(s.response.tp))} cycles`),
        h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': `Uops per instruction of ${t}` }, table));
    };
    return row('uops',
      h('div', { class: 'table-tools' }, h('span', { text: 'average per iteration, by instruction' }), h('label', null, toggle, ' hide empty columns')),
      h('div', { class: 'ab-pair' }, side('A', view.a), side('B', view.b)),
      h('p', { class: 'legend' }, Object.entries(NOTES).map(([k, v]) => h('span', null, h('b', { text: k }), ` ${v}`))));
  }

  function reports(view) {
    const det = (t, s) => {
      const d = h('details', { class: 'report-wrap', open: ui.reportOpen },
        h('summary', { text: `${t}: plain text report` }),
        h('pre', { class: 'report', tabindex: '0', text: typeof s?.response?.text === 'string' ? s.response.text : '' }));
      d.addEventListener('toggle', () => { ui.reportOpen = d.open; });
      return d;
    };
    return row('report', h('div', { class: 'ab-pair' }, h('div', { class: 'ab-col' }, det('A', view.a)), h('div', { class: 'ab-col' }, det('B', view.b))));
  }

  function draw(view) {
    shown = view;
    if (!view) return;
    const out = [headline(view)];
    if (view.cmp.okA && view.cmp.okB) out.push(bottlenecks(view.cmp), limits(view.cmp), diff(view, view.a.archKey, view.b.archKey));
    out.push(uops(view), reports(view));
    api.el.body.replaceChildren(...out);
  }

  paint();
  return {
    active: () => state.ab,
    paint, inputs, analyze, draw, summary, key,
    setB(code) { setB(code); paint(); api.changed(); },
    textareaB: bCode,
  };
}
