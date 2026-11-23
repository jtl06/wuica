.intel_syntax noprefix
l: mov rax, [rip+0x100]
lea rbx, [rip+8]
mov [rip+0x200], rcx
cmp dword ptr [rip+0x20], 1
jne l
