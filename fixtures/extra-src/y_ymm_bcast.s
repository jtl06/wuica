.intel_syntax noprefix
l: vaddps ymm0, ymm1, dword ptr [rax]{1to8}
vaddps xmm0, xmm1, dword ptr [rax]{1to4}
vaddps ymm0, ymm1, [rax]
vaddsd xmm0, xmm1, xmm2, {rz-sae}
vaddsd xmm0, xmm1, xmm2
vcomisd xmm0, xmm1, {sae}
vpaddd ymm3{k1}, ymm4, ymm5
vpaddd ymm3{k1}{z}, ymm4, [rax]
vmovdqu32 ymm1{k2}, [rsi]
vmovdqu32 [rdi]{k2}, ymm1
vpcompressd [rdi]{k3}, ymm2
vpexpandd ymm2{k3}{z}, [rsi]
kmovb k1, eax
kortestw k1, k2
dec r15
jnz l
