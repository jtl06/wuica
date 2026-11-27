	.att_syntax
	.file	"rec.c"
	.section	.rodata.cst16,"aM",@progbits,16
	.p2align	4, 0x0                          # -- Begin function rec
.LCPI0_0:
	.quad	0x7fffffffffffffff              # double NaN
	.quad	0x7fffffffffffffff              # double NaN
	.text
	.globl	rec
	.prefalign	4, .Lfunc_end0, nop
	.type	rec,@function
rec:                                    # @rec
# %bb.0:
	testq	%rdx, %rdx
	jle	.LBB0_1
# %bb.2:
	movapd	%xmm0, %xmm1
	cmpq	$1, %rdx
	jne	.LBB0_9
# %bb.3:
	xorpd	%xmm0, %xmm0
	xorl	%eax, %eax
	jmp	.LBB0_5
.LBB0_1:
	xorpd	%xmm0, %xmm0
	jmp	.LBB0_6
.LBB0_9:
	movabsq	$9223372036854775806, %r10      # imm = 0x7FFFFFFFFFFFFFFE
	andq	%rdx, %r10
	xorpd	%xmm0, %xmm0
	xorl	%eax, %eax
	movapd	.LCPI0_0(%rip), %xmm2           # xmm2 = [NaN,NaN]
	.p2align	4
.LBB0_10:                               # =>This Inner Loop Header: Depth=1
	movsd	(%rdi,%rax,8), %xmm3            # xmm3 = mem[0],zero
	movsd	8(%rdi,%rax,8), %xmm4           # xmm4 = mem[0],zero
	andpd	%xmm2, %xmm3
	mulsd	%xmm1, %xmm0
	addsd	%xmm3, %xmm0
	xorps	%xmm3, %xmm3
	cvtsi2sdl	(%rsi,%rax,4), %xmm3
	subsd	%xmm3, %xmm0
	andpd	%xmm2, %xmm4
	mulsd	%xmm1, %xmm0
	xorps	%xmm3, %xmm3
	cvtsi2sdl	4(%rsi,%rax,4), %xmm3
	addsd	%xmm4, %xmm0
	subsd	%xmm3, %xmm0
	addq	$2, %rax
	cmpq	%rax, %r10
	jne	.LBB0_10
# %bb.4:
	testb	$1, %dl
	je	.LBB0_6
.LBB0_5:
	movsd	(%rdi,%rax,8), %xmm2            # xmm2 = mem[0],zero
	andpd	.LCPI0_0(%rip), %xmm2
	mulsd	%xmm0, %xmm1
	addsd	%xmm2, %xmm1
	xorps	%xmm0, %xmm0
	cvtsi2sdl	(%rsi,%rax,4), %xmm0
	subsd	%xmm0, %xmm1
	movapd	%xmm1, %xmm0
.LBB0_6:
	movabsq	$-3750763034362895579, %rsi     # imm = 0xCBF29CE484222325
	testq	%r8, %r8
	jle	.LBB0_13
# %bb.7:
	movabsq	$1099511628211, %rax            # imm = 0x100000001B3
	cmpq	$1, %r8
	jne	.LBB0_14
# %bb.8:
	xorl	%edx, %edx
	jmp	.LBB0_12
.LBB0_14:
	movabsq	$9223372036854775806, %rdi      # imm = 0x7FFFFFFFFFFFFFFE
	andq	%r8, %rdi
	xorl	%edx, %edx
	xorl	%r10d, %r10d
	.p2align	4
.LBB0_15:                               # =>This Inner Loop Header: Depth=1
	movzbl	(%rcx,%rdx), %r11d
	xorq	%rsi, %r11
	imulq	%rax, %r11
	movq	%r11, %rsi
	shrq	$29, %rsi
	xorq	%r11, %rsi
	addq	%r10, %rsi
	rolq	$7, %rsi
	movzbl	1(%rcx,%rdx), %r11d
	xorq	%rsi, %r11
	imulq	%rax, %r11
	movq	%r11, %rsi
	shrq	$29, %rsi
	xorq	%r11, %rsi
	addq	%r10, %rsi
	addq	$31, %rsi
	rolq	$7, %rsi
	addq	$2, %rdx
	addq	$62, %r10
	cmpq	%rdx, %rdi
	jne	.LBB0_15
# %bb.11:
	testb	$1, %r8b
	je	.LBB0_13
.LBB0_12:
	movzbl	(%rcx,%rdx), %ecx
	xorq	%rsi, %rcx
	imulq	%rax, %rcx
	movq	%rcx, %rax
	shrq	$29, %rax
	xorq	%rcx, %rax
	movq	%rdx, %rsi
	shlq	$5, %rsi
	subq	%rdx, %rsi
	addq	%rax, %rsi
	rolq	$7, %rsi
.LBB0_13:
	movq	%rsi, (%r9)
	retq
.Lfunc_end0:
	.size	rec, .Lfunc_end0-rec
                                        # -- End function
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
