	.att_syntax
	.file	"dot4.c"
	.text
	.globl	dot                             # -- Begin function dot
	.prefalign	4, .Lfunc_end0, nop
	.type	dot,@function
dot:                                    # @dot
# %bb.0:
	vxorps	%xmm0, %xmm0, %xmm0
	cmpq	$4, %rdx
	jae	.LBB0_10
# %bb.1:
	vxorps	%xmm1, %xmm1, %xmm1
	xorl	%eax, %eax
	jmp	.LBB0_3
.LBB0_10:
	xorl	%eax, %eax
	vxorps	%xmm1, %xmm1, %xmm1
	.p2align	4
.LBB0_11:                               # =>This Inner Loop Header: Depth=1
	movq	%rax, %rcx
	vmovsd	(%rdi,%rax,4), %xmm2            # xmm2 = mem[0],zero
	vmovsd	8(%rdi,%rax,4), %xmm3           # xmm3 = mem[0],zero
	vmovsd	(%rsi,%rax,4), %xmm4            # xmm4 = mem[0],zero
	vfmadd231ps	%xmm4, %xmm2, %xmm0     # xmm0 = (xmm2 * xmm4) + xmm0
	vmovsd	8(%rsi,%rax,4), %xmm2           # xmm2 = mem[0],zero
	vfmadd231ps	%xmm2, %xmm3, %xmm1     # xmm1 = (xmm3 * xmm2) + xmm1
	addq	$4, %rax
	addq	$8, %rcx
	cmpq	%rdx, %rcx
	jbe	.LBB0_11
# %bb.2:
	vmovshdup	%xmm1, %xmm2            # xmm2 = xmm1[1,1,3,3]
	vaddss	%xmm2, %xmm1, %xmm1
.LBB0_3:
	movq	%rax, %rcx
	subq	%rdx, %rcx
	jae	.LBB0_4
# %bb.5:
	movl	%edx, %r8d
	subl	%eax, %r8d
	vmovaps	%xmm0, %xmm2
	andl	$7, %r8d
	je	.LBB0_7
	.p2align	4
.LBB0_6:                                # =>This Inner Loop Header: Depth=1
	vmovss	(%rdi,%rax,4), %xmm3            # xmm3 = mem[0],zero,zero,zero
	vfmadd231ss	(%rsi,%rax,4), %xmm3, %xmm2 # xmm2 = (xmm3 * mem) + xmm2
	incq	%rax
	decq	%r8
	jne	.LBB0_6
.LBB0_7:
	cmpq	$-8, %rcx
	ja	.LBB0_9
	.p2align	4
.LBB0_8:                                # =>This Inner Loop Header: Depth=1
	vmovss	(%rdi,%rax,4), %xmm3            # xmm3 = mem[0],zero,zero,zero
	vfmadd231ss	(%rsi,%rax,4), %xmm3, %xmm2 # xmm2 = (xmm3 * mem) + xmm2
	vmovss	4(%rdi,%rax,4), %xmm3           # xmm3 = mem[0],zero,zero,zero
	vfmadd231ss	4(%rsi,%rax,4), %xmm3, %xmm2 # xmm2 = (xmm3 * mem) + xmm2
	vmovss	8(%rdi,%rax,4), %xmm3           # xmm3 = mem[0],zero,zero,zero
	vfmadd132ss	8(%rsi,%rax,4), %xmm2, %xmm3 # xmm3 = (xmm3 * mem) + xmm2
	vmovss	12(%rdi,%rax,4), %xmm2          # xmm2 = mem[0],zero,zero,zero
	vfmadd132ss	12(%rsi,%rax,4), %xmm3, %xmm2 # xmm2 = (xmm2 * mem) + xmm3
	vmovss	16(%rdi,%rax,4), %xmm3          # xmm3 = mem[0],zero,zero,zero
	vfmadd132ss	16(%rsi,%rax,4), %xmm2, %xmm3 # xmm3 = (xmm3 * mem) + xmm2
	vmovss	20(%rdi,%rax,4), %xmm2          # xmm2 = mem[0],zero,zero,zero
	vfmadd132ss	20(%rsi,%rax,4), %xmm3, %xmm2 # xmm2 = (xmm2 * mem) + xmm3
	vmovss	24(%rdi,%rax,4), %xmm3          # xmm3 = mem[0],zero,zero,zero
	vfmadd132ss	24(%rsi,%rax,4), %xmm2, %xmm3 # xmm3 = (xmm3 * mem) + xmm2
	vmovss	28(%rdi,%rax,4), %xmm2          # xmm2 = mem[0],zero,zero,zero
	vfmadd132ss	28(%rsi,%rax,4), %xmm3, %xmm2 # xmm2 = (xmm2 * mem) + xmm3
	addq	$8, %rax
	cmpq	%rax, %rdx
	jne	.LBB0_8
	jmp	.LBB0_9
.LBB0_4:
	vmovaps	%xmm0, %xmm2
.LBB0_9:
	vmovshdup	%xmm0, %xmm0            # xmm0 = xmm0[1,1,3,3]
	vaddss	%xmm2, %xmm0, %xmm0
	vaddss	%xmm0, %xmm1, %xmm0
	retq
.Lfunc_end0:
	.size	dot, .Lfunc_end0-dot
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
