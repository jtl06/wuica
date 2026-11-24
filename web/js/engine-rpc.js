// The analyzer in a web worker. An analysis is fast for a basic block (milliseconds) but takes seconds for
// thousands of instructions; in a worker it does not freeze the page, and it can be cancelled.
//
//   WorkerEngine   the page's side: the interface of WasmEngine (engine.js) plus cancel()
//   createHandler  the worker's side (engine-worker.js): answers the messages with a WasmEngine
//
// Messages: {id, op, ...arguments} -> {id, ok: true, value} | {id, ok: false, error, engineError}.
// No DOM in here; the worker is created by a function the caller passes in, so the tests can use a fake one.

import { WasmEngine, EngineError, makeRequest } from './engine.js';

// The warm-up block (the npm package's WARM_HEX): ~500 instructions of several kinds in a loop, ~10 ms. V8 compiles the
// module's functions when they are first called, with its baseline compiler, and optimizes the hot ones in the
// background later; after one analysis of this block the first large block runs at nearly full speed.
const WARM_MIX = '4883c001' + '488906' + '8b06' + 'c4e2d5aaf4' + '4c03d1' + '4d0fafc0' + 'c5fc100c87' + 'c4e27da80c86' + 'c5fc110c86'
  + 'f3480fb80cc7' + '4801ca' + 'f2480f38f104cf' + '660f6f0f' + '660f74c8' + '660fd7c1' + '488b00' + 'c4626db8c0' + '4839d0'
  + '4883c708' + '4c8d0c49' + '48c1e005' + '4421c0' + 'c5f857c0' + '488d0c0a';
export const WARM_HEX = WARM_MIX.repeat(20) + '49ffcf' + '0f853bf8ffff';

export class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'CancelledError'; }
}

// A large answer in parts: the long arrays of an answer (the details' rows of a long block, the uops of a trace's model)
// go first, in slices, each a message of its own; the answer itself follows with them left empty and a note of where they
// belong. Reading one message of tens of MB of objects took the page a tenth of a second at once (WorkerEngine joins them).
/** @type {[string, string, number][]} */
const PARTS = [['details', 'rows', 400], ['model', 'uops', 4000]];
export function inParts(answer) {
  const v = answer?.ok ? answer.value : null;
  const out = [];
  if (v && typeof v === 'object') {
    for (const [obj, key, size] of PARTS) {
      const holder = obj === 'details' ? v.details : v[obj];
      const list = holder?.[key];
      if (!Array.isArray(list) || list.length <= size) continue;
      for (let i = 0; i < list.length; i += size) out.push({ id: answer.id, part: `${obj}.${key}`, items: list.slice(i, i + size) });
      holder[key] = [];
    }
  }
  out.push(answer);
  return out;
}

export function createHandler() {
  let engine = null;
  const ops = {
    async init({ module }) { engine = await WasmEngine.create(module); return engine.capabilities; },
    loadUarch: ({ bytes }) => engine.loadUarch(bytes),
    loadArch: ({ name, bytes }) => engine.loadArch(name, bytes),
    analyze: ({ request }) => engine.analyze(request),
    // the dependency view's graph of a run (deps.js), made here from its trace: the page does not receive the trace
    async depGraph({ request }) {
      const res = await engine.analyze({ ...request, includeTrace: true, details: true });
      if (!res || res.error) return { error: res?.error ?? 'no response' };
      const [{ depGraph }, { annotateLatencies }] = await Promise.all([import('./deps.js'), import('./deps-slack.js')]);
      const graph = depGraph(res, res.trace);
      if (graph) annotateLatencies(graph, res, res.details);
      return { graph };
    },
    // a run's trace as the trace view's model (trace.js buildModel), made here: the trace of a large block is tens of
    // MB of objects, which took the page a fifth of a second to receive and read; the model is about half of it.
    // {response (without the trace), model} or {response} if there is no trace.
    async traceModel({ request, opts }) {
      const response = await engine.analyze(request);
      if (!response || response.error || !response.trace) return { response, model: null };
      const { buildModel } = await import('./trace.js');
      const t0 = performance.now();
      const model = buildModel(response.trace, opts);
      model.buildMs = performance.now() - t0;
      delete model.index; // (only buildModel's own)
      const { trace, ...rest } = response;
      return { response: rest, model };
    },
    decode: ({ code, chip }) => engine.decode(code, chip),
    memory: () => engine.memory(),
    warmUp: async ({ arch }) => { await engine.analyze(makeRequest(WARM_HEX, arch)); }, // the result is not used
  };
  /** @type {Promise<unknown>} */
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
  /** @type {Readonly<{cancel: boolean} & Record<string, unknown>>} what the engine can (create) */ capabilities;
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
      const parts = new Map(); // id -> {path -> items}: the parts of a large answer (inParts)
      worker.onmessage = (ev) => {
        const m = ev.data;
        const p = this.#pending.get(m?.id);
        if (!p || worker !== this.#worker) return;
        if (m.part) { const got = parts.get(m.id) ?? new Map(); parts.set(m.id, got); const list = got.get(m.part) ?? []; got.set(m.part, list); for (const x of m.items) list.push(x); return; }
        this.#pending.delete(m.id);
        const got = parts.get(m.id);
        if (got) {
          parts.delete(m.id);
          if (m.ok) for (const [path, list] of got) { const [obj, key] = path.split('.'); const holder = obj === 'details' ? m.value?.details : m.value?.[obj]; if (holder) holder[key] = list; }
        }
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

  // Keeps only the tables named in `keep` and stops the worker (as cancel() does: pending calls reject): the next call
  // starts a new worker with uarch.json and those tables. The module cannot unload a table, and a WebAssembly memory
  // never shrinks, so a new worker is the way to give the memory of the other tables back.
  recycle(keep) {
    const k = new Set(keep);
    for (const name of [...this.#tables.keys()]) if (!k.has(name)) this.#tables.delete(name);
    this.cancel();
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
  // calls that have not been answered yet (recycle() and cancel() would reject them)
  get pending() { return this.#pending.size + (this.#starting ? 1 : 0); }

  async analyze(request) {
    await this.#live();
    return this.#send('analyze', { request });
  }

  async decode(code, chip) {
    await this.#live();
    return this.#send('decode', { code, chip });
  }

  // the dependency view's graph of a run, made in the worker (createHandler: depGraph)
  async depGraph(request) {
    await this.#live();
    return this.#send('depGraph', { request });
  }

  // the trace view's model of a run, made in the worker (createHandler: traceModel)
  async traceModel(request, opts) {
    await this.#live();
    return this.#send('traceModel', { request, opts });
  }

  async memory() {
    await this.#live();
    return this.#send('memory', {});
  }

  // One analysis of WARM_HEX on `arch` (its table loaded), in the worker as it is: not started for it, and stopped
  // like any call by cancel(). Resolves when done; never rejects.
  async warmUp(arch) {
    if (!this.#worker || this.#starting) return;
    await this.#send('warmUp', { arch }).catch(() => {});
  }
}
