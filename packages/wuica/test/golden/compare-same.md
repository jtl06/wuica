**A 16.00 · B 16.00 cycles per iteration** (the same)\
bottleneck: Dependencies (both)

| Limit          |     A |     B |   Δ |
|----------------|------:|------:|----:|
| DSB            |  1.67 |  1.67 |     |
| Issue          |  3.50 |  3.50 |     |
| Ports          |  4.00 |  4.00 |     |
| Dependencies * | 16.00 | 16.00 |     |

|     | A                                                      | B                                                      | Δ uops | Δ Port 0 | Δ Port 1 | Δ Port 2 | Δ Port 3 | Δ Port 5 | Δ Port 6 |
|:---:|--------------------------------------------------------|--------------------------------------------------------|-------:|---------:|---------:|---------:|---------:|---------:|---------:|
|     | `vmovups ymm4, ymmword ptr [rdi+rax*4]`                | `vmovups ymm4, ymmword ptr [rdi+rax*4]`                |        |          |          |          |          |          |          |
|     | `vmovups ymm5, ymmword ptr [rdi+rax*4+0x20]`           | `vmovups ymm5, ymmword ptr [rdi+rax*4+0x20]`           |        |          |          |          |          |          |          |
|     | `vmovups ymm6, ymmword ptr [rdi+rax*4+0x40]`           | `vmovups ymm6, ymmword ptr [rdi+rax*4+0x40]`           |        |          |          |          |          |          |          |
|     | `vmovups ymm7, ymmword ptr [rdi+rax*4+0x60]`           | `vmovups ymm7, ymmword ptr [rdi+rax*4+0x60]`           |        |          |          |          |          |          |          |
|     | `vfmadd231ps ymm0, ymm4, ymmword ptr [rsi+rax*4]`      | `vfmadd231ps ymm0, ymm4, ymmword ptr [rsi+rax*4]`      |        |          |          |          |          |          |          |
|     | `vfmadd231ps ymm0, ymm5, ymmword ptr [rsi+rax*4+0x20]` | `vfmadd231ps ymm0, ymm5, ymmword ptr [rsi+rax*4+0x20]` |        |          |          |          |          |          |          |
|     | `vfmadd231ps ymm0, ymm6, ymmword ptr [rsi+rax*4+0x40]` | `vfmadd231ps ymm0, ymm6, ymmword ptr [rsi+rax*4+0x40]` |        |          |          |          |          |          |          |
|     | `vfmadd231ps ymm0, ymm7, ymmword ptr [rsi+rax*4+0x60]` | `vfmadd231ps ymm0, ymm7, ymmword ptr [rsi+rax*4+0x60]` |        |          |          |          |          |          |          |
|     | `add rax, 0x20`                                        | `add rax, 0x20`                                        |        |          |          |          |          |          |          |
|     | `cmp rax, rdx`                                         | `cmp rax, rdx`                                         |        |          |          |          |          |          |          |
|     | `jb 0xffffffffffffffc7`                                | `jb 0xffffffffffffffc7`                                |        |          |          |          |          |          |          |
|     | **Total**                                              |                                                        |        |          |          |          |          |          |          |

no change; Δ: B − A, uops per iteration
