.intel_syntax noprefix
l: call rax
call qword ptr [rax]
call qword ptr [rsp+8]
call l
ret
ret 8
jmp rax
jmp qword ptr [rsp]
jmp qword ptr [rax+rbx*8]
jmp l
