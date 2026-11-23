// Thin synchronous wrappers around the two WebAssembly modules:
//   Analyzer   wuica_wasm.wasm  (docs/WASM-API.md in the wuica repository)
//   Assembler  wuica_asm.wasm   (assembler/README.md)
// Neither module has imports. A trap (any exception thrown out of a call into a module) leaves the instance unusable:
// it is dropped, and the next call instantiates the compiled module again (the analyzer also reloads its tables).
// Nothing in here writes to stdout (the MCP server speaks JSON-RPC on stdout).

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Analyzer {
  #module;
  #x = null;
  #uarch = null;          // bytes of uarch.json, kept to reload after a trap
  #tables = new Map();    // table name -> bytes of data/arch/<name>.json
  restarts = 0;

  constructor(module) {
    this.#module = module;
    this.#live();
    for (const n of ['memory', 'wuica_alloc', 'wuica_free', 'wuica_result_ptr', 'wuica_load_uarch', 'wuica_load_arch', 'wuica_analyze']) {
      if (!this.#x[n]) throw new Error(`not a wuica analyzer module: export "${n}" is missing`);
    }
  }

  // Arguments are byte arrays passed as (pointer, length); the result is the text at wuica_result_ptr(). Views of the
  // memory are created after each call into the module, since any call can grow the memory.
  #call(name, inputs) {
    const x = this.#x;
    try {
      const args = [], allocated = [];
      for (const bytes of inputs) {
        const ptr = x.wuica_alloc(bytes.length);
        new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
        allocated.push([ptr, bytes.length]);
        args.push(ptr, bytes.length);
      }
      const len = x[name](...args);
      const text = dec.decode(new Uint8Array(x.memory.buffer, x.wuica_result_ptr(), len));
      for (const [p, l] of allocated) x.wuica_free(p, l);
      return JSON.parse(text);
    } catch (e) {
      this.#x = null;
      throw e;
    }
  }

  #live() {
    if (this.#x) return;
    if (this.#uarch) this.restarts++;
    this.#x = new WebAssembly.Instance(this.#module, {}).exports;
    if (this.#uarch) this.#load('wuica_load_uarch', [this.#uarch], 'uarch.json');
    for (const [name, bytes] of this.#tables) this.#load('wuica_load_arch', [enc.encode(name), bytes], `instruction table ${name}`);
  }

  #load(fn, inputs, what) {
    const r = this.#call(fn, inputs);
    if (r?.ok !== true) throw new Error(`${what}: ${r?.error ?? 'not loaded'}`);
  }

  loadUarch(bytes) {
    this.#live();
    this.#load('wuica_load_uarch', [bytes], 'uarch.json');
    this.#uarch = bytes;
  }

  loadArch(name, bytes) {
    this.#live();
    this.#load('wuica_load_arch', [enc.encode(name), bytes], `instruction table ${name}`);
    this.#tables.set(name, bytes);
  }

  hasArch(name) { return this.#tables.has(name); }

  // Returns the response object; a trap becomes {error, trapped: true}.
  analyze(request) {
    try {
      this.#live();
    } catch (e) {
      return { error: `the analyzer could not be restarted: ${e instanceof Error ? e.message : e}` };
    }
    try {
      return this.#call('wuica_analyze', [enc.encode(JSON.stringify(request))]);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return {
        error: `the analysis failed for this input (the WebAssembly module trapped: ${detail}); the analyzer was restarted`,
        trapped: true,
      };
    }
  }
}

// llvm-mc's diagnostics: "<input>:LINE:COL: error: MESSAGE", followed by the source line and a caret line.
export function parseDiagnostics(text) {
  const out = [];
  for (const l of String(text ?? '').split('\n')) {
    const m = /^[^:\n]*:(\d+):(\d+): (error|warning|note): (.*)$/.exec(l);
    if (m) out.push({ line: Number(m[1]), column: Number(m[2]), severity: m[3], message: m[4].trim() });
  }
  const rest = String(text ?? '').trim();
  if (out.length === 0 && rest !== '') out.push({ line: null, column: null, severity: 'error', message: rest.split('\n')[0] });
  return out;
}

// GNU as's {load}/{store} pseudo-prefixes at the start of a line, which LLVM's assembler rejects.
export function stripHints(text) {
  return text.replace(/^([ \t]*)\{(?:load|store)\}[ \t]*/gm, '$1');
}

const OUT_CAP = 1 << 20;
const ERR_CAP = 1 << 16;

export class Assembler {
  #module;
  #x = null;

  constructor(module) {
    this.#module = module;
    this.#live();
    for (const n of ['memory', 'malloc', 'free', 'wuica_assemble']) {
      if (!this.#x[n]) throw new Error(`not a wuica assembler module: export "${n}" is missing`);
    }
  }

  #live() {
    if (this.#x) return;
    const x = new WebAssembly.Instance(this.#module, {}).exports;
    x._initialize?.();
    this.#x = x;
  }

  // syntax: 0 = Intel (noprefix), 1 = AT&T. Returns {ok: true, bytes, message} or {ok: false, status, message}.
  assemble(text, syntax) {
    this.#live();
    const x = this.#x;
    const src = enc.encode(stripHints(text) + '\0');
    let textPtr = 0, outPtr = 0, errPtr = 0;
    try {
      textPtr = x.malloc(src.length); outPtr = x.malloc(OUT_CAP); errPtr = x.malloc(ERR_CAP);
      new Uint8Array(x.memory.buffer).set(src, textPtr);
      const n = x.wuica_assemble(textPtr, syntax, outPtr, OUT_CAP, errPtr, ERR_CAP);
      const mem = new Uint8Array(x.memory.buffer);
      const end = mem.indexOf(0, errPtr);
      const message = dec.decode(mem.subarray(errPtr, end < 0 ? errPtr : end));
      const r = n >= 0 ? { ok: true, bytes: mem.slice(outPtr, outPtr + n), message } : { ok: false, status: n, message };
      x.free(textPtr); x.free(outPtr); x.free(errPtr);
      return r;
    } catch (e) {
      let fatal = '';
      try {
        const p = x.wuica_fatal_message?.();
        if (p) { const mem = new Uint8Array(x.memory.buffer); fatal = dec.decode(mem.subarray(p, mem.indexOf(0, p))); }
      } catch { /* the message is optional */ }
      this.#x = null;
      return { ok: false, status: 'trap', message: `the assembler failed${fatal ? `: ${fatal}` : ''} (${e instanceof Error ? e.message : e}); it was restarted` };
    }
  }
}
