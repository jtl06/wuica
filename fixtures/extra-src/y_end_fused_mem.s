.intel_syntax noprefix
l: mov rbx, [rsi]
cmp qword ptr [rsi+8], rax
jnz l
