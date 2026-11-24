// The Markdown generators (lib/web/markdown.js, the page's web/js/markdown.js) on real results, against golden texts in
// test/golden (UPDATE_GOLDEN=1 rewrites them): the default example's report, the saxpy example on three CPUs, a
// what-if, an A–B pair (with the table per CPU), a failing input, the loops of a text, the batch form. Every text: no
// trailing whitespace, every table's rows with as many cells as its header, the same text twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWuica, findExample, markdown, whatIf, WHAT_IF_VARIANTS, listLoops } from '../lib/index.js';
import { analyzedLines } from '../lib/web/branch-label.js';
import { tmpDir } from './tmpdir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'golden');
const BIN = path.resolve(HERE, '../bin/wuica.js');
const run = (args, input = '') => {
  const r = spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const w = await createWuica();
const ex = (name) => findExample(name).intel;

// cells of a GFM table row (pipes escaped with a backslash do not split)
const cells = (line) => line.trim().slice(1, -1).split(/(?<!\\)\|/);
function wellFormed(md, name) {
  assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'), `${name}: ends with one newline`);
  for (const [k, l] of md.split('\n').entries()) assert.ok(!/[ \t]$/.test(l), `${name}: line ${k + 1} has trailing whitespace: ${JSON.stringify(l)}`);
  for (const block of md.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    if (!lines[0].startsWith('| ') || !/^\|[-:|]+\|$/.test(lines[1] ?? '')) continue;
    const n = cells(lines[0]).length;
    assert.equal(cells(lines[1]).length, n, `${name}: the rule has as many cells as the header`);
    for (const l of lines.slice(2)) assert.equal(cells(l).length, n, `${name}: a row with ${n} cells: ${l}`);
    const width = lines[0].length;
    for (const l of lines) assert.ok(l.length <= width, `${name}: padded to the header's width: ${l}`);
  }
}
function golden(name, md) {
  wellFormed(md, name);
  const file = path.join(GOLDEN, `${name}.md`);
  if (process.env.UPDATE_GOLDEN) { fs.mkdirSync(GOLDEN, { recursive: true }); fs.writeFileSync(file, md); }
  assert.equal(md, fs.readFileSync(file, 'utf8'), `${name}: the golden text (UPDATE_GOLDEN=1 rewrites test/golden/${name}.md)`);
}
const analyze = (a, r) => w.analyze(a, r);
const tools = { assemble: (t) => w.assemble(t, 'intel') };

test('report: the default example (chain) on SKL, with the code and a link', async () => {
  const src = ex('chain');
  const r = await w.analyze('SKL', { source: src });
  const meta = { arch: 'SKL', archTitle: 'SKL · Skylake (2015)', insights: w.insights(r), src: analyzedLines(src, r), code: src, link: 'https://example.invalid/#v=1' };
  const md = markdown.report(r, meta);
  golden('report-chain-SKL', md);
  assert.equal(markdown.report(r, meta), md, 'deterministic');
  assert.match(md, /critical chain/);
  assert.match(md, /\| `jnz loop` +\|/, 'the branch target as the label written in the text');
});

test('branch targets: the label in the text, else the offset in the block, never the 64-bit relative value', async () => {
  const r = await w.analyze('SKL', { source: ex('chain') });
  assert.match(markdown.uopTable(r), /\| `jnz 0x0` +\|/, 'machine code: the offset in the block');
  assert.match(markdown.uopTable(r, { shown: r.rows.map((x) => (x.kind === 'instr' && /^jnz/.test(x.label) ? 'jnz top' : null)) }), /`jnz top`/, 'the labels the page shows');
  const both = markdown.compare(r, await w.analyze('SKL', { source: ex('chain') }), { srcA: analyzedLines(ex('chain'), r) });
  assert.match(both, /\| `jnz loop` +\| `jnz 0x0` +\|/, 'A with its text, B without');
  for (const md of [markdown.report(r), markdown.uopTable(r), both]) assert.doesNotMatch(md, /0xffff/);
});

test('report: per element, an unknown bottleneck', async () => {
  const r = await w.analyze('SKL', { source: ex('dot4') });
  golden('report-dot4-SKL-per32', markdown.report(r, { arch: 'SKL', per: 32, insights: w.insights(r), src: analyzedLines(ex('dot4'), r) }));
  const u = { ...r, bottlenecks: [] };
  assert.match(markdown.headline(u, { arch: 'SKL' }), /bottleneck: unknown · nearest Ports, Dependencies 4\.00$/);
});

test('cpuTable: saxpy on SKL, ZEN3, ADL-P', async () => {
  const c = await w.compare({ source: ex('saxpy'), archs: ['SKL', 'ZEN3', 'ADL-P'] });
  golden('cpus-saxpy', markdown.cpuTable(c));
  golden('cpus-saxpy-per8', markdown.cpuTable(c, { per: 8 }));
});

test('cpuTable: the batch form, files x CPUs, with a failing file', async () => {
  const archs = ['SKL', 'ZEN3'];
  const items = [
    { file: 'saxpy.s', result: await w.compare({ source: ex('saxpy'), archs }) },
    { file: 'a|b.s', result: await w.compare({ source: ex('dot1'), archs }) },
    { file: 'bad.s', result: await w.compare({ source: 'foo rax', archs }) },
  ];
  golden('cpus-batch', markdown.cpuTable(items));
});

test('whatIf: dot1 on SKL, and per element', async () => {
  const x = await whatIf(analyze, 'SKL', { source: ex('dot1') }, WHAT_IF_VARIANTS, tools);
  golden('whatif-dot1-SKL', markdown.whatIf(x));
  golden('whatif-dot1-SKL-per8', markdown.whatIf({ ...x, elementsPerIteration: 8 }));
});

test('compare: dot1 (A) against dot4 (B), per element, with the table per CPU', async () => {
  const a = await w.analyze('SKL', { source: ex('dot1') }), b = await w.analyze('SKL', { source: ex('dot4') });
  const cpus = [];
  for (const arch of ['SKL', 'ZEN3', 'ADL-P']) {
    const [ra, rb] = [await w.analyze(arch, { source: ex('dot1') }), await w.analyze(arch, { source: ex('dot4') })];
    cpus.push({ arch, a: ra.code ? null : ra.tp / 32, b: rb.code ? null : rb.tp / 32 });
  }
  golden('compare-dot1-dot4', markdown.compare(a, b, { workA: 32, workB: 32, archA: 'SKL', archB: 'SKL', cpus, srcA: analyzedLines(ex('dot1'), a), srcB: analyzedLines(ex('dot4'), b) }));
  golden('compare-same', markdown.compare(a, a));
});

test('a failing input: the report, the A–B and the CPU table say so', async () => {
  const bad = await w.analyze('SKL', { source: 'add rax, rbx\nfoo bar, baz' });
  assert.notEqual(bad.code, 0);
  golden('report-failure', markdown.report(bad, { code: 'add rax, rbx\nfoo bar, baz' }));
  assert.match(markdown.compare(bad, await w.analyze('SKL', { source: ex('chain') })), /one side has no result \(A: assembly failed/);
});

test('loops: a text with two', () => {
  golden('loops-two', markdown.loops(listLoops('f:\n.L1:\n  add rax, 1\n  dec rcx\n  jnz .L1\n.L2:\n  add rbx, 1\n  dec rdx\n  jnz .L2\n  ret\n')));
  assert.equal(markdown.loops([]), 'no loops\n');
});

test('whatIf with per 1: per element (as the text form), not ignored', async () => {
  const x = await whatIf(analyze, 'SKL', { source: ex('dot1') }, ['unroll2'], tools);
  assert.match(markdown.whatIf({ ...x, elementsPerIteration: 1 }), /cycles per element \(1 per original iteration; base 16\.00\)/);
});

test('escaping: pipes and backticks in instruction text, cells padded by characters', () => {
  assert.equal(markdown.code('a|b'), '`a\\|b`');
  assert.equal(markdown.code('mov al, `'), '`` mov al, ` ``');
  assert.equal(markdown.text('x|y `z`'), 'x\\|y \\`z\\`');
  assert.equal(markdown.fence('a ``` b'), '````\na ``` b\n````');
  assert.equal(markdown.table(['A', 'Δ'], [['ü', '−1']], ['l', 'r']), '| A   |   Δ |\n|-----|----:|\n| ü   |  −1 |');
});

test('wuica -md: a single run, -arch A,B,C, -whatif, -loops, several files, -per; not with -json or -TPonly', () => {
  const one = run(['-example', 'chain', '-md']);
  assert.equal(one.code, 0);
  wellFormed(one.out, '-md');
  assert.match(one.out, /^\*\*2\.00 cycles\/iteration\*\* · SKL · Skylake \(2015\) · loop · bottleneck: Dependencies\\$/m);
  assert.match(one.out, /\| `jnz loop` +\|/);
  assert.match(one.out, /```asm\nloop:\n  add rax, 1\n/);
  const cpus = run(['-example', 'saxpy', '-arch', 'SKL,ZEN3,ADL-P', '-md']);
  assert.equal(cpus.code, 0);
  assert.equal(cpus.out, fs.readFileSync(path.join(GOLDEN, 'cpus-saxpy.md'), 'utf8'), 'the CPU table as the library makes it');
  const wi = run(['-example', 'dot1', '-whatif', '-md']);
  assert.equal(wi.code, 0);
  wellFormed(wi.out, '-whatif -md');
  assert.ok(wi.out.endsWith(fs.readFileSync(path.join(GOLDEN, 'whatif-dot1-SKL.md'), 'utf8')), 'the report, then the what-if table');
  const per = run(['-example', 'dot1', '-per', '8', '-md']);
  assert.match(per.out, /^\*\*2\.00 cycles\/element\*\* \(16\.00 cycles\/iteration, 8 elements per iteration\)/);
  const loops = run(['-example', 'dot1', '-loops', '-md']);
  assert.equal(loops.code, 0);
  assert.match(loops.out, /^\| +# \| Label +\| Function/);
  // several files (one fails: the largest status, a row that says so)
  const dir = tmpDir('wuica-md-');
  fs.writeFileSync(path.join(dir, 'a.s'), ex('saxpy'));
  fs.writeFileSync(path.join(dir, 'b.s'), 'foo rax\n');
  const many = spawnSync(process.execPath, [BIN, 'a.s', 'b.s', '-arch', 'SKL,ZEN3', '-md', '-per', '8'], { cwd: dir, encoding: 'utf8' });
  assert.equal(many.status, 2);
  wellFormed(many.stdout, 'several files');
  assert.match(many.stdout, /^\| File \| Loop +\| CPU +\| Model +\| Year \| +TP \| per el \| Bottlenecks/);
  assert.match(many.stdout, /\| b\.s +\| - +\|.*\| error: assembly failed/);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const other of ['-json', '-TPonly']) {
    const bad = run(['-example', 'chain', '-md', other]);
    assert.equal(bad.code, 1);
    assert.equal(bad.out, '');
    assert.match(bad.err, new RegExp(`-md: .*not with ${other}`));
  }
});
