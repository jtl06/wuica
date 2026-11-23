.intel_syntax noprefix
l: push rax
push rbx
mov rcx, [rsp+8]
pop rbx
pop rax
add rax, rcx
dec r15
jnz l
