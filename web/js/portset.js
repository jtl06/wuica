// The Ports limit, drilled down: the set of ports behind it (Facile's port model, as the simulator computes the limit:
// details.ports of the response with details, details.js) and which instructions load it: the uops of each row that can
// only use these ports. The bound view (bound.js) uses it for "Ports" instead of the busiest simulated ports once the
// details are there.
//
// No DOM except setLine (tests-js/web_details.mjs runs the rest under Node).

import { h } from './render.js';
import { shortPort } from './bound.js';

// "p0156" for Intel's ports, "ALU0 ALU1" otherwise
export function setName(ports) {
  const names = (ports ?? []).map(shortPort);
  return names.every((n) => /^p\w$/.test(n)) ? 'p' + names.map((n) => n.slice(1)).join('') : names.join(' ');
}

// {weights, total, max, unit, ports, set: {name, uops, n, tp}} as bound.js's blame(), or null
export function portSetBlame(response, ps) {
  const n = response?.rows?.length ?? 0;
  if (!ps || !Array.isArray(ps.rows) || ps.rows.length !== n || !Array.isArray(ps.ports) || !ps.ports.length) return null;
  const w = new Float64Array(n);
  let total = 0, max = 0;
  ps.rows.forEach((x, k) => { const v = Number(x) || 0; w[k] = v; total += v; if (v > max) max = v; });
  if (!(total > 0)) return null;
  return { weights: w, total, max, unit: 'uops', ports: ps.ports.map(shortPort), set: { name: setName(ps.ports), uops: Number(ps.uops), n: ps.ports.length, tp: Number(ps.tp) } };
}

// marks the uop table's columns of the set's ports (null: none)
export function markPorts(root, ports) {
  const ths = root?.querySelectorAll?.('table.uops thead th') ?? [];
  for (const th of ths) {
    const on = !!ports && ports.includes(th.dataset.col ?? th.textContent); // ("Port 0" is shown as "P0": render.js)
    th.classList.toggle('ps-on', on);
    if (on) th.title = `${th.dataset.col ?? ''} in the port set behind the Ports limit`.trim(); else if (th.classList.contains('ps-was')) { if (th.dataset.col && th.dataset.col !== th.textContent) th.title = th.dataset.col; else th.removeAttribute('title'); }
    th.classList.toggle('ps-was', on);
  }
}

// one line: the set, its uops per iteration and the cycles they need
export function setLine(b) {
  const s = b.set;
  return h('div', { class: 'bd-group bd-set' }, h('span', { class: 'bd-g', text: 'set', title: 'the ports behind the Ports limit: the uops that can only use them, per port' }),
    h('span', { class: 'bd-items' }, h('span', { class: 'code', text: s.name }),
      h('span', { class: 'bd-share', title: `${s.uops.toFixed(2)} uops/iteration can only use these ${s.n} ports: at least ${s.tp.toFixed(2)} cycles/iteration` },
        ` ${+s.uops.toFixed(2)} uops / ${s.n} = ${s.tp.toFixed(2)}`)));
}
