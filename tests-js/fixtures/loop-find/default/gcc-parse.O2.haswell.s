        .file   "example.c"
        .text
        .p2align 4
        .globl  parse
        .type   parse, @function
parse:
        jmp     .L14
        .p2align 4
        .p2align 4,,10
        .p2align 3
.L11:
        incq    %rdi
.L14:
        movsbl  (%rdi), %eax
        cmpb    $32, %al
        je      .L11
        cmpb    $9, %al
        je      .L11
        subl    $48, %eax
        xorl    %edx, %edx
        cmpl    $9, %eax
        ja      .L1
        .p2align 5
        .p2align 4,,10
        .p2align 3
.L6:
        leaq    (%rdx,%rdx,4), %rdx
        incq    %rdi
        leaq    (%rax,%rdx,2), %rdx
        movsbl  (%rdi), %eax
        subl    $48, %eax
        cmpl    $9, %eax
        jbe     .L6
.L1:
        movq    %rdx, %rax
        ret
        .size   parse, .-parse
        .ident  "GCC: (Compiler-Explorer-Build-gcc--binutils-2.44) 16.2.0"
        .section        .note.GNU-stack,"",@progbits
