// A fixed-size pool of analysis workers (worker_threads) with a bounded FIFO queue and a time budget per job.
//
// - Each worker runs one job at a time. A job that exceeds the budget gets {code: 3, timedOut: true}; its worker is
//   terminated (this also stops a WebAssembly loop) and replaced.
// - A worker that dies (crash, out of memory) fails its job with code 3 and is replaced; so is a worker that asks to be
//   recycled after its job (its WebAssembly memory has grown).
// - run() rejects with a BusyError when the queue is full (the HTTP layer answers 503 with Retry-After).

import { Worker } from 'node:worker_threads';

export class BusyError extends Error {
  constructor(retryAfter) { super('the server is busy'); this.retryAfter = retryAfter; }
}

const WORKER = new URL('./worker.js', import.meta.url);

function failure(error, extra = {}) {
  return { code: 3, error, stderr: [{ text: error }], ...extra };
}

// The failure of a job that ran out of the server's time budget (limitMs).
export function timeoutFailure(limitMs) {
  return failure(`the analysis took longer than ${(limitMs / 1000).toString()} s, the limit of this server`, { timedOut: true });
}

export class Pool {
  #size; #maxQueue; #timeoutMs; #workerData; #log;
  #slots = [];          // {worker, ready, job, timer, started}
  #queue = [];          // {id, op, args, resolve, enqueued}
  #nextId = 1;
  #closed = false;
  #respawnDelay = 0;
  #avgRunMs = 10;       // moving average of the job run time, for Retry-After
  stats = { jobs: 0, timeouts: 0, crashes: 0, recycled: 0, rejected: 0 };

  constructor({ size, maxQueue, timeoutMs, workerData, log = () => {} }) {
    this.#size = size; this.#maxQueue = maxQueue; this.#timeoutMs = timeoutMs; this.#workerData = workerData; this.#log = log;
  }

  // Starts the workers and waits until all of them are ready (rejects if one cannot start).
  async start() {
    await Promise.all(Array.from({ length: this.#size }, (_, i) => this.#spawn(i)));
  }

  get size() { return this.#size; }
  get queued() { return this.#queue.length; }
  get busy() { return this.#slots.filter((s) => s?.job).length; }
  get ready() { return this.#slots.filter((s) => s?.ready).length; }
  get idle() { return this.#slots.filter((s) => s?.ready && !s.job).length; }

  #spawn(i) {
    return new Promise(/** @type {(resolve: (v?: void) => void, reject: (e: Error) => void) => void} */ ((resolve, reject) => {
      const worker = new Worker(WORKER, { workerData: this.#workerData });
      /** @type {{worker: Worker, ready: boolean, job: any, timer: any, started: number}} */
      const slot = { worker, ready: false, job: null, timer: null, started: 0 };
      this.#slots[i] = slot;
      worker.on('message', (m) => {
        if (m.type === 'ready') {
          slot.ready = true;
          this.#respawnDelay = 0;
          resolve();
          this.#pump();
        } else if (m.type === 'init-error') {
          if (this.#slots[i] === slot) this.#slots[i] = null;
          reject(new Error(`a worker could not start: ${m.message}`));
        } else this.#done(slot, m);
      });
      worker.on('error', (e) => {
        this.#log({ event: 'worker-error', error: String(e?.message ?? e).split('\n')[0] });
        if (!slot.ready) {
          if (this.#slots[i] === slot) this.#slots[i] = null;
          worker.terminate().catch(() => {});
          reject(e);
        }
      });
      worker.on('exit', (code) => {
        if (this.#slots[i] !== slot) return; // replaced on purpose (timeout, recycle) or failed to start
        slot.ready = false;
        if (slot.job) {
          this.stats.crashes++;
          this.#finish(slot, failure(`the analysis worker stopped unexpectedly (exit code ${code}); the input may need more memory than this server allows`, { crashed: true }), {});
        }
        if (!this.#closed) this.#replace(i, 'exit');
      });
    }));
  }

  // Replaces the worker in slot i (after a delay that grows while new workers keep failing).
  #replace(i, reason) {
    const delay = this.#respawnDelay;
    this.#respawnDelay = Math.min(5000, Math.max(100, delay * 2));
    this.#slots[i] = null;
    this.#log({ event: 'worker-replace', reason });
    const go = () => {
      if (this.#closed) return;
      this.#spawn(i).catch((e) => {
        this.#log({ event: 'worker-start-failed', error: String(e?.message ?? e).split('\n')[0] });
        this.#replace(i, 'start-failed');
      });
    };
    if (delay) setTimeout(go, delay).unref(); else go();
  }

  // Resolves to the job's message {result, meta}; never rejects except with BusyError (queue full) or when closed.
  // timeoutMs: this job's budget, if less than the server's (a part of a compare gets what is left of the whole one's).
  run(op, args, { timeoutMs = this.#timeoutMs } = {}) {
    if (this.#closed) return Promise.reject(new BusyError(5));
    if (this.#queue.length >= this.#maxQueue) {
      this.stats.rejected++;
      return Promise.reject(new BusyError(Math.min(30, Math.max(1, Math.ceil((this.#queue.length * this.#avgRunMs) / this.#size / 1000)))));
    }
    return new Promise((resolve) => {
      this.#queue.push({ id: this.#nextId++, op, args, resolve, enqueued: performance.now(), timeoutMs: Math.min(timeoutMs, this.#timeoutMs) });
      this.#pump();
    });
  }

  #pump() {
    for (let i = 0; i < this.#slots.length && this.#queue.length; i++) {
      const slot = this.#slots[i];
      if (!slot || !slot.ready || slot.job) continue;
      const job = this.#queue.shift();
      slot.job = job;
      slot.started = performance.now();
      slot.timer = setTimeout(() => this.#timeout(i, slot), Math.max(1, job.timeoutMs));
      slot.worker.postMessage({ id: job.id, op: job.op, args: job.args });
    }
  }

  #finish(slot, result, meta, extra = {}) {
    const job = slot.job;
    clearTimeout(slot.timer);
    slot.job = null;
    slot.timer = null;
    if (!job) return;
    this.stats.jobs++;
    const runMs = performance.now() - slot.started;
    this.#avgRunMs = 0.9 * this.#avgRunMs + 0.1 * runMs;
    job.resolve({ result, meta, queueMs: slot.started - job.enqueued, runMs, ...extra });
  }

  #done(slot, m) {
    if (!slot.job || slot.job.id !== m.id) return;
    this.#finish(slot, m.result, m.meta ?? {});
    const i = this.#slots.indexOf(slot);
    if (m.recycle && !this.#closed && i >= 0) {
      this.stats.recycled++;
      slot.ready = false;
      this.#slots[i] = null;
      slot.worker.terminate().catch(() => {});
      this.#respawnDelay = 0;
      this.#replace(i, 'recycle');
    }
    this.#pump();
  }

  #timeout(i, slot) {
    if (this.#slots[i] !== slot || !slot.job) return;
    this.stats.timeouts++;
    this.#finish(slot, timeoutFailure(this.#timeoutMs), {}, { timedOut: true });
    slot.ready = false;
    this.#slots[i] = null;
    slot.worker.terminate().catch(() => {});
    this.#respawnDelay = 0;
    this.#replace(i, 'timeout');
  }

  // Waits for the running jobs (up to graceMs), fails the queued ones, and terminates the workers.
  async close(graceMs = 0) {
    this.#closed = true;
    for (const job of this.#queue.splice(0)) job.resolve({ result: failure('the server is shutting down'), meta: {}, shuttingDown: true });
    const deadline = Date.now() + graceMs;
    while (this.busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await Promise.all(this.#slots.filter(Boolean).map((s) => {
      if (s.job) this.#finish(s, failure('the server is shutting down'), {}, { shuttingDown: true });
      return s.worker.terminate().catch(() => {});
    }));
  }
}
