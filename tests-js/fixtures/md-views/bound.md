**bound** · 2.00 cycles/iteration · binding Dependencies · next DSB 1.00 (at most 2.00× faster)

| resource     | group | cycles/iteration | busy | binding |
|:-------------|:------|-----------------:|-----:|:-------:|
| DSB          | front |             1.00 |  50% |         |
| Issue        | issue |             0.75 |  38% |         |
| Ports        | ports |             1.00 |  50% |         |
| Dependencies | deps  |             2.00 | 100% |   yes   |
| p0           | ports |             0.50 |  25% |         |
| p1           | ports |             0.52 |  26% |         |
| p5           | ports |             0.52 |  26% |         |
| p6           | ports |             1.47 |  73% |         |

top of Dependencies (by cycles):

| instruction    | share |
|:---------------|------:|
| `add rax, 0x1` |   50% |
| `add rax, 0x1` |   50% |
