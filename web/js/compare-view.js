// The compare views: the table of the checked CPUs (above the detailed result, when several are checked) and the focused
// CPU at every alignment offset (a panel below the result).
// They run on the worker pool (pool.js) if the page has one, in parallel and apart from the main analysis; otherwise
// in the analyzer's worker, one analysis at a time (a main analysis waits behind one of them at most). They stop as
// soon as their input is out of date, and reuse results (compare.js). The page (app.js) passes in what
// they need: no other module state is touched from here.

import { h, cyc } from './render.js';
import { makeRequest } from './engine.js';
import { setCopy } from './copy-view.js';
import { sweep as sweepText, cpuTable, offsetRanges } from './markdown.js';
import { ARCH_INFO, PROTOTYPE } from './archs.js';
import {
  summarize, compareRows, sweepData, sweepLayout, compareKey, sweepKey, resultKey, ResultCache, latestWins, SWEEP_OFFSETS,
} from './compare.js';

const AUTO_DELAY = 250;   // ms after a live result before a panel recomputes (15 or 64 analyses)
const BUDGET_MS = 3000;   // a recomputation estimated to take longer waits for a click
const REDRAW_MS = 30;     // the shortest time between two redraws while results come in
const SVG = 'http://www.w3.org/2000/svg';

function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const fmtTp = (v) => Number(v).toFixed(2);
const fmtMs = (ms) => `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
const isCancel = (e) => e?.name === 'CancelledError';
const yieldToPage = () => new Promise((r) => setTimeout(r, 0));

// Keeps keyboard focus across a redraw: finds the element with the same data-focus value in the new content.
function keepFocus(root, draw) {
  const a = document.activeElement;
  const id = a && root.contains(a) ? a.getAttribute('data-focus') : null;
  draw();
  if (id) root.querySelector(`[data-focus="${CSS.escape(id)}"]`)?.focus();
}

// env: {
//   els: {cpus, cpusInfo, cpusBody, sweep, sweepInfo, sweepBody}   the table's box and the sweep's <details>, their hints and bodies
//   engine()                the analyzer (analyze(request), capabilities)
//   checked()               the checked CPUs in menu order ({key, title, table, experimental})
//   multi()                 true: the table of the checked CPUs is shown (several checked, single mode)
//   tableLoaded(key), ensureTable(key)
//   pool()                  the worker pool (pool.js) or null: then the analyses run in engine(), one at a time
//   onArch(key), onAlign(offset)   a row or a point was chosen
//   onToggle()              a panel was opened or closed (the URL keeps it)
//   wantResult()            a panel was opened before any result: analyze the input
// }
export function createComparePanels(env) {
  const cache = new ResultCache();
  const parallel = (jobs) => Math.max(1, Math.min(jobs, env.pool?.()?.size ?? 1)); // analyses that run at once
  let input = null;       // {hex, arch, options, elapsedMs} of the latest successful main analysis
  let mainStale = false;

  // Runs jobs [{arch, options}] for input.hex in order; onResult(job, summary). False if it stopped early.
  async function runJobs(hex, jobs, { isStale, signal, onResult, onTable }) {
    const pool = env.pool?.();
    if (pool) return runPooled(pool, hex, jobs, { isStale, signal, onResult });
    const engine = env.engine();
    for (const job of jobs) {
      if (isStale()) return false;
      const rk = resultKey(hex, job.arch, job.options);
      let r = cache.get(rk);
      if (!r && !env.tableLoaded(job.arch)) {
        onTable?.(job);
        try { await env.ensureTable(job.arch); } catch (e) { r = { error: `table not loaded: ${e?.message ?? e}`, transient: true }; }
        if (isStale()) return false;
      }
      if (!r) {
        try {
          r = summarize(await engine.analyze(makeRequest(hex, job.arch, job.options)));
        } catch (e) {
          if (isCancel(e)) return false; // the page stopped the analyzer; the next result reruns this
          r = { error: e?.message ?? String(e), transient: true };
        }
        if (!r.transient) cache.set(rk, r);
        if (!engine.capabilities?.cancel) await yieldToPage(); // the analyzer runs on the page's thread: let it breathe
      }
      onResult(job, r);
    }
    return true;
  }

  // The same on the pool: every job at once (the pool loads the tables into its workers); results in any order.
  async function runPooled(pool, hex, jobs, { isStale, signal, onResult }) {
    const todo = [];
    for (const job of jobs) {
      const r = cache.get(resultKey(hex, job.arch, job.options));
      if (r) onResult(job, r); else todo.push({ job, request: makeRequest(hex, job.arch, job.options) });
    }
    return pool.run(todo, {
      signal, isStale,
      onResult: ({ job }, response, error) => {
        const r = error ? { error: error.message ?? String(error), transient: true } : summarize(response);
        if (!r.transient) cache.set(resultKey(hex, job.arch, job.options), r);
        onResult(job, r);
      },
    });
  }

  // What both views share: open state, scheduling, progress markers (data-state, data-runs, data-ms: for tests).
  // details: the element that gets the markers (a <details> element is also the open state, unless isOpen is given)
  function panel({ details, isOpen = () => details.open, info, body, keyOf, jobsFor, draw, label }) {
    const p = {
      details, info, body,
      shownKey: null, doneKey: null, runningKey: null, forcedKey: null,
      results: new Map(), ms: null, runs: 0, progress: '', mock: false,
    };
    p.setState = (s) => { details.dataset.state = s; };
    p.paintInfo = () => {
      let t = p.progress;
      if (!t && p.doneKey && p.doneKey === p.shownKey) t = `${label(p)} · ${fmtMs(p.ms)}${p.mock ? ' · mock data' : ''}`;
      info.textContent = t ? `${details instanceof HTMLDetailsElement ? '· ' : ''}${t}` : '';
    };
    p.paintStale = () => {
      // dimmed while what it shows is not for the current input (the main result's, or its own, is out of date)
      body.classList.toggle('stale', mainStale || (p.shownKey !== null && input !== null && p.shownKey !== keyOf(input)));
    };
    let redrawTimer = 0, redrawn = 0;
    p.redraw = () => {
      clearTimeout(redrawTimer);
      redrawTimer = 0;
      redrawn = performance.now();
      keepFocus(body, () => draw(p)); p.paintInfo(); p.paintStale();
    };
    // while results come in (several at once from the pool): at most one redraw per REDRAW_MS, the last one included
    p.redrawSoon = () => {
      if (redrawTimer) return;
      const wait = REDRAW_MS - (performance.now() - redrawn);
      if (wait <= 0) p.redraw(); else redrawTimer = setTimeout(p.redraw, wait);
    };

    p.runner = latestWins(async ({ isStale, signal }) => {
      if (!input || !isOpen()) return;
      const inp = input;
      const key = keyOf(inp);
      if (key !== p.shownKey) { p.shownKey = key; p.results = new Map(); p.doneKey = null; p.mock = false; }
      if (p.doneKey === key) { p.redraw(); return; }
      const jobs = jobsFor(inp).filter((j) => !p.results.has(j.id));
      for (const j of [...jobs]) { // what is cached is shown at once
        const r = cache.get(resultKey(inp.hex, j.arch, j.options));
        if (r) { p.results.set(j.id, r); jobs.splice(jobs.indexOf(j), 1); }
      }
      const estimate = ((inp.elapsedMs ?? 0) * jobs.length) / parallel(jobs.length);
      p.waitingForClick = jobs.length > 0 && estimate > BUDGET_MS && p.forcedKey !== key;
      if (p.waitingForClick) { p.progress = ''; p.redraw(); p.setState('waiting'); return; }

      const t0 = performance.now();
      p.runningKey = key;
      p.setState('running');
      const total = jobsFor(inp).length;
      const missing = env.pool?.() ? 0 : jobs.filter((j) => !env.tableLoaded(j.arch)).length;
      let tablesDone = 0;
      p.progress = jobs.length ? `${p.results.size}/${total}` : '';
      p.redraw();
      let finished = false;
      try {
        finished = await runJobs(inp.hex, jobs, {
          isStale: () => isStale() || !isOpen(), signal,
          onTable: () => { tablesDone++; p.progress = `loading tables ${tablesDone}/${missing}`; p.paintInfo(); },
          onResult: (job, r) => {
            p.results.set(job.id, r);
            if (r.mock) p.mock = true;
            if (!p.progress.startsWith('loading') || env.tableLoaded(job.arch)) p.progress = `${p.results.size}/${total}`;
            p.paintInfo();
            p.redrawSoon();
          },
        });
      } finally {
        if (p.runningKey === key) p.runningKey = null;
      }
      if (finished && p.shownKey === key) {
        p.doneKey = key;
        p.ms = performance.now() - t0;
        p.runs++;
        details.dataset.runs = String(p.runs);
        details.dataset.ms = p.ms.toFixed(1);
      }
      p.progress = '';
      p.setState(finished ? 'done' : 'idle');
      p.redraw();
    }, { onError: (e) => { p.progress = ''; p.runningKey = null; p.setState('idle'); info.textContent = `· failed: ${e?.message ?? e}`; } });

    p.update = (auto) => {
      if (!isOpen() || !input) return;
      const key = keyOf(input);
      if (key === p.doneKey || key === p.runningKey) { p.redraw(); return; } // only the markers moved
      p.paintStale();
      p.setState('queued');
      p.runner.schedule(auto ? AUTO_DELAY : 0);
    };
    p.force = () => { if (input) { p.forcedKey = keyOf(input); p.runner.schedule(0); } };

    if (details instanceof HTMLDetailsElement) {
      let last = details.open;
      details.addEventListener('toggle', () => {
        if (details.open === last) return;
        last = details.open;
        env.onToggle();
        if (!details.open) { p.runner.cancel(); return; }
        if (input) p.update(false); else env.wantResult();
      });
    }
    return p;
  }

  // ---- the checked CPUs -----------------------------------------------------------------------------------------------

  let sort = 'menu';
  const cpus = panel({
    details: env.els.cpus, isOpen: () => env.multi(), info: env.els.cpusInfo, body: env.els.cpusBody,
    keyOf: (i) => `${compareKey(i.hex, i.options)}|${env.checked().map((it) => it.key).join()}`,
    jobsFor: (i) => env.checked().map((it) => ({ id: it.key, arch: it.key, options: i.options })),
    label: (p) => `${[...p.results.values()].filter((r) => !r.error).length} CPUs`,
    draw: drawCpus,
  });

  function sortButton(id, text, title) {
    const b = h('button', { type: 'button', class: 'plain sort', 'data-focus': `sort-${id}`, title, text });
    b.addEventListener('click', () => {
      sort = id === 'menu' ? 'menu' : sort === 'tp' ? 'tp-desc' : 'tp';
      cpus.redraw();
    });
    return b;
  }

  // the table of the checked CPUs as markdown.js cpuTable takes it (null: one CPU); a CPU not analyzed yet says so
  function cpuResults() {
    if (!env.multi() || !input) return null;
    return env.checked().map((it) => {
      const r = cpus.results.get(it.key);
      const info = ARCH_INFO[it.key];
      const row = { arch: it.key, name: info?.name ?? '', year: info?.year ?? '' };
      if (!r || r.error) return { ...row, code: 1, error: r?.error ?? 'not analyzed yet' };
      return { ...row, tp: r.tp, bottlenecks: r.bottlenecks, decodeErrors: r.decodeErrors, ...(it.experimental ? { prototype: true } : {}) };
    });
  }

  function drawCpus(p) {
    const work = env.work?.() ?? 1; // elements per iteration: per element
    const rows = compareRows(env.checked(), p.results, { sort, current: input?.arch ?? null });
    const ariaSort = (col) => (col === 'menu' ? (sort === 'menu' ? 'ascending' : null) : sort === 'tp' ? 'ascending' : sort === 'tp-desc' ? 'descending' : null);
    const head = h('tr', null,
      h('th', { scope: 'col', class: 'first', 'aria-sort': ariaSort('menu') }, sortButton('menu', 'cpu', 'sort by release date')),
      h('th', { scope: 'col', class: 'cmp-name' }, ''),
      h('th', { scope: 'col', 'aria-sort': ariaSort('tp') }, sortButton('tp', sort === 'tp' ? 'cycles ↑' : sort === 'tp-desc' ? 'cycles ↓' : 'cycles', 'sort by throughput (cycles/iteration)')),
      h('th', { scope: 'col', class: 'cmp-bar', 'aria-hidden': 'true' }),
      h('th', { scope: 'col', class: 'cmp-bn' }, 'bottleneck', copyButton()));
    setCopy('cpus', { what: 'the table of the checked CPUs', md: () => cpuTable(cpuResults(), { per: work }) });
    const body = h('tbody');
    for (const r of rows) {
      const info = ARCH_INFO[r.key];
      const name = info ? `${info.name}${info.year ? ` (${info.year})` : ''}` : '';
      const gauge = h('span', { class: 'gauge' }, h('span'));
      gauge.firstChild.style.width = `${(100 * r.bar).toFixed(1)}%`;
      const tr = h('tr', { class: [r.current ? 'current' : '', r.fastest ? 'fastest' : '', r.state !== 'ok' ? r.state : ''].filter(Boolean).join(' ') || null,
        'aria-current': r.current ? 'true' : null, 'data-arch': r.key },
        h('th', { scope: 'row', class: 'first' },
          h('button', { type: 'button', class: 'plain pick', 'data-focus': `cpu-${r.key}`, title: `details for ${r.title}`, 'aria-pressed': r.current ? 'true' : 'false', text: r.key })),
        h('td', { class: 'cmp-name' }, name, r.experimental ? h('span', { class: 'caveat', text: ` · ${PROTOTYPE}` }) : null),
        h('td', { class: 'cmp-tp', title: r.state === 'error' ? r.error : r.state === 'ok' && work > 1 ? `${fmtTp(r.tp)} cycles/iteration ÷ ${work}` : null,
          text: r.state === 'ok' ? (work > 1 ? cyc(r.tp / work) : fmtTp(r.tp)) : r.state === 'error' ? 'failed' : '…' }),
        h('td', { class: 'cmp-bar', 'aria-hidden': 'true' }, gauge),
        h('td', { class: 'cmp-bn' }, r.state !== 'ok' ? '' : r.bottlenecks.length ? r.bottlenecks.join(', ')
          : h('span', { class: 'hint', title: 'no single limit explains the throughput', text: 'unknown' }),
        r.decodeErrors ? h('span', { class: 'caveat', title: `this CPU's decoder skipped ${r.decodeErrors} position${r.decodeErrors === 1 ? '' : 's'} (instructions it does not support): the throughput leaves them out`,
          text: ` · ${r.decodeErrors} undecodable skipped` }) : null));
      tr.addEventListener('click', () => env.onArch(r.key));
      body.append(tr);
    }
    const parts = [h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'Throughput on the checked CPUs' },
      h('table', { class: 'grid cmp-cpus' }, h('thead', null, head), body))];
    if (p.waitingForClick) parts.unshift(runButton(p));
    p.body.replaceChildren(...parts);
    if (input) env.decorateCpus?.(p.body.querySelector('table'), { hex: input.hex, options: input.options }); // cmp-slots.js
  }

  // the table's copy control (copy-view.js; the same look as the tab row's)
  function copyButton() {
    const b = h('button', { type: 'button', class: 'plain ws-copy cmp-copy', title: 'copy this table as Markdown', text: 'copy' });
    b.addEventListener('click', (e) => { e.stopPropagation(); document.dispatchEvent(new CustomEvent('wuica:copy', { detail: { tab: 'cpus', format: 'md' } })); });
    return b;
  }

  function runButton(p) {
    const n = input ? (p === cpus ? env.checked().length : SWEEP_OFFSETS) : 0;
    const b = h('button', { type: 'button', class: 'cmp-run', 'data-focus': 'run', text: `run ${n} analyses`,
      title: `about ${Math.round(((input?.elapsedMs ?? 0) * n) / parallel(n) / 1000)} s` });
    b.addEventListener('click', () => p.force());
    return h('p', { class: 'cmp-wait' }, b);
  }

  // ---- alignment sweep --------------------------------------------------------------------------------------------

  let cursor = null; // the offset shown as current (moves at once on a click or key, before the page reruns)
  const sweep = panel({
    details: env.els.sweep, info: env.els.sweepInfo, body: env.els.sweepBody,
    keyOf: (i) => sweepKey(i.hex, i.arch, i.options),
    jobsFor: (i) => Array.from({ length: SWEEP_OFFSETS }, (_, k) => ({ id: k, arch: i.arch, options: { ...i.options, alignmentOffset: k } })),
    label: () => `${input?.arch ?? ''}`,
    draw: drawSweep,
  });

  function pickOffset(k) {
    k = Math.max(0, Math.min(SWEEP_OFFSETS - 1, k));
    cursor = k;
    sweep.redraw();
    env.onAlign(k);
  }

  function drawSweep(p) {
    const points = Array.from({ length: SWEEP_OFFSETS }, (_, k) => p.results.get(k));
    const d = sweepData(points);
    const arch = input?.arch ?? '';
    setCopy('sweep', { what: 'the sweep', md: () => sweepText(d, arch), csv: () => `offset,cycles\r\n${d.values.map((v, i) => `${i},${v === null ? '' : v}`).join('\r\n')}\r\n` });
    const cur = cursor ?? input?.options.alignmentOffset ?? 0;
    const width = Math.max(240, Math.round((p.body.clientWidth || 602) - 2)); // inside the 1px border
    const height = 120;
    const L = sweepLayout(d, { width, height, left: 44, right: 8, top: 8, bottom: 20 });
    const vt = (k) => (d.values[k] === null ? (d.failed.includes(k) ? 'failed' : 'not analyzed yet') : `${fmtTp(d.values[k])} cycles/iteration`);

    const g = svg('svg', {
      class: 'sweep-chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'slider', tabindex: '0', 'data-focus': 'chart',
      'aria-label': 'alignment offset', 'aria-orientation': 'horizontal', 'aria-valuemin': 0, 'aria-valuemax': SWEEP_OFFSETS - 1,
      'aria-valuenow': cur, 'aria-valuetext': `offset ${cur}: ${vt(cur)}`,
    });
    // guides at the 16-byte boundaries, axis labels
    for (const k of [16, 32, 48]) {
      const x = L.x0 + k * L.step;
      g.append(svg('line', { class: 'guide', x1: x, x2: x, y1: L.y0, y2: L.y1 }));
    }
    for (const k of [0, 16, 32, 48, 63]) g.append(svg('text', { class: 'ax', x: L.points[k].x, y: height - 5, 'text-anchor': 'middle' }, String(k)));
    if (d.min !== null) {
      g.append(svg('text', { class: 'ax', x: L.x0 - 6, y: L.yOf(d.max) + 4, 'text-anchor': 'end' }, fmtTp(d.max)));
      if (!d.flat) g.append(svg('text', { class: 'ax', x: L.x0 - 6, y: L.yOf(d.min) + 4, 'text-anchor': 'end' }, fmtTp(d.min)));
    }
    // the line (broken where there is no value), the points, the current offset
    let seg = [];
    const flush = () => { if (seg.length > 1) g.append(svg('polyline', { class: 'line', points: seg.join(' ') })); seg = []; };
    for (const pt of L.points) { if (pt.y === null) flush(); else seg.push(`${pt.x.toFixed(1)},${pt.y.toFixed(1)}`); }
    flush();
    const cx = L.points[cur].x;
    g.append(svg('line', { class: 'cur', x1: cx, x2: cx, y1: L.y0 - 4, y2: L.y1 + 4 }));
    for (const pt of L.points) {
      if (pt.y === null) continue;
      const cls = ['pt', !d.flat && d.minAt.includes(pt.offset) ? 'min' : '', !d.flat && d.maxAt.includes(pt.offset) ? 'max' : ''].filter(Boolean).join(' ');
      g.append(svg('circle', { class: cls, cx: pt.x.toFixed(1), cy: pt.y.toFixed(1), r: 2.5 }));
    }
    if (L.points[cur].y !== null) g.append(svg('circle', { class: 'cur-pt', cx: cx.toFixed(1), cy: L.points[cur].y.toFixed(1), r: 5 }));
    // a column per offset: hover target, tooltip and click
    for (const pt of L.points) {
      const r = svg('rect', { class: 'hit', x: (pt.x - L.step / 2).toFixed(1), y: 0, width: L.step.toFixed(2), height, 'data-offset': pt.offset },
        svg('title', null, `offset ${pt.offset}: ${vt(pt.offset)}`));
      g.append(r);
    }
    g.addEventListener('click', (e) => {
      const k = e.target?.getAttribute?.('data-offset');
      if (k !== null && k !== undefined) pickOffset(Number(k));
    });
    g.addEventListener('keydown', (e) => {
      const moves = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -8, PageUp: 8 };
      let k = null;
      if (e.key in moves) k = cur + moves[e.key];
      else if (e.key === 'Home') k = 0;
      else if (e.key === 'End') k = SWEEP_OFFSETS - 1;
      if (k === null) return;
      e.preventDefault();
      pickOffset(k);
    });

    let head;
    if (d.min === null) head = h('span', { class: 'hint', text: d.failed.length === SWEEP_OFFSETS ? 'failed' : '…' });
    else if (d.flat && d.complete) head = h('span', null, h('span', { class: 'v', text: fmtTp(d.min) }), ' at every offset');
    else {
      head = [
        h('span', { class: 'min', title: `offsets ${offsetRanges(d.minAt)}` }, 'min ', h('span', { class: 'v', text: fmtTp(d.min) })),
        h('span', { class: 'sep', text: ' · ' }),
        h('span', { class: 'max', title: `offsets ${offsetRanges(d.maxAt)}` }, 'max ', h('span', { class: 'v', text: fmtTp(d.max) })),
      ];
    }
    const parts = [
      h('p', { class: 'sweep-head' }, head, d.flat && d.complete ? null : [h('span', { class: 'sep', text: ' · ' }),
        h('span', { class: 'at' }, `offset ${cur}: `, h('span', { class: 'v', text: d.values[cur] === null ? '…' : fmtTp(d.values[cur]) }))]),
      h('div', { class: 'sweep-wrap', title: 'cycles/iteration at each alignment offset (0–63) of the first byte' }, g),
    ];
    if (p.waitingForClick) parts.unshift(runButton(p));
    p.body.replaceChildren(...parts);
  }

  // redraw the chart for a new width
  if (typeof ResizeObserver === 'function') {
    let w = 0;
    new ResizeObserver(() => {
      const nw = Math.round(sweep.body.clientWidth);
      if (nw && nw !== w && sweep.shownKey) { w = nw; sweep.redraw(); }
      else w = nw;
    }).observe(sweep.body);
  }

  const panels = [cpus, sweep];
  function showCpus() {
    const on = env.multi();
    env.els.cpus.hidden = !on;
    if (!on) { cpus.runner.cancel(); setCopy('cpus', null); }
    return on;
  }
  return {
    // a successful main analysis: {hex, arch, options, elapsedMs, response}; auto: it was a live run. Its own result
    // is the focused CPU's row and the sweep's point at its offset (the same numbers as the detailed result).
    update(next, { auto = false } = {}) {
      input = next;
      cursor = null;
      mainStale = false;
      if (next.response) {
        const r = summarize(next.response);
        if (!r.error) cache.set(resultKey(next.hex, next.arch, next.options), r);
      }
      showCpus();
      for (const p of panels) p.update(auto);
    },
    // the checked CPUs changed (or single / A–B): show or hide the table; it computes what is missing
    // the elements per iteration changed: the table again (no new analysis)
    redrawCpus() { if (showCpus() && input) cpus.redraw(); },
    cpuResults,
    refreshCpus() {
      if (!showCpus()) return;
      if (input) cpus.update(false); else env.wantResult();
    },
    // the main result no longer matches the input
    setStale(stale) {
      if (stale === mainStale) return;
      mainStale = stale;
      for (const p of panels) p.paintStale();
    },
    setOpen({ sweep: s = false }) {
      env.els.sweep.open = !!s;
    },
    open() { return { sweep: env.els.sweep.open }; },
  };
}
