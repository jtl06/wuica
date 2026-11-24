	.att_syntax
	.file	"scan_v2.c"
	.text
	.globl	my_memchr                       # -- Begin function my_memchr
	.prefalign	4, .Lfunc_end0, nop
	.type	my_memchr,@function
my_memchr:                              # @my_memchr
	.cfi_startproc
# %bb.0:
	pushq	%rbx
	.cfi_def_cfa_offset 16
	.cfi_offset %rbx, -16
	movq	%rdi, %rax
	movabsq	$-9187201950435737472, %rcx     # imm = 0x8080808080808080
	movabsq	$72340172838076672, %rdi        # imm = 0x101010101010100
	movzbl	%sil, %r9d
	leaq	1(%rdi), %r8
	imulq	%r9, %r8
	xorl	%r10d, %r10d
	.p2align	4
.LBB0_1:                                # =>This Inner Loop Header: Depth=1
	movq	%r10, %r9
	addq	$8, %r10
	cmpq	%rdx, %r10
	ja	.LBB0_3
# %bb.2:                                #   in Loop: Header=BB0_1 Depth=1
	movq	(%rax,%r9), %r11
	xorq	%r8, %r11
	movq	%rdi, %rbx
	subq	%r11, %rbx
	orq	%r11, %rbx
	andnq	%rcx, %rbx, %r11
	je	.LBB0_1
.LBB0_3:
	subq	%r9, %rdx
	jbe	.LBB0_7
# %bb.4:
	addq	%r9, %rax
	.p2align	4
.LBB0_5:                                # =>This Inner Loop Header: Depth=1
	cmpb	%sil, (%rax)
	je	.LBB0_8
# %bb.6:                                #   in Loop: Header=BB0_5 Depth=1
	incq	%rax
	decq	%rdx
	jne	.LBB0_5
.LBB0_7:
	xorl	%eax, %eax
.LBB0_8:
	popq	%rbx
	.cfi_def_cfa_offset 8
	retq
.Lfunc_end0:
	.size	my_memchr, .Lfunc_end0-my_memchr
	.cfi_endproc
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
