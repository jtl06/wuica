// The insight views on the result: the critical dependency chain (a line under the limits, a marker on its rows) and
// the cost column (Δ cycles/iteration without each instruction). They decorate the result after render.js has drawn
// it (app.js calls decorate() after renderResult): the rows of `table.uops tbody` are the response's rows, in order.
// The cost analyses run after the main result, on the worker pool (pool.js) if the page has one, otherwise in the
// analyzer's worker, one at a time; they stop as soon as their input is out of date and are cached (insight.js has the
// data side).

import { h } from './render.js';
import { makeRequest } from './engine.js';
import { summarize, resultKey, ResultCache, latestWins } from './compare.js';
import { chainInfo, chainTitle, costUnits, costJobs, costCells, costKey, VARIANTS } from './insight.js';

const DELAY = 100;        // ms after a result before the cost column starts
const BUDGET_MS = 2000;   // more (estimated) waits for a click
const MAX_STEPS = 8;      // instructions shown in the chain line
const isCancel = (e) => e?.name === 'CancelledError';
const yieldToPage = () => new Promise((r) => setTimeout(r, 0));

// env: { engine(), pool() (the worker pool or null), onToggle() (the cost toggle or variant changed: the URL keeps them) }
export function createInsight(env) {
  const cache = new ResultCache();
  const open = { cost: false, nop: false };
  let root = null, view = null; // what was decorated last
  let job = null;               // {key, hex, arch, options, cu, jobs, count, response, variant, estimate}; jobs: null until needed
  let results = new Map();      // unit -> summary, for job.key
  let doneKey = null, forcedKey = null, waitingKey = null, runs = 0;
  let cellsOf = null;           // row -> td of the cost column in the decorated table
  let tools = null;             // the status/button element next to the toggle

  const variant = () => (open.nop ? 'nop' : 'remove');
  const setState = (s) => { if (root) root.dataset.cost = s; };

  // ---- chain ----------------------------------------------------------------------------------------------------------

  function chainRow(r, info) {
    const shown = info.steps.slice(0, MAX_STEPS);
    const parts = [];
    for (const s of shown) {
      parts.push(h('span', { class: 'ins-step', text: s.label }), ' ',
        h('span', { class: 'ins-arrow', title: `${s.operand}, ${s.latency} cycle${s.latency === 1 ? '' : 's'}${s.arrow === '↻' ? ', into the next iteration' : ''}`, text: s.arrow }), ' ');
    }
    if (info.steps.length > shown.length) parts.push(h('span', { class: 'hint', text: `… +${info.steps.length - shown.length} ` }));
    const bottleneck = r.bottlenecks.includes('Dependencies');
    return h('div', { class: 'row ins ins-chain-row', title: `→ same iteration · ↻ next iteration\n\n${info.lines.join('\n')}` },
      h('div', { class: 'label', text: 'chain' }),
      h('div', { class: 'field' },
        h('span', { class: 'ins-chain' }, parts),
        h('span', { class: 'hint' }, `${info.ratio.toFixed(2)} cycles/iteration${info.iterations > 1 ? ` (over ${info.iterations} iterations)` : ''}${bottleneck ? '' : ' · not the bottleneck'}`)));
  }

  function markChain(table, r, info) {
    const trs = table.tBodies[0]?.rows ?? [];
    for (const [row, list] of info.onChain) {
      const th = trs[row]?.cells[0];
      if (!th) continue;
      trs[row].classList.add('ins-on-chain');
      th.dataset.chain = `← ${[...new Set(list.map((m) => m.operand))].join(', ')}`;
      th.title = chainTitle(info, row);
    }
  }

  // ---- cost -----------------------------------------------------------------------------------------------------------

  function toggle(available, reason) {
    const box = h('input', { type: 'checkbox', class: 'ins-cost-box', checked: open.cost && available, disabled: !available });
    box.checked = open.cost && available;
    box.addEventListener('change', () => { open.cost = box.checked; env.onToggle?.(); redecorate(); });
    const sel = h('select', { class: 'ins-variant', 'aria-label': 'cost: what happens to the instruction', title: `Δ with the instruction ${VARIANTS[variant()]}` },
      h('option', { value: 'remove', text: 'removed' }), h('option', { value: 'nop', text: 'as NOP' }));
    sel.value = variant();
    sel.hidden = !(open.cost && available);
    sel.addEventListener('change', () => { open.nop = sel.value === 'nop'; env.onToggle?.(); redecorate(); });
    tools = h('span', { class: 'ins-cost-status' });
    return h('span', { class: 'ins ins-cost-tools' },
      h('label', { title: available ? 'change of cycles/iteration without each instruction (one analysis per instruction)' : reason }, box, ' cost'),
      ' ', sel, ' ', tools);
  }

  function addColumn(table, r) {
    const at = (tr) => tr.cells[2] ?? null; // after the instruction and the notes
    const head = table.tHead?.rows[0];
    if (head) head.insertBefore(h('th', { scope: 'col', class: 'ins ins-cost', title: `Δ cycles/iteration with the instruction ${VARIANTS[variant()]}; macro-fused pairs together; the loop's branch is kept`, text: 'Δ' }), at(head));
    cellsOf = new Map();
    const trs = table.tBodies[0]?.rows ?? [];
    r.rows.forEach((_, row) => {
      const tr = trs[row];
      if (!tr) return;
      const td = h('td', { class: 'ins ins-cost' });
      tr.insertBefore(td, at(tr));
      cellsOf.set(row, td);
    });
    const foot = table.tFoot?.rows[0];
    if (foot) foot.insertBefore(h('td', { class: 'ins ins-cost' }), at(foot));
  }

  function paint() {
    if (!job || !cellsOf) return;
    const cells = costCells(job.response, job.cu, results, job.variant);
    cells.forEach((c, row) => {
      const td = cellsOf.get(row);
      if (!td) return;
      td.textContent = c.text;
      td.className = ['ins', 'ins-cost', `ins-${c.kind}`, c.kind === 'value' ? (c.delta < 0 ? 'neg' : c.delta > 0 ? 'pos' : 'zero') : '', c.top ? 'top' : ''].filter(Boolean).join(' ');
      if (c.title) td.title = c.title; else td.removeAttribute('title');
    });
  }

  function paintTools(state) {
    if (!tools) return;
    tools.replaceChildren();
    if (state === 'waiting') {
      const b = h('button', { type: 'button', class: 'plain', text: `compute (${job.count} analyses)`, title: `about ${Math.max(1, Math.round(job.estimate / parallel(job.count) / 1000))} s` });
      b.addEventListener('click', () => { forcedKey = job.key; runner.schedule(0); });
      tools.append(b);
    } else if (state === 'running') {
      tools.append(h('span', { class: 'hint', text: `${results.size}/${job.count}` }));
    }
  }

  const runner = latestWins(async ({ isStale, signal }) => {
    if (!job || !open.cost) return;
    const j = job;
    const stale = () => isStale() || job !== j || !open.cost;
    if (doneKey === j.key) { setState('done'); return; }
    if (!j.jobs && j.estimate / parallel(j.count) > BUDGET_MS && forcedKey !== j.key) { waitingKey = j.key; setState('waiting'); paintTools('waiting'); return; }
    buildJobs(j);
    const todo = j.jobs.filter((x) => !results.has(x.unit));
    if (todo.length && j.estimate / parallel(todo.length) > BUDGET_MS && forcedKey !== j.key) { waitingKey = j.key; setState('waiting'); paintTools('waiting'); return; }
    await runJobs(j, todo, stale, signal);
  },{ onError: () => { setState('idle'); paintTools('idle'); } });

  const parallel = (n) => Math.max(1, Math.min(n, env.pool?.()?.size ?? 1)); // analyses that run at once

  function finished(j, t0) {
    doneKey = j.key;
    runs++;
    if (root) { root.dataset.costRuns = String(runs); root.dataset.costMs = (performance.now() - t0).toFixed(1); }
    setState('done');
    paintTools('done');
  }

  async function runJobs(j, todo, stale, signal) {
    setState('running');
    paintTools('running');
    const t0 = performance.now();
    const pool = env.pool?.();
    if (pool) {
      const same = new Map(); // resultKey -> the units whose blocks are the same (e.g. without one of two equal instructions)
      for (const x of todo) {
        const rk = resultKey(x.hex, j.arch, j.options);
        const c = cache.get(rk);
        if (c) results.set(x.unit, c); else if (same.has(rk)) same.get(rk).units.push(x.unit); else same.set(rk, { rk, units: [x.unit], request: makeRequest(x.hex, j.arch, j.options) });
      }
      paint();
      const ok = await pool.run([...same.values()], {
        signal, isStale: stale,
        onResult: ({ rk, units }, response, error) => {
          const r = error ? { error: error.message ?? String(error), transient: true } : summarize(response);
          if (!r.transient) cache.set(rk, r);
          if (job !== j) return;
          for (const u of units) results.set(u, r);
          paint();
          paintTools('running');
        },
      });
      if (ok && !stale()) finished(j, t0);
      return;
    }
    const engine = env.engine();
    for (const x of todo) {
      if (stale()) return;
      const rk = resultKey(x.hex, j.arch, j.options);
      let r = cache.get(rk);
      if (!r) {
        try {
          r = summarize(await engine.analyze(makeRequest(x.hex, j.arch, j.options)));
        } catch (e) {
          if (isCancel(e)) { if (job === j) { setState('idle'); paintTools('idle'); } return; } // the page stopped the analyzer: the next result reruns this
          r = { error: e?.message ?? String(e), transient: true };
        }
        if (!r.transient) cache.set(rk, r);
        if (!engine.capabilities?.cancel) await yieldToPage();
      }
      if (job !== j) return;
      results.set(x.unit, r);
      paint();
      paintTools('running');
    }
    if (stale()) return;
    finished(j, t0);
  }

  // ---- decorate -------------------------------------------------------------------------------------------------------

  function clean() {
    for (const e of root.querySelectorAll('.ins')) e.remove();
    for (const tr of root.querySelectorAll('tr.ins-on-chain')) {
      tr.classList.remove('ins-on-chain');
      delete tr.cells[0].dataset.chain;
      tr.cells[0].removeAttribute('title');
    }
    cellsOf = null;
    tools = null;
  }

  function decorate(target, v) {
    root = target;
    view = v;
    const r = v?.response;
    const table = root.querySelector('table.uops');
    if (!r || r.error || !Array.isArray(r.rows) || !table) { job = null; setState('off'); return; }
    clean();

    const info = chainInfo(r);
    if (info) {
      const after = root.querySelector('.limits')?.closest('.row');
      const row = chainRow(r, info);
      if (after) after.after(row); else table.closest('.row')?.before(row);
      if (r.bottlenecks.includes('Dependencies')) markChain(table, r, info);
    }

    const cu = r.mock ? { ok: false, reason: 'not with mock data' } : costUnits(r, v.hex);
    root.querySelector('.table-tools')?.append(toggle(cu.ok, cu.reason));
    if (!cu.ok || !open.cost) { job = null; runner.cancel(); setState(cu.ok ? 'off' : 'unavailable'); return; }

    addColumn(table, r);
    const opts = { ...v.request };
    delete opts.hex; delete opts.arch; delete opts.includeTrace;
    const key = costKey(v.hex, v.archKey, opts, variant());
    if (!job || job.key !== key) {
      // the blocks of the jobs (one per instruction, each almost the whole block) are made only when they run: a large
      // block waits for a click first
      const count = cu.units.filter((u) => !u.fixed).length;
      job = { key, hex: v.hex, arch: v.archKey, options: opts, cu, jobs: null, count, response: r, variant: variant(), estimate: (v.elapsedMs ?? 0) * count };
      results = new Map();
      doneKey = null;
      if (job.estimate / parallel(count) <= BUDGET_MS || forcedKey === key) {
        buildJobs(job);
        if (job.jobs.every((x) => results.has(x.unit))) doneKey = key;
      }
    } else {
      job.response = r; job.cu = cu;
    }
    paint();
    if (doneKey === key) { setState('done'); paintTools('done'); return; }
    if (waitingKey === key && forcedKey !== key) { setState('waiting'); paintTools('waiting'); return; }
    setState('queued');
    runner.schedule(DELAY);
  }

  function redecorate() { if (root && view) decorate(root, view); }

  function buildJobs(j) {
    if (j.jobs) return;
    j.jobs = costJobs(j.cu.units, j.hex, j.variant);
    j.count = j.jobs.length;
    for (const x of j.jobs) { const c = cache.get(resultKey(x.hex, j.arch, j.options)); if (c) results.set(x.unit, c); }
  }

  return {
    decorate,
    setOpen({ cost = false, nop = false }) { open.cost = !!cost; open.nop = !!nop; },
    open() { return { cost: open.cost, nop: open.nop }; },
  };
}
