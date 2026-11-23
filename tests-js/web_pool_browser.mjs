// End-to-end test of the worker pool (web/js/pool.js) in the built site (web/dist), in headless Chrome over the DevTools
// protocol; no dependencies (Node 22+). Run web/build.sh first.
//
//    node tests-js/web_pool_browser.mjs [--chrome PATH] [--reps N] [--timing-only] [--dist DIR]
//
//  1. The table of all CPUs, the alignment sweep and the cost column of every example (basics and classic loops) are
//     the same with the pool as without it (?pool=0: everything in the main analyzer's worker, as before the pool).
//  2. The pool is made only when a view needs it; the table of all CPUs loads each table into one worker only; the
//     pool's memory after it is printed, and after a sweep on every CPU, one after another (each copies its table into
//     every worker): no worker holds more tables than the pool's cap.
//  3. Timings for the GEMM example (median of --reps fresh pages, default 3): each view alone, cold (fresh workers,
//     tables not loaded) and warm (another input), with the pool and with ?pool=0. --dist DIR times another build (e.g.
//     one made before the pool) the same way; --timing-only skips 1 and 2; --small also times a small block (the first
//     example), --big a block of 49 adds.
// Skips (exit 0) without Chrome.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';
import { EXAMPLES, CLASSIC_EXAMPLES } from '../web/js/examples.js';
import { DEFAULT_STATE, encodeState } from '../web/js/url-state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dist = path.resolve(opt('--dist') || path.join(here, '..', 'web', 'dist'));
const reps = Number(opt('--reps') || 3);
const timingOnly = args.includes('--timing-only');
const chrome = findChrome(opt('--chrome'));
if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.log(`${dist} has no build: run web/build.sh first`); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GEMM = CLASSIC_EXAMPLES.find((e) => e.id === 'gemm');
// 49 different adds (add r64, r64 without rsp); dec r15; jnz (rel32)
const BIG_BODY = Array.from({ length: 64 }, (_, i) => i).filter((i) => (i & 7) !== 4 && (i >> 3) !== 4).map((i) => '4801' + (0xc0 + i).toString(16)).join('') + '49ffcf';
const BIG_HEX = BIG_BODY + '0f85' + (0x100000000 - (BIG_BODY.length / 2 + 6)).toString(16).padStart(8, '0').match(/../g).reverse().join('');
const BIG = { id: 'big', arch: 'SKL', text: { hex: BIG_HEX } };

// ---- server and browser (as in web_insight_browser.mjs) ---------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  requests.push(url.pathname);
  let p = path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
  if (!p.startsWith(dist)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-pool-test-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = '';
  proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
  proc.on('exit', () => reject(new Error('Chrome exited: ' + err.slice(0, 500))));
  setTimeout(() => reject(new Error('Chrome did not start')), 20000);
});

let seq = 0;
const pending = new Map(), handlers = [];
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot connect to Chrome')); });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result); }
  else for (const h of handlers) h(msg);
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, method }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

async function openPage() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const page = { sessionId, problems: [] };
  handlers.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') page.problems.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(m.params.type)) page.problems.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  page.cmd = (method, params) => send(method, params, sessionId);
  page.eval = async (expression) => {
    const r = await page.cmd('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };
  page.goto = async (url) => {
    await page.cmd('Page.navigate', { url });
    await sleep(150);
    for (let t = 0; t < 200; t++) { try { if (await page.eval(`return document.readyState === 'complete'`)) return; } catch { /* navigating */ } await sleep(100); }
    throw new Error('page did not load');
  };
  for (const d of ['Runtime', 'Page']) await page.cmd(`${d}.enable`);
  await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  page.close = () => page.cmd('Page.close').catch(() => {});
  return page;
}

const HELPERS = `
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 60000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + f); await wait(5); } };
  const body = () => $('result-body');
  // a view whose estimated time is over its budget (compare-view.js, insight-view.js: from the main analysis's time, so on a
  // slow machine too) waits for a click on its run button: click it, the test needs the results either way
  const runAnyway = () => { for (const b of document.querySelectorAll('.cmp-run, .ins-cost-status button')) b.click(); };
  const runs = (id) => Number($(id).dataset.runs ?? 0);
  const costRuns = () => Number(body().dataset.costRuns ?? 0);
  const done = async (start) => { const n = $('results').dataset.run; start(); await until(() => $('results').dataset.run !== n); };
  const instrRows = () => [...document.querySelectorAll('table.uops tbody tr')];
  const collect = () => ({
    tp: document.querySelector('.tp .value')?.textContent,
    cpus: [...document.querySelectorAll('table.cmp-cpus tbody tr')].map((tr) => [tr.dataset.arch, tr.querySelector('.cmp-tp').textContent, tr.querySelector('.cmp-tp').title, tr.querySelector('.cmp-bn').textContent].join('|')),
    sweep: [...document.querySelectorAll('.sweep-chart rect.hit')].map((r) => r.textContent),
    cost: instrRows().map((tr) => { const td = tr.querySelector('td.ins-cost'); return td ? td.textContent + '|' + (td.title ?? '') : null; }),
  });
`;
const link = (ex, extra = {}, query = '') => `${origin}/?nosw=1${query}#${encodeState({ ...DEFAULT_STATE, mode: 'hex', text: ex.text.hex, arch: ex.arch, ...extra })}`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

try {
  if (!timingOnly) {
    // --- 1. the same results with and without the pool ---------------------------------------------------------------------
    for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES]) {
      const got = {};
      for (const [mode, query] of [['single', '&pool=0'], ['pool', '']]) {
        const page = await openPage();
        await page.goto(link(ex, { cpus: 'all', cmpSweep: true, cost: true }, query));
        got[mode] = await page.eval(`${HELPERS}
          await until(() => {
            runAnyway();
            return document.querySelector('.tp .value') && $('cmp-cpus').dataset.state === 'done' && $('cmp-sweep').dataset.state === 'done' && body().dataset.cost === 'done';
          });
          const out = collect();
          out.pool = !!window.__wuicaPool;
          out.workers = window.__wuicaPool?.workers ?? 0;
          return out;`);
        check(page.problems.length === 0, `${ex.id} (${mode}): no console errors`, page.problems.join('\n'));
        await page.close();
      }
      const { single, pool } = got;
      check(single.cpus.length === 15 && single.sweep.length === 64 && single.cost.filter(Boolean).length > 2, `${ex.id}: the views are complete`, JSON.stringify(single).slice(0, 300));
      check(!single.pool && pool.pool && pool.workers > 1, `${ex.id}: ?pool=0 has no pool; the default has one with several workers`, JSON.stringify([single.pool, pool.pool, pool.workers]));
      for (const k of ['tp', 'cpus', 'sweep', 'cost']) {
        check(JSON.stringify(single[k]) === JSON.stringify(pool[k]), `${ex.id}: ${k} the same with the pool`, JSON.stringify([single[k], pool[k]]).slice(0, 600));
      }
    }

    // --- 2. lazy, one table per worker for all CPUs, memory ------------------------------------------------------------------
    {
      const page = await openPage();
      await page.goto(link(GEMM));
      const r = await page.eval(`${HELPERS}
        await until(() => document.querySelector('.tp .value'));
        await wait(300);
        const out = { before: window.__wuicaPool === undefined };
        const n = runs('cmp-cpus');
        $('cpu-all').click(); // every CPU checked: the table of all of them
        await until(() => (runAnyway(), runs('cmp-cpus') > n));
        const pool = window.__wuicaPool;
        out.size = pool.size;
        out.stats = await pool.stats();
        const m = runs('cmp-sweep'), c = costRuns();
        document.querySelector('#cmp-sweep summary').click();
        document.querySelector('.ins-cost-box').click();
        await until(() => (runAnyway(), runs('cmp-sweep') > m && costRuns() > c));
        out.all = await pool.stats();
        // a sweep (64 analyses) on every CPU, one after another, straight on the pool
        const hex = ${JSON.stringify(GEMM.hex)};
        const archs = [...document.querySelectorAll('#cpu-grid input[type=checkbox]')].map((b) => b.value);
        out.sweepsOk = true;
        for (const arch of archs) {
          const items = Array.from({ length: 64 }, (_, k) => ({ request: { hex, arch, alignmentOffset: k } }));
          const ok = await pool.run(items, { onResult: (_, r, e) => { if (e || r?.error) { out.sweepsOk = false; out.sweepError ??= arch + ': ' + (e?.message ?? r.error); } } });
          out.sweepsOk &&= ok;
        }
        out.archs = archs.length;
        out.sweeps = await pool.stats();
        out.cap = pool.maxTables ?? null;
        out.recycles = pool.counts.recycles ?? 0;
        out.tableLoads = pool.counts.tableLoads ?? 0;
        return out;`);
      const tables = r.stats.flatMap((s) => s.tables);
      check(r.before, 'lazy: no pool before a view needs one');
      // the focused CPU's row is the main result (not analyzed again): the other 14 tables, each in one worker
    check(r.stats.length === r.size && tables.length === 14 && new Set(tables).size === 14 && !tables.includes(GEMM.arch), 'all CPUs: each table in one worker only; the focused CPU comes from the main analysis', JSON.stringify(r.stats));
      const tableReqs = requests.filter((p) => p.startsWith('/data/arch/'));
      const wasm = r.stats.reduce((n, s) => n + s.wasmBytes, 0), kept = r.stats.reduce((n, s) => n + s.tableBytes, 0);
      console.log(`pool after the table of all CPUs (GEMM): ${r.stats.length} workers, tables ${JSON.stringify(r.stats.map((s) => s.tables))}`);
      console.log(`  WebAssembly memory ${r.stats.map((s) => (s.wasmBytes / 1048576).toFixed(1)).join(' + ')} = ${(wasm / 1048576).toFixed(1)} MiB; table bytes kept in the workers ${(kept / 1048576).toFixed(1)} MiB`);
      const wasmAll = r.all.reduce((n, s) => n + s.wasmBytes, 0), keptAll = r.all.reduce((n, s) => n + s.tableBytes, 0);
      console.log(`  with the sweep and the cost column as well (SKL in every worker): WebAssembly memory ${(wasmAll / 1048576).toFixed(1)} MiB; table bytes ${(keptAll / 1048576).toFixed(1)} MiB`);
      const ws = r.sweeps, wasmS = ws.reduce((n, s) => n + s.wasmBytes, 0), keptS = ws.reduce((n, s) => n + s.tableBytes, 0);
      console.log(`  after a sweep on each of the ${r.archs} CPUs (cap ${r.cap ?? 'none'}, ${r.recycles} recycles): tables per worker ${JSON.stringify(ws.map((s) => s.tables.length))}`);
      console.log(`  WebAssembly memory ${ws.map((s) => (s.wasmBytes / 1048576).toFixed(1)).join(' + ')} = ${(wasmS / 1048576).toFixed(1)} MiB; table bytes kept in the workers ${(keptS / 1048576).toFixed(1)} MiB`);
      check(r.sweepsOk && r.archs === 15, 'sweeps on every CPU: every result', JSON.stringify([r.sweepsOk, r.archs, r.sweepError]));
      // (how many workers take part in each sweep, and so how many tables each loads, depends on timing: a worker must have
      // been recycled when the tables loaded could not all fit under the cap)
      if (r.cap !== null) check(ws.every((s) => s.tables.length <= r.cap) && (r.recycles > 0 || r.tableLoads <= r.cap * r.size), 'sweeps on every CPU: no worker over the cap', JSON.stringify([r.cap, r.recycles, r.tableLoads, ws.map((s) => s.tables)]));
      check(page.problems.length === 0, 'lazy: no console errors', page.problems.join('\n'));
      await page.close();
      check(tableReqs.length > 0, 'tables were fetched');
    }
  }

  // --- 3. timings ----------------------------------------------------------------------------------------------------------
  const TIME = `${HELPERS}
    await until(() => document.querySelector('.tp .value'));
    await wait(300);
    const t = async (start, cond) => { const t0 = performance.now(); start(); await until(cond); return Math.round((performance.now() - t0) * 10) / 10; };
    // the sweep opens and closes; the table of all CPUs comes with "all" and goes with "clear"
    const toggle = (id, on) => (id === 'cmp-cpus' ? $(on ? 'cpu-all' : 'cpu-clear').click() : document.querySelector('#' + id + ' summary').click());
    const panel = async (id) => {
      const n = runs(id);
      const ms = await t(() => toggle(id, true), () => (runAnyway(), runs(id) > n && $(id).dataset.state === 'done'));
      toggle(id, false);
      await wait(50);
      return ms;
    };
    const cost = async () => {
      const n = costRuns();
      const ms = await t(() => document.querySelector('.ins-cost-box').click(), () => (runAnyway(), costRuns() > n && body().dataset.cost === 'done'));
      document.querySelector('.ins-cost-box').click();
      await wait(50);
      return ms;
    };
    const out = { cold: {}, warm: {} };
    out.cold.cpus = await panel('cmp-cpus');
    out.cold.sweep = await panel('cmp-sweep');
    out.cold.cost = await cost();
    out.cold.costWork = Number(body().dataset.costMs ?? NaN);
    await done(() => { const r = document.querySelector('input[name=init][value=same]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
    out.warm.cpus = await panel('cmp-cpus');
    out.warm.sweep = await panel('cmp-sweep');
    out.warm.cost = await cost();
    out.warm.costWork = Number(body().dataset.costMs ?? NaN);
    out.workers = window.__wuicaPool?.workers ?? 0;
    out.recycles = window.__wuicaPool?.counts.recycles ?? 0;
    return out;`;
  const modes = opt('--dist') ? [['build', '']] : [['pool', ''], ['single (?pool=0)', '&pool=0']];
  const subjects = [GEMM, ...(args.includes('--small') ? [EXAMPLES[0]] : []), ...(args.includes('--big') ? [BIG] : [])];
  for (const subject of subjects) {
    const table = {};
    for (const [label, query] of modes) {
      const all = [];
      for (let i = 0; i < reps; i++) {
        const page = await openPage();
        await page.goto(link(subject, {}, query));
        all.push(await page.eval(TIME));
        await page.close();
      }
      const m = {};
      for (const phase of ['cold', 'warm']) for (const k of ['cpus', 'sweep', 'cost', 'costWork']) m[`${phase} ${k}`] = median(all.map((x) => x[phase][k]));
      m.workers = all[0].workers;
      m.recycles = Math.max(...all.map((x) => x.recycles));
      table[label] = m;
    }
    console.log(`${subject.id} timings in ms (median of ${reps}; ${dist}; cost: from the click, including its 100 ms delay; costWork: without it):`);
    console.table(table);
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  ws.close();
  proc.kill();
  server.close();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be writing its profile */ }
}

console.log(`${count} pool browser checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
