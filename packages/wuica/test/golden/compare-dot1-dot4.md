**A 0.50 · B 0.13 cycles per element** (Δ −0.38, −75%) (A: SKL, B: SKL)\
bottleneck: A Dependencies → B Dependencies, Ports

| Limit          |      A |      B |     Δ |
|----------------|-------:|-------:|------:|
| DSB            | 0.0522 | 0.0522 |       |
| Issue          |   0.11 |   0.11 |       |
| Ports *        |   0.13 |   0.13 |       |
| Dependencies * |   0.50 |   0.13 | −0.38 |

|     | A                                                      | B                                                      | Δ uops | Δ Port 0 | Δ Port 1 | Δ Port 2 | Δ Port 3 | Δ Port 5 | Δ Port 6 |
|:---:|--------------------------------------------------------|--------------------------------------------------------|-------:|---------:|---------:|---------:|---------:|---------:|---------:|
|     | `vmovups ymm4, ymmword ptr [rdi+rax*4]`                | `vmovups ymm4, ymmword ptr [rdi+rax*4]`                |        |          |          |          |          |          |          |
|     | `vmovups ymm5, ymmword ptr [rdi+rax*4+0x20]`           | `vmovups ymm5, ymmword ptr [rdi+rax*4+0x20]`           |        |          |          |          |          |          |          |
|     | `vmovups ymm6, ymmword ptr [rdi+rax*4+0x40]`           | `vmovups ymm6, ymmword ptr [rdi+rax*4+0x40]`           |        |          |          |          |          |          |          |
|     | `vmovups ymm7, ymmword ptr [rdi+rax*4+0x60]`           | `vmovups ymm7, ymmword ptr [rdi+rax*4+0x60]`           |        |          |          |          |          |          |          |
|  •  | `vfmadd231ps ymm0, ymm4, ymmword ptr [rsi+rax*4]`      | `vfmadd231ps ymm0, ymm4, ymmword ptr [rsi+rax*4]`      |        |    −0.08 |    +0.08 |          |          |          |          |
|  ~  | `vfmadd231ps ymm0, ymm5, ymmword ptr [rsi+rax*4+0x20]` | `vfmadd231ps ymm1, ymm5, ymmword ptr [rsi+rax*4+0x20]` |        |    +0.18 |    −0.18 |          |          |          |          |
|  ~  | `vfmadd231ps ymm0, ymm6, ymmword ptr [rsi+rax*4+0x40]` | `vfmadd231ps ymm2, ymm6, ymmword ptr [rsi+rax*4+0x40]` |        |    +0.13 |    −0.13 |          |          |          |          |
|  ~  | `vfmadd231ps ymm0, ymm7, ymmword ptr [rsi+rax*4+0x60]` | `vfmadd231ps ymm3, ymm7, ymmword ptr [rsi+rax*4+0x60]` |        |    −0.35 |    +0.35 |          |          |          |          |
|  •  | `add rax, 0x20`                                        | `add rax, 0x20`                                        |        |          |          |          |          |     +0.8 |     −0.8 |
|     | `cmp rax, rdx`                                         | `cmp rax, rdx`                                         |        |          |          |          |          |          |          |
|     | `jb 0xffffffffffffffc7`                                | `jb 0xffffffffffffffc7`                                |        |          |          |          |          |          |          |
|     | **Total**                                              |                                                        |        |    −0.12 |    +0.12 |          |          |     +0.8 |     −0.8 |

• same instruction, other uops · ~ changed operands; Δ: B − A, uops per iteration

| CPU   |    A |    B |     Δ |    % |
|-------|-----:|-----:|------:|-----:|
| SKL   | 0.50 | 0.13 | −0.38 | −75% |
| ZEN3  | 0.50 | 0.13 | −0.38 | −75% |
| ADL-P | 0.50 | 0.13 | −0.38 | −75% |
