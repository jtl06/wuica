# Accuracy of the experimental models: rounds 6 to 10

The results, changes and method of the model rounds before the current one, as they were written at the time. The current
numbers, the policy and the known errors are in [ACCURACY.md](ACCURACY.md).

## Round 10

"Before" is the fork's `improve-r9` at `640e40e` (branch `model-r9`), "after" is `improve-r10` at `7301b04` (branch `model-r10`).
With loop benchmarks on the Ryzen (`microbench/lb/r10a.txt` to `r10d.txt`), the round looked for the scheduler behavior behind two
ZEN3 errors left open in round 9: the scalar prefix sum and the shuffle-heavy vector loops. One mechanism was found and modeled (a
bypass delay between vector domains); the two errors themselves are not fixed.

### ZEN3 — measured on a Ryzen 7 7735U (Zen 3+)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout8) | 1956 | uiCA ZEN3, before | 76.3% | 85.6% | 94.7% | 3.9% |
|  |  | uiCA ZEN3, after | 76.4% | 85.7% | 94.8% | 3.8% |
|  |  | llvm-mca `znver3` | 43.3% | 56.0% | 75.9% | 17.0% |
| real-code blocks (bhive6) | 1895 | uiCA ZEN3, before | 85.6% | 88.8% | 92.8% | 3.9% |
|  |  | uiCA ZEN3, after | 85.6% | 88.8% | 92.8% | 3.9% |
|  |  | llvm-mca `znver3` | 67.4% | 71.3% | 80.7% | 11.6% |
| dogfood loops (gcc -O3, measured in the dogfood runs) | 21 | uiCA ZEN3, before |  | 57.1% |  |  |
|  |  | uiCA ZEN3, after |  | 57.1% |  |  |

### ADL-P — measured on a Core i7-12650H (P-core)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout8) | 1923 | uiCA ADL-P, before | 83.8% | 90.7% | 97.0% | 2.6% |
|  |  | uiCA ADL-P, after | 83.8% | 90.7% | 97.0% | 2.6% |
|  |  | uiCA RKL (original uiCA) | 43.4% | 48.0% | 67.2% | 17.6% |
|  |  | llvm-mca `alderlake` | 29.3% | 33.8% | 44.4% | 35.2% |
| real-code blocks (bhive6) | 1837 | uiCA ADL-P, before | 89.2% | 91.5% | 94.1% | 3.6% |
|  |  | uiCA ADL-P, after | 89.2% | 91.5% | 94.1% | 3.6% |
|  |  | uiCA RKL (original uiCA) | 68.0% | 70.4% | 75.7% | 12.2% |
|  |  | llvm-mca `alderlake` | 63.7% | 66.2% | 72.8% | 20.3% |

### ICX — measured on a Xeon Gold 6314U (Ice Lake-SP)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout8) | 1867 | uiCA ICX, before | 70.4% | 85.6% | 98.2% | 3.7% |
|  |  | uiCA ICX, after | 70.4% | 85.6% | 98.2% | 3.7% |
|  |  | uiCA ICL (original uiCA) | 65.1% | 78.7% | 93.1% | 6.3% |
|  |  | llvm-mca `icelake-server` | 42.2% | 54.7% | 71.0% | 22.5% |
| real-code blocks (bhive6) | 1869 | uiCA ICX, before | 82.0% | 88.2% | 96.2% | 3.3% |
|  |  | uiCA ICX, after | 82.0% | 88.2% | 96.2% | 3.3% |
|  |  | uiCA ICL (original uiCA) | 79.3% | 84.8% | 92.8% | 5.0% |
|  |  | llvm-mca `icelake-server` | 64.9% | 70.1% | 77.0% | 12.0% |

ADL-P and ICX are unchanged by construction (the change is in the ZEN3 configuration only).

### Change in round 10

- ZEN3: a vector value arrives one cycle later (`domainBypassDelay`) when it passes between the integer domain (`vpaddd`,
  `vpalignr`, shifts, blends, `vpmuludq`, ...), the floating-point domain (`vmulps`, `vmaxps`, `vandps`, FMA, ...) and the
  lane-crossing permutes `vperm2i128`/`vperm2f128`. Measured: 4-op chains alternating `vpaddd`/`vmaxps`, `vpalignr`/`vmaxps` or
  `vpalignr`/`vandps` take 8.0 cycles per iteration (predicted 4.0 before, 8.0 now), `vperm2i128`/`vpaddd` twice 12.95
  (8.0 -> 12.0); chains within one domain stay at 4.0. Development sets: dev13, dev11 and holdout5 +0.1 point each (7 loops
  fixed, none broken).

### Not fixed

The scalar prefix sum and the shuffle-heavy loops: see "Known errors and what was ruled out" in [ACCURACY.md](ACCURACY.md#known-errors-and-what-was-ruled-out).

Dogfood loops (ZEN3, measured / before / after): `fir8_s` 5.20 / 4.51 / 4.51, `fir8_s2` 6.66 / 5.26 / 5.41, `udiv_v` 7.31 / 5.20 /
5.33, `udiv_v2` 2.69 / 2.24 / 2.24, `psum_v2` 4.22 / 3.35 / 3.32, `psum` 1.00 / 1.36 / 1.36.

### Method of round 10

- **Held out**: random loops `holdout8` (`microbench/fuzz/fuzz_gen.py`, profile `mem`, seed 15, 2000 loops) and BHive blocks `bhive6`
  (seed 6, 250 per program, none in `bhive1`-`bhive5`), generated and measured on all three machines at the start of the round, scored
  once at the end. Measurement as in round 7.
- **Development**: loop benchmarks measured for this round (`microbench/lb/r10a.txt`-`r10d.txt`, loops called from C on buffers, the
  slope per iteration from perf cycles) and the dogfood loops. The bypass delay was checked against the earlier development and
  check sets (`dev13`, `dev11`, `holdout5`, the development half of `bhive1`, `bhive3`) and hand-written sets; none got worse.

## Round 9

"Before" is the fork's `improve-r8` at `c899be7` (the model of the previous wuica data, branch `model-r8`), "after" is `improve-r9`
at `640e40e` (the model of the branch `model-r9`). This round fixed bugs that two dogfood runs of wuica found by measuring real loops
on the Ryzen. The held-out sets check that nothing else got worse; the dogfood loops and new loop benchmarks measure the fixes.

### ZEN3 — measured on a Ryzen 7 7735U (Zen 3+)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout7) | 1960 | uiCA ZEN3, before | 74.8% | 84.4% | 93.7% | 4.2% |
|  |  | uiCA ZEN3, after | 74.8% | 84.4% | 93.7% | 4.2% |
|  |  | llvm-mca `znver3` | 42.9% | 55.2% | 75.3% | 18.0% |
| real-code blocks (bhive5) | 1941 | uiCA ZEN3, before | 85.0% | 87.7% | 93.4% | 3.9% |
|  |  | uiCA ZEN3, after | 85.0% | 87.7% | 93.4% | 3.9% |
|  |  | llvm-mca `znver3` | 68.4% | 71.8% | 80.8% | 12.1% |
| dogfood loops (gcc -O3, measured in the dogfood runs) | 21 | uiCA ZEN3, before |  | 47.6% |  |  |
|  |  | uiCA ZEN3, after |  | 57.1% |  |  |

### ADL-P — measured on a Core i7-12650H (P-core)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout7) | 1933 | uiCA ADL-P, before | 83.2% | 90.9% | 96.8% | 2.8% |
|  |  | uiCA ADL-P, after | 83.2% | 90.9% | 96.8% | 2.8% |
|  |  | uiCA RKL (original uiCA) | 42.7% | 47.1% | 66.3% | 16.8% |
|  |  | llvm-mca `alderlake` | 27.8% | 32.3% | 42.9% | 35.9% |
| real-code blocks (bhive5) | 1896 | uiCA ADL-P, before | 89.1% | 92.6% | 95.3% | 3.2% |
|  |  | uiCA ADL-P, after | 89.1% | 92.6% | 95.3% | 3.2% |
|  |  | uiCA RKL (original uiCA) | 68.6% | 71.3% | 77.1% | 13.6% |
|  |  | llvm-mca `alderlake` | 66.1% | 68.8% | 75.1% | 18.4% |

### ICX — measured on a Xeon Gold 6314U (Ice Lake-SP)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout7) | 1879 | uiCA ICX, before | 70.5% | 85.8% | 97.8% | 3.9% |
|  |  | uiCA ICX, after | 70.5% | 85.8% | 97.8% | 3.9% |
|  |  | uiCA ICL (original uiCA) | 63.3% | 78.4% | 92.5% | 6.3% |
|  |  | llvm-mca `icelake-server` | 41.0% | 53.0% | 71.4% | 22.5% |
| real-code blocks (bhive5) | 1928 | uiCA ICX, before | 82.7% | 89.7% | 96.9% | 3.0% |
|  |  | uiCA ICX, after | 82.7% | 89.7% | 96.9% | 3.0% |
|  |  | uiCA ICL (original uiCA) | 79.5% | 85.6% | 93.4% | 4.8% |
|  |  | llvm-mca `icelake-server` | 65.5% | 69.5% | 77.7% | 11.9% |

On the held-out sets no share changed: no prediction of holdout7 changed, and 20 ZEN3 predictions of bhive5 changed without moving
a block across the 10 % line. The random loops load from size-aligned addresses, store through registers that are not rewritten
between the stores and have no long FP dependency chains, so this round's rules do not apply to them.

### Changes in round 9

- ZEN3: the store-line rule (two stores per cycle only to the same cache line) compares the values of the address registers within an
  iteration (a version per register and an offset from added immediates), not their names. A byte histogram with 8
  `inc dword ptr [rsp+rdx*4+D]` and `movzx edx, ...` between them (dogfood `hist_c`): 8.00 cycles per iteration measured, predicted
  6.08 before (both store-data ports), 8.00 now.
- ZEN3, ADL-P, ICX: loads that cross a 64-byte line block their load port for 2, 3 and 2 cycles (`splitLoadCycles`). The rule
  applies where the loop's addresses make the crossing knowable: for loads whose address registers only change by adding
  immediates, the offsets and the stride are known, and the start address is assumed to have the alignment with the fewest
  crossings. gcc's 8-tap FIR (8 unaligned ymm loads, of which 3.7 cross a line per iteration as counted by
  `ls_misal_loads.ma64`): 5.85 measured, 4.10 -> 5.71; the same loads from a 64-byte aligned pointer: ZEN3 6.00 (4.00 -> 5.78),
  ADL-P 5.07 (2.67 -> 5.02), ICX 6.00 (4.00 -> 6.00). The three FIR variants are now ranked with the right winner (the
  2-aligned-loads + shuffle variant). Loads at constant addresses are not modeled, and neither is the longer latency of crossing
  loads (+1 cycle on the Ryzen, +6 to +7 on the Intel CPUs). The original Intel models are unchanged.
- ZEN3: at most 56 uops for the FP pipes wait in the FP scheduler; younger ones wait in order in the non-scheduling queue and cannot be
  dispatched before they enter it (`fpSchedulerSize`). A chain of 16 / 24 FMAs per iteration: 10.09 / 18.86 cycles measured,
  8.33 / 12.00 -> 9.12 / 18.27. Dogfood: AVX2 prefix sum 4.22 measured, 3.04 -> 3.35; vectorized division 7.31, 5.02 -> 5.20.

Not fixed (measured, see the fork's `microbench/lb/` and `microbench/measurements/lb/`):

- The scalar prefix sum (`add edx, [rdi+rax*4]; mov [rsi+rax*4], edx; inc rax; cmp rcx, rax; jne`): 1.00 measured, 1.36 predicted;
  a sum reduction without the store: 1.07, 1.55. In the model, the index chain (`inc rax`) loses ALU ports to the older accumulator
  chain, which falls behind by the load latency, so the loads come late. Measured: a fused CMP/TEST + Jcc takes no ALU slot (3 adds +
  `inc` + `cmp; jne`: 1.00 cycles, predicted 1.50), but all branches share two branch units, fused DEC + Jcc included. Moving fused
  CMP/TEST pairs to two branch ports fixed the first and broke loops with several branches (reverted); dispatching ALU uops to any free
  ALU (not bound at issue) fixed the prefix sums but lowered the random loops by 1.4 to 2.4 points; steering a uop to the port of its
  producer lowered them by 20 points.
- Shuffle-heavy vector loops are still 13–29% optimistic (dogfood `fir8_s`, `fir8_s2`, `udiv_v`, `udiv_v2`, `psum_v2`). Measured:
  8 `vmulps` + 6 `vpalignr` take 5.58 cycles (the model balances them over FP0-FP2 perfectly: 4.67); `vpermd` costs 1.33 cycles when
  two or more are in a loop, 1.00 alone, and less next to `vpaddd` (a throughput limit fit the loops with two or more and broke the
  others; not kept).

### Method of round 9

- **Held out**: random loops `holdout7` (`microbench/fuzz/fuzz_gen.py`, profile `mem`, seed 14, 2000 loops) and BHive blocks `bhive5`
  (seed 5, 250 per program, none in `bhive1`-`bhive4`), generated and measured on all three machines before any model change, scored
  once at the end.
- **Development**: the 21 dogfood loops (`microbench/dogfood/`, measured by the dogfood runs) and three sets of small loop benchmarks
  measured for this round (`microbench/lb/r9a.txt`, `r9b.txt`, `r9c.txt`: loops called from C on buffers, the slope per iteration from
  perf cycles); every change was checked against the earlier development and check sets (`dev13`, `dev11`, `holdout5`, the
  development half of `bhive1`, `bhive3`) and the hand-written sets, and kept only if none got worse.

## Round 8

"Before" is the fork's `improve-r7` at `f4a7868` (the model of the previous wuica data, branch `model-r7`), "after" is `improve-r8`
at `c899be7` (the model of the branch `model-r8`).

### ZEN3 — measured on a Ryzen 7 7735U (Zen 3+)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout6) | 1968 | uiCA ZEN3, before | 73.3% | 83.7% | 94.1% | 4.4% |
|  |  | uiCA ZEN3, after | 73.8% | 84.0% | 94.7% | 4.2% |
|  |  | llvm-mca `znver3` | 42.0% | 54.0% | 73.6% | 18.5% |
| real-code blocks (bhive4) | 1939 | uiCA ZEN3, before | 86.0% | 89.0% | 93.7% | 3.7% |
|  |  | uiCA ZEN3, after | 86.0% | 89.1% | 93.7% | 3.7% |
|  |  | llvm-mca `znver3` | 69.8% | 72.8% | 82.4% | 10.8% |

### ADL-P — measured on a Core i7-12650H (P-core)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout6) | 1922 | uiCA ADL-P, before | 83.2% | 90.5% | 96.5% | 2.7% |
|  |  | uiCA ADL-P, after | 83.2% | 90.5% | 96.5% | 2.7% |
|  |  | uiCA RKL (original uiCA) | 44.2% | 48.5% | 66.9% | 17.0% |
|  |  | llvm-mca `alderlake` | 28.2% | 32.8% | 44.6% | 35.2% |
| real-code blocks (bhive4) | 1884 | uiCA ADL-P, before | 90.5% | 93.7% | 95.9% | 2.9% |
|  |  | uiCA ADL-P, after | 90.5% | 93.7% | 95.9% | 2.9% |
|  |  | uiCA RKL (original uiCA) | 69.2% | 71.8% | 76.9% | 13.2% |
|  |  | llvm-mca `alderlake` | 68.2% | 71.5% | 77.7% | 17.5% |

### ICX — measured on a Xeon Gold 6314U (Ice Lake-SP)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout6) | 1855 | uiCA ICX, before | 69.8% | 84.4% | 97.4% | 4.0% |
|  |  | uiCA ICX, after | 70.1% | 84.6% | 97.5% | 4.0% |
|  |  | uiCA ICL (original uiCA) | 63.9% | 77.8% | 92.3% | 6.4% |
|  |  | llvm-mca `icelake-server` | 42.3% | 54.2% | 71.0% | 22.7% |
| real-code blocks (bhive4) | 1895 | uiCA ICX, before | 83.1% | 89.8% | 96.9% | 3.0% |
|  |  | uiCA ICX, after | 83.1% | 89.8% | 96.9% | 3.0% |
|  |  | uiCA ICL (original uiCA) | 80.4% | 86.4% | 93.7% | 4.7% |
|  |  | llvm-mca `icelake-server` | 69.9% | 74.5% | 81.4% | 10.1% |

Within 10% on the random loops: ZEN3 +0.3, ICX +0.2 points, ADL-P unchanged (no ADL-P change in this round); on the real-code
blocks ZEN3 +0.1, the others unchanged (the changes concern microcoded instructions and read-modify-write forms that are rare in
BHive). These are new sets, so the "before" numbers differ from round 7's "after" numbers on holdout5 and bhive3. On the development
set (dev13, not held out) the changes gave ZEN3 83.2 -> 84.2 %, ICX 86.5 -> 86.9 %. On the earlier random sets they gave ZEN3
dev11 81.7 -> 82.9, holdout5 83.1 -> 83.4, holdout4 84.6 -> 85.0, ICX dev11 87.2 -> 87.5, holdout4 85.8 -> 86.1. The fork's ICL
model (the original Intel model with the fork's instruction data) gives identical results before and after.

### Changes in round 8

- ZEN3: after a microcoded instruction (more than two macro-ops), the next op-cache entry delivers at most 4 macro-ops
  (`microcodeNextEntryOps`). Measured: 'vphaddw ymm4, ymm11, ymm13' (3 macro-ops) with K independent 'add r, 1' and dec/jnz takes
  2.00 cycles per iteration for K = 2-3, 2.67 for 4, 3.00 for 5-8 and 4.00 for 9-12; the same with NOPs or vector instructions instead
  of the adds, so the limit is the number of macro-ops, not the integer ALUs (`microbench/mb/mc8.txt`). Before, the model predicted
  2.00 up to K = 5.
- ZEN3: ADC and SBB on 8- or 16-bit memory form chains through memory of at least 7 cycles (uops.info: 5; measured 7.6 alone, 6.3-7.0
  in random loops).
- ICX: the loads of read-modify-write RCL and RCR get a store-forwarding delay of 4 instead of 5 ('rcl qword ptr [rsi+6656], cl' in a
  random loop: 11.1 cycles per iteration, predicted 13 before, 12 now).

Tried and not kept: the 7-cycle chain also for shifts and rotates on 8/16-bit memory on ZEN3, and the shorter forwarding delay for
all shifts and rotates on memory on ICX. Both helped the random loops of dev13 (ZEN3 +0.4, ICX +0.5 points) but made the hand-written
read-modify-write loops worse (ZEN3 82.9 -> 65.9 %, ICX 79.1 -> 58.9 % within 10 %), because alone or in short loops these chains
are longer than in random loops (on ICX the forwarding latency depends on timing, see round 4). Also tried: a limit of 3 or 5
macro-ops after microcode (dev13 83.3 / 83.6 % instead of 84.0 %), 8 cycles for the narrow chains, forwarding delay 3 for RCL/RCR
on ICX, and a lower latency through memory for ZEN3 CMPXCHG, CMPXCHG8B and CMPXCHG16B (measured 9.1-9.3, 9.7 and 14.5 cycles per
iteration, predicted 12, 11 and 18). For these CMPXCHG forms, lowering uops.info's memory latency by 3 or 4 changed no prediction,
so the chain that the model builds for them comes from elsewhere; this round did not find where. This round also found no ADL-P
change in the time it had: the mispredicted ADL-P loops of dev13 are spread thinly over many instructions.
`microbench/fuzz/ablate.py` was not run.

### Method of round 8

- **Random loops**: `microbench/fuzz/fuzz_gen.py` of the fork (profile `mem`), held-out set `holdout6` (seed 12, 2000 loops).
- **Real-code blocks**: BHive basic blocks (`microbench/real/bhive_gen.py`, seed 4, 250 blocks from each of 10 programs, none of
  them in the earlier sets `bhive1`-`bhive3`), held-out set `bhive4`.
- **Measurement**: as in round 7 (`perf stat`, user-mode cycles, pinned to one core, best of three runs, nothing else running on the
  machine, each run under an exclusive lease of the machine; unstable loops excluded).
- **Held out**: both sets were generated before any model change of this round, measured during the round without being looked at,
  and scored once, at the end (before and after), after the model was frozen. The changes were made on the development set
  `dev13` (seed 13), by grouping its mispredicted loops by probe instruction, and with hand-written loops
  (`microbench/mb/mc8.txt`). Each change was checked on the earlier random sets (`dev11`, `dev9`, `fresh`, `holdout4`,
  `holdout5`), the development half of `bhive1`, `bhive2`, `bhive3` and the hand-written sets (`clean3.py` read-modify-write sets,
  `mb/*.txt`). The full tables and reports are in the fork: `microbench/measurements/fuzz/{holdout6,bhive4}_table_r8.txt`.

## Round 7

"Before" is the fork's `improve-r6` at `21b0b17` (the model of the previous wuica data, branch `model-r6`), "after" is `improve-r7`
at `f4a7868` (the model of the branch `model-r7`).

### ZEN3 — measured on a Ryzen 7 7735U (Zen 3+)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout5) | 1954 | uiCA ZEN3, before | 72.9% | 82.8% | 92.7% | 4.6% |
|  |  | uiCA ZEN3, after | 72.9% | 83.0% | 93.1% | 4.5% |
|  |  | llvm-mca `znver3` | 41.4% | 54.5% | 74.8% | 18.1% |
| real-code blocks (bhive3) | 1931 | uiCA ZEN3, before | 85.8% | 88.7% | 92.5% | 4.0% |
|  |  | uiCA ZEN3, after | 85.9% | 88.8% | 92.7% | 4.0% |
|  |  | llvm-mca `znver3` | 67.5% | 70.6% | 80.5% | 11.5% |

### ADL-P — measured on a Core i7-12650H (P-core)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout5) | 1912 | uiCA ADL-P, before | 83.3% | 91.0% | 95.8% | 3.0% |
|  |  | uiCA ADL-P, after | 84.0% | 92.0% | 96.9% | 2.7% |
|  |  | uiCA RKL (original uiCA) | 41.0% | 45.0% | 63.7% | 18.2% |
|  |  | llvm-mca `alderlake` | 28.1% | 33.3% | 44.5% | 34.6% |
| real-code blocks (bhive3) | 1884 | uiCA ADL-P, before | 88.5% | 91.8% | 94.7% | 3.8% |
|  |  | uiCA ADL-P, after | 88.6% | 91.9% | 94.6% | 3.8% |
|  |  | uiCA RKL (original uiCA) | 66.1% | 68.9% | 75.1% | 14.6% |
|  |  | llvm-mca `alderlake` | 66.0% | 69.0% | 75.1% | 17.9% |

### ICX — measured on a Xeon Gold 6314U (Ice Lake-SP)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout5) | 1863 | uiCA ICX, before | 70.5% | 85.9% | 97.4% | 4.0% |
|  |  | uiCA ICX, after | 70.3% | 86.5% | 98.0% | 3.9% |
|  |  | uiCA ICL (original uiCA) | 65.6% | 80.0% | 93.7% | 6.1% |
|  |  | llvm-mca `icelake-server` | 41.9% | 53.9% | 71.8% | 21.8% |
| real-code blocks (bhive3) | 1906 | uiCA ICX, before | 81.2% | 88.3% | 95.5% | 3.7% |
|  |  | uiCA ICX, after | 81.2% | 88.4% | 95.5% | 3.7% |
|  |  | uiCA ICL (original uiCA) | 78.0% | 84.4% | 92.4% | 5.6% |
|  |  | llvm-mca `icelake-server` | 64.4% | 69.6% | 77.0% | 14.1% |

Within 10% on the random loops: ZEN3 +0.2, ADL-P +1.0, ICX +0.6 points; on the real-code blocks +0.1 for each model (the
changes concern instructions and patterns that are rare in BHive). On the development set (dev11, not held out) the same changes
gave ZEN3 81.0 -> 81.7%, ADL-P 89.4 -> 90.4%, ICX 86.3 -> 87.2%. The fork's ICL model (the original Intel model with the fork's
instruction data) gives identical results before and after.

### Changes in round 7

- ADL-P: when the renamer computed a register's value (immediate folding: 64-bit add/sub with an 8-bit immediate, inc, dec, lea
  with base and displacement), a shift or rotate (also SHLX, SHRX, SARX, RORX) gets that register two cycles later
  (`foldedShiftDelay`). Measured: 'add r13, 2; shl r13, 5' takes 3 cycles per iteration, 'add r13, 2; and r13, r8' 1.
- ICX: store-to-load forwarding into the load of a load-op instruction ('add rdx, [rsi]') takes 5 cycles instead of 4
  (`loadOpForwardDelay`).
- ZEN3: a move from a vector to a general-purpose register (pmovmskb, pextr*, cvt*2si, movd/movq r, xmm, ...) uses three more slots
  of the integer ALUs.
- Single instructions, measured as loops of one instruction: AESKEYGENASSIST, CMPXCHG8B, CMPXCHG16B throughput (ADL-P, ICX),
  SHA256RNDS2 and SHA256MSG1 latency (ADL-P, ICX), ROUNDSS/ROUNDSD latency through the destination and CVTPI2PD throughput (ZEN3).

Tried and not kept (development set dev11 or the checks did not improve): an extra cycle when the result of a fast FP add on ADL-P
goes to another kind of instruction (measured: 'addps xmm5, xmm1; maxps xmm5, xmm5' 7 cycles, predicted 6; no loop of dev11 changed),
merge latency 2 for setcc r8 / cmov r16 on ADL-P, PHADD/PHSUB latency 3 on ADL-P, a longer front-end hold after microcoded ZEN3
instructions, other delays for the folded values (CMOVcc/ADC +1, every consumer +1), load-op forwarding delay 6 on ICX, 1, 2 or 4
additional ALU slots for ZEN3 vector-to-GPR moves.

### Method of round 7

- **Random loops**: `microbench/fuzz/fuzz_gen.py` of the fork (profile `mem`), held-out set `holdout5` (seed 10, 2000 loops).
- **Real-code blocks**: BHive basic blocks (`microbench/real/bhive_gen.py`, seed 3, 250 blocks from each of 10 programs, none of
  them in the earlier sets `bhive1` and `bhive2`), held-out set `bhive3`.
- **Measurement**: as in round 6 (`perf stat`, user-mode cycles, pinned to one core, best of three runs, nothing else running on the
  machine; unstable loops excluded).
- **Held out**: both sets were generated and measured before any model change of this round and scored once, at the end (before and
  after). The changes were made on the development set `dev11` (seed 11), found by grouping its mispredicted loops by probe
  instruction and with `microbench/fuzz/ablate.py`, and confirmed with hand-written loops (`microbench/mb/instr7.txt`, `fold7.txt`).
  Each change was checked on the earlier random sets (`dev9`, `fresh`, `holdout2`-`holdout4`), the development half of `bhive1`,
  `bhive2` and the hand-written sets. The full tables and reports are in the fork:
  `microbench/measurements/fuzz/{holdout5,bhive3}_table_r7.txt`.

## Round 6

"Before" is the fork at `adf62ae` (the model of the earlier wuica data), "after" is `improve-r6` at `9bed908` (the model of
the branch `model-r6`). The merge of `9bed908` with the crash fixes, `21b0b17`, gives the same predictions on all these loops.

### ZEN3 — measured on a Ryzen 7 7735U (Zen 3+)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout4) | 1960 | uiCA ZEN3, before | 71.3% | 81.6% | 91.5% | 5.2% |
| | | uiCA ZEN3, after | 73.5% | 83.8% | 93.4% | 4.7% |
| | | llvm-mca `znver3` | 43.5% | 54.8% | 72.4% | 18.6% |
| real-code blocks (bhive2) | 1973 | uiCA ZEN3, before | 85.6% | 88.7% | 92.7% | 4.1% |
| | | uiCA ZEN3, after | 85.6% | 88.7% | 92.7% | 4.1% |
| | | llvm-mca `znver3` | 69.2% | 72.7% | 82.1% | 11.1% |

### ADL-P — measured on a Core i7-12650H (P-core)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout4) | 1916 | uiCA ADL-P, before | 81.5% | 89.0% | 95.3% | 3.2% |
| | | uiCA ADL-P, after | 82.5% | 89.8% | 96.1% | 3.0% |
| | | uiCA RKL (original uiCA) | 43.1% | 47.9% | 67.2% | 17.1% |
| | | llvm-mca `alderlake` | 27.9% | 33.7% | 43.2% | 36.2% |
| real-code blocks (bhive2) | 1908 | uiCA ADL-P, before | 89.3% | 92.1% | 95.3% | 3.3% |
| | | uiCA ADL-P, after | 89.4% | 92.3% | 95.3% | 3.3% |
| | | uiCA RKL (original uiCA) | 68.0% | 70.9% | 76.2% | 14.0% |
| | | llvm-mca `alderlake` | 66.0% | 68.7% | 74.9% | 18.1% |

### ICX — measured on a Xeon Gold 6314U (Ice Lake-SP)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout4) | 1873 | uiCA ICX, before | 69.7% | 83.8% | 96.7% | 4.1% |
| | | uiCA ICX, after | 70.7% | 84.7% | 96.7% | 4.0% |
| | | uiCA ICL (original uiCA) | 64.4% | 79.4% | 93.2% | 6.2% |
| | | llvm-mca `icelake-server` | 41.3% | 53.4% | 69.0% | 23.8% |
| real-code blocks (bhive2) | 1936 | uiCA ICX, before | 82.8% | 89.6% | 96.8% | 3.2% |
| | | uiCA ICX, after | 82.8% | 89.6% | 96.8% | 3.2% |
| | | uiCA ICL (original uiCA) | 79.8% | 85.5% | 93.2% | 4.9% |
| | | llvm-mca `icelake-server` | 65.5% | 71.2% | 78.8% | 11.7% |

### Changes in round 6

- ZEN3: an instruction with more than two macro-ops is microcoded; it ends its op-cache entry, and the front end delivers nothing
  else while the microcode sequencer delivers its macro-ops (4 per cycle).
- ADL-P: uops.info's port data for indexed memory operands lacks the non-memory uops of about 3200 instruction forms; for these
  forms the ports of the non-indexed form are used instead. Store-to-load forwarding into loads that are not memory-renamed takes 5
  cycles instead of 4.
- ICX: measured latencies on the Xeon for horizontal add/subtract (+1 cycle) and dot products (DPPS +2, DPPD +1).

### Method of round 6

- **Random loops**: generated by `microbench/fuzz/fuzz_gen.py` of the fork (profile `mem`, seed 8): a few integer instructions,
  one or two probe instructions that cycle through all usable mnemonics, loads, stores and store/reload pairs, and a loop branch.
- **Real-code blocks**: basic blocks of the [BHive](https://github.com/ithemal/bhive) benchmark (`microbench/real/bhive_gen.py`,
  seed 2, 250 blocks from each of 10 programs, none of them in the earlier set), each run as the body of a loop with registers
  pointing into mapped memory. Blocks that crash, and prologue/epilogue blocks whose stack pointer moves every iteration, are
  excluded.
- **Measurement**: cycles per iteration with `perf stat` (user-mode cycles), pinned to one core, best of three runs, with nothing
  else running on the machine; loops whose two fastest runs differ by more than 2% or whose instruction count is off are excluded.
- **Held out**: both sets were generated and measured before any model change of this round and scored exactly twice, before and
  after. The changes were made on other sets (development set: seed 9; checks: earlier random sets and half of the earlier
  real-code set).
- All tools are compared on the same loops (those for which every tool gives a prediction). The full tables and reports are in the
  fork: `microbench/measurements/fuzz/{holdout4,bhive2}_table_*.txt`.
