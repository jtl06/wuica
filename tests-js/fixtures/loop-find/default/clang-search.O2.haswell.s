	.att_syntax
	.file	"search.c"
	.section	.rodata.cst8,"aM",@progbits,8
	.p2align	3, 0x0                          # -- Begin function after
.LCPI0_0:
	.quad	1                               # 0x1
	.text
	.globl	after
	.prefalign	4, .Lfunc_end0, nop
	.type	after,@function
after:                                  # @after
# %bb.0:
	testq	%rsi, %rsi
	jle	.LBB0_1
# %bb.4:
	xorl	%eax, %eax
	xorl	%ecx, %ecx
	.p2align	4
.LBB0_5:                                # =>This Inner Loop Header: Depth=1
	cmpb	%dl, (%rdi,%rcx)
	je	.LBB0_2
# %bb.6:                                #   in Loop: Header=BB0_5 Depth=1
	incq	%rcx
	cmpq	%rcx, %rsi
	jne	.LBB0_5
	jmp	.LBB0_19
.LBB0_1:
	xorl	%ecx, %ecx
.LBB0_2:
	movq	%rsi, %r8
	subq	%rcx, %r8
	jle	.LBB0_3
# %bb.7:
	cmpq	$4, %r8
	jae	.LBB0_9
# %bb.8:
	xorl	%eax, %eax
	movq	%rcx, %r10
	jmp	.LBB0_18
.LBB0_3:
	xorl	%eax, %eax
	retq
.LBB0_9:
	cmpq	$16, %r8
	jae	.LBB0_11
# %bb.10:
	xorl	%r9d, %r9d
	xorl	%eax, %eax
	jmp	.LBB0_15
.LBB0_11:
	movq	%r8, %r9
	andq	$-16, %r9
	leaq	(%rcx,%r9), %r10
	vmovd	%edx, %xmm0
	vpbroadcastb	%xmm0, %xmm0
	leaq	(%rcx,%rdi), %rax
	addq	$12, %rax
	vpxor	%xmm1, %xmm1, %xmm1
	xorl	%r11d, %r11d
	vpbroadcastq	.LCPI0_0(%rip), %ymm2   # ymm2 = [1,1,1,1]
	vpxor	%xmm3, %xmm3, %xmm3
	vpxor	%xmm4, %xmm4, %xmm4
	vpxor	%xmm5, %xmm5, %xmm5
	.p2align	4
.LBB0_12:                               # =>This Inner Loop Header: Depth=1
	vmovd	-12(%rax,%r11), %xmm6           # xmm6 = mem[0],zero,zero,zero
	vmovd	-8(%rax,%r11), %xmm7            # xmm7 = mem[0],zero,zero,zero
	vmovd	-4(%rax,%r11), %xmm8            # xmm8 = mem[0],zero,zero,zero
	vmovd	(%rax,%r11), %xmm9              # xmm9 = mem[0],zero,zero,zero
	vpmovzxbq	%xmm6, %ymm10           # ymm10 = xmm6[0],zero,zero,zero,zero,zero,zero,zero,xmm6[1],zero,zero,zero,zero,zero,zero,zero,xmm6[2],zero,zero,zero,zero,zero,zero,zero,xmm6[3],zero,zero,zero,zero,zero,zero,zero
	vpmovzxbq	%xmm7, %ymm11           # ymm11 = xmm7[0],zero,zero,zero,zero,zero,zero,zero,xmm7[1],zero,zero,zero,zero,zero,zero,zero,xmm7[2],zero,zero,zero,zero,zero,zero,zero,xmm7[3],zero,zero,zero,zero,zero,zero,zero
	vpmovzxbq	%xmm8, %ymm12           # ymm12 = xmm8[0],zero,zero,zero,zero,zero,zero,zero,xmm8[1],zero,zero,zero,zero,zero,zero,zero,xmm8[2],zero,zero,zero,zero,zero,zero,zero,xmm8[3],zero,zero,zero,zero,zero,zero,zero
	vpmovzxbq	%xmm9, %ymm13           # ymm13 = xmm9[0],zero,zero,zero,zero,zero,zero,zero,xmm9[1],zero,zero,zero,zero,zero,zero,zero,xmm9[2],zero,zero,zero,zero,zero,zero,zero,xmm9[3],zero,zero,zero,zero,zero,zero,zero
	vpsllq	$5, %ymm10, %ymm14
	vpsubq	%ymm10, %ymm14, %ymm10
	vpsllq	$5, %ymm11, %ymm14
	vpsubq	%ymm11, %ymm14, %ymm11
	vpsllq	$5, %ymm12, %ymm14
	vpsubq	%ymm12, %ymm14, %ymm12
	vpsllq	$5, %ymm13, %ymm14
	vpsubq	%ymm13, %ymm14, %ymm13
	vpcmpeqb	%xmm0, %xmm6, %xmm6
	vpmovzxbq	%xmm6, %ymm6            # ymm6 = xmm6[0],zero,zero,zero,zero,zero,zero,zero,xmm6[1],zero,zero,zero,zero,zero,zero,zero,xmm6[2],zero,zero,zero,zero,zero,zero,zero,xmm6[3],zero,zero,zero,zero,zero,zero,zero
	vpand	%ymm2, %ymm6, %ymm6
	vpaddq	%ymm6, %ymm1, %ymm1
	vpaddq	%ymm1, %ymm10, %ymm1
	vpcmpeqb	%xmm0, %xmm7, %xmm6
	vpmovzxbq	%xmm6, %ymm6            # ymm6 = xmm6[0],zero,zero,zero,zero,zero,zero,zero,xmm6[1],zero,zero,zero,zero,zero,zero,zero,xmm6[2],zero,zero,zero,zero,zero,zero,zero,xmm6[3],zero,zero,zero,zero,zero,zero,zero
	vpand	%ymm2, %ymm6, %ymm6
	vpaddq	%ymm6, %ymm3, %ymm3
	vpaddq	%ymm3, %ymm11, %ymm3
	vpcmpeqb	%xmm0, %xmm8, %xmm6
	vpmovzxbq	%xmm6, %ymm6            # ymm6 = xmm6[0],zero,zero,zero,zero,zero,zero,zero,xmm6[1],zero,zero,zero,zero,zero,zero,zero,xmm6[2],zero,zero,zero,zero,zero,zero,zero,xmm6[3],zero,zero,zero,zero,zero,zero,zero
	vpand	%ymm2, %ymm6, %ymm6
	vpaddq	%ymm6, %ymm4, %ymm4
	vpaddq	%ymm4, %ymm12, %ymm4
	vpcmpeqb	%xmm0, %xmm9, %xmm6
	vpmovzxbq	%xmm6, %ymm6            # ymm6 = xmm6[0],zero,zero,zero,zero,zero,zero,zero,xmm6[1],zero,zero,zero,zero,zero,zero,zero,xmm6[2],zero,zero,zero,zero,zero,zero,zero,xmm6[3],zero,zero,zero,zero,zero,zero,zero
	vpand	%ymm2, %ymm6, %ymm6
	vpaddq	%ymm6, %ymm5, %ymm5
	vpaddq	%ymm5, %ymm13, %ymm5
	addq	$16, %r11
	cmpq	%r11, %r9
	jne	.LBB0_12
# %bb.13:
	vpaddq	%ymm1, %ymm3, %ymm0
	vpaddq	%ymm0, %ymm4, %ymm0
	vpaddq	%ymm0, %ymm5, %ymm0
	vextracti128	$1, %ymm0, %xmm1
	vpaddq	%xmm1, %xmm0, %xmm0
	vpshufd	$238, %xmm0, %xmm1              # xmm1 = xmm0[2,3,2,3]
	vpaddq	%xmm1, %xmm0, %xmm0
	vmovq	%xmm0, %rax
	cmpq	%r9, %r8
	je	.LBB0_19
# %bb.14:
	testb	$12, %r8b
	je	.LBB0_18
.LBB0_15:
	movq	%r8, %r11
	andq	$-4, %r11
	vmovq	%rax, %xmm0
	vmovd	%edx, %xmm1
	vpbroadcastb	%xmm1, %xmm1
	leaq	(%rdi,%rcx), %rax
	addq	%r11, %rcx
	vpbroadcastq	.LCPI0_0(%rip), %ymm2   # ymm2 = [1,1,1,1]
	.p2align	4
.LBB0_16:                               # =>This Inner Loop Header: Depth=1
	vmovd	(%rax,%r9), %xmm3               # xmm3 = mem[0],zero,zero,zero
	vpmovzxbq	%xmm3, %ymm4            # ymm4 = xmm3[0],zero,zero,zero,zero,zero,zero,zero,xmm3[1],zero,zero,zero,zero,zero,zero,zero,xmm3[2],zero,zero,zero,zero,zero,zero,zero,xmm3[3],zero,zero,zero,zero,zero,zero,zero
	vpsllq	$5, %ymm4, %ymm5
	vpsubq	%ymm4, %ymm5, %ymm4
	vpcmpeqb	%xmm1, %xmm3, %xmm3
	vpmovzxbq	%xmm3, %ymm3            # ymm3 = xmm3[0],zero,zero,zero,zero,zero,zero,zero,xmm3[1],zero,zero,zero,zero,zero,zero,zero,xmm3[2],zero,zero,zero,zero,zero,zero,zero,xmm3[3],zero,zero,zero,zero,zero,zero,zero
	vpand	%ymm2, %ymm3, %ymm3
	vpaddq	%ymm3, %ymm0, %ymm0
	vpaddq	%ymm4, %ymm0, %ymm0
	addq	$4, %r9
	cmpq	%r9, %r11
	jne	.LBB0_16
# %bb.17:
	vextracti128	$1, %ymm0, %xmm1
	vpaddq	%xmm1, %xmm0, %xmm0
	vpshufd	$238, %xmm0, %xmm1              # xmm1 = xmm0[2,3,2,3]
	vpaddq	%xmm1, %xmm0, %xmm0
	vmovq	%xmm0, %rax
	movq	%rcx, %r10
	cmpq	%r11, %r8
	je	.LBB0_19
	.p2align	4
.LBB0_18:                               # =>This Inner Loop Header: Depth=1
	movzbl	(%rdi,%r10), %ecx
	movl	%ecx, %r8d
	shll	$5, %r8d
	subq	%rcx, %r8
	xorl	%r9d, %r9d
	cmpb	%dl, %cl
	sete	%r9b
	addq	%r8, %rax
	addq	%r9, %rax
	incq	%r10
	cmpq	%r10, %rsi
	jne	.LBB0_18
.LBB0_19:
	vzeroupper
	retq
.Lfunc_end0:
	.size	after, .Lfunc_end0-after
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
