.intel_syntax noprefix
l: mov rax, [rax]
mov rbx, [rbx+8]
mov rcx, [rcx+rdx*8]
mov rsi, [rsi+4096]
mov edi, [rdi+16]
dec r15
jnz l
