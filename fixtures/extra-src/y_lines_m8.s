.intel_syntax noprefix
l: mov [rdi], rax
mov [rdi+64], rbx
setz byte ptr [rcx-1]
mov byte ptr [rcx-64], 5
dec r15
jnz l
