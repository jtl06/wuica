# 0.1.6: from the dogfood runs

0.1.6 is everything below, bugs and features alike:
- the browser suites adapted to the tabbed layout;
- "Must fix" items 1–6 and items 7–13 from the GUI-only run;
- "Features, in order";
- the GUI run's UI list and the smaller items.

It is done when the full check passes and a third dogfood run has tried it.

## Must fix

| # | Item | Why |
|---|---|---|
| 1 | **ZEN3 store ports depend on the block**: `inc dword ptr [rsp+rdx*4]` is on SD0 in a 4-inc block but split SD0/SD1 in an 8-inc block | the 8-inc histogram is predicted at 6.08 and measured at 8.00; wuica ranked a no-gain change as a 1.72× win |
| 2 | **`bottlenecks` and `insights.binding` disagree** (`[]` / "unknown" vs `["Ports"]`) | two answers to the main question |
| 3 | **A result whose input no longer assembles stays on screen without a stale mark** | wrong numbers look current |
| 4 | **An undefined non-local branch target is encoded as rel32 with a relocation, silently** | the bytes view and the sweep are wrong for that block; `.L` targets already give an error |
| 5 | **`/api/version` says 0.1.0**: the `packages/wuica` and `server` versions are not bumped with the site | the API and the site disagree |
| 6 | **`;` comments fail** ("invalid instruction mnemonic") | `#` and `//` work |

## Features, in order

1. **Find the loop.** Accept a whole function (`gcc -S`, objdump output with addresses) and pick the innermost loop, or let the user pick one. Treat branches out of the block as not taken, so `jae .Lout` assembles. Take the alignment offset from the loop's address. Accept objdump lines (`40: crc32 …`) as they are. *Every one of 11 loops was trimmed by hand; a whole function gave 13.00 cycles/iteration and "bottleneck unknown".*
2. **Work per iteration.** Let the user give the bytes or elements one iteration processes, and show cycles per byte or element in the headline, in A–B, in the CPU table and in the API (`compare` too). A–B then compares per unit of work. *"B 1.85× slower" was a 3.4× win per byte.*
3. **"N accumulators" what-if.** Unroll with the loop-carried register renamed into N copies, then show the best N per CPU. *All three unroll variants gave +0.00 on CRC and the dot product; finding that 3 streams is optimal on Zen 3 took writing C.*
4. **A–B on every checked CPU**, as one table. Today it runs only on the primary CPU, and making a CPU primary is hard to discover.
5. **Warnings for known blind spots:**
   - a read-modify-write to an indexed address (data-dependent store forwarding);
   - low confidence on ZEN3 store-port cases;
   - exit mispredicts for short trip counts.

## Smaller

- **The "cost" column reads backwards.** It is the change when an instruction is removed, so a removal that breaks a chain shows as +0.94. Rename it, or flip the sign so it reads "what this instruction adds".
- **The trace needs a legend** for its hatched, grey and solid segments. It may already be enough in 0.1.5; check again in the next dogfood run.
- **The CPU that A–B and the details use** should be marked more clearly than a click on its row of the CPU table.

## From the GUI-only dogfood run (0.1.5 build)

The run used three loops: a prefix sum (1.9×), an 8-tap FIR (1.13×) and u32 division by a runtime divisor (17.9×).

**Accuracy:**
- ZEN3's mean error was 17%. Scalar code and pure chains were within 2%.
- Shuffle-heavy loops were 17–31% optimistic.
- The FIR ranking was inverted.

| # | Item | Why |
|---|---|---|
| 7 | **Model: loads that split a cache line** are not modelled. The hardware counted 3.7 split loads per iteration in gcc's FIR. | FIR is 30% underpredicted, and the best variant was ranked worst |
| 8 | **Model: ZEN3 gives 1.36 for a scalar prefix sum** (`add edx, [mem]; mov [mem], edx`), with bottleneck "unknown" and every limit ≤ 1.00. Measured 1.00; llvm-mca 1.01. | a wrong number with no explanation |
| 9 | **Model: ZEN3 shuffles may be too cheap** (vpermd, vpalignr, vperm2i128, vpblendd) | 17–31% optimistic on four variants |
| 10 | **A–B: "unrolled ×N" for B** is applied only on blur, survives replacing B's code, and the header mixes raw and normalized numbers | "B is 7.27× faster" for a variant rated 10% slower |
| 11 | **A–B: stale B results are not dimmed** | an old B combined with a new A for about 1 s |
| 12 | **objdump addresses with hex letters** (`1c:`, `jne 10 <psum+0x10>`) are rejected or read as labels | see "Find the loop" |
| 13 | **The instruction card's "tp" for `div`** (2.00) disagrees with the loop's Divider limit (6.00) | confusing |

**UI:**
- **Port columns:** the uop table should fit every port column, or keep the instruction column sticky. ZEN3's FP2/FP3 and ADL-P's ports past 6 are clipped at 1440 px.
- **A–B:**
  - stack A and B, or show one merged table;
  - add a per-CPU table of A, B and Δ;
  - give it the tabs, as single mode has.
- **Tabs:**
  - Keep the tab order and positions fixed: "source" appears only after an import and shifts the others.
  - Give every tab a key, in display order.
- **The folded input pane:** give it a wider, labelled handle. The fold persists across reloads, and the 10 px strip is easy to miss.
- **Branch targets:** the loop branch shows as `jnz 0xfffffffffffffff4`; show the label.
- **"unknown" and "Scheduling" need an answer:** the uop that waits longest and what it waits on.
- **deps header:** label "→ 3 ↻ 0".
- **Phone width:** the result comes a full screen below the editor and the CPU grid.

## The loop

Each release: build → dogfood (a fresh session tunes real loops and measures them) → fix → repeat. Alternate the runs:
- **API/MCP-driven runs**, like this one;
- **GUI-only runs**: the site with screenshots, mouse and keyboard, no API and no reading of the repository.
