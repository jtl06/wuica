// Tests of the keyboard shortcuts' table and decision (web/js/keys.js), without a DOM: every listed key maps to an
// action, no key is taken twice or uses a key the focused widgets own, keys typed in an editable target are ignored
// (except Escape), modifiers and handled events are left alone, the overlay takes only ? and Escape, and the hot-row
// stepping wraps around. The page side: tests-js/web_keys_browser.mjs.
// Usage: node tests-js/web_keys.mjs
import { KEYS, KEYMAP, VIEWS, typing, actionFor, stepIn, hotOrder } from '../web/js/keys.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const ev = (key, extra = {}) => ({ key, target: { tagName: 'BODY' }, ...extra });

// ---- the table ----------------------------------------------------------------------------------------------------------
check(KEYS.length >= 6 && KEYS.length <= 10, 'at most ~10 entries', String(KEYS.length));
for (const k of KEYS) {
  check(Array.isArray(k.show) && k.show.length > 0 && k.show.every((s) => typeof s === 'string' && s), `${k.label}: keys shown`);
  check(typeof k.label === 'string' && k.label.length > 0 && k.label.length <= 28, `${k.label}: a short label`);
  if (Array.isArray(k.action)) check(k.action.length === k.keys.length, `${k.label}: one action per key`);
}
const all = KEYS.flatMap((k) => k.keys);
check(new Set(all).size === all.length, 'no key is taken twice', all.join(' '));
check(KEYMAP.size === all.length, 'the key map has every key');
// keys the widgets own when focused: the trace (+ − = _ 0, arrows, Home/End/Page, Enter), the code map, the arcs, the
// sweep, the table rows (arrows, Home/End, Enter, space)
for (const k of ['+', '-', '=', '_', '0', ' ', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
  check(!KEYMAP.has(k), `not taken: ${JSON.stringify(k)}`);
}
check(KEYS[0].show.join(' ') === 'Ctrl/⌘ Enter' && KEYS[0].keys.length === 0, 'Ctrl/⌘+Enter listed (app.js handles it)');
for (const [key, action] of [['?', 'help'], ['/', 'code'], ['j', 'next'], ['k', 'prev'], ['n', 'hotNext'], ['p', 'hotPrev'], ['a', 'ab'],
  ['1', 'view:bound'], ['2', 'view:try'], ['3', 'view:bytes'], ['4', 'view:deps'], ['5', 'view:trace']]) {
  check(actionFor(ev(key)) === action, `${key} -> ${action}`, String(actionFor(ev(key))));
}
for (const v of Object.keys(VIEWS)) check(KEYMAP.get(String(Object.keys(VIEWS).indexOf(v) + 1)) === `view:${v}`, `view ${v} has its digit`);
check(actionFor(ev('J')) === null && actionFor(ev('x')) === null && actionFor(ev('6')) === null, 'other keys: nothing');

// ---- modifiers, handled events, composition --------------------------------------------------------------------------------
for (const m of ['ctrlKey', 'metaKey', 'altKey']) check(actionFor(ev('j', { [m]: true })) === null, `j with ${m}: nothing`);
check(actionFor(ev('?', { shiftKey: true })) === 'help', '? with shift (as typed on most layouts)');
check(actionFor(ev('j', { defaultPrevented: true })) === null, 'a key a widget handled: nothing');
check(actionFor(ev('j', { isComposing: true })) === null, 'composing: nothing');

// ---- the typing guard ---------------------------------------------------------------------------------------------------------
const editable = [
  { tagName: 'TEXTAREA' }, { tagName: 'textarea' }, { tagName: 'SELECT' }, { tagName: 'INPUT' }, { tagName: 'INPUT', type: 'text' },
  { tagName: 'INPUT', type: 'number' }, { tagName: 'INPUT', type: 'search' }, { tagName: 'DIV', isContentEditable: true },
  { tagName: 'SPAN', isContentEditable: true },
];
for (const t of editable) {
  check(typing(t), `typing in ${JSON.stringify(t)}`);
  for (const key of ['j', 'k', 'n', 'p', 'a', '/', '?', '1', '5']) check(actionFor(ev(key, { target: t })) === null, `${key} typed in ${JSON.stringify(t)}: nothing`);
}
for (const t of [{ tagName: 'BUTTON' }, { tagName: 'TR' }, { tagName: 'BODY' }, { tagName: 'INPUT', type: 'checkbox' }, { tagName: 'INPUT', type: 'radio' }, { tagName: 'SUMMARY' }, null, undefined]) {
  check(!typing(t), `not typing: ${JSON.stringify(t)}`);
}
check(actionFor(ev('j', { target: { tagName: 'INPUT', type: 'checkbox' } })) === 'next', 'j on a focused checkbox: next row');

// ---- Escape --------------------------------------------------------------------------------------------------------------------
check(actionFor(ev('Escape', { target: { tagName: 'TEXTAREA' } })) === 'blur', 'Escape in the editor: blur');
check(actionFor(ev('Escape', { target: { tagName: 'INPUT', type: 'text' } })) === null, 'Escape in an input: left to it');
check(actionFor(ev('Escape')) === null, 'Escape elsewhere: left to the widgets');
check(actionFor(ev('Escape'), { overlay: true }) === 'close', 'Escape with the overlay: close');

// ---- the overlay ---------------------------------------------------------------------------------------------------------------
check(actionFor(ev('?'), { overlay: true }) === 'close', '? with the overlay: close');
for (const key of ['j', 'k', 'n', 'p', 'a', '/', '1']) check(actionFor(ev(key), { overlay: true }) === null, `${key} with the overlay: nothing`);

// ---- stepping through hot rows: hottest first ---------------------------------------------------------------------------------
check(stepIn([], 3, 1) === -1 && stepIn([], -1, -1) === -1, 'no hot rows: none');
check(stepIn([5, 2, 9], -1, 1) === 5 && stepIn([5, 2, 9], -1, -1) === 5 && stepIn([5, 2, 9], 3, 1) === 5, 'from a row that is not hot: the hottest');
check(stepIn([5, 2, 9], 5, 1) === 2 && stepIn([5, 2, 9], 2, 1) === 9 && stepIn([5, 2, 9], 9, 1) === 5, 'next (wraps)');
check(stepIn([5, 2, 9], 2, -1) === 5 && stepIn([5, 2, 9], 5, -1) === 9, 'previous (wraps)');
check(stepIn([4], 4, 1) === 4 && stepIn([4], 4, -1) === 4, 'one hot row: stays');
check(JSON.stringify(hotOrder([{ row: 0, weight: 0.2 }, { row: 1, weight: 1 }, { row: 2, weight: 0.2 }, { row: 3, weight: 0.5 }])) === '[1,3,0,2]', 'hot rows: by weight, then in table order');
check(JSON.stringify(hotOrder([])) === '[]', 'no hot rows');

console.log(`${count} keys checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
