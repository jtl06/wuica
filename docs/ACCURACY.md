# Accuracy of the experimental models

wuica reproduces the Python uiCA of the fork [jtl06/uiCA](https://github.com/jtl06/uiCA) exactly, so these numbers hold for both.
They cover the three models that the fork adds: **ZEN3** (AMD Zen 3), **ADL-P** (Alder Lake P-cores) and **ICX** (Ice Lake
server). Each was measured on one machine. The rounds below do not change the original Intel models of uiCA (their predictions on
the test corpus are identical before and after), and they are not measured here; "original uiCA" in the tables is the upstream
uiCA with its own instruction data, used as a reference.

Percentages are the share of loops whose predicted throughput is within 5, 10 or 20% of the measured one; MAPE is the mean absolute
percentage error. All tools are compared on the same loops (those for which every tool gives a prediction).

## Round 8 (current model)

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
set (dev13, not held out) the changes gave ZEN3 83.2 -> 84.2%, ICX 86.5 -> 86.9%, and on the earlier random sets ZEN3 dev11 81.7 ->
82.9, holdout5 83.1 -> 83.4, holdout4 84.6 -> 85.0, ICX dev11 87.2 -> 87.5, holdout4 85.8 -> 86.1. The fork's ICL model (the original
Intel model with the fork's instruction data) gives identical results before and after.

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
read-modify-write loops worse (ZEN3 82.9 -> 65.9%, ICX 79.1 -> 58.9% within 10%): alone or in short loops these chains are longer than
in random loops (on ICX the forwarding latency depends on timing, see round 4). Also tried: a limit of 3 or 5 macro-ops after
microcode (dev13 83.3 / 83.6% instead of 84.0%), 8 cycles for the narrow chains, forwarding delay 3 for RCL/RCR on ICX, and a lower
latency through memory for ZEN3 CMPXCHG, CMPXCHG8B and CMPXCHG16B (measured 9.1-9.3, 9.7 and 14.5 cycles per iteration, predicted
12, 11 and 18): lowering uops.info's memory latency by 3 or 4 changed no prediction, so the chain that the model builds for these
instructions comes from elsewhere (not found in this round). No ADL-P change was found in the time of this round (its mispredicted
loops of dev13 are spread thinly over many instructions); `microbench/fuzz/ablate.py` was not run.

### Method of round 8

- **Random loops**: `microbench/fuzz/fuzz_gen.py` of the fork (profile `mem`), held-out set `holdout6` (seed 12, 2000 loops).
- **Real-code blocks**: BHive basic blocks (`microbench/real/bhive_gen.py`, seed 4, 250 blocks from each of 10 programs, none of
  them in the earlier sets `bhive1`-`bhive3`), held-out set `bhive4`.
- **Measurement**: as in round 7 (`perf stat`, user-mode cycles, pinned to one core, best of three runs, nothing else running on the
  machine, each run under an exclusive lease of the machine; unstable loops excluded).
- **Held out**: both sets were generated before any model change of this round, measured during the round without being looked at,
  and scored once, at the end (before and after), after the model was frozen. The changes were made on the development set
  `dev13` (seed 13): grouping its mispredicted loops by probe instruction, and hand-written loops (`microbench/mb/mc8.txt`); each was
  checked on the earlier random sets (`dev11`, `dev9`, `fresh`, `holdout4`, `holdout5`), the development half of `bhive1`, `bhive2`,
  `bhive3` and the hand-written sets (`clean3.py` read-modify-write sets, `mb/*.txt`). The full tables and reports are in the fork:
  `microbench/measurements/fuzz/{holdout6,bhive4}_table_r8.txt`.

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

- ADL-P: a shift or rotate (also SHLX, SHRX, SARX, RORX) gets a register whose value the renamer computed (immediate folding: 64-bit
  add/sub with an 8-bit immediate, inc, dec, lea with base and displacement) two cycles later (`foldedShiftDelay`). Measured: 'add
  r13, 2; shl r13, 5' takes 3 cycles per iteration, 'add r13, 2; and r13, r8' 1.
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
  instruction and with `microbench/fuzz/ablate.py`, and confirmed with hand-written loops (`microbench/mb/instr7.txt`, `fold7.txt`);
  each was checked on the earlier random sets (`dev9`, `fresh`, `holdout2`-`holdout4`), the development half of `bhive1`, `bhive2`
  and the hand-written sets. The full tables and reports are in the fork: `microbench/measurements/fuzz/{holdout5,bhive3}_table_r7.txt`.

## Round 6

"Before" is the fork at `adf62ae` (the model of the earlier wuica data), "after" is `improve-r6` at `9bed908` (the model of
the branch `model-r6`; its merge with the crash fixes, `21b0b17`, gives the same predictions on all these loops).

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
- ADL-P: uops.info's port data for indexed memory operands lacks the non-memory uops of about 3200 instruction forms; the ports
  of the non-indexed form are used instead. Store-to-load forwarding into loads that are not memory-renamed: 5 cycles instead of 4.
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

## Limits

- These are prototype models of the fork, not models by the authors of uiCA. Their parameters were fitted to measurements; the
  instruction data comes from [uops.info](https://uops.info) (for ICX: Rocket Lake data, with a few corrections).
- Each model was measured on a single machine (one Zen 3+ laptop CPU, one Alder Lake laptop CPU, one Ice Lake-SP server CPU).
  Other CPUs of the same microarchitecture can differ (clock domains, microcode, memory).
- The loops are small, run from the caches, and have no branches inside the loop body. Throughput under cache misses, branch
  mispredictions or frequency changes is not modeled.
- Random loops do not represent typical code; the real-code blocks are closer to it but come from one benchmark collection.
