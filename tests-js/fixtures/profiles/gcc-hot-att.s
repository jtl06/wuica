	.file	"hot.c"
	.text
.Ltext0:
	.file 0 "." "hot.c"
	.p2align 4
	.globl	matvec
	.type	matvec, @function
matvec:
.LVL0:
.LFB39:
	.file 1 "hot.c"
	.loc 1 6 106 view -0
	.cfi_startproc
	.loc 1 6 106 is_stmt 0 view .LVU1
	endbr64
	.loc 1 7 3 is_stmt 1 view .LVU2
	.loc 1 8 3 view .LVU3
.LBB9:
	.loc 1 8 8 view .LVU4
.LVL1:
	.loc 1 8 22 discriminator 1 view .LVU5
	testq	%rcx, %rcx
	jle	.L2
	leaq	(%rdx,%rcx,4), %r9
.LVL2:
.LBB10:
.LBB11:
	.loc 1 10 24 discriminator 1 view .LVU6
	testq	%r8, %r8
	jle	.L3
	movq	%r8, %rcx
.LVL3:
	.loc 1 10 24 is_stmt 0 discriminator 1 view .LVU7
	leaq	0(,%r8,4), %r11
	pxor	%xmm3, %xmm3
	shrq	$2, %rcx
	leaq	-1(%r8), %r10
	salq	$4, %rcx
.LVL4:
	.p2align 4
	.p2align 3
.L8:
	.loc 1 10 24 discriminator 1 view .LVU8
	xorl	%eax, %eax
.LBE11:
	.loc 1 9 11 view .LVU9
	pxor	%xmm1, %xmm1
	cmpq	$2, %r10
	jbe	.L7
	.p2align 6
	.p2align 4
	.p2align 3
.L5:
.LVL5:
.LBB12:
	.loc 1 11 7 is_stmt 1 view .LVU10
	.loc 1 11 28 is_stmt 0 view .LVU11
	movups	(%rdi,%rax), %xmm0
	movups	(%rsi,%rax), %xmm4
	addq	$16, %rax
	mulps	%xmm4, %xmm0
	addss	%xmm0, %xmm1
.LVL6:
	.loc 1 11 28 view .LVU12
	movaps	%xmm0, %xmm2
	shufps	$85, %xmm0, %xmm2
	addss	%xmm2, %xmm1
	movaps	%xmm0, %xmm2
	unpckhps	%xmm0, %xmm2
	.loc 1 11 9 view .LVU13
	shufps	$255, %xmm0, %xmm0
	addss	%xmm2, %xmm1
	addss	%xmm0, %xmm1
	.loc 1 10 33 is_stmt 1 discriminator 3 view .LVU14
.LVL7:
	.loc 1 10 24 discriminator 1 view .LVU15
	cmpq	%rcx, %rax
	jne	.L5
	testb	$3, %r8b
	je	.L6
	movq	%r8, %rax
	andq	$-4, %rax
.LVL8:
.L7:
	.loc 1 11 7 view .LVU16
	.loc 1 11 28 is_stmt 0 view .LVU17
	movss	(%rsi,%rax,4), %xmm0
	mulss	(%rdi,%rax,4), %xmm0
	.loc 1 10 33 discriminator 3 view .LVU18
	addq	$1, %rax
.LVL9:
	.loc 1 11 9 view .LVU19
	addss	%xmm0, %xmm1
.LVL10:
	.loc 1 10 33 is_stmt 1 discriminator 3 view .LVU20
	.loc 1 10 24 discriminator 1 view .LVU21
	cmpq	%r8, %rax
	jl	.L7
.LVL11:
.L6:
	.loc 1 10 24 is_stmt 0 discriminator 1 view .LVU22
.LBE12:
	.loc 1 12 5 is_stmt 1 view .LVU23
	.loc 1 12 12 is_stmt 0 view .LVU24
	movss	%xmm1, (%rdx)
	.loc 1 13 5 is_stmt 1 view .LVU25
.LBE10:
	.loc 1 8 22 is_stmt 0 discriminator 1 view .LVU26
	addq	$4, %rdx
.LBB14:
	.loc 1 13 11 view .LVU27
	addss	%xmm1, %xmm3
.LBE14:
	.loc 1 8 31 is_stmt 1 discriminator 2 view .LVU28
.LVL12:
	.loc 1 8 22 discriminator 1 view .LVU29
	addq	%r11, %rdi
	cmpq	%r9, %rdx
	jne	.L8
	.loc 1 8 22 is_stmt 0 discriminator 1 view .LVU30
.LBE9:
	.loc 1 16 1 view .LVU31
	movaps	%xmm3, %xmm0
	ret
.LVL13:
	.loc 1 16 1 view .LVU32
	.p2align 5
	.p2align 4,,10
	.p2align 3
.L3:
.LVL14:
.LBB19:
.LBB15:
	.loc 1 12 5 is_stmt 1 view .LVU33
.LBE15:
	.loc 1 8 22 is_stmt 0 discriminator 1 view .LVU34
	leaq	4(%rdx), %rax
.LBB16:
	.loc 1 12 12 view .LVU35
	movl	$0x00000000, (%rdx)
	.loc 1 13 5 is_stmt 1 view .LVU36
.LBE16:
	.loc 1 8 31 discriminator 2 view .LVU37
.LVL15:
	.loc 1 8 22 discriminator 1 view .LVU38
	cmpq	%r9, %rax
	je	.L2
.LVL16:
.LBB17:
.LBB13:
	.loc 1 10 24 discriminator 1 view .LVU39
.LBE13:
	.loc 1 12 5 view .LVU40
	.loc 1 12 12 is_stmt 0 view .LVU41
	movl	$0x00000000, 4(%rdx)
	.loc 1 13 5 is_stmt 1 view .LVU42
.LBE17:
	.loc 1 8 31 discriminator 2 view .LVU43
	.loc 1 8 22 discriminator 1 view .LVU44
	addq	$8, %rdx
	cmpq	%rdx, %r9
	jne	.L3
.LVL17:
.L2:
.LBB18:
	.loc 1 13 11 is_stmt 0 view .LVU45
	pxor	%xmm3, %xmm3
.LBE18:
.LBE19:
	.loc 1 15 3 is_stmt 1 view .LVU46
	.loc 1 16 1 is_stmt 0 view .LVU47
	movaps	%xmm3, %xmm0
	ret
	.cfi_endproc
.LFE39:
	.size	matvec, .-matvec
	.p2align 4
	.globl	count
	.type	count, @function
count:
.LVL18:
.LFB40:
	.loc 1 18 70 is_stmt 1 view -0
	.cfi_startproc
	.loc 1 18 70 is_stmt 0 view .LVU49
	endbr64
	.loc 1 19 3 is_stmt 1 view .LVU50
	.loc 1 20 3 view .LVU51
.LBB20:
	.loc 1 20 8 view .LVU52
.LVL19:
	.loc 1 20 22 discriminator 1 view .LVU53
	testq	%rsi, %rsi
	jle	.L27
	leaq	-1(%rsi), %rax
	cmpq	$14, %rax
	jbe	.L28
	movq	%rsi, %rdx
	pxor	%xmm4, %xmm4
	pcmpeqd	%xmm0, %xmm0
	movq	%rdi, %rax
	movdqa	%xmm4, %xmm5
	pxor	%xmm3, %xmm3
	.loc 1 21 7 is_stmt 0 view .LVU54
	pxor	%xmm2, %xmm2
	andq	$-16, %rdx
	leaq	(%rdi,%rdx), %rcx
	.loc 1 20 22 discriminator 1 view .LVU55
	pxor	%xmm9, %xmm9
	psubb	%xmm0, %xmm5
.LVL20:
	.p2align 4
	.p2align 3
.L23:
	.loc 1 21 5 is_stmt 1 view .LVU56
	.loc 1 21 11 is_stmt 0 view .LVU57
	movdqu	(%rax), %xmm1
	addq	$16, %rax
	psrlw	$7, %xmm1
	pand	%xmm5, %xmm1
	movdqa	%xmm1, %xmm6
	punpckhbw	%xmm4, %xmm1
	punpcklbw	%xmm4, %xmm6
	movdqa	%xmm1, %xmm7
	punpckhwd	%xmm3, %xmm1
	movdqa	%xmm6, %xmm8
	punpckhwd	%xmm3, %xmm6
	punpcklwd	%xmm3, %xmm7
	punpcklwd	%xmm3, %xmm8
	.loc 1 21 7 view .LVU58
	movdqa	%xmm8, %xmm0
	punpckhdq	%xmm2, %xmm8
	punpckldq	%xmm2, %xmm0
	paddq	%xmm9, %xmm0
	paddq	%xmm8, %xmm0
	movdqa	%xmm6, %xmm8
	punpckhdq	%xmm2, %xmm6
	punpckldq	%xmm2, %xmm8
	paddq	%xmm8, %xmm0
	paddq	%xmm6, %xmm0
	movdqa	%xmm7, %xmm6
	punpckhdq	%xmm2, %xmm7
	punpckldq	%xmm2, %xmm6
	paddq	%xmm6, %xmm0
	movdqa	%xmm1, %xmm6
	punpckhdq	%xmm2, %xmm1
	paddq	%xmm7, %xmm0
	punpckldq	%xmm2, %xmm6
	paddq	%xmm6, %xmm0
	paddq	%xmm1, %xmm0
	movdqa	%xmm0, %xmm9
	.loc 1 20 28 is_stmt 1 discriminator 3 view .LVU59
	.loc 1 20 22 discriminator 1 view .LVU60
	cmpq	%rcx, %rax
	jne	.L23
	psrldq	$8, %xmm0
	paddq	%xmm0, %xmm9
	movq	%xmm9, %rax
	cmpq	%rsi, %rdx
	je	.L20
	.loc 1 20 22 is_stmt 0 discriminator 1 view .LVU61
	.p2align 5
	.p2align 4
	.p2align 3
.L26:
.LVL21:
	.loc 1 21 5 is_stmt 1 view .LVU62
	.loc 1 21 15 is_stmt 0 view .LVU63
	movsbq	(%rdi,%rdx), %rcx
	.loc 1 20 28 discriminator 3 view .LVU64
	addq	$1, %rdx
.LVL22:
	.loc 1 21 15 view .LVU65
	shrq	$63, %rcx
	.loc 1 21 7 view .LVU66
	addq	%rcx, %rax
.LVL23:
	.loc 1 20 28 is_stmt 1 discriminator 3 view .LVU67
	.loc 1 20 22 discriminator 1 view .LVU68
	cmpq	%rdx, %rsi
	jg	.L26
	ret
.LVL24:
	.p2align 4,,10
	.p2align 3
.L27:
	.loc 1 20 22 is_stmt 0 discriminator 1 view .LVU69
.LBE20:
	.loc 1 19 8 view .LVU70
	xorl	%eax, %eax
	.loc 1 22 3 is_stmt 1 view .LVU71
.LVL25:
.L20:
	.loc 1 23 1 is_stmt 0 view .LVU72
	ret
.LVL26:
.L28:
.LBB21:
	.loc 1 20 13 view .LVU73
	xorl	%edx, %edx
.LBE21:
	.loc 1 19 8 view .LVU74
	xorl	%eax, %eax
	jmp	.L26
	.cfi_endproc
.LFE40:
	.size	count, .-count
	.section	.rodata.str1.1,"aMS",@progbits,1
.LC3:
	.string	"%f %ld\n"
	.section	.text.startup,"ax",@progbits
	.p2align 4
	.globl	main
	.type	main, @function
main:
.LVL27:
.LFB41:
	.loc 1 25 33 is_stmt 1 view -0
	.cfi_startproc
	.loc 1 25 33 is_stmt 0 view .LVU76
	endbr64
	.loc 1 26 3 is_stmt 1 view .LVU77
.LVL28:
	.loc 1 25 33 is_stmt 0 view .LVU78
	pushq	%r15
	.cfi_def_cfa_offset 16
	.cfi_offset 15, -16
	pushq	%r14
	.cfi_def_cfa_offset 24
	.cfi_offset 14, -24
	pushq	%r13
	.cfi_def_cfa_offset 32
	.cfi_offset 13, -32
	pushq	%r12
	.cfi_def_cfa_offset 40
	.cfi_offset 12, -40
	pushq	%rbp
	.cfi_def_cfa_offset 48
	.cfi_offset 6, -48
	pushq	%rbx
	.cfi_def_cfa_offset 56
	.cfi_offset 3, -56
	movl	$200, %ebx
	subq	$24, %rsp
	.cfi_def_cfa_offset 80
	.loc 1 26 65 view .LVU79
	cmpl	$1, %edi
	jle	.L32
.LVL29:
.LBB22:
.LBI22:
	.file 2 "/usr/include/stdlib.h"
	.loc 2 490 1 is_stmt 1 view .LVU80
.LBB23:
	.loc 2 492 3 view .LVU81
	.loc 2 492 10 is_stmt 0 view .LVU82
	movq	8(%rsi), %rdi
.LVL30:
	.loc 2 492 10 view .LVU83
	movl	$10, %edx
	xorl	%esi, %esi
.LVL31:
	.loc 2 492 10 view .LVU84
	call	__isoc23_strtol@PLT
.LVL32:
	.loc 2 492 10 view .LVU85
	movq	%rax, %rbx
.LVL33:
.L32:
	.loc 2 492 10 view .LVU86
.LBE23:
.LBE22:
	.loc 1 27 3 is_stmt 1 view .LVU87
	.loc 1 27 14 is_stmt 0 view .LVU88
	movl	$4194304, %edi
	call	malloc@PLT
.LVL34:
	.loc 1 27 56 discriminator 1 view .LVU89
	movl	$16384, %edi
	.loc 1 27 14 view .LVU90
	movq	%rax, %r12
.LVL35:
	.loc 1 27 56 discriminator 1 view .LVU91
	call	malloc@PLT
.LVL36:
	.loc 1 27 93 discriminator 2 view .LVU92
	movl	$1024, %edi
	.loc 1 27 56 discriminator 1 view .LVU93
	movq	%rax, %r13
.LVL37:
	.loc 1 27 93 discriminator 2 view .LVU94
	call	malloc@PLT
.LVL38:
	.loc 1 28 22 view .LVU95
	movl	$1048576, %edi
	.loc 1 27 93 discriminator 2 view .LVU96
	movq	%rax, 8(%rsp)
.LVL39:
	.loc 1 28 3 is_stmt 1 view .LVU97
	.loc 1 28 22 is_stmt 0 view .LVU98
	call	malloc@PLT
.LVL40:
	.loc 1 28 22 view .LVU99
	xorl	%esi, %esi
.LBB24:
	.loc 1 29 13 view .LVU100
	xorl	%ecx, %ecx
	.loc 1 29 61 discriminator 3 view .LVU101
	movabsq	$5270498306774157605, %rdi
.LBE24:
	.loc 1 28 22 view .LVU102
	movq	%rax, %r14
.LVL41:
	.loc 1 29 3 is_stmt 1 view .LVU103
.LBB25:
	.loc 1 29 8 view .LVU104
	.loc 1 29 22 discriminator 1 view .LVU105
	.p2align 4
	.p2align 3
.L33:
	.loc 1 29 44 discriminator 3 view .LVU106
	.loc 1 29 61 is_stmt 0 discriminator 3 view .LVU107
	movq	%rcx, %rax
	.loc 1 29 51 discriminator 3 view .LVU108
	pxor	%xmm0, %xmm0
	.loc 1 29 72 discriminator 3 view .LVU109
	movb	%sil, (%r14,%rcx)
	.loc 1 29 22 discriminator 1 view .LVU110
	addl	$37, %esi
	.loc 1 29 61 discriminator 3 view .LVU111
	imulq	%rdi
	movq	%rcx, %rax
	sarq	$63, %rax
	sarq	%rdx
	subq	%rax, %rdx
	leaq	0(,%rdx,8), %rax
	subq	%rdx, %rax
	movq	%rcx, %rdx
	subq	%rax, %rdx
	.loc 1 29 51 discriminator 3 view .LVU112
	cvtsi2ssq	%rdx, %xmm0
	movss	%xmm0, (%r12,%rcx,4)
	.loc 1 29 67 is_stmt 1 discriminator 3 view .LVU113
	.loc 1 29 38 discriminator 3 view .LVU114
	addq	$1, %rcx
.LVL42:
	.loc 1 29 22 discriminator 1 view .LVU115
	cmpq	$1048576, %rcx
	jne	.L33
.LBE25:
.LBB26:
	.loc 1 30 52 is_stmt 0 discriminator 3 view .LVU116
	movabsq	$-3689348814741910323, %rsi
	.loc 1 30 13 view .LVU117
	xorl	%ecx, %ecx
.LVL43:
	.loc 1 30 13 view .LVU118
	.p2align 6
	.p2align 4
	.p2align 3
.L34:
.LVL44:
	.loc 1 30 35 is_stmt 1 discriminator 3 view .LVU119
	.loc 1 30 52 is_stmt 0 discriminator 3 view .LVU120
	movq	%rcx, %rax
	.loc 1 30 42 discriminator 3 view .LVU121
	pxor	%xmm0, %xmm0
	.loc 1 30 52 discriminator 3 view .LVU122
	mulq	%rsi
	movq	%rdx, %rax
	andq	$-4, %rdx
	shrq	$2, %rax
	addq	%rax, %rdx
	movq	%rcx, %rax
	subq	%rdx, %rax
	.loc 1 30 42 discriminator 3 view .LVU123
	cvtsi2ssq	%rax, %xmm0
	movss	%xmm0, 0(%r13,%rcx,4)
	.loc 1 30 31 is_stmt 1 discriminator 3 view .LVU124
	addq	$1, %rcx
.LVL45:
	.loc 1 30 22 discriminator 1 view .LVU125
	cmpq	$4096, %rcx
	jne	.L34
.LVL46:
	.loc 1 30 22 is_stmt 0 discriminator 1 view .LVU126
.LBE26:
.LBB27:
	.loc 1 33 22 is_stmt 1 discriminator 4 view .LVU127
	testq	%rbx, %rbx
	jle	.L38
	.loc 1 33 13 is_stmt 0 view .LVU128
	xorl	%ebp, %ebp
.LBE27:
	.loc 1 32 8 view .LVU129
	xorl	%r15d, %r15d
	.loc 1 31 10 view .LVU130
	pxor	%xmm10, %xmm10
.LVL47:
	.p2align 4
	.p2align 3
.L36:
.LBB28:
	.loc 1 33 37 is_stmt 1 discriminator 5 view .LVU131
	.loc 1 33 42 is_stmt 0 discriminator 5 view .LVU132
	movq	8(%rsp), %rdx
	movl	$256, %ecx
	movq	%r13, %rsi
	movq	%r12, %rdi
	movl	$4096, %r8d
	.loc 1 33 31 discriminator 5 view .LVU133
	addq	$1, %rbp
.LVL48:
	.loc 1 33 42 discriminator 5 view .LVU134
	call	matvec
.LVL49:
	.loc 1 33 78 discriminator 5 view .LVU135
	movl	$262144, %esi
	movq	%r14, %rdi
	.loc 1 33 42 discriminator 5 view .LVU136
	cvtss2sd	%xmm0, %xmm0
	.loc 1 33 39 discriminator 5 view .LVU137
	addsd	%xmm0, %xmm10
.LVL50:
	.loc 1 33 73 is_stmt 1 discriminator 5 view .LVU138
	.loc 1 33 78 is_stmt 0 discriminator 5 view .LVU139
	call	count
.LVL51:
	.loc 1 33 75 discriminator 5 view .LVU140
	addq	%rax, %r15
.LVL52:
	.loc 1 33 31 is_stmt 1 discriminator 5 view .LVU141
	.loc 1 33 22 discriminator 4 view .LVU142
	cmpq	%rbp, %rbx
	jne	.L36
.LVL53:
.L35:
	.loc 1 33 22 is_stmt 0 discriminator 4 view .LVU143
.LBE28:
	.loc 1 34 3 is_stmt 1 view .LVU144
.LBB29:
.LBI29:
	.file 3 "/usr/include/x86_64-linux-gnu/bits/stdio2.h"
	.loc 3 116 1 view .LVU145
.LBB30:
	.loc 3 118 3 view .LVU146
	.loc 3 118 10 is_stmt 0 view .LVU147
	movq	%r15, %rdx
	movapd	%xmm10, %xmm0
	movl	$2, %edi
	movl	$1, %eax
	leaq	.LC3(%rip), %rsi
	call	__printf_chk@PLT
.LVL54:
	.loc 3 118 10 view .LVU148
.LBE30:
.LBE29:
	.loc 1 35 3 is_stmt 1 view .LVU149
	.loc 1 36 1 is_stmt 0 view .LVU150
	addq	$24, %rsp
	.cfi_remember_state
	.cfi_def_cfa_offset 56
	xorl	%eax, %eax
	popq	%rbx
	.cfi_def_cfa_offset 48
.LVL55:
	.loc 1 36 1 view .LVU151
	popq	%rbp
	.cfi_def_cfa_offset 40
	popq	%r12
	.cfi_def_cfa_offset 32
.LVL56:
	.loc 1 36 1 view .LVU152
	popq	%r13
	.cfi_def_cfa_offset 24
.LVL57:
	.loc 1 36 1 view .LVU153
	popq	%r14
	.cfi_def_cfa_offset 16
.LVL58:
	.loc 1 36 1 view .LVU154
	popq	%r15
	.cfi_def_cfa_offset 8
	ret
.LVL59:
.L38:
	.cfi_restore_state
	.loc 1 32 8 view .LVU155
	xorl	%r15d, %r15d
	.loc 1 31 10 view .LVU156
	pxor	%xmm10, %xmm10
	jmp	.L35
	.cfi_endproc
.LFE41:
	.size	main, .-main
	.text
.Letext0:
	.file 4 "/usr/include/x86_64-linux-gnu/bits/stdio2-decl.h"
	.section	.debug_info,"",@progbits
.Ldebug_info0:
	.long	0x506
	.value	0x5
	.byte	0x1
	.byte	0x8
	.long	.Ldebug_abbrev0
	.uleb128 0x15
	.long	.LASF29
	.byte	0x1d
	.byte	0x3
	.long	0x31647
	.long	.LASF0
	.long	.LASF1
	.long	.LLRL29
	.quad	0
	.long	.Ldebug_line0
	.uleb128 0x3
	.byte	0x8
	.byte	0x7
	.long	.LASF2
	.uleb128 0x3
	.byte	0x4
	.byte	0x7
	.long	.LASF3
	.uleb128 0x16
	.byte	0x8
	.uleb128 0x3
	.byte	0x1
	.byte	0x8
	.long	.LASF4
	.uleb128 0x9
	.long	0x3f
	.uleb128 0x3
	.byte	0x2
	.byte	0x7
	.long	.LASF5
	.uleb128 0x3
	.byte	0x1
	.byte	0x6
	.long	.LASF6
	.uleb128 0x3
	.byte	0x2
	.byte	0x5
	.long	.LASF7
	.uleb128 0x17
	.byte	0x4
	.byte	0x5
	.string	"int"
	.uleb128 0x3
	.byte	0x8
	.byte	0x5
	.long	.LASF8
	.uleb128 0x4
	.long	0x73
	.uleb128 0x3
	.byte	0x1
	.byte	0x6
	.long	.LASF9
	.uleb128 0x9
	.long	0x73
	.uleb128 0x4
	.long	0x7a
	.uleb128 0xd
	.long	0x7f
	.uleb128 0x3
	.byte	0x8
	.byte	0x5
	.long	.LASF10
	.uleb128 0x3
	.byte	0x8
	.byte	0x7
	.long	.LASF11
	.uleb128 0x18
	.long	.LASF12
	.byte	0x4
	.byte	0x34
	.byte	0xc
	.long	0x60
	.long	0xb3
	.uleb128 0x5
	.long	0x60
	.uleb128 0x5
	.long	0x7f
	.uleb128 0xe
	.byte	0
	.uleb128 0x19
	.long	.LASF30
	.byte	0x2
	.byte	0xdb
	.byte	0x11
	.long	.LASF31
	.long	0x67
	.long	0xd7
	.uleb128 0x5
	.long	0x84
	.uleb128 0x5
	.long	0xdc
	.uleb128 0x5
	.long	0x60
	.byte	0
	.uleb128 0x4
	.long	0x6e
	.uleb128 0xd
	.long	0xd7
	.uleb128 0x1a
	.long	.LASF13
	.byte	0x2
	.value	0x2a4
	.byte	0xe
	.long	0x3d
	.long	0xf8
	.uleb128 0x5
	.long	0x2f
	.byte	0
	.uleb128 0xa
	.long	.LASF21
	.byte	0x19
	.byte	0x5
	.long	0x60
	.quad	.LFB41
	.quad	.LFE41-.LFB41
	.uleb128 0x1
	.byte	0x9c
	.long	0x37f
	.uleb128 0xb
	.long	.LASF14
	.byte	0x19
	.byte	0xe
	.long	0x60
	.long	.LLST13
	.long	.LVUS13
	.uleb128 0xb
	.long	.LASF15
	.byte	0x19
	.byte	0x1b
	.long	0xd7
	.long	.LLST14
	.long	.LVUS14
	.uleb128 0xf
	.long	.LASF16
	.byte	0x8
	.long	0x67
	.value	0x100
	.uleb128 0xf
	.long	.LASF17
	.byte	0x14
	.long	0x67
	.value	0x1000
	.uleb128 0x10
	.long	.LASF18
	.byte	0x1a
	.byte	0x21
	.long	0x67
	.long	.LLST15
	.long	.LVUS15
	.uleb128 0x2
	.string	"m"
	.byte	0x1b
	.byte	0xa
	.long	0x37f
	.long	.LLST16
	.long	.LVUS16
	.uleb128 0x2
	.string	"v"
	.byte	0x1b
	.byte	0x34
	.long	0x37f
	.long	.LLST17
	.long	.LVUS17
	.uleb128 0x2
	.string	"out"
	.byte	0x1b
	.byte	0x57
	.long	0x37f
	.long	.LLST18
	.long	.LVUS18
	.uleb128 0x2
	.string	"p"
	.byte	0x1c
	.byte	0x12
	.long	0x390
	.long	.LLST19
	.long	.LVUS19
	.uleb128 0x2
	.string	"t"
	.byte	0x1f
	.byte	0xa
	.long	0x395
	.long	.LLST20
	.long	.LVUS20
	.uleb128 0x2
	.string	"k"
	.byte	0x20
	.byte	0x8
	.long	0x67
	.long	.LLST21
	.long	.LVUS21
	.uleb128 0x11
	.long	.LLRL23
	.long	0x1ed
	.uleb128 0x2
	.string	"i"
	.byte	0x1d
	.byte	0xd
	.long	0x67
	.long	.LLST24
	.long	.LVUS24
	.byte	0
	.uleb128 0x1b
	.quad	.LBB26
	.quad	.LBE26-.LBB26
	.long	0x214
	.uleb128 0x2
	.string	"i"
	.byte	0x1e
	.byte	0xd
	.long	0x67
	.long	.LLST25
	.long	.LVUS25
	.byte	0
	.uleb128 0x11
	.long	.LLRL26
	.long	0x27c
	.uleb128 0x2
	.string	"r"
	.byte	0x21
	.byte	0xd
	.long	0x67
	.long	.LLST27
	.long	.LVUS27
	.uleb128 0x6
	.quad	.LVL49
	.long	0x401
	.long	0x261
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x55
	.uleb128 0x2
	.byte	0x7c
	.sleb128 0
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x54
	.uleb128 0x2
	.byte	0x74
	.sleb128 0
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x51
	.uleb128 0x4
	.byte	0x91
	.sleb128 -72
	.byte	0x6
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x52
	.uleb128 0x3
	.byte	0xa
	.value	0x100
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x58
	.uleb128 0x2
	.byte	0x78
	.sleb128 0
	.byte	0
	.uleb128 0x7
	.quad	.LVL51
	.long	0x39c
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x55
	.uleb128 0x2
	.byte	0x75
	.sleb128 0
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x54
	.uleb128 0x2
	.byte	0x74
	.sleb128 0
	.byte	0
	.byte	0
	.uleb128 0x12
	.long	0x4ce
	.quad	.LBI22
	.byte	.LVU80
	.quad	.LBB22
	.quad	.LBE22-.LBB22
	.byte	0x1a
	.byte	0x33
	.long	0x2c6
	.uleb128 0x13
	.long	0x4e0
	.long	.LLST22
	.long	.LVUS22
	.uleb128 0x7
	.quad	.LVL32
	.long	0xb3
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x54
	.uleb128 0x1
	.byte	0x30
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x51
	.uleb128 0x1
	.byte	0x3a
	.byte	0
	.byte	0
	.uleb128 0x12
	.long	0x4ee
	.quad	.LBI29
	.byte	.LVU145
	.quad	.LBB29
	.quad	.LBE29-.LBB29
	.byte	0x22
	.byte	0x3
	.long	0x31e
	.uleb128 0x13
	.long	0x4fb
	.long	.LLST28
	.long	.LVUS28
	.uleb128 0x7
	.quad	.LVL54
	.long	0x97
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x55
	.uleb128 0x1
	.byte	0x32
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x54
	.uleb128 0x9
	.byte	0x3
	.quad	.LC3
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x51
	.uleb128 0x2
	.byte	0x7f
	.sleb128 0
	.byte	0
	.byte	0
	.uleb128 0x6
	.quad	.LVL34
	.long	0xe1
	.long	0x337
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x55
	.uleb128 0x3
	.byte	0x40
	.byte	0x42
	.byte	0x24
	.byte	0
	.uleb128 0x6
	.quad	.LVL36
	.long	0xe1
	.long	0x350
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x55
	.uleb128 0x3
	.byte	0xa
	.value	0x4000
	.byte	0
	.uleb128 0x6
	.quad	.LVL38
	.long	0xe1
	.long	0x369
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x55
	.uleb128 0x3
	.byte	0xa
	.value	0x400
	.byte	0
	.uleb128 0x7
	.quad	.LVL40
	.long	0xe1
	.uleb128 0x1
	.uleb128 0x1
	.byte	0x55
	.uleb128 0x3
	.byte	0x40
	.byte	0x40
	.byte	0x24
	.byte	0
	.byte	0
	.uleb128 0x4
	.long	0x384
	.uleb128 0x3
	.byte	0x4
	.byte	0x4
	.long	.LASF19
	.uleb128 0x9
	.long	0x384
	.uleb128 0x4
	.long	0x3f
	.uleb128 0x3
	.byte	0x8
	.byte	0x4
	.long	.LASF20
	.uleb128 0xa
	.long	.LASF22
	.byte	0x12
	.byte	0x20
	.long	0x67
	.quad	.LFB40
	.quad	.LFE40-.LFB40
	.uleb128 0x1
	.byte	0x9c
	.long	0x3fc
	.uleb128 0xc
	.string	"p"
	.byte	0x12
	.byte	0x3b
	.long	0x3fc
	.uleb128 0x1
	.byte	0x55
	.uleb128 0xc
	.string	"n"
	.byte	0x12
	.byte	0x43
	.long	0x67
	.uleb128 0x1
	.byte	0x54
	.uleb128 0x2
	.string	"k"
	.byte	0x13
	.byte	0x8
	.long	0x67
	.long	.LLST10
	.long	.LVUS10
	.uleb128 0x8
	.long	.LLRL11
	.uleb128 0x2
	.string	"i"
	.byte	0x14
	.byte	0xd
	.long	0x67
	.long	.LLST12
	.long	.LVUS12
	.byte	0
	.byte	0
	.uleb128 0x4
	.long	0x46
	.uleb128 0xa
	.long	.LASF23
	.byte	0x6
	.byte	0x21
	.long	0x384
	.quad	.LFB39
	.quad	.LFE39-.LFB39
	.uleb128 0x1
	.byte	0x9c
	.long	0x4c9
	.uleb128 0x14
	.string	"m"
	.byte	0x35
	.long	0x4c9
	.long	.LLST0
	.long	.LVUS0
	.uleb128 0xc
	.string	"v"
	.byte	0x6
	.byte	0x45
	.long	0x4c9
	.uleb128 0x1
	.byte	0x54
	.uleb128 0x14
	.string	"out"
	.byte	0x4f
	.long	0x37f
	.long	.LLST1
	.long	.LVUS1
	.uleb128 0xb
	.long	.LASF16
	.byte	0x6
	.byte	0x59
	.long	0x67
	.long	.LLST2
	.long	.LVUS2
	.uleb128 0x1c
	.long	.LASF17
	.byte	0x1
	.byte	0x6
	.byte	0x64
	.long	0x67
	.uleb128 0x1
	.byte	0x58
	.uleb128 0x10
	.long	.LASF24
	.byte	0x7
	.byte	0x9
	.long	0x384
	.long	.LLST3
	.long	.LVUS3
	.uleb128 0x8
	.long	.LLRL4
	.uleb128 0x2
	.string	"r"
	.byte	0x8
	.byte	0xd
	.long	0x67
	.long	.LLST5
	.long	.LVUS5
	.uleb128 0x8
	.long	.LLRL6
	.uleb128 0x2
	.string	"s"
	.byte	0x9
	.byte	0xb
	.long	0x384
	.long	.LLST7
	.long	.LVUS7
	.uleb128 0x8
	.long	.LLRL8
	.uleb128 0x2
	.string	"c"
	.byte	0xa
	.byte	0xf
	.long	0x67
	.long	.LLST9
	.long	.LVUS9
	.byte	0
	.byte	0
	.byte	0
	.byte	0
	.uleb128 0x4
	.long	0x38b
	.uleb128 0x1d
	.long	.LASF25
	.byte	0x2
	.value	0x1ea
	.byte	0x1
	.long	0x67
	.byte	0x3
	.long	0x4ee
	.uleb128 0x1e
	.long	.LASF27
	.byte	0x2
	.value	0x1ea
	.byte	0x1
	.long	0x7f
	.byte	0
	.uleb128 0x1f
	.long	.LASF26
	.byte	0x3
	.byte	0x74
	.byte	0x1
	.long	0x60
	.byte	0x3
	.uleb128 0x20
	.long	.LASF28
	.byte	0x3
	.byte	0x74
	.byte	0x20
	.long	0x84
	.uleb128 0xe
	.byte	0
	.byte	0
	.section	.debug_abbrev,"",@progbits
.Ldebug_abbrev0:
	.uleb128 0x1
	.uleb128 0x49
	.byte	0
	.uleb128 0x2
	.uleb128 0x18
	.uleb128 0x7e
	.uleb128 0x18
	.byte	0
	.byte	0
	.uleb128 0x2
	.uleb128 0x34
	.byte	0
	.uleb128 0x3
	.uleb128 0x8
	.uleb128 0x3a
	.uleb128 0x21
	.sleb128 1
	.uleb128 0x3b
	.uleb128 0xb
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x49
	.uleb128 0x13
	.uleb128 0x2
	.uleb128 0x17
	.uleb128 0x2137
	.uleb128 0x17
	.byte	0
	.byte	0
	.uleb128 0x3
	.uleb128 0x24
	.byte	0
	.uleb128 0xb
	.uleb128 0xb
	.uleb128 0x3e
	.uleb128 0xb
	.uleb128 0x3
	.uleb128 0xe
	.byte	0
	.byte	0
	.uleb128 0x4
	.uleb128 0xf
	.byte	0
	.uleb128 0xb
	.uleb128 0x21
	.sleb128 8
	.uleb128 0x49
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0x5
	.uleb128 0x5
	.byte	0
	.uleb128 0x49
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0x6
	.uleb128 0x48
	.byte	0x1
	.uleb128 0x7d
	.uleb128 0x1
	.uleb128 0x7f
	.uleb128 0x13
	.uleb128 0x1
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0x7
	.uleb128 0x48
	.byte	0x1
	.uleb128 0x7d
	.uleb128 0x1
	.uleb128 0x7f
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0x8
	.uleb128 0xb
	.byte	0x1
	.uleb128 0x55
	.uleb128 0x17
	.byte	0
	.byte	0
	.uleb128 0x9
	.uleb128 0x26
	.byte	0
	.uleb128 0x49
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0xa
	.uleb128 0x2e
	.byte	0x1
	.uleb128 0x3f
	.uleb128 0x19
	.uleb128 0x3
	.uleb128 0xe
	.uleb128 0x3a
	.uleb128 0x21
	.sleb128 1
	.uleb128 0x3b
	.uleb128 0xb
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x27
	.uleb128 0x19
	.uleb128 0x49
	.uleb128 0x13
	.uleb128 0x11
	.uleb128 0x1
	.uleb128 0x12
	.uleb128 0x7
	.uleb128 0x40
	.uleb128 0x18
	.uleb128 0x7a
	.uleb128 0x19
	.uleb128 0x1
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0xb
	.uleb128 0x5
	.byte	0
	.uleb128 0x3
	.uleb128 0xe
	.uleb128 0x3a
	.uleb128 0x21
	.sleb128 1
	.uleb128 0x3b
	.uleb128 0xb
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x49
	.uleb128 0x13
	.uleb128 0x2
	.uleb128 0x17
	.uleb128 0x2137
	.uleb128 0x17
	.byte	0
	.byte	0
	.uleb128 0xc
	.uleb128 0x5
	.byte	0
	.uleb128 0x3
	.uleb128 0x8
	.uleb128 0x3a
	.uleb128 0x21
	.sleb128 1
	.uleb128 0x3b
	.uleb128 0xb
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x49
	.uleb128 0x13
	.uleb128 0x2
	.uleb128 0x18
	.byte	0
	.byte	0
	.uleb128 0xd
	.uleb128 0x37
	.byte	0
	.uleb128 0x49
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0xe
	.uleb128 0x18
	.byte	0
	.byte	0
	.byte	0
	.uleb128 0xf
	.uleb128 0x34
	.byte	0
	.uleb128 0x3
	.uleb128 0xe
	.uleb128 0x3a
	.uleb128 0x21
	.sleb128 1
	.uleb128 0x3b
	.uleb128 0x21
	.sleb128 26
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x49
	.uleb128 0x13
	.uleb128 0x1c
	.uleb128 0x5
	.byte	0
	.byte	0
	.uleb128 0x10
	.uleb128 0x34
	.byte	0
	.uleb128 0x3
	.uleb128 0xe
	.uleb128 0x3a
	.uleb128 0x21
	.sleb128 1
	.uleb128 0x3b
	.uleb128 0xb
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x49
	.uleb128 0x13
	.uleb128 0x2
	.uleb128 0x17
	.uleb128 0x2137
	.uleb128 0x17
	.byte	0
	.byte	0
	.uleb128 0x11
	.uleb128 0xb
	.byte	0x1
	.uleb128 0x55
	.uleb128 0x17
	.uleb128 0x1
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0x12
	.uleb128 0x1d
	.byte	0x1
	.uleb128 0x31
	.uleb128 0x13
	.uleb128 0x52
	.uleb128 0x1
	.uleb128 0x2138
	.uleb128 0xb
	.uleb128 0x11
	.uleb128 0x1
	.uleb128 0x12
	.uleb128 0x7
	.uleb128 0x58
	.uleb128 0x21
	.sleb128 1
	.uleb128 0x59
	.uleb128 0xb
	.uleb128 0x57
	.uleb128 0xb
	.uleb128 0x1
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0x13
	.uleb128 0x5
	.byte	0
	.uleb128 0x31
	.uleb128 0x13
	.uleb128 0x2
	.uleb128 0x17
	.uleb128 0x2137
	.uleb128 0x17
	.byte	0
	.byte	0
	.uleb128 0x14
	.uleb128 0x5
	.byte	0
	.uleb128 0x3
	.uleb128 0x8
	.uleb128 0x3a
	.uleb128 0x21
	.sleb128 1
	.uleb128 0x3b
	.uleb128 0x21
	.sleb128 6
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x49
	.uleb128 0x13
	.uleb128 0x2
	.uleb128 0x17
	.uleb128 0x2137
	.uleb128 0x17
	.byte	0
	.byte	0
	.uleb128 0x15
	.uleb128 0x11
	.byte	0x1
	.uleb128 0x25
	.uleb128 0xe
	.uleb128 0x13
	.uleb128 0xb
	.uleb128 0x90
	.uleb128 0xb
	.uleb128 0x91
	.uleb128 0x6
	.uleb128 0x3
	.uleb128 0x1f
	.uleb128 0x1b
	.uleb128 0x1f
	.uleb128 0x55
	.uleb128 0x17
	.uleb128 0x11
	.uleb128 0x1
	.uleb128 0x10
	.uleb128 0x17
	.byte	0
	.byte	0
	.uleb128 0x16
	.uleb128 0xf
	.byte	0
	.uleb128 0xb
	.uleb128 0xb
	.byte	0
	.byte	0
	.uleb128 0x17
	.uleb128 0x24
	.byte	0
	.uleb128 0xb
	.uleb128 0xb
	.uleb128 0x3e
	.uleb128 0xb
	.uleb128 0x3
	.uleb128 0x8
	.byte	0
	.byte	0
	.uleb128 0x18
	.uleb128 0x2e
	.byte	0x1
	.uleb128 0x3f
	.uleb128 0x19
	.uleb128 0x3
	.uleb128 0xe
	.uleb128 0x3a
	.uleb128 0xb
	.uleb128 0x3b
	.uleb128 0xb
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x27
	.uleb128 0x19
	.uleb128 0x49
	.uleb128 0x13
	.uleb128 0x3c
	.uleb128 0x19
	.uleb128 0x1
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0x19
	.uleb128 0x2e
	.byte	0x1
	.uleb128 0x3f
	.uleb128 0x19
	.uleb128 0x3
	.uleb128 0xe
	.uleb128 0x3a
	.uleb128 0xb
	.uleb128 0x3b
	.uleb128 0xb
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x6e
	.uleb128 0xe
	.uleb128 0x27
	.uleb128 0x19
	.uleb128 0x49
	.uleb128 0x13
	.uleb128 0x3c
	.uleb128 0x19
	.uleb128 0x1
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0x1a
	.uleb128 0x2e
	.byte	0x1
	.uleb128 0x3f
	.uleb128 0x19
	.uleb128 0x3
	.uleb128 0xe
	.uleb128 0x3a
	.uleb128 0xb
	.uleb128 0x3b
	.uleb128 0x5
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x27
	.uleb128 0x19
	.uleb128 0x49
	.uleb128 0x13
	.uleb128 0x3c
	.uleb128 0x19
	.uleb128 0x1
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0x1b
	.uleb128 0xb
	.byte	0x1
	.uleb128 0x11
	.uleb128 0x1
	.uleb128 0x12
	.uleb128 0x7
	.uleb128 0x1
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0x1c
	.uleb128 0x5
	.byte	0
	.uleb128 0x3
	.uleb128 0xe
	.uleb128 0x3a
	.uleb128 0xb
	.uleb128 0x3b
	.uleb128 0xb
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x49
	.uleb128 0x13
	.uleb128 0x2
	.uleb128 0x18
	.byte	0
	.byte	0
	.uleb128 0x1d
	.uleb128 0x2e
	.byte	0x1
	.uleb128 0x3f
	.uleb128 0x19
	.uleb128 0x3
	.uleb128 0xe
	.uleb128 0x3a
	.uleb128 0xb
	.uleb128 0x3b
	.uleb128 0x5
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x27
	.uleb128 0x19
	.uleb128 0x49
	.uleb128 0x13
	.uleb128 0x20
	.uleb128 0xb
	.uleb128 0x1
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0x1e
	.uleb128 0x5
	.byte	0
	.uleb128 0x3
	.uleb128 0xe
	.uleb128 0x3a
	.uleb128 0xb
	.uleb128 0x3b
	.uleb128 0x5
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x49
	.uleb128 0x13
	.byte	0
	.byte	0
	.uleb128 0x1f
	.uleb128 0x2e
	.byte	0x1
	.uleb128 0x3f
	.uleb128 0x19
	.uleb128 0x3
	.uleb128 0xe
	.uleb128 0x3a
	.uleb128 0xb
	.uleb128 0x3b
	.uleb128 0xb
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x27
	.uleb128 0x19
	.uleb128 0x49
	.uleb128 0x13
	.uleb128 0x20
	.uleb128 0xb
	.uleb128 0x34
	.uleb128 0x19
	.byte	0
	.byte	0
	.uleb128 0x20
	.uleb128 0x5
	.byte	0
	.uleb128 0x3
	.uleb128 0xe
	.uleb128 0x3a
	.uleb128 0xb
	.uleb128 0x3b
	.uleb128 0xb
	.uleb128 0x39
	.uleb128 0xb
	.uleb128 0x49
	.uleb128 0x13
	.byte	0
	.byte	0
	.byte	0
	.section	.debug_loclists,"",@progbits
	.long	.Ldebug_loc3-.Ldebug_loc2
.Ldebug_loc2:
	.value	0x5
	.byte	0x8
	.byte	0
	.long	0
.Ldebug_loc0:
.LVUS13:
	.uleb128 0
	.uleb128 .LVU83
	.uleb128 .LVU83
	.uleb128 0
.LLST13:
	.byte	0x6
	.quad	.LVL27
	.byte	0x4
	.uleb128 .LVL27-.LVL27
	.uleb128 .LVL30-.LVL27
	.uleb128 0x1
	.byte	0x55
	.byte	0x4
	.uleb128 .LVL30-.LVL27
	.uleb128 .LFE41-.LVL27
	.uleb128 0x4
	.byte	0xa3
	.uleb128 0x1
	.byte	0x55
	.byte	0x9f
	.byte	0
.LVUS14:
	.uleb128 0
	.uleb128 .LVU84
	.uleb128 .LVU84
	.uleb128 0
.LLST14:
	.byte	0x6
	.quad	.LVL27
	.byte	0x4
	.uleb128 .LVL27-.LVL27
	.uleb128 .LVL31-.LVL27
	.uleb128 0x1
	.byte	0x54
	.byte	0x4
	.uleb128 .LVL31-.LVL27
	.uleb128 .LFE41-.LVL27
	.uleb128 0x4
	.byte	0xa3
	.uleb128 0x1
	.byte	0x54
	.byte	0x9f
	.byte	0
.LVUS15:
	.uleb128 .LVU86
	.uleb128 .LVU151
	.uleb128 .LVU155
	.uleb128 0
.LLST15:
	.byte	0x6
	.quad	.LVL33
	.byte	0x4
	.uleb128 .LVL33-.LVL33
	.uleb128 .LVL55-.LVL33
	.uleb128 0x1
	.byte	0x53
	.byte	0x4
	.uleb128 .LVL59-.LVL33
	.uleb128 .LFE41-.LVL33
	.uleb128 0x1
	.byte	0x53
	.byte	0
.LVUS16:
	.uleb128 .LVU91
	.uleb128 .LVU92
	.uleb128 .LVU92
	.uleb128 .LVU152
	.uleb128 .LVU155
	.uleb128 0
.LLST16:
	.byte	0x6
	.quad	.LVL35
	.byte	0x4
	.uleb128 .LVL35-.LVL35
	.uleb128 .LVL36-1-.LVL35
	.uleb128 0x1
	.byte	0x50
	.byte	0x4
	.uleb128 .LVL36-1-.LVL35
	.uleb128 .LVL56-.LVL35
	.uleb128 0x1
	.byte	0x5c
	.byte	0x4
	.uleb128 .LVL59-.LVL35
	.uleb128 .LFE41-.LVL35
	.uleb128 0x1
	.byte	0x5c
	.byte	0
.LVUS17:
	.uleb128 .LVU94
	.uleb128 .LVU95
	.uleb128 .LVU95
	.uleb128 .LVU153
	.uleb128 .LVU155
	.uleb128 0
.LLST17:
	.byte	0x6
	.quad	.LVL37
	.byte	0x4
	.uleb128 .LVL37-.LVL37
	.uleb128 .LVL38-1-.LVL37
	.uleb128 0x1
	.byte	0x50
	.byte	0x4
	.uleb128 .LVL38-1-.LVL37
	.uleb128 .LVL57-.LVL37
	.uleb128 0x1
	.byte	0x5d
	.byte	0x4
	.uleb128 .LVL59-.LVL37
	.uleb128 .LFE41-.LVL37
	.uleb128 0x1
	.byte	0x5d
	.byte	0
.LVUS18:
	.uleb128 .LVU97
	.uleb128 .LVU99
	.uleb128 .LVU99
	.uleb128 0
.LLST18:
	.byte	0x6
	.quad	.LVL39
	.byte	0x4
	.uleb128 .LVL39-.LVL39
	.uleb128 .LVL40-1-.LVL39
	.uleb128 0x1
	.byte	0x50
	.byte	0x4
	.uleb128 .LVL40-1-.LVL39
	.uleb128 .LFE41-.LVL39
	.uleb128 0x3
	.byte	0x91
	.sleb128 -72
	.byte	0
.LVUS19:
	.uleb128 .LVU103
	.uleb128 .LVU106
	.uleb128 .LVU106
	.uleb128 .LVU154
	.uleb128 .LVU155
	.uleb128 0
.LLST19:
	.byte	0x6
	.quad	.LVL41
	.byte	0x4
	.uleb128 .LVL41-.LVL41
	.uleb128 .LVL41-.LVL41
	.uleb128 0x1
	.byte	0x50
	.byte	0x4
	.uleb128 .LVL41-.LVL41
	.uleb128 .LVL58-.LVL41
	.uleb128 0x1
	.byte	0x5e
	.byte	0x4
	.uleb128 .LVL59-.LVL41
	.uleb128 .LFE41-.LVL41
	.uleb128 0x1
	.byte	0x5e
	.byte	0
.LVUS20:
	.uleb128 .LVU126
	.uleb128 .LVU131
	.uleb128 .LVU131
	.uleb128 .LVU143
	.uleb128 .LVU155
	.uleb128 0
.LLST20:
	.byte	0x6
	.quad	.LVL46
	.byte	0x4
	.uleb128 .LVL46-.LVL46
	.uleb128 .LVL47-.LVL46
	.uleb128 0xa
	.byte	0x9e
	.uleb128 0x8
	.long	0
	.long	0
	.byte	0x4
	.uleb128 .LVL47-.LVL46
	.uleb128 .LVL53-.LVL46
	.uleb128 0x1
	.byte	0x6b
	.byte	0x4
	.uleb128 .LVL59-.LVL46
	.uleb128 .LFE41-.LVL46
	.uleb128 0xa
	.byte	0x9e
	.uleb128 0x8
	.long	0
	.long	0
	.byte	0
.LVUS21:
	.uleb128 .LVU126
	.uleb128 .LVU131
	.uleb128 .LVU131
	.uleb128 .LVU143
	.uleb128 .LVU155
	.uleb128 0
.LLST21:
	.byte	0x6
	.quad	.LVL46
	.byte	0x4
	.uleb128 .LVL46-.LVL46
	.uleb128 .LVL47-.LVL46
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL47-.LVL46
	.uleb128 .LVL53-.LVL46
	.uleb128 0x1
	.byte	0x5f
	.byte	0x4
	.uleb128 .LVL59-.LVL46
	.uleb128 .LFE41-.LVL46
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0
.LVUS24:
	.uleb128 .LVU105
	.uleb128 .LVU106
	.uleb128 .LVU106
	.uleb128 .LVU118
.LLST24:
	.byte	0x6
	.quad	.LVL41
	.byte	0x4
	.uleb128 .LVL41-.LVL41
	.uleb128 .LVL41-.LVL41
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL41-.LVL41
	.uleb128 .LVL43-.LVL41
	.uleb128 0x1
	.byte	0x52
	.byte	0
.LVUS25:
	.uleb128 .LVU119
	.uleb128 .LVU131
	.uleb128 .LVU155
	.uleb128 0
.LLST25:
	.byte	0x6
	.quad	.LVL44
	.byte	0x4
	.uleb128 .LVL44-.LVL44
	.uleb128 .LVL47-.LVL44
	.uleb128 0x1
	.byte	0x52
	.byte	0x4
	.uleb128 .LVL59-.LVL44
	.uleb128 .LFE41-.LVL44
	.uleb128 0x1
	.byte	0x52
	.byte	0
.LVUS27:
	.uleb128 .LVU126
	.uleb128 .LVU131
	.uleb128 .LVU131
	.uleb128 .LVU134
	.uleb128 .LVU134
	.uleb128 .LVU142
	.uleb128 .LVU142
	.uleb128 .LVU143
	.uleb128 .LVU155
	.uleb128 0
.LLST27:
	.byte	0x6
	.quad	.LVL46
	.byte	0x4
	.uleb128 .LVL46-.LVL46
	.uleb128 .LVL47-.LVL46
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL47-.LVL46
	.uleb128 .LVL48-.LVL46
	.uleb128 0x1
	.byte	0x56
	.byte	0x4
	.uleb128 .LVL48-.LVL46
	.uleb128 .LVL52-.LVL46
	.uleb128 0x3
	.byte	0x76
	.sleb128 -1
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL52-.LVL46
	.uleb128 .LVL53-.LVL46
	.uleb128 0x1
	.byte	0x56
	.byte	0x4
	.uleb128 .LVL59-.LVL46
	.uleb128 .LFE41-.LVL46
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0
.LVUS22:
	.uleb128 .LVU80
	.uleb128 .LVU84
	.uleb128 .LVU84
	.uleb128 .LVU85
.LLST22:
	.byte	0x6
	.quad	.LVL29
	.byte	0x4
	.uleb128 .LVL29-.LVL29
	.uleb128 .LVL31-.LVL29
	.uleb128 0x2
	.byte	0x74
	.sleb128 8
	.byte	0x4
	.uleb128 .LVL31-.LVL29
	.uleb128 .LVL32-1-.LVL29
	.uleb128 0x1
	.byte	0x55
	.byte	0
.LVUS28:
	.uleb128 .LVU145
	.uleb128 .LVU148
.LLST28:
	.byte	0x8
	.quad	.LVL53
	.uleb128 .LVL54-.LVL53
	.uleb128 0xa
	.byte	0x3
	.quad	.LC3
	.byte	0x9f
	.byte	0
.LVUS10:
	.uleb128 .LVU53
	.uleb128 .LVU56
	.uleb128 .LVU62
	.uleb128 .LVU69
	.uleb128 .LVU69
	.uleb128 .LVU72
	.uleb128 .LVU73
	.uleb128 0
.LLST10:
	.byte	0x6
	.quad	.LVL19
	.byte	0x4
	.uleb128 .LVL19-.LVL19
	.uleb128 .LVL20-.LVL19
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL21-.LVL19
	.uleb128 .LVL24-.LVL19
	.uleb128 0x1
	.byte	0x50
	.byte	0x4
	.uleb128 .LVL24-.LVL19
	.uleb128 .LVL25-.LVL19
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL26-.LVL19
	.uleb128 .LFE40-.LVL19
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0
.LVUS12:
	.uleb128 .LVU53
	.uleb128 .LVU56
	.uleb128 .LVU62
	.uleb128 .LVU65
	.uleb128 .LVU65
	.uleb128 .LVU68
	.uleb128 .LVU68
	.uleb128 .LVU69
	.uleb128 .LVU69
	.uleb128 .LVU72
	.uleb128 .LVU73
	.uleb128 0
.LLST12:
	.byte	0x6
	.quad	.LVL19
	.byte	0x4
	.uleb128 .LVL19-.LVL19
	.uleb128 .LVL20-.LVL19
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL21-.LVL19
	.uleb128 .LVL22-.LVL19
	.uleb128 0x1
	.byte	0x51
	.byte	0x4
	.uleb128 .LVL22-.LVL19
	.uleb128 .LVL23-.LVL19
	.uleb128 0x3
	.byte	0x71
	.sleb128 -1
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL23-.LVL19
	.uleb128 .LVL24-.LVL19
	.uleb128 0x1
	.byte	0x51
	.byte	0x4
	.uleb128 .LVL24-.LVL19
	.uleb128 .LVL25-.LVL19
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL26-.LVL19
	.uleb128 .LFE40-.LVL19
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0
.LVUS0:
	.uleb128 0
	.uleb128 .LVU8
	.uleb128 .LVU8
	.uleb128 .LVU32
	.uleb128 .LVU32
	.uleb128 0
.LLST0:
	.byte	0x6
	.quad	.LVL0
	.byte	0x4
	.uleb128 .LVL0-.LVL0
	.uleb128 .LVL4-.LVL0
	.uleb128 0x1
	.byte	0x55
	.byte	0x4
	.uleb128 .LVL4-.LVL0
	.uleb128 .LVL13-.LVL0
	.uleb128 0x4
	.byte	0xa3
	.uleb128 0x1
	.byte	0x55
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL13-.LVL0
	.uleb128 .LFE39-.LVL0
	.uleb128 0x1
	.byte	0x55
	.byte	0
.LVUS1:
	.uleb128 0
	.uleb128 .LVU8
	.uleb128 .LVU8
	.uleb128 0
.LLST1:
	.byte	0x6
	.quad	.LVL0
	.byte	0x4
	.uleb128 .LVL0-.LVL0
	.uleb128 .LVL4-.LVL0
	.uleb128 0x1
	.byte	0x51
	.byte	0x4
	.uleb128 .LVL4-.LVL0
	.uleb128 .LFE39-.LVL0
	.uleb128 0x4
	.byte	0xa3
	.uleb128 0x1
	.byte	0x51
	.byte	0x9f
	.byte	0
.LVUS2:
	.uleb128 0
	.uleb128 .LVU7
	.uleb128 .LVU7
	.uleb128 .LVU32
	.uleb128 .LVU32
	.uleb128 0
.LLST2:
	.byte	0x6
	.quad	.LVL0
	.byte	0x4
	.uleb128 .LVL0-.LVL0
	.uleb128 .LVL3-.LVL0
	.uleb128 0x1
	.byte	0x52
	.byte	0x4
	.uleb128 .LVL3-.LVL0
	.uleb128 .LVL13-.LVL0
	.uleb128 0x4
	.byte	0xa3
	.uleb128 0x1
	.byte	0x52
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL13-.LVL0
	.uleb128 .LFE39-.LVL0
	.uleb128 0x1
	.byte	0x52
	.byte	0
.LVUS3:
	.uleb128 .LVU5
	.uleb128 .LVU8
	.uleb128 .LVU29
	.uleb128 .LVU32
	.uleb128 .LVU32
	.uleb128 .LVU33
	.uleb128 .LVU38
	.uleb128 0
.LLST3:
	.byte	0x6
	.quad	.LVL1
	.byte	0x4
	.uleb128 .LVL1-.LVL1
	.uleb128 .LVL4-.LVL1
	.uleb128 0x6
	.byte	0x9e
	.uleb128 0x4
	.long	0
	.byte	0x4
	.uleb128 .LVL12-.LVL1
	.uleb128 .LVL13-.LVL1
	.uleb128 0x1
	.byte	0x64
	.byte	0x4
	.uleb128 .LVL13-.LVL1
	.uleb128 .LVL14-.LVL1
	.uleb128 0x6
	.byte	0x9e
	.uleb128 0x4
	.long	0
	.byte	0x4
	.uleb128 .LVL15-.LVL1
	.uleb128 .LFE39-.LVL1
	.uleb128 0x6
	.byte	0x9e
	.uleb128 0x4
	.long	0
	.byte	0
.LVUS5:
	.uleb128 .LVU5
	.uleb128 .LVU6
.LLST5:
	.byte	0x8
	.quad	.LVL1
	.uleb128 .LVL2-.LVL1
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0
.LVUS7:
	.uleb128 .LVU6
	.uleb128 .LVU8
	.uleb128 .LVU10
	.uleb128 .LVU12
	.uleb128 .LVU15
	.uleb128 .LVU32
	.uleb128 .LVU32
	.uleb128 .LVU33
	.uleb128 .LVU39
	.uleb128 .LVU45
.LLST7:
	.byte	0x6
	.quad	.LVL2
	.byte	0x4
	.uleb128 .LVL2-.LVL2
	.uleb128 .LVL4-.LVL2
	.uleb128 0x6
	.byte	0x9e
	.uleb128 0x4
	.long	0
	.byte	0x4
	.uleb128 .LVL5-.LVL2
	.uleb128 .LVL6-.LVL2
	.uleb128 0x1
	.byte	0x62
	.byte	0x4
	.uleb128 .LVL7-.LVL2
	.uleb128 .LVL13-.LVL2
	.uleb128 0x1
	.byte	0x62
	.byte	0x4
	.uleb128 .LVL13-.LVL2
	.uleb128 .LVL14-.LVL2
	.uleb128 0x6
	.byte	0x9e
	.uleb128 0x4
	.long	0
	.byte	0x4
	.uleb128 .LVL16-.LVL2
	.uleb128 .LVL17-.LVL2
	.uleb128 0x6
	.byte	0x9e
	.uleb128 0x4
	.long	0
	.byte	0
.LVUS9:
	.uleb128 .LVU6
	.uleb128 .LVU8
	.uleb128 .LVU16
	.uleb128 .LVU19
	.uleb128 .LVU19
	.uleb128 .LVU21
	.uleb128 .LVU21
	.uleb128 .LVU22
	.uleb128 .LVU32
	.uleb128 .LVU33
	.uleb128 .LVU39
	.uleb128 .LVU45
.LLST9:
	.byte	0x6
	.quad	.LVL2
	.byte	0x4
	.uleb128 .LVL2-.LVL2
	.uleb128 .LVL4-.LVL2
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL8-.LVL2
	.uleb128 .LVL9-.LVL2
	.uleb128 0x1
	.byte	0x50
	.byte	0x4
	.uleb128 .LVL9-.LVL2
	.uleb128 .LVL10-.LVL2
	.uleb128 0x3
	.byte	0x70
	.sleb128 -1
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL10-.LVL2
	.uleb128 .LVL11-.LVL2
	.uleb128 0x1
	.byte	0x50
	.byte	0x4
	.uleb128 .LVL13-.LVL2
	.uleb128 .LVL14-.LVL2
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0x4
	.uleb128 .LVL16-.LVL2
	.uleb128 .LVL17-.LVL2
	.uleb128 0x2
	.byte	0x30
	.byte	0x9f
	.byte	0
.Ldebug_loc3:
	.section	.debug_aranges,"",@progbits
	.long	0x3c
	.value	0x2
	.long	.Ldebug_info0
	.byte	0x8
	.byte	0
	.value	0
	.value	0
	.quad	.Ltext0
	.quad	.Letext0-.Ltext0
	.quad	.LFB41
	.quad	.LFE41-.LFB41
	.quad	0
	.quad	0
	.section	.debug_rnglists,"",@progbits
.Ldebug_ranges0:
	.long	.Ldebug_ranges3-.Ldebug_ranges2
.Ldebug_ranges2:
	.value	0x5
	.byte	0x8
	.byte	0
	.long	0
.LLRL4:
	.byte	0x5
	.quad	.LBB9
	.byte	0x4
	.uleb128 .LBB9-.LBB9
	.uleb128 .LBE9-.LBB9
	.byte	0x4
	.uleb128 .LBB19-.LBB9
	.uleb128 .LBE19-.LBB9
	.byte	0
.LLRL6:
	.byte	0x5
	.quad	.LBB10
	.byte	0x4
	.uleb128 .LBB10-.LBB10
	.uleb128 .LBE10-.LBB10
	.byte	0x4
	.uleb128 .LBB14-.LBB10
	.uleb128 .LBE14-.LBB10
	.byte	0x4
	.uleb128 .LBB15-.LBB10
	.uleb128 .LBE15-.LBB10
	.byte	0x4
	.uleb128 .LBB16-.LBB10
	.uleb128 .LBE16-.LBB10
	.byte	0x4
	.uleb128 .LBB17-.LBB10
	.uleb128 .LBE17-.LBB10
	.byte	0x4
	.uleb128 .LBB18-.LBB10
	.uleb128 .LBE18-.LBB10
	.byte	0
.LLRL8:
	.byte	0x5
	.quad	.LBB11
	.byte	0x4
	.uleb128 .LBB11-.LBB11
	.uleb128 .LBE11-.LBB11
	.byte	0x4
	.uleb128 .LBB12-.LBB11
	.uleb128 .LBE12-.LBB11
	.byte	0x4
	.uleb128 .LBB13-.LBB11
	.uleb128 .LBE13-.LBB11
	.byte	0
.LLRL11:
	.byte	0x5
	.quad	.LBB20
	.byte	0x4
	.uleb128 .LBB20-.LBB20
	.uleb128 .LBE20-.LBB20
	.byte	0x4
	.uleb128 .LBB21-.LBB20
	.uleb128 .LBE21-.LBB20
	.byte	0
.LLRL23:
	.byte	0x5
	.quad	.LBB24
	.byte	0x4
	.uleb128 .LBB24-.LBB24
	.uleb128 .LBE24-.LBB24
	.byte	0x4
	.uleb128 .LBB25-.LBB24
	.uleb128 .LBE25-.LBB24
	.byte	0
.LLRL26:
	.byte	0x5
	.quad	.LBB27
	.byte	0x4
	.uleb128 .LBB27-.LBB27
	.uleb128 .LBE27-.LBB27
	.byte	0x4
	.uleb128 .LBB28-.LBB27
	.uleb128 .LBE28-.LBB27
	.byte	0
.LLRL29:
	.byte	0x7
	.quad	.Ltext0
	.uleb128 .Letext0-.Ltext0
	.byte	0x7
	.quad	.LFB41
	.uleb128 .LFE41-.LFB41
	.byte	0
.Ldebug_ranges3:
	.section	.debug_line,"",@progbits
.Ldebug_line0:
	.section	.debug_str,"MS",@progbits,1
.LASF22:
	.string	"count"
.LASF12:
	.string	"__printf_chk"
.LASF17:
	.string	"cols"
.LASF19:
	.string	"float"
.LASF4:
	.string	"unsigned char"
.LASF2:
	.string	"long unsigned int"
.LASF5:
	.string	"short unsigned int"
.LASF20:
	.string	"double"
.LASF21:
	.string	"main"
.LASF18:
	.string	"reps"
.LASF3:
	.string	"unsigned int"
.LASF27:
	.string	"__nptr"
.LASF11:
	.string	"long long unsigned int"
.LASF25:
	.string	"atol"
.LASF31:
	.string	"__isoc23_strtol"
.LASF16:
	.string	"rows"
.LASF10:
	.string	"long long int"
.LASF9:
	.string	"char"
.LASF26:
	.string	"printf"
.LASF7:
	.string	"short int"
.LASF15:
	.string	"argv"
.LASF23:
	.string	"matvec"
.LASF24:
	.string	"total"
.LASF8:
	.string	"long int"
.LASF29:
	.string	"GNU C23 15.2.0 -D_FORTIFY_SOURCE=3 -mtune=generic -march=x86-64 -g -O2 -fasynchronous-unwind-tables -fstack-protector-strong -fstack-clash-protection -fcf-protection -fzero-init-padding-bits=all"
.LASF6:
	.string	"signed char"
.LASF28:
	.string	"__fmt"
.LASF30:
	.string	"strtol"
.LASF13:
	.string	"malloc"
.LASF14:
	.string	"argc"
	.section	.debug_line_str,"MS",@progbits,1
.LASF1:
	.string	"."
.LASF0:
	.string	"hot.c"
	.ident	"GCC: (Ubuntu 15.2.0-16ubuntu1) 15.2.0"
	.section	.note.GNU-stack,"",@progbits
	.section	.note.gnu.property,"a"
	.align 8
	.long	1f - 0f
	.long	4f - 1f
	.long	5
0:
	.string	"GNU"
1:
	.align 8
	.long	0xc0000002
	.long	3f - 2f
2:
	.long	0x3
3:
	.align 8
4:
