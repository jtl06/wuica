.intel_syntax noprefix
l: vpcmpeqd ymm1, ymm1, ymm1
vgatherdps ymm0, [rsi+ymm2*4], ymm1
vpgatherqq ymm3, [rsi+ymm4*8], ymm5
dec r15
jnz l
