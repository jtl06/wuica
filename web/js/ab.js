// A–B mode: two versions of a block. Side A is the page's own editor (#code, with the format, examples, cpu and
// options in the toolbar above it, which is A's row); this module adds the "single / A–B" switch, side B under A (one
// row of its own: format, cpu, elements per iteration), swap and copy, and the comparison view: a two-line headline,
// the table of A and B per checked CPU (ab-cpus.js, from app.js), and the "diff" tab of the result workspace
// (workspace.js): the uop tables of A and B stacked, the instruction-by-instruction difference, the limits, the issue
// slots and the text reports. The other tabs are the page's views, of one side at a time (app.js).
//
// Elements per iteration (aWork, bWork): the elements (or bytes) one iteration of each side processes. Given, A and B
// are compared per element: the headline, the limits and the table per CPU. They apply as they are typed, without a new
// analysis. Code that replaces a side's code (a paste or typing over most of it, an import, an example, A → B) resets its
// count; an edit of the code marks the count (it may no longer be right) until the field is visited or the count typed.
//
// Its state is part of the page's state (url-state.js: ab, bMode, bSyntax, bArch, bText, aWork, bWork), so a link
// carries both sides. The page (app.js) runs the analyses: inputs() gets the machine code of both sides,
// analyze() runs them, draw() shows the result. All text goes in through textContent.

import { h, uopTable, NOTES, watchFit, nearestLimit, columnGroup, copyAllButton, messageList, invalidText, alignButton } from './render.js';
import { attachHighlight, colorInstr } from './asm-hl.js'; // B's code box in colour; the instructions of the Δ table
import { caveats, cannotRun } from './caveats.js';
import { GROUP_LABEL } from './archs.js';
import { compareResponses, signed, cycles, signedCycles } from './ab-diff.js';
import { parseHexInput, toHex } from './hex-input.js';
import { MAX_CODE_BYTES, tooMuchCode } from './assembler.js';
import { LIMITS } from './url-state.js';
import { branchLabels, analyzedLines, analyzedText } from './branch-label.js';
import { VRows, ALL_UP_TO } from './vrows.js';

const PLACEHOLDERS = {
  hex: '48 83 c0 02 49 ff cf 75 f7',
  asm: 'loop:\n  add rax, 2\n  dec r15\n  jnz loop',
};
const STATUS_MARK = { same: '', changed: '•', modified: '~', added: '+', removed: '−' };
const STATUS_TEXT = {
  same: 'same', changed: 'same instruction, other uops', modified: 'changed operands', added: 'only in B', removed: 'only in A',
};

const two = cycles; // (two decimals; three significant digits below 0.1)
function percent(p) {
  if (p === null || !Number.isFinite(p)) return '';
  const a = Math.abs(p);
  return `${p < 0 ? '−' : '+'}${a < 10 ? a.toFixed(1) : String(Math.round(a))}%`;
}
const sign2 = (v) => (v === 0 ? '0' : signedCycles(v)); // cycle counts (0: the same)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ok =(r) => !!r && typeof r === 'object' && !('error' in r) && Array.isArray(r.rows) && Array.isArray(r.columns);
// (per mode: single mode has one count, the page's)
const workTitle = (ab) => `elements per iteration: the elements (or bytes) one iteration processes; ${ab ? 'A and B are then compared per element' : 'the result is then per element'}`;

// api (from app.js):
//   state, el: {code, body, toolbar}, archItems() -> Map, archTitle(key, experimental), ensureAssembler(), ensureTable(key),
//   machineCodeA(runId) -> bytes | null (shows A's messages), getA() / setA({mode, syntax, text}, {run}),
//   changed({rerun}), toggled() (the mode changed), writeControls(), watchLinks(textarea, side, messages), demo() -> {a, b} | null,
//   srcA() -> side A's analyzed assembly lines (branch-label.js), replaced(inputEvent) -> true for a paste rather than typing, redraw() (the shown comparison again: the counts changed), cpusBox (the table per CPU, ab-cpus.js)
export function createAB(api) {
  const { state } = api;
  const buffers = { hex: '', asm: '' }; // B's text of each input mode
  const ui = { onlyChanges: false, open: {} }; // open: the collapsed parts of the view that are open, by name
  let shown = null; // the view on the page

  // ---- the switch ----------------------------------------------------------------------------------------------
  const rSingle = h('input', { type: 'radio', name: 'compare', value: 'single', id: 'cmp-single' });
  const rAB = h('input', { type: 'radio', name: 'compare', value: 'ab', id: 'cmp-ab' });
  const swap = h('button', { type: 'button', id: 'ab-swap', title: 'exchange the two sides: code, input format, cpu and elements' }, 'swap');
  const copy = h('button', { type: 'button', id: 'ab-copy', title: 'replace B with a copy of A' }, 'A → B');
  const switchRow = h('div', { class: 'ab-switch' },
    h('div', { class: 'choice', role: 'radiogroup', 'aria-label': 'compare', title: 'one block, or two versions' },
      h('label', null, rSingle, 'single'), h('label', null, rAB, 'A–B')),
    h('span', { class: 'ab-tools ab-only' }, swap, copy));
  const heading = document.getElementById('h-input');
  if (heading) heading.after(switchRow); else api.el.code.closest('section')?.prepend(switchRow);

  // elements per iteration: a small number field of each side's row
  const workField = (side) => {
    const input = h('input', { type: 'number', id: `${side}-work`, class: 'ab-work-in', min: 1, max: LIMITS.aWork[1], step: 1, inputmode: 'numeric', value: 1 });
    const label = h('label', { class: 'inline ab-work', title: workTitle(state.ab) }, h('span', { class: 'ab-work-k', text: 'elems' }), input);
    return { input, label };
  };

  // ---- side A: the page's toolbar is its row (a tag in front, the elements at the end) ------------------------------
  // The editor's own elements go into a column (display: contents outside A–B mode: the layout does not change).
  const field = api.el.code.closest('.code-field') ?? api.el.code.parentElement; // (the box itself is in asm-hl.js's wrapper)
  const aCol = h('div', { class: 'field ab-a-col' });
  aCol.append(...field.childNodes);
  field.append(aCol);
  const aDesc = h('span', { class: 'ab-desc vh' });
  const aHead = h('span', { class: 'ab-head ab-a ab-only', title: 'A: the input format here and the marked CPU' }, h('span', { class: 'ab-tag', text: 'A' }), aDesc);
  const aWork = workField('a');
  // (single mode too: A's count is the page's)
  const toolbar = api.el.toolbar ?? field.previousElementSibling;
  if (toolbar) { toolbar.prepend(aHead); toolbar.append(aWork.label); } else aCol.prepend(aHead, aWork.label);

  // ---- side B ----------------------------------------------------------------------------------------------------
  const bAsm = h('input', { type: 'radio', name: 'b-mode', value: 'asm', id: 'b-mode-asm' });
  const bHex = h('input', { type: 'radio', name: 'b-mode', value: 'hex', id: 'b-mode-hex' });
  const bSyntax = h('select', { id: 'b-syntax', title: 'assembly syntax of B' }, h('option', { value: 'intel', text: 'Intel' }), h('option', { value: 'att', text: 'AT&T' }));
  const bSyntaxWrap = h('label', { class: 'inline' }, h('span', { class: 'vh', text: 'syntax' }), bSyntax);
  const bArch = h('select', { id: 'b-arch', title: 'the cpu of B' });
  const bWork = workField('b');
  const bCode = h('textarea', { id: 'code-b', rows: 9, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', wrap: 'off', 'aria-describedby': 'b-messages' });
  const bMessages = h('div', { id: 'b-messages', class: 'messages', 'aria-live': 'polite' });
  const bSide = h('div', { class: 'ab-b ab-only', role: 'group', 'aria-labelledby': 'ab-b-tag' },
    h('div', { class: 'ab-head ab-b-head' },
      h('span', { class: 'ab-tag', id: 'ab-b-tag', text: 'B' }),
      h('div', { class: 'choice', role: 'radiogroup', 'aria-label': 'input format of B' }, h('label', null, bAsm, 'asm'), h('label', null, bHex, 'hex')),
      bSyntaxWrap,
      h('label', { class: 'inline' }, 'cpu', bArch),
      bWork.label),
    bCode, bMessages);
  field.append(bSide);
  const bColors = attachHighlight(bCode, { mode: () => state.bMode, syntax: () => state.bSyntax });

  // wide (ab.css, from 1200 px): the table per CPU and the headline side by side, only while the headline fits beside it
  // (nothing of its two lines cut); else the headline under the table, as on narrow screens
  const resultBody = document.getElementById('result-body');
  if (resultBody && typeof ResizeObserver === 'function') {
    let t = 0;
    const fitBeside = () => {
      t = 0;
      resultBody.classList.add('ab-beside');
      const cut = [...resultBody.querySelectorAll(':scope > .row.lead .ab-meta, :scope > .row.lead .ab-delta')].some((e) => e.scrollWidth > e.clientWidth + 1);
      if (cut) resultBody.classList.remove('ab-beside');
    };
    const later = () => { if (!t) t = requestAnimationFrame(fitBeside); };
    new ResizeObserver(later).observe(resultBody);
    new MutationObserver(later).observe(resultBody, { childList: true, subtree: true, characterData: true });
  }
  api.watchLinks?.(bCode, 'B', bMessages);

  // ---- state <-> controls -------------------------------------------------------------------------------------------
  const archOk = (k) => !!k && api.archItems().has(k);
  const archB = () => (archOk(state.bArch) ? state.bArch : state.arch);
  let archCount = -1;

  function fillArchs() { // the page's menu (archs.js: one group, by release date) after "same as A"
    const items = api.archItems();
    if (items.size !== archCount) {
      archCount = items.size;
      const same = h('option', { value: '' });
      const group = h('optgroup', { label: GROUP_LABEL }, [...items.values()].map((it) => h('option', { value: it.key, text: it.title })));
      bArch.replaceChildren(same, ...(items.size ? [group] : []));
    }
    bArch.options[0].textContent = `as A (${state.arch})`;
    bArch.disabled = items.size === 0;
  }

  // the counts: the code each was given for (an edit of the code marks a count that is not 1)
  const sides = { a: { work: aWork, code: () => api.el.code.value, key: 'aWork', given: '' }, b: { work: bWork, code: () => bCode.value, key: 'bWork', given: '' } };
  function flagged(s) { const x = sides[s]; return state[x.key] !== 1 && x.code() !== x.given; }
  let singleWork = [1, false]; // (single mode: the count and its mark the result was last drawn with)
  function paintWork() {
    for (const s of ['a', 'b']) {
      const x = sides[s];
      if (document.activeElement !== x.work.input || Number(x.work.input.value) !== state[x.key]) x.work.input.value = state[x.key];
      const flag = flagged(s);
      x.work.label.classList.toggle('flag', flag);
      x.work.input.setAttribute('aria-invalid', flag ? 'true' : 'false');
      x.work.label.title = flag ? `${workTitle(state.ab)}. ${state.ab ? `${s.toUpperCase()}'s code` : 'The code'} changed since it was set: check it (or confirm it: type it again)` : workTitle(state.ab);
    }
    // a count changed by any route (typed, swap, A → B, a link, an example): the shown comparison is weighed again;
    // in single mode the result (A's count, or its mark)
    if (state.ab && shown && (shown.workA !== state.aWork || shown.workB !== state.bWork)) reweigh();
    else if (!state.ab && (singleWork[0] !== state.aWork || singleWork[1] !== flagged('a'))) { singleWork = [state.aWork, flagged('a')]; api.redraw?.(); }
  }
  // a count is right for the code shown now (set, confirmed, or the code was replaced)
  const settle = (s) => { sides[s].given = sides[s].code(); };

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
    bColors.refresh();
    aDesc.textContent = `${state.mode === 'asm' ? `asm (${state.syntax === 'att' ? 'AT&T' : 'Intel'})` : 'hex'} · ${state.arch}`;
    paintWork();
  }

  function setB({ mode, syntax, text }, { work = 1 } = {}) {
    state.bMode = mode === 'asm' ? 'asm' : 'hex';
    if (syntax) state.bSyntax = syntax === 'att' ? 'att' : 'intel';
    state.bText = text;
    buffers[state.bMode] = text;
    if (bCode.value !== text) bCode.value = text;
    state.bWork = work; // other code: its own count (1 until given)
    settle('b');
    clearB();
  }

  function setActive(on) {
    if (on === state.ab) return;
    state.ab = on;
    const demo = on && state.bText.trim() === '' ? api.demo?.() : null; // the default example in A, B empty: a demo pair
    if (demo) { api.setA(demo.a, { run: false }); setB(demo.b); state.aWork = 1; settle('a'); } else if (on && state.bText.trim() === '') { setB(api.getA(), { work: state.aWork }); api.copiedA?.(); } // start from a copy of A (its loop too)
    paint();
    api.toggled();
  }

  // a count typed: applied at once (no new analysis: the shown result is weighed again); a field left empty or out of
  // range goes back to the count in use
  function setWork(s, value, { final = false } = {}) {
    const x = sides[s];
    const n = Number(value);
    const valid = value !== '' && Number.isInteger(n) && n >= LIMITS[x.key][0] && n <= LIMITS[x.key][1];
    if (!valid) { if (final) x.work.input.value = state[x.key]; return; }
    settle(s);
    if (n !== state[x.key]) {
      state[x.key] = n;
      paintWork();
      api.changed();
    } else paintWork();
  }
  for (const s of ['a', 'b']) {
    const input = sides[s].work.input;
    input.addEventListener('input', () => setWork(s, input.value));
    input.addEventListener('change', () => setWork(s, input.value, { final: true }));
    input.addEventListener('focus', () => { settle(s); paintWork(); }); // visited: the count is confirmed for this code
  }
  api.el.code.addEventListener('input', () => paintWork()); // (single mode too: the result's "?" follows the mark)

  rSingle.addEventListener('change', () => { if (rSingle.checked) setActive(false); });
  rAB.addEventListener('change', () => { if (rAB.checked) setActive(true); });
  const setBMode = (mode) => {
    if (mode === state.bMode) return;
    const apply = (c = null) => { // c: B's code converted to `mode` by the page (switchMode), or null: B's own text for it
      buffers[state.bMode] = bCode.value;
      state.bMode = mode;
      state.bText = c ? c.text : buffers[mode];
      if (c?.syntax) state.bSyntax = c.syntax;
      if (c) settle('b'); // the same machine code: its count stays right
      clearB();
      paint();
      if (mode === 'asm') api.ensureAssembler();
      api.changed();
    };
    if (api.switchMode) api.switchMode(mode, buffers[mode], apply); else apply();
  };
  bAsm.addEventListener('change', () => setBMode('asm'));
  bHex.addEventListener('change', () => setBMode('hex'));
  bSyntax.addEventListener('change', () => { state.bSyntax = bSyntax.value === 'att' ? 'att' : 'intel'; api.changed(); });
  bArch.addEventListener('change', () => {
    state.bArch = bArch.value;
    if (archOk(state.bArch)) api.ensureTable(state.bArch).catch(() => {}); // reported when it runs
    api.changed({ rerun: true });
  });
  bCode.addEventListener('input', (e) => { state.bText = buffers[state.bMode] = bCode.value; paintWork(); api.changed({ now: !!api.replaced?.(e) }); });
  copy.addEventListener('click', () => {
    setB(api.getA(), { work: state.aWork });
    api.copiedA?.(); // (A's loop too)
    paint();
    api.changed({ rerun: true, now: true });
    bCode.focus();
  });
  swap.addEventListener('click', () => {
    const a = api.getA();
    const b = { mode: state.bMode, syntax: state.bSyntax, text: state.bText };
    const works = [state.bWork, state.aWork];
    const loops = { loopA: state.loop, loopB: state.bLoop };
    if (archOk(state.bArch) && state.bArch !== state.arch) [state.arch, state.bArch] = [state.bArch, state.arch];
    setB(a, { work: works[1] });
    api.setA(b, { run: false });
    api.swapped?.(loops); // (the loops change sides too)
    state.aWork = works[0];
    settle('a');
    paint();
    api.changed({ rerun: true, now: true });
  });

  // ---- messages under B ---------------------------------------------------------------------------------------------
  function clearB() {
    bMessages.replaceChildren();
    bCode.removeAttribute('aria-invalid');
    bColors.setDiagnostics([]);
  }
  function selectLine(line) {
    const lines = bCode.value.split('\n');
    if (line < 1 || line > lines.length) return;
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    bCode.focus();
    bCode.setSelectionRange(start, start + lines[line - 1].length);
  }
  function showB(items) {
    bMessages.replaceChildren(...messageList(items, selectLine));
    if (items.some((d) => d.severity === 'error')) bCode.setAttribute('aria-invalid', 'true');
    bColors.setDiagnostics(items);
  }

  // The messages are replaced only when there are new ones (no flicker while live mode re-runs).
  let srcB = null; // the lines of B's analyzed assembly (its labels for the branch targets: branch-label.js)
  async function machineCodeB(current) {
    const text = bCode.value;
    srcB = null;
    if (state.bMode === 'hex') {
      const p = parseHexInput(text);
      if (!p.ok) { showB([{ line: p.line ?? null, severity: 'error', message: p.message }]); return null; }
      if (p.bytes.length > MAX_CODE_BYTES) { showB([{ severity: 'error', message: tooMuchCode(p.bytes.length) }]); return null; }
      clearB();
      return p.bytes;
    }
    if (text.trim() === '') { showB([{ severity: 'error', message: 'No code' }]); return null; }
    const assembler = await api.ensureAssembler();
    if (!current()) return null;
    if (!assembler) { showB([{ severity: 'error', message: 'No assembler: use hex' }]); return null; }
    const r = await assembler.assemble(text, state.bSyntax);
    if (!current()) return null;
    srcB = r.ok ? analyzedLines(text, r) : null;
    const items = [...r.diagnostics];
    if (r.ok && r.bytes.length === 0) items.push({ severity: 'error', message: 'No machine code' });
    if (r.ok && r.bytes.length && assembler.mock) items.push({ severity: 'note', message: 'mock assembler' });
    if (items.length) showB(items); else clearB();
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

  const weigh = (view) => {
    view.workA = state.aWork;
    view.workB = state.bWork;
    view.scale = state.bWork / state.aWork; // iterations of A per iteration of B (the traces' windows)
    view.cmp = compareResponses(view.a?.response, view.b?.response, { workA: state.aWork, workB: state.bWork });
    return view;
  };
  // the counts changed: the shown comparison is weighed again and drawn
  function reweigh() { if (shown) { weigh(shown); if (api.redraw) api.redraw(); else draw(shown); } }

  // analyzeFn(hex, archKey) -> response. One side failing does not stop the other.
  async function analyze(input, analyzeFn, current) {
    const side = async (x, s) => {
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
      const src = s === 'b' ? srcB : api.srcA?.() ?? null;
      const code = analyzedText(src);
      // invalid: code this CPU cannot run (caveats.js): its number is no result, and A–B no comparison
      return { side: s, response, shown: ok(response) ? branchLabels(response.rows, src) : null, code, invalid: ok(response) ? cannotRun(response, { arch: x.arch, code }) : null,
        text: s === 'a' ? api.getA().text : bCode.value, loop: api.picks?.()[s] ?? null,
        elapsedMs: performance.now() - t0, hex, byteCount: x.bytes.length, archKey: x.arch,
        archTitle: api.archTitle(x.arch, !!item?.experimental), experimental: !!item?.experimental,
        inputMode: s === 'a' ? state.mode : state.bMode };
    };
    const a = await side(input.a, 'a');
    if (!current()) return null;
    const b = await side(input.b, 'b');
    return weigh({ a, b });
  }

  const unitOf = (view) => (view.cmp.perElement ? 'cycles/element' : 'cycles/iteration');
  function summary(view) {
    const t = view.cmp.tp;
    if (!t) return 'compared: one side has no result';
    return `A ${two(t.a)} · B ${two(t.b)} ${view.cmp.perElement ? 'cycles per element' : 'cycles per iteration'}${t.verdict === 'same' ? ' (the same)' : ` (Δ ${sign2(t.delta)}, ${percent(t.pct)})`}`;
  }

  // what a result depends on, besides side A and the options (app.js adds this to its own key); not the counts: they
  // weigh the result without a new analysis
  const key = () => (state.ab ? JSON.stringify([state.bMode, state.bMode === 'asm' ? state.bSyntax : '', bCode.value, archB()]) : '');

  // ---- the view -----------------------------------------------------------------------------------------------------------
  // On top, two lines: A → B and the verdict; the sides' cpus and the bottlenecks. Under it the result's tabs; this
  // module draws the first one, "diff": the uop tables of A and B stacked, then the difference, the limits, the slots and
  // the reports, collapsed (ui.open keeps them open).
  const row = (label, ...content) => h('div', { class: 'row' }, h('div', { class: 'label', text: label }), h('div', { class: 'field' }, ...content));
  // a row whose content says what it is: its label is for screen readers only
  const lead = (label, ...content) => h('div', { class: 'row lead' }, h('div', { class: 'label', text: label }), h('div', { class: 'field' }, ...content));
  const sep = () => h('span', { class: 'sep', text: ' · ' });
  const tag = (t) => h('span', { class: `ab-tag${t === 'B' ? ' b' : ''}`, text: t });
  const ms = (s) => `${s.elapsedMs < 10 ? s.elapsedMs.toFixed(1) : Math.round(s.elapsedMs)} ms`;

  // where the page does not scroll (from 1200 × 700): a fold opened (its summary clicked, or Enter or Space on it) closes
  // the others, so the tables keep room (workspace.js fits them into the pane)
  const still = window.matchMedia?.('(min-width: 1200px) and (min-height: 700px)');
  document.addEventListener('click', (e) => {
    const d = e.target instanceof Element ? /** @type {HTMLDetailsElement | undefined} */ (e.target.closest('#ab-main details.ab-fold > summary')?.parentElement) : null;
    if (!still?.matches || !d || d.open) return;
    for (const o of /** @type {NodeListOf<HTMLDetailsElement>} */ (document.querySelectorAll('#ab-main details.ab-fold[open]'))) if (o !== d) o.open = false;
  }, true);

  function fold(name, label, summary, ...content) {
    const d = h('details', { class: 'ab-fold', open: !!ui.open[name] }, h('summary', null, summary), ...content);
    d.addEventListener('toggle', () => { ui.open[name] = d.open; });
    return row(label, d);
  }

  // the cpu and loop/unrolled of a side; the rest in the tooltip
  function sideMeta(t, s) {
    if (!s) return [tag(t), ' no input'];
    const r = s.response;
    if (!ok(r)) {
      const msg = r?.trapped ? `analyzer crashed${r.detail ? ' (' + r.detail + ')' : ''}; restarted` : `analysis failed: ${r?.error ?? 'unexpected response'}`;
      return h('span', { class: 'caveat ab-side-error', role: 'alert' }, tag(t), ` ${msg}`);
    }
    const instrs = r.rows.filter((x) => x.kind === 'instr').length;
    const title = [s.archTitle, plural(instrs, 'instruction'), plural(s.byteCount, 'byte'), r.mock ? 'mock data' : ms(s)].join(' · ');
    return h('span', { class: 'ab-side', title }, tag(t), ` ${s.archKey} `, h('span', { class: 'tag', text: r.mode === 'loop' ? 'loop' : 'unrolled' }),
      r.mock ? h('span', { class: 'mock-tag', text: ' mock' }) : null,
      s.invalid ? h('span', { class: 'caveat', title: s.invalid.title, text: ` not a result: ${invalidText(s.invalid)}` }) : null);
  }

  function bottlenecks(view) {
    const cmp = view.cmp;
    const bn = cmp.bottlenecks;
    const k = h('span', { class: 'k', text: bn.a.length > 1 || bn.b.length > 1 ? 'bottlenecks' : 'bottleneck' });
    // none named: the nearest limit of that side (per element when counted so), as single mode says it
    // none named: "≈" the nearest limit of that side (per element when counted so); the words in the tooltip
    const near = (s, w) => nearestLimit(s?.response, w);
    const unknown = (s, w) => { const n = near(s, w); return h('span', { class: 'hint', title: n ? `no single limit explains the throughput; ≈ the nearest limit: ${n}` : 'no single limit explains the throughput', text: n ? `≈ ${n}` : 'unknown' }); };
    // both unknown, with the same nearest limit: once
    if (!bn.a.length && !bn.b.length && near(view.a, cmp.workA) === near(view.b, cmp.workB)) return h('span', { class: 'ab-bn' }, k, ' ', unknown(view.a, cmp.workA), h('span', { class: 'hint', text: ' (both)' }));
    const list = (names, cls, s, w) => (names.length ? names.flatMap((n, i) => [i ? ', ' : '', h('span', { class: cls(n), text: n })]) : unknown(s, w));
    if (bn.same && bn.a.length) return h('span', { class: 'ab-bn' }, k, ' ', h('span', { class: 'bn', text: bn.a.join(', ') }), h('span', { class: 'hint', text: ' (both)' }));
    const change = [bn.gone.length ? `no longer: ${bn.gone.join(', ')}` : '', bn.new.length ? `new: ${bn.new.join(', ')}` : ''].filter(Boolean).join(' · ');
    return h('span', { class: 'ab-bn', title: change || null }, k, ' ',
      tag('A'), ' ', list(bn.a, (n) => (bn.b.includes(n) ? 'bn' : 'bn ab-gone'), view.a, cmp.workA),
      h('span', { class: 'ab-arrow', 'aria-hidden': 'true', text: ' → ' }),
      tag('B'), ' ', list(bn.b, (n) => (bn.a.includes(n) ? 'bn' : 'bn ab-new'), view.b, cmp.workB),
      null); // (what changed: in the title; B's new names are marked in its list)
  }

  // the model's known blind spots the blocks meet (caveats.js), on the second line: once, tagged with the side when one
  // side only has it
  function notModelled(view) {
    const seen = new Map();
    for (const [t, s] of [['A', view.a], ['B', view.b]]) {
      if (!ok(s?.response)) continue;
      for (const c of caveats(s.response, api.config?.(s.archKey) ?? null)) {
        const x = seen.get(c.id) ?? seen.set(c.id, { c, sides: [] }).get(c.id);
        x.sides.push(t);
      }
    }
    if (!seen.size) return null;
    return h('span', { class: 'cv-line ab-cv' }, sep(), h('span', { class: 'k', text: 'not modelled' }), ' ',
      [...seen.values()].flatMap(({ c, sides }, k) => [k ? ' · ' : '', h('span', { class: 'cv', 'data-cv': c.id, title: c.title, text: c.text }),
        sides.length === 1 ? [' ', tag(sides[0])] : null]));
  }

  // {text, title} when A and B analyze loops with other labels of one text, or other instruction counts with the same
  // elements per iteration; else null
  function mismatch(view) {
    const { a, b, cmp } = view;
    if (!ok(a?.response) || !ok(b?.response)) return null;
    const label = (s) => String(s.loop ?? 'all of it').replace(/^loop /, '');
    if (a.text === b.text && a.loop !== b.loop) {
      return { text: 'other loops', title: `A and B are the same text but analyze other loops: A ${label(a)}, B ${label(b)} (each side's loop menu picks one)` };
    }
    const n = (s) => s.response.rows.filter((x) => x.kind === 'instr').length;
    if (cmp.workA === cmp.workB && n(a) !== n(b)) {
      return { text: `${n(a)} vs ${n(b)} instr`, title: `A has ${n(a)} instructions, B ${n(b)}, with the same elements per iteration (${cmp.workA}): if an iteration of one does more work, set each side's elems` };
    }
    return null;
  }

  function headline(view) {
    const { a, b, cmp } = view;
    const t = cmp.tp;
    const per = cmp.perElement;
    const val = (s, v, raw, work) => (ok(s?.response)
      ? h('span', { class: `value${s.invalid ? ' invalid' : ''}`, title: s.invalid ? `not a result: ${s.invalid.title} (${two(raw)} cycles/iteration as computed)` : per ? `${two(raw)} cycles/iteration ÷ ${work}` : null, text: two(v) })
      : h('span', { class: 'value ab-none', text: '–' }));
    // a side whose code its CPU cannot run: no verdict, but why
    const bad = [['A', a], ['B', b]].filter(([, s]) => ok(s?.response) && s.invalid);
    const okA = ok(a?.response), okB = ok(b?.response);
    const rawA = okA ? Number(a.response.tp) : null, rawB = okB ? Number(b.response.tp) : null;
    const flag = flagged('a') || flagged('b');
    const line = h('div', { class: 'ab-tp' },
      tag('A'), val(a, okA ? rawA / cmp.workA : null, rawA, cmp.workA),
      h('span', { class: 'ab-arrow', 'aria-hidden': 'true', text: '→' }),
      tag('B'), val(b, okB ? rawB / cmp.workB : null, rawB, cmp.workB),
      h('span', { class: `unit${flag ? ' caveat' : ''}`, title: flag ? 'a side\'s code changed since its elements per iteration were set' : (per ? `A: ${cmp.workA}, B: ${cmp.workB} elements per iteration` : null), text: `${unitOf(view)}${flag ? '?' : ''}` }));
    if (t && bad.length) {
      line.append(h('span', { class: 'ab-delta ab-invalid caveat', 'data-verdict': 'invalid', title: bad.map(([k, s]) => `${k}: ${s.invalid.title}`).join('\n') },
        `not comparable: ${bad.map(([k, s]) => `${k} ${s.invalid.reason} on ${s.archKey}`).join(', ')}`));
    } else if (t) {
      const speed = t.speedup >= 1 ? `${t.speedup.toFixed(2)}× faster` : `${(1 / t.speedup).toFixed(2)}× slower`;
      line.append(h('span', { class: `ab-delta ab-${t.verdict}`, 'data-verdict': t.verdict },
        h('span', { class: 'ab-verdict', text: t.verdict === 'better' ? 'B better' : t.verdict === 'worse' ? 'B worse' : 'no change' }),
        t.verdict === 'same' ? null : ` Δ ${sign2(t.delta)} (${percent(t.pct)}) · ${speed}`));
    }
    // A and B analyze other loops of the same text, or blocks of other sizes counted with the same elements per iteration:
    // said, as that is rarely what is meant (A → B of a file, then B's loop picked by default)
    const odd = mismatch(view);
    if (odd) line.insertBefore(h('span', { class: 'ab-odd caveat', title: odd.title, text: odd.text }), line.querySelector('.ab-delta'));
    const at = alignButton(api.alignTag?.() ?? null); // (the offset, when not the default: both sides run at it)
    if (at) line.insertBefore(at, line.querySelector('.ab-delta'));
    line.append(copyAllButton());
    const meta = h('div', { class: 'meta ab-meta' }, sideMeta('A', a), sep(), sideMeta('B', b), cmp.okA && cmp.okB ? [sep(), bottlenecks(view), notModelled(view)] : null);
    meta.title = meta.textContent; // (one line on wider screens, cut with …: the whole of it here)
    // the same in one line, for screen readers and for copying
    const sr = t ? h('p', { class: 'ab-sr', text: `A: ${two(t.a)} cycles, B: ${two(t.b)} cycles${per ? ' per element' : ''}, ${bad.length ? 'not comparable' : `Δ = ${t.verdict === 'same' ? '0' : `${sign2(t.delta)} (${percent(t.pct)})`}`}` }) : null;
    return lead('throughput', line, meta, sr);
  }

  function deltaCell(d, { lowerIsBetter = true, cycles = false } = {}) {
    const cls = d === 0 ? 'ab-d' : `ab-d ${(d < 0) === lowerIsBetter ? 'ab-better' : 'ab-worse'}`;
    return h('td', { class: cls, text: cycles ? (d === 0 ? '' : sign2(d)) : signed(d) });
  }

  function limits(view) {
    const cmp = view.cmp;
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
      h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'first', text: view.cmp.perElement ? 'cycles/element' : 'limit' }), h('th', { scope: 'col', text: 'A' }), h('th', { scope: 'col' }),
        h('th', { scope: 'col', text: 'B' }), h('th', { scope: 'col' }), h('th', { scope: 'col', text: 'Δ' }))), body);
    return fold('limits', 'limits', h('span', { title: `${unitOf(view)} if each were the only bottleneck`, text: 'A vs B' }),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Limits of A and B' }, table));
  }

  function instrCell(u, shownLabel) {
    if (!u) return h('td', { class: 'ab-i ab-empty' });
    const extras = u.extras.length ? h('span', { class: 'ab-x', title: `includes ${u.extras.length} uop${u.extras.length === 1 ? '' : 's'} the renamer inserts before it (${u.extras.join(', ')})`, text: ` +${u.extras.length}` }) : null;
    const note = u.notes ? h('span', { class: 'ab-note', title: NOTES[u.notes] ?? null, text: ` ${u.notes}` }) : null;
    const text = shownLabel?.get(u.row) ?? u.label;
    return h('td', { class: 'ab-i' }, colorInstr(h('span', { title: text !== u.label ? u.label : null }), text), note, extras);
  }

  function diff(view, archA, archB) {
    const d = view.cmp.diff;
    const changed = Object.entries(d.counts).filter(([k]) => k !== 'same').reduce((n, [, c]) => n + c, 0);
    const counts = changed ? `${changed} changed` : '';
    const detail = Object.entries(d.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${STATUS_TEXT[k]}`).join(', ');
    const only = h('input', { type: 'checkbox', id: 'ab-only-changes', checked: ui.onlyChanges });
    only.checked = ui.onlyChanges;
    only.addEventListener('change', () => { ui.onlyChanges = only.checked; draw(shown); });
    const labels = new Map(); // row -> its shown label (branch targets as labels)
    for (const s of [view.a, view.b]) if (s?.shown) s.response.rows.forEach((r, i) => { if (s.shown[i]) labels.set(r, s.shown[i]); });
    const head = h('tr', null, h('th', { scope: 'col', class: 'ab-m first', 'aria-label': 'change' }),
      h('th', { scope: 'col', class: 'ab-i', text: 'A' }), h('th', { scope: 'col', class: 'ab-i', text: 'B' }),
      // (ports under their group's name, one number each, as in the uop tables: render.js columnGroup)
      d.columns.map((c, k) => {
        const cls = k === 0 || (k === 1 && d.columns[0].name === 'Issued') ? 'grp' : null, g = columnGroup(c.name);
        if (!g) return h('th', { scope: 'col', class: cls, title: c.name, text: c.name === 'Issued' ? 'Δ uops' : c.name });
        const first = k === 0 || columnGroup(d.columns[k - 1].name)?.group !== g.group;
        return h('th', { scope: 'col', class: [cls, 'pg'].filter(Boolean).join(' '), 'data-col': c.name, title: c.name }, first ? h('span', { class: 'cg', text: g.group }) : null, g.n);
      }));
    // (a long block: drawn in a window of rows, vrows.js; the sizing row holds each column's widest text)
    const rows = ui.onlyChanges ? d.rows.filter((r) => r.status !== 'same') : d.rows;
    const hidden = d.rows.length - rows.length;
    const grp = (td, k) => { if (k === 0 || (k === 1 && d.columns[0].name === 'Issued')) td.classList.add('grp'); return td; };
    const body = h('tbody');
    if (rows.length > ALL_UP_TO) {
      const widest = (texts) => texts.reduce((a, t) => (t.length > a.length ? t : a), '');
      const lab = (u) => (u ? `${labels.get(u.row) ?? u.label}${u.notes ? ` ${u.notes}` : ''}${u.extras.length ? ` +${u.extras.length}` : ''}` : '');
      body.append(h('tr', { class: 'vr-size', 'aria-hidden': 'true' }, h('td', { class: 'ab-m first', text: '±' }),
        h('td', { class: 'ab-i' }, h('span', { text: widest(rows.map((r) => lab(r.a))) })), h('td', { class: 'ab-i' }, h('span', { text: widest(rows.map((r) => lab(r.b))) })),
        d.columns.map((c, k) => grp(h('td', { class: 'ab-d', text: widest(rows.map((r) => signed(r.deltas[k]))) }), k))));
    }
    body.vr = new VRows(body, rows.length, (i) => {
      const r = rows[i];
      return h('tr', { class: `ab-${r.status}`, title: STATUS_TEXT[r.status] },
        h('td', { class: 'ab-m first', text: STATUS_MARK[r.status] }),
        instrCell(r.a, labels), instrCell(r.b, labels),
        r.deltas.map((v, k) => grp(deltaCell(v), k)));
    });
    const foot = h('tr', null, h('td', { class: 'ab-m first' }), h('th', { scope: 'row', class: 'ab-i', text: 'Total' }), h('td', { class: 'ab-i' }),
      d.totals.map((v, k) => {
        const td = deltaCell(v);
        if (k === 0 || (k === 1 && d.columns[0].name === 'Issued')) td.classList.add('grp');
        return td;
      }));
    const table = h('table', { class: 'grid ab-diff' }, h('thead', null, head), body, h('tfoot', null, foot));
    const legend = Object.entries(STATUS_MARK).filter(([k]) => k !== 'same').map(([k, m]) => `${m} ${STATUS_TEXT[k]}`).join(' · ');
    return fold('diff', 'Δ', h('span', { title: `${detail}; B − A, uops per iteration`, text: counts || 'no change' }),
      h('div', { class: 'table-tools' }, h('label', null, only, ` only changes${hidden ? ` (${hidden} hidden)` : ''}`)),
      watchFit(h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Instruction-by-instruction difference of A and B (B − A)', title: legend }, table)),
      d.portsComparable ? null : h('p', { class: 'hint', text: `${archA} and ${archB} have different ports: uop counts only` }));
  }

  // the uop tables of A and B, one above the other, each the whole width (its instruction column stays in view)
  function tables(view) {
    const side = (t, s) => {
      const col = h('div', { class: 'ab-col', 'data-side': t.toLowerCase() });
      if (!s || !ok(s.response)) { col.append(h('div', { class: 'ab-cap' }, tag(t), ' no result')); return col; }
      const r = uopTable(s.response, true, Infinity, { shown: s.shown });
      markChanges(r.table, s, t === 'A' ? 'a' : 'b', view);
      col.append(...[h('div', { class: 'ab-cap' }, tag(t), ` ${s.archKey} · ${two(Number(s.response.tp))} cycles/iteration`),
        watchFit(h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': `Uops per instruction of ${t}, average per iteration` }, r.table)),
].filter(Boolean));
      return col;
    };
    const stack = h('div', { class: 'ab-stack' }, side('A', view.a), side('B', view.b));
    scrollTogether(stack, view);
    return stack;
  }

  // The two tables' rows scroll together: the row at the top of one brings the row the diff aligns with it (ab-diff.js)
  // to the top of the other; a row only one side has leaves the other where it is.
  function scrollTogether(stack, view) {
    const wraps = [...stack.querySelectorAll(':scope > .ab-col > .table-wrap')];
    if (wraps.length !== 2) return;
    const rowsOf = (s) => s?.response?.rows ?? [];
    const map = [new Map(), new Map()]; // row of A -> of B, and back
    const d = view.cmp?.diff;
    if (d) {
      const at = [indexOfRows(view.a), indexOfRows(view.b)];
      for (const x of d.rows) {
        if (!x.a || !x.b) continue;
        const ia = at[0].get(x.a.row) ?? -1, ib = at[1].get(x.b.row) ?? -1;
        if (ia >= 0 && ib >= 0) { map[0].set(ia, ib); map[1].set(ib, ia); }
      }
    } else for (let k = 0; k < Math.min(rowsOf(view.a).length, rowsOf(view.b).length); k++) { map[0].set(k, k); map[1].set(k, k); }
    let following = false;
    // (by rows: the row at the top of one table and how far into it, the same in the other; vrows.js offsetOf and rowAt
    // measure a short table's rows, a long one's by its row height)
    const vrOf = (w) => w.querySelector('table')?.vr ?? null;
    wraps.forEach((w, k) => w.addEventListener('scroll', () => {
      if (following) return;
      const other = wraps[1 - k];
      const va = vrOf(w), vb = vrOf(other);
      if (!va || !vb) return;
      const lo = va.rowAt(w.scrollTop);
      const j = map[k].get(lo);
      if (j === undefined) return;
      const t = vb.offsetOf(j) + (w.scrollTop - va.offsetOf(lo));
      if (Math.abs(other.scrollTop - t) < 1) return;
      following = true;
      other.scrollTop = t;
      requestAnimationFrame(() => { following = false; });
    }, { passive: true }));
  }

  // What differs, in the tables themselves (the alignment of the Δ fold, ab-diff.js): a row of a changed instruction
  // gets a bar in its side's colour and its differing cells a frame; a row only this side has is tinted.
  // (as a decorator of the table's rows, vrows.js: registered first, so the cell positions are the table's own)
  function markChanges(table, s, side, view) {
    const d = view.cmp?.diff;
    const other = side === 'a' ? view.b : view.a;
    if (!d || !ok(other?.response) || !table.vr) return;
    const names = [...table.tHead.rows[0].cells].slice(2).map((th) => th.dataset.col); // (after the instruction and the notes)
    const otherCols = other.response.columns;
    const at = indexOfRows(s);
    const marks = new Map(); // row -> {only: title} | {cells: [cell index]}
    for (const x of d.rows) {
      const mine = side === 'a' ? x.a : x.b, theirs = side === 'a' ? x.b : x.a;
      if (!mine || x.status === 'same') continue;
      const row = at.get(mine.row);
      if (row === undefined) continue;
      if (!theirs) { marks.set(row, { only: side === 'a' ? 'only in A' : 'only in B' }); continue; }
      const cells = [];
      names.forEach((name, k) => {
        const ia = s.response.columns.indexOf(name), ib = otherCols.indexOf(name);
        if (ia < 0 || ib < 0) return;
        if (Math.abs((mine.values[ia] ?? 0) - (theirs.values[ib] ?? 0)) >= 0.005) cells.push(k + 2);
      });
      marks.set(row, { cells });
    }
    table.vr.decorate('ab', (tr, k) => {
      const m = marks.get(k);
      if (!m) return;
      if (m.only) { tr.classList.add('abd-only'); tr.title = m.only; return; }
      tr.classList.add('abd-chg');
      for (const c of m.cells) tr.cells[c]?.classList.add('abd-cell');
    });
  }
  // a side's rows by object: row -> index
  function indexOfRows(s) { const m = new Map(); (s?.response?.rows ?? []).forEach((r, k) => m.set(r, k)); return m; }

  function reports(view) {
    // (the texts go into the page when the fold is opened: a long block's reports are hundreds of kB to lay out)
    const pres = [];
    const pre = (t, s) => {
      const p = h('pre', { class: 'report', tabindex: '0', 'aria-label': `uiCA report of ${t}` });
      pres.push([p, typeof s?.response?.text === 'string' ? s.response.text : '']);
      return h('div', { class: 'ab-col' }, h('div', { class: 'ab-cap' }, tag(t)), p);
    };
    const row = fold('report', 'text', 'uiCA reports', h('div', { class: 'ab-pair' }, pre('A', view.a), pre('B', view.b)));
    const d = row.querySelector('details');
    const small = pres.every(([, text]) => text.length < 50000); // (a short block's reports: in the page at once, as before)
    const fill = () => { if (d.open || small) for (const [p, text] of pres) if (!p.firstChild && text) p.textContent = text; };
    d.addEventListener('toggle', fill);
    fill();
    return row;
  }

  function draw(view) {
    shown = view;
    if (!view) return;
    const both = view.cmp.okA && view.cmp.okB;
    const parts = [tables(view)];
    if (both) parts.push(diff(view, view.a.archKey, view.b.archKey), limits(view));
    parts.push(h('div', { class: 'ab-slots-slot', hidden: true }), reports(view));
    // the first tab of the result (workspace.js): its content says what it is
    const main = h('div', { class: 'row lead ws-main', id: 'ab-main', 'data-tab': 'diff' }, h('div', { class: 'label', text: 'uops' }), h('div', { class: 'field' }, ...parts));
    // the tab row (workspace.js) and the table per CPU stay in the page, and the focus with them (a tab, a row's button)
    const keep = api.el.body.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement) : null;
    const strip = api.el.body.querySelector(':scope > .view-tabs');
    api.el.body.replaceChildren(...[api.cpusBox, headline(view), strip, main].filter(Boolean));
    if (keep?.isConnected && document.activeElement !== keep) keep.focus({ preventScroll: true });
    api.drawn?.(api.el.body, view); // more parts of other modules (ab-slots.js)
  }

  paint();
  settle('a'); settle('b');
  return {
    active: () => state.ab,
    paint, inputs, analyze, draw, summary, key, reweigh,
    setB(code) { setB(code); paint(); api.changed({ now: true }); },
    // side A's code was replaced (an example, an import): its count starts again at 1
    replacedA() { if (state.aWork !== 1) { state.aWork = 1; api.changed(); } settle('a'); paintWork(); },
    // B's code was replaced by other code (a paste over it): its count starts again at 1
    replacedB() { if (state.bWork !== 1) { state.bWork = 1; api.changed(); } settle('b'); paintWork(); },
    // a side's code is the same machine code in another form (asm <-> hex), or came with its count (a link): its count
    // stays right
    settleCode(s) { settle(s); paintWork(); },
    flagged: (s) => flagged(s),
    // the root of a side's table (the page's views of that side shade and point at its rows)
    sideRoot: (s) => api.el.body.querySelector(`#ab-main .ab-col[data-side="${s}"]`),
    getB: () => ({ mode: state.bMode, syntax: state.bSyntax, text: bCode.value }),
    hasMessages: () => state.ab && !!bMessages.firstChild,
    clearMessages: () => clearB(),
    textareaB: bCode,
  };
}
