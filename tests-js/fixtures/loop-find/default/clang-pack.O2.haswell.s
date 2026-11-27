	.att_syntax
	.file	"pack.c"
	.section	.rodata.cst8,"aM",@progbits,8
	.p2align	3, 0x0                          # -- Begin function pack
.LCPI0_0:
	.long	0                               # 0x0
	.long	4                               # 0x4
.LCPI0_1:
	.long	1                               # 0x1
	.long	5                               # 0x5
.LCPI0_2:
	.long	2                               # 0x2
	.long	6                               # 0x6
.LCPI0_3:
	.long	3                               # 0x3
	.long	7                               # 0x7
	.text
	.globl	pack
	.prefalign	4, .Lfunc_end0, nop
	.type	pack,@function
pack:                                   # @pack
# %bb.0:
	cmpq	$4, %rdx
	jge	.LBB0_2
# %bb.1:
	xorl	%eax, %eax
	jmp	.LBB0_8
.LBB0_2:
	leaq	-4(%rdx), %rcx
	movq	%rcx, %rax
	shrq	$2, %rax
	incq	%rax
	cmpq	$28, %rcx
	jae	.LBB0_5
# %bb.3:
	movl	$4, %r8d
	xorl	%ecx, %ecx
	xorl	%r9d, %r9d
	jmp	.LBB0_4
.LBB0_5:
	movq	%rax, %rcx
	andq	$-8, %rcx
	leaq	(,%rcx,4), %r9
	leaq	4(,%rcx,4), %r8
	xorl	%r10d, %r10d
	vpbroadcastq	.LCPI0_0(%rip), %ymm0   # ymm0 = [0,4,0,4,0,4,0,4]
	vpbroadcastq	.LCPI0_1(%rip), %ymm1   # ymm1 = [1,5,1,5,1,5,1,5]
	vpbroadcastq	.LCPI0_2(%rip), %ymm2   # ymm2 = [2,6,2,6,2,6,2,6]
	vpbroadcastq	.LCPI0_3(%rip), %ymm3   # ymm3 = [3,7,3,7,3,7,3,7]
	movq	%rsi, %r11
	.p2align	4
.LBB0_6:                                # =>This Inner Loop Header: Depth=1
	vmovdqu	(%r11), %ymm4
	vmovdqu	32(%r11), %ymm7
	vmovdqu	64(%r11), %ymm5
	vmovdqu	96(%r11), %ymm6
	vpermd	%ymm6, %ymm0, %ymm8
	vpermd	%ymm5, %ymm0, %ymm9
	vpblendd	$192, %ymm8, %ymm9, %ymm8       # ymm8 = ymm9[0,1,2,3,4,5],ymm8[6,7]
	vpermd	%ymm7, %ymm0, %ymm9
	vmovdqu	(%r11), %xmm10
	vmovdqu	16(%r11), %xmm11
	vmovdqu	32(%r11), %xmm12
	vpunpckldq	%xmm11, %xmm10, %xmm13  # xmm13 = xmm10[0],xmm11[0],xmm10[1],xmm11[1]
	vpblendd	$12, %xmm9, %xmm13, %xmm9       # xmm9 = xmm13[0,1],xmm9[2,3]
	vpblendd	$240, %ymm8, %ymm9, %ymm8       # ymm8 = ymm9[0,1,2,3],ymm8[4,5,6,7]
	vpermd	%ymm6, %ymm1, %ymm9
	vpermd	%ymm5, %ymm1, %ymm13
	vpblendd	$192, %ymm9, %ymm13, %ymm9      # ymm9 = ymm13[0,1,2,3,4,5],ymm9[6,7]
	vmovdqu	48(%r11), %xmm13
	vpunpckldq	%xmm13, %xmm12, %xmm14  # xmm14 = xmm12[0],xmm13[0],xmm12[1],xmm13[1]
	vpermd	%ymm4, %ymm1, %ymm15
	vpblendd	$12, %xmm14, %xmm15, %xmm14     # xmm14 = xmm15[0,1],xmm14[2,3]
	vpblendd	$240, %ymm9, %ymm14, %ymm9      # ymm9 = ymm14[0,1,2,3],ymm9[4,5,6,7]
	vpaddd	%ymm8, %ymm9, %ymm8
	vpermd	%ymm6, %ymm2, %ymm9
	vpermd	%ymm5, %ymm2, %ymm14
	vpblendd	$192, %ymm9, %ymm14, %ymm9      # ymm9 = ymm14[0,1,2,3,4,5],ymm9[6,7]
	vpermd	%ymm7, %ymm2, %ymm7
	vpunpckhdq	%xmm11, %xmm10, %xmm10  # xmm10 = xmm10[2],xmm11[2],xmm10[3],xmm11[3]
	vpblendd	$12, %xmm7, %xmm10, %xmm7       # xmm7 = xmm10[0,1],xmm7[2,3]
	vpblendd	$240, %ymm9, %ymm7, %ymm7       # ymm7 = ymm7[0,1,2,3],ymm9[4,5,6,7]
	vpermd	%ymm6, %ymm3, %ymm6
	vpermd	%ymm5, %ymm3, %ymm5
	vpblendd	$192, %ymm6, %ymm5, %ymm5       # ymm5 = ymm5[0,1,2,3,4,5],ymm6[6,7]
	vpunpckhdq	%xmm13, %xmm12, %xmm6   # xmm6 = xmm12[2],xmm13[2],xmm12[3],xmm13[3]
	vpermd	%ymm4, %ymm3, %ymm4
	vpblendd	$12, %xmm6, %xmm4, %xmm4        # xmm4 = xmm4[0,1],xmm6[2,3]
	vpblendd	$240, %ymm5, %ymm4, %ymm4       # ymm4 = ymm4[0,1,2,3],ymm5[4,5,6,7]
	vpaddd	%ymm4, %ymm7, %ymm4
	vpaddd	%ymm4, %ymm8, %ymm4
	vmovdqu	%ymm4, (%rdi,%r10,4)
	addq	$8, %r10
	subq	$-128, %r11
	cmpq	%r10, %rcx
	jne	.LBB0_6
	jmp	.LBB0_7
.LBB0_4:
	vpbroadcastq	8(%rsi,%r9,4), %xmm0
	vpaddd	(%rsi,%r9,4), %xmm0, %xmm0
	vpshufd	$85, %xmm0, %xmm1               # xmm1 = xmm0[1,1,1,1]
	vpaddd	%xmm1, %xmm0, %xmm0
	vmovd	%xmm0, (%rdi,%rcx,4)
	movq	%r8, %r9
	incq	%rcx
	addq	$4, %r8
.LBB0_7:
	cmpq	%rcx, %rax
	jne	.LBB0_4
.LBB0_8:
	movq	%rdx, %rcx
	subq	%rax, %rcx
	jle	.LBB0_21
# %bb.9:
	cmpq	$8, %rcx
	jae	.LBB0_11
# %bb.10:
	movq	%rax, %r8
	jmp	.LBB0_20
.LBB0_11:
	cmpq	$32, %rcx
	jae	.LBB0_13
# %bb.12:
	xorl	%esi, %esi
	jmp	.LBB0_17
.LBB0_13:
	movq	%rcx, %rsi
	andq	$-32, %rsi
	leaq	(%rax,%rsi), %r8
	leaq	(%rdi,%rax,4), %r9
	addq	$96, %r9
	xorl	%r10d, %r10d
	vpxor	%xmm0, %xmm0, %xmm0
	.p2align	4
.LBB0_14:                               # =>This Inner Loop Header: Depth=1
	vmovdqu	%ymm0, -96(%r9,%r10,4)
	vmovdqu	%ymm0, -64(%r9,%r10,4)
	vmovdqu	%ymm0, -32(%r9,%r10,4)
	vmovdqu	%ymm0, (%r9,%r10,4)
	addq	$32, %r10
	cmpq	%r10, %rsi
	jne	.LBB0_14
# %bb.15:
	cmpq	%rsi, %rcx
	je	.LBB0_21
# %bb.16:
	testb	$24, %cl
	je	.LBB0_20
.LBB0_17:
	movq	%rcx, %r9
	andq	$-8, %r9
	leaq	(%rdi,%rax,4), %r8
	addq	%r9, %rax
	vpxor	%xmm0, %xmm0, %xmm0
	.p2align	4
.LBB0_18:                               # =>This Inner Loop Header: Depth=1
	vmovdqu	%ymm0, (%r8,%rsi,4)
	addq	$8, %rsi
	cmpq	%rsi, %r9
	jne	.LBB0_18
# %bb.19:
	movq	%rax, %r8
	cmpq	%r9, %rcx
	je	.LBB0_21
	.p2align	4
.LBB0_20:                               # =>This Inner Loop Header: Depth=1
	movl	$0, (%rdi,%r8,4)
	incq	%r8
	cmpq	%r8, %rdx
	jne	.LBB0_20
.LBB0_21:
	vzeroupper
	retq
.Lfunc_end0:
	.size	pack, .Lfunc_end0-pack
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
