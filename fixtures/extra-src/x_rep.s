.intel_syntax noprefix
l: mov rcx, 16
rep movsb
mov rcx, 4
rep stosq
cld
dec r15
jnz l
