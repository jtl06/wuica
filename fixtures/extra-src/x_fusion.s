.intel_syntax noprefix
l: cmp rax, rbx
jne m
test rcx, rcx
je m
add rdx, 1
m: sub r8, 1
cmp r8, [rsi]
jb n
n: dec r15
jnz l
