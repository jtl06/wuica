.intel_syntax noprefix
l: add rax, [rsi+rdi*8]
add [rsi+rdi*8], rax
cmovz rax, [rbx+rcx]
movzx eax, byte ptr [rsi+rcx]
vaddps ymm0, ymm1, [rax+rbx*4]
paddd xmm0, [rax+rbx]
mov [rax+rbx], rcx
mov qword ptr [rax+rbx*2+8], 5
inc qword ptr [rax+rcx]
shl qword ptr [rax+rbx], cl
rol byte ptr [rax+rbx], 1
cmpxchg [rax+rbx], rcx
vmaskmovps [rax+rbx], ymm0, ymm1
maskmovdqu xmm0, xmm1
vpmaskmovd ymm0, ymm1, [rax]
bt [rax], rbx
bts qword ptr [rax+rbx], rcx
vgatherdps ymm0, [rax+ymm1*4], ymm2
vpgatherqq ymm3, [rbx+ymm4*8], ymm5
movs qword ptr [rdi], qword ptr [rsi]
cmp byte ptr [rax+rbx], 0
jz l
test qword ptr [rax+rcx*8], rdx
jnz l
dec r15
jnz l
