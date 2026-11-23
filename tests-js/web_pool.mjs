// Tests of the worker pool (web/js/pool.js): scheduling with fake engines (which tables go where, how many workers,
// latest-wins, stopping, traps, failures), then, if the analyzer has been built, the pool over real engines in workers
// that run in this thread, against the same analyses made one at a time (all CPUs, sweep and cost of every example).
// Usage: node tests-js/web_pool.mjs
import fs from 'node:fs';
import { createPool, poolSize, POOL_MAX } from '../web/js/pool.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { WorkerEngine, createHandler, CancelledError } from '../web/js/engine-rpc.js';
import { archGroups } from '../web/js/archs.js';
import { EXAMPLES, CLASSIC_EXAMPLES } from '../web/js/examples.js';
import { costUnits, costJobs } from '../web/js/insight.js';
import { SWEEP_OFFSETS } from '../web/js/compare.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pool size -----------------------------------------------------------------------------------------------------
check(poolSize(1) === 1 && poolSize(2) === 1 && poolSize(4) === 3 && poolSize(12) === POOL_MAX && poolSize(64, 4) === 4, 'size: cores - 1, at least 1, capped');
check(poolSize(null) === 1 && poolSize(0) === 1 && poolSize(NaN) === 1, 'size: unknown core count: 1');

// ---- fake engines ----------------------------------------------------------------------------------------------------
// An engine like WorkerEngine: loadArch takes `loadMs`, analyze `ms(request)`; cancel() rejects what is pending with
// CancelledError and "restarts" (the tables stay loaded, as in WorkerEngine, which loads them into the new worker).
function world({ loadMs = 5, ms = () => 3, failSpawn = 0 } = {}) {
  const w = { engines: [], loads: [], running: 0, maxRunning: 0, analyses: [], spawnFails: failSpawn, bytesAsked: [] };
  w.spawn = async () => {
    await sleep(1);
    if (w.spawnFails > 0) { w.spawnFails--; throw new Error('no worker'); }
    const e = { id: w.engines.length, tables: new Set(), pending: new Set(), restarts: 0, crashNext: 0 };
    e.hasArch = (t) => e.tables.has(t);
    e.loadArch = (t, bytes) => new Promise((resolve, reject) => {
      const p = { reject }; e.pending.add(p);
      setTimeout(() => { if (!e.pending.delete(p)) return; if (t === 'BAD') { reject(new Error('bad table')); return; } e.tables.add(t); w.loads.push([e.id, t, bytes.length]); resolve(); }, loadMs);
    });
    e.analyze = (request) => new Promise((resolve, reject) => {
      if (!e.tables.has(w.tableOf(request.arch))) { resolve({ error: 'table not loaded' }); return; }
      w.running++; w.maxRunning = Math.max(w.maxRunning, w.running);
      const p = { reject: (x) => { w.running--; reject(x); } }; e.pending.add(p);
      setTimeout(() => {
        if (!e.pending.delete(p)) return;
        w.running--;
        w.analyses.push([e.id, request.arch, request.alignmentOffset]);
        if (e.crashNext > 0) { e.crashNext--; reject(new Error("the analyzer's worker failed")); return; }
        if (request.hex === 'cc') { resolve({ error: 'the analysis failed for this input', trapped: true }); return; }
        resolve({ tp: request.alignmentOffset + request.arch.length / 100, arch: request.arch, engine: e.id });
      }, ms(request));
    });
    e.cancel = () => { e.restarts++; for (const p of [...e.pending]) { e.pending.delete(p); p.reject(new CancelledError()); } };
    e.memory = async () => 1048576 * (1 + e.tables.size);
    w.engines.push(e);
    return e;
  };
  w.tableOf = (arch) => arch;
  w.tableBytes = async (name) => { w.bytesAsked.push(name); return new Uint8Array(name.length * 1000); };
  w.pool = (opts = {}) => createPool({ size: 4, spawn: w.spawn, tableOf: w.tableOf, tableBytes: w.tableBytes, ...opts });
  return w;
}
const ARCHS = ['SNB', 'IVB', 'HSW', 'BDW', 'SKL', 'KBL', 'SKX', 'CFL', 'CLX', 'ICL', 'TGL', 'ZEN3', 'RKL', 'ICX', 'ADL-P'];
const req = (arch, k = 0, hex = '90') => ({ request: { hex, arch, alignmentOffset: k }, arch, k });
const collect = () => { const got = []; return { got, onResult: (item, response, error) => got.push({ item, response, error }) }; };

// all CPUs: 15 tables, one job each -> every table in one worker only, all workers used, at most `size` at once
{
  const w = world();
  const pool = w.pool();
  const c = collect();
  const ok = await pool.run(ARCHS.map((a) => req(a)), c);
  check(ok === true && c.got.length === 15 && c.got.every((g) => !g.error && g.response.arch === g.item.arch), 'cpus: every job has its result', JSON.stringify(c.got.slice(0, 2)));
  check(w.engines.length === 4 && pool.workers === 4 && pool.counts.spawned === 4, 'cpus: 4 workers', String(w.engines.length));
  const loadedBy = new Map();
  for (const [e, t] of w.loads) loadedBy.set(t, [...(loadedBy.get(t) ?? []), e]);
  check(loadedBy.size === 15 && [...loadedBy.values()].every((l) => l.length === 1), 'cpus: each table is loaded into one worker only', JSON.stringify([...loadedBy]));
  const per = w.engines.map((e) => e.tables.size);
  check(Math.max(...per) - Math.min(...per) <= 2 && per.reduce((a, b) => a + b) === 15, 'cpus: the tables are spread', JSON.stringify(per));
  check(w.maxRunning === 4, 'cpus: 4 analyses at once', String(w.maxRunning));
  check(w.analyses.every(([e, arch]) => w.engines[e].tables.has(arch)), 'cpus: each job ran where its table is');
  check(w.bytesAsked.length === 15 && new Set(w.bytesAsked).size === 15, 'cpus: each table\'s bytes asked for once');

  // the next input: no table is loaded again, each job goes to the worker that has its table
  const loads = w.loads.length;
  const c2 = collect();
  check(await pool.run(ARCHS.map((a) => req(a, 1)), c2) && c2.got.length === 15, 'cpus again: done');
  check(w.loads.length === loads && w.engines.length === 4, 'cpus again: no table loaded, no worker started', `${w.loads.length - loads} loads`);
  const st = await pool.stats();
  check(st.length === 4 && st.reduce((n, s) => n + s.tables.length, 0) === 15 && st.every((s) => s.wasmBytes === 1048576 * (1 + s.tables.length) && s.tableBytes === s.tables.reduce((n, t) => n + t.length * 1000, 0)), 'stats: tables, memory and bytes per worker', JSON.stringify(st));

  // a sweep (64 jobs, one table) after that: the table goes into every worker, the jobs are spread
  const c3 = collect();
  const sweepBefore = w.analyses.length;
  check(await pool.run(Array.from({ length: 64 }, (_, k) => req('SKL', k)), c3) && c3.got.length === 64, 'sweep: done');
  const by = new Map();
  for (const [e] of w.analyses.slice(sweepBefore)) by.set(e, (by.get(e) ?? 0) + 1);
  check(by.size === 4 && Math.min(...by.values()) >= 8, 'sweep: every worker takes a share', JSON.stringify([...by]));
  check(w.engines.every((e) => e.tables.has('SKL')) && w.loads.filter(([, t]) => t === 'SKL').length === 4, 'sweep: SKL in every worker, loaded once each');
  check(c3.got.map((g) => g.response.tp).sort((a, b) => a - b).join() === Array.from({ length: 64 }, (_, k) => k + 0.03).join(), 'sweep: every offset\'s result');
}

// a sweep in a fresh pool: workers start for it, each loads the table once
{
  const w = world();
  const pool = w.pool({ size: 3 });
  const c = collect();
  await pool.run(Array.from({ length: 64 }, (_, k) => req('SKL', k)), c);
  check(c.got.length === 64 && w.engines.length === 3 && w.loads.length === 3 && w.maxRunning === 3, 'sweep cold: 3 workers, 3 loads, 3 at once', JSON.stringify([w.engines.length, w.loads, w.maxRunning]));
  check(w.bytesAsked.length === 3, 'sweep cold: the bytes come from the page each time (no fetch: the caller caches them)');
}

// few jobs: only as many workers as pay off (rule 3: STEAL waiting jobs per worker that has the table)
{
  const w = world();
  const pool = w.pool();
  await pool.run([req('SKL', 0), req('SKL', 1)], collect());
  check(w.engines.length === 1, 'small: 2 jobs of one table: one worker', String(w.engines.length));
  const w2 = world();
  await w2.pool().run(Array.from({ length: 6 }, (_, k) => req('SKL', k)), collect());
  check(w2.engines.length === 3, 'small: 6 jobs of one table: 3 workers', String(w2.engines.length));
  const w3 = world();
  check(await w3.pool().run([], collect()) === true && w3.engines.length === 0, 'small: an empty batch starts nothing');
}

// latest wins: an aborted batch settles at once, its waiting jobs are dropped; the next batch runs
{
  const w = world({ ms: () => 20 });
  const pool = w.pool({ size: 2 });
  const ctrl = new AbortController();
  const c1 = collect();
  const t0 = Date.now();
  const p1 = pool.run(Array.from({ length: 40 }, (_, k) => req('SKL', k)), { ...c1, signal: ctrl.signal });
  await sleep(50);
  ctrl.abort();
  const r1 = await p1;
  const settled = Date.now() - t0;
  const c2 = collect();
  const r2 = await pool.run(Array.from({ length: 4 }, (_, k) => req('SKL', 100 + k)), c2);
  await sleep(30);
  check(r1 === false && settled < 70, 'abort: the batch settles with false at once', String(settled));
  check(c1.got.length < 10, 'abort: the rest of it does not run', String(c1.got.length));
  check(r2 === true && c2.got.length === 4 && w.analyses.length < 16, 'abort: the next batch runs, the old one\'s jobs were dropped', String(w.analyses.length));
  check(w.engines.every((e) => e.restarts === 0), 'abort: short running jobs are not stopped');
  check(await pool.run([req('SKL', 1)], { signal: AbortSignal.abort() }) === false, 'abort: an aborted signal at the start');

  // isStale (checked when a job is taken) also stops a batch
  let stale = false;
  const c3 = collect();
  const p3 = pool.run(Array.from({ length: 20 }, (_, k) => req('SKL', k)), { ...c3, isStale: () => stale });
  await sleep(30); stale = true;
  check(await p3 === false && c3.got.length < 20, 'stale: the batch stops', String(c3.got.length));
}

// a long analysis of an aborted batch: its worker is stopped after the grace period, and works for the next job
{
  const w = world({ ms: (r) => (r.alignmentOffset === 99 ? 5000 : 3) });
  const pool = w.pool({ size: 1, graceMs: 40 });
  const ctrl = new AbortController();
  const p = pool.run([req('SKL', 99)], { signal: ctrl.signal });
  await sleep(20);
  ctrl.abort();
  check(await p === false, 'grace: the batch settles');
  const c = collect();
  const t0 = Date.now();
  check(await pool.run([req('SKL', 1)], c) === true && c.got[0].response.tp === 1.03, 'grace: the next job gets its result');
  check(Date.now() - t0 < 200 && w.engines[0].restarts === 1 && pool.counts.cancels === 1, 'grace: the long one was stopped', JSON.stringify([Date.now() - t0, w.engines[0].restarts]));
}

// a trap: the result is the error response; the worker is replaced (cancel) and goes on with the same tables
{
  const w = world();
  const pool = w.pool({ size: 1 });
  const c = collect();
  await pool.run([req('SKL', 0, 'cc'), req('SKL', 1)], c);
  const trap = c.got.find((g) => g.item.k === 0);
  check(trap?.response?.trapped === true && !trap.error && c.got.find((g) => g.item.k === 1)?.response.tp === 1.03, 'trap: an error response, then the next job works', JSON.stringify(c.got));
  check(w.engines[0].restarts === 1 && pool.counts.traps === 1 && w.loads.length === 1, 'trap: the worker was restarted, the pool did not load the table again');
}

// a worker that fails: the job is tried once more; twice: an error for that job, the others go on
{
  const w = world();
  const pool = w.pool({ size: 1 });
  const c = collect();
  const ready = pool.run([req('SKL', 0)], collect());
  await ready;
  w.engines[0].crashNext = 1;
  await pool.run([req('SKL', 5)], c);
  check(c.got.length === 1 && c.got[0].response?.tp === 5.03 && pool.counts.retries === 1, 'crash: retried once, then the result', JSON.stringify(c.got));
  w.engines[0].crashNext = 2;
  const c2 = collect();
  await pool.run([req('SKL', 6), req('SKL', 7)], c2);
  const bad = c2.got.filter((g) => g.error);
  check(c2.got.length === 2 && bad.length === 1 && /failed/.test(bad[0].error.message), 'crash: twice: an error for that job, the next one works', JSON.stringify(c2.got.map((g) => [g.item.k, g.error?.message, g.response?.tp])));
}

// a table that cannot be loaded: an error for its jobs (not owned afterwards), the others go on
{
  const w = world();
  w.tableOf = (arch) => (arch === 'X' ? 'BAD' : arch);
  const pool = w.pool({ size: 2 });
  const c = collect();
  check(await pool.run([req('X'), req('SKL'), req('X', 1)], c) === true, 'bad table: the batch completes');
  const errs = c.got.filter((g) => g.error);
  check(errs.length === 2 && errs.every((g) => /^table not loaded: bad table/.test(g.error.message)) && c.got.find((g) => g.item.arch === 'SKL')?.response.tp === 0.03, 'bad table: errors for its jobs only', JSON.stringify(c.got.map((g) => [g.item.arch, g.error?.message])));
  check((await pool.stats()).every((s) => !s.tables.includes('BAD')), 'bad table: no worker counts as having it');
}

// a worker that cannot start: the job is tried with another one; if that fails too, an error
{
  const w = world({ failSpawn: 1 });
  const pool = w.pool({ size: 2 });
  const c = collect();
  await pool.run([req('SKL')], c);
  check(c.got.length === 1 && c.got[0].response?.tp === 0.03 && pool.workers === 1, 'spawn: one failure, the job runs in the next worker', JSON.stringify(c.got));
  const w2 = world({ failSpawn: 9 });
  const c2 = collect();
  await w2.pool({ size: 2 }).run([req('SKL')], c2);
  check(c2.got.length === 1 && /no worker/.test(c2.got[0].error?.message), 'spawn: always failing: an error result');
}

// two batches at once (e.g. the sweep and the cost column): both complete, results go to their own callbacks
{
  const w = world();
  const pool = w.pool();
  const a = collect(), b = collect();
  const [ra, rb] = await Promise.all([
    pool.run(ARCHS.map((x) => req(x)), a),
    pool.run(Array.from({ length: 20 }, (_, k) => req('SKL', k)), b),
  ]);
  check(ra && rb && a.got.length === 15 && b.got.length === 20 && b.got.every((g) => g.item.arch === 'SKL'), 'two batches: both complete');
}

// ---- the real analyzer, in workers in this thread ------------------------------------------------------------------
class FakeWorker {
  #handle = createHandler(); #dead = false;
  postMessage(msg) { setTimeout(async () => { if (this.#dead) return; const a = await this.#handle(msg); setTimeout(() => { if (!this.#dead) this.onmessage?.({ data: a }); }, 0); }, 0); }
  terminate() { this.#dead = true; }
}
const root = new URL('../', import.meta.url);
const wasmPath = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (!fs.existsSync(wasmPath) || !fs.existsSync(new URL('data/uarch.json', root))) {
  console.log('(no real module or data: skipped)');
} else {
  const module = await WebAssembly.compile(fs.readFileSync(wasmPath));
  const uarchBytes = fs.readFileSync(new URL('data/uarch.json', root));
  const items = archGroups(JSON.parse(uarchBytes.toString()))[0].items;
  const tableOf = (arch) => items.find((i) => i.key === arch).table;
  const bytes = new Map();
  const tableBytes = async (name) => { if (!bytes.has(name)) bytes.set(name, new Uint8Array(fs.readFileSync(new URL(`data/arch/${name}.json`, root)))); return bytes.get(name); };
  const single = await WasmEngine.create(module);
  await single.loadUarch(uarchBytes);
  for (const it of items) await single.loadArch(it.table, await tableBytes(it.table));
  const pool = createPool({
    size: 4, tableOf, tableBytes,
    async spawn() { const e = await WorkerEngine.create(module, () => new FakeWorker()); await e.loadUarch(uarchBytes); return e; },
  });
  const same = async (what, requests) => {
    const got = new Array(requests.length);
    const ok = await pool.run(requests.map((request, i) => ({ request, i })), { onResult: ({ i }, r, e) => { got[i] = e ? { thrown: e.message } : r; } });
    let diff = 0;
    for (let i = 0; i < requests.length; i++) if (JSON.stringify(got[i]) !== JSON.stringify(await single.analyze(requests[i]))) diff++;
    check(ok && diff === 0, `real: ${what}: the same responses as one engine (${requests.length})`, `${diff} differ`);
  };
  for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES]) {
    await same(`${ex.id}, all CPUs`, items.map((it) => makeRequest(ex.hex, it.key)));
    await same(`${ex.id}, sweep`, Array.from({ length: SWEEP_OFFSETS }, (_, k) => makeRequest(ex.hex, ex.arch, { alignmentOffset: k })));
    const base = await single.analyze(makeRequest(ex.hex, ex.arch));
    const cu = costUnits(base, ex.hex);
    await same(`${ex.id}, cost`, costJobs(cu.units, ex.hex, 'remove').map((j) => makeRequest(j.hex, ex.arch)));
  }
  const st = await pool.stats();
  const loaded = st.flatMap((s) => s.tables);
  console.log(`real: one engine with every table: wasm memory ${((await single.memory()) / 1048576).toFixed(0)} MiB`);
  console.log(`real: ${st.length} workers; tables per worker ${JSON.stringify(st.map((s) => s.tables.length))}; wasm memory ${st.map((s) => (s.wasmBytes / 1048576).toFixed(0)).join(' + ')} MiB`);
  check(st.length === 4 && new Set(loaded).size === items.length, 'real: every table is in the pool');
}

console.log(`${count} pool checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
