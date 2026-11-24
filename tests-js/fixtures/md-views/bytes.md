**bytes** · 13 bytes from offset 0 · crossing 16 B: 0, 32 B: 0, 64 B: 0

| Instruction    | Start | Bytes | Crosses | Notes |
|----------------|------:|------:|---------|-------|
| `add rax, 0x1` |   0x0 |     4 |         |       |
| `add rax, 0x1` |   0x4 |     4 |         |       |
| `dec r15`      |   0x8 |     3 |         |       |
| `jnz loop`     |   0xb |     2 |         | fused |
