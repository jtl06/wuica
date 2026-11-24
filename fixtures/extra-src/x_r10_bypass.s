.intel_syntax noprefix
l:
vpalignr ymm0, ymm0, ymm15, 4
vandps ymm0, ymm0, ymm15
vpalignr ymm0, ymm0, ymm15, 4
vandps ymm0, ymm0, ymm15
dec rcx
jne l
