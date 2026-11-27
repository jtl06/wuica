.L3:
	addsd	(%rdi), %xmm0
	addq	$16, %rdi
	addsd	-8(%rdi), %xmm0
	cmpq	%rax, %rdi
	jne	.L3
