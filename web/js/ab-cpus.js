// A–B on every checked CPU: one table of A, B and B − A per CPU, above the A–B result when several CPUs are checked
// (as the table of the checked CPUs in single mode). Both sides run on each CPU (B's own cpu, if it has one, is for the
// detailed comparison below); the values are per element when the elements per iteration are given. A row is the CPU
// the detailed comparison uses: a click moves it there. The analyses run on the worker pool if the page has one, else in
// the analyzer's worker one at a time; they stop as soon as the input is out of date, and results are reused.
// abCpuRows has no DOM (tests-js/web_branch_label.mjs runs it under Node).

import { h } from './render.js';
import { makeRequest } from './engine.js';
import { summarize, resultKey, ResultCache, latestWins } from './compare.js';
import { verdict, cycles } from './ab-diff.js';
import { cannotRun } from './caveats.js';

const two = (v) => (typeof v === 'number' && Number.isFinite(v) ? cycles(v) : '');
const isCancel = (e) => e?.name === 'CancelledError';

// items: the checked CPUs ({key, title, experimental}), results: Map "a:KEY" / "b:KEY" -> summary. Values per element
// (tp / work). [{key, title, experimental, state: 'ok'|'pending'|'error', a, b, delta, pct, speedup, verdict, current}]
// invalidA, invalidB: the side's code cannot run on that CPU (caveats.js cannotRun; codeA, codeB: the analyzed assembly
// texts, which name the extension): its number is no result, so the row has no verdict
export function abCpuRows(items, results, { workA = 1, workB = 1, current = null, codeA = null, codeB = null } = {}) {
  return items.map((it) => {
    const ra = results.get(`a:${it.key}`), rb = results.get(`b:${it.key}`);
    const row = { key: it.key, title: it.title ?? it.key, experimental: !!it.experimental, current: it.key === current,
      state: 'pending', a: null, b: null, delta: null, pct: null, speedup: null, verdict: null, error: null, invalidA: null, invalidB: null };
    if (ra && !ra.error) { row.a = ra.tp / workA; row.invalidA = cannotRun(ra, { arch: it.key, code: codeA }); }
    if (rb && !rb.error) { row.b = rb.tp / workB; row.invalidB = cannotRun(rb, { arch: it.key, code: codeB }); }
    if (ra?.error || rb?.error) { row.state = 'error'; row.error = ra?.error ?? rb?.error; }
    else if (ra && rb && (row.invalidA || row.invalidB)) row.state = 'invalid';
    else if (ra && rb) {
      row.state = 'ok';
      row.verdict = verdict(row.a, row.b); // (relative, unrounded: as the headline)
      row.delta = row.verdict === 'same' ? 0 : row.b - row.a;
      row.pct = row.a > 0 ? (100 * row.delta) / row.a : null;
      row.speedup = row.b > 0 ? row.a / row.b : null;
    }
    return row;
  });
}

const pct = (p) => (p === null || !Number.isFinite(p) ? '' : `${p < 0 ? '−' : p > 0 ? '+' : ''}${Math.abs(p) < 10 ? Math.abs(p).toFixed(1) : Math.round(Math.abs(p))}%`);
const times = (r) => (!r.speedup || r.verdict === 'same' ? '' : r.speedup >= 1 ? `${r.speedup.toFixed(2)}×` : `${(1 / r.speedup).toFixed(2)}× slower`);

// env: { engine(), pool() (or null), checked() -> [{key, title, experimental}], tableLoaded(key), ensureTable(key),
//        onArch(key) (a row was picked) }
export function createABCpus(env) {
  const cache = new ResultCache();
  const box = h('div', { id: 'ab-cpus', class: 'multi ab-cpus-box', hidden: true });
  let input = null;          // {a, b (hex or null), options, workA, workB, focus}
  let results = new Map();
  let shownKey = null, doneKey = null, runs = 0;

  const keyOf = (x) => JSON.stringify([x.a, x.b, x.options, env.checked().map((i) => i.key)]);
  const unit = () => (input && (input.workA !== 1 || input.workB !== 1) ? 'cycles/element' : 'cycles/iteration');

  let lastRows = null;
  function draw() {
    if (!input) return;
    const rows = abCpuRows(env.checked(), results, { workA: input.workA, workB: input.workB, current: input.focus, codeA: input.codeA ?? null, codeB: input.codeB ?? null });
    lastRows = rows;
    const head = h('tr', null, h('th', { scope: 'col', class: 'first', text: 'cpu' }),
      h('th', { scope: 'col', title: unit(), text: 'A' }), h('th', { scope: 'col', title: unit(), text: 'B' }),
      h('th', { scope: 'col', title: 'B against A, in percent', text: 'Δ%' }), h('th', { scope: 'col', class: 'ab-cx', title: 'B against A', text: '' }));
    const body = h('tbody');
    for (const r of rows) {
      const cls = r.verdict === 'better' ? 'ab-better' : r.verdict === 'worse' ? 'ab-worse' : '';
      const bad = [['A', r.invalidA], ['B', r.invalidB]].filter(([, x]) => x);
      const tr = h('tr', { class: [r.current ? 'current' : '', r.state !== 'ok' ? r.state : ''].filter(Boolean).join(' ') || null,
        'aria-current': r.current ? 'true' : null, 'data-arch': r.key, title: r.error ?? (bad.length ? bad.map(([t, x]) => `${t}: ${x.title}`).join('\n') : null) },
      h('th', { scope: 'row', class: 'first' },
        h('button', { type: 'button', class: 'plain pick', 'data-focus': `abcpu-${r.key}`, title: `compare in detail on ${r.title}`, 'aria-pressed': r.current ? 'true' : 'false', text: r.key }),
        r.experimental ? h('span', { class: 'proto-mark', 'aria-hidden': 'true', text: 'p' }) : null),
      h('td', { class: `ab-cv${r.invalidA ? ' invalid' : ''}`, text: r.state === 'error' && r.a === null ? '!' : two(r.a) }),
      h('td', { class: `ab-cv${r.invalidB ? ' invalid' : ''}`, text: r.state === 'error' && r.b === null ? '!' : two(r.b) }),
      h('td', { class: `ab-d ${cls}`, text: r.delta === null ? '' : r.delta === 0 ? '0' : `${pct(r.pct)}` }),
      // a side that cannot run on this CPU: why, instead of the speed-up
      h('td', { class: `ab-cx ${cls}${bad.length ? ' caveat' : ''}`, text: bad.length ? bad.map(([t, x]) => `${t} ${x.reason}`).join(' · ') : times(r) }));
      tr.addEventListener('click', (e) => { if (!e.target.closest('button')) env.onArch(r.key); });
      tr.querySelector('button.pick').addEventListener('click', () => env.onArch(r.key));
      body.append(tr);
    }
    const a = document.activeElement;
    const focusId = a && box.contains(a) ? a.getAttribute('data-focus') : null;
    box.replaceChildren(h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'A and B on each checked CPU' },
      h('table', { class: 'grid ab-cpus' }, h('thead', null, head), body)));
    if (focusId) box.querySelector(`[data-focus="${CSS.escape(focusId)}"]`)?.focus();
  }

  async function runJobs(jobs, { isStale, signal }) {
    const pool = env.pool?.();
    const done = (job, r) => { if (!r.transient) cache.set(resultKey(job.hex, job.arch, job.options), r); results.set(job.id, r); draw(); };
    if (pool) {
      return pool.run(jobs.map((job) => ({ job, request: makeRequest(job.hex, job.arch, job.options) })), {
        signal, isStale,
        onResult: ({ job }, response, error) => done(job, error ? { error: error.message ?? String(error), transient: true } : summarize(response)),
      });
    }
    const engine = env.engine();
    for (const job of jobs) {
      if (isStale()) return false;
      if (!env.tableLoaded(job.arch)) {
        try { await env.ensureTable(job.arch); } catch (e) { done(job, { error: `table not loaded: ${e?.message ?? e}`, transient: true }); continue; }
        if (isStale()) return false;
      }
      let r;
      try { r = summarize(await engine.analyze(makeRequest(job.hex, job.arch, job.options))); } catch (e) {
        if (isCancel(e)) return false;
        r = { error: e?.message ?? String(e), transient: true };
      }
      if (isStale()) return false;
      done(job, r);
    }
    return true;
  }

  const runner = latestWins(async ({ isStale, signal }) => {
    if (!input) return;
    const key = keyOf(input);
    const jobs = [];
    for (const it of env.checked()) {
      for (const side of ['a', 'b']) {
        const hex = input[side];
        const id = `${side}:${it.key}`;
        if (!hex) { results.set(id, { error: 'no input' }); continue; }
        if (results.has(id)) continue;
        const r = cache.get(resultKey(hex, it.key, input.options));
        if (r) results.set(id, r); else jobs.push({ id, hex, arch: it.key, options: input.options });
      }
    }
    draw();
    if (jobs.length) {
      box.dataset.state = 'running';
      const finished = await runJobs(jobs, { isStale, signal });
      if (!finished || isStale()) return;
    }
    doneKey = key;
    runs++;
    box.dataset.runs = String(runs);
    box.dataset.state = 'done';
    draw();
  }, { onError: () => { box.dataset.state = 'idle'; } });

  return {
    box,
    // after each A–B result. x: {a, b (hex or null), options, workA, workB, focus, seed: Map "a:KEY" -> summary}
    update(x, { auto = false } = {}) {
      input = x;
      const many = env.checked().length > 1;
      box.hidden = !many;
      if (!many) { runner.cancel(); return; }
      const key = keyOf(x);
      if (key !== shownKey) { shownKey = key; results = new Map(); doneKey = null; }
      for (const [id, r] of x.seed ?? []) if (!results.has(id)) results.set(id, r);
      if (doneKey === key) { draw(); return; }
      box.dataset.state = 'queued';
      draw();
      runner.schedule(auto ? 150 : 0);
    },
    // the drawn result is gone (single mode, a failure)
    clear() { input = null; lastRows = null; runner.cancel(); box.hidden = true; },
    // A and B per checked CPU as markdown.js compare takes them (meta.cpus; null: one CPU)
    rows: () => (!input || box.hidden || !lastRows ? null : lastRows.map((r) => ({ arch: r.key, a: r.a, b: r.b,
      ...(r.invalidA ? { unsupportedA: r.invalidA.reason } : {}), ...(r.invalidB ? { unsupportedB: r.invalidB.reason } : {}) }))),
  };
}
