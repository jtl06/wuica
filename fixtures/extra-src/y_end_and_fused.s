.intel_syntax noprefix
l: inc rax
jnz m
m: sub rbx, rcx
jb l
and rax, rbx
js l
