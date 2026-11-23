.intel_syntax noprefix
l:
vmovups ymm0, ymmword ptr [rdi]
vmovups ymm1, ymmword ptr [rdi+4]
vmovups ymm2, ymmword ptr [rdi+8]
vmovups ymm3, ymmword ptr [rdi+12]
vmovups ymm4, ymmword ptr [rdi+16]
vmovups ymm5, ymmword ptr [rdi+20]
vmovups ymm6, ymmword ptr [rdi+24]
vmovups ymm7, ymmword ptr [rdi+28]
add rdi, 32
cmp r8, rdi
jne l
