.intel_syntax noprefix
l:
mov r8, rax
mov r9, rbx
mov r10, rcx
mov r11, rdx
movaps xmm1, xmm0
mov rsi, r8
mov rdi, r9
movaps xmm2, xmm1
add rax, r11
dec rcx
jne l
