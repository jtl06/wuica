# Accuracy of the experimental models

wuica reproduces the Python uiCA of the fork [jtl06/uiCA](https://github.com/jtl06/uiCA) exactly, so these numbers hold for both.
They cover the three models that the fork adds: **ZEN3** (AMD Zen 3), **ADL-P** (Alder Lake P-cores) and **ICX** (Ice Lake
server). Each was measured on one machine. The rounds below do not change uiCA's original Intel models: their predictions on the
test corpus are identical before and after. Those models are not measured here. "Original uiCA" in the tables is the upstream
uiCA with its own instruction data, used as a reference.

Percentages are the share of loops whose predicted throughput is within 5, 10 or 20% of the measured one; MAPE is the mean absolute
percentage error. All tools are compared on the same loops (those for which every tool gives a prediction).

## Real hot loops

These are the numbers to judge the models by. The web page quotes the held-out "wuica" rows next to each prototype model. The
benchmark is 1,844 hot loops from 175 open-source libraries (hashes, codecs, string functions, math kernels and more;
hand-written intrinsics as well as auto-vectorized code), built in 11 configurations of gcc 15 and clang 22 from the x86-64
baseline to x86-64-v4, and measured in place with performance counters on the three machines below. The libraries are split in
two: a development part, which model round 11 worked from, and a held-out part, which was scored once, after the round was
finished. Each share in the table is the share of loops predicted within 10 % of the measured cycles per iteration, at the
loop's own alignment, averaged per library so that a library with many loops counts once.

| Split | Model | Tool | Loops | ≤10% |
|---|---|---|---:|---:|
| held out | ADL-P | wuica | 500 | 82.8% |
| | | llvm-mca 22, `alderlake` | 500 | 41.4% |
| | | upstream uiCA, `RKL` | 500 | 49.6% |
| held out | ICX | wuica | 579 | 77.1% |
| | | llvm-mca 22, `icelake-server` | 579 | 53.6% |
| | | upstream uiCA, `ICL` | 579 | 62.4% |
| held out | ZEN3 | wuica | 558 | 64.2% |
| | | llvm-mca 22, `znver3` | 558 | 45.2% |
| development | ADL-P | wuica | 874 | 86.9% |
| | | llvm-mca 22, `alderlake` | 874 | 54.6% |
| development | ICX | wuica | 1029 | 77.1% |
| | | llvm-mca 22, `icelake-server` | 1029 | 55.6% |
| development | ZEN3 | wuica | 961 | 70.9% |
| | | llvm-mca 22, `znver3` | 961 | 44.8% |

How to read it:

- **The machines.** ADL-P: Core i7-12650H, P-core. ICX: Xeon Gold 6314U. ZEN3: Ryzen 7 7735U, a Zen 3+ laptop chip; the model
  has not been checked on a desktop or server Zen 3.
- **llvm-mca** is LLVM 22 with `-mcpu` as shown and `-iterations=1000`, on the loop's own instructions.
- **Upstream uiCA** has no model for these CPUs. The rows show its nearest model (Rocket Lake for Alder Lake P-cores, Ice Lake
  client for Ice Lake server) as a reference for what the new models add; they say nothing about uiCA's accuracy on the CPUs it
  does model.
- **The original Intel models** are not in the table: the benchmark has only been measured on these three machines.
- **Noise.** Re-measuring loops and swapping the accepted measurement moves a share by about 1.5 points; treat differences under
  2 points as noise.
- **Before round 11** the held-out shares were 76.1 % (ADL-P), 68.0 % (ICX) and 50.7 % (ZEN3). The mean absolute error per library
  went from 8.7 to 7.3 %, from 8.5 to 6.2 % and from 12.8 to 9.8 %.
- **The data.** [wuica-calibrate](https://github.com/jtl06/wuica-calibrate) publishes the loops as prebuilt binaries (1,814 of
  them, from 173 of the libraries), the measurements from the three machines and wuica's predictions. It also runs the benchmark
  on any other x86-64 Linux machine. The llvm-mca and upstream uiCA predictions are not published yet.

The rounds below are scored on the older test sets (random loops and BHive blocks). These sets are easier than real loops and
are now a guard against regressions.

## Policy and the accuracy gate

The random held-out sets no longer discriminate between model variants: in rounds 7 to 10 the model changes moved them by tenths of a
point (round 10: ZEN3 holdout8 85.6 -> 85.7 %, no other held-out set moved). Further model work therefore starts from measured
real loops and an identified mechanism, isolated by a loop benchmark as in "Known errors" below, and not from tuning against the
random sets. The random sets remain the guard against regressions.

The guard is automatic. `crates/wuica/tests/accuracy_gate.rs` (suite `wuica:accuracy_gate` of `scripts/check.sh`, and so of CI)
predicts the 7,925 measured loops of `fixtures/generated/accuracy.jsonl.gz` and compares, per set and CPU, the share within
5/10/20 % and the MAPE with `crates/wuica/tests/accuracy_expected.json`. The loops are the held-out sets of rounds 9 and 10 for
ZEN3, ADL-P and ICX and the 21 dogfood loops, with their machine code and measured cycles; the fork's
`microbench/accuracy_export.py` generates the file, which is in the CI data asset. The gate reproduces the tables of this
document exactly: the same loops, and the throughput rounded to 2 decimals as the command-line tool prints it. It fails when a
share moves by more than 0.1 point (2 loops in about 1,900) or the MAPE by more than 0.02 point, in either direction. An intended
change is accepted with `WUICA_ACCURACY_ACCEPT=1 cargo test --release -p wuica --test accuracy_gate`. The dogfood loops are
printed loop by loop but not gated. The gate takes about 2 s (22,905 predictions on all cores of the development Mac).

## Known errors and what was ruled out

Two ZEN3 errors remain after round 10. The loop benchmarks that reproduce them are in the fork: `microbench/lb/r9a.txt`,
`r9b.txt`, `r9c.txt` and `r10a.txt` to `r10d.txt`, built and measured with `microbench/lb/lb.py` and predicted with
`lb/lbpred.py`. Their measurements are in `microbench/measurements/lb/`, the comparison of the policies in
`microbench/measurements/lb/r10_policies.txt`, and the dogfood loops in `microbench/dogfood/`.

### Scalar chains that share the ALUs (prefix sum, sum reduction)

**Symptom.** `add edx, [rdi+rax*4]; mov [rsi+rax*4], edx; inc rax; cmp rcx, rax; jne` (prefix sum) runs at 1.00 cycles per
iteration on the Ryzen 7 7735U and is predicted at 1.36, with bottleneck "unknown". The reduction without the store: 1.07
measured, 1.55 predicted; with two accumulators (`q_s2`): 1.00 measured, 1.80 predicted. In the model, the index chain (`inc rax`)
loses ALU ports to the older accumulator chain, which waits for the loads, so the loads come late.

**Tested and ruled out.**
- *ALU-port contention as the cause.* One more macro-op that needs no ALU makes the prefix sum as slow as one more ALU op: a `nop` 1.34,
  an eliminated `mov` 1.34, a `lea` 1.42, a load 1.37 (`r10a`: `q_ps_*`); two accumulators with one `nop` 1.53 (`q_s2_nop`). Loops of
  1-cycle chains without loads stay at 1.00 with 6 macro-ops (`q_c3n`, `q_c2n2`).
- *Loads or stores taking ALU issue slots.* 3 loads + 3 adds + `dec; jne`: 1.17; 2 stores + 3 adds: 1.00 (`q_l3a3`, `q_s2a3`).
- *Fused CMP/TEST + Jcc on an ALU.* It takes no ALU slot (3 adds + `inc` + `cmp; jne`: 1.00, `b_a3cmp`), but all branches share two
  branch units, fused DEC + Jcc included (`r9c`). Moving the fused pairs to their own two ports fixed the first and broke loops with
  several branches (round 9, reverted); with a limit of two branch uops per cycle the prefix sum is still 1.25.
- *Port-assignment policies* (simulated against all loops of `r9a`, `r9b`, `r10a`): least occupancy as now (occupancy updated per
  uop within the dispatch cycle, a slot freed one cycle after dispatch, ties to the least recently used port); the slot freed at
  issue, visible to the next cycle (the reviewer's H1); ties to the lowest port (H2); round robin per port set or over all ALUs; by
  issue slot; least occupancy at the start of the cycle; dispatch to any free ALU (round 9: random sets -1.4 to -2.4 points); steering
  a uop to its producer's port (-20 points). None reproduces both the 1.00 of the prefix sum and the 1.34 with a `nop`.
- *Store-queue backpressure* (the reviewer's reading of "without the store it is slower"): with the store's data taken off the chain
  (`mov [rsi+rax*4], r12d`) the loop stays at 1.00 (`q_ps_sti`). Adding a `nop` to the store-less reduction does not change its
  speed (1.09 -> 1.07, `q_s_nop1`), so the cause is not the number of macro-ops per dispatch cycle either.

**Unexplained.** What makes a loop with one or two load-op accumulator chains slow down by a third when it gets a fifth macro-op that
does not execute. On Intel the same loops really are slow on the Xeon Gold 6314U (sum 1.39, prefix sum 1.43, two accumulators
1.72 cycles per iteration; original uiCA ICL predicts 1.48, 1.61, 1.89) and run at 0.97-1.00 on the Core i7-12650H (ADL-P
predicts 1.00).

### FP mixes and lane-crossing permutes

**Symptom.** Shuffle-heavy vector loops are 13-29 % optimistic: dogfood `fir8_s` 5.20 measured / 4.51 predicted, `fir8_s2` 6.66 /
5.41, `udiv_v` 7.31 / 5.33, `udiv_v2` 2.69 / 2.24, `psum_v2` 4.22 / 3.32. The model ranks the three FIR variants `fir8_s` <
`fir8_s2` < `fir8`; the measured order is `fir8_s` < `fir8` < `fir8_s2`. Single-instruction latencies and port counts match the
measurements.

**Found and modeled.** A bypass delay of one cycle between the vector integer, floating-point and lane-crossing-permute domains
(round 10: chains 4.0 -> 8.0 cycles, measured 8.0). It changes the predictions for the dogfood loops above by less than 0.15
cycles.

**Tested and ruled out or not supported.**
- *A perfectly balancing unified FP scheduler* (the model): 8 `vmulps` + 6 `vpalignr` take 5.58 cycles, not 4.67 (`f_mix`).
- *Pipe choice independent of order:* the same mix takes 5.58 grouped, 5.22 interleaved, 5.59 with the shuffles first (`m_mix_*`), so
  the pipes are chosen when the uops enter the scheduler (supports the reviewer's H3 in part). Mixes of 8-10 uops balance perfectly
  (4 `vmulps` + 6 `vpalignr`: 3.35, `m_m4p6`), so a split structure that saturates one shuffle pipe early is not supported at moderate
  pressure. Round robin per uop type or globally predicts 7.0 and is ruled out (`r10_policies.txt`).
- *A flat throughput limit for `vpermd`* (tried in round 9): 1, 2, 4, 8 in a row take 1.00, 2.65, 5.35, 10.64 cycles, but 2 and 4 with
  `vaddps` between them take 2.00 and 3.91 (`r10d`).
- *A dispatch burst of `vpermd`* (the reviewer's H4): `nop`s between them do not help (4 with `nop`s: 5.35).
- *The FP non-scheduling-queue window as the main cause*: it explains long FMA chains (round 9) but moves the predictions for
  the dogfood loops above by tenths.

**Unexplained.** Why lane-crossing permutes cost more in mixes than their port data says: `udiv_v` without its two `vperm2i128` takes
5.74 instead of 7.33 cycles, and the model predicts 5.00 instead of 5.20 (`r10c`); 2 `vperm2i128` + 4 `vpshufd` take 2.41
(model 2.00).

## Round 11 (current model)

"Before" is the fork's `improve-r10` at `7301b04` (branch `model-r10`), "after" is `improve-r11` at `5429430` (branch
`model-r11`). The predictions of `5429430` are those of `7b8f800`, which only lacked the name of ZEN3's port `q`.
The fork's round 11 worked from the development split of the real hot loops and from microbenchmarks; the fork's `CHANGES.md`
lists the mechanisms, their sources and the development numbers. The numbers below are those of the accuracy gate (the held-out
sets of rounds 9 and 10, the dogfood loops), which wuica reproduces exactly.

### ZEN3 — measured on a Ryzen 7 7735U (Zen 3+)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout8) | 1956 | uiCA ZEN3, before | 76.4% | 85.7% | 94.8% | 3.8% |
|  |  | uiCA ZEN3, after | 76.9% | 86.3% | 95.2% | 3.7% |
| real-code blocks (bhive6) | 1895 | uiCA ZEN3, before | 85.6% | 88.8% | 92.8% | 3.9% |
|  |  | uiCA ZEN3, after | 85.9% | 89.1% | 93.0% | 3.8% |
| random loops (holdout7) | 1960 | uiCA ZEN3, before | 75.1% | 84.6% | 93.9% | 4.2% |
|  |  | uiCA ZEN3, after | 75.9% | 85.5% | 95.0% | 4.0% |
| real-code blocks (bhive5) | 1941 | uiCA ZEN3, before | 85.0% | 87.7% | 93.4% | 3.9% |
|  |  | uiCA ZEN3, after | 85.8% | 88.3% | 93.5% | 3.8% |

### ADL-P — measured on a Core i7-12650H (P-core)

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout8) | 1923 | uiCA ADL-P, before | 83.8% | 90.7% | 97.0% | 2.6% |
|  |  | uiCA ADL-P, after | 83.7% | 90.8% | 97.0% | 2.6% |
| real-code blocks (bhive6) | 1837 | uiCA ADL-P, before | 89.2% | 91.5% | 94.1% | 3.6% |
|  |  | uiCA ADL-P, after | 89.3% | 92.1% | 94.2% | 3.5% |
| random loops (holdout7) | 1933 | uiCA ADL-P, before | 83.2% | 90.9% | 96.8% | 2.8% |
|  |  | uiCA ADL-P, after | 82.9% | 90.9% | 96.8% | 2.8% |
| real-code blocks (bhive5) | 1896 | uiCA ADL-P, before | 89.1% | 92.6% | 95.3% | 3.2% |
|  |  | uiCA ADL-P, after | 89.2% | 93.4% | 95.3% | 3.9% |

### ICX — measured on a Xeon Gold 6314U

| Set | Loops | Tool | ≤5% | ≤10% | ≤20% | MAPE |
|---|---:|---|---:|---:|---:|---:|
| random loops (holdout8) | 1867 | uiCA ICX, before | 70.4% | 85.6% | 98.2% | 3.7% |
|  |  | uiCA ICX, after | 70.8% | 86.0% | 98.5% | 3.6% |
| real-code blocks (bhive6) | 1869 | uiCA ICX, before | 82.0% | 88.2% | 96.2% | 3.3% |
|  |  | uiCA ICX, after | 81.3% | 88.6% | 96.3% | 3.3% |
| random loops (holdout7) | 1879 | uiCA ICX, before | 70.5% | 85.8% | 97.8% | 3.9% |
|  |  | uiCA ICX, after | 70.7% | 85.9% | 98.0% | 3.9% |
| real-code blocks (bhive5) | 1928 | uiCA ICX, before | 82.7% | 89.7% | 96.9% | 3.0% |
|  |  | uiCA ICX, after | 81.8% | 89.8% | 96.8% | 3.0% |

The 21 dogfood loops (ZEN3, not gated): within 10 % 57.1 % before, 81.0 % after (MAPE 5.3 %).

## Rounds 6 to 10

The results, changes and method of each earlier round are in [ACCURACY-HISTORY.md](ACCURACY-HISTORY.md).

## Limits

- These are prototype models of the fork, not models by the authors of uiCA. Their parameters were fitted to measurements; the
  instruction data comes from [uops.info](https://uops.info) (for ICX: Rocket Lake data, with a few corrections).
- Each model was measured on a single machine (one Zen 3+ laptop CPU, one Alder Lake laptop CPU, one Ice Lake-SP server CPU).
  Other CPUs of the same microarchitecture can differ (clock domains, microcode, memory).
- The loops are small, run from the caches, and have no branches inside the loop body. Throughput under cache misses, branch
  mispredictions or frequency changes is not modeled.
- Random loops do not represent typical code; the real-code blocks are closer to it but come from one benchmark collection.
