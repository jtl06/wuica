// The CLI against the retest of 0.1.7 (N1-N8): a branch inside the picked loop (both paths), an ambiguous -loop label,
// -whatif with -TPonly and -per, the step's unit, small per-element values, one JSON shape for one CPU and several, the
// table's columns and footnote, syntax hints; `wuica mcp --help`; the uiCA commit of `--version -json`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inductionSteps } from '../lib/cli.js';
import { createWuica } from '../lib/index.js';
import { mcpTools, callTool } from '../lib/mcp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const BIN = path.resolve(HERE, '../bin/wuica.js');
const fx = (n) => path.join(ROOT, 'tests-js/fixtures/cli', n);
const run = (args, input = '') => {
  const r = spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('N1. a branch inside the picked loop: "both paths" in text, JSON, the table, MCP; not for a plain loop', async () => {
  const r = run([fx('divmod.hsw.s')]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Not modelled: both paths: both sides of the branch at line 46 \(jnz\) are simulated, one after the other; a real iteration takes one, so the cycles per iteration \(and the step\) count both\. To analyze one side, put # wuica-begin and # wuica-end around it$/m);
  assert.match(r.out, /^Not modelled: exit mispredict:/m); // the je to .LBB0_11 is an exit: its own caveat
  const j = JSON.parse(run([fx('divmod.hsw.s'), '-json']).out);
  assert.deepEqual(j.insights.caveats.map((c) => [c.id, c.instructions]), [['paths', [10]], ['exit', [5]]]);
  assert.match(run([fx('divmod.hsw.s'), '-arch', 'SKL,ZEN3']).out, /^SKL .* both paths; exit mispredict$/m);
  assert.doesNotMatch(run([fx('dot.hsw.s')]).out, /both paths/);
  // MCP: the analyze tool's summary
  const w = await createWuica();
  const out = await callTool(mcpTools(w), 'analyze', { source: fs.readFileSync(fx('divmod.hsw.s'), 'utf8'), arch: 'SKL', format: 'json' });
  const caveats = JSON.parse(out.content[0].text).insights.caveats;
  assert.equal(caveats[0].id, 'paths');
  assert.match(caveats[0].title, /at line 46/);
  // region markers around one side: no caveat (the 32-bit side, lines 41-55 of the dogfood)
  const lines = fs.readFileSync(fx('divmod.hsw.s'), 'utf8').split('\n');
  const marked = [...lines.slice(0, 40), '# wuica-begin', ...lines.slice(40, 55), '# wuica-end', ...lines.slice(55)].join('\n');
  const m = run(['-', '-TPonly'], marked);
  assert.equal(m.code, 0, m.err);
  assert.doesNotMatch(run(['-'], marked).out, /both paths/);
  await w.close();
});

test('N3. -loop LABEL naming loops in several functions: an error with the candidates, unless -func picks', () => {
  const r = run([fx('duplabel.s'), '-loop', '1b']);
  assert.equal(r.code, 1);
  assert.equal(r.err, 'loop: "1b" names 2 loops (0 in fa, 1 in fb): -func NAME or -loop N (0-based) picks one\n');
  const f = run([fx('duplabel.s'), '-loop', '1b', '-func', 'fb', '-TPonly']);
  assert.equal(f.code, 0, f.err);
  assert.match(f.err, /^analyzed: loop 1b \(lines 15-19, in fb\)/m);
  assert.equal(run([fx('duplabel.s'), '-loop', '1', '-TPonly']).out, f.out);
});

test('N4/N5. -whatif -TPonly: one "variant cycles" line per variant (per CPU); -per: per element in table, text, JSON', () => {
  const t = run([fx('dot.hsw.s'), '-whatif', '-TPonly']).out.split('\n').filter(Boolean);
  assert.equal(t[0], '32.00');
  assert.ok(t.includes('acc2 16.00') && t.includes('acc8 error') && t.includes('nochain 8.00'), t.join('|'));
  assert.equal(t.length, 12); // the throughput and 11 variants
  assert.ok(run([fx('dot.hsw.s'), '-whatif', '-TPonly', '-per', '8']).out.split('\n').includes('acc2 16.00 2.00'));
  // a variant within sampling of its Ports limit (dot1's 8 accumulators: 3.98 simulated, under 4.00): at the limit,
  // marked ~, as the table shows it (whatif-core.js shownOutcome); the JSON keeps 3.98
  const d = run(['-example', 'dot1', '-whatif', '-TPonly']).out.split('\n');
  assert.ok(d.includes('acc8 ~4.00') && !d.some((l) => /3\.98/.test(l)), d.join('|'));
  assert.ok(run(['-example', 'dot1', '-whatif', '-TPonly', '-per', '8']).out.split('\n').includes('acc8 ~4.00 ~0.50'));
  assert.equal(JSON.parse(run(['-example', 'dot1', '-whatif', '-json']).out).whatIf.SKL.variants.find((v) => v.id === 'acc8').tp, 3.98);
  const m = run([fx('dot.hsw.s'), '-whatif', '-TPonly', '-arch', 'SKL,ZEN3']).out.split('\n').filter(Boolean);
  assert.equal(m.length, 24);
  assert.match(m[0], /^SKL {3}32\.00$/);
  assert.match(m[2], /^SKL {3}unroll4 32\.00$/);
  const p = run([fx('dot.hsw.s'), '-whatif', '-per', '8']).out;
  assert.match(p, /^What if \(SKL\), cycles per element \(8 per original iteration; base 4\.00\):$/m);
  assert.match(p, /^ {2}2 accumulators +2\.00 +-2\.00 +2\.00x$/m);
  const j = JSON.parse(run([fx('dot.hsw.s'), '-whatif', '-per', '8', '-json']).out).whatIf.SKL;
  assert.equal(j.elementsPerIteration, 8);
  assert.equal(j.perElement, 4);
  assert.equal(j.variants.find((v) => v.id === 'acc2').perElement, 2);
});

test('N6. the step says what it counts; per-element values under 0.1 with 3 significant digits', () => {
  assert.match(run([fx('dot.hsw.s')]).err, /^step: rcx \+= 8 per iteration \(index; ×4 bytes in \[rdi\+rcx\*4\]\); -per N \(N elements per iteration\): cycles per element$/m);
  const rows = (...ls) => ({ mode: 'loop', rows: ls.map((label) => ({ kind: 'instr', label })) });
  assert.deepEqual(inductionSteps(rows('vaddps ymm0, ymm0, ymmword ptr [r13+0x20]', 'add r13, 0x40', 'cmp r13, r14', 'jnz 0x0')), ['r13 += 64 per iteration (bytes; the base of [r13+0x20])']);
  assert.deepEqual(inductionSteps(rows('add rax, rbx', 'inc rdi', 'cmp rdi, rsi', 'jnz 0x0')), ['rdi += 1 per iteration (register step)']);
  assert.match(run([fx('dot.hsw.s'), '-per', '512']).out, /^Per element: 0\.0625 cycles \(32\.00 cycles\/iteration, 512 elements per iteration\)$/m);
  assert.equal(run([fx('dot.hsw.s'), '-per', '1024', '-TPonly']).out, '32.00 0.0313\n');
});

test('N7. -json: whatIf keyed by CPU and caveats as objects, for one CPU and several', () => {
  const one = JSON.parse(run([fx('divmod.hsw.s'), '-whatif', '-json']).out);
  const two = JSON.parse(run([fx('divmod.hsw.s'), '-whatif', '-json', '-arch', 'SKL,ZEN3']).out);
  assert.deepEqual(Object.keys(one.whatIf), ['SKL']);
  assert.deepEqual(Object.keys(two.whatIf), ['SKL', 'ZEN3']);
  assert.deepEqual(Object.keys(one.whatIf.SKL).sort(), Object.keys(two.whatIf.SKL).sort());
  assert.deepEqual(one.insights.caveats, two.results[0].caveats);
  assert.deepEqual(Object.keys(two.results[0].caveats[0]), ['id', 'text', 'title', 'instructions']);
});

test('N8. the Bottlenecks column fits its entries; [prototype] only under prototypes; syntax hints', () => {
  const t = run([fx('divmod.hsw.s'), '-arch', 'SKL,ZEN3']).out.split('\n');
  const col = t[0].indexOf('Notes');
  assert.equal(t[1].indexOf('both paths'), col, t.join('\n'));
  assert.equal(t[2].indexOf('both paths'), col);
  assert.match(t.join('\n'), /^\[prototype\]: experimental model/m);
  assert.doesNotMatch(run([fx('dot.hsw.s'), '-arch', 'SKL,HSW']).out, /\[prototype\]/);
  const hint = (f) => { const r = run([fx(f)]); assert.equal(r.code, 2, f); return r.err.trimEnd().split('\n').pop(); };
  assert.equal(hint('mixed.s'), 'hint: the text mixes AT&T (line 3) and Intel (line 2) operands; the assembler reads one syntax per text: -att or -intel (syntax "att" or "intel")');
  assert.equal(hint('intel_dollar_imm.s'), 'hint: line 3 has an AT&T immediate ($) in Intel code: in Intel syntax an immediate has no $ (if the text is AT&T, -att, syntax "att", reads it so)');
  assert.equal(hint('att_in_intel_directive.s'), 'hint: line 3 has AT&T operands (%register or $immediate) but the text is read as Intel; if it is AT&T, -att (syntax "att") reads it so');
  // clang's AT&T forced as Intel: the hint after the count of the errors left out
  assert.match(run([fx('dot.hsw.s'), '-intel']).err, /… and \d+ more errors\nhint: line 9 has AT&T operands/);
});

test('wuica mcp --help / --version; --version -json has the uiCA commit of ci/data-asset.txt', () => {
  assert.match(run(['mcp', '--help']).out, /^Usage: wuica-mcp/);
  assert.match(run(['mcp', '--version']).out, /^wuica-mcp \d+\.\d+\.\d+\n$/);
  assert.equal(run(['mcp', '--bogus']).code, 1);
  const [, commit, branch] = /^uica_commit=([0-9a-f]+) \(([^)]+)\)/m.exec(fs.readFileSync(path.join(ROOT, 'ci/data-asset.txt'), 'utf8'));
  const v = JSON.parse(run(['--version', '-json']).out);
  assert.deepEqual(v.uiCA, { repository: 'https://github.com/jtl06/uiCA', commit, branch });
  assert.equal(v.wuica, JSON.parse(fs.readFileSync(path.join(HERE, '../package.json'), 'utf8')).version);
});
