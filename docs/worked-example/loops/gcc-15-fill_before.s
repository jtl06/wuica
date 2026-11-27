.L3:
	movq	(%rdi), %rcx
	movq	8(%rdi), %rdx
	addq	$8, %r8
	movq	16(%rdi), %r9
	movq	24(%rdi), %rax
	movq	%rdx, %r10
	xorq	%rcx, %r9
	movq	%rax, %rsi
	addq	%rcx, %rax
	xorq	%r9, %r10
	xorq	%rdx, %rsi
	rolq	$23, %rax
	movq	%r10, 8(%rdi)
	salq	$17, %rdx
	movq	%rcx, %r10
	addq	%rcx, %rax
	xorq	%rsi, %r10
	xorq	%r9, %rdx
	rorq	$19, %rsi
	movq	%r10, (%rdi)
	movq	%rdx, 16(%rdi)
	movq	%rsi, 24(%rdi)
	movq	%rax, -8(%r8)
	cmpq	%r8, %r11
	jne	.L3
