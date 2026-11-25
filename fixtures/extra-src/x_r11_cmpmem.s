.intel_syntax noprefix
l:
add rax, [rdi+8]
add rdx, 1
test byte ptr [rdi+16], 1
vpcmpeqd ymm1, ymm1, ymm1
vpaddd ymm2, ymm2, ymm1
cmp [rsi+8], rdx
jne l
