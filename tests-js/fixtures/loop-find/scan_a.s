scan_a:
.LFB7309:
	.cfi_startproc
	endbr64
	test	rsi, rsi
	je	.L51
	vmovd	xmm1, edx
	xor	edx, edx
	vpbroadcastb	ymm1, xmm1
	jmp	.L50
	.p2align 5
	.p2align 4
	.p2align 3
.L49:
	add	rdx, 32
	cmp	rdx, rsi
	jnb	.L53
.L50:
	vpcmpeqb	ymm0, ymm1, YMMWORD PTR [rdi+rdx]
	vpmovmskb	ecx, ymm0
	test	ecx, ecx
	je	.L49
	tzcnt	ecx, ecx
	add	rcx, rdx
	lea	rax, [rdi+rcx]
	vzeroupper
	ret
	.p2align 4
	.p2align 3
.L53:
	xor	eax, eax
	vzeroupper
	ret
.L51:
	xor	eax, eax
	ret
	.cfi_endproc
.LFE7309:
	.size	scan_a, .-scan_a
