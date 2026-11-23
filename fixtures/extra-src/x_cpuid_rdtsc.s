.intel_syntax noprefix
l: cpuid
rdtsc
shl rdx, 32
or rax, rdx
dec r15
jnz l
