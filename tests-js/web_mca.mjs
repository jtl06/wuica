// Tests of the llvm-mca module (mca/dist/wuica_mca.wasm, mca/wuica_mca.cpp) and of mca.js's helpers, in Node: the
// module runs the examples on every CPU of MCPU, reports errors, keeps no state between runs (the options are
// reset), and the SHA-256 showcase runs within the memory limit. With --native FILE (a JSON of
// {name, cpu, iterations, text, out} records from a native llvm-mca-22), the outputs must be identical.
//   node tests-js/web_mca.mjs [--native FILE]
import fs from 'node:fs';
import { MCPU, parseMca, mcaIterations } from '../web/js/mca.js';
import { EXAMPLES, CLASSIC_EXAMPLES } from '../web/js/examples.js';
import { SHA256_BLOCK_ASM } from '../web/js/showcase-asm.js';

const path = new URL('../mca/dist/wuica_mca.wasm', import.meta.url);
if (!fs.existsSync(path)) { console.log('mca/dist/wuica_mca.wasm is missing: skipped'); process.exit(0); }

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }

const module = await WebAssembly.compile(fs.readFileSync(path));
const enc = new TextEncoder(), dec = new TextDecoder();
let x = null;
function fresh() { x = new WebAssembly.Instance(module, {}).exports; x._initialize?.(); }
fresh();
function run(args, text) {
  const a = enc.encode(args.map((s) => s + '\0').join('')), t = enc.encode(text);
  const pa = x.malloc(Math.max(1, a.length)), pt = x.malloc(Math.max(1, t.length));
  new Uint8Array(x.memory.buffer, pa, a.length).set(a);
  new Uint8Array(x.memory.buffer, pt, t.length).set(t);
  const t0 = performance.now();
  const code = x.wuica_mca_run(pa, a.length, pt, t.length);
  const ms = performance.now() - t0;
  const read = (w) => dec.decode(new Uint8Array(x.memory.buffer, x.wuica_mca_output(w), x.wuica_mca_output_len(w)));
  const out = read(0), err = read(1);
  x.free(pa); x.free(pt);
  return { code, out, err, ms };
}
const mca = (cpu, text, iterations = 100, extra = []) => run(['-mtriple=x86_64-unknown-linux-gnu', `-mcpu=${cpu}`, `-iterations=${iterations}`, ...extra, '-'], '.intel_syntax noprefix\n' + text);

// the dependency chain: two dependent adds, 2 cycles per iteration on every Intel model
{
  const r = mca('skylake', 'loop:\n  add rax, 1\n  add rax, 1\n  dec r15\n  jnz loop\n');
  const m = parseMca(r.out);
  check(r.code === 0 && m.iterations === 100 && m.instructions === 400 && Math.abs(m.perIteration - 2) < 0.1, 'skylake: two dependent adds, about 2 cycles per iteration', JSON.stringify(m) + r.err);
  check(/^Iterations:\s+100$/m.test(r.out) && /Resource pressure per iteration:/.test(r.out) && /Instruction Info:/.test(r.out), 'the default views: summary, instruction info, resource pressure');
}
// every CPU, every example
for (const [arch, cpu] of Object.entries(MCPU)) {
  let ok = 0, all = 0;
  for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES]) {
    if (!ex.text?.intel) continue;
    all++;
    const r = mca(cpu, ex.text.intel);
    const m = parseMca(r.out);
    if (r.code === 0 && m.perIteration > 0) ok++; else console.log(`  ${arch} ${ex.id}: ${r.code} ${r.err.slice(0, 200)}`);
  }
  check(ok === all && all > 5, `${arch} (${cpu}): every example runs`, `${ok}/${all}`);
}
// options are reset between runs; timeline and bottleneck analysis work
{
  const a = mca('haswell', 'add rax, rbx\n', 10, ['-timeline']);
  const b = mca('haswell', 'add rax, rbx\n', 10);
  check(a.code === 0 && /Timeline view:/.test(a.out) && b.code === 0 && !/Timeline view:/.test(b.out) && /^Iterations:\s+10$/m.test(b.out), 'an option does not stay on for the next run');
  const c = mca('znver3', 'imul rax, rbx\nadd rax, rcx\n', 50, ['-bottleneck-analysis']);
  check(c.code === 0 && /Cycles with backend pressure increase|No resource or data dependency bottlenecks discovered/.test(c.out), 'bottleneck analysis', c.out.slice(0, 300) + c.err);
}
// errors: bad assembly and an unknown CPU give a message and exit code 1, and the module keeps working
{
  const bad = mca('skylake', 'add rax, \n');
  check(bad.code !== 0 && /error/i.test(bad.err), 'bad assembly: an error on stderr', JSON.stringify(bad).slice(0, 300));
  const cpu = mca('pentium9000', 'add rax, rbx\n');
  check(/not a recognized processor|error/i.test(cpu.err + cpu.out), 'an unknown CPU is reported', JSON.stringify(cpu).slice(0, 300));
  const after = mca('skylake', 'add rax, rbx\n');
  check(after.code === 0 && parseMca(after.out).perIteration > 0, 'the module works after errors');
}
// the showcase: 2,949 instructions within the memory limit
{
  const n = SHA256_BLOCK_ASM.split('\n').filter((l) => /^\s+\S/.test(l)).length;
  const r = mca('skylake', SHA256_BLOCK_ASM, mcaIterations(n));
  const m = parseMca(r.out);
  check(r.code === 0 && m.instructions === 2949 * m.iterations && m.perIteration > 400, 'SHA-256 on skylake', JSON.stringify(m) + r.err.slice(0, 200));
  console.log(`  SHA-256: ${m.perIteration?.toFixed(2)} cycles/iteration over ${m.iterations} iterations, ${r.ms.toFixed(0)} ms`);
}
check(mcaIterations(4) === 1000 && mcaIterations(2949) === 101 && mcaIterations(100000) === 100, 'iterations: 100 to 1000, about 300,000 instructions');

// identical to a native llvm-mca-22
const ni = process.argv.indexOf('--native');
if (ni > 0) {
  const records = JSON.parse(fs.readFileSync(process.argv[ni + 1], 'utf8'));
  let same = 0;
  for (const rec of records) {
    const r = mca(rec.cpu, rec.text, rec.iterations);
    if (r.out === rec.out) same++; else console.log(`  differs: ${rec.name} ${rec.cpu}`);
  }
  check(same === records.length, 'byte-identical to native llvm-mca 22.1.2', `${same}/${records.length}`);
}

console.log(`${count} llvm-mca checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
