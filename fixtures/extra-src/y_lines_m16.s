.intel_syntax noprefix
l: mov word ptr [rsi], ax
mov [rdi], rax
movdqu xmmword ptr [rdx], xmm0
add byte ptr [rcx], 1
dec r15
jnz l
