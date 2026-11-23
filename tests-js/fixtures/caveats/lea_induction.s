.L:
  lea rsi, [rsi+4]
  add dword ptr [rsi+rax*4], 1
  dec r8
  jnz .L
