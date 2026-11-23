// The workspace of 0.1.6 in the built site, headless Chrome (started with --headless and --remote-debugging-port
// through tests-js/cdp.mjs), the real analyzer:
// - the folded input pane is a labelled strip the window's height ("input ▸"), kept across a reload; "\" unfolds it
// - the uop table: ports shown as P0.., the instruction column stays in view while the ports scroll sideways
// - phones: only the checked CPUs, the rest behind "more"; the result starts within the first screen
// - A–B: the table per CPU per element (as Node's analyzer gives it); the sweep and mca tabs of one side, the switch
// - A–B: a pasted side dims an out-of-date result at once; typing dims it only after a pause
// Skipped (exit 0) without Chrome.
//
//   node tests-js/web_workspace_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';

const chrome = findChrome();
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
const check = checker('workspace browser');

const dir = copyDist();
const imp = (f) => import(pathToFileURL(path.join(ROOT, 'web/js', f)).href);
const { WasmEngine, makeRequest } = await imp('engine.js');
const { CLASSIC_EXAMPLES } = await imp('examples.js');
const { encodeState } = await imp('url-state.js');
const engine = await WasmEngine.create(fs.readFileSync(path.join(dir, 'wuica_wasm.wasm')));
const uarchBytes = fs.readFileSync(path.join(dir, 'data/uarch.json'));
await engine.loadUarch(uarchBytes);
const configs = JSON.parse(uarchBytes).configs;
async function tpOf(hex, arch) {
  const t = configs[arch].name;
  if (!engine.hasArch(t)) await engine.loadArch(t, fs.readFileSync(path.join(dir, 'data/arch', `${t}.json`)));
  return Number((await engine.analyze(makeRequest(hex, arch))).tp);
}
const ex = (id) => CLASSIC_EXAMPLES.find((e) => e.id === id);
const W = `${HELPERS}
  const rect = (el) => (typeof el === 'string' ? document.querySelector(el) : el).getBoundingClientRect();
  const settled = () => !$('results').hasAttribute('aria-busy') && !$('result-body').classList.contains('stale') && !!$('results').dataset.run;
  const tabNames = () => [...document.querySelectorAll('#result-body > .view-tabs > .view-tab')].map((b) => b.dataset.tab);
  const pick = async (name) => { document.querySelector('.view-tab[data-tab="' + name + '"]').click(); await until(() => document.querySelector('.view-tab[data-tab="' + name + '"]')?.getAttribute('aria-selected') === 'true'); };
`;

const srv = await serve(dir);
const { browser, close } = await launch(chrome);
try {
  const saxpy = encodeState({ mode: 'asm', text: ex('saxpy').text.intel, arch: 'ADL-P' });
  // ---- the folded input: a labelled strip, kept across a reload ------------------------------------------------------------
  {
    const page = await Page.open(browser, { width: 1440, height: 900 });
    await page.goto(`${srv.origin}/?nosw=1#${saxpy}`);
    await page.waitFor(`document.getElementById('results').dataset.run && document.querySelector('#result-body .tp .value')`, 'the result', 60000);
    const open = await page.eval(`${W} const b = $('input-fold'); return [b.textContent, b.getAttribute('aria-expanded'), Math.round(rect('#results').left)];`);
    await page.eval(`${W} $('input-fold').click(); return 1;`);
    const fold = async () => page.eval(`${W} const b = $('input-fold'), r = rect(b);
      return { text: b.textContent, expanded: b.getAttribute('aria-expanded'), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), code: $('code').offsetParent === null,
        results: Math.round(rect('#results').left), color: getComputedStyle(b).color !== getComputedStyle(document.body).backgroundColor };`);
    const f = await fold();
    await page.reload();
    await page.waitFor(`document.getElementById('results').dataset.run`, 'the result after a reload', 60000);
    const g = await fold();
    await page.eval(`document.activeElement?.blur(); return 1;`);
    await page.key('\\', { code: 'Backslash', keyCode: 220 });
    const u = await page.eval(`${W} return [$('input-fold').textContent, $('code').offsetParent !== null];`);
    check(open[0] === '◂' && open[1] === 'true', 'fold: open, a small button', JSON.stringify(open));
    check(f.text === 'input ▸' && f.expanded === 'false' && f.w >= 18 && f.h > 600 && f.code && f.results < open[2] && f.results >= f.left + f.w && f.color, 'fold: folded, a labelled strip the window\'s height ("input ▸") beside the result', JSON.stringify(f));
    check(g.text === 'input ▸' && g.h > 600 && g.code, 'fold: kept across a reload, the strip as before', JSON.stringify(g));
    check(u[0] === '◂' && u[1], 'fold: \\ unfolds it', JSON.stringify(u));

    // ---- the uop table: P0.., the instruction column in view while the ports scroll ----------------------------------------
    await page.size(1200, 800);
    const t = await page.eval(`${W} const wrap = document.querySelector('#result-body .table-wrap'), th = wrap.querySelector('tbody th.first');
      const head = [...wrap.querySelectorAll('thead th')].map((x) => x.textContent + (x.dataset.col && x.dataset.col !== x.textContent ? '=' + x.dataset.col : ''));
      const before = Math.round(rect(th).left - rect(wrap).left);
      wrap.scrollLeft = wrap.scrollWidth; await wait(50);
      return { head, sticky: getComputedStyle(th).position, before, after: Math.round(rect(th).left - rect(wrap).left), scrolled: wrap.scrollLeft,
        bg: getComputedStyle(th).backgroundColor, last: rect(wrap.querySelector('thead th:last-child')).right <= rect(wrap).right + 1 };`);
    check(t.head.includes('P0=Port 0') && t.head.includes('P9=Port 9') && t.head[0] === 'Instruction', 'uop table: ports shown as P0.. (the full name kept)', JSON.stringify(t.head));
    check(t.sticky === 'sticky' && Math.abs(t.before - t.after) <= 1 && t.last && !/rgba\(.*, 0\)/.test(t.bg), 'uop table: the instruction column stays in view (opaque) while the ports scroll', JSON.stringify(t));
    check(page.take().length === 0, 'fold and table: no console errors');
    await page.close();
  }

  // ---- phones: the checked CPUs only, "more"; the result within the first screen -----------------------------------------------
  {
    const page = await Page.open(browser, { width: 375, height: 812, mobile: true });
    for (const [name, frag] of [['single', encodeState({ mode: 'asm', text: ex('saxpy').text.intel, arch: 'SKL', cpus: 'SKL,ZEN3' })],
      ['A–B', encodeState({ mode: 'asm', text: ex('dot1').text.intel, arch: 'SKL', cpus: 'SKL,ZEN3', ab: true, bMode: 'asm', bText: ex('dot4').text.intel })]]) {
      await page.goto(`${srv.origin}/?nosw=1#${frag}`);
      await page.waitFor(`document.getElementById('results').dataset.run && !document.getElementById('results').hasAttribute('aria-busy')`, `the ${name} result on a phone`, 60000);
      const r = await page.eval(`${W}
        const boxes = () => [...document.querySelectorAll('#cpu-grid label.cpu')].filter((l) => l.offsetParent).map((l) => l.textContent.replace('p', ''));
        const out = { shown: boxes(), more: $('cpu-more').offsetParent !== null && $('cpu-more').textContent, top: Math.round(rect('#results').top + scrollY), h: innerHeight, over: overflow() };
        $('cpu-more').click(); await wait(50);
        out.all = boxes().length; out.less = $('cpu-more').textContent; out.expanded = $('cpu-more').getAttribute('aria-expanded');
        $('cpu-more').click(); await wait(50);
        out.again = boxes().length;
        return out;`);
      check(r.shown.join() === 'SKL,ZEN3' && r.more === 'more' && r.all === 15 && r.less === 'less' && r.expanded === 'true' && r.again === 2 && r.over <= 0, `phone (${name}): only the checked CPUs, the rest behind "more"`, JSON.stringify(r));
      check(r.top < r.h, `phone (${name}): the result starts within the first screen`, JSON.stringify([r.top, r.h]));
    }
    check(page.take().length === 0, 'phone: no console errors');
    await page.close();
  }

  // ---- A–B: per element per CPU; the sweep and mca of one side; pasted code dims at once ----------------------------------------
  {
    const a = ex('dot1'), b = ex('dot4');
    const want = { SKL: [await tpOf(a.hex, 'SKL'), await tpOf(b.hex, 'SKL')], ZEN3: [await tpOf(a.hex, 'ZEN3'), await tpOf(b.hex, 'ZEN3')] };
    const page = await Page.open(browser, { width: 1440, height: 900 });
    await page.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'asm', text: a.text.intel, arch: 'SKL', cpus: 'SKL,ZEN3', ab: true, bMode: 'asm', bText: b.text.intel, aWork: 8, bWork: 32 })}`);
    await page.waitFor(`document.getElementById('ab-cpus')?.dataset.state === 'done' && document.querySelector('.ab-tp')`, 'the A–B result', 60000);
    const c = await page.eval(`${W} return { rows: [...document.querySelectorAll('#ab-cpus tbody tr')].map((tr) => [tr.dataset.arch, tr.cells[1].textContent, tr.cells[2].textContent, tr.classList.contains('current')]),
      unit: document.querySelector('.ab-tp .unit').textContent, work: [$('a-work').value, $('b-work').value] };`);
    const per = (arch) => [(want[arch][0] / 8).toFixed(2), (want[arch][1] / 32).toFixed(2)];
    check(c.rows.length === 2 && c.rows.every(([arch, x, y]) => x === per(arch)[0] && y === per(arch)[1]) && c.rows[0][3] && c.unit === 'cycles/element' && c.work.join() === '8,32',
      'A–B: the table per CPU per element (8 and 32 elements per iteration, from a link)', JSON.stringify([c, want]));

    // the sweep tab of B: B's alignment sweep; mca's tab is of the side too
    const s = await page.eval(`${W}
      await pick('sweep'); await until(() => $('cmp-sweep').dataset.state === 'done', 60000);
      const at0 = () => document.querySelector('.sweep-chart rect.hit')?.textContent ?? '';
      const out = { a: [document.querySelector('.ws-side-btn.on')?.textContent, at0()] };
      const n = Number($('cmp-sweep').dataset.runs || 0);
      document.querySelector('.ws-side-btn[data-tab="side-b"]').click();
      await until(() => Number($('cmp-sweep').dataset.runs || 0) > n && $('cmp-sweep').dataset.state === 'done', 60000);
      out.b = [document.querySelector('.ws-side-btn.on')?.textContent, at0(), document.body.dataset.abSide];
      await pick('trace'); out.traceSwitch = !!document.querySelector('.ws-side');
      await pick('mca'); out.mca = [!!document.querySelector('.ws-side'), document.querySelector('.ws-side-btn.on')?.textContent];
      document.querySelector('.ws-side-btn[data-tab="side-a"]').click(); await wait(50);
      await pick('diff');
      return out;`);
    const t0 = (v) => Number((/(\d+\.\d\d)/.exec(v) ?? [])[1]);
    check(s.a[0] === 'A' && t0(s.a[1]) === Number(want.SKL[0].toFixed(2)) && s.b[0] === 'B' && s.b[2] === 'b' && t0(s.b[1]) === Number(want.SKL[1].toFixed(2)),
      'A–B: the sweep tab is of one side; the switch shows B\'s', JSON.stringify([s, want.SKL]));
    check(!s.traceSwitch && s.mca[0] && s.mca[1] === 'B', 'A–B: the switch is there for the views of one side (mca), not for the traces of both', JSON.stringify(s));

    // pasted code dims an out-of-date result at once; typed code only after a pause (no flicker while typing)
    const d = await page.eval(`${W}
      await until(settled);
      const bc = $('code-b'), op = () => getComputedStyle($('result-body')).opacity;
      if ($('live').checked) $('live').click(); // (no new result meanwhile)
      bc.value = bc.value + ' '; bc.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }));
      const typed = [$('result-body').classList.contains('stale'), $('result-body').classList.contains('stale-now'), op()];
      bc.value = bc.value.slice(0, -1); bc.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      const back = [$('result-body').classList.contains('stale'), op()];
      bc.value = ${JSON.stringify(a.text.intel)}; bc.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
      const pasted = [$('result-body').classList.contains('stale'), $('result-body').classList.contains('stale-now'), op()];
      await done(() => $('run').click());
      await until(() => op() === '1', 5000).catch(() => {}); // (it brightens in 0.1 s)
      const after = [$('result-body').classList.contains('stale'), $('result-body').classList.contains('stale-now'), op()];
      return { typed, back, pasted, after };`);
    check(d.typed[0] && !d.typed[1] && d.typed[2] === '1' && !d.back[0], 'A–B: typed into B: stale, dimmed only after a pause', JSON.stringify(d));
    check(d.pasted[0] && d.pasted[1] && Number(d.pasted[2]) < 0.6, 'A–B: pasted into B: dimmed at once', JSON.stringify(d));
    check(!d.after[0] && !d.after[1] && d.after[2] === '1', 'A–B: the new result: not dimmed', JSON.stringify(d));
    check(page.take().length === 0, 'A–B: no console errors');
    await page.close();
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? e);
} finally {
  await close();
  await srv.stop();
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be writing */ }
}
process.exit(check.summary() ? 1 : 0);
