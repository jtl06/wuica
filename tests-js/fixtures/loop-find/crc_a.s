crc_a:
.LFB7304:
	.cfi_startproc
	endbr64
	test	rsi, rsi
	je	.L4
	mov	eax, 4294967295
	lea	rcx, -1[rsi]
	mov	edx, 8
	shr	rcx, 3
	crc32	rax, QWORD PTR [rdi]
	cmp	rdx, rsi
	jnb	.L12
	and	ecx, 1
	je	.L3
	mov	edx, 16
	crc32	rax, QWORD PTR 8[rdi]
	cmp	rdx, rsi
	jnb	.L12
	.p2align 5
	.p2align 4
	.p2align 3
.L3:
	crc32	rax, QWORD PTR [rdi+rdx]
	crc32	rax, QWORD PTR 8[rdi+rdx]
	add	rdx, 16
	cmp	rdx, rsi
	jb	.L3
.L12:
	not	eax
	ret
	.p2align 4
	.p2align 3
.L4:
	xor	eax, eax
	ret
	.cfi_endproc
.LFE7304:
	.size	crc_a, .-crc_a
