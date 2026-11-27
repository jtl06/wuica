.LBB1_8:                                # =>This Inner Loop Header: Depth=1
	leaq	(%r9,%r8), %rbx
	rolq	$23, %rbx
	addq	%r8, %rbx
	movq	%rax, %r14
	shlq	$17, %r14
	xorq	%r8, %rcx
	xorq	%rax, %r9
	xorq	%rcx, %rax
	xorq	%r9, %r8
	xorq	%r14, %rcx
	rolq	$45, %r9
	movq	%rbx, (%rsi,%r10,8)
	leaq	(%r9,%r8), %rbx
	rolq	$23, %rbx
	addq	%r8, %rbx
	movq	%rax, %r14
	shlq	$17, %r14
	xorq	%r8, %rcx
	xorq	%rax, %r9
	xorq	%rcx, %rax
	xorq	%r9, %r8
	rolq	$45, %r9
	xorq	%r14, %rcx
	movq	%rbx, 8(%rsi,%r10,8)
	addq	$2, %r10
	cmpq	%r10, %r11
	jne	.LBB1_8
