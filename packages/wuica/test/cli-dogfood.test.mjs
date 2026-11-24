// The CLI against the first-time-user dogfood of 0.1.6 (clang -S output in AT&T, objdump, mistakes): syntax detection,
// a closed pipe, decode failures in tables, loop listing and choice, wrong kinds of input, exit codes, flags, the
// diagnosis, -whatif and -per. Fixtures: tests-js/fixtures/cli (clang 17 -O3 -march=haswell).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, binaryFormat, inductionSteps } from '../lib/cli.js';
import { detectSyntax } from '../lib/web/loop-find.js';
import { tmpDir } from './tmpdir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../bin/wuica.js');
const MCP_BIN = path.resolve(HERE, '../bin/wuica-mcp.js');
const FX = path.resolve(HERE, '../../../tests-js/fixtures/cli');
const fx = (n) => path.join(FX, n);
const run = (args, input = '', bin = BIN) => {
  const r = spawnSync(process.execPath, [bin, ...args], { input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const sh = (cmd) => spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
const W = `"${process.execPath}" "${BIN}"`;

test('1. AT&T is detected (clang -S, objdump), said on stderr; -intel / -att force it', () => {
  assert.equal(detectSyntax('\taddq\t$8, %rcx\n'), 'att');
  assert.equal(detectSyntax('  add rcx, 8\n  vmovups ymm0, ymmword ptr [rdi]\n'), 'intel');
  assert.equal(detectSyntax('.intel_syntax noprefix\n  add rcx, 8\n'), 'intel');
  assert.equal(detectSyntax('\t.att_syntax\n  nop\n'), 'att');
  const r = run([fx('dot.hsw.s')]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /^analyzed: loop \.LBB0_9 \(lines 28-47, in dot\), AT&T syntax \(detected\);/m);
  assert.match(r.out, /^Throughput \(in cycles per iteration\): 32\.00$/m);
  const intel = run([fx('dot.hsw.intel.s'), '-TPonly']);
  assert.equal(intel.out, '32.00\n');
  assert.match(intel.err, /Intel syntax \(detected\)/);
  const forced = run([fx('dot.hsw.s'), '-intel']);
  assert.equal(forced.code, 2);
  const att = run([fx('dot.hsw.s'), '-att', '-TPonly']);
  assert.match(att.err, /AT&T syntax;/);
  // objdump of the object (AT&T) on stdin
  const od = fs.readFileSync(path.resolve(HERE, '../../../tests-js/fixtures/loop-find/psum.att'), 'utf8');
  assert.equal(run(['-TPonly'], od).code, 0);
});

test('2. a closed pipe: no stack trace, the exit status is the result\'s code', () => {
  for (let k = 0; k < 4; k++) {
    const ok = sh(`${W} "${fx('dot.hsw.s')}" -json -trace | head -c 10; echo " \${PIPESTATUS[0]}"`);
    assert.match(ok.stdout, / 0\n$/);
    assert.doesNotMatch(ok.stderr, /EPIPE|node:events/);
    const bad = sh(`printf '.L1:\\n  vfmad231ps ymm0, ymm1, ymmword ptr [rdi]\\n  jnz .L1\\n' | ${W} 2>&1 | head -1 >/dev/null; echo \${PIPESTATUS[1]}`);
    assert.equal(bad.stdout, '2\n');
  }
});

test('3. a table marks a CPU that could not decode some instructions, in text and JSON', () => {
  const r = run([fx('dot.hsw.s'), '-arch', 'SNB,SKL']);
  // (not a result for SNB: the reason first, web/caveats.js cannotRun, from the analyzed text: FMA)
  // (and no bottleneck for it: a struck result has no diagnosis)
  assert.match(r.out, /^SNB\s+Sandy Bridge\s+2011\s+5\.00\*\s+-\s+not a result: needs FMA; 8 undecodable \(left out\)$/m);
  assert.match(r.err, /Warning: SNB: 8 position\(s\) could not be decoded/);
  const j = JSON.parse(run([fx('dot.hsw.s'), '-arch', 'SNB,SKL', '-json']).out);
  assert.equal(j.results[0].decodeErrors, 8);
  assert.equal(j.results[0].unsupported, 'needs FMA');
  assert.equal(j.results[1].unsupported, undefined);
  assert.ok(j.stderr.some((l) => /SNB: 8 position/.test(l.text)));
});

test('3b. code a CPU cannot run (AVX-512 on SKL, ZEN3): not a result in text, Markdown, JSON (a flag), diff; the numbers as they are', () => {
  const avx = path.resolve(FX, '../dogfood/avx512.s');
  const t = run([avx, '-arch', 'SKL,ZEN3,ICL']);
  // (no bottleneck, no caveats for it: they would describe rows that are not that code)
  assert.match(t.out, /^SKL\s+Skylake\s+2015\s+38\.00\*\s+-\s+not a result: needs AVX-512; 12 undecodable \(left out\)$/m);
  // ZEN3 decodes the zmm instructions but has no data for them: marked as SKL is
  assert.match(t.out, /^ZEN3\s+AMD Zen 3\s+2020\s+3\.00\*\s.*not a result: needs AVX-512;/m);
  assert.match(t.out, /^ICL\s+Ice Lake client\s+2019\s+4\.00\s/m);
  const j = JSON.parse(run([avx, '-arch', 'SKL,ZEN3,ICL', '-json']).out);
  assert.deepEqual(j.results.map((r) => [r.arch, r.tp, r.unsupported ?? null]), [['SKL', 38, 'needs AVX-512'], ['ZEN3', 3, 'needs AVX-512'], ['ICL', 4, null]]);
  assert.ok(j.results.every((r) => !('xLabels' in r)));
  const one = JSON.parse(run([avx, '-arch', 'ZEN3', '-json']).out);
  assert.equal(one.tp, 3);
  assert.equal(one.unsupported, 'needs AVX-512');
  const zt = run([avx, '-arch', 'ZEN3']).out;
  assert.match(zt, /^Not a result for ZEN3: needs AVX-512/m);
  assert.doesNotMatch(zt, /^(?:Not modelled|Next limit|Bottleneck: unknown \(nearest)/m);
  assert.match(run([avx, '-arch', 'ZEN3', '-md']).out, /^\*\*~~3\.00~~ cycles\/iteration\*\* \(not a result: needs AVX-512\)/m);
  // a gap in the tables (x87 tbyte loads: the note X, accepted by every decoder) is not "cannot run": a note, the result stands
  const ld = path.resolve(FX, '../dogfood/ldouble.s');
  assert.match(run([ld, '-arch', 'SKL,ZEN3']).out, /^SKL\s+Skylake\s+2015\s+1\.00\s+.*2 without data \(cost left out\)$/m);
  const lj = JSON.parse(run([ld, '-arch', 'SKL,ZEN3', '-json']).out);
  assert.deepEqual(lj.results.map((r) => [r.arch, r.unsupported ?? null, r.noData ?? null, 'xOps' in r]), [['SKL', null, 2, false], ['ZEN3', null, 2, false]]);
  assert.match(run([ld, '-arch', 'SKL']).out, /^2 instructions without data \(not in the instruction tables\): the throughput leaves their cost out$/m);
  // what-if of a base SKL cannot run: once, no variants (text, -TPonly, JSON)
  const wt = run([avx, '-arch', 'SKL', '-whatif']).out;
  assert.match(wt, /^What if \(SKL\): not a result: needs AVX-512 .*: no variants$/m);
  assert.doesNotMatch(wt, /accumulators|unroll ×/);
  assert.match(run([avx, '-arch', 'SKL', '-whatif', '-TPonly']).out, /^what-if: not a result: needs AVX-512$/m);
  const wj = JSON.parse(run([avx, '-arch', 'SKL', '-whatif', '-json']).out).whatIf.SKL;
  assert.deepEqual([wj.unsupported, wj.variants.length, wj.tp], ['needs AVX-512', 0, 38]);
  const dj = JSON.parse(run(['diff', avx, avx, '-arch', 'SKL', '-json']).out);
  assert.deepEqual([dj.verdict, 'speedup' in dj, 'delta' in dj], ['not comparable', false, false]);
  const d = run(['diff', avx, avx, '-arch', 'SKL']);
  assert.match(d.out, /^SKL: A 38\.00 {2}B 38\.00 cycles per iteration {2}\(not comparable: A needs AVX-512, B needs AVX-512\)$/m);
});

test('4. -loops, -loop LABEL, -func; the deepest loop first (clang notes); 0-based indices', () => {
  const ls = run(['-loops', fx('count_u8.hsw.s')]);
  assert.match(ls.out, /^ {2}0 {2}\.LBB0_12 {2}count_byte {2}87-99 +11 +2 {2}auto$/m);
  assert.match(ls.out, /^ {2}3 {2}\.LBB0_4 +count_byte {2}39-142 +79 +1 *$/m);
  const auto = run([fx('count_u8.hsw.s'), '-TPonly']);
  assert.match(auto.err, /analyzed: loop \.LBB0_12 .*; 3 other loops: -loops lists them/);
  assert.match(run([fx('count_u8.hsw.s'), '-loop', '.LBB0_8', '-TPonly']).err, /analyzed: loop \.LBB0_8 \(lines 134-141/);
  assert.match(run([fx('count_u8.hsw.s'), '-loop', 'LBB0_8', '-TPonly']).err, /analyzed: loop \.LBB0_8/);
  const nine = run([fx('count_u8.hsw.s'), '-loop', '9']);
  assert.equal(nine.code, 1);
  assert.match(nine.err, /0-based; the text has 4: 0 to 3/);
  assert.match(run(['-h']).out, /index \(0-based/);
  const j = JSON.parse(run(['-loops', '-json', fx('divmod.hsw.s')]).out);
  assert.deepEqual(j.loops.map((l) => [l.label, l.function, l.auto]), [['.LBB0_7', 'sum_mod', true], ['.LBB0_13', 'sum_mod', false]]);
  assert.match(run([fx('divmod.hsw.s'), '-func', 'sum_mod', '-loop', '1', '-TPonly']).err, /analyzed: loop \.LBB0_13/);
  assert.match(run([fx('divmod.hsw.s'), '-func', 'nope']).err, /func: "nope" is not a label/);
});

test('5. wrong kinds of input: object files, text with -raw, missing files, a hex argument, AArch64', () => {
  const elf = run(['-raw', fx('count.hsw.o')]);
  assert.equal(elf.code, 1);
  assert.match(elf.err, /is an ELF file, not bare machine code: give it without -raw \(wuica .* reads ELF and Mach-O object files and executables\)/);
  assert.equal(binaryFormat(Buffer.from('cffaedfe', 'hex')), 'a Mach-O file');
  assert.equal(binaryFormat(Buffer.from('!<arch>\n')), 'an archive (.a)');
  assert.equal(binaryFormat(Buffer.from('4801d8', 'hex')), null);
  const txt = run(['-raw', fx('dot.c'), '-TPonly']);
  assert.match(txt.err, /looks like text, not machine code/);
  const miss = run(['nope.bin']);
  assert.equal(miss.code, 1);
  assert.match(miss.err, /^wuica: no such file: nope\.bin$/m);
  assert.deepEqual(JSON.parse(run(['-raw', 'nope.bin', '-json']).out).code, 1);
  assert.match(run([FX]).err, /is a directory/);
  const beef = run(['beef', '-TPonly']);
  assert.match(beef.err, /analyzed: 2 bytes of machine code from the argument "beef" \(not a file\)/);
  const arm = run([fx('dot.arm64.s')]);
  assert.equal(arm.code, 2);
  assert.equal(arm.err.trim().split('\n').length, 1);
  assert.match(arm.err, /this looks like AArch64 assembly; wuica analyzes x86-64/);
  // many errors: the first 10, then a count
  const many = run([], Array.from({ length: 30 }, (_, k) => `frob${k} rax`).join('\n') + '\n');
  assert.match(many.err, /… and 20 more errors\n$/);
  assert.equal((many.err.match(/error: invalid instruction mnemonic/g) ?? []).length, 10);
});

test('6. exit status and JSON code agree; an unknown arch is rejected before stdin is read', () => {
  const r = run([fx('dot.hsw.s'), '-arch', 'SKL,FOO', '-json']);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).code, 1);
  const t0 = Date.now();
  const s = spawnSync(process.execPath, [BIN, '-arch', 'intel.s'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
  assert.equal(s.status, 1);
  assert.match(s.stderr, /unknown microarchitecture: intel\.s/);
  assert.ok(Date.now() - t0 < 20000);
});

test('7. flags: --version, --long spellings, =values, case-insensitive; -trace without -json; file names in diagnostics; wuica-mcp --help', () => {
  assert.match(run(['--version']).out, /^wuica \d+\.\d+\.\d+\n$/);
  assert.equal(run(['-v']).out, run(['--version']).out);
  assert.equal(run([fx('dot.hsw.s'), '--tponly', '--arch=zen3']).out, '32.00\n');
  assert.equal(run([fx('dot.hsw.s'), '-TPONLY', '--ARCH', 'skl']).out, '32.00\n');
  assert.deepEqual(parseArgs(['--json', '--loop=.LBB0_12', '-per=8']).loop, '.LBB0_12');
  assert.match(run([fx('dot.hsw.s'), '-trace', '-TPonly']).err, /-trace: shown only with -json/);
  const typo = path.join(tmpDir('wuica-'), 'typo.s');
  fs.writeFileSync(typo, '.L1:\n  frob rax\n  jnz .L1\n');
  assert.match(run([typo]).err, new RegExp(`^${typo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:2:3: error: invalid instruction mnemonic 'frob'`, 'm'));
  assert.match(run(['--help'], '', MCP_BIN).out, /^Usage: wuica-mcp/);
  assert.match(run(['--version'], '', MCP_BIN).out, /^wuica-mcp \d/);
});

test('8. the diagnosis after the report: the nearest limit, the next one, the caveats; a notes column', () => {
  const r = run([fx('count_u8.hsw.s'), '-loop', '0']);
  assert.match(r.out, /^Bottleneck: unknown \(nearest Issue 3\.50; 0\.50 cycles\/iteration no single limit explains\)$/m);
  const h = run([fx('hist.hsw.s')]);
  assert.match(h.out, /^Next limit: Issue 8\.50 \(at most 1\.41x faster without Ports\)$/m);
  assert.match(h.out, /^Not modelled: store forwarding: a read-modify-write to an indexed address/m);
  assert.doesNotMatch(run([fx('hist.hsw.s'), '-TPonly']).out, /Not modelled/);
  const t = run([fx('hist.hsw.s'), '-arch', 'SKL,ZEN3']);
  assert.match(t.out, /^SKL .*Ports\s+store forwarding$/m);
});

test('9. -whatif: the variants per CPU; accumulators on clang\'s dot (the chain reloaded through xmm0-xmm2)', () => {
  const r = run([fx('dot.hsw.s'), '-whatif']);
  assert.match(r.out, /^What if \(SKL\), cycles per original iteration \(base 32\.00\):$/m);
  assert.match(r.out, /^ {2}2 accumulators +16\.00 +-16\.00 +2\.00x$/m);
  assert.match(r.out, /^ {2}best number of accumulators: \d$/m);
  const p = run([fx('psum.hsw.s'), '-whatif', '-arch', 'SKL,ZEN3']);
  assert.match(p.out, /What if \(SKL\)[\s\S]*What if \(ZEN3\)/);
  assert.match(p.out, /2 accumulators +- +rcx's running value is also read off the chain \(mov qword ptr \[rdi\+rdx\*8\], rcx\): it cannot be split/);
  const j = JSON.parse(run([fx('dot.hsw.s'), '-whatif', '-json']).out);
  assert.equal(j.whatIf.SKL.variants.find((v) => v.id === 'acc2').tp, 16);
});

test('10. -per N: cycles per element in text and JSON; the induction step as a hint', () => {
  const r = run([fx('dot.hsw.s'), '-per', '8']);
  assert.match(r.out, /^Per element: 4\.00 cycles \(32\.00 cycles\/iteration, 8 elements per iteration\)$/m);
  assert.equal(run([fx('dot.hsw.s'), '-per', '8', '-TPonly']).out, '32.00 4.00\n');
  assert.equal(JSON.parse(run([fx('dot.hsw.s'), '-per', '8', '-json']).out).perElement, 4);
  const t = run([fx('dot.hsw.s'), '-per', '8', '-arch', 'SKL,ZEN3', '-json']);
  assert.deepEqual(JSON.parse(t.out).results.map((x) => x.perElement), [4, 4]);
  assert.match(run([fx('dot.hsw.s')]).err, /^step: rcx \+= 8 per iteration \(index; ×4 bytes in \[rdi\+rcx\*4\]\); -per N \(N elements per iteration\): cycles per element$/m);
  assert.deepEqual(inductionSteps({ mode: 'loop', rows: [{ kind: 'instr', label: 'add rax, qword ptr [rdi+rcx*8]' }, { kind: 'instr', label: 'add rcx, 0x4' }, { kind: 'instr', label: 'cmp rcx, rdx' }] }), ['rcx += 4 per iteration (index; ×8 bytes in [rdi+rcx*8])']);
});
