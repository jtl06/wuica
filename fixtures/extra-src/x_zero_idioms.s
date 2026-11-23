.intel_syntax noprefix
l: xor eax, eax
sub rbx, rbx
pxor xmm0, xmm0
vpxor ymm1, ymm1, ymm1
pcmpeqd xmm2, xmm2
add rax, rcx
xorps xmm3, xmm3
dec r15
jnz l
