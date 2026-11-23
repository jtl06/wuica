.intel_syntax noprefix
.L:
	mov    eax,DWORD PTR [r13+rcx*1+0x0]
	add    rcx,0x4
	movzx  edx,al
	inc    DWORD PTR [rsp+rdx*4]
	movzx  edx,ah
	inc    DWORD PTR [rsp+rdx*4+0x400]
	mov    edx,eax
	shr    eax,0x18
	shr    edx,0x10
	inc    DWORD PTR [rsp+rax*4+0xc00]
	movzx  edx,dl
	inc    DWORD PTR [rsp+rdx*4+0x800]
	cmp    rcx,r12
	jb     .L
