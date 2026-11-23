// End-to-end test of the built site (web/dist) in headless Chrome, driven over the DevTools protocol; no
// dependencies (Node 22+ for the WebSocket client). Run web/build.sh first.
//
//    node tests-js/web_browser.mjs [--chrome PATH] [--keep]
//
// It copies web/dist to a temporary directory and serves the copy itself, because it also stops the server
// (the page must keep working offline) and swaps in a second "deploy" (the service worker must take it over).
// Skips (exit 0) if Chrome is not found. Uses a fresh browser profile in the temporary directory.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ---- a static file server that can be stopped and pointed at another directory ---------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
let root = '';
const requests = [];
const sockets = new Set();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  requests.push(url.pathname + url.search);
  let p = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { // like Cloudflare Pages with a 404.html
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(path.join(root, '404.html')));
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(p).pipe(res);
});
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
let port = 0;
const listen = () => new Promise((r) => server.listen(port, '127.0.0.1', () => { port = server.address().port; r(); }));
const stop = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); });

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
  problems = []; // console errors, exceptions, failed requests
  static async open(browser, { width = 1280, height = 900, mobile = false } = {}) {
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
    for (const d of ['Runtime', 'Log', 'Page', 'Network']) await p.cmd(`${d}.enable`);
    await p.cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    return p;
  }
  cmd(method, params) { return this.browser.send(method, params, this.sessionId); }
  async eval(expression) {
    const r = await this.cmd('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  }
  async goto(url) {
    await this.cmd('Page.navigate', { url });
    await sleep(150);
    await this.waitFor(`document.readyState === 'complete'`, 'load');
  }
  async reload() { await this.cmd('Page.reload'); await sleep(150); await this.waitFor(`document.readyState === 'complete'`, 'reload'); }
  async waitFor(cond, what, ms = 20000) {
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
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const until = async (f, ms = 15000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + f); await wait(50); } };
  const tp = () => document.querySelector('.tp .value')?.textContent;
  const done = async (start) => { const n = $('results').dataset.run; start(); await until(() => $('results').dataset.run !== n); }; // a run has finished
  const example = (id) => done(() => set($('examples'), id));
  const overflow = () => document.documentElement.scrollWidth - innerWidth;
`;

// ---- the test ---------------------------------------------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-web-test-'));
const siteA = path.join(tmp, 'site-a'), siteB = path.join(tmp, 'site-b');
fs.cpSync(dist, siteA, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(siteA, 'manifest.json'), 'utf8'));
// a second deploy: the same files with another version
fs.cpSync(dist, siteB, { recursive: true });
const versionB = 'feedfacecafe';
fs.writeFileSync(path.join(siteB, 'manifest.json'), fs.readFileSync(path.join(siteB, 'manifest.json'), 'utf8').replace(manifest.version, versionB));
fs.writeFileSync(path.join(siteB, 'sw.js'), fs.readFileSync(path.join(siteB, 'sw.js'), 'utf8').replace(manifest.version, versionB));

root = siteA;
await listen();
const origin = `http://127.0.0.1:${port}`;
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = '';
  proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
  proc.on('exit', () => reject(new Error('Chrome exited: ' + err.slice(0, 500))));
  setTimeout(() => reject(new Error('Chrome did not start')), 20000);
});
const browser = await Browser.connect(wsUrl);

try {
  // --- 1. mock mode (?mock=1), desktop width ---------------------------------------------------------------------------
  {
    const page = await Page.open(browser);
    await page.goto(`${origin}/?mock=1&nosw=1`);
    await page.ready();
    check(!requests.some((r) => r.includes('wuica_wasm')), 'mock mode: the analyzer is not fetched');
    const r = await page.eval(`${HELPERS}
      const out = {};
      out.title = document.title; out.robots = document.querySelector('meta[name=robots]').content;
      out.notice = $('notice').hidden ? '' : $('notice').innerText;
      out.groups = [...$('arch').querySelectorAll('optgroup')].map((g) => g.label + ': ' + [...g.children].map((o) => o.value).join(','));
      out.arch = $('arch').value; out.examples = [...$('examples').options].map((o) => o.value).join(',');
      out.focusable = ['code', 'arch', 'run', 'copy-link', 'examples', 'mode-asm', 'mode-hex'].every((id) => $(id).tabIndex >= 0);
      out.labelled = [...document.querySelectorAll('input, select, textarea')].filter((e) => !(e.labels?.length || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby'))).map((e) => e.id || e.name);
      out.empty = $('result-body').innerText;
      // Ctrl+Enter runs
      $('code').focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      await until(() => tp());
      out.tp = tp(); out.meta = $('result-body').innerText;
      out.rows = [...document.querySelectorAll('table.uops tbody tr')].map((tr) => tr.innerText.trim().replace(/\\t+/g, '|'));
      out.total = document.querySelector('table.uops tfoot tr').innerText.replace(/\\t+/g, '|');
      out.link = document.querySelector('table.uops tbody a').href;
      out.heat = [...document.querySelectorAll('table.uops td.heat')].map((td) => td.style.getPropertyValue('--h')).slice(0, 3).join(',');
      out.blank = [...document.querySelectorAll('table.uops tbody td')].some((td) => td.textContent === '0');
      out.reportHidden = !document.querySelector('details.report-wrap').open;
      document.querySelector('details.report-wrap summary').click(); await wait(50);
      out.report = document.querySelector('pre.report').textContent.slice(0, 43);
      out.hash = location.hash; out.search = location.search;
      for (const id of ['loadstore', 'avx', 'stack', 'synthetic']) { await example(id); out[id] = [tp(), $('arch').value, document.querySelector('.mock-tag').textContent.slice(0, 44), document.querySelectorAll('table.uops tr.extra').length, overflow()]; }
      out.reportStaysOpen = document.querySelector('details.report-wrap').open;
      out.synthetic2 = { notes: [...document.querySelectorAll('table.uops td.note')].map((td) => td.textContent).join(''), nolink: !document.querySelector('table.uops tr.unsupported a'), caveat: [...document.querySelectorAll('.caveat')].map((e) => e.textContent).join(' / '), mode: $('result-body').innerText.includes('analyzed unrolled') };
      const hidden = document.querySelectorAll('table.uops thead th').length; $('hide-empty').click(); await wait(50);
      out.columns = [hidden, document.querySelectorAll('table.uops thead th').length];
      await example('error'); out.error = document.querySelector('.error-box')?.textContent;
      return out;`);
    check(r.robots === 'noindex' && /wuica/.test(r.title), 'mock: title and robots');
    check(/Mock mode/.test(r.notice), 'mock: the notice says so', r.notice);
    check(r.groups[0] === 'Intel: RKL,TGL,ICL,CLX,CFL,SKX,KBL,SKL,BDW,HSW,IVB,SNB' && r.groups[1] === 'Experimental (this fork): ZEN3,ADL-P,ICX' && r.arch === 'SKL', 'mock: the microarchitecture menu', JSON.stringify(r.groups));
    check(r.examples === ',chain,loadstore,avx,stack,synthetic,error', 'mock: the examples menu', r.examples);
    check(r.focusable && r.labelled.length === 0, 'mock: controls are focusable and labelled', JSON.stringify(r.labelled));
    check(/No result yet/.test(r.empty), 'mock: empty state', r.empty);
    check(r.tp === '2.00' && /cycles per iteration/.test(r.meta) && /analyzed as a loop/.test(r.meta) && /mock data/.test(r.meta) && /Dependencies/.test(r.meta), 'mock: Ctrl+Enter gives the result of the first example', r.meta.slice(0, 300));
    check(r.rows.length === 4 && r.rows[0] === 'add rax, 0x1|1|1|1|0.22|0.22|0.29|0.27' && r.rows[3] === 'jnz 0xfffffffffffffff5|M' && r.total === 'Total|3|3|3|0.5|0.52|0.52|1.47', 'mock: the uop table (empty columns hidden, zeros blank, totals)', JSON.stringify([r.rows, r.total]));
    check(r.link === 'https://www.uops.info/html-instr/ADD_R64_I8.html' && r.heat === '0.22,0.22,0.29' && !r.blank, 'mock: links and shading', `${r.link} ${r.heat}`);
    check(r.reportHidden && r.report === 'Throughput (in cycles per iteration): 2.00\n' && r.reportStaysOpen, 'mock: the text report toggles and stays open', JSON.stringify(r.report));
    check(/^#v=1&c=/.test(r.hash) && r.search === '?mock=1&nosw=1', 'mock: the state is in the fragment, not in the query string', r.hash);
    check(r.loadstore[0] === '1.00' && r.loadstore[1] === 'ZEN3' && r.avx[0] === '4.00' && r.avx[1] === 'ADL-P' && r.stack[0] === '2.10' && r.stack[3] === 1, 'mock: the other examples', JSON.stringify([r.loadstore, r.avx, r.stack]));
    check([r.loadstore, r.avx, r.stack, r.synthetic].every((x) => x[4] <= 0), 'mock: the page never scrolls sideways at 1280px', JSON.stringify([r.loadstore[4], r.avx[4], r.stack[4], r.synthetic[4]]));
    check(r.synthetic[0] === '23.57' && r.synthetic[3] === 2 && r.synthetic2.notes === 'XJM' && r.synthetic2.nolink && r.synthetic2.mode && /could not be decoded/.test(r.synthetic2.caveat), 'mock: synthetic case (extra rows, notes, unrolled, decode errors)', JSON.stringify([r.synthetic, r.synthetic2]));
    check(r.columns[1] > r.columns[0], 'mock: "hide empty columns" toggles', JSON.stringify(r.columns));
    check(/Analysis failed: mock/.test(r.error ?? ''), 'mock: an analysis error is shown', r.error);

    // input errors, assembly mode with the mock assembler, options
    const s = await page.eval(`${HELPERS}
      const out = {};
      const run = async () => { $('run').click(); await wait(250); };
      set($('code'), '48 01 zz'); await run(); out.notHex = [$('input-messages').innerText, $('code').getAttribute('aria-invalid')];
      set($('code'), '4801d'); await run(); out.odd = $('input-messages').innerText;
      set($('code'), ''); await run(); out.none = $('input-messages').innerText;
      set($('code'), '   0:\\t48 01 d8             \\tadd    %rbx,%rax\\n   3:\\tc3                   \\tret\\n'); await done(() => $('run').click());
      out.objdump = [$('input-messages').innerText, $('result-body').innerText.includes('4 bytes'), $('code').getAttribute('aria-invalid')];
      $('mode-asm').click(); await wait(300);
      out.asm = [$('code').value.split('\\n')[1], !$('syntax-wrap').hidden, $('run').disabled];
      set($('syntax'), 'att'); await wait(50); out.att = $('code').value.split('\\n')[1];
      await done(() => $('run').click()); out.assembled = $('input-messages').innerText;
      set($('code'), 'loop:\\n  frobnicate %rax\\n  decq %r15\\n    bogus\\n'); out.stale = $('result-body').classList.contains('stale');
      await run(); out.diag = $('input-messages').innerText;
      $('input-messages').querySelectorAll('button')[1].click(); out.selected = $('code').value.slice($('code').selectionStart, $('code').selectionEnd);
      $('mode-hex').click(); await wait(50); out.hexKept = $('code').value.includes('48 01 d8');
      set($('opt-align'), '99'); document.querySelector('input[name=init][value=stack]').click(); $('opt-nma').click(); set($('opt-cycles'), '1234'); await wait(700);
      out.options = [$('opt-align').value, $('advanced-summary').textContent, location.hash.replace(/&c=.*/, '')];
      $('opt-reset').click(); await wait(600); out.reset = [$('opt-align').value, $('opt-nma').checked, location.hash.replace(/&c=.*/, '')];
      return out;`);
    check(/Not hex: "zz"/.test(s.notHex[0]) && s.notHex[1] === 'true' && /Odd number of hex digits \(5\)/.test(s.odd) && /No bytes/.test(s.none), 'mock: hex input errors are shown next to the input', JSON.stringify([s.notHex, s.odd, s.none]));
    check(s.objdump[0] === '' && s.objdump[1] && s.objdump[2] === null, 'mock: pasted objdump output is analyzed', JSON.stringify(s.objdump));
    check(s.asm[0] === '  add rax, 1' && s.asm[1] && !s.asm[2] && s.att === '  addq $1, %rax', 'mock: assembly mode and syntax switch', JSON.stringify([s.asm, s.att]));
    // with wuica_asm.wasm in the build, mock mode uses the real assembler (only the analyzer is mocked)
    check((manifest.assembler ? /^assembled: 13 bytes: 48 83 c0 01 48 83 c0 01 49 ff cf 75 f3$/ : /assembled \(mock assembler\): 13 bytes: 48 83 c0 01/).test(s.assembled), 'mock: assembly is assembled', s.assembled);
    check(s.stale && /line 2:3: .*\n.*line 4:5: /.test(s.diag) && s.selected === '    bogus', 'mock: assembler diagnostics with lines; a click selects the line', JSON.stringify([s.stale, s.diag, s.selected]));
    check(s.hexKept, 'mock: each input mode keeps its text');
    check(s.options[0] === '63' && s.options[1] === '· 4 changed' && s.options[2] === '#v=1&al=63&mc=1234&ip=stack&nma=1', 'mock: options are clamped and go into the fragment', JSON.stringify(s.options));
    check(s.reset[0] === '0' && !s.reset[1] && s.reset[2] === '#v=1', 'mock: reset to defaults', JSON.stringify(s.reset));

    // restore from a link (full load), then from a changed fragment; copy link
    const link = '#v=1&m=asm&s=att&a=ZEN3&al=31&mi=7&mc=1234&ip=stack&sfe=1&nmi=1&nma=1&c=bG9vcDoKICBtb3ZxICVyYXgsICglcnNpKQogIG1vdmwgKCVyc2kpLCAlZWF4CiAgYWRkcSAkMSwgJXJheAogIGRlY3EgJXIxNQogIGpueiBsb29wCg';
    await page.goto('about:blank');
    await page.goto(`${origin}/?mock=1&nosw=1${link}`);
    await page.waitFor(`document.querySelector('.tp .value')`, 'the result of a shared link');
    const u = await page.eval(`${HELPERS}
      const out = {};
      out.restored = [$('mode-asm').checked, $('syntax').value, $('arch').value, $('code').value.split('\\n')[1], $('opt-align').value, document.querySelector('input[name=init]:checked').value, $('opt-sfe').checked, $('opt-nmi').checked, $('opt-nma').checked, $('opt-iter').value, $('opt-cycles').value].join('|');
      out.tp = tp(); out.same = location.hash === ${JSON.stringify(link)};
      location.hash = 'v=1&a=SKL&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM';
      await until(() => tp() === '2.00');
      out.second = [$('mode-hex').checked, $('arch').value, $('code').value, $('opt-align').value].join('|');
      location.hash = 'about'; await wait(200); out.anchor = $('code').value;
      let copied = null; navigator.clipboard.writeText = async (t) => { copied = t; };
      $('copy-link').click(); await wait(200);
      out.copied = copied; out.label = $('copy-link').textContent; out.href = location.href;
      navigator.clipboard.writeText = async () => { throw new Error('denied'); };
      $('copy-link').click(); await wait(200); out.afterDenied = $('status').textContent;
      return out;`);
    check(u.restored === 'true|att|ZEN3|  movq %rax, (%rsi)|31|stack|true|true|true|7|1234' && u.tp === '1.00' && u.same, 'mock: a link restores input, mode and options, and runs', JSON.stringify(u));
    check(u.second === 'true|SKL|48 83 c0 01 48 83 c0 01 49 ff cf 75 f3|0' && u.anchor === '48 83 c0 01 48 83 c0 01 49 ff cf 75 f3', 'mock: a changed fragment is applied; an anchor is not a state', JSON.stringify([u.second, u.anchor]));
    check(u.copied === `${origin}/?mock=1&nosw=1#v=1&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM` && u.copied === u.href && u.label === 'Copied', 'mock: Copy link', JSON.stringify([u.copied, u.label]));
    check(/copied|address bar/.test(u.afterDenied), 'mock: a refused clipboard is handled', u.afterDenied);
    const problems = page.take();
    check(problems.length === 0, 'mock: no console errors', problems.join('\n'));
    await page.cmd('Page.close');
  }

  // --- 2. the real analyzer (in its worker), phone width; then service worker, offline, a new deploy --------------------
  {
    const page = await Page.open(browser, { width: 375, height: 812, mobile: true });
    requests.length = 0;
    await page.goto(`${origin}/`);
    await page.ready();
    const r = await page.eval(`${HELPERS}
      const out = {};
      const run = () => done(() => $('run').click());
      const notes = () => [...document.querySelectorAll('table.uops tbody td.note')].map((td) => td.textContent || '-').join('');
      out.build = $('build-id').textContent; out.notice = $('notice').hidden ? '' : $('notice').innerText;
      out.failed = document.querySelector('.error-box')?.textContent ?? '';
      out.examples = [...$('examples').options].map((o) => o.value).join(',');
      out.overflow0 = overflow();
      await run();
      out.first = { tp: tp(), mock: !!document.querySelector('.mock-tag'), text: $('result-body').innerText,
        rows: [...document.querySelectorAll('table.uops tbody tr')].map((tr) => tr.innerText.trim().replace(/\\t+/g, '|')),
        total: document.querySelector('table.uops tfoot tr').innerText.trim().replace(/\\t+/g, '|'),
        report: document.querySelector('pre.report').textContent };
      out.overflow1 = overflow();
      const w = document.querySelector('.table-wrap'); out.tableScrolls = [w.clientWidth <= innerWidth, getComputedStyle(w).overflowX];
      out.fontSize = [getComputedStyle($('code')).fontSize, getComputedStyle(document.body).fontSize, getComputedStyle(document.body).fontFamily.split(',')[0]];
      // the examples on the microarchitectures the reference's results were recorded for
      for (const [id, arch] of [['loadstore', 'ZEN3'], ['avx', 'ADL-P'], ['stack', 'SKL']]) {
        if ($('arch').value !== arch) await done(() => set($('arch'), arch));
        await example(id);
        out[id] = [tp(), $('result-body').innerText.includes(arch), document.querySelector('table.uops thead').innerText.trim().replace(/\\s*\\t+/g, '|'), document.querySelectorAll('table.uops tr.extra').length, notes(), overflow(), document.querySelector('pre.report').textContent];
      }
      out.experimental = [$('arch-hint').textContent, $('result-body').innerText.includes('experimental model')];
      // options change the result
      await example('chain');
      out.before = notes();
      await done(() => $('opt-nma').click()); out.noMacroFusion = [notes(), tp(), location.hash.includes('nma=1')];
      await done(() => $('opt-nma').click());
      await done(() => set($('opt-align'), '5')); out.aligned = [tp(), location.hash.includes('al=5')];
      await done(() => $('opt-sfe').click()); out.simpleFrontEnd = [document.querySelector('.limits').innerText.replace(/\\s+/g, ' ')];
      await done(() => $('opt-reset').click()); out.reset = [tp(), notes()];
      // error responses of the analyzer
      set($('code'), '06'); await run(); out.noInstr = document.querySelector('.error-box')?.textContent;
      set($('code'), '48 01 d8 06 0f 0b'); await run();
      out.partial = [tp(), [...document.querySelectorAll('.caveat')].map((e) => e.textContent).join(' / '), notes()];
      // an input on which the analyzer itself crashes: reported, and the next analysis works
      set($('code'), '48 f7 f1 '.repeat(200)); set($('opt-iter'), '10000'); set($('opt-cycles'), '100000');
      await until(() => document.querySelector('.error-box, .tp') && !$('results').hasAttribute('aria-busy') && !$('result-body').classList.contains('stale'), 60000);
      out.crash = document.querySelector('.error-box')?.textContent ?? ('no error: ' + tp());
      $('opt-reset').click(); await example('chain'); out.afterCrash = tp();
      // a long analysis does not block the page and can be cancelled
      set($('code'), '4801d8'.repeat(20000));
      $('run').click(); await wait(300);
      let ticks = 0; const t = setInterval(() => ticks++, 20); await wait(700); clearInterval(t);
      out.long = [$('run').textContent, $('results').getAttribute('aria-busy'), ticks];
      $('run').click(); await wait(100);
      out.cancelled = [$('run').textContent, $('results').hasAttribute('aria-busy'), $('status').textContent, tp()];
      await example('chain'); out.afterCancel = [tp(), $('run').textContent];
      $('mode-asm').click(); await wait(600);
      out.asm = [$('input-messages').innerText, $('run').disabled];
      if (${!!manifest.assembler}) {
        // the real assembler: both syntaxes, diagnostics, a block that assembles to nothing
        set($('syntax'), 'intel'); await example('chain'); out.asmChain = [tp(), $('input-messages').innerText];
        set($('syntax'), 'att'); await done(() => $('run').click()); out.asmAtt = [tp(), $('code').value.split('\\n')[1], $('input-messages').innerText];
        set($('syntax'), 'intel');
        set($('code'), 'loop:\\n  vaddps ymm0, ymm1, ymm2\\n  frobnicate rax\\n  jmp loop\\n'); $('run').click(); await wait(1500);
        out.asmErr = [$('input-messages').innerText, $('code').getAttribute('aria-invalid')];
        set($('code'), 'x:\\n  vaddps ymm0, ymm0, ymm1\\n  dec r15\\n  jnz x\\n'); await done(() => $('run').click()); out.asmAvx = [tp(), $('input-messages').innerText];
        set($('code'), '.data\\n  .byte 1\\n'); $('run').click(); await wait(1500); out.asmEmpty = $('input-messages').innerText;
        $('mode-hex').click(); await wait(50);
      } else {
        $('input-messages').querySelector('button')?.click(); await wait(100);
      }
      out.back = [$('mode-hex').checked, $('run').disabled];
      return out;`);
    check(r.failed === '' && r.notice === '' && r.build === manifest.version, 'real: the page starts with the real analyzer and shows the build', JSON.stringify([r.failed, r.notice, r.build]));
    check(requests.some((x) => x.includes('wuica_wasm.wasm')) && requests.some((x) => x.includes('data/arch/SKL.json')) && requests.some((x) => x.includes('js/engine-worker.js')), 'real: the analyzer, its worker and the selected table are fetched');
    check(r.examples === ',chain,loadstore,avx,stack', 'real: no mock-only examples', r.examples);
    check(r.first.tp === '2.00' && !r.first.mock && /analyzed as a loop/.test(r.first.text) && /bottleneck\s+Dependencies/.test(r.first.text) && / ms\n/.test(r.first.text), 'real: the first example: 2.00 cycles, a loop, bottleneck Dependencies', r.first.text.slice(0, 300));
    check(r.first.rows.length === 4 && r.first.rows[0] === 'add rax, 0x1|1|1|1|0.22|0.22|0.29|0.27' && r.first.rows[3] === 'jnz 0xfffffffffffffff5|M' && r.first.total === 'Total|3|3|3|0.5|0.52|0.52|1.47', 'real: the uop table equals the reference (rounded like uiCA, totals as in its "Total" line)', JSON.stringify([r.first.rows, r.first.total]));
    check(r.first.report.startsWith('Throughput (in cycles per iteration): 2.00\nBottleneck: Dependencies\n') && r.first.report.includes('│ Total'), 'real: the text report');
    check(r.loadstore[0] === '1.00' && r.loadstore[1] && /ALU0\|ALU1\|ALU2\|ALU3\|AGU0\|AGU1\|AGU2\|SD0$/.test(r.loadstore[2]) && r.loadstore[4] === '----M', 'real: load/store example on ZEN3 (1.00, Zen port names)', JSON.stringify(r.loadstore.slice(0, 6)));
    check(r.avx[0] === '4.00' && r.avx[1] && /Port 0\|Port 1\|Port 5\|Port 6\|Port B$/.test(r.avx[2]), 'real: AVX example on ADL-P (4.00, ports up to B)', JSON.stringify(r.avx.slice(0, 6)));
    check(r.stack[0] === '2.10' && r.stack[3] === 1 && /unknown/.test(r.stack[6].split('\n')[1]), 'real: stack example on SKL (2.10, a stack-sync row, bottleneck unknown)', JSON.stringify(r.stack.slice(0, 6)));
    check([r.loadstore, r.avx, r.stack].every((x) => x[5] <= 0) && r.overflow0 <= 0 && r.overflow1 <= 0 && r.tableScrolls[0] && r.tableScrolls[1] === 'auto', 'real: at 375px the page never scrolls sideways; the table scrolls in its container', JSON.stringify([r.overflow0, r.overflow1, r.tableScrolls]));
    check(r.fontSize[0] === '16px' && r.fontSize[1] === '15px' && /IBM Plex Mono/.test(r.fontSize[2]), 'real: font sizes', JSON.stringify(r.fontSize));
    check(r.before === '---M' && r.noMacroFusion[0] === '----' && r.noMacroFusion[2], 'real: "no macro-fusion" reruns the analysis and removes the M note', JSON.stringify([r.before, r.noMacroFusion]));
    check(r.aligned[0] === '2.00' && r.aligned[1] && /Issue 0.75 Dependencies 2.00|Issue/.test(r.simpleFrontEnd[0]) && !/DSB|LSD|Decoder/.test(r.simpleFrontEnd[0]), 'real: alignment offset and simple front end reach the analyzer', JSON.stringify([r.aligned, r.simpleFrontEnd]));
    check(r.reset[0] === '2.00' && r.reset[1] === '---M', 'real: reset restores the default result', JSON.stringify(r.reset));
    check(/Analysis failed: no instructions found/.test(r.noInstr ?? ''), 'real: an error response is shown (no instructions)', r.noInstr);
    check(/1 position could not be decoded/.test(r.partial[1]) && r.partial[2].includes('X'), 'real: decode errors and unsupported instructions are marked', JSON.stringify(r.partial));
    check(/failed for this input/.test(r.crash) && r.afterCrash === '2.00', 'real: a crash of the analyzer is reported and the analyzer is restarted', JSON.stringify([r.crash, r.afterCrash]));
    check(r.long[0] === 'Cancel' && r.long[1] === 'true' && r.long[2] >= 20, 'real: a long analysis runs in the worker: the page stays responsive', JSON.stringify(r.long));
    check(r.cancelled[0] === 'Analyze' && !r.cancelled[1] && r.cancelled[2] === 'cancelled' && r.afterCancel[0] === '2.00', 'real: Cancel stops it; the next analysis works', JSON.stringify([r.cancelled, r.afterCancel]));
    if (!manifest.assembler) {
      check(/Assembly input is not available in this build yet/.test(r.asm[0]) && r.asm[1] && r.back[0] && !r.back[1], 'real: without the assembler, assembly mode says so and offers hex mode', JSON.stringify([r.asm, r.back]));
      check(!requests.some((x) => x.includes('wuica_asm')), 'real: the missing assembler is not requested');
    } else {
      check(!/not available/.test(r.asm[0]) && !r.asm[1] && requests.some((x) => x.includes('wuica_asm.wasm')), 'real: the assembler is loaded when assembly mode is chosen', JSON.stringify([r.asm, requests.filter((x) => x.includes('asm'))]));
      check(r.asmChain[0] === '2.00' && /^assembled: 13 bytes: 48 83 c0 01 48 83 c0 01 49 ff cf 75 f3$/.test(r.asmChain[1]), 'real: the chain example assembled (Intel) gives the hex result', JSON.stringify(r.asmChain));
      check(r.asmAtt[0] === '2.00' && r.asmAtt[1] === '  addq $1, %rax' && /13 bytes: 48 83 c0 01/.test(r.asmAtt[2]), 'real: AT&T syntax', JSON.stringify(r.asmAtt));
      check(/^line 3:3: .*frobnicate|^line 3:3: invalid instruction/m.test(r.asmErr[0]) && r.asmErr[1] === 'true', 'real: assembler diagnostics with line and column', JSON.stringify(r.asmErr));
      check(/^\d\.\d\d$/.test(r.asmAvx[0] ?? '') && /assembled: 9 bytes: c5 fc 58 c1 49 ff cf 75 f7/.test(r.asmAvx[1]), 'real: an AVX block typed in assembly is analyzed', JSON.stringify(r.asmAvx));
      check(/no machine code/.test(r.asmEmpty), 'real: assembly without code in .text is reported', r.asmEmpty);
      check(r.back[0] && !r.back[1], 'real: back to hex mode');
    }

    // service worker: everything gets cached, then the page works without the server
    const sw = await page.eval(`${HELPERS}
      await until(() => /works offline/.test($('status').textContent), 60000);
      const keys = await caches.keys();
      const c = await caches.open(keys[0]);
      return { keys, controlled: !!navigator.serviceWorker.controller, cached: (await c.keys()).map((r) => new URL(r.url).pathname.slice(1)).sort() };`);
    // everything, the assembler included (the page prefetches it when idle; the checks above also used it)
    const expected = Object.keys(manifest.files).concat('manifest.json').sort();
    check(sw.controlled && sw.keys.length === 1 && sw.keys[0] === `wuica-${manifest.version}`, 'sw: controls the page; the cache is named after the build', JSON.stringify(sw.keys));
    check(JSON.stringify(sw.cached) === JSON.stringify(expected), 'sw: the page, the analyzer and all tables are cached', `missing: ${expected.filter((f) => !sw.cached.includes(f))}; extra: ${sw.cached.filter((f) => !expected.includes(f))}`);
    check(page.take().length === 0, 'real: no console errors (online)', page.problems.join('\n'));

    await stop(); // offline
    requests.length = 0;
    await page.goto('about:blank');
    await page.goto(`${origin}/?x=1#v=1&a=ADL-P&c=YzQgZTIgZDUgYWEgZjQgNGMgMDMgZDEgNGQgMGYgYWYgYzAgNDkgZmYgY2YgNzUgZWY`);
    await page.waitFor(`document.querySelector('.tp .value')`, 'a result while offline');
    const off = await page.eval(`${HELPERS}
      const out = { tp: tp(), arch: $('arch').value, build: $('build-id').textContent, real: !document.querySelector('.mock-tag') && $('notice').hidden };
      await done(() => set($('arch'), 'ICX'));
      out.switched = $('result-body').innerText.includes('Ice Lake server');
      await wait(300); out.status = $('status').textContent; out.font = document.fonts.check('15px "IBM Plex Mono"');
      if (${!!manifest.assembler}) {
        $('mode-asm').click(); await wait(300); set($('syntax'), 'intel');
        await example('chain'); out.asm = [tp(), $('input-messages').innerText];
      }
      return out;`);
    check(off.tp === '4.00' && off.arch === 'ADL-P' && off.build === manifest.version && off.real, 'offline: a shared link loads and is analyzed with the server stopped (also with a query string)', JSON.stringify(off));
    check(off.switched && off.font, 'offline: another microarchitecture (its table) and the font come from the cache', JSON.stringify(off));
    if (manifest.assembler) check(off.asm?.[0] === '2.00' && /^assembled: 13 bytes/.test(off.asm?.[1] ?? ''), 'offline: assembly mode works (the assembler comes from the cache)', JSON.stringify(off.asm));
    const offProblems = page.take();
    check(offProblems.length === 0, 'offline: no console errors', offProblems.join('\n'));
    if (manifest.assembler) {
      // an assembler that cannot be fetched (offline, not cached) is a temporary failure, not "not in this build"
      await page.eval(`const keys = await caches.keys(); await (await caches.open(keys[0])).delete('wuica_asm.wasm'); return 1;`);
      await page.goto('about:blank');
      await page.goto(`${origin}/#v=1&m=asm&c=bG9vcDoKICBhZGQgcmF4LCAxCiAgZGVjIHIxNQogIGpueiBsb29wCg`);
      await page.waitFor(`document.getElementById('input-messages').innerText.includes('could not be loaded')`, 'the assembler load failure');
      const fail = await page.eval(`${HELPERS} return [$('input-messages').innerText, $('run').disabled];`);
      check(/could not be loaded/.test(fail[0]) && !/not available in this build/.test(fail[0]) && fail[1] === false, 'offline: a missing assembler download is reported as such and can be retried', JSON.stringify(fail));
      page.take(); // the failed fetch of wuica_asm.wasm is logged by the browser
    }

    // a new deploy: the worker of the new build takes over, the old cache goes away, the page offers a reload
    root = siteB;
    await listen();
    await page.goto('about:blank');
    await page.goto(`${origin}/`);
    await page.ready();
    const first = await page.eval(`${HELPERS} return $('build-id').textContent;`);
    await page.waitFor(`!document.getElementById('update-note').hidden`, 'the update note', 30000);
    await sleep(1500); // requests of the page that the old worker was still answering
    const upd = await page.eval(`${HELPERS} return { keys: await caches.keys(), note: $('update-note').innerText };`);
    check(first === manifest.version, 'deploy: the open page is still the cached build', first);
    check(JSON.stringify(upd.keys) === JSON.stringify([`wuica-${versionB}`]) && /new version/.test(upd.note), 'deploy: the new worker replaces the cache and the page says so', JSON.stringify(upd));
    await page.reload();
    await page.ready();
    check(await page.eval(`return document.getElementById('build-id').textContent;`) === versionB, 'deploy: after a reload the page is the new build');
    const p3 = page.take();
    check(p3.length === 0, 'deploy: no console errors', p3.join('\n'));
    await page.cmd('Page.close');
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  browser.close();
  proc.kill();
  await stop().catch(() => {});
  await sleep(300);
  if (!args.includes('--keep')) fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`${count} browser checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
