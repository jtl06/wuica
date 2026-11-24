	.intel_syntax noprefix
.L1:
  addq (%rdi), %rax
  addq $8, %rdi
  decq %rcx
  jnz .L1
