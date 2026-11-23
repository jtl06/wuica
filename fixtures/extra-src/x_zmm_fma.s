.intel_syntax noprefix
l: vfmadd231pd zmm0, zmm1, zmm2
vfmadd231pd ymm3, ymm4, ymm5
vfmadd231sd xmm6, xmm7, xmm8
vsqrtpd zmm9, zmm10
vdivpd ymm11, ymm12, ymm13
dec r15
jnz l
