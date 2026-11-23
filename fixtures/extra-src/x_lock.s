.intel_syntax noprefix
l: lock add [rsi], rax
lock xadd [rsi+8], rbx
lock cmpxchg [rsi+16], rcx
xchg [rsi+24], rdx
lock inc qword ptr [rsi+32]
dec r15
jnz l
