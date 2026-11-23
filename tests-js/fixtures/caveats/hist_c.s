.intel_syntax noprefix
.L:
	mov    rax,QWORD PTR [r13+rcx*1+0x0]
	add    rcx,0x8
	movzx  edx,al
	inc    DWORD PTR [rsp+rdx*4]
	movzx  edx,ah
	inc    DWORD PTR [rsp+rdx*4+0x400]
	mov    rdx,rax
	shr    rdx,0x10
	movzx  edx,dl
	inc    DWORD PTR [rsp+rdx*4+0x800]
	mov    edx,eax
	shr    edx,0x18
	inc    DWORD PTR [rsp+rdx*4+0xc00]
	mov    rdx,rax
	shr    rdx,0x20
	movzx  edx,dl
	inc    DWORD PTR [rsp+rdx*4]
	mov    rdx,rax
	shr    rdx,0x28
	movzx  edx,dl
	inc    DWORD PTR [rsp+rdx*4+0x400]
	mov    rdx,rax
	shr    rax,0x38
	shr    rdx,0x30
	inc    DWORD PTR [rsp+rax*4+0xc00]
	movzx  edx,dl
	inc    DWORD PTR [rsp+rdx*4+0x800]
	cmp    rcx,r12
	jb     .L
