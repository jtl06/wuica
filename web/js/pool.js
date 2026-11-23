// A pool of analyzer workers for the views that run many analyses: the table of all CPUs (one analysis per CPU), the
// alignment sweep (64) and the cost column (one per instruction). The main analysis does not use it: it keeps its own
// worker (app.js), so it never waits behind this work.
//
//   poolSize(cores)      navigator.hardwareConcurrency - 1, at least 1, at most POOL_MAX
//   tableCap(n, size)    the most tables a worker keeps, for n tables and `size` workers
//   createPool(options)  the pool; its workers are started when the first jobs come in, and only as many as useful
//
// Scheduling. Every worker holds the instruction tables it has loaded (a table is 0.5–1.8 MB of JSON and takes 10–40 ms
// to load; in the WebAssembly memory it takes 1–6 MB: 2.5 MB with no table, ~10 with one, ~20 with five, ~54 with all 15).
// A worker that becomes free takes, in this order:
//   1. the first waiting job whose table it has (or is loading);
//   2. the first job whose table no worker has: it loads that table (so a batch with one job per CPU spreads the 15
//      tables over the workers, each table into one worker only, and keeps them there for the next input);
//   3. a job of a table that other workers have, if at least STEAL waiting jobs per such worker are left (the sweep and
//      the cost column: one table, many jobs; the table is loaded into more workers while that pays off).
// A new worker is started (up to the size) when a job is waiting that rule 2 or 3 would give it.
//
// A worker keeps at most `maxTables` tables (tableCap: an even share of all tables plus TABLE_SPARE, so the table of all
// CPUs and a sweep or two fit without evicting anything). A full worker takes a job of a table it lacks (rules 2 and 3)
// only when every worker has been started and no other worker without that table has room: then it evicts. The module
// cannot unload a table and its memory never shrinks, so evicting means a new worker (WorkerEngine.recycle) with only
// the tables it keeps: about half the cap, chosen in this order: tables that waiting jobs need, tables no other worker
// has, the most recently used. Without eviction, sweeps on one CPU after another would put every table in every worker.
//
// Batches are latest-wins: run() settles with false as soon as its signal aborts (or isStale() is true when a job is
// taken); its waiting jobs are dropped at once, a running one is left to finish (its result is ignored) unless it
// is still running after GRACE_MS: then its worker is stopped (WorkerEngine.cancel(): the next call starts a new
// worker and loads the same tables into it). A worker whose analysis traps is replaced the same way; a job whose
// worker failed is tried once more.
//
// No DOM: spawn() and tableBytes() are passed in, so the tests run it with fake workers (tests-js/web_pool.mjs).

export const POOL_MAX = 6;
export const STEAL = 2;
export const GRACE_MS = 500;
export const TABLE_SPARE = 2;

export function poolSize(cores = globalThis.navigator?.hardwareConcurrency, max = POOL_MAX) {
  const n = Number.isFinite(cores) && cores > 0 ? Math.floor(cores) - 1 : 1;
  return Math.max(1, Math.min(max, n));
}

export function tableCap(tables, size) {
  return Math.ceil(Math.max(1, tables) / Math.max(1, size)) + TABLE_SPARE;
}

const isCancel = (e) => e?.name === 'CancelledError';
const message = (e) => (e instanceof Error ? e.message : String(e));

// options:
//   size                 the most workers
//   spawn()              resolves to a started engine with uarch.json loaded: {hasArch, loadArch, analyze, cancel,
//                        recycle?, memory?} (a WorkerEngine, engine-rpc.js)
//   tableOf(arch)        the table a configuration needs (configs[arch].name)
//   tableBytes(name)     resolves to the bytes of a table (the page's copy: nothing is fetched twice)
//   maxTables            the most tables a worker keeps (tableCap); evicting needs engine.recycle(keep). Default: no limit
//   steal, graceMs, now, timers   (tests)
export function createPool({ size, spawn, tableOf, tableBytes, maxTables = Infinity, steal = STEAL, graceMs = GRACE_MS, now = () => performance.now(), timers = globalThis }) {
  const slots = [];  // {id, engine: promise, tables: Map (loaded or loading) -> last use, job, phase, since, evicted}
  let queue = [];    // waiting jobs, oldest first: {batch, item, request, table, attempts}
  let ids = 0;
  let uses = 0;      // the clock of the tables' last use
  let spawnFailed = false; // a worker could not be started: no more are started while others run
  const cap = Math.max(1, maxTables);
  const sizes = new Map(); // table -> bytes, for stats()
  const counts = { spawned: 0, tableLoads: 0, analyses: 0, cancels: 0, traps: 0, retries: 0, recycles: 0 };

  const owners = (table) => slots.reduce((n, s) => n + (s.tables.has(table) ? 1 : 0), 0);
  const waiting = (table) => queue.reduce((n, j) => n + (j.table === table ? 1 : 0), 0);
  const room = (s) => s.tables.size < cap;

  function prune() {
    queue = queue.filter((j) => {
      if (!j.batch.over && j.batch.isStale?.()) j.batch.finish(false);
      return !j.batch.over;
    });
  }

  // The job a worker should take next (slot null: a worker that is not started yet), or null. A full worker loads a
  // table only if `evict`, and only if no other worker without that table has room (that one takes it when it is free).
  function pick(slot, evict = false) {
    const has = (t) => !!slot && slot.tables.has(t);
    const fits = !slot || room(slot);
    const may = (t) => fits || (evict && !slots.some((o) => o !== slot && !o.tables.has(t) && room(o)));
    let i = queue.findIndex((j) => has(j.table));
    if (i < 0) i = queue.findIndex((j) => owners(j.table) === 0 && may(j.table));
    if (i < 0) i = queue.findIndex((j) => !has(j.table) && waiting(j.table) >= steal * owners(j.table) && may(j.table));
    return i < 0 ? null : queue.splice(i, 1)[0];
  }

  function pump() {
    prune();
    for (const s of slots) {
      if (s.job || !queue.length) continue;
      const j = pick(s);
      if (j) start(s, j);
    }
    const limit = spawnFailed && slots.length ? slots.length : size;
    while (slots.length < limit && queue.length) {
      const j = pick(null);
      if (!j) break;
      const s = { id: ++ids, tables: new Map(), job: null, phase: '', since: 0, evicted: null };
      s.engine = Promise.resolve().then(spawn);
      s.engine.catch(() => {}); // handled in start()
      counts.spawned++;
      slots.push(s);
      start(s, j);
    }
    if (slots.length < limit) return;
    for (const s of slots) { // every worker started: a full one may evict
      if (s.job || !queue.length) continue;
      const j = pick(s, true);
      if (j) start(s, j);
    }
  }

  // Makes room in a full worker for one more table: forgets all but about half the cap (see the top). The worker
  // itself is replaced in start(), once its engine is there.
  function makeRoom(s) {
    const keep = Math.max(0, Math.ceil(cap / 2) - 1);
    const rank = ([t, used]) => [waiting(t) > 0 ? 1 : 0, owners(t) > 1 ? 0 : 1, used];
    const order = [...s.tables].sort((a, b) => {
      const x = rank(a), y = rank(b);
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    });
    s.evicted = order.slice(keep).map(([t]) => t);
    for (const t of s.evicted) s.tables.delete(t);
  }

  async function start(s, j) {
    s.job = j;
    s.since = now();
    s.phase = 'start';
    if (!s.tables.has(j.table) && s.tables.size >= cap) makeRoom(s);
    s.tables.set(j.table, ++uses);
    let response = null, error = null, tableError = false;
    try {
      let engine;
      try {
        engine = await s.engine;
      } catch (e) { // the worker could not be started: forget it
        slots.splice(slots.indexOf(s), 1);
        spawnFailed = true;
        throw e;
      }
      if (s.evicted) {
        const gone = s.evicted;
        s.evicted = null;
        if (typeof engine.recycle === 'function' && gone.some((t) => engine.hasArch(t))) {
          engine.recycle([...s.tables.keys()].filter((t) => t !== j.table && engine.hasArch(t)));
          counts.recycles++;
        }
      }
      if (!engine.hasArch(j.table)) {
        s.phase = 'load';
        try {
          const bytes = await tableBytes(j.table);
          sizes.set(j.table, bytes.length);
          await engine.loadArch(j.table, bytes);
          counts.tableLoads++;
        } catch (e) {
          s.tables.delete(j.table);
          tableError = !isCancel(e);
          throw e;
        }
      }
      if (!j.batch.over) {
        s.phase = 'analyze';
        s.since = now();
        response = await engine.analyze(j.request);
        counts.analyses++;
        if (response?.trapped) { counts.traps++; engine.cancel(); } // a fresh worker, with the same tables, for the next job
      }
    } catch (e) {
      error = e;
    }
    s.job = null;
    s.phase = '';
    const b = j.batch;
    if (!b.over) {
      if (!error) deliver(j, response, null);
      else if (tableError) deliver(j, null, new Error(`table not loaded: ${message(error)}`));
      else if (j.attempts < 1) { j.attempts++; counts.retries++; queue.unshift(j); } // the worker failed or was stopped: once more
      else deliver(j, null, error);
    }
    pump();
  }

  function deliver(j, response, error) {
    const b = j.batch;
    try { b.onResult?.(j.item, response, error); } catch { /* the caller's problem; the batch goes on */ }
    if (--b.left === 0) b.finish(true);
  }

  // A running job of a batch that is over: stopped if it is still running after the grace period.
  function stopLater(s, j) {
    const left = Math.max(0, graceMs - (now() - s.since));
    timers.setTimeout(() => {
      if (s.job !== j || s.phase !== 'analyze') return;
      counts.cancels++;
      s.engine.then((e) => e.cancel(), () => {});
    }, left);
  }

  return {
    size,
    maxTables: cap,
    counts,

    // items: [{request, ...}] (request: see docs/WASM-API.md); onResult(item, response, error) for each, in the order
    // they finish (error: an Error if there is no response). Resolves to true when every item has its result, false
    // if the batch was stopped (signal aborted, or isStale() true).
    run(items, { signal = null, isStale = null, onResult = null } = {}) {
      return new Promise((resolve) => {
        const b = { over: false, left: items.length, onResult, isStale };
        const onAbort = () => { b.finish(false); pump(); };
        b.finish = (ok) => {
          if (b.over) return;
          b.over = true;
          signal?.removeEventListener('abort', onAbort);
          if (!ok) for (const s of slots) if (s.job?.batch === b) stopLater(s, s.job);
          resolve(ok);
        };
        if (signal?.aborted || isStale?.()) { b.finish(false); return; }
        if (!items.length) { b.finish(true); return; }
        signal?.addEventListener('abort', onAbort);
        for (const item of items) queue.push({ batch: b, item, request: item.request, table: tableOf(item.request.arch), attempts: 0 });
        pump();
      });
    },

    // Per worker: the tables it holds, the size of its WebAssembly memory (it never shrinks: the peak) and of the
    // table bytes it keeps (to load them again after a restart).
    async stats() {
      return Promise.all(slots.map(async (s) => {
        const e = await s.engine.catch(() => null);
        const tables = [...s.tables.keys()].filter((t) => e?.hasArch(t));
        return {
          id: s.id, busy: !!s.job, tables,
          wasmBytes: e?.memory ? await e.memory().catch(() => 0) : 0,
          tableBytes: tables.reduce((n, t) => n + (sizes.get(t) ?? 0), 0),
        };
      }));
    },

    get workers() { return slots.length; },
    get waiting() { return queue.length; },
    get busy() { return queue.length > 0 || slots.some((s) => !!s.job); },
  };
}
