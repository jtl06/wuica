// The Markdown generators (lib/web/markdown.js, the page's web/js/markdown.js) on real results, against golden texts in
// test/golden (UPDATE_GOLDEN=1 rewrites them): the default example's report, the saxpy example on three CPUs, a
// what-if, an A–B pair (with the table per CPU), a failing input, the loops of a text, the batch form. Every text: no
// trailing whitespace, every table's rows with as many cells as its header, the same text twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWuica, findExample, markdown, whatIf, WHAT_IF_VARIANTS, listLoops } from '../lib/index.js';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');
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
  const meta = { arch: 'SKL', archTitle: 'SKL · Skylake (2015)', insights: w.insights(r), code: src, link: 'https://example.invalid/#v=1' };
  const md = markdown.report(r, meta);
  golden('report-chain-SKL', md);
  assert.equal(markdown.report(r, meta), md, 'deterministic');
  assert.match(md, /critical chain/);
});

test('report: per element, an unknown bottleneck', async () => {
  const r = await w.analyze('SKL', { source: ex('dot4') });
  golden('report-dot4-SKL-per32', markdown.report(r, { arch: 'SKL', per: 32, insights: w.insights(r) }));
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
  golden('compare-dot1-dot4', markdown.compare(a, b, { workA: 32, workB: 32, archA: 'SKL', archB: 'SKL', cpus }));
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

test('escaping: pipes and backticks in instruction text, cells padded by characters', () => {
  assert.equal(markdown.code('a|b'), '`a\\|b`');
  assert.equal(markdown.code('mov al, `'), '`` mov al, ` ``');
  assert.equal(markdown.text('x|y `z`'), 'x\\|y \\`z\\`');
  assert.equal(markdown.fence('a ``` b'), '````\na ``` b\n````');
  assert.equal(markdown.table(['A', 'Δ'], [['ü', '−1']], ['l', 'r']), '| A   |   Δ |\n|-----|----:|\n| ü   |  −1 |');
});
