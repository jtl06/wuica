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
import { cannotRun, noData, extensionOf, LACKS } from '../web/js/caveats.js';
import { summarize, compareRows } from '../web/js/compare.js';
import { abCpuRows } from '../web/js/ab-cpus.js';
import { cpuTable, report, compare, whatIf as whatIfMd } from '../web/js/markdown.js';
import { whatIf, whatIfText } from '../web/js/whatif-core.js';
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
  // an instruction without data is a cannot-run case only when it is of an extension the CPU lacks (by its encoding:
  // EVEX is AVX-512); otherwise a gap in the tables (noData), and the result stands
  const zmm = { kind: 'instr', notes: 'X', label: 'vaddps zmm0, zmm1, zmm2', opcode: '62F1744858C2' };
  const x = cannotRun({ tp: 3, decodeErrors: 0, rows: [zmm, { kind: 'instr', label: 'dec r15', opcode: '49FFCF' }] }, { arch: 'ZEN3' });
  check(x?.reason === 'needs AVX-512' && x.unsupported === 1 && x.decodeErrors === 0, 'ZEN3: an AVX-512 instruction without data: cannot run, named from its encoding', j(x));
  const fld = { kind: 'instr', notes: 'X', label: 'fld tbyte ptr [rdi]', opcode: 'DB2F' };
  check(cannotRun({ tp: 3, decodeErrors: 0, rows: [fld] }, { arch: 'SKL' }) === null && noData({ tp: 3, decodeErrors: 0, rows: [fld] }, { arch: 'SKL' }) === 1, 'x87 tbyte load without data: a gap (a note), not "cannot run"');
  check(noData({ tp: 3, decodeErrors: 0, rows: [zmm] }, { arch: 'ZEN3' }) === 0, 'noData: 0 for a block it cannot run (the reason says it)');
  const d = cannotRun({ tp: 3, decodeErrors: 4, rows: [] }, { arch: 'SKL' });
  check(d?.reason === '4 undecodable' && d.needs.length === 0, 'undecodable positions without the code: counted', j(d));
  const named = cannotRun({ tp: 3, decodeErrors: 4, rows: [] }, { arch: 'SKL', code: 'vaddps (%rdi), %zmm0, %zmm0' });
  check(named?.reason === 'needs AVX-512', 'undecodable positions, named from the analyzed text (AT&T)', j(named));
  // only an extension the CPU lacks is named: SKL has FMA, so FMA code that SKL cannot decode says the count
  check(cannotRun({ decodeErrors: 2, rows: [] }, { arch: 'SKL', code: 'vfmadd231ps ymm0, ymm1, ymm2' })?.reason === '2 undecodable', 'an extension the CPU has is not named');
  check(cannotRun({ decodeErrors: 2, rows: [] }, { arch: 'IVB', code: 'vfmadd231ps ymm0, ymm1, ymm2\nrorx rax, rbx, 3' })?.reason === 'needs FMA, BMI2', 'IVB: FMA and BMI2');
  // the review's cases: AVX-VNNI is not AVX2; a comment names nothing; one skipped instruction is one count; X rows of
  // other instructions (the decoder's junk after a skipped position) name nothing
  check(cannotRun({ decodeErrors: 1, rows: [] }, { arch: 'SNB', code: '{vex} vpdpbusd ymm0, ymm1, ymm2' })?.reason === 'needs AVX-VNNI', '{vex} vpdpbusd ymm on SNB: needs AVX-VNNI (not AVX2)');
  const cm = cannotRun({ decodeErrors: 2, rows: [] }, { arch: 'SNB', code: 'vfmadd231ps ymm0, ymm1, ymm2 # not zmm0\n// zmm1 too\n/* zmm2 */ mov eax, "zmm3"' });
  check(cm?.reason === 'needs FMA', 'comments and strings name nothing', j(cm));
  check(cannotRun({ decodeErrors: 1, rows: [{ ...zmm, opcode: '0F0B' }] }, { arch: 'IVB' })?.reason === '1 undecodable', 'one skipped position, junk X rows: one count');
  check(cannotRun({ decodeErrors: 3, rows: [zmm] }, { arch: 'IVB' })?.reason === '3 undecodable', 'machine code (no text): counts only, not named from the junk', j(cannotRun({ decodeErrors: 3, rows: [zmm] }, { arch: 'IVB' })));
  check(cannotRun({ decodeErrors: 0, xOps: ['62F17C481006', '62F17C48104E01'] }, { arch: 'ZEN3' })?.reason === 'needs AVX-512', 'a summary (xOps) as a response');
  check(extensionOf('C4E27550C2') === 'AVX-VNNI' && extensionOf('C4E27D4904') === 'AMX' && extensionOf('0F01D5') === 'TSX' && extensionOf('C7F800000000') === 'TSX'
    && extensionOf('660F3A0FC104') === null && extensionOf('F30F1EFA') === null && extensionOf('0F05') === null, 'extensionOf: by the encoding');
  check(ARCH_ORDER.every((k) => Array.isArray(LACKS[k])), 'every CPU of the menu has its list of missing extensions', ARCH_ORDER.filter((k) => !LACKS[k]).join());
}

// ---- the table of CPUs: never the fastest, no bar, not the scale --------------------------------------------------------
{
  const items = ['SKL', 'ICL', 'ZEN3', 'ADL-P'].map((key) => ({ key, title: key }));
  const res = new Map([
    ['SKL', { tp: 38, bottlenecks: [], decodeErrors: 12, xOps: [] }],
    ['ICL', { tp: 4, bottlenecks: ['Ports'], decodeErrors: 0, xOps: [] }],
    ['ZEN3', { tp: 3, bottlenecks: [], decodeErrors: 0, xOps: ['62F17C485807'] }],
    ['ADL-P', { tp: 11725, bottlenecks: [], decodeErrors: 12, xOps: [] }],
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
  const ab = abCpuRows(items, new Map([...res].flatMap(([k, v]) => [[`a:${k}`, v], [`b:${k}`, { tp: v.tp / 2, bottlenecks: [], decodeErrors: 0, xOps: [] }]])), { codeA: 'vaddps %zmm1, %zmm0, %zmm0' });
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
  // none of the diagnosis of rows that are not that code: no bottleneck, limits, next limit, caveats, chain
  const mdSkl = report(out.SKL, { arch: 'SKL', analyzed: code });
  check(/not a result: needs AVX-512/.test(mdSkl) && !/bottleneck|limits:|next limit|not modelled|critical chain/.test(mdSkl), 'Markdown report of a struck result: the reason only, no diagnosis', mdSkl.split('\n').slice(0, 6).join(' / '));
  const tbl = cpuTable([{ arch: 'SKL', name: 'Skylake', year: 2015, tp: 38, bottlenecks: [], decodeErrors: 12, unsupported: 'needs AVX-512', caveats: [{ text: 'store forwarding' }], limits: [{ name: 'Issue', tp: 34 }] }]);
  check(/\| SKL .*~~38\.00~~\* \| - +\| not a result: needs AVX-512; 12 undecodable \(left out\) +\|/.test(tbl), 'Markdown table: a struck row has no bottleneck and no caveats', tbl);
  check(/^\*\*~~3\.00~~ cycles\/iteration\*\* \(not a result: needs AVX-512\)/m.test(md), 'Markdown report: the number struck, the reason', md.split('\n')[0]);
  const cmd = compare(out.SKL, out.ICL, { archA: 'SKL', archB: 'ICL', invalidA: skl, invalidB: null });
  check(/^\*\*A ~~38\.00~~ · B 4\.00 cycles per iteration\*\* \(not comparable: A needs AVX-512 on SKL\)/.test(cmd), 'Markdown A–B: not comparable', cmd.split('\n')[0]);
  // the package's diff text (block-diff.js): no verdict
  const dt = diffText(diffResult({ ...out.ZEN3, unsupported: zen.reason }, out.ZEN3));
  check(/not comparable: A needs AVX-512/.test(dt) && !/speedup/.test(dt.split('\n')[0]), 'diff text: not comparable', dt.split('\n')[0]);
  // the diff's data says the same: no verdict of better/worse/same, no delta, no speedup (per element too)
  const dj = diffResult({ ...out.ZEN3, unsupported: zen.reason }, out.ZEN3, { per: [4, 4] });
  check(dj.verdict === 'not comparable' && !('delta' in dj) && !('speedup' in dj) && dj.perElement.verdict === 'not comparable' && !('speedup' in dj.perElement) && !('delta' in dj.perElement), 'diff data: verdict "not comparable", no delta or speedup', j({ verdict: dj.verdict, delta: dj.delta, speedup: dj.speedup, pe: dj.perElement }));
  // what-if of a base its CPU cannot run: said once, no variants (text, Markdown)
  const wi = await whatIf(async (arch, req) => (req.hex === hex ? { code: 0, ...out.SKL, unsupported: skl.reason } : { code: 0, ...out.ICL }), 'SKL', { hex });
  check(wi.unsupported === 'needs AVX-512' && wi.variants.length === 0 && wi.tp === 38, 'what-if: unsupported, no variants, the base number as it is', j({ u: wi.unsupported, n: wi.variants.length, tp: wi.tp }));
  check(/^What if \(SKL\): not a result: needs AVX-512 .*no variants\n$/.test(whatIfText(wi)) && /^\*\*What if \(SKL\):\*\* not a result: needs AVX-512 \(the base ~~38\.00~~/.test(whatIfMd(wi)), 'what-if text and Markdown: once, no variants', whatIfText(wi) + whatIfMd(wi));
  const ok2 = diffResult(out.ICL, out.ICL);
  check(ok2.verdict === 'same' && ok2.speedup === 1 && ok2.delta === 0, 'diff data of two results: as before');
  // FMA on SNB (the classic GEMM and saxpy): named
  for (const id of ['gemm', 'saxpy']) {
    const ex = CLASSIC_EXAMPLES.find((x) => x.id === id);
    const r = await run(ex.hex, 'SNB');
    const c = cannotRun(r, { arch: 'SNB', code: ex.text.intel });
    check(r.decodeErrors > 0 && /^needs (?:AVX2, )?FMA|^needs FMA/.test(c?.reason ?? '') && c.reason.includes('FMA'), `${id} on SNB: needs FMA`, j([r.decodeErrors, c]));
    check(cannotRun(await run(ex.hex, 'HSW'), { arch: 'HSW', code: ex.text.intel }) === null, `${id} on HSW: runs it`);
  }

  // the review's cases: instructions the decoder accepts but the tables lack are gaps, not "cannot run"
  const loop = async (body) => { const t = `  fldz\n.L:\n${body.map((l) => `  ${l}\n`).join('')}  dec rsi\n  jne .L\n`; const a = await A.assemble(t, 'intel', { loop: 'auto' }); if (!a.ok) throw new Error(`${body}: ${j(a.diagnostics)}`); return { hex: Buffer.from(a.bytes).toString('hex'), text: t }; };
  const gapCases = [
    [['fld tbyte ptr [rdi]', 'faddp st(1), st', 'add rdi, 16'], ARCH_ORDER],
    [['endbr64', 'add rax, 1'], ARCH_ORDER], [['cldemote byte ptr [rdi]', 'add rax, 1'], ARCH_ORDER], [['ud2', 'add rax, 1'], ARCH_ORDER],
    [['int3', 'add rax, 1'], ARCH_ORDER], [['syscall', 'add rax, 1'], ARCH_ORDER],
    [['clwb byte ptr [rdi]', 'add rax, 1'], ['ICX']], [['rdfsbase rax', 'add rbx, rax'], ['IVB', 'HSW', 'BDW']],
    [['xend', 'add rax, 1'], ['HSW', 'BDW', 'SKL', 'KBL', 'SKX', 'CFL', 'CLX', 'ICL', 'TGL', 'RKL', 'ICX']], [['xtest', 'add rax, 1'], ['HSW', 'SKL', 'ICX']],
    [['tpause eax', 'add rbx, 1'], ['ADL-P']],
  ];
  for (const [body, archs] of gapCases) {
    const { hex, text } = await loop(body);
    const items = [], res = new Map(), struck = [], noted = [];
    for (const arch of archs) {
      const r = await run(hex, arch);
      if (r.error) continue;
      if (cannotRun(r, { arch, code: text })) struck.push(`${arch}:${r.decodeErrors}`);
      if (noData(r, { arch })) noted.push(arch);
      items.push({ key: arch, title: arch }); res.set(arch, summarize(r));
    }
    const rows = compareRows(items, res, { code: text });
    check(struck.filter((x) => x.endsWith(':0')).length === 0, `${body[0]}: never struck where the decoder accepts it (${archs.length} CPUs)`, j(struck));
    if (archs === ARCH_ORDER && /fld|syscall/.test(body[0])) check(noted.length > 0 && rows.some((r) => r.fastest) && rows.filter((r) => r.noData).every((r) => r.bar > 0), `${body[0]}: "without data" noted, the rows keep their bars and a fastest`, j([noted, rows.map((r) => [r.key, r.fastest, r.noData])]));
  }
  // AVX-VNNI ({vex} vpdpbusd) on ZEN3, decoded and without data: cannot run, named from the encoding
  { const { hex } = await loop(['{vex} vpdpbusd ymm0, ymm1, ymm2']); check(cannotRun(await run(hex, 'ZEN3'), { arch: 'ZEN3' })?.reason === 'needs AVX-VNNI', '{vex} vpdpbusd on ZEN3: needs AVX-VNNI'); }

  // the fixture corpus (the reference's simulation cases, default options, the menu's CPUs): every result struck either
  // had positions its decoder skipped, or an instruction without data whose ISA set (XED's own, decoded with chip ALL)
  // is of an extension that CPU lacks; and each such instruction makes its result struck (the encoding rule agrees)
  const corpus = [new URL('fixtures/generated/sim_fixtures.jsonl.gz', root), new URL('fixtures/generated/extra_sim_fixtures.jsonl.gz', root)].filter((u) => fs.existsSync(u));
  if (!corpus.length) console.log('(the simulation fixtures are missing: no corpus check)');
  else {
    const { createGunzip } = await import('node:zlib');
    const readline = await import('node:readline');
    const ISA = [[/^AVX512/, 'AVX-512'], [/^AMX/, 'AMX'], [/^AVX_VNNI/, 'AVX-VNNI'], [/^RTM$/, 'TSX']];
    const isaOf = async (op) => { const d = await e.decode(new Uint8Array(Buffer.from(op, 'hex')), 'ALL'); const set = Array.isArray(d) ? d[0]?.['isa-set'] ?? '' : ''; return ISA.find(([re]) => re.test(set))?.[1] ?? null; };
    const seen = new Set();
    let n = 0, struck = 0, wrong = 0, missed = 0, gaps = 0;
    const bad = [];
    for (const u of corpus) {
      for await (const line of readline.createInterface({ input: fs.createReadStream(u).pipe(createGunzip()), crlfDelay: Infinity })) {
        const cut = line.indexOf(', "stdout"');
        const c = JSON.parse(cut < 0 ? line : line.slice(0, cut) + '}');
        if (Object.keys(c.options ?? {}).length || !ARCH_ORDER.includes(c.arch) || seen.has(`${c.hex}|${c.arch}`)) continue;
        seen.add(`${c.hex}|${c.arch}`);
        const r = await e.analyze({ ...makeRequest(c.hex, c.arch), minIterations: 1, minCycles: 1 }); // (the rows' notes and the decode errors do not depend on them)
        if (r.error) continue;
        n++;
        const x = cannotRun(r, { arch: c.arch });
        if (noData(r, { arch: c.arch })) gaps++;
        const lacked = [];
        if (!r.decodeErrors) for (const row of r.rows) if (row.kind === 'instr' && row.notes === 'X') { const ext = await isaOf(row.opcode); if (ext && LACKS[c.arch].includes(ext)) lacked.push(ext); }
        if (x) { struck++; if (!r.decodeErrors && !lacked.length) { wrong++; bad.push(`${c.arch} ${c.hex.slice(0, 40)}`); } }
        else if (lacked.length) { missed++; bad.push(`missed ${c.arch} ${c.hex.slice(0, 40)}`); }
      }
    }
    check(n > 5000 && wrong === 0 && missed === 0, `corpus: ${n} results, ${struck} struck (each with skipped positions or an instruction of an extension its CPU lacks), ${gaps} with instructions without data (not struck)`, j({ wrong, missed, bad: bad.slice(0, 10) }));
  }
}

console.log(`${count} cannot-run checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
