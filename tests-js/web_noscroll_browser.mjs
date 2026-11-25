// From 1200 × 700 up the page is a fixed frame and only its sections scroll (web/css/style.css, web/js/workspace.js):
// at 1440 × 900 and 1200 × 700, single and A–B, with a small loop and with the showcase (SHA-256, 2,949 instructions),
// every tab: the document does not scroll; Analyze and the CPUs are in the window; with the tab's sections scrolled to
// their ends the headline, the tab strip and the view's controls stay in the window. Also: the table with the uiCA
// report open, each of A–B's folds open (one at a time there), A and B side by side when wide and their rows scrolling
// together, the limitations as a popover, the trace's legend open. A shorter window
// (1200 × 600) scrolls as before, with Analyze reachable. Headless Chrome through tests-js/cdp.mjs (it honours
// WUICA_TEST_SCROLLBARS and WUICA_TEST_FONT); skipped (exit 0) without Chrome.
//
//   node tests-js/web_noscroll_browser.mjs [--chrome PATH]
//
// WUICA_SHARD=k/n (scripts/check.mjs runs n shards in parallel in `full`): only the k-th of every n of the cases below,
// each of which opens a page of its own; the shards' check counts add up to the count of a whole run.
import fs from 'node:fs';
import path from 'node:path';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';

const chrome = findChrome();
const check = checker('no-scroll browser');
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(check.summary() ? 1 : 0); }

const [shard, shards] = (process.env.WUICA_SHARD || '0/1').split('/').map(Number);
if (!(shards >= 1 && shard >= 0 && shard < shards)) { console.log(`WUICA_SHARD=${process.env.WUICA_SHARD}: not k/n with 0 <= k < n`); process.exit(2); }
let caseNo = -1;
const mine = () => ++caseNo % shards === shard; // (called once per case, in order, whatever the shard)

const SMALL = 'loop:\n  add rax, [rsi]\n  add rsi, 8\n  imul rbx, rax\n  vaddps ymm0, ymm0, ymm1\n  dec rcx\n  jnz loop\n';

// in the page: wait until the analyses are done and the pane's content stops changing size
const SETTLE = `${HELPERS}
  const idle = () => $('status-wrap').classList.contains('idle') && !$('results').hasAttribute('aria-busy');
  const settle = async () => {
    await wait(150); await until(idle, 120000);
    let last = '', same = 0;
    for (let i = 0; i < 80 && same < 3; i++) {
      await wait(200);
      const now = [$('results').scrollHeight, $('result-body').offsetHeight, $('more').offsetHeight, idle()].join();
      same = now === last && idle() ? same + 1 : 0; last = now;
    }
  };
  // the document must not scroll; Analyze and the CPUs are in reach; and with the shown tab's sections (and the result
  // pane, were it to scroll) scrolled to their ends, the headline, the tab strip and the view's controls are still in the
  // window. (Sections may scroll; the frame may not.)
  const measure = () => {
    const se = document.scrollingElement, inp = $('input'), res = $('results');
    const out = { page: se.scrollHeight - innerHeight };
    out.run = Math.round($('run').getBoundingClientRect().bottom - innerHeight);
    out.cpus = Math.round($('cpu-grid').getBoundingClientRect().bottom - Math.min(innerHeight, inp.getBoundingClientRect().bottom));
    const opened = document.querySelector('#more details[open]');
    const shown = opened ?? $('result-body');
    const sc = [...shown.querySelectorAll('.trace-scroll, .dp-wrap, .ly-wrap, .mca-out, .table-wrap, details[open] > pre, .ab-pair pre')]
      .filter((e) => e.getClientRects().length && !e.closest('details:not([open])'));
    out.scrollers = sc.length;
    out.paneScrolls = res.scrollHeight > res.clientHeight; // (allowed; reported)
    const keep = [...sc, res].map((e) => [e, e.scrollTop]);
    for (const e of [...sc, res]) e.scrollTop = e.scrollHeight;
    const controls = opened ? [...opened.children].find((c) => c.tagName !== 'SUMMARY' && c.getClientRects().length) : null;
    const fixed = { headline: document.querySelector('#result-body > .row.lead'), tabs: document.querySelector('#result-body > .view-tabs'), controls };
    out.away = Object.entries(fixed).filter(([, e]) => e && (e.getBoundingClientRect().top < 0 || e.getBoundingClientRect().top > innerHeight - 10)).map(([k]) => k);
    for (const [e, t] of keep) e.scrollTop = t;
    return out;
  };
`;
const ok = (m) => m.page <= 0 && m.run <= 0 && m.cpus <= 0 && m.away.length === 0;

const dir = copyDist();
const srv = await serve(dir);
const { browser, close } = await launch(chrome);
try {
  for (const [w, h] of [[1440, 900], [1200, 700]]) for (const mode of ['single', 'ab']) for (const content of ['small', 'showcase']) {
    if (!mine()) continue;
    const what = `${w}×${h} ${mode === 'ab' ? 'A–B' : 'single'} ${content}`;
    const page = await Page.open(browser, { width: w, height: h });
    await page.goto(`${srv.origin}/?nosw=1`);
    await page.ready();
    const r = await page.eval(`${SETTLE}
      cpus('SKL', 'ZEN3', 'ADL-P'); await settle();
      if (${JSON.stringify(content)} === 'showcase') {
        $('examples').value = 'sha256'; $('examples').dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => (document.querySelector('#result-body .meta')?.title ?? '').startsWith('2949 instructions'), 120000);
      } else { $('mode-asm').click(); set($('code'), ${JSON.stringify(SMALL)}); await done(() => $('run').click()); }
      await settle();
      if (${JSON.stringify(mode)} === 'ab') { await done(() => $('cmp-ab').click(), 120000); await settle(); if ($('code-b').value !== $('code').value) { $('ab-copy').click(); await until(() => $('code-b').value === $('code').value); } await settle(); }
      const out = { tabs: {} };
      for (const name of [...document.querySelectorAll('.view-tab')].map((b) => b.dataset.tab)) {
        [...document.querySelectorAll('.view-tab')].find((b) => b.dataset.tab === name).click();
        await settle();
        out.tabs[name] = measure();
        // the trace: its legend open too
        if (name === 'trace') { const q = document.querySelector('.trace-keybtn'); q?.click(); await wait(100); out.tabs['trace legend'] = measure(); q?.click(); }
      }
      [...document.querySelectorAll('.view-tab')][0].click(); await settle();
      if (${JSON.stringify(mode)} === 'single') {
        // the report under the table: in the pane's height
        document.querySelector('details.report-wrap summary').click(); await settle();
        out.tabs['table + report'] = measure();
        document.querySelector('details.report-wrap summary').click(); await settle();
      } else {
        // each fold open: in the pane's height; one open at a time
        for (const d of document.querySelectorAll('#ab-main details.ab-fold')) {
          d.querySelector('summary').click(); await settle();
          out.tabs['fold ' + d.querySelector('summary').textContent.trim().slice(0, 12)] = { ...measure(), open: document.querySelectorAll('#ab-main details.ab-fold[open]').length };
        }
        document.querySelectorAll('#ab-main details.ab-fold[open]').forEach((d) => { d.open = false; });
      }
      // the options popover open
      $('advanced').querySelector('summary').click(); await wait(100); out.tabs.options = measure(); $('advanced').querySelector('summary').click();
      return out;`, { timeout: 900000 });
    for (const [tab, m] of Object.entries(r.tabs)) check(ok(m) && (m.open ?? 1) === 1, `${what}, ${tab}: the document does not scroll; Analyze and the CPUs in the window; the sections scrolled to their ends leave the headline, the tabs and the view's controls in the window`, JSON.stringify(m));
    const paneScrolls = Object.entries(r.tabs).filter(([, m]) => m.paneScrolls).map(([t]) => t);
    console.log(`${what}: the result pane itself scrolls in: ${paneScrolls.join(', ') || 'none'}`);
    check(r.tabs[mode === 'ab' ? 'diff' : 'table'].scrollers >= (mode === 'ab' ? 2 : 1), `${what}: the table${mode === 'ab' ? 's' : ''} scroll${mode === 'ab' ? '' : 's'} inside`, JSON.stringify(r.tabs));
    check(page.problems.length === 0, `${what}: no console errors`, page.problems.join('\n'));
    await page.close();
  }

  // A–B's diff tab, wide: A and B side by side when each half has room for its columns; the folds one line under them;
  // a long block (stacked): the two tables' rows scroll together
  if (mine()) {
    const page = await Page.open(browser, { width: 2000, height: 1140 });
    await page.goto(`${srv.origin}/?nosw=1`);
    await page.ready();
    const r = await page.eval(`${SETTLE}
      cpus('SKL'); await settle();
      $('mode-asm').click(); set($('code'), ${JSON.stringify(SMALL)}); await done(() => $('run').click()); await settle();
      await done(() => $('cmp-ab').click(), 120000); await settle();
      if ($('code-b').value !== $('code').value) { $('ab-copy').click(); await until(() => $('code-b').value === $('code').value); } await settle();
      const wraps = () => [...document.querySelectorAll('#ab-main .ab-stack .table-wrap')];
      const out = { side: document.querySelector('#ab-main .ab-stack').classList.contains('ab-side'), tops: wraps().map((w) => Math.round(w.getBoundingClientRect().top)),
        folds: [...new Set([...document.querySelectorAll('#ab-main details.ab-fold > summary')].map((x) => Math.round(x.getBoundingClientRect().top)))].length, m: measure() };
      $('examples').value = 'sha256'; $('examples').dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => $('code').value.includes('rsp+0x98') && /744\\.25/.test(document.querySelector('.ab-tp')?.textContent ?? ''), 120000); await settle();
      if ($('code-b').value !== $('code').value) { $('ab-copy').click(); await until(() => $('code-b').value === $('code').value); } await settle();
      await until(() => (document.querySelector('#ab-main .ab-stack table.uops')?.vr?.count ?? 0) >= 2949, 120000); await settle();
      out.long = { side: document.querySelector('#ab-main .ab-stack').classList.contains('ab-side'), m: measure() };
      const [a, b] = wraps(); a.scrollTop = 600; await wait(200);
      out.long.sync = [a.scrollTop, b.scrollTop];
      b.scrollTop = 200; await wait(200);
      out.long.back = [a.scrollTop, b.scrollTop];
      return out;`, { timeout: 600000 });
    check(r.side && r.tops.length === 2 && r.tops[0] === r.tops[1] && r.folds === 1 && ok(r.m), 'A–B at 2000 px, a small loop: A and B side by side, the folds on one line under them; nothing scrolls', JSON.stringify(r));
    check(!r.long.side && ok(r.long.m), 'A–B at 2000 px, the showcase (more columns): stacked, nothing scrolls', JSON.stringify(r.long));
    check(r.long.sync[0] === 600 && Math.abs(r.long.sync[1] - 600) <= 1 && Math.abs(r.long.back[0] - 200) <= 1 && r.long.back[1] === 200, 'A–B: the two tables\' rows scroll together (the same code: the same rows)', JSON.stringify(r.long));
    check(page.problems.length === 0, 'no console errors (A–B wide)', page.problems.join('\n'));
    await page.close();
  }

  // the limitations: a popover from the top bar (the page does not scroll to them); Escape closes it
  if (mine()) {
    const page = await Page.open(browser, { width: 1440, height: 900 });
    await page.goto(`${srv.origin}/?nosw=1`);
    await page.ready();
    const r = await page.eval(`${HELPERS}
      const link = document.querySelector('.top nav a[href="#about"]'), about = $('about');
      const out = { closed: about.getClientRects().length === 0 };
      link.click(); await wait(50);
      const b = about.getBoundingClientRect();
      out.open = [b.height > 20 && b.bottom <= innerHeight && b.top >= 0, link.getAttribute('aria-expanded'), scrollY, location.hash, document.scrollingElement.scrollHeight - innerHeight];
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(50);
      out.esc = [about.getClientRects().length === 0, link.getAttribute('aria-expanded'), document.activeElement === link];
      return out;`);
    check(r.closed && r.open[0] && r.open[1] === 'true' && r.open[2] === 0 && !/about/.test(r.open[3]) && r.open[4] <= 0, 'the limitations: a popover from the top bar, in the window; the page does not scroll', JSON.stringify(r));
    check(r.esc[0] && r.esc[1] === 'false' && r.esc[2], 'the limitations: Escape closes the popover (the focus back on the link)', JSON.stringify(r.esc));
    check(page.problems.length === 0, 'no console errors (limitations)', page.problems.join('\n'));
    await page.close();
  }

  // a shorter window: it scrolls as before (nothing trapped): Analyze is in the window or the input pane scrolls to it
  if (mine()) {
    const page = await Page.open(browser, { width: 1200, height: 600 });
    await page.goto(`${srv.origin}/?nosw=1`);
    await page.ready();
    const r = await page.eval(`${HELPERS}
      const inp = $('input'), run = $('run').getBoundingClientRect();
      const scrolls = getComputedStyle(inp).overflowY !== 'hidden' || document.scrollingElement.scrollHeight > innerHeight;
      return { inWindow: run.bottom <= innerHeight, scrolls, about: getComputedStyle($('about')).position };`);
    check((r.inWindow || r.scrolls) && r.about !== 'fixed', 'at 1200 × 600: Analyze in reach (the pane or the page scrolls); the limitations in the page', JSON.stringify(r));
    await page.close();
  }
  // the status line in the top bar stays one line in the window with a long text (a CPU that cannot run the code, all
  // CPUs checked): cut with …, the whole text in its title
  for (const [w, h] of [[1440, 900], [1200, 700]]) {
    if (!mine()) continue;
    const page = await Page.open(browser, { width: w, height: h });
    await page.goto(`${srv.origin}/?nosw=1`);
    await page.ready();
    const avx = fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/dogfood/avx512.s'), 'utf8');
    const r = await page.eval(`${SETTLE}
      $('cpu-all').click(); set($('code'), ${JSON.stringify(avx)}); await done(() => $('run').click()); await settle();
      await until(() => document.querySelector('table.cmp-cpus tr[data-arch="ZEN3"]'), 90000);
      document.querySelector('table.cmp-cpus tr[data-arch="ZEN3"]').click(); await until(() => /ZEN3/.test($('status').textContent)); await wait(200);
      const s = $('status').getBoundingClientRect(), lh = parseFloat(getComputedStyle($('status')).lineHeight);
      return { text: $('status').textContent, title: $('status').title, top: Math.round(s.top), height: Math.round(s.height), lh: Math.round(lh) };`, { timeout: 200000 });
    check(/not a result/.test(r.text) && r.title === r.text && r.top >= 0 && r.height <= r.lh + 1, `${w}×${h}: the status line is one line in the window (cut with …, its text in the title)`, JSON.stringify(r));
    check(page.take().length === 0, `${w}×${h}: status line: no errors`);
    await page.close();
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  await close();
  await srv.stop();
}
process.exit(check.summary() ? 1 : 0);
