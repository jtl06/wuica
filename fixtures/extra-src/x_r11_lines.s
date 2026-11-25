.intel_syntax noprefix
l:
vfmadd231ps ymm0, ymm1, [rdi+0x100]
vfmadd231ps ymm2, ymm3, [rdi+0x120]
add rdi, 0x40
add rax, 0x12345678
dec rcx
jne l
