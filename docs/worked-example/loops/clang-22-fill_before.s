.LBB0_2:                                # =>This Inner Loop Header: Depth=1
	movq	24(%rdi), %rcx
	movq	(%rdi), %r8
	movq	8(%rdi), %r9
	leaq	(%rcx,%r8), %r10
	rolq	$23, %r10
	addq	%r8, %r10
	movq	%r9, %r11
	shlq	$17, %r11
	movq	16(%rdi), %rbx
	xorq	%r8, %rbx
	xorq	%r9, %rcx
	xorq	%rbx, %r9
	movq	%r9, 8(%rdi)
	xorq	%rcx, %r8
	movq	%r8, (%rdi)
	xorq	%r11, %rbx
	movq	%rbx, 16(%rdi)
	rolq	$45, %rcx
	movq	%rcx, 24(%rdi)
	movq	%r10, (%rsi,%rax,8)
	incq	%rax
	cmpq	%rax, %rdx
	jne	.LBB0_2
