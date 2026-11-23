# Brief: inputs on which the reference fails

For an unattended worker. Read `docs/PORTING.md` and `docs/WASM-API.md` first.

## Goal

wuica reproduces the Python uiCA (fork `jtl06/uiCA`) exactly, including the inputs on which the reference raises an
exception. For those, wuica returns `"the reference implementation fails for this input: <exception>"`. That is a clear
error but not a useful one: the user gets no throughput for code that a CPU runs without trouble.

When you are done:

1. Every such input gives either the right result or an error that says what is wrong with the *input* (e.g. "VPADDD
   zmm: not supported on Skylake"), never "the reference fails".
2. No input makes wuica panic (a panic is a trap in the WebAssembly module). A fuzzer shows this.
3. wuica is still an exact port: of the *fixed* reference, on a new branch of the fork. Every difference from upstream
   uiCA is listed in one document.

## What is known (measured on main `fa10c8e`, 2026-11-23)

The fixtures contain 202 cases in which the reference fails, in three classes. Only the last line of each exception is
stored, so get the tracebacks yourself (run the reference on the case).

| Exception (last line) | Cases | Where | wuica today |
|---|---|---|---|
| `AttributeError: 'NoneType' object has no attribute 'get'` | 83 | `x_zmm_mask`, `x_zmm_mix` (8 CPUs), and two blocks of the main corpus: `s2_0394` (IVB), `s6_1556` | error, from `sim/renamer.rs:617` |
| `IndexError: deque index out of range` | 8 | `x_lock`, `x_serial` (4 CPUs), some only with `alignmentOffset` | error, from `sim/frontend.rs` (DSB block queue) |
| `TypeError: list indices must be integers or slices, not float` | 111 | 8 files, 3 CPUs (ADL-P among them); raised while writing the `-json` file, after the analysis | result (the text output is compared, the `-json` content is not) |

Files: `fixtures/generated/{sim,extra_sim,more_sim}_fixtures.jsonl.gz`, field `error`.

Two things to check, not assume:

- `docs/PORTING.md` says the main corpus has no ZMM code, yet two of its blocks hit the first exception. So "ZMM mask
  registers" is not the whole cause of that class.
- wuica has 20 places that reproduce a reference exception: `grep -rn 'crash(' crates/wuica-core/src`. Each names the
  Python exception it stands for. Only two of them are reached by the fixtures. The others were found by reading the
  code; inputs that reach them are not known yet.

Out of scope: inputs that exhaust memory (e.g. 200 × `div rcx` with `minIterations` 10000 and `minCycles` 100000, the
case in `packages/wuica/test/trap.test.mjs`; a 5,000-instruction block at the server's caps needs 2 GB). Note what you
learn about them in the report; do not change the simulator for them.

## The rule for each case

Decide per root cause, and do not stop to ask:

- **Fix it** if the CPU can run the code and the answer is well defined once the bug is gone (an index that should have
  been an integer, a queue read one element too far, a table entry looked up under the wrong key).
- **Give an input error** if the CPU does not have the instruction, or the instruction tables have no data for it. The
  message names the instruction and the reason. The reference gets the same message (raise an exception with that text
  in place of the accidental one).
- If you cannot tell which of the two it is, give an input error and say so in the report.

## Method

Work in this order. The reference stays the oracle throughout: fix the Python first, export fixtures from it, then make
wuica equal to them.

### 1. The reference (on aethia)

- Checkout: `~/uica-zen/uiCA-perf`, branch `perf`. The fixtures were exported from `8f24bd3`; the tip is `adf62ae`
  (a rename). Check that the two give the same output, then make a new branch `crash-fixes` from the tip in a **new
  worktree** (`git worktree add ~/uica-zen/uiCA-crashfix`). Do not change `uiCA-perf` or any other directory there.
- For each class: get the traceback, find the root cause, make the smallest fix, one commit per root cause, and an entry
  in the fork's `CHANGES.md`.
- **Invariant:** export all fixture sets again from the fixed reference, in the same way as the originals (`tools/
  export_fixtures.py`; the extra set with `FRESH=1`, one process per case). Every case that did not fail before must be
  byte-identical. If a fix changes one, drop that fix and report it.
- Write the new fixtures to new directories (`~/uicaspeed/wuica-fix-crash/...`). Do not overwrite `~/uicaspeed/wuica-fix`
  or `wuica-data`.
- You may push the branch `crash-fixes` to `jtl06/uiCA`. Do not touch its other branches.

### 2. wuica

- Port each fix. Replace the matching `crash(...)` site by the fixed behaviour or by the input error.
- `crates/wuica/tests/end_to_end.rs` and `tests-js/analyze_fixtures.mjs` skip the cases with `error` today. Afterwards
  they skip nothing: a result is compared like every other case, an input error must have the same text as the
  reference's.
- Where the `-json` content is now available for the 111 cases, compare it wherever wuica has the same data (the
  trace).
- The remaining `crash(...)` sites: for each, either find an input that reaches it (the fuzzer, below) and treat it
  like the others, or show from the code that no input can reach it and say why in a comment. Do not delete a check
  because no test reaches it.

### 3. The fuzzer (the definition of done for "no panic")

- A native test or example in `crates/wuica` that builds random blocks and analyzes them under
  `std::panic::catch_unwind`, on all 15 CPUs, with random options (alignment offset, init policy, simple front end, no
  micro/macro fusion, loop and non-loop mode).
- Blocks: instructions drawn from all encodings in the decode fixtures (main and extra), 1 to about 60 per block, some
  ending in a branch back to the start, some with a few random bytes mixed in.
- Deterministic from a seed; a failure prints the seed and the block as hex.
- Any panic is a bug: reduce it to a small block, run the reference on it, apply the rule above, and add the block to
  `fixtures/extra-src` so that it becomes a fixture.
- Also compare a sample (a few thousand blocks) with the reference on aethia: text output and throughput. A difference
  there is a porting bug of the usual kind; fix it in wuica.
- Run it for as long as the night allows, at least 10 million blocks without a panic after the last fix. A short run
  (a few seconds) becomes a suite of `scripts/check.sh`.

### 4. Speed

The checks are in the simulator's hot loops. Measure before and after with `cargo run --release -p wuica --example
phases` and `node tests-js/analyze_fixtures.mjs 1` (ms per case) on aethia. Budget: no more than 1 % slower. If a fix
costs more, find a cheaper form.

### 5. Documents

- `docs/DEVIATIONS.md` (new): each difference from upstream `andreas-abel/uiCA` that changes a result or an error: the
  input, what upstream does, what the fork and wuica do, and why. Include the determinism fix and the two bug fixes of
  the `perf` branch (the fork's `CHANGES.md` has them).
- `docs/WASM-API.md`, "Failures and traps": what is true now.
- `docs/PORTING.md`: the fixture sets and the reference commit.

## Rules

- **Machines.** Heavy or measuring work on aethia only under a lease, started from the Mac:
  `~/perfq/perfq ssh aethia --est DUR [--mode shared] -- CMD` (see `~/perfq/README.md`; it blocks while queued, so run
  it in the background). Exclusive for measuring, `--mode shared` for exports and fuzzing. Project files on aethia go
  under `/data` (`~/projects`); `~/uica-zen` and `~/uicaspeed` exist already. No sudo, no installs, no system settings.
  Do not use alcidae or diomedea.
- **Repository.** Work in your own worktree and branch (`crash-fixes`), from main `fa10c8e`. `data/` and
  `fixtures/generated/` are not in git: link them from the main checkout for the old sets, and put the new sets in new
  directories. Touch `crates/`, `tests-js/`, `tools/`, `fixtures/`, `scripts/` and `docs/`; not `web/`, `server/`,
  `packages/` or `assembler/` (other work is going on there). Commit as the user's global git identity, with no
  co-author line. You may push the branch `crash-fixes` to `jtl06/wuica`. Do not merge into main, do not deploy, do not
  publish anything, do not change release assets.
- **Report, do not change:** the CI data asset `ci-data-v1` (new fixtures need a new asset), the reference commit
  `8f24bd3` in `server/lib/version.js` and in the docs of other parts.
- **Text.** Nothing in the repository may say or imply that the uops.info authors gave permission for anything.
- **Checks.** `scripts/check.sh full` must pass at the end (about a minute). Use `scripts/check.sh quick` while working.

## Final report

A table with one row per root cause: the exception, the cause in one sentence, fix or input error, the number of
fixture cases, and the commits (fork and wuica). Then: the fuzzer's totals (blocks, panics found and fixed, differences
from the reference), the speed before and after, the state of the invariant (identical or which cases changed), what is
left, and what you could not check.
