	.att_syntax
	.file	"mm3.c"
	.text
	.globl	mm3                             # -- Begin function mm3
	.prefalign	4, .Lfunc_end0, nop
	.type	mm3,@function
mm3:                                    # @mm3
# %bb.0:
	pushq	%rbp
	pushq	%r15
	pushq	%r14
	pushq	%r13
	pushq	%r12
	pushq	%rbx
	movq	%rdx, -8(%rsp)                  # 8-byte Spill
	movq	%rsi, -40(%rsp)                 # 8-byte Spill
	movq	%rdi, -32(%rsp)                 # 8-byte Spill
	testl	%ecx, %ecx
	setle	%al
	testl	%r9d, %r9d
	setle	%dl
	orb	%al, %dl
	jne	.LBB0_14
# %bb.1:
	movl	%r9d, %eax
	movl	%ecx, %edx
	movl	%eax, %esi
	andl	$2147483616, %esi               # imm = 0x7FFFFFE0
	movl	%eax, %r10d
	andl	$2147483644, %r10d              # imm = 0x7FFFFFFC
	movl	%r9d, %r11d
	shrl	$5, %r11d
	andl	$67108863, %r11d                # imm = 0x3FFFFFF
	shlq	$7, %r11
	movq	-32(%rsp), %r12                 # 8-byte Reload
	leaq	96(%r12), %rbx
	leaq	(,%rax,4), %r14
	xorl	%r15d, %r15d
	vxorps	%xmm0, %xmm0, %xmm0
	vxorps	%xmm1, %xmm1, %xmm1
	jmp	.LBB0_2
	.p2align	4
.LBB0_13:                               #   in Loop: Header=BB0_2 Depth=1
	incq	%r15
	addq	%r14, %rbx
	addq	%r14, %r12
	cmpq	%rdx, %r15
	je	.LBB0_14
.LBB0_2:                                # =>This Loop Header: Depth=1
                                        #     Child Loop BB0_8 Depth 2
                                        #     Child Loop BB0_11 Depth 2
                                        #     Child Loop BB0_4 Depth 2
	cmpl	$4, %r9d
	jae	.LBB0_5
# %bb.3:                                #   in Loop: Header=BB0_2 Depth=1
	xorl	%edi, %edi
	jmp	.LBB0_4
	.p2align	4
.LBB0_5:                                #   in Loop: Header=BB0_2 Depth=1
	cmpl	$32, %r9d
	jae	.LBB0_7
# %bb.6:                                #   in Loop: Header=BB0_2 Depth=1
	xorl	%r13d, %r13d
	jmp	.LBB0_11
	.p2align	4
.LBB0_7:                                #   in Loop: Header=BB0_2 Depth=1
	xorl	%edi, %edi
	.p2align	4
.LBB0_8:                                #   Parent Loop BB0_2 Depth=1
                                        # =>  This Inner Loop Header: Depth=2
	vmovups	%ymm1, -96(%rbx,%rdi)
	vmovups	%ymm1, -64(%rbx,%rdi)
	vmovups	%ymm1, -32(%rbx,%rdi)
	vmovups	%ymm1, (%rbx,%rdi)
	subq	$-128, %rdi
	cmpq	%rdi, %r11
	jne	.LBB0_8
# %bb.9:                                #   in Loop: Header=BB0_2 Depth=1
	cmpl	%eax, %esi
	je	.LBB0_13
# %bb.10:                               #   in Loop: Header=BB0_2 Depth=1
	movq	%rsi, %r13
	movq	%rsi, %rdi
	testb	$28, %al
	je	.LBB0_4
	.p2align	4
.LBB0_11:                               #   Parent Loop BB0_2 Depth=1
                                        # =>  This Inner Loop Header: Depth=2
	vmovups	%xmm0, (%r12,%r13,4)
	addq	$4, %r13
	cmpq	%r13, %r10
	jne	.LBB0_11
# %bb.12:                               #   in Loop: Header=BB0_2 Depth=1
	movq	%r10, %rdi
	cmpl	%eax, %r10d
	je	.LBB0_13
	.p2align	4
.LBB0_4:                                #   Parent Loop BB0_2 Depth=1
                                        # =>  This Inner Loop Header: Depth=2
	movl	$0, (%r12,%rdi,4)
	incq	%rdi
	cmpq	%rdi, %rax
	jne	.LBB0_4
	jmp	.LBB0_13
.LBB0_14:
	testl	%ecx, %ecx
	jle	.LBB0_22
# %bb.15:
	testl	%r9d, %r9d
	jle	.LBB0_22
# %bb.16:
	movl	%r9d, %eax
	movl	%ecx, %ecx
	movq	%rcx, -16(%rsp)                 # 8-byte Spill
	movl	%r8d, %r9d
	movl	%r9d, %r10d
	andl	$7, %r10d
	andl	$2147483640, %r9d               # imm = 0x7FFFFFF8
	movq	-40(%rsp), %rcx                 # 8-byte Reload
	addq	$28, %rcx
	movq	%rcx, -24(%rsp)                 # 8-byte Spill
	movq	%rax, %rbx
	shlq	$5, %rbx
	leaq	(,%rax,4), %r14
	xorl	%r15d, %r15d
	xorl	%ecx, %ecx
	jmp	.LBB0_17
	.p2align	4
.LBB0_21:                               #   in Loop: Header=BB0_17 Depth=1
	incq	%r15
	movl	-44(%rsp), %ecx                 # 4-byte Reload
	addl	%r8d, %ecx
	cmpq	-16(%rsp), %r15                 # 8-byte Folded Reload
	je	.LBB0_22
.LBB0_17:                               # =>This Loop Header: Depth=1
                                        #     Child Loop BB0_18 Depth 2
                                        #       Child Loop BB0_28 Depth 3
                                        #       Child Loop BB0_25 Depth 3
	movl	%ecx, -44(%rsp)                 # 4-byte Spill
	movl	%ecx, %ecx
	movq	-24(%rsp), %rdx                 # 8-byte Reload
	leaq	(%rdx,%rcx,4), %r12
	movq	%r15, %rdx
	imulq	%rax, %rdx
	movq	-32(%rsp), %rsi                 # 8-byte Reload
	leaq	(%rsi,%rdx,4), %r13
	movq	-40(%rsp), %rdx                 # 8-byte Reload
	leaq	(%rdx,%rcx,4), %r11
	movq	-8(%rsp), %rdi                  # 8-byte Reload
	xorl	%ecx, %ecx
	jmp	.LBB0_18
	.p2align	4
.LBB0_26:                               #   in Loop: Header=BB0_18 Depth=2
	vmovss	%xmm0, (%r13,%rcx,4)
	incq	%rcx
	addq	$4, %rdi
	cmpq	%rax, %rcx
	je	.LBB0_21
.LBB0_18:                               #   Parent Loop BB0_17 Depth=1
                                        # =>  This Loop Header: Depth=2
                                        #       Child Loop BB0_28 Depth 3
                                        #       Child Loop BB0_25 Depth 3
	vxorps	%xmm0, %xmm0, %xmm0
	testl	%r8d, %r8d
	jle	.LBB0_26
# %bb.19:                               #   in Loop: Header=BB0_18 Depth=2
	cmpl	$8, %r8d
	jae	.LBB0_27
# %bb.20:                               #   in Loop: Header=BB0_18 Depth=2
	xorl	%esi, %esi
	jmp	.LBB0_24
	.p2align	4
.LBB0_27:                               #   in Loop: Header=BB0_18 Depth=2
	movq	%rdi, %rdx
	xorl	%esi, %esi
	.p2align	4
.LBB0_28:                               #   Parent Loop BB0_17 Depth=1
                                        #     Parent Loop BB0_18 Depth=2
                                        # =>    This Inner Loop Header: Depth=3
	vmovss	-28(%r12,%rsi,4), %xmm1         # xmm1 = mem[0],zero,zero,zero
	vmovss	-24(%r12,%rsi,4), %xmm2         # xmm2 = mem[0],zero,zero,zero
	vfmadd231ss	(%rdx), %xmm1, %xmm0    # xmm0 = (xmm1 * mem) + xmm0
	vfmadd231ss	(%rdx,%r14), %xmm2, %xmm0 # xmm0 = (xmm2 * mem) + xmm0
	leaq	(%rdx,%r14), %rbp
	vmovss	-20(%r12,%rsi,4), %xmm1         # xmm1 = mem[0],zero,zero,zero
	vfmadd132ss	(%r14,%rbp), %xmm0, %xmm1 # xmm1 = (xmm1 * mem) + xmm0
	addq	%r14, %rbp
	vmovss	-16(%r12,%rsi,4), %xmm0         # xmm0 = mem[0],zero,zero,zero
	vfmadd132ss	(%r14,%rbp), %xmm1, %xmm0 # xmm0 = (xmm0 * mem) + xmm1
	addq	%r14, %rbp
	vmovss	-12(%r12,%rsi,4), %xmm1         # xmm1 = mem[0],zero,zero,zero
	vfmadd132ss	(%r14,%rbp), %xmm0, %xmm1 # xmm1 = (xmm1 * mem) + xmm0
	addq	%r14, %rbp
	vmovss	-8(%r12,%rsi,4), %xmm0          # xmm0 = mem[0],zero,zero,zero
	vfmadd132ss	(%r14,%rbp), %xmm1, %xmm0 # xmm0 = (xmm0 * mem) + xmm1
	addq	%r14, %rbp
	vmovss	-4(%r12,%rsi,4), %xmm1          # xmm1 = mem[0],zero,zero,zero
	vfmadd132ss	(%r14,%rbp), %xmm0, %xmm1 # xmm1 = (xmm1 * mem) + xmm0
	addq	%r14, %rbp
	vmovss	(%r12,%rsi,4), %xmm0            # xmm0 = mem[0],zero,zero,zero
	vfmadd132ss	(%r14,%rbp), %xmm1, %xmm0 # xmm0 = (xmm0 * mem) + xmm1
	addq	$8, %rsi
	addq	%rbx, %rdx
	cmpq	%rsi, %r9
	jne	.LBB0_28
# %bb.23:                               #   in Loop: Header=BB0_18 Depth=2
	testq	%r10, %r10
	je	.LBB0_26
.LBB0_24:                               #   in Loop: Header=BB0_18 Depth=2
	movq	%r14, %rdx
	imulq	%rsi, %rdx
	addq	%rdi, %rdx
	leaq	(%r11,%rsi,4), %rsi
	xorl	%ebp, %ebp
	.p2align	4
.LBB0_25:                               #   Parent Loop BB0_17 Depth=1
                                        #     Parent Loop BB0_18 Depth=2
                                        # =>    This Inner Loop Header: Depth=3
	vmovss	(%rsi,%rbp,4), %xmm1            # xmm1 = mem[0],zero,zero,zero
	vfmadd231ss	(%rdx), %xmm1, %xmm0    # xmm0 = (xmm1 * mem) + xmm0
	incq	%rbp
	addq	%r14, %rdx
	cmpq	%rbp, %r10
	jne	.LBB0_25
	jmp	.LBB0_26
.LBB0_22:
	popq	%rbx
	popq	%r12
	popq	%r13
	popq	%r14
	popq	%r15
	popq	%rbp
	vzeroupper
	retq
.Lfunc_end0:
	.size	mm3, .Lfunc_end0-mm3
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
