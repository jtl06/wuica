.intel_syntax noprefix
l: lfence
add rax, rbx
mfence
mov [rsi], rax
sfence
mov rbx, [rsi]
pause
dec r15
jnz l
