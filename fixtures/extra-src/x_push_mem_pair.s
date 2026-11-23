# Two stores without a displacement (the stack slots of PUSH m) at the heads of the port-4 and port-9 queues (ICL, TGL, RKL,
# ICX, ADL-P). Upstream uiCA failed with TypeError (None - None) in Scheduler.dispatchUops; found by the fuzzer.
.intel_syntax noprefix
l: push qword ptr [rax]
push qword ptr [rax]
dec ecx
jnz l
