// The rows of a long table, drawn in a window: the rows in and near the view, with a spacer row above and below that
// stands for the rest, so a block of thousands of instructions is a scroll range, not thousands of DOM rows. A short
// table (up to ALL_UP_TO rows) is drawn in full, through the same interface.
//
// The rows are addressed by their index in the model (the response's rows): el(k) is row k's <tr> if it is drawn,
// index(tr) the row of a <tr>; reveal(k) draws and scrolls to row k. What other modules add to the rows (classes, a
// column's cells, the selection) is a decorator, decorate(name, fn): fn(tr, k) is applied to every row as it is drawn
// (it must set the row's state for k, whatever the <tr> held before: a <tr> is made anew each time, by make(k)).
// Per-row data that other modules read (the shaded rows of the bound view, the chain) is kept in `data`, by name.
//
//   const vr = new VRows(tbody, count, make); table.vr = vr;   (render.js uopTable)

const OVER = 30;           // rows drawn beyond the view, on each side
export const ALL_UP_TO = 300;
const live = new Set();    // WeakRefs of the windowed instances in the page
let frame = 0;
let observer = null;

function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const ref of live) {
      const v = ref.deref();
      if (!v || (!v.tbody.isConnected && v.gone++ > 3)) { live.delete(ref); continue; }
      v.update();
    }
  });
}
function listen() {
  if (observer || typeof window === 'undefined') return;
  document.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule);
  observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
}

export class VRows {
  // tbody: the table's body (a sizing row may already be in it); count: the rows; make(k): row k's <tr>
  constructor(tbody, count, make) {
    this.tbody = tbody;
    this.count = count;
    this.make = make;
    this.data = {};
    this.decorators = new Map();
    this.rows = new Map(); // k -> tr, drawn
    this.a = 0; this.b = 0;
    this.rowH = 0;
    this.gone = 0;
    this.windowed = count > ALL_UP_TO;
    if (!this.windowed) {
      this.#draw(0, count);
      return;
    }
    const pad = () => { const tr = document.createElement('tr'); tr.className = 'vr-pad'; tr.setAttribute('aria-hidden', 'true'); const td = document.createElement('td'); td.colSpan = 999; tr.append(td); return tr; };
    this.top = pad(); this.bottom = pad();
    tbody.append(this.top, this.bottom);
    this.#draw(0, Math.min(count, 2 * OVER));
    listen();
    live.add(new WeakRef(this));
    observer?.observe(tbody);
  }

  el(k) { return this.rows.get(k) ?? null; }
  index(tr) { const k = tr?.dataset?.row; return k === undefined ? -1 : Number(k); }
  drawn() { return [...this.rows.entries()].sort((x, y) => x[0] - y[0]); }

  // a decorator: applied now to the drawn rows, and to every row drawn later; null removes it (the rows are made anew)
  decorate(name, fn) {
    if (fn) { this.decorators.set(name, fn); for (const [k, tr] of this.rows) fn(tr, k); return; }
    if (!this.decorators.delete(name)) return;
    this.#remake();
  }
  // a decorator's state changed: apply it (or all of them) again to the drawn rows
  repaint(name = null) {
    const fns = name ? [this.decorators.get(name)].filter(Boolean) : [...this.decorators.values()];
    for (const [k, tr] of this.rows) for (const fn of fns) fn(tr, k);
  }

  // row k drawn and in view (block: as scrollIntoView's); its <tr>
  reveal(k, { block = 'nearest', behavior = 'auto' } = {}) {
    if (k < 0 || k >= this.count) return null;
    if (this.windowed && (k < this.a || k >= this.b)) this.#draw(Math.max(0, k - 2 * OVER), Math.min(this.count, k + 2 * OVER));
    const tr = this.rows.get(k);
    tr?.scrollIntoView({ block, behavior });
    if (this.windowed) this.update();
    return tr ?? null;
  }

  // the rows near the view (after a scroll, a resize, the table being shown)
  update() {
    if (!this.windowed || !this.tbody.isConnected) return;
    this.gone = 0;
    const rect = this.tbody.getBoundingClientRect();
    if (!rect.height) return; // hidden (another tab)
    const any = this.rows.values().next().value;
    if (any) {
      const h = any.getBoundingClientRect().height;
      // (the first measure, or another font: the spacers follow, so the scroll range is the rows' own)
      if (h > 0 && Math.abs(h - this.rowH) > 0.01) { this.rowH = h; this.#pads(); }
    }
    const rowH = this.rowH || 19;
    const wrap = this.tbody.closest('.table-wrap');
    const w = wrap && wrap.scrollHeight > wrap.clientHeight + 1 ? wrap.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    const viewTop = Math.max(w.top, 0), viewBottom = Math.min(w.bottom, innerHeight);
    const base = rect.top + (this.sizer?.getBoundingClientRect().height ?? 0);
    const from = Math.max(0, Math.floor((viewTop - base) / rowH) - OVER / 2);
    const to = Math.min(this.count, Math.ceil((viewBottom - base) / rowH) + OVER / 2);
    if (from >= this.a && to <= this.b) return;
    this.#draw(Math.max(0, from - OVER), Math.min(this.count, to + OVER));
  }

  get sizer() { return this.tbody.querySelector(':scope > tr.vr-size'); }

  #make(k) {
    const tr = this.make(k);
    tr.dataset.row = String(k);
    for (const fn of this.decorators.values()) fn(tr, k);
    return tr;
  }
  #remake() {
    for (const [k, tr] of this.rows) { const n = this.#make(k); tr.replaceWith(n); this.rows.set(k, n); }
  }
  // rows a..b drawn (those already drawn are kept: their focus and hover stay)
  #draw(a, b) {
    const keep = new Map();
    for (const [k, tr] of this.rows) { if (k >= a && k < b) keep.set(k, tr); else tr.remove(); }
    const before = document.createDocumentFragment(), after = document.createDocumentFragment();
    const firstKept = keep.size ? Math.min(...keep.keys()) : b;
    for (let k = a; k < b; k++) {
      if (keep.has(k)) continue;
      const tr = this.#make(k);
      keep.set(k, tr);
      (k < firstKept ? before : after).append(tr);
    }
    if (this.windowed) {
      this.top.after(before);
      this.bottom.before(after);
    } else {
      this.tbody.append(before, after);
    }
    this.rows = keep;
    this.a = a; this.b = b;
    if (this.windowed) this.#pads();
  }
  // the spacers: the rows above and below the drawn ones, at the rows' height
  #pads() {
    if (!this.windowed) return;
    const rowH = this.rowH || 19;
    this.top.firstChild.style.height = `${this.a * rowH}px`;
    this.bottom.firstChild.style.height = `${(this.count - this.b) * rowH}px`;
    this.top.hidden = this.a === 0; this.bottom.hidden = this.b === this.count;
  }
}

// the rows of a table (render.js gives every uop table one), or null
export const rowsOf = (table) => table?.vr ?? null;
