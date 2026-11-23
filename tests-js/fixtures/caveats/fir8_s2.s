.intel_syntax noprefix
.L:
	vmovdqa ymm2,ymm3
	vmovaps ymm14,ymm3
	vmovaps ymm3,YMMWORD PTR [rdi+rax*4]
	vfmadd132ps ymm14,ymm4,ymm12
	vperm2i128 ymm13,ymm2,ymm3,0x21
	vpalignr ymm15,ymm13,ymm2,0x4
	vfmadd231ps ymm14,ymm11,ymm15
	vpalignr ymm15,ymm13,ymm2,0x8
	vpalignr ymm2,ymm13,ymm2,0xc
	vfmadd231ps ymm14,ymm10,ymm15
	vfmadd132ps ymm2,ymm14,ymm9
	vpalignr ymm14,ymm3,ymm13,0x4
	vfmadd231ps ymm2,ymm8,ymm13
	vfmadd231ps ymm2,ymm7,ymm14
	vpalignr ymm14,ymm3,ymm13,0x8
	vpalignr ymm13,ymm3,ymm13,0xc
	vfmadd231ps ymm2,ymm6,ymm14
	vfmadd132ps ymm13,ymm2,ymm5
	vmovups YMMWORD PTR [rdx+rax*4-0x20],ymm13
	add    rax,0x8
	cmp    rcx,rax
	jae .L
