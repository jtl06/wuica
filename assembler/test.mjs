#!/usr/bin/env node
// Tests wuica_asm.wasm against the native assembler: every input is assembled by the WebAssembly module
// and by `llvm-mc -filetype=obj` + `llvm-objcopy -O binary --only-section=.text`, and the bytes must be
// identical. Also prints the module's sizes and timings.
//
//    node test.mjs [--wasm dist/wuica_asm.wasm] [--corpus DIR] [--limit N] [--min-corpus N]
//
// --corpus  directory with s6_NNNN.s files (default: ~/uica-zen/uiCA/zenbench/out_fuzz/holdout2; `*.exe.s` are ignored)
// --limit   use only the first N corpus files (default: all)
// --min-corpus  fail if fewer corpus files than this were compared (default 500)
// Environment: LLVM_MC (default llvm-mc-22), LLVM_OBJCOPY (default llvm-objcopy-22). Needs Node 18 or later.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
   const i = args.indexOf(name);
   return i >= 0 ? args[i + 1] : fallback;
}
const wasmPath = option('--wasm', join(here, 'dist', 'wuica_asm.wasm'));
const corpusDir = option('--corpus', join(homedir(), 'uica-zen/uiCA/zenbench/out_fuzz/holdout2'));
const limit = Number(option('--limit', Infinity));
const minCorpus = Number(option('--min-corpus', 500));
const LLVM_MC = process.env.LLVM_MC || 'llvm-mc-22';
const LLVM_OBJCOPY = process.env.LLVM_OBJCOPY || 'llvm-objcopy-22';
const TRIPLE = 'x86_64-unknown-linux-gnu';
const INTEL = 0, ATT = 1;

// ---------------------------------------------------------------------------------------------------
// Loading and calling the module. This is all a page needs (see README.md).

function loadAssembler(bytes) {
   const module = new WebAssembly.Module(bytes);
   const instance = new WebAssembly.Instance(module, {}); // the module has no imports
   const e = instance.exports;
   e._initialize(); // runs the C++ static constructors; call it once, before anything else
   const encoder = new TextEncoder(), decoder = new TextDecoder();
   const ERR_CAP = 16384;
   function assemble(text, syntax, outCap = 1 << 16) {
      const source = encoder.encode(text + '\0');
      const textPtr = e.malloc(source.length), outPtr = e.malloc(outCap), errPtr = e.malloc(ERR_CAP);
      if (!textPtr || !outPtr || !errPtr) throw new Error('out of memory');
      new Uint8Array(e.memory.buffer).set(source, textPtr);
      const n = e.wuica_assemble(textPtr, syntax, outPtr, outCap, errPtr, ERR_CAP);
      const memory = new Uint8Array(e.memory.buffer); // after the call: the memory may have grown
      const message = decoder.decode(memory.subarray(errPtr, memory.indexOf(0, errPtr)));
      const code = n >= 0 ? memory.slice(outPtr, outPtr + n) : null;
      e.free(textPtr); e.free(outPtr); e.free(errPtr);
      return { status: n, code, message };
   }
   // After a trap (WebAssembly.RuntimeError from assemble): what LLVM reported, if it was a fatal LLVM error.
   function fatalMessage() {
      const memory = new Uint8Array(e.memory.buffer), p = e.wuica_fatal_message();
      return decoder.decode(memory.subarray(p, memory.indexOf(0, p)));
   }
   return { module, instance, assemble, fatalMessage, memoryBytes: () => e.memory.buffer.byteLength };
}

// ---------------------------------------------------------------------------------------------------
// The native reference.

for (const [tool, flag] of [[LLVM_MC, '--version'], [LLVM_OBJCOPY, '--version']]) {
   const r = spawnSync(tool, [flag], { encoding: 'utf8' });
   if (r.status !== 0) { console.error(`cannot run ${tool} (set LLVM_MC / LLVM_OBJCOPY)`); process.exit(2); }
}
const mcVersion = /version\s+(\S+)/.exec(execFileSync(LLVM_MC, ['--version'], { encoding: 'utf8' }))?.[1];
const tmp = mkdtempSync(join(tmpdir(), 'wuica-asm-test-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// Returns { ok: true, code } or { ok: false, stderr }.
function reference(path, syntax) {
   const obj = join(tmp, 'ref.o'), bin = join(tmp, 'ref.bin');
   const mcArgs = [`-triple=${TRIPLE}`, '-filetype=obj', '-o', obj, path];
   if (syntax === INTEL) mcArgs.unshift('--x86-asm-syntax=intel');
   const mc = spawnSync(LLVM_MC, mcArgs, { encoding: 'utf8' });
   if (mc.status !== 0) return { ok: false, stderr: mc.stderr };
   execFileSync(LLVM_OBJCOPY, ['-O', 'binary', '--only-section=.text', obj, bin]);
   return { ok: true, code: readFileSync(bin), stderr: mc.stderr };
}
function referenceText(text, syntax) {
   const path = join(tmp, 'case.s');
   writeFileSync(path, text);
   return reference(path, syntax);
}

// ---------------------------------------------------------------------------------------------------

let failures = 0, checks = 0;
function check(condition, what, detail = '') {
   checks++;
   if (!condition) {
      failures++;
      if (failures <= 20) console.error(`FAIL: ${what}${detail ? '\n      ' + detail : ''}`);
   }
   return condition;
}
const hex = bytes => Buffer.from(bytes).toString('hex');
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

const wasmBytes = readFileSync(wasmPath);
console.log(`module     ${wasmPath}`);
console.log(`sha256     ${createHash('sha256').update(wasmBytes).digest('hex')}`);
console.log(`reference  ${LLVM_MC} ${mcVersion}, ${LLVM_OBJCOPY}; node ${process.version}`);

const loadStarted = process.hrtime.bigint();
const assembler = loadAssembler(wasmBytes); // the first (uncached) compile in this process
const firstLoadMs = Number(process.hrtime.bigint() - loadStarted) / 1e6;
const imports = WebAssembly.Module.imports(assembler.module);
check(imports.length === 0, 'the module has no imports', imports.map(i => `${i.module}.${i.name}`).join(' '));
const exportNames = WebAssembly.Module.exports(assembler.module).map(x => x.name);
for (const name of ['memory', '_initialize', 'wuica_assemble', 'wuica_fatal_message', 'malloc', 'free'])
   check(exportNames.includes(name), `export ${name}`);

// Compares the module with the reference for one text. `refSyntax` is what the native assembler is told.
function compare(name, text, syntax, ref) {
   const got = assembler.assemble(text, syntax);
   if (!ref.ok) return check(false, `${name}: the reference assembler failed`, ref.stderr);
   if (!check(got.status >= 0, `${name}: wuica_assemble returned ${got.status}`, got.message)) return false;
   return check(same(got.code, ref.code), `${name}: bytes differ`, `wasm ${hex(got.code)}\n      llvm ${hex(ref.code)}`);
}

// For texts that the native assembler may reject: the module must then fail too, with the same diagnostics
// (llvm-mc prints PATH:LINE:COL, the module "<input>:LINE:COL"). Returns 'bytes', 'errors' or false.
function sameOutcome(name, text, syntax, ref, path) {
   if (ref.ok) return compare(name, text, syntax, ref) ? 'bytes' : false;
   const got = assembler.assemble(text, syntax);
   const expected = ref.stderr.split(path + ':').join('<input>:');
   const ok = check(got.status === -1, `${name}: fails like llvm-mc`, `returned ${got.status}`) &
      check(got.message === expected, `${name}: the same diagnostics as llvm-mc`, `wasm ${JSON.stringify(got.message)}\n      llvm ${JSON.stringify(expected)}`);
   return ok ? 'errors' : false;
}

// --- 1. the corpus ---------------------------------------------------------------------------------

// The corpus was written for GNU as. Most files use its `{load}` / `{store}` encoding hints, which LLVM's
// assembler does not know ("unknown prefix"), and a few use mnemonics that only GNU as accepts
// (pcmpestriq, vpcmpestrmq, ...). So each file is checked twice, and in both cases the module must do
// what llvm-mc does: produce the same bytes, or fail with the same diagnostics.
//   as it is:        nearly all files are rejected;
//   hints removed:   nearly all files assemble.
let corpusFiles = 0, corpusByteCompared = 0, corpusSameErrors = 0, corpusPlainErrors = 0, corpusMismatches = 0, corpusBytes = 0;
const memoryMarks = [];
if (!existsSync(corpusDir)) {
   check(false, `corpus directory ${corpusDir} does not exist (use --corpus DIR)`);
} else {
   const files = readdirSync(corpusDir).filter(f => /^s6_\d+\.s$/.test(f)).sort().slice(0, limit);
   const started = Date.now();
   const hintsRemoved = join(tmp, 'corpus.s');
   for (const file of files) {
      const path = join(corpusDir, file);
      const text = readFileSync(path, 'utf8');
      const before = failures;
      check(/^\.intel_syntax noprefix\n/.test(text), `${file}: starts with .intel_syntax noprefix`);
      const withoutDirective = text.replace(/^\.intel_syntax noprefix\n/, '\n'); // what a page user types; same line numbers

      // As it is. Three ways to say "Intel syntax" must all behave like llvm-mc on the file.
      const ref = reference(path, ATT); // the directive in the file selects the syntax
      const variants = [['intel', text, INTEL], ['att + directive', text, ATT], ['intel, directive removed', withoutDirective, INTEL]];
      for (const [what, t, syntax] of variants) sameOutcome(`${file} [${what}]`, t, syntax, ref, path);
      if (!ref.ok) corpusSameErrors++;

      // With the encoding hints removed.
      const plain = text.replace(/^\{(load|store)\} /gm, '');
      let plainRef = ref, plainPath = path;
      if (plain !== text) {
         writeFileSync(hintsRemoved, plain);
         plainRef = reference(hintsRemoved, ATT);
         plainPath = hintsRemoved;
      }
      const outcome = sameOutcome(`${file} [hints removed, intel]`, plain, INTEL, plainRef, plainPath);
      if (outcome === 'bytes') {
         corpusByteCompared++;
         corpusBytes += plainRef.code.length;
      } else if (outcome === 'errors') {
         corpusPlainErrors++;
      }
      sameOutcome(`${file} [hints removed, intel, directive removed]`, plain.replace(/^\.intel_syntax noprefix\n/, '\n'), INTEL, plainRef, plainPath);

      if (failures !== before) corpusMismatches++;
      corpusFiles++;
      if (corpusFiles === 100 || corpusFiles === files.length) memoryMarks.push(assembler.memoryBytes());
   }
   // `--x86-asm-syntax=intel` on the command line gives the same reference (checked on a sample).
   for (const file of files.filter((_, i) => i % 50 === 0)) {
      writeFileSync(hintsRemoved, readFileSync(join(corpusDir, file), 'utf8').replace(/^\{(load|store)\} /gm, ''));
      const a = reference(hintsRemoved, ATT), b = reference(hintsRemoved, INTEL);
      check(a.ok === b.ok && (!a.ok || same(a.code, b.code)), `${file}: llvm-mc with and without --x86-asm-syntax=intel agree`);
   }
   console.log(`corpus     ${corpusFiles} files from ${corpusDir}, ${((Date.now() - started) / 1000).toFixed(1)} s`);
   console.log(`           as they are: ${corpusFiles - corpusSameErrors} assemble (bytes compared), ${corpusSameErrors} are rejected by llvm-mc ` +
      `(mostly {load}/{store} hints; diagnostics compared)`);
   console.log(`           hints removed: ${corpusByteCompared} assemble (bytes compared, ${corpusBytes} code bytes), ` +
      `${corpusPlainErrors} are rejected by llvm-mc (GNU-only mnemonics; diagnostics compared)`);
   console.log(`           files with a mismatch: ${corpusMismatches}`);
   check(corpusByteCompared >= Math.min(minCorpus, limit), `at least ${minCorpus} corpus files compared byte for byte`, `${corpusByteCompared}`);
   if (memoryMarks.length === 2)
      check(memoryMarks[1] === memoryMarks[0], 'memory does not grow from call to call',
         `${memoryMarks[0]} bytes after 100 files, ${memoryMarks[1]} at the end`);
}

// --- 2. hand-written cases -------------------------------------------------------------------------

const pad = (n, line = 'nop') => Array(n).fill(line).join('\n') + '\n';
const cases = [
   ['backward short jcc/jmp', INTEL, 'top:\nadd rax, rbx\ndec rcx\njnz top\njmp top\n'],
   ['forward short jcc/jmp', INTEL, 'test rax, rax\njz done\njmp done\nadd rax, 1\ndone:\nret\n'],
   ['forward near jcc/jmp (relaxed)', INTEL, 'test rax, rax\njz far\njmp far\n' + pad(200, 'add rax, rbx') + 'far:\nret\n'],
   ['backward near jcc/jmp', INTEL, 'top:\n' + pad(200, 'add rax, rbx') + 'dec rcx\njnz top\njmp top\n'],
   ['jump distance exactly at the short limit', INTEL, 'jmp a\n' + pad(127) + 'a:\njmp b\n' + pad(128) + 'b:\nc:\n' + pad(126) + 'jmp c\nd:\n' + pad(127) + 'jmp d\n'],
   ['relaxation cascade', INTEL, 'jz l1\njz l2\njz l3\n' + pad(122) + 'l1:\nnop\nl2:\nnop\nl3:\nret\n'],
   ['loop/jrcxz/call', INTEL, 'top:\ncall top\ncall fwd\nloop top\njrcxz fwd\nfwd:\nret\n'],
   ['RIP-relative', INTEL,
      'data:\n.quad 0\nmov rax, [rip + data]\nlea rsi, [rip + data]\nmov qword ptr [rip + after], 1\ncmp byte ptr [rip + data], 3\nvmovdqa ymm1, ymmword ptr [rip + after]\nafter:\n.quad 1\n'],
   ['RIP-relative to an undefined symbol (relocation, zero bytes)', INTEL, 'mov rax, [rip + external]\ncall external\njmp external\n'],
   ['addressing modes', INTEL,
      'mov eax, [rbx]\nmov eax, [rbp]\nmov eax, [rsp]\nmov eax, [r12]\nmov eax, [r13]\nmov eax, [rbx + 4*rcx]\nmov eax, [rbx + 4*rcx + 8]\nmov eax, [rbx + 4*rcx + 0x1000]\n' +
      'mov eax, [4*rcx]\nmov eax, [0x1000]\nmov rax, qword ptr fs:[0x28]\nmov al, [rdi + 127]\nmov al, [rdi + 128]\nmov al, [rdi - 128]\nmov al, [rdi - 129]\nlea r8, [r9 + 8*r10 - 4]\n'],
   ['immediates and encodings', INTEL,
      'add rax, 1\nadd rax, 127\nadd rax, 128\nadd eax, 0x12345678\nmov rax, 1\nmov rax, -1\nmov rax, 0x123456789a\nmov eax, 1\nmovabs rax, 0x1122334455667788\n' +
      'xor eax, eax\npush 1\npush 1000\nimul rax, rbx, 100\nshl rax, 1\nshl rax, 5\ntest al, 1\nxchg rax, rbx\nnop dword ptr [rax + rax]\n{vex3} vpaddd xmm1, xmm2, xmm3\n{evex} vpaddd xmm1, xmm2, xmm3\n{disp32} mov eax, [rbx + 4]\n'],
   ['AVX/AVX2/FMA/BMI', INTEL,
      'vaddps ymm0, ymm1, ymm2\nvaddps ymm8, ymm9, ymmword ptr [rsi + 32]\nvpsubd xmm4, xmm14, xmm0\nvfmadd231pd ymm0, ymm1, ymm2\nvpgatherdd ymm1, [rax + 4*ymm2], ymm3\n' +
      'vzeroupper\nandn rax, rbx, rcx\npdep rax, rbx, [rsi]\nshlx rax, rbx, rcx\nvpbroadcastd ymm1, xmm2\nvextracti128 xmm1, ymm2, 1\nvpmovzxbw xmm2, qword ptr [rsi + 704]\n'],
   ['AVX-512 with masks, broadcast, rounding', INTEL,
      'vaddps zmm0, zmm1, zmm2\nvaddps zmm0 {k1}, zmm1, zmm2\nvaddps zmm0 {k1} {z}, zmm1, zmm2\nvaddpd zmm3 {k2}, zmm4, qword ptr [rax]{1to8}\nvaddps zmm0, zmm1, zmm2, {rn-sae}\n' +
      'vpaddd zmm16, zmm17, zmmword ptr [rsi + 64]\nvpaddd xmm16, xmm17, xmm18\nvmovdqu8 zmm1 {k3}, zmmword ptr [rdi]\nvpternlogd zmm0, zmm1, zmm2, 0x96\nkandw k1, k2, k3\nkmovq k1, rax\n' +
      'vpcmpeqb k1, zmm0, zmm1\nvcompressps zmmword ptr [rdi] {k1}, zmm2\nvpopcntq zmm1, zmm2\nvpdpbusd zmm1, zmm2, zmm3\nvgf2p8mulb zmm1, zmm2, zmm3\nvaddph zmm1, zmm2, zmm3\nvmovups zmm1, [rsi + 64]\nvmovups zmm1, [rsi + 65]\n'],
   ['APX and other recent extensions', INTEL, 'add r16, r17\n{nf} add rax, rbx\nadd rax, rbx, rcx\npush2 rax, rbx\nvpdpbssd ymm1, ymm2, ymm3\nsha256rnds2 xmm1, xmm2\nrdpid rax\nserialize\n'],
   ['x87/SSE/legacy', INTEL, 'fld st(1)\nfaddp st(1), st\nfld qword ptr [rax]\naddss xmm0, xmm1\npshufb xmm0, [rax]\ncvtsi2sd xmm0, rax\nrep movsb\nlock cmpxchg [rdi], rsi\ncdqe\ncqo\nsyscall\nud2\n'],
   ['alignment padding in the middle of code', INTEL, 'add rax, rbx\n.p2align 4\nl:\nadd rax, rbx\n.p2align 5\ndec rcx\n.balign 8\njnz l\n.p2align 6, 0x90\nret\n.nops 7\n'],
   ['data directives, symbols and expressions', INTEL, 'start:\n.byte 1, 2, 3\n.word 0x1234\n.long end - start\n.quad 0\n.ascii "ab"\n.asciz "c"\n.fill 3, 1, 0xcc\n.set five, 5\nmov eax, five\nmov eax, five * 2 + 1\nend:\nmov eax, offset start\n'],
   ['macros, .rept, .if', INTEL, '.macro inc2 reg\ninc \\reg\ninc \\reg\n.endm\ninc2 rax\ninc2 r9\n.rept 3\nadd rax, 1\n.endr\n.if 1\nnop\n.else\nint3\n.endif\n'],
   ['other sections are not part of the result', INTEL, 'mov rax, [rip + v]\n.data\nv:\n.quad 42\n.text\nret\n'],
   ['switching the syntax inside the text', INTEL, 'add rax, rbx\n.att_syntax\naddq %rbx, %rax\n.intel_syntax noprefix\nadd rax, rbx\n'],
   ['empty input', INTEL, ''],
   ['comments and blank lines only', INTEL, '# comment\n\n   // another\n/* block */\n'],
   ['no trailing newline; several statements on one line', INTEL, 'add rax, rbx; add rcx, rdx\nret'],
   ['AT&T: basic', ATT, 'top:\naddq %rbx, %rax\nmovl $1, %ecx\nmovq 8(%rsi,%rdi,4), %rdx\nleaq top(%rip), %r8\nvaddps %zmm2, %zmm1, %zmm0{%k1}{z}\nvaddpd (%rax){1to8}, %zmm4, %zmm3\ndecq %r15\njnz top\n'],
   ['AT&T: forward near branch', ATT, 'testq %rax, %rax\nje far\njmp far\n' + pad(150, 'addq %rbx, %rax') + 'far:\nret\n'],
   ['AT&T: local labels', ATT, '1:\nnop\njmp 1b\njmp 1f\nnop\n1:\nret\n'],
];
let caseMismatches = 0;
for (const [name, syntax, text] of cases) {
   const before = failures;
   compare(`case "${name}"`, text, syntax, referenceText(text, syntax));
   if (failures !== before) caseMismatches++;
}

// Error cases: a negative return value and a message with the line number; the native assembler must fail too.
const errorCases = [
   ['unknown mnemonic', INTEL, 'mov rax, rbx\nfrobnicate rax, rbx\nret\n', /^<input>:2:1: error: invalid instruction mnemonic 'frobnicate'/],
   ['invalid operands', INTEL, 'nop\nnop\nadd rax, xmm1\n', /^<input>:3:\d+: error: invalid operand/],
   ['two errors are both reported', INTEL, 'foo\nnop\nbar\n', /<input>:1:1: error: [^]*<input>:3:1: error: /],
   ['AT&T text in Intel mode', INTEL, 'addq %rbx, %rax\n', /^<input>:1:\d+: error: /],
   ['Intel text in AT&T mode', ATT, 'add rax, rbx\n', /^<input>:1:\d+: error: /],
   ['GNU as encoding hint {load} (LLVM does not support it)', INTEL, 'add rax, rbx\n{load} add rcx, r8\n', /^<input>:2:1: error: unknown prefix/],
   ['.intel_syntax prefix', ATT, '.intel_syntax prefix\n', /^<input>:1:\d+: error: /],
   ['.incbin with an absolute path', INTEL, '.incbin "/etc/passwd"\n', /^<input>:1:\d+: error: Could not find incbin file '\/etc\/passwd'/, 'no reference'],
   ['.incbin with a relative path', INTEL, 'nop\n.incbin "test.mjs"\n', /^<input>:2:\d+: error: Could not find incbin file/, 'no reference'],
   ['.include with an absolute path', INTEL, '.include "/etc/passwd"\n', /^<input>:1:\d+: error: Could not find include file '\/etc\/passwd'/, 'no reference'],
   ['.include with a relative path', ATT, '.include "../../../../etc/hostname"\n', /^<input>:1:\d+: error: Could not find include file/, 'no reference'],
   ['undefined symbol in an absolute expression', INTEL, '.if undefined_symbol\nnop\n.endif\n', /^<input>:1:\d+: error: /],
   ['error found after parsing (at layout)', INTEL, 'a:\n.fill b - a, 1, 0\nnop\n', /error: /],
   ['.error directive', INTEL, 'nop\n.error "stop here"\n', /^<input>:2:\d+: error: stop here/],
];
for (const [name, syntax, text, pattern, noReference] of errorCases) {
   const got = assembler.assemble(text, syntax);
   check(got.status === -1 && got.code === null, `error case "${name}": returns -1`, `returned ${got.status}: ${got.message}`);
   check(pattern.test(got.message), `error case "${name}": message`, JSON.stringify(got.message));
   if (!noReference) check(!referenceText(text, syntax).ok, `error case "${name}": the native assembler fails too`);
   // The module still works afterwards, in both syntaxes.
   const after = assembler.assemble('add rax, rbx\n', INTEL);
   check(after.status === 3 && hex(after.code) === '4801d8' && after.message === '', `after error case "${name}": the next call works`, after.message);
}

// Warnings do not fail the call; they are returned in the message.
{
   const text = 'nop\n.warning "careful"\nret\n';
   const got = assembler.assemble(text, INTEL);
   check(got.status === 2 && hex(got.code) === '90c3', 'warning: code is returned', `${got.status}`);
   check(/^<input>:2:\d+: warning: careful/.test(got.message), 'warning: message is returned', JSON.stringify(got.message));
}
// An output buffer that is too small.
{
   const got = assembler.assemble('add rax, rbx\nret\n', INTEL, 3);
   check(got.status === -2 && /4 bytes needed/.test(got.message), 'output buffer too small: returns -2 and the size', `${got.status} ${got.message}`);
   const exact = assembler.assemble('add rax, rbx\nret\n', INTEL, 4);
   check(exact.status === 4 && hex(exact.code) === '4801d8c3', 'output buffer of exactly the right size');
}
// A long diagnostic is cut to the buffer and still NUL-terminated (the helper would read past it otherwise).
{
   const got = assembler.assemble(pad(400, 'bogus'), INTEL);
   check(got.status === -1 && got.message.length > 0 && got.message.length < 16384, 'long diagnostics are truncated', `${got.message.length}`);
}
// Invalid syntax argument.
check(assembler.assemble('nop\n', 2).status === -3, 'invalid syntax argument: returns -3');

// Running out of memory (the module's memory is limited to 256 MiB) is a fatal LLVM error: the call traps.
// The instance must then be thrown away; the message can still be read.
{
   const victim = loadAssembler(wasmBytes);
   check(victim.fatalMessage() === '', 'no fatal message before a fatal error');
   let trapped = null;
   try { victim.assemble('nop\n.fill 400000000, 1, 0x90\n', INTEL); } catch (error) { trapped = error; }
   check(trapped instanceof WebAssembly.RuntimeError, 'out of memory: the call traps', String(trapped));
   check(victim.fatalMessage().length > 0, 'out of memory: a fatal message is available', JSON.stringify(victim.fatalMessage()));
   check(victim.memoryBytes() <= 256 * 1048576, 'the memory stays within 256 MiB', `${victim.memoryBytes()}`);
   console.log(`fatal      out of memory traps (${trapped?.message}); wuica_fatal_message: ${JSON.stringify(victim.fatalMessage())}`);
}

console.log(`cases      ${cases.length} hand-written cases compared, ${caseMismatches} mismatches; ${errorCases.length} error cases`);

// --- 3. sizes and timings --------------------------------------------------------------------------

const kb = n => `${n} bytes (${(n / 1024).toFixed(0)} KiB)`;
console.log(`size       raw ${kb(wasmBytes.length)}`);
console.log(`           gzip -9 ${kb(gzipSync(wasmBytes, { level: 9 }).length)}`);
console.log(`           brotli -q 11 ${kb(brotliCompressSync(wasmBytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_LGWIN]: 24, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: wasmBytes.length } }).length)}`);

// A 100-line input: a loop of 98 instructions.
const templates = [
   'add rax, rbx', 'mov qword ptr [rsi + 8000], rax', 'lea rdx, [r9 + 1*r10]', 'imul r12, rbx', 'vpsubd xmm4, xmm14, xmm0', 'movzx r11d, dil',
   'vpmovzxbw xmm2, qword ptr [rsi + 704]', 'xor r10, rbp', 'vaddps zmm0 {k1}, zmm1, zmm2', 'cmp byte ptr [rdi + rcx], 0', 'shl rax, 5',
   'vfmadd231pd ymm0, ymm1, ymmword ptr [rsi + 64]', 'mov eax, dword ptr [rip + loop]', 'popcnt rax, rbx',
];
const hundred = 'loop:\n' + Array.from({ length: 98 }, (_, i) => templates[i % templates.length]).join('\n') + '\njnz loop\n';
check(hundred.split('\n').length - 1 === 100, 'the timing input has 100 lines');
compare('100-line timing input', hundred, INTEL, referenceText(hundred, INTEL));
{
   const ms = (a, b) => Number(b - a) / 1e6;
   const median = xs => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
   const compileTimes = [], instantiateTimes = [], firstCallTimes = [];
   for (let i = 0; i < 9; i++) {
      const t0 = process.hrtime.bigint();
      const module = new WebAssembly.Module(wasmBytes);
      const t1 = process.hrtime.bigint();
      const instance = new WebAssembly.Instance(module, {});
      instance.exports._initialize();
      const t2 = process.hrtime.bigint();
      compileTimes.push(ms(t0, t1)); instantiateTimes.push(ms(t1, t2));
   }
   for (let i = 0; i < 5; i++) {
      const fresh = loadAssembler(wasmBytes);
      const t0 = process.hrtime.bigint();
      fresh.assemble(hundred, INTEL);
      firstCallTimes.push(ms(t0, process.hrtime.bigint()));
   }
   const warm = [];
   for (let i = 0; i < 200; i++) {
      const t0 = process.hrtime.bigint();
      assembler.assemble(hundred, INTEL);
      warm.push(ms(t0, process.hrtime.bigint()));
   }
   console.log(`time       first load in this process (compile + instantiate + _initialize) ${firstLoadMs.toFixed(1)} ms`);
   console.log(`           again: WebAssembly.Module ${median(compileTimes).toFixed(1)} ms (V8 reuses the compiled module); ` +
      `instantiate + _initialize ${median(instantiateTimes).toFixed(2)} ms (medians of 9)`);
   console.log(`           assemble 100 lines: first call on a fresh instance ${median(firstCallTimes).toFixed(2)} ms (median of 5), ` +
      `later calls ${median(warm).toFixed(2)} ms (median of 200)`);
   console.log(`memory     ${(assembler.memoryBytes() / 1048576).toFixed(1)} MiB of linear memory after all tests`);
}

console.log(failures === 0 ? `PASS: ${checks} checks, 0 failures` : `FAIL: ${failures} of ${checks} checks failed`);
process.exit(failures === 0 ? 0 : 1);
