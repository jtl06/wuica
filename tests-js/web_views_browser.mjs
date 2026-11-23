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
      // the chain: its largest share is beyond the first 200 rows: the jump draws them all first
      document.querySelector('.bd-item[data-id="Dependencies"]')?.click();
      const btns = [...document.querySelectorAll('.bd-row')];
      out.top = btns.length;
      btns[0]?.click();
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
    check(r.top === Math.min(5, order.length) && order[0] >= 200 && r.afterJump[0] === 2949 && r.afterJump[1] === order[0], 'bound: SHA-256: a jump to a chain row beyond the drawn ones draws all rows and flashes it', JSON.stringify([r.top, r.afterJump, order]));
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
      out.cols = [...document.querySelectorAll('table.uops thead th.ps-on')].map((th) => th.textContent);
      out.slots = document.querySelector('.bd-slots')?.innerText.replace(/\\s+/g, ' ').trim();
      out.top = top();
      // a click on a row: the card with the details
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
    check(!r.card0 && r.set === `set p6 ${p.uops} uops / ${p.ports.length} = ${p.tp.toFixed(2)}` && r.top[0] === 'dec r15 100%' && r.cols.join() === 'Port 6', 'details: Ports drills down to the port set and its instructions', JSON.stringify(r));
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
      await done(() => set($('examples'), 'sha256'));
      await wait(200);
      long.length = 0;
      document.querySelector('#bound summary').click();
      await until(() => document.querySelector('.bd-slots'), 20000);
      trs()[5].cells[2].click();
      await until(() => $('result-body').dataset.icard === 'details', 20000);
      await wait(100);
      return { long, hz: document.querySelectorAll('td.note[data-hz]').length, sticky: $('icard').classList.contains('stick') };`);
    check(s.long.every((ms) => ms < 100) && s.sticky, 'details: SHA-256: bound view and card with details, no task of 100 ms or more', JSON.stringify(s));
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
    check(r.label === 'try' && /[#&]whatif=1(&|$)/.test(r.hash) && r.order.join() === 'bound-row,whatif-row,codemap-row,deps-row,sweep-row,trace-slot', 'what if: a row "try" after "bound", open from the link', JSON.stringify(r));
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
      await done(() => set($('examples'), 'sha256'));
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
    check(r.long.every((ms) => ms < 100) && r.u2 === want.toFixed(2), 'what if: SHA-256: no long task on the page; unroll ×2 equals an analysis made here', JSON.stringify([r, want]));
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
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      out.end = svg.getAttribute('aria-activedescendant');
      // the alignment: +1 is a new analysis at offset 59
      await done(() => document.querySelectorAll('.ly-shift')[1].click());
      await until(() => document.querySelector('.ly-offv')?.textContent === 'offset 59');
      out.after = [document.querySelector('.ly-offv').textContent, $('opt-align').value, /[#&]al=59(&|$)/.test(location.hash), /[#&]codemap=1(&|$)/.test(location.hash)];
      return out;`);
    check(r.label === 'bytes' && r.summary === 'cache lines · 13 B, 2 lines' && r.order.join() === 'bound-row,whatif-row,codemap-row,deps-row,sweep-row,trace-slot', 'code map: a row "bytes", open from the link', JSON.stringify(r));
    check(r.ins.join() === '1,2,1,1' && r.split.join() === 'false,true,false,false' && r.off === 'offset 58' && r.legend.join() === '16B 1,32B 1,64B 1', 'code map: the split instruction has a box on each line', JSON.stringify(r));
    check(r.info === 'add rax, 0x1 · 0x3a–0x3d (4 B)' && r.key[0] === 'ly-i1' && /^add rax, 0x1 · 0x3e–0x41 \(4 B\) · crosses a cache line$/.test(r.key[1]) && r.key[2], 'code map: arrow keys move through the instructions', JSON.stringify([r.info, r.key]));
    check(r.flash === 1 && r.end === 'ly-i3', 'code map: Enter jumps to the row; End to the last instruction', JSON.stringify([r.flash, r.end]));
    check(r.after.every((x, i) => (i === 0 ? x === 'offset 59' : i === 1 ? x === '59' : x)), 'code map: ▸ shifts the alignment offset (analyzed again, in the link)', JSON.stringify(r.after));
    await page.shot('codemap-chain.png');

    // SHA-256: drawing the map of 11,602 bytes stays under 100 ms per task
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const s = await page.eval(`${HELPERS}
      await done(() => set($('examples'), 'sha256'));
      const long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
      const t0 = performance.now();
      document.querySelector('#codemap summary').click();
      await until(() => document.querySelector('.ly-map'));
      const ms = performance.now() - t0;
      await wait(200);
      return { ms: Math.round(ms), long: [...long], n: document.querySelectorAll('.ly-ins').length, lines: document.querySelectorAll('.ly-line').length, o: overflow() };`);
    check(s.n === 2949 && s.lines === Math.ceil(11602 / 64) && s.long.every((ms) => ms < 100) && s.o <= 0, 'code map: SHA-256: every instruction, no task of 100 ms or more', JSON.stringify(s));
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
        order: [...$('more').children].map((e) => e.id) };
      const svg = document.querySelector('.dp-map');
      svg.focus();
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      out.key = [svg.getAttribute('aria-activedescendant'), document.querySelector('.dp-info').textContent, [...document.querySelectorAll('.dp-arc.on')].length];
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(50);
      out.flash = trs().findIndex((tr) => tr.classList.contains('rj-flash'));
      return out;`);
    check(r.label === 'deps' && r.summary === 'dependency arcs · 3 edges, 2 ↻' && r.order.join() === 'bound-row,whatif-row,codemap-row,deps-row,sweep-row,trace-slot', 'deps: a row "deps", open from the link', JSON.stringify(r));
    check(r.arcs.slice().sort().join() === '0>1!,1>0c!,2>2c' && r.legend.join() === '→ 1,↻ 2,chain' && r.nodes === 4, 'deps: add → add, add ↻ add (the chain), dec ↻ dec', JSON.stringify(r));
    check(r.key[0] === 'dp-i1' && r.key[1] === 'add rax, 0x1 ← add rax, 0x1 → add rax, 0x1 ↻' && r.key[2] === 2 && r.flash === 1, 'deps: arrow keys select an instruction and its arcs; Enter jumps to the row', JSON.stringify([r.key, r.flash]));
    await page.shot('deps-chain.png');

    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const s = await page.eval(`${HELPERS}
      await done(() => set($('examples'), 'sha256'));
      document.querySelector('#deps summary').click();
      await until(() => document.querySelector('#deps .dp-body')?.dataset.state === 'waiting');
      const out = [document.querySelector('#deps .dp-body button')?.textContent, document.querySelectorAll('.dp-map').length];
      const long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
      const t0 = performance.now();
      document.querySelector('#deps .dp-body button').click();
      await until(() => document.querySelector('#deps .dp-body')?.dataset.state === 'done', 60000);
      return [...out, Math.round(performance.now() - t0), long, document.querySelectorAll('.dp-node').length];`);
    check(s[0] === 'trace 2,949 instructions' && s[1] === 0 && s[4] === 2949, 'deps: SHA-256: the trace waits for a click, then every instruction is drawn', JSON.stringify(s));
    console.log(`deps: SHA-256: traced and drawn in ${s[2]} ms after the click; long tasks ${JSON.stringify(s[3])}`);
  }

  // --- A–B mode: the views of the single result are hidden, also when the A–B traces show the "more" section -------------
  {
    const chain = ex('chain');
    await page.goto(`${origin}/?nosw=1#v=1&bound=1&whatif=1&codemap=1&deps=1&trace=1&c=${b64(chain.text.hex)}`);
    await page.result();
    const r = await page.eval(`${HELPERS}
      await until(() => document.querySelector('.bd-item') && document.querySelector('.dp-map'), 20000);
      const shown = () => ['bound-row', 'whatif-row', 'codemap-row', 'deps-row'].map((id) => getComputedStyle($(id)).display !== 'none');
      const single = shown();
      trs()[1].cells[2].click(); await wait(100); // a selected row (its card) in single mode
      const cardSingle = !$('icard').hidden;
      await done(() => $('cmp-ab').click()); await wait(300);
      const ab = [shown(), getComputedStyle($('more')).display];
      // a click on a row of A's table in A–B mode: no card (not the single result's)
      document.querySelector('table.uops tbody tr')?.cells[2]?.click(); await wait(300);
      const cards = [...document.querySelectorAll('.ic')].filter((c) => !c.hidden && c.offsetParent !== null).length;
      await done(() => $('cmp-single').click()); await wait(300);
      return { single, ab, back: shown(), cardSingle, cards };`);
    check(r.single.every(Boolean) && r.ab[0].every((x) => !x) && r.back.every(Boolean), 'A–B mode: the views are hidden (also with the A–B traces open), back in single mode they are there', JSON.stringify(r));
    check(r.cardSingle && r.cards === 0, 'A–B mode: no instruction card', JSON.stringify(r));
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
      const btn = (k) => document.querySelector('.ex-tools .ex-btn[data-format="' + k + '"]');
      const out = { labels: [...document.querySelectorAll('.ex-tools > *')].map((e) => e.textContent), inTools: !!btn('md')?.closest('.table-tools') };
      for (const k of ['md', 'csv', 'json']) { btn(k).click(); await wait(30); }
      out.flash = btn('json').textContent;
      out.got = got;
      return out;`);
    check(r.labels.join() === 'copy,md,csv,json' && r.inTools && r.flash === 'copied', 'copy: three buttons in the tools above the uop table', JSON.stringify(r.labels));
    const [md, csv, json] = r.got;
    check(md?.startsWith('**2.00 cycles/iteration** · SKL') && md.includes('| `add rax, 0x1` |') && /\[wuica\]\(http:\/\/127\.0\.0\.1:\d+\/\?nosw=1#v=1&c=/.test(md), 'copy: Markdown with a link to the page', md);
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
      out.push(await page.eval(`${HELPERS} await until(() => document.querySelector('.bd-item') && document.querySelector('.ly-map') && document.querySelector('.dp-map') && document.querySelector('#whatif .wi-body')?.dataset.state === 'done'); return { w: ${w}, o: overflow(), bg: getComputedStyle(document.documentElement).backgroundColor };`));
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
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be writing its profile: left in the temp dir */ }
}

console.log(`${count} views browser checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
