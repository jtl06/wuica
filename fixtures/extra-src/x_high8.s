.intel_syntax noprefix
l: mov ah, bl
add eax, ecx
mov ch, [rsi]
movzx edx, ch
add al, ah
inc ah
mov rbx, rax
dec r15
jnz l
