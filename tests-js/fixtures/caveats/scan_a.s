.intel_syntax noprefix
.L:
	add    rdx,0x20
	cmp    rdx,rsi
	jae    .L
	vpcmpeqb ymm0,ymm1,YMMWORD PTR [rdi+rdx*1]
	vpmovmskb ecx,ymm0
	test   ecx,ecx
	je     .L
