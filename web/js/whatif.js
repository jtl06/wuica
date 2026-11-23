// What-if experiments: the whole block re-analyzed with one change each (Facile's and MAQAO CQA's counterfactuals):
// unrolled ×2/×4/×8, N accumulators (unrolled with the chain's register renamed in each copy: accum.js; the best N is
// marked, and with several CPUs checked, the best N of each), an ideal front end, macro- or micro-fusion switched, and
// the estimate without the critical chain.
// Each is shown per original iteration, with Δ and the speedup; a link opens the variant in a new tab. The analyses run
// only while the view is open (on the worker pool if the page has one), are cached, and a large block waits for a click.
//
// The first half has no DOM (tests-js/web_whatif.mjs runs it under Node).

import { h } from './render.js';
import { makeRequest } from './engine.js';
import { summarize, resultKey, ResultCache, latestWins } from './compare.js';
import { encodeState } from './url-state.js';
import { ACCUMULATORS, accumulatorText, bestAccumulators } from './accum.js';
import { toHex } from './hex-input.js';

const BUDGET_MS = 2000; // more (estimated) waits for a click
const UNROLL = [2, 4, 8];
const f2 = (x) => Number(x).toFixed(2);
const isCancel = (e) => e?.name === 'CancelledError';

// The instructions of a response as byte ranges of the code: [{row, start, end, fused}], or null if the rows do not
// make up the code (undecodable bytes).
export function instrRanges(response, hex) {
  const rows = response?.rows;
  if (!Array.isArray(rows)) return null;
  const out = [];
  let at = 0;
  rows.forEach((x, row) => {
    if (x.kind !== 'instr') return;
    const op = String(x.opcode ?? '').toLowerCase();
    out.push({ row, start: at, end: at + op.length / 2, op, fused: x.notes === 'M' });
    at += op.length / 2;
  });
  if (!out.length || out.map((i) => i.op).join('') !== String(hex ?? '').toLowerCase()) return null;
  return out;
}

// The loop unrolled n times: n copies of the body, then the loop's branch once (with the instruction it is macro-fused
// with). Registers are not renamed: the dependencies stay; what goes is the loop overhead (n − 1 branches and their
// compares) and the front end sees a longer body. {ok, hex, tail} or {ok: false, reason}.
export function unrollHex(response, hex, n) {
  if (response?.mode !== 'loop') return { ok: false, reason: 'not a loop' };
  const ins = instrRanges(response, hex);
  if (!ins) return { ok: false, reason: 'the code has bytes that are not instructions' };
  const last = ins.length - 1;
  const tailFrom = ins[last].fused && last > 0 ? ins[last - 1].start : ins[last].start;
  if (tailFrom === 0) return { ok: false, reason: 'nothing but the branch' };
  const code = String(hex).toLowerCase();
  return { ok: true, hex: code.slice(0, 2 * tailFrom).repeat(n) + code.slice(2 * tailFrom), tail: tailFrom === ins[last].start ? 1 : 2 };
}

const FLAGS = [
  ['simpleFrontEnd', 'simple front end', 'detailed front end', 'a front end limited only by the issue width (uiCA -simpleFrontEnd); not always faster'],
  ['noMacroFusion', 'no macro-fusion', 'macro-fusion', 'compare and branch not fused (uiCA -noMacroFusion)'],
  ['noMicroFusion', 'no micro-fusion', 'micro-fusion', 'load and operation not fused (uiCA -noMicroFusion)'],
];

// The experiments for a response: [{id, label, title, hex, options, per}] (analyses) and, if the chain is a limit,
// {id: 'nochain', label, estimate, title} (no analysis: the largest other limit, as uiCA computes them).
// The accumulator variants have `text` (assembly, accum.js) instead of hex until it is assembled; one that cannot be
// made has `error` (one row, 'acc').
//   options: the request's options (alignmentOffset, ..., without hex, arch, includeTrace)
export function experiments(response, hex, options) {
  const out = [];
  for (const n of UNROLL) {
    const u = unrollHex(response, hex, n);
    if (u.ok) out.push({ id: `unroll${n}`, label: `unroll ×${n}`, per: n, hex: u.hex, options,
      title: `${n} copies of the loop body and one branch${u.tail === 2 ? ' (with its macro-fused compare)' : ''}; registers not renamed, so the dependencies stay; per original iteration` });
  }
  if (response?.mode === 'loop' && response.criticalPath?.edges?.length) {
    for (const n of ACCUMULATORS) {
      const a = accumulatorText(response, hex, n);
      if (!a.ok) { if (n === ACCUMULATORS[0]) out.push({ id: 'acc', label: 'accumulators', per: 1, error: a.reason, options, title: `N accumulators: ${a.reason}` }); break; }
      const names = a.renamed.map((x) => `${x.from} → ${x.to.join(', ')}`).join('; ');
      out.push({ id: `acc${n}`, label: `${n} accumulators`, per: n, text: a.text, options,
        title: `unrolled ×${n} with the chain's register renamed in each copy (${names}): ${n} independent chains; per original iteration` });
    }
  }
  for (const [k, on, off, what] of FLAGS) {
    const v = !options?.[k];
    out.push({ id: k, label: v ? on : off, per: 1, hex: String(hex).toLowerCase(), options: { ...options, [k]: v }, title: v ? what : `${off} (as without uiCA -${k})` });
  }
  const lims = Array.isArray(response?.limits) ? response.limits : [];
  const dep = lims.find((l) => l.name === 'Dependencies');
  const others = lims.filter((l) => l.name !== 'Dependencies').map((l) => Number(l.tp));
  if (dep && others.length) {
    const est = Math.max(...others);
    out.push({ id: 'nochain', label: 'no chain', estimate: est, per: 1,
      title: `at best the largest other limit (${lims.filter((l) => l.name !== 'Dependencies' && Number(l.tp) === est).map((l) => l.name).join(', ')}): an estimate without the loop-carried dependencies, not a simulation` });
  }
  return out;
}

// One result line: {tp (per original iteration), delta, speedup, comparable} from a summary ({tp, mode} or {error}).
export function outcome(base, exp, r) {
  if (exp.error) return { error: exp.error };
  if (exp.estimate !== undefined) {
    const tp = exp.estimate;
    return { tp, delta: tp - base.tp, speedup: tp > 0 ? base.tp / tp : Infinity, estimate: true };
  }
  if (!r) return null;
  if (r.error) return { error: r.error };
  if (r.mode && base.mode && r.mode !== base.mode) return { error: `analyzed ${r.mode === 'loop' ? 'as a loop' : 'unrolled'}: not comparable` };
  const tp = r.tp / exp.per;
  return { tp, delta: tp - base.tp, speedup: tp > 0 ? base.tp / tp : Infinity };
}

export const formatDelta = (d) => (Math.abs(d) < 0.005 ? '0.00' : `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`);
export const formatSpeedup = (s) => (Number.isFinite(s) ? `×${s.toFixed(2)}` : '—');

// The fragment of the page with a variant (machine code without spaces: the fragment takes up to 200,000 characters,
// enough for 100 kB of code, e.g. SHA-256 unrolled ×8).
export const variantFragment = (exp, arch) => encodeState({ mode: 'hex', text: exp.hex, arch, cpus: '', ...exp.options });

// The size of an experiment relative to the block (the time of its analysis grows about linearly).
export const weight = (exp, baseBytes) => (exp.estimate !== undefined || exp.error ? 0 : exp.hex ? (exp.hex.length / 2) / Math.max(1, baseBytes) : exp.per);

// The best number of accumulators from the base throughput and the results of the accumulator variants ({n, tp} or
// null if none has a result).
export function bestOf(baseTp, exps, results) {
  const tps = new Map([[1, Number(baseTp)]]);
  for (const x of exps) {
    if (!/^acc\d+$/.test(x.id)) continue;
    const r = results.get(x.id);
    if (r && !r.error && Number.isFinite(r.tp)) tps.set(x.per, r.tp / x.per);
  }
  return tps.size > 1 ? bestAccumulators(tps) : null;
}

// ---- the view ----------------------------------------------------------------------------------------------------

// env: { engine(), pool(), onToggle(open), assemble(text) -> promise of the assembler's result (Intel syntax; the
// accumulator variants) or null, cpus() -> the checked CPUs' keys (the best number of accumulators of each) }
export function createWhatIf(env) {
  const cache = new ResultCache(512);
  const asmCache = new Map(); // accumulator text -> {hex} | {error}
  let open = false;
  let row = null, details = null, body = null;
  let view = null;
  let job = null;        // {key, base, exps, results: Map id -> summary, others: [arch], cpuResults: Map 'arch|id' -> summary}
  let forcedKey = null;

  // the accumulator variants as machine code (once per text)
  async function assembleAll(j, stale) {
    for (const x of j.exps) {
      if (!x.text || x.hex || j.results.has(x.id)) continue;
      let a = asmCache.get(x.text);
      if (!a) {
        let r = null;
        try { r = await env.assemble?.(x.text); } catch (e) { r = { ok: false, diagnostics: [{ message: e?.message ?? String(e) }] }; }
        if (stale()) return false;
        a = r?.ok && r.bytes?.length ? { hex: toHex(r.bytes) } : { error: r ? `does not assemble: ${r.diagnostics?.find((d) => d.severity !== 'warning')?.message ?? 'error'}` : 'no assembler' };
        asmCache.set(x.text, a);
      }
      if (a.hex) x.hex = a.hex; else j.results.set(x.id, { error: a.error });
    }
    return true;
  }

  // the analyses still to do: [{key, arch, x, store(r)}]; the other CPUs' only with the worker pool
  function todoOf(j, pool) {
    const out = [];
    for (const x of j.exps) {
      if (x.estimate !== undefined || x.error || !x.hex || j.results.has(x.id)) continue;
      out.push({ key: x.id, arch: j.arch, x, store: (r) => j.results.set(x.id, r) });
    }
    if (!pool) return out;
    const accs = j.exps.filter((x) => /^acc\d+$/.test(x.id) && x.hex);
    if (!accs.length) return out;
    for (const arch of j.others) {
      const base = { id: 'base', hex: j.hex, options: j.options };
      for (const x of [base, ...accs]) {
        const key = `${arch}|${x.id}`;
        if (j.cpuResults.has(key)) continue;
        out.push({ key, arch, x, store: (r) => j.cpuResults.set(key, r) });
      }
    }
    return out;
  }

  const runner = latestWins(async ({ isStale, signal }) => {
    const j = job;
    if (!j || !open) return;
    const stale = () => isStale() || job !== j || !open;
    setState('running');
    if (!(await assembleAll(j, stale))) return;
    paint();
    const pool = env.pool?.();
    const todo = todoOf(j, pool);
    if (!todo.length) { setState('done'); return; }
    if (pool) {
      const ok = await pool.run(todo.map((t) => ({ t, arch: t.arch, request: makeRequest(t.x.hex, t.arch, t.x.options) })), {
        signal, isStale: stale,
        onResult: ({ t }, response, error) => {
          const r = error ? { error: error.message ?? String(error), transient: true } : summarize(response);
          if (!r.transient) cache.set(resultKey(t.x.hex, t.arch, t.x.options), r);
          if (job !== j) return;
          t.store(r);
          paint();
        },
      });
      if (ok && !stale()) setState('done');
      return;
    }
    const engine = env.engine?.();
    for (const t of todo) {
      if (stale()) return;
      let r;
      try { r = summarize(await engine.analyze(makeRequest(t.x.hex, t.arch, t.x.options))); } catch (e) {
        if (isCancel(e)) { setState('idle'); return; }
        r = { error: e?.message ?? String(e), transient: true };
      }
      if (!r.transient) cache.set(resultKey(t.x.hex, t.arch, t.x.options), r);
      if (job !== j) return;
      t.store(r);
      paint();
      await new Promise((res) => setTimeout(res, 0));
    }
    if (!stale()) setState('done');
  }, { onError: () => setState('idle') });

  function setState(s) { if (body) body.dataset.state = s; if (s === 'done' || s === 'idle') paint(); }

  function ensureRow() {
    if (row?.isConnected) return row;
    details = h('details', { class: 'wi', id: 'whatif' }, h('summary', { title: 'the block re-analyzed with one change each' }, 'experiments'));
    details.open = open;
    let last = open;
    details.addEventListener('toggle', () => {
      if (details.open === last) return;
      last = open = details.open;
      env.onToggle?.(open);
      update();
    });
    body = h('div', { class: 'wi-body' });
    details.append(body);
    row = h('div', { class: 'row', id: 'whatif-row' }, h('div', { class: 'label', text: 'try', title: 'what if' }), h('div', { class: 'field' }, details));
    const more = document.getElementById('more');
    const before = document.getElementById('sweep-row');
    if (before?.parentNode === more) more.insertBefore(row, before); else more?.append(row);
    return row;
  }

  function variantLink(x) {
    const a = h('a', { class: 'wi-open', href: '#', target: '_blank', rel: 'noopener', 'aria-label': `open "${x.label}" in a new tab`, title: 'open this variant in a new tab (as machine code)', text: '↗' });
    const fill = () => {
      a.href = `${location.pathname}#${variantFragment(x, job.arch)}`;
    };
    for (const ev of ['pointerenter', 'focus', 'pointerdown', 'click']) a.addEventListener(ev, fill);
    return a;
  }

  // "best N: SKL 3 · ZEN3 3" for the checked CPUs (this one from the table's results), when there are several
  function bestLine() {
    const { base, exps, results, others, cpuResults, arch } = job;
    if (!others.length || !exps.some((x) => /^acc\d+$/.test(x.id) && x.hex)) return null;
    const parts = [arch, ...others].map((a) => {
      let best;
      if (a === arch) best = bestOf(base.tp, exps, results);
      else {
        const b = cpuResults.get(`${a}|base`);
        const rs = new Map(exps.map((x) => [x.id, cpuResults.get(`${a}|${x.id}`)]).filter(([, r]) => r));
        best = b && !b.error && exps.every((x) => !/^acc\d+$/.test(x.id) || !x.hex || rs.has(x.id)) ? bestOf(b.tp, exps, rs) : undefined;
      }
      return `${a} ${best === undefined ? '…' : best ? best.n : '—'}`;
    });
    return h('p', { class: 'wi-best', title: 'the best number of accumulators on each checked CPU: the smallest within 1% of the fastest (1: as it is)' }, `best N: ${parts.join(' · ')}`);
  }

  function paint() {
    if (!row || !open || !job) return;
    const { base, exps, results } = job;
    const best = bestOf(base.tp, exps, results);
    const done = exps.filter((x) => /^acc\d+$/.test(x.id)).every((x) => results.has(x.id));
    const lines = exps.map((x) => {
      const o = outcome(base, x, results.get(x.id));
      const cells = !o ? [h('td', { class: 'wi-tp hint', text: '…' }), h('td'), h('td')]
        : o.error ? [h('td', { class: 'wi-tp hint', title: o.error, text: '—' }), h('td'), h('td')]
          : [h('td', { class: 'wi-tp', text: `${o.estimate ? '≥' : ''}${f2(o.tp)}` }),
            h('td', { class: `wi-d ${o.delta < -0.005 ? 'neg' : o.delta > 0.005 ? 'pos' : ''}`, text: formatDelta(o.delta) }),
            h('td', { class: `wi-x ${o.speedup > 1.005 ? 'neg' : o.speedup < 0.995 ? 'pos' : ''}`, text: `${o.estimate ? '≤' : ''}${formatSpeedup(o.speedup)}` })];
      const isBest = done && best && best.n > 1 && x.id === `acc${best.n}`;
      return h('tr', { 'data-id': x.id, class: isBest ? 'wi-best-row' : null }, h('th', { scope: 'row', title: x.title + (isBest ? '\nthe best number of accumulators: the smallest within 1% of the fastest' : ''), text: x.label + (isBest ? ' ★' : '') }), cells,
        h('td', { class: 'wi-link' }, x.estimate === undefined && x.hex ? variantLink(x) : null));
    });
    const table = h('table', { class: 'grid wi-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'variant' }), h('th', { scope: 'col', title: 'cycles per original iteration', text: 'cycles' }),
        h('th', { scope: 'col', title: `change from ${f2(base.tp)}`, text: 'Δ' }), h('th', { scope: 'col', title: 'speedup', text: '×' }), h('th', null, h('span', { class: 'vh', text: 'open' })))),
      h('tbody', null, lines));
    const waiting = body.dataset.state === 'waiting';
    let go = null;
    if (waiting) {
      go = h('button', { type: 'button', class: 'plain wi-go', text: `compute (${exps.filter((x) => x.estimate === undefined && !x.error).length} analyses)`, title: `about ${Math.max(1, Math.round(job.estimate / 1000))} s` });
      go.addEventListener('click', () => { forcedKey = job.key; body.dataset.state = 'queued'; runner.schedule(0); });
    }
    body.replaceChildren(...(go ? [h('p', { class: 'wi-wait' }, go)] : []), h('div', { class: 'table-wrap' }, table), ...(waiting ? [] : [bestLine()].filter(Boolean)));
  }

  function update() {
    ensureRow();
    const r = view?.response;
    const ok = r && !r.error && Array.isArray(r.rows) && !r.mock && view.hex;
    row.hidden = !ok;
    if (!ok) { job = null; runner.cancel(); return; }
    if (!open) { body.replaceChildren(); body.dataset.state = 'closed'; runner.cancel(); return; }
    const options = { ...view.request };
    delete options.hex; delete options.arch; delete options.includeTrace;
    // the other checked CPUs (only with the worker pool: their analyses run there)
    const others = env.pool?.() ? (env.cpus?.() ?? []).filter((a) => a !== view.archKey) : [];
    const key = `${resultKey(view.hex, view.archKey, options)}|${others.join(',')}`;
    if (!job || job.key !== key) {
      const exps = experiments(r, view.hex, options);
      const bytes = view.hex.length / 2;
      const results = new Map();
      const cpuResults = new Map();
      for (const x of exps) {
        if (x.text) { const a = asmCache.get(x.text); if (a?.hex) x.hex = a.hex; else if (a?.error) results.set(x.id, { error: a.error }); }
        if (x.estimate !== undefined || !x.hex) continue;
        const c = cache.get(resultKey(x.hex, view.archKey, x.options));
        if (c) results.set(x.id, c);
      }
      for (const a of others) {
        const c = cache.get(resultKey(view.hex, a, options));
        if (c) cpuResults.set(`${a}|base`, c);
        for (const x of exps) if (x.hex && /^acc\d+$/.test(x.id)) { const cx = cache.get(resultKey(x.hex, a, x.options)); if (cx) cpuResults.set(`${a}|${x.id}`, cx); }
      }
      const pending = exps.filter((x) => x.estimate === undefined && !x.error && !results.has(x.id));
      const estimate = (view.elapsedMs ?? 0) * pending.reduce((s, x) => s + weight(x, bytes), 0) / Math.max(1, env.pool?.()?.size ?? 1);
      job = { key, base: { tp: Number(r.tp), mode: r.mode }, exps, results, arch: view.archKey, hex: view.hex, options, others, cpuResults, estimate };
    }
    const todo = job.exps.some((x) => x.estimate === undefined && !x.error && !job.results.has(x.id))
      || (job.others.length && job.exps.some((x) => /^acc\d+$/.test(x.id) && !x.error) && job.others.some((a) => !job.cpuResults.has(`${a}|base`)));
    if (!todo) body.dataset.state = 'done';
    else if (job.estimate > BUDGET_MS && forcedKey !== job.key) body.dataset.state = 'waiting';
    else { body.dataset.state = 'queued'; runner.schedule(50); }
    paint();
  }

  return {
    decorate(target, v) { view = v; update(); },
    setOpen(o) { open = !!o; if (details) details.open = open; },
    open: () => open,
  };
}
