// The page: wires the controls to the engine (the analyzer in a worker, engine-rpc.js; with ?mock=1 the mock,
// engine-mock.js), the hex parser, the assembler adapter, the URL state and the result view.

import { WasmEngine, makeRequest } from './engine.js';
import { WorkerEngine } from './engine-rpc.js';
import { parseHexInput, toHex, hexToBytes } from './hex-input.js';
import { archGroups, archTitle, DEFAULT_ARCH, ARCH_INFO, PROTOTYPE, accuracyNote } from './archs.js';
import { DEFAULT_STATE, LIMITS, encodeState, decodeState, clampInt } from './url-state.js';
import { EXAMPLES, CLASSIC_EXAMPLES, SHOWCASE_EXAMPLES, MOCK_EXAMPLES } from './examples.js';
import { fetchBytes, fetchManifest, PATHS, formatSize, whenIdle } from './loader.js';
import { WasmAssembler, isWasm, MAX_CODE_BYTES, tooMuchCode } from './assembler.js';
import { WorkerAssembler, PageAssembler } from './assembler-rpc.js'; // large sources in a worker of its own
import { renderResult, renderEmpty, renderFailure, copyText, h, row } from './render.js';
import { latestWins } from './compare.js';
import { createComparePanels } from './compare-view.js';
import { createTracePanel, createABTracePanel } from './trace.js';
import { createTraceLink } from './trace-link.js'; // the uop table <-> the trace; the wait column
import { createAB } from './ab.js';                 // A–B comparison
import { createCeImport } from './godbolt-ui.js';   // import from Compiler Explorer
import { createInsight } from './insight-view.js';
import { createPool, poolSize, tableCap } from './pool.js';  // workers for the views with many analyses
import { createConverter } from './asm-text.js';  // hex <-> asm
import { createViews } from './views.js';         // the opt-in views below the result
import { createABSlots } from './ab-slots.js';     // A–B: the issue slots of both sides
import { createCmpSlots } from './cmp-slots.js';   // the issue slots per CPU in the CPU table (bound view open)
import { withRegions } from './asm-regions.js';     // marked regions and .loc lines of pasted assembly
import { createRegionChip } from './region-chip.js';
import { createKeys } from './keys.js';           // keyboard shortcuts, the ? overlay
import { createABCpus } from './ab-cpus.js';       // A–B on every checked CPU
import { branchLabels, startLabel } from './branch-label.js'; // branch targets as labels in the uop table

const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const MOCK = query.get('mock') === '1';       // ?mock=1: do not load the analyzer, use the mock (for work on the page)
const NO_SW = query.get('nosw') === '1';      // ?nosw=1: do not register the service worker
// ?pool=N: N workers for the compare panels and the cost column (0: none, they share the main analyzer's worker)
const POOL_SIZE = query.has('pool') ? Math.max(0, Math.min(16, Number.parseInt(query.get('pool'), 10) || 0)) : poolSize();
const VERSION = '0.1.5';                  // the page's version (footer); bump it here

const el = {
  notice: $('notice'), code: $('code'), codeHint: $('code-hint'), messages: $('input-messages'),
  modeAsm: $('mode-asm'), modeHex: $('mode-hex'), syntax: $('syntax'), syntaxWrap: $('syntax-wrap'),
  examples: $('examples'), cpus: $('cpus'), cpuGrid: $('cpu-grid'), cpuAll: $('cpu-all'), cpuClear: $('cpu-clear'), traceSlot: $('trace-slot'),
  advanced: $('advanced'), advancedSummary: $('advanced-summary'),
  align: $('opt-align'), sfe: $('opt-sfe'), nmi: $('opt-nmi'), nma: $('opt-nma'), iter: $('opt-iter'), cycles: $('opt-cycles'),
  reset: $('opt-reset'), run: $('run'), copy: $('copy-link'), live: $('live'),
  status: $('status'), statusWrap: $('status-wrap'), statusBar: $('status-bar'),
  results: $('results'), body: $('result-body'), buildId: $('build-id'), updateNote: $('update-note'), reload: $('reload'),
  toolbar: document.querySelector('#input .toolbar'),
};

const HINTS = { hex: 'hex or objdump -d', asm: '' };
const PLACEHOLDERS = {
  hex: '48 83 c0 01 49 ff cf 75 f7',
  asm: 'loop:\n  add rax, 1\n  dec r15\n  jnz loop',
};

// ---- state ---------------------------------------------------------------------------------------------------

const state = { ...DEFAULT_STATE };
const buffers = { hex: '', asm: '' }; // the text of each input mode; the text area shows buffers[state.mode]
const ui = { hideEmpty: true, reportOpen: false, listingOpen: { asm: null, hex: null } }; // listing: per input mode; null: closed

let manifest = { version: 'dev', files: {}, tables: [], assembler: null };
let uarch = null;
let archItems = new Map(); // key -> {key, title, table, chip, experimental}
let checked = [];          // the checked CPUs, in menu order; state.arch (the focused one, with the details) is one of them
let engine = null;
let wasmModule = null;  // the compiled analyzer, shared by every worker
let uarchBytes = null;
let pool = null;        // the worker pool (pool.js): made when a view with many analyses first needs it
let ready = false;
let warmedUp = false; // the analyzer's worker ran its warm-up block (once, after the first result: engine-rpc.js)
let runSeq = 0;
let busy = false;
let lastView = null;
let lastRunKey = '';
let lastFragment = null;
const tables = new Map(); // table name -> promise of "loaded into the engine"
const tableData = new Map(); // table name -> promise of its bytes (the main engine and the pool's workers share them)
let assemblerPromise = null;
let assemblerMissing = false; // true: this build has no assembler (final); a failed load of an existing one is not
let assemblerError = '';
let assembling = null;  // AbortController of the assembly of the current run: a newer run or an edit stops it
let prefetchStarted = false;
let inflight = { id: 0, key: '' }; // the analysis that is running (busy)
let cancelledKey = '';              // the input of a run the user cancelled: live mode does not start it again
let touched = false;                // the input was changed before the analyzer was ready

// Live mode: analyze while typing (LIVE_DELAY after the last change; at once after an option change). At most
// one live run at a time; requests that come in meanwhile give one more run, with the latest input.
const LIVE_KEY = 'wuica-live';
const LIVE_DELAY = 200;
const LONG_RUN_MS = 1000; // a running analysis older than this is stopped by new input instead of waited for
let liveOn = true;
try { liveOn = localStorage.getItem(LIVE_KEY) !== 'off'; } catch { /* storage unavailable: on */ }
const liveRunner = latestWins(() => run({ auto: true }));

// The compare views (compare-view.js): the table of the checked CPUs (several checked) and the alignment sweep. They
// get every successful result of single mode; in A–B mode they are hidden (ab.css), keep their state, and wait for
// the next single-mode result.
const cmpSlots = createCmpSlots({ engine: () => engine, pool: () => getPool(), enabled: () => state.bound });
const panels = createComparePanels({
  decorateCpus: (table, input) => cmpSlots.decorate(table, input),
  els: {
    cpus: $('cmp-cpus'), cpusInfo: $('cmp-cpus-info'), cpusBody: $('cmp-cpus-body'),
    sweep: $('cmp-sweep'), sweepInfo: $('cmp-sweep-info'), sweepBody: $('cmp-sweep-body'),
  },
  engine: () => engine,
  pool: () => getPool(),
  checked: () => checked.map((k) => archItems.get(k)).filter(Boolean),
  multi: () => checked.length > 1 && !state.ab,
  tableLoaded: (key) => !!engine?.hasArch(archItems.get(key)?.table),
  ensureTable: (key) => ensureTable(key),
  onArch: (key) => focusArch(key),
  onAlign: (offset) => setAlign(offset),
  onToggle: () => {
    const o = panels.open();
    if (o.sweep === state.cmpSweep) return;
    state.cmpSweep = o.sweep;
    syncUrl(true);
  },
  wantResult: () => { if (ready && !lastView && !ab?.active() && el.code.value.trim() !== '') run(); },
});
// A–B: A and B on every checked CPU (a table above the comparison, several CPUs checked)
const abCpus = createABCpus({
  engine: () => engine,
  pool: () => getPool(),
  checked: () => checked.map((k) => archItems.get(k)).filter(Boolean),
  tableLoaded: (key) => !!engine?.hasArch(archItems.get(key)?.table),
  ensureTable: (key) => ensureTable(key),
  onArch: (key) => focusArch(key),
});
// A–B: the side the page's views (bound, try, bytes, deps, mca, sweep, source) show; picked in the tab row (workspace.js)
let abSide = 'a';
// The critical chain and the cost column on the result (insight-view.js).
const insight = createInsight({
  engine: () => engine,
  pool: () => getPool(),
  onToggle: () => { const o = insight.open(); state.cost = o.cost; state.costNop = o.cost && o.nop; syncUrl(true); },
});
let pastedSource = null; // the .loc lines of pasted assembly (asm-regions.js), bound to its bytes
const regionChip = createRegionChip(el.messages, (line) => selectLine(line));
const views = createViews({ engine: () => engine, pool: () => getPool(), setAlign: (o) => setAlign(o), onToggle: (open) => { Object.assign(state, open); syncUrl(true); if ('bound' in open) cmpSlots.decorate(); }, getSel: () => state.sel, getSource: () => (ceSource && (!pastedSource || ceSource.hex === lastView?.hex) ? ceSource : pastedSource),
  // llvm-mca (mca.js): its module only if the build has it, downloaded on first use; the bytes as Intel assembly
  mca: {
    available: () => !!manifest.mca && !MOCK,
    module: () => (mcaModule ??= download('llvm-mca', PATHS.mca).then((b) => WebAssembly.compile(b)).catch((e) => { mcaModule = null; throw e; })),
    toAsm: (hex) => converter.fromBytes(hexToBytes(hex)),
    spawn: () => new Worker(new URL('./mca-worker.js', import.meta.url)),
  } });
let mcaModule = null;
// The trace (trace.js), below both panes; linked to the uop table (trace-link.js). Its open state and the selected row
// are in the URL.
const traceOpened = (open) => { if (state.trace === open) return; state.trace = open; syncUrl(true); };
const tracePanel = createTracePanel({
  analyze: (request) => engine.analyze(request), config: (v) => uarch?.configs?.[v.archKey],
  onToggle: traceOpened,
  onHoverGroup: (g) => traceLink.fromTraceHover(g),
  onPickGroup: (g) => traceLink.fromTracePick(g),
  onTrace: () => traceLink.refresh(),
});
const traceLink = createTraceLink({
  panel: tracePanel,
  getSel: () => state.sel,
  setSel: (row) => { if (state.sel === row) return; state.sel = row; syncUrl(true); },
  onWaits: (on) => { state.waits = on; syncUrl(true); },
});
// A–B: the traces of both sides on one time axis
const abTracePanel = createABTracePanel({ analyze: (request) => engine.analyze(request), config: (side) => uarch?.configs?.[side.archKey], onToggle: traceOpened });
let ab = null; // the A–B comparison (ab.js); in A–B mode lastView is {ab: view} (the A–B traces, no compare panels)
let ce = null; // the Compiler Explorer import (godbolt-ui.js)

// ---- status line and progress ----------------------------------------------------------------------------------

const downloads = new Map(); // label -> {got, total}
let idleStatus = 'starting…';
let flashTimer = 0;

function paintStatus() {
  if (flashTimer) return;
  el.statusWrap.classList.remove('error', 'idle');
  if (downloads.size) {
    let got = 0, total = 0;
    for (const d of downloads.values()) { got += d.got; total += Math.max(d.total, d.got); }
    const names = [...downloads.keys()].join(', ');
    el.status.textContent = `loading ${names} · ${formatSize(got)}${total > got ? ' / ' + formatSize(total) : ''}`;
    el.statusBar.style.width = total ? `${Math.min(100, (100 * got) / total).toFixed(1)}%` : '0';
  } else {
    el.status.textContent = idleStatus;
    el.statusBar.style.width = '0';
    el.statusWrap.classList.add('idle'); // dense mode hides it: the result says the same
  }
}
function setIdle(text) { idleStatus = text; paintStatus(); }
function flash(text, { error = false, ms = 2500 } = {}) {
  clearTimeout(flashTimer);
  el.statusWrap.classList.remove('idle');
  el.status.textContent = text;
  el.statusWrap.classList.toggle('error', error);
  flashTimer = setTimeout(() => { flashTimer = 0; paintStatus(); }, ms);
}
async function download(label, path) {
  const size = manifest.files[path] ?? 0;
  const d = { got: 0, total: size };
  downloads.set(label, d);
  paintStatus();
  try {
    return await fetchBytes(path, { size, onProgress: (got) => { d.got = got; paintStatus(); } });
  } finally {
    downloads.delete(label);
    paintStatus();
  }
}

// ---- controls <-> state ---------------------------------------------------------------------------------------

function options() {
  return {
    alignmentOffset: state.alignmentOffset, initPolicy: state.initPolicy, simpleFrontEnd: state.simpleFrontEnd,
    noMicroFusion: state.noMicroFusion, noMacroFusion: state.noMacroFusion,
    minIterations: state.minIterations, minCycles: state.minCycles,
  };
}

function writeControls() {
  el.modeAsm.checked = state.mode === 'asm';
  el.modeHex.checked = state.mode === 'hex';
  el.syntax.value = state.syntax;
  el.syntaxWrap.hidden = state.mode !== 'asm';
  el.code.value = buffers[state.mode];
  el.code.placeholder = PLACEHOLDERS[state.mode];
  el.code.setAttribute('aria-label', state.mode === 'asm' ? 'Assembly code' : 'Machine code (hex)');
  el.codeHint.textContent = HINTS[state.mode];
  el.codeHint.hidden = !HINTS[state.mode];
  paintCpus();
  el.align.value = state.alignmentOffset;
  for (const r of document.querySelectorAll('input[name="init"]')) r.checked = r.value === state.initPolicy;
  el.sfe.checked = state.simpleFrontEnd;
  el.nmi.checked = state.noMicroFusion;
  el.nma.checked = state.noMacroFusion;
  el.iter.value = state.minIterations;
  el.cycles.value = state.minCycles;
  panels.setOpen({ sweep: state.cmpSweep });
  insight.setOpen({ cost: state.cost, nop: state.costNop });
  tracePanel.setOpen(state.trace);
  abTracePanel.setOpen(state.trace);
  traceLink.setOpen({ waits: state.waits });
  views.setOpen(state);
  paintDerived();
  ab?.paint();
}

function paintDerived() {
  const changed = ['alignmentOffset', 'initPolicy', 'simpleFrontEnd', 'noMicroFusion', 'noMacroFusion', 'minIterations', 'minCycles']
    .filter((k) => state[k] !== DEFAULT_STATE[k]).length;
  el.advancedSummary.textContent = changed ? ` · ${changed} changed` : '';
  paintCpus();
  el.run.disabled = !ready || (state.mode === 'asm' && assemblerMissing);
  paintStale();
}

function runKey() {
  return JSON.stringify([state.mode, state.mode === 'asm' ? state.syntax : '', el.code.value, state.arch, options(), ab?.key() ?? '']);
}
// drawn: an A–B result was just drawn; if its input changed while it ran (e.g. B edited while A and B ran), it dims at
// once (style.css: otherwise only after a pause in typing, as single mode's result does)
function paintStale({ drawn = false } = {}) {
  const stale = !!lastView && runKey() !== lastRunKey;
  el.body.classList.toggle('stale', stale);
  if (drawn || !stale) el.body.classList.toggle('stale-now', stale);
  const shownResponse = lastView?.ab ? abView()?.response : lastView?.response;
  panels.setStale(stale || !(shownResponse && !('error' in shownResponse)));
}

function collectState() {
  return { ...state, cpus: cpusField(), text: el.code.value };
}

let syncTimer = 0;
function syncUrl(now = false) {
  clearTimeout(syncTimer);
  const go = () => {
    const frag = encodeState(collectState());
    lastFragment = frag;
    try {
      history.replaceState(null, '', location.pathname + location.search + (frag ? '#' + frag : ''));
    } catch { /* some browsers limit the rate or the length; the link button still works */ }
  };
  if (now) go(); else syncTimer = setTimeout(go, 400);
}

// now: the code was replaced (pasted, imported, an example, swapped): an out-of-date result dims at once, not after a
// pause in typing (in A–B mode a new A next to an old B would otherwise look current for a moment)
function changed({ rerun = false, now = false } = {}) {
  keepFocusChecked();
  paintDerived();
  if (now && el.body.classList.contains('stale')) el.body.classList.add('stale-now');
  syncUrl();
  if (!ready) touched = true;
  if (liveOn && ready) liveSchedule(rerun ? 0 : LIVE_DELAY);
  else if (rerun && lastView && ready) scheduleRun();
}
function liveSchedule(ms) {
  // an assembly is out of date now: stop it (a large one takes seconds; a small one is done before the next edit)
  if (assembling) stopAssembly();
  // an analysis that takes long is out of date now: stop it rather than wait for it
  else if (busy && engine?.capabilities.cancel && performance.now() - busySince > LONG_RUN_MS) { runSeq++; engine.cancel(); setBusy(false); }
  liveRunner.schedule(ms);
}
function setLive(on) {
  liveOn = on;
  el.live.checked = on;
  el.results.classList.toggle('live', on); // style.css: the result dims later while typing
  try { localStorage.setItem(LIVE_KEY, on ? 'on' : 'off'); } catch { /* not remembered */ }
  if (on && ready && el.code.value.trim() !== '') liveRunner.schedule(0); else liveRunner.cancel();
}
// ---- the checked CPUs ---------------------------------------------------------------------------------------------
// Several can be checked (a table compares them); one of them, state.arch, is focused: it has the detailed result, the
// sweep, the trace and side A of an A–B comparison. A CPU that is checked (one click) becomes the focused one; a row of
// the table moves the focus too. Unchecking the focused CPU moves the focus to the checked CPU that was focused most
// recently (or the first checked one). "All" and "clear" keep the focus. At least one CPU stays checked.

const inMenuOrder = (keys) => [...archItems.keys()].filter((k) => keys.includes(k));
// the CPUs that were focused, most recent first (recorded where the boxes are painted: every change of state.arch
// passes there, also those made elsewhere, e.g. the A–B swap or a link)
let focusHistory = [];
function noteFocus() {
  if (focusHistory[0] === state.arch) return;
  focusHistory = [state.arch, ...focusHistory.filter((k) => k !== state.arch)].slice(0, 64);
}
// the checked CPUs for the URL: '' (only the focused one), 'all', or a list
function cpusField() {
  if (!archItems.size) return state.cpus; // not read yet: as the link had it
  if (checked.length <= 1 && (checked[0] ?? state.arch) === state.arch) return '';
  if (checked.length === archItems.size) return 'all';
  return checked.join(',');
}
// the checked CPUs from state.cpus (a link) once the menu is known; unknown keys are dropped
function readCpus() {
  if (!archItems.size) return;
  if (!archItems.has(state.arch)) state.arch = archItems.has(DEFAULT_ARCH) ? DEFAULT_ARCH : archItems.keys().next().value;
  const want = state.cpus === 'all' ? [...archItems.keys()] : String(state.cpus || '').split(',');
  checked = inMenuOrder([...want, state.arch]);
  state.cpus = cpusField();
}
function setChecked(keys) {
  checked = inMenuOrder(keys);
  state.cpus = cpusField();
  paintCpus();
  panels.refreshCpus();
  if (lastView?.ab) updateABCpus(lastView.ab, { auto: true });
}
// the focused CPU changed elsewhere (A–B swap, an example of the mock): it is checked too
function keepFocusChecked() {
  if (!archItems.size || checked.includes(state.arch) || !archItems.has(state.arch)) return;
  setChecked(checked.length <= 1 ? [state.arch] : [...checked, state.arch]);
}
// focus a CPU (a row of the table, an example); an unchecked one is checked (instead of the only one checked)
function focusArch(key, { rerun = true } = {}) {
  if (!archItems.has(key)) return;
  if (!checked.includes(key)) setChecked(checked.length <= 1 ? [key] : [...checked, key]);
  if (key === state.arch) return;
  state.arch = key;
  ab?.paint();
  ensureTable(key).catch((e) => flash(`table not loaded: ${e?.message ?? e}`, { error: true, ms: 6000 }));
  changed({ rerun });
}
const cpuBoxes = () => [...el.cpuGrid.querySelectorAll('input[type=checkbox]')];
function paintCpus() {
  if (archItems.has(state.arch)) noteFocus();
  for (const b of cpuBoxes()) {
    b.checked = checked.includes(b.value);
    const focus = b.value === state.arch;
    b.parentElement.classList.toggle('focus', focus);
    if (focus) b.setAttribute('aria-describedby', 'l-cpus-focus'); else b.removeAttribute('aria-describedby');
  }
  el.cpus.classList.toggle('multi', checked.length > 1 || state.ab);
  el.cpus.dataset.focus = state.arch;
  el.cpus.dataset.checked = checked.join(',');
  el.cpuClear.disabled = checked.length <= 1;
  el.cpuAll.disabled = archItems.size > 0 && checked.length === archItems.size;
}
// the boxes changed (one click, or a test that sets several and sends one change event)
function cpusChanged(e) {
  const now = cpuBoxes().filter((b) => b.checked).map((b) => b.value);
  if (!now.length) { if (e?.target) e.target.checked = true; return; } // the last one stays checked
  const added = now.filter((k) => !checked.includes(k));
  // one CPU checked (a click): it gets the focus; the focused one unchecked: the most recently focused of the rest.
  // (Several at once, which only a script does: the focus stays if it can.)
  const focus = added.length === 1 ? added[0] : now.includes(state.arch) ? state.arch : focusHistory.find((k) => now.includes(k)) ?? now[0];
  setChecked(now);
  if (focus !== state.arch) {
    state.arch = focus;
    ab?.paint(); // side A's caption, B's "same as A"
    ensureTable(focus).catch((err) => flash(`table not loaded: ${err?.message ?? err}`, { error: true, ms: 6000 }));
    changed({ rerun: true });
  } else {
    paintDerived();
    syncUrl(true);
  }
}
function setAlign(offset) {
  const v = clampInt(offset, LIMITS.alignmentOffset, DEFAULT_STATE.alignmentOffset);
  if (v === state.alignmentOffset) return;
  state.alignmentOffset = v;
  el.align.value = v;
  changed({ rerun: true });
}
let rerunTimer = 0;
function scheduleRun() {
  clearTimeout(rerunTimer);
  rerunTimer = setTimeout(run, 120);
}

// ---- messages next to the input ---------------------------------------------------------------------------------

function clearMessages() {
  regionChip.sync(state.mode === 'asm' ? el.code.value : null); // kept only for the text it was shown for
  el.messages.replaceChildren();
  delete el.messages.dataset.key;
  el.code.removeAttribute('aria-invalid');
}

function selectLine(line) {
  const text = el.code.value;
  let start = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) return;
    start = nl + 1;
  }
  let end = text.indexOf('\n', start);
  if (end < 0) end = text.length;
  el.code.focus();
  el.code.setSelectionRange(start, end);
}

// items: [{line, column, severity, message}]; severity 'error' | 'warning' | 'note'
function showMessages(items) {
  const key = JSON.stringify(items);
  if (el.messages.dataset.key === key && el.messages.firstChild) return; // the same: keep them (and their focus)
  const list = h('ul');
  for (const d of items) {
    const where = d.line ? `line ${d.line}${d.column ? ':' + d.column : ''}: ` : '';
    const text = `${where}${d.severity === 'warning' ? 'warning: ' : ''}${d.message}`;
    const li = h('li', { class: d.severity === 'error' ? null : d.severity });
    if (d.line) {
      const b = h('button', { type: 'button', class: 'plain', title: `select line ${d.line}`, text });
      b.addEventListener('click', () => selectLine(d.line));
      li.append(b);
    } else {
      li.textContent = text;
    }
    list.append(li);
  }
  el.messages.replaceChildren(list);
  el.messages.dataset.key = key;
  if (items.some((d) => d.severity === 'error')) el.code.setAttribute('aria-invalid', 'true'); else el.code.removeAttribute('aria-invalid');
}

function showAssemblerMissing() {
  const b = h('button', { type: 'button', class: 'plain', text: 'use hex' });
  b.addEventListener('click', () => setMode('hex'));
  const why = assemblerMissing ? 'No assembler in this build'
    : `Assembler could not be loaded (${assemblerError || 'unknown error'}); Analyze retries`;
  el.messages.replaceChildren(h('ul', null, h('li', null, `${why} · `, b)));
  delete el.messages.dataset.key;
}

// ---- input modes -------------------------------------------------------------------------------------------------

function setMode(mode, converted = null) { // converted: the code in the new format (switchMode), or null: its own text
  if (mode === state.mode) return;
  buffers[state.mode] = el.code.value;
  state.mode = mode;
  if (converted) { buffers[mode] = converted.text; if (converted.syntax) state.syntax = converted.syntax; }
  clearMessages();
  writeControls();
  regionChip.sync(state.mode === 'asm' ? el.code.value : null); // back to the marked text (asm -> hex -> asm)
  if (mode === 'asm') {
    ensureAssembler().then((a) => { if (!a && state.mode === 'asm') showAssemblerMissing(); paintDerived(); });
  }
  changed();
}

function ensureAssembler() {
  assemblerPromise ??= (async () => withRegions(await (async () => {
    if (manifest.assembler !== false) { // false: build.sh found no module, so do not even ask for it
      try {
        const bytes = await download('assembler', PATHS.assembler);
        if (isWasm(bytes)) {
          // small sources on this thread, large ones in a worker (started when the first one comes): assembler-rpc.js
          const module = await WebAssembly.compile(bytes);
          return new PageAssembler(await WasmAssembler.create(module), () => WorkerAssembler.create(module, spawnAsmWorker));
        }
        assemblerError = 'wuica_asm.wasm is not a WebAssembly module';
      } catch (e) {
        assemblerError = e?.message ?? String(e); // not there, offline, or not usable
      }
    }
    if (MOCK) {
      const { MockAssembler } = await import('./assembler-mock.js');
      return new MockAssembler();
    }
    if (manifest.assembler) { // the build has it: a failure to load it can be temporary (offline), so try again next time
      assemblerPromise = null;
      return null;
    }
    assemblerMissing = true;
    return null;
  })()))();
  return assemblerPromise;
}

// The assembler for side B of a run: its jobs stop with the run (as side A's in machineCode()).
async function assemblerForRun() {
  const signal = assembling?.signal;
  const a = await ensureAssembler();
  return a && { mock: a.mock, assemble: (text, syntax) => a.assemble(text, syntax, { signal }) };
}

async function loadExample(ex) {
  if (ex.asm && ex.text.intel == null) { try { ex.text.intel = await ex.asm(); } catch { /* offline and not cached: hex */ } }
  settleMode({ replacing: true }); // the example replaces the code
  if (ex.hexOnly && state.mode !== 'hex') setMode('hex'); // machine code only
  if (ex.asm) { // Intel assembly only (else machine code): opens in asm mode
    if (ex.text.intel == null) { if (state.mode !== 'hex') setMode('hex'); }
    else {
      if (state.mode !== 'asm') setMode('asm');
      if (state.syntax !== 'intel') { state.syntax = 'intel'; writeControls(); }
    }
  }
  const key = state.mode === 'asm' ? state.syntax : 'hex';
  el.code.value = buffers[state.mode] = ex.text[key];
  if (state.ab) ab.replacedA(); // other code: its elements per iteration start again
  // the mock has the reference's result for this microarchitecture
  if (engine?.capabilities.mock && archItems.has(ex.arch) && state.arch !== ex.arch) focusArch(ex.arch, { rerun: false });
  clearMessages();
  changed({ now: true });
  run();
}

const ALL_EXAMPLES = [...EXAMPLES, ...CLASSIC_EXAMPLES, ...SHOWCASE_EXAMPLES, ...MOCK_EXAMPLES];
function fillExamples() {
  const group = (label, list) => h('optgroup', { label }, list.map((e) => h('option', { value: e.id, text: e.title })));
  el.examples.replaceChildren(h('option', { value: '', text: 'examples…' }), group('basics', EXAMPLES), group('classic loops', CLASSIC_EXAMPLES),
    group('showcase', SHOWCASE_EXAMPLES), ...(engine?.capabilities.mock ? [group('mock', MOCK_EXAMPLES)] : []));
}
// the code of an example in the current input format
const exampleCode = (ex) => ({ mode: state.mode, syntax: state.syntax, text: ex.text[state.mode === 'asm' ? state.syntax : 'hex'] });

// ---- microarchitectures and their tables ---------------------------------------------------------------------------

// The CPU boxes: short keys in order of release; the full name and year in the tooltip and the accessible name;
// prototypes marked.
function fillArchs() {
  archItems = new Map();
  const cells = [];
  for (const g of archGroups(uarch)) {
    for (const it of g.items) {
      archItems.set(it.key, it);
      const info = ARCH_INFO[it.key];
      const name = info ? `${info.name}${info.year ? ` (${info.year})` : ''}` : it.key;
      const box = h('input', { type: 'checkbox', value: it.key, 'aria-label': it.title });
      cells.push(h('label', { class: 'cpu' + (it.experimental ? ' proto' : ''), title: `${name}${it.experimental ? ` · ${PROTOTYPE} model: less validated${accuracyNote(it.key) ? ` · ${accuracyNote(it.key)}` : ''}` : ''}` },
        box, it.key, it.experimental ? h('span', { class: 'proto-mark', 'aria-hidden': 'true', text: 'p' }) : null));
    }
  }
  if (archItems.size === 0) throw new Error('uarch.json has no configurations');
  el.cpuGrid.replaceChildren(...cells, h('span', { id: 'l-cpus-focus', class: 'vh', text: 'details shown' }));
  readCpus();
  paintCpus();
}

// The bytes of a table, downloaded once (they are kept: the engines load them again after a restart).
function tableBytes(name) {
  let p = tableData.get(name);
  if (!p) {
    p = download(`${name} table`, PATHS.table(name));
    tableData.set(name, p);
    p.catch(() => tableData.delete(name)); // a later attempt may succeed (e.g. back online)
  }
  return p;
}

// Loads the table of a microarchitecture into the main engine.
function ensureTable(archKey) {
  const name = archItems.get(archKey).table;
  let p = tables.get(name);
  if (!p) {
    p = (async () => { await engine.loadArch(name, await tableBytes(name)); })();
    tables.set(name, p);
    p.catch(() => tables.delete(name));
  }
  return p;
}

const spawnWorker = () => new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });

// WebAssembly memory never shrinks: after a huge block (20,000 `div rcx`: 2.6 GB) the analyzer's worker would keep it
// until the page is reloaded. After a run, a worker with more than this is replaced by a new one with only the tables
// of the CPUs shown (WorkerEngine.recycle), as the API server does; once nothing else waits on it (the views below the
// result also use it). The pool does the same for its workers (pool.js).
const ENGINE_MEMORY_LIMIT = 512 * 2 ** 20;
let memoryTimer = 0;
function checkMemory(delay = 0) {
  if (!(engine instanceof WorkerEngine)) return;
  clearTimeout(memoryTimer);
  memoryTimer = setTimeout(async () => {
    let bytes = 0;
    try { bytes = await engine.memory(); } catch { return; }
    if (bytes <= ENGINE_MEMORY_LIMIT) return;
    if (busy || assembling || engine.pending > 0) { checkMemory(500); return; } // later, when nothing waits on it
    const shown = lastView?.ab ? [lastView.ab.a?.archKey, lastView.ab.b?.archKey] : [lastView?.archKey];
    const keep = [...new Set([state.arch, ...shown].map((k) => archItems.get(k)?.table).filter(Boolean))];
    engine.recycle(keep);
    for (const name of [...tables.keys()]) if (!keep.includes(name)) tables.delete(name); // loaded again when needed
    engine.memory().catch(() => {}); // the new worker starts now, not with the next run
  }, delay);
}
const spawnAsmWorker = () => new Worker(new URL('./assembler-worker.js', import.meta.url), { type: 'module' });

// The worker pool, or null: none in mock mode, with ?pool=0, or when the analyzer runs on the page's thread. Making it
// starts no worker yet; the pool starts them when jobs come in.
function getPool() {
  if (pool || !ready || POOL_SIZE === 0 || !wasmModule || !(engine instanceof WorkerEngine)) return pool;
  pool = createPool({
    size: POOL_SIZE,
    maxTables: tableCap(new Set([...archItems.values()].map((i) => i.table)).size, POOL_SIZE),
    tableOf: (arch) => archItems.get(arch)?.table ?? arch,
    tableBytes,
    async spawn() {
      const e = await WorkerEngine.create(wasmModule, spawnWorker);
      await e.loadUarch(uarchBytes);
      return e;
    },
  });
  window.__wuicaPool = pool; // for the tests (tests-js/web_pool_browser.mjs)
  return pool;
}

// ---- analysis ------------------------------------------------------------------------------------------------------

function nextFrame() { // lets the busy state paint before the (synchronous) analysis blocks the thread
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 100); // a hidden tab gets no animation frames
    requestAnimationFrame(() => { clearTimeout(t); setTimeout(resolve, 0); });
  });
}

// The trace panel (trace.js) goes below the result, full width.
function showTrace(panel) {
  el.traceSlot.hidden = !panel;
  if (!panel) { el.traceSlot.replaceChildren(); return; }
  if (el.traceSlot.querySelector('.field')?.firstChild !== panel) el.traceSlot.replaceChildren(...row('trace', panel).childNodes);
}

function draw() {
  if (!lastView) { showTrace(null); return; }
  if (lastView.ab) {
    ab.draw(lastView.ab);
    abTracePanel.setOpen(state.trace);
    showTrace(abTracePanel.update(lastView.ab));
    // the page's views show one side (abSide; the other if it has no result)
    const sv = abView();
    const root = sv && ab.sideRoot(sv.side);
    if (root) views.decorate(root, sv);
    paintStale({ drawn: true });
    return;
  }
  tracePanel.setOpen(state.trace); // (opened or closed in A–B mode meanwhile)
  const trace = lastView.response && !lastView.response.error && Array.isArray(lastView.response.rows) ? tracePanel.update(lastView) : null;
  const onUi = (k, v) => { ui[k] = v; if (k === 'hideEmpty' || k === 'allRows') draw(); };
  renderResult(el.body, { ...lastView, ui, onUi });
  showTrace(trace);
  insight.decorate(el.body, lastView);
  traceLink.decorate(el.body, lastView, { onUi });
  views.decorate(el.body, lastView);
  paintStale();
}

async function machineCode(id) {
  const text = el.code.value;
  pastedSource = null; regionChip.show(null); regionA = null;
  if (state.mode === 'hex') {
    const p = parseHexInput(text);
    if (!p.ok) {
      showMessages([{ line: p.line ?? null, column: null, severity: 'error', message: p.message }]);
      return null;
    }
    if (p.bytes.length > MAX_CODE_BYTES) { // as for assembly: more than the analyzer can simulate in its memory
      showMessages([{ line: null, column: null, severity: 'error', message: tooMuchCode(p.bytes.length) }]);
      return null;
    }
    clearMessages();
    return p.bytes;
  }
  if (text.trim() === '') {
    showMessages([{ line: null, column: null, severity: 'error', message: 'No code' }]);
    return null;
  }
  const assembler = await ensureAssembler();
  if (id !== runSeq) return null;
  if (!assembler) { showAssemblerMissing(); paintDerived(); return null; }
  let r;
  try {
    r = await assembler.assemble(text, state.syntax, { signal: assembling?.signal });
  } catch (e) {
    if (e?.name === 'CancelledError') return null; // replaced by a newer run, an edit, or Cancel
    throw e;
  }
  if (id !== runSeq) return null;
  // what it assembled to is the result's objdump listing
  const items = [...r.diagnostics];
  if (r.ok && r.bytes.length === 0) items.push({ line: null, column: null, severity: 'error', message: 'No machine code' });
  if (r.ok && r.bytes.length && assembler.mock) items.push({ line: null, column: null, severity: 'note', message: 'mock assembler' });
  if (items.length) showMessages(items); else clearMessages();
  if (r.ok && r.bytes.length) { regionChip.show(r.region ?? null, text); pastedSource = r.source ? { ...r.source, hex: toHex(r.bytes) } : null; regionA = r.region ?? null; }
  return r.ok && r.bytes.length ? r.bytes : null;
}

let busySince = 0;
let busyPaint = 0;
function setBusy(on, { defer = false } = {}) {
  busy = on;
  if (on) busySince = performance.now();
  clearTimeout(busyPaint);
  if (on && defer) busyPaint = setTimeout(() => paintBusy(true), 150);
  else paintBusy(on);
}
function paintBusy(on) {
  if (on) el.results.setAttribute('aria-busy', 'true'); else el.results.removeAttribute('aria-busy');
  // While an analysis runs, the button stops it (if the engine can be stopped).
  el.run.textContent = on ? (engine.capabilities.cancel ? 'Cancel' : 'Analyzing…') : 'Analyze';
  el.run.classList.toggle('busy', on);
}

// Stops the assembly of the current run (it ends without a result; the assembler's worker is replaced if it was busy).
function stopAssembly() {
  const c = assembling;
  assembling = null;
  c?.abort();
}

function cancelRun() {
  if (!busy) return;
  cancelledKey = inflight.key;
  runSeq++; // whatever the stopped run still does is ignored
  if (assembling) stopAssembly(); else engine.cancel?.();
  setBusy(false);
  flash('cancelled');
}

// auto: a live run (liveRunner). It is skipped if its input is the one shown, running or cancelled; it keeps the
// messages until it has new ones, and it does not stop a running analysis unless that one takes long.
async function run({ auto = false } = {}) {
  clearTimeout(rerunTimer);
  if (!auto) { liveRunner.cancel(); cancelledKey = ''; settleMode(); }
  if (!ready || el.run.disabled) return;
  if (ce?.linkBox()) return; // a box that holds only a Compiler Explorer link is imported (analyze()), never analyzed
  const key = runKey();
  const messages = !!el.messages.firstChild || !!ab?.hasMessages();
  if (auto && ((busy && key === inflight.key) || key === cancelledKey || (lastView && key === lastRunKey && !messages))) return;
  // a newer request replaces the one that is running (an assembly is always stopped: its input is out of date)
  if (assembling) stopAssembly();
  else if (busy && (!auto || performance.now() - busySince > LONG_RUN_MS)) engine.cancel?.();
  const id = ++runSeq;
  if (!auto) clearMessages();
  const ctrl = new AbortController();
  assembling = ctrl;
  if (ab?.active()) { await runCompare(id, key, { auto, ctrl }); return; } // awaited: live mode runs one comparison at a time
  const archKey = state.arch;
  const opts = options();
  const item = archItems.get(archKey);
  const text0 = el.code.value; // (the label of the block's start, for its branch targets)
  let bytes;
  inflight = { id, key };
  if (state.mode === 'asm') setBusy(true, { defer: true }); // a long assembly can be cancelled
  try {
    bytes = await machineCode(id);
  } catch (e) {
    if (id === runSeq) showMessages([{ line: null, column: null, severity: 'error', message: `The assembler failed: ${e?.message ?? e}` }]);
    bytes = null;
  } finally {
    if (assembling === ctrl) assembling = null;
  }
  if (!bytes || id !== runSeq) {
    if (inflight.id === id) inflight = { id: 0, key: '' };
    if (id === runSeq && busy) setBusy(false);
    return;
  }
  const hex = toHex(bytes);

  setBusy(true, { defer: auto });
  inflight = { id, key };
  try {
    await ensureTable(archKey);
    if (!auto || !engine.capabilities.cancel) await nextFrame();
    if (id !== runSeq) return;
    const t0 = performance.now();
    const request = makeRequest(hex, archKey, opts);
    const response = await engine.analyze(request);
    const elapsedMs = performance.now() - t0;
    if (id !== runSeq) return;
    // the status line tells the result of a run that was asked for, and of one for another CPU than the result shown
    // (a CPU was checked or picked: the status line must not keep the old CPU's time)
    const prevArch = lastView?.archKey;
    const tell = !auto || (prevArch !== undefined && prevArch !== archKey);
    lastView = {
      response, request, elapsedMs, hex, byteCount: bytes.length, inputMode: state.mode,
      archKey, archTitle: archTitle(archKey, item.experimental), experimental: item.experimental,
      shown: response && !response.error && Array.isArray(response.rows) ? branchLabels(response.rows, blockLabel('a', text0) ?? 'loop') : null,
    };
    lastRunKey = key;
    draw();
    if (response && !response.error) {
      // the time is shown here (not in the result): how fast the analyzer is
      // with several CPUs checked, their number: the table has the others (the time is this CPU's)
      const n = checked.length > 1 && !state.ab ? ` · ${checked.length} CPUs` : '';
      if (tell) flash(`${Number(response.tp).toFixed(2)} cycles/iteration · ${archKey}${n}${response.mock ? ' (mock data)' : ` · ${elapsedMs < 10 ? elapsedMs.toFixed(1) : Math.round(elapsedMs)} ms`}`, { ms: 6000 });
      panels.update({ hex, arch: archKey, options: opts, elapsedMs, response }, { auto });
      if (!warmedUp && engine.warmUp) { warmedUp = true; setTimeout(() => engine.warmUp(archKey), 0); }
    } else if (tell) {
      flash('analysis failed', { error: true });
    }
    syncUrl(true);
    prefetchTables();
    checkMemory();
  } catch (e) {
    if (id !== runSeq) return;
    lastView = null;
    showTrace(null);
    renderFailure(el.body, `Analysis failed: ${e?.message ?? e}`);
  } finally {
    if (inflight.id === id) inflight = { id: 0, key: '' };
    if (id === runSeq) {
      setBusy(false);
      el.results.dataset.run = String(id); // the number of the run that is shown (tests wait for it)
    }
  }
}

// Analyze (button, Ctrl/⌘+Enter): a box that holds only a Compiler Explorer link is imported (the user's own
// action; nothing else on the page contacts godbolt.org), otherwise the input is analyzed.
function analyze() {
  const link = ready ? ce?.linkBox() : null;
  if (link) ce.start(link); else run();
}

// A–B mode: both sides, one after the other (ab.js gets the machine code and draws the comparison). auto: as in run().
async function runCompare(id, key, { auto = false, ctrl = null } = {}) {
  const current = () => id === runSeq;
  const opts = options();
  let input;
  inflight = { id, key };
  if (state.mode === 'asm' || state.bMode === 'asm') setBusy(true, { defer: true }); // a long assembly can be cancelled
  try {
    input = await ab.inputs(id, current);
  } catch (e) {
    if (current() && e?.name !== 'CancelledError') showMessages([{ line: null, column: null, severity: 'error', message: `The assembler failed: ${e?.message ?? e}` }]);
    input = null;
  } finally {
    if (assembling === ctrl) assembling = null;
  }
  if (!input || !current()) {
    if (inflight.id === id) inflight = { id: 0, key: '' };
    if (current() && busy) setBusy(false);
    return;
  }
  setBusy(true, { defer: auto });
  inflight = { id, key };
  try {
    await Promise.all([...new Set([input.a?.arch, input.b?.arch].filter(Boolean))].map(ensureTable));
    if (!auto || !engine.capabilities.cancel) await nextFrame();
    if (!current()) return;
    const view = await ab.analyze(input, (hex, arch) => engine.analyze(makeRequest(hex, arch, opts)), current);
    if (!view || !current()) return;
    for (const s of [view.a, view.b]) if (s) s.request = makeRequest(s.hex, s.archKey, opts); // for the traces
    lastView = { ab: view };
    lastRunKey = key;
    draw();
    updateABCpus(view, { auto });
    sweepSide({ auto });
    if (!auto) flash(ab.summary(view), { ms: 4000 });
    syncUrl(true);
    prefetchTables();
    checkMemory();
  } catch (e) {
    if (!current()) return;
    lastView = null;
    showTrace(null);
    renderFailure(el.body, `Comparison failed: ${e?.message ?? e}`);
  } finally {
    if (inflight.id === id) inflight = { id: 0, key: '' };
    if (current()) {
      setBusy(false);
      el.results.dataset.run = String(id);
    }
  }
}

// an edit of a code box that replaces its code rather than types in it (a paste, a drop, a cut)
const replaced = (e) => /^(insertFromPaste|insertFromDrop|insertReplacementText|deleteByCut|historyUndo|historyRedo)/.test(e?.inputType ?? '');
// A–B: the side the views show (the other one if it has no result)
const okSide = (s) => !!s?.response && !s.response.error && Array.isArray(s.response.rows);
function abView() {
  const v = lastView?.ab;
  if (!v) return null;
  const want = v[abSide], other = v[abSide === 'a' ? 'b' : 'a'];
  return okSide(want) ? want : okSide(other) ? other : null;
}
// the table of A and B per checked CPU (ab-cpus.js); the results of the comparison itself are reused
const summaryOf = (r) => ({ tp: Number(r.tp), bottlenecks: r.bottlenecks ?? [], mode: r.mode, decodeErrors: Number(r.decodeErrors) || 0, mock: !!r.mock });
function updateABCpus(view, { auto = false } = {}) {
  const seed = new Map();
  for (const s of [view.a, view.b]) if (okSide(s)) seed.set(`${s.side}:${s.archKey}`, summaryOf(s.response));
  abCpus.update({ a: view.a?.hex ?? null, b: view.b?.hex ?? null, options: options(), workA: view.workA, workB: view.workB, focus: state.arch, seed }, { auto });
}
// the sweep (compare-view.js) of the side the views show
function sweepSide({ auto = true } = {}) {
  const sv = abView();
  if (sv) panels.update({ hex: sv.hex, arch: sv.archKey, options: options(), elapsedMs: sv.elapsedMs, response: sv.response }, { auto });
}
// the label of a block's start in the code of side s (assembly), for its branch targets; null for machine code
// region: the marked region the block is (asm-regions.js), or null: then the label in front of the region's code
function blockLabel(s, text, region = s === 'a' ? regionA : null) {
  const asm = s === 'b' ? state.bMode === 'asm' : state.mode === 'asm';
  const t = text ?? (s === 'b' ? ab?.getB().text : el.code.value);
  if (!asm) return null;
  return startLabel(region?.line ? t.split('\n').slice(region.line).join('\n') : t);
}
let regionA = null; // the marked region of side A's last assembly (a block's start label is the region's)
document.addEventListener('wuica:ab-side', (e) => {
  const s = e.detail === 'b' ? 'b' : 'a';
  if (s === abSide) return;
  abSide = s;
  document.body.dataset.abSide = s;
  if (lastView?.ab) { draw(); sweepSide({ auto: false }); }
});
document.body.dataset.abSide = abSide;

// Puts code into the page's editor (side A), e.g. from Compiler Explorer or a swap.
function importCode({ mode, syntax, text }, { run: andRun = true } = {}) {
  if (mode === 'asm' || mode === 'hex') setMode(mode);
  if (syntax === 'intel' || syntax === 'att') state.syntax = syntax;
  el.code.value = buffers[state.mode] = text;
  clearMessages();
  writeControls();
  changed({ now: true });
  return andRun && ready ? run() : null;
}

// ---- hex <-> asm (asm-text.js): machine code that comes in (an import) becomes assembly of exactly those bytes, and
// a click on asm / hex converts the code, unless the box's text for that format already is the same machine code.
let decoderPromise = null;
const converter = createConverter({
  // the decoder in an instance of its own on this thread (the analyzer's worker can be busy, or be stopped)
  decoder: () => (decoderPromise ??= wasmModule ? WasmEngine.create(wasmModule).catch(() => { decoderPromise = null; return null; })
    : Promise.resolve(engine instanceof WasmEngine ? engine : null)),
  assembler: () => ensureAssembler(),
});
// The shown result stays current through a change of the text that keeps the machine code (the conversion checked it).
function keepResult(apply) {
  const current = !!lastView && lastRunKey === runKey();
  apply();
  if (current) { lastRunKey = runKey(); paintStale(); }
}
const switching = { A: 0, B: 0 };
let switchingFrom = null; // side A: the box's text when asm / hex was clicked, while that conversion runs
// A click on asm / hex (side A) whose conversion is still running, when an action needs the format now (Analyze, an
// example): the clicked format is taken at once, without the conversion. Text put into the box after the click is in
// the clicked format; otherwise (or when the action replaces the code) the format's own text is used.
function settleMode({ replacing = false } = {}) {
  const clicked = el.modeAsm.checked ? 'asm' : 'hex';
  if (clicked === state.mode) return;
  switching.A++;
  el.code.readOnly = false;
  const text = el.code.value;
  setMode(clicked, !replacing && switchingFrom !== null && text !== switchingFrom ? { text } : null);
  switchingFrom = null;
}
// side A or B, the new format, the box's text for it, apply(converted | null): the switch
async function switchMode(side, mode, other, apply) {
  const box = side === 'B' ? $('code-b') : el.code;
  const radio = side === 'B' ? $('b-mode-asm') : el.modeAsm;
  const get = () => (side === 'B' ? ab.getB() : { mode: state.mode, syntax: state.syntax, text: el.code.value });
  const before = get();
  const seq = ++switching[side];
  box.readOnly = false;
  if (!ready || before.text.trim() === '' || ce?.isLink(before.text)) { apply(null); return; }
  box.readOnly = true;
  if (side === 'A') switchingFrom = before.text;
  let c = null;
  try { c = await converter.convert(before, mode, other); } catch { c = null; } finally { if (seq === switching[side]) box.readOnly = false; }
  const now = get();
  if (seq !== switching[side] || now.mode !== before.mode || radio.checked !== (mode === 'asm')) return; // clicked again, settled, or an import
  if (side === 'A') switchingFrom = null;
  // The box was read-only, so new text came from the page (an example, a set value) after the click: it is in the
  // clicked format, which wins
  if (now.text !== before.text) { apply({ text: now.text }); return; }
  if (c) keepResult(() => apply(c.same ? null : c)); else apply(null); // the result is kept only for the same machine code
  if (c) ab?.settleCode(side === 'B' ? 'b' : 'a'); // (and the elements per iteration stay right for it)
}
// After an import of machine code, and its analysis: the box gets the assembly, if the box still has the import.
// The source lines of the last Compiler Explorer import into A (srcmap.js), bound to the bytes of its first analysis.
let ceSource = null;
async function ceSourceOf(source, analysis) {
  if (ceSource) { ceSource = null; views.refreshSource(); } // undo, or another import
  if (!source || !analysis) return;
  await analysis;
  if (!lastView?.hex || lastRunKey !== runKey()) return; // another run or an edit meanwhile
  ceSource = { ...source, hex: lastView.hex };
  views.refreshSource();
}

async function importAsAsm(side, text, analysis) {
  const box = () => (side === 'B' ? ab.getB() : { mode: state.mode, text: el.code.value });
  const unchanged = () => box().mode === 'hex' && box().text === text;
  const p = parseHexInput(text);
  if (!p.ok) return;
  await analysis;
  const c = ready && unchanged() ? await converter.fromBytes(p.bytes).catch(() => null) : null;
  if (!c || !unchanged()) return; // undo, an edit or another import meanwhile
  keepResult(() => { if (side === 'B') { ab.setB(c); writeControls(); changed(); } else importCode(c, { run: false }); });
}

function setupFeatures() {
  ce = createCeImport({
    sides: () => (state.ab ? ['A', 'B'] : ['A']),
    getCode: (side) => (side === 'B' ? ab.getB() : { mode: state.mode, syntax: state.syntax, text: el.code.value }),
    importInto(side, code, { alignment = null, undo = false, source = null } = {}) {
      if (alignment !== null) state.alignmentOffset = alignment;
      let analysis = null;
      if (side === 'B') { ab.setB(code); writeControls(); if (ready && !undo) analysis = run(); } else { analysis = importCode(code, { run: !undo }); if (state.ab) ab.replacedA(); }
      if (side === 'A') ceSourceOf(source, analysis);
      if (!undo && code.mode === 'hex') importAsAsm(side, code.text, analysis);
    },
  });
  const abSlots = createABSlots({ engine: () => engine, options });
  ab = createAB({
    replaced,
    drawn: (body, view) => abSlots.decorate(body, view),
    cpusBox: abCpus.box, redraw: () => { if (lastView?.ab) { draw(); updateABCpus(lastView.ab, { auto: true }); } },
    labels: (s, region) => blockLabel(s, undefined, region),
    state, el: { code: el.code, body: el.body, toolbar: el.toolbar }, archItems: () => archItems, archTitle, ensureAssembler: assemblerForRun, ensureTable,
    machineCodeA: machineCode, changed, writeControls,
    getA: () => ({ mode: state.mode, syntax: state.syntax, text: el.code.value }),
    setA: importCode,
    // A–B with the default example (or nothing) in A: the demo pair, one dot-product accumulator vs four
    demo() {
      const a = el.code.value.trim();
      if (a !== '' && !Object.values(EXAMPLES[0].text).some((t) => t.trim() === a)) return null;
      const [d1, d4] = ['dot1', 'dot4'].map((id) => CLASSIC_EXAMPLES.find((e) => e.id === id));
      return { a: exampleCode(d1), b: exampleCode(d4) };
    },
    toggled() { // single <-> A–B
      lastView = null;
      abCpus.clear();
      showTrace(null);
      paintCpus();
      panels.refreshCpus();
      changed();
      if (ready && !el.run.disabled && el.code.value.trim() !== '') run();
      else renderEmpty(el.body);
    },
    watchLinks: (textarea, side, messages) => ce.watch(textarea, side, messages),
    switchMode: (mode, other, apply) => switchMode('B', mode, other, apply),
  });
  ce.watch(el.code, 'A', el.messages);
}

// ---- offline: service worker and background caching ------------------------------------------------------------------

const swUsable = () => 'serviceWorker' in navigator && !NO_SW && manifest.version !== 'dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function registerServiceWorker() {
  if (!swUsable()) return;
  const hadController = !!navigator.serviceWorker.controller;
  for (const type of ['keydown', 'input', 'change']) document.addEventListener(type, () => { lastInput = performance.now(); }, { capture: true, passive: true });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) updated(); // a new deploy took over while this page was open
  });
  try {
    await navigator.serviceWorker.register('sw.js');
  } catch { /* the page works without it, just not offline */ }
}

// A new deploy: its service worker takes over at once (skipWaiting and clients.claim in sw.js), but this page is still
// the old build, served from the old cache. It reloads itself, when that loses nothing: once the analyzer is ready and
// idle (no analysis running, nothing on the pool) and nothing was typed for UPDATE_QUIET_MS, after writing the state
// into the URL fragment. At most once per build (sessionStorage), so a reload that comes back to the old build cannot
// loop. If that cannot be ensured (no session storage, the fragment could not be written, already reloaded for this
// build), the note in the footer stays: reload by hand.
const UPDATE_KEY = 'wuica-update-reload';
const UPDATE_QUIET_MS = 1200;
let lastInput = 0;     // performance.now() of the last keystroke or change
let updating = false;

async function updated() {
  if (updating) return;
  updating = true;
  el.updateNote.hidden = false;
  let next = null; // the new build's version: its worker answers from its own cache
  try { next = (await (await fetch('manifest.json', { cache: 'no-store' })).json())?.version ?? null; } catch { /* unknown */ }
  if (next === manifest.version) { el.updateNote.hidden = true; updating = false; return; } // the same build again
  const mark = typeof next === 'string' ? next : `after ${manifest.version}`;
  try { if (sessionStorage.getItem(UPDATE_KEY) === mark) return; } catch { return; }
  while (!ready || busy || pool?.busy || performance.now() - lastInput < UPDATE_QUIET_MS) await sleep(250);
  syncUrl(true);
  if (location.hash.replace(/^#/, '') !== lastFragment) return; // the address does not hold the state
  try {
    sessionStorage.setItem(UPDATE_KEY, mark);
    if (sessionStorage.getItem(UPDATE_KEY) !== mark) return;
  } catch { return; }
  location.reload();
}

// After the first result: fetch the remaining instruction tables when the browser is idle, so that switching the
// microarchitecture is instant and the page works offline. This only fills the caches; a table is loaded into
// the analyzer when its microarchitecture is selected.
async function prefetchTables() {
  if (prefetchStarted) return;
  prefetchStarted = true;
  if (navigator.connection?.saveData) { setIdle('ready'); return; }
  let controlled = false;
  if (swUsable()) {
    await Promise.race([navigator.serviceWorker.ready.catch(() => null), sleep(8000)]);
    if (!navigator.serviceWorker.controller) {
      await Promise.race([new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })), sleep(3000)]);
    }
    controlled = !!navigator.serviceWorker.controller;
  }
  // the tables, and the assembler if the build has one (so that assembly mode also works offline)
  const urls = [...new Set([...archItems.values()].map((i) => i.table))].map(PATHS.table);
  if (manifest.assembler && controlled) urls.push(PATHS.assembler);
  let done = 0;
  for (const url of urls) {
    await new Promise(whenIdle);
    try {
      const cached = controlled && 'caches' in window && await caches.match(url, { ignoreSearch: true });
      if (!cached) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.arrayBuffer();
      }
      done++;
    } catch {
      break; // offline or a failing host: stop quietly
    }
    setIdle(`ready · caching ${done}/${urls.length}`);
  }
  setIdle(done === urls.length && controlled ? 'ready · works offline' : 'ready');
}

// ---- start -------------------------------------------------------------------------------------------------------------

function restore(fragment) {
  const s = decodeState(fragment);
  if (!s) return false;
  Object.assign(state, s);
  buffers.hex = buffers.asm = '';
  buffers[state.mode] = s.text;
  delete state.text;
  return true;
}

function showNotice(...paragraphs) {
  el.notice.replaceChildren(...paragraphs.map((t) => h('p', { text: t })));
  el.notice.hidden = false;
}

function bind() {
  el.modeAsm.addEventListener('change', () => switchMode('A', 'asm', buffers.asm, (c) => setMode('asm', c)));
  el.modeHex.addEventListener('change', () => switchMode('A', 'hex', buffers.hex, (c) => setMode('hex', c)));
  el.syntax.addEventListener('change', () => {
    const old = state.syntax;
    state.syntax = el.syntax.value === 'att' ? 'att' : 'intel';
    // an untouched example follows the syntax
    const ex = ALL_EXAMPLES.find((e) => e.text[old] === el.code.value);
    if (ex && state.mode === 'asm') el.code.value = buffers.asm = ex.text[state.syntax];
    changed();
  });
  el.examples.addEventListener('change', () => {
    const ex = ALL_EXAMPLES.find((e) => e.id === el.examples.value);
    el.examples.value = '';
    if (ex) loadExample(ex);
  });
  el.code.addEventListener('input', (e) => { buffers[state.mode] = el.code.value; changed({ now: replaced(e) }); });
  el.cpuGrid.addEventListener('change', cpusChanged);
  el.cpuAll.addEventListener('click', () => { setChecked([...archItems.keys()]); paintDerived(); syncUrl(true); });
  el.cpuClear.addEventListener('click', () => { setChecked([state.arch]); paintDerived(); syncUrl(true); });
  // phones: only the checked CPUs show (dense.css); "more" shows them all
  $('cpu-more')?.addEventListener('click', (e) => {
    const open = el.cpus.classList.toggle('open');
    e.currentTarget.textContent = open ? 'less' : 'more';
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
  // the options popover: Escape or a click elsewhere closes it
  el.advanced.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.advanced.open) { el.advanced.open = false; el.advanced.querySelector('summary').focus(); }
  });
  // (a popover only: on phones the options are in the flow, and closing them would move what is being tapped)
  const popBody = el.advanced.querySelector('.pop-body');
  document.addEventListener('pointerdown', (e) => {
    if (el.advanced.open && !el.advanced.contains(e.target) && getComputedStyle(popBody).position === 'absolute') el.advanced.open = false;
  });
  const int = (input, name) => input.addEventListener('change', () => {
    state[name] = clampInt(input.value, LIMITS[name], DEFAULT_STATE[name]);
    input.value = state[name];
    changed({ rerun: true });
  });
  int(el.align, 'alignmentOffset');
  int(el.iter, 'minIterations');
  int(el.cycles, 'minCycles');
  for (const r of document.querySelectorAll('input[name="init"]')) {
    r.addEventListener('change', () => { if (r.checked) { state.initPolicy = r.value; changed({ rerun: true }); } });
  }
  const flag = (input, name) => input.addEventListener('change', () => { state[name] = input.checked; changed({ rerun: true }); });
  flag(el.sfe, 'simpleFrontEnd');
  flag(el.nmi, 'noMicroFusion');
  flag(el.nma, 'noMacroFusion');
  el.reset.addEventListener('click', () => {
    for (const k of ['alignmentOffset', 'initPolicy', 'simpleFrontEnd', 'noMicroFusion', 'noMacroFusion', 'minIterations', 'minCycles']) state[k] = DEFAULT_STATE[k];
    writeControls();
    changed({ rerun: true });
  });
  el.run.addEventListener('click', () => (busy && el.run.classList.contains('busy') ? cancelRun() : analyze()));
  el.live.addEventListener('change', () => setLive(el.live.checked));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!busy) analyze(); }
  });
  el.copy.addEventListener('click', copyLink);
  el.reload.addEventListener('click', () => location.reload());
  window.addEventListener('hashchange', () => {
    const frag = location.hash.replace(/^#/, '');
    if (frag === lastFragment) return; // our own update
    if (!frag.startsWith('v=')) { syncUrl(true); return; } // an in-page anchor: keep the state in the address bar

    if (restore(frag)) {
      lastFragment = frag;
      readCpus();
      panels.refreshCpus();
      clearMessages();
      writeControls();
      ab?.settleCode('a'); ab?.settleCode('b'); // (the link's counts are for its code)
      if (state.mode === 'asm') ensureAssembler().then(() => paintDerived());
      if (el.code.value.trim() !== '') run();
    }
  });
}

async function copyLink() {
  syncUrl(true);
  const ok = await copyText(location.href);
  el.copy.textContent = ok ? 'Copied' : 'Copy link';
  flash(ok ? 'link copied' : 'copy failed: use the address bar', { error: !ok });
  if (ok) setTimeout(() => { el.copy.textContent = 'Copy link'; }, 1500);
}

async function start() {
  const hadState = restore(location.hash);
  if (hadState) {
    lastFragment = location.hash.replace(/^#/, '');
  } else {
    buffers.hex = EXAMPLES[0].text.hex;
    buffers.asm = EXAMPLES[0].text.intel;
  }
  $('app-version').textContent = VERSION;
  el.live.checked = liveOn;
  el.results.classList.toggle('live', liveOn);
  writeControls();
  fillExamples();
  bind();
  createKeys({ button: $('keys-btn') });
  setupFeatures();

  manifest = await fetchManifest();
  el.buildId.textContent = manifest.version;
  registerServiceWorker();
  // the assembler loads while the analyzer does: the first result in asm mode needs both
  if (state.mode === 'asm') ensureAssembler();

  try {
    const wasmBytes = MOCK ? null : download('analyzer', PATHS.wasm);
    wasmBytes?.catch(() => {}); // reported below
    uarchBytes = await download('configurations', PATHS.uarch);
    uarch = JSON.parse(new TextDecoder().decode(uarchBytes));
    fillArchs();
    writeControls();

    if (MOCK) {
      const { MockEngine } = await import('./engine-mock.js');
      engine = new MockEngine();
      showNotice('Mock mode: recorded results, no analyzer.');
      fillExamples();
    } else {
      let bytes;
      try { bytes = await wasmBytes; } catch (e) { throw new Error(`the analyzer could not be loaded (${e?.message ?? e})`); }
      if (!isWasm(bytes)) throw new Error('the analyzer could not be loaded (wuica_wasm.wasm is not a WebAssembly module)');
      wasmModule = await WebAssembly.compile(bytes);
      try {
        engine = await WorkerEngine.create(wasmModule, spawnWorker);
      } catch {
        engine = await WasmEngine.create(wasmModule); // no module workers here: run it on the page's own thread
      }
      if (!engine.capabilities.analyze) throw new Error('this build of the analyzer has no simulator (wuica_analyze is missing)');
    }
    await engine.loadUarch(uarchBytes);
    await ensureTable(state.arch);
  } catch (e) {
    setIdle('not ready');
    el.statusWrap.classList.add('error');
    renderFailure(el.body, `Could not start: ${e?.message ?? e}. Reload to retry.`);
    return;
  }

  ready = true;
  setIdle('ready');
  if (state.mode === 'asm') {
    const a = await ensureAssembler();
    if (!a) showAssemblerMissing();
  }
  paintDerived();
  if (hadState && el.code.value.trim() !== '' && !el.run.disabled) run();
  else if (liveOn && touched && el.code.value.trim() !== '' && !el.run.disabled) run({ auto: true });
  else {
    renderEmpty(el.body);
    if (!hadState && !touched) autoFirst(); // a fresh visit: the default example
  }
}

// A fresh visit (no state in the link, nothing typed): the default example is analyzed once, after the next frame
// (the analysis runs in the worker; a key press meanwhile goes first, and live mode or Analyze replace this run). The
// address stays without a fragment while nothing was changed.
function autoFirst() {
  const go = async () => {
    if (lastView || busy || touched || el.code.value.trim() === '' || el.run.disabled) return;
    const pristine = encodeState(collectState());
    await run({ auto: true });
    if (encodeState(collectState()) !== pristine || location.hash.replace(/^#/, '') !== lastFragment) return;
    clearTimeout(syncTimer);
    lastFragment = '';
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* kept */ }
  };
  requestAnimationFrame(() => setTimeout(go, 0));
}

start();
