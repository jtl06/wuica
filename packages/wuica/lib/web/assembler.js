// Adapter for the assembler module (wuica_asm.wasm: LLVM's x86 assembler, built in assembler/). The rest of the
// page only uses: WasmAssembler.create(bytes), assemble(text, syntax) and the result shape below. The page runs small
// sources on its own thread and large ones in a worker (assembler-rpc.js).
//
// The interface is the one of assembler/README.md ("Interface", "Rules"): exports memory, _initialize, malloc,
// free, wuica_assemble, wuica_fatal_message; no imports (the import object is {});
//   int wuica_assemble(const char *text /* UTF-8, NUL-terminated */, int syntax /* 0 Intel, 1 AT&T */,
//                      unsigned char *out, unsigned out_cap, char *err, unsigned err_cap)
//   returns  the number of .text bytes, or -1 (diagnostics in err), -2 (out too small: "N bytes needed"),
//            -3 (bad arguments / internal error); err holds llvm-mc style diagnostics, or warnings on success.
// _initialize() once per instance; views of the memory after each call; a trap (out of memory) makes the instance
// unusable: it is dropped and the next call instantiates the compiled module again.
// GNU as's {load}/{store} hints, which LLVM rejects, are removed at the start of a line, as the README suggests
// (they only pick between two encodings of the same length).
//
// assemble() resolves to
//   { ok: true,  bytes: Uint8Array, diagnostics: [...] }   diagnostics: warnings, if any
//   { ok: false, diagnostics: [{ line, column, severity, message }] }   line/column are 1-based or null
// No DOM and no fetch in here.

export const SYNTAX = Object.freeze({ intel: 0, att: 1 });
const ERR_CAP = 16384;
const OUT_CAP = 1 << 16;
// At most this much machine code (as in the npm package), assembled or given as hex: a block this large is already
// more than the analyzer can simulate in its memory.
export const MAX_CODE_BYTES = 1 << 20;
export const tooMuchCode = (bytes) => `Too much machine code: ${bytes.toLocaleString('en-US')} bytes (at most ${MAX_CODE_BYTES.toLocaleString('en-US')})`;

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

// The text as the module gets it, the one preparation for the page and the npm package (lib/wasm.js): no byte order
// mark at the start (not code: LLVM would reject it), a NUL character as a space (the module reads a C string, which
// ends at the first NUL: clang -g -S writes NULs into the comments of its .debug_str bytes, and the text after one,
// with the labels it defines, would be lost), and stripHints. Lines and columns stay where they are.
export function prepareSource(text) {
  return stripHints(String(text).replace(/^\uFEFF/, '').replace(/\0/g, ' '));
}

// Removes GNU as's {load} / {store} pseudo-prefixes at the start of a line (LLVM 22 says "unknown prefix"), and reads
// directives of newer compilers that the bundled LLVM 22 does not know: clang 23's `.prefalign LOG2, END, FILL` (a
// function's preferred alignment) as `.p2align LOG2`, the alignment clang 22 wrote there. Lines stay where they are.
export function stripHints(text) {
  return text.replace(/^([ \t]*)\{(?:load|store)\}[ \t]*/gm, '$1')
    .replace(/^([ \t]*)\.prefalign[ \t]+(\d+)[^\n#]*/gm, '$1.p2align $2');
}

// LLVM (like GNU as) reads ';' as a separator between statements, not as a comment, so "add rax, 1 ; note" fails with
// "invalid instruction mnemonic 'note'". Such an error (right after a ';') gets a hint. diagnostics: changed in place.
export function semicolonHint(diagnostics, text) {
  const lines = String(text).split('\n');
  for (const d of diagnostics) {
    if (d.severity !== 'error' || !d.line || !d.column || !/^(invalid instruction mnemonic|unexpected token at start of statement)/.test(d.message)) continue;
    if (/;\s*$/.test((lines[d.line - 1] ?? '').slice(0, d.column - 1))) d.message += " (';' separates instructions; comments start with '#')";
  }
  return diagnostics;
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

// True if the bytes are a WebAssembly module. A static host may answer a missing file with an HTML page and
// status 200, so the status of the response is not enough.
export function isWasm(bytes) {
  return bytes?.length >= 8 && bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
}

export class WasmAssembler {
  /** @type {any} */
  #module; // a WebAssembly.Module, or a function that makes the exports (create())
  /** @type {any} */
  #x = null; // the instance's exports

  // source: the bytes of wuica_asm.wasm, a WebAssembly.Module, or (tests) a function that returns a fresh object with
  // the exports.
  static async create(source) {
    const a = new WasmAssembler();
    if (typeof source === 'function' || source instanceof WebAssembly.Module) {
      a.#module = source;
    } else {
      if (!isWasm(source)) throw new Error('wuica_asm.wasm is not a WebAssembly module');
      a.#module = await WebAssembly.compile(source);
    }
    await a.#instantiate();
    return a;
  }

  // The size of the instance's memory (it only grows: the most it has used); 0 if there is no instance.
  get memoryBytes() { return this.#x?.memory.buffer.byteLength ?? 0; }

  // Drops the instance (and its memory); the next call makes a new one.
  reset() { this.#x = null; }

  async #instantiate() {
    let x;
    if (typeof this.#module === 'function') {
      x = this.#module();
    } else {
      // The module is specified to have no imports. If a build has some after all (WASI), give it functions that
      // fail with ENOSYS instead of refusing to load.
      const imports = {};
      for (const i of WebAssembly.Module.imports(this.#module)) {
        if (i.kind !== 'function') throw new Error(`wuica_asm.wasm: unsupported import ${i.module}.${i.name}`);
        (imports[i.module] ??= {})[i.name] = () => 52;
      }
      x = (await WebAssembly.instantiate(/** @type {WebAssembly.Module} */ (this.#module), imports)).exports;
    }
    for (const name of ['memory', 'malloc', 'free', 'wuica_assemble']) {
      if (!x[name]) throw new Error(`wuica_asm.wasm: export "${name}" is missing`);
    }
    x._initialize?.(); // static constructors; once per instance, before anything else
    this.#x = x;
  }

  #cstr(ptr) {
    const mem = new Uint8Array(this.#x.memory.buffer);
    let end = mem.indexOf(0, ptr);
    if (end < 0) end = mem.length;
    return new TextDecoder().decode(mem.subarray(ptr, end));
  }

  #run(source, syntax, outCap) {
    const x = this.#x;
    const textPtr = x.malloc(source.length);
    const outPtr = x.malloc(outCap);
    const errPtr = x.malloc(ERR_CAP);
    try {
      if (!textPtr || !outPtr || !errPtr) throw new Error('the assembler is out of memory');
      new Uint8Array(x.memory.buffer).set(source, textPtr); // a view made after the last malloc
      const status = x.wuica_assemble(textPtr, syntax, outPtr, outCap, errPtr, ERR_CAP);
      // Views after the call: the memory can have grown.
      const message = this.#cstr(errPtr);
      const bytes = status >= 0 ? new Uint8Array(x.memory.buffer).slice(outPtr, outPtr + status) : null;
      return { status, bytes, message };
    } finally {
      if (textPtr) x.free(textPtr);
      if (outPtr) x.free(outPtr);
      if (errPtr) x.free(errPtr);
    }
  }

  // text: assembly source; syntax: 'intel' | 'att'.
  async assemble(text, syntax = 'intel') {
    if (!(syntax in SYNTAX)) throw new TypeError(`unknown syntax: ${syntax}`);
    if (!this.#x) await this.#instantiate();
    // (a byte order mark at the start is not code: LLVM would reject it)
    const plain = prepareSource(text);
    const mode = codeModeError(plain);
    if (mode) return { ok: false, diagnostics: [{ severity: 'error', ...mode }] };
    const source = new TextEncoder().encode(plain + '\0');
    let r;
    try {
      r = this.#run(source, SYNTAX[syntax], OUT_CAP);
      if (r.status === -2) {
        const need = Number(/(\d+) bytes needed/.exec(r.message)?.[1]);
        if (need > MAX_CODE_BYTES) {
          return { ok: false, diagnostics: [{ line: null, column: null, severity: 'error', message: tooMuchCode(need) }] };
        }
        if (need > OUT_CAP) r = this.#run(source, SYNTAX[syntax], need);
      }
    } catch (e) {
      // A trap (LLVM's fatal error handler). The instance is unusable afterwards: drop it, the next call makes a new one.
      let fatal = '';
      try { const p = this.#x.wuica_fatal_message?.(); if (p) fatal = this.#cstr(p); } catch { /* ignore */ }
      this.#x = null;
      const message = fatal || (e instanceof Error ? e.message : String(e));
      return { ok: false, diagnostics: [{ line: null, column: null, severity: 'error', message: `the assembler failed: ${message}` }] };
    }
    const diagnostics = parseDiagnostics(r.message);
    if (r.status >= 0) return { ok: true, bytes: r.bytes, diagnostics };
    semicolonHint(diagnostics, plain);
    if (!diagnostics.some((d) => d.severity === 'error')) {
      diagnostics.push({ line: null, column: null, severity: 'error', message: `the assembler failed (code ${r.status})` });
    }
    return { ok: false, diagnostics };
  }
}
