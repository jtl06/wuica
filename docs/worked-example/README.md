# The worked example of the README: sources, method and all numbers

Two small cases, each a loop before and after a change, with wuica's prediction, llvm-mca's and a measurement on the three
machines the prototype models were built on. Everything here can be re-run.

## Files

- `xoshiro.c`, `sum.c`: the kernels. `probe.c`: a loop that stores a value and reloads it, to measure what that costs.
  `bench.c`: the driver; it counts cycles and instructions (user mode) around the calls.
- `build.sh`: builds one static binary per compiler (gcc 15.2.0, clang 22.1.2, `-O2`, no `-march`), each kernel in its own
  file. The same binaries ran on all three machines.
- `measure.sh CPU [RUNS]`: every kernel pinned to one CPU, 40,000 calls of 1,024 elements (8 kB, in the L1 cache), one
  warm-up run and 9 runs. The number is the fastest run; the spread is the slowest minus the fastest.
- `mca.sh`: cuts each loop out of the `-S` output and runs llvm-mca 22.1.2 with `-mcpu=znver3`, `alderlake` and
  `icelake-server`, `-iterations=1000`. The number is total cycles / 1000.
- `loops/`: the loops as cut out, to paste into the page or give to `wuica`.

wuica's numbers are from version 0.1.11, on the disassembly of the measured binary (`objdump -d bench | wuica -arch
ICX,ADL-P,ZEN3`), so each loop is analyzed at the alignment it has in that binary.

## xoshiro256++ filling an array

`fill_before` and `fill_after` differ by `restrict` on the output pointer. Without it the compiler has to assume that `out`
may point into the generator's state, so it reloads the four state words in every iteration and stores them back. Cycles per
number (one loop iteration), before → after.

gcc 15 (25 and 15 instructions per iteration; the counters give 25.01 and 15.03 per number):

| CPU | wuica | measured (spread) | llvm-mca 22 |
|---|---|---|---|
| `ICX`, Xeon Gold 6314U | 9.04 → 3.63 | 8.91 (0.0 %) → 3.78 (0.1 %) | 4.18 → 3.50 |
| `ADL-P`, Core i7-12650H, P-core | 4.00 → 3.32 | 4.04 (1.2 %) → 3.26 (0.0 %) | 4.69 → 4.01 |
| `ZEN3`, Ryzen 7 7735U | 4.00 → 3.49 | 4.54 (0.6 %) → 4.01 (0.1 %) | 5.01 → 2.76 |

clang 22 (it unrolls the after loop twice; per number):

| CPU | wuica | measured (spread) | llvm-mca 22 |
|---|---|---|---|
| `ICX` | 8.81 → 3.82 | 8.98 (0.0 %) → 3.90 (0.0 %) | 3.84 → 3.13 |
| `ADL-P` | 3.65 → 3.56 | 3.72 (3.6 %) → 3.52 (0.0 %) | 5.02 → 4.01 |
| `ZEN3` | 4.00 → 3.41 | 4.87 (0.1 %) → 3.04 (0.1 %) | 5.01 → 2.50 |

What holds and what does not:

- **The Xeon.** Each reload waits for the store of the iteration before. wuica's report names no bottleneck for the before
  loop ("unknown": no static limit explains 9.04); the wait is in the simulation. With the four loads moved to other
  addresses, wuica gives 5.02 on `ICX` and still 4.00 on the other two. `probe.c` measures the round trip itself.
- **The other two CPUs** forward the stored value without that delay, in the model and on the hardware, so the change gains
  much less there.
- **llvm-mca** assumes by default that loads and stores do not alias, and predicts the Xeon's before loop at 4.18. With
  `-noalias=false` it is no closer.
- **wuica is 12 to 13 % low on `ZEN3`** with gcc, on both versions, and 18 % low on clang's before loop. An earlier build
  with that loop at another offset in its cache line measured 5.01 against 4.87; wuica gives 4.00 at both offsets.
- **The gain depends on the compiler:** with clang the i7 gains 5 %.

[The gcc loops as an A-B comparison on the page](https://wuica.jacen.li/#v=1&m=asm&s=att&a=ICX&as=ICX,ADL-P,ZEN3&c=LkwzOgoJbW92cQkoJXJkaSksICVyY3gKCW1vdnEJOCglcmRpKSwgJXJkeAoJYWRkcQkkOCwgJXI4Cgltb3ZxCTE2KCVyZGkpLCAlcjkKCW1vdnEJMjQoJXJkaSksICVyYXgKCW1vdnEJJXJkeCwgJXIxMAoJeG9ycQklcmN4LCAlcjkKCW1vdnEJJXJheCwgJXJzaQoJYWRkcQklcmN4LCAlcmF4Cgl4b3JxCSVyOSwgJXIxMAoJeG9ycQklcmR4LCAlcnNpCglyb2xxCSQyMywgJXJheAoJbW92cQklcjEwLCA4KCVyZGkpCglzYWxxCSQxNywgJXJkeAoJbW92cQklcmN4LCAlcjEwCglhZGRxCSVyY3gsICVyYXgKCXhvcnEJJXJzaSwgJXIxMAoJeG9ycQklcjksICVyZHgKCXJvcnEJJDE5LCAlcnNpCgltb3ZxCSVyMTAsICglcmRpKQoJbW92cQklcmR4LCAxNiglcmRpKQoJbW92cQklcnNpLCAyNCglcmRpKQoJbW92cQklcmF4LCAtOCglcjgpCgljbXBxCSVyOCwgJXIxMQoJam5lCS5MMwo&ab=1&bm=asm&bs=att&bc=Lkw4OgoJbGVhcQkoJXJheCwlcmRpKSwgJXJkeAoJbW92cQklcjgsICVyOQoJeG9ycQklcmRpLCAlcmN4Cgl4b3JxCSVyOCwgJXJheAoJcm9scQkkMjMsICVyZHgKCXNhbHEJJDE3LCAlcjkKCWFkZHEJJDgsICVyc2kKCXhvcnEJJXJjeCwgJXI4CglhZGRxCSVyZGksICVyZHgKCXhvcnEJJXI5LCAlcmN4Cgl4b3JxCSVyYXgsICVyZGkKCXJvcnEJJDE5LCAlcmF4Cgltb3ZxCSVyZHgsIC04KCVyc2kpCgljbXBxCSVyc2ksICVyMTEKCWpuZQkuTDgK)

## A sum of doubles, one accumulator and four

The textbook case: `s += a[i]` is one chain of dependent additions unless the compiler may reassociate. Four accumulators
make four chains (gcc turns them into two `addpd`). Cycles per element, gcc 15:

| CPU | wuica | measured | llvm-mca 22 |
|---|---|---|---|
| `ICX` | 4.00 → 1.00 | 4.01 → 1.02 | 4.00 → 1.00 |
| `ADL-P` | 2.00 → 0.50 | 2.01 → 0.52 | 4.00 → 0.75 |
| `ZEN3` | 3.00 → 0.75 | 3.01 → 0.77 | 3.00 → 0.75 |

Every tool sees the chain. llvm-mca's `alderlake` model takes 4 cycles for the addition where the P-core measures 2.

[These loops on the page](https://wuica.jacen.li/#v=1&m=asm&s=att&a=ADL-P&as=ADL-P,ZEN3,ICX&aw=2&c=LkwzOgoJYWRkc2QJKCVyZGkpLCAleG1tMAoJYWRkcQkkMTYsICVyZGkKCWFkZHNkCS04KCVyZGkpLCAleG1tMAoJY21wcQklcmF4LCAlcmRpCglqbmUJLkwzCg&ab=1&bm=asm&bs=att&bw=4&bc=LkwxNToKCW1vdnVwZAkoJXJkaSksICV4bW0zCgltb3Z1cGQJMTYoJXJkaSksICV4bW00CglhZGRxCSQxLCAlcmF4CglhZGRxCSQzMiwgJXJkaQoJYWRkcGQJJXhtbTMsICV4bW0yCglhZGRwZAkleG1tNCwgJXhtbTEKCWNtcHEJJXJkeCwgJXJheAoJamIJLkwxNQo)
