  fldz
.L:
  fld tbyte ptr [rdi]
  faddp st(1), st
  add rdi, 16
  dec rsi
  jne .L
