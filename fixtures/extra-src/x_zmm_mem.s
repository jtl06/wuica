.intel_syntax noprefix
l: vmovdqu64 zmm0, [rsi]
vpaddq zmm0, zmm0, zmm1
vmovdqu64 [rdi], zmm0
vpaddq ymm2, ymm2, [rsi+64]
vpand xmm3, xmm3, xmm4
add rsi, 64
add rdi, 64
dec r15
jnz l
