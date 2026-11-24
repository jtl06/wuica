import zlib from 'node:zlib';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWuica, normalizeHex } from '../lib/index.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HEX = '4801d84801c349ffcf75f5';
const ASM = 'top:\n  add rax, rbx\n  add rbx, rax\n  dec r15\n  jnz top\n';

// uiCA's report from the Rust CLI: `cargo run` as in the repository's README, else the binary already built there.
function rustReport(hex, arch) {
  const args = [hex, '-arch', arch];
  // scripts/check.sh passes the binary it built
  if (process.env.WUICA_CLI) return execFileSync(process.env.WUICA_CLI, args, { cwd: ROOT, encoding: 'utf8' });
  try {
    return execFileSync('cargo', ['run', '--release', '-q', '-p', 'wuica-cli', '--', ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, CARGO_TARGET_DIR: path.join(ROOT, 'target-main'), PATH: `${process.env.HOME}/.rustup/toolchains/stable-aarch64-apple-darwin/bin:${process.env.PATH}` },
    });
  } catch {
    const bin = path.join(ROOT, 'target-main/release/wuica');
    if (!fs.existsSync(bin)) return null;
    return execFileSync(bin, args, { cwd: ROOT, encoding: 'utf8' });
  }
}

const w = await createWuica();

test('archs: order, names, prototypes, no ablation variants, fields', () => {
  const a = w.archs();
  assert.equal(a.length, 15);
  assert.deepEqual(a.map((x) => x.id).slice(0, 5), ['SNB', 'IVB', 'HSW', 'BDW', 'SKL']);
  assert.ok(a.every((x) => !x.id.includes('_')));
  assert.deepEqual(a.filter((x) => x.prototype).map((x) => x.id).sort(), ['ADL-P', 'ICX', 'ZEN3']);
  assert.deepEqual(a.find((x) => x.id === 'SKL'), { id: 'SKL', name: 'Skylake', year: 2015, prototype: false, table: 'SKL', xedChip: 'SKYLAKE' });
  assert.deepEqual(w.archs(['id', 'prototype'])[11], { id: 'ZEN3', prototype: true });
  assert.deepEqual(w.archs('id,name')[0], { id: 'SNB', name: 'Sandy Bridge' });
});

for (const arch of ['SKL', 'ZEN3', 'ADL-P']) {
  test(`analyze hex and source on ${arch}: same result, matches the Rust CLI`, async (t) => {
    const h = await w.analyze(arch, { hex: HEX });
    assert.equal(h.code, 0);
    assert.equal(h.error, undefined);
    assert.equal(h.arch, arch);
    assert.equal(h.mode, 'loop');
    assert.equal(typeof h.tp, 'number');
    assert.deepEqual(h.stderr, []);
    assert.ok(h.text.startsWith(`Throughput (in cycles per iteration): ${h.tp.toFixed(2)}`));
    assert.equal(h.hex, undefined);
    const a = await w.analyze(arch, { source: ASM });
    assert.equal(a.hex, HEX);
    assert.equal(a.text, h.text);
    assert.equal(a.tp, h.tp);
    const rust = rustReport(HEX, arch);
    if (rust === null) return t.skip('Rust CLI not available');
    assert.equal(h.text, rust);
  });
}

test('the work budget: wbinvd (about 10^6 uops) fails at once with code 3; an alignment offset beyond 2^62 with code 1 or 3', async () => {
  const t0 = performance.now();
  const r = await w.analyze('SKL', { hex: '0f09' });
  assert.equal(r.code, 3);
  assert.match(r.error, /^the block has \d+ uops per iteration, more than the 250000 wuica simulates/);
  assert.ok(performance.now() - t0 < 5000, `${Math.round(performance.now() - t0)} ms`);
  const big = await w.analyze('SKL', { hex: HEX, options: { alignmentOffset: 2 ** 62 + 4096 } });
  assert.notEqual(big.code, 0);
  assert.match(big.error, /alignmentOffset .* out of range|not an integer/);
  assert.equal((await w.analyze('SKL', { hex: HEX, options: { alignmentOffset: 2 ** 40 } })).tp, (await w.analyze('SKL', { hex: HEX })).tp);
});

test('whatIf(arch, request): the what-if experiments with variants and per (the MCP tool and REST give the same)', async () => {
  const { whatIf, WHAT_IF_VARIANTS, whatIfText } = await import('../lib/index.js');
  const DOT = 'loop:\n vfmadd231ps ymm0, ymm1, [rdi+rax]\n add rax, 32\n cmp rax, rdx\n jb loop\n';
  const x = await w.whatIf('SKL', { source: DOT });
  assert.deepEqual(x, await whatIf((a, r) => w.analyze(a, r), 'SKL', { source: DOT }, WHAT_IF_VARIANTS, { assemble: (t) => w.assemble(t, 'intel') }));
  const p = await w.whatIf('SKL', { source: DOT, variants: ['acc4'], per: 8 });
  assert.equal(p.elementsPerIteration, 8);
  assert.equal(p.perElement, p.tp / 8);
  assert.equal(p.variants[0].perElement, p.variants[0].tp / 8);
  assert.match(whatIfText(p), /^What if \(SKL\), cycles per element \(8 per original iteration; base /);
  assert.equal((await w.whatIf('SKL', { source: DOT, per: -1 })).code, 1);
  assert.equal((await w.whatIf('SKL', { source: DOT, variants: 'acc2' })).code, 1);
  assert.equal((await w.whatIf('SKL', { source: DOT, variants: ['acc9'] })).code, 1);
});

test('otherLoops: the loops not analyzed when the text has more than one (listLoops\' entries), in analyze, summarize, compare', async () => {
  const { listLoops } = await import('../lib/index.js');
  const src = 'f:\n.L1:\n add rax, 1\n dec rcx\n jnz .L1\n.L2:\n add rbx, 1\n dec rdx\n jnz .L2\n ret\n';
  const r = await w.analyze('SKL', { source: src });
  const all = listLoops(src);
  assert.equal(r.loop.index, 0);
  assert.deepEqual(r.otherLoops, all.filter((l) => l.index !== 0).map(({ auto, ...l }) => l));
  assert.deepEqual(r.otherLoops, [{ index: 1, label: '.L2', function: 'f', line: 6, endLine: 9, instructions: 3, depth: 1 }]);
  assert.deepEqual((await w.analyze('SKL', { source: src, loop: 1 })).otherLoops.map((l) => l.label), ['.L1']);
  assert.deepEqual(w.summarize(r).otherLoops, r.otherLoops);
  assert.deepEqual((await w.compare({ source: src, archs: ['SKL'] })).otherLoops, r.otherLoops);
  // one loop, or machine code: none
  assert.equal((await w.analyze('SKL', { source: 'l:\n dec rcx\n jnz l\n' })).otherLoops, undefined);
  assert.equal((await w.analyze('SKL', { hex: HEX })).otherLoops, undefined);
  assert.equal(listLoops(42).error, '`source` must be assembly text');
});

test('compare with per: cycles per element on each row (as the CLI\'s -arch with -per)', async () => {
  const c = await w.compare({ hex: HEX, archs: ['SKL', 'ZEN3', 'NOPE'], per: 4 });
  assert.equal(c.elementsPerIteration, 4);
  assert.deepEqual(c.results.map((r) => r.perElement), [c.results[0].tp / 4, c.results[1].tp / 4, undefined]);
  assert.equal((await w.compare({ hex: HEX, archs: ['SKL'] })).elementsPerIteration, undefined);
  for (const per of [0, -1, '4']) assert.equal((await w.compare({ hex: HEX, per })).code, 1, String(per));
});

test('SKL result in detail', async () => {
  const r = await w.analyze('SKL', { hex: HEX });
  assert.equal(r.tp, 2);
  assert.deepEqual(r.bottlenecks, ['Dependencies']);
  assert.ok(r.limits.some((l) => l.name === 'Dependencies' && l.tp === 2));
  assert.equal(r.rows.length, 4);
  assert.equal(r.rows[3].notes, 'M');
  assert.equal(r.columns.length, r.rows[0].values.length);
});

test('options are passed through and checked', async () => {
  assert.equal((await w.analyze('SKL', { hex: '4801d8' })).mode, 'unroll');
  const a = await w.analyze('SKL', { hex: HEX, options: { noMacroFusion: true } });
  assert.equal(a.rows[3].notes, '');
  const t = await w.analyze('SKL', { hex: '4801d8', options: { includeTrace: true } });
  assert.ok(t.trace && Array.isArray(t.trace.cycles));
  // a bad value is a bad request (code 1), like an unknown option
  const bad = await w.analyze('SKL', { hex: '4801d8', options: { initPolicy: 'nonsense' } });
  assert.equal(bad.code, 1);
  assert.match(bad.error, /option initPolicy: "nonsense" is not one of "diff", "same", "stack"/);
  for (const o of [{ alignmentOffset: '3' }, { alignmentOffset: 1.5 }, { minIterations: 2 ** 60 }, { minCycles: NaN }, { simpleFrontEnd: 'yes' }, { noMicroFusion: 1 }, { includeTrace: 'x' }]) {
    const r = await w.analyze('SKL', { hex: '4801d8', options: o });
    assert.equal(r.code, 1, JSON.stringify(o));
    assert.match(r.error, /^option \w+: .* is not (an integer|true or false)$/);
  }
  assert.equal((await w.compare({ hex: '4801d8', options: { minCycles: 'x' } })).code, 1);
  const typo = await w.analyze('SKL', { hex: '4801d8', options: { minIteration: 5 } });
  assert.equal(typo.code, 1);
  assert.match(typo.error, /unknown option\(s\): minIteration/);
  // option keys at the top level are accepted (the single-object form of the original API); `options` wins
  const flat = await w.analyze({ arch: 'SKL', hex: HEX, noMacroFusion: true });
  assert.equal(flat.rows[3].notes, '');
  assert.equal((await w.analyze('SKL', { hex: HEX, noMacroFusion: true, options: { noMacroFusion: false } })).rows[3].notes, 'M');
  const unknownTop = await w.analyze('SKL', { hex: HEX, minIteration: 5 });
  assert.equal(unknownTop.code, 1);
  assert.match(unknownTop.error, /unknown request field\(s\): minIteration/);
  assert.equal((await w.compare({ hex: HEX, arch: 'SKL' })).code, 1);
  assert.equal((await w.compare({ hex: HEX, archs: ['SKL'], minCycles: 600 })).code, 0);
});

test('single-object form, asm alias, AT&T, hex formats, arch names', async () => {
  const r = await w.analyze({ arch: 'adlp', asm: 'addq %rbx, %rax\n', syntax: 'att' });
  assert.equal(r.arch, 'ADL-P');
  assert.equal(r.hex, '4801d8');
  assert.equal(normalizeHex('0x48, 0x01 0xD8'), '4801d8');
  assert.equal(normalizeHex('\\x48\\x01\\xd8'), '4801d8');
  assert.equal(normalizeHex('480'), null);
  assert.equal((await w.analyze('skl', { hex: '48 01 d8' })).arch, 'SKL');
  assert.equal((await w.analyze({ hex: '4801d8' })).arch, 'SKL');
  assert.equal(w.resolveArch('zen3'), 'ZEN3');
  assert.equal(w.resolveArch('nope'), null);
  assert.equal(w.resolveArch(' skl\t'), 'SKL'); // whitespace around a name is trimmed; blank is the default, as ''
  assert.equal(w.resolveArch(' '), 'SKL');
  assert.equal((await w.analyze('adl-p ', { hex: '4801d8' })).arch, 'ADL-P');
});

test('errors are returned as {code, error, stderr}, not thrown', async () => {
  const u = await w.analyze('K8', { hex: '4801d8' });
  assert.equal(u.code, 1);
  assert.match(u.error, /unknown microarchitecture: K8/);
  assert.deepEqual(u.stderr, [{ text: u.error }]);
  assert.equal((await w.analyze('SKL', { hex: 'xyz' })).code, 1);
  assert.match((await w.analyze('SKL', {})).error, /exactly one/);
  assert.match((await w.analyze('SKL', { hex: '4801d8', source: 'nop' })).error, /exactly one/);
  const asmErr = await w.analyze('SKL', { source: 'nop\nfrobnicate rax\n' });
  assert.equal(asmErr.code, 2);
  assert.equal(asmErr.error, "assembly failed: line 2: invalid instruction mnemonic 'frobnicate'");
  assert.deepEqual(asmErr.stderr, [
    { text: "<input>:2:1: error: invalid instruction mnemonic 'frobnicate'", tag: { line: 2, column: 1, severity: 'error', text: "invalid instruction mnemonic 'frobnicate'" } },
    { text: 'frobnicate rax' },
    { text: '^~~~~~~~~~' },
  ]);
  assert.match((await w.analyze('SKL', { source: '# nothing\n' })).error, /no instructions/);
  assert.equal((await w.analyze('SKL', { source: 'nop', syntax: 'masm' })).code, 1);
});

test('assemble', async () => {
  const r = await w.assemble('top:\nadd rax, rbx\nvaddps zmm0 {k1}{z}, zmm1, zmm2\njnz top\n');
  assert.equal(r.code, 0);
  assert.equal(r.hex, '4801d862f174c958c275f5');
  assert.equal(r.length, 11);
  assert.deepEqual([...r.bytes.slice(0, 3)], [0x48, 0x01, 0xd8]);
  assert.deepEqual(r.stderr, []);
  assert.equal((await w.assemble('addq %rbx, %rax', 'att')).hex, '4801d8');
  assert.equal((await w.assemble('{load} mov eax, ebx')).code, 0);
  assert.equal((await w.assemble('\uFEFFadd rax, rbx\n')).hex, '4801d8'); // a byte order mark at the start is dropped
  assert.equal((await w.analyze('SKL', { source: '\uFEFFadd rax, rbx\r\nadd rbx, rax\r\n' })).code, 0);
  const warn = await w.assemble('.warning "careful"\nnop\n');
  assert.equal(warn.code, 0);
  assert.equal(warn.stderr[0].tag.severity, 'warning');
  const bad = await w.assemble('mov rax, ');
  assert.equal(bad.code, 2);
  assert.equal(bad.stderr[0].tag.line, 1);
});

test('.code16 / .code32: an error (only 64-bit code is analyzed), not 16- or 32-bit code analyzed as 64-bit', async () => {
  const r = await w.analyze('SKL', { source: 'nop\n.code32\ninc eax\n' });
  assert.equal(r.code, 1);
  assert.equal(r.error, 'line 2: .code32: only 64-bit code can be analyzed');
  for (const source of ['.code16\nadd ax, 1', 'x: .code16gcc\nnop', 'nop; .code32; inc eax', '/* x */ .code32\nnop']) {
    assert.equal((await w.analyze('SKL', { source })).code, 1, source);
  }
  assert.equal((await w.compare({ source: '.code32\ninc eax', archs: ['SKL'] })).code, 1);
  // in comments, in other words, or 64-bit mode: analyzed
  for (const source of ['# .code32\ninc eax', '/* .code32\n */ inc eax', 'inc eax // .code16', '.code64\ninc eax']) {
    assert.equal((await w.analyze('SKL', { source })).code, 0, source);
  }
  // assembling alone is not affected (the bytes of 32-bit code are what was asked for)
  assert.equal((await w.assemble('.code32\ninc eax')).hex, '40');
});

test('summarize', async () => {
  const s = w.summarize(await w.analyze('ZEN3', { source: ASM }));
  assert.equal(s.tp, 2);
  assert.equal(s.name, 'AMD Zen 3');
  assert.equal(s.prototype, true);
  assert.equal(s.hex, HEX);
  assert.equal(s.instructions[0].bytes, '4801d8');
  assert.ok(s.instructions[0].ports.ALU0 > 0);
  assert.equal(s.instructions[3].notes, 'M');
  // the derived diagnosis (add rax, rbx; add rbx, rax: a loop-carried chain)
  const ins = s.insights;
  assert.deepEqual(ins.binding, s.bottlenecks.slice(0, ins.binding.length));
  for (const l of s.limits) assert.equal(ins.utilization[l.name], Math.round((l.tp / s.tp) * 100) / 100);
  assert.ok(ins.utilization.ALU0 > 0);
  if (s.bottlenecks.includes('Dependencies')) {
    assert.ok(ins.chain.length >= 1 && ins.chain.every((e) => typeof e.index === 'number' && e.instr === s.instructions[e.index].instr));
    assert.equal(ins.hot.resource, ins.binding[0]);
  }
  const shares = ins.hot?.instructions.map((x) => x.share) ?? [];
  assert.ok(shares.every((x, i) => i === 0 || x <= shares[i - 1]));
});

test('a dataDir with plain binary tables works; JSON tables are an error that says how to convert them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-data-'));
  fs.mkdirSync(path.join(dir, 'arch'));
  fs.copyFileSync(path.join(ROOT, 'data/uarch.json'), path.join(dir, 'uarch.json'));
  fs.writeFileSync(path.join(dir, 'arch/SKL.bin'), zlib.brotliDecompressSync(fs.readFileSync(path.join(DIR, 'dist/data/arch/SKL.bin.br'))));
  fs.copyFileSync(path.join(ROOT, 'data/arch/ICL.json'), path.join(dir, 'arch/ICL.json'));
  const w2 = await createWuica({ dataDir: dir, threads: 1 });
  assert.equal((await w2.analyze('SKL', { hex: HEX })).tp, 2);
  const j = await w2.analyze('ICL', { hex: HEX });
  assert.equal(j.code, 3);
  assert.match(j.error, /could not load the instruction table for ICL: .*reads only binary tables \(data\/arch\/<NAME>\.bin, written from the JSON by tools\/encode-tables\.sh\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compare', async () => {
  const c = await w.compare({ source: ASM, archs: ['SKL', 'zen3', 'K8'] });
  assert.equal(c.code, 0);
  assert.equal(c.hex, HEX);
  assert.deepEqual(c.results.map((r) => [r.arch, r.code]), [['SKL', 0], ['ZEN3', 0], ['K8', 1]]);
  assert.equal(c.results[0].tp, 2);
  assert.equal(c.results[1].prototype, true);
  assert.match(c.results[2].error, /unknown/);
  // a repeated name (the same id, or the same unknown name) counts once, in the order of its first appearance
  const d = await w.compare({ hex: HEX, archs: ['SKL', 'zen3 ', 'skl', 'K8', 'ZEN3', ' K8'] });
  assert.deepEqual(d.results.map((r) => r.arch), ['SKL', 'ZEN3', 'K8']);
  const all = await w.compare({ hex: HEX });
  assert.equal(all.results.length, 15);
  assert.ok(all.results.every((r) => typeof r.tp === 'number'));
  assert.equal((await w.compare({ source: 'frob' })).code, 2);
});
