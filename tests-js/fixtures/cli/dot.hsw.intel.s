	.text
	.intel_syntax noprefix
	.file	"dot.c"
	.globl	dot                             # -- Begin function dot
	.p2align	4, 0x90
	.type	dot,@function
dot:                                    # @dot
	.cfi_startproc
# %bb.0:
	test	rdx, rdx
	je	.LBB0_1
# %bb.2:
	mov	eax, edx
	and	eax, 7
	cmp	rdx, 8
	jae	.LBB0_8
# %bb.3:
	vxorps	xmm0, xmm0, xmm0
	xor	ecx, ecx
	jmp	.LBB0_4
.LBB0_1:
	vxorps	xmm0, xmm0, xmm0
	ret
.LBB0_8:
	and	rdx, -8
	vxorps	xmm0, xmm0, xmm0
	xor	ecx, ecx
	.p2align	4, 0x90
.LBB0_9:                                # =>This Inner Loop Header: Depth=1
	vmovss	xmm1, dword ptr [rdi + 4*rcx]   # xmm1 = mem[0],zero,zero,zero
	vmovss	xmm2, dword ptr [rdi + 4*rcx + 4] # xmm2 = mem[0],zero,zero,zero
	vfmadd132ss	xmm1, xmm0, dword ptr [rsi + 4*rcx] # xmm1 = (xmm1 * mem) + xmm0
	vfmadd231ss	xmm1, xmm2, dword ptr [rsi + 4*rcx + 4] # xmm1 = (xmm2 * mem) + xmm1
	vmovss	xmm0, dword ptr [rdi + 4*rcx + 8] # xmm0 = mem[0],zero,zero,zero
	vfmadd132ss	xmm0, xmm1, dword ptr [rsi + 4*rcx + 8] # xmm0 = (xmm0 * mem) + xmm1
	vmovss	xmm1, dword ptr [rdi + 4*rcx + 12] # xmm1 = mem[0],zero,zero,zero
	vfmadd132ss	xmm1, xmm0, dword ptr [rsi + 4*rcx + 12] # xmm1 = (xmm1 * mem) + xmm0
	vmovss	xmm0, dword ptr [rdi + 4*rcx + 16] # xmm0 = mem[0],zero,zero,zero
	vfmadd132ss	xmm0, xmm1, dword ptr [rsi + 4*rcx + 16] # xmm0 = (xmm0 * mem) + xmm1
	vmovss	xmm1, dword ptr [rdi + 4*rcx + 20] # xmm1 = mem[0],zero,zero,zero
	vfmadd132ss	xmm1, xmm0, dword ptr [rsi + 4*rcx + 20] # xmm1 = (xmm1 * mem) + xmm0
	vmovss	xmm2, dword ptr [rdi + 4*rcx + 24] # xmm2 = mem[0],zero,zero,zero
	vfmadd132ss	xmm2, xmm1, dword ptr [rsi + 4*rcx + 24] # xmm2 = (xmm2 * mem) + xmm1
	vmovss	xmm0, dword ptr [rdi + 4*rcx + 28] # xmm0 = mem[0],zero,zero,zero
	vfmadd132ss	xmm0, xmm2, dword ptr [rsi + 4*rcx + 28] # xmm0 = (xmm0 * mem) + xmm2
	add	rcx, 8
	cmp	rdx, rcx
	jne	.LBB0_9
.LBB0_4:
	test	rax, rax
	je	.LBB0_7
# %bb.5:
	lea	rdx, [rsi + 4*rcx]
	lea	rcx, [rdi + 4*rcx]
	xor	esi, esi
	.p2align	4, 0x90
.LBB0_6:                                # =>This Inner Loop Header: Depth=1
	vmovss	xmm1, dword ptr [rcx + 4*rsi]   # xmm1 = mem[0],zero,zero,zero
	vfmadd231ss	xmm0, xmm1, dword ptr [rdx + 4*rsi] # xmm0 = (xmm1 * mem) + xmm0
	inc	rsi
	cmp	rax, rsi
	jne	.LBB0_6
.LBB0_7:
	ret
.Lfunc_end0:
	.size	dot, .Lfunc_end0-dot
	.cfi_endproc
                                        # -- End function
	.ident	"Apple clang version 17.0.0 (clang-1700.0.13.5)"
	.section	".note.GNU-stack","",@progbits
	.addrsig
