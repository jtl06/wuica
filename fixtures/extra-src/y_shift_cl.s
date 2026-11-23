.intel_syntax noprefix
l: shl rax, cl
shr ebx, cl
sar rdx, cl
rol rsi, cl
ror di, cl
shl r8b, cl
shl ah, cl
sar bh, cl
add rax, rbx
shl rax, cl
mov al, ah
shr rbx, cl
shl rcx, cl
sar r9d, cl
dec r15
jnz l
