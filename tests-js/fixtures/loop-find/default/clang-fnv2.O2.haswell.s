	.att_syntax
	.file	"fnv2.c"
	.text
	.globl	fnv2                            # -- Begin function fnv2
	.prefalign	4, .Lfunc_end0, nop
	.type	fnv2,@function
fnv2:                                   # @fnv2
# %bb.0:
	movabsq	$-3750763034362895579, %rax     # imm = 0xCBF29CE484222325
	movabsq	$1099511628211, %rcx            # imm = 0x100000001B3
	cmpq	$2, %rsi
	jae	.LBB0_9
# %bb.1:
	movabsq	$7194454970620864876, %rdx      # imm = 0x63D7D6AD8C66696C
	xorl	%r8d, %r8d
	jmp	.LBB0_3
.LBB0_9:
	leaq	-1(%rax), %r9
	xorl	%r8d, %r8d
	.p2align	4
.LBB0_10:                               # =>This Inner Loop Header: Depth=1
	movq	%r8, %r10
	movzbl	(%rdi,%r8), %edx
	xorq	%rdx, %rax
	imulq	%rcx, %rax
	movzbl	1(%rdi,%r8), %r8d
	movq	%r9, %rdx
	xorq	%r8, %rdx
	movq	%rdx, %r9
	imulq	%rcx, %r9
	leaq	2(%r10), %r8
	addq	$4, %r10
	cmpq	%rsi, %r10
	jbe	.LBB0_10
# %bb.2:
	movabsq	$3298534884633, %r9             # imm = 0x30000000519
	imulq	%r9, %rdx
.LBB0_3:
	movq	%r8, %r9
	subq	%rsi, %r9
	jae	.LBB0_8
# %bb.4:
	movl	%esi, %r10d
	subl	%r8d, %r10d
	andl	$7, %r10d
	je	.LBB0_6
	.p2align	4
.LBB0_5:                                # =>This Inner Loop Header: Depth=1
	movzbl	(%rdi,%r8), %r11d
	xorq	%r11, %rax
	imulq	%rcx, %rax
	incq	%r8
	decq	%r10
	jne	.LBB0_5
.LBB0_6:
	cmpq	$-8, %r9
	ja	.LBB0_8
	.p2align	4
.LBB0_7:                                # =>This Inner Loop Header: Depth=1
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
	jne	.LBB0_7
.LBB0_8:
	xorq	%rdx, %rax
	retq
.Lfunc_end0:
	.size	fnv2, .Lfunc_end0-fnv2
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
