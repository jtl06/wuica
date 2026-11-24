**What if (SKL)**, cycles per element (8 per original iteration; base 2.00)

| Variant          | Cycles |     Δ | Speedup | Note     |
|------------------|-------:|------:|--------:|----------|
| unroll ×2        |   2.00 |  0.00 |   1.00x |          |
| unroll ×4        |   2.00 |  0.00 |   1.00x |          |
| unroll ×8        |   2.00 |  0.00 |   1.00x |          |
| 2 accumulators   |   1.00 | -1.00 |   2.00x |          |
| 3 accumulators   |   0.67 | -1.33 |   3.00x |          |
| 4 accumulators   |   0.50 | -1.50 |   4.00x |          |
| 8 accumulators   |   0.50 | -1.50 |   4.02x |          |
| simple front end |   2.00 |  0.00 |   1.00x |          |
| no macro-fusion  |   2.00 |  0.00 |   1.00x |          |
| no micro-fusion  |   2.00 |  0.00 |   1.00x |          |
| no chain         | >=0.50 | -1.50 |   4.00x | estimate |

best number of accumulators: 4
