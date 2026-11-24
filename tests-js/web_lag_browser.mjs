// The page stays responsive with the SHA-256 showcase (2,949 instructions): every interaction, in single mode and A–B,
// with a deterministic budget where there is one (vrows.js: the uop tables draw a window of rows, not thousands; a tab
// shown again is not built again; the trace and the dependency graph come from the analyzer's worker) and, for noise,
// no main-thread task over LONG_TASK_MS (cdp.mjs: 200 ms, 400 on CI). The long tasks over 50 ms are printed.
// Headless Chrome through tests-js/cdp.mjs; skipped without it.
//
//   node tests-js/web_lag_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT, LONG_TASK_MS } from './cdp.mjs';

const chrome = findChrome();
const check = checker('lag browser');
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(check.summary() ? 1 : 0); }

const ROW_WINDOW = 200; // rows a uop table may draw at once (vrows.js: the view and 30 on each side)
const DOM_MAX = 8000;   // elements in the page with the showcase, any tab (before: 44,732 with all rows, 72,687 with the trace,
                        // 16,000 more for the dependency graph; now about 2,500 to 3,600)

const srv = await serve(copyDist());
const { browser, close } = await launch(chrome);
try {
  const p = await Page.open(browser, { width: 1440, height: 900 });
  await p.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });` });
  await p.goto(`${srv.origin}/?nosw=1`);
  await p.ready();
  const PRE = `${HELPERS}
    const idle = () => $('status-wrap').classList.contains('idle') && !$('results').hasAttribute('aria-busy');
    const settle = async (ms = 500) => { await wait(100); await until(idle, 180000); await wait(ms); };
    const tab = (n) => [...document.querySelectorAll('.view-tab')].find((b) => b.dataset.tab === n).click();
    const drawn = (root = document) => Math.max(0, ...[...root.querySelectorAll('table.uops, table.ab-diff')].map((t) => t.querySelectorAll('tbody tr:not(.vr-pad):not(.vr-size)').length));
    const elements = () => document.getElementsByTagName('*').length;`;
  const table = [];
  // one interaction: js runs it; extra (after it settled) returns what the budget checks need
  const step = async (name, js, extra = 'return {};') => {
    const r = await p.eval(`${PRE} const t0 = performance.now(); ${js}; await settle();
      const out = await (async () => { ${extra} })();
      return { ...out, lt: window.__lt.filter(([s]) => s >= t0).map(([, d]) => Math.round(d)), drawn: drawn(), elements: elements() };`, { timeout: 400000 });
    table.push(`${name.padEnd(30)} ${r.lt.length ? r.lt.join(' + ') + ' ms' : 'none'} (rows drawn ${r.drawn}, elements ${r.elements})`);
    check(r.lt.every((d) => d < LONG_TASK_MS), `${name}: no task of ${LONG_TASK_MS} ms or more`, JSON.stringify(r.lt));
    check(r.drawn <= ROW_WINDOW && r.elements <= DOM_MAX, `${name}: at most ${ROW_WINDOW} rows drawn per table and ${DOM_MAX} elements`, JSON.stringify([r.drawn, r.elements]));
    return r;
  };

  await p.eval(`${PRE} await settle(); return 1;`);
  const pick = await step('pick SHA-256', `$('examples').value = 'sha256'; $('examples').dispatchEvent(new Event('change', { bubbles: true })); await until(() => (document.querySelector('#result-body .meta')?.title ?? '').startsWith('2949 instructions'), 120000)`,
    `const t = document.querySelector('#result-body table.uops'); return { count: t.vr.count, button: !!document.querySelector('.more-rows button') };`);
  check(pick.count >= 2949 && !pick.button, 'every row is a scroll away (no "show all")', JSON.stringify(pick));
  const end = await step('scroll the table to its end', `const w = document.querySelector('#result-body .table-wrap'); for (let i = 0; i < 30; i++) { w.scrollTop += 2000; await new Promise((r) => requestAnimationFrame(r)); }`,
    `const t = document.querySelector('#result-body table.uops'); const rows = [...t.querySelectorAll('tbody tr[data-row]')]; return { last: Number(rows.at(-1)?.dataset.row), count: t.vr.count };`);
  check(end.last === end.count - 1, 'scrolled to the end: the last row is drawn', JSON.stringify(end));
  await step('click a row (card)', `document.querySelector('#result-body .table-wrap').scrollTop = 0; await wait(100); document.querySelector('table.uops tbody tr[data-row="12"] th').click()`);
  const keys = await step('arrow keys over 40 rows', `document.querySelector('table.uops tbody tr[data-row="12"]').focus(); for (let i = 0; i < 40; i++) { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await new Promise((r) => requestAnimationFrame(r)); }`,
    `return { at: Number(document.activeElement?.dataset?.row) };`);
  check(keys.at === 52, 'the arrows move the focus row by row (row 52 after 40 from 12)', JSON.stringify(keys));
  await step('n ×5 (hot rows)', `for (let i = 0; i < 5; i++) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })); await wait(30); }`);
  await step('waits', `document.querySelector('.tl-waits-box').click()`);
  await step('cost (and compute)', `document.querySelector('.ins-cost-box').click(); await wait(300); document.querySelector('.ins-cost-status button')?.click(); await until(() => $('result-body').dataset.cost === 'done', 300000)`);
  const tr1 = await step('trace tab', `tab('trace'); await until(() => document.querySelector('details.trace-panel')?.wuicaTrace, 60000)`, `window.__v = document.querySelector('details.trace-panel').wuicaTrace; return {};`);
  await step('trace: all + zoom', `const s = document.querySelector('.trace-tools select'); s.value = 'all'; s.dispatchEvent(new Event('change')); await wait(200); document.querySelector('.trace-zoom[aria-label="zoom in"]').click()`);
  await step('trace: scroll', `const sc = document.querySelector('.trace-scroll'); for (let i = 0; i < 20; i++) { sc.scrollTop += 800; await new Promise((r) => requestAnimationFrame(r)); }`);
  await step('deps tab', `tab('deps'); await until(() => document.querySelector('#deps-row svg') || document.querySelector('#deps-row [data-state="error"]'), 120000)`, `window.__svg = document.querySelector('#deps-row svg'); return {};`);
  const dsc = await step('deps: scroll to the end', `const w = document.querySelector('#deps-row .dp-wrap'); for (let i = 0; i < 30; i++) { w.scrollTop += 3000; await new Promise((r) => requestAnimationFrame(r)); }`,
    `const ids = [...document.querySelectorAll('#deps-row .dp-node')].map((x) => Number(x.dataset.i)); return { last: Math.max(...ids), nodes: ids.length };`);
  check(dsc.last >= 2940 && dsc.nodes < 400, 'deps: the instructions near the view are drawn (the last ones at the end)', JSON.stringify(dsc));
  const back = await step('back to the table', `window.__table = document.querySelector('#result-body table.uops'); tab('table')`,
    `return { same: document.querySelector('#result-body table.uops') === window.__table };`);
  check(back.same, 'the table tab comes back as it was (not drawn again)');
  const backT = await step('back to the trace', `tab('trace')`, `return { same: document.querySelector('details.trace-panel').wuicaTrace === window.__v };`);
  const backD = await step('back to the deps', `tab('deps')`, `return { same: document.querySelector('#deps-row svg') === window.__svg };`);
  check(backT.same && backD.same, 'the trace and the dependency graph come back as they were (not built again)', JSON.stringify([backT.same, backD.same]));
  await step('back to the table again', `tab('table')`);
  await step('tick ZEN3', `const b = [...document.querySelectorAll('#cpu-grid input')].find((x) => x.value === 'ZEN3'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true }))`);
  await step('type one character (live)', `const c = $('code'); c.value += ' '; c.dispatchEvent(new Event('input', { bubbles: true })); await wait(1500)`);
  await step('A–B', `$('cmp-ab').click(); await settle(); if ($('code-b').value !== $('code').value) $('ab-copy').click()`);
  await step('A–B: scroll the tables', `const w = document.querySelector('#ab-main .table-wrap'); for (let i = 0; i < 20; i++) { w.scrollTop += 1500; await new Promise((r) => requestAnimationFrame(r)); }`);
  await step('A–B: Δ fold', `document.querySelector('#ab-main details.ab-fold > summary').click()`);
  await step('A–B: trace tab', `tab('trace'); await until(() => document.querySelector('details.trace-ab')?.wuicaTraces, 60000)`);
  await step('A–B: back to the diff', `tab('diff')`);
  console.log(table.join('\n'));
  check(p.problems.length === 0, 'no console errors', p.problems.join('\n'));
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  await close();
  await srv.stop();
}
process.exit(check.summary() ? 1 : 0);
