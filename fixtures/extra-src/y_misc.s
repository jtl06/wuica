.intel_syntax noprefix
l: ud2
syscall
hlt
add rax, rbx
vzeroupper
emms
cpuid
xgetbv
rdtscp
mfence
sfence
lfence
clflush [rax]
prefetcht0 [rax]
prefetchw [rax]
xlatb
cld
std
clc
stc
cmc
movbe rax, [rsi]
crc32 eax, bl
bswap rax
xchg rax, rbx
xchg [rsi], rax
cmpxchg16b [rsi]
lock add [rsi], rax
lock cmpxchg [rsi], rcx
lock inc dword ptr [rsi+rdi]
mul rbx
div rcx
idiv r8d
div byte ptr [rsi]
imul rax, rbx, 100
imul rcx
cqo
cdq
cwde
rdrand rax
xsave [rsi]
wrmsr
int3
dec r15
jnz l
