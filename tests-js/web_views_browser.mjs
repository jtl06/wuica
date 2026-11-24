// End-to-end test of the opt-in views below the result (web/js/views.js: bound), in the built site (web/dist), in
// headless Chrome over the DevTools protocol, with the real analyzer; the expected values come from analyses this test
// makes itself under Node. Run web/build.sh first. Node 22+.
//
//    node tests-js/web_views_browser.mjs [--chrome PATH] [--shots DIR]
//
// Skips (exit 0) if Chrome is not found.
import { testConditions } from './cdp.mjs';
import { LONG_TASK_MS } from './cdp.mjs'; // (the bound of the long-task checks)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostHandler } from './static-host.mjs';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES, CLASSIC_EXAMPLES } from '../web/js/examples.js';
import { experiments } from '../web/js/whatif.js';
import { WasmAssembler } from '../web/js/assembler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'web', 'dist');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const shots = opt('--shots');
const chrome = opt('--chrome') || process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));
if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// ---- the expected values, under Node ---------------------------------------------------------------------------------
const engine = await WasmEngine.create(fs.readFileSync(path.join(dist, 'wuica_wasm.wasm')));
const uarch = JSON.parse(fs.readFileSync(path.join(dist, 'data', 'uarch.json')));
await engine.loadUarch(fs.readFileSync(path.join(dist, 'data', 'uarch.json')));
for (const t of ['SKL', 'ZEN3']) await engine.loadArch(t, zlib.gunzipSync(fs.readFileSync(path.join(dist, 'data', 'arch', `${t}.bin.gz`))));
const analyze = (hex, arch = 'SKL', options = {}) => engine.analyze(makeRequest(hex, arch, options));
const ex = (id) => [...EXAMPLES, ...CLASSIC_EXAMPLES].find((e) => e.id === id);

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
    await testConditions((x, a) => p.cmd(x, a)); // (cdp.mjs: scratch runs under another font, scrollbars)
    await p.size(width, height, mobile);
    return p;
  }
  size(width, height, mobile = width < 768) { return this.cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); }
  theme(value) { return this.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] }); }
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
  result() { return this.waitFor(`document.querySelector('.tp .value') && document.getElementById('results').dataset.run`, 'a result'); }
  take() { const p = this.problems; this.problems = []; return p; }
  async shot(name) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await this.cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(shots, name), Buffer.from(data, 'base64'));
  }
}

const HELPERS = `
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 30000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + f); await wait(30); } };
  const tp = () => document.querySelector('.tp .value')?.textContent;
  const done = async (start) => { const n = $('results').dataset.run; start(); await until(() => $('results').dataset.run !== n); };
  const overflow = () => document.documentElement.scrollWidth - innerWidth;
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const trs = () => [...document.querySelectorAll('table.uops tbody tr')];
  const hot = () => trs().map((tr, i) => tr.classList.contains('bd-hot') ? i + ':' + tr.cells[0].style.getPropertyValue('--bd') : null).filter(Boolean);
  const items = () => [...document.querySelectorAll('.bd-item')].map((b) => [b.dataset.id, b.querySelector('.bd-pct').textContent, b.getAttribute('aria-pressed')]);
  const top = () => [...document.querySelectorAll('.bd-row')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim());
  // the table and the views are tabs of the result (workspace.js): one shows at a time
  // (SHA-256 below: (the state, not one run: the showcase loads its assembly first, and the fresh visit's own run may end meanwhile)
  const tab = async (name) => { [...document.querySelectorAll('.view-tab')].find((b) => b.textContent === name).click(); await wait(50); };
  const shownTab = () => document.querySelector('.view-tab[aria-selected="true"]')?.textContent;
  const openViews = () => ['bound', 'whatif', 'codemap', 'deps', 'mca', 'cmp-sweep'].filter((id) => $(id)?.open).concat(document.querySelector('details.trace-panel')?.open ? ['trace'] : []);
`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-views-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = '';
  proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
  proc.on('exit', () => reject(new Error('Chrome exited: ' + err.slice(0, 500))));
  setTimeout(() => reject(new Error('Chrome did not start')), 20000);
});
const browser = await Browser.connect(wsUrl);
const pct = (x) => `${Math.round(x * 100)}%`;

try {
  const page = await Page.open(browser);

  // --- bound: the chain example from a link with the view open ----------------------------------------------------------
  {
    const chain = ex('chain');
    const want = await analyze(chain.hex);
    await page.goto(`${origin}/?nosw=1#v=1&bound=1&c=${b64(chain.text.hex)}`);
    await page.result();
    const r = await page.eval(`${HELPERS}
      await until(() => document.querySelector('.bd-item'));
      const out = { tp: tp(), open: $('bound').open, label: $('bound-row').querySelector('.label').textContent, summary: $('bound').querySelector('summary').innerText,
        items: items(), hot: hot(), top: top(), desc: trs()[0].cells[0].getAttribute('aria-description'), afterSweep: $('bound-row').nextElementSibling?.id,
        rowText: trs().map((tr) => [...tr.cells].map((c) => c.textContent).join(' ').replace(/\\s+/g, ' ').trim()) }; // (the table is another tab)
      // another resource: port 6
      document.querySelector('.bd-item[data-id="col:Port 6"]').click(); await wait(30);
      out.p6 = { items: items().filter((x) => x[2] === 'true').map((x) => x[0]), hot: hot(), top: top() };
      // keyboard: the items are buttons
      out.keyboard = [...document.querySelectorAll('.bd-item')].every((b) => b.tagName === 'BUTTON' && b.tabIndex === 0);
      // jump: a top row shows the table tab, scrolls to the row and flashes it
      document.querySelector('.bd-row').click(); await wait(50);
      out.flash = trs().findIndex((tr) => tr.classList.contains('rj-flash'));
      out.focus = document.activeElement === trs()[out.flash]?.cells[0];
      out.jumpTab = shownTab();
      // so the bound view is closed: nothing shaded, the link forgets it
      out.closed = { open: $('bound').open, hot: hot(), body: document.querySelector('.bd-body').children.length, hash: location.hash };
      await tab('bound');
      out.reopened = [hot().length > 0, /[#&]bound=1(&|$)/.test(location.hash), $('bound').open];
      return out;`);
    const lim = Object.fromEntries(want.limits.map((l) => [l.name, l.tp]));
    check(r.tp === '2.00' && r.open && r.label === 'bound' && r.afterSweep === 'whatif-row', 'bound: a row before the experiments and the sweep, open from the link', JSON.stringify(r));
    check(r.summary === `by resource · next DSB ≤×${(want.tp / lim.DSB).toFixed(1)}`, 'bound: the summary names the next limit and the speedup at best', r.summary);
    // in groups: front end, issue, ports (the limit, then each port), chain
    const expItems = [...want.limits.filter((l) => l.name !== 'Dependencies').map((l) => [l.name, pct(l.tp / want.tp)])];
    want.columns.forEach((c, i) => { if (/^Port/.test(c)) { const t = want.rows.reduce((s, x) => s + x.values[i], 0); if (t > 0) expItems.push([`col:${c}`, pct(t / want.tp)]); } });
    expItems.push(['Dependencies', pct(lim.Dependencies / want.tp)]);
    check(JSON.stringify(r.items.map((x) => [x[0], x[1]])) === JSON.stringify(expItems), 'bound: every limit and used port, as % of the throughput', JSON.stringify([r.items, expItems]));
    check(r.items.filter((x) => x[2] === 'true').map((x) => x[0]).join() === 'Dependencies', 'bound: the bottleneck is selected');
    check(r.hot.join() === '0:1.000,1:1.000' && r.desc === '50% of Dependencies' && r.top.join('|') === 'add rax, 0x1 50%|add rax, 0x1 50%', 'bound: the chain rows are shaded, with their share', JSON.stringify([r.hot, r.desc, r.top]));
    check(r.rowText[0] === 'add rax, 0x1 1 1 1 0.22 0.22 0.29 0.27', 'bound: the table keeps its cells and text', r.rowText[0]);
    const p6 = want.rows.map((x) => x.values[want.columns.indexOf('Port 6')]);
    const p6max = Math.max(...p6);
    check(r.p6.items.join() === 'col:Port 6' && r.p6.hot.join() === p6.map((v, i) => (v > 0 ? `${i}:${(v / p6max).toFixed(3)}` : null)).filter(Boolean).join() && r.p6.top[0] === `dec r15 ${pct(p6[2] / p6.reduce((s, x) => s + x, 0))}`, 'bound: port 6 selected: its rows shaded by their uops there', JSON.stringify([r.p6, p6]));
    check(r.keyboard && r.flash === 2 && r.focus && r.jumpTab === 'table', 'bound: buttons; a top row jumps to the table row (the table tab, flash, focus)', JSON.stringify([r.keyboard, r.flash, r.focus, r.jumpTab]));
    check(!r.closed.open && r.closed.hot.length === 0 && r.closed.body === 0 && !/bound=1/.test(r.closed.hash) && r.reopened.every(Boolean), 'bound: closed by the jump, nothing is shaded and the link forgets it; its tab again, back', JSON.stringify([r.closed, r.reopened]));
    await page.shot('bound-chain.png');
  }

  // --- bound: SHA-256 (2,949 instructions): no work while closed; open in well under 100 ms; a jump past the drawn rows -----------
  {
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const r = await page.eval(`${HELPERS}
      const before = { run: $('results').dataset.run, text: $('code').value.slice(0, 40), mode: document.querySelector('input[name="mode"]:checked')?.value ?? null, tp: tp() };
      set($('examples'), 'sha256'); await until(() => document.querySelector('#result-body .tp .value')?.textContent === '744.25' && !$('results').hasAttribute('aria-busy') && !$('result-body').classList.contains('stale'), 120000);
      const after = { run: $('results').dataset.run, text: $('code').value.slice(0, 40) };
      await wait(100);
      const out = { tp: tp(), before, after, closed: [$('bound').open, document.querySelector('.bd-body').children.length, $('result-body').dataset.bound, hot().length] };
      const long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
      document.querySelector('#bound summary').click();
      await until(() => document.querySelector('.bd-item'));
      const drawn = () => [...document.querySelectorAll('table.uops tbody tr[data-row]')];
      out.items = items().length; out.hot = hot().length; out.rows = drawn().length;
      const t1 = performance.now();
      document.querySelector('.bd-item[data-id="Ports"]').click();
      out.switchMs = performance.now() - t1;
      await wait(100);
      out.long = [...long];
      // the chain: its largest share is beyond the rows drawn (vrows.js): the jump draws it
      document.querySelector('.bd-item[data-id="Dependencies"]')?.click();
      const btns = [...document.querySelectorAll('.bd-row')];
      out.top = btns.length;
      btns[0]?.click();
      await until(() => trs().some((tr) => tr.classList.contains('rj-flash')), 5000).catch(() => {});
      out.afterJump = [drawn().length, Number(drawn().find((tr) => tr.classList.contains('rj-flash'))?.dataset.row ?? -1)];
      return out;`);
    const sha = await analyze((await import('../web/js/examples.js')).SHOWCASE_EXAMPLES[0].hex);
    const edges = sha.criticalPath?.edges ?? [];
    const lat = new Map();
    for (const e of edges) lat.set(e.from, (lat.get(e.from) ?? 0) + e.latency);
    const order = [...lat].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 5).map((x) => x[0]);
    check(r.tp === '744.25' && r.closed[0] === false && r.closed[1] === 0 && r.closed[2] === 'closed' && r.closed[3] === 0, 'bound: SHA-256: closed, nothing computed or shaded', JSON.stringify(r.closed));
    check(r.long.every((ms) => ms < LONG_TASK_MS) && r.switchMs < LONG_TASK_MS && r.items > 5 && r.hot > 0 && r.rows < 200, `bound: SHA-256: opening and switching: no task of ${LONG_TASK_MS} ms or more`, JSON.stringify(r));
    check(r.top === Math.min(5, order.length) && order[0] >= 200 && r.afterJump[0] < 200 && r.afterJump[1] === order[0], 'bound: SHA-256: a jump to a chain row beyond the drawn ones draws it (and only the rows near it) and flashes it', JSON.stringify([r.top, r.afterJump, order]));
    console.log(`bound: SHA-256: long tasks while opening ${JSON.stringify(r.long)} ms, switch ${r.switchMs.toFixed(1)} ms; chain top rows ${order.join(',')}`);
  }

  // --- details: the instruction card, the badges, the port set and the issue slots (details.js, icard.js, portset.js) ------
  {
    // add rax, [rsi]; dec r15; jnz: a load on p23, the Ports limit on p6
    const want = await engine.analyze({ ...makeRequest('48030649ffcf75f9', 'SKL'), details: true });
    await page.goto(`${origin}/?nosw=1#v=1&m=hex&bound=1&c=${b64('48 03 06 49 ff cf 75 f9')}`);
    await page.result();
    const r = await page.eval(`${HELPERS}
      await until(() => document.querySelector('.bd-slots'), 10000);
      const out = { card0: !!$('icard') && !$('icard').hidden };
      document.querySelector('.bd-item[data-id="Ports"]').click(); await wait(30);
      out.set = document.querySelector('.bd-set')?.innerText.replace(/\\s+/g, ' ').trim();
      out.cols = [...document.querySelectorAll('table.uops thead th.ps-on')].map((th) => th.dataset.col + '=' + th.textContent);
      out.slots = document.querySelector('.bd-slots')?.innerText.replace(/\\s+/g, ' ').trim();
      out.top = top();
      // a click on a row of the table tab: the card with the details
      await tab('table');
      trs()[0].cells[2].click();
      await until(() => $('result-body').dataset.icard === 'details', 10000);
      const c = $('icard');
      out.card = c.innerText.replace(/\\s+/g, ' ').trim();
      out.link = c.querySelector('a.ic-link')?.href;
      out.sel = /[#&]sel=0(&|$)/.test(location.hash);
      // the keyboard: arrow down moves the focus and the card follows; Escape closes it
      trs()[0].focus(); trs()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(30);
      out.follow = $('icard').dataset.row;
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(30);
      out.closed = $('icard').hidden;
      out.notes = trs().map((tr) => tr.querySelector('td.note').textContent).join('');
      return out;`);
    const p = want.details.ports;
    check(!r.card0 && r.set === `set p6 ${p.uops} uops / ${p.ports.length} = ${p.tp.toFixed(2)}` && r.top[0] === 'dec r15 100%' && r.cols.join() === 'Port 6=6', 'details: Ports drills down to the port set and its instructions', JSON.stringify(r));
    check(/^slots issued \d+% front end \d+%/.test(r.slots), 'details: the issue slots', r.slots);
    check(/^add rax, qword ptr \[rsi\] uops\.info ↗ × ports 1\*p0156\+1\*p23 tp 0\.50 uops 2 · 1 fused · MITE 1 · 1 load lat RAX→RAX 1 · mem→RAX 3 · \[RSI\]→RAX 6 chain rax ← add rax, qword ptr \[rsi\] 1 ↻ share 50% of DSB front 3 B @0$/.test(r.card)
      && /^https:\/\/www\.uops\.info\//.test(r.link) && r.sel, 'details: a click on a row shows its card', JSON.stringify(r));
    check(r.follow === '1' && r.closed && r.notes === 'M', 'details: the card follows the focus, Escape closes it; the notes keep their text', JSON.stringify(r));
    // the accuracy link next to "limitations", and the numbers of the prototypes in their tooltips
    const acc = await page.eval(`
      const a = [...document.querySelectorAll('.top nav a')].find((x) => x.textContent === 'accuracy');
      return { href: a?.href, prev: a?.previousElementSibling?.textContent, zen3: [...document.querySelectorAll('label.cpu')].find((l) => l.textContent.startsWith('ZEN3'))?.title };`);
    const { ACCURACY_URL, accuracyNote } = await import('../web/js/archs.js');
    check(acc.href === ACCURACY_URL && acc.prev === 'limitations' && acc.zen3.endsWith(accuracyNote('ZEN3')), 'accuracy: the link, and the numbers in the tooltip of a prototype', JSON.stringify(acc));
    // SHA-256 with the bound view open: the details arrive without a long task
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const s = await page.eval(`${HELPERS}
      const long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
      set($('examples'), 'sha256'); await until(() => document.querySelector('#result-body .tp .value')?.textContent === '744.25' && !$('results').hasAttribute('aria-busy') && !$('result-body').classList.contains('stale'), 120000);
      await wait(200);
      long.length = 0;
      await tab('bound');
      await until(() => document.querySelector('.bd-slots'), 20000);
      await tab('table');
      trs()[5].cells[2].click();
      await until(() => $('result-body').dataset.icard === 'details', 20000);
      await wait(100);
      return { long, hz: document.querySelectorAll('td.note[data-hz]').length, sticky: $('icard').classList.contains('stick') };`);
    check(s.long.every((ms) => ms < LONG_TASK_MS) && s.sticky, `details: SHA-256: the bound tab, then a card with details, no task of ${LONG_TASK_MS} ms or more`, JSON.stringify(s));
    console.log(`details: SHA-256: long tasks ${JSON.stringify(s.long)} ms`);
    await page.goto(`${origin}/?nosw=1#v=1&m=hex`);
  }

  // --- what if: the chain example, with and without the worker pool, against analyses made here ------------------------------
  {
    const chain = ex('chain');
    // the listing's instructions: add, add | dec, jnz (macro-fused on SKL): the body is the two adds
    const lines = chain.text.hex.trimEnd().split('\n').map((l) => l.split(/:\s+/)[1].split(/\s{2,}/)[0].replace(/ /g, ''));
    const body = lines.slice(0, 2).join(''), tail = lines.slice(2).join('');
    const base = await analyze(chain.hex);
    const f = (x) => x.toFixed(2);
    const d = (x) => (Math.abs(x) < 0.005 ? '0.00' : `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(2)}`);
    const want = [];
    for (const n of [2, 4, 8]) { const r = await analyze(body.repeat(n) + tail); want.push([`unroll${n}`, f(r.tp / n), d(r.tp / n - base.tp), `×${(base.tp / (r.tp / n)).toFixed(2)}`]); }
    // N accumulators: the variants' text (accum.js), assembled here
    const asm = await WasmAssembler.create(fs.readFileSync(path.join(dist, 'wuica_asm.wasm')));
    for (const x of experiments(base, chain.hex, {}).filter((y) => /^acc\d+$/.test(y.id))) {
      const a = await asm.assemble(x.text, 'intel');
      const r = await analyze([...a.bytes].map((b) => b.toString(16).padStart(2, '0')).join(''));
      want.push([x.id, f(r.tp / x.per), d(r.tp / x.per - base.tp), `×${(base.tp / (r.tp / x.per)).toFixed(2)}`]);
    }
    for (const k of ['simpleFrontEnd', 'noMacroFusion', 'noMicroFusion']) { const r = await analyze(chain.hex, 'SKL', { [k]: true }); want.push([k, f(r.tp), d(r.tp - base.tp), `×${(base.tp / r.tp).toFixed(2)}`]); }
    const others = base.limits.filter((l) => l.name !== 'Dependencies').map((l) => l.tp);
    want.push(['nochain', `≥${f(Math.max(...others))}`, d(Math.max(...others) - base.tp), `≤×${(base.tp / Math.max(...others)).toFixed(2)}`]);
    const read = `
      await until(() => document.querySelector('#whatif .wi-body')?.dataset.state === 'done', 20000);
      const rows = [...document.querySelectorAll('.wi-table tbody tr')].map((tr) => [tr.dataset.id, ...[...tr.querySelectorAll('td')].slice(0, 3).map((td) => td.textContent)]);`;
    const out = {};
    for (const pool of ['', '&pool=0']) {
      await page.goto(`${origin}/?nosw=1${pool}#v=1&whatif=1&c=${b64(chain.text.hex)}`);
      await page.result();
      out[pool || 'pool'] = await page.eval(`${HELPERS} ${read}
        const a = document.querySelector('.wi-table tr[data-id="unroll2"] a.wi-open'); a.dispatchEvent(new Event('focus'));
        return { rows, label: $('whatif-row').querySelector('.label').textContent, href: a.getAttribute('href'), target: a.target, hash: location.hash, order: [...$('more').children].map((e) => e.id) };`);
    }
    for (const [k, r] of Object.entries(out)) {
      check(JSON.stringify(r.rows) === JSON.stringify(want), `what if (${k}): every experiment equals an analysis made here`, JSON.stringify([r.rows, want]));
    }
    const r = out.pool;
    check(r.label === 'try' && /[#&]whatif=1(&|$)/.test(r.hash) && r.order.join() === 'bound-row,whatif-row,codemap-row,deps-row,mca-row,sweep-row,trace-slot', 'what if: a row "try" after "bound", open from the link', JSON.stringify(r));
    const { decodeState } = await import('../web/js/url-state.js');
    const s = decodeState(r.href.split('#')[1]);
    check(r.target === '_blank' && s.mode === 'hex' && s.text.replace(/ /g, '') === body.repeat(2) + tail && s.arch === 'SKL', 'what if: a variant opens in a new tab as machine code', r.href);
    // closed: nothing runs; the A–B mode hides it
    await page.goto(`${origin}/?nosw=1#v=1&c=${b64(chain.text.hex)}`);
    await page.result();
    const c = await page.eval(`${HELPERS} await wait(300); return [$('whatif').open, $('whatif').querySelector('.wi-body').dataset.state, document.querySelectorAll('.wi-table').length];`);
    check(c[0] === false && c[1] === 'closed' && c[2] === 0, 'what if: closed by default, nothing analyzed', JSON.stringify(c));
    await page.shot('whatif-chain.png');
  }

  // --- what if: SHA-256: the main thread stays free; unroll ×2 as analyzed here -----------------------------------------------
  {
    const sha = (await import('../web/js/examples.js')).SHOWCASE_EXAMPLES[0];
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const r = await page.eval(`${HELPERS}
      set($('examples'), 'sha256'); await until(() => document.querySelector('#result-body .tp .value')?.textContent === '744.25' && !$('results').hasAttribute('aria-busy') && !$('result-body').classList.contains('stale'), 120000);
      const long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
      const t0 = performance.now();
      document.querySelector('#whatif summary').click();
      await until(() => ['waiting', 'done'].includes(document.querySelector('#whatif .wi-body')?.dataset.state) || document.querySelector('.wi-go'), 120000);
      const waited = !!document.querySelector('.wi-go');
      document.querySelector('.wi-go')?.click();
      await until(() => document.querySelector('#whatif .wi-body')?.dataset.state === 'done', 180000);
      return { waited, ms: Math.round(performance.now() - t0), long: [...long], u2: document.querySelector('.wi-table tr[data-id="unroll2"] td').textContent };`);
    // the block's instructions as the analyzer decodes them; the last two (dec rdx; jnz) are the macro-fused branch
    const ops = (await analyze(sha.hex)).rows.filter((x) => x.kind === 'instr').map((x) => x.opcode.toLowerCase());
    const u = ops.slice(0, -2).join('').repeat(2) + ops.slice(-2).join('');
    const want = (await analyze(u, 'SKL')).tp / 2;
    check(r.long.every((ms) => ms < LONG_TASK_MS) && r.u2 === want.toFixed(2), 'what if: SHA-256: no long task on the page; unroll ×2 equals an analysis made here', JSON.stringify([r, want]));
    console.log(`what if: SHA-256: ${r.waited ? 'waited for a click, then ' : ''}all experiments in ${r.ms} ms; long tasks ${JSON.stringify(r.long)}`);
  }

  // --- code map: the chain example at offset 58 (the second add split across two lines); keys; the alignment buttons ----------
  {
    const chain = ex('chain');
    await page.goto(`${origin}/?nosw=1#v=1&al=58&codemap=1&c=${b64(chain.text.hex)}`);
    await page.result();
    const r = await page.eval(`${HELPERS}
      await until(() => document.querySelector('.ly-map'));
      const g = () => [...document.querySelectorAll('.ly-ins')];
      const out = { label: $('codemap-row').querySelector('.label').textContent, summary: $('codemap').querySelector('summary').innerText,
        ins: g().map((x) => x.querySelectorAll('rect').length), split: g().map((x) => x.classList.contains('split')), off: document.querySelector('.ly-offv').textContent,
        legend: [...document.querySelectorAll('.ly-k')].map((x) => x.textContent), info: document.querySelector('.ly-info').textContent,
        order: [...$('more').children].map((e) => e.id) };
      const svg = document.querySelector('.ly-map');
      svg.focus();
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      out.key = [svg.getAttribute('aria-activedescendant'), document.querySelector('.ly-info').textContent, document.activeElement === svg];
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(50);
      out.flash = trs().findIndex((tr) => tr.classList.contains('rj-flash'));
      out.jumpTab = [shownTab(), $('codemap').open];
      // the bytes tab again
      await tab('bytes'); await until(() => document.querySelector('.ly-map'));
      const svg2 = document.querySelector('.ly-map');
      svg2.focus();
      svg2.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      out.end = svg2.getAttribute('aria-activedescendant');
      // the alignment: +1 is a new analysis at offset 59
      await done(() => document.querySelectorAll('.ly-shift')[1].click());
      await until(() => document.querySelector('.ly-offv')?.textContent === 'offset 59');
      out.after = [document.querySelector('.ly-offv').textContent, $('opt-align').value, /[#&]al=59(&|$)/.test(location.hash), /[#&]codemap=1(&|$)/.test(location.hash)];
      return out;`);
    check(r.label === 'bytes' && r.summary === 'cache lines · 13 B, 2 lines' && r.order.join() === 'bound-row,whatif-row,codemap-row,deps-row,mca-row,sweep-row,trace-slot', 'code map: a row "bytes", open from the link', JSON.stringify(r));
    check(r.ins.join() === '1,2,1,1' && r.split.join() === 'false,true,false,false' && r.off === 'offset 58' && r.legend.join() === '16B 1,32B 1,64B 1', 'code map: the split instruction has a box on each line', JSON.stringify(r));
    check(r.info === 'add rax, 0x1 · 0x3a–0x3d (4 B)' && r.key[0] === 'ly-i1' && /^add rax, 0x1 · 0x3e–0x41 \(4 B\) · crosses a cache line$/.test(r.key[1]) && r.key[2], 'code map: arrow keys move through the instructions', JSON.stringify([r.info, r.key]));
    check(r.flash === 1 && r.jumpTab[0] === 'table' && !r.jumpTab[1] && r.end === 'ly-i3', 'code map: Enter jumps to the row (the table tab); End to the last instruction', JSON.stringify([r.flash, r.jumpTab, r.end]));
    check(r.after.every((x, i) => (i === 0 ? x === 'offset 59' : i === 1 ? x === '59' : x)), 'code map: ▸ shifts the alignment offset (analyzed again, in the link)', JSON.stringify(r.after));
    await page.shot('codemap-chain.png');

    // SHA-256: drawing the map of 11,602 bytes stays under 100 ms per task
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const s = await page.eval(`${HELPERS}
      set($('examples'), 'sha256'); await until(() => document.querySelector('#result-body .tp .value')?.textContent === '744.25' && !$('results').hasAttribute('aria-busy') && !$('result-body').classList.contains('stale'), 120000);
      const long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
      const t0 = performance.now();
      document.querySelector('#codemap summary').click();
      await until(() => document.querySelector('.ly-map'));
      const ms = performance.now() - t0;
      await wait(200);
      return { ms: Math.round(ms), long: [...long], n: document.querySelectorAll('.ly-ins').length, lines: document.querySelectorAll('.ly-line').length, o: overflow() };`);
    check(s.n === 2949 && s.lines === Math.ceil(11602 / 64) && s.long.every((ms) => ms < LONG_TASK_MS) && s.o <= 0, `code map: SHA-256: every instruction, no task of ${LONG_TASK_MS} ms or more`, JSON.stringify(s));
    console.log(`code map: SHA-256 drawn in ${s.ms} ms; long tasks ${JSON.stringify(s.long)}`);
  }

  // --- dependency arcs: the chain example; keys; SHA-256 waits for a click --------------------------------------------------
  {
    const chain = ex('chain');
    await page.goto(`${origin}/?nosw=1#v=1&deps=1&c=${b64(chain.text.hex)}`);
    await page.result();
    const r = await page.eval(`${HELPERS}
      await until(() => document.querySelector('#deps .dp-body')?.dataset.state === 'done', 20000);
      const arcs = [...document.querySelectorAll('.dp-arc')];
      const out = { label: $('deps-row').querySelector('.label').textContent, summary: $('deps').querySelector('summary').innerText,
        arcs: arcs.map((a) => a.dataset.a + '>' + a.dataset.b + (a.classList.contains('carried') ? 'c' : '') + (a.classList.contains('crit') ? '!' : '')),
        legend: [...document.querySelectorAll('.dp-k')].map((x) => x.textContent), nodes: document.querySelectorAll('.dp-node').length,
        order: [...$('more').children].map((e) => e.id),
        slack: [...document.querySelectorAll('.dp-node')].map((n) => n.querySelector('.dp-sl')?.textContent ?? ''),
        lats: [...document.querySelectorAll('.dp-lat')].map((t) => [t.textContent, t.classList.contains('crit')]),
        critNodes: [...document.querySelectorAll('.dp-node.crit')].map((n) => n.dataset.i).join() };
      const svg = document.querySelector('.dp-map');
      svg.focus();
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      out.key = [svg.getAttribute('aria-activedescendant'), document.querySelector('.dp-info').textContent, [...document.querySelectorAll('.dp-arc.on')].length];
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      out.picked = [document.querySelector('.dp-info').textContent, [...document.querySelectorAll('.dp-lat.on')].map((t) => t.textContent).join()];
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(50);
      out.flash = trs().findIndex((tr) => tr.classList.contains('rj-flash'));
      return out;`);
    check(r.label === 'deps' && r.summary === 'dependency arcs · 3 edges, 2 ↻' && r.order.join() === 'bound-row,whatif-row,codemap-row,deps-row,mca-row,sweep-row,trace-slot', 'deps: a row "deps", open from the link', JSON.stringify(r));
    check(r.arcs.slice().sort().join() === '0>1!,1>0c!,2>2c' && r.legend.join() === '→ 1 same iteration,↻ 2 carried,chain 2,slack' && r.nodes === 4, 'deps: add → add, add ↻ add (the chain), dec ↻ dec', JSON.stringify(r));
    check(r.slack.join() === '0,0,1,∞' && r.critNodes === '0,1', 'deps: slack per instruction (the adds are the chain: 0; dec r15 1 of 2 cycles; jnz off every cycle)', JSON.stringify(r));
    check(r.lats.length === 2 && r.lats.every(([t, crit]) => t === '1' && crit), 'deps: latencies on the arcs of the chain', JSON.stringify(r.lats));
    check(r.picked[0] === 'dec r15 slack 1 ← dec r15 ↻ → dec r15 ↻' && r.picked[1] === '1', 'deps: the selected instruction: its slack and its arcs\' latencies', JSON.stringify(r.picked));
    check(r.key[0] === 'dp-i1' && r.key[1] === 'add rax, 0x1 slack 0 ← add rax, 0x1 → add rax, 0x1 ↻' && r.key[2] === 2 && r.flash === 1, 'deps: arrow keys select an instruction and its arcs; Enter jumps to the row', JSON.stringify([r.key, r.flash]));
    await page.shot('deps-chain.png');

    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const s = await page.eval(`${HELPERS}
      set($('examples'), 'sha256'); await until(() => document.querySelector('#result-body .tp .value')?.textContent === '744.25' && !$('results').hasAttribute('aria-busy') && !$('result-body').classList.contains('stale'), 120000);
      // the button past the size limit (data-gate), with its size; picking the tab presses it (workspace.js)
      const seen = []; const obs = new MutationObserver(() => { const b = document.querySelector('#deps .dp-body button[data-gate]'); if (b && !seen.length) seen.push(b.textContent); });
      obs.observe($('deps'), { childList: true, subtree: true });
      const long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
      const t0 = performance.now();
      await tab('deps');
      const out = [seen[0] ?? document.querySelector('#deps .dp-body button[data-gate]')?.textContent, document.querySelectorAll('.dp-map').length];
      await until(() => document.querySelector('#deps .dp-body')?.dataset.state === 'done', 60000);
      obs.disconnect();
      const drawn = Math.round(performance.now() - t0);
      await until(() => document.querySelector('.dp-sl'), 10000); // the slack column: a task of its own
      // (a graph this large draws the instructions near the view, deps.js: the map is as tall as all of them)
      const rows = Math.round((Number(document.querySelector('.dp-map').getAttribute('height')) - 4) / 18);
      return [...out, drawn, long, document.querySelectorAll('.dp-node').length, document.querySelectorAll('.dp-sl').length, document.querySelector('.dp-k.sl')?.title ?? '', rows];`);
    check(s[0] === 'trace 2,949 instructions' && s[1] === 0 && s[7] === 2949 && s[4] > 0 && s[4] < 400, 'deps: SHA-256: past its size limit (the button), picking the tab loads it; the map has every instruction, those near the view drawn', JSON.stringify(s));
    check(s[5] > 0 && s[6] && !/too large/.test(s[6]), 'deps: SHA-256: the slack is computed', JSON.stringify(s.slice(5)));
    console.log(`deps: SHA-256: traced and drawn in ${s[2]} ms after the tab; long tasks ${JSON.stringify(s[3])}`);
  }

  // --- A–B mode: the views are tabs as in single mode, of one side (a switch at the end of the tab row) ----------------------
  {
    const chain = ex('chain');
    await page.goto(`${origin}/?nosw=1#v=1&bound=1&whatif=1&codemap=1&deps=1&trace=1&c=${b64(chain.text.hex)}`);
    await page.result();
    const r = await page.eval(`${HELPERS}
      await until(() => document.querySelector('.view-tab') && document.querySelector('details.trace-panel'), 20000); await wait(300);
      const VIEWS = ['bound', 'try', 'bytes', 'deps'];
      const shown = () => ['bound-row', 'whatif-row', 'codemap-row', 'deps-row'].map((id) => getComputedStyle($(id)).display !== 'none');
      const tabs = () => [...document.querySelectorAll('.view-tab')].filter((b) => b.offsetParent !== null).map((b) => b.textContent);
      // five views from the link: one stays open (the one opened last)
      const open = openViews();
      // each view in its tab
      const single = [];
      for (const name of VIEWS) { await tab(name); single.push(shown()[VIEWS.indexOf(name)]); }
      await tab('table');
      trs()[1].cells[2].click(); await wait(100); // a selected row (its card) in single mode
      const cardSingle = !$('icard').hidden;
      await tab('trace'); // the A–B traces open too: their tab
      await done(() => $('cmp-ab').click()); await wait(300);
      const ab = [tabs(), document.querySelector('.view-tab[aria-selected="true"]')?.textContent, !!document.querySelector('.ws-side'), getComputedStyle($('trace-slot')).display];
      const abViews = [];
      for (const name of VIEWS) { await tab(name); abViews.push([shown()[VIEWS.indexOf(name)], document.querySelector('.ws-side-btn.on')?.textContent]); }
      // the bound view of side A shades A's table; the switch: B's
      await tab('bound'); await until(() => document.querySelector('.bd-item'), 10000);
      const hotOf = (s) => document.querySelectorAll('#ab-main .ab-col[data-side="' + s + '"] tbody tr.bd-hot').length;
      const sideA = [hotOf('a') > 0, hotOf('b')];
      document.querySelector('.ws-side-btn[data-tab="side-b"]').click(); await wait(200); await until(() => document.querySelector('.bd-item'), 10000);
      const sideB = [document.body.dataset.abSide, document.querySelector('.ws-side-btn.on')?.textContent, hotOf('a'), hotOf('b') > 0, $('bound').open];
      document.querySelector('.ws-side-btn[data-tab="side-a"]').click(); await wait(100);
      await tab('diff');
      // a click on a row of A's table in A–B mode: the card of that row of A, under A's table; one of B's: none (the
      // views show A)
      document.querySelector('#ab-main .ab-col[data-side="a"] table.uops tbody tr')?.cells[2]?.click(); await wait(300);
      const vis = () => [...document.querySelectorAll('.ic')].filter((c) => !c.hidden && c.offsetParent !== null);
      const cards = [vis().length, vis()[0]?.closest('.ab-col')?.dataset.side ?? null, vis()[0]?.querySelector('.ic-ins')?.textContent ?? null,
        document.querySelector('#ab-main .ab-col[data-side="a"] table.uops tbody tr')?.cells[0].textContent];
      document.querySelector('#ab-main .ab-col[data-side="b"] table.uops tbody tr')?.cells[2]?.click(); await wait(300);
      cards.push(vis().length === 1 && vis()[0].closest('.ab-col')?.dataset.side === 'a');
      await done(() => $('cmp-single').click()); await wait(300);
      const back = [];
      for (const name of VIEWS) { await tab(name); back.push(shown()[VIEWS.indexOf(name)]); }
      return { open, single, ab, abViews, sideA, sideB, back, backTabs: tabs(), cardSingle, cards };`);
    check(r.open.length === 1, 'A–B section: five views from a link, one stays open', JSON.stringify(r.open));
    check(r.single.every(Boolean) && r.ab[0].join() === 'diff,bound,try,bytes,deps,mca,sweep,trace' && r.ab[1] === 'trace' && !r.ab[2] && r.ab[3] !== 'none'
      && r.abViews.every((v) => v[0] && v[1] === 'A') && r.back.every(Boolean) && r.backTabs.join() === 'table,bound,try,bytes,deps,mca,sweep,trace',
    'A–B mode: the views are tabs in the same places (the A–B traces stay open; no side switch for them); each view of side A; back in single mode they are there', JSON.stringify(r));
    check(r.sideA[0] && r.sideA[1] === 0 && r.sideB[0] === 'b' && r.sideB[1] === 'B' && r.sideB[2] === 0 && r.sideB[3] && r.sideB[4], 'A–B mode: the bound view shades its side\'s table; the switch shows B\'s', JSON.stringify([r.sideA, r.sideB]));
    check(r.cardSingle && r.cards[0] === 1 && r.cards[1] === 'a' && r.cards[2] === r.cards[3] && r.cards[4], 'A–B mode: the card of a row of the side the views show (the whole instruction)', JSON.stringify(r.cards));
  }

  // --- copy: Markdown, CSV, JSON of the result -------------------------------------------------------------------------------
  {
    const chain = ex('chain');
    const want = await analyze(chain.hex);
    await page.goto(`${origin}/?nosw=1#v=1&c=${b64(chain.text.hex)}`);
    await page.result();
    const r = await page.eval(`${HELPERS}
      const got = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { got.push(t); } }, configurable: true });
      // the control at the end of the tab row (copy-view.js): Markdown; Shift+click CSV; Alt+click JSON
      const c = document.querySelector('#result-body .view-tabs .ws-copy');
      const out = { label: c?.textContent, last: c === c?.parentElement.lastElementChild, old: !!document.querySelector('.ex-tools') };
      for (const mod of [{}, { shiftKey: true }, { altKey: true }]) { c.dispatchEvent(new MouseEvent('click', { bubbles: true, ...mod })); await wait(50); }
      out.flash = $('status').textContent;
      out.got = got;
      return out;`);
    check(r.label === 'copy' && r.last && !r.old && /^copied/.test(r.flash), 'copy: one control, at the end of the tab row', JSON.stringify(r));
    const [md, csv, json] = r.got;
    check(md?.startsWith('**2.00 cycles/iteration** · SKL') && /\| `add rax, 0x1` +\|/.test(md) && /\| \*\*Total\*\* +\|/.test(md), 'copy: Markdown, the headline and the uop table (the whole result with its link: "copy all", web_copy_browser)', md);
    check(csv?.split('\r\n').length === want.rows.length + 2 && csv.startsWith('instruction,opcode,notes,MITE'), 'copy: CSV', csv);
    check(JSON.parse(json ?? '{}').response?.tp === want.tp && JSON.parse(json).request?.hex === chain.hex, 'copy: JSON with the request', (json ?? '').slice(0, 200));
  }

  // --- layout: no sideways scrolling with the views open, both themes -------------------------------------------------------
  {
    const out = [];
    for (const [w, hgt, theme] of [[320, 640, 'light'], [375, 812, 'light'], [768, 1024, 'dark'], [1440, 900, 'dark'], [2560, 1440, 'light']]) {
      await page.size(w, hgt);
      await page.theme(theme);
      await page.goto(`${origin}/?nosw=1#v=1&m=asm&bound=1&whatif=1&codemap=1&deps=1&c=${b64(ex('dot1').text.intel)}`);
      await page.result();
      // one view at a time (the tabs): each open and drawn
      out.push(await page.eval(`${HELPERS} await until(() => document.querySelector('.view-tab')); const o = {};
        for (const [name, ready] of [['bound', () => document.querySelector('.bd-item')], ['try', () => document.querySelector('#whatif .wi-body')?.dataset.state === 'done'],
          ['bytes', () => document.querySelector('.ly-map')], ['deps', () => document.querySelector('.dp-map')]]) { await tab(name); await until(ready); await wait(50); o[name] = overflow(); }
        return { w: ${w}, o: Math.max(...Object.values(o)), each: o, bg: getComputedStyle(document.documentElement).backgroundColor };`));
    }
    check(out.every((m) => m.o <= 0), 'layout: no sideways scrolling from 320 to 2560 px with each view open', JSON.stringify(out));
    check(out[0].bg !== out[2].bg, 'layout: both themes', JSON.stringify(out.map((m) => m.bg)));
    await page.size(1440, 900);
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
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be writing its profile: left in the temp dir */ }
}

console.log(`${count} views browser checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
