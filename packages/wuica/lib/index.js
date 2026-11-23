// wuica: x86-64 basic-block throughput prediction (a Rust/WebAssembly port of uiCA) for Node.
//
//   import { createWuica } from 'wuica';
//   const w = await createWuica();
//   const r = await w.analyze('SKL', { source: 'add rax, rbx\nadd rbx, rax' });
//   console.log(r.code, r.tp, r.bottlenecks, r.text);
//
// The request/response shapes follow Compiler Explorer's API style and are the contract for a REST server with the
// same shape (README.md, "API contract"): list = archs(), POST /api/analyze/<arch> = analyze(arch, request), etc.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Analyzer, Assembler, parseDiagnostics, codeModeError } from './wasm.js';
import { archList, DEFAULT_ARCH, ARCH_INFO, ARCH_ORDER } from './archs.js';
import { insights } from './insights.js';
import { instrDetails, detailInsights } from './details.js';
export { detailInsights };
import { readMaybeCompressed } from './files.js';
import { CODES, WARM_HEX, failure, tableFailure, analysisResult, compareFields } from './core.js';
import { ThreadPool, threadLimit, threadOption, threadsFor } from './threads.js';
// the web page's reading of pasted assembly (web/js, copied by build.sh): the loop of a whole function, objdump lines,
// exits as not taken, ';' comments, region markers
import { assembleMarked, commentFixes } from '../dist/web/asm-regions.js';

export { ARCH_INFO, ARCH_ORDER, DEFAULT_ARCH, CODES, WARM_HEX, parseDiagnostics, insights };
export { whatIf, VARIANTS as WHAT_IF_VARIANTS } from './whatif.js';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

export const OPTION_DEFAULTS = Object.freeze({
  alignmentOffset: 0,
  initPolicy: 'diff',
  simpleFrontEnd: false,
  noMicroFusion: false,
  noMacroFusion: false,
  minIterations: 10,
  minCycles: 500,
  includeTrace: false,
  details: false,      // per instruction allowed ports, latencies, front-end facts; port set; issue slots (docs/WASM-API.md)
});

export const ARCH_FIELDS = Object.freeze(['id', 'name', 'year', 'prototype', 'table', 'xedChip']);

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

// llvm-mc's diagnostics as stderr lines; lines with a position carry a tag {line, column, severity, text}.
export function stderrLines(message) {
  const lines = String(message ?? '').replace(/\n+$/, '').split('\n').filter((l) => l !== '');
  return lines.map((text) => {
    const d = parseDiagnostics(text)[0];
    return d && d.line !== null ? { text, tag: { line: d.line, column: d.column, severity: d.severity, text: d.message } } : { text };
  });
}

const REQUEST_KEYS = ['source', 'asm', 'hex', 'syntax', 'loop', 'options'];

// `loop` of a request: what of the source is analyzed (web/js/loop-find.js). null if it is not one of these.
export const LOOP_CHOICES = Object.freeze(['auto', 'whole']);
const loopChoice = (v) => (v === undefined || v === null ? 'auto' : LOOP_CHOICES.includes(v) || (Number.isSafeInteger(v) && v >= 0) ? v : null);

// Diagnostics ({line, column, severity, message}) as stderr lines in llvm-mc's form, with tags.
function diagnosticLines(diagnostics) {
  return diagnostics.map((d) => ({
    text: `<input>:${d.line ?? 0}:${d.column ?? 0}: ${d.severity}: ${d.message}`,
    ...(d.line ? { tag: { line: d.line, column: d.column ?? 0, severity: d.severity, text: d.message } } : {}),
  }));
}

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


// A list of arch names without repeats (the same id, or the same unknown name), in the order of their first appearance.
function uniqueArchs(list, resolve) {
  const seen = new Set();
  return list.filter((a) => {
    const key = resolve(a) ?? `?${String(a).trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
class Wuica {
  #analyzer;
  #configs;
  #archs;
  #dataDir;
  #asmWasm;
  #assembler = null;    // promise of an Assembler
  #loading = new Map(); // table name -> promise
  #wasm;                // bytes of the analyzer module (the threads compile it with a memory limit of their own)
  #uarch;               // bytes of uarch.json
  #threads;             // the most threads compare() uses (1: none)
  #threadsAuto;         // no number given: at most one thread per two microarchitectures (threads.js, threadsFor)
  #pool = null;         // ThreadPool, started by the first compare() that uses threads

  constructor(analyzer, configs, dataDir, asmWasm, { wasm, uarch, threads, threadsAuto }) {
    this.#analyzer = analyzer;
    this.#configs = configs;
    this.#archs = archList(configs);
    this.#dataDir = dataDir;
    this.#asmWasm = asmWasm;
    this.#wasm = wasm;
    this.#uarch = uarch;
    this.#threads = threads;
    this.#threadsAuto = threadsAuto;
  }

  // The microarchitectures in order of release (like CE's /api/compilers); `fields` selects fields (default: all).
  archs(fields) {
    const list = fields === undefined || fields === null || fields === 'all' ? ARCH_FIELDS : (typeof fields === 'string' ? fields.split(',') : fields).map((f) => f.trim());
    return this.#archs.map((a) => Object.fromEntries(list.filter((f) => Object.hasOwn(a, f)).map((f) => [f, a[f]])));
  }

  // Exact id, else case-insensitive and ignoring "-" and surrounding whitespace (adlp -> ADL-P). Empty -> DEFAULT_ARCH;
  // unknown -> null.
  resolveArch(arch) {
    if (arch === undefined || arch === null) return DEFAULT_ARCH;
    const s = String(arch).trim();
    if (s === '') return DEFAULT_ARCH;
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
    const asm = await this.#getAssembler();
    let text = source.replace(/^\uFEFF/, '');
    let r = asm.assemble(text, s);
    // ';' comments: a ';' whose rest the assembler rejects is retried as '#' (web/js/asm-regions.js)
    for (let round = 0; !r.ok && r.status !== 'trap' && round < 4; round++) {
      const fixes = commentFixes(parseDiagnostics(r.message), text);
      if (!fixes.size) break;
      const lines = text.split('\n');
      for (const [l, t] of fixes) lines[l - 1] = t;
      text = lines.join('\n');
      r = asm.assemble(text, s);
    }
    if (!r.ok) {
      if (r.status === 'trap') return failure(CODES.ASSEMBLER, r.message, undefined, { trapped: true });
      const first = parseDiagnostics(r.message).find((d) => d.severity === 'error');
      const error = first ? `assembly failed: ${first.line !== null ? `line ${first.line}: ` : ''}${first.message}` : 'assembly failed';
      return failure(CODES.ASSEMBLER, error, stderrLines(r.message));
    }
    return { code: CODES.OK, hex: Buffer.from(r.bytes).toString('hex'), length: r.bytes.length, bytes: r.bytes, stderr: stderrLines(r.message) };
  }

  // The machine code an analysis of assembly text gets (as the web page reads it): the loop of a whole function, objdump
  // lines, exits as not taken, ';' comments, a marked region (web/js/loop-find.js, asm-regions.js). loop: 'auto',
  // 'whole' or a loop's index. -> {code: 0, hex, bytes, stderr, loop} (loop: what was picked, or null) or a failure.
  async machineCode(source, syntax = 'intel', loop = 'auto') {
    if (typeof source !== 'string') return failure(CODES.REQUEST, '`source` must be a string');
    const s = syntaxCode(syntax);
    if (s < 0) return failure(CODES.REQUEST, `unknown syntax "${syntax}" (use "intel" or "att")`);
    if (loopChoice(loop) === null) return failure(CODES.REQUEST, '`loop` must be "auto", "whole" or the index of a loop (0, 1, ...)');
    const asm = await this.#getAssembler();
    let trap = null;
    const assemble = async (t) => {
      const r = asm.assemble(t, s);
      if (!r.ok && r.status === 'trap') trap = r.message;
      return { ok: r.ok, bytes: r.bytes, diagnostics: parseDiagnostics(r.message) };
    };
    const text = source.replace(/^\uFEFF/, '');
    const r = await assembleMarked(assemble, text, { loop: loopChoice(loop) });
    if (trap) return failure(CODES.ASSEMBLER, trap, undefined, { trapped: true });
    if (!r.ok) {
      const bad = r.diagnostics.find((d) => /^loop: /.test(d.message));
      if (bad) return failure(CODES.REQUEST, bad.message);
      const first = r.diagnostics.find((d) => d.severity === 'error');
      const error = first ? `assembly failed: ${first.line ? `line ${first.line}: ` : ''}${first.message}` : 'assembly failed';
      // llvm-mc's own lines (with the source line and the caret) when the text alone fails on the same line
      const plain = asm.assemble(text, s);
      const same = !plain.ok && first && parseDiagnostics(plain.message).find((d) => d.severity === 'error')?.line === first.line;
      return failure(CODES.ASSEMBLER, error, same ? stderrLines(plain.message) : diagnosticLines(r.diagnostics));
    }
    // what was analyzed, if not the whole text as it is: the loop (or body) picked, or the alignment from addresses
    const picked = r.loop ?? (r.alignment !== null ? { index: null, count: r.loops.length, name: 'whole', line: null, endLine: null, address: null, alignment: r.alignment } : null);
    const loopInfo = picked && { index: picked.index, count: picked.count, name: picked.name, line: picked.line, endLine: picked.endLine,
      ...(picked.address !== null && picked.address !== undefined ? { address: picked.address } : {}), ...(r.alignment !== null ? { alignmentOffset: r.alignment } : {}) };
    return { code: CODES.OK, hex: Buffer.from(r.bytes).toString('hex'), bytes: r.bytes, stderr: diagnosticLines(r.diagnostics), loop: loopInfo };
  }

  // {source | asm | hex, syntax, loop} -> {hex, assembled, stderr, loop} or a failure.
  async #code(req) {
    const source = req.source ?? req.asm;
    const hasSource = source !== undefined && source !== null;
    const hasHex = req.hex !== undefined && req.hex !== null;
    if (hasSource === hasHex) return failure(CODES.REQUEST, 'give exactly one of `source` (assembly text) and `hex` (machine code)');
    if (loopChoice(req.loop) === null) return failure(CODES.REQUEST, '`loop` must be "auto", "whole" or the index of a loop (0, 1, ...)');
    if (hasHex) {
      if (req.syntax !== undefined && syntaxCode(req.syntax) < 0) return failure(CODES.REQUEST, `unknown syntax "${req.syntax}"`);
      const hex = normalizeHex(req.hex);
      if (hex === null && typeof req.hex === 'string' && normalizeHex(req.hex + '00') === '00') return failure(CODES.REQUEST, '`hex` is empty: no machine code');
      if (hex === null) return failure(CODES.REQUEST, '`hex`: expected an even number of hex digits (spaces, commas and 0x prefixes are allowed)');
      return { hex, assembled: false, stderr: [] };
    }
    // 16- or 32-bit code would be analyzed as 64-bit code (the analyzer only models 64-bit mode)
    const mode = typeof source === 'string' ? codeModeError(source) : null;
    if (mode) return failure(CODES.REQUEST, `line ${mode.line}: ${mode.message}`);
    const a = await this.machineCode(source, req.syntax ?? 'intel', loopChoice(req.loop));
    if (a.code !== CODES.OK) return a;
    if (a.bytes.length === 0) return failure(CODES.REQUEST, 'the source contains no instructions');
    return { hex: a.hex, assembled: true, stderr: a.stderr, loop: a.loop };
  }

  // The options of a request with the alignment offset of the code's addresses (objdump input), unless it was given.
  static #withAlignment(req, options, code) {
    const given = req.options?.alignmentOffset !== undefined || req.alignmentOffset !== undefined;
    return !given && code.loop?.alignmentOffset !== undefined ? { ...options, alignmentOffset: code.loop.alignmentOffset } : options;
  }

  async #run(hex, arch, options) {
    const id = this.resolveArch(arch);
    if (!id) return failure(CODES.REQUEST, `unknown microarchitecture: ${arch} (known: ${this.#archs.map((a) => a.id).join(', ')})`);
    try {
      await this.#ensureTable(this.#configs[id].name);
    } catch (e) {
      return tableFailure(id, e);
    }
    return analysisResult(this.#analyzer.analyze({ hex, arch: id, ...options }));
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
    const r = await this.#run(code.hex, arch, Wuica.#withAlignment(req, opts.options, code));
    if (r.code !== undefined) return r;
    const stderr = [...code.stderr];
    if (r.decodeErrors > 0) stderr.push({ text: `Warning: ${r.decodeErrors} position(s) could not be decoded` });
    return { code: CODES.OK, ...r, ...(code.assembled ? { hex: code.hex } : {}), ...(code.loop ? { loop: code.loop } : {}), stderr };
  }

  // POST /api/compare {source | hex, syntax, archs?, options}: one block on several microarchitectures (default: all).
  async compare(request = {}) {
    const opts = pickOptions(request, ['archs']);
    if (opts.error) return failure(CODES.REQUEST, opts.error);
    const code = await this.#code(request);
    if (code.code !== undefined) return code;
    if (request.archs !== undefined && !Array.isArray(request.archs)) return failure(CODES.REQUEST, '`archs` must be an array of ids');
    const ids = request.archs?.length ? uniqueArchs(request.archs, (a) => this.resolveArch(a)) : this.#archs.map((a) => a.id);
    const options = { ...Wuica.#withAlignment(request, opts.options, code), includeTrace: false, details: false };
    const resolved = ids.map((arch) => this.resolveArch(arch));
    // the microarchitectures in threads (if that means at least two threads), each as #run() would on this thread;
    // whatever the threads do not do (unknown ids, a thread that failed) is done here, one after another
    const fields = new Array(ids.length).fill(null);
    const known = resolved.flatMap((id, i) => (id ? [{ i, table: this.#configs[id].name, request: { hex: code.hex, arch: id, ...options } }] : []));
    const threads = threadsFor(new Set(known.map((j) => j.table)).size, this.#threads, this.#threadsAuto);
    if (threads > 1) {
      this.#pool ??= new ThreadPool({ wasm: this.#wasm, uarch: this.#uarch, dataDir: this.#dataDir, limit: this.#threads });
      if (!this.#pool.broken) {
        const done = await this.#pool.run(known, threads);
        known.forEach((j, k) => { fields[j.i] = done[k]; });
      }
    }
    const results = [];
    for (const [i, arch] of ids.entries()) {
      const id = resolved[i];
      const { name, year, prototype } = id ? this.#info(id) : { name: String(arch), year: null, prototype: false };
      const row = { arch: id ?? String(arch), name, year, prototype };
      results.push({ ...row, ...(fields[i] ?? compareFields(await this.#run(code.hex, arch, options))) });
    }
    return { code: CODES.OK, ...(code.assembled ? { hex: code.hex } : {}), ...(code.loop ? { loop: code.loop } : {}), stderr: code.stderr, results };
  }

  // Stops compare()'s threads, if any (they also stop by themselves when idle, and never keep the process alive while
  // idle). The instance stays usable: the next compare() starts them again.
  async close() {
    await this.#pool?.close();
  }

  // The number of threads compare() has running now (0 if none).
  get threads() { return this.#pool?.threads ?? 0; }

  // The compact form of an analyze() response (used by the MCP server): uop table reduced to non-zero values, plus the
  // derived diagnosis of the web page's bound view (insights.js).
  summarize(r) {
    if (r.code !== CODES.OK) return r;
    const { name, year, prototype } = this.#info(r.arch);
    const round = (x) => Math.round(x * 100) / 100;
    const sources = new Set(['MITE', 'MS', 'DSB', 'LSD']);
    const instructions = r.rows.map((row, k) => {
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
      const det = instrDetails(r.details?.rows?.[k]);
      if (det) Object.assign(e, det);
      return e;
    });
    const base = insights(r);
    const ins = base ? { ...base, ...detailInsights(r) } : null;
    return {
      code: r.code, arch: r.arch, name, year, prototype, tp: r.tp, unit: 'cycles per iteration', mode: r.mode,
      bottlenecks: r.bottlenecks, limits: r.limits, decodeErrors: r.decodeErrors, ...(r.hex ? { hex: r.hex } : {}), ...(r.loop ? { loop: r.loop } : {}),
      stderr: r.stderr, instructions, ...(ins ? { insights: ins } : {}),
    };
  }

  get restarts() { return this.#analyzer.restarts; }
}

// options.dataDir: directory with uarch.json and arch/<NAME>.json (plain or .br); default: the package's tables.
// options.analyzerWasm / options.assemblerWasm: paths of the modules (plain or .br).
// options.threads: the most worker threads compare() uses, one per microarchitecture (default: the environment variable
// WUICA_THREADS, else "auto": os.availableParallelism(), and one thread per two microarchitectures; 1 = none, every
// microarchitecture one after another on this thread).
export async function createWuica(options = {}) {
  const threads = threadLimit(options.threads);
  const threadsAuto = threadOption(options.threads) === 'auto';
  const dataDir = options.dataDir ?? path.join(DIST, 'data');
  const analyzerWasm = options.analyzerWasm ?? path.join(DIST, 'wuica_wasm.wasm.br');
  const asmWasm = options.assemblerWasm ?? path.join(DIST, 'wuica_asm.wasm.br');
  const [wasm, uarchBytes] = await Promise.all([readMaybeCompressed(analyzerWasm), readMaybeCompressed(path.join(dataDir, 'uarch.json'))]);
  const analyzer = new Analyzer(await WebAssembly.compile(wasm));
  analyzer.loadUarch(uarchBytes);
  const configs = JSON.parse(new TextDecoder().decode(uarchBytes)).configs;
  return new Wuica(analyzer, configs, dataDir, asmWasm, { wasm, uarch: uarchBytes, threads, threadsAuto });
}
