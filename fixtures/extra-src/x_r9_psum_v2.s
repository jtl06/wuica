.intel_syntax noprefix
l:
	vmovdqu ymm0,YMMWORD PTR [rdi+rax*4-0x20]
	vpslldq ymm1,ymm0,0x4
	vpaddd ymm0,ymm0,ymm1
	vpslldq ymm1,ymm0,0x8
	vpaddd ymm0,ymm0,ymm1
	vperm2i128 ymm1,ymm0,ymm0,0x8
	vpshufd ymm1,ymm1,0xff
	vpaddd ymm0,ymm1,ymm0
	vpermd ymm1,ymm3,ymm0
	vpaddd ymm0,ymm0,ymm2
	vmovdqu YMMWORD PTR [rsi+rax*4-0x20],ymm0
	add    rax,0x8
	vpaddd ymm2,ymm1,ymm2
	cmp    rdx,rax
	jae l
