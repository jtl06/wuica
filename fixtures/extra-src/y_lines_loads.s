.intel_syntax noprefix
l: mov rax, [rsi]
mov rbx, [rsi+8]
mov rcx, [rdi-8]
mov rdx, [rdi-16]
mov r8, [r9-56]
mov r10, [r9-72]
mov r11, [r12+rax*8]
mov r13, [r12+rax*8+8]
mov r14, [r12+rax*4]
add rax, [rbp]
add rbx, [rbp-64]
vmovups ymm0, [rdx-1]
vaddps ymm1, ymm2, [rdx-33]
dec r15
jnz l
