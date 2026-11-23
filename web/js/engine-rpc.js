// The analyzer in a web worker. An analysis is fast for a basic block (milliseconds) but takes seconds for
// thousands of instructions; in a worker it does not freeze the page, and it can be cancelled.
//
//   WorkerEngine   the page's side: the interface of WasmEngine (engine.js) plus cancel()
//   createHandler  the worker's side (engine-worker.js): answers the messages with a WasmEngine
//
// Messages: {id, op, ...arguments} -> {id, ok: true, value} | {id, ok: false, error, engineError}.
// No DOM in here; the worker is created by a function the caller passes in, so the tests can use a fake one.

import { WasmEngine, EngineError } from './engine.js';

export class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'CancelledError'; }
}

export function createHandler() {
  let engine = null;
  const ops = {
    async init({ module }) { engine = await WasmEngine.create(module); return engine.capabilities; },
    loadUarch: ({ bytes }) => engine.loadUarch(bytes),
    loadArch: ({ name, bytes }) => engine.loadArch(name, bytes),
    analyze: ({ request }) => engine.analyze(request),
    decode: ({ code, chip }) => engine.decode(code, chip),
  };
  let queue = Promise.resolve(); // one message at a time, in order
  return (msg) => {
    const answer = queue.then(async () => {
      try {
        if (!ops[msg.op] || (msg.op !== 'init' && !engine)) throw new Error(`engine worker: cannot ${msg.op}`);
        return { id: msg.id, ok: true, value: await ops[msg.op](msg) };
      } catch (e) {
        return { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e), engineError: e instanceof EngineError };
      }
    });
    queue = answer;
    return answer;
  };
}

export class WorkerEngine {
  #spawn;
  #module;
  #worker = null;
  #starting = null;
  #pending = new Map();
  #seq = 0;
  #uarch = null;        // what has been loaded, to load it again into a new worker after cancel()
  #tables = new Map();

  // source: the bytes of wuica_wasm.wasm or a WebAssembly.Module (it is compiled once and shared with every
  // worker); spawn: () => Worker (anything with postMessage, terminate, onmessage, onerror).
  // Rejects if the worker cannot be started; the caller can then use WasmEngine directly.
  static async create(source, spawn) {
    // (tests pass a function that makes fake exports; a real worker could not receive that)
    const module = source instanceof WebAssembly.Module || typeof source === 'function' ? source : await WebAssembly.compile(source);
    const e = new WorkerEngine(module, spawn);
    const caps = await e.#live();
    e.capabilities = Object.freeze({ ...caps, cancel: true });
    return e;
  }

  constructor(module, spawn) {
    this.#module = module;
    this.#spawn = spawn;
  }

  #fail(error) {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#worker?.terminate();
    this.#worker = null;
    this.#starting = null;
    for (const p of pending) p.reject(error);
  }

  #send(op, args) {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      if (!this.#worker) { reject(new CancelledError()); return; } // cancelled just before
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, op, ...args });
    });
  }

  // A running worker with the data loaded; resolves to the engine's capabilities when it had to be started.
  #live() {
    if (this.#worker && !this.#starting) return Promise.resolve(null);
    if (this.#starting) return this.#starting;
    const starting = (async () => {
      let worker;
      try {
        worker = this.#spawn();
      } catch (e) {
        throw new Error(`the analyzer's worker could not be started: ${e?.message ?? e}`);
      }
      this.#worker = worker;
      worker.onmessage = (ev) => {
        const m = ev.data;
        const p = this.#pending.get(m?.id);
        if (!p || worker !== this.#worker) return;
        this.#pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else p.reject(m.engineError ? new EngineError(m.error) : new Error(m.error));
      };
      worker.onerror = (ev) => {
        ev?.preventDefault?.();
        if (worker === this.#worker) this.#fail(new Error(`the analyzer's worker failed${ev?.message ? ': ' + ev.message : ''}`));
      };
      const caps = await this.#send('init', { module: this.#module });
      if (this.#uarch) await this.#send('loadUarch', { bytes: this.#uarch });
      for (const [name, bytes] of this.#tables) await this.#send('loadArch', { name, bytes });
      return caps;
    })();
    this.#starting = starting;
    starting.then(
      () => { if (this.#starting === starting) this.#starting = null; },
      () => { if (this.#starting === starting) { this.#starting = null; this.#worker?.terminate(); this.#worker = null; } }, // try again on the next call
    );
    return starting;
  }

  // Stops whatever the analyzer is doing: every pending call rejects with CancelledError. The next call starts
  // a new worker and loads the data into it again.
  cancel() {
    if (this.#worker || this.#pending.size) this.#fail(new CancelledError());
  }

  async loadUarch(json) {
    const bytes = typeof json === 'string' ? new TextEncoder().encode(json) : json;
    await this.#live();
    await this.#send('loadUarch', { bytes });
    this.#uarch = bytes;
  }

  async loadArch(name, json) {
    const bytes = typeof json === 'string' ? new TextEncoder().encode(json) : json;
    await this.#live();
    await this.#send('loadArch', { name, bytes });
    this.#tables.set(name, bytes);
  }

  hasUarch() { return this.#uarch !== null; }
  hasArch(name) { return this.#tables.has(name); }

  async analyze(request) {
    await this.#live();
    return this.#send('analyze', { request });
  }

  async decode(code, chip) {
    await this.#live();
    return this.#send('decode', { code, chip });
  }
}
