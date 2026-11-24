// The command-line tool: `wuica [options] [FILE | - | HEX]`. Options follow uiCA's and the Rust CLI's (crates/wuica-cli);
// every flag also takes "--" and "=value" spellings, and flag names are case-insensitive.

import fs from 'node:fs';
import { createWuica, normalizeHex, listLoops, whatIf, WHAT_IF_VARIANTS, CODES } from './index.js';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const USAGE = `Usage: wuica [options] [FILE | - | HEX]
       wuica mcp                start the MCP server (stdio)

Predicts the throughput of an x86-64 basic block with uiCA's pipeline model (this is wuica ${VERSION}, a WebAssembly
port of uiCA). One input per run: assembly from FILE (gcc -S, clang -S, objdump -d output, or a hand-written loop),
or from stdin if FILE is - or missing. A HEX argument that is not a file (e.g. 4801d84801c349ffcf75f5) is machine code.

Input:
  -att, -intel           the assembly's syntax (default: detected from the text: %registers mean AT&T)
  -hex                   the input is machine code as hex digits (spaces, commas, 0x prefixes allowed)
  -raw FILE              read the machine code from a binary file that contains only the code (not an object
                         file: for those, objdump -d FILE | wuica)
  -loops                 list the loops of the assembly (index, label, function, lines, instructions, depth, auto)
  -loop L                what is analyzed: auto (default: the deepest loop, among equals the first; clang's
                         "Inner Loop Header" notes count), whole (all the text), a loop's index (0-based, as
                         -loops lists them) or its label (-loop .LBB0_12)
  -func NAME             only the loops of function NAME (with -loop: its index or label among them)

Output:
  -arch NAME             microarchitecture (default: SKL; case-insensitive); "all" prints a table for every one,
                         a comma-separated list (e.g. SKL,ICL,ZEN3) a table for those
  -list                  list the microarchitectures (same as -arch list)
  -TPonly                print only the throughput (with -per: also cycles per element; with -whatif: one
                         "variant cycles" line per variant)
  -per N                 the loop does N elements (bytes, floats, ...) per iteration: also print cycles per element
                         (what-if values too)
  -whatif                the what-if variants (unrolled, N accumulators, front end, fusion) per microarchitecture
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
  -threads N             with several microarchitectures: analyze them on up to N threads (default: the environment
                         variable WUICA_THREADS, else one thread per two microarchitectures; 1 = one after another)
  -data DIR              directory with uarch.json and arch/*.json (default: the tables in the package)
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

The wuica MCP server on stdio (JSON-RPC): tools list_archs, analyze, what_if, compare_archs, assemble.
Configure it in an MCP client as the command "wuica-mcp" (or "npx -y wuica-cli mcp"). Options: --help, --version.
`;

class UsageError extends Error {}

// flag (lower case, without dashes) -> [canonical, takes a value]
const FLAGS = {
  h: ['help'], help: ['help'], v: ['version'], version: ['version'],
  arch: ['arch', 1], list: ['list'], hex: ['hex'], att: ['att'], intel: ['intel'], raw: ['raw', 1], data: ['data', 1],
  loop: ['loop', 1], loops: ['loops'], func: ['func', 1], per: ['per', 1], whatif: ['whatif'], threads: ['threads', 1],
  tponly: ['tpOnly'], json: ['json'], trace: ['trace'], details: ['details'],
  alignmentoffset: ['alignmentOffset', 1], initpolicy: ['initPolicy', 1], simplefrontend: ['simpleFrontEnd'],
  nomicrofusion: ['noMicroFusion'], nomacrofusion: ['noMacroFusion'], miniterations: ['minIterations', 1], mincycles: ['minCycles', 1],
};

export function parseArgs(argv) {
  const o = { arch: 'SKL', options: {}, input: null, syntax: 'auto' };
  const int = (s, name) => {
    if (!/^-?\d+$/.test(s)) throw new UsageError(`-${name}: not an integer: ${s}`);
    return Number(s);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-') || a === '-') {
      if (o.input !== null) throw new UsageError(`more than one input: ${o.input}, ${a} (one input per run)`);
      o.input = a;
      continue;
    }
    const m = /^--?([^=]+)(?:=(.*))?$/.exec(a);
    const f = FLAGS[m[1].toLowerCase()];
    if (!f) throw new UsageError(`unknown option ${a}`);
    const [name, takes] = f;
    let v = m[2];
    if (takes && v === undefined) { if (i + 1 >= argv.length) throw new UsageError(`-${name} needs a value`); v = argv[++i]; }
    if (!takes && v !== undefined) throw new UsageError(`-${name} takes no value`);
    switch (name) {
      case 'att': case 'intel': o.syntax = name; break;
      case 'loop': o.loop = /^\d+$/.test(v) ? Number(v) : v; break;
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
async function readInput(o, io) {
  const notes = [];
  if (o.raw !== undefined) {
    if (o.input !== null) throw new UsageError(`-raw and an input (${o.input}) cannot be combined`);
    const b = readFile(o.raw);
    const fmt = binaryFormat(b);
    if (fmt) throw new UsageError(`${o.raw} is ${fmt}, not bare machine code: disassemble it and pipe the listing (objdump -d ${o.raw} | wuica)`);
    if (looksText(b)) notes.push(`warning: ${o.raw} looks like text, not machine code (without -raw it is read as assembly)`);
    return { request: { hex: b.toString('hex') }, name: o.raw, notes };
  }
  let text, name;
  if (o.input === null || o.input === '-') {
    if (o.input === null && io.stdin.isTTY) throw new UsageError('no input');
    text = await readStdin(io.stdin);
    name = '<stdin>';
  } else if (fs.existsSync(o.input)) {
    text = readFile(o.input).toString('utf8');
    name = o.input;
  } else if (normalizeHex(o.input) !== null) {
    const n = normalizeHex(o.input).length / 2;
    notes.push(`analyzed: ${n} byte${n === 1 ? '' : 's'} of machine code from the argument "${o.input}" (not a file)`);
    return { request: { hex: o.input }, name: 'the argument', notes };
  } else {
    readFile(o.input); // the error
  }
  if (o.hex) return { request: { hex: text }, name, notes };
  return { request: { source: text, syntax: o.syntax, ...(o.loop !== undefined ? { loop: o.loop } : {}), ...(o.func ? { func: o.func } : {}) }, name, notes };
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
    err.write(`analyzed: ${p.name} (lines ${p.line}-${p.endLine}${p.function ? `, in ${p.function}` : ''}${p.address !== undefined ? `, address 0x${p.address.toString(16)}` : ''})${syn ? `, ${syn}` : ''}`
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

// A what-if result with cycles per element (-per N): elementsPerIteration and perElement on it, perElement on each
// variant with a tp.
function whatIfPer(x, per) {
  if (!per || x.code) return x;
  return { ...x, elementsPerIteration: per, perElement: x.tp / per, variants: x.variants.map((v) => (v.tp !== undefined ? { ...v, perElement: v.tp / per } : v)) };
}

const VARIANT_W = 18;
function whatIfTable(x) {
  const per = x.elementsPerIteration;
  const f = per ? (v) => fmtEl(v / per) : fmt;
  const rows = x.variants.map((v) => (v.error ? `  ${v.label.padEnd(VARIANT_W)} ${'-'.padStart(8)}  ${v.error}`
    : `  ${v.label.padEnd(VARIANT_W)} ${`${v.estimate ? '>=' : ''}${f(v.tp)}`.padStart(8)} ${`${v.delta > 0 ? '+' : ''}${f(v.delta)}`.padStart(8)} ${`${fmt(v.speedup ?? 0)}x`.padStart(7)}`));
  return [per ? `What if (${x.arch}), cycles per element (${per} per original iteration; base ${fmtEl(x.tp / per)}):` : `What if (${x.arch}), cycles per original iteration (base ${fmt(x.tp)}):`,
    `  ${'variant'.padEnd(VARIANT_W)} ${'cycles'.padStart(8)} ${'delta'.padStart(8)} ${'speedup'.padStart(7)}`, ...rows,
    ...(x.accumulators ? [`  best number of accumulators: ${x.accumulators.best}${x.accumulators.best === 1 ? ' (as it is)' : ''}`] : [])].join('\n') + '\n';
}
// -TPonly -whatif: one "variant cycles [per element]" line per variant (prefix: the CPU, with several)
function whatIfTerse(x, prefix = '') {
  if (x.code) return `${prefix}what-if error: ${x.error}\n`;
  return x.variants.map((v) => `${prefix}${v.id} ${v.error ? 'error' : `${fmt(v.tp)}${v.perElement !== undefined ? ` ${fmtEl(v.perElement)}` : ''}`}\n`).join('');
}

// argv: the arguments after the program name. io: {stdin, stdout, stderr}. Returns the exit code: the result's
// `code` (0 ok, 1 bad request or usage, 2 assembler error, 3 analysis error).
export async function main(argv, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) {
  const { stdout: out, stderr: err } = io;
  let o = null;
  const fail = (code, msg) => {
    if (o?.json) out.write(JSON.stringify({ code, error: msg, stderr: [{ text: msg }] }) + '\n');
    else err.write(`${msg}\n`);
    return code;
  };
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
    const w = await createWuica({ ...(o.data ? { dataDir: o.data } : {}), ...(o.threads ? { threads: o.threads } : {}) });
    if (o.list) { printList(w, o, out); return 0; }
    // the microarchitectures before the input (stdin is not read for a mistyped name)
    const names = o.archs ?? [o.arch];
    const unknown = names.filter((a) => !w.resolveArch(a));
    if (unknown.length) return fail(CODES.REQUEST, `unknown microarchitecture${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (known: ${w.archs('id').map((a) => a.id).join(', ')})`);
    if (o.options.details && (!o.json || o.archs)) err.write('-details: shown only with -json and one microarchitecture; ignored\n');
    if (o.options.includeTrace && (!o.json || o.archs)) { err.write('-trace: shown only with -json and one microarchitecture; ignored\n'); delete o.options.includeTrace; }
    const input = await readInput(o, io);
    for (const n of input.notes) err.write(`${n}\n`);
    const req = { ...input.request, options: o.options };

    if (o.loops) {
      if (!req.source) return fail(CODES.REQUEST, '-loops: needs assembly (not machine code)');
      const ls = listLoops(req.source, { func: o.func ?? null });
      if (ls.error) return fail(CODES.REQUEST, ls.error);
      if (o.json) { out.write(JSON.stringify({ code: 0, loops: ls }) + '\n'); return 0; }
      if (!ls.length) { out.write('no loops\n'); return 0; }
      const lw = Math.max(5, ...ls.map((l) => l.label.length)), fw = Math.max(8, ...ls.map((l) => String(l.function ?? '-').length));
      out.write(`${'#'.padStart(3)}  ${'label'.padEnd(lw)}  ${'function'.padEnd(fw)}  ${'lines'.padEnd(9)}  instrs  depth\n`);
      for (const l of ls) out.write(`${String(l.index).padStart(3)}  ${l.label.padEnd(lw)}  ${String(l.function ?? '-').padEnd(fw)}  ${`${l.line}-${l.endLine}`.padEnd(9)}  ${String(l.instructions).padStart(6)}  ${String(l.depth).padStart(5)}${l.auto ? '  auto' : ''}\n`);
      out.write('\n-loop N (0-based) or -loop LABEL analyzes one; "auto" is what runs without -loop.\n');
      return 0;
    }
    const per = (tp) => (o.per ? tp / o.per : undefined);
    const bound = { analyze: (a, r) => w.analyze(a, r), assemble: (t) => w.assemble(t, 'intel') };
    const whatIfs = async (archs) => {
      const res = {};
      for (const a of archs) res[w.resolveArch(a)] = whatIfPer(await whatIf(bound.analyze, a, req, WHAT_IF_VARIANTS, { assemble: bound.assemble }), o.per);
      return res;
    };

    if (o.archs) {
      const c = await w.compare({ ...req, ...(o.archs.length ? { archs: o.archs } : {}) });
      const status = c.code || Math.max(0, ...(c.results ?? []).map((r) => r.code));
      if (c.code) {
        if (o.json) { out.write(JSON.stringify(c) + '\n'); return status; }
        printStderr(c, err, input.name);
        return status;
      }
      // the caveats per CPU: one analysis for the instructions, each CPU's configuration (the split-load cost)
      const first = c.results.find((r) => r.code === 0);
      const base = !o.tpOnly && first ? await w.analyze(first.arch, req) : null;
      const insOf = (r) => (base?.code === 0 && r.code === 0 ? w.insights({ ...base, arch: r.arch, tp: r.tp, limits: r.limits, bottlenecks: r.bottlenecks }) : null);
      const extra = c.results.map((r) => ({ ins: insOf(r), per: r.code === 0 ? per(r.tp) : undefined }));
      const wi = o.whatif ? await whatIfs(c.results.filter((r) => r.code === 0).map((r) => r.arch)) : null;
      if (o.json) {
        const results = c.results.map((r, k) => ({ ...r, ...(extra[k].per !== undefined ? { perElement: extra[k].per } : {}), ...(extra[k].ins?.caveats ? { caveats: extra[k].ins.caveats } : {}) }));
        out.write(JSON.stringify({ ...c, code: status, results, ...(wi ? { whatIf: wi } : {}) }) + '\n');
        return status;
      }
      printStderr(c, err, input.name);
      printAnalyzed(c, err, o);
      const kw = Math.max(4, ...c.results.map((r) => r.arch.length));
      const nw = Math.max(5, ...c.results.map((r) => r.name.length));
      const bns = c.results.map((r, k) => (r.code ? `error: ${r.error.split('\n')[0]}` : r.bottlenecks.join(', ') || (extra[k].ins?.largest ? `- (nearest ${extra[k].ins.largest.join(', ')})` : '-')));
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
        const tp = (r.code ? '-' : `${fmt(r.tp)}${r.decodeErrors ? '*' : ''}`).padStart(6);
        const notes = [r.decodeErrors ? `${r.decodeErrors} undecodable (left out)` : null, ...(ins?.caveats ?? []).map((x) => x.text), r.prototype ? '[prototype]' : null].filter(Boolean).join('; ');
        out.write(`${r.arch.padEnd(kw)}  ${r.name.padEnd(nw)}  ${year}  ${tp}${o.per ? `  ${(pe !== undefined ? fmtEl(pe) : '-').padStart(6)}` : ''}  ${bns[k].padEnd(bw)}${notes ? `  ${notes}` : ''}`.trimEnd() + '\n');
      });
      if (!o.tpOnly) {
        out.write(`\nTP: cycles per iteration${o.per ? `; per el: per element (${o.per} per iteration)` : ''}. "-": unknown. *: some instructions could not be decoded for that CPU and are left out.\n`);
        if (c.results.some((r) => r.prototype)) out.write('[prototype]: experimental model of the fork jtl06/uiCA.\n');
        if (base?.code === 0 && !o.per) { const s = inductionSteps(base); if (s.length) err.write(stepLine(s)); }
        for (const x of Object.values(wi ?? {})) out.write('\n' + (x.code ? `What if (${x.arch}): ${x.error}\n` : whatIfTable(x)));
      }
      return status;
    }

    const r = await w.analyze(o.arch, req);
    const ins = r.code === 0 ? w.insights(r) : null;
    const wi = o.whatif && r.code === 0 ? await whatIfs([o.arch]) : null;
    if (o.json) {
      out.write(JSON.stringify(r.code ? r : { ...r, ...(o.per ? { perElement: per(r.tp) } : {}), ...(ins ? { insights: ins } : {}), ...(wi ? { whatIf: wi } : {}) }) + '\n');
      return r.code;
    }
    printStderr(r, err, input.name);
    if (r.code) return r.code;
    printAnalyzed(r, err, o);
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
