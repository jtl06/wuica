**2.00 cycles/iteration** · SKL · Skylake (2015) · loop · bottleneck: Dependencies\
limits: DSB 1.00 · Issue 0.75 · Ports 1.00 · Dependencies 2.00\
next limit: DSB 1.00 (at most 2.00x faster without Dependencies)

critical chain (2 cycles of latency): `add rax, 0x1` (rax, 1) → `add rax, 0x1` (rax, 1)

| Instruction              | Notes | DSB | Issued | Exec. | Port 0 | Port 1 | Port 5 | Port 6 |
|--------------------------|:-----:|----:|-------:|------:|-------:|-------:|-------:|-------:|
| `add rax, 0x1`           |       |   1 |      1 |     1 |   0.22 |   0.22 |   0.29 |   0.27 |
| `add rax, 0x1`           |       |   1 |      1 |     1 |   0.28 |    0.3 |   0.23 |    0.2 |
| `dec r15`                |       |   1 |      1 |     1 |        |        |        |      1 |
| `jnz 0xfffffffffffffff5` |   M   |     |        |       |        |        |        |        |
| **Total**                |       |   3 |      3 |     3 |    0.5 |   0.52 |   0.52 |   1.47 |

```asm
loop:
  add rax, 1
  add rax, 1
  dec r15
  jnz loop
```

[open in wuica](https://example.invalid/#v=1)
