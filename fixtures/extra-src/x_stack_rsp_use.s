.intel_syntax noprefix
l: push rdi
lea rax, [rsp+16]
mov rbx, rsp
pop rdi
sub rsp, 32
mov [rsp], rax
add rsp, 32
dec r15
jnz l
