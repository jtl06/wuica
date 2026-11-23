// wuica: x86-64 basic-block throughput prediction (a Rust/WebAssembly port of uiCA) for Node.
//
//   import { createWuica } from 'wuica';
//   const w = await createWuica();
//   const r = await w.analyze('SKL', { source: 'add rax, rbx\nadd rbx, rax' });
//   console.log(r.code, r.tp, r.bottlenecks, r.text);
//
// The request/response shapes follow Compiler Explorer's API style and are the contract for a REST server with the
// same shape (README.md, "API contract"): list = archs(), POST /api/analyze/<arch> = analyze(arch, request), etc.

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Analyzer, Assembler, parseDiagnostics } from './wasm.js';
import { archList, DEFAULT_ARCH, ARCH_INFO, ARCH_ORDER } from './archs.js';
import { insights } from './insights.js';

export { ARCH_INFO, ARCH_ORDER, DEFAULT_ARCH, parseDiagnostics };

const brotli = promisify(zlib.brotliDecompress);
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** Result codes (`code`), like an exit status: 0 = success. */
export const CODES = Object.freeze({ OK: 0, REQUEST: 1, ASSEMBLER: 2, ANALYSIS: 3 });

export const OPTION_DEFAULTS = Object.freeze({
  alignmentOffset: 0,
  initPolicy: 'diff',
  simpleFrontEnd: false,
  noMicroFusion: false,
  noMacroFusion: false,
  minIterations: 10,
  minCycles: 500,
  includeTrace: false,
});

export const ARCH_FIELDS = Object.freeze(['id', 'name', 'year', 'prototype', 'table', 'xedChip']);

// Reads a file; `.br` files are decompressed. For a path without `.br`, `<path>.br` is tried first.
async function readMaybeCompressed(file) {
  if (file.endsWith('.br')) return new Uint8Array(await brotli(await fs.readFile(file)));
  try {
    return new Uint8Array(await brotli(await fs.readFile(file + '.br')));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return new Uint8Array(await fs.readFile(file));
}

// Accepts "4801d8", "48 01 d8", "0x48, 0x01, 0xd8", "\x48\x01\xd8". Returns lower-case hex or null.
export function normalizeHex(input) {
  if (input instanceof Uint8Array) return Buffer.from(input).toString('hex');
  const s = String(input).replace(/0x|\\x/gi, '').replace(/[\s,;]+/g, '').toLowerCase();
  return /^(?:[0-9a-f]{2})+$/.test(s) ? s : null;
}

function syntaxCode(syntax) {
  if (syntax === undefined || syntax === null || syntax === 'intel' || syntax === 0) return 0;
  if (syntax === 'att' || syntax === 1) return 1;
  return -1;
}

// A failed call: {code, error, stderr}, stderr as in Compiler Explorer (one entry per line, `tag` on positioned ones).
function failure(code, error, stderr = [{ text: error }], extra = {}) {
  return { code, error, stderr, ...extra };
}

// llvm-mc's diagnostics as stderr lines; lines with a position carry a tag {line, column, severity, text}.
export function stderrLines(message) {
  const lines = String(message ?? '').replace(/\n+$/, '').split('\n').filter((l) => l !== '');
  return lines.map((text) => {
    const d = parseDiagnostics(text)[0];
    return d && d.line !== null ? { text, tag: { line: d.line, column: d.column, severity: d.severity, text: d.message } } : { text };
  });
}

const REQUEST_KEYS = ['source', 'asm', 'hex', 'syntax', 'options'];

// The simulation options of a request: `options`, and (as a convenience) option keys at the top level of the request;
// `options` wins. Unknown keys, at the top level or in `options`, are an error rather than being ignored.
function pickOptions(req, extraKeys) {
  const options = req.options;
  if (options !== undefined && options !== null && (typeof options !== 'object' || Array.isArray(options))) return { error: '`options` must be an object' };
  const allowed = new Set([...REQUEST_KEYS, ...extraKeys, ...Object.keys(OPTION_DEFAULTS)]);
  const unknownTop = Object.keys(req).filter((k) => !allowed.has(k));
  if (unknownTop.length) return { error: `unknown request field(s): ${unknownTop.join(', ')} (known: ${[...REQUEST_KEYS, ...extraKeys].join(', ')}; simulation options go in \`options\`)` };
  const unknown = Object.keys(options ?? {}).filter((k) => !Object.hasOwn(OPTION_DEFAULTS, k));
  if (unknown.length) return { error: `unknown option(s): ${unknown.join(', ')} (known: ${Object.keys(OPTION_DEFAULTS).join(', ')})` };
  const out = {};
  for (const [k, d] of Object.entries(OPTION_DEFAULTS)) {
    const v = options?.[k] ?? req[k] ?? d;
    // a value of the wrong kind is a bad request (code 1), like an unknown option, not a failed analysis
    const bad = typeof d === 'number' ? !Number.isSafeInteger(v) : typeof d === 'boolean' ? typeof v !== 'boolean'
      : k === 'initPolicy' && !['diff', 'same', 'stack'].includes(v);
    if (bad) return { error: `option ${k}: ${JSON.stringify(v)} is not ${typeof d === 'number' ? 'an integer' : typeof d === 'boolean' ? 'true or false' : 'one of "diff", "same", "stack"'}` };
    out[k] = v;
  }
  return { options: out };
}

class Wuica {
  #analyzer;
  #configs;
  #archs;
  #dataDir;
  #asmWasm;
  #assembler = null;    // promise of an Assembler
  #loading = new Map(); // table name -> promise

  constructor(analyzer, configs, dataDir, asmWasm) {
    this.#analyzer = analyzer;
    this.#configs = configs;
    this.#archs = archList(configs);
    this.#dataDir = dataDir;
    this.#asmWasm = asmWasm;
  }

  // The microarchitectures in order of release (like CE's /api/compilers); `fields` selects fields (default: all).
  archs(fields) {
    const list = fields === undefined || fields === null || fields === 'all' ? ARCH_FIELDS : (typeof fields === 'string' ? fields.split(',') : fields).map((f) => f.trim());
    return this.#archs.map((a) => Object.fromEntries(list.filter((f) => Object.hasOwn(a, f)).map((f) => [f, a[f]])));
  }

  // Exact id, else case-insensitive and ignoring "-" (adlp -> ADL-P). Empty -> DEFAULT_ARCH; unknown -> null.
  resolveArch(arch) {
    if (arch === undefined || arch === null || arch === '') return DEFAULT_ARCH;
    const s = String(arch);
    if (Object.hasOwn(this.#configs, s)) return s;
    const norm = (k) => k.toUpperCase().replace(/-/g, '');
    return Object.keys(this.#configs).find((k) => norm(k) === norm(s)) ?? null;
  }

  #info(id) {
    return this.#archs.find((a) => a.id === id) ?? { id, name: id, year: null, prototype: !!this.#configs[id]?.experimental };
  }

  async #ensureTable(name) {
    if (this.#analyzer.hasArch(name)) return;
    let p = this.#loading.get(name);
    if (!p) {
      p = (async () => {
        const bytes = await readMaybeCompressed(path.join(this.#dataDir, 'arch', `${name}.json`));
        if (!this.#analyzer.hasArch(name)) this.#analyzer.loadArch(name, bytes);
      })();
      this.#loading.set(name, p);
      p.finally(() => this.#loading.delete(name)).catch(() => {});
    }
    await p;
  }

  async #getAssembler() {
    if (!this.#assembler) {
      this.#assembler = readMaybeCompressed(this.#asmWasm)
        .then((bytes) => WebAssembly.compile(bytes))
        .then((m) => new Assembler(m));
      this.#assembler.catch(() => { this.#assembler = null; });
    }
    return this.#assembler;
  }

  // POST /api/assemble {source, syntax}
  async assemble(source, syntax = 'intel') {
    if (typeof source !== 'string') return failure(CODES.REQUEST, '`source` must be a string');
    const s = syntaxCode(syntax);
    if (s < 0) return failure(CODES.REQUEST, `unknown syntax "${syntax}" (use "intel" or "att")`);
    // a byte order mark (a file saved by some Windows editors) is not part of the code: LLVM would reject it
    const r = (await this.#getAssembler()).assemble(source.replace(/^\uFEFF/, ''), s);
    if (!r.ok) {
      if (r.status === 'trap') return failure(CODES.ASSEMBLER, r.message, undefined, { trapped: true });
      const first = parseDiagnostics(r.message).find((d) => d.severity === 'error');
      const error = first ? `assembly failed: ${first.line !== null ? `line ${first.line}: ` : ''}${first.message}` : 'assembly failed';
      return failure(CODES.ASSEMBLER, error, stderrLines(r.message));
    }
    return { code: CODES.OK, hex: Buffer.from(r.bytes).toString('hex'), length: r.bytes.length, bytes: r.bytes, stderr: stderrLines(r.message) };
  }

  // {source | asm | hex, syntax} -> {hex, assembled, stderr} or a failure.
  async #code(req) {
    const source = req.source ?? req.asm;
    const hasSource = source !== undefined && source !== null;
    const hasHex = req.hex !== undefined && req.hex !== null;
    if (hasSource === hasHex) return failure(CODES.REQUEST, 'give exactly one of `source` (assembly text) and `hex` (machine code)');
    if (hasHex) {
      if (req.syntax !== undefined && syntaxCode(req.syntax) < 0) return failure(CODES.REQUEST, `unknown syntax "${req.syntax}"`);
      const hex = normalizeHex(req.hex);
      if (hex === null && typeof req.hex === 'string' && normalizeHex(req.hex + '00') === '00') return failure(CODES.REQUEST, '`hex` is empty: no machine code');
      if (hex === null) return failure(CODES.REQUEST, '`hex`: expected an even number of hex digits (spaces, commas and 0x prefixes are allowed)');
      return { hex, assembled: false, stderr: [] };
    }
    const a = await this.assemble(source, req.syntax);
    if (a.code !== CODES.OK) return a;
    if (a.length === 0) return failure(CODES.REQUEST, 'the source contains no instructions');
    return { hex: a.hex, assembled: true, stderr: a.stderr };
  }

  async #run(hex, arch, options) {
    const id = this.resolveArch(arch);
    if (!id) return failure(CODES.REQUEST, `unknown microarchitecture: ${arch} (known: ${this.#archs.map((a) => a.id).join(', ')})`);
    try {
      await this.#ensureTable(this.#configs[id].name);
    } catch (e) {
      return failure(CODES.ANALYSIS, `could not load the instruction table for ${id}: ${e.message}`);
    }
    const r = this.#analyzer.analyze({ hex, arch: id, ...options });
    if (r.error) return failure(CODES.ANALYSIS, r.error, undefined, r.trapped ? { trapped: true } : {});
    return r;
  }

  // POST /api/analyze/<arch> {source | hex, syntax, options}. Also analyze({arch, source | hex, ...}).
  async analyze(arch, request) {
    let req = request;
    if (typeof arch === 'object' && arch !== null && request === undefined) { req = arch; arch = req.arch; }
    req ??= {};
    if (typeof req !== 'object') return failure(CODES.REQUEST, 'the request must be an object');
    const opts = pickOptions(req, ['arch']);
    if (opts.error) return failure(CODES.REQUEST, opts.error);
    const code = await this.#code(req);
    if (code.code !== undefined) return code;
    const r = await this.#run(code.hex, arch, opts.options);
    if (r.code !== undefined) return r;
    const stderr = [...code.stderr];
    if (r.decodeErrors > 0) stderr.push({ text: `Warning: ${r.decodeErrors} position(s) could not be decoded` });
    return { code: CODES.OK, ...r, ...(code.assembled ? { hex: code.hex } : {}), stderr };
  }

  // POST /api/compare {source | hex, syntax, archs?, options}: one block on several microarchitectures (default: all).
  async compare(request = {}) {
    const opts = pickOptions(request, ['archs']);
    if (opts.error) return failure(CODES.REQUEST, opts.error);
    const code = await this.#code(request);
    if (code.code !== undefined) return code;
    if (request.archs !== undefined && !Array.isArray(request.archs)) return failure(CODES.REQUEST, '`archs` must be an array of ids');
    const ids = request.archs?.length ? request.archs : this.#archs.map((a) => a.id);
    const options = { ...opts.options, includeTrace: false };
    const results = [];
    for (const arch of ids) {
      const id = this.resolveArch(arch);
      const { name, year, prototype } = id ? this.#info(id) : { name: String(arch), year: null, prototype: false };
      const row = { arch: id ?? String(arch), name, year, prototype };
      const r = await this.#run(code.hex, arch, options);
      if (r.code !== undefined) results.push({ ...row, code: r.code, error: r.error });
      else results.push({ ...row, code: CODES.OK, tp: r.tp, mode: r.mode, bottlenecks: r.bottlenecks, decodeErrors: r.decodeErrors });
    }
    return { code: CODES.OK, ...(code.assembled ? { hex: code.hex } : {}), stderr: code.stderr, results };
  }

  // The compact form of an analyze() response (used by the MCP server): uop table reduced to non-zero values, plus the
  // derived diagnosis of the web page's bound view (insights.js).
  summarize(r) {
    if (r.code !== CODES.OK) return r;
    const { name, year, prototype } = this.#info(r.arch);
    const round = (x) => Math.round(x * 100) / 100;
    const sources = new Set(['MITE', 'MS', 'DSB', 'LSD']);
    const instructions = r.rows.map((row) => {
      const e = { instr: row.label };
      if (row.opcode) e.bytes = row.opcode.toLowerCase();
      if (row.kind !== 'instr') e.kind = row.kind;
      const uopSource = {}, ports = {};
      r.columns.forEach((c, i) => {
        const v = row.values[i];
        if (!v) return;
        if (sources.has(c)) uopSource[c] = round(v);
        else if (c === 'Issued') e.issued = round(v);
        else if (c === 'Exec.') e.executed = round(v);
        else ports[c] = round(v);
      });
      if (Object.keys(uopSource).length) e.uopSource = uopSource;
      if (Object.keys(ports).length) e.ports = ports;
      if (row.notes) e.notes = row.notes;
      if (row.instrStr) e.uopsInfo = row.instrStr;
      return e;
    });
    const ins = insights(r);
    return {
      code: r.code, arch: r.arch, name, year, prototype, tp: r.tp, unit: 'cycles per iteration', mode: r.mode,
      bottlenecks: r.bottlenecks, limits: r.limits, decodeErrors: r.decodeErrors, ...(r.hex ? { hex: r.hex } : {}),
      stderr: r.stderr, instructions, ...(ins ? { insights: ins } : {}),
    };
  }

  get restarts() { return this.#analyzer.restarts; }
}

// options.dataDir: directory with uarch.json and arch/<NAME>.json (plain or .br); default: the package's tables.
// options.analyzerWasm / options.assemblerWasm: paths of the modules (plain or .br).
export async function createWuica(options = {}) {
  const dataDir = options.dataDir ?? path.join(DIST, 'data');
  const analyzerWasm = options.analyzerWasm ?? path.join(DIST, 'wuica_wasm.wasm.br');
  const asmWasm = options.assemblerWasm ?? path.join(DIST, 'wuica_asm.wasm.br');
  const [wasm, uarchBytes] = await Promise.all([readMaybeCompressed(analyzerWasm), readMaybeCompressed(path.join(dataDir, 'uarch.json'))]);
  const analyzer = new Analyzer(await WebAssembly.compile(wasm));
  analyzer.loadUarch(uarchBytes);
  const configs = JSON.parse(new TextDecoder().decode(uarchBytes)).configs;
  return new Wuica(analyzer, configs, dataDir, asmWasm);
}
