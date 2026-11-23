.intel_syntax noprefix
l: nop
.rept 30
cmp rax, rbx
jz l
test ecx, ecx
jl l
sub rdx, 1
ja l
.endr
