// QA round 2 (docs/plans/qa-r2.md): the views and details of features rounds 1 and 2 in headless Chrome (started with
// --headless and --remote-debugging-port through tests-js/cdp.mjs), with the real analyzer:
// - the URL state with each view open (bound, try, bytes, deps, trace, a selected row and its card): reload, and the copied
//   link in a new tab, give the same state and the same numbers
// - the bound view's port set and issue slots against the module's details run in Node
// - A–B mode with the views open: no errors; back to single mode restores them
// - keyboard only: each view's summary opens with Enter and closes with Space; a row's card with Enter, Escape closes it
// - both themes × widths 320–2560 with every view open: no horizontal scrolling, no errors
// - the SHA-256 showcase with every view open and a card: no long task of 100 ms or more
// - the links of the page: only the project's repository, uiCA, uops.info and the accuracy page
// Skipped (exit 0) without Chrome.
//
//   node tests-js/web_qa2_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';

const chrome = findChrome();
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
const check = checker('qa2 browser');

const dir = copyDist();
const { WasmEngine, makeRequest } = await import(pathToFileURL(path.join(ROOT, 'web/js/engine.js')).href);
const { EXAMPLES, CLASSIC_EXAMPLES } = await import(pathToFileURL(path.join(ROOT, 'web/js/examples.js')).href);
const engine = await WasmEngine.create(fs.readFileSync(path.join(dir, 'wuica_wasm.wasm')));
const uarchBytes = fs.readFileSync(path.join(dir, 'data/uarch.json'));
await engine.loadUarch(uarchBytes);
const configs = JSON.parse(uarchBytes).configs;
async function ref(hex, arch, options = {}) {
  const table = configs[arch].name;
  if (!engine.hasArch(table)) await engine.loadArch(table, fs.readFileSync(path.join(dir, 'data/arch', `${table}.json`)));
  return engine.analyze({ ...makeRequest(hex, arch, options), details: true });
}
const ex = (id) => [...EXAMPLES, ...CLASSIC_EXAMPLES].find((e) => e.id === id);

// in the page: the state of the result and of every view, once their contents are there
const SNAP = `
  const openOf = (id) => !!$(id)?.open;
  const trace = () => document.querySelector('#trace-slot details.trace-panel');
  const snap = async () => {
    await until(() => tp() && !$('results').hasAttribute('aria-busy'), 60000);
    const settle = async (f) => { try { await until(f, 20000); } catch { /* recorded as it is */ } };
    if (openOf('bound')) await settle(() => /slots/.test($('bound').innerText) || /no port/.test($('bound').innerText));
    if (openOf('whatif')) await settle(() => !/…/.test($('whatif').innerText) && /unroll ×8\\s+[\\d.]+/.test($('whatif').innerText));
    if (openOf('deps')) await settle(() => /edges/.test($('deps').innerText));
    if ($('icard') && !$('icard').hidden) await settle(() => $('result-body').dataset.icard === 'details');
    if (trace()?.open) await settle(() => trace().querySelector('canvas, svg'));
    await wait(100);
    const text = (id) => ($(id)?.open ? $(id).innerText.replace(/\\s+/g, ' ').trim() : null);
    return {
      tp: tp(), cpu: focused(), open: ['bound', 'whatif', 'codemap', 'deps'].filter(openOf).concat(trace()?.open ? ['trace'] : []),
      bound: text('bound'), whatif: text('whatif'), codemap: text('codemap'), deps: text('deps'),
      card: $('icard') && !$('icard').hidden ? $('icard').innerText.replace(/\\s+/g, ' ').trim() : null,
      sel: (() => { const i = [...document.querySelectorAll('#result-body table.uops tbody tr')].findIndex((r) => r.classList.contains('tl-sel')); return i < 0 ? null : i; })(),
    };
  };`;

const srv = await serve(dir);
const origin = srv.origin;
const { browser, close } = await launch(chrome);
try {
  const page = await Page.open(browser, { width: 1440, height: 900 });
  await page.goto(`${origin}/?nosw=1`);
  await page.ready();
  await page.eval(`${HELPERS} if ($('live').checked) $('live').click(); return 1;`);

  // ---- URL state with each view open, and all at once: reload and a new tab give the same state ----------------------------
  const cases = [
    { ex: 'chain', arch: 'SKL', views: ['bound'] }, { ex: 'chain', arch: 'SKL', views: ['whatif'] }, { ex: 'chain', arch: 'SKL', views: ['codemap'] },
    { ex: 'chain', arch: 'SKL', views: ['deps'] }, { ex: 'ptrchase', arch: 'ADL-P', views: ['bound'], row: 0 },
    { ex: 'loadstore', arch: 'ZEN3', views: ['bound', 'whatif', 'codemap', 'deps'], row: 1 }, { ex: 'chain', arch: 'ICX', views: ['trace'], row: 2 },
  ];
  for (const c of cases) {
    const what = `${c.ex} on ${c.arch} with ${c.views.join(', ')}${c.row !== undefined ? ` and row ${c.row}` : ''}`;
    const a = await page.eval(`${HELPERS} ${SNAP}
      for (const id of ['bound', 'whatif', 'codemap', 'deps']) if ($(id)?.open) document.querySelector('#' + id + ' summary').click();
      if (trace()?.open) trace().querySelector('summary').click();
      if (focused() !== ${JSON.stringify(c.arch)} || checkedCpus() !== ${JSON.stringify(c.arch)}) cpus(${JSON.stringify(c.arch)});
      $('mode-asm').click();
      await done(() => set($('examples'), ${JSON.stringify(c.ex)}));
      for (const v of ${JSON.stringify(c.views)}) (v === 'trace' ? trace() : $(v)).querySelector('summary').click();
      ${c.row !== undefined ? `document.querySelectorAll('table.uops tbody tr')[${c.row}].cells[2].click(); await wait(50);` : ''}
      const s = await snap();
      $('copy-link').click(); await wait(100); // writes the state to the address bar first (the clipboard may be refused)
      return { ...s, href: location.href };`);
    const want = await ref(ex(c.ex).hex, c.arch);
    // (a selected row opens the trace: trace-link.js)
    const views = c.row !== undefined && !c.views.includes('trace') ? [...c.views, 'trace'] : c.views;
    check(a.tp === want.tp.toFixed(2) && a.open.join() === views.join() && a.sel === (c.row ?? null), `url: ${what}: the result and the views`, JSON.stringify(a));
    // the numbers of the bound view: the issue slots of the details (the port set: web_views_browser.mjs)
    if (c.views.includes('bound')) {
      const s = want.details.issue?.slots;
      const total = s ? s.issued + s.frontEnd + s.rob + s.rs + s.other : 0;
      const issued = s ? `issued ${Math.round((s.issued / total) * 100)}%` : '';
      check(a.bound && (!s || a.bound.includes(issued)), `url: ${what}: the bound view's slots (${issued})`, a.bound);
    }
    // reload
    await page.reload();
    await page.ready();
    const b = await page.eval(`${HELPERS} ${SNAP} return await snap();`);
    check(JSON.stringify({ ...a, href: undefined }) === JSON.stringify(b), `url: ${what}: a reload gives the same state`, JSON.stringify([a, b]));
    // the link in a new tab
    const p2 = await Page.open(browser, { width: 1440, height: 900 });
    await p2.goto(a.href);
    await p2.ready();
    const n = await p2.eval(`${HELPERS} ${SNAP} return await snap();`);
    check(JSON.stringify({ ...a, href: undefined }) === JSON.stringify(n), `url: ${what}: the link in a new tab gives the same state`, JSON.stringify([a, n]));
    check(p2.take().length === 0 && page.take().length === 0, `url: ${what}: no console errors`);
    await p2.close();
    await page.eval(`${HELPERS} if ($('live').checked) $('live').click(); return 1;`);
  }

  // ---- an old link (the CPU table open: cmpcpu=1, no "as") with views: every CPU checked, the views open ---------------------
  {
    const hex = ex('chain').hex;
    const b64 = Buffer.from(hex).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const p2 = await Page.open(browser, { width: 1440, height: 900 });
    await p2.goto(`${origin}/?nosw=1#v=1&m=hex&cmpcpu=1&bound=1&codemap=1&c=${b64}`);
    await p2.ready();
    const r = await p2.eval(`${HELPERS} ${SNAP} if (!tp()) await done(() => $('run').click()); const s = await snap(); return { ...s, n: checkedCpus().split(',').length };`);
    const want = await ref(hex, 'SKL');
    check(r.tp === want.tp.toFixed(2) && r.n === 15 && r.open.join() === 'bound,codemap' && /slots/.test(r.bound), 'url: an old link with the CPU table and two views', JSON.stringify(r));
    check(p2.take().length === 0, 'url: the old link: no console errors');
    await p2.close();
  }

  // ---- A–B mode with the views open ----------------------------------------------------------------------------------------
  {
    const r = await page.eval(`${HELPERS} ${SNAP}
      cpus('SKL'); await done(() => set($('examples'), 'chain'));
      for (const id of ['bound', 'whatif', 'codemap', 'deps']) if (!$(id).open) document.querySelector('#' + id + ' summary').click();
      document.querySelectorAll('table.uops tbody tr')[1].cells[2].click();
      const single = await snap();
      await done(() => $('cmp-ab').click());
      await wait(800);
      const ab = { tp: document.querySelector('.ab-tp')?.innerText.replace(/\\s+/g, ' ').trim(), hash: location.hash, more: [...document.querySelectorAll('#more > .row')].filter((r) => !r.hidden && r.offsetParent).map((r) => r.id),
        cards: [...document.querySelectorAll('.ic')].filter((c) => !c.hidden && c.offsetParent !== null).length };
      await done(() => $('cmp-single').click());
      const back = await snap();
      return { single, ab, back };`);
    check(r.ab.tp && /ab=1/.test(r.ab.hash) && r.ab.cards === 0, 'ab: A–B mode with the views open: a result, no instruction card', JSON.stringify(r.ab));
    // (the A–B demo put its pair in the code boxes: another result, the same views)
    check(r.back.tp && r.single.open.join() === r.back.open.join(), 'ab: back in single mode, the views are open as before', JSON.stringify([r.single.open, r.back]));
    check(page.take().length === 0, 'ab: no console errors');
  }

  // ---- keyboard only ---------------------------------------------------------------------------------------------------------
  {
    const out = {};
    await page.eval(`${HELPERS} for (const id of ['bound', 'whatif', 'codemap', 'deps']) if ($(id).open) document.querySelector('#' + id + ' summary').click(); return 1;`);
    for (const id of ['bound', 'whatif', 'codemap', 'deps']) {
      await page.eval(`document.querySelector('#${id} summary').focus(); return 1;`);
      await page.key('Enter', { keyCode: 13, text: '\r' });
      const opened = await page.eval(`return document.getElementById('${id}').open && document.activeElement === document.querySelector('#${id} summary');`);
      await page.key(' ', { code: 'Space', keyCode: 32 });
      const closed = await page.eval(`return !document.getElementById('${id}').open;`);
      out[id] = [opened, closed];
    }
    check(Object.values(out).every(([o, c]) => o && c), 'keyboard: Enter opens each view, Space closes it, the focus stays', JSON.stringify(out));
    // the row in the tab order (the selected one), then ArrowDown to the next, Enter: its card
    await page.eval(`document.getElementById('icard').hidden || document.querySelector('#icard button')?.click(); document.querySelector('#result-body table.uops tbody tr[tabindex="0"]').focus(); return 1;`);
    await page.key('ArrowDown', { keyCode: 40 });
    await page.key('Enter', { keyCode: 13, text: '\r' });
    const card = await page.eval(`${HELPERS} const rows = [...document.querySelectorAll('#result-body table.uops tbody tr')];
      await until(() => !$('icard').hidden, 5000).catch(() => {}); return [!$('icard').hidden, $('icard').dataset.row, String(rows.indexOf(document.activeElement))];`);
    await page.key('Escape', { keyCode: 27 });
    const gone = await page.eval(`return document.getElementById('icard').hidden;`);
    check(card[0] && card[1] === card[2] && card[2] === '2' && gone, 'keyboard: ArrowDown and Enter on a row show its card, Escape closes it', JSON.stringify([card, gone]));
  }

  // ---- themes × widths with every view open ----------------------------------------------------------------------------
  {
    await page.eval(`${HELPERS} ${SNAP} for (const id of ['bound', 'whatif', 'codemap', 'deps']) if (!$(id).open) document.querySelector('#' + id + ' summary').click();
      document.querySelectorAll('table.uops tbody tr')[0].cells[2].click(); await snap(); return 1;`);
    const bad = [];
    for (const theme of ['light', 'dark']) {
      await page.eval(`${HELPERS} if (document.documentElement.getAttribute('data-theme') !== ${JSON.stringify(theme)}) $('theme-toggle').click(); return 1;`);
      for (const w of [320, 375, 414, 768, 1024, 1280, 1440, 1920, 2560]) {
        await page.size(w, 900, w < 768);
        const r = await page.eval(`${HELPERS} await wait(120); return { o: overflow(), t: document.documentElement.getAttribute('data-theme'),
          wide: [...document.querySelectorAll('#bound, #whatif, #codemap, #deps, #icard')].filter((e) => e.offsetParent && e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.id) };`);
        if (r.o > 0 || r.t !== theme || r.wide.length) bad.push({ theme, w, ...r });
      }
    }
    await page.size(1440, 900);
    check(bad.length === 0, 'layout: both themes × 9 widths with every view and a card open: no horizontal scrolling', JSON.stringify(bad));
    check(page.take().length === 0, 'layout: no console errors');
  }

  // ---- SHA-256 with every view open: no long task --------------------------------------------------------------------------
  {
    const r = await page.eval(`${HELPERS} ${SNAP}
      const long = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
      cpus('SKL');
      $('mode-hex').click();
      await done(() => set($('examples'), 'sha256'), 120000);
      document.querySelectorAll('table.uops tbody tr')[3].cells[2].click();
      const s = await snap();
      await wait(500);
      return { long, tp: s.tp, open: s.open, card: !!s.card };`);
    check(r.tp === '744.25' && r.open.length === 5 && r.card, 'showcase: SHA-256 with every view and a card', JSON.stringify(r));
    check(r.long.every((ms) => ms < 100), 'showcase: no long task of 100 ms or more', JSON.stringify(r.long));
    check(page.take().length === 0, 'showcase: no console errors');
  }

  // ---- links and text ------------------------------------------------------------------------------------------------------
  {
    const r = await page.eval(`return { hrefs: [...document.querySelectorAll('a[href]')].map((a) => a.href), text: document.body.innerText,
      html: document.documentElement.outerHTML.length, titles: [...document.querySelectorAll('[title]')].map((e) => e.title).join('\\n') };`);
    const hosts = [...new Set(r.hrefs.map((h) => new URL(h).host))];
    const allowed = new Set([new URL(origin).host, 'github.com', 'www.uops.info', 'uops.info', 'uica.uops.info', 'godbolt.org']);
    check(hosts.every((h) => allowed.has(h)), 'links: only the site, GitHub, uops.info and Compiler Explorer', JSON.stringify(hosts));
    check(r.hrefs.filter((h) => h.startsWith('https://github.com/')).every((h) => /^https:\/\/github\.com\/(jtl06\/(wuica|uiCA)|andreas-abel\/uiCA)(\/|$)/.test(h)), 'links: GitHub links go to the repositories', JSON.stringify(r.hrefs.filter((h) => h.includes('github'))));
    check(r.hrefs.includes('https://github.com/jtl06/wuica/blob/main/docs/ACCURACY.md'), 'links: the accuracy page');
    check(!/jacen|permission|permitted|authori[sz]ed by/i.test(r.text + r.titles), 'text: no personal website, nothing about a permission', (/.{0,60}(jacen|permission|permitted|authori[sz]ed by).{0,60}/i.exec(r.text + r.titles) ?? [''])[0]);
  }
  await page.close();

  // ---- a Compiler Explorer import (recorded responses, nothing sent to godbolt.org): cost per source line, its URL state,
  // asm ↔ hex ------------------------------------------------------------------------------------------------------------
  {
    const fixtures = path.join(ROOT, 'tests-js/fixtures/godbolt');
    const fx = (name) => fs.readFileSync(path.join(fixtures, name), 'utf8');
    const links = JSON.parse(fx('links.json'));
    const sent = [];
    const intercept = (params, p) => {
      const u = new URL(params.request.url);
      sent.push(`${params.request.method} ${u.pathname}`);
      let status = 404, body = '{}';
      if (params.request.method === 'OPTIONS') { status = 204; body = ''; }
      else if (/^\/api\/compilers\/c%2B%2B$/.test(u.pathname)) { status = 200; body = fx('compilers-c++.json'); }
      else if (u.pathname === '/api/compiler/g82/compile') { status = 200; body = fx('compile-g82-countSetBits.json'); }
      p.cmd('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: status,
        responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }, { name: 'access-control-allow-origin', value: '*' },
          { name: 'access-control-allow-methods', value: 'POST, GET, OPTIONS' }, { name: 'access-control-allow-headers', value: 'Content-Type, Accept' }],
        body: Buffer.from(body).toString('base64') }).catch(() => {});
    };
    const CE = `
      const line = (id) => document.querySelector('.ce-line[data-for="' + id + '"]')?.textContent ?? '';
      const isAsm = (id) => /^(B: )?assembly code$/i.test($(id).getAttribute('aria-label'));
      const paste = (el, text) => { const dt = new DataTransfer(); dt.setData('text/plain', text); el.focus(); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); };
      const srcLines = () => [...document.querySelectorAll('.sm-list li')].map((li) => li.innerText.replace(/\\s+/g, ' ').trim());`;
    const p = await Page.open(browser, { width: 1440, height: 900, intercept });
    p.ignore.push(/godbolt\.org/);
    await p.goto(`${origin}/?nosw=1`);
    await p.ready();
    const r = await p.eval(`${HELPERS} ${CE}
      if ($('live').checked) $('live').click();
      paste($('code'), ${JSON.stringify(links.countSetBits)});
      await until(() => /^imported/.test(line('code')) && !$('results').hasAttribute('aria-busy') && tp() && isAsm('code'));
      await wait(300);
      document.querySelector('#srcmap summary').click(); await wait(100);
      const out = { tp: tp(), lines: srcLines(), href: location.href, code: $('code').value };
      // to hex and back: the same text, the same lines
      $('mode-hex').click(); await wait(300);
      out.hex = { asm: isAsm('code'), text: $('code').value.split('\\n')[0], src: $('srcmap-row')?.hidden };
      $('mode-asm').click(); await wait(300);
      out.back = { asm: isAsm('code'), same: $('code').value === out.code, src: !$('srcmap-row')?.hidden && $('srcmap').open };
      await done(() => $('run').click()); await wait(200);
      out.back.lines = srcLines();
      return out;`);
    check(r.tp && r.lines.length > 0 && /[#&]src=1(&|$)/.test(new URL(r.href).hash), 'ce: an import, its cost per source line, src=1 in the link', JSON.stringify(r));
    check(r.back.asm && r.back.same && JSON.stringify(r.back.lines) === JSON.stringify(r.lines), 'ce: asm → hex → asm gives the same text and the same lines', JSON.stringify([r.hex, r.back, r.lines]));
    // the link reopened: the import's source lines are not in it (the fragment has the assembly): no source view, no error
    const p2 = await Page.open(browser, { width: 1440, height: 900, intercept });
    p2.ignore.push(/godbolt\.org/);
    await p2.goto(r.href);
    await p2.ready();
    const n = await p2.eval(`${HELPERS} ${CE} await until(() => tp() || errorBox(), 60000); await wait(300);
      return { tp: tp(), err: errorBox(), srcHidden: $('srcmap-row')?.hidden ?? true, lines: srcLines(), code: $('code').value };`);
    check(n.tp === r.tp && !n.err && n.code === r.code, 'ce: the link of an import reopens with the same result', JSON.stringify(n));
    check(n.srcHidden || JSON.stringify(n.lines) === JSON.stringify(r.lines), 'ce: the reopened link shows the same source lines or none', JSON.stringify(n));
    check(sent.every((s) => /^(OPTIONS|GET \/api\/compilers|POST \/api\/compiler\/g82\/compile)/.test(s)), 'ce: only the recorded requests', JSON.stringify(sent));
    check(p.take().length === 0 && p2.take().length === 0, 'ce: no console errors');
    await p2.close();
    await p.close();
  }
} finally {
  await close();
  await srv.stop();
}
process.exit(check.summary() ? 1 : 0);
