// The command-line tool: `wuica [options] [FILE | -]`. Options follow uiCA's and the Rust CLI's (crates/wuica-cli).

import fs from 'node:fs';
import { createWuica, normalizeHex } from './index.js';

export const USAGE = `Usage: wuica [options] [FILE | - | HEX]
       wuica mcp                start the MCP server (stdio)

Predicts the throughput of an x86-64 basic block with uiCA's pipeline model (this is wuica, a WebAssembly port of
uiCA). The block is read as assembly (Intel syntax by default) from FILE, or from stdin if FILE is - or missing.
A HEX argument that is not a file (e.g. 4801d84801c349ffcf75f5) is taken as machine code.

Input:
  -hex                   the input is machine code as hex digits (spaces, commas, 0x prefixes allowed)
  -raw FILE              read the machine code from a binary file that contains only the code
  -att                   the assembly is in AT&T syntax (default: Intel, noprefix)
  -loop L                what of the assembly is analyzed: auto (default: the innermost loop of a whole function,
                         gcc -S or objdump -d output, else the text as it is), whole, or the index of a loop

Output:
  -arch NAME             microarchitecture (default: SKL); "all" prints a throughput table for every one, and a
                         comma-separated list (e.g. SKL,ICL,ZEN3) a table for those
  -list                  list the microarchitectures (same as -arch list)
  -TPonly                print only the throughput
  -json                  print the response as JSON
  -trace                 with -json: include the cycle-by-cycle events (large)
  -details               with -json: include the details (allowed ports, latencies, port set, issue slots)

Simulation (as in uiCA):
  -alignmentOffset N     alignment offset relative to a 64-byte cache line (default: 0)
  -initPolicy P          initial register state: diff (default), same, stack
  -simpleFrontEnd        simulate a front end that is only limited by the issue width
  -noMicroFusion, -noMacroFusion
  -minIterations N       simulate at least N iterations (default: 10)
  -minCycles N           simulate at least N cycles (default: 500)

Other:
  -threads N             with several microarchitectures: analyze them on up to N threads, one per microarchitecture
                         (default: the environment variable WUICA_THREADS, else one thread per two microarchitectures,
                         at most the number of CPU threads; 1 = one after another)
  -data DIR              directory with uarch.json and arch/*.json (default: the tables in the package)
  -h, --help             this text

Exit status: 0 ok, 1 bad request or usage, 2 assembler error, 3 the analysis failed for this input.

Throughput is in cycles per iteration: a block that ends with a branch is analyzed as a loop, otherwise as if it
were unrolled (repeated back to back). Assumes all data in L1 and no branch mispredictions. ZEN3, ADL-P and ICX are
prototype models (from the fork jtl06/uiCA), less validated than the Intel models of uiCA.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { arch: 'SKL', options: {}, hex: false, att: false, tpOnly: false, json: false, list: false, input: null, raw: null, data: null, threads: undefined, loop: undefined };
  const value = (i, name) => {
    if (i >= argv.length) throw new UsageError(`${name} needs a value`);
    return argv[i];
  };
  const int = (s, name) => {
    if (!/^-?\d+$/.test(s)) throw new UsageError(`${name}: not an integer: ${s}`);
    return Number(s);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '-help': case '--help': o.help = true; break;
      case '-arch': o.arch = value(++i, a); break;
      case '-list': o.list = true; break;
      case '-hex': o.hex = true; break;
      case '-att': o.att = true; break;
      case '-loop': { const v = value(++i, a); o.loop = /^\d+$/.test(v) ? Number(v) : v; if (!['auto', 'whole'].includes(o.loop) && typeof o.loop !== 'number') throw new UsageError(`${a}: auto, whole or a number: ${v}`); break; }
      case '-raw': o.raw = value(++i, a); break;
      case '-data': o.data = value(++i, a); break;
      case '-threads': o.threads = int(value(++i, a), a); if (o.threads < 1) throw new UsageError(`${a}: at least 1`); break;
      case '-TPonly': o.tpOnly = true; break;
      case '-json': o.json = true; break;
      case '-trace': o.options.includeTrace = true; break;
      case '-details': o.options.details = true; break;
      case '-alignmentOffset': o.options.alignmentOffset = int(value(++i, a), a); break;
      case '-initPolicy': o.options.initPolicy = value(++i, a); break;
      case '-simpleFrontEnd': o.options.simpleFrontEnd = true; break;
      case '-noMicroFusion': o.options.noMicroFusion = true; break;
      case '-noMacroFusion': o.options.noMacroFusion = true; break;
      case '-minIterations': o.options.minIterations = int(value(++i, a), a); break;
      case '-minCycles': o.options.minCycles = int(value(++i, a), a); break;
      default:
        if (a.startsWith('-') && a !== '-') throw new UsageError(`unknown option ${a}`);
        if (o.input !== null) throw new UsageError(`more than one input: ${o.input}, ${a}`);
        o.input = a;
    }
  }
  o.arch = o.arch.trim();
  if (o.arch === 'list') o.list = true;
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

// Returns {hex} or {source, syntax}.
async function readInput(o, io) {
  if (o.raw !== null) {
    if (o.input !== null) throw new UsageError(`-raw and an input (${o.input}) cannot be combined`);
    return { hex: fs.readFileSync(o.raw).toString('hex') };
  }
  let text;
  if (o.input === null || o.input === '-') {
    if (o.input === null && io.stdin.isTTY) throw new UsageError('no input');
    text = await readStdin(io.stdin);
  } else if (fs.existsSync(o.input)) {
    text = fs.readFileSync(o.input, 'utf8');
  } else if (normalizeHex(o.input) !== null) {
    return { hex: o.input };
  } else {
    throw new UsageError(`${o.input}: no such file`);
  }
  return o.hex ? { hex: text } : { source: text, syntax: o.att ? 'att' : 'intel', ...(o.loop !== undefined ? { loop: o.loop } : {}) };
}

const fmt = (tp) => tp.toFixed(2);

function printList(w, o, out) {
  const archs = w.archs();
  if (o.json) { out.write(JSON.stringify(archs, null, 1) + '\n'); return; }
  const width = Math.max(...archs.map((a) => a.id.length));
  for (const a of archs) {
    out.write(`${a.id.padEnd(width)}  ${a.name}${a.year ? ` (${a.year})` : ''}${a.prototype ? '  [prototype]' : ''}\n`);
  }
}

function printStderr(r, err, o = null) {
  for (const l of r.stderr ?? []) err.write(l.text + '\n');
  // what of the text was analyzed, if not all of it
  const p = r.loop;
  if (p && p.line) err.write(`analyzed: ${p.name} (lines ${p.line}-${p.endLine}${p.address !== undefined ? `, address 0x${p.address.toString(16)}` : ''}); -loop whole for the whole text\n`);
  if (p && p.alignmentOffset !== undefined && o?.options.alignmentOffset === undefined) err.write(`alignment offset ${p.alignmentOffset} (from the addresses)\n`);
}

// argv: the arguments after the program name. io: {stdin, stdout, stderr}. Returns the exit code: the result's
// `code` (0 ok, 1 bad request or usage, 2 assembler error, 3 analysis error).
export async function main(argv, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) {
  const { stdout: out, stderr: err } = io;
  let o;
  try {
    o = parseArgs(argv);
    if (o.help) { out.write(USAGE + '\n'); return 0; }
    const w = await createWuica({ ...(o.data ? { dataDir: o.data } : {}), ...(o.threads ? { threads: o.threads } : {}) });
    if (o.list) { printList(w, o, out); return 0; }
    const input = await readInput(o, io);
    if (o.options.details && (!o.json || o.archs)) err.write('-details: shown only with -json and one microarchitecture; ignored\n');

    if (o.archs) {
      const c = await w.compare({ ...input, ...(o.archs.length ? { archs: o.archs } : {}), options: o.options });
      if (o.json) { out.write(JSON.stringify(c) + '\n'); return c.code || Math.max(0, ...(c.results ?? []).map((r) => r.code)); }
      printStderr(c, err, o);
      if (c.code) return c.code;
      const kw = Math.max(4, ...c.results.map((r) => r.arch.length));
      const nw = Math.max(5, ...c.results.map((r) => r.name.length));
      if (!o.tpOnly) out.write(`${'Arch'.padEnd(kw)}  ${'Model'.padEnd(nw)}  Year  ${'TP'.padStart(6)}  Bottlenecks\n`);
      for (const r of c.results) {
        if (o.tpOnly) { out.write(`${r.arch.padEnd(kw)}  ${r.code ? 'error' : fmt(r.tp)}\n`); continue; }
        const year = String(r.year ?? '').padEnd(4);
        const rest = r.code ? `error: ${r.error.split('\n')[0]}` : `${r.bottlenecks.join(', ') || '-'}${r.prototype ? '  [prototype]' : ''}`;
        out.write(`${r.arch.padEnd(kw)}  ${r.name.padEnd(nw)}  ${year}  ${(r.code ? '-' : fmt(r.tp)).padStart(6)}  ${rest}\n`);
      }
      if (!o.tpOnly) out.write('\nTP: cycles per iteration. [prototype]: experimental model of the fork jtl06/uiCA.\n');
      return Math.max(0, ...c.results.map((r) => r.code));
    }

    const r = await w.analyze(o.arch, { ...input, options: o.options });
    if (o.json) { out.write(JSON.stringify(r) + '\n'); return r.code; }
    printStderr(r, err, o);
    if (r.code) return r.code;
    out.write(o.tpOnly ? fmt(r.tp) + '\n' : r.text);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err.write(e.message === 'no input' ? `${USAGE}\n` : `${e.message}\nRun "wuica -h" for the options.\n`);
      return 1;
    }
    err.write(`wuica: ${e?.message ?? e}\n`);
    return 1;
  }
}
