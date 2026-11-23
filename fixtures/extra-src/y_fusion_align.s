.intel_syntax noprefix
.rept 12
1: test rax, rax
jnz 1b
cmp rbx, rcx
jz 1b
nop
add rax, 1
jc 1b
dec rdx
jnz 1b
.endr
