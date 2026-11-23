// The page: wires the controls to the engine (the analyzer in a worker, engine-rpc.js; with ?mock=1 the mock,
// engine-mock.js), the hex parser, the assembler adapter, the URL state and the result view.

import { WasmEngine, makeRequest } from './engine.js';
import { WorkerEngine } from './engine-rpc.js';
import { parseHexInput, toHex } from './hex-input.js';
import { archGroups, archTitle, DEFAULT_ARCH } from './archs.js';
import { DEFAULT_STATE, LIMITS, encodeState, decodeState, clampInt } from './url-state.js';
import { EXAMPLES, MOCK_EXAMPLES } from './examples.js';
import { fetchBytes, fetchManifest, PATHS, formatSize, whenIdle } from './loader.js';
import { WasmAssembler, isWasm } from './assembler.js';
import { renderResult, renderEmpty, renderFailure, h } from './render.js';
import { createAB } from './ab.js';                 // A–B comparison
import { createCeImport } from './godbolt-ui.js';   // import from Compiler Explorer

const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const MOCK = query.get('mock') === '1';       // ?mock=1: do not load the analyzer, use the mock (for work on the page)
const NO_SW = query.get('nosw') === '1';      // ?nosw=1: do not register the service worker

const el = {
  notice: $('notice'), code: $('code'), codeHint: $('code-hint'), messages: $('input-messages'),
  modeAsm: $('mode-asm'), modeHex: $('mode-hex'), syntax: $('syntax'), syntaxWrap: $('syntax-wrap'),
  examples: $('examples'), arch: $('arch'), archHint: $('arch-hint'),
  advanced: $('advanced'), advancedSummary: $('advanced-summary'),
  align: $('opt-align'), sfe: $('opt-sfe'), nmi: $('opt-nmi'), nma: $('opt-nma'), iter: $('opt-iter'), cycles: $('opt-cycles'),
  reset: $('opt-reset'), run: $('run'), copy: $('copy-link'),
  status: $('status'), statusWrap: $('status-wrap'), statusBar: $('status-bar'),
  results: $('results'), body: $('result-body'), buildId: $('build-id'), updateNote: $('update-note'), reload: $('reload'),
};

const HINTS = {
  hex: 'Hex in any common form: 4801d8, 48 01 d8, 0x48, \\x48, or pasted objdump -d / Compiler Explorer output (only the byte column is used).',
  asm: 'x86-64 assembly; labels and directives work. The block is assembled in your browser.',
};
const PLACEHOLDERS = {
  hex: '48 83 c0 01 49 ff cf 75 f7',
  asm: 'loop:\n  add rax, 1\n  dec r15\n  jnz loop',
};

// ---- state ---------------------------------------------------------------------------------------------------

const state = { ...DEFAULT_STATE };
const buffers = { hex: '', asm: '' }; // the text of each input mode; the text area shows buffers[state.mode]
const ui = { hideEmpty: true, reportOpen: false };

let manifest = { version: 'dev', files: {}, tables: [], assembler: null };
let uarch = null;
let archItems = new Map(); // key -> {key, title, table, chip, experimental}
let engine = null;
let ready = false;
let runSeq = 0;
let busy = false;
let lastView = null;
let lastRunKey = '';
let lastFragment = null;
const tables = new Map(); // table name -> promise of "loaded into the engine"
let assemblerPromise = null;
let assemblerMissing = false; // true: this build has no assembler (final); a failed load of an existing one is not
let assemblerError = '';
let prefetchStarted = false;
let ab = null; // the A–B comparison (ab.js); in A–B mode lastView is {ab: view}
let ce = null; // the Compiler Explorer import (godbolt-ui.js)

// ---- status line and progress ----------------------------------------------------------------------------------

const downloads = new Map(); // label -> {got, total}
let idleStatus = 'starting…';
let flashTimer = 0;

function paintStatus() {
  if (flashTimer) return;
  el.statusWrap.classList.remove('error');
  if (downloads.size) {
    let got = 0, total = 0;
    for (const d of downloads.values()) { got += d.got; total += Math.max(d.total, d.got); }
    const names = [...downloads.keys()].join(', ');
    el.status.textContent = `loading ${names} · ${formatSize(got)}${total > got ? ' / ' + formatSize(total) : ''}`;
    el.statusBar.style.width = total ? `${Math.min(100, (100 * got) / total).toFixed(1)}%` : '0';
  } else {
    el.status.textContent = idleStatus;
    el.statusBar.style.width = '0';
  }
}
function setIdle(text) { idleStatus = text; paintStatus(); }
function flash(text, { error = false, ms = 2500 } = {}) {
  clearTimeout(flashTimer);
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
  if (archItems.has(state.arch)) el.arch.value = state.arch;
  el.align.value = state.alignmentOffset;
  for (const r of document.querySelectorAll('input[name="init"]')) r.checked = r.value === state.initPolicy;
  el.sfe.checked = state.simpleFrontEnd;
  el.nmi.checked = state.noMicroFusion;
  el.nma.checked = state.noMacroFusion;
  el.iter.value = state.minIterations;
  el.cycles.value = state.minCycles;
  paintDerived();
  ab?.paint();
}

function paintDerived() {
  const changed = ['alignmentOffset', 'initPolicy', 'simpleFrontEnd', 'noMicroFusion', 'noMacroFusion', 'minIterations', 'minCycles']
    .filter((k) => state[k] !== DEFAULT_STATE[k]).length;
  el.advancedSummary.textContent = changed ? `· ${changed} changed` : '';
  const item = archItems.get(state.arch);
  el.archHint.textContent = item?.experimental ? 'experimental model' : '';
  el.archHint.classList.toggle('caveat', !!item?.experimental);
  el.run.disabled = !ready || (state.mode === 'asm' && assemblerMissing);
  paintStale();
}

function runKey() {
  return JSON.stringify([state.mode, state.mode === 'asm' ? state.syntax : '', el.code.value, state.arch, options(), ab?.key() ?? '']);
}
function paintStale() {
  el.body.classList.toggle('stale', !!lastView && runKey() !== lastRunKey);
}

function collectState() {
  return { ...state, text: el.code.value };
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

function changed({ rerun = false } = {}) {
  paintDerived();
  syncUrl();
  if (rerun && lastView && ready) scheduleRun();
}
let rerunTimer = 0;
function scheduleRun() {
  clearTimeout(rerunTimer);
  rerunTimer = setTimeout(run, 120);
}

// ---- messages next to the input ---------------------------------------------------------------------------------

function clearMessages() {
  el.messages.replaceChildren();
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
  if (items.some((d) => d.severity === 'error')) el.code.setAttribute('aria-invalid', 'true');
}

function showAssemblerMissing() {
  const b = h('button', { type: 'button', class: 'plain', text: 'switch to machine code (hex)' });
  b.addEventListener('click', () => setMode('hex'));
  const why = assemblerMissing ? 'Assembly input is not available in this build yet.'
    : `The assembler could not be loaded (${assemblerError || 'unknown error'}); Analyze tries again.`;
  el.messages.replaceChildren(h('ul', null, h('li', null, `${why} You can `, b, '.')));
}

// ---- input modes -------------------------------------------------------------------------------------------------

function setMode(mode) {
  if (mode === state.mode) return;
  buffers[state.mode] = el.code.value;
  state.mode = mode;
  clearMessages();
  writeControls();
  if (mode === 'asm') {
    ensureAssembler().then((a) => { if (!a && state.mode === 'asm') showAssemblerMissing(); paintDerived(); });
  }
  changed();
}

function ensureAssembler() {
  assemblerPromise ??= (async () => {
    if (manifest.assembler !== false) { // false: build.sh found no module, so do not even ask for it
      try {
        const bytes = await download('assembler', PATHS.assembler);
        if (isWasm(bytes)) return await WasmAssembler.create(bytes);
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
  })();
  return assemblerPromise;
}

function loadExample(ex) {
  const key = state.mode === 'asm' ? state.syntax : 'hex';
  el.code.value = buffers[state.mode] = ex.text[key];
  if (engine?.capabilities.mock && archItems.has(ex.arch) && state.arch !== ex.arch) {
    state.arch = ex.arch; // the mock has the reference's result for this microarchitecture
    el.arch.value = ex.arch;
  }
  clearMessages();
  changed();
  run();
}

function fillExamples() {
  const list = engine?.capabilities.mock ? [...EXAMPLES, ...MOCK_EXAMPLES] : EXAMPLES;
  el.examples.replaceChildren(h('option', { value: '', text: 'choose…' }),
    ...list.map((e) => h('option', { value: e.id, text: e.title })));
}

// ---- microarchitectures and their tables ---------------------------------------------------------------------------

function fillArchs() {
  const groups = archGroups(uarch);
  archItems = new Map();
  const nodes = [];
  for (const g of groups) {
    const og = h('optgroup', { label: g.label });
    for (const it of g.items) {
      archItems.set(it.key, { ...it, experimental: g.experimental });
      og.append(h('option', { value: it.key, text: it.title }));
    }
    nodes.push(og);
  }
  if (archItems.size === 0) throw new Error('uarch.json has no configurations');
  el.arch.replaceChildren(...nodes);
  if (!archItems.has(state.arch)) state.arch = archItems.has(DEFAULT_ARCH) ? DEFAULT_ARCH : archItems.keys().next().value;
  el.arch.value = state.arch;
  el.arch.disabled = false;
}

function ensureTable(archKey) {
  const name = archItems.get(archKey).table;
  let p = tables.get(name);
  if (!p) {
    p = (async () => {
      const bytes = await download(`${name} table`, PATHS.table(name));
      await engine.loadArch(name, bytes);
    })();
    tables.set(name, p);
    p.catch(() => tables.delete(name)); // a later attempt may succeed (e.g. back online)
  }
  return p;
}

// ---- analysis ------------------------------------------------------------------------------------------------------

function nextFrame() { // lets the busy state paint before the (synchronous) analysis blocks the thread
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 100); // a hidden tab gets no animation frames
    requestAnimationFrame(() => { clearTimeout(t); setTimeout(resolve, 0); });
  });
}

function draw() {
  if (!lastView) return;
  if (lastView.ab) { ab.draw(lastView.ab); paintStale(); return; }
  renderResult(el.body, { ...lastView, ui, onUi: (k, v) => { ui[k] = v; if (k === 'hideEmpty') draw(); } });
  paintStale();
}

async function machineCode(id) {
  const text = el.code.value;
  if (state.mode === 'hex') {
    const p = parseHexInput(text);
    if (!p.ok) {
      showMessages([{ line: p.line ?? null, column: null, severity: 'error', message: p.message }]);
      return null;
    }
    return p.bytes;
  }
  if (text.trim() === '') {
    showMessages([{ line: null, column: null, severity: 'error', message: 'No code: enter assembly' }]);
    return null;
  }
  const assembler = await ensureAssembler();
  if (id !== runSeq) return null;
  if (!assembler) { showAssemblerMissing(); paintDerived(); return null; }
  const r = await assembler.assemble(text, state.syntax);
  if (id !== runSeq) return null;
  const items = [...r.diagnostics];
  if (r.ok && r.bytes.length === 0) items.push({ line: null, column: null, severity: 'error', message: 'The assembly produced no machine code' });
  if (r.ok && r.bytes.length) {
    const shown = toHex(r.bytes.subarray(0, 48)).match(/../g).join(' ');
    items.push({ line: null, column: null, severity: 'note',
      message: `assembled${assembler.mock ? ' (mock assembler)' : ''}: ${r.bytes.length} byte${r.bytes.length === 1 ? '' : 's'}: ${shown}${r.bytes.length > 48 ? ' …' : ''}` });
  }
  showMessages(items);
  return r.ok && r.bytes.length ? r.bytes : null;
}

function setBusy(on) {
  busy = on;
  if (on) el.results.setAttribute('aria-busy', 'true'); else el.results.removeAttribute('aria-busy');
  // While an analysis runs, the button stops it (if the engine can be stopped).
  el.run.textContent = on ? (engine.capabilities.cancel ? 'Cancel' : 'Analyzing…') : 'Analyze';
  el.run.classList.toggle('busy', on);
}

function cancelRun() {
  if (!busy) return;
  runSeq++; // whatever the stopped run still does is ignored
  engine.cancel?.();
  setBusy(false);
  flash('cancelled');
}

async function run() {
  clearTimeout(rerunTimer);
  if (!ready || el.run.disabled) return;
  if (busy) engine.cancel?.(); // a newer request replaces the one that is running
  const id = ++runSeq;
  clearMessages();
  const key = runKey();
  if (ab?.active()) { await runCompare(id, key); return; }
  const archKey = state.arch;
  const item = archItems.get(archKey);
  let bytes;
  try {
    bytes = await machineCode(id);
  } catch (e) {
    showMessages([{ line: null, column: null, severity: 'error', message: `The assembler failed: ${e?.message ?? e}` }]);
    return;
  }
  if (!bytes || id !== runSeq) return;
  const hex = toHex(bytes);

  setBusy(true);
  try {
    await ensureTable(archKey);
    await nextFrame();
    if (id !== runSeq) return;
    const t0 = performance.now();
    const response = await engine.analyze(makeRequest(hex, archKey, options()));
    const elapsedMs = performance.now() - t0;
    if (id !== runSeq) return;
    lastView = {
      response, elapsedMs, hex, byteCount: bytes.length,
      archKey, archTitle: archTitle(archKey), experimental: item.experimental,
    };
    lastRunKey = key;
    draw();
    if (response && !response.error) {
      flash(`${Number(response.tp).toFixed(2)} cycles per iteration on ${archKey}${response.mock ? ' (mock data)' : ''}`, { ms: 4000 });
    } else {
      flash('analysis failed', { error: true });
    }
    syncUrl(true);
    prefetchTables();
  } catch (e) {
    if (id !== runSeq) return;
    lastView = null;
    renderFailure(el.body, `Could not run the analysis: ${e?.message ?? e}`);
  } finally {
    if (id === runSeq) {
      setBusy(false);
      el.results.dataset.run = String(id); // the number of the run that is shown (tests wait for it)
    }
  }
}

// A–B mode: both sides, one after the other (ab.js gets the machine code and draws the comparison).
async function runCompare(id, key) {
  const current = () => id === runSeq;
  let input;
  try {
    input = await ab.inputs(id, current);
  } catch (e) {
    showMessages([{ line: null, column: null, severity: 'error', message: `The assembler failed: ${e?.message ?? e}` }]);
    return;
  }
  if (!input || !current()) return;
  setBusy(true);
  try {
    await Promise.all([...new Set([input.a?.arch, input.b?.arch].filter(Boolean))].map(ensureTable));
    await nextFrame();
    if (!current()) return;
    const view = await ab.analyze(input, (hex, arch) => engine.analyze(makeRequest(hex, arch, options())), current);
    if (!view || !current()) return;
    lastView = { ab: view };
    lastRunKey = key;
    draw();
    flash(ab.summary(view), { ms: 4000 });
    syncUrl(true);
    prefetchTables();
  } catch (e) {
    if (!current()) return;
    lastView = null;
    renderFailure(el.body, `Could not run the comparison: ${e?.message ?? e}`);
  } finally {
    if (current()) {
      setBusy(false);
      el.results.dataset.run = String(id);
    }
  }
}

// Puts code into the page's editor (side A), e.g. from Compiler Explorer or a swap.
function importCode({ mode, syntax, text }, { run: andRun = true } = {}) {
  if (mode === 'asm' || mode === 'hex') setMode(mode);
  if (syntax === 'intel' || syntax === 'att') state.syntax = syntax;
  el.code.value = buffers[state.mode] = text;
  clearMessages();
  writeControls();
  changed();
  if (andRun && ready) run();
}

function setupFeatures() {
  ce = createCeImport({
    sides: () => (state.ab ? ['A', 'B'] : ['A']),
    importInto(side, code, { alignment = null } = {}) {
      if (alignment !== null) state.alignmentOffset = alignment;
      if (side === 'B') { ab.setB(code); writeControls(); if (ready) run(); } else importCode(code);
    },
  });
  ab = createAB({
    state, el: { code: el.code, body: el.body }, archItems: () => archItems, archTitle, ensureAssembler, ensureTable,
    machineCodeA: machineCode, changed, writeControls,
    getA: () => ({ mode: state.mode, syntax: state.syntax, text: el.code.value }),
    setA: importCode,
    toggled() { // single <-> A–B
      lastView = null;
      changed();
      if (ready && !el.run.disabled && el.code.value.trim() !== '') run();
      else renderEmpty(el.body, 'No result yet. Press Analyze (Ctrl/⌘ + Enter).');
    },
    openImport: (side) => ce.open(side),
    watchPaste: (textarea, side) => ce.watchPaste(textarea, side),
  });
  ce.watchPaste(el.code, 'A');
  const open = h('button', { type: 'button', class: 'plain', id: 'ce-open', title: 'import code from a Compiler Explorer link (fetches from godbolt.org)' }, 'Import from Compiler Explorer…');
  open.addEventListener('click', () => ce.open('A'));
  el.examples.closest('label')?.after(open);
}

// ---- offline: service worker and background caching ------------------------------------------------------------------

const swUsable = () => 'serviceWorker' in navigator && !NO_SW && manifest.version !== 'dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function registerServiceWorker() {
  if (!swUsable()) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) el.updateNote.hidden = false; // a new deploy took over while this page was open
  });
  try {
    await navigator.serviceWorker.register('sw.js');
  } catch { /* the page works without it, just not offline */ }
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
    setIdle(`ready · caching for offline use ${done}/${urls.length}`);
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
  el.modeAsm.addEventListener('change', () => setMode('asm'));
  el.modeHex.addEventListener('change', () => setMode('hex'));
  el.syntax.addEventListener('change', () => {
    const old = state.syntax;
    state.syntax = el.syntax.value === 'att' ? 'att' : 'intel';
    // an untouched example follows the syntax
    const ex = [...EXAMPLES, ...MOCK_EXAMPLES].find((e) => e.text[old] === el.code.value);
    if (ex && state.mode === 'asm') el.code.value = buffers.asm = ex.text[state.syntax];
    changed();
  });
  el.examples.addEventListener('change', () => {
    const ex = [...EXAMPLES, ...MOCK_EXAMPLES].find((e) => e.id === el.examples.value);
    el.examples.value = '';
    if (ex) loadExample(ex);
  });
  el.code.addEventListener('input', () => { buffers[state.mode] = el.code.value; changed(); });
  el.arch.addEventListener('change', () => {
    state.arch = el.arch.value;
    ensureTable(state.arch).catch((e) => flash(`could not load the instruction table: ${e?.message ?? e}`, { error: true, ms: 6000 }));
    changed({ rerun: true });
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
  el.run.addEventListener('click', () => (busy ? cancelRun() : run()));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!busy) run(); }
  });
  el.copy.addEventListener('click', copyLink);
  el.reload.addEventListener('click', () => location.reload());
  window.addEventListener('hashchange', () => {
    const frag = location.hash.replace(/^#/, '');
    if (frag === lastFragment) return; // our own update
    if (!frag.startsWith('v=')) { syncUrl(true); return; } // an in-page anchor: keep the state in the address bar

    if (restore(frag)) {
      lastFragment = frag;
      if (!archItems.has(state.arch)) state.arch = DEFAULT_ARCH;
      clearMessages();
      writeControls();
      if (state.mode === 'asm') ensureAssembler().then(() => paintDerived());
      if (el.code.value.trim() !== '') run();
    }
  });
}

async function copyLink() {
  syncUrl(true);
  const url = location.href;
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch {
    const t = h('textarea', { readonly: true, 'aria-hidden': 'true', tabindex: '-1' });
    t.value = url;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.append(t);
    t.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    t.remove();
    el.copy.focus();
  }
  el.copy.textContent = ok ? 'Copied' : 'Copy link';
  flash(ok ? 'link copied: it contains the input and options' : 'could not copy; the link is in the address bar', { error: !ok });
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
  writeControls();
  fillExamples();
  bind();
  setupFeatures();

  manifest = await fetchManifest();
  el.buildId.textContent = manifest.version;
  registerServiceWorker();

  try {
    const wasmBytes = MOCK ? null : download('analyzer', PATHS.wasm);
    wasmBytes?.catch(() => {}); // reported below
    const uarchBytes = await download('configurations', PATHS.uarch);
    uarch = JSON.parse(new TextDecoder().decode(uarchBytes));
    fillArchs();
    writeControls();

    if (MOCK) {
      const { MockEngine } = await import('./engine-mock.js');
      engine = new MockEngine();
      showNotice('Mock mode (?mock=1): the analyzer is not loaded.',
        'Results are the reference\'s recorded results for the built-in examples, and a recorded sample for any other input. They are labelled "mock data".');
      fillExamples();
    } else {
      let bytes;
      try { bytes = await wasmBytes; } catch (e) { throw new Error(`the analyzer could not be loaded (${e?.message ?? e})`); }
      if (!isWasm(bytes)) throw new Error('the analyzer could not be loaded (wuica_wasm.wasm is not a WebAssembly module)');
      const module = await WebAssembly.compile(bytes);
      try {
        engine = await WorkerEngine.create(module, () => new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' }));
      } catch {
        engine = await WasmEngine.create(module); // no module workers here: run it on the page's own thread
      }
      if (!engine.capabilities.analyze) throw new Error('this build of the analyzer has no simulator (wuica_analyze is missing)');
    }
    await engine.loadUarch(uarchBytes);
    await ensureTable(state.arch);
  } catch (e) {
    setIdle('not ready');
    el.statusWrap.classList.add('error');
    renderFailure(el.body, `wuica could not start: ${e?.message ?? e}. Reload the page to try again.`);
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
  else renderEmpty(el.body, 'No result yet. Press Analyze (Ctrl/⌘ + Enter) to analyze the code above.');
}

start();
