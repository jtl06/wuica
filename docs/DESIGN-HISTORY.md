# The reference in model rounds 7 to 10

What each earlier model round added to the reference and where it is ported, as written at the time. The current reference
(round 11) is described in [DESIGN.md](DESIGN.md#reference).

On the branch `model-r7`, the reference is the fork's branch `improve-r7`, with the model at `f4a7868`: the model changes of
round 7 (see docs/ACCURACY.md) on top of `improve-r6` (`21b0b17`), which merged the round-6 model with `crash-fixes`. Its data
and fixtures are exported with `tools/export_all.sh`. The sources in `reference/uiCA/` are still those of `8f24bd3`; the model
changes since then are in `uiCA.py` (`FrontEnd`: `microcodeBusyCycles`; `Renamer`/`Scheduler`: `foldedInputs`,
`getFoldedInputDelay`; load uops: `loadOpForwardDelay`), `microArchConfigs.py` (`microcodeOps`, `microcodeWidth`,
`foldedShiftDelay`, `loadOpForwardDelay`; ADL-P `storeForwardDelay`) and the instruction data (`convertXML.py`: ZEN3
vector-to-GPR moves, `INSTR_CORRECTIONS`).

On the branch `model-r8`, the reference is the fork's branch `improve-r8` (model at `c899be7`: the changes of round 8 on top of
`improve-r7`). New since round 7: `FrontEnd.afterMicrocode` with `microcodeNextEntryOps` (ZEN3: the first op-cache entry after a
microcoded instruction holds at most 4 macro-ops), `rotateCarryRMWForwardDelay` (ICX: store-forwarding delay for the loads of
read-modify-write RCL/RCR) and, in the instruction data, `AMD_NARROW_RMW_MEM_LATENCY` (ZEN3: ADC/SBB on 8/16-bit memory).

On the branch `model-r9`, the reference is the fork's branch `improve-r9` (the changes of round 9 on top of `improve-r8`). New since
round 8, in `instructions.py`: `registerVersions` / `addressLineKey` give the values of the address registers within an iteration
as a version and an offset, and ZEN3's store-line rule `storeLineRestrictedPorts` now compares these instead of the register names.
`splitLoadPatterns` with `splitLoadCycles` (ZEN3 2, ADL-P 3, ICX 2) cover a load that crosses a 64-byte line in some iterations:
where the loop's addresses make this knowable, the load blocks its load port for that many cycles in those iterations
(`Instr.splitLoadPattern`, exported in the instruction fixtures only when set). New in `uiCA.py` is the FP non-scheduling queue
(`fpSchedulerSize` 56 and `fpSchedulerPorts` for ZEN3): at most `fpSchedulerSize` uops for the FP ports wait in the scheduler,
and younger ones wait in order and are not dispatched before they enter the scheduler. Ported in `instr_builder.rs`
(`register_versions`, `address_line_key`, `split_load_patterns`) and `sim/scheduler.rs`.

On the branch `model-r10`, the reference is the fork's branch `improve-r10` (the changes of round 10 on top of `improve-r9`). New
since round 9, in `uiCA.py`: `vectorDomain` and `domainBypassDelay` (ZEN3: 1). When a vector instruction of the integer domain
(P...), the floating-point domain (...PS/PD/SS/SD, FMA) or the lane-crossing domain (VPERM2I128/VPERM2F128) reads a register
written by an instruction of another domain (not a load), it gets the value `domainBypassDelay` cycles later; store-data uops are
exempt. Ported in `sim/prep.rs` (`vector_domain`, the instruction flags `DOMAIN_*`) and `sim/scheduler.rs`
(`get_ready_for_dispatch_cycle`).
