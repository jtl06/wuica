# The specification: parts that describe an earlier state

These parts of [SPEC.md](SPEC.md) were written for a review at release 0.1.8 (2026-11-23) and describe that moment: work then in
progress, questions put to the reviewers, a decision since reversed, and weaknesses since fixed. They are kept as written, under
their old section numbers.

### 8.3 Measured, gain available, deliberately not taken

| Idea | Gain | Why not | Source |
|---|---|---|---|
| Strip the analyzer's `name` section (`llvm-objcopy --remove-section=name`) | 4.24 → 3.03 MB raw, 616 → 556 kB brotli (−60 kB), no change in compile time | Kept on purpose (`build-wasm.sh`: "the names are kept"); the profiling method of `docs/PORTING.md` reads function names from it | `build-wasm.sh` comment; `docs/PORTING.md`, "Speed" |

## 9. In progress for 0.1.9 (not released; on branches, may change)

- Several inputs per CLI run.
- Thread count chosen by the workload, and one compiled module shared across worker threads.
- The shipped JSON tables replaced by a build-time binary form (JSON stays the export format).
- Object files as CLI input.
- A redesigned trace view (a compact port strip, long waits for operands shortened to their length, A and B's differences
  marked, the legend behind "?") and a fixed-frame layout: from 1200 × 700 the window does not scroll, only its sections
  (editors, table rows, trace rows, a view's content).
- A model round on the two known ZEN3 errors (section 10.1).
- An audit of what the WebAssembly modules contain.

## 10. Known weaknesses: bullets since superseded

From 7.1:

- The content of the 1.13 MB data section is not attributed yet (an audit is in progress, section 9).

From 10.2:

- The JSON tables are parsed with `serde_json` on every load (2–15 ms each, 80 ms for all); the 0.1.9 binary form targets this.

From 10.3:

- A `wbinvd` block (about 10^6 uops in the tables) is rejected, takes minutes, or runs out of memory depending on the CPU
  (`docs/WASM-API.md`, "Failures and traps").

From 10.5:

- `engines.node` is `>=20` but CI runs Node 22 only.

### 10.7 Where the docs and the code disagree (the code wins)

| Doc | Says | Code / logs |
|---|---|---|
| `Cargo.toml` | Workspace version 0.1.0 (the crates are not published) | Package and server 0.1.8 |
| `packages/wuica/README.md` | Describes 0.1.8 (`-example`, …) | At the time of writing the registry's latest is 0.1.7, so `npx wuica-cli` does not have 0.1.8's features yet |

## 11. Feedback wanted

Answer any of these; cite the file and function.

1. **Exactness strategy.** Is three-boundary fixture testing on 18,791 cases, plus a fuzzer for panics, enough to trust
   exactness on inputs outside the corpus? Which reference paths are likely unexercised (e.g. options combined, ZMM code
   beyond the extra set, very long blocks)? Are there float-ordering or `round` risks in `crates/wuica-core/src/facile.rs`
   or `sim/` that the fixtures would not catch?
2. **Model design for the open ZEN3 errors** (section 10.1): what mechanism explains a prefix sum at 1.00 cycles with one
   load, one store and a 1-cycle add chain, given that "dispatch to any free ALU" fixed it but cost 1.4–2.4 points on random
   loops? What would explain `vpermd` at 1.33 cycles only when two or more are present?
3. **Payload and cold start**: given section 7.1, what would cut the first-visit 2.2 MB without breaking rules 1, 4 and 5
   (e.g. serving the precompressed brotli files, splitting XED's decoder tables, loading the assembler later, stripping the
   name section)? Is the trade in section 8.3 right?
4. **API design for agents**: are the CLI's `-json` shapes, the MCP tools' schemas and the compact form
   (`packages/wuica/lib/{mcp,core,insights}.js`, `index.d.ts`) what an agent needs? What is missing (e.g. several inputs,
   a diff of two blocks, source-line mapping)?
5. **UI clarity**: is the default result readable without the docs, given rule 9? (Use the live page.)
6. **Test strategy**: which gap in section 10.5 matters most? How would you test accuracy continuously without a hardware
   lab in CI? Are the timing-bound browser checks worth their flakiness?

**Not wanted**: rewrites that break a hard rule (a different decoder, "approximately equal" results, server-side analysis for
the page, a runtime dependency in the package); suggestions already in section 8 without new evidence; style changes to the
docs' wording.
