	.att_syntax
	.file	"fnv.c"
	.text
	.globl	fnv1a                           # -- Begin function fnv1a
	.prefalign	4, .Lfunc_end0, nop
	.type	fnv1a,@function
fnv1a:                                  # @fnv1a
	.cfi_startproc
# %bb.0:
	movabsq	$-3750763034362895579, %rax     # imm = 0xCBF29CE484222325
	testq	%rsi, %rsi
	je	.LBB0_6
# %bb.1:
	movabsq	$1099511628211, %rcx            # imm = 0x100000001B3
	movl	%esi, %edx
	andl	$7, %edx
	cmpq	$8, %rsi
	jae	.LBB0_7
# %bb.2:
	xorl	%r8d, %r8d
	jmp	.LBB0_4
.LBB0_7:
	andq	$-8, %rsi
	xorl	%r8d, %r8d
	.p2align	4
.LBB0_8:                                # =>This Inner Loop Header: Depth=1
	movzbl	(%rdi,%r8), %r9d
	xorq	%rax, %r9
	imulq	%rcx, %r9
	movzbl	1(%rdi,%r8), %eax
	xorq	%r9, %rax
	imulq	%rcx, %rax
	movzbl	2(%rdi,%r8), %r9d
	xorq	%rax, %r9
	imulq	%rcx, %r9
	movzbl	3(%rdi,%r8), %eax
	xorq	%r9, %rax
	imulq	%rcx, %rax
	movzbl	4(%rdi,%r8), %r9d
	xorq	%rax, %r9
	imulq	%rcx, %r9
	movzbl	5(%rdi,%r8), %eax
	xorq	%r9, %rax
	imulq	%rcx, %rax
	movzbl	6(%rdi,%r8), %r9d
	xorq	%rax, %r9
	imulq	%rcx, %r9
	movzbl	7(%rdi,%r8), %eax
	xorq	%r9, %rax
	imulq	%rcx, %rax
	addq	$8, %r8
	cmpq	%r8, %rsi
	jne	.LBB0_8
# %bb.3:
	testq	%rdx, %rdx
	je	.LBB0_6
.LBB0_4:
	addq	%r8, %rdi
	xorl	%esi, %esi
	.p2align	4
.LBB0_5:                                # =>This Inner Loop Header: Depth=1
	movzbl	(%rdi,%rsi), %r8d
	xorq	%r8, %rax
	imulq	%rcx, %rax
	incq	%rsi
	cmpq	%rsi, %rdx
	jne	.LBB0_5
.LBB0_6:
	retq
.Lfunc_end0:
	.size	fnv1a, .Lfunc_end0-fnv1a
	.cfi_endproc
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
