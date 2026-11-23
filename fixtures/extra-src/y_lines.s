.intel_syntax noprefix
l: mov rax, [rsi-8]
mov rbx, [rsi-64]
mov rcx, [rsi-65]
mov rdx, [rsi-1]
mov r8, [rsi]
mov r9, [rsi+63]
mov r10, [rsi+64]
add r11, [rdi-128]
add r12, [rdi-100]
mov [rbx-8], rax
mov [rbx-72], rcx
mov byte ptr [rbx-200], al
mov word ptr [rdx-300], ax
fstp tbyte ptr [rcx-400]
fld tbyte ptr [rcx-400]
movaps [r8-16], xmm0
vmovups [r9+rax*4-32], ymm1
movsb
movsq
cmpxchg [rsi-8], rcx
xadd [rdi+8], rax
dec r15
jnz l
