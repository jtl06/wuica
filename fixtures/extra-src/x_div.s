.intel_syntax noprefix
l: xor edx, edx
div rcx
idiv r8d
divsd xmm0, xmm1
sqrtpd xmm2, xmm3
vdivps ymm4, ymm5, [rsi]
dec r15
jnz l
