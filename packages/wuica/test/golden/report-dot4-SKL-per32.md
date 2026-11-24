**0.13 cycles/element** (4.00 cycles/iteration, 32 elements per iteration) · SKL · loop · bottleneck: Dependencies, Ports\
limits: DSB 0.0522 · Issue 0.11 · Ports 0.13 · Dependencies 0.13\
next limit: Issue 0.11 (at most 1.14x faster without Dependencies, Ports)

critical chain (4 cycles of latency): `vfmadd231ps ymm0, ymm4, ymmword ptr [rsi+rax*4]` (ymm0, 4)

| Instruction                                            | Notes | DSB | Issued | Exec. | Port 0 | Port 1 | Port 2 | Port 3 | Port 5 | Port 6 |
|--------------------------------------------------------|:-----:|----:|-------:|------:|-------:|-------:|-------:|-------:|-------:|-------:|
| `vmovups ymm4, ymmword ptr [rdi+rax*4]`                |       |   1 |      1 |     1 |        |        |      1 |        |        |        |
| `vmovups ymm5, ymmword ptr [rdi+rax*4+0x20]`           |       |   1 |      1 |     1 |        |        |        |      1 |        |        |
| `vmovups ymm6, ymmword ptr [rdi+rax*4+0x40]`           |       |   1 |      1 |     1 |        |        |      1 |        |        |        |
| `vmovups ymm7, ymmword ptr [rdi+rax*4+0x60]`           |       |   1 |      1 |     1 |        |        |        |      1 |        |        |
| `vfmadd231ps ymm0, ymm4, ymmword ptr [rsi+rax*4]`      |       |   1 |      2 |     2 |   0.58 |   0.42 |      1 |        |        |        |
| `vfmadd231ps ymm1, ymm5, ymmword ptr [rsi+rax*4+0x20]` |       |   1 |      2 |     2 |   0.58 |   0.42 |        |      1 |        |        |
| `vfmadd231ps ymm2, ymm6, ymmword ptr [rsi+rax*4+0x40]` |       |   1 |      2 |     2 |   0.47 |   0.53 |      1 |        |        |        |
| `vfmadd231ps ymm3, ymm7, ymmword ptr [rsi+rax*4+0x60]` |       |   1 |      2 |     2 |   0.38 |   0.62 |        |      1 |        |        |
| `add rax, 0x20`                                        |       |   1 |      1 |     1 |        |        |        |        |      1 |        |
| `cmp rax, rdx`                                         |       |   1 |      1 |     1 |        |        |        |        |        |      1 |
| `jb loop`                                              |   M   |     |        |       |        |        |        |        |        |        |
| **Total**                                              |       |  10 |     14 |    14 |   2.02 |   1.98 |      4 |      4 |      1 |      1 |
