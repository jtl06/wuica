	.intel_syntax noprefix
	.text
	.globl	fa
fa:
	xor eax, eax
1:
	add rax, qword ptr [rdi]
	add rdi, 8
	dec rcx
	jnz 1b
	ret
	.globl	fb
fb:
	vxorps xmm0, xmm0, xmm0
1:
	vaddss xmm0, xmm0, dword ptr [rdi]
	add rdi, 4
	dec rcx
	jnz 1b
	ret
