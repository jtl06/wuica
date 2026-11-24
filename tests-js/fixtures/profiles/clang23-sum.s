	.att_syntax
	.file	"sum.c"
	.text
	.globl	dot                             # -- Begin function dot
	.prefalign	4, .Lfunc_end0, nop
	.type	dot,@function
dot:                                    # @dot
	.cfi_startproc
# %bb.0:
	testq	%rdx, %rdx
	jle	.LBB0_1
# %bb.2:
	movl	%edx, %eax
	andl	$3, %eax
	cmpq	$4, %rdx
	jae	.LBB0_8
# %bb.3:
	xorps	%xmm0, %xmm0
	xorl	%ecx, %ecx
	jmp	.LBB0_5
.LBB0_1:
	xorps	%xmm0, %xmm0
	retq
.LBB0_8:
	movabsq	$9223372036854775804, %rcx      # imm = 0x7FFFFFFFFFFFFFFC
	andq	%rcx, %rdx
	xorps	%xmm0, %xmm0
	xorl	%ecx, %ecx
	.p2align	4
.LBB0_9:                                # =>This Inner Loop Header: Depth=1
	movss	(%rdi,%rcx,4), %xmm1            # xmm1 = mem[0],zero,zero,zero
	movss	4(%rdi,%rcx,4), %xmm2           # xmm2 = mem[0],zero,zero,zero
	mulss	(%rsi,%rcx,4), %xmm1
	mulss	4(%rsi,%rcx,4), %xmm2
	addss	%xmm0, %xmm1
	movss	8(%rdi,%rcx,4), %xmm3           # xmm3 = mem[0],zero,zero,zero
	mulss	8(%rsi,%rcx,4), %xmm3
	addss	%xmm1, %xmm2
	movss	12(%rdi,%rcx,4), %xmm0          # xmm0 = mem[0],zero,zero,zero
	mulss	12(%rsi,%rcx,4), %xmm0
	addss	%xmm2, %xmm3
	addss	%xmm3, %xmm0
	addq	$4, %rcx
	cmpq	%rcx, %rdx
	jne	.LBB0_9
# %bb.4:
	testq	%rax, %rax
	je	.LBB0_7
.LBB0_5:
	leaq	(%rsi,%rcx,4), %rdx
	leaq	(%rdi,%rcx,4), %rcx
	xorl	%esi, %esi
	.p2align	4
.LBB0_6:                                # =>This Inner Loop Header: Depth=1
	movss	(%rcx,%rsi,4), %xmm1            # xmm1 = mem[0],zero,zero,zero
	mulss	(%rdx,%rsi,4), %xmm1
	addss	%xmm1, %xmm0
	incq	%rsi
	cmpq	%rsi, %rax
	jne	.LBB0_6
.LBB0_7:
	retq
.Lfunc_end0:
	.size	dot, .Lfunc_end0-dot
	.cfi_endproc
                                        # -- End function
	.section	.rodata.cst16,"aM",@progbits,16
	.p2align	4, 0x0                          # -- Begin function count
.LCPI1_0:
	.zero	16,1
	.text
	.globl	count
	.prefalign	4, .Lfunc_end1, nop
	.type	count,@function
count:                                  # @count
	.cfi_startproc
# %bb.0:
	testq	%rsi, %rsi
	jle	.LBB1_1
# %bb.2:
	cmpq	$4, %rsi
	jae	.LBB1_5
# %bb.3:
	xorl	%ecx, %ecx
	xorl	%eax, %eax
	jmp	.LBB1_4
.LBB1_1:
	xorl	%eax, %eax
	retq
.LBB1_5:
	movabsq	$9223372036854775804, %rcx      # imm = 0x7FFFFFFFFFFFFFFC
	andq	%rsi, %rcx
	pxor	%xmm0, %xmm0
	xorl	%eax, %eax
	movdqa	.LCPI1_0(%rip), %xmm3           # xmm3 = [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
	pxor	%xmm2, %xmm2
	pxor	%xmm1, %xmm1
	.p2align	4
.LBB1_6:                                # =>This Inner Loop Header: Depth=1
	movzwl	(%rdi,%rax), %edx
	movd	%edx, %xmm4
	movzwl	2(%rdi,%rax), %edx
	movd	%edx, %xmm5
	psrlw	$7, %xmm4
	pand	%xmm3, %xmm4
	psrlw	$7, %xmm5
	pand	%xmm3, %xmm5
	punpcklbw	%xmm0, %xmm4            # xmm4 = xmm4[0],xmm0[0],xmm4[1],xmm0[1],xmm4[2],xmm0[2],xmm4[3],xmm0[3],xmm4[4],xmm0[4],xmm4[5],xmm0[5],xmm4[6],xmm0[6],xmm4[7],xmm0[7]
	punpcklwd	%xmm0, %xmm4            # xmm4 = xmm4[0],xmm0[0],xmm4[1],xmm0[1],xmm4[2],xmm0[2],xmm4[3],xmm0[3]
	punpckldq	%xmm0, %xmm4            # xmm4 = xmm4[0],xmm0[0],xmm4[1],xmm0[1]
	paddq	%xmm4, %xmm2
	punpcklbw	%xmm0, %xmm5            # xmm5 = xmm5[0],xmm0[0],xmm5[1],xmm0[1],xmm5[2],xmm0[2],xmm5[3],xmm0[3],xmm5[4],xmm0[4],xmm5[5],xmm0[5],xmm5[6],xmm0[6],xmm5[7],xmm0[7]
	punpcklwd	%xmm0, %xmm5            # xmm5 = xmm5[0],xmm0[0],xmm5[1],xmm0[1],xmm5[2],xmm0[2],xmm5[3],xmm0[3]
	punpckldq	%xmm0, %xmm5            # xmm5 = xmm5[0],xmm0[0],xmm5[1],xmm0[1]
	paddq	%xmm5, %xmm1
	addq	$4, %rax
	cmpq	%rax, %rcx
	jne	.LBB1_6
# %bb.7:
	paddq	%xmm2, %xmm1
	pshufd	$238, %xmm1, %xmm0              # xmm0 = xmm1[2,3,2,3]
	paddq	%xmm1, %xmm0
	movq	%xmm0, %rax
	jmp	.LBB1_8
.LBB1_4:
	movzbl	(%rdi,%rcx), %edx
	shrl	$7, %edx
	addq	%rdx, %rax
	incq	%rcx
.LBB1_8:
	cmpq	%rcx, %rsi
	jne	.LBB1_4
# %bb.9:
	retq
.Lfunc_end1:
	.size	count, .Lfunc_end1-count
	.cfi_endproc
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
