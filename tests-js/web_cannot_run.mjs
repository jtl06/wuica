// Code a CPU cannot run (web/js/caveats.js cannotRun; the dogfood report's B1): positions its decoder skipped, or
// instructions its model has no data for, give the reference's number, which is not a result for that CPU. One rule for
// the page's table of CPUs (compare.js compareRows: never the fastest, no bar, not the bars' scale), its A–B table per
// CPU (ab-cpus.js abCpuRows: no verdict), the Markdown (markdown.js: struck through, the reason; A–B: not comparable) and
// the package's text (block-diff.js). With the real assembler and analyzer: AVX-512 code (tests-js/fixtures/dogfood/
// avx512.s, clang -march=skylake-avx512) on SKL (undecodable) and ZEN3 (decoded, no data), FMA code on SNB; the engine's
// numbers stay as they are.
//
//   node tests-js/web_cannot_run.mjs
import fs from 'node:fs';
import { cannotRun, LACKS } from '../web/js/caveats.js';
import { summarize, compareRows } from '../web/js/compare.js';
import { abCpuRows } from '../web/js/ab-cpus.js';
import { cpuTable, report, compare } from '../web/js/markdown.js';
import { diffResult, diffText } from '../web/js/block-diff.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { WasmAssembler } from '../web/js/assembler.js';
import { withRegions } from '../web/js/asm-regions.js';
import { analyzedLines, analyzedText } from '../web/js/branch-label.js';
import { CLASSIC_EXAMPLES } from '../web/js/examples.js';
import { ARCH_ORDER } from '../web/js/archs.js';
import { tableBytes } from './tables.mjs';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + String(detail).slice(0, 1500) : ''}`); } }
const j = JSON.stringify;
const root = new URL('../', import.meta.url);

// ---- the rule, without the analyzer -----------------------------------------------------------------------------------
{
  check(cannotRun({ tp: 1, decodeErrors: 0, rows: [{ kind: 'instr', label: 'add rax, 1' }] }) === null, 'a block it can run: null');
  check(cannotRun({ error: 'x' }) === null && cannotRun(null) === null, 'a failure: null');
  const x = cannotRun({ tp: 3, decodeErrors: 0, rows: [{ kind: 'instr', notes: 'X', label: 'vaddps zmm0, zmm1, zmm2' }, { kind: 'instr', label: 'dec r15' }] }, { arch: 'ZEN3' });
  check(x?.reason === 'needs AVX-512' && x.unsupported === 1 && x.decodeErrors === 0, 'ZEN3: an instruction without data, named from its text', j(x));
  const d = cannotRun({ tp: 3, decodeErrors: 4, rows: [] }, { arch: 'SKL' });
  check(d?.reason === '4 undecodable' && d.needs.length === 0, 'undecodable positions without the code: counted', j(d));
  const named = cannotRun({ tp: 3, decodeErrors: 4, rows: [] }, { arch: 'SKL', code: 'vaddps (%rdi), %zmm0, %zmm0' });
  check(named?.reason === 'needs AVX-512', 'undecodable positions, named from the analyzed text (AT&T)', j(named));
  // only an extension the CPU lacks is named: SKL has FMA, so FMA code that SKL cannot decode says the count
  check(cannotRun({ decodeErrors: 2, rows: [] }, { arch: 'SKL', code: 'vfmadd231ps ymm0, ymm1, ymm2' })?.reason === '2 undecodable', 'an extension the CPU has is not named');
  check(cannotRun({ decodeErrors: 2, rows: [] }, { arch: 'IVB', code: 'vfmadd231ps ymm0, ymm1, ymm2\nrorx rax, rbx, 3' })?.reason === 'needs FMA, BMI2', 'IVB: FMA and BMI2');
  check(cannotRun({ decodeErrors: 0, xLabels: ['vmovups zmm0, zmmword ptr [rsi]', 'vmovups zmm1, zmmword ptr [rsi+0x40]'] }, { arch: 'ZEN3' })?.reason === 'needs AVX-512', 'a summary (xLabels) as a response');
  check(ARCH_ORDER.every((k) => Array.isArray(LACKS[k])), 'every CPU of the menu has its list of missing extensions', ARCH_ORDER.filter((k) => !LACKS[k]).join());
}

// ---- the table of CPUs: never the fastest, no bar, not the scale --------------------------------------------------------
{
  const items = ['SKL', 'ICL', 'ZEN3', 'ADL-P'].map((key) => ({ key, title: key }));
  const res = new Map([
    ['SKL', { tp: 38, bottlenecks: [], decodeErrors: 12, xLabels: [] }],
    ['ICL', { tp: 4, bottlenecks: ['Ports'], decodeErrors: 0, xLabels: [] }],
    ['ZEN3', { tp: 3, bottlenecks: [], decodeErrors: 0, xLabels: ['vaddps zmm0, zmm0, zmmword ptr [rdi+rcx*4]'] }],
    ['ADL-P', { tp: 11725, bottlenecks: [], decodeErrors: 12, xLabels: [] }],
  ]);
  const rows = compareRows(items, res, { code: 'vaddps (%rdi,%rcx,4), %zmm0, %zmm0' });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  check(by.ICL.fastest && !by.ZEN3.fastest && !by.SKL.fastest && !by['ADL-P'].fastest, 'the fastest: ICL, not ZEN3 (3.00, no AVX-512 data)', j(rows.map((r) => [r.key, r.fastest])));
  check(by.ICL.bar === 1 && by['ADL-P'].bar === 0 && by.SKL.bar === 0 && by.ZEN3.bar === 0, 'the bars: scaled to the valid rows; none for the others (ADL-P\'s 11725 does not squash them)', j(rows.map((r) => [r.key, r.bar])));
  check(by.ZEN3.invalid?.reason === 'needs AVX-512' && by.SKL.invalid?.reason === 'needs AVX-512' && by.ICL.invalid === null, 'ZEN3 is marked as the Intel rows are', j(rows.map((r) => [r.key, r.invalid?.reason ?? null])));
  check(compareRows(items, res, { sort: 'tp' }).map((r) => r.key).join() === 'ICL,ZEN3,SKL,ADL-P', 'sorted by cycles: the rows with a result first', compareRows(items, res, { sort: 'tp' }).map((r) => r.key).join());
  const all = compareRows(items.filter((i) => i.key !== 'ICL'), res);
  check(all.every((r) => !r.fastest && r.bar === 0), 'every row unable to run the code: none is the fastest');
  // A–B per CPU: a side that cannot run on a CPU: no verdict on that row
  const ab = abCpuRows(items, new Map([...res].flatMap(([k, v]) => [[`a:${k}`, v], [`b:${k}`, { tp: v.tp / 2, bottlenecks: [], decodeErrors: 0, xLabels: [] }]])), { codeA: 'vaddps %zmm1, %zmm0, %zmm0' });
  const abBy = Object.fromEntries(ab.map((r) => [r.key, r]));
  check(abBy.SKL.state === 'invalid' && abBy.SKL.verdict === null && abBy.SKL.invalidA?.reason === 'needs AVX-512' && abBy.ICL.verdict === 'better', 'A–B per CPU: no verdict where A cannot run', j(ab.map((r) => [r.key, r.state, r.verdict])));
  // the Markdown table: struck through, why
  const md = cpuTable([{ arch: 'SKL', name: 'Skylake', year: 2015, tp: 38, bottlenecks: [], decodeErrors: 12, unsupported: 'needs AVX-512' }, { arch: 'ICL', name: 'Ice Lake', year: 2019, tp: 4, bottlenecks: ['Ports'], decodeErrors: 0 }]);
  check(/\| SKL .*~~38\.00~~\*.*not a result: needs AVX-512; 12 undecodable \(left out\)/.test(md) && /\| ICL .*\b4\.00 /.test(md) && /~~TP~~: not a result/.test(md), 'Markdown: the table strikes the number, says why', md);
}

// ---- with the assembler and the analyzer ---------------------------------------------------------------------------------
const asmPath = new URL('assembler/dist/wuica_asm.wasm', root);
const wasmPath = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (!fs.existsSync(asmPath) || !fs.existsSync(wasmPath)) {
  console.log('(the assembler or the analyzer is missing: only the cases without them)');
} else {
  const A = withRegions(await WasmAssembler.create(fs.readFileSync(asmPath)));
  const e = await WasmEngine.create(fs.readFileSync(wasmPath));
  const uarch = JSON.parse(fs.readFileSync(new URL('data/uarch.json', root)));
  await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
  const loaded = new Set();
  const run = async (hex, arch) => { const t = uarch.configs[arch].name; if (!loaded.has(t)) { await e.loadArch(t, tableBytes(t)); loaded.add(t); } return e.analyze(makeRequest(hex, arch)); };
  const text = fs.readFileSync(new URL('tests-js/fixtures/dogfood/avx512.s', root), 'utf8');
  const asm = await A.assemble(text, 'att', { loop: 'auto' });
  const code = analyzedText(analyzedLines(text, asm));
  const hex = Buffer.from(asm.bytes).toString('hex');
  check(asm.ok && /zmm/.test(code) && !/ymm/.test(code), 'avx512.s: its zmm loop is the one analyzed', j([asm.ok, code.slice(0, 200)]));
  const out = {};
  for (const arch of ['SKL', 'ZEN3', 'ICL', 'ADL-P']) out[arch] = await run(hex, arch);
  const skl = cannotRun(out.SKL, { arch: 'SKL', code }), zen = cannotRun(out.ZEN3, { arch: 'ZEN3', code }), icl = cannotRun(out.ICL, { arch: 'ICL', code });
  // the numbers the report saw, unchanged
  check(out.SKL.tp === 38 && out.ZEN3.tp === 3 && out.ICL.tp === 4 && out['ADL-P'].tp === 11725, 'the engine\'s numbers are the reference\'s (38, 3, 4, 11725)', j(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.tp]))));
  check(skl?.reason === 'needs AVX-512' && skl.decodeErrors === 12, 'SKL: needs AVX-512 (12 undecodable)', j(skl));
  check(zen?.reason === 'needs AVX-512' && zen.unsupported === 12 && zen.decodeErrors === 0, 'ZEN3: needs AVX-512 (12 instructions without data), as the Intel rows', j(zen));
  check(icl === null, 'ICL: runs it', j(icl));
  const sum = summarize(out.ZEN3);
  check(cannotRun(sum, { arch: 'ZEN3' })?.reason === 'needs AVX-512', 'the summaries of the views keep what names it');
  // the report and the A–B Markdown
  const md = report(out.ZEN3, { arch: 'ZEN3' });
  check(/^\*\*~~3\.00~~ cycles\/iteration\*\* \(not a result: needs AVX-512\)/m.test(md), 'Markdown report: the number struck, the reason', md.split('\n')[0]);
  const cmd = compare(out.SKL, out.ICL, { archA: 'SKL', archB: 'ICL', invalidA: skl, invalidB: null });
  check(/^\*\*A ~~38\.00~~ · B 4\.00 cycles per iteration\*\* \(not comparable: A needs AVX-512 on SKL\)/.test(cmd), 'Markdown A–B: not comparable', cmd.split('\n')[0]);
  // the package's diff text (block-diff.js): no verdict
  const dt = diffText(diffResult({ ...out.ZEN3, unsupported: zen.reason }, out.ZEN3));
  check(/not comparable: A needs AVX-512/.test(dt) && !/speedup/.test(dt.split('\n')[0]), 'diff text: not comparable', dt.split('\n')[0]);
  // FMA on SNB (the classic GEMM and saxpy): named
  for (const id of ['gemm', 'saxpy']) {
    const ex = CLASSIC_EXAMPLES.find((x) => x.id === id);
    const r = await run(ex.hex, 'SNB');
    const c = cannotRun(r, { arch: 'SNB', code: ex.text.intel });
    check(r.decodeErrors > 0 && /^needs (?:AVX2, )?FMA|^needs FMA/.test(c?.reason ?? '') && c.reason.includes('FMA'), `${id} on SNB: needs FMA`, j([r.decodeErrors, c]));
    check(cannotRun(await run(ex.hex, 'HSW'), { arch: 'HSW', code: ex.text.intel }) === null, `${id} on HSW: runs it`);
  }
}

console.log(`${count} cannot-run checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
