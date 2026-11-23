// Worker threads for compare(): the analyses of one block on several microarchitectures run in parallel, one per thread
// at a time (thread-worker.js). The module is compiled once for all threads, and each thread loads only the tables of
// the microarchitectures it is given.
//
// - Memory: the threads' module has a smaller memory limit than the main thread's (maxMemoryBytes: a quarter of the
//   RAM shared by the threads, from 256 MiB to 1 GiB each), so that an input that needs a lot of memory cannot take it
//   on every thread at once. An analysis that traps in a thread (it may only have hit that limit) is given back to the
//   caller, which runs it on its own thread, so the result is the same as without threads. A thread whose memory has
//   grown beyond half its limit (it never shrinks) is stopped after its job.
// - The pool is started by the first compare() with at least two microarchitectures and kept for the next ones; its
//   threads are started as jobs need them, up to `limit`. While no job runs they do not keep the process alive, and
//   after IDLE_MS without a job they are stopped (close() stops them at once).
// - A table is pinned to the thread that loaded it: a job goes to a thread that has its table, else a table no thread
//   has goes to the first free thread (or a new one). So every table is loaded once, whatever the number of compares.
// - A thread that cannot start or stops unexpectedly does not fail anything: its jobs resolve to null and the caller
//   runs them on its own thread. After a start failure the pool is `broken` and the caller stops using it.

import os from 'node:os';
import { Worker, isMainThread } from 'node:worker_threads';
import { capMemory } from './wasm.js';

const WORKER = new URL('./thread-worker.js', import.meta.url);
export const IDLE_MS = 30_000;
const MIB = 2 ** 20;

// The memory limit of a thread's analyzer, for `threads` threads.
export function maxMemoryBytes(threads, total = os.totalmem()) {
  return Math.min(1024 * MIB, Math.max(256 * MIB, Math.floor(total / 4 / Math.max(1, threads) / (64 * 1024)) * 64 * 1024));
}

// The most threads compare() uses: `option` (createWuica's `threads`), else the environment variable WUICA_THREADS,
// else os.availableParallelism() (on the main thread; 1 inside a worker thread). 1 means no threads.
export function threadLimit(option, env = process.env) {
  const raw = option ?? (env.WUICA_THREADS === undefined || env.WUICA_THREADS === '' ? 'auto' : env.WUICA_THREADS);
  if (raw === 'auto' || raw === 0 || raw === '0') return isMainThread ? Math.max(1, os.availableParallelism()) : 1;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`${option !== undefined && option !== null ? 'threads' : 'WUICA_THREADS'}: expected a non-negative integer or "auto", got ${JSON.stringify(raw)}`);
  }
  return n;
}

export class ThreadPool {
  #workerData = null;
  #wasm; #uarch; #dataDir;
  #compiled = null;   // promise of the module with the threads' memory limit
  #limit;
  #slots = [];        // {worker, ready, job, tables: Set}
  #queue = [];        // {id, table, request, resolve}
  #nextId = 1;
  #idleTimer = null;
  broken = false;

  // wasm: the bytes of the analyzer module; uarch: the bytes of uarch.json; limit: the most threads.
  constructor({ wasm, uarch, dataDir, limit }) {
    this.#wasm = wasm; this.#uarch = uarch; this.#dataDir = dataDir;
    this.#limit = limit;
  }

  get threads() { return this.#slots.length; }

  // jobs: [{table, request}] -> a promise of [fields | null] in the same order (null: not done, run it elsewhere).
  // A thread is started for each table no thread has, up to the limit.
  async run(jobs) {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    if (!this.#workerData) {
      const maxBytes = maxMemoryBytes(this.#limit);
      this.#compiled ??= WebAssembly.compile(capMemory(this.#wasm, maxBytes / (64 * 1024)));
      try {
        const module = await this.#compiled;
        this.#workerData ??= { module, uarch: this.#uarch, dataDir: this.#dataDir, recycleBytes: maxBytes / 2 };
      } catch {
        this.broken = true;
      }
    }
    const out = Promise.all(jobs.map(({ table, request }) => new Promise((resolve) => {
      if (this.broken) { resolve(null); return; }
      this.#queue.push({ id: this.#nextId++, table, request, resolve });
    })));
    this.#pump();
    return out;
  }

  #owner(table) { return this.#slots.find((s) => s.tables.has(table)); }

  // The job for a free thread: one of its tables, else one of a table no thread has.
  #pick(slot) {
    let i = this.#queue.findIndex((j) => slot.tables.has(j.table));
    if (i < 0) i = this.#queue.findIndex((j) => !this.#owner(j.table));
    return i < 0 ? null : this.#queue.splice(i, 1)[0];
  }

  #pump() {
    for (const s of this.#slots) {
      if (!s.ready || s.job || !this.#queue.length) continue;
      const j = this.#pick(s);
      if (j) this.#start(s, j);
    }
    // a new thread for each table that no thread has, up to the limit
    const starting = this.#slots.filter((s) => !s.ready).length;
    const unowned = new Set(this.#queue.filter((j) => !this.#owner(j.table)).map((j) => j.table)).size;
    for (let k = starting; k < unowned && this.#slots.length < this.#limit; k++) this.#spawn();
    this.#idle();
  }

  #start(slot, job) {
    slot.job = job;
    slot.tables.add(job.table);
    slot.worker.ref();
    slot.worker.postMessage({ id: job.id, table: job.table, request: job.request });
  }

  #spawn() {
    const worker = new Worker(WORKER, { workerData: this.#workerData, stdout: true, stderr: true });
    const slot = { worker, ready: false, job: null, tables: new Set() };
    this.#slots.push(slot);
    worker.on('message', (m) => {
      if (m.type === 'ready') {
        slot.ready = true;
        worker.unref();
        this.#pump();
      } else if (m.type === 'init-error') {
        this.#fail(slot, true);
      } else if (slot.job && m.id === slot.job.id) {
        const job = slot.job;
        slot.job = null;
        worker.unref();
        job.resolve(m.fields);
        if (m.recycle) this.#remove(slot);
        this.#pump();
      }
    });
    worker.on('error', () => this.#fail(slot, !slot.ready));
    worker.on('exit', () => this.#fail(slot, !slot.ready));
  }

  // Stops a thread and forgets it (its tables are no longer pinned to it). False if it was gone already.
  #remove(slot) {
    const i = this.#slots.indexOf(slot);
    if (i < 0) return false;
    this.#slots.splice(i, 1);
    slot.worker.terminate().catch(() => {});
    return true;
  }

  // A thread that failed: its job (and, if it never started, every waiting job) is given back to the caller.
  #fail(slot, atStart) {
    if (!this.#remove(slot)) return;
    slot.job?.resolve(null);
    slot.job = null;
    if (atStart) this.broken = true;
    if (this.broken) for (const j of this.#queue.splice(0)) j.resolve(null);
    this.#pump();
  }

  // No job left: the threads are stopped after IDLE_MS (a timer that does not keep the process alive).
  #idle() {
    if (this.#queue.length || this.#slots.some((s) => s.job) || this.#idleTimer || !this.#slots.length) return;
    this.#idleTimer = setTimeout(() => { this.#idleTimer = null; this.close(); }, IDLE_MS);
    this.#idleTimer.unref();
  }

  // Stops the threads; waiting and running jobs resolve to null. The next run() starts new ones.
  async close() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    const slots = this.#slots.splice(0);
    for (const j of this.#queue.splice(0)) j.resolve(null);
    await Promise.all(slots.map((s) => {
      s.job?.resolve(null);
      s.job = null;
      return s.worker.terminate().catch(() => {});
    }));
  }
}
