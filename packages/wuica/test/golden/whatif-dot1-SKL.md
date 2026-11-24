**What if (SKL)**, cycles per original iteration (base 16.00)

| Variant          | Cycles |      Δ | Speedup | Note                                |
|------------------|-------:|-------:|--------:|-------------------------------------|
| unroll ×2        |  16.00 |   0.00 |   1.00x |                                     |
| unroll ×4        |  16.00 |   0.00 |   1.00x |                                     |
| unroll ×8        |  16.00 |   0.00 |   1.00x |                                     |
| 2 accumulators   |   8.00 |  -8.00 |   2.00x |                                     |
| 3 accumulators   |   5.33 | -10.67 |   3.00x |                                     |
| 4 accumulators   |   4.00 | -12.00 |   4.00x |                                     |
| 8 accumulators   |  ≈4.00 | -12.00 |   4.00x | at its Ports limit (simulated 3.98) |
| simple front end |  16.00 |   0.00 |   1.00x |                                     |
| no macro-fusion  |  16.00 |   0.00 |   1.00x |                                     |
| no micro-fusion  |  16.00 |   0.00 |   1.00x |                                     |
| no chain         | >=4.00 | -12.00 |   4.00x | estimate                            |

best number of accumulators: 4
