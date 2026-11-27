	.att_syntax
	.file	"idct.c"
	.text
	.globl	block                           # -- Begin function block
	.prefalign	4, .Lfunc_end0, nop
	.type	block,@function
block:                                  # @block
# %bb.0:
	pushq	%rbp
	pushq	%r15
	pushq	%r14
	pushq	%rbx
	subq	$136, %rsp
	vxorps	%xmm0, %xmm0, %xmm0
	vmovups	%ymm0, 96(%rsp)
	vmovups	%ymm0, 64(%rsp)
	vmovups	%ymm0, 32(%rsp)
	vmovups	%ymm0, (%rsp)
	vmovups	%ymm0, -32(%rsp)
	vmovups	%ymm0, -64(%rsp)
	vmovups	%ymm0, -96(%rsp)
	vmovups	%ymm0, -128(%rsp)
	testl	%edx, %edx
	jle	.LBB0_8
# %bb.1:
	movl	%edx, %r8d
	movl	%r8d, %eax
	andl	$7, %eax
	cmpl	$8, %edx
	jae	.LBB0_3
# %bb.2:
	xorl	%ecx, %ecx
	jmp	.LBB0_6
.LBB0_3:
	andl	$2147483640, %r8d               # imm = 0x7FFFFFF8
	xorl	%ecx, %ecx
	movq	zz@GOTPCREL(%rip), %rdx
	.p2align	4
.LBB0_4:                                # =>This Inner Loop Header: Depth=1
	movswl	(%rsi,%rcx,2), %r9d
	movzbl	(%rdx,%rcx), %r10d
	movl	%r9d, -128(%rsp,%r10,4)
	movswl	2(%rsi,%rcx,2), %r9d
	movzbl	1(%rdx,%rcx), %r10d
	movl	%r9d, -128(%rsp,%r10,4)
	movswl	4(%rsi,%rcx,2), %r9d
	movzbl	2(%rdx,%rcx), %r10d
	movl	%r9d, -128(%rsp,%r10,4)
	movswl	6(%rsi,%rcx,2), %r9d
	movzbl	3(%rdx,%rcx), %r10d
	movl	%r9d, -128(%rsp,%r10,4)
	movswl	8(%rsi,%rcx,2), %r9d
	movzbl	4(%rdx,%rcx), %r10d
	movl	%r9d, -128(%rsp,%r10,4)
	movswl	10(%rsi,%rcx,2), %r9d
	movzbl	5(%rdx,%rcx), %r10d
	movl	%r9d, -128(%rsp,%r10,4)
	movswl	12(%rsi,%rcx,2), %r9d
	movzbl	6(%rdx,%rcx), %r10d
	movl	%r9d, -128(%rsp,%r10,4)
	movswl	14(%rsi,%rcx,2), %r9d
	movzbl	7(%rdx,%rcx), %r10d
	movl	%r9d, -128(%rsp,%r10,4)
	addq	$8, %rcx
	cmpq	%rcx, %r8
	jne	.LBB0_4
# %bb.5:
	testq	%rax, %rax
	je	.LBB0_8
.LBB0_6:
	leaq	(%rsi,%rcx,2), %rdx
	addq	zz@GOTPCREL(%rip), %rcx
	xorl	%esi, %esi
	.p2align	4
.LBB0_7:                                # =>This Inner Loop Header: Depth=1
	movswl	(%rdx,%rsi,2), %r8d
	movzbl	(%rcx,%rsi), %r9d
	movl	%r8d, -128(%rsp,%r9,4)
	incq	%rsi
	cmpq	%rsi, %rax
	jne	.LBB0_7
.LBB0_8:
	xorl	%eax, %eax
	.p2align	4
.LBB0_9:                                # =>This Inner Loop Header: Depth=1
	movl	-100(%rsp,%rax), %esi
	movl	-128(%rsp,%rax), %ecx
	movl	-124(%rsp,%rax), %edx
	leal	(%rsi,%rcx), %r9d
	subl	%esi, %ecx
	movl	-104(%rsp,%rax), %esi
	leal	(%rsi,%rdx), %r10d
	subl	%esi, %edx
	movl	-120(%rsp,%rax), %esi
	movl	-108(%rsp,%rax), %r8d
	leal	(%r8,%rsi), %r11d
	subl	%r8d, %esi
	movl	-116(%rsp,%rax), %r8d
	movl	-112(%rsp,%rax), %ebx
	leal	(%rbx,%r8), %r14d
	subl	%ebx, %r8d
	leal	(%r14,%r9), %ebx
	leal	(%r11,%r10), %r15d
	leal	(%r15,%rbx), %ebp
	movl	%ebp, -128(%rsp,%rax)
	subl	%r15d, %ebx
	movl	%ebx, -112(%rsp,%rax)
	subl	%r14d, %r9d
	leal	(%r9,%r9,2), %ebx
	subl	%r11d, %r10d
	addl	%r10d, %ebx
	movl	%ebx, -120(%rsp,%rax)
	leal	(%r10,%r10,2), %r10d
	subl	%r10d, %r9d
	movl	%r9d, -104(%rsp,%rax)
	leal	(%rcx,%rcx,4), %r9d
	leal	(%r9,%rdx,4), %r9d
	leal	(%rsi,%rsi,2), %r10d
	addl	%r8d, %r10d
	addl	%r9d, %r10d
	movl	%r10d, -124(%rsp,%rax)
	leal	(,%rcx,4), %r9d
	leal	(%rsi,%rsi,4), %r10d
	subl	%r10d, %r9d
	subl	%edx, %r9d
	leal	(%r8,%r8,2), %r10d
	subl	%r10d, %r9d
	movl	%r9d, -116(%rsp,%rax)
	leal	(%rcx,%rcx,2), %r9d
	leal	(%rdx,%rdx,4), %r10d
	subl	%r10d, %r9d
	addl	%esi, %r9d
	leal	(%r9,%r8,4), %r9d
	movl	%r9d, -108(%rsp,%rax)
	leal	(%rdx,%rdx,2), %edx
	subl	%edx, %ecx
	leal	(%rcx,%rsi,4), %ecx
	leal	(%r8,%r8,4), %edx
	subl	%edx, %ecx
	movl	%ecx, -100(%rsp,%rax)
	addq	$32, %rax
	cmpq	$256, %rax                      # imm = 0x100
	jne	.LBB0_9
# %bb.10:
	movq	$-8, %rax
	.p2align	4
.LBB0_11:                               # =>This Inner Loop Header: Depth=1
	movl	128(%rsp,%rax,4), %esi
	movl	-96(%rsp,%rax,4), %ecx
	movl	-64(%rsp,%rax,4), %edx
	leal	(%rsi,%rcx), %r9d
	subl	%esi, %ecx
	movl	96(%rsp,%rax,4), %esi
	leal	(%rsi,%rdx), %r10d
	subl	%esi, %edx
	movl	-32(%rsp,%rax,4), %esi
	movl	64(%rsp,%rax,4), %r8d
	leal	(%r8,%rsi), %r11d
	subl	%r8d, %esi
	movl	(%rsp,%rax,4), %r8d
	movl	32(%rsp,%rax,4), %ebx
	leal	(%rbx,%r8), %r14d
	subl	%ebx, %r8d
	leal	(%r14,%r9), %ebx
	leal	(%r11,%r10), %r15d
	leal	(%r15,%rbx), %ebp
	shrl	$6, %ebp
	movw	%bp, 16(%rdi,%rax,2)
	subl	%r15d, %ebx
	shrl	$6, %ebx
	movw	%bx, 80(%rdi,%rax,2)
	subl	%r14d, %r9d
	leal	(%r9,%r9,2), %ebx
	subl	%r11d, %r10d
	addl	%r10d, %ebx
	shrl	$6, %ebx
	movw	%bx, 48(%rdi,%rax,2)
	imull	$4194301, %r10d, %r10d          # imm = 0x3FFFFD
	addl	%r9d, %r10d
	shrl	$6, %r10d
	movw	%r10w, 112(%rdi,%rax,2)
	leal	(%rcx,%rcx,4), %r9d
	leal	(%r9,%rdx,4), %r9d
	leal	(%rsi,%rsi,2), %r10d
	addl	%r8d, %r10d
	addl	%r9d, %r10d
	shrl	$6, %r10d
	movw	%r10w, 32(%rdi,%rax,2)
	imull	$4194299, %esi, %r9d            # imm = 0x3FFFFB
	leal	(%r9,%rcx,4), %r9d
	subl	%edx, %r9d
	imull	$4194301, %r8d, %r10d           # imm = 0x3FFFFD
	addl	%r9d, %r10d
	shrl	$6, %r10d
	movw	%r10w, 64(%rdi,%rax,2)
	leal	(%rcx,%rcx,2), %r9d
	imull	$4194299, %edx, %r10d           # imm = 0x3FFFFB
	addl	%esi, %r9d
	addl	%r10d, %r9d
	leal	(%r9,%r8,4), %r9d
	shrl	$6, %r9d
	movw	%r9w, 96(%rdi,%rax,2)
	imull	$4194301, %edx, %edx            # imm = 0x3FFFFD
	addl	%ecx, %edx
	leal	(%rdx,%rsi,4), %ecx
	imull	$4194299, %r8d, %edx            # imm = 0x3FFFFB
	addl	%ecx, %edx
	shrl	$6, %edx
	movw	%dx, 128(%rdi,%rax,2)
	incq	%rax
	jne	.LBB0_11
# %bb.12:
	addq	$136, %rsp
	popq	%rbx
	popq	%r14
	popq	%r15
	popq	%rbp
	vzeroupper
	retq
.Lfunc_end0:
	.size	block, .Lfunc_end0-block
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
