	.text
	.file	"psum.c"
	.globl	psum                            # -- Begin function psum
	.p2align	4, 0x90
	.type	psum,@function
psum:                                   # @psum
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
	xorl	%edx, %edx
	xorl	%ecx, %ecx
	jmp	.LBB0_3
.LBB0_7:
	andq	$-8, %rsi
	xorl	%edx, %edx
	xorl	%ecx, %ecx
	.p2align	4, 0x90
.LBB0_8:                                # =>This Inner Loop Header: Depth=1
	addq	(%rdi,%rdx,8), %rcx
	movq	%rcx, (%rdi,%rdx,8)
	addq	8(%rdi,%rdx,8), %rcx
	movq	%rcx, 8(%rdi,%rdx,8)
	addq	16(%rdi,%rdx,8), %rcx
	movq	%rcx, 16(%rdi,%rdx,8)
	addq	24(%rdi,%rdx,8), %rcx
	movq	%rcx, 24(%rdi,%rdx,8)
	addq	32(%rdi,%rdx,8), %rcx
	movq	%rcx, 32(%rdi,%rdx,8)
	addq	40(%rdi,%rdx,8), %rcx
	movq	%rcx, 40(%rdi,%rdx,8)
	addq	48(%rdi,%rdx,8), %rcx
	movq	%rcx, 48(%rdi,%rdx,8)
	addq	56(%rdi,%rdx,8), %rcx
	movq	%rcx, 56(%rdi,%rdx,8)
	addq	$8, %rdx
	cmpq	%rdx, %rsi
	jne	.LBB0_8
.LBB0_3:
	testq	%rax, %rax
	je	.LBB0_6
# %bb.4:
	leaq	(%rdi,%rdx,8), %rdx
	xorl	%esi, %esi
	.p2align	4, 0x90
.LBB0_5:                                # =>This Inner Loop Header: Depth=1
	addq	(%rdx,%rsi,8), %rcx
	movq	%rcx, (%rdx,%rsi,8)
	incq	%rsi
	cmpq	%rsi, %rax
	jne	.LBB0_5
.LBB0_6:
	retq
.Lfunc_end0:
	.size	psum, .Lfunc_end0-psum
	.cfi_endproc
                                        # -- End function
	.ident	"Apple clang version 17.0.0 (clang-1700.0.13.5)"
	.section	".note.GNU-stack","",@progbits
	.addrsig
