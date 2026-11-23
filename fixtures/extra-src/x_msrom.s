.intel_syntax noprefix
l: bsf rax, rbx
shld rax, rbx, cl
rcl rcx, 3
xlatb
aeskeygenassist xmm0, xmm1, 3
pcmpistri xmm2, xmm3, 0
dec r15
jnz l
