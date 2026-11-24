// Worker threads for compare(): the analyses of one block on several microarchitectures run in parallel, one per thread
// at a time (thread-worker.js). The module is compiled once for all threads, and each thread loads only the tables of
// the microarchitectures it is given.
//
// - Memory: the threads' module has a smaller memory limit than the main thread's (maxMemoryBytes: a quarter of the
//   RAM shared by the threads, from 256 MiB to 1 GiB each), so that an input that needs a lot of memory cannot take it
//   on every thread at once. An analysis that traps in a thread (it may only have hit that limit) is given back to the
//   caller, which runs it on its own thread, so the result is the same as without threads. A thread whose memory has
//   grown beyond half its limit (it never shrinks) is stopped after its job.
// - The pool is started by the first compare() that uses threads and kept for the next ones; its threads are started
//   as jobs need them, up to the number run() is given (and `limit`). While no job runs they do not keep the process alive, and
//   after IDLE_MS without a job they are stopped (close() stops them at once).
// - A table is pinned to the thread that loaded it: a job goes to a thread that has its table, else a table no thread
//   has goes to the first free thread (or a new one). So every table is loaded once, whatever the number of compares.
//   A new thread gets its first job at once (it waits in the thread's queue while the thread starts).
// - Warm-up: V8 compiles the module's functions when they are first called (and optimizes the hot ones later, in the
//   background), and the compiled code belongs to the module, which the threads share. While new threads start
//   (~80 ms), this thread analyzes a block once on an instance of their module, so that they find most of the code
//   compiled (on aethia the first analysis of the SHA-256 showcase in 8 new threads at once takes ~100 instead of
//   ~230 ms).
// - A thread that cannot start or stops unexpectedly does not fail anything: its jobs resolve to null and the caller
//   runs them on its own thread. After a start failure the pool is `broken` and the caller stops using it.

import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread } from 'node:worker_threads';
import { Analyzer, capMemory } from './wasm.js';
import { readMaybeCompressed, tableFile } from './files.js';
import { WARM_HEX } from './core.js';

const WORKER = new URL('./thread-worker.js', import.meta.url);
export const IDLE_MS = 30_000;
const WARM_MIN_HEX = 2 * 1024; // the smallest block (hex digits: 1 KB of code, ~250 instructions) that gets a warm-up
const MIB = 2 ** 20;

// The memory limit of a thread's analyzer, for `threads` threads.
export function maxMemoryBytes(threads, total = os.totalmem()) {
  return Math.min(1024 * MIB, Math.max(256 * MIB, Math.floor(total / 4 / Math.max(1, threads) / (64 * 1024)) * 64 * 1024));
}

// The most threads compare() uses: `option` (createWuica's `threads`), else the environment variable WUICA_THREADS,
// else "auto": os.availableParallelism() (on the main thread; 1 inside a worker thread). 1 means no threads.
export function threadLimit(option, env = process.env) {
  const raw = threadOption(option, env);
  if (raw === 'auto') return isMainThread ? Math.max(1, os.availableParallelism()) : 1;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`${option !== undefined && option !== null ? 'threads' : 'WUICA_THREADS'}: expected a non-negative integer or "auto", got ${JSON.stringify(raw)}`);
  }
  return n;
}

// The option as given (option, else WUICA_THREADS), "auto" if there is none (also for 0).
export function threadOption(option, env = process.env) {
  const raw = option ?? (env.WUICA_THREADS === undefined || env.WUICA_THREADS === '' ? 'auto' : env.WUICA_THREADS);
  return raw === 0 || raw === '0' ? 'auto' : raw;
}

// The default number of threads for a set of jobs ([{table, request: {hex}}]: blocks x microarchitectures), from the
// work they are: the estimated time on this thread (each table loaded once, each analysis a fixed cost plus a cost per
// instruction). Below WORK.minMs no threads (a thread's start, its table and its first, unoptimized analysis cost more
// than they save); else one thread per WORK.perThreadMs, from 2 to WORK.max, at most the cores but one (and `limit`),
// and at most one per job. Measurements: docs/PORTING.md, "Threads".
export const WORK = Object.freeze({ tableMs: 8, jobMs: 1.2, instrMs: 0.009, minMs: 300, perThreadMs: 150, max: 8 });
export function workMs(jobs) {
  const tables = new Set(jobs.map((j) => j.table)).size;
  // ~4 bytes (8 hex digits) per instruction
  return tables * WORK.tableMs + jobs.reduce((s, j) => s + WORK.jobMs + (j.request.hex.length / 8) * WORK.instrMs, 0);
}
export function threadsForWork(jobs, limit, cores = os.availableParallelism()) {
  const ms = workMs(jobs);
  if (ms < WORK.minMs || jobs.length < 2) return 1;
  return Math.max(1, Math.min(limit, cores - 1, jobs.length, Math.max(2, Math.min(WORK.max, Math.ceil(ms / WORK.perThreadMs)))));
}

export class ThreadPool {
  #workerData = null;
  #wasm; #uarch; #dataDir;
  #compiled = null;   // promise of the module with the threads' memory limit
  #limit;
  #slots = [];        // {worker, ready, job, tables: Set}
  #warmed = false;
  #want;              // the threads the latest run() may start
  #queue = [];        // {id, table, request, resolve}
  #nextId = 1;
  #idleTimer = null;
  broken = false;

  // wasm: the bytes of the analyzer module; uarch: the bytes of uarch.json; limit: the most threads.
  constructor({ wasm, uarch, dataDir, limit }) {
    this.#wasm = wasm; this.#uarch = uarch; this.#dataDir = dataDir;
    this.#limit = limit;
    this.#want = limit;
  }

  get threads() { return this.#slots.length; }

  // jobs: [{table, request, full}] -> a promise of [fields | null] in the same order (null: not done, run it elsewhere;
  // full: the whole analysis result instead of a compare() row's fields). Threads are started while there are fewer
  // than `threads` (and `limit`) and jobs wait.
  async run(jobs, threads = this.#limit) {
    this.#want = Math.min(this.#limit, threads);
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    if (!this.#workerData) {
      const maxBytes = maxMemoryBytes(this.#limit);
      // (the module's bytes are not needed after this: the threads get the compiled module)
      this.#compiled ??= WebAssembly.compile(capMemory(this.#wasm, maxBytes / (64 * 1024)));
      this.#wasm = null;
      try {
        const module = await this.#compiled;
        this.#workerData ??= { module, uarch: this.#uarch, dataDir: this.#dataDir, recycleBytes: maxBytes / 2 };
      } catch {
        this.broken = true;
      }
    }
    const out = Promise.all(jobs.map(({ table, request, full = false }) => new Promise((resolve) => {
      if (this.broken) { resolve(null); return; }
      this.#queue.push({ id: this.#nextId++, table, request, full, resolve });
    })));
    // (not for a small block: its analyses are short, and the warm-up would compete with them for the CPU)
    if (this.#pump() && !this.#warmed && jobs[0]?.request.hex.length >= WARM_MIN_HEX) {
      this.#warmed = true;
      this.#warmUp(jobs[0]).catch(() => {});
    }
    return out;
  }

  // One analysis of WARM_HEX on an instance of the threads' module (see the top); the instance is dropped afterwards.
  async #warmUp({ table, request }) {
    const bytes = await readMaybeCompressed(tableFile(this.#dataDir, table));
    const a = new Analyzer(this.#workerData.module);
    a.loadUarch(this.#uarch);
    a.loadArch(table, bytes);
    a.analyze({ hex: WARM_HEX, arch: request.arch });
  }

  #owner(table) { return this.#slots.find((s) => s.tables.has(table)); }

  // The job for a free thread: one of its tables, else one of a table no thread has, else any (its table is loaded
  // here too: many blocks on one microarchitecture).
  #pick(slot) {
    let i = this.#queue.findIndex((j) => slot.tables.has(j.table));
    if (i < 0) i = this.#queue.findIndex((j) => !this.#owner(j.table));
    if (i < 0) i = this.#queue.length ? 0 : -1;
    return i < 0 ? null : this.#queue.splice(i, 1)[0];
  }

  // Gives the waiting jobs to free threads, and starts threads for the jobs left (up to the threads wanted): first
  // for tables no thread has. Returns the number of threads started.
  #pump() {
    for (const s of this.#slots) {
      if (s.job || !this.#queue.length) continue;
      const j = this.#pick(s);
      if (j) this.#start(s, j);
    }
    let started = 0;
    while (this.#slots.length < this.#want && this.#queue.length) {
      const i = Math.max(0, this.#queue.findIndex((j) => !this.#owner(j.table)));
      this.#spawn(this.#queue.splice(i, 1)[0]);
      started++;
    }
    this.#idle();
    return started;
  }

  #start(slot, job) {
    slot.job = job;
    slot.tables.add(job.table);
    slot.worker.ref();
    slot.worker.postMessage({ id: job.id, table: job.table, request: job.request, full: job.full });
  }

  #spawn(job) {
    const worker = new Worker(WORKER, { workerData: this.#workerData, stdout: true, stderr: true });
    const slot = { worker, ready: false, job: null, tables: new Set() };
    this.#slots.push(slot);
    this.#start(slot, job);
    worker.on('message', (m) => {
      if (m.type === 'ready') {
        slot.ready = true;
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
