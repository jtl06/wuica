// The issue slots of the steady state (VTune's top-down level 1, from the simulation itself): of issue width × cycles, the
// share that issued a uop, and the lost shares by the cause the simulation had: the front end delivered too few (IDQ
// empty), the reorder buffer or the scheduler was full (back end), other (a uop that did not fit, serialization, merge
// uops). From details.issue of the response with details (details.js); one stacked bar in the bound view.
//
// No DOM except slotsLine (tests-js/web_details.mjs runs slotParts under Node).

import { h } from './render.js';

export const SLOT_PARTS = Object.freeze([
  ['issued', 'issued', 'slots that issued a uop'],
  ['frontEnd', 'front end', 'lost: the front end delivered too few uops (the IDQ ran empty)'],
  ['rob', 'ROB', 'lost: the reorder buffer was full'],
  ['rs', 'RS', 'lost: the scheduler (reservation station) was full'],
  ['other', 'other', 'lost: the next uop did not fit into the cycle, a serializing instruction, or merge uops'],
]);

// [{key, name, title, slots, share}] (slots per iteration, share of all slots), or null
export function slotParts(issue) {
  const s = issue?.slots;
  if (!s || !(issue.width > 0)) return null;
  const total = SLOT_PARTS.reduce((n, [k]) => n + (Number(s[k]) || 0), 0);
  if (!(total > 0)) return null;
  return SLOT_PARTS.map(([key, name, title]) => ({ key, name, title, slots: Number(s[key]) || 0, share: (Number(s[key]) || 0) / total }));
}

export function slotsLine(issue) {
  const parts = slotParts(issue);
  if (!parts) return null;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const bar = h('span', { class: 'sl-bar', 'aria-hidden': 'true' }, parts.filter((p) => p.share > 0).map((p) => {
    const seg = h('span', { class: `sl-seg sl-${p.key}` });
    seg.style.width = `${(p.share * 100).toFixed(2)}%`;
    return seg;
  }));
  const keys = parts.filter((p) => p.share >= 0.005).map((p) => h('span', { class: 'sl-k', title: `${p.title}: ${p.slots.toFixed(2)} of ${issue.width} slots × ${(issue.cycles / issue.iterations).toFixed(2)} cycles per iteration` },
    h('span', { class: `sl-sw sl-${p.key}` }), `${p.name} ${pct(p.share)}`));
  return h('div', { class: 'bd-group bd-slots' }, h('span', { class: 'bd-g', text: 'slots', title: `issue slots (${issue.width} per cycle) of the steady state, ${issue.iterations} iterations: issued, or lost and why` }),
    h('span', { class: 'sl' }, bar, h('span', { class: 'sl-keys' }, keys)));
}
