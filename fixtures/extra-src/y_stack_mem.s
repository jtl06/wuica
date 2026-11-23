.intel_syntax noprefix
l: push qword ptr [rsp+8]
pop qword ptr [rsp]
push qword ptr [rax]
pop qword ptr [rbx+rcx*8]
push ax
pop bx
pop rsp
pop sp
pop r12
pop r13
push rsp
push 0x12345678
push 5
push word ptr [rsp]
pop word ptr [rsi]
leave
pushfq
popfq
enter 16, 0
push qword ptr [rsp+rax*2]
pop qword ptr [rsp+rbx]
mov rax, [rsp]
add [rsp+8], rax
dec r15
jnz l
