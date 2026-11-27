        .file   "example.c"
        .text
        .p2align 4
        .globl  scale_add
        .type   scale_add, @function
scale_add:
        movq    %rdx, %r8
        testq   %rdx, %rdx
        jle     .L12
        movq    %rdi, %rdx
        xorl    %eax, %eax
        jmp     .L3
        .p2align 5
        .p2align 4,,10
        .p2align 3
.L4:
        vmovss  (%rdx), %xmm1
        vfmadd213ss     (%rsi,%rax,4), %xmm0, %xmm1
        incq    %rax
        addq    $4, %rdx
        vmovss  %xmm1, -4(%rdx)
        cmpq    %rax, %r8
        je      .L12
.L3:
        testb   $31, %dl
        jne     .L4
        leaq    7(%rax), %rdx
        cmpq    %rdx, %r8
        jle     .L8
        leaq    -8(%r8), %rdx
        leaq    8(%rax), %rcx
        vbroadcastss    %xmm0, %ymm2
        subq    %rax, %rdx
        andq    $-8, %rdx
        addq    %rcx, %rdx
        jmp     .L6
        .p2align 5
        .p2align 4,,10
        .p2align 3
.L14:
        addq    $8, %rcx
.L6:
        vmovaps (%rdi,%rax,4), %ymm1
        vfmadd213ps     (%rsi,%rax,4), %ymm2, %ymm1
        vmovaps %ymm1, (%rdi,%rax,4)
        movq    %rcx, %rax
        cmpq    %rdx, %rcx
        jne     .L14
        vzeroupper
.L5:
        cmpq    %rdx, %r8
        jle     .L12
        .p2align 5
        .p2align 4,,10
        .p2align 3
.L7:
        vmovss  (%rdi,%rdx,4), %xmm1
        vfmadd213ss     (%rsi,%rdx,4), %xmm0, %xmm1
        vmovss  %xmm1, (%rdi,%rdx,4)
        incq    %rdx
        cmpq    %rdx, %r8
        jne     .L7
.L12:
        ret
.L8:
        movq    %rax, %rdx
        jmp     .L5
        .size   scale_add, .-scale_add
        .ident  "GCC: (Compiler-Explorer-Build-gcc--binutils-2.44) 16.2.0"
        .section        .note.GNU-stack,"",@progbits
