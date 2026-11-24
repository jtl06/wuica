// wuica: x86-64 basic-block throughput prediction (a Rust/WebAssembly port of uiCA) for Node.
//
//   import { createWuica } from 'wuica-cli';
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
import { insights } from './web/bound-core.js';
import { cannotRun, noData } from './web/caveats.js';
import { analyzedLines, analyzedText } from './web/branch-label.js';
import { instrDetails, detailInsights } from './details.js';
export { detailInsights };
import { readMaybeCompressed, readMaybeCompressedSync, tableFile } from './files.js';
import { readObject, objdumpText, resolveFunction, objectKind } from './objfile.js';
import { CODES, WARM_HEX, failure, tableFailure, analysisResult, compareFields } from './core.js';
import { ThreadPool, threadLimit, threadOption, threadsForWork } from './threads.js';
// the web page's reading of pasted assembly (copies of web/js in lib/web: tests-js/web_pkg_copies.mjs): the loop of a whole function, objdump lines,
// exits as not taken, ';' comments, region markers
import { assembleMarked, commentFixes, separatorNotes, spanLines } from './web/asm-regions.js';
import { normalizeText, detectSyntax, preparePaste, syntaxSigns } from './web/loop-find.js';
export { detectSyntax };

// The loops of assembly text, as `loop` and `func` choose among them: [{index, label, function, line, endLine,
// instructions, depth, auto}] (auto: the one "auto" analyzes) or {error}. No assembling.
/** @param {string} source @param {{func?: string | null}} [opts] @returns {any} (index.d.ts: LoopListing[] | {error}) */
export function listLoops(source, { func = null } = {}) {
  if (typeof source !== 'string') return { error: '`source` must be assembly text' };
  const p = preparePaste(normalizeText(source), { loop: 'auto', func });
  if (p.error) return { error: p.error };
  return loopListing(p.loops, p.choice);
}

// The loops of a text (loop-find.js preparePaste's, or what an assembly of it found) as listLoops gives them; the one
// implementation behind -loops, the MCP tool list_loops and the analyze response's otherLoops.
function loopListing(loops, choice) {
  return loops.map((l, index) => ({ index, label: l.label, function: l.function, line: l.begin, endLine: l.end, instructions: l.instructions, depth: l.depth, auto: choice === index }));
}

export { ARCH_INFO, ARCH_ORDER, DEFAULT_ARCH, CODES, WARM_HEX, parseDiagnostics, insights };
export { whatIf, VARIANTS as WHAT_IF_VARIANTS, OPT_IN_VARIANTS as WHAT_IF_OPT_IN_VARIANTS, whatIfPerElement, whatIfText, whatIfRequest } from './web/whatif-core.js';
export { diffResult, diffAnalyses, diffRequest, diffMarkdown, diffText } from './web/block-diff.js';
import { diffRequest } from './web/block-diff.js';
import { whatIfRequest } from './web/whatif-core.js';
export { examples, findExample } from './examples.js';
export * as markdown from './web/markdown.js';
export { objectKind } from './objfile.js';

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

// 0 Intel, 1 AT&T, 2 auto (detected from the text: loop-find.js, detectSyntax); -1 unknown. Missing: auto.
function syntaxCode(syntax) {
  if (syntax === undefined || syntax === null || syntax === 'auto') return 2;
  if (syntax === 'intel' || syntax === 0) return 0;
  if (syntax === 'att' || syntax === 1) return 1;
  return -1;
}
// {code: 0 | 1, name: 'intel' | 'att', detected: true if it was auto}
function syntaxOf(syntax, text) {
  const c = syntaxCode(syntax);
  if (c !== 2) return { code: c, name: c === 1 ? 'att' : 'intel', detected: false };
  const d = detectSyntax(text) ?? 'intel';
  return { code: d === 'att' ? 1 : 0, name: d, detected: true };
}
const SYNTAX_ERROR = (syntax) => `unknown syntax "${syntax}" (use "auto", "intel" or "att")`;

// After an assembler error: a line with the other syntax's operands (AT&T's %registers or $immediates in text read as
// Intel, Intel's [registers] or "ptr [" in text read as AT&T: mixed lines, a directive that does not match the code,
// "mov rdx, $8"), as a one-line hint, or null. name: the syntax the text was read as.
export function syntaxHint(text, name) {
  const lines = String(text).split('\n');
  let att = 0, intel = 0, dollar = 0;
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/(?:#|\/\/|;).*$/, '');
    if (/^\s*\./.test(code)) continue;
    const n = syntaxSigns(code);
    // "mov rdx, $8": an Intel line with an AT&T immediate
    if (n.att && n.intel && !/%/.test(code)) { dollar ||= i + 1; continue; }
    if (n.att && !att) att = i + 1;
    else if (n.intel && !n.att && !intel) intel = i + 1;
  }
  if (dollar && name === 'intel' && !att) return `hint: line ${dollar} has an AT&T immediate ($) in Intel code: in Intel syntax an immediate has no $ (if the text is AT&T, -att, syntax "att", reads it so)`;
  if (att && intel) return `hint: the text mixes AT&T (line ${att}) and Intel (line ${intel}) operands; the assembler reads one syntax per text: -att or -intel (syntax "att" or "intel")`;
  if (name === 'intel' && att) return `hint: line ${att} has AT&T operands (%register or $immediate) but the text is read as Intel; if it is AT&T, -att (syntax "att") reads it so`;
  if (name === 'att' && intel) return `hint: line ${intel} has Intel operands but the text is read as AT&T; if it is Intel, -intel (syntax "intel") reads it so`;
  return null;
}

// AArch64 assembly (a common mistake on an Arm Mac): its registers and mnemonics on several lines
export function looksAArch64(text) {
  let n = 0;
  for (const l of String(text).split('\n')) {
    const code = l.replace(/(?:\/\/|;|@).*$/, '').trim();
    if (/^(?:ldr|str|ldp|stp|adrp|cbz|cbnz|b\.\w+|fmadd|fmla|ld1|st1|csel|madd|msub|subs|adds|ldur|stur|fmov|movk)\b/i.test(code) || /(?:^|[\s,\[])[xw](?:[12]?\d|30)\b/.test(code)) n++;
  }
  return n >= 3;
}

// llvm-mc's diagnostics as stderr lines; lines with a position carry a tag {line, column, severity, text}.
export function stderrLines(message) {
  const lines = String(message ?? '').replace(/\n+$/, '').split('\n').filter((l) => l !== '');
  return lines.map((text) => {
    const d = parseDiagnostics(text)[0];
    return d && d.line !== null ? { text, tag: { line: d.line, column: d.column, severity: d.severity, text: d.message } } : { text };
  });
}

const REQUEST_KEYS = ['source', 'asm', 'hex', 'syntax', 'loop', 'func', 'options'];

// `loop` of a request: what of the source is analyzed (web/js/loop-find.js). null if it is not one of these.
export const LOOP_CHOICES = /** @type {readonly ['auto', 'whole']} */ (Object.freeze(['auto', 'whole']));
// (a string other than these is a loop's label: ".LBB0_12", "0x10")
const loopChoice = (v) => (v === undefined || v === null ? 'auto' : LOOP_CHOICES.includes(v) || (Number.isSafeInteger(v) && v >= 0) || (typeof v === 'string' && v.trim() !== '') ? v : null);
const LOOP_ERROR = '`loop` must be "auto", "whole", the index of a loop (0-based) or its label';

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
    if (bad && typeof d === 'number' && Number.isInteger(v)) return { error: `option ${k}: ${v} is out of range (at most 2^53 - 1 in magnitude)` };
    if (bad) return { error: `option ${k}: ${JSON.stringify(v)} is not ${typeof d === 'number' ? 'an integer' : typeof d === 'boolean' ? 'true or false' : 'one of "diff", "same", "stack"'}` };
    out[k] = v;
  }
  return { options: out };
}


// A compare() result with cycles per element (`per` elements per iteration, as the CLI's -arch with -per):
// elementsPerIteration on it and perElement (tp / per) on each row that has a tp. Unchanged without `per`.
export function comparePerElement(c, per) {
  if (!per || c.code) return c;
  return { ...c, elementsPerIteration: per, results: c.results.map((r) => (r.code === CODES.OK ? { ...r, perElement: r.tp / per } : r)) };
}

// The rows of an analysis with where each instruction came from (assembly input): `line` (1-based, of the text as given)
// and `loc` ("file.c:12", from .loc/.file directives). Only when the counts fit the instruction rows exactly (from the
// loop finder and the assembler, never by matching text); unchanged otherwise.
function withSourceLines(r, src) {
  if (!src || !Array.isArray(r.rows)) return r;
  const instr = r.rows.filter((x) => x.kind === 'instr');
  const lines = Array.isArray(src.lines) && src.lines.length === instr.length ? src.lines : null;
  const locs = src.loc?.spans?.length ? spanLines(r.rows, src.loc.spans) : null;
  const file = src.loc?.file ?? null;
  if (!lines && !(locs && file)) return r;
  let k = 0;
  const rows = r.rows.map((x) => {
    if (x.kind !== 'instr') return x;
    const i = k++;
    const info = lines && src.info ? src.info.get(lines[i]) : undefined; // objdump -S, perf annotate: source, samples
    return { ...x, ...(lines ? { line: lines[i] } : {}), ...(locs && file && locs[i] ? { loc: `${file}:${locs[i]}` } : {}), ...(info ?? {}) };
  });
  return { ...r, rows };
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
  /** @type {Promise<any> | null} */
  #assembler = null;    // promise of an Assembler
  #loading = new Map(); // table name -> promise
  #wasm;                // bytes of the analyzer module (the threads compile it with a memory limit of their own)
  #uarch;               // bytes of uarch.json
  #threads;             // the most threads compare() uses (1: none)
  #threadsAuto;         // no number given: at most one thread per two microarchitectures (threads.js, threadsFor)
  /** @type {import('./threads.js').ThreadPool | null} */
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
        const file = tableFile(this.#dataDir, name);
        const bytes = await readMaybeCompressed(file);
        if (!this.#analyzer.hasArch(name)) this.#analyzer.loadArch(name, bytes, () => readMaybeCompressedSync(file));
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
  /** @param {string} source @param {string} [syntax] @returns {Promise<any>} */
  async assemble(source, syntax = 'auto') {
    if (typeof source !== 'string') return failure(CODES.REQUEST, '`source` must be a string');
    if (syntaxCode(syntax) < 0) return failure(CODES.REQUEST, SYNTAX_ERROR(syntax));
    // a byte order mark (a file saved by some Windows editors) is not part of the code: LLVM would reject it
    const asm = await this.#getAssembler();
    // (CRLF and a lone CR are line feeds)
    let text = normalizeText(source).replace(/^\uFEFF/, '');
    const s = syntaxOf(syntax, text).code;
    let r = asm.assemble(text, s);
    // ';' comments: a ';' whose rest the assembler rejects is retried as '#' (web/js/asm-regions.js)
    const notes = [];
    for (let round = 0; !r.ok && r.status !== 'trap' && round < 8; round++) {
      const { fixes, notes: n } = commentFixes(parseDiagnostics(r.message), text);
      notes.push(...n);
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
    return { code: CODES.OK, hex: Buffer.from(r.bytes).toString('hex'), length: r.bytes.length, bytes: r.bytes,
      stderr: [...stderrLines(r.message), ...diagnosticLines([...notes, ...separatorNotes(text)])] };
  }

  // The machine code an analysis of assembly text gets (as the web page reads it): the loop of a whole function, objdump
  // lines, exits as not taken, ';' comments, a marked region (web/js/loop-find.js, asm-regions.js). loop: 'auto',
  // 'whole', a loop's index or its label; func: the function whose loops count (or null).
  // -> {code: 0, hex, bytes, stderr, loop, syntax} (loop: what was picked, or null; syntax: {name, detected}) or a failure.
  /** @param {string} source @param {string} [syntax] @param {string | number} [loop] @param {string | null} [func] @returns {Promise<any>} */
  async machineCode(source, syntax = 'auto', loop = 'auto', func = null) {
    if (typeof source !== 'string') return failure(CODES.REQUEST, '`source` must be a string');
    if (syntaxCode(syntax) < 0) return failure(CODES.REQUEST, SYNTAX_ERROR(syntax));
    if (loopChoice(loop) === null) return failure(CODES.REQUEST, LOOP_ERROR);
    if (func !== null && func !== undefined && typeof func !== 'string') return failure(CODES.REQUEST, '`func` must be the name of a function');
    const syn = syntaxOf(syntax, normalizeText(source));
    const s = syn.code;
    const asm = await this.#getAssembler();
    let trap = null;
    const assemble = async (t) => {
      const r = asm.assemble(t, s);
      if (!r.ok && r.status === 'trap') trap = r.message;
      return { ok: r.ok, bytes: r.bytes, diagnostics: parseDiagnostics(r.message) };
    };
    const text = normalizeText(source).replace(/^\uFEFF/, '');
    const r = await assembleMarked(assemble, text, { loop: loopChoice(loop), func });
    if (trap) return failure(CODES.ASSEMBLER, trap, undefined, { trapped: true });
    if (!r.ok) {
      const bad = r.diagnostics.find((d) => /^(?:loop|func|input): /.test(d.message));
      if (bad) return failure(CODES.REQUEST, bad.message);
      if (looksAArch64(text)) return failure(CODES.ASSEMBLER, 'this looks like AArch64 assembly; wuica analyzes x86-64 (compile with --target=x86_64-linux-gnu)');
      const first = r.diagnostics.find((d) => d.severity === 'error');
      const error = first ? `assembly failed: ${first.line ? `line ${first.line}: ` : ''}${first.message}` : 'assembly failed';
      // llvm-mc's own lines (with the source line and the caret) when the text alone fails on the same line
      const plain = asm.assemble(text, s);
      const same = !plain.ok && first && parseDiagnostics(plain.message).find((d) => d.severity === 'error')?.line === first.line;
      const hint = syntaxHint(text, syn.name);
      return failure(CODES.ASSEMBLER, error, [...(same ? stderrLines(plain.message) : diagnosticLines(r.diagnostics)), ...(hint ? [{ text: hint }] : [])]);
    }
    // what was analyzed, if not the whole text as it is: the loop (or body) picked, or the alignment from addresses
    const picked = r.loop ?? (r.alignment !== null ? { index: null, count: r.loops.length, name: 'whole', line: null, endLine: null, address: null, alignment: r.alignment } : null);
    const info = picked && Number.isInteger(picked.index) ? r.loops[picked.index] : null;
    const loopInfo = picked && { index: picked.index, count: picked.count, name: picked.name, line: picked.line, endLine: picked.endLine, ...(picked.lines ? { lines: picked.lines } : {}),
      ...(info ? { function: info.function, depth: info.depth, instructions: info.instructions } : {}),
      ...(picked.address !== null && picked.address !== undefined ? { address: picked.address } : {}), ...(r.alignment !== null ? { alignmentOffset: r.alignment } : {}) };
    // the other loops of the text, when it has more than one and one of them was analyzed (with -loop whole every loop
    // is in the analyzed code; a marked region has none)
    const otherLoops = r.loops.length > 1 && Number.isInteger(picked?.index) ? loopListing(r.loops, null).filter((l) => l.index !== picked?.index).map(({ auto, ...l }) => l) : null;
    // where each instruction came from: its line of the text (the loop finder's), and its .loc line (the assembler's)
    const sourceLines = { lines: r.lines ?? null, loc: r.source ?? null, info: r.lineInfo ?? null };
    return { code: CODES.OK, hex: Buffer.from(r.bytes).toString('hex'), bytes: r.bytes, stderr: diagnosticLines(r.diagnostics), loop: loopInfo, syntax: { name: syn.name, detected: syn.detected }, ...(otherLoops ? { otherLoops } : {}), sourceLines };
  }

  // {source | asm | hex, syntax, loop} -> {hex, assembled, stderr, loop} or a failure.
  async #code(req) {
    const source = req.source ?? req.asm;
    const hasSource = source !== undefined && source !== null;
    const hasHex = req.hex !== undefined && req.hex !== null;
    if (hasSource === hasHex) return failure(CODES.REQUEST, 'give exactly one of `source` (assembly text) and `hex` (machine code)');
    if (loopChoice(req.loop) === null) return failure(CODES.REQUEST, LOOP_ERROR);
    if (hasHex) {
      if (req.syntax !== undefined && syntaxCode(req.syntax) < 0) return failure(CODES.REQUEST, SYNTAX_ERROR(req.syntax));
      const hex = normalizeHex(req.hex);
      if (hex === null && typeof req.hex === 'string' && normalizeHex(req.hex + '00') === '00') return failure(CODES.REQUEST, '`hex` is empty: no machine code');
      if (hex === null) return failure(CODES.REQUEST, '`hex`: expected an even number of hex digits (spaces, commas and 0x prefixes are allowed)');
      return { hex, assembled: false, stderr: [] };
    }
    // 16- or 32-bit code would be analyzed as 64-bit code (the analyzer only models 64-bit mode)
    const mode = typeof source === 'string' ? codeModeError(source) : null;
    if (mode) return failure(CODES.REQUEST, `line ${mode.line}: ${mode.message}`);
    const a = await this.machineCode(source, req.syntax ?? 'auto', loopChoice(req.loop), req.func ?? null);
    if (a.code !== CODES.OK) return a;
    if (a.bytes.length === 0) return failure(CODES.REQUEST, 'the source contains no instructions');
    // (analyzed: the text of what was analyzed, which names an extension a CPU lacks: web/caveats.js cannotRun)
    const analyzed = typeof source === 'string' ? analyzedText(analyzedLines(normalizeText(source).replace(/^\uFEFF/, ''), { loop: a.loop })) : null;
    return { hex: a.hex, assembled: true, stderr: a.stderr, loop: a.loop, syntax: a.syntax.name, ...(a.otherLoops ? { otherLoops: a.otherLoops } : {}), sourceLines: a.sourceLines, analyzed };
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
    return Wuica.#analyzeResult(code, await this.#run(code.hex, arch, Wuica.#withAlignment(req, opts.options, code)));
  }

  // analyze()'s result from the code (#code) and the analysis (#run)
  static #analyzeResult(code, r) {
    if (r.code !== undefined) return r;
    r = withSourceLines(r, code.sourceLines);
    const stderr = [...code.stderr];
    if (r.decodeErrors > 0) stderr.push({ text: `Warning: ${r.decodeErrors} position(s) could not be decoded` });
    // code this CPU cannot run (web/caveats.js cannotRun): the number is the reference's, but not a result for it
    const bad = cannotRun(r, { arch: r.arch, code: code.analyzed ?? null }), gaps = noData(r, { arch: r.arch });
    return { code: CODES.OK, ...r, ...(bad ? { unsupported: bad.reason } : {}), ...(gaps ? { noData: gaps } : {}), ...(code.assembled ? { hex: code.hex, syntax: code.syntax } : {}), ...(code.loop ? { loop: code.loop } : {}), ...(code.otherLoops ? { otherLoops: code.otherLoops } : {}), stderr };
  }

  // Several blocks on one microarchitecture: [request] -> [analyze() result] in the same order (each exactly what
  // analyze(arch, request) returns). The code is assembled here; the analyses run on the threads when the work is worth
  // it (threads.js, threadsForWork).
  async analyzeMany(arch, requests) {
    if (!Array.isArray(requests)) return failure(CODES.REQUEST, '`requests` must be an array');
    const prepared = await this.#prepare(requests, ['arch']);
    const jobs = prepared.flatMap((p, i) => (p.failure ? [] : [{ i, hex: p.code.hex, arch, options: Wuica.#withAlignment(p.request, p.options, p.code), full: true }]));
    const done = await this.#runJobs(jobs);
    const out = prepared.map((p) => p.failure);
    jobs.forEach((j, k) => { out[j.i] = Wuica.#analyzeResult(prepared[j.i].code, done[k]); });
    return out;
  }

  // Several blocks on several microarchitectures: [request] -> [compare() result] in the same order (each exactly what
  // compare(request) returns; `archs` is that of each request, else of the call, else all). Every block x CPU is one
  // job for the threads.
  /** @param {any[]} requests @param {{archs?: string[]}} [opts] */
  async compareMany(requests, { archs } = {}) {
    if (!Array.isArray(requests)) return failure(CODES.REQUEST, '`requests` must be an array');
    const prepared = await this.#prepare(requests, ['archs']);
    const jobs = [], rows = [];
    prepared.forEach((p, i) => {
      if (p.failure) return;
      const list = p.request.archs ?? archs;
      if (list !== undefined && !Array.isArray(list)) { p.failure = failure(CODES.REQUEST, '`archs` must be an array of ids'); return; }
      const ids = list?.length ? uniqueArchs(list, (a) => this.resolveArch(a)) : this.#archs.map((a) => a.id);
      const options = { ...Wuica.#withAlignment(p.request, p.options, p.code), includeTrace: false, details: false };
      rows[i] = ids.map((a) => { jobs.push({ i, hex: p.code.hex, arch: a, options }); return a; });
    });
    const done = await this.#runJobs(jobs);
    let k = 0;
    return prepared.map((p, i) => {
      if (p.failure) return p.failure;
      const fields = rows[i].map(() => done[k++]);
      return this.#compareResult(p.code, rows[i], fields);
    });
  }

  // The requests checked and their code assembled, one after another: [{request, options, code} | {failure}]
  async #prepare(requests, extra) {
    const out = [];
    for (const req of requests) {
      if (typeof req !== 'object' || req === null) { out.push({ failure: failure(CODES.REQUEST, 'the request must be an object') }); continue; }
      const opts = pickOptions(req, extra);
      if (opts.error) { out.push({ failure: failure(CODES.REQUEST, opts.error) }); continue; }
      const code = await this.#code(req);
      if (code.code !== undefined) { out.push({ failure: code }); continue; }
      out.push({ request: req, options: opts.options, code });
    }
    return out;
  }

  // [{hex, arch, options, full}] -> the analyses in the same order: analyze results (full) or compare() row fields. On
  // the threads when the work is worth it (threadsForWork) or -threads asks; what they do not do (an unknown arch, a
  // thread that failed) is done here, one after another.
  async #runJobs(list) {
    const out = new Array(list.length).fill(null);
    const known = list.flatMap((j, i) => {
      const id = this.resolveArch(j.arch);
      return id ? [{ i, table: this.#configs[id].name, request: { hex: j.hex, arch: id, ...j.options }, full: !!j.full }] : [];
    });
    const threads = this.#threadsAuto ? threadsForWork(known, this.#threads) : Math.min(this.#threads, known.length);
    if (threads > 1) {
      if (!this.#pool) {
        // the pool compiles the module for its threads once; its bytes are dropped after that
        this.#pool = new ThreadPool({ wasm: this.#wasm, uarch: this.#uarch, dataDir: this.#dataDir, limit: this.#threads });
        this.#wasm = null;
      }
      if (!this.#pool.broken) {
        const done = await this.#pool.run(known, threads);
        known.forEach((j, k) => { out[j.i] = done[k]; });
      }
    }
    for (const [i, j] of list.entries()) {
      if (out[i] !== null) continue;
      const r = await this.#run(j.hex, j.arch, j.options);
      out[i] = j.full ? r : compareFields(r);
    }
    return out;
  }

  // compare()'s result from the code, the microarchitectures asked for and their fields (#runJobs)
  #compareResult(code, ids, fields) {
    const results = ids.map((arch, i) => {
      const id = this.resolveArch(arch);
      const { name, year, prototype } = id ? this.#info(id) : { name: String(arch), year: null, prototype: false };
      const { xOps, ...f } = fields[i];
      // code this CPU cannot run (web/caveats.js cannotRun): `unsupported`, the reason; else instructions without data
      // (gaps in its tables): `noData`, their count
      const s = { decodeErrors: f.decodeErrors, xOps: xOps ?? [] };
      const bad = f.code === CODES.OK ? cannotRun(s, { arch: id, code: code.analyzed ?? null }) : null;
      const gaps = f.code === CODES.OK ? noData(s, { arch: id }) : 0;
      return { arch: id ?? String(arch), name, year, prototype, ...f, ...(bad ? { unsupported: bad.reason } : {}), ...(gaps ? { noData: gaps } : {}) };
    });
    // a CPU that could not decode some instructions (FMA on SNB): its throughput leaves them out
    const decode = results.filter((r) => r.code === CODES.OK && r.decodeErrors > 0)
      .map((r) => ({ text: `Warning: ${r.arch}: ${r.decodeErrors} position(s) could not be decoded (instructions it does not have): its throughput leaves them out` }));
    return { code: CODES.OK, ...(code.assembled ? { hex: code.hex, syntax: code.syntax } : {}), ...(code.loop ? { loop: code.loop } : {}), ...(code.otherLoops ? { otherLoops: code.otherLoops } : {}), stderr: [...code.stderr, ...decode], results };
  }

  // POST /api/compare {source | hex, syntax, archs?, options}: one block on several microarchitectures (default: all).
  /** @param {any} [request] @returns {Promise<any>} */
  async compare(request = {}) {
    const opts = pickOptions(request, ['archs', 'per']);
    if (opts.error) return failure(CODES.REQUEST, opts.error);
    const code = await this.#code(request);
    if (code.code !== undefined) return code;
    if (request.archs !== undefined && !Array.isArray(request.archs)) return failure(CODES.REQUEST, '`archs` must be an array of ids');
    const ids = request.archs?.length ? uniqueArchs(request.archs, (a) => this.resolveArch(a)) : this.#archs.map((a) => a.id);
    const options = { ...Wuica.#withAlignment(request, opts.options, code), includeTrace: false, details: false };
    // each microarchitecture as #run() would do it here, on the threads when the work is worth it (#runJobs)
    const per = request.per;
    if (per !== undefined && !(typeof per === 'number' && Number.isFinite(per) && per > 0)) return failure(CODES.REQUEST, '`per` must be a positive number (elements per iteration)');
    const fields = await this.#runJobs(ids.map((arch) => ({ hex: code.hex, arch, options })));
    return comparePerElement(this.#compareResult(code, ids, fields), per);
  }

  // Stops compare()'s threads, if any (they also stop by themselves when idle, and never keep the process alive while
  // idle). The instance stays usable: the next compare() starts them again.
  async close() {
    await this.#pool?.close();
  }

  // The number of threads compare() has running now (0 if none).
  get threads() { return this.#pool?.threads ?? 0; }

  // The derived diagnosis of an analyze() response (web/bound-core.js) with this CPU's configuration (the split-load caveat
  // depends on it); null for a failure.
  // The what-if experiments of a block (web/js/whatif-core.js whatIfRequest): request as analyze's, with `variants` and
  // `per`. The MCP tool what_if and POST /api/what-if/<arch> give the same.
  /** @param {string} arch @param {any} [request] @returns {Promise<any>} */
  async whatIf(arch, request = {}) {
    return whatIfRequest(this, arch, request);
  }

  // Two blocks on one microarchitecture (web/js/block-diff.js): {a: block, b: block, options?, per?} -> the change of
  // throughput, bottlenecks, limits, ports and instructions. wuica diff, the MCP tool diff_blocks and POST /api/diff/<arch>.
  /** @param {string} arch @param {any} request @returns {Promise<any>} */
  async diff(arch, request) {
    return diffRequest(this, arch, request);
  }

  insights(r) {
    return r?.code === CODES.OK ? insights(r, this.#configs[r.arch] ?? null) : null;
  }

  // The compact form of an analyze() response (used by the MCP server): uop table reduced to non-zero values, plus the
  // derived diagnosis of the web page's bound view (web/bound-core.js).
  summarize(r) {
    if (r.code !== CODES.OK) return r;
    const { name, year, prototype } = this.#info(r.arch);
    const round = (x) => Math.round(x * 100) / 100;
    const sources = new Set(['MITE', 'MS', 'DSB', 'LSD']);
    const instructions = r.rows.map((row, k) => {
      /** @type {Record<string, any>} */
      const e = { instr: row.label, ...(row.line ? { line: row.line } : {}), ...(row.loc ? { loc: row.loc } : {}), ...(row.source !== undefined ? { source: row.source } : {}), ...(row.samples !== undefined ? { samples: row.samples } : {}) };
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
    const base = this.insights(r);
    const ins = base ? { ...base, ...detailInsights(r) } : null;
    return {
      code: r.code, arch: r.arch, name, year, prototype, tp: r.tp, unit: 'cycles per iteration', mode: r.mode,
      bottlenecks: r.bottlenecks, limits: r.limits, decodeErrors: r.decodeErrors, ...(r.unsupported ? { unsupported: r.unsupported } : {}), ...(r.noData ? { noData: r.noData } : {}), ...(r.hex ? { hex: r.hex } : {}), ...(r.loop ? { loop: r.loop } : {}), ...(r.otherLoops ? { otherLoops: r.otherLoops } : {}),
      stderr: r.stderr, instructions, ...(ins ? { insights: ins } : {}),
    };
  }

  // An object file (ELF or Mach-O, x86-64; objfile.js) as llvm-objdump -d's text of its code, which analyze() and
  // compare() read as `source` (the objdump path: the loop at its address, exits stubbed, the alignment from it).
  // -> {code: 0, text, format, functions: [{name, section, address, size}]} or a failure (another architecture says how
  // to compile for x86-64). `func`: also resolves a -func name (exact, without Mach-O's "_", or a unique part): `func`.
  /** @param {Uint8Array} bytes @param {{name?: string, func?: string | null}} [opts] @returns {any} */
  disassemble(bytes, { name = 'input', func = null } = {}) {
    const obj = readObject(bytes);
    if (obj.error) return failure(CODES.REQUEST, obj.error);
    if (!obj.functions.length) return failure(CODES.REQUEST, 'no functions in the code sections');
    let resolved = null;
    if (func !== null && func !== undefined) {
      const r = resolveFunction(obj.functions, func);
      if (r.error) return failure(CODES.REQUEST, r.error);
      resolved = r.name;
    }
    let text;
    try {
      text = objdumpText(obj, (b) => this.#analyzer.decode(b, 'ALL'), name);
    } catch (e) {
      return failure(CODES.ANALYSIS, `the decoder failed (${e.message})`);
    }
    return { code: CODES.OK, text, format: obj.format, functions: obj.functions.map(({ name: n, section, address, size }) => ({ name: n, section, address, size })), ...(resolved !== null ? { func: resolved } : {}) };
  }

  get restarts() { return this.#analyzer.restarts; }
}

// options.dataDir: directory with uarch.json and arch/<NAME>.json (plain or .br); default: the package's tables.
// options.analyzerWasm / options.assemblerWasm: paths of the modules (plain or .br).
// options.threads: the most worker threads compare() uses, one per microarchitecture (default: the environment variable
// WUICA_THREADS, else "auto": os.availableParallelism(), and one thread per two microarchitectures; 1 = none, every
// microarchitecture one after another on this thread).
/** @param {import('../index.d.ts').CreateOptions} [options] */
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
