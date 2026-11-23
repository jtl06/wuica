# Differences from upstream uiCA

wuica is an exact port of the fork [jtl06/uiCA](https://github.com/jtl06/uiCA), branch `crash-fixes` (based on `perf`); the
fork is based on [andreas-abel/uiCA](https://github.com/andreas-abel/uiCA) `master` at `6ebeeab` (2024-01-14). This document
lists every difference from upstream that changes a result or an error for an input that upstream also accepts: what upstream
does, what the fork and wuica do, and why. The fork's `CHANGES.md` has all of its changes, including those that change no
result (speed, refactoring, the experimental models); commit hashes below refer to the fork.

New microarchitecture models (`ZEN3`, `ADL-P`, `ICX`) are not differences: upstream has no such `-arch`. Fixes that only affect
those models are listed where they change what happens to an input (a crash that becomes a result).

## Inputs on which upstream raises an exception

Upstream fails with a Python exception on these inputs. The fork fixes the cause where the CPU can run the code and the answer is
well defined; otherwise it raises `InputError` with a message that names the problem. wuica gives the same result, or an error
with the same message. Before these fixes, wuica returned "the reference implementation fails for this input: ...".

| Input | Upstream | Fork and wuica | Commit |
|---|---|---|---|
| An instruction without a memory input operand whose port data has a load port: `pcmpestri`/`vpcmpestrm` with register operands on SNB and IVB, `out`, `ins` (also what is left of AVX-512 code that the decoder cannot decode for a CPU without AVX-512, e.g. `x_zmm_mask` on SKL) | `AttributeError: 'NoneType' object has no attribute 'get'` in `Renamer.cycle` | the load uop has no address: it reads from no store and gets no fast pointer chasing | `ebc6e47` |
| A loop run from the DSB in which a microcoded instruction (`lock add`, `lfence`, ...) or a macro-fused pair is the last instruction in the DSB, and the next instruction is not in the DSB (e.g. `x_lock` with alignment offset 31 on SNB to BDW) | `IndexError: deque index out of range` in `DSB.cycle`; before that, the DSB delivered the next round's block ahead of the rest of the current round | the front end switches to the legacy decoders (MITE) after that instruction, as it does after any other instruction whose successor is not in the DSB | `19ba4f3`, `e9b7a70` |
| Two stores without a displacement (the stack slot of `push m`, `call [m]`) at the heads of the store-data queues of ports 4 and 9 (ICL, TGL, RKL; also ICX, ADL-P) | `TypeError: unsupported operand type(s) for -: 'NoneType' and 'NoneType'` in `Scheduler.dispatchUops` | a missing displacement is 0 (the two stores are in the same cache line) | `1a3e7bf` |
| `minIterations` < 1 with a `minCycles` so small that the first iteration has not retired when the simulation stops (e.g. `-minIterations 0 -minCycles 0`) | `IndexError: list index out of range` | `InputError: no iteration was completed (minIterations must be at least 1, or minCycles larger)`; the throughput is not defined | `8360f1b` |
| `-json` output for code with an instruction with a fractional throughput limit (measured microcoded instructions of the fork's models: `cpuid`, `lock` instructions, `rep` string instructions, ... on ADL-P, ICX, ZEN3) | (no such models) the fork's own models failed with `TypeError: list indices must be integers or slices, not float` while writing the file, after the analysis | the `executed` event of a uop goes to the cycle in which its fractional cycle lies; the text output was already correct | `4351920` |
| Fork-only models with `renameImmediateFolding` and move elimination (ADL-P, about 1 % of random loops) | (no such models) | a `KeyError` in the renamer is fixed | `917878c` |

In the fixtures (`fixtures/generated`), these were the 202 cases with an `error` (83, 8 and 111 cases for the first two rows and
the `-json` row); they now have results, and every other case is byte-identical to the export from `adf62ae` (see
`docs/PORTING.md`). The cases of the other rows were found with the fuzzer (`crates/wuica/examples/fuzz.rs`) and by reading the
code; blocks for them are in `fixtures/extra-src` (`x_dsb_fused_mid*.s`, `x_push_mem_pair.s`).

Inputs that exhaust time or memory are unchanged: for example `wbinvd`, whose port data has about 10^6 uops (172,044 of them
loads on IVB), makes the reference run for hours; wuica rejects a uop with more than 65,535 operands ("invalid input: too many
operands"), stops after 10^8 cycles ("invalid input: the simulation does not terminate"), and otherwise needs minutes or runs out
of memory on such blocks (see `docs/WASM-API.md`, "Failures and traps").

## Results that differ from upstream

| Change | Upstream | Fork and wuica | Commit |
|---|---|---|---|
| Determinism | `Scheduler.processPendingUops` iterated over a `set` of uops, whose order depends on memory addresses: the same input could give different port assignments in different runs (observed with the ZEN3 model; the stock Intel models gave identical output on 329 test files) | uops are processed in program order | `9b69d9d` |
| `getRegSize` | `['AX', 'BX', 'CX', 'DX', 'SP', 'BP' 'SI', 'DI']` (a missing comma): `BP` and `SI` were 64-bit registers | 16-bit registers (no output changed on the 329 test files) | `a100889` |
| `-TPonly` | declared with `nargs='?'`: in `uiCA.py -TPonly file.o` the file name was taken as its value | a flag | `ddc22da` |
| Library use | the random seed and the uop counter were not reset between calls of `runSimulation`, so a call could depend on earlier calls in the same process | each simulation starts from a fresh state, as in a new process | `49c6b2a` |
| Instruction tables | `convertXML.py` ignored the `min_cycles_*` latencies of instructions with a value-dependent latency (memory latency 1: `divpd xmm5, [rax]` 4 instead of 13 cycles per iteration), and newer uops.info data uses 113 iform names that the bundled XED does not know (BMI1/BMI2/TBM, `movzx`/`movsx r, m16` got no data) | both read (14 instruction forms on SKL, 52 on ICL/RKL); the tables in `data/arch` are generated with the fork's `convertXML.py` | `aa9f2c7`, `9a2007c` |

The tables in `data/arch` are generated from the uops.info data that `tools/export_data.py` was given, which can be newer than
the tables that upstream ships; results for instructions whose measurements changed differ accordingly.

## wuica and the fork

wuica reproduces the fork exactly, with these exceptions (inputs the fork cannot analyze in reasonable time or at all):

- Configurations with `simplePortAssignment` (`CLX_SimplePorts`, `CLX_SimplePorts_noMoveElim`) use `random.choice` and are not
  supported ("not supported: ...").
- A uop with more than 65,535 input or output operands, and a simulation of more than 10^8 cycles, are errors (see above).
