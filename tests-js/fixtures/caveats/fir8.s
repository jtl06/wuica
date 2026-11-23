.intel_syntax noprefix
.L:
	vmovaps ymm1,ymm9
	vfmadd132ps ymm1,ymm0,YMMWORD PTR [rax-0x4]
	add    rdx,0x20
	add    rax,0x20
	vfmadd231ps ymm1,ymm8,YMMWORD PTR [rax-0x20]
	vfmadd231ps ymm1,ymm7,YMMWORD PTR [rax-0x1c]
	vfmadd231ps ymm1,ymm6,YMMWORD PTR [rax-0x18]
	vfmadd231ps ymm1,ymm5,YMMWORD PTR [rax-0x14]
	vfmadd231ps ymm1,ymm4,YMMWORD PTR [rax-0x10]
	vfmadd231ps ymm1,ymm3,YMMWORD PTR [rax-0xc]
	vfmadd231ps ymm1,ymm2,YMMWORD PTR [rax-0x8]
	vmovups YMMWORD PTR [rdx-0x20],ymm1
	cmp    rbx,rdx
	jne .L
