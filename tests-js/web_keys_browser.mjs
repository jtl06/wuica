// The keyboard shortcuts (web/js/keys.js) in the built site, in headless Chrome (--headless, over the DevTools protocol:
// tests-js/cdp.mjs), with the real analyzer; the keys go through Chrome's input pipeline (focus, default actions):
// - ? opens the overlay (a modal dialog: labelled, focus inside, the keys listed), keys behind it do nothing, Escape and
//   a click on the backdrop close it, the focus comes back; the ? button in the footer opens it too
// - j/k select the next/previous row of the uop table as a click does (the card follows), / goes to the code and
//   typing j there only types; Escape leaves the code
// - the digits pick the result's tabs in their order (the overlay lists them); a tab's digit again goes back to the first
//   tab; the bound tab's digit and n/p step through its hot rows; a toggles A–B, where the digits pick A–B's tabs
// - the overlay at 320 px and in both themes: no sideways scroll
// - SHA-256 (2,949 instructions): j on the drawn table, the time of the handler (printed; not asserted)
// Skipped (exit 0) without Chrome.
//
//   node tests-js/web_keys_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';
import { KEYS } from '../web/js/keys.js';

const chrome = findChrome();
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
const check = checker('keys browser');

const KEY = {
  Escape: { code: 'Escape', keyCode: 27 },
  '?': { code: 'Slash', keyCode: 191, modifiers: 8 }, // shift
  '/': { code: 'Slash', keyCode: 191 },
};
const letter = (k) => ({ code: /^\d$/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`, keyCode: k.toUpperCase().charCodeAt(0) });

const KH = `${HELPERS}
  // (the rows drawn: a long table draws those near the view, vrows.js; data-row is the row of the result)
  const trs = () => [...(document.querySelector('table.uops.tl-linkable')?.querySelectorAll('tbody tr[data-row]') ?? [])];
  const sel = () => Number(document.querySelector('table.uops.tl-linkable tbody tr.tl-sel')?.dataset.row ?? -1);
  const dlg = () => $('keys');
  const card = () => { const c = $('icard'); return c && !c.hidden ? Number(c.dataset.row) : -1; };
  const act = () => { const a = document.activeElement; return a ? (a.id || a.tagName) : ''; };
  const tabNames = () => [...document.querySelectorAll('#result-body > .view-tabs > .view-tab')].map((b) => b.dataset.tab);
  const selected = () => document.querySelector('.view-tab[aria-selected="true"]')?.dataset.tab;
  const settled = () => !$('results').hasAttribute('aria-busy') && !$('result-body').classList.contains('stale');
`;

const dir = copyDist();
const srv = await serve(dir);
const { browser, close } = await launch(chrome);
try {
  const page = await Page.open(browser);
  const press = async (k) => page.key(k, KEY[k] ?? letter(k));
  const digit = async (name) => String(await page.eval(`${KH} return tabNames().indexOf(${JSON.stringify(name)}) + 1;`));
  await page.goto(`${srv.origin}/?nosw=1`);
  await page.ready();
  await page.eval(`${KH} if ($('live').checked) $('live').click(); await done(() => set($('examples'), 'avx')); document.activeElement?.blur(); return 1;`);
  const rows = await page.eval(`${KH} return trs().length;`);
  check(rows >= 3, 'a result with a few rows', String(rows));

  // ---- the overlay -----------------------------------------------------------------------------------------------------
  {
    await press('?');
    const r = await page.eval(`${KH} const d = dlg();
      return d ? { open: d.open, modal: d.matches(':modal'), role: d.getAttribute('role'), aria: d.getAttribute('aria-modal'), label: $(d.getAttribute('aria-labelledby'))?.textContent,
        dt: d.querySelectorAll('dt').length, dd: [...d.querySelectorAll('dd')].map((x) => x.textContent), kbd: d.querySelectorAll('kbd').length,
        inside: d.contains(document.activeElement), expanded: $('keys-btn').getAttribute('aria-expanded') } : null;`);
    check(r?.open && r.modal && r.role === 'dialog' && r.aria === 'true' && r.label === 'keys', '?: a labelled modal dialog', JSON.stringify(r));
    check(r?.dt === KEYS.length && r.dd.length === KEYS.length && r.kbd >= KEYS.length && r.dd.every((t) => t.split(/\s+/).length <= 5), '?: every key listed, short labels', JSON.stringify(r?.dd));
    check(r?.inside && r.expanded === 'true', '?: the focus is in the overlay; the button says expanded', JSON.stringify(r));
    const t = await page.eval(`${KH} return [dlg().querySelector('.keys-tabs')?.textContent, tabNames().map((n, i) => (i + 1) + ' ' + n).join(' ')];`);
    check(t[0] === t[1] && t[1].startsWith('1 table 2 bound'), '?: the overlay lists the tabs with their digits, in order', JSON.stringify(t));
    await press('j');
    check(await page.eval(`${KH} return sel();`) === -1, 'j behind the overlay: no row selected');
    await press('Escape');
    const c = await page.eval(`${KH} return { open: dlg().open, focus: act(), expanded: $('keys-btn').getAttribute('aria-expanded') };`);
    check(!c.open && c.focus === 'BODY' && c.expanded === 'false', 'Escape closes the overlay; the focus goes back', JSON.stringify(c));
    await press('?'); await press('?');
    check(await page.eval(`${KH} return dlg().open;`) === false, '? again closes it');

    // the button, a click on the backdrop, the focus back on the button
    await page.eval(`${KH} $('keys-btn').focus(); $('keys-btn').click(); return 1;`);
    const b = await page.eval(`${KH} return { open: dlg().open, box: dlg().querySelector('.keys-inner').getBoundingClientRect().toJSON() };`);
    check(b.open, 'the ? button opens the overlay');
    await page.click(3, 3);
    const after = await page.eval(`${KH} return { open: dlg().open, focus: act() };`);
    check(!after.open && after.focus === 'keys-btn' && b.box.left > 3, 'a click on the backdrop closes it; the focus is back on the button', JSON.stringify([after, b.box]));
    await page.eval(`document.activeElement?.blur(); return 1;`);
  }

  // ---- the digits: the tabs in their order; the trace's digit opens it, again: back to the table -------------------------
  const tabs = await page.eval(`${KH} return tabNames();`);
  check(tabs.join() === 'table,bound,try,bytes,deps,mca,sweep,trace', 'the tabs, in their fixed order', tabs.join());
  {
    const seen = [];
    for (let i = 1; i <= tabs.length; i++) {
      await page.eval(`document.activeElement?.blur(); return 1;`);
      await press(String(i));
      seen.push(await page.eval(`${KH} return selected();`));
      if (i > 1) { await press(String(i)); seen.push(await page.eval(`${KH} return selected();`)); }
    }
    const want = tabs.flatMap((n, i) => (i ? [n, 'table'] : [n]));
    check(JSON.stringify(seen) === JSON.stringify(want), 'each digit picks its tab; again: the table', JSON.stringify(seen));
  }
  const T = await digit('trace'), B = await digit('bound');
  {
    await press(T);
    await page.waitFor(`document.querySelector('details.trace-panel')?.open && document.querySelector('details.trace-panel').wuicaTrace && /(^|&)trace=1(&|$)/.test(location.hash.slice(1))`, 'the trace (and its state in the address: the toggle event comes after the click)');
    const tab = await page.eval(`return [location.hash, document.querySelector('.view-tab[aria-selected="true"]')?.textContent];`);
    check(/(^|&)trace=1(&|$)/.test(tab[0].slice(1)) && tab[1] === 'trace', 'the trace\'s digit opens it (its tab, in the URL)', JSON.stringify(tab));
    await page.eval(`document.activeElement?.blur(); return 1;`);
    await press(T);
    await page.waitFor(`!document.querySelector('details.trace-panel').open`, 'the trace closed');
    check(await page.eval(`return document.querySelector('.view-tab[aria-selected="true"]')?.textContent;`) === 'table', 'its digit again closes it: the table tab');
  }

  // ---- j/k: rows, the card follows ------------------------------------------------------------------------------------------
  {
    const seen = [];
    for (const k of ['j', 'j', 'k', 'j', 'j']) {
      await press(k);
      seen.push(await page.eval(`${KH} return [sel(), card(), document.activeElement === trs()[sel()], act(), document.activeElement?.className];`));
    }
    const want = [0, 1, 0, 1, 2];
    check(seen.every((s, i) => s[0] === want[i] && s[1] === want[i] && s[2]), 'j/k: next/previous row selected and focused, the card follows', JSON.stringify(seen));
    // at the ends: stays
    await page.eval(`${KH} trs()[0].click(); return 1;`);
    await press('k');
    check(await page.eval(`${KH} return sel();`) === 0, 'k on the first row: stays');
    const url = await page.eval(`return location.hash;`);
    check(/(^|&)sel=0(&|$)/.test(url.slice(1)) || /sel/.test(url), 'the selection is in the URL', url);
    // the selection carries over to the trace tab; j there steps on (the card follows), and the trace with it
    await page.eval(`document.activeElement?.blur(); return 1;`);
    await press(T);
    await page.waitFor(`document.querySelector('details.trace-panel')?.open && document.querySelector('.trace-viewer canvas')`, 'the trace again');
    const inTrace = async () => page.eval(`${KH} await wait(50); return [sel(), card(), document.querySelector('details.trace-panel').wuicaTrace?.selKey ?? null];`);
    const t0 = await inTrace();
    await press('j');
    const t1 = await inTrace();
    check(t0[0] === 0 && t0[1] === 0 && t0[2] === '0/instr' && t1[0] === 1 && t1[1] === 1 && t1[2] === '1/instr', 'the trace tab: the selection carries over (the trace marks it); j selects the next row', JSON.stringify([t0, t1]));
    await page.eval(`document.activeElement?.blur(); return 1;`);
    await press(T);
    await page.waitFor(`!document.querySelector('details.trace-panel').open`, 'the trace closed');
  }

  // ---- / and typing in the editor; Escape leaves it ---------------------------------------------------------------------------
  {
    await page.eval(`document.activeElement?.blur(); return 1;`);
    const before = await page.eval(`${KH} return [ $('code').value, sel() ];`);
    await press('/');
    const f = await page.eval(`${KH} return [act(), $('code').value];`);
    check(f[0] === 'code' && f[1] === before[0], '/ focuses the code; nothing typed', JSON.stringify(f));
    await page.eval(`${KH} const c = $('code'); c.setSelectionRange(c.value.length, c.value.length); return 1;`);
    for (const k of ['j', 'k', 'a', '1', 'n']) await press(k);
    const t = await page.eval(`${KH} return { v: $('code').value, sel: sel(), ab: document.body.classList.contains('ab-on'), bound: $('bound')?.open ?? null, focus: act() };`);
    check(t.v === before[0] + 'jka1n' && t.sel === before[1] && !t.ab && !t.bound && t.focus === 'code', 'typing j k a 1 n in the code only types', JSON.stringify(t));
    await press('Escape');
    check(await page.eval(`${KH} return act();`) !== 'code', 'Escape leaves the code');
    await page.eval(`${KH} set($('code'), ${JSON.stringify(before[0])}); return 1;`);
  }

  // ---- the bound tab's digit; n/p through its hot rows; a: A–B, its tabs -----------------------------------------------------
  {
    await page.eval(`${KH} await done(() => $('run').click()); await until(settled); document.activeElement?.blur(); return 1;`);
    await press(B);
    await page.waitFor(`document.querySelector('#bound')?.open && document.querySelector('.bd-item')`, 'the bound view');
    // (the bound view paints again when the details come: wait for them)
    await page.eval(`${KH} await until(() => document.querySelector('.bd-slots'), 10000).catch(() => {}); await wait(50); return 1;`);
    const hot = await page.eval(`${KH} return trs().map((tr, i) => [i, tr.classList.contains('bd-hot') ? Number.parseFloat(tr.cells[0].style.getPropertyValue('--bd')) || 0 : -1])
      .filter((x) => x[1] >= 0).sort((a, b) => b[1] - a[1] || a[0] - b[0]).map((x) => x[0]);`);
    await page.eval(`${KH} document.activeElement?.blur(); return 1;`);
    const start = await page.eval(`${KH} return sel();`);
    const got = [];
    for (const k of ['n', 'n', 'p', 'p']) { await press(k); got.push(await page.eval(`${KH} return [sel(), card()];`)); }
    const at = (i) => hot[((i % hot.length) + hot.length) % hot.length];
    const i0 = hot.indexOf(start) < 0 ? 0 : hot.indexOf(start) + 1; // the first n: the hottest, or the next after the selected one
    const want = [at(i0), at(i0 + 1), at(i0), at(i0 - 1)];
    check(hot.length > 0 && JSON.stringify(got.map((g) => g[0])) === JSON.stringify(want) && got.every((g) => g[0] === g[1]), 'n/p: the hot rows of the bound view, hottest first; the card follows', JSON.stringify({ hot, start, got, want }));
    await press(B);
    check(await page.waitFor(`!document.querySelector('#bound').open`, 'the bound view closed'), 'its digit again closes it');

    await page.eval(`document.activeElement?.blur(); return 1;`);
    await press('a');
    const on = await page.eval(`${KH} return [document.body.classList.contains('ab-on'), $('cmp-ab').checked];`);
    await page.eval(`document.activeElement?.blur(); return 1;`);
    await press('a');
    const off = await page.eval(`${KH} return [document.body.classList.contains('ab-on'), $('cmp-single').checked];`);
    check(on[0] && on[1] && !off[0] && off[1], 'a toggles A–B', JSON.stringify([on, off]));
    // A–B: the same places; the first tab is the diff, the views of one side (the switch at the end of the row)
    await page.eval(`document.activeElement?.blur(); return 1;`);
    await press('a');
    await page.waitFor(`document.querySelector('#ab-main') && document.querySelector('.view-tab')?.dataset.tab === 'diff' && !document.getElementById('results').hasAttribute('aria-busy')`, 'the A–B result');
    const abTabs = await page.eval(`${KH} return tabNames();`);
    await page.eval(`document.activeElement?.blur(); return 1;`);
    await press(B);
    const abBound = await page.eval(`${KH} await until(() => $('bound')?.open); return [selected(), [...document.querySelectorAll('.ws-side-btn')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')).join()];`);
    await press(B);
    const abBack = await page.eval(`${KH} return [selected(), !document.querySelector('.ws-side')];`);
    check(abTabs.join() === 'diff,bound,try,bytes,deps,mca,sweep,trace' && abBound[0] === 'bound' && abBound[1] === 'A*,B' && abBack[0] === 'diff' && abBack[1],
      'A–B: the tabs in the same places (diff first); the bound tab of side A, the side switch; its digit again: the diff', JSON.stringify([abTabs, abBound, abBack]));
    await page.eval(`document.activeElement?.blur(); return 1;`);
    await press('a');
    await page.waitFor(`!document.body.classList.contains('ab-on') && document.querySelector('.view-tab')?.dataset.tab === 'table'`, 'single mode again');
  }

  // ---- the overlay at 320 px, both themes ------------------------------------------------------------------------------------
  for (const [w, scheme] of [[320, 'dark'], [320, 'light'], [2560, 'light']]) {
    await page.size(w, 800);
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await page.eval(`document.activeElement?.blur(); return 1;`);
    await press('?');
    const r = await page.eval(`${KH} const d = dlg(), i = d.querySelector('.keys-inner'), b = i.getBoundingClientRect();
      return { open: d.open, over: overflow(), dOver: d.scrollWidth - d.clientWidth, left: b.left, right: b.right, w: innerWidth,
        bg: getComputedStyle(i).backgroundColor, fg: getComputedStyle(d.querySelector('dd')).color };`);
    check(r.open && r.over <= 0 && r.dOver <= 0 && r.left >= 0 && r.right <= r.w && r.bg !== r.fg && r.bg !== 'rgba(0, 0, 0, 0)', `overlay at ${w} px (${scheme}): fits, no sideways scroll`, JSON.stringify(r));
    await press('Escape');
  }
  await page.size(1280, 900);

  // ---- SHA-256: j on the drawn table; the handler's time ---------------------------------------------------------------------
  {
    // (the showcase loads its assembly first, showcase-asm.js: wait for its own result)
    // (wait for the state: the SHA-256 result drawn and current, nothing running; not for one run, which may be another's)
    await page.eval(`${KH} await until(settled, 60000); set($('examples'), 'sha256');
      await until(() => tp() === '744.25' && (document.querySelector('table.uops')?.vr?.count ?? 0) >= 2949 && settled() && $('mode-asm').checked && $("code").value.startsWith("loop:\\n  mov qword ptr [rsp+0x98], r8"), 120000);
      document.activeElement?.blur(); return 1;`);
    const r = await page.eval(`${KH}
      const n = document.querySelector('table.uops').vr.count, ms = [], s0 = sel();
      for (let i = 0; i < 5; i++) { const t0 = performance.now(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })); ms.push(performance.now() - t0); }
      // past the fold: the row stays in view, above the card (it sticks to the bottom of a long table)
      for (let i = 0; i < 40; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
      const r = document.querySelector('table.uops tbody tr.tl-sel').getBoundingClientRect(), c = $('icard').getBoundingClientRect();
      const seen = r.top >= 0 && r.bottom <= Math.min(innerHeight, $('icard').classList.contains('stick') ? c.top : Infinity);
      return { n, s0, sel: sel() - 40, card: card() - 40, ms, seen, r: [r.top, r.bottom], c: [c.top, c.bottom], h: innerHeight };`);
    const want = r.s0 < 0 ? 4 : r.s0 + 5;
    check(r.seen, 'SHA-256: j past the fold: the row in view, not under the card', JSON.stringify(r));
    check(r.n >= 2949 && r.sel === want && r.card === want, 'SHA-256: j moves row by row (drawn as it goes)', JSON.stringify(r));
    console.log(`SHA-256 (${r.n} rows): j handler ${r.ms.map((x) => x.toFixed(1)).join(', ')} ms`);
  }

  const problems = page.take();
  check(problems.length === 0, 'no console errors or exceptions', JSON.stringify(problems));
} finally {
  await close();
  await srv.stop();
}
process.exit(check.summary() ? 1 : 0);
