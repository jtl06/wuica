// Built-in examples. Each has the code in both assembly syntaxes and as machine code (a listing that the hex
// parser reads, so the examples also show that disassembly output can be pasted). The four blocks are in the
// corpus of the Python reference, so the mock engine has the reference's result for them
// (see mock-data.js; `arch` is the microarchitecture that result was recorded for).

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
    [['c4 e2 d5 aa f4', 'vfmsub213pd ymm6, ymm5, ymm4'], ['4c 03 d1', 'add r10, rcx'], ['4d 0f af c0', 'imul r8, r8'],
      ['49 ff cf', 'dec r15'], ['75 ef', 'jnz 0x0']]),
  ex('stack', 'Stack: pops after an add to rsp', 'SKL',
    ['loop:', '  add rsp, 8', '  mov rsi, rbx', '  mov rdx, rbp', '  pop rbx', '  pop rbp', '  mov edi, eax', '  dec r15', '  jnz loop'],
    ['loop:', '  addq $8, %rsp', '  movq %rbx, %rsi', '  movq %rbp, %rdx', '  popq %rbx', '  popq %rbp', '  movl %eax, %edi', '  decq %r15', '  jnz loop'],
    [['48 83 c4 08', 'add rsp, 0x8'], ['48 89 de', 'mov rsi, rbx'], ['48 89 ea', 'mov rdx, rbp'], ['5b', 'pop rbx'], ['5d', 'pop rbp'],
      ['89 c7', 'mov edi, eax'], ['49 ff cf', 'dec r15'], ['75 ed', 'jnz 0x0']]),
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
