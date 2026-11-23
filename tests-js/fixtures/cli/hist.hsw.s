	.text
	.file	"hist.c"
	.globl	hist                            # -- Begin function hist
	.p2align	4, 0x90
	.type	hist,@function
hist:                                   # @hist
	.cfi_startproc
# %bb.0:
	testq	%rsi, %rsi
	je	.LBB0_6
# %bb.1:
	movl	%esi, %eax
	andl	$7, %eax
	cmpq	$8, %rsi
	jae	.LBB0_7
# %bb.2:
	xorl	%ecx, %ecx
	jmp	.LBB0_3
.LBB0_7:
	andq	$-8, %rsi
	xorl	%ecx, %ecx
	.p2align	4, 0x90
.LBB0_8:                                # =>This Inner Loop Header: Depth=1
	movzbl	(%rdi,%rcx), %r8d
	incl	(%rdx,%r8,4)
	movzbl	1(%rdi,%rcx), %r8d
	incl	(%rdx,%r8,4)
	movzbl	2(%rdi,%rcx), %r8d
	incl	(%rdx,%r8,4)
	movzbl	3(%rdi,%rcx), %r8d
	incl	(%rdx,%r8,4)
	movzbl	4(%rdi,%rcx), %r8d
	incl	(%rdx,%r8,4)
	movzbl	5(%rdi,%rcx), %r8d
	incl	(%rdx,%r8,4)
	movzbl	6(%rdi,%rcx), %r8d
	incl	(%rdx,%r8,4)
	movzbl	7(%rdi,%rcx), %r8d
	incl	(%rdx,%r8,4)
	addq	$8, %rcx
	cmpq	%rcx, %rsi
	jne	.LBB0_8
.LBB0_3:
	testq	%rax, %rax
	je	.LBB0_6
# %bb.4:
	addq	%rcx, %rdi
	xorl	%ecx, %ecx
	.p2align	4, 0x90
.LBB0_5:                                # =>This Inner Loop Header: Depth=1
	movzbl	(%rdi,%rcx), %esi
	incl	(%rdx,%rsi,4)
	incq	%rcx
	cmpq	%rcx, %rax
	jne	.LBB0_5
.LBB0_6:
	retq
.Lfunc_end0:
	.size	hist, .Lfunc_end0-hist
	.cfi_endproc
                                        # -- End function
	.ident	"Apple clang version 17.0.0 (clang-1700.0.13.5)"
	.section	".note.GNU-stack","",@progbits
	.addrsig
