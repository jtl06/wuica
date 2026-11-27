.L8:
	leaq	(%rax,%rdi), %rdx
	movq	%r8, %r9
	xorq	%rdi, %rcx
	xorq	%r8, %rax
	rolq	$23, %rdx
	salq	$17, %r9
	addq	$8, %rsi
	xorq	%rcx, %r8
	addq	%rdi, %rdx
	xorq	%r9, %rcx
	xorq	%rax, %rdi
	rorq	$19, %rax
	movq	%rdx, -8(%rsi)
	cmpq	%rsi, %r11
	jne	.L8
