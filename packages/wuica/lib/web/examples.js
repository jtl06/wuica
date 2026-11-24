// Built-in examples. Each has the code in both assembly syntaxes and as machine code (a listing that the hex
// parser reads, so the examples also show that disassembly output can be pasted). The four blocks are in the
// corpus of the Python reference, so the mock engine has the reference's result for them
// (see mock-data.js; `arch` is the microarchitecture that result was recorded for). Menu group "basics".
// An example's machine code is what the assembler makes of its text (tests-js/web_qa.mjs, web_asm_shipped.mjs), so that
// its result can be shown before the assembler has loaded (asm-shipped.js): 'avx' has `49 01 ca` for `add r10, rcx`,
// where the corpus has `4c 03 d1` (the mock engine takes it for the recorded block: engine-mock.js SAME_AS).

import { SHA256_BLOCK_HEX } from './showcase.js';

function ex(id, title, arch, intel, att, listing) {
  const hex = listing.map((l) => l[0].replace(/ /g, '')).join('');
  let addr = 0;
  const width = Math.max(...listing.map((l) => l[0].length));
  const lines = listing.map(([bytes, text]) => {
    const line = `${addr.toString(16).padStart(4)}:  ${bytes.padEnd(width)}    ${text}`;
    addr += (bytes.length + 1) / 3;
    return line;
  });
  return { id, title, arch, hex, text: { intel: intel.join('\n') + '\n', att: att.join('\n') + '\n', hex: lines.join('\n') + '\n' } };
}

export const EXAMPLES = [
  ex('chain', 'Dependency chain: two dependent adds', 'SKL',
    ['loop:', '  add rax, 1', '  add rax, 1', '  dec r15', '  jnz loop'],
    ['loop:', '  addq $1, %rax', '  addq $1, %rax', '  decq %r15', '  jnz loop'],
    [['48 83 c0 01', 'add rax, 0x1'], ['48 83 c0 01', 'add rax, 0x1'], ['49 ff cf', 'dec r15'], ['75 f3', 'jnz 0x0']]),
  ex('loadstore', 'Load/store: store, then reload', 'ZEN3',
    ['loop:', '  mov qword ptr [rsi], rax', '  mov eax, dword ptr [rsi]', '  add rax, 1', '  dec r15', '  jnz loop'],
    ['loop:', '  movq %rax, (%rsi)', '  movl (%rsi), %eax', '  addq $1, %rax', '  decq %r15', '  jnz loop'],
    [['48 89 06', 'mov qword ptr [rsi], rax'], ['8b 06', 'mov eax, dword ptr [rsi]'], ['48 83 c0 01', 'add rax, 0x1'],
      ['49 ff cf', 'dec r15'], ['75 f2', 'jnz 0x0']]),
  ex('avx', 'AVX: FMA, add and multiply', 'ADL-P',
    ['loop:', '  vfmsub213pd ymm6, ymm5, ymm4', '  add r10, rcx', '  imul r8, r8', '  dec r15', '  jnz loop'],
    ['loop:', '  vfmsub213pd %ymm4, %ymm5, %ymm6', '  addq %rcx, %r10', '  imulq %r8, %r8', '  decq %r15', '  jnz loop'],
    [['c4 e2 d5 aa f4', 'vfmsub213pd ymm6, ymm5, ymm4'], ['49 01 ca', 'add r10, rcx'], ['4d 0f af c0', 'imul r8, r8'],
      ['49 ff cf', 'dec r15'], ['75 ef', 'jnz 0x0']]),
  ex('stack', 'Stack: pops after an add to rsp', 'SKL',
    ['loop:', '  add rsp, 8', '  mov rsi, rbx', '  mov rdx, rbp', '  pop rbx', '  pop rbp', '  mov edi, eax', '  dec r15', '  jnz loop'],
    ['loop:', '  addq $8, %rsp', '  movq %rbx, %rsi', '  movq %rbp, %rdx', '  popq %rbx', '  popq %rbp', '  movl %eax, %edi', '  decq %r15', '  jnz loop'],
    [['48 83 c4 08', 'add rsp, 0x8'], ['48 89 de', 'mov rsi, rbx'], ['48 89 ea', 'mov rdx, rbp'], ['5b', 'pop rbx'], ['5d', 'pop rbp'],
      ['89 c7', 'mov edi, eax'], ['49 ff cf', 'dec r15'], ['75 ed', 'jnz 0x0']]),
];

// Well-known loops (menu group "classic loops"). Not in the reference's corpus: the mock has no result for them.
// dot1/dot4 are the default A–B demo (the same work, one accumulator vs four).
export const CLASSIC_EXAMPLES = [
  ex('saxpy', 'saxpy (AVX2 FMA)', 'SKL',
    ['loop:', '  vmovups ymm1, ymmword ptr [rdi + rax*4]', '  vfmadd213ps ymm1, ymm0, ymmword ptr [rsi + rax*4]', '  vmovups ymmword ptr [rsi + rax*4], ymm1', '  add rax, 8', '  cmp rax, rdx', '  jb loop'],
    ['loop:', '  vmovups (%rdi,%rax,4), %ymm1', '  vfmadd213ps (%rsi,%rax,4), %ymm0, %ymm1', '  vmovups %ymm1, (%rsi,%rax,4)', '  addq $8, %rax', '  cmpq %rdx, %rax', '  jb loop'],
    [['c5 fc 10 0c 87', 'vmovups ymm1, ymmword ptr [rdi+rax*4]'], ['c4 e2 7d a8 0c 86', 'vfmadd213ps ymm1, ymm0, ymmword ptr [rsi+rax*4]'], ['c5 fc 11 0c 86', 'vmovups ymmword ptr [rsi+rax*4], ymm1'], ['48 83 c0 08', 'add rax, 0x8'], ['48 39 d0', 'cmp rax, rdx'], ['72 e7', 'jb 0x0']]),
  ex('dot1', 'dot product, 1 accumulator', 'SKL',
    ['loop:', '  vmovups ymm4, ymmword ptr [rdi + rax*4]', '  vmovups ymm5, ymmword ptr [rdi + rax*4 + 32]', '  vmovups ymm6, ymmword ptr [rdi + rax*4 + 64]', '  vmovups ymm7, ymmword ptr [rdi + rax*4 + 96]', '  vfmadd231ps ymm0, ymm4, ymmword ptr [rsi + rax*4]', '  vfmadd231ps ymm0, ymm5, ymmword ptr [rsi + rax*4 + 32]', '  vfmadd231ps ymm0, ymm6, ymmword ptr [rsi + rax*4 + 64]', '  vfmadd231ps ymm0, ymm7, ymmword ptr [rsi + rax*4 + 96]', '  add rax, 32', '  cmp rax, rdx', '  jb loop'],
    ['loop:', '  vmovups (%rdi,%rax,4), %ymm4', '  vmovups 32(%rdi,%rax,4), %ymm5', '  vmovups 64(%rdi,%rax,4), %ymm6', '  vmovups 96(%rdi,%rax,4), %ymm7', '  vfmadd231ps (%rsi,%rax,4), %ymm4, %ymm0', '  vfmadd231ps 32(%rsi,%rax,4), %ymm5, %ymm0', '  vfmadd231ps 64(%rsi,%rax,4), %ymm6, %ymm0', '  vfmadd231ps 96(%rsi,%rax,4), %ymm7, %ymm0', '  addq $32, %rax', '  cmpq %rdx, %rax', '  jb loop'],
    [['c5 fc 10 24 87', 'vmovups ymm4, ymmword ptr [rdi+rax*4]'], ['c5 fc 10 6c 87 20', 'vmovups ymm5, ymmword ptr [rdi+rax*4+0x20]'], ['c5 fc 10 74 87 40', 'vmovups ymm6, ymmword ptr [rdi+rax*4+0x40]'], ['c5 fc 10 7c 87 60', 'vmovups ymm7, ymmword ptr [rdi+rax*4+0x60]'], ['c4 e2 5d b8 04 86', 'vfmadd231ps ymm0, ymm4, ymmword ptr [rsi+rax*4]'], ['c4 e2 55 b8 44 86 20', 'vfmadd231ps ymm0, ymm5, ymmword ptr [rsi+rax*4+0x20]'], ['c4 e2 4d b8 44 86 40', 'vfmadd231ps ymm0, ymm6, ymmword ptr [rsi+rax*4+0x40]'], ['c4 e2 45 b8 44 86 60', 'vfmadd231ps ymm0, ymm7, ymmword ptr [rsi+rax*4+0x60]'], ['48 83 c0 20', 'add rax, 0x20'], ['48 39 d0', 'cmp rax, rdx'], ['72 c5', 'jb 0x0']]),
  ex('dot4', 'dot product, 4 accumulators', 'SKL',
    ['loop:', '  vmovups ymm4, ymmword ptr [rdi + rax*4]', '  vmovups ymm5, ymmword ptr [rdi + rax*4 + 32]', '  vmovups ymm6, ymmword ptr [rdi + rax*4 + 64]', '  vmovups ymm7, ymmword ptr [rdi + rax*4 + 96]', '  vfmadd231ps ymm0, ymm4, ymmword ptr [rsi + rax*4]', '  vfmadd231ps ymm1, ymm5, ymmword ptr [rsi + rax*4 + 32]', '  vfmadd231ps ymm2, ymm6, ymmword ptr [rsi + rax*4 + 64]', '  vfmadd231ps ymm3, ymm7, ymmword ptr [rsi + rax*4 + 96]', '  add rax, 32', '  cmp rax, rdx', '  jb loop'],
    ['loop:', '  vmovups (%rdi,%rax,4), %ymm4', '  vmovups 32(%rdi,%rax,4), %ymm5', '  vmovups 64(%rdi,%rax,4), %ymm6', '  vmovups 96(%rdi,%rax,4), %ymm7', '  vfmadd231ps (%rsi,%rax,4), %ymm4, %ymm0', '  vfmadd231ps 32(%rsi,%rax,4), %ymm5, %ymm1', '  vfmadd231ps 64(%rsi,%rax,4), %ymm6, %ymm2', '  vfmadd231ps 96(%rsi,%rax,4), %ymm7, %ymm3', '  addq $32, %rax', '  cmpq %rdx, %rax', '  jb loop'],
    [['c5 fc 10 24 87', 'vmovups ymm4, ymmword ptr [rdi+rax*4]'], ['c5 fc 10 6c 87 20', 'vmovups ymm5, ymmword ptr [rdi+rax*4+0x20]'], ['c5 fc 10 74 87 40', 'vmovups ymm6, ymmword ptr [rdi+rax*4+0x40]'], ['c5 fc 10 7c 87 60', 'vmovups ymm7, ymmword ptr [rdi+rax*4+0x60]'], ['c4 e2 5d b8 04 86', 'vfmadd231ps ymm0, ymm4, ymmword ptr [rsi+rax*4]'], ['c4 e2 55 b8 4c 86 20', 'vfmadd231ps ymm1, ymm5, ymmword ptr [rsi+rax*4+0x20]'], ['c4 e2 4d b8 54 86 40', 'vfmadd231ps ymm2, ymm6, ymmword ptr [rsi+rax*4+0x40]'], ['c4 e2 45 b8 5c 86 60', 'vfmadd231ps ymm3, ymm7, ymmword ptr [rsi+rax*4+0x60]'], ['48 83 c0 20', 'add rax, 0x20'], ['48 39 d0', 'cmp rax, rdx'], ['72 c5', 'jb 0x0']]),
  ex('popcnt', 'popcount (false dependency)', 'SKL',
    ['loop:', '  popcnt rcx, qword ptr [rdi + rax*8]', '  add rdx, rcx', '  inc rax', '  cmp rax, rsi', '  jb loop'],
    ['loop:', '  popcntq (%rdi,%rax,8), %rcx', '  addq %rcx, %rdx', '  incq %rax', '  cmpq %rsi, %rax', '  jb loop'],
    [['f3 48 0f b8 0c c7', 'popcnt rcx, qword ptr [rdi+rax*8]'], ['48 01 ca', 'add rdx, rcx'], ['48 ff c0', 'inc rax'], ['48 39 f0', 'cmp rax, rsi'], ['72 ef', 'jb 0x0']]),
  ex('ptrchase', 'pointer chasing', 'SKL',
    ['loop:', '  mov rax, qword ptr [rax]', '  dec rcx', '  jnz loop'],
    ['loop:', '  movq (%rax), %rax', '  decq %rcx', '  jne loop'],
    [['48 8b 00', 'mov rax, qword ptr [rax]'], ['48 ff c9', 'dec rcx'], ['75 f8', 'jnz 0x0']]),
  ex('strlen', 'strlen (SSE2)', 'SKL',
    ['loop:', '  movdqa xmm1, xmmword ptr [rdi]', '  pcmpeqb xmm1, xmm0', '  pmovmskb eax, xmm1', '  add rdi, 16', '  test eax, eax', '  jz loop'],
    ['loop:', '  movdqa (%rdi), %xmm1', '  pcmpeqb %xmm0, %xmm1', '  pmovmskb %xmm1, %eax', '  addq $16, %rdi', '  testl %eax, %eax', '  je loop'],
    [['66 0f 6f 0f', 'movdqa xmm1, xmmword ptr [rdi]'], ['66 0f 74 c8', 'pcmpeqb xmm1, xmm0'], ['66 0f d7 c1', 'pmovmskb eax, xmm1'], ['48 83 c7 10', 'add rdi, 0x10'], ['85 c0', 'test eax, eax'], ['74 ec', 'jz 0x0']]),
  ex('crc32', 'CRC32', 'SKL',
    ['loop:', '  crc32 rax, qword ptr [rdi + rcx*8]', '  inc rcx', '  cmp rcx, rsi', '  jb loop'],
    ['loop:', '  crc32q (%rdi,%rcx,8), %rax', '  incq %rcx', '  cmpq %rsi, %rcx', '  jb loop'],
    [['f2 48 0f 38 f1 04 cf', 'crc32 rax, qword ptr [rdi+rcx*8]'], ['48 ff c1', 'inc rcx'], ['48 39 f1', 'cmp rcx, rsi'], ['72 f1', 'jb 0x0']]),
  ex('memcpy', 'memcpy (AVX)', 'SKL',
    ['loop:', '  vmovdqu ymm0, ymmword ptr [rsi + rax]', '  vmovdqu ymm1, ymmword ptr [rsi + rax + 32]', '  vmovdqu ymmword ptr [rdi + rax], ymm0', '  vmovdqu ymmword ptr [rdi + rax + 32], ymm1', '  add rax, 64', '  cmp rax, rdx', '  jb loop'],
    ['loop:', '  vmovdqu (%rsi,%rax), %ymm0', '  vmovdqu 32(%rsi,%rax), %ymm1', '  vmovdqu %ymm0, (%rdi,%rax)', '  vmovdqu %ymm1, 32(%rdi,%rax)', '  addq $64, %rax', '  cmpq %rdx, %rax', '  jb loop'],
    [['c5 fe 6f 04 06', 'vmovdqu ymm0, ymmword ptr [rsi+rax*1]'], ['c5 fe 6f 4c 06 20', 'vmovdqu ymm1, ymmword ptr [rsi+rax*1+0x20]'], ['c5 fe 7f 04 07', 'vmovdqu ymmword ptr [rdi+rax*1], ymm0'], ['c5 fe 7f 4c 07 20', 'vmovdqu ymmword ptr [rdi+rax*1+0x20], ymm1'], ['48 83 c0 40', 'add rax, 0x40'], ['48 39 d0', 'cmp rax, rdx'], ['72 e1', 'jb 0x0']]),
  ex('gemm', 'GEMM microkernel (4×8 FMA)', 'SKL',
    ['loop:', '  vmovaps ymm0, ymmword ptr [rsi]', '  vmovaps ymm1, ymmword ptr [rsi + 32]', '  vbroadcastss ymm2, dword ptr [rdi]', '  vfmadd231ps ymm8, ymm2, ymm0', '  vfmadd231ps ymm9, ymm2, ymm1', '  vbroadcastss ymm3, dword ptr [rdi + 4]', '  vfmadd231ps ymm10, ymm3, ymm0', '  vfmadd231ps ymm11, ymm3, ymm1', '  vbroadcastss ymm2, dword ptr [rdi + 8]', '  vfmadd231ps ymm12, ymm2, ymm0', '  vfmadd231ps ymm13, ymm2, ymm1', '  vbroadcastss ymm3, dword ptr [rdi + 12]', '  vfmadd231ps ymm14, ymm3, ymm0', '  vfmadd231ps ymm15, ymm3, ymm1', '  add rdi, 16', '  add rsi, 64', '  dec rcx', '  jnz loop'],
    ['loop:', '  vmovaps (%rsi), %ymm0', '  vmovaps 32(%rsi), %ymm1', '  vbroadcastss (%rdi), %ymm2', '  vfmadd231ps %ymm0, %ymm2, %ymm8', '  vfmadd231ps %ymm1, %ymm2, %ymm9', '  vbroadcastss 4(%rdi), %ymm3', '  vfmadd231ps %ymm0, %ymm3, %ymm10', '  vfmadd231ps %ymm1, %ymm3, %ymm11', '  vbroadcastss 8(%rdi), %ymm2', '  vfmadd231ps %ymm0, %ymm2, %ymm12', '  vfmadd231ps %ymm1, %ymm2, %ymm13', '  vbroadcastss 12(%rdi), %ymm3', '  vfmadd231ps %ymm0, %ymm3, %ymm14', '  vfmadd231ps %ymm1, %ymm3, %ymm15', '  addq $16, %rdi', '  addq $64, %rsi', '  decq %rcx', '  jne loop'],
    [['c5 fc 28 06', 'vmovaps ymm0, ymmword ptr [rsi]'], ['c5 fc 28 4e 20', 'vmovaps ymm1, ymmword ptr [rsi+0x20]'], ['c4 e2 7d 18 17', 'vbroadcastss ymm2, dword ptr [rdi]'], ['c4 62 6d b8 c0', 'vfmadd231ps ymm8, ymm2, ymm0'], ['c4 62 6d b8 c9', 'vfmadd231ps ymm9, ymm2, ymm1'], ['c4 e2 7d 18 5f 04', 'vbroadcastss ymm3, dword ptr [rdi+0x4]'], ['c4 62 65 b8 d0', 'vfmadd231ps ymm10, ymm3, ymm0'], ['c4 62 65 b8 d9', 'vfmadd231ps ymm11, ymm3, ymm1'], ['c4 e2 7d 18 57 08', 'vbroadcastss ymm2, dword ptr [rdi+0x8]'], ['c4 62 6d b8 e0', 'vfmadd231ps ymm12, ymm2, ymm0'], ['c4 62 6d b8 e9', 'vfmadd231ps ymm13, ymm2, ymm1'], ['c4 e2 7d 18 5f 0c', 'vbroadcastss ymm3, dword ptr [rdi+0xc]'], ['c4 62 65 b8 f0', 'vfmadd231ps ymm14, ymm3, ymm0'], ['c4 62 65 b8 f9', 'vfmadd231ps ymm15, ymm3, ymm1'], ['48 83 c7 10', 'add rdi, 0x10'], ['48 83 c6 40', 'add rsi, 0x40'], ['48 ff c9', 'dec rcx'], ['75 ab', 'jnz 0x0']]),
];

// A large block that shows the analyzer's speed (menu group "showcase"). Machine code only: `hexOnly` examples switch the
// input to hex.
export const SHOWCASE_EXAMPLES = [
  { id: 'sha256', title: 'SHA-256 block (2,949 instr)', arch: 'SKL', hex: SHA256_BLOCK_HEX.replace(/\s+/g, ''), text: { hex: SHA256_BLOCK_HEX },
    // Intel assembly, loaded when picked (showcase-asm.js, about 60 KB); the example opens in asm mode, hex if it cannot load
    // @ts-ignore: the page's module (the npm package's copy of this file has no showcase-asm.js and never calls asm())
    asm: () => import('./showcase-asm.js').then((m) => m.SHA256_BLOCK_ASM) },
];

// Only offered while the mock engine is active: inputs that make it return what the recorded results lack.
export const MOCK_EXAMPLES = [
  ex('synthetic', 'Mock only: synthetic result (all row kinds and notes)', 'SKL',
    ['div rcx', 'mov ah, bl', 'add rax, rcx', 'push rax', 'ud2', 'cmp rax, rbx', 'jz next', 'next:', '.byte 0x06', 'nop'],
    ['divq %rcx', 'movb %bl, %ah', 'addq %rcx, %rax', 'pushq %rax', 'ud2', 'cmpq %rbx, %rax', 'jz next', 'next:', '.byte 0x06', 'nop'],
    [['48 f7 f1', 'div rcx'], ['88 dc', 'mov ah, bl'], ['48 01 c8', 'add rax, rcx'], ['50', 'push rax'], ['0f 0b', 'ud2'],
      ['48 39 d8', 'cmp rax, rbx'], ['74 00', 'jz 0x2'], ['06', '(bad)'], ['90', 'nop']]),
  ex('error', 'Mock only: analysis error', 'SKL', ['ud2'], ['ud2'], [['0f 0b', 'ud2']]),
];
