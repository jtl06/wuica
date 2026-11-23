.intel_syntax noprefix
l: fstp tbyte ptr [rsi]
mov [rdi], rax
mov [rdx+128], rbx
dec r15
jnz l
