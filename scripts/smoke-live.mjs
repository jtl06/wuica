#!/usr/bin/env node
// A smoke test of the deployed site and API, after a deploy: it only reads (GET, and one analyze, compare and what_if as
// any visitor sends them); it deploys nothing. scripts/smoke-live.sh runs it.
//
//   node scripts/smoke-live.mjs VERSION [--site URL] [--api URL] [--chrome PATH] [--no-site] [--no-api]
//
// Site (default https://wuica.jacen.li), in headless Chrome with a fresh profile:
//   - the page's version (the footer) is VERSION;
//   - the service worker's cache: the stamp in /sw.js (a hash of the build's files, web/build.sh) names the cache the worker
//     opens (caches.keys() after it installs); with a local build in web/dist of the same files, the stamps are equal;
//   - one analysis (the default example) gives a throughput;
//   - the bytes on the wire (what Chrome received, headers included; the worker bypassed, each file once) of the first
//     visit and of all the tables (the idle prefetch) are within tests-js/budgets.mjs (+10%): the check whose absence let uncompressed tables ship in 0.1.9.
//     Also: the analyzer, the assembler and the tables come compressed (content-encoding, or the precompressed .gz).
// API (default https://api.wuica.jacen.li): /healthz, /api/version (wuica and server are VERSION), one analyze, one
// compare, MCP tools/list (at least the five tools of 0.1.9) and one what_if.
// Exit status 1 if a check fails.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../tests-js/chrome.mjs';
import { BUDGET, SLACK } from '../tests-js/budgets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(name);
const VALUED = new Set(['--site', '--api', '--chrome']);
const version = args.find((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1])) ?? null;
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) { console.error('usage: node scripts/smoke-live.mjs VERSION [--site URL] [--api URL] [--chrome PATH] [--no-site] [--no-api]'); process.exit(2); }
const SITE = (opt('--site') ?? 'https://wuica.jacen.li').replace(/\/$/, '');
const API = (opt('--api') ?? 'https://api.wuica.jacen.li').replace(/\/$/, '');
const HEX = '4801d84801c349ffcf75f5'; // add rax, rbx; add rbx, rax; dec r15; jnz: 2.00 cycles per iteration on SKL

let failed = 0, count = 0;
const check = (cond, what, detail = '') => { count++; console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}${detail !== '' ? `: ${detail}` : ''}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchT = (url, init = {}, ms = 20000) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

// ---- the API -----------------------------------------------------------------------------------------------------
async function api() {
  console.log(`API ${API}`);
  const json = async (p, body) => {
    const r = await fetchT(API + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const h = await json('/healthz');
    check(h.status === 200 && h.body?.ok === true, 'GET /healthz', JSON.stringify(h.body));
    const v = await json('/api/version');
    check(v.status === 200 && v.body?.wuica === version && v.body?.server === version, `GET /api/version: wuica and server ${version}`, JSON.stringify({ wuica: v.body?.wuica, server: v.body?.server, uiCA: v.body?.uiCA?.commit }));
    const a = await json('/api/analyze/SKL', { hex: HEX });
    check(a.status === 200 && a.body?.code === 0 && a.body?.tp === 2, 'POST /api/analyze/SKL: 2.00 cycles per iteration', JSON.stringify({ status: a.status, code: a.body?.code, tp: a.body?.tp }));
    const c = await json('/api/compare', { hex: HEX, archs: ['SKL', 'ZEN3'] });
    check(c.status === 200 && c.body?.code === 0 && c.body?.results?.length === 2 && c.body.results.every((x) => x.code === 0), 'POST /api/compare (SKL, ZEN3)', JSON.stringify(c.body?.results?.map((x) => [x.arch, x.tp])));
    const rpc = async (id, method, params) => {
      const r = await fetchT(`${API}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) }, 60000);
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const t = await rpc(1, 'tools/list');
    const names = (t.body?.result?.tools ?? []).map((x) => x.name).sort().join(',');
    const want = ['analyze', 'assemble', 'compare_archs', 'list_archs', 'what_if']; // (and the newer ones: diff_blocks, list_loops)
    check(t.status === 200 && want.every((n) => names.split(',').includes(n)), 'MCP tools/list', names || JSON.stringify(t.body));
    const w = await rpc(2, 'tools/call', { name: 'what_if', arguments: { source: 'loop:\n vaddps ymm0, ymm0, ymm1\n dec rcx\n jnz loop\n', arch: 'SKL' } });
    const text = w.body?.result?.content?.[0]?.text ?? '';
    check(w.status === 200 && !w.body?.result?.isError && /accumulators/.test(text), 'MCP tools/call what_if', text.slice(0, 80).replace(/\s+/g, ' ') || JSON.stringify(w.body));
  } catch (e) {
    check(false, 'API reachable', e.message);
  }
}

// ---- the site ------------------------------------------------------------------------------------------------------
async function site() {
  console.log(`site ${SITE}`);
  const chrome = findChrome(opt('--chrome'));
  if (!chrome) { check(false, 'Chrome found (use --chrome PATH)'); return; }
  // the service worker's stamp: /sw.js, and the local build's
  let stamp = null;
  try {
    const sw = await (await fetchT(`${SITE}/sw.js`, { cache: 'no-store' })).text();
    stamp = /^const VERSION = '([^']+)';/m.exec(sw)?.[1] ?? null;
    check(/^[0-9a-f]{12}$/.test(stamp ?? ''), 'GET /sw.js: a build stamp', String(stamp));
    const local = path.join(ROOT, 'web/dist/sw.js');
    if (fs.existsSync(local)) {
      const mine = /^const VERSION = '([^']+)';/m.exec(fs.readFileSync(local, 'utf8'))?.[1];
      console.log(`      (web/dist here is build ${mine}${mine === stamp ? ', the same' : ': another build than the live one'})`);
    }
  } catch (e) { check(false, 'GET /sw.js', e.message); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-smoke-'));
  const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let err = '';
      proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
      proc.on('exit', () => reject(new Error('Chrome exited: ' + err.slice(0, 300))));
      setTimeout(() => reject(new Error('Chrome did not start')), 20000);
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot connect to Chrome')); });
    let seq = 0, sessionId;
    const pending = new Map(), problems = [];
    const reqs = new Map(); // requestId -> {url, encoding, bytes, done, t}
    let phase = 'first';
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result); return; }
      if (msg.sessionId !== sessionId) return;
      const q = msg.params;
      if (msg.method === 'Network.requestWillBeSent') reqs.set(q.requestId, { url: q.request.url, phase, bytes: 0, done: false, encoding: '', status: 0 });
      if (msg.method === 'Network.responseReceived' && reqs.has(q.requestId)) {
        const r = reqs.get(q.requestId);
        r.status = q.response.status;
        r.fromServiceWorker = q.response.fromServiceWorker;
        r.encoding = Object.entries(q.response.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-encoding')?.[1] ?? '';
      }
      if (msg.method === 'Network.loadingFinished' && reqs.has(q.requestId)) Object.assign(reqs.get(q.requestId), { bytes: q.encodedDataLength, done: true });
      if (msg.method === 'Runtime.exceptionThrown') problems.push(q.exceptionDetails.exception?.description ?? q.exceptionDetails.text);
    };
    const send = (method, params = {}, sid) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, method }); ws.send(JSON.stringify({ id, method, params, sessionId: sid })); });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const cmd = (method, params) => send(method, params, sessionId);
    for (const d of ['Runtime', 'Page', 'Network']) await cmd(`${d}.enable`);
    await cmd('Network.setCacheDisabled', { cacheDisabled: true });
    // every request of the page goes to the network and is seen here (the worker still installs and fills its cache)
    await cmd('Network.setBypassServiceWorker', { bypass: true });
    const evaluate = async (expression) => {
      const r = await cmd('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (cond, ms) => {
      const t0 = Date.now();
      for (;;) {
        try { if (await evaluate(`return !!(${cond});`)) return true; } catch { /* loading */ }
        if (Date.now() - t0 > ms) return false;
        await sleep(100);
      }
    };
    // the first visit: until the default example's result (a fresh visit analyzes it once by itself)
    await cmd('Page.navigate', { url: `${SITE}/` });
    const shown = await waitFor(`/^\\d+\\.\\d\\d$/.test(document.querySelector('.tp .value')?.textContent ?? '')`, 60000);
    phase = 'later';
    const page = await evaluate(`return { version: document.getElementById('app-version')?.textContent ?? null, tp: document.querySelector('.tp .value')?.textContent ?? null, error: document.querySelector('.error-box')?.textContent ?? '' };`).catch((e) => ({ error: e.message }));
    check(page.version === version, `the page's version (footer) is ${version}`, String(page.version));
    check(shown && !page.error, 'an analysis (the default example) gives a throughput', JSON.stringify(page));
    // the service worker installs and opens the cache named after the stamp
    const installed = await waitFor(`navigator.serviceWorker.controller || /works offline/.test(document.getElementById('status')?.textContent ?? '')`, 60000);
    const keys = await evaluate('return await caches.keys();').catch(() => []);
    check(installed && stamp !== null && keys.includes(`wuica-${stamp}`), `the service worker's cache is wuica-${stamp}`, JSON.stringify({ installed, keys }));
    // the idle prefetch of the tables
    const isTable = (u) => new URL(u).pathname.startsWith('/data/arch/');
    let tableCount = 15;
    try { tableCount = (await (await fetchT(`${SITE}/manifest.json`, { cache: 'no-store' })).json()).tables.length; } catch { /* the default */ }
    for (let i = 0; i < 300; i++) {
      const tables = new Set([...reqs.values()].filter((r) => isTable(r.url) && r.done && !r.fromServiceWorker).map((r) => new URL(r.url).pathname));
      if (tables.size >= tableCount) break;
      await sleep(200);
    }
    const net = [...reqs.values()].filter((r) => r.done && !r.fromServiceWorker && new URL(r.url).origin === new URL(SITE).origin);
    // (each file once, as tests-js/budgets.mjs counts them)
    const once = (list) => [...new Map(list.map((r) => [new URL(r.url).pathname, r])).values()];
    const first = once(net.filter((r) => r.phase === 'first'));
    const firstBytes = first.reduce((n, r) => n + r.bytes, 0);
    const tableReqs = new Map();
    for (const r of net.filter((x) => isTable(x.url))) if (!tableReqs.has(new URL(r.url).pathname)) tableReqs.set(new URL(r.url).pathname, r);
    const tableBytes = [...tableReqs.values()].reduce((n, r) => n + r.bytes, 0);
    console.log(`      on the wire: first visit ${firstBytes} bytes in ${first.length} requests; ${tableReqs.size} tables ${tableBytes} bytes`);
    check(firstBytes > 0 && firstBytes <= BUDGET.firstVisit * SLACK, `first visit: at most ${BUDGET.firstVisit} bytes + 10% on the wire`, firstBytes);
    check(tableReqs.size === tableCount && tableBytes <= BUDGET.tables * SLACK, `the ${tableCount} tables: at most ${BUDGET.tables} bytes + 10% on the wire`, `${tableBytes} in ${tableReqs.size}`);
    const big = net.filter((r) => /\.(wasm|js|json)$|\/data\/arch\//.test(new URL(r.url).pathname) && r.bytes > 50_000);
    const raw = big.filter((r) => !r.encoding && !/\.gz$/.test(new URL(r.url).pathname)).map((r) => `${new URL(r.url).pathname} ${r.bytes}`);
    check(raw.length === 0, 'the large files (analyzer, assembler, tables) come compressed', raw.join(', '));
    check(problems.length === 0, 'no exceptions in the page', problems.slice(0, 3).join(' | '));
    ws.close();
  } catch (e) {
    check(false, 'the site in Chrome', e.message);
  } finally {
    try { proc.kill(); } catch { /* gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* busy */ }
  }
}

if (!flag('--no-api')) await api();
if (!flag('--no-site')) await site();
console.log(`${count} live checks, ${failed} failed (version ${version})`);
process.exit(failed ? 1 : 0);
