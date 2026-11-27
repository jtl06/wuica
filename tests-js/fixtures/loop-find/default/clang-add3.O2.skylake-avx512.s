	.att_syntax
	.file	"add3.c"
	.text
	.globl	add3                            # -- Begin function add3
	.prefalign	4, .Lfunc_end0, nop
	.type	add3,@function
add3:                                   # @add3
# %bb.0:
	cmpq	$16, %rcx
	jge	.LBB0_2
# %bb.1:
	xorl	%eax, %eax
	jmp	.LBB0_10
.LBB0_2:
	leaq	-16(%rcx), %rax
	movq	%rax, %r9
	shrq	$4, %r9
	incq	%r9
	movl	%r9d, %r8d
	andl	$7, %r8d
	cmpq	$112, %rax
	jae	.LBB0_4
# %bb.3:
	movl	$16, %r9d
	xorl	%eax, %eax
	jmp	.LBB0_8
.LBB0_4:
	andq	$-8, %r9
	xorl	%eax, %eax
	.p2align	4
.LBB0_5:                                # =>This Inner Loop Header: Depth=1
	vmovups	(%rsi,%rax,4), %zmm0
	vaddps	(%rdx,%rax,4), %zmm0, %zmm0
	vmovups	%zmm0, (%rdi,%rax,4)
	vmovups	64(%rsi,%rax,4), %zmm0
	vaddps	64(%rdx,%rax,4), %zmm0, %zmm0
	vmovups	%zmm0, 64(%rdi,%rax,4)
	vmovups	128(%rsi,%rax,4), %zmm0
	vaddps	128(%rdx,%rax,4), %zmm0, %zmm0
	vmovups	%zmm0, 128(%rdi,%rax,4)
	vmovups	192(%rsi,%rax,4), %zmm0
	vaddps	192(%rdx,%rax,4), %zmm0, %zmm0
	vmovups	%zmm0, 192(%rdi,%rax,4)
	vmovups	256(%rsi,%rax,4), %zmm0
	vaddps	256(%rdx,%rax,4), %zmm0, %zmm0
	vmovups	%zmm0, 256(%rdi,%rax,4)
	vmovups	320(%rsi,%rax,4), %zmm0
	vaddps	320(%rdx,%rax,4), %zmm0, %zmm0
	vmovups	%zmm0, 320(%rdi,%rax,4)
	vmovups	384(%rsi,%rax,4), %zmm0
	vaddps	384(%rdx,%rax,4), %zmm0, %zmm0
	vmovups	%zmm0, 384(%rdi,%rax,4)
	vmovups	448(%rsi,%rax,4), %zmm0
	vaddps	448(%rdx,%rax,4), %zmm0, %zmm0
	vmovups	%zmm0, 448(%rdi,%rax,4)
	subq	$-128, %rax
	addq	$-8, %r9
	jne	.LBB0_5
# %bb.6:
	testq	%r8, %r8
	je	.LBB0_10
# %bb.7:
	leaq	16(%rax), %r9
	.p2align	4
.LBB0_8:                                # =>This Inner Loop Header: Depth=1
	vmovups	(%rsi,%rax,4), %zmm0
	vaddps	(%rdx,%rax,4), %zmm0, %zmm0
	vmovups	%zmm0, (%rdi,%rax,4)
	movq	%r9, %rax
	addq	$16, %r9
	decq	%r8
	jne	.LBB0_8
# %bb.9:
	addq	$-16, %r9
	movq	%r9, %rax
.LBB0_10:
	leaq	8(%rax), %r8
	cmpq	%rcx, %r8
	jle	.LBB0_12
# %bb.11:
	movq	%rax, %r8
	jmp	.LBB0_13
	.p2align	4
.LBB0_12:                               # =>This Inner Loop Header: Depth=1
	vmovups	(%rsi,%rax,4), %ymm0
	vaddps	(%rdx,%rax,4), %ymm0, %ymm0
	vmovups	%ymm0, (%rdi,%rax,4)
	leaq	8(%rax), %r8
	addq	$16, %rax
	cmpq	%rcx, %rax
	movq	%r8, %rax
	jle	.LBB0_12
.LBB0_13:
	movq	%rcx, %r9
	subq	%r8, %r9
	jle	.LBB0_33
# %bb.14:
	pushq	%r15
	pushq	%r14
	pushq	%rbx
	cmpq	$8, %r9
	jb	.LBB0_15
# %bb.16:
	movq	%rsi, %rax
	subq	%rdi, %rax
	cmpq	$-127, %rax
	setae	%al
	movq	%rdx, %r10
	subq	%rdi, %r10
	cmpq	$-127, %r10
	setae	%r10b
	orb	%al, %r10b
	je	.LBB0_18
.LBB0_15:
	movq	%r8, %rax
.LBB0_27:
	movl	%ecx, %r9d
	subl	%eax, %r9d
	movq	%rax, %r8
	andl	$7, %r9d
	je	.LBB0_30
# %bb.28:
	movq	%rax, %r8
	.p2align	4
.LBB0_29:                               # =>This Inner Loop Header: Depth=1
	vmovss	(%rsi,%r8,4), %xmm0             # xmm0 = mem[0],zero,zero,zero
	vaddss	(%rdx,%r8,4), %xmm0, %xmm0
	vmovss	%xmm0, (%rdi,%r8,4)
	incq	%r8
	decq	%r9
	jne	.LBB0_29
.LBB0_30:
	subq	%rcx, %rax
	cmpq	$-8, %rax
	ja	.LBB0_32
	.p2align	4
.LBB0_31:                               # =>This Inner Loop Header: Depth=1
	vmovss	(%rsi,%r8,4), %xmm0             # xmm0 = mem[0],zero,zero,zero
	vaddss	(%rdx,%r8,4), %xmm0, %xmm0
	vmovss	%xmm0, (%rdi,%r8,4)
	vmovss	4(%rsi,%r8,4), %xmm0            # xmm0 = mem[0],zero,zero,zero
	vaddss	4(%rdx,%r8,4), %xmm0, %xmm0
	vmovss	%xmm0, 4(%rdi,%r8,4)
	vmovss	8(%rsi,%r8,4), %xmm0            # xmm0 = mem[0],zero,zero,zero
	vaddss	8(%rdx,%r8,4), %xmm0, %xmm0
	vmovss	%xmm0, 8(%rdi,%r8,4)
	vmovss	12(%rsi,%r8,4), %xmm0           # xmm0 = mem[0],zero,zero,zero
	vaddss	12(%rdx,%r8,4), %xmm0, %xmm0
	vmovss	%xmm0, 12(%rdi,%r8,4)
	vmovss	16(%rsi,%r8,4), %xmm0           # xmm0 = mem[0],zero,zero,zero
	vaddss	16(%rdx,%r8,4), %xmm0, %xmm0
	vmovss	%xmm0, 16(%rdi,%r8,4)
	vmovss	20(%rsi,%r8,4), %xmm0           # xmm0 = mem[0],zero,zero,zero
	vaddss	20(%rdx,%r8,4), %xmm0, %xmm0
	vmovss	%xmm0, 20(%rdi,%r8,4)
	vmovss	24(%rsi,%r8,4), %xmm0           # xmm0 = mem[0],zero,zero,zero
	vaddss	24(%rdx,%r8,4), %xmm0, %xmm0
	vmovss	%xmm0, 24(%rdi,%r8,4)
	vmovss	28(%rsi,%r8,4), %xmm0           # xmm0 = mem[0],zero,zero,zero
	vaddss	28(%rdx,%r8,4), %xmm0, %xmm0
	vmovss	%xmm0, 28(%rdi,%r8,4)
	addq	$8, %r8
	cmpq	%r8, %rcx
	jne	.LBB0_31
.LBB0_32:
	popq	%rbx
	popq	%r14
	popq	%r15
.LBB0_33:
	vzeroupper
	retq
.LBB0_18:
	cmpq	$32, %r9
	jae	.LBB0_20
# %bb.19:
	xorl	%r10d, %r10d
	jmp	.LBB0_24
.LBB0_20:
	movq	%r9, %r10
	andq	$-32, %r10
	leaq	(%r8,%r10), %rax
	leaq	(%rdi,%r8,4), %r11
	addq	$96, %r11
	leaq	(%rdx,%r8,4), %rbx
	addq	$96, %rbx
	leaq	(%rsi,%r8,4), %r14
	addq	$96, %r14
	xorl	%r15d, %r15d
	.p2align	4
.LBB0_21:                               # =>This Inner Loop Header: Depth=1
	vmovups	-96(%r14,%r15,4), %ymm0
	vmovups	-64(%r14,%r15,4), %ymm1
	vmovups	-32(%r14,%r15,4), %ymm2
	vmovups	(%r14,%r15,4), %ymm3
	vaddps	-96(%rbx,%r15,4), %ymm0, %ymm0
	vaddps	-64(%rbx,%r15,4), %ymm1, %ymm1
	vaddps	-32(%rbx,%r15,4), %ymm2, %ymm2
	vaddps	(%rbx,%r15,4), %ymm3, %ymm3
	vmovups	%ymm0, -96(%r11,%r15,4)
	vmovups	%ymm1, -64(%r11,%r15,4)
	vmovups	%ymm2, -32(%r11,%r15,4)
	vmovups	%ymm3, (%r11,%r15,4)
	addq	$32, %r15
	cmpq	%r15, %r10
	jne	.LBB0_21
# %bb.22:
	cmpq	%r10, %r9
	je	.LBB0_32
# %bb.23:
	testb	$24, %r9b
	je	.LBB0_27
.LBB0_24:
	movq	%r9, %r11
	andq	$-8, %r11
	leaq	(%r8,%r11), %rax
	leaq	(%rdi,%r8,4), %rbx
	leaq	(%rdx,%r8,4), %r14
	leaq	(%rsi,%r8,4), %r8
	.p2align	4
.LBB0_25:                               # =>This Inner Loop Header: Depth=1
	vmovups	(%r8,%r10,4), %ymm0
	vaddps	(%r14,%r10,4), %ymm0, %ymm0
	vmovups	%ymm0, (%rbx,%r10,4)
	addq	$8, %r10
	cmpq	%r10, %r11
	jne	.LBB0_25
# %bb.26:
	cmpq	%r11, %r9
	je	.LBB0_32
	jmp	.LBB0_27
.Lfunc_end0:
	.size	add3, .Lfunc_end0-add3
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
