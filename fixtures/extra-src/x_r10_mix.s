.intel_syntax noprefix
l:
vmulps ymm0, ymm14, ymm15
vpalignr ymm8, ymm14, ymm15, 4
vmulps ymm1, ymm14, ymm15
vpalignr ymm9, ymm14, ymm15, 4
vmulps ymm2, ymm14, ymm15
vpalignr ymm10, ymm14, ymm15, 4
vmulps ymm3, ymm14, ymm15
vpalignr ymm11, ymm14, ymm15, 4
vmulps ymm4, ymm14, ymm15
vpalignr ymm12, ymm14, ymm15, 4
vmulps ymm5, ymm14, ymm15
vpalignr ymm13, ymm14, ymm15, 4
vmulps ymm6, ymm14, ymm15
vmulps ymm7, ymm14, ymm15
dec rcx
jne l
