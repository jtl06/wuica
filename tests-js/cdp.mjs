// Shared helpers for browser suites: headless Chrome over the DevTools protocol (no dependencies, Node 22+), a copy
// of web/dist served like the host (static-host.mjs), and a page object. Not a suite itself (scripts/check.mjs runs
// tests-js/web_*.mjs); a suite that uses it must still mention the Chrome flags it starts with (--headless,
// --remote-debugging-port) in its own file so that check.mjs counts it as a browser suite.
//
//   import { findChrome, launch, serveCopy, Page } from './cdp.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostHandler } from './static-host.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const DIST = path.join(ROOT, 'web', 'dist');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The bound of the suites' "no long task" checks. Alone, the page's tasks stay well under 100 ms; scripts/check.sh runs
// the browser suites beside the Rust tests and the fixtures, and a task then also waits for the CPU (101–115 ms seen):
// the bound leaves room for that and still catches a task that doubles. On CI it is doubled (see TIMING_SLACK below: a task
// of 80 ms here took exactly 200 ms on a shared runner, on a commit that changed only documents).
// On CI (GitHub Actions sets CI=true for every step) the browser runs on a shared 4-core runner: a wall-clock bound of a
// frame or a few milliseconds is noise there (17.8 ms seen for a draw that takes 5 ms here). TIMING_SLACK scales such
// bounds: 1 locally (strict), 3 on CI. FRAME_MS is the bound of the "under a frame" checks.
export const ON_CI = !!process.env.CI && process.env.CI !== 'false';
export const TIMING_SLACK = ON_CI ? 3 : 1;
export const FRAME_MS = 16 * TIMING_SLACK;
export const LONG_TASK_MS = ON_CI ? 400 : 200;

// Scratch runs of the browser suites under other conditions than this machine's (layout checks that depend on widths):
//   WUICA_TEST_FONT=monospace     every text in that font instead of the page's own (as when it is not loaded; the checks
//                                 of the font itself then accept it)
//   WUICA_TEST_SCROLLBARS=1       scrollbars that take room, 15 px (Linux; macOS draws them over the page)
// (a constructed style sheet: the page's CSP allows no inline style). cmd: the page's DevTools command function.
export async function testConditions(cmd) {
  const rules = [];
  if (process.env.WUICA_TEST_FONT) rules.push(`html, body, button, input, select, textarea { font-family: ${process.env.WUICA_TEST_FONT} !important; }`);
  if (process.env.WUICA_TEST_SCROLLBARS) rules.push('::-webkit-scrollbar { width: 15px; height: 15px; background: #808080; }');
  if (!rules.length) return;
  await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `{ const s = new CSSStyleSheet(); s.replaceSync(${JSON.stringify(rules.join('\n'))}); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; }` });
}

export function findChrome(args = process.argv.slice(2)) {
  const i = args.indexOf('--chrome');
  return (i >= 0 ? args[i + 1] : null) || process.env.CHROME || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].find((p) => fs.existsSync(p)) || null;
}

/** a checker: check(cond, what, detail); summary() prints the count line; failed() */
export function checker(label) {
  let failed = 0, count = 0;
  const check = (cond, what, detail = '') => { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + String(detail).slice(0, 2000) : ''}`); } return !!cond; };
  check.summary = () => { console.log(`${count} ${label} checks, ${failed} failed`); return failed; };
  check.failed = () => failed;
  return check;
}

/** copies web/dist to a temporary directory (a running check.sh may rebuild web/dist meanwhile) */
export function copyDist(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-dist-'))) {
  fs.cpSync(DIST, dir, { recursive: true });
  return dir;
}

/** serves a directory like the host; root() may change; extra(req, res) can answer first (return true) */
export async function serve(root, { extra = null } = {}) {
  let dir = root;
  const requests = [];
  const sockets = new Set();
  const host = hostHandler(() => dir, { onRequest: (p) => requests.push(p) });
  const server = http.createServer((req, res) => { if (extra && extra(req, res)) return; host(req, res); });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  let port = 0;
  const listen = () => new Promise((r) => server.listen(port, '127.0.0.1', () => { port = server.address().port; r(); }));
  await listen();
  return {
    get origin() { return `http://127.0.0.1:${port}`; },
    requests,
    setRoot(d) { dir = d; },
    stop: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    restart: listen,
  };
}

export class Browser {
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

/** starts headless Chrome with a fresh profile: { browser, close() } */
export async function launch(chrome, { extraArgs = [] } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-chrome-'));
  const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', ...extraArgs, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = '';
    const t = setTimeout(() => reject(new Error('Chrome did not start: ' + err.slice(-500))), 30000);
    proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); resolve(m[1]); } });
    proc.on('exit', (c) => reject(new Error(`Chrome exited (${c}): ${err.slice(-500)}`)));
  });
  const browser = await Browser.connect(wsUrl);
  return {
    browser,
    async close() {
      try { await browser.send('Browser.close'); } catch { /* gone */ }
      browser.close();
      await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]);
      try { proc.kill('SIGKILL'); } catch { /* exited */ }
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be writing its profile */ }
    },
  };
}

export class Page {
  problems = []; // console errors, exceptions, failed requests
  ignore = [];   // RegExps of problems that are expected
  static async open(browser, { width = 1280, height = 900, mobile = false, intercept = null } = {}) {
    const p = new Page();
    p.browser = browser;
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    p.targetId = targetId;
    p.sessionId = (await browser.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    browser.on((m) => {
      if (m.sessionId !== p.sessionId) return;
      let text = null;
      if (m.method === 'Runtime.exceptionThrown') text = 'exception: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(m.params.type)) text = `console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description).join(' ');
      if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) text = `log ${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url ?? ''}`;
      if (text && !p.ignore.some((re) => re.test(text))) p.problems.push(text);
      if (m.method === 'Fetch.requestPaused' && intercept) intercept(m.params, p);
    });
    for (const d of ['Runtime', 'Log', 'Page', 'Network']) await p.cmd(`${d}.enable`);
    await testConditions((m, a) => p.cmd(m, a));
    if (intercept) await p.cmd('Fetch.enable', { patterns: [{ urlPattern: 'https://godbolt.org/*' }] });
    await p.size(width, height, mobile);
    return p;
  }
  cmd(method, params) { return this.browser.send(method, params, this.sessionId); }
  size(width, height, mobile = false) { return this.cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); }
  async eval(expression, { timeout = 120000 } = {}) {
    const r = await Promise.race([
      this.cmd('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true }),
      sleep(timeout).then(() => ({ exceptionDetails: { text: `evaluation took more than ${timeout} ms (a stuck page?)` } })),
    ]);
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  }
  async goto(url) {
    await this.cmd('Page.navigate', { url });
    await sleep(150);
    await this.waitFor(`document.readyState === 'complete'`, 'load');
  }
  async reload() { await this.cmd('Page.reload'); await sleep(150); await this.waitFor(`document.readyState === 'complete'`, 'reload'); }
  async waitFor(cond, what, ms = 30000) {
    const t0 = Date.now();
    for (;;) {
      let v = false;
      try { v = await this.eval(`return !!(${cond});`, { timeout: 10000 }); } catch { /* navigating */ }
      if (v) return true;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}: ${cond}`);
      await sleep(100);
    }
  }
  ready() { return this.waitFor(`!document.getElementById('run').disabled || document.querySelector('.error-box')`, 'the page to be ready', 60000); }
  /** a key press with the real input pipeline (focus, default actions) */
  async key(key, { code = key, keyCode = 0, modifiers = 0, text } = {}) {
    const t = text ?? (key.length === 1 ? key : undefined);
    await this.cmd('Input.dispatchKeyEvent', { type: t ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers, text: t });
    await this.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
  }
  async type(text) { await this.cmd('Input.insertText', { text }); }
  async click(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) await this.cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  async screenshot(file) {
    const { data } = await this.cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
  take() { const p = this.problems; this.problems = []; return p; }
  close() { return this.browser.send('Target.closeTarget', { targetId: this.targetId }); }
}

// Helpers evaluated in the page (prepend to an expression).
export const HELPERS = `
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 30000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + f); await wait(50); } };
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const tp = () => document.querySelector('#result-body .tp .value')?.textContent;
  const runId = () => $('results').dataset.run;
  const done = async (start, ms = 60000) => { const n = $('results').dataset.run; start(); await until(() => $('results').dataset.run !== n, ms); };
  const overflow = () => document.documentElement.scrollWidth - innerWidth;
  const focused = () => $('cpus').dataset.focus;
  const checkedCpus = () => [...document.querySelectorAll('#cpu-grid input:checked')].map((b) => b.value).join();
  const cpus = (...keys) => { const boxes = [...document.querySelectorAll('#cpu-grid input')]; for (const b of boxes) b.checked = keys.includes(b.value); boxes[0].dispatchEvent(new Event('change', { bubbles: true })); };
  const msgs = () => [...document.querySelectorAll('#input-messages li')].map((l) => l.textContent);
  const errorBox = () => document.querySelector('#result-body .error-box')?.textContent ?? '';
`;
