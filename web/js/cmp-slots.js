// The issue slots per CPU in the table of the checked CPUs (compare-view.js): one small stacked bar per row (issued, or
// lost to the front end, the ROB, the RS, other: slots.js), with the shares in its tooltip. Only while the bound view is
// open (the slots are part of its breakdown): the details of each CPU are one more analysis each (`details: true`), on
// the pool if the page has one, in the background, once per (code, CPU, options); the table is decorated after every
// redraw (compare-view.js calls decorate(table)).
//
// No DOM in slotsTitle (tests-js/web_cmp_slots.mjs runs it under Node).

import { h } from './render.js';
import { makeRequest } from './engine.js';
import { slotParts } from './slots.js';

export function slotsTitle(issue) {
  const parts = slotParts(issue);
  if (!parts) return '';
  return parts.filter((p) => p.share >= 0.005).map((p) => `${p.name} ${Math.round(p.share * 100)}%`).join(' · ');
}

const isCancel = (e) => e?.name === 'CancelledError';

// env: { engine(), pool(), enabled() (the bound view is open) }. decorate(table, input): input {hex, options} of the
// table (compare-view.js); decorate() again (no arguments) after the bound view was opened or closed.
export function createCmpSlots(env) {
  const cache = new Map(); // key -> details.issue | null
  const pending = new Map();
  let last = null, lastInput = null; // the table decorated last, and its input
  const keyOf = (hex, arch, options) => JSON.stringify([hex, arch, options]);

  function fetchIssue(hex, arch, options) {
    const k = keyOf(hex, arch, options);
    if (cache.has(k)) return Promise.resolve(cache.get(k));
    if (pending.has(k)) return pending.get(k);
    const request = { ...makeRequest(hex, arch, options), details: true };
    // out of date: the table shows other code or options now, or the bound view was closed (not cached: asked again)
    const isStale = () => !env.enabled?.() || !lastInput || keyOf(lastInput.hex, arch, lastInput.options) !== k;
    const p = (async () => {
      try {
        const pool = env.pool?.();
        let res = null;
        if (isStale()) return undefined; // undefined: stale, nothing to show
        if (pool) await pool.run([{ job: arch, request }], { isStale, onResult: (_, response) => { res = response; } });
        else res = await env.engine().analyze(request);
        if (!res) return undefined;
        const issue = res.details?.issue ?? null;
        if (cache.size >= 256) cache.clear(); // (keys hold the code: keep the memory bounded)
        cache.set(k, issue);
        return issue;
      } catch (e) {
        if (!isCancel(e)) cache.set(k, null);
        return null;
      } finally {
        pending.delete(k);
      }
    })();
    pending.set(k, p);
    return p;
  }

  function cell(issue) {
    const parts = slotParts(issue);
    if (!parts) return h('span', { class: 'hint', text: '–' });
    return h('span', { class: 'sl-bar cs-bar', title: slotsTitle(issue), 'aria-label': `issue slots: ${slotsTitle(issue)}` }, parts.filter((p) => p.share > 0).map((p) => {
      const seg = h('span', { class: `sl-seg sl-${p.key}` });
      seg.style.width = `${(p.share * 100).toFixed(2)}%`;
      return seg;
    }));
  }

  function decorate(table = last, inp = lastInput) {
    last = table; lastInput = inp;
    if (!table?.isConnected || !inp) return;
    if (!env.enabled?.()) { for (const c of table.querySelectorAll('.cs-col')) c.remove(); return; }
    const head = table.querySelector('thead tr');
    if (!head || head.querySelector('.cs-col')) return;
    head.append(h('th', { scope: 'col', class: 'cs-col', title: 'issue slots of the steady state: issued, or lost to the front end, the ROB, the RS, other', text: 'slots' }));
    const rows = [...table.querySelectorAll('tbody tr[data-arch]')];
    const cells = rows.map((tr) => { const td = h('td', { class: 'cs-col' }); tr.append(td); return [tr.dataset.arch, td, tr]; });
    for (const [arch, td, tr] of cells) {
      if (tr.classList.contains('error')) continue;
      const k = keyOf(inp.hex, arch, inp.options);
      if (cache.has(k)) { td.replaceChildren(cell(cache.get(k))); continue; }
      td.dataset.state = 'loading';
      fetchIssue(inp.hex, arch, inp.options).then((issue) => {
        if (issue === undefined) return; // out of date: a newer table asks again
        if (!td.isConnected) { if (last?.isConnected) decorateCell(last, arch, issue); return; }
        td.replaceChildren(cell(issue));
        delete td.dataset.state;
      });
    }
  }
  // a cell of a table redrawn meanwhile
  function decorateCell(table, arch, issue) {
    const td = table.querySelector(`tbody tr[data-arch="${CSS.escape(arch)}"] td.cs-col`);
    if (td && td.dataset.state === 'loading') { td.replaceChildren(cell(issue)); delete td.dataset.state; }
  }

  return { decorate, slotsTitle };
}
