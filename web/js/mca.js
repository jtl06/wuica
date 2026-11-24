// The llvm-mca view (row "mca" of the "more" section): the same machine code through LLVM's machine code analyzer
// (llvm-mca 22.1.2, mca/wuica_mca.cpp), next to uiCA's prediction. Computed only while the view is open; the module
// (several MB) is downloaded on first use and runs in a worker (mca-worker.js).
//
// The input is the analyzed bytes as Intel assembly (asm-text.js: assembles back to exactly these bytes), so llvm-mca
// sees what uiCA saw, whether it was typed as assembly or hex. The CPU is the uiCA microarchitecture's LLVM
// counterpart (MCPU below). The cycles per iteration are llvm-mca's Total Cycles / Iterations.
//
// env: { available(), module() -> promise of a WebAssembly.Module, toAsm(hex) -> promise of {text} | null,
//        spawn() -> Worker, onToggle(open) }
import { h } from './render.js';
import { setCopy, waitCopy } from './copy-view.js';
import { mcaText } from './markdown.js';

// uiCA's microarchitectures -> llvm -mcpu (LLVM has no Kaby Lake or Coffee Lake model: they are Skylake)
export const MCPU = {
  SNB: 'sandybridge', IVB: 'ivybridge', HSW: 'haswell', BDW: 'broadwell', SKL: 'skylake', KBL: 'skylake', CFL: 'skylake',
  SKX: 'skylake-avx512', CLX: 'cascadelake', ICL: 'icelake-client', TGL: 'tigerlake', RKL: 'rocketlake',
  ICX: 'icelake-server', 'ADL-P': 'alderlake', ZEN3: 'znver3',
};

// llvm-mca's numbers from its default output
export function parseMca(out) {
  const num = (re) => { const m = re.exec(out); return m ? Number(m[1]) : null; };
  const iterations = num(/^Iterations:\s+(\d+)/m), cycles = num(/^Total Cycles:\s+(\d+)/m);
  return {
    iterations, cycles, instructions: num(/^Instructions:\s+(\d+)/m), uops: num(/^Total uOps:\s+(\d+)/m),
    ipc: num(/^IPC:\s+([\d.]+)/m), rthroughput: num(/^Block RThroughput:\s+([\d.]+)/m),
    perIteration: iterations && cycles ? cycles / iterations : null,
  };
}

// iterations: enough for the start to matter little, at most about 300,000 simulated instructions
export function mcaIterations(instrs) { return Math.max(100, Math.min(1000, Math.floor(300000 / Math.max(1, instrs)))); }

const fmt = (x) => (x === null || x === undefined ? '–' : Number(x).toFixed(2));

export function createMca(env = {}) {
  let open = false, timeline = false, bottleneck = false;
  let row = null, details = null, body = null, hint = null;
  let view = null, key = '', seq = 0;
  let worker = null, workerReady = null, nextId = 0;
  const pending = new Map();

  function ensureWorker() {
    if (workerReady) return workerReady;
    workerReady = (async () => {
      const module = await env.module();
      worker = env.spawn();
      worker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p(e.data); } };
      worker.postMessage({ module });
      return worker;
    })();
    workerReady.catch(() => { workerReady = null; });
    return workerReady;
  }
  async function run(args, text) {
    const w = await ensureWorker();
    const id = ++nextId;
    return new Promise((resolve) => { pending.set(id, resolve); w.postMessage({ id, args, text }); });
  }

  function ensureRow() {
    if (row?.isConnected) return row;
    hint = h('span', { class: 'hint mca-hint' });
    details = h('details', { class: 'mca', id: 'mca' }, h('summary', { title: "the same machine code through LLVM's machine code analyzer" }, 'llvm-mca', hint));
    details.open = open;
    let last = open;
    details.addEventListener('toggle', () => {
      if (details.open === last) return;
      last = open = details.open;
      env.onToggle?.(open);
      update();
    });
    body = h('div', { class: 'mca-body' });
    details.append(body);
    row = h('div', { class: 'row', id: 'mca-row' }, h('div', { class: 'label', text: 'mca' }), h('div', { class: 'field' }, details));
    const more = document.getElementById('more');
    const before = document.getElementById('sweep-row');
    if (before?.parentNode === more) more.insertBefore(row, before); else more?.append(row);
    return row;
  }

  function option(label, title, get, set) {
    const box = h('input', { type: 'checkbox' });
    box.checked = get();
    box.addEventListener('change', () => { set(box.checked); key = ''; update(); });
    return h('label', { class: 'mca-opt', title }, box, ` ${label}`);
  }

  async function update() {
    if (!env.available?.()) { if (row) row.hidden = true; return; }
    ensureRow();
    const v = view, r = v?.response;
    const ok = r && !r.error && Array.isArray(r.rows) && !r.mock && v.hex;
    row.hidden = !ok;
    if (!ok) { setCopy('mca', null); return; }
    const arch = v.archKey;
    const cpu = MCPU[arch];
    const instrs = r.rows.filter((x) => x.kind === 'instr').length;
    const iterations = mcaIterations(instrs);
    const k = [v.hex, cpu, iterations, timeline, bottleneck].join('|');
    if (k === key) return;
    // (another result or other options: the text shown before is not copied for it)
    if (!open) { setCopy('mca', null); return; }
    key = k;
    waitCopy('mca', "llvm-mca's text");
    const mine = ++seq;
    const tools = h('div', { class: 'mca-tools' },
      option('timeline', 'llvm-mca -timeline: the first iterations, cycle by cycle', () => timeline, (x) => { timeline = x; }),
      option('bottlenecks', 'llvm-mca -bottleneck-analysis', () => bottleneck, (x) => { bottleneck = x; }));
    if (!cpu) { setCopy('mca', null); body.replaceChildren(tools, h('p', { class: 'hint', text: `llvm-mca has no model for ${arch}.` })); return; }
    body.replaceChildren(tools, h('p', { class: 'hint', text: 'llvm-mca: loading…' }));
    try {
      const asm = await env.toAsm(v.hex);
      if (mine !== seq) return;
      if (!asm) { setCopy('mca', null); body.replaceChildren(tools, h('p', { class: 'hint', text: 'The machine code could not be turned into assembly for llvm-mca.' })); return; }
      const args = ['-mtriple=x86_64-unknown-linux-gnu', `-mcpu=${cpu}`, `-iterations=${iterations}`, '-'];
      if (timeline) args.splice(-1, 0, '-timeline', '-timeline-max-iterations=3');
      if (bottleneck) args.splice(-1, 0, '-bottleneck-analysis');
      const res = await run(args, '.intel_syntax noprefix\n' + asm.text);
      if (mine !== seq) return;
      if (res.error || res.code !== 0) {
        setCopy('mca', null);
        body.replaceChildren(tools, h('pre', { class: 'mca-out error-box', text: res.error ? `llvm-mca stopped: ${res.error}` : (res.err || res.out || `llvm-mca exited with ${res.code}`) }));
        return;
      }
      const m = parseMca(res.out);
      const out = res.out;
      setCopy('mca', { what: "llvm-mca's text", md: () => mcaText(out, `${m.iterations} iterations`) });
      const uica = Number(r.tp ?? r.throughput);
      const diff = m.perIteration && uica ? (100 * (m.perIteration - uica)) / uica : null;
      hint.textContent = m.perIteration ? ` · ${fmt(m.perIteration)} cycles/iteration` : '';
      const head = h('div', { class: 'mca-head' },
        h('span', { class: 'mca-tp', title: `Total Cycles ${m.cycles} / Iterations ${m.iterations}` }, h('b', { text: fmt(m.perIteration) }), ' cycles/iteration'),
        h('span', { class: 'meta' }, ` · ${cpu} · ${m.iterations} iterations · block rthroughput ${fmt(m.rthroughput)} · IPC ${fmt(m.ipc)}`),
        Number.isFinite(uica) ? h('span', { class: 'mca-vs', title: "uiCA's prediction for the same code and CPU" },
          ` · uiCA ${fmt(uica)}`, diff !== null ? h('span', { class: Math.abs(diff) > 10 ? 'mca-far' : 'mca-near', text: ` (llvm-mca ${diff >= 0 ? '+' : ''}${diff.toFixed(0)}%)` }) : null) : null,
        h('span', { class: 'hint', text: ` · ${res.ms.toFixed(0)} ms` }));
      body.replaceChildren(...[tools, head, h('pre', { class: 'mca-out', tabindex: '0', text: res.out.replace(/\s+$/, '') }),
        res.err.trim() ? h('pre', { class: 'mca-out mca-warn', text: res.err.trim() }) : null].filter(Boolean));
    } catch (e) {
      if (mine !== seq) return;
      key = '';
      setCopy('mca', null);
      body.replaceChildren(tools, h('p', { class: 'messages', text: `llvm-mca could not be loaded: ${e?.message ?? e}` }));
    }
  }

  return {
    decorate(target, v) { view = v; update(); },
    setOpen(o) { open = !!o; if (details) details.open = open; },
    open: () => open,
  };
}
