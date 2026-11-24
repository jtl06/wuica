.intel_syntax noprefix
l:
vperm2i128 ymm0, ymm0, ymm15, 0x21
vpaddd ymm0, ymm0, ymm15
vperm2i128 ymm0, ymm0, ymm15, 0x21
vpaddd ymm0, ymm0, ymm15
dec rcx
jne l
