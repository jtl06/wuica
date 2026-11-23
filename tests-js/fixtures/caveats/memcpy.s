.L:
  mov rcx, qword ptr [rsi+rax*8]
  mov qword ptr [rdi+rax*8], rcx
  inc rax
  cmp rax, rdx
  jne .L
