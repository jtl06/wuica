// The built site (web/dist) on a server that behaves like the host (tests-js/static-host.mjs: /index.html -> / with a 307,
// /404.html -> /404, a 404.html page), in headless Chrome with a fresh profile: the service worker takes control, and the page
// keeps working on reloads, after a visit to /index.html (the redirect) and offline. Regression test for a service worker
// that cached the redirected page and so made every second visit fail (ERR_FAILED).
// Then deploys: the host switches to other builds (the same files with another version stamp in manifest.json and sw.js).
// A visit after a deploy gets the old page from the cache; the page must end up on the new build by itself, with its
// state (the URL fragment), with one reload only, not while the user is typing, and not twice for one build (then the
// note in the footer stays).
//    web/build.sh && node tests-js/web_host_browser.mjs [--chrome PATH] [--dist DIR]
// Skips (exit 0) if Chrome is not found.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';
import { hostHandler, compressedByHost, transferSize } from './static-host.mjs';
import { BUDGET, SLACK } from './budgets.mjs';
import { stopChrome, readSettled } from './cdp.mjs';
import { DEFAULT_STATE, encodeState, decodeState } from '../web/js/url-state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dist = path.resolve(opt('--dist') ?? path.join(here, '../web/dist'));
const chrome = findChrome(opt('--chrome'));
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.error('web/dist is missing: run web/build.sh'); process.exit(1); }

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- other builds: links to the files of dist, with the version replaced in manifest.json and sw.js
const tmpBuilds = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-host-builds-'));
const versionA = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8')).version;
function build(tag) {
  const version = (tag.repeat(12) + versionA).slice(0, versionA.length);
  const dir = path.join(tmpBuilds, tag);
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(dist)) {
    if (f === 'manifest.json' || f === 'sw.js' || f === 'index.html') fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(dist, f), 'utf8').replaceAll(versionA, version));
    else fs.symlinkSync(path.join(dist, f), path.join(dir, f));
  }
  return { dir, version };
}

// ---- the server (stoppable, for the offline part)
const sockets = new Set();
let root = dist;
const requests = []; // the paths the page requested, in order
const requestTimes = []; // when (Date.now())
const server = http.createServer(hostHandler(() => root, { onRequest: (p) => { requests.push(p.replace(/\?.*$/, '')); requestTimes.push(Date.now()); } }));
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
  { // one policy, in the page and as a header (the header adds frame-ancestors, which a meta element cannot set)
    const meta = index.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
    const header = r.headers.get('content-security-policy');
    check(!!meta && header === `${meta}; frame-ancestors 'none'` && !/cloudflare|unsafe-inline/.test(header), 'host: the security policy as a response header equals the page\'s, plus frame-ancestors', JSON.stringify([meta, header]));
  }
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

// ---- the transfer sizes, with the host's compression rule (static-host.mjs: it compresses only the content types of
// its list): every file above 50 kB is either of a type the host compresses or compressed already (0.1.9 shipped its
// tables as .bin, application/octet-stream, which the host sends as they are: 6.4 MB instead of 0.8)
const BIG = 50 * 1024;
const PRECOMPRESSED = /\.(?:gz|br|woff2|png)$/;
{
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const bad = walk(dist).filter((f) => fs.statSync(f).size > BIG && !compressedByHost(f) && !PRECOMPRESSED.test(f)).map((f) => path.relative(dist, f));
  check(bad.length === 0, 'host: every file above 50 kB is of a type the host compresses, or compressed already', bad.join(', '));
}
// the budgets (tests-js/budgets.mjs, shared with scripts/smoke-live.mjs, which checks the deployed site)
const sizeOf = (p) => { const f = path.join(dist, p.replace(/^\//, '')); try { return fs.statSync(f).isFile() ? transferSize(f) : 0; } catch { return 0; } };

// ---- 2. the page in Chrome
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-host-test-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
// (the folders after Chrome's exit: it writes to its profile until then, and a profile removed before that was left in
// the temp folder, half written, on every run)
const cleanup = () => stopChrome(proc, [tmp, tmpBuilds]);
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
  let navigations = 0; // of the main frame
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result); return; }
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) navigations++;
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
  // (the requests until the default example's result is on the page: the moment it appeared, from the page's clock)
  await waitFor(`document.querySelector('#result-body .tp .value')`, 60000);
  const shownAt = await evaluate(`return performance.timeOrigin + (performance.getEntriesByName('wuica-first-result')[0]?.startTime ?? performance.now());`);
  const firstRequests = new Set(requests.filter((p, i) => p !== '/index.html' && requestTimes[i] <= shownAt));
  check(!firstRequests.has('/wuica_asm.wasm'), 'first visit: the default example\'s result does not wait for the assembler', [...firstRequests].filter((p) => /wasm/.test(p)).join());
  const first = await works('first visit, at /index.html');
  check(first.path === '/', 'first visit: /index.html is redirected to /', first.path);
  // the worker has installed (everything cached) and controls the page
  const installed = await waitFor(`/works offline/.test(document.getElementById('status').textContent)`, 60000);
  if (!(await evaluate('return !!navigator.serviceWorker.controller'))) await reload();
  const controlled = await evaluate('return !!navigator.serviceWorker.controller');
  check(installed && controlled, 'the service worker installs and controls the page', JSON.stringify({ installed, controlled }));
  {
    // (which tables come with the first visit depends on timing: the prefetch is measured as all the tables, once each)
    const tableCount = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8')).tables.length;
    const allTables = () => new Set(requests.filter((p) => p.startsWith('/data/arch/')));
    for (let i = 0; i < 300 && allTables().size < tableCount; i++) await sleep(200);
    const firstVisit = [...firstRequests].reduce((n, p) => n + sizeOf(p), 0);
    const tables = allTables();
    const prefetch = [...tables].reduce((n, p) => n + sizeOf(p), 0);
    console.log(`transfer (host's rule): first visit ${firstVisit} bytes in ${firstRequests.size} files; the ${tables.size} tables ${prefetch} bytes`);
    check(firstVisit <= BUDGET.firstVisit * SLACK, `first visit transfers at most ${BUDGET.firstVisit} bytes + 10%`, firstVisit);
    check(tables.size === tableCount && prefetch <= BUDGET.tables * SLACK, `the tables (the idle prefetch fetches them all) transfer at most ${BUDGET.tables} bytes + 10%`, `${prefetch} in ${tables.size} of ${tableCount}`);
  }
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

  // ---- deploys
  // (in a loaded document that has the elements; read again if the page replaced it meanwhile: it reloads itself)
  const shown = () => readSettled(evaluate, `return { build: document.getElementById('build-id').textContent, hash: location.hash, note: !document.getElementById('update-note').hidden,
    text: document.getElementById('code').value, controller: navigator.serviceWorker.controller?.scriptURL ?? null };`,
  { ready: `document.getElementById('run')?.disabled === false && document.getElementById('update-note') && document.getElementById('build-id') && document.getElementById('code')` }); // (started: the footer has its build)
  const settled = async (version, what) => {
    const ok = await waitFor(`document.getElementById('build-id')?.textContent === ${JSON.stringify(version)} && document.readyState === 'complete'`, 60000);
    check(ok, `${what}: the page is the new build`, JSON.stringify(ok ? null : await shown().catch((e) => e.message)));
    return ok;
  };
  const stateOf = (hash) => { const s = decodeState(hash.replace(/^#/, '')); return s && JSON.stringify({ text: s.text, arch: s.arch, cpus: s.cpus, mode: s.mode, al: s.alignmentOffset }); };
  // a page with state of its own: hex input, another CPU, two CPUs checked, an alignment offset
  const frag = encodeState({ ...DEFAULT_STATE, mode: 'hex', text: '48 01 d8\n48 01 c3\n49 ff cf\n75 f5\n', arch: 'ZEN3', cpus: 'ZEN3,SKL', alignmentOffset: 5 });
  await goto(`${origin}/#${frag}`);
  await works('build A with state');
  check(await waitFor(`/works offline/.test(document.getElementById('status').textContent)`, 60000), 'build A: works offline');
  const before = await shown();

  // deploy B, then a new visit: the old page from the cache, which reloads itself into B
  const B = build('b');
  root = B.dir;
  await goto('about:blank');
  let n0 = navigations;
  await goto(`${origin}/#${frag}`);
  if (await settled(B.version, 'deploy B, a visit')) {
    await sleep(3000); // no second reload
    const r = await shown();
    check(navigations - n0 === 2, 'deploy B: one reload, then no more', `${navigations - n0 - 1} reloads`);
    check(r.hash === before.hash && stateOf(r.hash) === stateOf(before.hash) && stateOf(r.hash) !== null && r.text === before.text && !r.note, 'deploy B: the state is the same, no note', JSON.stringify({ before, r }));
    await works('deploy B: after the reload');
  }
  check(await waitFor(`/works offline/.test(document.getElementById('status').textContent)`, 60000), 'build B: works offline');

  // deploy C while the page is open and the user types: no reload until typing stops; the typed text survives
  const C = build('c');
  root = C.dir;
  n0 = navigations;
  await evaluate(`navigator.serviceWorker.getRegistration().then((r) => r.update()); return true;`);
  // type every 200 ms until the new worker has taken over (the note shows), and for 2 s after that
  let typed = 0, reloadedWhileTyping = false, why = '', noteAt = 0;
  for (const t0 = Date.now(); Date.now() - t0 < 30000 && !(noteAt && Date.now() - noteAt > 2000); typed++) {
    try {
      const note = await evaluate(`const c = document.getElementById('code'); c.value += '90\\n'; c.dispatchEvent(new Event('input', { bubbles: true })); return !document.getElementById('update-note').hidden;`);
      if (note && !noteAt) noteAt = Date.now();
    } catch (e) { reloadedWhileTyping = true; why = e.message; break; }
    if (navigations !== n0) { reloadedWhileTyping = true; why = 'navigated'; break; }
    await sleep(200);
  }
  check(!reloadedWhileTyping && noteAt > 0, 'deploy C: no reload while typing (the note shows meanwhile)', JSON.stringify({ reloadedWhileTyping, why, typed, noteAt }));
  if (await settled(C.version, 'deploy C, typing stopped')) {
    await sleep(3000);
    const r = await shown();
    check(navigations - n0 === 1, 'deploy C: one reload', `${navigations - n0} reloads`);
    check(r.text === before.text + '90\n'.repeat(typed) && decodeState(r.hash.slice(1))?.text === r.text && !r.note, 'deploy C: the typed text survives the reload', JSON.stringify({ r, typed }));
    await works('deploy C: after the reload');
  }

  // deploy D after an automatic reload for D in this tab: no reload, the note stays; its button reloads
  const D = build('d');
  await evaluate(`sessionStorage.setItem('wuica-update-reload', ${JSON.stringify(D.version)}); return true;`);
  root = D.dir;
  n0 = navigations;
  await evaluate(`navigator.serviceWorker.getRegistration().then((r) => r.update()); return true;`);
  const noted = await waitFor(`document.getElementById('update-note')?.hidden === false`, 30000);
  await sleep(3000);
  const r = await shown();
  check(noted && navigations === n0 && r.build === C.version && r.note, 'deploy D, already reloaded for D: the note, no reload', JSON.stringify({ noted, reloads: navigations - n0, r }));
  await evaluate(`document.getElementById('reload').click(); return true;`);
  await sleep(300);
  if (await settled(D.version, 'deploy D, the note\'s button')) await works('deploy D: after the reload by hand');
  check(await waitFor(`/works offline/.test(document.getElementById('status').textContent)`, 60000), 'build D: works offline');

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
  server.close();
  await cleanup();
}
console.log(`${count} host checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
