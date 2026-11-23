.intel_syntax noprefix
l: add ah, ah
mov rcx, rax
mov bh, 3
add rbx, rcx
setz dh
movzx esi, dh
dec r15
jnz l
