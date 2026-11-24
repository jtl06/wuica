// Scrolls the uop table to one of its rows and flashes it. Shared by the views that point at instructions (bound.js,
// layout.js). The table's rows are the response's rows by index (vrows.js: a long table draws the rows near the view,
// reveal() draws the one asked for).

export function jumpToRow(root, row) {
  // the table is a tab of the result (workspace.js): show it first
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('wuica:show-table'));
  const tr = root?.querySelector('table.uops')?.vr?.reveal(row, { block: 'center' });
  if (!tr) return false;
  const th = tr.cells[0];
  th.tabIndex = -1;
  th.focus({ preventScroll: true });
  tr.classList.remove('rj-flash');
  void tr.offsetWidth; // restart the animation
  tr.classList.add('rj-flash');
  setTimeout(() => tr.classList.remove('rj-flash'), 1600);
  return true;
}

// (kept for the callers: a jump no longer waits for a fuller table)
export function finishJump() {}
