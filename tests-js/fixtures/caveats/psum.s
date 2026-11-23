.intel_syntax noprefix
.L:
	add    edx,DWORD PTR [rdi+rax*4]
	mov    DWORD PTR [rsi+rax*4],edx
	inc    rax
	cmp    rcx,rax
	jne .L
