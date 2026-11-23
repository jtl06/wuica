// End-to-end test of A–B mode and of the Compiler Explorer import, in headless Chrome over the DevTools protocol,
// with the real analyzer. No network: requests to godbolt.org are intercepted and answered with the responses
// recorded in tests-js/fixtures/godbolt/. Run web/build.sh first. Node 22+.
//
//    node tests-js/web_browser_ab.mjs [--chrome PATH]
//
// Skips (exit 0) if Chrome is not found.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'web', 'dist');
const fixtures = path.join(here, 'fixtures', 'godbolt');
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
const fx = (name) => fs.readFileSync(path.join(fixtures, name), 'utf8');
const links = JSON.parse(fx('links.json'));

// ---- the site ----------------------------------------------------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
  if (!p.startsWith(dist)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(p).pipe(res);
});
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

// Compiler Explorer, as recorded. Every request is logged; a path can be made to fail.
const ce = { requests: [], fail: new Map() };
function ceAnswer(url, method, postData) {
  const u = new URL(url);
  ce.requests.push(`${method} ${u.pathname}${u.search}`);
  if (method === 'OPTIONS') return { status: 204, body: '' };
  for (const [re, status] of ce.fail) if (re.test(u.pathname)) return { status, body: '{}', headers: status === 429 ? [{ name: 'retry-after', value: '42' }, { name: 'access-control-expose-headers', value: 'Retry-After' }] : [] };
  let m;
  if ((m = /^\/api\/shortlinkinfo\/(\w+)$/.exec(u.pathname)) && fs.existsSync(path.join(fixtures, `shortlinkinfo-${m[1]}.json`))) return { status: 200, body: fx(`shortlinkinfo-${m[1]}.json`) };
  if (/^\/api\/compilers\/c%2B%2B$/.test(u.pathname)) return { status: 200, body: fx('compilers-c++.json') };
  if ((m = /^\/api\/compiler\/(\w+)\/compile$/.exec(u.pathname)) && method === 'POST') {
    const body = JSON.parse(postData ?? '{}');
    if (m[1] === 'g82') return { status: 200, body: fx('compile-g82-countSetBits.json') };
    if (m[1] === 'g132') return { status: 200, body: fx('compile-g132-short.json') };
    if (m[1] === 'g142' && body.source?.includes('int f( {')) return { status: 200, body: fx('compile-g142-error.json') };
  }
  return { status: 404, body: '{}' };
}

class Page {
  problems = [];
  static async open(browser, { width = 1280, height = 900, mobile = false } = {}) {
    const p = new Page();
    p.browser = browser;
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    p.sessionId = (await browser.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    browser.on((m) => {
      if (m.sessionId !== p.sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') p.problems.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(m.params.type)) p.problems.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
      if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level) && !/godbolt\.org/.test(m.params.entry.url ?? '')) p.problems.push(`log ${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
      if (m.method === 'Fetch.requestPaused') {
        const { requestId, request } = m.params;
        const a = ceAnswer(request.url, request.method, request.postData);
        p.cmd('Fetch.fulfillRequest', { requestId, responseCode: a.status,
          responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }, { name: 'access-control-allow-origin', value: '*' },
            { name: 'access-control-allow-methods', value: 'POST, GET, OPTIONS' }, { name: 'access-control-allow-headers', value: 'Content-Type, Accept' }, ...(a.headers ?? [])],
          body: Buffer.from(a.body).toString('base64') }).catch(() => {});
      }
    });
    for (const d of ['Runtime', 'Log', 'Page']) await p.cmd(`${d}.enable`);
    await p.cmd('Fetch.enable', { patterns: [{ urlPattern: 'https://godbolt.org/*' }] });
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
  const done = async (start) => { const n = $('results').dataset.run; start(); await until(() => $('results').dataset.run !== n); };
  const vals = () => [...document.querySelectorAll('.ab-tp .value')].map((e) => e.textContent);
  const verdict = () => document.querySelector('.ab-delta')?.dataset.verdict;
  const overflow = () => document.documentElement.scrollWidth - innerWidth;
  const unlabelled = () => [...document.querySelectorAll('input, select, textarea')].filter((e) => !(e.labels?.length || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby'))).map((e) => e.id || e.name);
  const paste = (el, text) => { const dt = new DataTransfer(); dt.setData('text/plain', text); el.focus(); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); };
`;
const CHAIN = '48 83 c0 01 48 83 c0 01 49 ff cf 75 f3';
const BETTER = '48 83 c0 02 49 ff cf 75 f7';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-ab-test-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = '';
  proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
  proc.on('exit', () => reject(new Error('Chrome exited: ' + err.slice(0, 500))));
  setTimeout(() => reject(new Error('Chrome did not start')), 20000);
});
const browser = await Browser.connect(wsUrl);

try {
  // --- 1. A–B mode, desktop ------------------------------------------------------------------------------------------------
  {
    const page = await Page.open(browser);
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const r = await page.eval(`${HELPERS}
      const out = {};
      out.start = [$('cmp-single').checked, getComputedStyle($('code-b').closest('.ab-b')).display, location.hash];
      set($('code'), ${JSON.stringify(CHAIN)});
      await done(() => $('cmp-ab').click());
      out.entered = [vals(), verdict(), $('code-b').value, $('code-b').offsetWidth > 0, location.hash];
      set($('code-b'), ${JSON.stringify(BETTER)});
      out.stale = $('result-body').classList.contains('stale');
      await done(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
      out.result = { vals: vals(), verdict: verdict(), sr: document.querySelector('.ab-sr').textContent, delta: document.querySelector('.ab-delta').textContent,
        labels: [...document.querySelectorAll('#result-body > .row > .label')].map((e) => e.textContent).join(','),
        bn: document.querySelector('.ab-bn')?.innerText ?? document.querySelector('#result-body .bn')?.textContent,
        limits: [...document.querySelectorAll('.ab-limits tbody tr')].map((tr) => tr.innerText.replace(/\\s+/g, ' ').trim()),
        diff: [...document.querySelectorAll('.ab-diff tbody tr')].map((tr) => tr.className + ':' + tr.innerText.replace(/\\s+/g, ' ').trim()),
        diffHead: document.querySelector('.ab-diff thead').innerText.replace(/\\s+/g, ' ').trim(),
        tables: document.querySelectorAll('.ab-pair table.uops').length, overflow: overflow(), status: $('status').textContent };
      out.hash = location.hash;
      // swap
      await done(() => $('ab-swap').click());
      out.swapped = [vals(), verdict(), $('code').value, $('code-b').value];
      // another cpu for B
      await done(() => set($('b-arch'), 'ZEN3'));
      out.zen = [document.querySelectorAll('.ab-tp .value').length, [...document.querySelectorAll('#result-body .meta')].map((e) => e.textContent).join(' / '), document.querySelector('.ab-diff')?.closest('.row').innerText.includes('different execution ports'), location.hash.includes('ba=ZEN3')];
      // swap with another cpu: the cpus change sides too
      await done(() => $('ab-swap').click());
      out.swapArch = [$('arch').value, $('b-arch').value];
      await done(() => set($('b-arch'), ''));
      // copy A to B
      await done(() => $('ab-copy').click());
      out.copied = [$('code-b').value === $('code').value, verdict()];
      // unrolled B: twice A, the same work per iteration of A
      set($('code-b'), '48 83 c0 01 48 83 c0 01 48 83 c0 01 48 83 c0 01 49 ff cf 75 eb');
      await done(() => $('run').click());
      const v1 = [vals(), verdict()];
      await done(() => set($('b-scale'), '2'));
      out.scaled = [v1, vals(), verdict(), document.querySelector('#result-body').innerText.includes('per iteration of A'), location.hash.includes('bk=2')];
      set($('b-scale'), '1');
      // B in assembly
      $('b-mode-asm').click(); await wait(300);
      set($('code-b'), 'x:\\n  add rax, 2\\n  dec r15\\n  jnz x\\n');
      await done(() => $('run').click());
      out.asm = [$('b-messages').innerText, vals(), verdict(), !$('b-syntax').closest('label').hidden];
      set($('code-b'), 'x:\\n  frobnicate rax\\n'); await done(() => $('run').click()).catch(() => {}); await wait(500);
      out.asmErr = [$('b-messages').innerText, $('code-b').getAttribute('aria-invalid'), vals(), document.querySelector('#result-body .meta')?.textContent];
      out.unlabelled = unlabelled();
      out.focusable = ['cmp-single', 'cmp-ab', 'ab-swap', 'ab-copy', 'code-b', 'b-arch', 'b-scale', 'b-mode-asm', 'b-import', 'ce-open'].every((id) => $(id) && $(id).tabIndex >= 0);
      return out;`);
    check(r.start[0] && r.start[1] === 'none' && r.start[2] === '', 'ab: the page starts in single mode, B hidden', JSON.stringify(r.start));
    check(r.entered[0].join() === '2.00,2.00' && r.entered[1] === 'same' && r.entered[2] === r.entered[2] && r.entered[3] && /ab=1/.test(r.entered[4]), 'ab: switching to A–B copies A to B and compares at once', JSON.stringify(r.entered));
    check(r.stale, 'ab: an edit of B marks the result stale');
    check(r.result.vals.join() === '2.00,1.00' && r.result.verdict === 'better' && r.result.sr === 'A: 2.00 cycles, B: 1.00 cycles, Δ = −1.00 (−50%)' && /B better Δ = −1\.00 cycles \(−50%\) · B is 2\.00× faster/.test(r.result.delta), 'ab: the headline (Ctrl+Enter runs both)', JSON.stringify(r.result));
    check(r.result.labels === 'throughput,bottleneck,limits,diff,uops,report' && r.result.tables === 2, 'ab: all parts of the comparison', r.result.labels);
    check(/Dependencies/.test(r.result.bn) && r.result.limits.some((l) => /^Dependencies 2\.00 1\.00 −1\.00$/.test(l)) && r.result.limits.some((l) => /^Issue 0\.75 0\.50 −0\.25$/.test(l)), 'ab: bottlenecks and limits side by side', JSON.stringify([r.result.bn, r.result.limits]));
    check(r.result.diffHead === 'A B Δ uops Port 0 Port 1 Port 5 Port 6' && r.result.diff.length === 4 && /^ab-modified:~ add rax, 0x1 add rax, 0x2/.test(r.result.diff[0]) && /^ab-removed:− add rax, 0x1 −1 −0\.28/.test(r.result.diff[1]) && /^ab-same:dec r15 dec r15$/.test(r.result.diff[2]) && /^ab-same:jnz 0x\w+ M jnz 0x\w+ M$/.test(r.result.diff[3]), 'ab: the instruction diff (modified, removed, same; branch targets ignored)', JSON.stringify(r.result.diff));
    check(r.result.overflow <= 0 && /Δ −1\.00/.test(r.result.status), 'ab: no sideways scrolling at 1280px; the status line', JSON.stringify([r.result.overflow, r.result.status]));
    check(r.hash === '#v=1&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM&ab=1&bc=NDggODMgYzAgMDIgNDkgZmYgY2YgNzUgZjc', 'ab: both inputs are in the fragment', r.hash);
    check(r.swapped[0].join() === '1.00,2.00' && r.swapped[1] === 'worse' && r.swapped[2] === BETTER && r.swapped[3] === CHAIN, 'ab: swap', JSON.stringify(r.swapped));
    check(r.zen[0] === 2 && /B .*ZEN3/.test(r.zen[1]) && r.zen[2] && r.zen[3], 'ab: another cpu for B (Zen 3): no per-port comparison', JSON.stringify(r.zen));
    check(r.swapArch.join() === 'ZEN3,SKL', 'ab: swap also exchanges the cpus', JSON.stringify(r.swapArch));
    check(r.copied[0] && r.copied[1] === 'same', 'ab: copy A → B', JSON.stringify(r.copied));
    check(r.scaled[0][0].join() === '2.00,4.00' && r.scaled[0][1] === 'worse' && r.scaled[1].join() === '2.00,4.00' && r.scaled[2] === 'same' && r.scaled[3] && r.scaled[4], 'ab: B unrolled ×2 is compared per iteration of A', JSON.stringify(r.scaled));
    check(/^assembled: 9 bytes: 48 83 c0 02 49 ff cf 75 f7$/.test(r.asm[0]) && r.asm[2] !== undefined && r.asm[3], 'ab: B in assembly', JSON.stringify(r.asm));
    check(/line 2:3: .*frobnicate|invalid instruction/.test(r.asmErr[0]) && r.asmErr[1] === 'true', 'ab: B\'s assembler errors are shown under B', JSON.stringify(r.asmErr));
    check(r.unlabelled.length === 0 && r.focusable, 'ab: every control is labelled and focusable', JSON.stringify(r.unlabelled));

    // the link restores both sides and runs; old single-mode links are unchanged
    const link = `${origin}/?nosw=1#v=1&a=SKL&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM&ab=1&ba=ZEN3&bc=NDggODMgYzAgMDIgNDkgZmYgY2YgNzUgZjc`;
    await page.goto('about:blank');
    await page.goto(link);
    await page.waitFor(`document.querySelectorAll('.ab-tp .value').length === 2`, 'the comparison of a shared link');
    const u = await page.eval(`${HELPERS}
      const out = { ab: $('cmp-ab').checked, b: $('code-b').value, arch: $('b-arch').value, vals: vals() };
      await done(() => $('cmp-single').click());
      out.single = [document.querySelector('.tp .value')?.textContent, location.hash, getComputedStyle($('code-b').closest('.ab-b')).display];
      return out;`);
    check(u.ab && u.b === BETTER && u.arch === 'ZEN3' && u.vals[0] === '2.00', 'ab: a link restores both sides and the cpu of B', JSON.stringify(u));
    check(u.single[0] === '2.00' && u.single[1] === '#v=1&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM' && u.single[2] === 'none', 'ab: back to single mode: the single result and an old-style link', JSON.stringify(u.single));
    check(ce.requests.length === 0, 'ab: nothing was sent to godbolt.org', JSON.stringify(ce.requests));
    const problems = page.take();
    check(problems.length === 0, 'ab: no console errors', problems.join('\n'));
    await page.cmd('Page.close');
  }

  // --- 2. Compiler Explorer import --------------------------------------------------------------------------------------------
  {
    ce.fail.set(/RateLimited/, 429);
    const page = await Page.open(browser);
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const r = await page.eval(`${HELPERS}
      const out = {};
      out.csp = document.querySelector('meta[http-equiv=Content-Security-Policy]').content.match(/connect-src [^;]*/)[0];
      $('ce-open').click(); await wait(100);
      out.dialog = [$('ce-dialog').open, document.querySelector('.ce-privacy').textContent.includes('godbolt.org'), document.activeElement === $('ce-url')];
      $('ce-url').value = ${JSON.stringify(links.countSetBits)};
      $('ce-load').click();
      await until(() => document.querySelectorAll('tr.ce-row').length > 0);
      out.pane = document.querySelector('.ce-pane-list').innerText.replace(/\\s+/g, ' ').trim();
      out.status = $('ce-status').textContent;
      out.fn = $('ce-fn').selectedOptions[0].textContent;
      out.selected = [...document.querySelectorAll('tr.ce-row.on .ce-text')].map((e) => e.textContent);
      out.chips = [...document.querySelectorAll('.ce-chip')].map((e) => e.textContent);
      out.sel = $('ce-sel').textContent;
      out.unlabelled = unlabelled();
      // shift+click extends the range; a click starts it
      const rows = [...document.querySelectorAll('tr.ce-row')];
      rows[1].click(); rows[3].dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
      out.range = [...document.querySelectorAll('tr.ce-row.on .ce-text')].map((e) => e.textContent).join(' | ');
      document.querySelectorAll('.ce-chip')[0].click();
      $('ce-align').click();
      await done(() => $('ce-import-a').click());
      out.imported = [$('ce-dialog').open, $('mode-hex').checked, $('code').value, document.querySelector('.tp .value')?.textContent, $('opt-align').value];
      // A–B: a pasted short link goes into B
      set($('opt-align'), '0');
      await done(() => $('cmp-ab').click());
      paste($('code-b'), ${JSON.stringify(links.short)});
      await wait(50);
      out.offer = [document.querySelector('.ce-offer')?.textContent, $('code-b').value === $('code').value];
      document.querySelector('.ce-offer button.primary').click();
      await until(() => document.querySelectorAll('tr.ce-row').length > 0 && $('ce-fn').selectedOptions[0]?.textContent.startsWith('square'));
      out.short = [$('ce-url').value, $('ce-fn').selectedOptions[0].textContent, [...$('ce-fn').options].map((o) => o.textContent), [...document.querySelectorAll('.ce-buttons button')].map((b) => b.textContent)];
      await done(() => $('ce-import-b').click());
      out.intoB = [$('code-b').value.split('\\n')[0], vals().length, $('code').value.includes('blsr')];
      // pasting it as text instead
      paste($('code-b'), ${JSON.stringify(links.short)});
      await wait(50);
      [...document.querySelectorAll('.ce-offer button')].find((b) => /as text/.test(b.textContent)).click();
      out.asText = $('code-b').value.includes('godbolt.org/z/G38YP7eW4');
      // errors: a rate-limited short link, a failed compilation
      $('b-import').click(); await wait(50);
      $('ce-url').value = 'https://godbolt.org/z/RateLimited'; $('ce-load').click();
      await until(() => $('ce-status').classList.contains('error'));
      out.rate = $('ce-status').textContent;
      $('ce-url').value = 'https://example.com/#g:abc'; $('ce-load').click(); await wait(50);
      out.host = $('ce-status').textContent;
      // a link with only assembly source (no compiler pane): imported as it is
      const asmState = { sessions: [{ id: 1, language: 'assembly', source: 'loop:\\n  vaddps ymm0, ymm0, ymm1\\n  dec r15\\n  jnz loop', compilers: [] }] };
      $('ce-url').value = 'https://godbolt.org/clientstate/' + btoa(JSON.stringify(asmState)); $('ce-load').click();
      await until(() => /imported as it is/.test($('ce-status').textContent));
      out.source = [document.querySelector('.ce-pane-list').innerText.trim(), [...document.querySelectorAll('.ce-buttons button')].map((b) => b.textContent).join('|')];
      await done(() => $('ce-import-b').click());
      out.sourceIn = [$('b-mode-asm').checked, $('code-b').value, vals().length, $('b-messages').innerText];
      $('b-import').click(); await wait(50);
      $('ce-close').click();
      out.closed = !$('ce-dialog').open;
      return out;`);
    check(r.csp === 'connect-src \'self\' https://godbolt.org', 'ce: the CSP allows godbolt.org and nothing else', r.csp);
    check(r.dialog.every(Boolean), 'ce: the dialog says where requests go; the link field has focus', JSON.stringify(r.dialog));
    check(/x86-64 gcc 8\.2 -O2 -march=haswell -Wall -Wextra -pedantic · c\+\+ · editor #1/.test(r.pane) && /compiled with x86-64 gcc 8\.2.*exact encoding/.test(r.status), 'ce: the compiler pane (named from the compiler list) and the output mode', JSON.stringify([r.pane, r.status]));
    check(r.fn === 'countSetBits(unsigned int) · 1 loop' && r.selected.join(' | ') === 'inc eax | blsr edi,edi | jne 10 <countSetBits(unsigned int)+0x10>' && /^innermost loop 1/.test(r.chips[0]) && /3 instructions, 9 bytes .*analyzed as a loop/.test(r.sel), 'ce: the innermost loop is preselected', JSON.stringify([r.fn, r.selected, r.chips, r.sel]));
    check(r.unlabelled.length === 0, 'ce: the dialog\'s controls are labelled', JSON.stringify(r.unlabelled));
    check(r.range === 'test edi,edi | je 20 <countSetBits(unsigned int)+0x20> | cs nop WORD PTR [rax+rax*1+0x0]', 'ce: click and shift+click select a range', r.range);
    check(!r.imported[0] && r.imported[1] && r.imported[2] === '  10:  ff c0             inc eax\n  12:  c4 e2 40 f3 cf    blsr edi,edi\n  17:  75 f7             jne 10 <countSetBits(unsigned int)+0x10>\n' && /^\d+\.\d\d$/.test(r.imported[3]) && r.imported[4] === '16', 'ce: the import puts the compiler\'s machine code into the editor, analyzes it, and sets the alignment', JSON.stringify(r.imported));
    check(/Compiler Explorer link/.test(r.offer[0] ?? '') && /godbolt\.org/.test(r.offer[0]) && r.offer[1], 'ce: a pasted link is offered for import (and not pasted)', JSON.stringify(r.offer));
    check(r.short[0] === links.short && r.short[2].join('|') === 'square(int)|main' && r.short[3].join('|') === 'Import into B|Import into A', 'ce: a short link; in A–B mode both sides are offered, the pasted-into side first', JSON.stringify(r.short));
    check(/^\s+0:\s+55\s+push rbp$/.test(r.intoB[0]) && r.intoB[1] === 2 && r.intoB[2], 'ce: imported into B, A unchanged, both analyzed', JSON.stringify(r.intoB));
    check(r.asText, 'ce: "paste the link as text"');
    check(/assembly source \(editor #1\)/.test(r.source[0]) && r.source[1] === 'Import into B|Import into A' && r.sourceIn[0] && r.sourceIn[1] === 'loop:\n  vaddps ymm0, ymm0, ymm1\n  dec r15\n  jnz loop\n' && r.sourceIn[2] === 2 && /^assembled: 9 bytes/.test(r.sourceIn[3]), 'ce: an assembly-only link is imported as assembly and analyzed', JSON.stringify([r.source, r.sourceIn]));
    check(/limiting the rate of requests; try again in 42 s/.test(r.rate) && /not a Compiler Explorer link/.test(r.host) && r.closed, 'ce: rate limit and a foreign link are reported', JSON.stringify([r.rate, r.host]));
    const sent = ce.requests.filter((x) => !x.startsWith('OPTIONS'));
    check(JSON.stringify(sent) === JSON.stringify(['GET /api/compilers/c%2B%2B?fields=id,name,lang,instructionSet,supportsBinary,supportsBinaryObject', 'POST /api/compiler/g82/compile',
      'GET /api/shortlinkinfo/G38YP7eW4', 'GET /api/compilers/c%2B%2B?fields=id,name,lang,instructionSet,supportsBinary,supportsBinaryObject', 'POST /api/compiler/g132/compile', 'GET /api/shortlinkinfo/RateLimited']), 'ce: exactly these requests went to godbolt.org', JSON.stringify(sent));
    const problems = page.take();
    check(problems.length === 0, 'ce: no console errors', problems.join('\n'));
    await page.cmd('Page.close');
  }

  // --- 3. phone width ----------------------------------------------------------------------------------------------------------
  {
    const page = await Page.open(browser, { width: 375, height: 812, mobile: true });
    await page.goto(`${origin}/?nosw=1#v=1&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM&ab=1&bc=NDggODMgYzAgMDIgNDkgZmYgY2YgNzUgZjc`);
    await page.waitFor(`document.querySelectorAll('.ab-tp .value').length === 2`, 'the comparison on a phone');
    const r = await page.eval(`${HELPERS}
      const a = $('code').getBoundingClientRect(), b = $('code-b').getBoundingClientRect();
      const o1 = overflow();
      $('ce-open').click(); await wait(100);
      const d = $('ce-dialog').getBoundingClientRect();
      return { stacked: b.top > a.bottom, overflow: o1, dialog: d.right <= innerWidth && d.left >= 0, vals: vals() };`);
    check(r.stacked && r.overflow <= 0 && r.dialog && r.vals.join() === '2.00,1.00', 'phone: A above B, no sideways scrolling, the dialog fits', JSON.stringify(r));
    const problems = page.take();
    check(problems.length === 0, 'phone: no console errors', problems.join('\n'));
    await page.cmd('Page.close');
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  browser.close();
  proc.kill();
  server.close();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`${count} A–B / Compiler Explorer browser checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
