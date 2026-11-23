.intel_syntax noprefix
l: vpaddd xmm1, xmm2, xmm3
vpaddd ymm4, ymm5, ymm6
vpaddd xmm10, xmm11, xmm12
vmulps ymm13, ymm14, ymm15
dec r15
jnz l
