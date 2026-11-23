// The cycle range of the trace on the page (the data: trace-range.js):
// - in the trace (trace.js calls attachRange for the single-mode viewer): a drag over the head (the cycle axis, the port
//   strips, the issue strip) selects cycles; [ and ] on the focused timeline set the start and the end (at the uop under
//   the keyboard focus, else at the first / last cycle in view); Esc, a click on the head or × clears. The range is drawn
//   as a band, the port and issue shares in the head's gutter are the range's, and a chip in the tools names it.
// - in the bound view (bound.js calls rangeGroup): while a range of the shown run is selected, its ports and issue slots
//   replace the steady-state breakdown.
// Another run clears the range. Closing the trace does not: the trace and the bound view are tabs of the result
// (workspace.js), so a range picked in the trace is shown in the bound tab.

import { h } from './render.js';
import { traceRange, rangeStats, rangeSlotParts, steadyShares } from './trace-range.js';

const shortPort = (name) => { const m = /^Port (\w+)$/.exec(name); return m ? `p${m[1]}` : name; }; // as bound.js (no import cycle)
const pct = (x) => `${Math.round(x * 100)}%`;
const label = (r) => (r.a === r.b ? `c ${r.a}` : `c ${r.a}–${r.b}`);
const HEAD_KEYS = 'the cycles under a drag on the head of the trace, or [ and ] on the focused timeline';

// where the focus goes from the bound view once its range is gone: its summary, or its tab when the tabbed workspace
// hides the summary of the open view (workspace.js, dense.css)
function home(el) {
  const sum = el.closest('details')?.querySelector(':scope > summary');
  if (sum && sum.getClientRects().length) return sum;
  return document.querySelector('.view-tab[aria-selected="true"]') ?? sum;
}

// focus(): where the focus goes once the button is gone or hidden
function clearButton(focus) {
  const b = h('button', { type: 'button', class: 'plain tr-x', title: 'clear the range (Esc)', 'aria-label': 'clear the cycle range', text: '×' });
  b.addEventListener('click', () => { traceRange.clear(); focus(b)?.focus({ preventScroll: true }); });
  return b;
}

// ---- the trace ------------------------------------------------------------------------------------------------------

// viewer: a trace.js Viewer (single mode); tools: its tool bar. Sets viewer.ext (the hooks trace.js calls).
export function attachRange(viewer, tools) {
  const text = h('span', { class: 'tr-c' });
  const chip = h('span', { class: 'tr-chip', hidden: true, title: HEAD_KEYS }, text, clearButton(() => viewer.canvas));
  tools.append(chip);
  let drag = null;   // {anchor, last, moved}
  let pending = null, frame = 0;
  const mine = () => { const r = traceRange.get(); return r && r.model === viewer.model ? r : null; };
  const set = (a, b) => traceRange.set(viewer.view ?? null, viewer.model, a, b);

  const unsubscribe = traceRange.subscribe(() => {
    const r = mine();
    chip.hidden = !r;
    if (r) { text.textContent = label(r); chip.dataset.a = r.a; chip.dataset.b = r.b; }
    viewer.root.dataset.range = r ? `${r.a}-${r.b}` : '';
    viewer.paint();
  });

  const local = (e) => { const b = viewer.canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  const cycle = (x) => Math.max(viewer.c0, Math.min(viewer.c1, viewer.cycleAt(x)));
  const visible = () => [Math.max(viewer.c0, viewer.cycleAt(viewer.G)), Math.min(viewer.c1, viewer.cycleAt(viewer.viewW - 1))];
  function update() { // once per frame while dragging
    frame = 0;
    if (pending) set(pending[0], pending[1]);
  }

  function onMove(e) {
    if (!drag) return;
    e.stopPropagation(); // (the capture phase, on the chart: no hover tooltips while selecting)
    const c = cycle(local(e).x);
    if (c !== drag.anchor) drag.moved = true;
    if (!drag.moved || c === drag.last) return;
    drag.last = c;
    pending = [drag.anchor, c];
    if (!frame) frame = requestAnimationFrame(update);
  }
  function onUp(e) {
    if (!drag) return;
    viewer.chart.removeEventListener('pointermove', onMove, true);
    viewer.canvas.removeEventListener('pointerup', onUp);
    viewer.canvas.removeEventListener('pointercancel', onUp);
    viewer.canvas.releasePointerCapture?.(e.pointerId);
    const d = drag;
    drag = null;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    if (e.type === 'pointerup') { // where the button was released (the last moves may not have been delivered yet)
      const c = cycle(local(e).x);
      if (c !== d.anchor) { d.moved = true; pending = [d.anchor, c]; }
    }
    if (d.moved && pending) set(pending[0], pending[1]);
    else if (e.type === 'pointerup') traceRange.clear(viewer.model); // a click on the head
    pending = null;
  }

  viewer.ext = {
    // a pointer went down on the canvas: true if it starts a range (on the head, right of the gutter)
    down(e) {
      if (viewer.fixed || e.button !== 0 || e.pointerType === 'touch') return false;
      const { x, y } = local(e);
      if (y >= viewer.headH() || x <= viewer.G) return false;
      drag = { anchor: cycle(x), last: null, moved: false };
      pending = null;
      viewer.canvas.setPointerCapture?.(e.pointerId);
      viewer.chart.addEventListener('pointermove', onMove, true);
      viewer.canvas.addEventListener('pointerup', onUp);
      viewer.canvas.addEventListener('pointercancel', onUp);
      e.preventDefault();
      return true;
    },
    // a key on the focused canvas: true if it was the range's
    key(e) {
      const bracket = e.key === '[' || e.key === ']'; // (Option or AltGr on some layouts)
      if (e.metaKey || (!bracket && (e.altKey || e.ctrlKey))) return false;
      const r = mine();
      if (e.key === 'Escape') { if (!r) return false; traceRange.clear(); viewer.live.textContent = 'range cleared'; e.preventDefault(); return true; }
      if (e.key !== '[' && e.key !== ']') return false;
      e.preventDefault();
      const [v0, v1] = visible();
      const u = viewer.active >= 0 ? viewer.model.uops[viewer.rows[viewer.active]] : null;
      const at = u ? (u.dispatched ?? u.issued ?? u.idq ?? u.iq) : null;
      let a, b;
      if (e.key === '[') { a = at ?? v0; b = r ? Math.max(a, r.b) : Math.max(a, v1); }
      else { b = at ?? v1; a = r ? Math.min(r.a, b) : Math.min(v0, b); }
      const n = set(a, b);
      if (n) viewer.live.textContent = `cycles ${n.a} to ${n.b} selected`;
      return true;
    },
    // the selected cycles, for the head's shares: {a, b} or null
    range: () => mine(),
    // after the trace is drawn: the band over the selected cycles
    draw(ctx) {
      const r = mine();
      if (!r || !viewer.colors) return;
      const x0 = viewer.x(r.a), x1 = viewer.x(r.b + 1), G = viewer.G, W = viewer.viewW;
      if (x1 < G || x0 > W) return;
      ctx.save();
      ctx.beginPath(); ctx.rect(G, 0, W - G, viewer.viewH); ctx.clip();
      ctx.fillStyle = viewer.colors.accent;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), viewer.viewH);
      ctx.globalAlpha = 0.9;
      ctx.fillRect(Math.round(x0), 0, 1, viewer.viewH);
      ctx.fillRect(Math.round(x1) - 1, 0, 1, viewer.viewH);
      ctx.restore();
    },
    destroy() {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
      traceRange.clear(viewer.model);
    },
  };
  const al = viewer.canvas.getAttribute('aria-label');
  if (al && !viewer.fixed) viewer.canvas.setAttribute('aria-label', `${al} [ and ] set the start and the end of a cycle range; Esc clears it.`);
}

// ---- the bound view ------------------------------------------------------------------------------------------------

// view: the result view the bound view shows; an element with the breakdown of the selected range, or null (none for
// this run: the bound view shows the steady state)
export function rangeGroup(view) {
  const r = traceRange.of(view);
  const s = r ? rangeStats(r.model, r.a, r.b) : null;
  if (!s) return null;
  const steady = steadyShares(view?.response);
  const max = Math.max(0, ...s.ports.map((p) => p.share));
  const ports = s.ports.map((p) => {
    const fill = h('span', { class: 'bd-fill' });
    fill.style.width = `${Math.min(100, p.share * 100).toFixed(1)}%`;
    const ss = steady.get(p.name);
    return h('span', {
      class: ['bd-item', 'tr-item', max > 0 && p.share >= 0.95 * max ? 'is-bn' : ''].filter(Boolean).join(' '), 'data-port': p.name,
      title: `${p.name}: a uop dispatched in ${p.uops} of ${s.cycles} cycles (${pct(p.share)})${ss !== undefined ? `; steady state ${pct(ss)}` : ''}`,
    }, h('span', { class: 'bd-name', text: shortPort(p.name) }), h('span', { class: 'bd-bar', 'aria-hidden': 'true' }, fill), h('span', { class: 'bd-pct', text: pct(p.share) }));
  });
  const out = [
    h('div', { class: 'bd-group tr-head' }, h('span', { class: 'bd-g', text: 'range', title: HEAD_KEYS }),
      h('span', { class: 'tr-chip' }, h('span', { class: 'tr-c', text: label(s) }), h('span', { class: 'hint', text: ` ${s.cycles} cyc` }), clearButton(home))),
    h('div', { class: 'bd-group', role: 'group', 'aria-label': 'ports' }, h('span', { class: 'bd-g', text: 'ports', title: 'the share of the range\'s cycles in which each port dispatched a uop' }), h('span', { class: 'bd-items' }, ports)),
  ];
  const parts = rangeSlotParts(s.slots);
  if (parts.length) {
    const sl = s.slots;
    const bar = h('span', { class: 'sl-bar', 'aria-hidden': 'true' }, parts.map((p) => {
      const seg = h('span', { class: `sl-seg sl-${p.key}` });
      seg.style.width = `${(p.share * 100).toFixed(2)}%`;
      return seg;
    }));
    const keys = parts.filter((p) => p.share >= 0.005).map((p) => h('span', { class: 'sl-k', 'data-key': p.key, title: `${p.title}: ${p.slots} of ${sl.width} × ${sl.cycles} slots` },
      h('span', { class: `sl-sw sl-${p.key}` }), `${p.name} ${pct(p.share)}`));
    const logged = sl.logged === sl.cycles ? '' : sl.logged ? `; the cause of lost slots is logged for ${sl.logged} of the cycles (the steady state)` : '; no cause logged outside the steady state';
    out.push(h('div', { class: 'bd-group bd-slots' }, h('span', { class: 'bd-g', text: 'slots', title: `issue slots (${sl.width} per cycle) of the range: issued, or lost and why${logged}` }),
      h('span', { class: 'sl' }, bar, h('span', { class: 'sl-keys' }, keys))));
  }
  const box = h('div', { class: 'bd-groups tr-bd', 'data-range': `${s.a}-${s.b}` }, out);
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    const to = home(box);
    traceRange.clear();
    to?.focus({ preventScroll: true });
  });
  return box;
}

// f() after each change of the range (bound.js repaints)
export const onRange = (f) => traceRange.subscribe(f);
