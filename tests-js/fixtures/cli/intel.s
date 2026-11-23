.L1:
  add rax, qword ptr [rdi]
  add rdi, 8
  dec rcx
  jnz .L1
