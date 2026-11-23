// End-to-end test of the page layout, the CPU checkboxes (several CPUs: the table, the focused CPU, the URL) and the
// showcase example (a block of 2,949 instructions), in headless Chrome over the DevTools protocol, with the real
// analyzer. Run web/build.sh first. Node 22+.
//
//    node tests-js/web_layout_browser.mjs [--chrome PATH]
//
// Skips (exit 0) if Chrome is not found.
import { LONG_TASK_MS } from './cdp.mjs'; // (the bound of the long-task checks)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostHandler } from './static-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'web', 'dist');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const chrome = opt('--chrome') || process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));
if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(hostHandler(dist));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- DevTools protocol ---------------------------------------------------------------------------------------------------
class Browser {
  #ws; #id = 0; #pending = new Map(); #handlers = [];
  static async connect(url) {
    const b = new Browser();
    b.#ws = new WebSocket(url);
    await new Promise((res, rej) => { b.#ws.onopen = res; b.#ws.onerror = () => rej(new Error('cannot connect to Chrome')); });
    b.#ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id) {
        const p = b.#pending.get(msg.id); b.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
      } else for (const h of b.#handlers) h(msg);
    };
    return b;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => { this.#pending.set(id, { resolve, reject, method }); this.#ws.send(JSON.stringify({ id, method, params, sessionId })); });
  }
  on(h) { this.#handlers.push(h); }
  close() { this.#ws.close(); }
}

class Page {
  problems = [];
  static async open(browser, { width = 1440, height = 900, mobile = false } = {}) {
    const p = new Page();
    p.browser = browser;
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    p.sessionId = (await browser.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    browser.on((m) => {
      if (m.sessionId !== p.sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') p.problems.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(m.params.type)) p.problems.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
      if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) p.problems.push(`log ${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
    });
    for (const d of ['Runtime', 'Log', 'Page']) await p.cmd(`${d}.enable`);
    await p.size(width, height, mobile);
    return p;
  }
  size(width, height, mobile = width < 768) { return this.cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); }
  cmd(method, params) { return this.browser.send(method, params, this.sessionId); }
  async eval(expression) {
    const r = await this.cmd('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  }
  async goto(url) {
    await this.cmd('Page.navigate', { url: 'about:blank' });
    await sleep(50);
    await this.cmd('Page.navigate', { url });
    await sleep(150);
    await this.waitFor(`document.readyState === 'complete'`, 'load');
  }
  async waitFor(cond, what, ms = 30000) {
    const t0 = Date.now();
    for (;;) {
      let v = false;
      try { v = await this.eval(`return !!(${cond});`); } catch { /* navigating */ }
      if (v) return true;
      if (Date.now() - t0 > ms) { check(false, `timeout waiting for ${what}`, cond); return false; }
      await sleep(100);
    }
  }
  ready() { return this.waitFor(`!document.getElementById('run').disabled || document.querySelector('.error-box')`, 'the page to be ready'); }
  take() { const p = this.problems; this.problems = []; return p; }
}

const HELPERS = `
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 30000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + f); await wait(50); } };
  const tp = () => document.querySelector('.tp .value')?.textContent;
  const done = async (start) => { const n = $('results').dataset.run; start(); await until(() => $('results').dataset.run !== n); };
  const overflow = () => document.documentElement.scrollWidth - innerWidth;
  const rect = (el) => { const b = (typeof el === 'string' ? document.querySelector(el) : el)?.getBoundingClientRect(); return b ? { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) } : null; };
  // the CPU checkboxes: the focused CPU (the details), and "check exactly these" (one change event, like one click)
  const focused = () => $('cpus').dataset.focus;
  const checkedCpus = () => [...document.querySelectorAll('#cpu-grid input:checked')].map((b) => b.value).join();
  const cpus = (...keys) => { const boxes = [...document.querySelectorAll('#cpu-grid input')]; for (const b of boxes) b.checked = keys.includes(b.value); boxes[0].dispatchEvent(new Event('change', { bubbles: true })); };
  const rows = () => [...document.querySelectorAll('table.cmp-cpus tbody tr')].map((tr) => [tr.dataset.arch, tr.querySelector('.cmp-tp').textContent]);
  const runs = () => Number($('cmp-cpus').dataset.runs || 0);
  const tableDone = () => !$('cmp-cpus').hidden && $('cmp-cpus').dataset.state === 'done';
`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-layout-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = '';
  proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
  proc.on('exit', () => reject(new Error('Chrome exited: ' + err.slice(0, 500))));
  setTimeout(() => reject(new Error('Chrome did not start')), 20000);
});
const browser = await Browser.connect(wsUrl);

try {
  const page = await Page.open(browser);

  // --- 1440×900: the default example, analyzed: the throughput and the uop table are visible without scrolling ---------------
  {
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const r = await page.eval(`${HELPERS}
      const out = { mode: $('mode-asm').checked, code: $('code').value.split('\\n')[1] };
      out.before = [rect('#results'), rect('#code')];
      await until(() => tp()); // a fresh visit analyzes the default example by itself
      out.auto = [tp(), $('results').dataset.run];
      out.after = rect('#results');
      out.scrollY = scrollY; out.h = innerHeight; out.overflow = overflow();
      out.tp = [tp(), rect('.tp .value')]; out.uops = rect('table.uops'); out.run = rect('#run');
      out.cpuGrid = rect('#cpus');
      out.codeLines = Math.floor($('code').clientHeight / parseFloat(getComputedStyle($('code')).lineHeight));
      out.oneLine = [rect('.tp .value').top <= rect('.bn-line').top && rect('.bn-line').bottom <= rect('.tp .value').bottom + 4, document.querySelector('.bn-line').innerText];
      out.textRow = [...document.querySelectorAll('.text-row summary')].map((s) => rect(s).top);
      // keyboard: the order of the controls follows the page: the input pane, then the result
      const order = ['mode-asm', 'examples', 'code', 'run', 'copy-link', 'live'].map((id) => $(id));
      out.order = order.every((e, k) => k === 0 || (order[k - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING));
      out.resultAfterInput = !!($('run').compareDocumentPosition($('result-body')) & Node.DOCUMENT_POSITION_FOLLOWING);
      // the options popover does not push the page down; Escape closes it
      const y0 = rect('#cpus').top;
      document.querySelector('#advanced summary').click(); await wait(50);
      out.pop = [$('advanced').open, rect('#cpus').top === y0, overflow(), rect('.pop-body').right <= innerWidth];
      $('opt-align').focus(); $('opt-align').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(50);
      out.popClosed = [!$('advanced').open, document.activeElement === document.querySelector('#advanced summary')];
      return out;`);
    check(r.mode && r.code === '  add rax, 1' && r.auto[0] === '2.00' && r.auto[1] === '1', 'layout: assembly is the default input (the first example), analyzed without a click', JSON.stringify([r.mode, r.code, r.auto]));
    check(r.before[0].top === r.after.top && r.before[0].left > r.before[1].right, 'layout: at 1440 px the result is beside the input; it does not move when the result arrives', JSON.stringify([r.before, r.after]));
    check(r.scrollY === 0 && r.tp[0] === '2.00' && r.tp[1].bottom <= r.h && r.uops.top >= 0 && r.uops.bottom <= r.h && r.overflow <= 0, 'layout: at 1440×900 the throughput and the whole uop table are visible without scrolling', JSON.stringify([r.tp, r.uops, r.h]));
    check(r.run.bottom <= r.h && r.cpuGrid.bottom <= r.h && r.codeLines >= 20, 'layout: the code box (20+ lines), the CPUs and Analyze fit in the window', JSON.stringify([r.run, r.cpuGrid, r.codeLines]));
    check(r.oneLine[0] && /^bottleneck\s+Dependencies$/.test(r.oneLine[1]) && r.textRow.length === 2 && r.textRow[0] === r.textRow[1], 'layout: throughput and bottleneck on one line; objdump and report on one line', JSON.stringify([r.oneLine, r.textRow]));
    check(r.order && r.resultAfterInput, 'layout: the focus order follows the visual order');
    check(r.pop[0] && r.pop[1] && r.pop[2] <= 0 && r.pop[3] && r.popClosed[0] && r.popClosed[1], 'layout: the options are a popover (nothing moves); Escape closes it', JSON.stringify([r.pop, r.popClosed]));
  }

  // --- no sideways scrolling at any width; stacked on phones, side by side on wide screens -------------------------------------
  {
    const widths = [[320, 640], [375, 812], [768, 1024], [1199, 800], [1200, 800], [1280, 800], [1920, 1080], [2560, 1440]];
    const out = [];
    for (const [w, hgt] of widths) {
      await page.size(w, hgt);
      await page.goto(`${origin}/?nosw=1#v=1&as=SKL,ZEN3,ADL-P&cmpsweep=1&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM`);
      await page.waitFor(`document.getElementById('cmp-cpus').dataset.state === 'done' && document.getElementById('cmp-sweep').dataset.state === 'done' && document.querySelector('.tp .value')`, `the result at ${w} px`);
      const m = await page.eval(`${HELPERS}
        // the views are tabs of the result (workspace.js): the link opens the sweep's; then the table's
        const tab = async (name) => { [...document.querySelectorAll('.view-tab')].find((b) => b.textContent === name).click(); await wait(50); };
        const sweep = [document.querySelector('.view-tab[aria-selected="true"]')?.textContent, overflow()];
        await tab('table');
        document.querySelector('details.report-wrap summary').click(); await wait(50); // the wide text report, open
        const o = { w: ${w}, single: Math.max(sweep[1], overflow()), sweep, side: rect('#results').left > rect('#code').right, gap: rect('#results').top - rect('#run').bottom };
        document.querySelector('#advanced summary').click(); await wait(50); o.pop = overflow(); document.querySelector('#advanced summary').click();
        // the wait column and a selected row in the table, then the trace tab, open (the selection carries over)
        const tpanel = () => document.querySelector('#trace-slot details.trace-panel');
        document.querySelector('.tl-waits-box').click(); await until(() => document.querySelector('th.tl-wait'));
        document.querySelector('table.uops tbody tr').click(); await wait(100);
        o.waits = overflow();
        await tab('trace'); await until(() => tpanel().wuicaTrace); await wait(100);
        o.trace = Math.max(o.waits, overflow()); o.traceWide = Math.abs(rect(tpanel()).right - rect('#more').right) < 4 && rect(tpanel()).right > rect(tpanel()).left;
        document.querySelector('.tl-waits-box').click(); await wait(50);
        await done(() => $('cmp-ab').click()); await wait(200);
        await until(() => $('ab-cpus').dataset.state === 'done');
        o.ab = overflow(); o.abStacked = rect('#code-b').top > rect('#code').bottom && Math.abs(rect('#code-b').left - rect('#code').left) < 2;
        o.abSide = rect('#results').left > rect('#code').right; o.abBelow = rect('#results').top > rect('#run').bottom; o.abTable = $('cmp-cpus').offsetParent === null;
        o.abCpus = [...document.querySelectorAll('#ab-cpus tbody tr')].map((tr) => tr.dataset.arch).join();
        // the A–B traces (the trace tab stays open)
        await until(() => tpanel()?.wuicaTraces); await wait(100);
        o.abTrace = overflow(); o.abTraceBelow = document.querySelector('.view-tab[aria-selected="true"]')?.dataset.tab === 'trace' && rect(tpanel()).top >= rect('#result-body').bottom && rect(tpanel()).right > rect(tpanel()).left;
        tpanel().querySelector('summary').click(); await wait(50);
        await done(() => $('cmp-single').click());
        return o;`);
      out.push(m);
    }
    check(out.every((m) => m.sweep[0] === 'sweep' && m.single <= 0 && m.pop <= 0 && m.ab <= 0), 'layout: no sideways scrolling from 320 to 2560 px (single with three CPUs, the sweep and the report open; the options open; A–B)', JSON.stringify(out));
    check(out.every((m) => m.trace <= 0 && m.traceWide && m.abTrace <= 0 && m.abTraceBelow), 'layout: the trace (with the wait column and a selected row) and the A–B traces (their tab): no sideways scrolling from 320 to 2560 px', JSON.stringify(out.map((m) => [m.w, m.trace, m.traceWide, m.abTrace, m.abTraceBelow])));
    check(out.every((m) => m.side === m.w >= 1200), 'layout: input and result side by side from 1200 px, stacked below', JSON.stringify(out.map((m) => [m.w, m.side])));
    check(out.every((m) => m.abStacked && m.abTable && m.abSide === m.w >= 1200 && (m.w >= 1200 || m.abBelow) && m.abCpus === 'SKL,ZEN3,ADL-P'), 'layout: A–B: A over B, the result beside them from 1200 px (below on narrow screens); its own table of the CPUs, not single mode\'s', JSON.stringify(out.map((m) => [m.w, m.abStacked, m.abSide, m.abBelow, m.abTable, m.abCpus])));
    // the default toolbar (assembly: the syntax menu too) with the options open, around the phone breakpoint and the two panes
    const pop = [];
    for (const w of [320, 641, 660, 700, 900, 1200, 1300]) {
      await page.size(w, 800);
      await page.goto(`${origin}/?nosw=1`);
      await page.ready();
      pop.push(await page.eval(`${HELPERS} document.querySelector('#advanced summary').click(); await wait(50); return [${w}, overflow(), rect('.pop-body').right <= innerWidth, getComputedStyle(document.querySelector('.pop-body')).position];`));
    }
    check(pop.every((p) => p[1] <= 0 && p[2]), 'layout: the open options never widen the page (assembly toolbar)', JSON.stringify(pop));
    // on a phone the options are in the flow: a tap elsewhere does not close them (that would move what is tapped)
    await page.size(375, 812);
    const tap = await page.eval(`${HELPERS} $('code').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await wait(50); return [$('advanced').open, getComputedStyle(document.querySelector('.pop-body')).position];`);
    await page.size(1440, 900);
    const tapWide = await page.eval(`${HELPERS} await wait(100); $('code').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await wait(50); return [$('advanced').open, getComputedStyle(document.querySelector('.pop-body')).position];`);
    check(tap[0] && tap[1] === 'static' && !tapWide[0], 'layout: the options popover closes on a click elsewhere, but not on a phone (in the flow)', JSON.stringify([tap, tapWide]));
  }

  // --- several CPUs: the table, the focused CPU, the URL --------------------------------------------------------------------
  {
    await page.goto(`${origin}/?nosw=1#v=1&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM`);
    await page.waitFor(`document.querySelector('.tp .value')`, 'a result');
    const r = await page.eval(`${HELPERS}
      const out = { start: [focused(), checkedCpus(), $('cmp-cpus').hidden] };
      // check two more: the table of three (in order of release); the focus stays on the CPU that had it
      cpus('ADL-P', 'SKL', 'ZEN3'); await until(tableDone);
      out.three = [focused(), checkedCpus(), rows(), tp(), location.hash.replace(/&c=.*/, ''), document.querySelector('table.cmp-cpus tr[aria-current=true]')?.dataset.arch];
      // a row focuses its CPU: the detailed result is that CPU's (the same number); the table is not recomputed
      const n = runs();
      await done(() => document.querySelector('table.cmp-cpus tr[data-arch="ZEN3"]').click());
      out.zen = [focused(), tp(), rows().find((x) => x[0] === 'ZEN3')[1], runs() === n, document.querySelector('table.cmp-cpus tr[aria-current=true]')?.dataset.arch,
        location.hash.replace(/&c=.*/, ''), document.querySelector('#cpu-grid label.focus input')?.value, document.querySelector('.meta').textContent];
      // keyboard: the CPU key in a row is a button
      const b = document.querySelector('table.cmp-cpus tr[data-arch="ADL-P"] button.pick'); b.focus();
      await done(() => b.click());
      out.key = [focused(), document.activeElement?.getAttribute('data-focus')];
      // a click on another CPU's box focuses it: the detailed result and the status line follow (in live mode too)
      const box = (k) => document.querySelector('#cpu-grid input[value="' + k + '"]');
      await done(() => box('HSW').click()); const status = $('status').textContent; // (read at once: it shows for 6 s)
      await until(() => tableDone() && rows().length === 4);
      out.added = [focused(), checkedCpus(), rows().length, document.querySelector('#result-body .meta')?.textContent, status, tp() === rows().find((x) => x[0] === 'HSW')[1], $('live').checked];
      // unchecking the focused one moves the focus to the CPU focused before it (ADL-P), then to the one before that (ZEN3)
      await done(() => box('HSW').click());
      out.unchecked = [focused(), checkedCpus(), $('status').textContent];
      await done(() => box('ADL-P').click());
      out.unchecked2 = [focused(), checkedCpus()];
      // unchecking a CPU that is not focused keeps the focus
      await done(() => box('HSW').click()); await until(() => tableDone() && rows().length === 3);
      await done(() => document.querySelector('table.cmp-cpus tr[data-arch="ZEN3"]').click());
      const n2 = $('results').dataset.run;
      box('HSW').click(); await until(() => tableDone() && rows().length === 2); await wait(300);
      out.uncheckedOther = [focused(), checkedCpus(), $('results').dataset.run === n2];
      await done(() => box('HSW').click()); await until(() => tableDone() && rows().length === 3);
      return out;`);
    check(r.start[0] === 'SKL' && r.start[1] === 'SKL' && r.start[2], 'cpus: SKL is checked by default; one CPU: no table', JSON.stringify(r.start));
    check(r.three[0] === 'SKL' && r.three[1] === 'SKL,ZEN3,ADL-P' && r.three[2].map((x) => x[0]).join() === 'SKL,ZEN3,ADL-P' && r.three[2].every((x) => /^\d+\.\d\d$/.test(x[1]))
      && r.three[2][0][1] === r.three[3] && r.three[4] === '#v=1&as=SKL,ZEN3,ADL-P' && r.three[5] === 'SKL', 'cpus: three checked: a table in order of release; the focused row is the detailed result; the URL lists them', JSON.stringify(r.three));
    check(r.zen[0] === 'ZEN3' && r.zen[1] === r.zen[2] && r.zen[3] && r.zen[4] === 'ZEN3' && r.zen[5] === '#v=1&a=ZEN3&as=SKL,ZEN3,ADL-P' && r.zen[6] === 'ZEN3' && /ZEN3/.test(r.zen[7]),
      'cpus: a row focuses its CPU (same throughput, the table is not recomputed, the URL and the boxes follow)', JSON.stringify(r.zen));
    check(r.key[0] === 'ADL-P' && r.key[1] === 'cpu-ADL-P', 'cpus: a row works from the keyboard; the focus stays on it', JSON.stringify(r.key));
    check(r.added[0] === 'HSW' && r.added[1] === 'HSW,SKL,ZEN3,ADL-P' && r.added[2] === 4 && /HSW/.test(r.added[3]) && r.added[5] && r.added[6]
      && /^\d+\.\d\d cycles\/iteration · HSW · 4 CPUs · \d+(\.\d)? ms$/.test(r.added[4]),
    'cpus: checking a CPU adds its row and focuses it; the details and the status line (with the number of CPUs) follow', JSON.stringify(r.added));
    check(r.unchecked[0] === 'ADL-P' && r.unchecked[1] === 'SKL,ZEN3,ADL-P' && / · ADL-P · 3 CPUs · /.test(r.unchecked[2]) && r.unchecked2[0] === 'ZEN3' && r.unchecked2[1] === 'SKL,ZEN3',
      'cpus: unchecking the focused CPU focuses the one focused most recently among the rest', JSON.stringify([r.unchecked, r.unchecked2]));
    check(r.uncheckedOther[0] === 'ZEN3' && r.uncheckedOther[1] === 'SKL,ZEN3' && r.uncheckedOther[2], 'cpus: unchecking another CPU keeps the focus (no new analysis)', JSON.stringify(r.uncheckedOther));

    // the URL round trip: a reload restores the checked CPUs and the focused one
    await page.eval(`${HELPERS} await done(() => document.querySelector('table.cmp-cpus tr[data-arch="ZEN3"]').click()); return 1;`);
    const hash = await page.eval(`return location.hash;`);
    await page.goto(`${origin}/?nosw=1${hash}`);
    await page.waitFor(`document.getElementById('cmp-cpus').dataset.state === 'done' && document.querySelector('.tp .value')`, 'the table from a link');
    const u = await page.eval(`${HELPERS}
      const out = { restored: [focused(), checkedCpus(), rows().map((x) => x[0]).join(), document.querySelector('table.cmp-cpus tr[aria-current=true]')?.dataset.arch, location.hash === ${JSON.stringify(hash)}] };
      // all / clear; the last checked CPU stays checked
      $('cpu-all').click(); await until(() => tableDone() && rows().length === 15);
      out.all = [checkedCpus().split(',').length, location.hash.includes('as=all'), focused()];
      $('cpu-clear').click(); await wait(100);
      out.clear = [checkedCpus(), focused(), $('cmp-cpus').hidden, location.hash.includes('as=')];
      const box = document.querySelector('#cpu-grid input[value=ZEN3]'); box.click(); await wait(50);
      out.last = [box.checked, checkedCpus()];
      // A–B: one CPU per side; side A is the focused one; no table
      await done(() => cpus('SKL', 'ZEN3')); out.two = [focused(), $('status').textContent]; // SKL, checked, gets the focus
      await until(() => tableDone() && rows().length === 2);
      await done(() => $('cmp-ab').click());
      await until(() => $('ab-cpus').dataset.state === 'done');
      out.ab = [$('cmp-cpus').offsetParent === null, document.querySelector('.ab-a .ab-desc')?.textContent, document.querySelector('#result-body .meta')?.textContent,
        [...document.querySelectorAll('#ab-cpus tbody tr')].map((tr) => tr.dataset.arch + (tr.classList.contains('current') ? '*' : '')).join()];
      // in A–B mode (no table), a CPU that is checked becomes side A's
      await done(() => cpus('SKL', 'ZEN3', 'ICL'));
      await until(() => $('ab-cpus').dataset.state === 'done' && document.querySelectorAll('#ab-cpus tbody tr').length === 3);
      out.abCheck = [focused(), document.querySelector('.ab-a .ab-desc')?.textContent, document.querySelector('#result-body .meta')?.textContent,
        [...document.querySelectorAll('#ab-cpus tbody tr')].map((tr) => tr.dataset.arch + (tr.classList.contains('current') ? '*' : '')).join()];
      // a row of A–B's table: that CPU for the comparison below
      await done(() => document.querySelector('#ab-cpus tr[data-arch="ZEN3"]').click());
      out.abPick = [focused(), document.querySelector('#result-body .meta')?.textContent, document.querySelector('#ab-cpus tr.current')?.dataset.arch];
      await done(() => document.querySelector('#ab-cpus tr[data-arch="ICL"]').click());
      await done(() => $('cmp-single').click());
      out.single = [!$('cmp-cpus').hidden, checkedCpus(), focused()];
      return out;`);
    check(u.restored[0] === 'ZEN3' && u.restored[1] === 'HSW,SKL,ZEN3' && u.restored[2] === 'HSW,SKL,ZEN3' && u.restored[3] === 'ZEN3' && u.restored[4], 'cpus: a link restores the checked CPUs and the focused one', JSON.stringify(u.restored));
    check(u.all[0] === 15 && u.all[1] && u.all[2] === 'ZEN3', 'cpus: "all" checks every CPU ("as=all" in the URL)', JSON.stringify(u.all));
    check(u.clear[0] === 'ZEN3' && u.clear[1] === 'ZEN3' && u.clear[2] && !u.clear[3], 'cpus: "clear" keeps the focused CPU only', JSON.stringify(u.clear));
    check(u.last[0] && u.last[1] === 'ZEN3', 'cpus: the last checked CPU cannot be unchecked', JSON.stringify(u.last));
    check(u.two[0] === 'SKL' && / · SKL · 2 CPUs · /.test(u.two[1]), 'cpus: a checked CPU becomes the focused one (with a table already there)', JSON.stringify(u.two));
    check(u.ab[3] === 'SKL*,ZEN3' && u.abCheck[3] === 'SKL,ICL*,ZEN3' && u.abPick[0] === 'ZEN3' && /A ZEN3/.test(u.abPick[1]) && u.abPick[2] === 'ZEN3', 'cpus: A–B has a table of A and B per checked CPU; its rows pick the CPU of the comparison', JSON.stringify([u.ab, u.abCheck, u.abPick]));
    check(u.ab[0] && /SKL/.test(u.ab[1]) && /A SKL/.test(u.ab[2]) && u.abCheck[0] === 'ICL' && /ICL/.test(u.abCheck[1]) && /A ICL/.test(u.abCheck[2])
      && u.single[0] && u.single[1] === 'SKL,ICL,ZEN3' && u.single[2] === 'ICL', 'cpus: A–B uses the focused CPU (a newly checked one becomes it) and hides the table; back in single mode it is there again', JSON.stringify([u.ab, u.abCheck, u.single]));

    // old links: one CPU (a=); the table of all CPUs (cmpcpu=1) checks them all
    await page.goto(`${origin}/?nosw=1#v=1&a=HSW&cmpcpu=1&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM`);
    await page.waitFor(`document.getElementById('cmp-cpus').dataset.state === 'done' && document.querySelector('.tp .value')`, 'an old link with the table of all CPUs');
    const o = await page.eval(`${HELPERS} return [focused(), checkedCpus().split(',').length, rows().length, $('mode-hex').checked];`);
    await page.goto(`${origin}/?nosw=1#v=1&a=ICL&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM`);
    await page.waitFor(`document.querySelector('.tp .value')`, 'an old link with one CPU');
    const o2 = await page.eval(`${HELPERS} return [focused(), checkedCpus(), $('cmp-cpus').hidden, $('mode-hex').checked];`);
    check(o[0] === 'HSW' && o[1] === 15 && o[2] === 15 && o[3] && o2[0] === 'ICL' && o2[1] === 'ICL' && o2[2] && o2[3], 'cpus: old links (hex, one CPU; cmpcpu=1: all CPUs) keep their meaning', JSON.stringify([o, o2]));
  }

  // --- the showcase: SHA-256, 2,949 instructions -----------------------------------------------------------------------------
  {
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const r = await page.eval(`${HELPERS}
      const long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
      const opts = [...$('examples').querySelectorAll('optgroup')].map((g) => g.label + ':' + [...g.children].map((o) => o.value).join(','));
      const t0 = performance.now();
      // (the state, not one run: the showcase loads its assembly first, and the fresh visit's own run may end meanwhile)
      $('examples').value = 'sha256'; $('examples').dispatchEvent(new Event('change', { bubbles: true })); await until(() => document.querySelector('#result-body .tp .value')?.textContent === '744.25' && !$('results').hasAttribute('aria-busy') && !$('result-body').classList.contains('stale'), 120000);
      const ms = performance.now() - t0;
      await wait(300);
      const out = { opts, ms, long: [...long], tp: tp(), asm: $('mode-asm').checked && $('code').value.startsWith('loop:') && $('code').value.includes('mov qword ptr [rsp+0x98], r8'), rows: document.querySelectorAll('table.uops tbody tr').length,
        more: document.querySelector('.more-rows')?.innerText, status: $('status').textContent, cost: $('result-body').dataset.cost,
        closed: [...document.querySelectorAll('details.text-block, details.trace-panel')].every((d) => !d.open), meta: document.querySelector('#result-body .meta').title };
      // the cost column waits for a click (2,949 analyses)
      document.querySelector('.ins-cost-box').click(); await until(() => $('result-body').dataset.cost === 'waiting', 10000);
      out.costWait = [$('result-body').dataset.cost, document.querySelector('.ins-cost-status button')?.textContent];
      document.querySelector('.ins-cost-box').click(); await wait(100);
      // all rows on request
      const t1 = performance.now();
      document.querySelector('.more-rows button').click(); await wait(50);
      out.all = [document.querySelectorAll('table.uops tbody tr').length, Math.round(performance.now() - t1), !document.querySelector('.more-rows')];
      // three CPUs (the pool): the table of their throughputs
      cpus('SKL', 'ZEN3', 'ADL-P'); await until(tableDone, 60000);
      out.cpus = rows(); out.cpusInfo = $('cmp-cpus-info').textContent;
      return out;`);
    check(r.opts.at(-1) === 'showcase:sha256', 'showcase: its own group at the end of the examples', JSON.stringify(r.opts));
    check(r.tp === '744.25' && r.asm && /^2949 instructions · 11602 bytes/.test(r.meta), 'showcase: SHA-256 (2,949 instructions) gives 744.25 on SKL; the input switches to Intel assembly', JSON.stringify([r.tp, r.asm, r.meta]));
    check(r.rows === 200 && /^2,749 more rows · show all 2,949 rows$/.test(r.more) && r.closed && r.cost === 'off', 'showcase: the first 200 rows are drawn, the rest on request; objdump, report and trace stay closed; no cost column', JSON.stringify([r.rows, r.more, r.closed, r.cost]));
    check(/^744\.25 cycles\/iteration · SKL · \d+(\.\d)? ms$/.test(r.status), 'showcase: the status line shows the analysis time', r.status);
    check(r.costWait[0] === 'waiting' && /compute \(\d{4} analyses\)/.test(r.costWait[1] ?? ''), 'showcase: the cost column waits for a click', JSON.stringify(r.costWait));
    check(r.all[0] === 2949 && r.all[2], 'showcase: "show all" draws every row', JSON.stringify(r.all));
    check(r.cpus.map((x) => x.join(':')).join() === 'SKL:744.25,ZEN3:620.75,ADL-P:587.00', 'showcase: the table of three CPUs (as uiCA: 744.25, 620.75, 587)', JSON.stringify([r.cpus, r.cpusInfo]));
    check(r.long.every((ms) => ms < LONG_TASK_MS), `showcase: no long task of ${LONG_TASK_MS} ms or more while it loads`, JSON.stringify(r.long));
    console.log(`showcase: example to result ${r.ms.toFixed(0)} ms (${r.status}); long tasks meanwhile ${JSON.stringify(r.long)} ms; all rows drawn in ${r.all[1]} ms; three CPUs: ${r.cpusInfo}`);
  }

  const problems = page.take();
  check(problems.length === 0, 'no console errors', problems.join('\n'));
  await page.cmd('Page.close');
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  browser.close();
  proc.kill();
  server.close();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be writing its profile */ }
}

console.log(`${count} layout checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
