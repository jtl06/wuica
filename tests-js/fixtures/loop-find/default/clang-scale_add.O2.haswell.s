	.att_syntax
	.file	"scale_add.c"
	.text
	.globl	scale_add                       # -- Begin function scale_add
	.prefalign	4, .Lfunc_end0, nop
	.type	scale_add,@function
scale_add:                              # @scale_add
# %bb.0:
	testq	%rdx, %rdx
	setle	%al
	testb	$31, %dil
	sete	%cl
	orb	%al, %cl
	jne	.LBB0_4
# %bb.1:
	leaq	4(%rdi), %rax
	xorl	%ecx, %ecx
	.p2align	4
.LBB0_2:                                # =>This Inner Loop Header: Depth=1
	vmovss	(%rdi,%rcx,4), %xmm1            # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	(%rsi,%rcx,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, (%rdi,%rcx,4)
	incq	%rcx
	cmpq	%rdx, %rcx
	jge	.LBB0_5
# %bb.3:                                #   in Loop: Header=BB0_2 Depth=1
	movl	%eax, %r8d
	andl	$31, %r8d
	addq	$4, %rax
	testq	%r8, %r8
	jne	.LBB0_2
	jmp	.LBB0_5
.LBB0_4:
	xorl	%ecx, %ecx
.LBB0_5:
	vbroadcastss	%xmm0, %ymm1
	leaq	8(%rcx), %rax
	cmpq	%rdx, %rax
	jle	.LBB0_7
# %bb.6:
	movq	%rcx, %rax
	jmp	.LBB0_8
	.p2align	4
.LBB0_7:                                # =>This Inner Loop Header: Depth=1
	vmulps	(%rdi,%rcx,4), %ymm1, %ymm2
	vaddps	(%rsi,%rcx,4), %ymm2, %ymm2
	vmovaps	%ymm2, (%rdi,%rcx,4)
	leaq	8(%rcx), %rax
	addq	$16, %rcx
	cmpq	%rdx, %rcx
	movq	%rax, %rcx
	jle	.LBB0_7
.LBB0_8:
	movq	%rdx, %rcx
	subq	%rax, %rcx
	jle	.LBB0_28
# %bb.9:
	pushq	%r15
	pushq	%r14
	pushq	%rbx
	cmpq	$8, %rcx
	jb	.LBB0_10
# %bb.11:
	leaq	(%rdi,%rax,4), %r9
	leaq	(%rdi,%rdx,4), %r8
	leaq	(%rsi,%rax,4), %r10
	leaq	(%rsi,%rdx,4), %r11
	cmpq	%r11, %r9
	setb	%r11b
	cmpq	%r8, %r10
	setb	%r8b
	testb	%r8b, %r11b
	je	.LBB0_13
.LBB0_10:
	movq	%rax, %r8
.LBB0_22:
	movl	%edx, %ecx
	subl	%r8d, %ecx
	movq	%r8, %rax
	andl	$7, %ecx
	je	.LBB0_25
# %bb.23:
	movq	%r8, %rax
	.p2align	4
.LBB0_24:                               # =>This Inner Loop Header: Depth=1
	vmovss	(%rdi,%rax,4), %xmm1            # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	(%rsi,%rax,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, (%rdi,%rax,4)
	incq	%rax
	decq	%rcx
	jne	.LBB0_24
.LBB0_25:
	subq	%rdx, %r8
	cmpq	$-8, %r8
	ja	.LBB0_27
	.p2align	4
.LBB0_26:                               # =>This Inner Loop Header: Depth=1
	vmovss	(%rdi,%rax,4), %xmm1            # xmm1 = mem[0],zero,zero,zero
	vmovss	4(%rdi,%rax,4), %xmm2           # xmm2 = mem[0],zero,zero,zero
	vfmadd213ss	(%rsi,%rax,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, (%rdi,%rax,4)
	vfmadd213ss	4(%rsi,%rax,4), %xmm0, %xmm2 # xmm2 = (xmm0 * xmm2) + mem
	vmovss	%xmm2, 4(%rdi,%rax,4)
	vmovss	8(%rdi,%rax,4), %xmm1           # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	8(%rsi,%rax,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, 8(%rdi,%rax,4)
	vmovss	12(%rdi,%rax,4), %xmm1          # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	12(%rsi,%rax,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, 12(%rdi,%rax,4)
	vmovss	16(%rdi,%rax,4), %xmm1          # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	16(%rsi,%rax,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, 16(%rdi,%rax,4)
	vmovss	20(%rdi,%rax,4), %xmm1          # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	20(%rsi,%rax,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, 20(%rdi,%rax,4)
	vmovss	24(%rdi,%rax,4), %xmm1          # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	24(%rsi,%rax,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, 24(%rdi,%rax,4)
	vmovss	28(%rdi,%rax,4), %xmm1          # xmm1 = mem[0],zero,zero,zero
	vfmadd213ss	28(%rsi,%rax,4), %xmm0, %xmm1 # xmm1 = (xmm0 * xmm1) + mem
	vmovss	%xmm1, 28(%rdi,%rax,4)
	addq	$8, %rax
	cmpq	%rax, %rdx
	jne	.LBB0_26
.LBB0_27:
	popq	%rbx
	popq	%r14
	popq	%r15
.LBB0_28:
	vzeroupper
	retq
.LBB0_13:
	cmpq	$32, %rcx
	jae	.LBB0_15
# %bb.14:
	xorl	%r11d, %r11d
	jmp	.LBB0_19
.LBB0_15:
	movq	%rcx, %r11
	andq	$-32, %r11
	leaq	(%rax,%r11), %r8
	leaq	(%rsi,%rax,4), %rbx
	addq	$96, %rbx
	leaq	(%rdi,%rax,4), %r14
	addq	$96, %r14
	xorl	%r15d, %r15d
	.p2align	4
.LBB0_16:                               # =>This Inner Loop Header: Depth=1
	vmovups	-96(%r14,%r15,4), %ymm2
	vmovups	-64(%r14,%r15,4), %ymm3
	vmovups	-32(%r14,%r15,4), %ymm4
	vmovups	(%r14,%r15,4), %ymm5
	vfmadd213ps	-96(%rbx,%r15,4), %ymm1, %ymm2 # ymm2 = (ymm1 * ymm2) + mem
	vfmadd213ps	-64(%rbx,%r15,4), %ymm1, %ymm3 # ymm3 = (ymm1 * ymm3) + mem
	vfmadd213ps	-32(%rbx,%r15,4), %ymm1, %ymm4 # ymm4 = (ymm1 * ymm4) + mem
	vfmadd213ps	(%rbx,%r15,4), %ymm1, %ymm5 # ymm5 = (ymm1 * ymm5) + mem
	vmovups	%ymm2, -96(%r14,%r15,4)
	vmovups	%ymm3, -64(%r14,%r15,4)
	vmovups	%ymm4, -32(%r14,%r15,4)
	vmovups	%ymm5, (%r14,%r15,4)
	addq	$32, %r15
	cmpq	%r15, %r11
	jne	.LBB0_16
# %bb.17:
	cmpq	%r11, %rcx
	je	.LBB0_27
# %bb.18:
	testb	$24, %cl
	je	.LBB0_22
.LBB0_19:
	movq	%rcx, %rbx
	andq	$-8, %rbx
	addq	%rbx, %rax
	.p2align	4
.LBB0_20:                               # =>This Inner Loop Header: Depth=1
	vmovups	(%r9,%r11,4), %ymm2
	vfmadd213ps	(%r10,%r11,4), %ymm1, %ymm2 # ymm2 = (ymm1 * ymm2) + mem
	vmovups	%ymm2, (%r9,%r11,4)
	addq	$8, %r11
	cmpq	%r11, %rbx
	jne	.LBB0_20
# %bb.21:
	movq	%rax, %r8
	cmpq	%rbx, %rcx
	je	.LBB0_27
	jmp	.LBB0_22
.Lfunc_end0:
	.size	scale_add, .Lfunc_end0-scale_add
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
