.intel_syntax noprefix
l: shl rax, 1
adc rbx, rcx
shr rdx, 5
rcl rax, 1
rcr rbx, cl
rcl rdx, 3
shld rax, rbx, 3
shrd rcx, rdx, cl
bt rax, rbx
setc al
cmovc rax, rbx
sahf
lahf
shlx rax, rbx, rcx
sarx r8, [rsi], r9
rorx rax, rbx, 5
shl byte ptr [rsi], cl
sar qword ptr [rdi+8], 1
rol dword ptr [rdx], 3
adc [rsi], rax
sbb rax, [rdi]
adcx rax, rbx
adox rcx, rdx
mulx rax, rbx, rcx
dec r15
jnz l
