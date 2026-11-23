.intel_syntax noprefix
l: rep movsb
rep stosq
repne scasb
repe cmpsb
movsb
stosq
scasb
cmpsb
lodsb
rep lodsb
rep movsq
pause
nop
xchg ax, ax
nop dword ptr [rax]
nop word ptr [rax+rax*1+0]
rep stosb
repne cmpsq
dec r15
jnz l
