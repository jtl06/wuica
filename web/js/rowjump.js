// Scrolls the uop table to one of its rows, focuses it and flashes it. Shared by the views that point at instructions
// (bound.js, codemap.js, deps.js, srcmap.js). The table's rows are the response's rows by index (vrows.js: a long table
// draws the rows near the view, reveal() draws the one asked for). The table is a tab of the result (workspace.js): it is
// shown and fitted first; if the page's layout moves it again in the next frames, the row is brought back into view.

const inView = (tr) => {
  const r = tr.getBoundingClientRect();
  const wrap = tr.closest('.table-wrap');
  const w = wrap ? wrap.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  return r.height > 0 && r.top >= Math.max(0, w.top) - 1 && r.bottom <= Math.min(innerHeight, w.bottom) + 1;
};

export function jumpToRow(root, row) {
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('wuica:show-table'));
  const vr = () => root?.querySelector('table.uops')?.vr ?? null;
  const go = () => {
    const tr = vr()?.reveal(row, { block: 'center' });
    if (!tr) return null;
    const th = tr.cells[0];
    th.tabIndex = -1;
    th.focus({ preventScroll: true });
    return tr;
  };
  const tr = go();
  if (!tr) return false;
  flash(tr);
  // (the tab's scrollers are fitted again on a later frame, workspace.js: the row stays drawn, in view and focused)
  let n = 0;
  const check = () => {
    const now = vr()?.el(row);
    if (!now || !now.isConnected || !inView(now) || document.activeElement !== now.cells[0]) { const t = go(); if (t && t !== now) flash(t); }
    if (++n < 3) requestAnimationFrame(check);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(check);
  return true;
}

function flash(tr) {
  tr.classList.remove('rj-flash');
  void tr.offsetWidth; // restart the animation
  tr.classList.add('rj-flash');
  setTimeout(() => tr.classList.remove('rj-flash'), 1600);
}

// (kept for the callers: a jump no longer waits for a fuller table)
export function finishJump() {}
