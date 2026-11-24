// Two blocks, before and after (web/js/block-diff.js): the library's diff, the MCP tool diff_blocks and `wuica diff`
// give the same result; the Markdown against a golden text (test/golden/diff-dot1-dot4.md, UPDATE_GOLDEN=1 rewrites it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWuica, findExample, diffAnalyses, diffMarkdown, diffText } from '../lib/index.js';
import { mcpTools, callTool } from '../lib/mcp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../bin/wuica.js');
const w = await createWuica();
const DOT1 = findExample('dot1').intel, DOT4 = findExample('dot4').intel;
const REQ = { a: { source: DOT1 }, b: { source: DOT4 }, per: 32 };

test('diff: throughput, per element, bottlenecks, limits, ports, instructions', async () => {
  const r = await w.diff('SKL', REQ);
  assert.equal(r.code, 0);
  assert.deepEqual([r.a.tp, r.b.tp, r.delta, r.speedup, r.verdict], [16, 4, -12, 4, 'better']);
  assert.deepEqual(r.perElement, { a: 0.5, b: 0.125, delta: -0.375, speedup: 4, verdict: 'better' });
  assert.deepEqual([r.a.perElement, r.b.perElement, r.a.decodeErrors, r.b.decodeErrors], [0.5, 0.125, 0, 0]);
  assert.deepEqual(r.bottlenecks, { a: ['Dependencies'], b: ['Dependencies', 'Ports'], gone: [], new: ['Ports'] });
  assert.deepEqual(r.limits.find((l) => l.name === 'Dependencies'), { name: 'Dependencies', a: 16, b: 4, delta: -12 });
  assert.ok(r.ports.length > 0 && r.ports.every((p) => Math.abs(p.b - p.a - p.delta) < 0.011));
  assert.deepEqual(r.instructions.counts, { same: 6, changed: 2, modified: 3, added: 0, removed: 0 });
  assert.equal(r.instructions.changes.length, 5);
  assert.ok(r.instructions.changes.some((x) => x.status === 'modified' && /ymm1, ymm5/.test(x.b)));
  // without per: no perElement; a block against itself: the same, no changes
  const same = await w.diff('SKL', { a: { source: DOT1 }, b: { source: DOT1 } });
  assert.equal(same.verdict, 'same');
  assert.equal(same.perElement, undefined);
  assert.equal(same.instructions.changes.length, 0);
  // per [A, B]: each side's own (written out: dot1 16 cycles / 8, dot4 4 cycles / 32)
  const pp = await w.diff('SKL', { ...REQ, per: [8, 32] });
  assert.deepEqual([pp.a.perElement, pp.b.perElement, pp.perElement.a, pp.perElement.b], [2, 0.125, 2, 0.125]);
  // per element unrounded, as compare and what-if give it: 16 / 3
  const p3 = await w.diff('SKL', { ...REQ, per: [3, 3] });
  assert.equal(p3.a.perElement, 16 / 3);
  assert.equal(p3.perElement.a, 16 / 3);
});

test('diff: each instruction\'s uop change is B - A, from two separate analyses, rounded as the uop table', async () => {
  const ra = await w.analyze('SKL', { source: DOT1 }), rb = await w.analyze('SKL', { source: DOT4 });
  const port0 = ra.columns.indexOf('Port 0');
  // the second vfmadd231ps: ymm0 in A, ymm1 in B (row 5 of both), Port 0 0.4 in A, 0.58 in B (written out)
  assert.deepEqual([ra.rows[5].values[port0], rb.rows[5].values[port0]].map((v) => Math.round(v * 100) / 100), [0.4, 0.58]);
  const r = await w.diff('SKL', REQ);
  const x = r.instructions.changes.find((c) => c.status === 'modified' && /ymm1, ymm5/.test(c.b));
  assert.equal(x.uops['Port 0'], 0.18);
  assert.equal(x.uops['Port 0'], Math.round((rb.rows[5].values[port0] - ra.rows[5].values[port0]) * 100) / 100);
  assert.ok(r.instructions.changes.every((c) => Object.values(c.uops).every((v) => Math.round(v * 100) / 100 === v)));
  // the ports: A's and B's totals (written out from the two uop tables)
  assert.deepEqual(r.ports.find((p) => p.port === 'Port 5'), { port: 'Port 5', a: 0.2, b: 1, delta: 0.8 });
});

test('diff: decode errors and warnings of each side; a loop against an unrolled block is not comparable', async () => {
  const s = await w.diff('SNB', REQ); // SNB has no FMA: 4 positions of each block cannot be decoded
  assert.equal(s.code, 0);
  assert.deepEqual([s.a.decodeErrors, s.b.decodeErrors], [4, 4]);
  assert.deepEqual(s.stderr.map((l) => l.text), ['A: Warning: 4 position(s) could not be decoded', 'B: Warning: 4 position(s) could not be decoded']);
  assert.match(diffText(s), /^warning: A: 4 position\(s\) could not be decoded$/m);
  assert.match(diffMarkdown(await diffAnalyses(w, 'SNB', REQ)), /^- B: Warning: 4 position\(s\) could not be decoded$/m);
  const m = await w.diff('SKL', { a: { source: DOT1 }, b: { hex: '4801d8' } });
  assert.equal(m.code, 1);
  assert.equal(m.error, 'not comparable: A is analyzed as a loop, B unrolled (it does not end with a branch)');
});

test('diff: failures say which side; bad requests are code 1', async () => {
  const b = await w.diff('SKL', { a: { source: DOT1 }, b: { source: 'frob rax' } });
  assert.equal(b.code, 2);
  assert.match(b.error, /^B: assembly failed/);
  for (const bad of [{}, { a: { source: DOT1 } }, { a: 1, b: { hex: '4801d8' } }, { ...REQ, per: 0 }, { ...REQ, per: [1] }, { ...REQ, bogus: 1 }]) {
    assert.equal((await w.diff('SKL', bad)).code, 1, JSON.stringify(bad).slice(0, 60));
  }
  const nope = await w.diff('NOPE', REQ);
  assert.equal(nope.code, 1);
  assert.match(nope.error, /^unknown microarchitecture: NOPE/, 'not a side\'s error');
  const opt = await w.diff('SKL', { ...REQ, options: { minCycles: 'x' } });
  assert.match(opt.error, /^option minCycles/, 'the shared options are the request\'s');
  assert.match((await w.diff('SKL', { ...REQ, b: { source: DOT4, options: { minCycles: 'x' } } })).error, /^B: option minCycles/);
});

test('the MCP tool diff_blocks gives the library\'s result', async () => {
  const tools = mcpTools(w);
  const r = await callTool(tools, 'diff_blocks', { arch: 'SKL', ...REQ });
  assert.deepEqual(JSON.parse(r.content[0].text), await w.diff('SKL', REQ));
  const e = await callTool(tools, 'diff_blocks', { arch: 'SKL', a: { source: DOT1 }, b: { source: 'frob rax' } });
  assert.equal(e.isError, true);
  // per-side options as the library takes them; per [A, B] exactly two
  const own = await callTool(tools, 'diff_blocks', { arch: 'SKL', a: { source: DOT1, options: { noMacroFusion: true } }, b: { source: DOT4 } });
  assert.deepEqual(JSON.parse(own.content[0].text), await w.diff('SKL', { a: { source: DOT1, options: { noMacroFusion: true } }, b: { source: DOT4 } }));
  assert.match((await callTool(tools, 'diff_blocks', { ...REQ, per: [1, 2, 3] })).content[0].text, /^Invalid arguments for tool diff_blocks: per: expected/);
  const bad = await callTool(tools, 'diff_blocks', { a: { source: DOT1 } });
  assert.match(bad.content[0].text, /^Invalid arguments for tool diff_blocks: b: required/);
});

test('the MCP tool list_loops: listLoops\' entries, func, errors, why there are none', async () => {
  const { listLoops } = await import('../lib/index.js');
  const tools = mcpTools(w);
  const src = 'f:\n.L1:\n add rax, 1\n dec rcx\n jnz .L1\n.L2:\n add rbx, 1\n dec rdx\n jnz .L2\n ret\n';
  const r = await callTool(tools, 'list_loops', { source: src });
  assert.deepEqual(JSON.parse(r.content[0].text), { code: 0, loops: listLoops(src) });
  const e = await callTool(tools, 'list_loops', { source: src, func: 'nope' });
  assert.equal(e.isError, true);
  assert.match(JSON.parse(e.content[0].text).error, /^func: "nope" is not a label/);
  const marked = JSON.parse((await callTool(tools, 'list_loops', { source: '# LLVM-MCA-BEGIN\nl:\n dec rcx\n jnz l\n# LLVM-MCA-END\n' })).content[0].text);
  assert.deepEqual(marked.loops, []);
  assert.match(marked.note, /marked region/);
  assert.match(JSON.parse((await callTool(tools, 'list_loops', { source: 'add rax, 1\n' })).content[0].text).note, /no backward branch/);
});

test('the MCP tool compare_archs with per', async () => {
  const tools = mcpTools(w);
  const r = await callTool(tools, 'compare_archs', { hex: '4801d84801c349ffcf75f5', archs: ['SKL'], per: 2 });
  const c = JSON.parse(r.content[0].text);
  assert.equal(c.results[0].perElement, c.results[0].tp / 2);
  assert.match((await callTool(tools, 'compare_archs', { hex: '4801d8', per: 0 })).content[0].text, /per: expected more than 0/);
});

test('wuica diff A B: text, -json, -md (golden), exit codes', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wuica-diff-'));
  fs.writeFileSync(path.join(dir, 'dot1.s'), DOT1);
  fs.writeFileSync(path.join(dir, 'dot4.s'), DOT4);
  const run = (...args) => spawnSync(process.execPath, [BIN, 'diff', ...args], { cwd: dir, encoding: 'utf8' });
  const j = run('dot1.s', 'dot4.s', '-per', '32', '-json');
  assert.equal(j.status, 0, j.stderr);
  const r = JSON.parse(j.stdout);
  assert.equal(r.speedup, 4);
  const t = run('dot1.s', 'dot4.s', '-per', '32');
  assert.equal(t.stdout, `A: dot1.s\nB: dot4.s\n${diffText(r)}`);
  assert.match(t.stdout, /^SKL: A 16\.00 {2}B 4\.00 cycles per iteration {2}\(-12\.00, -75\.0%; speedup 4\.00x\)$/m);
  const md = run('dot1.s', 'dot4.s', '-per', '32', '-md');
  assert.equal(md.status, 0);
  const file = path.join(HERE, 'golden', 'diff-dot1-dot4.md');
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(file, md.stdout);
  assert.equal(md.stdout, fs.readFileSync(file, 'utf8'));
  // hex for one side; the other side failing: its code; usage errors: 1
  // hex: a loop against a block without a branch is not comparable (one message, once)
  const hex = run('dot1.s', '4801d8');
  assert.equal(hex.status, 1);
  assert.equal(hex.stderr.split('\n').filter((l) => /not comparable/.test(l)).length, 1);
  const hh = run('4801d8', '48 01 d8');
  assert.equal(hh.status, 0);
  assert.match(hh.stdout, /^B: 48 01 d8$/m);
  fs.writeFileSync(path.join(dir, 'bad.s'), 'frob rax\n');
  assert.equal(run('dot1.s', 'bad.s').status, 2);
  for (const args of [['dot1.s'], ['dot1.s', 'dot4.s', '-arch', 'SKL,ZEN3'], ['dot1.s', 'dot4.s', '-md', '-json'], ['dot1.s', 'dot4.s', '-per', '0'], ['dot1.s', 'dot4.s', '-per', 'Infinity'], ['dot1.s', 'dot4.s', '-TPonly']]) {
    const e = run(...args);
    assert.equal(e.status, 1, args.join(' '));
    assert.match(e.stderr, /^wuica diff: (?!diff:)/);
    assert.equal(e.stderr.trim().split("\n").length, 1, `one message: ${e.stderr}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diffMarkdown: the page\'s A–B tables with branch targets as labels', async () => {
  const x = await diffAnalyses(w, 'SKL', REQ);
  const md = diffMarkdown(x);
  assert.match(md, /^\*\*A–B on SKL\*\*\n\n\*\*A 0\.50 · B 0\.13 cycles per element\*\*/);
  assert.match(diffMarkdown(x, { archTitle: 'SKL · Skylake (2015)' }), /^\*\*A–B on SKL · Skylake \(2015\)\*\*/);
  assert.match(md, /`jb loop`/);
  assert.equal(diffMarkdown({ failure: { code: 2, error: 'B: assembly failed' } }), '**diff failed:** B: assembly failed\n');
});
