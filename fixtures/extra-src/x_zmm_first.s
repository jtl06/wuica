.intel_syntax noprefix
l: vaddps zmm0, zmm1, zmm2
vaddps ymm3, ymm4, ymm5
vaddps xmm6, xmm7, xmm8
vpxor xmm9, xmm9, xmm9
add rax, rbx
dec r15
jnz l
