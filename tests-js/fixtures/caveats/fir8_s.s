.intel_syntax noprefix
.L:
	vmovdqa ymm13,ymm3
	vmovaps ymm14,ymm3
	vmovaps ymm3,YMMWORD PTR [rdi+rax*4]
	vfmadd132ps ymm14,ymm4,ymm12
	vperm2i128 ymm2,ymm13,ymm3,0x21
	vpalignr ymm15,ymm2,ymm13,0x4
	vfmadd231ps ymm14,ymm11,ymm15
	vpalignr ymm15,ymm2,ymm13,0x8
	vpalignr ymm13,ymm2,ymm13,0xc
	vfmadd231ps ymm14,ymm10,ymm15
	vfmadd132ps ymm13,ymm14,ymm9
	vfmadd132ps ymm2,ymm13,ymm8
	vfmadd231ps ymm2,ymm7,YMMWORD PTR [rdi+rax*4-0xc]
	vfmadd231ps ymm2,ymm6,YMMWORD PTR [rdi+rax*4-0x8]
	vfmadd231ps ymm2,ymm5,YMMWORD PTR [rdi+rax*4-0x4]
	vmovups YMMWORD PTR [rdx+rax*4-0x20],ymm2
	add    rax,0x8
	cmp    rcx,rax
	jae .L
