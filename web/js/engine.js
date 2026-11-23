// The analyzer: a thin wrapper around wuica_wasm.wasm, written against docs/WASM-API.md.
// No DOM and no fetch in here: the caller passes the bytes of the module and of the data files, so the same code
// runs in the page and under Node (tests-js/web_engine.mjs).
//
// The methods return promises although the calls are synchronous today, so that the engine can move into a
// worker later without changing its users.

const enc = new TextEncoder();
const dec = new TextDecoder();

function asBytes(x) {
  if (typeof x === 'string') return enc.encode(x);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  throw new TypeError('expected a string, Uint8Array or ArrayBuffer');
}

function hexBytes(hex) {
  if (hex instanceof Uint8Array) return hex;
  const s = String(hex);
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new TypeError('hex: an even number of hex digits is required');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(2 * i, 2), 16);
  return out;
}

export class EngineError extends Error {}

// What a trap says, and whether the memory was exhausted: an allocation that fails in the module (a very large block,
// or very many iterations) ends in `unreachable` like any other panic. A normal block needs some MB; an instance that
// trapped with more than 1 GiB most likely ran out of memory (wasm32 has at most 4 GiB, browsers may give less).
export const OOM_BYTES = 2 ** 30;
export function trapDetail(e, exports) {
  const what = e instanceof Error ? e.message : String(e);
  let used = 0;
  try { used = exports?.memory?.buffer?.byteLength ?? 0; } catch { /* no memory to read */ }
  return used >= OOM_BYTES ? `${what}: out of memory, ${(used / 2 ** 30).toFixed(1)} GB in use; try a smaller block or fewer iterations` : what;
}

function check(exports) {
  for (const name of ['memory', 'wuica_alloc', 'wuica_free', 'wuica_result_ptr']) {
    if (!exports?.[name]) throw new EngineError(`not a wuica module: export "${name}" is missing`);
  }
  return exports;
}

export class WasmEngine {
  #instantiate;       // () => promise of the exports of a fresh instance
  #x = null;          // the exports of the current instance; null after a trap, until the next call
  #uarch = null;      // what has been loaded (bytes), to load it again into a fresh instance
  #tables = new Map();

  // `source`: the bytes of wuica_wasm.wasm (Uint8Array / ArrayBuffer), a WebAssembly.Module, or (tests) a
  // function that returns an object with the exports of a fresh instance.
  static async create(source) {
    let instantiate;
    if (typeof source === 'function') {
      instantiate = async () => source();
    } else {
      const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
      instantiate = async () => (await WebAssembly.instantiate(module, {})).exports; // the module has no imports
    }
    const exports = check(await instantiate());
    return new WasmEngine(instantiate, exports);
  }

  constructor(instantiate, exports) {
    this.#instantiate = instantiate;
    this.#x = exports;
    const has = (n) => typeof exports[n] === 'function';
    this.capabilities = Object.freeze({
      decode: has('wuica_decode'),
      // The three belong together: an analysis needs the configurations and a table.
      analyze: has('wuica_analyze') && has('wuica_load_uarch') && has('wuica_load_arch'),
      mock: false,
    });
  }

  // Calls an export whose arguments are (pointer, length) pairs and whose result is a length; returns the bytes
  // of the result as text. Views of the memory are created after every call into the module: any of them,
  // wuica_alloc included, can grow the memory, which detaches the old ArrayBuffer.
  //
  // If the module traps (or anything else is thrown inside it), its state cannot be trusted any more: the
  // instance is dropped, and the next call starts a fresh one (see #live). The exception is passed on.
  #call(name, inputs) {
    const x = this.#x;
    const fn = x[name];
    if (typeof fn !== 'function') throw new EngineError(`this build of the analyzer has no ${name}`);
    const args = [];
    const allocated = [];
    let text;
    try {
      for (const bytes of inputs) {
        const ptr = x.wuica_alloc(bytes.length);
        allocated.push([ptr, bytes.length]);
        new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
        args.push(ptr, bytes.length);
      }
      const len = fn(...args);
      const ptr = x.wuica_result_ptr();
      text = dec.decode(new Uint8Array(x.memory.buffer, ptr, len));
      for (const [p, l] of allocated) x.wuica_free(p, l);
    } catch (e) {
      this.#x = null;
      throw e;
    }
    return text;
  }

  #json(name, inputs) {
    const text = this.#call(name, inputs);
    try {
      return JSON.parse(text);
    } catch {
      throw new EngineError(`${name} returned invalid JSON (${text.length} characters)`);
    }
  }

  // Makes sure there is a usable instance: after a trap, a fresh one with the same data loaded again.
  async #live() {
    if (this.#x) return;
    const x = check(await this.#instantiate());
    this.#x = x;
    try {
      if (this.#uarch) this.#load('wuica_load_uarch', [this.#uarch], 'uarch.json');
      for (const [name, bytes] of this.#tables) this.#load('wuica_load_arch', [enc.encode(name), bytes], `instruction table ${name}`);
    } catch (e) {
      this.#x = null;
      throw e;
    }
  }

  #load(fn, inputs, what) {
    const r = this.#json(fn, inputs);
    if (!r || r.ok !== true) throw new EngineError(`${what}: ${r?.error ?? 'not loaded'}`);
  }

  // data/uarch.json (text or bytes). Throws EngineError if the module rejects it.
  async loadUarch(json) {
    await this.#live();
    const bytes = asBytes(json);
    this.#load('wuica_load_uarch', [bytes], 'uarch.json');
    this.#uarch = bytes;
  }

  // data/arch/<name>.json (text or bytes); `name` is configs[arch].name. The bytes are kept (not copied), to be
  // loaded again if the module has to be restarted: do not modify them afterwards.
  async loadArch(name, json) {
    await this.#live();
    const bytes = asBytes(json);
    this.#load('wuica_load_arch', [enc.encode(name), bytes], `instruction table ${name}`);
    this.#tables.set(name, bytes);
  }

  hasUarch() { return this.#uarch !== null; }
  hasArch(name) { return this.#tables.has(name); }

  // The size of the instance's memory in bytes (WebAssembly memory only grows: the most it has used); 0 after a trap.
  async memory() { return this.#x?.memory.buffer.byteLength ?? 0; }

  // request: see "Analysis request" in docs/WASM-API.md ({hex, arch, ...}). Resolves to the response object.
  // A failed analysis is a response with an `error` field, not an exception; that includes an input on which
  // the module traps (`trapped: true` is set then, and the module is restarted before the next call).
  async analyze(request) {
    await this.#live();
    const input = [enc.encode(JSON.stringify(request))];
    const x = this.#x;
    try {
      return this.#json('wuica_analyze', input);
    } catch (e) {
      if (e instanceof EngineError) throw e;
      return { error: 'the analysis failed for this input', trapped: true, detail: trapDetail(e, x) };
    }
  }

  // Decodes machine code (hex string or bytes) for an XED chip name (configs[arch].XEDName).
  // Resolves to the array of decoded instructions, or to {error}.
  async decode(code, chip) {
    const bytes = hexBytes(code);
    await this.#live();
    return this.#json('wuica_decode', [bytes, enc.encode(chip)]);
  }
}

// The complete request with the defaults of docs/WASM-API.md; unknown fields are dropped.
export const REQUEST_DEFAULTS = Object.freeze({
  alignmentOffset: 0,
  initPolicy: 'diff',
  simpleFrontEnd: false,
  noMicroFusion: false,
  noMacroFusion: false,
  minIterations: 10,
  minCycles: 500,
  includeTrace: false,
});

export function makeRequest(hex, arch, options = {}) {
  const req = { hex, arch };
  for (const [k, d] of Object.entries(REQUEST_DEFAULTS)) req[k] = options[k] ?? d;
  return req;
}
