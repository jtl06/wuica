// End-to-end test of the opt-in views below the result (web/js/views.js: bound), in the built site (web/dist), in
// headless Chrome over the DevTools protocol, with the real analyzer; the expected values come from analyses this test
// makes itself under Node. Run web/build.sh first. Node 22+.
//
//    node tests-js/web_views_browser.mjs [--chrome PATH] [--shots DIR]
//
// Skips (exit 0) if Chrome is not found.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostHandler } from './static-host.mjs';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES, CLASSIC_EXAMPLES } from '../web/js/examples.js';

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
for (const t of ['SKL', 'ZEN3']) await engine.loadArch(t, fs.readFileSync(path.join(dist, 'data', 'arch', `${t}.json`)));
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
        rowText: trs().map((tr) => tr.innerText.replace(/\\s+/g, ' ').trim()) };
      // another resource: port 6
      document.querySelector('.bd-item[data-id="col:Port 6"]').click(); await wait(30);
      out.p6 = { items: items().filter((x) => x[2] === 'true').map((x) => x[0]), hot: hot(), top: top() };
      // keyboard: the items are buttons
      out.keyboard = [...document.querySelectorAll('.bd-item')].every((b) => b.tagName === 'BUTTON' && b.tabIndex === 0);
      // jump: a top row scrolls to the row in the table and flashes it
      document.querySelector('.bd-row').click(); await wait(50);
      out.flash = trs().findIndex((tr) => tr.classList.contains('rj-flash'));
      out.focus = document.activeElement === trs()[out.flash]?.cells[0];
      // closed: nothing shaded, the link forgets it
      document.querySelector('#bound summary').click(); await wait(50);
      out.closed = { hot: hot(), body: document.querySelector('.bd-body').children.length, hash: location.hash };
      document.querySelector('#bound summary').click(); await wait(50);
      out.reopened = [hot().length > 0, /[#&]bound=1(&|$)/.test(location.hash)];
      return out;`);
    const lim = Object.fromEntries(want.limits.map((l) => [l.name, l.tp]));
    check(r.tp === '2.00' && r.open && r.label === 'bound' && r.afterSweep === 'sweep-row', 'bound: a row before the sweep, open from the link', JSON.stringify(r));
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
    check(r.keyboard && r.flash === 2 && r.focus, 'bound: buttons; a top row jumps to the table row (flash, focus)', JSON.stringify([r.keyboard, r.flash, r.focus]));
    check(r.closed.hot.length === 0 && r.closed.body === 0 && !/bound=1/.test(r.closed.hash) && r.reopened.every(Boolean), 'bound: closed, nothing is shaded and the link forgets it; reopened, back', JSON.stringify([r.closed, r.reopened]));
    await page.shot('bound-chain.png');
  }

  // --- bound: SHA-256 (2,949 instructions): no work while closed; open in well under 100 ms; a jump past the drawn rows -----------
  {
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const r = await page.eval(`${HELPERS}
      await done(() => set($('examples'), 'sha256'));
      await wait(100);
      const out = { tp: tp(), closed: [$('bound').open, document.querySelector('.bd-body').children.length, $('result-body').dataset.bound, hot().length] };
      const long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
      document.querySelector('#bound summary').click();
      await until(() => document.querySelector('.bd-item'));
      out.items = items().length; out.hot = hot().length; out.rows = trs().length;
      const t1 = performance.now();
      document.querySelector('.bd-item[data-id="Ports"]').click();
      out.switchMs = performance.now() - t1;
      await wait(100);
      out.long = [...long];
      // the chain: rows beyond the first 200: jump to the last of the top rows
      document.querySelector('.bd-item[data-id="Dependencies"]')?.click();
      const btns = [...document.querySelectorAll('.bd-row')];
      out.top = btns.length;
      btns.at(-1)?.click();
      await until(() => trs().some((tr) => tr.classList.contains('rj-flash')), 5000).catch(() => {});
      out.afterJump = [trs().length, trs().findIndex((tr) => tr.classList.contains('rj-flash'))];
      return out;`);
    const sha = await analyze((await import('../web/js/examples.js')).SHOWCASE_EXAMPLES[0].hex);
    const edges = sha.criticalPath?.edges ?? [];
    const lat = new Map();
    for (const e of edges) lat.set(e.from, (lat.get(e.from) ?? 0) + e.latency);
    const order = [...lat].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 5).map((x) => x[0]);
    check(r.tp === '744.25' && r.closed[0] === false && r.closed[1] === 0 && r.closed[2] === 'closed' && r.closed[3] === 0, 'bound: SHA-256: closed, nothing computed or shaded', JSON.stringify(r.closed));
    check(r.long.every((ms) => ms < 100) && r.switchMs < 100 && r.items > 5 && r.hot > 0 && r.rows === 200, 'bound: SHA-256: opening and switching: no task of 100 ms or more', JSON.stringify(r));
    check(r.top === Math.min(5, order.length) && r.afterJump[1] === order[r.top - 1] && (order[r.top - 1] < 200 || r.afterJump[0] === 2949), 'bound: SHA-256: a jump to a chain row (drawing all rows if needed)', JSON.stringify([r.top, r.afterJump, order]));
    console.log(`bound: SHA-256: long tasks while opening ${JSON.stringify(r.long)} ms, switch ${r.switchMs.toFixed(1)} ms; chain top rows ${order.join(',')}`);
  }

  // --- layout: no sideways scrolling with the views open, both themes -------------------------------------------------------
  {
    const out = [];
    for (const [w, hgt, theme] of [[320, 640, 'light'], [375, 812, 'light'], [768, 1024, 'dark'], [1440, 900, 'dark'], [2560, 1440, 'light']]) {
      await page.size(w, hgt);
      await page.theme(theme);
      await page.goto(`${origin}/?nosw=1#v=1&m=asm&bound=1&c=${b64(ex('dot1').text.intel)}`);
      await page.result();
      out.push(await page.eval(`${HELPERS} await until(() => document.querySelector('.bd-item')); return { w: ${w}, o: overflow(), bg: getComputedStyle(document.documentElement).backgroundColor };`));
    }
    check(out.every((m) => m.o <= 0), 'layout: no sideways scrolling from 320 to 2560 px with the views open', JSON.stringify(out));
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
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(`${count} views browser checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
