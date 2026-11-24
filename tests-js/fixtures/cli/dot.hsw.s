	.text
	.file	"dot.c"
	.globl	dot                             # -- Begin function dot
	.p2align	4, 0x90
	.type	dot,@function
dot:                                    # @dot
	.cfi_startproc
# %bb.0:
	testq	%rdx, %rdx
	je	.LBB0_1
# %bb.2:
	movl	%edx, %eax
	andl	$7, %eax
	cmpq	$8, %rdx
	jae	.LBB0_8
# %bb.3:
	vxorps	%xmm0, %xmm0, %xmm0
	xorl	%ecx, %ecx
	jmp	.LBB0_4
.LBB0_1:
	vxorps	%xmm0, %xmm0, %xmm0
	retq
.LBB0_8:
	andq	$-8, %rdx
	vxorps	%xmm0, %xmm0, %xmm0
	xorl	%ecx, %ecx
	.p2align	4, 0x90
.LBB0_9:                                # =>This Inner Loop Header: Depth=1
	vmovss	(%rdi,%rcx,4), %xmm1            # xmm1 = mem[0],zero,zero,zero
	vmovss	4(%rdi,%rcx,4), %xmm2           # xmm2 = mem[0],zero,zero,zero
	vfmadd132ss	(%rsi,%rcx,4), %xmm0, %xmm1 # xmm1 = (xmm1 * mem) + xmm0
	vfmadd231ss	4(%rsi,%rcx,4), %xmm2, %xmm1 # xmm1 = (xmm2 * mem) + xmm1
	vmovss	8(%rdi,%rcx,4), %xmm0           # xmm0 = mem[0],zero,zero,zero
	vfmadd132ss	8(%rsi,%rcx,4), %xmm1, %xmm0 # xmm0 = (xmm0 * mem) + xmm1
	vmovss	12(%rdi,%rcx,4), %xmm1          # xmm1 = mem[0],zero,zero,zero
	vfmadd132ss	12(%rsi,%rcx,4), %xmm0, %xmm1 # xmm1 = (xmm1 * mem) + xmm0
	vmovss	16(%rdi,%rcx,4), %xmm0          # xmm0 = mem[0],zero,zero,zero
	vfmadd132ss	16(%rsi,%rcx,4), %xmm1, %xmm0 # xmm0 = (xmm0 * mem) + xmm1
	vmovss	20(%rdi,%rcx,4), %xmm1          # xmm1 = mem[0],zero,zero,zero
	vfmadd132ss	20(%rsi,%rcx,4), %xmm0, %xmm1 # xmm1 = (xmm1 * mem) + xmm0
	vmovss	24(%rdi,%rcx,4), %xmm2          # xmm2 = mem[0],zero,zero,zero
	vfmadd132ss	24(%rsi,%rcx,4), %xmm1, %xmm2 # xmm2 = (xmm2 * mem) + xmm1
	vmovss	28(%rdi,%rcx,4), %xmm0          # xmm0 = mem[0],zero,zero,zero
	vfmadd132ss	28(%rsi,%rcx,4), %xmm2, %xmm0 # xmm0 = (xmm0 * mem) + xmm2
	addq	$8, %rcx
	cmpq	%rcx, %rdx
	jne	.LBB0_9
.LBB0_4:
	testq	%rax, %rax
	je	.LBB0_7
# %bb.5:
	leaq	(%rsi,%rcx,4), %rdx
	leaq	(%rdi,%rcx,4), %rcx
	xorl	%esi, %esi
	.p2align	4, 0x90
.LBB0_6:                                # =>This Inner Loop Header: Depth=1
	vmovss	(%rcx,%rsi,4), %xmm1            # xmm1 = mem[0],zero,zero,zero
	vfmadd231ss	(%rdx,%rsi,4), %xmm1, %xmm0 # xmm0 = (xmm1 * mem) + xmm0
	incq	%rsi
	cmpq	%rsi, %rax
	jne	.LBB0_6
.LBB0_7:
	retq
.Lfunc_end0:
	.size	dot, .Lfunc_end0-dot
	.cfi_endproc
                                        # -- End function
	.ident	"Apple clang version 17.0.0 (clang-1700.0.13.5)"
	.section	".note.GNU-stack","",@progbits
	.addrsig
