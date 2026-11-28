# wuica_mca: llvm-mca for the browser

`dist/wuica_mca.wasm` is LLVM's machine code analyzer, `llvm-mca` of LLVM 22.1.2, compiled to WebAssembly. The page's
`mca` view (`web/js/mca.js`) runs it in a worker with the LLVM model of the chosen CPU and shows its report next to uiCA's
prediction. The input is the analyzed bytes, written as Intel assembly that assembles back to exactly those bytes.

The module is the llvm-mca tool itself. `wuica_mca.cpp` adds the entry point and the WASI calls, and `build.sh` compiles
`llvm/tools/llvm-mca` (the driver and its views) with three edits:

| edit | why |
|---|---|
| `main()` becomes `mca_main()` | `wuica_mca_run()` calls it with the arguments |
| `InitLLVM` is left out | no signal handlers or argument rewriting in a library |
| `MemoryBuffer::getFileOrSTDIN()` becomes `wuica_mca_input()` | the input is the text passed to `wuica_mca_run()` |

The tool's stdout and stderr are collected in memory and read with `wuica_mca_output(0 or 1)`. The options are reset to
their defaults before each run. The output is byte-identical to Ubuntu's native `llvm-mca-22` for the examples on every
CPU model the page uses and for the SHA-256 showcase (`node tests-js/web_mca.mjs --native FILE`, 171 runs).

## Building

```
assembler/build.sh     # first: downloads, extracts and patches LLVM and wasi-sdk (see assembler/README.md)
mca/build.sh           # then: a second LLVM build without LLVM_X86_MC_ASSEMBLER_ONLY, the MCA libraries, the tool, the link
```

On aethia: `WUICA_ASM_WORK=$HOME/wuica-asm/clean WUICA_MCA_BUILD=/data/projects/wuica-mca/build-wasm mca/build.sh`.
`mca/build.sh` needs `node` for the check that the module has no imports.

| | |
|---|---|
| size | 4.4 MB raw, 1.2 MB gzip (downloaded only when the view is first opened) |
| SHA-256 showcase, skylake, 101 iterations | about 0.4 s in Node and in Chrome |
| memory | 1 GiB at most; 2 MiB stack |

## CPUs

The table lists uiCA's microarchitectures and the LLVM model used for each (`MCPU` in `web/js/mca.js`). LLVM has no
separate Kaby Lake or Coffee Lake model, so KBL and CFL use Skylake's.

| uiCA | llvm `-mcpu` | uiCA | llvm `-mcpu` |
|---|---|---|---|
| SNB | sandybridge | CLX | cascadelake |
| IVB | ivybridge | ICL | icelake-client |
| HSW | haswell | TGL | tigerlake |
| BDW | broadwell | RKL | rocketlake |
| SKL, KBL, CFL | skylake | ICX | icelake-server |
| SKX | skylake-avx512 | ADL-P | alderlake |
| ZEN3 | znver3 | | |
