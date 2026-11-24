// The command-line tool: `wuica [options] [FILE | - | HEX]`. Options follow uiCA's and the Rust CLI's (crates/wuica-cli);
// every flag also takes "--" and "=value" spellings, and flag names are case-insensitive.

import fs from 'node:fs';
import path from 'node:path';
import { createWuica, normalizeHex, listLoops, whatIf, WHAT_IF_VARIANTS, WHAT_IF_OPT_IN_VARIANTS, CODES, examples, findExample, objectKind, markdown } from './index.js';
import { analyzedLines } from './web/branch-label.js';
import { whatIfPerElement, whatIfText } from './web/whatif-core.js';
import { diffAnalyses, diffMarkdown, diffText } from './web/block-diff.js';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const USAGE = `Usage: wuica [options] [FILE | - | HEX]
       wuica diff [options] A B     two blocks (files, - or hex) on one CPU: throughput, bottlenecks, ports, instructions
                                    changed; -per N or -per A,B (per element), -md, -json, -arch NAME, -loop, the options
       wuica [options] FILE FILE...   several inputs in one run: one table (-files LIST reads the names from a file)
       wuica mcp                start the MCP server (stdio)

Predicts the throughput of an x86-64 basic block with uiCA's pipeline model (this is wuica ${VERSION}, a WebAssembly
port of uiCA). Input: assembly from FILE (gcc -S, clang -S, objdump -d or -dS, perf annotate --stdio, a hand-written
loop), or stdin if FILE is - or missing; several FILEs: one table. A HEX argument that is not a file is machine code.
Built-in examples (no file needed): -examples lists them, -example saxpy analyzes one (every option applies),
-example saxpy -show prints its assembly to save and edit.

Input:
  -examples              list the built-in examples (name, title, instructions)
  -example NAME          analyze a built-in example as if its text were the input file (case-insensitive; with -att
                         its AT&T text)
  -show                  with -example: print its assembly (machine code for sha256) instead of analyzing it
  -files LIST            also analyze the files named in LIST, one per line (- reads the names from stdin); with
                         several inputs the output is one table (a row per file, or per file and CPU), -TPonly gives
                         "file<TAB>[CPU<TAB>]cycles" lines, -json {code, files: [{file, ...as a single run}]}
  -report                with several inputs: also uiCA's report of each file
  -att, -intel           the assembly's syntax (default: detected from the text: %registers mean AT&T)
  -hex                   the input is machine code as hex digits (spaces, commas, 0x prefixes allowed)
  -raw FILE              read the machine code from a binary file that contains only the code (not an object
                         file: for those, objdump -d FILE | wuica)
  -loops                 list the loops of the assembly (index, label, function, lines, instructions, depth, auto)
  -loop L                what is analyzed: auto (default: the deepest loop, among equals the first; clang's
                         "Inner Loop Header" notes count; perf annotate: the loop with the most samples of its
                         own), whole (all the text), a loop's index (0-based, as
                         -loops lists them) or its label (-loop .LBB0_12)
  -func NAME             only the loops of function NAME (with -loop: its index or label among them); in an object
                         file its symbol, or a unique part of it
  -funcs                 list the functions of an object file (name, section, address, size)
Object files: an ELF or Mach-O x86-64 object, executable or shared object is read directly (wuica dot.o -func dot):
its code as llvm-objdump -d prints it, the loop at its address.

Output:
  -arch NAME             microarchitecture (default: SKL; case-insensitive); "all" prints a table for every one,
                         a comma-separated list (e.g. SKL,ICL,ZEN3) a table for those
  -list                  list the microarchitectures (same as -arch list)
  -TPonly                print only the throughput (with -per: also cycles per element; with -whatif: one
                         "variant cycles" line per variant)
  -per N                 the loop does N elements (bytes, floats, ...) per iteration: also print cycles per element
                         (what-if values too)
  -whatif                the what-if variants (unrolled, N accumulators, front end, fusion) per microarchitecture
  -variants LIST         with -whatif (implied): these variants only, comma-separated; also align (the 64 alignment
                         offsets: min, median, max, best and worst offset; 64 analyses, not in the default set)
  -md                    print GitHub-flavoured Markdown instead of the text report (for an issue, a review, a
                         chat): the result with its uop table, the CPU table, the what-if and loop tables; not with
                         -json or -TPonly
  -json                  print the response as JSON
  -trace                 with -json: include the cycle-by-cycle events (large)
  -details               with -json: include the details (allowed ports, latencies, port set, issue slots)

Simulation (as in uiCA):
  -alignmentOffset N     alignment offset relative to a 64-byte cache line (default: 0; objdump input: from the
                         loop's address)
  -initPolicy P          initial register state: diff (default), same, stack
  -simpleFrontEnd        simulate a front end that is only limited by the issue width
  -noMicroFusion, -noMacroFusion
  -minIterations N       simulate at least N iterations (default: 10)
  -minCycles N           simulate at least N cycles (default: 500)

Other:
  -threads N             with several microarchitectures or files: up to N threads (default: the environment variable
                         WUICA_THREADS, else by the amount of work: none below about 0.3 s, else 2 to 8; 1 = one
                         after another)
  -data DIR              directory with uarch.json and arch/*.bin or *.json (default: the tables in the package)
  -h, --help             this text
  -v, --version          the version (with -json: also the uiCA commit of the data and model)

Exit status: 0 ok, 1 bad request or usage, 2 assembler error, 3 the analysis failed for this input; with several
microarchitectures, the largest of their codes (also the JSON's "code"). A reader that closes the output early
(| head) does not change it.

Throughput is in cycles per iteration of the loop as written (a compiler's unrolled loop does several elements per
iteration: -per N). A block that ends with a branch is analyzed as a loop, otherwise as if repeated back to back.
Assumes all data in L1 and no branch mispredictions. "-" in a table means unknown. ZEN3, ADL-P and ICX are
prototype models (from the fork jtl06/uiCA), less validated than the Intel models of uiCA.`;

export const MCP_USAGE = `Usage: wuica-mcp   (or: wuica mcp)

The wuica MCP server on stdio (JSON-RPC): tools list_archs, analyze, what_if, diff_blocks, compare_archs, list_loops,
assemble.
Configure it in an MCP client as the command "wuica-mcp" (or "npx -y wuica-cli mcp"). Options: --help, --version.
`;

class UsageError extends Error {}

// What a bare run on a terminal prints (no input and stdin is a terminal: nothing to read), on stderr, exit 1.
export const SHORT_USAGE = `wuica: no input. Usage: wuica [options] FILE   (assembly, objdump -d output; - or a pipe for stdin)
  wuica loop.s -arch SKL,ZEN3      objdump -d f.o | wuica      wuica -examples (built-in loops)      wuica -h
Try: wuica -example saxpy -arch SKL,ZEN3,ADL-P
`;

// A bare run on a terminal: no input argument, no example or binary file, and stdin a terminal (piped stdin is read).
export function bareTerminalRun(o, stdinIsTTY) {
  return o.input === null && o.files === undefined && o.example === undefined && o.raw === undefined && !o.examples && !!stdinIsTTY;
}

// flag (lower case, without dashes) -> [canonical, takes a value]
const FLAGS = {
  h: ['help'], help: ['help'], v: ['version'], version: ['version'],
  examples: ['examples'], example: ['example', 1], show: ['show'], files: ['files', 1], report: ['report'], funcs: ['funcs'],
  arch: ['arch', 1], list: ['list'], hex: ['hex'], att: ['att'], intel: ['intel'], raw: ['raw', 1], data: ['data', 1],
  loop: ['loop', 1], loops: ['loops'], func: ['func', 1], per: ['per', 1], whatif: ['whatif'], threads: ['threads', 1],
  tponly: ['tpOnly'], json: ['json'], md: ['md'], variants: ['variants', 1], trace: ['trace'], details: ['details'],
  alignmentoffset: ['alignmentOffset', 1], initpolicy: ['initPolicy', 1], simplefrontend: ['simpleFrontEnd'],
  nomicrofusion: ['noMicroFusion'], nomacrofusion: ['noMacroFusion'], miniterations: ['minIterations', 1], mincycles: ['minCycles', 1],
};

/** @typedef {Record<string, any> & {arch: string, options: Record<string, any>, input: string | null, inputs: string[], syntax: string}} CliOptions */
/** @param {string[]} argv @returns {CliOptions} */
export function parseArgs(argv) {
  /** @type {CliOptions} */
  const o = { arch: 'SKL', options: {}, input: null, inputs: [], syntax: 'auto' };
  const int = (s, name) => {
    if (!/^-?\d+$/.test(s)) throw new UsageError(`-${name}: not an integer: ${s}`);
    return Number(s);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-') || a === '-') {
      // several inputs: a batch (batch(); o.input is the first)
      o.inputs.push(a);
      o.input ??= a;
      continue;
    }
    const m = /^--?([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new UsageError(`unknown option ${a}`); // "-=x"
    const f = FLAGS[m[1].toLowerCase()];
    if (!f) throw new UsageError(`unknown option ${a}`);
    const [name, takes] = f;
    let v = m[2];
    if (takes && v === undefined) { if (i + 1 >= argv.length) throw new UsageError(`-${name} needs a value`); v = argv[++i]; }
    if (!takes && v !== undefined) throw new UsageError(`-${name} takes no value`);
    switch (name) {
      case 'att': case 'intel': o.syntax = name; break;
      case 'loop': o.loop = /^\d+$/.test(v) ? Number(v) : v; break;
      case 'variants': {
        o.variants = v.split(',').map((x) => x.trim()).filter(Boolean);
        const known = [...WHAT_IF_VARIANTS, ...WHAT_IF_OPT_IN_VARIANTS];
        if (!o.variants.length) throw new UsageError(`-variants: no variant in "${v}" (known: ${known.join(', ')})`);
        const unknown = o.variants.filter((x) => !known.includes(x));
        if (unknown.length) throw new UsageError(`-variants: unknown variant(s): ${unknown.join(', ')} (known: ${known.join(', ')})`);
        o.whatif = true;
        break;
      }
      case 'per': o.per = Number(v); if (!(o.per > 0)) throw new UsageError(`-per: a positive number of elements per iteration: ${v}`); break;
      case 'threads': o.threads = int(v, name); if (o.threads < 1) throw new UsageError('-threads: at least 1'); break;
      case 'trace': o.options.includeTrace = true; break;
      case 'details': o.options.details = true; break;
      case 'alignmentOffset': case 'minIterations': case 'minCycles': o.options[name] = int(v, name); break;
      case 'initPolicy': o.options.initPolicy = v; break;
      case 'simpleFrontEnd': case 'noMicroFusion': case 'noMacroFusion': o.options[name] = true; break;
      default: o[name] = takes ? v : true;
    }
  }
  if (o.md && (o.json || o.tpOnly)) throw new UsageError(`-md: Markdown instead of the text report; not with ${o.json ? '-json (JSON is its own format)' : '-TPonly (one number per line)'}`);
  o.arch = o.arch.trim();
  if (o.arch.toLowerCase() === 'list') o.list = true;
  // several microarchitectures: all, or a comma-separated list
  if (o.arch.toLowerCase() === 'all') o.archs = [];
  else if (o.arch.includes(',')) {
    o.archs = o.arch.split(',').map((x) => x.trim()).filter((x) => x !== '');
    if (o.archs.length === 0) throw new UsageError(`-arch: no microarchitecture in "${o.arch}"`);
    if (o.archs.some((x) => x.toLowerCase() === 'all')) throw new UsageError('-arch: "all" cannot be part of a list');
  }
  return o;
}

async function readStdin(stdin) {
  const chunks = [];
  for await (const c of stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8');
}

// The format of a file that is not bare machine code, from its first bytes, or null.
export function binaryFormat(b) {
  const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0x7f, 0x45, 0x4c, 0x46)) return 'an ELF file';
  if (at(0, 0xcf, 0xfa, 0xed, 0xfe) || at(0, 0xce, 0xfa, 0xed, 0xfe) || at(0, 0xfe, 0xed, 0xfa, 0xcf) || at(0, 0xfe, 0xed, 0xfa, 0xce) || at(0, 0xca, 0xfe, 0xba, 0xbe)) return 'a Mach-O file';
  if (at(0, 0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a)) return 'an archive (.a)';
  if (at(0, 0x4d, 0x5a)) return 'a PE (Windows) executable';
  if (at(0, 0x64, 0x86) && b.length >= 20) return 'a COFF object file';
  return null;
}
// mostly printable text
const looksText = (b) => b.length > 0 && [...b.subarray(0, 4096)].filter((x) => x === 9 || x === 10 || x === 13 || (x >= 32 && x < 127)).length >= 0.95 * Math.min(b.length, 4096);

// Reads a file for -raw or as the input: its bytes, or a UsageError that says what is wrong.
function readFile(file) {
  let st;
  try { st = fs.statSync(file); } catch { throw new UsageError(`no such file: ${file}`); }
  if (st.isDirectory()) throw new UsageError(`${file} is a directory, not a file`);
  return fs.readFileSync(file);
}

// {request: {hex} | {source, syntax}, name: what the diagnostics call it, notes: [stderr lines]}
/** @param {CliOptions} o @param {any} io @param {any} [w] @returns {Promise<any>} */
async function readInput(o, io, w = null) {
  const notes = [];
  if (o.example !== undefined) {
    if (o.input !== null || o.raw !== undefined) throw new UsageError(`-example and an input (${o.input ?? `-raw ${o.raw}`}) cannot be combined`);
    const e = exampleOf(o.example);
    const syntax = o.syntax === 'att' ? 'att' : 'intel';
    notes.push(`example ${e.name}: ${e.title}${e.intel ? `, ${syntax === 'att' ? 'AT&T' : 'Intel'} syntax` : ', machine code'} (-example ${e.name} -show prints it)`);
    if (!e.intel) return { request: { hex: e.hex }, name: `example ${e.name}`, notes };
    return { request: { source: e[syntax], syntax, ...(o.loop !== undefined ? { loop: o.loop } : {}), ...(o.func ? { func: o.func } : {}) }, name: `example ${e.name}`, notes };
  }
  if (o.raw !== undefined) {
    if (o.input !== null) throw new UsageError(`-raw and an input (${o.input}) cannot be combined`);
    const b = readFile(o.raw);
    const fmt = binaryFormat(b);
    if (fmt) throw new UsageError(`${o.raw} is ${fmt}, not bare machine code: give it without -raw (wuica ${o.raw} reads ELF and Mach-O object files and executables)`);
    if (looksText(b)) notes.push(`warning: ${o.raw} looks like text, not machine code (without -raw it is read as assembly)`);
    return { request: { hex: b.toString('hex') }, name: o.raw, notes };
  }
  let text, name;
  if (o.input === null || o.input === '-') {
    if (o.input === null && io.stdin.isTTY) throw new UsageError('no input');
    text = await readStdin(io.stdin);
    name = '<stdin>';
  } else if (fs.existsSync(o.input)) {
    const b = readFile(o.input);
    name = o.input;
    // an object file or executable: llvm-objdump -d's text of its code (Wuica.disassemble), read as objdump output
    if (objectKind(b) && !o.hex) {
      const d = w.disassemble(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), { name: path.basename(name), func: o.func ?? null });
      if (d.code) throw new UsageError(/^func: /.test(d.error) ? d.error : `${name}: ${d.error}`);
      return { request: { source: d.text, syntax: 'intel', ...(o.loop !== undefined ? { loop: o.loop } : {}), ...(d.func ? { func: d.func } : {}) }, name, notes, object: d };
    }
    text = b.toString('utf8');
  } else if (normalizeHex(o.input) !== null) {
    const n = String(normalizeHex(o.input)).length / 2;
    notes.push(`analyzed: ${n} byte${n === 1 ? '' : 's'} of machine code from the argument "${o.input}" (not a file)`);
    return { request: { hex: o.input }, name: 'the argument', notes };
  } else {
    readFile(o.input); // the error
  }
  if (o.hex) return { request: { hex: text }, name, notes };
  return { request: { source: text, syntax: o.syntax, ...(o.loop !== undefined ? { loop: o.loop } : {}), ...(o.func ? { func: o.func } : {}) }, name, notes };
}

// The -loops table
function printLoops(ls, out) {
  const lw = Math.max(5, ...ls.map((l) => l.label.length)), fw = Math.max(8, ...ls.map((l) => String(l.function ?? '-').length));
  out.write(`${'#'.padStart(3)}  ${'label'.padEnd(lw)}  ${'function'.padEnd(fw)}  ${'lines'.padEnd(9)}  instrs  depth\n`);
  for (const l of ls) out.write(`${String(l.index).padStart(3)}  ${l.label.padEnd(lw)}  ${String(l.function ?? '-').padEnd(fw)}  ${`${l.line}-${l.endLine}`.padEnd(9)}  ${String(l.instructions).padStart(6)}  ${String(l.depth).padStart(5)}${l.auto ? '  auto' : ''}\n`);
  out.write('\n-loop N (0-based) or -loop LABEL analyzes one; "auto" is what runs without -loop.\n');
}

// The built-in example called name, or a UsageError that lists the names.
function exampleOf(name) {
  const e = findExample(name);
  if (!e) throw new UsageError(`unknown example: ${name} (known: ${examples().map((x) => x.name).join(', ')})`);
  return e;
}

function printExamples(o, out) {
  const list = examples();
  if (o.json) { out.write(JSON.stringify(list.map(({ name, title, group, arch, instructions }) => ({ name, title, group, arch, instructions }))) + '\n'); return; }
  const nw = Math.max(...list.map((e) => e.name.length)), tw = Math.max(...list.map((e) => e.title.length));
  for (const e of list) out.write(`${e.name.padEnd(nw)}  ${e.title.padEnd(tw)}  ${String(e.instructions).padStart(4)} instructions\n`);
  out.write('\nwuica -example NAME [options] analyzes one; -example NAME -show prints its assembly.\n');
}

const fmt = (x) => Number(x).toFixed(2);
// cycles per element: 3 significant digits under 0.1 (0.0625, 0.0313), else as fmt
const fmtEl = (x) => (x !== 0 && Math.abs(x) < 0.1 ? Number(x).toPrecision(3) : fmt(x));
const MAX_ERRORS = 10;

function printList(w, o, out) {
  const archs = w.archs();
  if (o.json) { out.write(JSON.stringify(archs, null, 1) + '\n'); return; }
  const width = Math.max(...archs.map((a) => a.id.length));
  for (const a of archs) out.write(`${a.id.padEnd(width)}  ${a.name}${a.year ? ` (${a.year})` : ''}${a.prototype ? '  [prototype]' : ''}\n`);
}

// stderr lines with the input's name for <input>; after MAX_ERRORS errors (each with its source and caret lines), one
// line for the rest
function printStderr(r, err, name) {
  let errors = 0, skipping = false;
  const hints = [];
  for (const l of r.stderr ?? []) {
    if (/^hint: /.test(l.text)) { hints.push(l.text); continue; } // last, after the count of the errors left out
    if (l.tag?.severity === 'error') { errors++; skipping = errors > MAX_ERRORS; }
    else if (l.tag) skipping = false;
    if (!skipping) err.write(String(l.text).replace(/^<input>:/, `${name}:`) + '\n');
  }
  if (errors > MAX_ERRORS) err.write(`… and ${errors - MAX_ERRORS} more error${errors - MAX_ERRORS === 1 ? '' : 's'}\n`);
  for (const h of hints) err.write(`${h}\n`);
}

// What of the text was analyzed, the syntax, the other loops; the alignment offset from addresses.
function printAnalyzed(r, err, o) {
  const p = r.loop;
  const syn = r.syntax ? `${r.syntax === 'att' ? 'AT&T' : 'Intel'} syntax${o.syntax === 'auto' ? ' (detected)' : ''}` : null;
  if (p && p.line) {
    const others = (p.count ?? 1) - (Number.isInteger(p.index) ? 1 : 0);
    err.write(`analyzed: ${p.name} (${o.objectInput ? '' : `lines ${p.line}-${p.endLine}`}${p.function ? `${o.objectInput ? '' : ', '}in ${p.function}` : ''}${p.address !== undefined ? `, address 0x${p.address.toString(16)}` : ''})${syn ? `, ${syn}` : ''}`
      + `${others > 0 ? `; ${others} other loop${others === 1 ? '' : 's'}: -loops lists them, -loop picks one` : ''}; -loop whole for the whole text\n`);
  } else if (syn && r.syntax === 'att' && o.syntax === 'auto') {
    err.write(`analyzed: the whole text, ${syn}; -intel forces Intel\n`);
  }
  if (p && p.alignmentOffset !== undefined && o.options.alignmentOffset === undefined) err.write(`alignment offset ${p.alignmentOffset} (from the addresses)\n`);
}

// The registers a loop advances by a constant and uses in an address or a compare, with what the step counts: "rcx +=
// 8 per iteration (index; ×4 bytes in [rdi+rcx*4])" (an index register: elements of that size), "r13 += 64 per iteration
// (bytes; the base of [r13+0x20])", or "(register step)" when no address says (a counter only compared).
export function inductionSteps(r) {
  if (r?.mode !== 'loop') return [];
  const step = new Map(), other = new Set(), used = new Set(), unit = new Map();
  for (const x of r.rows ?? []) {
    if (x.kind !== 'instr') continue;
    const t = String(x.label).trim().toLowerCase().replace(/\s+/g, ' ');
    const [mn, rest = ''] = t.split(/ (.*)/);
    const ops = rest.split(',').map((s) => s.trim());
    for (const m of t.matchAll(/\[([^\]]*)\]/g)) {
      const regs = m[1].split(/[+-]/).map((p) => p.trim()).filter((p) => /^[a-z]\w*(?:\*\d)?$/.test(p) && !/^0x/.test(p));
      regs.forEach((p, k) => {
        const [reg, scale] = p.split('*');
        used.add(reg);
        if (unit.has(reg)) return;
        // the first register without a scale is the base (bytes); a scaled one is an index (elements of that size)
        if (scale && scale !== '1') unit.set(reg, `index; ×${scale} bytes in [${m[1]}]`);
        else unit.set(reg, k === 0 && !scale ? `bytes; the base of [${m[1]}]` : `bytes; the index of [${m[1]}]`);
      });
    }
    if (mn === 'cmp' || mn === 'test') for (const op of ops) used.add(op);
    const reg = /^(?:r(?:[abcd]x|[sd]i|bp|[89]|1[0-5]))$/.test(ops[0]) ? ops[0] : null;
    if (!reg) continue;
    const imm = /^-?(?:0x[0-9a-f]+|\d+)$/.test(ops[1] ?? '') ? Number(ops[1].startsWith('-') ? -Number(ops[1].slice(1)) : Number(ops[1])) : null;
    if (mn === 'add' && imm !== null) step.set(reg, (step.get(reg) ?? 0) + imm);
    else if (mn === 'sub' && imm !== null) step.set(reg, (step.get(reg) ?? 0) - imm);
    else if (mn === 'inc' && ops.length === 1) step.set(reg, (step.get(reg) ?? 0) + 1);
    else if (mn === 'dec' && ops.length === 1) step.set(reg, (step.get(reg) ?? 0) - 1);
    else if (!['cmp', 'test', 'push', 'bt'].includes(mn)) other.add(reg); // written otherwise
  }
  return [...step].filter(([reg, s]) => s !== 0 && !other.has(reg) && used.has(reg)).map(([reg, s]) => `${reg} ${s < 0 ? '-=' : '+='} ${Math.abs(s)} per iteration (${unit.get(reg) ?? 'register step'})`);
}
const stepLine = (steps) => `step: ${steps.join(', ')}; -per N (N elements per iteration): cycles per element\n`;

// The diagnosis after the report: the nearest limit when uiCA names no bottleneck, the next limit, the caveats.
function diagnosis(ins, r) {
  const lines = [];
  if (!ins) return lines;
  if (ins.largest) lines.push(`Bottleneck: unknown (nearest ${ins.largest.join(', ')} ${fmt(Math.max(...r.limits.filter((l) => ins.largest.includes(l.name)).map((l) => l.tp)))}${ins.unexplained ? `; ${fmt(ins.unexplained)} cycles/iteration no single limit explains` : ''})`);
  else if (ins.next && ins.binding.length) lines.push(`Next limit: ${ins.next.limit} ${fmt(ins.next.tp)} (at most ${fmt(ins.next.maxSpeedup)}x faster without ${ins.binding.join(', ')})`);
  for (const c of ins.caveats ?? []) lines.push(`Not modelled: ${c.text}: ${c.title}`);
  return lines;
}

// what-if results per element and as text: web/js/whatif-core.js (shared with the REST API)
const whatIfPer = whatIfPerElement;
const whatIfTable = whatIfText;
// -TPonly -whatif: one "variant cycles [per element]" line per variant (prefix: the CPU, with several)
function whatIfTerse(x, prefix = '') {
  if (x.code) return `${prefix}what-if error: ${x.error}\n`;
  if (x.unsupported) return `${prefix}what-if: not a result: ${x.unsupported}\n`; // (no variants)
  return x.variants.map((v) => `${prefix}${v.id} ${v.error ? 'error' : `${fmt(v.tp)}${v.perElement !== undefined ? ` ${fmtEl(v.perElement)}` : ''}`}\n`).join('');
}

// -md: "SKL · Skylake (2015)"
function archTitle(w, id) {
  const a = w.archs().find((x) => x.id === id);
  return a ? `${id} · ${a.name}${a.year ? ` (${a.year})` : ''}` : id;
}
// -md: the analyzed lines of an assembly input, for the branch targets as labels (branch-label.js); null for machine code
const srcOf = (req, r) => (req.source ? analyzedLines(String(req.source).replace(/\r\n?/g, '\n'), r) : null);
// -md: the assembly that was analyzed (the loop's lines, or all of the text), for the report's code block; none for
// machine code or a text longer than MD_CODE_LINES lines
const MD_CODE_LINES = 200;
function analyzedCode(req, r) {
  if (!req.source) return null;
  const lines = String(req.source).replace(/\r\n?/g, '\n').split('\n');
  const p = r.loop;
  const part = p && p.line && p.endLine ? lines.slice(p.line - 1, p.endLine) : lines;
  const text = part.join('\n').replace(/^\n+|\s+$/g, '');
  return text && part.length <= MD_CODE_LINES ? text : null;
}

// argv: the arguments after the program name. io: {stdin, stdout, stderr}. Returns the exit code: the result's
// `code` (0 ok, 1 bad request or usage, 2 assembler error, 3 analysis error).
export async function main(argv, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) {
  const { stdout: out, stderr: err } = io;
  /** @type {CliOptions} */
  let o = /** @type {any} */ (null); // set by parseArgs, first thing (fail() before that: o?.json)
  const fail = (code, msg) => {
    if (o?.json) out.write(JSON.stringify({ code, error: msg, stderr: [{ text: msg }] }) + '\n');
    else err.write(`${msg}\n`);
    return code;
  };
  if (argv[0] === 'diff') return diffMain(argv.slice(1), io);
  try {
    o = parseArgs(argv);
    if (o.help) { out.write(USAGE + '\n'); return 0; }
    if (o.version) {
      // -json: with the uiCA reference whose data and model this is (dist/manifest.json, from ci/data-asset.txt)
      if (o.json) {
        let uiCA = null;
        try { uiCA = JSON.parse(fs.readFileSync(new URL('../dist/manifest.json', import.meta.url), 'utf8')).uiCA ?? null; } catch { /* not built */ }
        out.write(JSON.stringify({ wuica: VERSION, uiCA, node: process.versions.node }) + '\n');
      } else out.write(`wuica ${VERSION}\n`);
      return 0;
    }
    if (o.examples) { printExamples(o, out); return 0; }
    if (o.show) {
      if (o.example === undefined) throw new UsageError('-show: with -example NAME (prints that example\'s assembly)');
      const e = exampleOf(o.example);
      out.write(e.intel ? e[o.syntax === 'att' ? 'att' : 'intel'] : e.hex.replace(/(.{64})/g, '$1\n').replace(/\n?$/, '\n'));
      if (!e.intel) err.write(`example ${e.name} is machine code: wuica -hex FILE reads it\n`);
      return 0;
    }
    if (bareTerminalRun(o, io.stdin?.isTTY)) { err.write(SHORT_USAGE); return 1; }
    const w = await createWuica({ ...(o.data ? { dataDir: o.data } : {}), ...(o.threads ? { threads: o.threads } : {}) });
    if (o.list) { printList(w, o, out); return 0; }
    // the microarchitectures before the input (stdin is not read for a mistyped name)
    const names = o.archs ?? [o.arch];
    const unknown = names.filter((a) => !w.resolveArch(a));
    if (unknown.length) return fail(CODES.REQUEST, `unknown microarchitecture${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (known: ${w.archs('id').map((a) => a.id).join(', ')})`);
    if (o.options.details && (!o.json || o.archs)) err.write('-details: shown only with -json and one microarchitecture; ignored\n');
    if (o.options.includeTrace && (!o.json || o.archs)) { err.write('-trace: shown only with -json and one microarchitecture; ignored\n'); delete o.options.includeTrace; }
    if (o.inputs.length > 1 || o.files !== undefined) {
      if (o.raw !== undefined) throw new UsageError('-raw: one input per run (not with several inputs)');
      return await batch(w, o, io);
    }
    if (o.report) err.write('-report: with several inputs (one input prints its report anyway); ignored\n');
    const input = await readInput(o, io, w);
    for (const n of input.notes) err.write(`${n}\n`);
    if (input.object) o.objectInput = true;
    if (o.funcs) {
      if (!input.object) return fail(CODES.REQUEST, '-funcs: lists the functions of an object file (for assembly, -loops lists the loops with their functions)');
      const fs_ = input.object.functions;
      if (o.json) { out.write(JSON.stringify({ code: 0, format: input.object.format, functions: fs_ }) + '\n'); return 0; }
      const nw = Math.max(4, ...fs_.map((f) => f.name.length)), sw = Math.max(7, ...fs_.map((f) => f.section.length));
      out.write(`${'name'.padEnd(nw)}  ${'section'.padEnd(sw)}  ${'address'.padStart(10)}  ${'size'.padStart(6)}\n`);
      for (const f of fs_) out.write(`${f.name.padEnd(nw)}  ${f.section.padEnd(sw)}  ${`0x${f.address.toString(16)}`.padStart(10)}  ${String(f.size).padStart(6)}\n`);
      return 0;
    }
    const req = { ...input.request, options: o.options };

    if (o.loops) {
      if (!req.source) return fail(CODES.REQUEST, '-loops: needs assembly (not machine code)');
      const ls = listLoops(req.source, { func: o.func ?? null });
      if (ls.error) return fail(CODES.REQUEST, ls.error);
      if (o.json) { out.write(JSON.stringify({ code: 0, loops: ls }) + '\n'); return 0; }
      if (o.md) { out.write(markdown.loops(ls)); return 0; }
      if (!ls.length) { out.write('no loops\n'); return 0; }
      printLoops(ls, out);
      return 0;
    }
    const per = (tp) => (o.per ? tp / o.per : undefined);
    const bound = { analyze: (a, r) => w.analyze(a, r), assemble: (t) => w.assemble(t, 'intel') };
    const whatIfs = async (archs) => {
      const res = {};
      for (const a of archs) res[w.resolveArch(a)] = whatIfPer(await whatIf(bound.analyze, a, req, o.variants ?? WHAT_IF_VARIANTS, { assemble: bound.assemble }), o.per);
      return res;
    };

    if (o.archs) {
      const c = await w.compare({ ...req, ...(o.archs.length ? { archs: o.archs } : {}), ...(o.per ? { per: o.per } : {}) });
      const status = c.code || Math.max(0, ...(c.results ?? []).map((r) => r.code));
      if (c.code) {
        if (o.json) { out.write(JSON.stringify(c) + '\n'); return status; }
        printStderr(c, err, input.name);
        return status;
      }
      // the caveats per CPU: one analysis for the instructions, each CPU's configuration (the split-load cost)
      const first = c.results.find((r) => r.code === 0);
      const base = !o.tpOnly && first ? await w.analyze(first.arch, req) : null;
      const insOf = (r) => (base?.code === 0 && r.code === 0 && !r.unsupported ? w.insights({ ...base, arch: r.arch, tp: r.tp, limits: r.limits, bottlenecks: r.bottlenecks }) : null);
      const extra = c.results.map((r) => ({ ins: insOf(r), per: r.code === 0 ? per(r.tp) : undefined }));
      const wi = o.whatif ? await whatIfs(c.results.filter((r) => r.code === 0).map((r) => r.arch)) : null;
      if (o.json) {
        const results = c.results.map((r, k) => ({ ...r, ...(extra[k].per !== undefined ? { perElement: extra[k].per } : {}), ...(extra[k].ins?.caveats ? { caveats: extra[k].ins.caveats } : {}) }));
        out.write(JSON.stringify({ ...c, code: status, results, ...(wi ? { whatIf: wi } : {}) }) + '\n');
        return status;
      }
      printStderr(c, err, input.name);
      printAnalyzed(c, err, o);
      if (o.md) {
        const results = c.results.map((r, k) => ({ ...r, ...(extra[k].ins?.caveats ? { caveats: extra[k].ins.caveats } : {}) }));
        out.write(markdown.cpuTable({ ...c, results }, { per: o.per }));
        for (const x of Object.values(wi ?? {})) out.write('\n' + markdown.whatIfAlignment(x));
        if (base?.code === 0 && !o.per) { const s = inductionSteps(base); if (s.length) err.write(stepLine(s)); }
        return status;
      }
      const kw = Math.max(4, ...c.results.map((r) => r.arch.length));
      const nw = Math.max(5, ...c.results.map((r) => r.name.length));
      const bns = c.results.map((r, k) => (r.code ? `error: ${r.error.split('\n')[0]}` : r.unsupported ? '-' : r.bottlenecks.join(', ') || (extra[k].ins?.largest ? `- (nearest ${extra[k].ins.largest.join(', ')})` : '-')));
      // the Bottlenecks column as wide as its widest entry (an error's message, the last thing on its row, not counted)
      const bw = Math.max(11, ...bns.filter((b, k) => !c.results[k].code).map((b) => b.length));
      if (!o.tpOnly) out.write(`${'Arch'.padEnd(kw)}  ${'Model'.padEnd(nw)}  Year  ${'TP'.padStart(6)}${o.per ? `  ${'per el'.padStart(6)}` : ''}  ${'Bottlenecks'.padEnd(bw)}  Notes\n`);
      c.results.forEach((r, k) => {
        const { ins, per: pe } = extra[k];
        if (o.tpOnly) {
          out.write(`${r.arch.padEnd(kw)}  ${r.code ? 'error' : fmt(r.tp)}${pe !== undefined ? ` ${fmtEl(pe)}` : ''}\n`);
          if (wi?.[r.arch]) out.write(whatIfTerse(wi[r.arch], `${r.arch.padEnd(kw)}  `));
          return;
        }
        const year = String(r.year ?? '').padEnd(4);
        const tp = (r.code ? '-' : `${fmt(r.tp)}${r.decodeErrors || r.unsupported ? '*' : ''}`).padStart(6);
        const notes = [r.unsupported ? `not a result: ${r.unsupported}` : null, r.decodeErrors ? `${r.decodeErrors} undecodable (left out)` : null, r.noData ? `${r.noData} without data (cost left out)` : null, ...(ins?.caveats ?? []).map((x) => x.text), r.prototype ? '[prototype]' : null].filter(Boolean).join('; ');
        out.write(`${r.arch.padEnd(kw)}  ${r.name.padEnd(nw)}  ${year}  ${tp}${o.per ? `  ${(pe !== undefined ? fmtEl(pe) : '-').padStart(6)}` : ''}  ${bns[k].padEnd(bw)}${notes ? `  ${notes}` : ''}`.trimEnd() + '\n');
      });
      if (!o.tpOnly) {
        out.write(`\nTP: cycles per iteration${o.per ? `; per el: per element (${o.per} per iteration)` : ''}. "-": unknown. *: not a result: that CPU cannot run some of the code, which its number leaves out.\n`);
        if (c.results.some((r) => r.prototype)) out.write('[prototype]: experimental model of the fork jtl06/uiCA.\n');
        if (base?.code === 0 && !o.per) { const s = inductionSteps(base); if (s.length) err.write(stepLine(s)); }
        for (const x of Object.values(wi ?? {})) out.write('\n' + (x.code ? `What if (${x.arch}): ${x.error}\n` : whatIfTable(x)));
      }
      return status;
    }

    const r = await w.analyze(o.arch, req);
    const ins = r.code === 0 && !r.unsupported ? w.insights(r) : null; // (none for a result its CPU cannot run)
    const wi = o.whatif && r.code === 0 ? await whatIfs([o.arch]) : null;
    if (o.json) {
      out.write(JSON.stringify(r.code ? r : { ...r, ...(o.per ? { perElement: per(r.tp) } : {}), ...(ins ? { insights: ins } : {}), ...(wi ? { whatIf: wi } : {}) }) + '\n');
      return r.code;
    }
    printStderr(r, err, input.name);
    if (r.code) return r.code;
    printAnalyzed(r, err, o);
    if (o.md) {
      out.write(markdown.report(r, { arch: archTitle(w, r.arch), per: o.per, insights: ins, src: srcOf(req, r), code: analyzedCode(req, r) }));
      for (const x of Object.values(wi ?? {})) out.write('\n' + markdown.whatIfAlignment(x));
      const steps = !o.per ? inductionSteps(r) : [];
      if (steps.length) err.write(stepLine(steps));
      return 0;
    }
    if (o.tpOnly) {
      out.write(`${fmt(r.tp)}${o.per ? ` ${fmtEl(per(r.tp))}` : ''}\n`);
      for (const x of Object.values(wi ?? {})) out.write(whatIfTerse(x));
      return 0;
    }
    // uiCA's "Bottleneck: unknown" line says what is nearest (the diagnosis's first line)
    const d = diagnosis(ins, r);
    let text = r.text;
    if (ins?.largest && /^Bottleneck: unknown$/m.test(text)) text = text.replace(/^Bottleneck: unknown$/m, d.shift());
    out.write(text);
    if (r.unsupported) d.unshift(`Not a result for ${r.arch}: ${r.unsupported} (the throughput leaves out what it cannot run)`);
    else if (r.noData) d.push(`${r.noData} instruction${r.noData === 1 ? '' : 's'} without data (not in the instruction tables): the throughput leaves their cost out`);
    if (o.per) d.push(`Per element: ${fmtEl(per(r.tp))} cycles (${fmt(r.tp)} cycles/iteration, ${o.per} elements per iteration)`);
    if (d.length) out.write(`\n${d.join('\n')}\n`);
    const steps = !o.per ? inductionSteps(r) : [];
    if (steps.length) err.write(stepLine(steps));
    for (const x of Object.values(wi ?? {})) out.write('\n' + (x.code ? `What if (${x.arch}): ${x.error}\n` : whatIfTable(x)));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      if (e.message === 'no input') { err.write(`${USAGE}\n`); return 1; }
      return o?.json ? fail(1, `wuica: ${e.message}`) : (err.write(`wuica: ${e.message}\nRun "wuica -h" for the options.\n`), 1);
    }
    return fail(1, `wuica: ${e?.message ?? e}`);
  }
}

// ---- wuica diff A B ---------------------------------------------------------------------------------------------------
// Two blocks (each a file, - for stdin, or hex; object files as for one input) on one microarchitecture (-arch, default
// SKL): web/js/block-diff.js. -per N (both) or -per A,B: also per element. -md: the Markdown of the page's A–B view;
// -json: the result object. The other options as for one input (applied to both). Exit status: 0, or the failing side's.
async function diffMain(argv, io) {
  const { stdout: out, stderr: err } = io;
  /** @type {CliOptions} */
  let o = /** @type {any} */ (null);
  try {
    // -per N or -per A,B (parseArgs takes one number)
    /** @type {number[] | null} */
    let per = null;
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
      const m = /^--?per(?:=(.*))?$/i.exec(argv[i]);
      if (!m) { rest.push(argv[i]); continue; }
      const v = m[1] ?? argv[++i];
      if (v === undefined) throw new UsageError('-per needs a value');
      per = String(v).split(',').map(Number);
      if (per.length === 1) per = [per[0], per[0]];
      if (per.length !== 2 || !per.every((n) => Number.isFinite(n) && n > 0)) throw new UsageError(`-per: elements per iteration, N or A,B: ${v}`);
    }
    o = parseArgs(rest);
    if (o.help) { out.write(USAGE + '\n'); return 0; }
    if (o.md && (o.json || o.tpOnly)) throw new UsageError(`-md: Markdown instead of the text report; not with ${o.json ? '-json (JSON is its own format)' : '-TPonly (one number per line)'}`);
    if (o.inputs.length !== 2) throw new UsageError(`two inputs, A and B (got ${o.inputs.length})`);
    if (o.archs) throw new UsageError('one microarchitecture (-arch NAME)');
    const NOT = { whatif: '-whatif', variants: '-variants', loops: '-loops', funcs: '-funcs', example: '-example', files: '-files', raw: '-raw', tpOnly: '-TPonly', report: '-report' };
    for (const [f, flag] of Object.entries(NOT)) if (o[f] !== undefined && o[f] !== false) throw new UsageError(`${flag} is not available here`);
    if (o.inputs.filter((n) => n === '-').length > 1) throw new UsageError('stdin (-) can be read only once');
    const w = await createWuica({ ...(o.data ? { dataDir: o.data } : {}) });
    if (!w.resolveArch(o.arch)) return failWith(CODES.REQUEST, `unknown microarchitecture: ${o.arch} (known: ${w.archs('id').map((a) => a.id).join(', ')})`);
    const sides = [];
    for (const name of o.inputs) {
      const input = await readInput({ ...o, input: name }, io, w);
      for (const n of input.notes) err.write(`${name}: ${n}\n`);
      sides.push(input);
    }
    const x = await diffAnalyses(w, o.arch, { a: sides[0].request, b: sides[1].request, options: o.options, ...(per ? { per } : {}) });
    if (x.failure) {
      if (o.json) { out.write(JSON.stringify(x.failure) + '\n'); return x.failure.code; }
      // one message: the assembler's positioned lines with the side's file name, else the error (with the side's name
      // when it is one side's)
      const k = /^A: /.test(x.failure.error) ? 0 : /^B: /.test(x.failure.error) ? 1 : -1;
      const tagged = (x.failure.stderr ?? []).some((l) => l.tag);
      if (k >= 0 && tagged) printStderr(x.failure, err, o.inputs[k]);
      else err.write(`${k >= 0 ? o.inputs[k] : 'wuica diff'}: ${String(x.failure.error).replace(/^[AB]: /, '')}\n`);
      return x.failure.code;
    }
    for (const [k, r] of [x.a, x.b].entries()) printStderr(prefixed(r, o.inputs[k]), err, o.inputs[k]);
    if (o.json) { out.write(JSON.stringify(x.result) + '\n'); return 0; }
    out.write(o.md ? diffMarkdown(x, { archTitle: archTitle(w, x.result.arch) }) : `A: ${o.inputs[0]}\nB: ${o.inputs[1]}\n${diffText(x.result)}`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) return failWith(1, `wuica diff: ${e.message}`);
    return failWith(1, `wuica diff: ${e?.message ?? e}`);
  }
  function failWith(code, msg) {
    if (o?.json) out.write(JSON.stringify({ code, error: msg, stderr: [{ text: msg }] }) + '\n');
    else err.write(`${msg}\n`);
    return code;
  }
}

// ---- several inputs in one run ---------------------------------------------------------------------------------------
// wuica a.s b.s ...  /  -files LIST (one path per line; - for stdin): each input as a single run would read it, the
// analyses of all of them (x the CPUs) as one set of jobs for the threads, the output in input order:
//   text      one table: a row per file (one CPU), or a row per file and CPU (several: grouped by file, a CPU column,
//             so that any number of CPUs fits in 80 columns); -report adds uiCA's report per file, -whatif the what-if
//             table per file, each after a "==> FILE <==" line
//   -TPonly   tab-separated lines: file, [CPU,] [variant,] cycles [, cycles per element]
//   -json     {code, files: [{file, ...}]}: each entry is what a single run prints for that file, with its name
// The exit status (and the JSON's code) is the largest of the files' statuses.

// The input names of a run: the arguments, then those of -files (blank lines and # comments left out).
async function inputNames(o, io) {
  const names = [...o.inputs];
  if (o.files !== undefined) {
    const text = o.files === '-' ? await readStdin(io.stdin) : readFile(o.files).toString('utf8');
    const listed = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    if (!listed.length) throw new UsageError(`-files ${o.files}: no file names in it`);
    names.push(...listed);
  }
  if (names.filter((n) => n === '-').length + (o.files === '-' ? 1 : 0) > 1) throw new UsageError('stdin (-) can be read only once');
  return names;
}

const STATUS = (r) => r.code || Math.max(0, ...(r.results ?? []).map((x) => x.code));

async function batch(w, o, io) {
  const { stdout: out, stderr: err } = io;
  if (o.example !== undefined) throw new UsageError('-example: one input per run (not with several inputs)');
  const names = await inputNames(o, io);
  const items = [];
  for (const name of names) {
    try {
      const input = await readInput({ ...o, input: name }, io, w);
      for (const n of input.notes) err.write(`${name}: ${n}\n`);
      items.push({ name, req: { ...input.request, options: o.options } });
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      items.push({ name, failure: { code: CODES.REQUEST, error: e.message, stderr: [{ text: e.message }] } });
    }
  }
  const good = items.filter((x) => x.req);

  if (o.loops) {
    let worst = 0;
    const docs = [];
    for (const it of items) {
      const ls = it.failure ? it.failure : !it.req.source ? { error: '-loops: needs assembly (not machine code)' } : listLoops(it.req.source, { func: o.func ?? null });
      const code = ls.error ? CODES.REQUEST : 0;
      worst = Math.max(worst, code);
      if (o.json) { docs.push({ file: it.name, ...(ls.error ? { code, error: ls.error, stderr: [{ text: ls.error }] } : { code: 0, loops: ls }) }); continue; }
      if (o.md) {
        out.write(`${it === items[0] ? '' : '\n'}### ${markdown.text(it.name)}\n\n`);
        if (ls.error) err.write(`${it.name}: ${ls.error}\n`);
        out.write(ls.error ? `error: ${markdown.text(ls.error)}\n` : markdown.loops(ls));
        continue;
      }
      out.write(`==> ${it.name} <==\n`);
      if (ls.error) err.write(`${it.name}: ${ls.error}\n`);
      else if (!ls.length) out.write('no loops\n');
      else printLoops(ls, out);
    }
    if (o.json) out.write(JSON.stringify({ code: worst, files: docs }) + '\n');
    return worst;
  }

  const per = (tp) => (o.per ? tp / o.per : undefined);
  const bound = { analyze: (a, r) => w.analyze(a, r), assemble: (t) => w.assemble(t, 'intel') };
  const whatIfs = async (req, archs) => {
    const res = {};
    for (const a of archs) res[w.resolveArch(a)] = whatIfPer(await whatIf(bound.analyze, a, req, o.variants ?? WHAT_IF_VARIANTS, { assemble: bound.assemble }), o.per);
    return res;
  };
  const docs = new Map(); // item -> {doc (as a single run's JSON), status, rows: [{cpu, tp, pe, bn, notes, code}], report, wi}

  if (!o.archs) {
    const rs = await w.analyzeMany(o.arch, good.map((x) => x.req));
    for (const [k, it] of good.entries()) {
      const r = rs[k];
      const ins = r.code === 0 ? w.insights(r) : null;
      const wi = o.whatif && r.code === 0 ? await whatIfs(it.req, [o.arch]) : null;
      const doc = r.code ? r : { ...r, ...(o.per ? { perElement: per(r.tp) } : {}), ...(ins ? { insights: ins } : {}), ...(wi ? { whatIf: wi } : {}) };
      docs.set(it, { doc, status: r.code, r, ins, wi, rows: [rowOf(r, ins, per)] });
    }
  } else {
    const cs = await w.compareMany(good.map((x) => x.req), o.archs.length ? { archs: o.archs } : {});
    // the caveats per CPU: one analysis per file on its first CPU that worked (as a single run does), grouped by that CPU
    const bases = new Array(good.length).fill(null);
    if (!o.tpOnly) {
      const byArch = new Map();
      cs.forEach((c, k) => { const first = c.code ? null : c.results.find((r) => r.code === 0); if (first) (byArch.get(first.arch) ?? byArch.set(first.arch, []).get(first.arch)).push(k); });
      for (const [arch, ks] of byArch) (await w.analyzeMany(arch, ks.map((k) => good[k].req))).forEach((b, j) => { bases[ks[j]] = b; });
    }
    for (const [k, it] of good.entries()) {
      const c = cs[k];
      const status = STATUS(c);
      if (c.code) { docs.set(it, { doc: c, status, rows: [rowOf(c, null, per)] }); continue; }
      const base = bases[k];
      const insOf = (r) => (base?.code === 0 && r.code === 0 ? w.insights({ ...base, arch: r.arch, tp: r.tp, limits: r.limits, bottlenecks: r.bottlenecks }) : null);
      const extra = c.results.map((r) => ({ ins: insOf(r), per: r.code === 0 ? per(r.tp) : undefined }));
      const wi = o.whatif ? await whatIfs(it.req, c.results.filter((r) => r.code === 0).map((r) => r.arch)) : null;
      const results = c.results.map((r, j) => ({ ...r, ...(extra[j].per !== undefined ? { perElement: extra[j].per } : {}), ...(extra[j].ins?.caveats ? { caveats: extra[j].ins.caveats } : {}) }));
      const doc = { ...c, code: status, ...(o.per ? { elementsPerIteration: o.per } : {}), results, ...(wi ? { whatIf: wi } : {}) };
      docs.set(it, { doc, status, c, wi, rows: c.results.map((r, j) => ({ ...rowOf(r, extra[j].ins, per), cpu: r.arch, prototype: r.prototype })) });
    }
  }
  for (const it of items) if (it.failure) docs.set(it, { doc: it.failure, status: it.failure.code, rows: [rowOf(it.failure, null, per)] });
  const worst = Math.max(0, ...items.map((it) => docs.get(it).status));

  if (o.json) {
    out.write(JSON.stringify({ code: worst, files: items.map((it) => ({ file: it.name, ...docs.get(it).doc })) }) + '\n');
    return worst;
  }
  // diagnostics: each file's stderr lines, with its name
  for (const it of items) printStderr(prefixed(docs.get(it).doc, it.name), err, it.name);

  if (o.tpOnly) {
    for (const it of items) {
      const d = docs.get(it);
      for (const row of d.rows) out.write(`${[it.name, ...(o.archs ? [row.cpu ?? '-'] : []), row.code ? 'error' : fmt(row.tp), ...(row.pe !== undefined ? [fmtEl(row.pe)] : [])].join('\t')}\n`);
      for (const [cpu, x] of Object.entries(d.wi ?? {})) {
        if (x.code) { out.write(`${[it.name, ...(o.archs ? [cpu] : []), 'what-if error'].join('\t')}\n`); continue; }
        for (const v of x.variants) out.write(`${[it.name, ...(o.archs ? [cpu] : []), v.id, v.error ? 'error' : fmt(v.tp), ...(v.perElement !== undefined ? [fmtEl(v.perElement)] : [])].join('\t')}\n`);
      }
    }
    return worst;
  }

  if (o.md) return batchMarkdown(w, o, out, items, docs, worst);

  // the table
  const loopOf = (it) => { const d = docs.get(it).doc; return d.code && !d.results ? '-' : d.loop ? (d.loop.name.replace(/^loop /, '') + (d.loop.function ? ` (${d.loop.function})` : '')) : 'as is'; };
  const fw = Math.max(4, ...items.map((it) => it.name.length)), lw = Math.max(4, ...items.map((it) => loopOf(it).length));
  const all = items.flatMap((it) => docs.get(it).rows);
  const cw = o.archs ? Math.max(3, ...all.map((r) => String(r.cpu ?? '-').length)) : 0;
  const bw = Math.max(11, ...all.filter((r) => !r.code).map((r) => r.bn.length));
  out.write(`${'File'.padEnd(fw)}  ${'Loop'.padEnd(lw)}  ${o.archs ? `${'CPU'.padEnd(cw)}  ` : ''}${'TP'.padStart(6)}${o.per ? `  ${'per el'.padStart(6)}` : ''}  ${'Bottlenecks'.padEnd(bw)}  Notes`.trimEnd() + '\n');
  for (const it of items) {
    docs.get(it).rows.forEach((row, j) => {
      const tp = (row.code ? '-' : `${fmt(row.tp)}${row.decodeErrors || row.unsupported ? '*' : ''}`).padStart(6);
      const notes = [...row.notes, row.prototype ? '[prototype]' : null].filter(Boolean).join('; ');
      out.write(`${(j ? '' : it.name).padEnd(fw)}  ${(j ? '' : loopOf(it)).padEnd(lw)}  ${o.archs ? `${String(row.cpu ?? '-').padEnd(cw)}  ` : ''}${tp}${o.per ? `  ${(row.pe !== undefined ? fmtEl(row.pe) : '-').padStart(6)}` : ''}  ${row.bn.padEnd(bw)}${notes ? `  ${notes}` : ''}`.trimEnd() + '\n');
    });
  }
  out.write(`\nTP: cycles per iteration${o.archs ? '' : ` on ${w.resolveArch(o.arch)}`}${o.per ? `; per el: per element (${o.per} per iteration)` : ''}. "-": unknown or failed.\n`
    + 'Loop: what was analyzed ("as is": all of it). *: not a result (code left out).\n');
  if (all.some((r) => r.prototype)) out.write('[prototype]: experimental model of the fork jtl06/uiCA.\n');
  if (o.report) {
    for (const it of items) {
      const d = docs.get(it);
      if (d.r?.code === 0) { out.write(`\n==> ${it.name} <==\n${d.r.text}`); continue; }
      if (d.c) for (const r of d.c.results.filter((x) => x.code === 0)) {
        const full = await w.analyze(r.arch, it.req);
        if (full.code === 0) out.write(`\n==> ${it.name} (${r.arch}) <==\n${full.text}`);
      }
    }
  }
  for (const it of items) {
    const wi = docs.get(it).wi;
    if (!wi) continue;
    out.write(`\n==> ${it.name} <==\n`);
    Object.values(wi).forEach((x, k) => out.write((k ? '\n' : '') + (x.code ? `What if (${x.arch}): ${x.error}\n` : whatIfTable(x))));
  }
  return worst;
}

// -md with several inputs: the files x CPUs table (a CPU column also with one CPU), then with -report each file's
// report, then each file's what-if tables, under a heading per file
async function batchMarkdown(w, o, out, items, docs, worst) {
  const info = new Map(w.archs().map((a) => [a.id, a]));
  const named = (r) => (r.code || r.name ? r : { ...r, name: info.get(r.arch)?.name ?? '', year: info.get(r.arch)?.year ?? null, prototype: !!info.get(r.arch)?.prototype });
  const rows = items.map((it) => {
    const d = docs.get(it).doc;
    if (d.results) return { file: it.name, result: { ...d, results: d.results.map(named) } };
    if (d.code) return { file: it.name, result: d };
    return { file: it.name, result: { ...named(d), caveats: d.insights?.caveats ?? [] } };
  });
  out.write(markdown.cpuTable(rows, { per: o.per }));
  if (o.report) {
    for (const it of items) {
      const d = docs.get(it);
      if (d.r?.code === 0) { out.write('\n' + markdown.report(d.r, { title: it.name, arch: archTitle(w, d.r.arch), per: o.per, insights: d.ins, src: srcOf(it.req, d.r) })); continue; }
      if (d.c) for (const r of d.c.results.filter((x) => x.code === 0)) {
        const full = await w.analyze(r.arch, it.req);
        if (full.code === 0) out.write('\n' + markdown.report(full, { title: `${it.name} (${r.arch})`, arch: archTitle(w, r.arch), per: o.per, insights: w.insights(full), src: srcOf(it.req, full) }));
      }
    }
  }
  for (const it of items) {
    const wi = docs.get(it).wi;
    if (!wi) continue;
    out.write(`\n### ${markdown.text(it.name)}\n`);
    for (const x of Object.values(wi)) out.write('\n' + markdown.whatIfAlignment(x));
  }
  return worst;
}

// A table row of a result (analyze, a compare() row, or a failure): tp, per element, bottlenecks, notes
function rowOf(r, ins, per) {
  if (r.code) return { code: r.code, bn: `error: ${String(r.error).split('\n')[0]}`, notes: [] };
  return {
    code: 0, tp: r.tp, pe: per(r.tp), decodeErrors: r.decodeErrors, unsupported: r.unsupported ?? null,
    bn: r.bottlenecks.join(', ') || (ins?.largest ? `- (nearest ${ins.largest.join(', ')})` : '-'),
    notes: [r.unsupported ? `not a result: ${r.unsupported}` : null, r.decodeErrors ? `${r.decodeErrors} undecodable (left out)` : null, r.noData ? `${r.noData} without data (cost left out)` : null, ...(ins?.caveats ?? []).map((x) => x.text)].filter(Boolean),
  };
}

// a result's stderr lines, those without the input's name (warnings of the whole input) with it in front
function prefixed(doc, name) {
  const lines = doc.stderr ?? [];
  const alone = lines.length === 1 && !lines[0].tag; // a failure's one line (no such file, ...)
  return { stderr: lines.map((l) => ((alone || /^Warning\b/.test(l.text)) && !l.text.startsWith(`${name}:`) ? { ...l, text: `${name}: ${l.text}` } : l)) };
}
