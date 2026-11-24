	.att_syntax
	.file	"multi.c"
	.text
	.globl	sum                             # -- Begin function sum
	.prefalign	4, .Lfunc_end0, nop
	.type	sum,@function
sum:                                    # @sum
	.cfi_startproc
# %bb.0:
	testq	%rsi, %rsi
	je	.LBB0_1
# %bb.2:
	movl	%esi, %eax
	andl	$7, %eax
	cmpq	$8, %rsi
	jae	.LBB0_8
# %bb.3:
	vxorps	%xmm0, %xmm0, %xmm0
	xorl	%ecx, %ecx
	jmp	.LBB0_5
.LBB0_1:
	vxorps	%xmm0, %xmm0, %xmm0
	retq
.LBB0_8:
	andq	$-8, %rsi
	vxorps	%xmm0, %xmm0, %xmm0
	xorl	%ecx, %ecx
	.p2align	4
.LBB0_9:                                # =>This Inner Loop Header: Depth=1
	vaddss	(%rdi,%rcx,4), %xmm0, %xmm0
	vaddss	4(%rdi,%rcx,4), %xmm0, %xmm0
	vaddss	8(%rdi,%rcx,4), %xmm0, %xmm0
	vaddss	12(%rdi,%rcx,4), %xmm0, %xmm0
	vaddss	16(%rdi,%rcx,4), %xmm0, %xmm0
	vaddss	20(%rdi,%rcx,4), %xmm0, %xmm0
	vaddss	24(%rdi,%rcx,4), %xmm0, %xmm0
	vaddss	28(%rdi,%rcx,4), %xmm0, %xmm0
	addq	$8, %rcx
	cmpq	%rcx, %rsi
	jne	.LBB0_9
# %bb.4:
	testq	%rax, %rax
	je	.LBB0_7
.LBB0_5:
	leaq	(%rdi,%rcx,4), %rcx
	xorl	%edx, %edx
	.p2align	4
.LBB0_6:                                # =>This Inner Loop Header: Depth=1
	vaddss	(%rcx,%rdx,4), %xmm0, %xmm0
	incq	%rdx
	cmpq	%rdx, %rax
	jne	.LBB0_6
.LBB0_7:
	retq
.Lfunc_end0:
	.size	sum, .Lfunc_end0-sum
	.cfi_endproc
                                        # -- End function
	.globl	scale                           # -- Begin function scale
	.prefalign	4, .Lfunc_end1, nop
	.type	scale,@function
scale:                                  # @scale
	.cfi_startproc
# %bb.0:
	testq	%rsi, %rsi
	je	.LBB1_13
# %bb.1:
	cmpq	$4, %rsi
	jae	.LBB1_4
# %bb.2:
	xorl	%eax, %eax
	jmp	.LBB1_3
.LBB1_4:
	cmpq	$32, %rsi
	jae	.LBB1_6
# %bb.5:
	xorl	%eax, %eax
	jmp	.LBB1_10
.LBB1_6:
	movq	%rsi, %rax
	andq	$-32, %rax
	vbroadcastss	%xmm0, %ymm1
	xorl	%ecx, %ecx
	.p2align	4
.LBB1_7:                                # =>This Inner Loop Header: Depth=1
	vmulps	(%rdi,%rcx,4), %ymm1, %ymm2
	vmulps	32(%rdi,%rcx,4), %ymm1, %ymm3
	vmulps	64(%rdi,%rcx,4), %ymm1, %ymm4
	vmulps	96(%rdi,%rcx,4), %ymm1, %ymm5
	vmovups	%ymm2, (%rdi,%rcx,4)
	vmovups	%ymm3, 32(%rdi,%rcx,4)
	vmovups	%ymm4, 64(%rdi,%rcx,4)
	vmovups	%ymm5, 96(%rdi,%rcx,4)
	addq	$32, %rcx
	cmpq	%rcx, %rax
	jne	.LBB1_7
# %bb.8:
	cmpq	%rax, %rsi
	je	.LBB1_13
# %bb.9:
	testb	$28, %sil
	je	.LBB1_3
.LBB1_10:
	movq	%rax, %rcx
	movq	%rsi, %rax
	andq	$-4, %rax
	vbroadcastss	%xmm0, %xmm1
	.p2align	4
.LBB1_11:                               # =>This Inner Loop Header: Depth=1
	vmulps	(%rdi,%rcx,4), %xmm1, %xmm2
	vmovups	%xmm2, (%rdi,%rcx,4)
	addq	$4, %rcx
	cmpq	%rcx, %rax
	jne	.LBB1_11
	jmp	.LBB1_12
.LBB1_3:
	vmulss	(%rdi,%rax,4), %xmm0, %xmm1
	vmovss	%xmm1, (%rdi,%rax,4)
	incq	%rax
.LBB1_12:
	cmpq	%rax, %rsi
	jne	.LBB1_3
.LBB1_13:
	vzeroupper
	retq
.Lfunc_end1:
	.size	scale, .Lfunc_end1-scale
	.cfi_endproc
                                        # -- End function
	.section	.rodata.cst32,"aM",@progbits,32
	.p2align	5, 0x0                          # -- Begin function popc
.LCPI2_0:
	.zero	32,15
.LCPI2_1:
	.byte	0                               # 0x0
	.byte	1                               # 0x1
	.byte	1                               # 0x1
	.byte	2                               # 0x2
	.byte	1                               # 0x1
	.byte	2                               # 0x2
	.byte	2                               # 0x2
	.byte	3                               # 0x3
	.byte	1                               # 0x1
	.byte	2                               # 0x2
	.byte	2                               # 0x2
	.byte	3                               # 0x3
	.byte	2                               # 0x2
	.byte	3                               # 0x3
	.byte	3                               # 0x3
	.byte	4                               # 0x4
	.byte	0                               # 0x0
	.byte	1                               # 0x1
	.byte	1                               # 0x1
	.byte	2                               # 0x2
	.byte	1                               # 0x1
	.byte	2                               # 0x2
	.byte	2                               # 0x2
	.byte	3                               # 0x3
	.byte	1                               # 0x1
	.byte	2                               # 0x2
	.byte	2                               # 0x2
	.byte	3                               # 0x3
	.byte	2                               # 0x2
	.byte	3                               # 0x3
	.byte	3                               # 0x3
	.byte	4                               # 0x4
.LCPI2_2:
	.long	0                               # 0x0
	.long	2                               # 0x2
	.long	4                               # 0x4
	.long	6                               # 0x6
	.long	4                               # 0x4
	.long	6                               # 0x6
	.long	6                               # 0x6
	.long	7                               # 0x7
.LCPI2_3:
	.long	0                               # 0x0
	.long	2                               # 0x2
	.long	4                               # 0x4
	.long	6                               # 0x6
	.zero	4
	.zero	4
	.zero	4
	.zero	4
	.section	.rodata.cst4,"aM",@progbits,4
	.p2align	2, 0x0
.LCPI2_4:
	.zero	4,15
	.section	.rodata.cst16,"aM",@progbits,16
	.p2align	4, 0x0
.LCPI2_5:
	.byte	0                               # 0x0
	.byte	1                               # 0x1
	.byte	1                               # 0x1
	.byte	2                               # 0x2
	.byte	1                               # 0x1
	.byte	2                               # 0x2
	.byte	2                               # 0x2
	.byte	3                               # 0x3
	.byte	1                               # 0x1
	.byte	2                               # 0x2
	.byte	2                               # 0x2
	.byte	3                               # 0x3
	.byte	2                               # 0x2
	.byte	3                               # 0x3
	.byte	3                               # 0x3
	.byte	4                               # 0x4
.LCPI2_6:
	.long	0                               # 0x0
	.long	2                               # 0x2
	.long	4                               # 0x4
	.long	6                               # 0x6
	.text
	.globl	popc
	.prefalign	4, .Lfunc_end2, nop
	.type	popc,@function
popc:                                   # @popc
	.cfi_startproc
# %bb.0:
	testq	%rsi, %rsi
	je	.LBB2_1
# %bb.2:
	cmpq	$4, %rsi
	jae	.LBB2_5
# %bb.3:
	xorl	%ecx, %ecx
	xorl	%eax, %eax
	jmp	.LBB2_4
.LBB2_1:
	xorl	%eax, %eax
	retq
.LBB2_5:
	cmpq	$16, %rsi
	jae	.LBB2_7
# %bb.6:
	xorl	%ecx, %ecx
	xorl	%eax, %eax
	jmp	.LBB2_11
.LBB2_7:
	movq	%rsi, %rcx
	andq	$-16, %rcx
	vpxor	%xmm0, %xmm0, %xmm0
	xorl	%eax, %eax
	vpbroadcastd	.LCPI2_4(%rip), %ymm1   # ymm1 = [15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15]
	vbroadcasti128	.LCPI2_5(%rip), %ymm2   # ymm2 = [0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4,0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4]
                                        # ymm2 = mem[0,1,0,1]
	vpxor	%xmm3, %xmm3, %xmm3
	vmovdqa	.LCPI2_2(%rip), %ymm4           # ymm4 = [0,2,4,6,4,6,6,7]
	vpxor	%xmm5, %xmm5, %xmm5
	vpxor	%xmm6, %xmm6, %xmm6
	vpxor	%xmm7, %xmm7, %xmm7
	.p2align	4
.LBB2_8:                                # =>This Inner Loop Header: Depth=1
	vmovdqu	(%rdi,%rax,8), %ymm8
	vmovdqu	32(%rdi,%rax,8), %ymm9
	vmovdqu	64(%rdi,%rax,8), %ymm10
	vmovdqu	96(%rdi,%rax,8), %ymm11
	vpand	%ymm1, %ymm8, %ymm12
	vpshufb	%ymm12, %ymm2, %ymm12
	vpsrlw	$4, %ymm8, %ymm8
	vpand	%ymm1, %ymm8, %ymm8
	vpshufb	%ymm8, %ymm2, %ymm8
	vpaddb	%ymm12, %ymm8, %ymm8
	vpsadbw	%ymm3, %ymm8, %ymm8
	vpand	%ymm1, %ymm9, %ymm12
	vpshufb	%ymm12, %ymm2, %ymm12
	vpsrlw	$4, %ymm9, %ymm9
	vpand	%ymm1, %ymm9, %ymm9
	vpshufb	%ymm9, %ymm2, %ymm9
	vpaddb	%ymm12, %ymm9, %ymm9
	vpsadbw	%ymm3, %ymm9, %ymm9
	vpand	%ymm1, %ymm10, %ymm12
	vpshufb	%ymm12, %ymm2, %ymm12
	vpsrlw	$4, %ymm10, %ymm10
	vpand	%ymm1, %ymm10, %ymm10
	vpshufb	%ymm10, %ymm2, %ymm10
	vpaddb	%ymm12, %ymm10, %ymm10
	vpsadbw	%ymm3, %ymm10, %ymm10
	vpand	%ymm1, %ymm11, %ymm12
	vpshufb	%ymm12, %ymm2, %ymm12
	vpsrlw	$4, %ymm11, %ymm11
	vpand	%ymm1, %ymm11, %ymm11
	vpshufb	%ymm11, %ymm2, %ymm11
	vpaddb	%ymm12, %ymm11, %ymm11
	vpsadbw	%ymm3, %ymm11, %ymm11
	vpermd	%ymm8, %ymm4, %ymm8
	vpermd	%ymm9, %ymm4, %ymm9
	vpermd	%ymm10, %ymm4, %ymm10
	vpermd	%ymm11, %ymm4, %ymm11
	vpaddd	%xmm0, %xmm8, %xmm0
	vpaddd	%xmm5, %xmm9, %xmm5
	vpaddd	%xmm6, %xmm10, %xmm6
	vpaddd	%xmm7, %xmm11, %xmm7
	addq	$16, %rax
	cmpq	%rax, %rcx
	jne	.LBB2_8
# %bb.9:
	vpaddd	%xmm0, %xmm5, %xmm0
	vpaddd	%xmm0, %xmm6, %xmm0
	vpaddd	%xmm0, %xmm7, %xmm0
	vpshufd	$238, %xmm0, %xmm1              # xmm1 = xmm0[2,3,2,3]
	vpaddd	%xmm1, %xmm0, %xmm0
	vpshufd	$85, %xmm0, %xmm1               # xmm1 = xmm0[1,1,1,1]
	vpaddd	%xmm1, %xmm0, %xmm0
	vmovd	%xmm0, %eax
	cmpq	%rcx, %rsi
	je	.LBB2_15
# %bb.10:
	testb	$12, %sil
	je	.LBB2_4
.LBB2_11:
	movq	%rcx, %rdx
	movq	%rsi, %rcx
	andq	$-4, %rcx
	vmovd	%eax, %xmm0
	vpbroadcastd	.LCPI2_4(%rip), %ymm1   # ymm1 = [15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15]
	vbroadcasti128	.LCPI2_5(%rip), %ymm2   # ymm2 = [0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4,0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4]
                                        # ymm2 = mem[0,1,0,1]
	vpxor	%xmm3, %xmm3, %xmm3
	vbroadcasti128	.LCPI2_6(%rip), %ymm4   # ymm4 = [0,2,4,6,0,2,4,6]
                                        # ymm4 = mem[0,1,0,1]
	.p2align	4
.LBB2_12:                               # =>This Inner Loop Header: Depth=1
	vmovdqu	(%rdi,%rdx,8), %ymm5
	vpand	%ymm1, %ymm5, %ymm6
	vpshufb	%ymm6, %ymm2, %ymm6
	vpsrlw	$4, %ymm5, %ymm5
	vpand	%ymm1, %ymm5, %ymm5
	vpshufb	%ymm5, %ymm2, %ymm5
	vpaddb	%ymm6, %ymm5, %ymm5
	vpsadbw	%ymm3, %ymm5, %ymm5
	vpermd	%ymm5, %ymm4, %ymm5
	vpaddd	%xmm5, %xmm0, %xmm0
	addq	$4, %rdx
	cmpq	%rdx, %rcx
	jne	.LBB2_12
# %bb.13:
	vpshufd	$238, %xmm0, %xmm1              # xmm1 = xmm0[2,3,2,3]
	vpaddd	%xmm1, %xmm0, %xmm0
	vpshufd	$85, %xmm0, %xmm1               # xmm1 = xmm0[1,1,1,1]
	vpaddd	%xmm1, %xmm0, %xmm0
	vmovd	%xmm0, %eax
	jmp	.LBB2_14
.LBB2_4:
	xorl	%edx, %edx
	popcntq	(%rdi,%rcx,8), %rdx
	addl	%edx, %eax
	incq	%rcx
.LBB2_14:
	cmpq	%rcx, %rsi
	jne	.LBB2_4
.LBB2_15:
	vzeroupper
	retq
.Lfunc_end2:
	.size	popc, .Lfunc_end2-popc
	.cfi_endproc
                                        # -- End function
	.globl	callloop                        # -- Begin function callloop
	.prefalign	4, .Lfunc_end3, nop
	.type	callloop,@function
callloop:                               # @callloop
	.cfi_startproc
# %bb.0:
	testl	%edi, %edi
	jle	.LBB3_4
# %bb.1:
	pushq	%rbp
	.cfi_def_cfa_offset 16
	pushq	%rbx
	.cfi_def_cfa_offset 24
	pushq	%rax
	.cfi_def_cfa_offset 32
	.cfi_offset %rbx, -24
	.cfi_offset %rbp, -16
	movl	%edi, %ebx
	xorl	%ebp, %ebp
	.p2align	4
.LBB3_2:                                # =>This Inner Loop Header: Depth=1
	movl	%ebp, %edi
	callq	sink@PLT
	addl	$3, %ebp
	decl	%ebx
	jne	.LBB3_2
# %bb.3:
	addq	$8, %rsp
	.cfi_def_cfa_offset 24
	popq	%rbx
	.cfi_def_cfa_offset 16
	popq	%rbp
	.cfi_def_cfa_offset 8
	.cfi_restore %rbx
	.cfi_restore %rbp
.LBB3_4:
	retq
.Lfunc_end3:
	.size	callloop, .Lfunc_end3-callloop
	.cfi_endproc
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
