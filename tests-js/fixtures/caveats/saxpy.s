loop:
  vmovups ymm1, ymmword ptr [rdi + rax*4]
  vfmadd213ps ymm1, ymm0, ymmword ptr [rsi + rax*4]
  vmovups ymmword ptr [rsi + rax*4], ymm1
  add rax, 8
  cmp rax, rdx
  jb loop
