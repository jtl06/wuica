.intel_syntax noprefix
l:
vaddps ymm0, ymm0, ymm15
vmulps ymm1, ymm0, ymm14
vaddps ymm2, ymm1, ymm15
vsubpd xmm3, xmm2, xmm13
vmaxpd xmm4, xmm3, xmm12
addss xmm5, xmm4
vmovups [rdi], ymm2
dec rcx
jne l
