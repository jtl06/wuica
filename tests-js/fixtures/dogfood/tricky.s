# tricky highlighting: comments, strings, numbers, prefixes
.L1:	lock xaddq %rax, (%rdi)        # atomic add ; not a comment marker in AT&T?
	movabsq $0x7fffffffffffffff, %rcx  /* C-style comment */
	subq $-128, %rsi
	vpbroadcastb .LCPI0_0(%rip), %ymm1
	leaq -8(%rsp,%rcx,8), %rdx
	rep movsb
	.byte 0x0f, 0x1f, 0x00   // byte directive
	cmpb $'a', %al
	jne .L1
