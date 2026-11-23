// The built site (web/dist) on a server that behaves like the host (tests-js/static-host.mjs: /index.html -> / with a 307,
// /404.html -> /404, a 404.html page), in headless Chrome with a fresh profile: the service worker takes control, and the page
// keeps working on reloads, after a visit to /index.html (the redirect) and offline. Regression test for a service worker
// that cached the redirected page and so made every second visit fail (ERR_FAILED).
//    web/build.sh && node tests-js/web_host_browser.mjs [--chrome PATH] [--dist DIR]
// Skips (exit 0) if Chrome is not found.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostHandler } from './static-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dist = path.resolve(opt('--dist') ?? path.join(here, '../web/dist'));
const chrome = opt('--chrome') || process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.error('web/dist is missing: run web/build.sh'); process.exit(1); }

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the server (stoppable, for the offline part)
const sockets = new Set();
const server = http.createServer(hostHandler(dist));
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const stop = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); });

// ---- 1. the server behaves like the host
{
  const get = (p) => fetch(origin + p, { redirect: 'manual' });
  const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), notFound = fs.readFileSync(path.join(dist, '404.html'), 'utf8');
  let r = await get('/index.html');
  check(r.status === 307 && r.headers.get('location') === '/', 'host: /index.html redirects to / (307)', `${r.status} ${r.headers.get('location')}`);
  r = await get('/index.html?x=1');
  check(r.status === 307 && r.headers.get('location') === '/?x=1', 'host: the query string is kept', r.headers.get('location'));
  r = await get('/404.html');
  check(r.status === 307 && r.headers.get('location') === '/404', 'host: /404.html redirects to /404', `${r.status} ${r.headers.get('location')}`);
  r = await get('/404');
  check(r.status === 404 && (await r.text()) === notFound, 'host: /404 is the 404 page with status 404', r.status);
  r = await get('/no/such/file.js');
  check(r.status === 404 && (await r.text()) === notFound, 'host: a missing file gets the 404 page', r.status);
  r = await get('/');
  check(r.status === 200 && /^text\/html/.test(r.headers.get('content-type')) && (await r.text()) === index, 'host: / is the page', r.status);
  r = await get('/wuica_wasm.wasm');
  check(r.status === 200 && r.headers.get('content-type') === 'application/wasm', 'host: the analyzer as application/wasm', r.headers.get('content-type'));
  await r.arrayBuffer();
  r = await get('/sw.js');
  check(r.status === 200 && r.headers.get('cache-control') === 'no-cache' && r.headers.get('x-content-type-options') === 'nosniff', 'host: the rules of _headers are applied', JSON.stringify([...r.headers]));
  await r.text();
  r = await get('/_headers');
  check(r.status === 404, 'host: _headers is not served', r.status);
  await r.text();
}

// ---- 2. the page in Chrome
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-host-test-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const cleanup = () => { try { proc.kill(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
try {
  const wsUrl = await new Promise((resolve, reject) => {
    let err = '';
    proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
    proc.on('exit', () => reject(new Error('Chrome exited: ' + err.slice(0, 500))));
    setTimeout(() => reject(new Error('Chrome did not start')), 20000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot connect to Chrome')); });
  let seq = 0;
  const pending = new Map(), problems = [];
  let sessionId;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result); return; }
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) problems.push(`console.${msg.params.type}: ` + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
    if (msg.method === 'Network.loadingFailed' && msg.params.type === 'Document') problems.push(`navigation failed: ${msg.params.errorText}`);
  };
  const send = (method, params = {}, sid) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, method }); ws.send(JSON.stringify({ id, method, params, sessionId: sid })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const cmd = (method, params) => send(method, params, sessionId);
  for (const d of ['Runtime', 'Log', 'Page', 'Network']) await cmd(`${d}.enable`);
  const evaluate = async (expression) => {
    const r = await cmd('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };
  const waitFor = async (cond, ms = 15000) => {
    const t0 = Date.now();
    for (;;) {
      try { if (await evaluate(`return !!(${cond});`)) return true; } catch { /* navigating */ }
      if (Date.now() - t0 > ms) return false;
      await sleep(100);
    }
  };
  const loaded = () => waitFor(`document.readyState === 'complete'`);
  const goto = async (url) => { await cmd('Page.navigate', { url }); await sleep(150); return loaded(); };
  const reload = async () => { await cmd('Page.reload'); await sleep(150); return loaded(); };
  // the page is there and an analysis gives a result
  const works = async (what) => {
    // (a reload restores the state from the fragment and analyzes it at once: while that runs, the button is
    // "Cancel", and a click would stop it; wait until it is "Analyze" again)
    const ready = await waitFor(`document.getElementById('run') && !document.getElementById('run').disabled && !document.getElementById('run').classList.contains('busy')`);
    let r = { ready };
    if (ready) {
      r = await evaluate(`
        const $ = (id) => document.getElementById(id);
        const n = $('results').dataset.run; $('run').click();
        const t0 = Date.now(); while ($('results').dataset.run === n && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 50));
        return { ready: true, path: location.pathname, tp: document.querySelector('.tp .value')?.textContent ?? null, error: document.querySelector('.error-box')?.textContent ?? '',
          controlled: !!navigator.serviceWorker.controller };`);
    }
    const p = problems.splice(0);
    check(r.ready && /^\d+\.\d\d$/.test(r.tp ?? '') && !r.error && p.length === 0, `${what}: the page renders and an analysis works`, JSON.stringify({ ...r, problems: p }));
    return r;
  };

  // first visit (no worker yet) at the address that the host redirects
  await goto(`${origin}/index.html`);
  const first = await works('first visit, at /index.html');
  check(first.path === '/', 'first visit: /index.html is redirected to /', first.path);
  // the worker has installed (everything cached) and controls the page
  const installed = await waitFor(`/works offline/.test(document.getElementById('status').textContent)`, 60000);
  if (!(await evaluate('return !!navigator.serviceWorker.controller'))) await reload();
  const controlled = await evaluate('return !!navigator.serviceWorker.controller');
  check(installed && controlled, 'the service worker installs and controls the page', JSON.stringify({ installed, controlled }));
  for (const n of [1, 2]) {
    await reload();
    const r = await works(`reload ${n}`);
    check(r.controlled, `reload ${n}: served by the service worker`);
  }
  // /index.html again, now with the worker (which answers it from its cache)
  await goto(`${origin}/index.html`);
  await works('a visit to /index.html');
  await reload();
  await works('a reload after the visit to /index.html');
  await goto('about:blank');
  await goto(`${origin}/`);
  await works('a new visit after /index.html');
  // offline
  await stop();
  await goto('about:blank');
  await goto(`${origin}/`);
  await works('offline visit');
  await reload();
  await works('offline reload');
  ws.close();
} catch (e) {
  check(false, 'the test ran', e.stack);
} finally {
  cleanup();
  server.close();
}
console.log(`${count} host checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
