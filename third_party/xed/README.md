# Intel XED (decoder subset)

Source: [andreas-abel/XED-to-XML](https://github.com/andreas-abel/XED-to-XML) at commit `c71679ee` (2022-02-22, XED
`v10.0-1167-gc71679ee`), the XED fork and version that uiCA pins as a submodule. License: Apache 2.0 (`LICENSE`).

wuica needs exactly this version: the instruction data from uops.info is matched by the iform names and operand attributes
that this version reports.

Contents (the files that XED's own build compiles into `libxed.a` with `mfile.py --no-encoder`):

- `src/`: the 94 C files of the decoder library: 29 hand-written ones (17 from `src/common`, 11 from `src/dec`, and
  `datafiles/knc/xed-operand-values-interface-uisa.c`) and 65 generated ones (`obj/*.c`).
- `include/xed/`: the public headers of the build's kit (`obj/wkit/include/xed`), including the generated ones.
- `include-private/`: `include/private`, `obj/include-private` and the generated headers in `obj/`.

The generated files were produced by XED's Python generators on Linux x86-64 (uiCA's `setup.sh`); they are plain C tables and do
not depend on the host. To regenerate: run `./mfile.py --opt=2 --no-encoder` in a checkout of the commit above and copy the files
listed here. The build flags are in `crates/wuica-xed/build.rs`.
