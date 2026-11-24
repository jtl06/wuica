**deps** · 3 arcs, 2 carried into a later iteration

| From           | To             | Iterations | Latency | Chain |
|----------------|----------------|-----------:|--------:|:-----:|
| `add rax, 0x1` | `add rax, 0x1` |          1 |       1 |  yes  |
| `add rax, 0x1` | `add rax, 0x1` |          0 |       1 |  yes  |
| `dec r15`      | `dec r15`      |          1 |         |       |
