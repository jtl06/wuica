.intel_syntax noprefix
l: mov eax, eax
mov rax, rax
movzx eax, al
movzx ebx, bx
movsx rax, al
movsxd rcx, ecx
movaps xmm0, xmm0
vmovdqa ymm1, ymm1
movq xmm0, xmm0
mov ax, ax
mov al, al
mov ah, ah
movzx esi, sil
movzx edi, dil
movzx eax, spl
movzx r8d, r12b
movzx ecx, ah
movzx rdx, bpl
movzx r9, r13b
movzx r10d, r10b
cmova rax, rax
movd xmm0, eax
mov cl, bl
mov rax, rbx
mov r11d, r12d
movdqa xmm1, xmm2
vmovaps ymm3, ymm4
movzx eax, bl
movzx ecx, cx
movsx edx, dx
movsxd rsi, edi
xor eax, eax
sub rbx, rbx
pxor xmm5, xmm5
vpxor ymm6, ymm6, ymm6
pcmpeqd xmm7, xmm7
cmp rax, rax
test rbx, rbx
and rcx, rcx
or rdx, rdx
xchg rsi, rsi
dec r15
jnz l
