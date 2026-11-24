.L1:
  add rax, qword ptr [rdi]
  addq $8, %rdi
  dec rcx
  jnz .L1
