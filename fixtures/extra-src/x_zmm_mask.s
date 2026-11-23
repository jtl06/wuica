.intel_syntax noprefix
l: vpaddd zmm1{k1}{z}, zmm2, zmm3
vpcmpeqd k2, zmm1, zmm4
kandw k3, k2, k1
vpaddd ymm5{k3}, ymm6, ymm7
vpaddd xmm8, xmm9, xmm10
dec r15
jnz l
