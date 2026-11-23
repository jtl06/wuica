.intel_syntax noprefix
l:
	vmovdqu ymm0,YMMWORD PTR [rdi+rdx*1]
	vpermq ymm2,ymm0,0xd8
	vpshufd ymm1,ymm2,0x50
	vpshufd ymm2,ymm2,0xfa
	vpmuludq ymm1,ymm4,ymm1
	vpmuludq ymm2,ymm3,ymm2
	vpsrlq ymm1,ymm1,0x20
	vpsrlq ymm2,ymm2,0x20
	vperm2i128 ymm6,ymm1,ymm2,0x20
	vperm2i128 ymm1,ymm1,ymm2,0x31
	vpshufd ymm1,ymm1,0xd8
	vpshufd ymm2,ymm6,0xd8
	vpunpcklqdq ymm1,ymm2,ymm1
	vpsubd ymm0,ymm0,ymm1
	vpsrld ymm0,ymm0,xmm8
	vpaddd ymm0,ymm0,ymm1
	vpsrld ymm0,ymm0,xmm7
	vmovdqu YMMWORD PTR [rsi+rdx*1],ymm0
	add    rdx,0x20
	cmp    rcx,rdx
	jne l
