	.text
	.file	"divmod.c"
	.globl	sum_mod                         # -- Begin function sum_mod
	.p2align	4, 0x90
	.type	sum_mod,@function
sum_mod:                                # @sum_mod
	.cfi_startproc
# %bb.0:
	testq	%rsi, %rsi
	je	.LBB0_1
# %bb.3:
	pushq	%r14
	.cfi_def_cfa_offset 16
	pushq	%rbx
	.cfi_def_cfa_offset 24
	.cfi_offset %rbx, -24
	.cfi_offset %r14, -16
	movq	%rdx, %rcx
	movl	%esi, %r11d
	andl	$3, %r11d
	cmpq	$4, %rsi
	jae	.LBB0_12
# %bb.4:
	xorl	%ebx, %ebx
	xorl	%r8d, %r8d
.LBB0_5:
	testq	%r11, %r11
	je	.LBB0_11
# %bb.6:
	leaq	(%rdi,%rbx,8), %rsi
	xorl	%edi, %edi
	jmp	.LBB0_7
	.p2align	4, 0x90
.LBB0_9:                                #   in Loop: Header=BB0_7 Depth=1
	xorl	%edx, %edx
	divq	%rcx
	addq	%rdx, %r8
	incq	%rdi
	cmpq	%rdi, %r11
	je	.LBB0_11
.LBB0_7:                                # =>This Inner Loop Header: Depth=1
	movq	(%rsi,%rdi,8), %rax
	movq	%rax, %rdx
	orq	%rcx, %rdx
	shrq	$32, %rdx
	jne	.LBB0_9
# %bb.8:                                #   in Loop: Header=BB0_7 Depth=1
                                        # kill: def $eax killed $eax killed $rax
	xorl	%edx, %edx
	divl	%ecx
                                        # kill: def $edx killed $edx def $rdx
	addq	%rdx, %r8
	incq	%rdi
	cmpq	%rdi, %r11
	jne	.LBB0_7
.LBB0_11:
	popq	%rbx
	.cfi_def_cfa_offset 16
	popq	%r14
	.cfi_def_cfa_offset 8
	.cfi_restore %rbx
	.cfi_restore %r14
	movq	%r8, %rax
	retq
.LBB0_1:
	xorl	%r8d, %r8d
	movq	%r8, %rax
	retq
.LBB0_12:
	.cfi_def_cfa_offset 24
	.cfi_offset %rbx, -24
	.cfi_offset %r14, -16
	andq	$-4, %rsi
	xorl	%ebx, %ebx
	xorl	%r14d, %r14d
	jmp	.LBB0_13
	.p2align	4, 0x90
.LBB0_24:                               #   in Loop: Header=BB0_13 Depth=1
	xorl	%edx, %edx
	divq	%rcx
.LBB0_25:                               #   in Loop: Header=BB0_13 Depth=1
	addq	%r14, %r9
	addq	%r9, %r10
	addq	%r10, %r8
	addq	%rdx, %r8
	addq	$4, %rbx
	movq	%r8, %r14
	cmpq	%rbx, %rsi
	je	.LBB0_5
.LBB0_13:                               # =>This Inner Loop Header: Depth=1
	movq	(%rdi,%rbx,8), %rax
	movq	%rax, %rdx
	orq	%rcx, %rdx
	shrq	$32, %rdx
	je	.LBB0_14
# %bb.15:                               #   in Loop: Header=BB0_13 Depth=1
	xorl	%edx, %edx
	divq	%rcx
	movq	%rdx, %r9
	jmp	.LBB0_16
	.p2align	4, 0x90
.LBB0_14:                               #   in Loop: Header=BB0_13 Depth=1
                                        # kill: def $eax killed $eax killed $rax
	xorl	%edx, %edx
	divl	%ecx
	movl	%edx, %r9d
.LBB0_16:                               #   in Loop: Header=BB0_13 Depth=1
	movq	8(%rdi,%rbx,8), %rax
	movq	%rax, %rdx
	orq	%rcx, %rdx
	shrq	$32, %rdx
	je	.LBB0_17
# %bb.18:                               #   in Loop: Header=BB0_13 Depth=1
	xorl	%edx, %edx
	divq	%rcx
	movq	%rdx, %r10
	jmp	.LBB0_19
	.p2align	4, 0x90
.LBB0_17:                               #   in Loop: Header=BB0_13 Depth=1
                                        # kill: def $eax killed $eax killed $rax
	xorl	%edx, %edx
	divl	%ecx
	movl	%edx, %r10d
.LBB0_19:                               #   in Loop: Header=BB0_13 Depth=1
	movq	16(%rdi,%rbx,8), %rax
	movq	%rax, %rdx
	orq	%rcx, %rdx
	shrq	$32, %rdx
	je	.LBB0_20
# %bb.21:                               #   in Loop: Header=BB0_13 Depth=1
	xorl	%edx, %edx
	divq	%rcx
	movq	%rdx, %r8
	jmp	.LBB0_22
	.p2align	4, 0x90
.LBB0_20:                               #   in Loop: Header=BB0_13 Depth=1
                                        # kill: def $eax killed $eax killed $rax
	xorl	%edx, %edx
	divl	%ecx
	movl	%edx, %r8d
.LBB0_22:                               #   in Loop: Header=BB0_13 Depth=1
	movq	24(%rdi,%rbx,8), %rax
	movq	%rax, %rdx
	orq	%rcx, %rdx
	shrq	$32, %rdx
	jne	.LBB0_24
# %bb.23:                               #   in Loop: Header=BB0_13 Depth=1
                                        # kill: def $eax killed $eax killed $rax
	xorl	%edx, %edx
	divl	%ecx
                                        # kill: def $edx killed $edx def $rdx
	jmp	.LBB0_25
.Lfunc_end0:
	.size	sum_mod, .Lfunc_end0-sum_mod
	.cfi_endproc
                                        # -- End function
	.ident	"Apple clang version 17.0.0 (clang-1700.0.13.5)"
	.section	".note.GNU-stack","",@progbits
	.addrsig
