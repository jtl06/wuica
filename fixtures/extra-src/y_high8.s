.intel_syntax noprefix
l: mov ah, [rsi]
add [rdi], ah
movzx eax, ah
mov [rsi+rax], bh
mov al, [rbx+rcx]
mov bh, 1
mov rax, [rbx]
lea rdx, [rax+rbx]
mov ch, dl
add rcx, 1
mov dh, cl
cmp dh, ah
setz ah
movzx ebx, ch
xchg ah, al
mul ah
add ah, bh
mov [rdx+rcx*2], rax
movzx esi, dh
imul ax, cx
div bh
mov cl, ch
shl rax, cl
dec r15
jnz l
