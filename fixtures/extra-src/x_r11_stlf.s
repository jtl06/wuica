.intel_syntax noprefix
l:
mov [rsi+256], rax
add eax, [rsi+260]
mov [rsi+512], eax
mov [rsi+516], eax
mov [rsi+520], eax
mov [rsi+524], eax
movdqu xmm1, [rsi+512]
vmovdqu [rsi+768], ymm0
vpaddd ymm0, ymm0, [rsi+768]
mov word ptr [rsi+1024], ax
movzx edx, byte ptr [rsi+1025]
add rax, rdx
dec rcx
jne l
