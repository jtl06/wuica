// The uop table and the trace, linked (app.js calls decorate() after renderResult and the insight views): a row of the
// table under the pointer or the keyboard focus marks its instruction's uops in the trace, and a uop of the trace marks
// its row; a click (or Enter) on a row selects the instruction and scrolls the trace to it (now, or when the trace tab is
// opened), a click on a uop selects its row and scrolls the table to it. The selection is in the URL (app.js).
// Also the wait column ("waits"): where each instruction's uops spent their time in the trace (trace.js, waitBreakdown),
// as a stacked bar; it needs the trace, which it asks the trace panel for.
//
// The table's rows are the response's rows, by index (vrows.js: a long table draws the rows near the view); the marks
// and the wait column are a decorator of its rows. The listeners are on the result's root (delegated), so they survive
// the table being drawn again.

import { h } from './render.js';
import { rowGroups, groupKey, rowOfGroup, waitBreakdown, waitText, WAIT_PARTS, traceGuard } from './trace.js';

const INTERACTIVE = 'a, button, input, select, textarea, label, summary';

// env: { panel (createTracePanel), getSel() -> row | -1, setSel(row) (the URL keeps it), onWaits(on) (the toggle changed) }
export function createTraceLink(env) {
  const { panel } = env;
  const open = { waits: false };
  let root = null, view = null, groups = [], onUi = null;
  let hoverRow = -1, linkedRow = -1;
  let waitsTools = null, waitsKey = null;
  let selRow = -1, roveRow = 0, waits = null; // what the rows show: the selection, the row in the tab order, the waits
  const bound = new WeakSet();
  const breakdowns = new WeakMap(); // model -> waitBreakdown

  const table = () => root?.querySelector('table.uops');
  const vr = () => table()?.vr ?? null;
  // the row of a <tr> of the decorated table (not of the A–B view's tables, which are not linked), or -1
  const rowOfTr = (tr) => {
    const t = tr?.parentElement?.parentElement;
    return tr && view && t === table() && t.classList.contains('tl-linkable') && tr.parentElement.tagName === 'TBODY' ? (t.vr?.index(tr) ?? -1) : -1;
  };
  const ok = (v) => !!v?.response && !v.response.error && Array.isArray(v.response.rows);

  // ---- marks: a decorator of the table's rows ---------------------------------------------------------------------
  function paintRow(tr, k) {
    tr.classList.toggle('tl-sel', k === selRow);
    if (k === selRow) tr.setAttribute('aria-current', 'true'); else tr.removeAttribute('aria-current');
    tr.classList.toggle('tl-linked', k === linkedRow);
    // one row is in the tab order (the selected one, else the first): arrows move between rows; the links of that row
    // only (its instruction's uops.info page: Tab from the row), so the table is one stop, not one per instruction
    tr.setAttribute('tabindex', k === roveRow ? '0' : '-1');
    for (const a of tr.querySelectorAll('a[href]')) a.setAttribute('tabindex', k === roveRow ? '0' : '-1');
    const td = tr.querySelector(':scope > td.tl-wait');
    if (!waits) td?.remove();
    else if (!td) tr.insertBefore(waitCell(k), at(tr));
  }
  const repaint = () => vr()?.repaint('tl');
  function paintSel() { selRow = env.getSel(); const v = vr(); if (v) v.data.sel = selRow; repaint(); }
  function roving(row) { const n = vr()?.count ?? 0; roveRow = row >= 0 && row < n ? row : 0; repaint(); }

  // ---- events (delegated) ------------------------------------------------------------------------------------------
  function hover(row) {
    if (row === hoverRow) return;
    hoverRow = row;
    panel.highlight(row >= 0 ? groups[row] ?? null : null);
  }
  function pick(row) {
    if (row < 0 || !groups[row]) return;
    env.setSel(row);
    paintSel();
    roving(row);
    panel.select(groups[row], { reveal: true });
  }
  function bind(target) {
    if (bound.has(target)) return;
    bound.add(target);
    target.addEventListener('pointerover', (e) => { if (e.pointerType !== 'touch') hover(rowOfTr(e.target.closest?.('tr'))); });
    target.addEventListener('pointerout', (e) => {
      const to = e.relatedTarget instanceof Element ? rowOfTr(e.relatedTarget.closest('tr')) : -1;
      if (to < 0) hover(-1);
    });
    target.addEventListener('focusin', (e) => {
      const tr = e.target.closest?.('tr');
      const row = rowOfTr(tr);
      if (row < 0) return;
      if (e.target === tr) roving(row);
      hover(row);
    });
    target.addEventListener('focusout', (e) => {
      const to = e.relatedTarget instanceof Element ? rowOfTr(e.relatedTarget.closest('tr')) : -1;
      if (to < 0) hover(-1);
    });
    target.addEventListener('click', (e) => {
      const tr = e.target.closest?.('tr');
      const row = rowOfTr(tr);
      if (row < 0 || e.target.closest(INTERACTIVE)) return; // the links on the instruction names work as before
      const s = getSelection?.();
      if (s && !s.isCollapsed && tr.contains(s.anchorNode)) return; // selecting text
      pick(row);
    });
    target.addEventListener('keydown', (e) => {
      const tr = e.target.closest?.('tr');
      const row = rowOfTr(tr);
      if (row < 0 || e.target !== tr || e.altKey || e.ctrlKey || e.metaKey) return; // a link in the row keeps its keys
      const n = vr()?.count ?? 0;
      let to = -1;
      if (e.key === 'ArrowDown') to = Math.min(n - 1, row + 1);
      else if (e.key === 'ArrowUp') to = Math.max(0, row - 1);
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = n - 1;
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(row); return; }
      else if (e.key === 'Escape' && env.getSel() >= 0) { env.setSel(-1); paintSel(); panel.select(null); return; }
      else return;
      e.preventDefault();
      roving(to);
      vr()?.reveal(to)?.focus({ preventScroll: true });
    });
  }

  // ---- from the trace -------------------------------------------------------------------------------------------------
  // a uop of the trace under the pointer: its row is marked (if it is drawn; never draws more rows)
  function fromTraceHover(g) {
    if (!root || !view) return;
    linkedRow = g ? rowOfGroup(groups, g) : -1;
    repaint();
  }
  // a uop of the trace was clicked: its row is selected and scrolled into view
  function fromTracePick(g) {
    if (!root || !view) return;
    const row = rowOfGroup(groups, g);
    if (row < 0) return;
    env.setSel(row);
    paintSel();
    roving(row);
    vr()?.reveal(row);
  }

  // ---- the wait column -----------------------------------------------------------------------------------------------
  function toggle(available, reason) {
    const box = h('input', { type: 'checkbox', class: 'tl-waits-box', disabled: !available });
    box.checked = open.waits && available;
    box.addEventListener('change', () => { open.waits = box.checked; env.onWaits?.(open.waits); decorateWaits(); });
    waitsTools = h('span', { class: 'tl-waits-status' });
    return h('span', { class: 'tl tl-waits-tools' },
      h('label', { title: available ? 'where the uops wait, from the trace: cycles per uop' : reason }, box, ' waits'), ' ', waitsTools);
  }

  function legend() {
    return h('span', { class: 'tl-legend', 'aria-hidden': 'true' },
      WAIT_PARTS.map(([p, name]) => h('span', { class: 'tl-key' }, h('span', { class: `tl-sw w-${p}` }), name)));
  }

  function removeColumn() {
    for (const e of root.querySelectorAll('.tl-wait')) e.remove();
    waitsKey = null;
    if (waits) { waits = null; repaint(); }
  }

  // the column, drawn from the trace once it is there
  function decorateWaits() {
    if (!root || !view) return;
    const t = table();
    if (!t) return;
    if (!open.waits || !ok(view) || view.response.mock) {
      removeColumn();
      if (waitsTools) waitsTools.replaceChildren();
      return;
    }
    const tr = panel.view === view ? panel.trace() : { state: 'idle' };
    if (tr.state === 'idle') { panel.want(); return; } // comes back through refresh()
    waitsTools.replaceChildren();
    if (tr.state === 'ready') waitsTools.append(legend());
    else if (tr.state === 'loading') waitsTools.append(h('span', { class: 'hint', text: '…' }));
    else if (tr.state === 'large') {
      const b = h('button', { type: 'button', class: 'plain', text: 'load', title: `${traceGuard(view)?.instrs ?? ''} instructions: a large trace` });
      b.addEventListener('click', () => panel.want(true));
      waitsTools.append(b);
    } else if (tr.state === 'error' || tr.state === 'mock') waitsTools.append(h('span', { class: 'hint', title: String(tr.error?.message ?? tr.error ?? ''), text: '—' }));
    if (tr.state !== 'ready') { removeColumn(); return; }
    const key = `${vr()?.count ?? 0}`;
    if (waitsKey === key && t.querySelector('th.tl-wait')) return;
    removeColumn();
    waitsKey = key;
    let wb = breakdowns.get(tr.model);
    if (!wb) { wb = waitBreakdown(tr.model); breakdowns.set(tr.model, wb); }
    addColumn(t, wb);
  }

  // after the instruction, the notes and the cost column (insight-view.js) if it is there
  const at = (tr) => { let i = 2; while (tr.cells[i]?.classList.contains('ins-cost')) i++; return tr.cells[i] ?? null; };
  function addColumn(t, wb) {
    const its = wb.from === wb.to ? `iteration ${wb.from}` : `iterations ${wb.from}–${wb.to}`;
    const head = t.tHead?.rows[0];
    if (head) head.insertBefore(h('th', { scope: 'col', class: 'tl tl-wait', title: `cycles per uop, ${its}: ${WAIT_PARTS.map((p) => p[1]).join(', ')}`, text: 'waits' }), at(head));
    const size = t.tBodies[0]?.querySelector(':scope > tr.vr-size');
    if (size) size.insertBefore(h('td', { class: 'tl tl-wait' }), at(size));
    const foot = t.tFoot?.rows[0];
    if (foot) foot.insertBefore(h('td', { class: 'tl tl-wait' }), at(foot));
    waits = { wb, its };
    repaint();
  }
  // row k's cell of the wait column
  function waitCell(k) {
    const { wb, its } = waits;
    const g = groups[k];
    const w = g && !g.fused ? wb.get(groupKey(g)) : null;
    const td = h('td', { class: 'tl tl-wait' });
    if (w) {
      const bar = h('span', { class: 'wbar', 'aria-hidden': 'true' });
      for (const [p] of WAIT_PARTS) {
        const v = w[p] ?? 0;
        if (v <= 0) continue;
        const seg = h('span', { class: `w-${p}` });
        seg.style.width = `${((100 * v) / Math.max(wb.max, 1e-9)).toFixed(2)}%`;
        bar.append(seg);
      }
      const text = waitText(w);
      td.title = `${w.total.toFixed(1)} cycles per uop (${its})\n${text.replace(/ · /g, '\n')}`;
      td.append(bar, h('span', { class: 'vh', text: `waits: ${text}` }));
    } else if (g?.fused) {
      td.title = 'macro-fused: with the row above';
    }
    return td;
  }

  // The table's scroller is its way in: Tab onto it moves on to the row in the tab order (drawn and scrolled to: a long
  // table draws only the rows near the view, so that row may not be there); while the focus is in the table the scroller
  // is out of the tab order, so Shift+Tab from the row leaves the table. (A click on it does not move the focus.)
  const entries = new WeakSet();
  function entry(wrap) {
    if (!wrap || entries.has(wrap)) return;
    entries.add(wrap);
    wrap.setAttribute('tabindex', '0');
    wrap.addEventListener('focus', (e) => {
      if (e.target !== wrap || wrap.contains(/** @type {Node | null} */ (e.relatedTarget)) || !wrap.matches(':focus-visible')) return;
      /** @type {HTMLElement | null} */ (vr()?.reveal(roveRow) ?? null)?.focus({ preventScroll: true });
    });
    wrap.addEventListener('focusin', (e) => { if (e.target !== wrap) wrap.setAttribute('tabindex', '-1'); });
    wrap.addEventListener('focusout', (e) => { if (!wrap.contains(/** @type {Node | null} */ (e.relatedTarget))) wrap.setAttribute('tabindex', '0'); });
  }

  // ---- decorate --------------------------------------------------------------------------------------------------------
  /** @param {Element} target @param {any} v @param {{onUi?: (name: string, value: unknown) => void}} [opts] */
  function decorate(target, v, { onUi: f } = {}) {
    if (v !== view) linkedRow = -1; // a new run: no mark from the trace of the last one
    root = target;
    view = v;
    onUi = f ?? null;
    bind(target);
    hoverRow = -1;
    waitsKey = null;
    waits = null;
    for (const e of root.querySelectorAll('.tl')) e.remove();
    const t = table();
    if (!ok(v) || !t) { groups = []; return; }
    groups = rowGroups(v.response.rows);
    t.classList.add('tl-linkable');
    t.vr?.decorate('tl', paintRow);
    entry(t.closest('.table-wrap'));
    // a selection beyond the rows of this result (e.g. from a link to another block) is dropped
    let sel = env.getSel();
    if (sel >= groups.length) { env.setSel(-1); sel = -1; }
    selRow = sel;
    t.vr && (t.vr.data.sel = sel);
    roving(sel);
    panel.select(sel >= 0 ? groups[sel] : null);
    const available = !v.response.mock;
    root.querySelector('.table-tools')?.append(toggle(available, 'not with mock data'));
    decorateWaits();
  }

  return {
    decorate,
    // the trace panel's trace changed (loaded, failed): the wait column follows
    refresh() { if (root && view && panel.view === view) decorateWaits(); },
    fromTraceHover, fromTracePick,
    setOpen({ waits = false }) { open.waits = !!waits; },
    open() { return { waits: open.waits }; },
  };
}
