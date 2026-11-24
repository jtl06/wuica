	.att_syntax
	.file	"avx512.c"
	.text
	.globl	add512                          # -- Begin function add512
	.prefalign	4, .Lfunc_end0, nop
	.type	add512,@function
add512:                                 # @add512
	.cfi_startproc
# %bb.0:
	testq	%rdx, %rdx
	je	.LBB0_13
# %bb.1:
	cmpq	$8, %rdx
	jae	.LBB0_4
# %bb.2:
	xorl	%eax, %eax
	jmp	.LBB0_3
.LBB0_4:
	cmpq	$64, %rdx
	jae	.LBB0_6
# %bb.5:
	xorl	%eax, %eax
	jmp	.LBB0_10
.LBB0_6:
	movq	%rdx, %rax
	andq	$-64, %rax
	xorl	%ecx, %ecx
	.p2align	4
.LBB0_7:                                # =>This Inner Loop Header: Depth=1
	vmovups	(%rsi,%rcx,4), %zmm0
	vmovups	64(%rsi,%rcx,4), %zmm1
	vmovups	128(%rsi,%rcx,4), %zmm2
	vmovups	192(%rsi,%rcx,4), %zmm3
	vaddps	(%rdi,%rcx,4), %zmm0, %zmm0
	vaddps	64(%rdi,%rcx,4), %zmm1, %zmm1
	vaddps	128(%rdi,%rcx,4), %zmm2, %zmm2
	vaddps	192(%rdi,%rcx,4), %zmm3, %zmm3
	vmovups	%zmm0, (%rdi,%rcx,4)
	vmovups	%zmm1, 64(%rdi,%rcx,4)
	vmovups	%zmm2, 128(%rdi,%rcx,4)
	vmovups	%zmm3, 192(%rdi,%rcx,4)
	addq	$64, %rcx
	cmpq	%rcx, %rax
	jne	.LBB0_7
# %bb.8:
	cmpq	%rax, %rdx
	je	.LBB0_13
# %bb.9:
	testb	$56, %dl
	je	.LBB0_3
.LBB0_10:
	movq	%rax, %rcx
	movq	%rdx, %rax
	andq	$-8, %rax
	.p2align	4
.LBB0_11:                               # =>This Inner Loop Header: Depth=1
	vmovups	(%rsi,%rcx,4), %ymm0
	vaddps	(%rdi,%rcx,4), %ymm0, %ymm0
	vmovups	%ymm0, (%rdi,%rcx,4)
	addq	$8, %rcx
	cmpq	%rcx, %rax
	jne	.LBB0_11
	jmp	.LBB0_12
.LBB0_3:
	vmovss	(%rsi,%rax,4), %xmm0            # xmm0 = mem[0],zero,zero,zero
	vaddss	(%rdi,%rax,4), %xmm0, %xmm0
	vmovss	%xmm0, (%rdi,%rax,4)
	incq	%rax
.LBB0_12:
	cmpq	%rax, %rdx
	jne	.LBB0_3
.LBB0_13:
	vzeroupper
	retq
.Lfunc_end0:
	.size	add512, .Lfunc_end0-add512
	.cfi_endproc
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
