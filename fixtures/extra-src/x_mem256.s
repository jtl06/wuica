.intel_syntax noprefix
l: vmovups ymm0, [rsi]
vmovups ymm1, [rsi+32]
vaddps ymm2, ymm0, ymm1
vmovups [rdi], ymm2
vmovups [rdi+32], ymm0
add rsi, 64
add rdi, 64
dec r15
jnz l
