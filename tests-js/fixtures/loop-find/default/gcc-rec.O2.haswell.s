        .file   "example.c"
        .text
        .p2align 4
        .globl  rec
        .type   rec, @function
rec:
        vmovapd %xmm0, %xmm2
        testq   %rdx, %rdx
        jle     .L6
        vxorps  %xmm3, %xmm3, %xmm3
        xorl    %eax, %eax
        vxorpd  %xmm0, %xmm0, %xmm0
        .p2align 6
        .p2align 4,,10
        .p2align 3
.L3:
        vmovsd  (%rdi,%rax,8), %xmm1
        vandpd  .LC1(%rip), %xmm1, %xmm1
        vfmadd132sd     %xmm2, %xmm1, %xmm0
        vcvtsi2sdl      (%rsi,%rax,4), %xmm3, %xmm1
        incq    %rax
        vsubsd  %xmm1, %xmm0, %xmm0
        cmpq    %rax, %rdx
        jne     .L3
        testq   %r8, %r8
        jle     .L7
.L11:
        movabsq $-3750763034362895579, %rax
        movq    %r8, %rdi
        xorl    %esi, %esi
        salq    $5, %rdi
        subq    %r8, %rdi
        movabsq $1099511628211, %r8
        .p2align 6
        .p2align 4,,10
        .p2align 3
.L5:
        movzbl  (%rcx), %edx
        incq    %rcx
        xorq    %rax, %rdx
        imulq   %r8, %rdx
        movq    %rdx, %rax
        shrq    $29, %rax
        xorq    %rdx, %rax
        addq    %rsi, %rax
        addq    $31, %rsi
        rorx    $57, %rax, %rax
        cmpq    %rsi, %rdi
        jne     .L5
        movq    %rax, (%r9)
        ret
        .p2align 4,,10
        .p2align 3
.L6:
        vxorpd  %xmm0, %xmm0, %xmm0
        testq   %r8, %r8
        jg      .L11
.L7:
        movabsq $-3750763034362895579, %rax
        movq    %rax, (%r9)
        ret
        .size   rec, .-rec
        .section        .rodata.cst16,"aM",@progbits,16
        .align 16
.LC1:
        .long   -1
        .long   2147483647
        .long   0
        .long   0
        .ident  "GCC: (Compiler-Explorer-Build-gcc--binutils-2.44) 16.2.0"
        .section        .note.GNU-stack,"",@progbits
