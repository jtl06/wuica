.intel_syntax noprefix
l: mov [rsi], rax
mov rbx, [rsi]
mov [rsi+8], bl
mov rcx, [rsi+8]
mov [rsi+16], ecx
movzx edx, word ptr [rsi+16]
add qword ptr [rsi+24], 1
add rax, rbx
dec r15
jnz l
