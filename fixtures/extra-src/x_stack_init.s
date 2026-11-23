# With -initPolicy stack, RSP and RBP start with values of their own, so [rsp+8] and [rbx+8] are different addresses (with
# 'same' they are the same address, and the load depends on the store). wuica treated 'stack' like 'same'; found in a
# review of the crash sites.
.intel_syntax noprefix
l: mov [rsp+8], rax
mov rax, [rbx+8]
add rax, 1
mov [rbp+16], rax
mov rcx, [rdx+16]
dec r15
jnz l
