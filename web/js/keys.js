// Keyboard shortcuts and the `?` overlay that lists them. app.js makes one createKeys({button}) (the ? button in the
// footer); everything else is done through the page as a click would do it: a row is selected by a click on it
// (trace-link.js and the instruction card, icard.js, react as to a click: the trace opens too), a tab of the result is
// picked by a click on it (the digits, in the tabs' order: workspace.js), A–B by its radio button. j/k: the next/previous row; n/p: the rows the bound view shades for its resource,
// hottest first (else the critical chain's rows).
// The table (KEYS) and the decision (actionFor, typing) are plain data and functions, testable without a DOM
// (tests-js/web_keys.mjs); the browser side is tests-js/web_keys_browser.mjs.
//
// No shortcut fires while typing (an input, select, textarea or contenteditable), except Escape (leaves the editor)
// and Ctrl/⌘+Enter (app.js). None uses Ctrl, ⌘ or Alt, and none of the keys the focused widgets own (the trace's
// arrows, + − 0; the arrows of the code map, the arcs and the table rows): a key a widget handled (defaultPrevented)
// is left alone.

// the digits: the tabs of the result, in their order (the second press of a tab's digit goes back to the first tab)
export const TABS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

// {show: the keys as shown, label, action (one, or one per key), keys: the KeyboardEvent.key values}; in the overlay's
// order. Ctrl/⌘+Enter is app.js's (listed only).
export const KEYS = [
  { show: ['Ctrl/⌘', 'Enter'], label: 'analyze', action: null, keys: [] }, // app.js
  { show: ['/'], label: 'code', action: 'code', keys: ['/'] },
  { show: ['j', 'k'], label: 'row ↓ ↑', action: ['next', 'prev'], keys: ['j', 'k'] },
  { show: ['n', 'p'], label: 'hot rows', action: ['hotNext', 'hotPrev'], keys: ['n', 'p'] },
  { show: ['1–9'], label: 'tabs, in their order', action: TABS.map((n) => `tab:${n}`), keys: TABS.map(String) },
  { show: ['a'], label: 'A–B', action: 'ab', keys: ['a'] },
  { show: ['c'], label: 'copy the view (Markdown)', action: 'copy', keys: ['c'] },
  { show: ['Esc'], label: 'close', action: 'escape', keys: ['Escape'] },
  { show: ['?'], label: 'keys', action: 'help', keys: ['?'] },
];

// key -> action
export const KEYMAP = new Map(KEYS.flatMap((k) => k.keys.map((key, i) => [key, Array.isArray(k.action) ? k.action[i] : k.action])));

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'color', 'file', 'range']);

// true when keys typed at `t` (an element, or a plain object with tagName/type/isContentEditable) are text
export function typing(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.isContentEditable) return true;
  const tag = String(t.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NOT_TEXT.has(String(t.type ?? 'text').toLowerCase());
  return false;
}

// The action of a keydown event (or a plain object like one), or null. overlay: the overlay is open.
export function actionFor(e, { overlay = false } = {}) {
  if (!e || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return null;
  const action = KEYMAP.get(e.key) ?? null;
  if (!action) return null;
  if (action === 'escape') return overlay ? 'close' : (e.target?.tagName === 'TEXTAREA' ? 'blur' : null);
  if (overlay) return action === 'help' ? 'close' : null; // the page behind the overlay is inert
  if (typing(e.target)) return null;
  return action;
}

// ---- the page ----------------------------------------------------------------------------------------------------

// The row `dir` (+1, -1) from the current one in `order` (row indexes, hottest first), wrapping around; from a row
// that is not in it, the hottest; -1 if there is none. cur: the current row, or -1.
export function stepIn(order, cur, dir) {
  if (!order.length) return -1;
  const i = order.indexOf(cur);
  if (i < 0) return order[0];
  return order[(i + (dir > 0 ? 1 : -1) + order.length) % order.length];
}

// The hot rows, hottest first: [{row, weight}] -> row indexes by weight (descending), then in table order.
export function hotOrder(items) {
  return items.slice().sort((a, b) => b.weight - a.weight || a.row - b.row).map((x) => x.row);
}

// env: { button (the ? button, optional) }
export function createKeys(env = {}) {
  let dialog = null, back = null;

  const table = () => document.querySelector('table.uops.tl-linkable');
  // the rows by index (vrows.js: a long table draws the rows near the view); the selection is trace-link.js's
  const vr = () => table()?.vr ?? null;
  const current = () => vr()?.data.sel ?? -1;

  // select a row as a click does, keep it in view and give it the focus (the arrows go on from there)
  function select(row) {
    const tr = vr()?.reveal(row);
    if (!tr) return;
    tr.click();
    tr.focus({ preventScroll: true });
    reveal(tr);
  }
  // in view, and not under the instruction card where it sticks to the bottom of a long table (icard.css): centred
  function reveal(tr) {
    const r = tr.getBoundingClientRect();
    const card = document.getElementById('icard');
    const top = card && !card.hidden && card.classList.contains('stick') ? card.getBoundingClientRect().top : Infinity;
    if (r.top < 0 || r.bottom > Math.min(innerHeight, top)) tr.scrollIntoView({ block: 'center' });
  }
  function step(dir) {
    const n = vr()?.count ?? 0;
    if (!n) return;
    const cur = current();
    select(cur < 0 ? (dir > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, cur + dir)));
  }
  // the rows the bound view shades (its selected resource; the shade's --bd is the share), hottest first; else the
  // critical chain's, in table order
  function hot(dir) {
    const items = vr()?.data.hot ?? [], chain = vr()?.data.chain ?? [];
    const row = stepIn(items.length ? hotOrder(items) : chain, current(), dir);
    if (row >= 0) select(row);
  }
  // the n-th tab of the result (workspace.js); its digit again: the first tab
  const tabs = () => [...document.querySelectorAll('#result-body > .view-tabs > .view-tab')];
  function tab(n) {
    const all = tabs();
    const t = all[n - 1];
    if (!t) return;
    (t.getAttribute('aria-selected') === 'true' && n > 1 ? all[0] : t).click();
  }
  function ab() {
    const on = document.getElementById('cmp-ab'), off = document.getElementById('cmp-single');
    if (!on || !off) return;
    (on.checked ? off : on).click();
  }

  // ---- the overlay ----------------------------------------------------------------------------------------------
  function build() {
    const list = document.createElement('dl');
    list.className = 'keys-list';
    for (const k of KEYS) {
      const dt = document.createElement('dt');
      k.show.forEach((s, i) => {
        if (i) dt.append(' ');
        const kbd = document.createElement('kbd');
        kbd.textContent = s;
        dt.append(kbd);
      });
      const dd = document.createElement('dd');
      dd.textContent = k.label;
      list.append(dt, dd);
    }
    const title = document.createElement('h2');
    title.id = 'keys-title';
    title.textContent = 'keys';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'plain keys-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'close');
    close.title = 'close (Esc)';
    close.addEventListener('click', hide);
    const head = document.createElement('div');
    head.className = 'keys-head';
    head.append(title, close);
    const inner = document.createElement('div');
    inner.className = 'keys-inner';
    inner.append(head, list);
    const names = document.createElement('p');
    names.className = 'keys-tabs';
    inner.append(names);
    const d = document.createElement('dialog');
    d.id = 'keys';
    d.className = 'keys';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-labelledby', 'keys-title');
    d.append(inner);
    // a click on the backdrop (the dialog itself: its content is the inner box) closes it
    d.addEventListener('click', (e) => { if (e.target === d) hide(); });
    d.addEventListener('close', closed); // (also after the browser's own Escape)
    document.body.append(d);
    return d;
  }
  const isOpen = () => !!dialog?.open;
  function show() {
    dialog ??= build();
    if (dialog.open) return;
    // the tabs there are now, with their digits
    const names = dialog.querySelector('.keys-tabs');
    names.replaceChildren(...tabs().slice(0, 9).flatMap((t, i) => {
      const kbd = document.createElement('kbd');
      kbd.textContent = String(i + 1);
      const item = document.createElement('span');
      item.className = 'kt';
      item.append(kbd, ` ${t.dataset.tab ?? t.textContent}`);
      return i ? [' ', item] : [item];
    }));
    names.hidden = !names.firstChild;
    back = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    dialog.showModal();
    env.button?.setAttribute('aria-expanded', 'true');
    dialog.querySelector('.keys-close')?.focus();
  }
  function hide() { if (dialog?.open) { dialog.close(); closed(); } }
  // the focus goes back to where it was (the close event comes later: done here at once)
  function closed() {
    env.button?.setAttribute('aria-expanded', 'false');
    const b = back;
    back = null;
    if (b?.isConnected) b.focus({ preventScroll: true });
    else if (dialog?.contains(document.activeElement)) document.activeElement.blur();
  }

  const ACTIONS = {
    help: show, close: hide,
    code: () => document.getElementById('code')?.focus(),
    blur: () => document.activeElement?.blur?.(),
    next: () => step(1), prev: () => step(-1),
    hotNext: () => hot(1), hotPrev: () => hot(-1),
    ab,
    copy: () => document.querySelector('#result-body .view-tabs .ws-copy')?.click(),
  };

  document.addEventListener('keydown', (e) => {
    const action = actionFor(e, { overlay: isOpen() });
    if (!action) return;
    if (action.startsWith('tab:')) tab(Number(action.slice(4)));
    else ACTIONS[action]?.();
    if (action !== 'blur') e.preventDefault(); // (Escape: the native close of the dialog does the same)
  });
  env.button?.addEventListener('click', () => (isOpen() ? hide() : show()));

  return { show, hide, isOpen };
}
