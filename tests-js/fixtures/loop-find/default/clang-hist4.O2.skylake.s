	.att_syntax
	.file	"hist4.c"
	.text
	.globl	hist                            # -- Begin function hist
	.prefalign	4, .Lfunc_end0, nop
	.type	hist,@function
hist:                                   # @hist
# %bb.0:
	pushq	%r15
	pushq	%r14
	pushq	%r12
	pushq	%rbx
	subq	$4104, %rsp                     # imm = 0x1008
	movq	%rdx, %rbx
	movq	%rsi, %r14
	movq	%rdi, %r15
	movq	%rsp, %rdi
	xorl	%r12d, %r12d
	movl	$1024, %edx                     # imm = 0x400
	xorl	%esi, %esi
	callq	memset@PLT
	leaq	3072(%rsp), %rdi
	movl	$1024, %edx                     # imm = 0x400
	xorl	%esi, %esi
	callq	memset@PLT
	leaq	2048(%rsp), %rdi
	movl	$1024, %edx                     # imm = 0x400
	xorl	%esi, %esi
	callq	memset@PLT
	leaq	1024(%rsp), %rdi
	movl	$1024, %edx                     # imm = 0x400
	xorl	%esi, %esi
	callq	memset@PLT
	cmpq	$4, %r14
	jb	.LBB0_3
# %bb.1:
	xorl	%eax, %eax
	.p2align	4
.LBB0_2:                                # =>This Inner Loop Header: Depth=1
	movzbl	(%r15,%rax), %ecx
	incl	(%rsp,%rcx,4)
	movzbl	1(%r15,%rax), %ecx
	incl	3072(%rsp,%rcx,4)
	movzbl	2(%r15,%rax), %ecx
	incl	2048(%rsp,%rcx,4)
	movzbl	3(%r15,%rax), %ecx
	incl	1024(%rsp,%rcx,4)
	leaq	4(%rax), %r12
	addq	$8, %rax
	cmpq	%r14, %rax
	movq	%r12, %rax
	jbe	.LBB0_2
.LBB0_3:
	movq	%r12, %rax
	subq	%r14, %rax
	jae	.LBB0_8
# %bb.4:
	movl	%r14d, %ecx
	subl	%r12d, %ecx
	andl	$7, %ecx
	je	.LBB0_6
	.p2align	4
.LBB0_5:                                # =>This Inner Loop Header: Depth=1
	movzbl	(%r15,%r12), %edx
	incl	(%rsp,%rdx,4)
	incq	%r12
	decq	%rcx
	jne	.LBB0_5
.LBB0_6:
	cmpq	$-8, %rax
	ja	.LBB0_8
	.p2align	4
.LBB0_7:                                # =>This Inner Loop Header: Depth=1
	movzbl	(%r15,%r12), %eax
	incl	(%rsp,%rax,4)
	movzbl	1(%r15,%r12), %eax
	incl	(%rsp,%rax,4)
	movzbl	2(%r15,%r12), %eax
	incl	(%rsp,%rax,4)
	movzbl	3(%r15,%r12), %eax
	incl	(%rsp,%rax,4)
	movzbl	4(%r15,%r12), %eax
	incl	(%rsp,%rax,4)
	movzbl	5(%r15,%r12), %eax
	incl	(%rsp,%rax,4)
	movzbl	6(%r15,%r12), %eax
	incl	(%rsp,%rax,4)
	movzbl	7(%r15,%r12), %eax
	incl	(%rsp,%rax,4)
	addq	$8, %r12
	cmpq	%r12, %r14
	jne	.LBB0_7
.LBB0_8:
	xorl	%eax, %eax
	.p2align	4
.LBB0_9:                                # =>This Inner Loop Header: Depth=1
	vmovdqu	3072(%rsp,%rax), %ymm0
	vmovdqu	3104(%rsp,%rax), %ymm1
	vmovdqu	3136(%rsp,%rax), %ymm2
	vmovdqu	3168(%rsp,%rax), %ymm3
	vpaddd	(%rsp,%rax), %ymm0, %ymm0
	vpaddd	32(%rsp,%rax), %ymm1, %ymm1
	vpaddd	64(%rsp,%rax), %ymm2, %ymm2
	vpaddd	96(%rsp,%rax), %ymm3, %ymm3
	vpaddd	2048(%rsp,%rax), %ymm0, %ymm0
	vpaddd	2080(%rsp,%rax), %ymm1, %ymm1
	vpaddd	2112(%rsp,%rax), %ymm2, %ymm2
	vpaddd	2144(%rsp,%rax), %ymm3, %ymm3
	vpaddd	1024(%rsp,%rax), %ymm0, %ymm0
	vpaddd	1056(%rsp,%rax), %ymm1, %ymm1
	vpaddd	1088(%rsp,%rax), %ymm2, %ymm2
	vpaddd	1120(%rsp,%rax), %ymm3, %ymm3
	vpaddd	(%rbx,%rax), %ymm0, %ymm0
	vpaddd	32(%rbx,%rax), %ymm1, %ymm1
	vpaddd	64(%rbx,%rax), %ymm2, %ymm2
	vpaddd	96(%rbx,%rax), %ymm3, %ymm3
	vmovdqu	%ymm0, (%rbx,%rax)
	vmovdqu	%ymm1, 32(%rbx,%rax)
	vmovdqu	%ymm2, 64(%rbx,%rax)
	vmovdqu	%ymm3, 96(%rbx,%rax)
	subq	$-128, %rax
	cmpq	$1024, %rax                     # imm = 0x400
	jne	.LBB0_9
# %bb.10:
	addq	$4104, %rsp                     # imm = 0x1008
	popq	%rbx
	popq	%r12
	popq	%r14
	popq	%r15
	vzeroupper
	retq
.Lfunc_end0:
	.size	hist, .Lfunc_end0-hist
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
