// End-to-end test of A–B mode and of Compiler Explorer links pasted into a code box, in headless Chrome over the DevTools protocol,
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
import { findChrome } from './chrome.mjs';
import { hostHandler } from './static-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'web', 'dist');
const fixtures = path.join(here, 'fixtures', 'godbolt');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const chrome = findChrome(opt('--chrome'));
if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fx = (name) => fs.readFileSync(path.join(fixtures, name), 'utf8');
const links = JSON.parse(fx('links.json'));

// ---- the site ----------------------------------------------------------------------------------------------------------
// like the host (redirects /index.html to /, a 404 page, _headers): see static-host.mjs
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
  const line = (id) => document.querySelector('.ce-line[data-for="' + id + '"]')?.textContent ?? '';
  const focused = () => $('cpus').dataset.focus; // the CPU with the details: side A's
  const isAsm = (id) => /^(B: )?assembly code$/i.test($(id).getAttribute('aria-label'));
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
      out.start = [$('cmp-single').checked, getComputedStyle($('code-b').closest('.ab-b')).display, location.hash, $('mode-asm').checked];
      $('mode-hex').click(); await wait(50);
      set($('code'), ${JSON.stringify(CHAIN)});
      await done(() => $('cmp-ab').click());
      out.entered = [vals(), verdict(), $('code-b').value, $('code-b').offsetWidth > 0, location.hash];
      set($('code-b'), ${JSON.stringify(BETTER)});
      out.stale = $('result-body').classList.contains('stale');
      await done(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
      out.folds = [...document.querySelectorAll('#result-body details.ab-fold')].map((d) => d.open);
      out.lean = [!!$('ab-hide-empty'), !document.querySelector('#result-body .meta')?.textContent.match(/bytes|instruction| ms/)];
      document.querySelectorAll('#result-body details.ab-fold').forEach((d) => { d.open = true; }); await wait(50);
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
      out.zen = [document.querySelectorAll('.ab-tp .value').length, [...document.querySelectorAll('#result-body .meta')].map((e) => e.textContent).join(' / '), document.querySelector('.ab-diff')?.closest('.row').innerText.includes('different ports'), location.hash.includes('ba=ZEN3')];
      // swap with another cpu: the cpus change sides too
      await done(() => $('ab-swap').click());
      out.swapArch = [focused(), $('b-arch').value];
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
      $('b-mode-asm').click(); await until(() => isAsm('code-b') && !$('code-b').readOnly);
      out.bConverted = [$('code-b').value, $('b-syntax').value];
      set($('code-b'), 'x:\\n  add rax, 2\\n  dec r15\\n  jnz x\\n');
      await done(() => $('run').click());
      out.asm = [$('b-messages').innerText, vals(), verdict(), !$('b-syntax').closest('label').hidden];
      set($('code-b'), 'x:\\n  frobnicate rax\\n'); await done(() => $('run').click()).catch(() => {}); await wait(500);
      out.asmErr = [$('b-messages').innerText, $('code-b').getAttribute('aria-invalid'), vals(), document.querySelector('#result-body .meta')?.textContent];
      out.unlabelled = unlabelled();
      out.focusable = ['cmp-single', 'cmp-ab', 'ab-swap', 'ab-copy', 'code-b', 'b-arch', 'b-scale', 'b-mode-asm'].every((id) => $(id) && $(id).tabIndex >= 0);
      return out;`);
    check(r.start[0] && r.start[1] === 'none' && r.start[2] === '' && r.start[3], 'ab: the page starts in single mode (assembly), B hidden', JSON.stringify(r.start));
    check(r.entered[0].join() === '2.00,2.00' && r.entered[1] === 'same' && r.entered[2] === r.entered[2] && r.entered[3] && /ab=1/.test(r.entered[4]), 'ab: switching to A–B copies A to B and compares at once', JSON.stringify(r.entered));
    check(r.stale, 'ab: an edit of B marks the result stale');
    check(r.result.vals.join() === '2.00,1.00' && r.result.verdict === 'better' && r.result.sr === 'A: 2.00 cycles, B: 1.00 cycles, Δ = −1.00 (−50%)' && /B better Δ = −1\.00 cycles \(−50%\) · B is 2\.00× faster/.test(r.result.delta), 'ab: the headline (Ctrl+Enter runs both)', JSON.stringify(r.result));
    check(r.result.labels === 'throughput,bottleneck,uops,limits,diff,text' && r.result.tables === 2, 'ab: all parts of the comparison', r.result.labels);
    check(r.folds.length === 3 && r.folds.every((o) => !o) && !r.lean[0] && r.lean[1], 'ab: lean by default: limits, diff and reports collapsed; no hide-empty control; no counts in the meta line', JSON.stringify([r.folds, r.lean]));
    check(/Dependencies/.test(r.result.bn) && r.result.limits.some((l) => /^Dependencies 2\.00 1\.00 −1\.00$/.test(l)) && r.result.limits.some((l) => /^Issue 0\.75 0\.50 −0\.25$/.test(l)), 'ab: bottlenecks and limits side by side', JSON.stringify([r.result.bn, r.result.limits]));
    check(r.result.diffHead === 'A B Δ uops Port 0 Port 1 Port 5 Port 6' && r.result.diff.length === 4 && /^ab-modified:~ add rax, 0x1 add rax, 0x2/.test(r.result.diff[0]) && /^ab-removed:− add rax, 0x1 −1 −0\.28/.test(r.result.diff[1]) && /^ab-same:dec r15 dec r15$/.test(r.result.diff[2]) && /^ab-same:jnz 0x\w+ M jnz 0x\w+ M$/.test(r.result.diff[3]), 'ab: the instruction diff (modified, removed, same; branch targets ignored)', JSON.stringify(r.result.diff));
    check(r.result.overflow <= 0 && /Δ −1\.00/.test(r.result.status), 'ab: no sideways scrolling at 1280px; the status line', JSON.stringify([r.result.overflow, r.result.status]));
    check(r.hash === '#v=1&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM&ab=1&bc=NDggODMgYzAgMDIgNDkgZmYgY2YgNzUgZjc', 'ab: both inputs are in the fragment', r.hash);
    check(r.swapped[0].join() === '1.00,2.00' && r.swapped[1] === 'worse' && r.swapped[2] === BETTER && r.swapped[3] === CHAIN, 'ab: swap', JSON.stringify(r.swapped));
    check(r.zen[0] === 2 && /B .*ZEN3/.test(r.zen[1]) && r.zen[2] && r.zen[3], 'ab: another cpu for B (Zen 3): no per-port comparison', JSON.stringify(r.zen));
    check(r.swapArch.join() === 'ZEN3,SKL', 'ab: swap also exchanges the cpus', JSON.stringify(r.swapArch));
    check(r.copied[0] && r.copied[1] === 'same', 'ab: copy A → B', JSON.stringify(r.copied));
    check(r.scaled[0][0].join() === '2.00,4.00' && r.scaled[0][1] === 'worse' && r.scaled[1].join() === '2.00,4.00' && r.scaled[2] === 'same' && r.scaled[3] && r.scaled[4], 'ab: B unrolled ×2 is compared per iteration of A', JSON.stringify(r.scaled));
    check(r.bConverted[0] === 'loop:\n  add rax, 0x1\n  add rax, 0x1\n  add rax, 0x1\n  add rax, 0x1\n  dec r15\n  jnz loop\n' && r.bConverted[1] === 'intel', 'ab: B switched from hex to asm: its code as assembly', JSON.stringify(r.bConverted));
    check(r.asm[0] === '' && r.asm[1].join() === '2.00,1.00' && r.asm[2] === 'better' && r.asm[3], 'ab: B in assembly (no messages when it assembles)', JSON.stringify(r.asm));
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

    // the default example in A: A–B loads the demo pair (one dot-product accumulator vs four); live mode re-runs it
    await page.goto('about:blank');
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const d = await page.eval(`${HELPERS}
      const out = {};
      await done(() => $('cmp-ab').click());
      await until(() => vals().length === 2);
      out.demo = [vals(), verdict(), $('code').value.includes('vfmadd231ps ymm0, ymm7'), $('code-b').value.includes('vfmadd231ps ymm3, ymm7'), $('live').checked, $('sweep-row').offsetParent === null && $('cmp-cpus').offsetParent === null && !$('trace-slot').hidden /* the sweep belongs to single mode; the trace row holds the A–B traces */, $('b-mode-asm').checked];
      const n = $('results').dataset.run;
      set($('code-b'), 'loop:\\n  add rax, 2\\n  dec r15\\n  jnz loop\\n'); // typing in B (assembly, as A): no click
      await until(() => $('results').dataset.run !== n);
      await wait(300);
      out.live = [vals(), Number($('results').dataset.run) - Number(n), $('result-body').classList.contains('stale')];
      return out;`);
    check(d.demo[0].join() === '16.00,4.00' && d.demo[1] === 'better' && d.demo[2] && d.demo[3] && d.demo[4] && d.demo[5] && d.demo[6], 'ab: from the default example, A–B shows the demo pair (dot product, 1 vs 4 accumulators; B in assembly too); the compare views are hidden', JSON.stringify(d.demo));
    check(d.live[0].join() === '16.00,1.00' && d.live[1] === 1 && !d.live[2], 'ab: live mode re-runs the comparison while typing in B (once, no click)', JSON.stringify(d.live));
    check(ce.requests.length === 0, 'ab: nothing was sent to godbolt.org', JSON.stringify(ce.requests));
    const problems = page.take();
    check(problems.length === 0, 'ab: no console errors', problems.join('\n'));
    await page.cmd('Page.close');
  }

  // --- 2. Compiler Explorer links pasted into a code box --------------------------------------------------------------------
  {
    ce.fail.set(/RateLimited/, 429);
    const page = await Page.open(browser);
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const r = await page.eval(`${HELPERS}
      const out = {};
      out.csp = document.querySelector('meta[http-equiv=Content-Security-Policy]').content.match(/connect-src [^;]*/)[0];
      out.noButton = !document.querySelector('#ce-open, #b-import, dialog');
      // one pane, one loop: imported at once, analyzed; the box then gets the assembly; undo gives the link back
      const first = [];
      const obs = new MutationObserver(() => { if (!first.length && document.querySelector('.tp .value')) first.push(isAsm('code'), $('code').value.split('\\n')[0], $('results').dataset.run); });
      obs.observe($('result-body'), { childList: true, subtree: true });
      paste($('code'), ${JSON.stringify(links.countSetBits)});
      out.busy = [line('code'), $('code').value === ${JSON.stringify(links.countSetBits)}];
      await until(() => /^imported/.test(line('code')) && !$('results').hasAttribute('aria-busy') && document.querySelector('.tp .value') && isAsm('code'));
      await wait(600);
      obs.disconnect();
      out.first = first;
      out.imported = [line('code'), $('mode-asm').checked, $('code').value, document.querySelector('.tp .value')?.textContent, $('opt-align').value, document.querySelector('.ce-line[data-for=code]').title,
        $('syntax').value, $('result-body').classList.contains('stale'), $('results').dataset.run === first[2], $('input-messages').innerText];
      $('ce-undo-a').click(); await wait(400);
      out.undone = [$('code').value === ${JSON.stringify(links.countSetBits)}, line('code'), document.querySelector('.ce-pick:not([hidden])') === null];
      // pasted again after undo: replaced (not appended) and imported again
      paste($('code'), ${JSON.stringify(links.countSetBits)});
      await until(() => /^imported/.test(line('code')) && isAsm('code'));
      out.again = $('code').value.startsWith('loop:\\n  inc eax');
      // an edit while the import is analyzed (before the conversion) wins: the box keeps it, in hex
      $('ce-undo-a').click(); await wait(300);
      const value = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      let edited = false;
      Object.defineProperty($('code'), 'value', { configurable: true, get() { return value.get.call(this); },
        set(v) { value.set.call(this, v); if (!edited && /^ +10:/.test(v)) { edited = true; queueMicrotask(() => set(this, v + '  90\\n')); } } });
      paste($('code'), ${JSON.stringify(links.countSetBits)});
      await until(() => edited); await wait(1500);
      delete $('code').value;
      out.edit = [isAsm('code'), $('mode-hex').checked, $('code').value.endsWith('jne 10 <countSetBits(unsigned int)+0x10>\\n  90\\n')];
      // A–B: a short link with two functions in B: the picker, with the first function preselected
      $('mode-hex').click(); await until(() => !isAsm('code') && !$('code').readOnly);
      set($('code'), ${JSON.stringify(CHAIN)});
      await done(() => $('cmp-ab').click());
      const aBefore = $('code').value;
      paste($('code-b'), ${JSON.stringify(links.short)});
      await until(() => $('ce-fn-b'));
      out.picker = [line('code-b'), [...$('ce-fn-b').options].map((o) => o.textContent), $('ce-fn-b').selectedOptions[0].textContent, [...document.querySelectorAll('.ce-pick:not([hidden]) .ce-chip')].map((b) => b.textContent),
        document.querySelector('details.ce-range summary').textContent, document.querySelector('details.ce-range').open];
      out.unlabelled = unlabelled();
      // the range: a click starts it, shift+click ends it; "whole" takes the function
      document.querySelector('details.ce-range summary').click(); await wait(50);
      const rows = () => [...document.querySelectorAll('tr.ce-row')];
      rows()[1].click(); rows()[3].dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
      out.range = [document.querySelectorAll('tr.ce-row.on').length, document.querySelector('details.ce-range summary').textContent];
      [...document.querySelectorAll('.ce-chip')].find((b) => b.textContent === 'whole').click();
      await done(() => $('ce-import-b').click());
      await until(() => isAsm('code-b')); await wait(200);
      out.intoB = [$('code-b').value, vals().length, $('code').value === aBefore, line('code-b'), document.querySelector('.ce-pick:not([hidden])') === null, $('result-body').classList.contains('stale')];
      // errors: one line under the box
      paste($('code-b'), 'https://godbolt.org/z/RateLimited');
      await until(() => document.querySelector('.ce-line[data-for=code-b]').classList.contains('error'));
      out.rate = line('code-b');
      // not a Compiler Explorer link: nothing happens
      set($('code-b'), ${JSON.stringify(BETTER)}); await wait(200);
      paste($('code-b'), 'https://example.com/#g:abc'); await wait(200);
      out.foreign = [line('code-b'), $('code-b').value === ${JSON.stringify(BETTER)}];
      // a link with only assembly source (no compiler pane): imported as it is, as assembly
      const asmState = { sessions: [{ id: 1, language: 'assembly', source: 'loop:\\n  vaddps ymm0, ymm0, ymm1\\n  dec r15\\n  jnz loop', compilers: [] }] };
      paste($('code-b'), 'https://godbolt.org/clientstate/' + btoa(JSON.stringify(asmState)));
      await until(() => /^imported/.test(line('code-b')));
      await until(() => !$('results').hasAttribute('aria-busy')); await wait(800);
      out.sourceIn = [$('b-mode-asm').checked, $('code-b').value, vals(), line('code-b'), $('b-messages').innerText];
      // two choices (here two assembly sources): the picker has a pane menu
      const two = { sessions: [{ id: 1, language: 'assembly', source: 'a:\\n  add rax, 1\\n  dec r15\\n  jnz a', compilers: [] }, { id: 2, language: 'assembly', source: 'b:\\n  add rax, 2\\n  dec r15\\n  jnz b', compilers: [] }] };
      paste($('code-b'), 'https://godbolt.org/clientstate/' + btoa(JSON.stringify(two)));
      await until(() => $('ce-pane-b'));
      out.panes = [[...$('ce-pane-b').options].map((o) => o.textContent), $('ce-pane-b').value, line('code-b'), unlabelled()];
      set($('ce-pane-b'), 'e2'); await wait(50);
      await done(() => $('ce-import-b').click());
      out.two = [$('code-b').value, line('code-b')];
      return out;`);
    check(r.csp === 'connect-src \'self\' https://cloudflareinsights.com https://godbolt.org', 'ce: the CSP allows godbolt.org (and the Cloudflare beacon)', r.csp);
    check(r.noButton, 'ce: no import button or dialog');
    check(r.busy[0] === 'importing from godbolt.org…' && r.busy[1], 'ce: a pasted link replaces the box\'s text and is imported at once (one status line)', JSON.stringify(r.busy));
    check(/^imported: loop in countSetBits\(unsigned int\) · undo$/.test(r.imported[0]) && r.imported[1] && r.imported[2] === 'loop:\n  inc eax\n  blsr edi, edi\n  jnz loop\n' && r.imported[6] === 'intel'
      && /^\d+\.\d\d$/.test(r.imported[3]) && r.imported[4] === '0' && /x86-64 gcc 8\.2/.test(r.imported[5]), 'ce: one pane, one loop: the innermost loop is imported without asking, analyzed, and shown as assembly', JSON.stringify(r.imported));
    check(r.first[0] === false && r.first[1] === '  10:  ff c0             inc eax' && !r.imported[7] && r.imported[8] && r.imported[9] === '', 'ce: the machine code is analyzed at once; the assembly comes after, and the result stays current (no second run)', JSON.stringify([r.first, r.imported.slice(7)]));
    check(r.edit.join() === 'false,true,true', 'ce: an edit before the conversion is kept (and the box stays hex)', JSON.stringify(r.edit));
    check(r.undone[0] && r.undone[1] === '' && r.undone[2], 'ce: undo puts the link back (and does not import it again)', JSON.stringify(r.undone));
    check(r.again, 'ce: the same link pasted again after undo is imported again');
    check(r.panes[0].join('|') === 'assembly source #1|assembly source #2' && r.panes[1] === 'e1' && r.panes[2] === 'choose what to import' && r.panes[3].length === 0
      && r.two[0] === 'b:\n  add rax, 2\n  dec r15\n  jnz b\n' && r.two[1] === 'imported: assembly source · undo', 'ce: several choices: a pane menu in the picker; the chosen one is imported', JSON.stringify([r.panes, r.two]));
    check(r.picker[0] === 'choose what to import' && r.picker[1].join('|') === 'square(int)|main' && r.picker[2] === 'square(int)' && r.picker[3].at(-1) === 'whole' && /instructions/.test(r.picker[4]) && !r.picker[5], 'ce: two functions: the picker under B, the first function preselected, the listing collapsed', JSON.stringify(r.picker));
    check(r.unlabelled.length === 0, 'ce: the picker\'s controls are labelled', JSON.stringify(r.unlabelled));
    check(r.range[0] === 3 && /^3 instructions/.test(r.range[1]), 'ce: click and shift+click select a range', JSON.stringify(r.range));
    check(r.intoB[0] === '  push rbp\n  mov rbp, rsp\n  mov dword ptr [rbp-0x4], edi\n  mov eax, dword ptr [rbp-0x4]\n  imul eax, eax\n  pop rbp\n  ret\n' && !r.intoB[5] && r.intoB[1] === 2 && r.intoB[2] && /^imported: \d+ instructions in square\(int\) · undo$/.test(r.intoB[3]) && r.intoB[4], 'ce: imported into B, A unchanged, both analyzed', JSON.stringify(r.intoB));
    check(/limiting the rate of requests; try again in 42 s/.test(r.rate), 'ce: a rate limit is reported in the status line', r.rate);
    check(r.foreign[0] === '' && r.foreign[1], 'ce: a link elsewhere is not imported', JSON.stringify(r.foreign));
    check(r.sourceIn[0] && r.sourceIn[1] === 'loop:\n  vaddps ymm0, ymm0, ymm1\n  dec r15\n  jnz loop\n' && r.sourceIn[2].length === 2 && /^imported: assembly source · undo$/.test(r.sourceIn[3]) && r.sourceIn[4] === '', 'ce: an assembly-only link is imported as assembly and analyzed', JSON.stringify(r.sourceIn));
    const sent = ce.requests.filter((x) => !x.startsWith('OPTIONS'));
    const LIST = 'GET /api/compilers/c%2B%2B?fields=id,name,lang,instructionSet,supportsBinary,supportsBinaryObject';
    check(JSON.stringify(sent) === JSON.stringify([LIST, 'POST /api/compiler/g82/compile', LIST, 'POST /api/compiler/g82/compile', LIST, 'POST /api/compiler/g82/compile',
      'GET /api/shortlinkinfo/G38YP7eW4', 'GET /api/compilers/c%2B%2B?fields=id,name,lang,instructionSet,supportsBinary,supportsBinaryObject', 'POST /api/compiler/g132/compile', 'GET /api/shortlinkinfo/RateLimited']), 'ce: exactly these requests went to godbolt.org', JSON.stringify(sent));
    // a link in a shared fragment is not imported by itself (only Analyze, the user's action, imports it)
    ce.requests.length = 0;
    const b64 = Buffer.from(links.short).toString('base64url');
    await page.goto('about:blank');
    await page.goto(`${origin}/?nosw=1#v=1&c=${b64}`);
    await page.ready();
    await sleep(1500);
    const f = await page.eval(`${HELPERS}
      const out = { before: [$('code').value, line('code')] };
      $('run').click(); await until(() => $('ce-fn-a')); out.after = line('code');
      return out;`);
    check(f.before[0] === links.short && f.before[1] === '' && f.after === 'choose what to import' && ce.requests.filter((x) => !x.startsWith('OPTIONS'))[0] === 'GET /api/shortlinkinfo/G38YP7eW4',
      'ce: a link restored from a fragment contacts godbolt.org only when Analyze is pressed', JSON.stringify([f, ce.requests]));
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
      paste($('code-b'), ${JSON.stringify(links.short)});
      await until(() => $('ce-fn-b'));
      document.querySelector('details.ce-range summary').click(); await wait(100);
      const p = document.querySelector('.ce-pick:not([hidden])').getBoundingClientRect();
      return { stacked: b.top > a.bottom, overflow: o1, picker: p.right <= innerWidth && p.left >= 0, overflow2: overflow(), vals: vals() };`);
    check(r.stacked && r.overflow <= 0 && r.picker && r.overflow2 <= 0 && r.vals.join() === '2.00,1.00', 'phone: A above B, no sideways scrolling, the picker fits', JSON.stringify(r));
    const problems = page.take();
    check(problems.length === 0, 'phone: no console errors', problems.join('\n'));
    await page.cmd('Page.close');
  }

  // --- 4. a switch of the input format converts the code -------------------------------------------------------------------
  {
    const page = await Page.open(browser);
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    const r = await page.eval(`${HELPERS}
      const { EXAMPLES } = await import('/js/examples.js');
      const out = {};
      const to = async (m) => { $('mode-' + m).click(); await until(() => (m === 'asm') === isAsm('code') && !$('code').readOnly); await wait(50); };
      await to('hex');
      out.example = $('code').value === EXAMPLES[0].text.hex; // the same code in the other format: that text, as it is
      set($('code'), ${JSON.stringify(CHAIN)});
      await done(() => $('run').click());
      const n = $('results').dataset.run;
      set($('syntax'), 'att');
      await to('asm'); await wait(500);
      out.toAsm = [$('code').value, $('syntax').value, $('result-body').classList.contains('stale'), $('results').dataset.run === n, $('input-messages').innerText];
      await to('hex');
      out.back = [$('code').value === ${JSON.stringify(CHAIN)}, $('result-body').classList.contains('stale')];
      await to('asm');
      set($('code'), 'top:\\n  add rax, 2\\n  dec r15\\n  jnz top\\n');
      await to('hex');
      out.toHex = $('code').value;
      // above the size limit: no conversion; the box shows asm's own text, and the result is not kept
      set($('code'), '90 '.repeat(4001));
      await done(() => $('run').click());
      const c = $('results').dataset.run;
      $('mode-asm').click(); await until(() => isAsm('code') && !$('code').readOnly);
      out.cap = [$('code').value];
      await until(() => $('results').dataset.run !== c || $('result-body').classList.contains('stale'), 5000).then(() => out.cap.push(true), () => out.cap.push(false));
      await to('hex');
      out.cap.push($('code').value === out.toHex);
      // A–B: B (a copy of A) from hex to asm
      await done(() => $('cmp-ab').click());
      const m = $('results').dataset.run;
      $('b-mode-asm').click(); await until(() => isAsm('code-b') && !$('code-b').readOnly); await wait(500);
      out.b = [$('code-b').value, $('b-syntax').value, $('result-body').classList.contains('stale'), $('results').dataset.run === m];
      await done(() => $('cmp-single').click());
      // the SHA-256 showcase (2,949 instructions, machine code only)
      await done(() => set($('examples'), 'sha256'));
      const k = $('results').dataset.run;
      let longest = 0;
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longest = Math.max(longest, e.duration); });
      try { po.observe({ type: 'longtask' }); } catch {}
      const t0 = performance.now();
      await to('asm');
      const ms = performance.now() - t0;
      await wait(800); po.disconnect();
      const text = $('code').value;
      out.sha = { ms: Math.round(ms), longest: PerformanceObserver.supportedEntryTypes.includes('longtask') ? Math.round(longest) : 'not measured', lines: text.split('\\n').length, bytes: (text.match(/^ *\\.byte/gm) ?? []).length, chars: text.length,
        stale: $('result-body').classList.contains('stale'), same: $('results').dataset.run === k, hash: location.hash.length, messages: $('input-messages').innerText };
      return out;`);
    check(r.example, 'switch: an untouched example shows its own text in the other format');
    check(r.toAsm[0] === 'loop:\n  add rax, 0x1\n  add rax, 0x1\n  dec r15\n  jnz loop\n' && r.toAsm[1] === 'intel' && !r.toAsm[2] && r.toAsm[3] && r.toAsm[4] === '',
      'switch: hex -> asm converts the code (Intel syntax); the result stays current, no second run', JSON.stringify(r.toAsm));
    check(r.back.join() === 'true,false', 'switch: back to hex: the hex text as it was (the same code)', JSON.stringify(r.back));
    check(r.toHex === '   0:  48 83 c0 02    add rax, 0x2\n   4:  49 ff cf       dec r15\n   7:  75 f7          jnz 0x0\n', 'switch: edited assembly -> hex: a listing of the new code', JSON.stringify(r.toHex));
    check(r.cap.join('|') === 'top:\n  add rax, 2\n  dec r15\n  jnz top\n|true|true', 'switch: above the size limit (4,001 instructions): no conversion, the result is not kept', JSON.stringify(r.cap));
    check(r.b[0] === 'loop:\n  add rax, 0x2\n  dec r15\n  jnz loop\n' && r.b[1] === 'intel' && !r.b[2] && r.b[3], 'switch: B from hex to asm in A–B mode', JSON.stringify(r.b));
    check(r.sha.lines > 2949 && r.sha.bytes < 50 && !r.sha.stale && r.sha.same && r.sha.messages === '', 'switch: the SHA-256 showcase as assembly (2,949 instructions), the result kept', JSON.stringify(r.sha));
    console.log(`SHA-256 showcase, hex -> asm in the page: ${r.sha.ms} ms, longest task (over 50 ms) ${r.sha.longest} ms, ${r.sha.lines} lines (${r.sha.chars} characters, ${r.sha.bytes} .byte), fragment ${r.sha.hash} characters`);
    const problems = page.take();
    check(problems.length === 0, 'switch: no console errors', problems.join('\n'));
    await page.cmd('Page.close');
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  browser.close();
  proc.kill();
  server.close();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be writing its profile */ }
}

console.log(`${count} A–B / Compiler Explorer browser checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
