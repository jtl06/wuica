.L15:
	movupd	(%rdi), %xmm3
	movupd	16(%rdi), %xmm4
	addq	$1, %rax
	addq	$32, %rdi
	addpd	%xmm3, %xmm2
	addpd	%xmm4, %xmm1
	cmpq	%rdx, %rax
	jb	.L15
