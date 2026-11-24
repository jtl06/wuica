	.att_syntax
	.file	"saxpy.c"
	.text
	.globl	saxpy                           # -- Begin function saxpy
	.prefalign	4, .Lfunc_end0, nop
	.type	saxpy,@function
saxpy:                                  # @saxpy
	.cfi_startproc
# %bb.0:
	testq	%rdi, %rdi
	je	.LBB0_19
# %bb.1:
	cmpq	$4, %rdi
	jb	.LBB0_2
# %bb.3:
	leaq	(%rdx,%rdi,4), %rax
	leaq	(%rsi,%rdi,4), %rcx
	cmpq	%rcx, %rdx
	setb	%cl
	cmpq	%rax, %rsi
	setb	%al
	testb	%al, %cl
	je	.LBB0_5
.LBB0_2:
	xorl	%eax, %eax
.LBB0_14:
	movl	%edi, %r8d
	subl	%eax, %r8d
	movq	%rax, %rcx
	andl	$7, %r8d
	je	.LBB0_17
# %bb.15:
	movq	%rax, %rcx
	.p2align	4
.LBB0_16:                               # =>This Inner Loop Header: Depth=1
	vmovss	(%rsi,%rcx,4), %xmm1            # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	(%rdx,%rcx,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, (%rdx,%rcx,4)
	incq	%rcx
	decq	%r8
	jne	.LBB0_16
.LBB0_17:
	subq	%rdi, %rax
	cmpq	$-8, %rax
	ja	.LBB0_19
	.p2align	4
.LBB0_18:                               # =>This Inner Loop Header: Depth=1
	vmovss	(%rsi,%rcx,4), %xmm1            # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	(%rdx,%rcx,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, (%rdx,%rcx,4)
	vmovss	4(%rsi,%rcx,4), %xmm1           # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	4(%rdx,%rcx,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, 4(%rdx,%rcx,4)
	vmovss	8(%rsi,%rcx,4), %xmm1           # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	8(%rdx,%rcx,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, 8(%rdx,%rcx,4)
	vmovss	12(%rsi,%rcx,4), %xmm1          # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	12(%rdx,%rcx,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, 12(%rdx,%rcx,4)
	vmovss	16(%rsi,%rcx,4), %xmm1          # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	16(%rdx,%rcx,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, 16(%rdx,%rcx,4)
	vmovss	20(%rsi,%rcx,4), %xmm1          # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	20(%rdx,%rcx,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, 20(%rdx,%rcx,4)
	vmovss	24(%rsi,%rcx,4), %xmm1          # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	24(%rdx,%rcx,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, 24(%rdx,%rcx,4)
	vmovss	28(%rsi,%rcx,4), %xmm1          # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	28(%rdx,%rcx,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, 28(%rdx,%rcx,4)
	addq	$8, %rcx
	cmpq	%rcx, %rdi
	jne	.LBB0_18
.LBB0_19:
	vzeroupper
	retq
.LBB0_5:
	cmpq	$32, %rdi
	jae	.LBB0_7
# %bb.6:
	xorl	%eax, %eax
	jmp	.LBB0_11
.LBB0_7:
	movq	%rdi, %rax
	andq	$-32, %rax
	vbroadcastss	%xmm0, %ymm1
	xorl	%ecx, %ecx
	.p2align	4
.LBB0_8:                                # =>This Inner Loop Header: Depth=1
	vmovups	(%rsi,%rcx,4), %ymm2
	vmovups	32(%rsi,%rcx,4), %ymm3
	vmovups	64(%rsi,%rcx,4), %ymm4
	vmovups	96(%rsi,%rcx,4), %ymm5
	vfmadd213ps	(%rdx,%rcx,4), %ymm1, %ymm2 # ymm2 = (ymm1 * ymm2) + mem
	vfmadd213ps	32(%rdx,%rcx,4), %ymm1, %ymm3 # ymm3 = (ymm1 * ymm3) + mem
	vfmadd213ps	64(%rdx,%rcx,4), %ymm1, %ymm4 # ymm4 = (ymm1 * ymm4) + mem
	vfmadd213ps	96(%rdx,%rcx,4), %ymm1, %ymm5 # ymm5 = (ymm1 * ymm5) + mem
	vmovups	%ymm2, (%rdx,%rcx,4)
	vmovups	%ymm3, 32(%rdx,%rcx,4)
	vmovups	%ymm4, 64(%rdx,%rcx,4)
	vmovups	%ymm5, 96(%rdx,%rcx,4)
	addq	$32, %rcx
	cmpq	%rcx, %rax
	jne	.LBB0_8
# %bb.9:
	cmpq	%rax, %rdi
	je	.LBB0_19
# %bb.10:
	testb	$28, %dil
	je	.LBB0_14
.LBB0_11:
	movq	%rax, %rcx
	movq	%rdi, %rax
	andq	$-4, %rax
	vbroadcastss	%xmm0, %xmm1
	.p2align	4
.LBB0_12:                               # =>This Inner Loop Header: Depth=1
	vmovups	(%rsi,%rcx,4), %xmm2
	vfmadd213ps	(%rdx,%rcx,4), %xmm1, %xmm2 # xmm2 = (xmm1 * xmm2) + mem
	vmovups	%xmm2, (%rdx,%rcx,4)
	addq	$4, %rcx
	cmpq	%rcx, %rax
	jne	.LBB0_12
# %bb.13:
	cmpq	%rax, %rdi
	je	.LBB0_19
	jmp	.LBB0_14
.Lfunc_end0:
	.size	saxpy, .Lfunc_end0-saxpy
	.cfi_endproc
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
