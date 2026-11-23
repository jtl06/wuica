// Scrolls the uop table to one of its rows and flashes it. Shared by the views that point at instructions (bound.js,
// layout.js). The rows of `table.uops tbody` are the response's rows in order; a long block draws only its first rows:
// then the "show all" button is pressed and the jump waits for the next decoration (pending()).

let waiting = null; // {root, row}: a jump that waits for the table to be drawn in full

export function jumpToRow(root, row) {
  const tr = root?.querySelector('table.uops')?.tBodies[0]?.rows[row];
  if (!tr) {
    const all = root?.querySelector('.more-rows button');
    if (all) { waiting = { root, row }; all.click(); }
    return false;
  }
  waiting = null;
  tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const th = tr.cells[0];
  th.tabIndex = -1;
  th.focus({ preventScroll: true });
  tr.classList.remove('rj-flash');
  void tr.offsetWidth; // restart the animation
  tr.classList.add('rj-flash');
  setTimeout(() => tr.classList.remove('rj-flash'), 1600);
  return true;
}

// After a redraw: finish a jump that waited for the full table.
export function finishJump(root) {
  if (!waiting || waiting.root !== root) return;
  const { row } = waiting;
  waiting = null;
  if (root.querySelector('table.uops')?.tBodies[0]?.rows[row]) jumpToRow(root, row);
}
