	.section	__TEXT,__text,regular,pure_instructions
	.build_version macos, 15, 5	sdk_version 15, 5
	.globl	_dot                            ; -- Begin function dot
	.p2align	2
_dot:                                   ; @dot
	.cfi_startproc
; %bb.0:
	cbz	x2, LBB0_3
; %bb.1:
	cmp	x2, #15
	b.hi	LBB0_4
; %bb.2:
	mov	x8, #0                          ; =0x0
	movi	d0, #0000000000000000
	b	LBB0_7
LBB0_3:
	movi	d0, #0000000000000000
	ret
LBB0_4:
	and	x8, x2, #0xfffffffffffffff0
	add	x9, x1, #32
	add	x10, x0, #32
	movi	d0, #0000000000000000
	mov	x11, x8
LBB0_5:                                 ; =>This Inner Loop Header: Depth=1
	ldp	q1, q2, [x10, #-32]
	ldp	q3, q4, [x10], #64
	ldp	q5, q6, [x9, #-32]
	ldp	q7, q16, [x9], #64
	fmul.4s	v1, v1, v5
	mov	s5, v1[3]
	mov	s17, v1[2]
	mov	s18, v1[1]
	fmul.4s	v2, v2, v6
	mov	s6, v2[3]
	mov	s19, v2[2]
	mov	s20, v2[1]
	fmul.4s	v3, v3, v7
	mov	s7, v3[3]
	mov	s21, v3[2]
	mov	s22, v3[1]
	fmul.4s	v4, v4, v16
	mov	s16, v4[3]
	mov	s23, v4[2]
	mov	s24, v4[1]
	fadd	s0, s0, s1
	fadd	s0, s0, s18
	fadd	s0, s0, s17
	fadd	s0, s0, s5
	fadd	s0, s0, s2
	fadd	s0, s0, s20
	fadd	s0, s0, s19
	fadd	s0, s0, s6
	fadd	s0, s0, s3
	fadd	s0, s0, s22
	fadd	s0, s0, s21
	fadd	s0, s0, s7
	fadd	s0, s0, s4
	fadd	s0, s0, s24
	fadd	s0, s0, s23
	fadd	s0, s0, s16
	subs	x11, x11, #16
	b.ne	LBB0_5
; %bb.6:
	cmp	x8, x2
	b.eq	LBB0_9
LBB0_7:
	sub	x9, x2, x8
	lsl	x10, x8, #2
	add	x8, x1, x10
	add	x10, x0, x10
LBB0_8:                                 ; =>This Inner Loop Header: Depth=1
	ldr	s1, [x10], #4
	ldr	s2, [x8], #4
	fmadd	s0, s1, s2, s0
	subs	x9, x9, #1
	b.ne	LBB0_8
LBB0_9:
	ret
	.cfi_endproc
                                        ; -- End function
.subsections_via_symbols
