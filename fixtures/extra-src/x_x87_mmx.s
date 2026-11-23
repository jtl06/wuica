.intel_syntax noprefix
l: fld qword ptr [rsi]
faddp st(1), st
fxch st(2)
fstp qword ptr [rdi]
paddq mm0, mm1
movq mm2, [rsi]
emms
dec r15
jnz l
