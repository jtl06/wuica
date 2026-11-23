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

  // The size of the instance's memory in bytes (0 after a trap, until the next call).
  get memoryBytes() { return this.#x?.memory.buffer.byteLength ?? 0; }

  // Returns the response object; a trap becomes {error, trapped: true}.
  analyze(request) {
    try {
      this.#live();
    } catch (e) {
      return { error: `the analyzer could not be restarted: ${e instanceof Error ? e.message : e}` };
    }
    const x = this.#x;
    try {
      return this.#call('wuica_analyze', [enc.encode(JSON.stringify(request))]);
    } catch (e) {
      // an allocation that fails ends in `unreachable` like any panic; more than 1 GiB in use: the memory ran out
      let used = 0;
      try { used = x.memory.buffer.byteLength; } catch { /* unknown */ }
      const detail = (e instanceof Error ? e.message : String(e)) + (used >= 2 ** 30 ? `: out of memory, ${(used / 2 ** 30).toFixed(1)} GB in use; try a smaller block or fewer iterations` : '');
      return {
        error: `the analysis failed for this input (the WebAssembly module trapped: ${detail}); the analyzer was restarted`,
        trapped: true,
      };
    }
  }
}

// The module bytes with the maximum of every (32-bit, unshared) memory set to at most `maxPages` (64 KiB each): an
// instance of it traps where an allocation would grow the memory beyond that.
export function capMemory(bytes, maxPages) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const readLeb = (p) => { let r = 0, s = 0, x; do { x = b[p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return [r, p]; };
  const leb = (n) => { const out = []; do { let x = n % 128; n = Math.floor(n / 128); if (n) x |= 0x80; out.push(x); } while (n); return out; };
  let p = 8;
  while (p < b.length) {
    const start = p;
    const id = b[p++];
    let size;
    [size, p] = readLeb(p);
    const end = p + size;
    if (id === 5) { // the memory section
      let q = p, n;
      [n, q] = readLeb(q);
      const body = [...leb(n)];
      for (let i = 0; i < n; i++) {
        const flags = b[q++];
        if (flags > 1) return b; // shared or 64-bit memory: left as it is
        let min, max = Infinity;
        [min, q] = readLeb(q);
        if (flags & 1) [max, q] = readLeb(q);
        body.push(1, ...leb(min), ...leb(Math.max(min, Math.min(max, maxPages))));
      }
      const section = [5, ...leb(body.length), ...body];
      const out = new Uint8Array(b.length - (end - start) + section.length);
      out.set(b.subarray(0, start), 0);
      out.set(section, start);
      out.set(b.subarray(end), start + section.length);
      return out;
    }
    p = end;
  }
  return b;
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

// The analyzer only models 64-bit code: a source that switches the assembler to 16- or 32-bit mode (.code16,
// .code16gcc, .code32; LLVM accepts them in lower case only) would be analyzed as 64-bit code without a word.
// Returns {line, column, message} for the first such directive (outside comments), or null.
export function codeModeError(text) {
  const plain = String(text).replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')); // block comments, lines kept
  const lines = plain.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/(#|\/\/).*$/, '');
    let at = 0;
    for (const stmt of code.split(';')) {
      const m = /^(\s*(?:[\w.$@]+:\s*)*)(\.code(?:16gcc|16|32))(?=\s|$)/.exec(stmt);
      if (m) return { line: i + 1, column: at + m[1].length + 1, message: `${m[2]}: only 64-bit code can be analyzed` };
      at += stmt.length + 1;
    }
  }
  return null;
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
