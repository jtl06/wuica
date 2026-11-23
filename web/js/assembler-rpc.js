// The assembler (assembler.js) in a web worker of its own. Assembling is fast for a basic block (about 0.1 ms) but
// takes seconds for a large .rept; in a worker it does not freeze the page, and it can be stopped.
//
//   PageAssembler            what the page uses: small sources on the page's thread, the others in the worker
//   WorkerAssembler          the page's side of the worker: assemble(text, syntax, {signal}), the result of
//                            WasmAssembler.assemble
//   createAssemblerHandler   the worker's side (assembler-worker.js)
//
// Small sources stay on the page's thread: a trip to a worker and back costs a little on every keystroke in live mode
// (measured in headless Chrome with the default example: about +2 ms per live edit and +6 ms per Analyze click, as
// the reply misses the frame the result would have been painted in; and a worker to start on the first load), and a
// source without directives cannot make much code: every directive that makes code out of little text (.rept, .fill,
// .zero, .skip, .p2align, .macro, ...) contains a '.', and without one each line gives at most 15 bytes.
// The worker is started when the first source that needs it comes.
//
// The page sends one job at a time and keeps the others in a queue, so that a job can be stopped on its own: aborting a
// waiting job removes it; aborting the running one stops the worker (the only way to interrupt WebAssembly), the jobs
// behind it go to a new worker. Several callers share it (the run, side B of A–B, the hex <-> asm conversion): a run
// that is replaced never takes a conversion with it.
//
// The analyzer has a worker of its own (engine-rpc.js), so an assembly never waits behind an analysis and stopping one
// never drops the other's tables. A separate worker also keeps engine*.js unchanged; its start-up (tens of ms) only
// delays the first large source.
//
// Messages: {id, op: 'init', module} | {id, op: 'assemble', text, syntax} -> {id, ok: true, value} | {id, ok: false, error}.
// No DOM in here; the worker is made by a function the caller passes in, so the tests can use a fake one.

import { WasmAssembler } from './assembler.js';

export class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'CancelledError'; }
}

// The worker drops its instance after a job that left it with more memory than this (WebAssembly memory never shrinks;
// a large .rept can take hundreds of MB); the next job makes a new one (a few ms).
export const ASM_MEMORY_LIMIT = 256 * 2 ** 20;

export function createAssemblerHandler({ memoryLimit = ASM_MEMORY_LIMIT } = {}) {
  let asm = null;
  return async (msg) => {
    try {
      if (msg.op === 'init') {
        asm = await WasmAssembler.create(msg.module);
        return { id: msg.id, ok: true, value: null };
      }
      if (msg.op !== 'assemble' || !asm) throw new Error(`assembler worker: cannot ${msg.op}`);
      const value = await asm.assemble(msg.text, msg.syntax);
      if (asm.memoryBytes > memoryLimit) asm.reset();
      return { id: msg.id, ok: true, value };
    } catch (e) {
      return { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

export class WorkerAssembler {
  #module;
  #spawn;
  #worker = null;
  #ready = false;      // the worker has its instance
  #queue = [];         // jobs not sent yet: {id, msg, resolve, reject, signal, onAbort}
  #current = null;     // the job the worker is running
  #seq = 0;
  stats = { workers: 0, stopped: 0 };

  // module: the compiled wuica_asm.wasm (WebAssembly.Module; it is shared with every worker); spawn: () => Worker.
  // Resolves when the first worker has its instance; rejects if it cannot be started (the caller then runs
  // WasmAssembler on its own thread).
  static async create(module, spawn) {
    const a = new WorkerAssembler(module, spawn);
    await new Promise((resolve, reject) => a.#start({ resolve, reject }));
    return a;
  }

  constructor(module, spawn) {
    this.#module = module;
    this.#spawn = spawn;
  }

  // Starts a worker; started: {resolve, reject} of create(), else null (a failure then fails the waiting jobs).
  #start(started = null) {
    let worker;
    try {
      worker = this.#spawn();
    } catch (e) {
      const err = new Error(`the assembler's worker could not be started: ${e?.message ?? e}`);
      if (started) started.reject(err); else this.#failAll(err);
      return;
    }
    this.stats.workers++;
    this.#worker = worker;
    this.#ready = false;
    const initId = ++this.#seq;
    worker.onmessage = (ev) => {
      if (worker !== this.#worker) return;
      const m = ev.data;
      if (m?.id === initId) {
        if (!m.ok) {
          this.#stop();
          const err = new Error(`the assembler could not be started: ${m.error}`);
          if (started) started.reject(err); else this.#failAll(err);
          return;
        }
        this.#ready = true;
        started?.resolve();
        this.#pump();
        return;
      }
      const job = this.#current;
      if (!job || m?.id !== job.id) return;
      this.#current = null;
      this.#settle(job);
      if (m.ok) job.resolve(m.value); else job.reject(new Error(m.error));
      this.#pump();
    };
    worker.onerror = (ev) => {
      ev?.preventDefault?.();
      if (worker !== this.#worker) return;
      const err = new Error(`the assembler's worker failed${ev?.message ? ': ' + ev.message : ''}`);
      const job = this.#current;
      const wasReady = this.#ready;
      this.#stop();
      if (started && !wasReady) { started.reject(err); return; } // the first worker did not start: create() rejects
      if (job) { this.#settle(job); job.reject(err); }
      if (!wasReady) this.#failAll(err); // a new worker did not start: no endless restarts
      else if (this.#queue.length) this.#start(); // the waiting jobs get a new worker
    };
    worker.postMessage({ id: initId, op: 'init', module: this.#module });
  }

  #stop() {
    this.#worker?.terminate();
    this.#worker = null;
    this.#ready = false;
    this.#current = null;
  }

  #failAll(err) {
    for (const job of this.#queue.splice(0)) { this.#settle(job); job.reject(err); }
  }

  #settle(job) {
    job.signal?.removeEventListener('abort', job.onAbort);
  }

  #pump() {
    if (this.#current || !this.#queue.length) return;
    if (!this.#worker) { this.#start(); return; }
    if (!this.#ready) return;
    const job = this.#queue.shift();
    this.#current = job;
    this.#worker.postMessage(job.msg);
  }

  #abort(job) {
    if (this.#current === job) {
      // running: only stopping the worker interrupts it; the next worker starts now, so the next job does not wait for it
      this.stats.stopped++;
      this.#stop();
      this.#settle(job);
      job.reject(new CancelledError());
      this.#start();
      return;
    }
    const i = this.#queue.indexOf(job);
    if (i < 0) return;
    this.#queue.splice(i, 1);
    this.#settle(job);
    job.reject(new CancelledError());
  }

  // text: assembly source; syntax: 'intel' | 'att'; signal: an AbortSignal that stops this job (it rejects with
  // CancelledError). Resolves to the result of WasmAssembler.assemble.
  assemble(text, syntax = 'intel', { signal = null } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new CancelledError()); return; }
      const id = ++this.#seq;
      const job = { id, msg: { id, op: 'assemble', text: String(text), syntax }, resolve, reject, signal, onAbort: null };
      if (signal) {
        job.onAbort = () => this.#abort(job);
        signal.addEventListener('abort', job.onAbort);
      }
      this.#queue.push(job);
      this.#pump();
    });
  }

  // Stops everything: every job rejects with CancelledError; the next call starts a new worker.
  cancel() {
    const job = this.#current;
    this.#stop();
    if (job) { this.#settle(job); job.reject(new CancelledError()); }
    this.#failAll(new CancelledError());
  }

  // true while a job runs or waits
  get busy() { return !!this.#current || this.#queue.length > 0; }
}

// At most this many characters, and no '.', is assembled on the page's thread (measured in Node: 8 KiB of `add rax, 1`
// lines about 3.5 ms, of VEX instructions with memory operands about 2.5 ms; the default example 0.07 ms).
export const SMALL_SOURCE = 8192;
export const onPageThread = (text) => text.length <= SMALL_SOURCE && !text.includes('.');

export class PageAssembler {
  #local;
  #makeWorker;
  #worker = null; // promise of a WorkerAssembler, or of null (no workers here: everything on the page's thread)

  // local: a WasmAssembler on this thread; makeWorker: () => promise of a WorkerAssembler (called once, when needed).
  constructor(local, makeWorker) {
    this.#local = local;
    this.#makeWorker = makeWorker;
  }

  // As WorkerAssembler.assemble; a small source is not stopped by the signal (it takes about a millisecond).
  async assemble(text, syntax = 'intel', { signal = null } = {}) {
    if (signal?.aborted) throw new CancelledError();
    const source = String(text);
    if (onPageThread(source)) return this.#local.assemble(source, syntax);
    this.#worker ??= Promise.resolve().then(this.#makeWorker).catch(() => null);
    const w = await this.#worker;
    if (!w) return this.#local.assemble(source, syntax);
    return w.assemble(source, syntax, { signal });
  }

  // the worker, if it has been started (tests)
  get worker() { return this.#worker; }
}
