// How the library reads assembly (as the web page does: web/js/loop-find.js, asm-regions.js): the loop of a whole
// function (`loop`), objdump lines and their alignment, exits as not taken, ';' comments; the CLI's -loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWuica, insights } from '../lib/index.js';
import { tmpDir } from './tmpdir.mjs';

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
  assert.deepEqual(fn.loop, { index: 0, count: 1, name: 'loop .L3', line: 23, endLine: 28, lines: [24, 25, 26, 27, 28], function: 'crc_a', depth: 1, instructions: 5 });
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
  assert.deepEqual(r.loop, { index: 0, count: 1, name: 'loop 0x10', line: 14, endLine: 18, lines: [14, 15, 16, 17, 18], function: 'psum', depth: 1, instructions: 5, address: 16, alignmentOffset: 16 });
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
  // what does not assemble after ';' is a comment (a note if it starts with a mnemonic); what does is assembled, with a note
  const typo = await w.assemble('add rax, rbx ; addd rax, 1');
  assert.equal(typo.code, 0);
  assert.equal(typo.hex, '4801d8');
  const mn = await w.assemble('add rax, rbx ; add the next element');
  assert.equal(mn.hex, '4801d8');
  assert.match(mn.stderr[0].text, /note: text after ';' taken as a comment/);
  const sep = await w.analyze('SKL', { source: '.L1:\n add rax, [rdi]\n add rdi, 8 ; call helper\n dec rcx\n jnz .L1\n' });
  assert.equal(sep.code, 0);
  assert.ok(sep.stderr.some((l) => l.tag?.text === "';' separates statements: 'call helper' was assembled (use # for a comment)"), JSON.stringify(sep.stderr));
  // an assembly error keeps llvm-mc's lines (the source line and the caret)
  const e = await w.analyze('SKL', { source: 'nop\nfrobnicate rax\n' });
  assert.deepEqual(e.stderr.map((l) => l.text), ["<input>:2:1: error: invalid instruction mnemonic 'frobnicate'", 'frobnicate rax', '^~~~~~~~~~']);
});

test('CRLF line ends: objdump and assembly, in analyze and assemble', async () => {
  const r = await w.analyze('SKL', { source: fx('psum.objdump').replace(/\n/g, '\r\n') });
  assert.equal(r.code, 0);
  assert.equal(r.loop.name, 'loop 0x10');
  assert.equal(r.loop.alignmentOffset, 16);
  assert.equal((await w.assemble('add rax, rbx ; sum\r\ndec rcx\r\n')).hex, '4801d848ffc9');
});

test('loop "whole" never picks; a bare snippet ending in ret is analyzed as typed', async () => {
  const ab = await w.analyze('SKL', { source: 'a: add rax, 1\nb: dec rcx\n   jnz a\n' });
  assert.equal(ab.hex, '4883c00148ffc975f7');
  const bare = await w.analyze('SKL', { source: 'add rax, 1\nret\n' });
  assert.equal(bare.hex, '4883c001c3');
  assert.equal(bare.loop, undefined);
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
  assert.throws(() => run('-loop', 'inner', file), /loop: "inner" is not the label of a loop \(the loops: \.L3\)/);
  // a file with CRLF line ends
  const crlf = path.join(tmpDir('wuica-cli-'), 'crc_a.s');
  fs.writeFileSync(crlf, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(json(crlf).loop.name, 'loop .L3');
});

test('insights.binding is the response\'s bottlenecks; with none, `largest` is the nearest limit', async () => {
  // the dogfood scan loop on ZEN3: uiCA names no bottleneck (the page says "unknown · nearest Ports 1.50")
  const scan = '.L:\n add rdx, 32\n cmp rdx, rsi\n jae .Lout\n vpcmpeqb ymm0, ymm1, [rdi+rdx]\n vpmovmskb ecx, ymm0\n test ecx, ecx\n je .L\n';
  const a = w.summarize(await w.analyze('ZEN3', { source: scan }));
  assert.deepEqual(a.bottlenecks, []);
  assert.deepEqual(a.insights.binding, []);
  assert.deepEqual(a.insights.largest, ['Ports']);
  assert.equal(a.insights.hot.resource, 'Ports');
  // div on ZEN3: the Divider (a bottleneck without a limit of its own) is the binding one, its share from the Div column
  const d = w.summarize(await w.analyze('ZEN3', { source: '.L2:\n mov eax, [rdi]\n xor edx, edx\n div ecx\n mov [rsi], eax\n add rdi, 4\n add rsi, 4\n cmp rdi, r8\n jne .L2\n' }));
  assert.deepEqual(d.bottlenecks, ['Divider']);
  assert.deepEqual(d.insights.binding, ['Divider']);
  assert.equal(d.insights.largest, undefined);
  assert.equal(d.insights.hot.resource, 'Divider');
  assert.equal(d.insights.hot.instructions[0].instr, 'div ecx');
  assert.equal(d.insights.next.limit, 'Ports');
});

test('insights.caveats: the known blind spots the block meets', async () => {
  const hist = w.summarize(await w.analyze('ZEN3', { source: '.L:\n movzx edx, byte ptr [rdi]\n inc dword ptr [rsp+rdx*4]\n inc rdi\n cmp rdi, rsi\n jne .L\n' }));
  assert.deepEqual(hist.insights.caveats.map((c) => [c.id, c.instructions]), [['rmw-index', [1]]]);
  assert.match(hist.insights.caveats[0].title, /not modelled/);
  // split loads: SKL's model has no split-load cost (they warn); ZEN3's charges them where the address advances by an
  // immediate (FIR: add rax, 0x20), and warns only for a load it cannot follow (a pointer chase)
  const firSource = fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/caveats/fir8.s'), 'utf8');
  const fir = w.summarize(await w.analyze('SKL', { source: firSource }));
  assert.equal(fir.insights.caveats[0].id, 'split');
  assert.equal(fir.insights.caveats[0].instructions.length, 7);
  const firZen = await w.analyze('ZEN3', { source: firSource });
  assert.equal(w.summarize(firZen).insights.caveats, undefined);
  assert.equal(w.insights(firZen).caveats, undefined);
  assert.equal(insights(firZen).caveats[0].id, 'split', 'the bare function without a configuration: as without a split-load cost');
  const chase = w.summarize(await w.analyze('ZEN3', { source: '.L:\n vaddps ymm0, ymm0, ymmword ptr [rdi+0x4]\n mov rdi, qword ptr [rdi+0x40]\n test rdi, rdi\n jne .L\n' }));
  assert.deepEqual(chase.insights.caveats.map((c) => [c.id, c.instructions]), [['split', [0]]]);
  assert.match(chase.insights.caveats[0].title, /rdi is written otherwise here/);
  // saxpy: a load and a store to [rsi+rax*4] with rax advanced by 8 each iteration is not a store-forwarding case
  for (const arch of ['SKL', 'ZEN3']) {
    const sx = w.summarize(await w.analyze(arch, { source: fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/caveats/saxpy.s'), 'utf8') }));
    assert.equal(sx.insights.caveats, undefined, arch);
  }
  const plain = w.summarize(await w.analyze('SKL', { source: CRC_LOOP }));
  assert.equal(plain.insights.caveats, undefined);
});
