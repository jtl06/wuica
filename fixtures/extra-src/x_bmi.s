.intel_syntax noprefix
l: andn rax, rbx, rcx
bextr rdx, rsi, rdi
pdep r8, r9, r10
shlx r11, r12, r13
tzcnt r14, rax
popcnt rbx, [rsi]
mulx rcx, rdx, r8
dec r15
jnz l
