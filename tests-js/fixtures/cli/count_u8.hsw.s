	.text
	.file	"count_u8.c"
	.globl	count_byte                      # -- Begin function count_byte
	.p2align	4, 0x90
	.type	count_byte,@function
count_byte:                             # @count_byte
	.cfi_startproc
# %bb.0:
	testq	%rsi, %rsi
	je	.LBB0_1
# %bb.3:
	pushq	%rbp
	.cfi_def_cfa_offset 16
	pushq	%r15
	.cfi_def_cfa_offset 24
	pushq	%r14
	.cfi_def_cfa_offset 32
	pushq	%r13
	.cfi_def_cfa_offset 40
	pushq	%r12
	.cfi_def_cfa_offset 48
	pushq	%rbx
	.cfi_def_cfa_offset 56
	.cfi_offset %rbx, -56
	.cfi_offset %r12, -48
	.cfi_offset %r13, -40
	.cfi_offset %r14, -32
	.cfi_offset %r15, -24
	.cfi_offset %rbp, -16
	vmovd	%edx, %xmm0
	vpbroadcastb	%xmm0, %xmm0
	leaq	48(%rdi), %rcx
	xorl	%eax, %eax
	movl	$255, %r8d
	vpxor	%xmm1, %xmm1, %xmm1
	xorl	%r9d, %r9d
	jmp	.LBB0_4
	.p2align	4, 0x90
.LBB0_5:                                #   in Loop: Header=BB0_4 Depth=1
	xorl	%r12d, %r12d
.LBB0_18:                               #   in Loop: Header=BB0_4 Depth=1
	movzbl	%r12b, %r11d
	addq	%r11, %rax
	addq	%r10, %r9
	cmpq	%rsi, %r9
	jae	.LBB0_19
.LBB0_4:                                # =>This Loop Header: Depth=1
                                        #     Child Loop BB0_12 Depth 2
                                        #     Child Loop BB0_16 Depth 2
                                        #     Child Loop BB0_8 Depth 2
	movq	%rsi, %r10
	subq	%r9, %r10
	cmpq	$255, %r10
	cmovaeq	%r8, %r10
	movq	%rsi, %r15
	subq	%r9, %r15
	je	.LBB0_5
# %bb.6:                                #   in Loop: Header=BB0_4 Depth=1
	leaq	(%rdi,%r9), %r11
	cmpq	$1, %r10
	movq	%r10, %rbx
	adcq	$0, %rbx
	cmpq	$8, %r15
	jae	.LBB0_9
# %bb.7:                                #   in Loop: Header=BB0_4 Depth=1
	xorl	%r14d, %r14d
	xorl	%r12d, %r12d
	jmp	.LBB0_8
	.p2align	4, 0x90
.LBB0_9:                                #   in Loop: Header=BB0_4 Depth=1
	cmpq	$64, %r15
	jae	.LBB0_11
# %bb.10:                               #   in Loop: Header=BB0_4 Depth=1
	xorl	%r12d, %r12d
	xorl	%r14d, %r14d
	jmp	.LBB0_15
.LBB0_11:                               #   in Loop: Header=BB0_4 Depth=1
	movl	%ebx, %r14d
	andl	$192, %r14d
	leaq	(%rcx,%r9), %r12
	vpxor	%xmm2, %xmm2, %xmm2
	xorl	%r13d, %r13d
	vpxor	%xmm3, %xmm3, %xmm3
	vpxor	%xmm4, %xmm4, %xmm4
	vpxor	%xmm5, %xmm5, %xmm5
	.p2align	4, 0x90
.LBB0_12:                               #   Parent Loop BB0_4 Depth=1
                                        # =>  This Inner Loop Header: Depth=2
	vpcmpeqb	-48(%r12,%r13), %xmm0, %xmm6
	vpsubb	%xmm6, %xmm2, %xmm2
	vpcmpeqb	-32(%r12,%r13), %xmm0, %xmm6
	vpsubb	%xmm6, %xmm3, %xmm3
	vpcmpeqb	-16(%r12,%r13), %xmm0, %xmm6
	vpcmpeqb	(%r12,%r13), %xmm0, %xmm7
	vpsubb	%xmm6, %xmm4, %xmm4
	vpsubb	%xmm7, %xmm5, %xmm5
	addq	$64, %r13
	cmpq	%r13, %r14
	jne	.LBB0_12
# %bb.13:                               #   in Loop: Header=BB0_4 Depth=1
	vpaddb	%xmm2, %xmm3, %xmm2
	vpaddb	%xmm4, %xmm5, %xmm3
	vpaddb	%xmm2, %xmm3, %xmm2
	vpshufd	$238, %xmm2, %xmm3              # xmm3 = xmm2[2,3,2,3]
	vpaddb	%xmm3, %xmm2, %xmm2
	vpsadbw	%xmm1, %xmm2, %xmm2
	vmovd	%xmm2, %r12d
	cmpq	%r14, %r15
	je	.LBB0_18
# %bb.14:                               #   in Loop: Header=BB0_4 Depth=1
	testb	$56, %bl
	je	.LBB0_8
.LBB0_15:                               #   in Loop: Header=BB0_4 Depth=1
	movq	%r14, %r13
	movl	%ebx, %r14d
	andl	$248, %r14d
	movzbl	%r12b, %ebp
	vmovd	%ebp, %xmm2
	.p2align	4, 0x90
.LBB0_16:                               #   Parent Loop BB0_4 Depth=1
                                        # =>  This Inner Loop Header: Depth=2
	vmovq	(%r11,%r13), %xmm3              # xmm3 = mem[0],zero
	vpcmpeqb	%xmm0, %xmm3, %xmm3
	vpsubb	%xmm3, %xmm2, %xmm2
	addq	$8, %r13
	cmpq	%r13, %r14
	jne	.LBB0_16
# %bb.17:                               #   in Loop: Header=BB0_4 Depth=1
	vpsadbw	%xmm1, %xmm2, %xmm2
	vmovd	%xmm2, %r12d
	cmpq	%r14, %r15
	je	.LBB0_18
	.p2align	4, 0x90
.LBB0_8:                                #   Parent Loop BB0_4 Depth=1
                                        # =>  This Inner Loop Header: Depth=2
	cmpb	%dl, (%r11,%r14)
	sete	%bpl
	addb	%bpl, %r12b
	incq	%r14
	cmpq	%r14, %rbx
	jne	.LBB0_8
	jmp	.LBB0_18
.LBB0_19:
	popq	%rbx
	.cfi_def_cfa_offset 48
	popq	%r12
	.cfi_def_cfa_offset 40
	popq	%r13
	.cfi_def_cfa_offset 32
	popq	%r14
	.cfi_def_cfa_offset 24
	popq	%r15
	.cfi_def_cfa_offset 16
	popq	%rbp
	.cfi_def_cfa_offset 8
	.cfi_restore %rbx
	.cfi_restore %r12
	.cfi_restore %r13
	.cfi_restore %r14
	.cfi_restore %r15
	.cfi_restore %rbp
	retq
.LBB0_1:
	xorl	%eax, %eax
	retq
.Lfunc_end0:
	.size	count_byte, .Lfunc_end0-count_byte
	.cfi_endproc
                                        # -- End function
	.ident	"Apple clang version 17.0.0 (clang-1700.0.13.5)"
	.section	".note.GNU-stack","",@progbits
	.addrsig
