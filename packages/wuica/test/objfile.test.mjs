// Object files as input (lib/objfile.js; fixtures: tests-js/fixtures/obj, made by its build.sh and build-dup.sh): a .o (ELF or Mach-O),
// a Mach-O executable and llvm-objdump -d of the same file give the same loop and throughput per function on SKL, ZEN3
// and ADL-P; -ffunction-sections objects; -funcs and -func; an arm64 object, COFF and -raw on an object say what to do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWuica } from '../lib/index.js';
import { readObject, resolveFunction } from '../lib/objfile.js';
import { tmpDir } from './tmpdir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../bin/wuica.js');
const OBJ = path.resolve(HERE, '../../../tests-js/fixtures/obj');
const run = (args, input = '') => {
  const r = spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8', cwd: OBJ });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const FUNCS = ['dot', 'psum', 'hist', 'sum_mod', 'walk'];

test('a .o, an executable and objdump -d of them: the same loop and throughput per function on 3 CPUs', () => {
  let n = 0;
  for (const [file, listing] of [['kernels.elf.o', 'kernels.elf.objdump.txt'], ['kernels.macho.o', 'kernels.macho.objdump.txt'], ['kernels.macho.exe', 'kernels.macho.exe.objdump.txt']]) {
    for (const f of FUNCS) {
      const pick = (input) => {
        // (objdump's listing names Mach-O's symbols with their "_"; the object input also takes the name without it)
        const name = input.startsWith('kernels.macho') && input.endsWith('.txt') ? `_${f}` : f;
        const j = JSON.parse(run([input, '-func', name, '-arch', 'SKL,ZEN3,ADL-P', '-json']).out);
        return [j.code, j.loop.name, j.loop.function, j.loop.address, j.loop.alignmentOffset, j.results.map((r) => r.tp)];
      };
      const a = pick(file);
      assert.equal(a[0], 0, `${file} ${f}`);
      assert.deepEqual(a, pick(listing), `${file} ${f}`);
      n++;
    }
  }
  assert.equal(n, 15);
});

test('-ffunction-sections: each .text.NAME laid out at a multiple of 64; -funcs lists them; -func by part of a name', () => {
  const f = run(['kernels.fs.o', '-funcs']);
  assert.match(f.out, /^dot +\.text\.dot +0x0 +196$/m);
  assert.match(f.out, /^psum +\.text\.psum +0x100 +\d+$/m);
  assert.equal(run(['kernels.fs.o', '-func', 'dot', '-TPonly']).out, run(['kernels.elf.o', '-func', 'dot', '-TPonly']).out);
  // (sum_mod's default: its largest loop, the unrolled one, in the same function as its first loop; the first, 21.00, was
  // the default before loop-find.js's defaultLoop)
  assert.equal(run(['kernels.fs.o', '-func', 'mod', '-TPonly']).out.trim(), '72.00');
  assert.match(run(['kernels.elf.o', '-func', 'sum']).err, /func: "sum" is part of 2 function names \(psum, sum_mod\): give one of them/);
  assert.match(run(['kernels.elf.o', '-func', 'nope']).err, /func: "nope" is not a function of the file \(functions: dot, psum, hist, sum_mod, walk\)/);
  assert.equal(run(['kernels.macho.o', '-func', 'dot', '-TPonly']).out.trim(), '32.00'); // _dot
  assert.match(run(['kernels.elf.o', '-func', 'dot']).err, /^analyzed: loop 0x30 \(in dot, address 0x30\)/m);
  assert.match(run(['kernels.elf.o', '-loops']).out, /^ +\d+ +0x3a0 +walk /m);
});

test('a loop with a call: a note; a call to another file is not a branch within the function', () => {
  const r = run(['kernels.elf.o', '-func', 'walk']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Not modelled: calls: the block calls a function \(call 0x[0-9a-f]+\): the call instruction is simulated, the function it calls is not/m);
  assert.match(run(['kernels.elf.o', '-func', 'walk', '-arch', 'SKL,ZEN3']).out, /^SKL .*calls$/m);
});

test('other architectures and formats: what they are and how to get x86-64; -raw on an object; batch with objects', () => {
  const arm = run(['kernels.arm64.o']);
  assert.equal(arm.code, 1);
  assert.match(arm.err, /^wuica: kernels\.arm64\.o: an arm64 Mach-O file: wuica analyzes x86-64 code; compile for x86-64: clang --target=x86_64-linux-gnu -c \(Linux objects\) or clang -arch x86_64 -c \(macOS\)$/m);
  const dir = tmpDir('wuica-obj-');
  const coff = path.join(dir, 'f.obj');
  fs.writeFileSync(coff, Buffer.from([0x64, 0x86, ...new Array(30).fill(0)]));
  assert.match(run([coff]).err, /a COFF object file: not supported yet; disassemble it and pipe the listing \(llvm-objdump -d FILE \| wuica\)/);
  assert.match(run(['-raw', 'kernels.elf.o']).err, /kernels\.elf\.o is an ELF file, not bare machine code: give it without -raw \(wuica kernels\.elf\.o reads ELF and Mach-O object files and executables\)/);
  fs.rmSync(dir, { recursive: true, force: true });
  const b = run(['kernels.elf.o', 'kernels.arm64.o', '../cli/dot.hsw.s', '-TPonly']);
  assert.equal(b.code, 1);
  // (kernels.elf.o: the default stays in dot, the function of the first loop; dot's loop is the larger of its two)
  assert.equal(b.out, 'kernels.elf.o\t32.00\nkernels.arm64.o\terror\n../cli/dot.hsw.s\t32.00\n');
  assert.match(b.err, /^kernels\.arm64\.o: an arm64 Mach-O file/m);
});

test('the library: disassemble() and readObject()', async () => {
  const w = await createWuica();
  const d = w.disassemble(fs.readFileSync(path.join(OBJ, 'kernels.elf.o')), { name: 'kernels.elf.o', func: 'mod' });
  assert.equal(d.code, 0);
  assert.equal(d.func, 'sum_mod');
  assert.deepEqual(d.functions.map((f) => f.name), FUNCS);
  assert.match(d.text, /^0000000000000000 <dot>:$/m);
  const r = await w.analyze('SKL', { source: d.text, func: 'dot' });
  assert.equal(r.tp, 32);
  assert.equal(w.disassemble(fs.readFileSync(path.join(OBJ, 'kernels.arm64.o'))).code, 1);
  assert.equal(readObject(new Uint8Array([1, 2, 3])).error, 'not an object file');
  assert.deepEqual(resolveFunction([{ name: '_dot' }, { name: '_psum' }], 'dot'), { name: '_dot' });
  await w.close();
});

// Repeated names (fixtures dup.*, made by build-dup.sh from dup_a.c, dup_b.c, dup_main.c: two static functions named
// step, each with a cold part step.cold). Before, the text of such a file defined the label step twice and every
// analysis of it failed in the assembler ("symbol 'step' is already defined"), as on any static glibc executable.
test('repeated names: NAME.0xADDR in -funcs and -loops; -func NAME lists them with their addresses; each one by its name', () => {
  const funcs = run(['dup.elf.exe', '-funcs']);
  assert.equal(funcs.code, 0);
  assert.deepEqual(funcs.out.trim().split('\n').slice(1).map((l) => l.split(/\s+/)[0]),
    ['step.cold.0x401000', 'step.cold.0x401006', 'step.0x401020', 'sum_a', 'step.0x4010a0', 'sum_b', 'fail', '_start']);
  const json = JSON.parse(run(['dup.elf.exe', '-funcs', '-json']).out);
  assert.deepEqual(json.functions.find((f) => f.address === 0x401020), { name: 'step.0x401020', section: '.text', address: 0x401020, size: 70, symbol: 'step' });
  assert.equal(json.functions.find((f) => f.name === 'sum_a').symbol, undefined);
  const amb = run(['dup.elf.exe', '-func', 'step']);
  assert.equal(amb.code, 1);
  assert.match(amb.err, /^wuica: func: "step" names 2 functions of the file, at 0x401020 and 0x4010a0 \(static functions of different source files, or parts of one\): give it with its address, -func step\.0x401020 or -func step\.0x4010a0$/m);
  assert.match(run(['dup.elf.exe', '-func', 'step.cold']).err, /func: "step\.cold" names 2 functions of the file, at 0x401000 and 0x401006/);
  // each step: its own loop, in it (the whole file's text no longer fails to assemble)
  for (const [name, address] of [['step.0x401020', 0x401040], ['step.0x4010a0', 0x4010c0]]) {
    const j = JSON.parse(run(['dup.elf.exe', '-func', name, '-arch', 'SKL', '-json']).out);
    assert.equal(j.code, 0, name);
    assert.equal(j.loop.function, name);
    assert.equal(j.loop.address, address);
    assert.equal(j.tp, 2);
  }
  assert.match(run(['dup.elf.exe', '-func', 'step.0x4010a0', '-loops']).out, /^ +0 +0x4010c0 +step\.0x4010a0 +\S+ +8 +1 +auto$/m);
  const loops = run(['dup.elf.exe', '-loops']);
  assert.equal(loops.code, 0);
  assert.match(loops.out, /^ +\d+ +0x401040 +step\.0x401020 /m);
  assert.equal(run(['dup.elf.exe', '-TPonly']).code, 0);
});

test('repeated names in a relocatable object (ld -r), a shared object and a Mach-O executable; a stripped executable', () => {
  assert.match(run(['dup.elf.o', '-funcs']).out, /^step\.cold\.0x100 +\.text\.unlikely +0x100 +6$/m);
  assert.match(run(['dup.elf.o', '-func', 'step']).err, /func: "step" names 2 functions of the file, at 0x0 and 0x80 .*-func step\.0x0 or -func step\.0x80$/m);
  assert.equal(run(['dup.elf.o', '-func', 'step.0x80', '-TPonly']).out.trim(), '2.00');
  assert.equal(run(['dup.elf.so', '-func', 'step.0x10c0', '-TPonly']).out.trim(), '2.00');
  assert.match(run(['dup.elf.so', '-func', 'step.0x10c0']).err, /^analyzed: loop 0x10e0 \(in step\.0x10c0, address 0x10e0\)/m);
  // Mach-O: the names with their "_"; -func takes them without it too
  assert.match(run(['dup.macho.exe', '-func', 'step']).err, /func: "step" names 2 functions of the file, at 0x100000390 and 0x1000003e0 .*-func _step\.0x100000390 or -func _step\.0x1000003e0$/m);
  assert.equal(run(['dup.macho.exe', '-func', '_step.0x1000003e0', '-TPonly']).out, run(['dup.macho.exe', '-func', 'step.0x1000003e0', '-TPonly']).out);
  assert.match(run(['dup.macho.exe', '-func', 'step.0x1000003e0']).err, /^analyzed: loop 0x1000003f0 \(in _step\.0x1000003e0, address 0x1000003f0\)/m);
  // stripped: no symbols at all, the code section is one function
  assert.match(run(['dup.elf.stripped', '-funcs']).out, /^\.text +\.text +0x401000 +\d+\n$/m);
  assert.match(run(['dup.elf.stripped', '-func', 'sum_a']).err, /func: "sum_a" is not a function of the file \(functions: \.text\)/);
  assert.equal(run(['dup.elf.stripped', '-TPonly']).code, 0);
});

test('the library: disassemble() with a repeated name; a long list of functions is cut', async () => {
  const w = await createWuica();
  const bytes = fs.readFileSync(path.join(OBJ, 'dup.elf.exe'));
  const all = w.disassemble(bytes, { name: 'dup.elf.exe' });
  assert.equal(all.code, 0);
  assert.equal(all.text.match(/^[0-9a-f]{16} <[^>]+>:$/gm).length, 8);
  assert.match(all.text, /^0000000000401020 <step\.0x401020>:$/m);
  const one = w.disassemble(bytes, { func: 'step.0x4010a0' });
  assert.equal(one.func, 'step.0x4010a0');
  assert.equal(one.functions.length, 8);
  assert.equal(w.disassemble(bytes, { func: 'step' }).code, 1);
  const many = Array.from({ length: 30 }, (_, k) => ({ name: `f${k}` }));
  assert.match(resolveFunction(many, 'nope').error, /\(functions: f0, f1, .*, f19, and 10 more: -funcs lists them\)$/);
  await w.close();
});
