.intel_syntax noprefix
l: add rax, rbx
mov rcx, [rsi+8]
lea rdx, [rax+rcx*2]
imul r8, rdx
add rax, rbx
mov rcx, [rsi+8]
lea rdx, [rax+rcx*2]
imul r8, rdx
add rax, rbx
mov rcx, [rsi+8]
lea rdx, [rax+rcx*2]
imul r8, rdx
add rax, rbx
mov rcx, [rsi+8]
lea rdx, [rax+rcx*2]
imul r8, rdx
add rax, rbx
mov rcx, [rsi+8]
lea rdx, [rax+rcx*2]
imul r8, rdx
add rax, rbx
mov rcx, [rsi+8]
lea rdx, [rax+rcx*2]
imul r8, rdx
add rax, rbx
mov rcx, [rsi+8]
lea rdx, [rax+rcx*2]
imul r8, rdx
add rax, rbx
mov rcx, [rsi+8]
lea rdx, [rax+rcx*2]
imul r8, rdx
add rax, rbx
mov rcx, [rsi+8]
lea rdx, [rax+rcx*2]
imul r8, rdx
dec r15
jnz l
