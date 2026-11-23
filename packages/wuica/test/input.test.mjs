// How the library reads assembly (as the web page does: web/js/loop-find.js, asm-regions.js): the loop of a whole
// function (`loop`), objdump lines and their alignment, exits as not taken, ';' comments; the CLI's -loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWuica } from '../lib/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fx = (name) => fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/loop-find', name), 'utf8');
const CRC_LOOP = '.L3:\n\tcrc32\trax, QWORD PTR [rdi+rdx]\n\tcrc32\trax, QWORD PTR [rdi+8+rdx]\n\tadd\trdx, 16\n\tcmp\trdx, rsi\n\tjb\t.L3\n';
const w = await createWuica();

test('loop: a whole function (gcc -S) is analyzed at its loop; "whole" and an index; bad values', async () => {
  const loop = await w.analyze('ZEN3', { source: CRC_LOOP });
  assert.equal(loop.code, 0);
  assert.equal(loop.loop, undefined); // one loop and nothing else: as it is
  const fn = await w.analyze('ZEN3', { source: fx('crc_a.s') });
  assert.equal(fn.code, 0);
  assert.equal(fn.hex, loop.hex);
  assert.equal(fn.tp, loop.tp);
  assert.deepEqual(fn.loop, { index: 0, count: 1, name: 'loop .L3', line: 23, endLine: 28 });
  const whole = await w.analyze('ZEN3', { source: fx('crc_a.s'), loop: 'whole' });
  assert.equal(whole.code, 0);
  assert.ok(whole.hex.length > fn.hex.length);
  assert.equal(whole.loop, undefined);
  assert.equal((await w.analyze('ZEN3', { source: fx('crc_a.s'), loop: 0 })).hex, fn.hex);
  const bad = await w.analyze('ZEN3', { source: fx('crc_a.s'), loop: 1 });
  assert.equal(bad.code, 1);
  assert.match(bad.error, /loop: 1 is not the index of a loop/);
  assert.equal((await w.analyze('ZEN3', { source: CRC_LOOP, loop: 'inner' })).code, 1);
  assert.equal((await w.analyze('ZEN3', { source: CRC_LOOP, loop: -1 })).code, 1);
  // compare: the same code, the loop in the response
  const c = await w.compare({ source: fx('crc_a.s'), archs: ['SKL', 'ZEN3'] });
  assert.equal(c.code, 0);
  assert.equal(c.hex, fn.hex);
  assert.equal(c.loop.name, 'loop .L3');
  assert.equal(c.results[1].tp, fn.tp);
  // the compact form keeps it
  assert.equal(w.summarize(fn).loop.name, 'loop .L3');
});

test('objdump lines: the loop at its address, and the alignment offset from it unless given', async () => {
  const r = await w.analyze('SKL', { source: fx('psum.noraw'), options: { details: true } });
  assert.equal(r.code, 0);
  assert.equal(r.hex, '0314878914864' + '8ffc04839c175f2');
  assert.deepEqual(r.loop, { index: 0, count: 1, name: 'loop 0x10', line: 14, endLine: 18, address: 16, alignmentOffset: 16 });
  assert.equal(w.summarize(r).instructions[0].frontEnd.offset, 16);
  const given = await w.analyze('SKL', { source: fx('psum.noraw'), options: { details: true, alignmentOffset: 0 } });
  assert.equal(w.summarize(given).instructions[0].frontEnd.offset, 0);
  const att = await w.analyze('SKL', { source: fx('psum.att'), syntax: 'att' });
  assert.equal(att.hex, r.hex);
  const raw = await w.analyze('SKL', { source: fx('psum.objdump') });
  assert.equal(raw.hex, r.hex);
});

test('exits: a jcc to an undefined symbol (.L or not) is a short jump, not taken; a note in stderr', async () => {
  const scan = '.L:\n add rdx, 32\n cmp rdx, rsi\n jae .Lout\n vpcmpeqb ymm0, ymm1, [rdi+rdx]\n vpmovmskb ecx, ymm0\n test ecx, ecx\n je .L\n';
  const a = await w.analyze('SKL', { source: scan });
  assert.equal(a.code, 0);
  assert.match(a.hex, /730d/);
  assert.equal(a.stderr[0].tag.severity, 'note');
  assert.equal(a.stderr[0].tag.line, 4);
  const b = await w.analyze('SKL', { source: scan.replace('.Lout', 'out') });
  assert.equal(b.hex, a.hex); // not a rel32 jump with a relocation
  const j = await w.analyze('SKL', { source: '.L1:\n add rax, 1\n jmp out\n dec rcx\n jnz .L1\n' });
  assert.equal(j.code, 0);
  assert.ok(j.stderr.some((l) => l.tag?.severity === 'warning' && /out is not defined/.test(l.tag.text)));
  // assemble() keeps the text as it is: .Lout stays an error there
  assert.equal((await w.assemble(scan)).code, 2);
});

test("';' comments: at the start of a line and after a statement; a separator stays one", async () => {
  const r = await w.analyze('SKL', { source: '; a loop\ntop: add rax, rbx ; sum\n dec r15; jnz top ; back\n' });
  assert.equal(r.code, 0);
  assert.equal(r.hex, '4801d849ffcf75f8');
  assert.equal((await w.assemble('add rax, rbx ; sum')).hex, '4801d8');
  const typo = await w.assemble('add rax, rbx ; addd rax, 1');
  assert.equal(typo.code, 2);
  assert.match(typo.error, /invalid instruction mnemonic 'addd'/);
  // an assembly error keeps llvm-mc's lines (the source line and the caret)
  const e = await w.analyze('SKL', { source: 'nop\nfrobnicate rax\n' });
  assert.deepEqual(e.stderr.map((l) => l.text), ["<input>:2:1: error: invalid instruction mnemonic 'frobnicate'", 'frobnicate rax', '^~~~~~~~~~']);
});

test('a function without a loop: its body', async () => {
  const r = await w.analyze('SKL', { source: 'f:\n push rbp\n mov rbp, rsp\n mulss xmm0, xmm0\n addss xmm0, xmm1\n pop rbp\n ret\n' });
  assert.equal(r.code, 0);
  assert.equal(r.loop.name, 'body');
  assert.equal(r.rows.filter((x) => x.kind === 'instr').length, 2);
});

test('CLI: -loop', () => {
  const bin = path.join(ROOT, 'packages/wuica/bin/wuica.js');
  const file = path.join(ROOT, 'tests-js/fixtures/loop-find/crc_a.s');
  const run = (...args) => execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const json = (...args) => JSON.parse(run('-json', ...args));
  assert.equal(json(file).loop.name, 'loop .L3');
  assert.equal(json('-loop', 'whole', file).loop, undefined);
  assert.equal(json('-loop', '0', file).loop.index, 0);
  assert.throws(() => run('-loop', 'inner', file), /auto, whole or a number/);
});
