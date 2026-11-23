// A–B: the issue slots of both sides (slots.js: issued, or lost to the front end, the ROB, the RS, other), one stacked
// bar each, under the bottleneck row of the comparison (ab.js). A fold, closed by default: the details of each side
// (one more analysis per side, with `details: true`: details.js) are fetched only while it is open, once per result.
// app.js calls decorate(body, abView) after each A–B result is drawn.
//
// No DOM in abSlotsDelta (tests-js/web_ab_slots.mjs runs it under Node).

import { h } from './render.js';
import { makeRequest } from './engine.js';
import { detailsFit } from './details.js';
import { slotParts, slotsLine } from './slots.js';

// the change of each part's share from A to B: [{key, name, a, b, delta}] (shares 0..1), or null without both
export function abSlotsDelta(issueA, issueB) {
  const a = slotParts(issueA), b = slotParts(issueB);
  if (!a || !b) return null;
  return a.map((p, k) => ({ key: p.key, name: p.name, a: p.share, b: b[k].share, delta: b[k].share - p.share }));
}

const pct = (x) => `${Math.round(x * 100)}%`;
const isCancel = (e) => e?.name === 'CancelledError';

// env: { engine(), options() (the analysis options of the page) }
export function createABSlots(env) {
  let open = false;
  const done = new WeakMap(); // side view -> details.issue | null
  let shown = null;           // the A–B view drawn last

  async function issueOf(side) {
    if (!side?.response || side.response.error || side.response.mock || !env.engine?.()) return null;
    if (done.has(side)) return done.get(side);
    try {
      const res = await env.engine().analyze({ ...(side.request ?? makeRequest(side.hex, side.archKey, env.options?.() ?? {})), details: true });
      const issue = detailsFit(side.response, res) ? res.details.issue ?? null : null;
      done.set(side, issue);
      return issue;
    } catch (e) {
      if (!isCancel(e)) done.set(side, null);
      return null;
    }
  }

  async function fill(view, body, summary) {
    body.dataset.state = 'loading';
    const [a, b] = [await issueOf(view.a), await issueOf(view.b)];
    if (shown !== view || !body.isConnected) return;
    const line = (tag, issue) => {
      const l = issue ? slotsLine(issue) : null;
      if (!l) return h('div', { class: 'bd-group bd-slots' }, h('span', { class: 'bd-g', text: tag }), h('span', { class: 'hint', text: '–' }));
      const g = l.querySelector('.bd-g');
      g.textContent = tag;
      return l;
    };
    body.replaceChildren(line('A', a), line('B', b));
    const d = abSlotsDelta(a, b);
    if (d) {
      const issued = d[0];
      summary.textContent = `issued ${pct(issued.a)} → ${pct(issued.b)}`;
      summary.title = d.filter((x) => x.a > 0.004 || x.b > 0.004).map((x) => `${x.name}: A ${pct(x.a)}, B ${pct(x.b)}`).join(' · ');
    }
    body.dataset.state = 'done';
  }

  return {
    decorate(root, view) {
      shown = view;
      if (!view || !root) return;
      const okA = view.a?.response && !view.a.response.error, okB = view.b?.response && !view.b.response.error;
      if (!okA && !okB) return;
      const summary = h('span', { title: 'issue slots of the steady state: issued, or lost and why', text: 'issue slots' });
      const body = h('div', { class: 'ab-slots bd-body' });
      const fold = h('details', { class: 'ab-fold', id: 'ab-slots' }, h('summary', null, summary), body);
      fold.open = open;
      fold.addEventListener('toggle', () => {
        open = fold.open;
        if (open && body.dataset.state !== 'done') fill(view, body, summary);
      });
      const row = h('div', { class: 'row', id: 'ab-slots-row' }, h('div', { class: 'label', text: 'slots' }), h('div', { class: 'field' }, fold));
      // after the bottleneck row (both sides have a result), else after the throughput
      const leads = [...root.querySelectorAll(':scope > .row.lead')];
      const after = leads[1] ?? leads[0];
      if (after) after.after(row); else root.prepend(row);
      if (open) fill(view, body, summary);
    },
  };
}
