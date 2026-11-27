	.att_syntax
	.file	"dot_sse.c"
	.section	.rodata.cst4,"aM",@progbits,4
	.p2align	2, 0x0                          # -- Begin function dot_sse
.LCPI0_0:
	.long	0x7fffffff                      # float NaN
.LCPI0_1:
	.long	0x3f000000                      # float 0.5
	.text
	.globl	dot_sse
	.prefalign	4, .Lfunc_end0, nop
	.type	dot_sse,@function
dot_sse:                                # @dot_sse
# %bb.0:
	cmpq	$4, %rdx
	jge	.LBB0_2
# %bb.1:
	vxorps	%xmm0, %xmm0, %xmm0
	xorl	%eax, %eax
	jmp	.LBB0_10
.LBB0_2:
	movabsq	$9223372036854775800, %rax      # imm = 0x7FFFFFFFFFFFFFF8
	leaq	-4(%rdx), %r8
	movq	%r8, %r9
	shrq	$2, %r9
	incq	%r9
	movl	%r9d, %ecx
	andl	$7, %ecx
	cmpq	$28, %r8
	jae	.LBB0_4
# %bb.3:
	vxorps	%xmm0, %xmm0, %xmm0
	movl	$4, %r9d
	xorl	%r8d, %r8d
	jmp	.LBB0_8
.LBB0_4:
	andq	%rax, %r9
	vxorps	%xmm0, %xmm0, %xmm0
	xorl	%r8d, %r8d
	.p2align	4
.LBB0_5:                                # =>This Inner Loop Header: Depth=1
	vmovups	(%rdi,%r8,4), %xmm1
	vmovups	16(%rdi,%r8,4), %xmm2
	vmovups	32(%rdi,%r8,4), %xmm3
	vmovups	48(%rdi,%r8,4), %xmm4
	vmulps	(%rsi,%r8,4), %xmm1, %xmm1
	vaddps	%xmm1, %xmm0, %xmm0
	vmulps	16(%rsi,%r8,4), %xmm2, %xmm1
	vaddps	%xmm1, %xmm0, %xmm0
	vmulps	32(%rsi,%r8,4), %xmm3, %xmm1
	vmulps	48(%rsi,%r8,4), %xmm4, %xmm2
	vaddps	%xmm1, %xmm0, %xmm0
	vmovups	64(%rdi,%r8,4), %xmm1
	vmulps	64(%rsi,%r8,4), %xmm1, %xmm1
	vaddps	%xmm2, %xmm0, %xmm0
	vmovups	80(%rdi,%r8,4), %xmm2
	vmulps	80(%rsi,%r8,4), %xmm2, %xmm2
	vaddps	%xmm1, %xmm0, %xmm0
	vmovups	96(%rdi,%r8,4), %xmm1
	vmulps	96(%rsi,%r8,4), %xmm1, %xmm1
	vaddps	%xmm2, %xmm0, %xmm0
	vmovups	112(%rdi,%r8,4), %xmm2
	vmulps	112(%rsi,%r8,4), %xmm2, %xmm2
	vaddps	%xmm1, %xmm0, %xmm0
	vaddps	%xmm2, %xmm0, %xmm0
	addq	$32, %r8
	addq	$-8, %r9
	jne	.LBB0_5
# %bb.6:
	testq	%rcx, %rcx
	je	.LBB0_9
# %bb.7:
	leaq	4(%r8), %r9
	.p2align	4
.LBB0_8:                                # =>This Inner Loop Header: Depth=1
	vmovups	(%rdi,%r8,4), %xmm1
	vmulps	(%rsi,%r8,4), %xmm1, %xmm1
	movq	%r9, %r8
	vaddps	%xmm1, %xmm0, %xmm0
	addq	$4, %r9
	decq	%rcx
	jne	.LBB0_8
.LBB0_9:
	addq	$4, %rax
	andq	%rdx, %rax
.LBB0_10:
	vhaddps	%xmm0, %xmm0, %xmm0
	vmovshdup	%xmm0, %xmm1            # xmm1 = xmm0[1,1,3,3]
	vaddss	%xmm1, %xmm0, %xmm0
	movq	%rax, %rcx
	subq	%rdx, %rcx
	jge	.LBB0_17
# %bb.11:
	movq	%rdx, %r8
	andq	$3, %r8
	je	.LBB0_14
# %bb.12:
	vbroadcastss	.LCPI0_0(%rip), %xmm1   # xmm1 = [NaN,NaN,NaN,NaN]
	vmovss	.LCPI0_1(%rip), %xmm2           # xmm2 = [5.0E-1,0.0E+0,0.0E+0,0.0E+0]
	.p2align	4
.LBB0_13:                               # =>This Inner Loop Header: Depth=1
	vmovss	(%rdi,%rax,4), %xmm3            # xmm3 = mem[0],zero,zero,zero
	vmovss	(%rsi,%rax,4), %xmm4            # xmm4 = mem[0],zero,zero,zero
	vsubss	%xmm4, %xmm3, %xmm5
	vandps	%xmm1, %xmm5, %xmm5
	vmulss	%xmm2, %xmm5, %xmm5
	vfmadd231ss	%xmm4, %xmm3, %xmm5     # xmm5 = (xmm3 * xmm4) + xmm5
	vaddss	%xmm5, %xmm0, %xmm0
	incq	%rax
	decq	%r8
	jne	.LBB0_13
.LBB0_14:
	cmpq	$-4, %rcx
	ja	.LBB0_17
# %bb.15:
	vbroadcastss	.LCPI0_0(%rip), %xmm1   # xmm1 = [NaN,NaN,NaN,NaN]
	vmovss	.LCPI0_1(%rip), %xmm2           # xmm2 = [5.0E-1,0.0E+0,0.0E+0,0.0E+0]
	.p2align	4
.LBB0_16:                               # =>This Inner Loop Header: Depth=1
	vmovss	(%rdi,%rax,4), %xmm3            # xmm3 = mem[0],zero,zero,zero
	vmovss	4(%rdi,%rax,4), %xmm4           # xmm4 = mem[0],zero,zero,zero
	vmovss	(%rsi,%rax,4), %xmm5            # xmm5 = mem[0],zero,zero,zero
	vmovss	4(%rsi,%rax,4), %xmm6           # xmm6 = mem[0],zero,zero,zero
	vsubss	%xmm5, %xmm3, %xmm7
	vandps	%xmm1, %xmm7, %xmm7
	vmulss	%xmm2, %xmm7, %xmm7
	vfmadd231ss	%xmm5, %xmm3, %xmm7     # xmm7 = (xmm3 * xmm5) + xmm7
	vaddss	%xmm7, %xmm0, %xmm0
	vsubss	%xmm6, %xmm4, %xmm3
	vandps	%xmm1, %xmm3, %xmm3
	vmulss	%xmm2, %xmm3, %xmm3
	vfmadd231ss	%xmm6, %xmm4, %xmm3     # xmm3 = (xmm4 * xmm6) + xmm3
	vaddss	%xmm3, %xmm0, %xmm0
	vmovss	8(%rdi,%rax,4), %xmm3           # xmm3 = mem[0],zero,zero,zero
	vmovss	8(%rsi,%rax,4), %xmm4           # xmm4 = mem[0],zero,zero,zero
	vsubss	%xmm4, %xmm3, %xmm5
	vandps	%xmm1, %xmm5, %xmm5
	vmulss	%xmm2, %xmm5, %xmm5
	vfmadd231ss	%xmm4, %xmm3, %xmm5     # xmm5 = (xmm3 * xmm4) + xmm5
	vaddss	%xmm5, %xmm0, %xmm0
	vmovss	12(%rdi,%rax,4), %xmm3          # xmm3 = mem[0],zero,zero,zero
	vmovss	12(%rsi,%rax,4), %xmm4          # xmm4 = mem[0],zero,zero,zero
	vsubss	%xmm4, %xmm3, %xmm5
	vandps	%xmm1, %xmm5, %xmm5
	vmulss	%xmm2, %xmm5, %xmm5
	vfmadd231ss	%xmm4, %xmm3, %xmm5     # xmm5 = (xmm3 * xmm4) + xmm5
	vaddss	%xmm5, %xmm0, %xmm0
	addq	$4, %rax
	cmpq	%rax, %rdx
	jne	.LBB0_16
.LBB0_17:
	retq
.Lfunc_end0:
	.size	dot_sse, .Lfunc_end0-dot_sse
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
