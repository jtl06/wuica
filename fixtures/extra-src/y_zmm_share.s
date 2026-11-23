.intel_syntax noprefix
l: lea rax, [rbx+rcx]
andn rax, rbx, rcx
imul rax, rbx
popcnt rcx, rdx
add rsi, rdi
vpaddd zmm0, zmm1, zmm2
vpaddd zmm3{k1}{z}, zmm4, zmm5
kandw k1, k2, k3
kmovw eax, k1
vmovd eax, xmm0
vpextrq rax, xmm1, 1
vmovq xmm2, rax
vpbroadcastd zmm6, eax
fadd st(0), st(1)
paddb mm0, mm1
movq2dq xmm0, mm1
vaddps zmm0, zmm1, dword ptr [rax]{1to16}
vaddps zmm0, zmm1, zmm2, {rn-sae}
vcmpps k1, zmm0, zmm1, {sae}, 1
vaddps zmm0, zmm1, zmmword ptr [rax]
vpaddq zmm0, zmm1, qword ptr [rax+rbx*8]{1to8}
vfmadd231pd zmm0{k2}, zmm1, zmm2
vpternlogd zmm0, zmm1, zmm2, 0xff
vcvtsi2sd xmm0, xmm1, rax
lea rdx, [rbx+rcx]
pdep rax, rbx, rcx
bsf rax, rbx
cmp rax, rbx
jnz l
