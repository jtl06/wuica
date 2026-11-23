.intel_syntax noprefix
l: cmp rax, rbx
cmovl rcx, rdx
setg sil
adc r8, r9
sbb r10, 0
cmovbe r11, [rsi]
rcr r12, 1
dec r15
jnz l
