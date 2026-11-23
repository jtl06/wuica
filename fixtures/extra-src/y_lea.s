.intel_syntax noprefix
l: lea rax, [rax+8]
lea rbx, [rcx]
lea rdx, [rsi+rdi*2+4]
lea r8, [r8*2]
lea r9d, [r9+1]
lea eax, [eax+ebx]
add rax, 5
sub rbx, -1
inc rcx
dec rdx
add eax, 1
add al, 1
add rax, rbx
lea rsp, [rsp+8]
lea rax, [rip+10]
add rsp, 8
sub rsp, 8
inc byte ptr [rsi]
add qword ptr [rdi], 1
lea rcx, [rcx+rcx]
lea rbp, [rbp+r13]
lea r13, [r13]
mov rax, [rbp]
mov rbx, [r13]
mov rcx, [r12]
mov rdx, [rsp]
mov rsi, [rbp+0]
mov rdi, [rax+0x100]
add rax, 0x1000
cmp rbx, 100000
dec r15
jnz l
