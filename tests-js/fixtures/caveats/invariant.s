.L:
  add dword ptr [rdi+rcx*4], eax
  dec r8
  jnz .L
