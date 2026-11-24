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
  // per [A, B]: each side's own
  assert.equal((await w.diff('SKL', { ...REQ, per: [8, 32] })).perElement.a, 2);
});

test('diff: failures say which side; bad requests are code 1', async () => {
  const b = await w.diff('SKL', { a: { source: DOT1 }, b: { source: 'frob rax' } });
  assert.equal(b.code, 2);
  assert.match(b.error, /^B: assembly failed/);
  for (const bad of [{}, { a: { source: DOT1 } }, { a: 1, b: { hex: '4801d8' } }, { ...REQ, per: 0 }, { ...REQ, per: [1] }, { ...REQ, bogus: 1 }]) {
    assert.equal((await w.diff('SKL', bad)).code, 1, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await w.diff('NOPE', REQ)).code, 1);
});

test('the MCP tool diff_blocks gives the library\'s result', async () => {
  const tools = mcpTools(w);
  const r = await callTool(tools, 'diff_blocks', { arch: 'SKL', ...REQ });
  assert.deepEqual(JSON.parse(r.content[0].text), await w.diff('SKL', REQ));
  const e = await callTool(tools, 'diff_blocks', { arch: 'SKL', a: { source: DOT1 }, b: { source: 'frob rax' } });
  assert.equal(e.isError, true);
  const bad = await callTool(tools, 'diff_blocks', { a: { source: DOT1 } });
  assert.match(bad.content[0].text, /^Invalid arguments for tool diff_blocks: b: required/);
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
  const hex = run('dot1.s', '4801d8');
  assert.equal(hex.status, 0);
  assert.match(hex.stdout, /^B: 4801d8$/m);
  fs.writeFileSync(path.join(dir, 'bad.s'), 'frob rax\n');
  assert.equal(run('dot1.s', 'bad.s').status, 2);
  for (const args of [['dot1.s'], ['dot1.s', 'dot4.s', '-arch', 'SKL,ZEN3'], ['dot1.s', 'dot4.s', '-md', '-json'], ['dot1.s', 'dot4.s', '-per', '0']]) {
    const e = run(...args);
    assert.equal(e.status, 1, args.join(' '));
    assert.match(e.stderr, /^wuica diff: /);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diffMarkdown: the page\'s A–B tables with branch targets as labels', async () => {
  const x = await diffAnalyses(w, 'SKL', REQ);
  const md = diffMarkdown(x);
  assert.match(md, /^\*\*A 0\.50 · B 0\.13 cycles per element\*\*/);
  assert.match(md, /`jb loop`/);
  assert.equal(diffMarkdown({ failure: { code: 2, error: 'B: assembly failed' } }), '**diff failed:** B: assembly failed\n');
});
