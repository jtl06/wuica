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
  assert.match(big.error, /alignmentOffset\b.* out of range/);
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
  assert.equal((await w.analyze('SKL', { source: src, loop: 'whole' })).otherLoops, undefined, 'whole: every loop is analyzed');
  assert.deepEqual(w.summarize(r).otherLoops, r.otherLoops);
  assert.deepEqual((await w.compare({ source: src, archs: ['SKL'] })).otherLoops, r.otherLoops);
  // one loop, or machine code: none
  assert.equal((await w.analyze('SKL', { source: 'l:\n dec rcx\n jnz l\n' })).otherLoops, undefined);
  assert.equal((await w.analyze('SKL', { hex: HEX })).otherLoops, undefined);
  assert.equal(listLoops(42).error, '`source` must be assembly text');
  assert.equal((await w.analyze('SKL', { hex: HEX, options: { minCycles: 2 ** 53 } })).error, 'option minCycles: 9007199254740992 is out of range (at most 2^53 - 1 in magnitude)');
});

test('compare with per: cycles per element on each row (as the CLI\'s -arch with -per)', async () => {
  const c = await w.compare({ hex: HEX, archs: ['SKL', 'ZEN3', 'NOPE'], per: 4 });
  assert.equal(c.elementsPerIteration, 4);
  assert.deepEqual(c.results.map((r) => r.perElement), [c.results[0].tp / 4, c.results[1].tp / 4, undefined]);
  assert.equal((await w.compare({ hex: HEX, archs: ['SKL'] })).elementsPerIteration, undefined);
  for (const per of [0, -1, '4']) assert.equal((await w.compare({ hex: HEX, per })).code, 1, String(per));
});

test('source lines: line (and loc from .loc) on each instruction row, instructions[], chain[] and hot.instructions[]', async () => {
  const src = 'f:\n.L1:\n add rax, 1\n dec rcx\n jnz .L1\n ret\n';
  const r = await w.analyze('SKL', { source: src });
  assert.deepEqual(r.rows.map((x) => x.line), [3, 4, 5]);
  const s = w.summarize(r);
  assert.deepEqual(s.instructions.map((x) => x.line), [3, 4, 5]);
  assert.deepEqual(s.insights.chain.map((x) => x.line), [3]);
  assert.ok(s.insights.hot.instructions.every((x) => x.line === r.rows[x.index].line));
  // the whole text, a picked loop of several, .loc directives
  // (a stack-synchronization uop before the ret is not an instruction: no line)
  assert.deepEqual((await w.analyze('SKL', { source: src, loop: 'whole' })).rows.map((x) => x.line), [3, 4, 5, undefined, 6]);
  const two = 'f:\n.L1:\n add rax, 1\n dec rcx\n jnz .L1\n.L2:\n add rbx, 1\n dec rdx\n jnz .L2\n ret\n';
  assert.deepEqual((await w.analyze('SKL', { source: two, loop: 1 })).rows.map((x) => x.line), [7, 8, 9]);
  const loc = '\t.file 1 "sum.c"\nloop:\n\t.loc 1 4 7\n\taddss xmm0, xmm1\n\t.loc 1 3 3\n\tdec rcx\n\tjnz loop\n';
  const l = await w.analyze('SKL', { source: loc });
  assert.deepEqual(l.rows.map((x) => [x.line, x.loc]), [[4, 'sum.c:4'], [6, 'sum.c:3'], [7, 'sum.c:3']]);
  assert.deepEqual(w.summarize(l).instructions.map((x) => x.loc), ['sum.c:4', 'sum.c:3', 'sum.c:3']);
  // objdump lines: the line of the text
  const od = fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/profiles/objdump-dS.txt'), 'utf8');
  assert.deepEqual((await w.analyze('SKL', { source: od })).rows.map((x) => x.line), [15, 16, 17, 19, 20, 21]);
  // machine code: none
  const h = await w.analyze('SKL', { hex: HEX });
  assert.ok(h.rows.every((x) => x.line === undefined && x.loc === undefined));
});

test('the what-if variant align: the 64 alignment offsets, only when asked for', async () => {
  const { WHAT_IF_VARIANTS, WHAT_IF_OPT_IN_VARIANTS, whatIfText, markdown, findExample } = await import('../lib/index.js');
  assert.ok(!WHAT_IF_VARIANTS.includes('align') && WHAT_IF_OPT_IN_VARIANTS.includes('align'));
  const src = findExample('saxpy').intel;
  assert.ok(!(await w.whatIf('SKL', { source: src })).variants.some((v) => v.id === 'align'));
  const x = await w.whatIf('SKL', { source: src, variants: ['align'] });
  const v = x.variants[0];
  const tps = [];
  for (let k = 0; k < 64; k++) tps.push((await w.analyze('SKL', { source: src, options: { alignmentOffset: k } })).tp);
  const sorted = [...tps].sort((a, b) => a - b);
  assert.deepEqual(v.alignment, { min: sorted[0], median: Math.round((sorted[31] + sorted[32]) / 2 * 100) / 100, max: sorted[63],
    best: tps.indexOf(sorted[0]), worst: tps.indexOf(sorted[63]), spread: Math.round((sorted[63] - sorted[0]) * 100) / 100, offset: 0 });
  assert.equal(v.tp, v.alignment.median);
  assert.ok(v.alignment.spread > 0, 'saxpy on SKL depends on the alignment');
  assert.match(whatIfText(x), /^ {2}alignment over 64 offsets: min 1\.50 \(offset \d+\), median 1\.50, max 3\.00 \(offset \d+\), spread 1\.50; this block at offset 0$/m);
  assert.match(markdown.whatIfAlignment(x), /\*\*Alignment\*\* over the 64 offsets: min 1\.50/);
  assert.equal((await w.whatIf('SKL', { source: src, variants: ['align'], options: { alignmentOffset: 8 } })).variants[0].alignment.offset, 8);
});

test('profiles: objdump -dS keeps the source lines', async () => {
  const { listLoops } = await import('../lib/index.js');
  // real llvm-objdump -dS output (tests-js/fixtures/profiles/sum.c, clang -O1 -g)
  const od = fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/profiles/objdump-dS.txt'), 'utf8');
  const r = await w.analyze('SKL', { source: od });
  assert.equal(r.loop.function, 'dot');
  assert.deepEqual(r.rows.map((x) => x.source), [...Array(3).fill('s += a[i] * b[i];'), ...Array(3).fill('for (long i = 0; i < n; i++)')]);
  assert.deepEqual(w.summarize(r).instructions.map((x) => x.source), r.rows.map((x) => x.source));
});

test('profiles, real output (tests-js/fixtures/profiles/make-fixtures.sh): perf annotate --stdio of two hot functions and a nested loop', async () => {
  const { listLoops } = await import('../lib/index.js');
  const pf = fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/profiles/perf-annotate-hot.txt'), 'utf8');
  const p = await w.analyze('SKL', { source: pf });
  assert.equal(p.code, 0, p.error);
  // the hottest loop by its own samples: the inner loop of matvec (0x1400), not the outer loop around it (0x13c0),
  // whose samples with those of the inner loop would be the most
  assert.equal(p.loop.function, 'matvec');
  assert.equal(p.loop.name, 'loop 0x1400');
  assert.equal(p.loop.depth, 2);
  assert.deepEqual(listLoops(pf).filter((l) => l.auto).map((l) => l.label), ['0x1400']);
  // each block's percentages weighted by its header's samples (matvec 1069, count 58, main 20 of 1147), worked out by
  // hand: 1430 at 26.33 % of matvec's 26.33 * 1069 / 1147 = 24.54; 1576 at 18.77 % of count's 18.77 * 58 / 1147 = 0.95
  const cmp = p.rows.find((x) => x.kind === 'instr' && x.samples === 24.54);
  assert.ok(cmp, JSON.stringify(p.rows.map((x) => x.samples)));
  assert.equal(cmp.source, 'for (long c = 0; c < cols; c++)');
  const c = await w.analyze('SKL', { source: pf, loop: listLoops(pf).findIndex((l) => l.label === '0x1500') });
  assert.equal(c.loop.function, 'count');
  assert.ok(c.rows.some((x) => x.samples === 0.95), JSON.stringify(c.rows.map((x) => x.samples)));
  assert.ok(c.rows.some((x) => x.samples === 0.44), '1519 at 8.68 % of count: 0.44');
  assert.ok(!c.rows.some((x) => x.samples > 1), 'no instruction of count has more than 1 % of all the samples');
  // --stdio2 has no addresses: said, not analyzed as something else
  const s2 = await w.analyze('SKL', { source: fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/profiles/perf-annotate-hot-stdio2.txt'), 'utf8') });
  assert.equal(s2.code, 1);
  assert.match(s2.error, /perf annotate --stdio2 output.*use perf annotate --stdio$/);
});

test('profiles, real output: GNU objdump -dS and -dSl, gcc 15 -O2 -g -S (DWARF 5, .file 0, .loc view) in AT&T and Intel syntax', async () => {
  const F = (f) => fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/profiles', f), 'utf8');
  for (const f of ['objdump-dS-hot.txt', 'objdump-dSl-hot.txt']) {
    const r = await w.analyze('SKL', { source: F(f) });
    assert.equal(r.code, 0, `${f}: ${r.error}`);
    assert.equal(r.loop.function, 'matvec', f);
    assert.equal(r.loop.name, 'loop 0x1400', f);
    const instr = r.rows.filter((x) => x.kind === 'instr');
    assert.deepEqual([...new Set(instr.map((x) => x.source))], ['s += m[r * cols + c] * v[c];', 'for (long c = 0; c < cols; c++)'], f);
  }
  const hex = (await w.analyze('SKL', { source: F('objdump-dS-hot.txt') })).hex;
  for (const f of ['gcc-hot-att.s', 'gcc-hot-intel.s']) {
    const text = F(f);
    assert.match(text, /^\t\.file 0 "\." "hot\.c"$/m, `${f}: DWARF 5`);
    assert.equal((await w.assemble(text)).code, 0, f);
    const r = await w.analyze('SKL', { source: text });
    assert.equal(r.code, 0, `${f}: ${r.error}`);
    assert.equal(r.loop.function, 'matvec', f);
    const instr = r.rows.filter((x) => x.kind === 'instr');
    assert.deepEqual([...new Set(instr.map((x) => x.loc))], ['hot.c:11', 'hot.c:10'], `${f}: the loop body, then the loop control`);
    assert.ok(instr.every((x) => Number.isInteger(x.line)), f);
    assert.equal(r.hex, hex, `${f}: the bytes of the binary's loop`);
  }
  // the line directives are not assembled: clang's text, the same bytes without them (gcc's: those of the binary, above)
  for (const f of ['profiles/clang23-sum-g.s', 'asm/dot-clang-O2-g.s']) {
    const text = fs.readFileSync(path.join(ROOT, 'tests-js/fixtures', f), 'utf8');
    const bare = text.replace(/^\t\.(?:loc|file\t?\s*\d+)\b.*$/gm, '');
    const [a, b] = [await w.analyze('SKL', { source: text }), await w.analyze('SKL', { source: bare })];
    assert.equal(a.code, 0, f);
    assert.equal(a.hex, b.hex, f);
  }
});

test('source lines only when the lines are the instructions: .rept, .irp, .if, .macro; .byte; a NUL in a comment', async () => {
  const lines = async (source, o = {}) => (await w.analyze('SKL', { source, ...o })).rows.filter((x) => x.kind === 'instr').map((x) => x.line);
  // an instruction written as bytes: two instructions, one instruction line: no lines (not the jnz's line for the dec)
  assert.deepEqual(await lines('loop:\n .byte 0x48, 0xff, 0xc9\n jnz loop\n'), [undefined, undefined]);
  for (const src of ['loop:\n .rept 2\n add rax, 1\n .endr\n dec rcx\n jnz loop\n', 'loop:\n .irp r, rax, rbx\n add \\r, 1\n .endr\n dec rcx\n jnz loop\n',
    '.if 0\n add rax, 1\n.endif\nloop:\n imul rbx, rbx\n dec rcx\n jnz loop\n', 'x: .rept 2\n nop\n .endr\nloop:\n add rax, 1\n dec rcx\n jnz loop\n']) {
    const r = await w.analyze('SKL', { source: src });
    assert.equal(r.code, 0, `${src}: ${r.error}`);
    assert.ok(r.rows.every((x) => x.line === undefined), src);
    assert.equal(r.loop, undefined, `${src}: the whole text`);
    assert.match(r.stderr.map((l) => l.text).join('\n'), /note: \.(?:rept|irp|if): the text repeats or leaves out lines, so a loop cannot be isolated: the whole text is analyzed/, src);
  }
  // a loop before which a .rept repeats code: the whole text (said), never a wrong loop
  const before = '.rept 2\n nop\n.endr\nf:\n mov eax, 1\nloop:\n add rax, 1\n dec rcx\n jnz loop\n ret\n';
  const r = await w.analyze('SKL', { source: before });
  assert.equal(r.loop, undefined);
  assert.equal(r.rows.filter((x) => x.kind === 'instr').length, 7, 'two nops, mov, the loop, ret');
  // a macro holding a .rept, called in two loops: assembled once each (no "symbol '.Lwuica_0' is already defined")
  const macro = '.macro body\n .rept 2\n add rax, 1\n .endr\n.endm\nf:\nloop:\n body\n dec rcx\n jnz loop\n ret\nloop2:\n body\n dec rdx\n jnz loop2\n';
  const m = await w.analyze('SKL', { source: macro });
  assert.equal(m.code, 0, m.error);
  assert.ok(m.rows.every((x) => x.line === undefined));
  // a NUL in a comment: the comment ends at the line's end, the instructions stay (6.00: the imul chain, three lines on)
  const nul = await w.analyze('SKL', { source: 'loop:\n add rax, 1 # a\x00b\n imul rbx, rbx\n imul rbx, rbx\n dec rcx\n jnz loop\n' });
  assert.equal(nul.code, 0, nul.error);
  assert.equal(nul.tp, 6);
  assert.deepEqual(nul.rows.filter((x) => x.kind === 'instr').map((x) => x.line), [2, 3, 4, 5, 6]);
});

test('clang 23 -S output as is: .prefalign is read as the .p2align clang 22 wrote', async () => {
  // real output of Homebrew clang 23.1.6: clang --target=x86_64-linux-gnu -O2 -S tests-js/fixtures/profiles/sum.c
  const s = fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/profiles/clang23-sum.s'), 'utf8');
  assert.match(s, /^\t\.prefalign\t4, \.Lfunc_end0, nop$/m);
  const r = await w.analyze('SKL', { source: s });
  assert.equal(r.code, 0, r.error);
  assert.equal(r.loop.function, 'dot');
  const p2 = await w.analyze('SKL', { source: s.replace(/\.prefalign\t(\d+).*$/gm, '.p2align $1') });
  assert.equal(r.tp, p2.tp);
  assert.equal(r.hex, p2.hex);
  assert.equal((await w.assemble(s)).code, 0);
  // what follows a ';' stays; after a label; in upper case
  const { stripHints } = await import('../lib/web/assembler.js');
  assert.equal(stripHints('.prefalign 4, .Lend, nop; add rax, 1\n'), '.p2align 4; add rax, 1\n');
  assert.equal(stripHints('x: .prefalign 4, .Lend, nop # c\n'), 'x: .p2align 4# c\n');
  assert.equal(stripHints('\t.PREFALIGN\t5, .Lend, nop\n'), '\t.p2align 5\n');
  const kept = await w.assemble('nop\n.prefalign 4, .Lend, nop; add rax, 1\n.Lend:\n');
  assert.equal(kept.hex, (await w.assemble('nop\n.p2align 4; add rax, 1\n')).hex);
  assert.match(kept.hex, /4883c001$/, 'the add is assembled');
  assert.equal((await w.assemble('nop\nx: .PREFALIGN 4, .Lend, nop\n add rax, 1\n.Lend:\n')).hex, (await w.assemble('nop\nx: .p2align 4\n add rax, 1\n')).hex);
});

test('what-if carries the base\'s decode errors and warnings (also with align)', async () => {
  const { whatIfText, markdown, findExample } = await import('../lib/index.js');
  const x = await w.whatIf('SNB', { source: findExample('dot1').intel, variants: ['unroll2', 'align'] }); // SNB has no FMA
  assert.equal(x.decodeErrors, 4);
  assert.deepEqual(x.stderr.map((l) => l.text), ['Warning: 4 position(s) could not be decoded']);
  assert.match(whatIfText(x), /^ {2}warning: 4 position\(s\) could not be decoded$/m);
  assert.match(markdown.whatIfAlignment(x), /^- Warning: 4 position\(s\) could not be decoded$/m);
  assert.equal(x.variants.find((v) => v.id === 'align').alignment.min, 4, 'written out: 4 cycles at the best offset');
});

test('clang -g -S output (NULs in the .debug_str comments): the library, the CLI and the MCP tool, with lines and .loc', async () => {
  const { mcpTools, callTool } = await import('../lib/mcp.js');
  const { execFileSync } = await import('node:child_process');
  // real clang -O2 -g -S output: clang 22 (dot.c) and clang 23.1.6 (sum.c, -fdebug-prefix-map to /src)
  for (const [file, src] of [['tests-js/fixtures/asm/dot-clang-O2-g.s', 'dot.c'], ['tests-js/fixtures/profiles/clang23-sum-g.s', 'sum.c']]) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(text.includes('\0'), `${file} has NUL characters`);
    assert.equal((await w.assemble(text)).code, 0, file);
    const r = await w.analyze('SKL', { source: text });
    assert.equal(r.code, 0, `${file}: ${r.error}`);
    assert.equal(r.loop.function, 'dot');
    const instr = r.rows.filter((x) => x.kind === 'instr');
    assert.ok(instr.every((x) => Number.isInteger(x.line) && /^(dot|sum)\.c:[34]$/.test(x.loc)), file);
    assert.deepEqual([...new Set(instr.map((x) => x.loc))], [`${src}:4`, `${src}:3`], 'written out: the loop body, then the loop control');
    const cli = JSON.parse(execFileSync(process.execPath, [path.join(DIR, 'bin/wuica.js'), path.join(ROOT, file), '-json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    assert.equal(cli.tp, r.tp, `${file}: the CLI`);
    const m = await callTool(mcpTools(w), 'analyze', { source: text, format: 'json' });
    assert.ok(!m.isError, `${file}: the MCP tool`);
    assert.deepEqual(JSON.parse(m.content[0].text).instructions.map((x) => x.loc), instr.map((x) => x.loc));
  }
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
    assert.match(r.error, /^option \w+: .* (is not (an integer|true or false)|is out of range \(at most 2\^53 - 1 in magnitude\))$/);
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
