// End-to-end test of the built site (web/dist) in headless Chrome, driven over the DevTools protocol; no
// dependencies (Node 22+ for the WebSocket client). Run web/build.sh first.
//
//    node tests-js/web_browser.mjs [--chrome PATH] [--keep]
//
// It copies web/dist to a temporary directory and serves the copy itself, because it also stops the server
// (the page must keep working offline) and swaps in a second "deploy" (the service worker must take it over).
// Skips (exit 0) if Chrome is not found. Uses a fresh browser profile in the temporary directory.
import { testConditions } from './cdp.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';
import { hostHandler } from './static-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'web', 'dist');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const chrome = findChrome(opt('--chrome'));
if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a static file server that can be stopped and pointed at another directory ---------------------------------------
let root = '';
const requests = [];
const sockets = new Set();
// like the host (redirects /index.html to /, a 404 page, _headers): see static-host.mjs
const server = http.createServer(hostHandler(() => root, { onRequest: (p) => requests.push(p) }));
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
    await testConditions((x, a) => p.cmd(x, a)); // (cdp.mjs: scratch runs under another font, scrollbars)
    // a compare panel or the cost column estimated over its time budget (from the main analysis's time, so on a slow machine
    // also for the small blocks here) waits for a click on its run button; this suite does not test that, so click it
    await p.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `setInterval(() => { for (const b of document.querySelectorAll('.cmp-run, .ins-cost-status button')) b.click(); }, 20);` });
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
  const mode = () => document.querySelector('.meta .tag')?.textContent;
  const listing = () => document.querySelector('pre.listing')?.textContent;
  const listingOpen = () => !!document.querySelector('details.listing-wrap')?.open;
  const caveats = () => [...document.querySelectorAll('#result-body .caveat')].map((e) => e.textContent).join(' / ');
  // the CPU checkboxes: the focused CPU (the details), and "check exactly these" (one change event, like one click)
  const focused = () => $('cpus').dataset.focus;
  const cpus = (...keys) => { const boxes = [...document.querySelectorAll('#cpu-grid input')]; for (const b of boxes) b.checked = keys.includes(b.value); boxes[0].dispatchEvent(new Event('change', { bubbles: true })); };
`;

// the objdump listing of the first example
const CHAIN = '   0:  48 83 c0 01    add rax, 0x1\n   4:  48 83 c0 01    add rax, 0x1\n   8:  49 ff cf       dec r15\n   b:  75 f3          jnz 0xfffffffffffffff5\n';

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
      out.groups = [[...document.querySelectorAll('#cpu-grid input')].map((b) => b.value).join(','), [...document.querySelectorAll('#cpu-grid label.proto input')].map((b) => b.value).join(','),
        document.querySelector('#cpu-grid input[value=ZEN3]').getAttribute('aria-label'), document.querySelector('#cpu-grid label.proto').title];
      out.arch = [focused(), [...document.querySelectorAll('#cpu-grid input:checked')].map((b) => b.value).join()]; out.examples = [...$('examples').options].map((o) => o.value).join(',');
      out.exGroups = [...$('examples').querySelectorAll('optgroup')].map((g) => g.label).join(',');
      out.footer = [document.querySelector('footer').innerText.replace(/\\s+/g, ' ').trim(), [...document.querySelectorAll('footer a')].map((a) => a.href).join(' '), document.querySelector('header nav a.gh:last-child')?.getAttribute('aria-label') + ' ' + document.querySelector('header nav a.gh')?.href,
        document.body.innerText.match(/(?<!un)official|AGPL|Plex|OFL|Typeface|license/gi)?.join(',') ?? ''];
      out.focusable = ['code', 'run', 'copy-link', 'examples', 'mode-asm', 'mode-hex', 'cpu-all'].every((id) => $(id).tabIndex >= 0) && [...document.querySelectorAll('#cpu-grid input')].every((b) => b.tabIndex >= 0);
      out.labelled = [...document.querySelectorAll('input, select, textarea')].filter((e) => !(e.labels?.length || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby'))).map((e) => e.id || e.name);
      await until(() => tp()); out.empty = [tp(), $('results').dataset.run]; // a fresh visit analyzes the first example by itself
      out.start = [$('mode-asm').checked, $('code').value.split('\\n')[1]]; // assembly is the default
      $('mode-hex').click(); await wait(50); // the rest of this part is in hex
      out.csp = document.querySelector('meta[http-equiv=Content-Security-Policy]').content;
      // Ctrl+Enter runs
      $('code').focus();
      await done(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
      out.tp = tp(); out.meta = $('result-body').innerText; out.mode = mode();
      out.listing = [listing(), listingOpen()];
      let copied = null; navigator.clipboard.writeText = async (t) => { copied = t; };
      document.querySelector('details.listing-wrap summary').click(); await wait(50);
      const cb = document.querySelector('details.listing-wrap button.copy');
      out.copyVisible = cb.offsetParent !== null; cb.click(); await wait(50);
      out.copied = [copied, cb.textContent, cb.getAttribute('aria-label')];
      document.querySelector('details.listing-wrap summary').click(); await wait(50);
      out.rows = [...document.querySelectorAll('table.uops tbody tr')].map((tr) => tr.innerText.trim().replace(/\\t+/g, '|'));
      out.total = document.querySelector('table.uops tfoot tr').innerText.replace(/\\t+/g, '|');
      out.link = document.querySelector('table.uops tbody a').href;
      out.heat = [...document.querySelectorAll('table.uops td.heat')].map((td) => td.style.getPropertyValue('--h')).slice(0, 3).join(',');
      out.blank = [...document.querySelectorAll('table.uops tbody td')].some((td) => td.textContent === '0');
      out.reportHidden = !document.querySelector('details.report-wrap').open;
      document.querySelector('details.report-wrap summary').click(); await wait(50);
      out.report = document.querySelector('pre.report').textContent.slice(0, 43);
      out.hash = location.hash; out.search = location.search;
      for (const id of ['loadstore', 'avx', 'stack', 'synthetic']) { await example(id); out[id] = [tp(), focused(), document.querySelector('.mock-tag').textContent.slice(0, 44), document.querySelectorAll('table.uops tr.extra').length, overflow()]; }
      out.reportStaysOpen = document.querySelector('details.report-wrap').open;
      out.synthetic2 = { notes: [...document.querySelectorAll('table.uops td.note')].map((td) => td.textContent).join(''), nolink: !document.querySelector('table.uops tr.unsupported a'), caveat: caveats(), mode: mode() === 'unrolled',
        listing: listing().trimEnd().split('\\n'), instrs: document.querySelectorAll('table.uops tbody tr:not(.extra)').length, legend: document.querySelector('.legend').innerText };
      out.columns = [document.querySelectorAll('table.uops thead th').length, !!$('hide-empty')];
      await example('error'); out.error = document.querySelector('.error-box')?.textContent;
      return out;`);
    check(r.robots === 'noindex' && /wuica/.test(r.title), 'mock: title and robots');
    check(/Mock mode/.test(r.notice), 'mock: the notice says so', r.notice);
    check(r.groups[0] === 'SNB,IVB,HSW,BDW,SKL,KBL,SKX,CFL,CLX,ICL,TGL,ZEN3,RKL,ICX,ADL-P' && r.groups[1] === 'ZEN3,ICX,ADL-P' && r.groups[2] === 'ZEN3 · AMD Zen 3 (2020) · prototype' && /prototype/.test(r.groups[3])
      && r.arch[0] === 'SKL' && r.arch[1] === 'SKL', 'mock: the CPU checkboxes (in order of release; prototypes marked; names in the accessible name); SKL checked', JSON.stringify([r.groups, r.arch]));
    check(r.start[0] && r.start[1] === '  add rax, 1', 'mock: assembly is the default input, with the first example', JSON.stringify(r.start));
    check(r.examples === ',chain,loadstore,avx,stack,saxpy,dot1,dot4,popcnt,ptrchase,strlen,crc32,memcpy,gemm,sha256,synthetic,error' && r.exGroups === 'basics,classic loops,showcase,mock', 'mock: the examples menu', JSON.stringify([r.examples, r.exGroups]));
    check(/^unofficial port of uiCA · data from uops\.info · repo at jtl06\/wuica v\d+\.\d+\.\d+(-\S+)? · LLVM 22\.1\.2 · Intel XED · build \S+ · \?$/.test(r.footer[0])
      && r.footer[1] === 'https://github.com/andreas-abel/uiCA https://www.uops.info/ https://github.com/jtl06/wuica' && r.footer[2] === 'Source on GitHub https://github.com/jtl06/wuica' && r.footer[3] === '', 'mock: the footer (credit, the repository, versions; no license or font text); GitHub at the right end of the top bar', JSON.stringify(r.footer));
    check(r.focusable && r.labelled.length === 0, 'mock: controls are focusable and labelled', JSON.stringify(r.labelled));
    check(r.empty[0] === '2.00' && r.empty[1] === '1', 'mock: a fresh visit analyzes the first example once', JSON.stringify(r.empty));
    check(/script-src 'self' 'wasm-unsafe-eval' https:\/\/static\.cloudflareinsights\.com;/.test(r.csp) && /connect-src 'self' https:\/\/cloudflareinsights\.com https:\/\/godbolt\.org;/.test(r.csp) && !/unsafe-inline/.test(r.csp), 'mock: the CSP allows the Cloudflare beacon and Compiler Explorer (link import), nothing else', r.csp);
    check(r.tp === '2.00' && /cycles\/iteration/.test(r.meta) && r.mode === 'loop' && /mock data/.test(r.meta) && /Dependencies/.test(r.meta), 'mock: Ctrl+Enter gives the result of the first example', r.meta.slice(0, 300));
    check(r.listing[0] === CHAIN && !r.listing[1], 'mock: the objdump listing (closed for hex input)', JSON.stringify(r.listing));
    check(r.copyVisible && r.copied[0] === CHAIN && r.copied[1] === 'copied' && r.copied[2] === 'Copy objdump', 'mock: the listing copies as text', JSON.stringify(r.copied));
    check(r.rows.length === 4 && r.rows[0] === 'add rax, 0x1|1|1|1|0.22|0.22|0.29|0.27' && r.rows[3] === 'jnz 0x0|M' && r.total === 'Total|3|3|3|0.5|0.52|0.52|1.47', 'mock: the uop table (empty columns hidden, zeros blank, totals)', JSON.stringify([r.rows, r.total]));
    check(r.link === 'https://www.uops.info/html-instr/ADD_R64_I8.html' && r.heat === '0.22,0.22,0.29' && !r.blank, 'mock: links and shading', `${r.link} ${r.heat}`);
    check(r.reportHidden && r.report === 'Throughput (in cycles per iteration): 2.00\n' && r.reportStaysOpen, 'mock: the text report toggles and stays open', JSON.stringify(r.report));
    check(/^#v=1&c=/.test(r.hash) && r.search === '?mock=1&nosw=1', 'mock: the state is in the fragment, not in the query string', r.hash);
    check(r.loadstore[0] === '1.00' && r.loadstore[1] === 'ZEN3' && r.avx[0] === '4.00' && r.avx[1] === 'ADL-P' && r.stack[0] === '2.10' && r.stack[3] === 1, 'mock: the other examples', JSON.stringify([r.loadstore, r.avx, r.stack]));
    check([r.loadstore, r.avx, r.stack, r.synthetic].every((x) => x[4] <= 0), 'mock: the page never scrolls sideways at 1280px', JSON.stringify([r.loadstore[4], r.avx[4], r.stack[4], r.synthetic[4]]));
    check(r.synthetic[0] === '23.57' && r.synthetic[3] === 2 && r.synthetic2.notes === 'XJM' && r.synthetic2.nolink && r.synthetic2.mode && /1 undecodable position skipped/.test(r.synthetic2.caveat), 'mock: synthetic case (extra rows, notes, unrolled, decode errors)', JSON.stringify([r.synthetic, r.synthetic2]));
    check(r.synthetic2.listing.length === r.synthetic2.instrs && r.synthetic2.listing.every((l) => /^ *[0-9a-f]+:  [0-9a-f]{2}( [0-9a-f]{2})* +\S/.test(l)) && !r.synthetic2.listing.some((l) => /Uop/.test(l)), 'mock: the listing has the instructions only (no inserted uops)', JSON.stringify(r.synthetic2.listing));
    check(/X no data/.test(r.synthetic2.legend) && /J JCC erratum/.test(r.synthetic2.legend) && /M macro-fused/.test(r.synthetic2.legend), 'mock: the legend lists the notes that occur', r.synthetic2.legend);
    check(!r.columns[1], 'mock: no "hide empty columns" control (empty columns stay hidden, as in uiCA)', JSON.stringify(r.columns));
    check(/Analysis failed: mock/.test(r.error ?? ''), 'mock: an analysis error is shown', r.error);

    // input errors, assembly mode with the mock assembler, options
    const s = await page.eval(`${HELPERS}
      const out = {};
      const run = async () => { $('run').click(); await wait(250); };
      set($('code'), '48 01 zz'); await run(); out.notHex = [$('input-messages').innerText, $('code').getAttribute('aria-invalid')];
      set($('code'), '4801d'); await run(); out.odd = $('input-messages').innerText;
      set($('code'), ''); await run(); out.none = $('input-messages').innerText;
      set($('code'), '   0:\\t48 01 d8             \\tadd    %rbx,%rax\\n   3:\\tc3                   \\tret\\n'); await done(() => $('run').click());
      out.objdump = [$('input-messages').innerText, document.querySelector('#result-body .meta').title.includes('4 bytes'), $('code').getAttribute('aria-invalid')];
      $('mode-asm').click(); await wait(300);
      out.asm = [$('code').value.split('\\n')[1], !$('syntax-wrap').hidden, $('run').disabled];
      set($('syntax'), 'att'); await wait(50); out.att = $('code').value.split('\\n')[1];
      await done(() => $('run').click()); out.assembled = [$('input-messages').innerText, listing(), listingOpen()];
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
    check(s.assembled[0] === (manifest.assembler ? '' : 'mock assembler') && s.assembled[1] === CHAIN && !s.assembled[2], 'mock: assembly is assembled; the listing shows it (collapsed by default)', JSON.stringify(s.assembled));
    check(s.stale && /line 2:3: .*\n.*line 4:5: /.test(s.diag) && s.selected === '    bogus', 'mock: assembler diagnostics with lines; a click selects the line', JSON.stringify([s.stale, s.diag, s.selected]));
    check(s.hexKept, 'mock: each input mode keeps its text');
    check(s.options[0] === '63' && s.options[1] === ' · 4 changed' && s.options[2] === '#v=1&al=63&mc=1234&ip=stack&nma=1', 'mock: options are clamped and go into the fragment', JSON.stringify(s.options));
    check(s.reset[0] === '0' && !s.reset[1] && s.reset[2] === '#v=1', 'mock: reset to defaults', JSON.stringify(s.reset));

    // restore from a link (full load), then from a changed fragment; copy link
    const link = '#v=1&m=asm&s=att&a=ZEN3&al=31&mi=7&mc=1234&ip=stack&sfe=1&nmi=1&nma=1&c=bG9vcDoKICBtb3ZxICVyYXgsICglcnNpKQogIG1vdmwgKCVyc2kpLCAlZWF4CiAgYWRkcSAkMSwgJXJheAogIGRlY3EgJXIxNQogIGpueiBsb29wCg';
    await page.goto('about:blank');
    await page.goto(`${origin}/?mock=1&nosw=1${link}`);
    await page.waitFor(`document.querySelector('.tp .value')`, 'the result of a shared link');
    const u = await page.eval(`${HELPERS}
      const out = {};
      out.restored = [$('mode-asm').checked, $('syntax').value, focused(), $('code').value.split('\\n')[1], $('opt-align').value, document.querySelector('input[name=init]:checked').value, $('opt-sfe').checked, $('opt-nmi').checked, $('opt-nma').checked, $('opt-iter').value, $('opt-cycles').value].join('|');
      out.tp = tp(); out.same = location.hash === ${JSON.stringify(link)};
      location.hash = 'v=1&a=SKL&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM';
      await until(() => tp() === '2.00');
      out.second = [$('mode-hex').checked, focused(), $('code').value, $('opt-align').value].join('|');
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

    // color theme: follows the system until the toggle sets it; the choice is remembered and applied before paint
    const theme = async () => page.eval(`${HELPERS} return [document.documentElement.getAttribute('data-theme'), getComputedStyle(document.documentElement).backgroundColor, $('theme-toggle').textContent, $('theme-toggle').getAttribute('aria-label'), (() => { try { return localStorage.getItem('wuica-theme'); } catch { return 'n/a'; } })()];`);
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await sleep(100);
    const t1 = await theme();
    await page.eval(`document.getElementById('theme-toggle').click(); return 1;`);
    const t2 = await theme();
    await page.reload(); await page.ready();
    const t3 = await theme();
    await page.eval(`document.getElementById('theme-toggle').click(); return 1;`);
    const t4 = await theme();
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(100);
    const t5 = await theme();
    await page.eval(`localStorage.removeItem('wuica-theme'); return 1;`);
    await page.reload(); await page.ready();
    const t6 = await theme();
    check(t1[0] === null && t1[1] === 'rgb(251, 246, 234)' && t1[2] === 'light' && t1[3] === 'Color theme: light', 'theme: follows a light system theme', JSON.stringify(t1));
    check(t2[0] === 'dark' && t2[1] === 'rgb(9, 10, 9)' && t2[2] === 'dark' && t2[4] === 'dark', 'theme: the toggle switches to dark and remembers it', JSON.stringify(t2));
    check(t3[0] === 'dark' && t3[1] === 'rgb(9, 10, 9)', 'theme: the choice survives a reload', JSON.stringify(t3));
    check(t4[0] === 'light' && t4[1] === 'rgb(251, 246, 234)' && t5[1] === 'rgb(251, 246, 234)' && t5[2] === 'light', 'theme: a stored choice overrides the system theme', JSON.stringify([t4, t5]));
    check(t6[0] === null && t6[1] === 'rgb(9, 10, 9)' && t6[2] === 'dark', 'theme: without a stored choice, a dark system gives dark', JSON.stringify(t6));
    await page.cmd('Emulation.setEmulatedMedia', { features: [] });
    const problems = page.take();
    check(problems.length === 0, 'mock: no console errors', problems.join('\n'));
    await page.cmd('Page.close');
  }

  // --- 1b. compare panels and live mode with the real analyzer (no service worker), desktop width ---------------------------
  {
    const page = await Page.open(browser);
    await page.goto(`${origin}/?nosw=1#v=1&cmpcpu=1&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM`);
    await page.waitFor(`document.getElementById('cmp-cpus').dataset.state === 'done'`, 'the table of all CPUs from a link', 60000);
    const c = await page.eval(`${HELPERS}
      const out = {};
      const runs = (id) => Number($(id).dataset.runs || 0);
      const settled = async (id, start) => { const n = runs(id); await start(); await until(() => runs(id) > n && $(id).dataset.state === 'done', 30000); };
      const rows = () => [...document.querySelectorAll('table.cmp-cpus tbody tr')].map((tr) => [tr.dataset.arch, tr.querySelector('.cmp-tp').textContent, tr.querySelector('.cmp-bn').textContent]);
      const bn = () => document.querySelector('#result-body .bn')?.textContent ?? 'unknown';
      out.cold = [$('cmp-cpus').dataset.ms, $('cmp-cpus-info').textContent];
      out.menu = rows(); out.tp = tp(); out.open = [!$('cmp-cpus').hidden, $('cmp-sweep').open];
      out.current = document.querySelector('table.cmp-cpus tr[aria-current=true]')?.dataset.arch;
      out.protos = [...document.querySelectorAll('table.cmp-cpus tbody tr')].filter((tr) => /prototype/.test(tr.textContent)).map((tr) => tr.dataset.arch).join();
      document.querySelector('table.cmp-cpus button[data-focus=sort-tp]').focus(); document.activeElement.click();
      out.byTp = rows().map((r) => r[1]); out.sortAria = document.querySelector('table.cmp-cpus th[aria-sort]')?.getAttribute('aria-sort');
      out.sortFocus = document.activeElement?.getAttribute('data-focus');
      document.querySelector('table.cmp-cpus button[data-focus=sort-menu]').click();
      // a row shows that CPU in the main view: the same numbers as a single analysis
      const before = runs('cmp-cpus');
      out.picked = [];
      for (const arch of ['ZEN3', 'HSW']) {
        const row = rows().find((r) => r[0] === arch);
        await done(() => document.querySelector('table.cmp-cpus tr[data-arch="' + arch + '"]').click());
        out.picked.push([arch, row[1], row[2], focused(), tp(), bn(), document.querySelector('table.cmp-cpus tr[aria-current=true]')?.dataset.arch]);
      }
      out.notRerun = runs('cmp-cpus') === before;
      // the sweep: 64 points; a click sets the offset
      await settled('cmp-sweep', () => document.querySelector('#cmp-sweep summary').click());
      out.sweep = { ms: $('cmp-sweep').dataset.ms, hits: document.querySelectorAll('.sweep-chart rect.hit').length, pts: document.querySelectorAll('.sweep-chart circle.pt').length,
        now: document.querySelector('.sweep-chart').getAttribute('aria-valuenow'), hash: location.hash.replace(/&c=.*/, '') };
      const t5 = document.querySelector('.sweep-chart rect.hit[data-offset="5"] title').textContent;
      const sweepRuns = runs('cmp-sweep');
      await done(() => document.querySelector('.sweep-chart rect.hit[data-offset="5"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
      out.click = [t5, $('opt-align').value, tp(), document.querySelector('.sweep-chart').getAttribute('aria-valuenow'), location.hash.includes('al=5')];
      document.querySelector('.sweep-chart').focus();
      await done(() => document.querySelector('.sweep-chart').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
      out.key = [$('opt-align').value, document.querySelector('.sweep-chart').getAttribute('aria-valuenow'), document.activeElement?.classList.contains('sweep-chart')];
      out.sweepNotRerun = runs('cmp-sweep') === sweepRuns;
      await done(() => set($('opt-align'), '0'));
      // live: typing analyzes without a click (once, for the latest text); the open panels follow
      const n0 = Number($('results').dataset.run), cr = runs('cmp-cpus'), sr = runs('cmp-sweep');
      for (const t of ['c5', 'c5 fc', 'c5 fc 58', 'c5 fc 58 c1 49', 'c5 fc 58 c1 49 ff cf 75 f7']) { set($('code'), t); await wait(10); }
      await until(() => Number($('results').dataset.run) > n0);
      await until(() => runs('cmp-cpus') > cr && runs('cmp-sweep') > sr && $('cmp-cpus').dataset.state === 'done' && $('cmp-sweep').dataset.state === 'done', 30000);
      await wait(400);
      out.live = [Number($('results').dataset.run) - n0, document.querySelector('#result-body .meta').title.includes('9 bytes'), tp(), $('result-body').classList.contains('stale'), $('live').checked,
        rows().find((r) => r[0] === 'HSW')[1] === tp(), runs('cmp-cpus') - cr, runs('cmp-sweep') - sr];
      // an assembler-free error while typing: the messages show, the result stays (stale), nothing flashes
      set($('code'), 'c5 fc 5'); await wait(400);
      out.typo = [$('input-messages').innerText, !!document.querySelector('.tp'), $('result-body').classList.contains('stale')];
      // assembly: live runs only when the text assembles; errors show next to the input, the result stays
      if (${!!manifest.assembler}) {
        $('mode-asm').click(); await until(() => !$('run').disabled); await wait(400);
        const a0 = Number($('results').dataset.run);
        set($('code'), 'x:\\n  add rax, 1\\n  dec r15\\n  jnz x\\n');
        await until(() => Number($('results').dataset.run) > a0, 10000); await wait(300);
        out.asm1 = [tp(), $('input-messages').innerText, listing()];
        const a1 = Number($('results').dataset.run);
        set($('code'), 'x:\\n  add rax, 1\\n  frob r15\\n  jnz x\\n'); await wait(700);
        out.asm2 = [Number($('results').dataset.run) === a1, $('input-messages').innerText, !!document.querySelector('.tp'), $('result-body').classList.contains('stale')];
        set($('code'), 'x:\\n  add rax, 1\\n  add rax, 1\\n  dec r15\\n  jnz x\\n');
        await until(() => Number($('results').dataset.run) > a1, 10000); await wait(300);
        out.asm3 = [$('input-messages').innerText, $('result-body').classList.contains('stale'), tp(), listing()];
        $('mode-hex').click(); await wait(400);
      }
      // live off: typing does not analyze; it is remembered
      $('live').click();
      const n1 = Number($('results').dataset.run);
      set($('code'), '48 01 d8'); await wait(600);
      out.off = [Number($('results').dataset.run) === n1, $('result-body').classList.contains('stale'), localStorage.getItem('wuica-live')];
      await done(() => $('run').click()); out.manual = document.querySelector('#result-body .meta').title.includes('3 bytes');
      return out;`);
    const menuOrder = 'SNB,IVB,HSW,BDW,SKL,KBL,SKX,CFL,CLX,ICL,TGL,ZEN3,RKL,ICX,ADL-P';
    check(c.menu.map((r) => r[0]).join() === menuOrder && c.menu.every((r) => /^\d+\.\d\d$/.test(r[1])) && c.open[0] && !c.open[1] && c.current === 'SKL', 'compare: an old link with the table of all CPUs checks them all: the table, in menu order, every one with a result', JSON.stringify(c.menu));
    check(c.menu.find((r) => r[0] === 'SKL')[1] === c.tp && c.menu.find((r) => r[0] === 'ADL-P')[1] === '1.00' && c.protos === 'ZEN3,ICX,ADL-P', 'compare: the row of the selected CPU is the main result; prototypes are marked', JSON.stringify([c.tp, c.protos]));
    check(c.byTp.every((v, i) => i === 0 || Number(v) >= Number(c.byTp[i - 1])) && c.sortAria === 'ascending' && c.sortFocus === 'sort-tp', 'compare: sortable by throughput (focus stays on the button)', JSON.stringify([c.byTp, c.sortAria, c.sortFocus]));
    check(c.picked.length === 2 && c.picked.every((p) => p[0] === p[3] && p[1] === p[4] && p[2] === p[5] && p[6] === p[0]) && c.notRerun, 'compare: a row selects that CPU; its single analysis gives the same throughput and bottleneck', JSON.stringify(c.picked));
    check(c.sweep.hits === 64 && c.sweep.pts === 64 && c.sweep.now === '0' && /as=all&cmpsweep=1/.test(c.sweep.hash) && !/cmpcpu/.test(c.sweep.hash), 'sweep: 64 points; the checked CPUs and the open sweep are in the fragment', JSON.stringify(c.sweep));
    check(c.click[1] === '5' && c.click[3] === '5' && c.click[4] && c.click[0] === `offset 5: ${c.click[2]} cycles/iteration`, 'sweep: a click sets the alignment offset; the main result equals the point', JSON.stringify(c.click));
    check(c.key[0] === '6' && c.key[1] === '6' && c.key[2] && c.sweepNotRerun, 'sweep: arrow keys move the offset; focus stays; the sweep is not recomputed', JSON.stringify([c.key, c.sweepNotRerun]));
    check(c.live[0] === 1 && c.live[1] && !c.live[3] && c.live[4] && c.live[5] && c.live[6] >= 1 && c.live[7] >= 1, 'live: typing analyzes once, for the latest text; the panels follow', JSON.stringify(c.live));
    check(/Odd number of hex digits/.test(c.typo[0]) && c.typo[1] && c.typo[2], 'live: an input error is shown; the last result stays, dimmed', JSON.stringify(c.typo));
    if (manifest.assembler) {
      check(/^\d\.\d\d$/.test(c.asm1[0] ?? '') && c.asm1[1] === '' && /add rax, 0x1\n.*dec r15\n.*jnz /s.test(c.asm1[2] ?? ''), 'live: assembly is analyzed while typing', JSON.stringify(c.asm1));
      check(c.asm2[0] && /line 3:3: /.test(c.asm2[1]) && c.asm2[2] && c.asm2[3], 'live: text that does not assemble is not analyzed; the error shows; the result stays', JSON.stringify(c.asm2));
      check(c.asm3[0] === '' && !c.asm3[1] && c.asm3[2] === '2.00' && c.asm3[3] === CHAIN, 'live: fixed, it is analyzed and the error goes away', JSON.stringify(c.asm3));
    }
    check(c.off[0] && c.off[1] && c.off[2] === 'off' && c.manual, 'live: switched off, typing does not analyze (Analyze does); remembered', JSON.stringify([c.off, c.manual]));
    await page.reload();
    await page.waitFor(`document.getElementById('cmp-sweep').dataset.state === 'done'`, 'the panels after a reload', 60000);
    const t = await page.eval(`${HELPERS}
      const out = { live: $('live').checked, open: [!$('cmp-cpus').hidden, $('cmp-sweep').open] };
      $('live').click(); out.stored = localStorage.getItem('wuica-live');
      // timings with the tables loaded: the CPU table and the sweep for each built-in example
      const runs = (id) => Number($(id).dataset.runs || 0);
      // one panel at a time (they share the analyzer's worker), on SKL
      out.times = {};
      const settle = async (id, start) => { const n = runs(id); await start(); await until(() => runs(id) > n && $(id).dataset.state === 'done', 30000); return Number($(id).dataset.ms); };
      document.querySelector('#cmp-sweep summary').click(); await wait(50);
      if (focused() !== 'SKL') await done(() => document.querySelector('table.cmp-cpus tr[data-arch="SKL"]').click());
      for (const id of ['chain', 'loadstore', 'avx', 'stack']) out.times[id] = [await settle('cmp-cpus', () => example(id))];
      $('cpu-clear').click(); // SKL only: no table
      out.times.stack.push(await settle('cmp-sweep', () => document.querySelector('#cmp-sweep summary').click()));
      for (const id of ['chain', 'loadstore', 'avx']) out.times[id].push(await settle('cmp-sweep', () => example(id)));
      document.querySelector('#cmp-sweep summary').click(); await wait(100);
      out.closed = location.hash.includes('cmp') || location.hash.includes('as=');
      return out;`);
    check(!t.live && t.open[0] && t.open[1] && t.stored === 'on', 'live: off after a reload; switched on again', JSON.stringify(t));
    check(Object.values(t.times).every((x) => x[0] > 0 && x[1] > 0) && !t.closed, 'compare: timings for the examples; a closed sweep and one CPU leave the fragment', JSON.stringify(t));
    console.log('compare timings on SKL, one panel at a time, tables loaded (ms: all CPUs, sweep):', JSON.stringify(t.times), '; first table with table loading:', c.cold[0]);
    // phone width, both panels open: no sideways scrolling
    await page.cmd('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
    await page.goto('about:blank');
    await page.goto(`${origin}/?nosw=1#v=1&cmpcpu=1&cmpsweep=1&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM`);
    await page.waitFor(`document.getElementById('cmp-sweep').dataset.state === 'done' && document.getElementById('cmp-cpus').dataset.state === 'done'`, 'the panels at phone width', 60000);
    const m = await page.eval(`${HELPERS} return [overflow(), document.querySelector('.sweep-chart').getBoundingClientRect().right <= innerWidth];`);
    check(m[0] <= 0 && m[1], 'compare: at 375px the page does not scroll sideways with both panels open', JSON.stringify(m));
    const problems = page.take();
    check(problems.length === 0, 'compare: no console errors', problems.join('\n'));
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
      out.start = [$('mode-asm').checked, $('code').value.split('\\n')[1]];
      await run(); // the default example, in assembly
      out.asmFirst = tp();
      $('mode-hex').click(); await wait(400); // the rest in hex
      await run();
      out.first = { tp: tp(), mock: !!document.querySelector('.mock-tag'), text: $('result-body').innerText, metaTitle: document.querySelector('#result-body .meta').title,
        rows: [...document.querySelectorAll('table.uops tbody tr')].map((tr) => tr.innerText.trim().replace(/\\t+/g, '|')),
        total: document.querySelector('table.uops tfoot tr').innerText.trim().replace(/\\t+/g, '|'),
        report: document.querySelector('pre.report').textContent };
      out.overflow1 = overflow();
      const w = document.querySelector('.table-wrap'); out.tableScrolls = [w.clientWidth <= innerWidth, getComputedStyle(w).overflowX];
      out.fontSize = [getComputedStyle($('code')).fontSize, getComputedStyle(document.body).fontSize, getComputedStyle(document.body).fontFamily.split(',')[0]];
      // the examples on the microarchitectures the reference's results were recorded for
      for (const [id, arch] of [['loadstore', 'ZEN3'], ['avx', 'ADL-P'], ['stack', 'SKL']]) {
        if (focused() !== arch) await done(() => cpus(arch));
        await example(id);
        if (arch === 'ADL-P') out.prototype = [document.querySelector('#cpu-grid label.focus').classList.contains('proto'), caveats()];
        out[id] = [tp(), $('result-body').innerText.includes(arch), document.querySelector('table.uops thead').innerText.trim().replace(/\\s*\\t+/g, '|'), document.querySelectorAll('table.uops tr.extra').length, notes(), overflow(), document.querySelector('pre.report').textContent];
      }
      out.notPrototype = [document.querySelector('#cpu-grid label.focus').classList.contains('proto'), caveats()]; // SKL
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
      // a long analysis does not block the page and can be cancelled (many iterations: the analyzer keeps getting faster)
      await done(() => set($('opt-iter'), '1000'));
      set($('code'), '4801d8'.repeat(20000));
      $('run').click(); await wait(300);
      let ticks = 0; const t = setInterval(() => ticks++, 20); await wait(700); clearInterval(t);
      out.long = [$('run').textContent, $('results').getAttribute('aria-busy'), ticks];
      $('run').click(); await wait(100);
      out.cancelled = [$('run').textContent, $('results').hasAttribute('aria-busy'), $('status').textContent, tp()];
      $('opt-reset').click(); await example('chain'); out.afterCancel = [tp(), $('run').textContent];
      $('mode-asm').click(); await wait(600);
      out.asm = [$('input-messages').innerText, $('run').disabled];
      if (${!!manifest.assembler}) {
        // the real assembler: both syntaxes, diagnostics, a block that assembles to nothing
        set($('syntax'), 'intel'); await example('chain'); out.asmChain = [tp(), $('input-messages').innerText, listing(), listingOpen()];
        set($('syntax'), 'att'); await done(() => $('run').click()); out.asmAtt = [tp(), $('code').value.split('\\n')[1], listing()];
        set($('syntax'), 'intel');
        set($('code'), 'loop:\\n  vaddps ymm0, ymm1, ymm2\\n  frobnicate rax\\n  jmp loop\\n'); $('run').click(); await wait(1500);
        out.asmErr = [$('input-messages').innerText, $('code').getAttribute('aria-invalid')];
        set($('code'), 'x:\\n  vaddps ymm0, ymm0, ymm1\\n  dec r15\\n  jnz x\\n'); await done(() => $('run').click()); out.asmAvx = [tp(), $('input-messages').innerText, listing()];
        set($('code'), '.data\\n  .byte 1\\n'); $('run').click(); await wait(1500); out.asmEmpty = $('input-messages').innerText;
        $('mode-hex').click(); await wait(50);
      } else {
        $('input-messages').querySelector('button')?.click(); await wait(100);
      }
      out.back = [$('mode-hex').checked, $('run').disabled];
      return out;`);
    check(r.failed === '' && r.notice === '' && r.build === manifest.version, 'real: the page starts with the real analyzer and shows the build', JSON.stringify([r.failed, r.notice, r.build]));
    check(requests.some((x) => x.includes('wuica_wasm.wasm')) && requests.some((x) => x.includes('data/arch/SKL.bin')) && requests.some((x) => x.includes('js/engine-worker.js')), 'real: the analyzer, its worker and the selected table are fetched');
    check(r.examples === ',chain,loadstore,avx,stack,saxpy,dot1,dot4,popcnt,ptrchase,strlen,crc32,memcpy,gemm,sha256', 'real: no mock-only examples', r.examples);
    check(r.start[0] && r.start[1] === '  add rax, 1' && r.asmFirst === '2.00', 'real: assembly is the default; the first example assembled gives 2.00', JSON.stringify([r.start, r.asmFirst]));
    check(r.first.tp === '2.00' && !r.first.mock && /^loop · SKL/m.test(r.first.text) && /bottleneck\s+Dependencies/.test(r.first.text) && !/ ms\n|\d bytes|\d instructions/.test(r.first.text)
      && /^4 instructions · 13 bytes · \d+(\.\d)? ms$/.test(r.first.metaTitle), 'real: the first example: 2.00 cycles, a loop, bottleneck Dependencies; counts and time only in the tooltip', JSON.stringify([r.first.text.slice(0, 300), r.first.metaTitle]));
    check(r.first.rows.length === 4 && r.first.rows[0] === 'add rax, 0x1|1|1|1|0.22|0.22|0.29|0.27' && r.first.rows[3] === 'jnz 0x0|M' && r.first.total === 'Total|3|3|3|0.5|0.52|0.52|1.47', 'real: the uop table equals the reference (rounded like uiCA, totals as in its "Total" line)', JSON.stringify([r.first.rows, r.first.total]));
    check(r.first.report.startsWith('Throughput (in cycles per iteration): 2.00\nBottleneck: Dependencies\n') && r.first.report.includes('│ Total'), 'real: the text report');
    check(r.loadstore[0] === '1.00' && r.loadstore[1] && /\s*ALU\s*0\|1\|2\|3\|\s*AGU\s*0\|1\|2\|\s*SD\s*0$/.test(r.loadstore[2]) && r.loadstore[4] === '----M', 'real: load/store example on ZEN3 (1.00, Zen port names)', JSON.stringify(r.loadstore.slice(0, 6)));
    check(r.avx[0] === '4.00' && r.avx[1] && /\s*P\s*0\|1\|5\|6\|B$/.test(r.avx[2]), 'real: AVX example on ADL-P (4.00, ports up to B)', JSON.stringify(r.avx.slice(0, 6)));
    check(r.prototype[0] === true && /^ADL-P .*prototype$/.test(r.prototype[1]) && r.notPrototype[0] === false && r.notPrototype[1] === '', 'real: a prototype model (ADL-P) is marked at its checkbox and in the result; SKL is not', JSON.stringify([r.prototype, r.notPrototype]));
    check(r.stack[0] === '2.10' && r.stack[3] === 1 && /unknown/.test(r.stack[6].split('\n')[1]), 'real: stack example on SKL (2.10, a stack-sync row, bottleneck unknown)', JSON.stringify(r.stack.slice(0, 6)));
    check([r.loadstore, r.avx, r.stack].every((x) => x[5] <= 0) && r.overflow0 <= 0 && r.overflow1 <= 0 && r.tableScrolls[0] && r.tableScrolls[1] === 'auto', 'real: at 375px the page never scrolls sideways; the table scrolls in its container', JSON.stringify([r.overflow0, r.overflow1, r.tableScrolls]));
    check(r.fontSize[0] === '16px' && r.fontSize[1] === '14px' && (/IBM Plex Mono/.test(r.fontSize[2]) || !!process.env.WUICA_TEST_FONT), 'real: font sizes', JSON.stringify(r.fontSize));
    check(r.before === '---M' && r.noMacroFusion[0] === '----' && r.noMacroFusion[2], 'real: "no macro-fusion" reruns the analysis and removes the M note', JSON.stringify([r.before, r.noMacroFusion]));
    check(r.aligned[0] === '2.00' && r.aligned[1] && /Issue 0.75 Dependencies 2.00|Issue/.test(r.simpleFrontEnd[0]) && !/DSB|LSD|Decoder/.test(r.simpleFrontEnd[0]), 'real: alignment offset and simple front end reach the analyzer', JSON.stringify([r.aligned, r.simpleFrontEnd]));
    check(r.reset[0] === '2.00' && r.reset[1] === '---M', 'real: reset restores the default result', JSON.stringify(r.reset));
    check(/Analysis failed: no instructions found/.test(r.noInstr ?? ''), 'real: an error response is shown (no instructions)', r.noInstr);
    check(/1 undecodable position skipped/.test(r.partial[1]) && r.partial[2].includes('X'), 'real: decode errors and unsupported instructions are marked', JSON.stringify(r.partial));
    check(/crashed on this input/.test(r.crash) && r.afterCrash === '2.00', 'real: a crash of the analyzer is reported and the analyzer is restarted', JSON.stringify([r.crash, r.afterCrash]));
    check(r.long[0] === 'Cancel' && r.long[1] === 'true' && r.long[2] >= 20, 'real: a long analysis runs in the worker: the page stays responsive', JSON.stringify(r.long));
    check(r.cancelled[0] === 'Analyze' && !r.cancelled[1] && r.cancelled[2] === 'cancelled' && r.afterCancel[0] === '2.00', 'real: Cancel stops it; the next analysis works', JSON.stringify([r.cancelled, r.afterCancel]));
    if (!manifest.assembler) {
      check(/No assembler in this build/.test(r.asm[0]) && r.asm[1] && r.back[0] && !r.back[1], 'real: without the assembler, assembly mode says so and offers hex mode', JSON.stringify([r.asm, r.back]));
      check(!requests.some((x) => x.includes('wuica_asm')), 'real: the missing assembler is not requested');
    } else {
      check(!/not available/.test(r.asm[0]) && !r.asm[1] && requests.some((x) => x.includes('wuica_asm.wasm')), 'real: the assembler is loaded when assembly mode is chosen', JSON.stringify([r.asm, requests.filter((x) => x.includes('asm'))]));
      check(r.asmChain[0] === '2.00' && r.asmChain[1] === '' && r.asmChain[2] === CHAIN && !r.asmChain[3], 'real: the chain example assembled (Intel) gives the hex result; the (collapsed) listing shows the bytes', JSON.stringify(r.asmChain));
      check(r.asmAtt[0] === '2.00' && r.asmAtt[1] === '  addq $1, %rax' && r.asmAtt[2] === CHAIN, 'real: AT&T syntax', JSON.stringify(r.asmAtt));
      check(/^line 3:3: .*frobnicate|^line 3:3: invalid instruction/m.test(r.asmErr[0]) && r.asmErr[1] === 'true', 'real: assembler diagnostics with line and column', JSON.stringify(r.asmErr));
      check(/^\d\.\d\d$/.test(r.asmAvx[0] ?? '') && r.asmAvx[1] === '' && /^ {3}0:  c5 fc 58 c1    vaddps ymm0, ymm0, ymm1\n {3}4:  49 ff cf       dec r15\n {3}7:  75 f7          jnz /.test(r.asmAvx[2]), 'real: an AVX block typed in assembly is analyzed', JSON.stringify(r.asmAvx));
      check(/no machine code/i.test(r.asmEmpty), 'real: assembly without code in .text is reported', r.asmEmpty);
      check(r.back[0] && !r.back[1], 'real: back to hex mode');
    }

    // service worker: everything gets cached, then the page works without the server
    const sw = await page.eval(`${HELPERS}
      await until(() => /works offline/.test($('status').textContent), 60000);
      const keys = await caches.keys();
      const c = await caches.open(keys[0]);
      return { keys, controlled: !!navigator.serviceWorker.controller, cached: (await c.keys()).map((r) => new URL(r.url).pathname.slice(1)).sort() };`);
    // everything, the assembler included (the page prefetches it when idle; the checks above also used it), except
    // what is fetched only on use: llvm-mca (the mca view) and the showcase's assembly (picking SHA-256)
    const expected = Object.keys(manifest.files).filter((f) => !/^(wuica_mca\.wasm|js\/showcase-asm\.js)$/.test(f)).concat('manifest.json').sort();
    check(sw.controlled && sw.keys.length === 1 && sw.keys[0] === `wuica-${manifest.version}`, 'sw: controls the page; the cache is named after the build', JSON.stringify(sw.keys));
    check(JSON.stringify(sw.cached) === JSON.stringify(expected), 'sw: the page, the analyzer and all tables are cached', `missing: ${expected.filter((f) => !sw.cached.includes(f))}; extra: ${sw.cached.filter((f) => !expected.includes(f))}`);
    check(page.take().length === 0, 'real: no console errors (online)', page.problems.join('\n'));

    await stop(); // offline
    requests.length = 0;
    await page.goto('about:blank');
    await page.goto(`${origin}/?x=1#v=1&a=ADL-P&c=YzQgZTIgZDUgYWEgZjQgNGMgMDMgZDEgNGQgMGYgYWYgYzAgNDkgZmYgY2YgNzUgZWY`);
    await page.waitFor(`document.querySelector('.tp .value')`, 'a result while offline');
    const off = await page.eval(`${HELPERS}
      const out = { tp: tp(), arch: focused(), build: $('build-id').textContent, real: !document.querySelector('.mock-tag') && $('notice').hidden };
      await done(() => cpus('ICX'));
      out.switched = $('result-body').innerText.includes('Ice Lake server');
      await wait(300); out.status = $('status').textContent; out.font = document.fonts.check('15px "IBM Plex Mono"');
      if (${!!manifest.assembler}) {
        $('mode-asm').click(); await wait(300); set($('syntax'), 'intel');
        await example('chain'); out.asm = [tp(), listing()];
      }
      return out;`);
    check(off.tp === '4.00' && off.arch === 'ADL-P' && off.build === manifest.version && off.real, 'offline: a shared link loads and is analyzed with the server stopped (also with a query string)', JSON.stringify(off));
    check(off.switched && (off.font || !!process.env.WUICA_TEST_FONT), 'offline: another microarchitecture (its table) and the font come from the cache', JSON.stringify(off));
    if (manifest.assembler) check(off.asm?.[0] === '2.00' && off.asm?.[1] === CHAIN, 'offline: assembly mode works (the assembler comes from the cache)', JSON.stringify(off.asm));
    const offProblems = page.take();
    check(offProblems.length === 0, 'offline: no console errors', offProblems.join('\n'));
    if (manifest.assembler) {
      // an assembler that cannot be fetched (offline, not cached) is a temporary failure, not "not in this build"
      await page.eval(`const keys = await caches.keys(); await (await caches.open(keys[0])).delete('wuica_asm.wasm'); return 1;`);
      await page.goto('about:blank');
      await page.goto(`${origin}/#v=1&m=asm&c=bG9vcDoKICBhZGQgcmF4LCAxCiAgZGVjIHIxNQogIGpueiBsb29wCg`);
      await page.waitFor(`document.getElementById('input-messages').innerText.includes('could not be loaded')`, 'the assembler load failure');
      const fail = await page.eval(`${HELPERS} return [$('input-messages').innerText, $('run').disabled];`);
      check(/could not be loaded/.test(fail[0]) && !/No assembler in this build/.test(fail[0]) && fail[1] === false, 'offline: a missing assembler download is reported as such and can be retried', JSON.stringify(fail));
      page.take(); // the failed fetch of wuica_asm.wasm is logged by the browser
    }

    // a new deploy: the worker of the new build takes over, the old cache goes away, the page offers a reload
    root = siteB;
    await listen();
    await page.goto('about:blank');
    await page.goto(`${origin}/`);
    await page.ready();
    const first = await page.eval(`${HELPERS} return $('build-id').textContent;`);
    // The page shows the note, then reloads itself once it is idle (app.js updated(): at most once per build, marked in
    // session storage before the reload). Wait for that state, not for the note: under load it can be gone again
    // before a look at it (the new worker first caches the whole new build).
    await page.waitFor(`!document.getElementById('update-note').hidden || sessionStorage.getItem('wuica-update-reload') === ${JSON.stringify(versionB)}`, 'the update note (or the reload after it)', 120000);
    await page.waitFor(`(await caches.keys()).join() === ${JSON.stringify(`wuica-${versionB}`)}`, 'the new build\'s cache, alone', 60000);
    const upd = await page.eval(`${HELPERS} return { keys: await caches.keys(), note: $('update-note').hidden ? null : $('update-note').innerText, build: $('build-id').textContent, mark: sessionStorage.getItem('wuica-update-reload') };`);
    check(first === manifest.version, 'deploy: the open page is still the cached build', first);
    check(JSON.stringify(upd.keys) === JSON.stringify([`wuica-${versionB}`]) && (/new version/.test(upd.note ?? '') || upd.mark === versionB),
      'deploy: the new worker replaces the cache and the page says so (or, idle, reloads itself)', JSON.stringify(upd));
    // The page marked its own reload (session storage): then it must come back as the new build by itself (no reload by
    // hand that would hide a page that did nothing). Otherwise the note is shown: a reload by hand gives the new build.
    if (upd.mark === versionB) {
      check(await page.waitFor(`document.readyState === 'complete' && document.getElementById('build-id')?.textContent === ${JSON.stringify(versionB)}`, 'the page\'s own reload into the new build', 60000),
        'deploy: the page reloaded itself into the new build');
    } else {
      await page.reload();
    }
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
  const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
  proc.kill();
  await stop().catch(() => {});
  await Promise.race([exited, sleep(5000)]); // Chrome may still write to its profile in tmp (ENOTEMPTY under load)
  if (!args.includes('--keep')) try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be writing its profile */ }
}

console.log(`${count} browser checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
