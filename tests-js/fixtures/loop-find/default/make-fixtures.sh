#!/bin/sh
# The fixtures of the default loop (tests-js/web_loop_find.mjs, "the default loop"): real compiler output of the C files
# here, unedited. clang: Homebrew clang 23.1.6; gcc: x86-64 gcc 16.2 on Compiler Explorer (compiler cg162; its gcc adds
# -g and -fverbose-asm unless told otherwise, hence -g0 -fno-verbose-asm). The objdump listings: the -S output assembled
# by clang and disassembled by llvm-objdump 23. Run in this directory; CLANG and OBJDUMP name other tools.
set -e
CLANG=${CLANG:-clang}
OBJDUMP=${OBJDUMP:-llvm-objdump}
FLAGS="--target=x86_64-linux-gnu -ffreestanding -fno-asynchronous-unwind-tables"
clang_s() { "$CLANG" $FLAGS "-$2" "-march=$3" -S "$1.c" -o "clang-$1.$2.$3.s"; }
clang_s saxpy O3 haswell
clang_s dot4 O2 skylake
clang_s dot_sse O2 haswell
clang_s add3 O2 skylake-avx512
clang_s scale_add O2 haswell
clang_s hist4 O2 skylake
clang_s mm3 O2 haswell
clang_s fnv2 O2 haswell
clang_s search O2 haswell
clang_s pack O2 haswell
clang_s idct O2 haswell
# the baseline x86-64 (SSE2): scalar double code without VEX (andpd, xorps before cvtsi2sd)
"$CLANG" $FLAGS -O2 -S rec.c -o clang-rec.O2.x86-64.s

# gcc on Compiler Explorer (talks to godbolt.org): the assembly text gcc writes, all of Compiler Explorer's filters off
gcc_s() {
  node -e '
    const [src, o, m] = process.argv.slice(1);
    const body = { source: require("fs").readFileSync(src + ".c", "utf8"), lang: "c", options: {
      userArguments: `-${o} -march=${m} -fno-asynchronous-unwind-tables -g0 -fno-verbose-asm`,
      filters: { binary: false, binaryObject: false, labels: false, directives: false, commentOnly: false, demangle: false,
        intel: false, execute: false, libraryCode: false, trim: false } } };
    fetch("https://godbolt.org/api/compiler/cg162/compile", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body) }).then((r) => r.json()).then((j) => {
      if (j.code !== 0) { console.error(JSON.stringify(j.stderr)); process.exit(1); }
      require("fs").writeFileSync(`gcc-${src}.${o}.${m}.s`, j.asm.map((l) => l.text).join("\n") + "\n");
    });' "$1" "$2" "$3"
}
gcc_s rec O2 haswell
gcc_s scale_add O2 haswell
gcc_s parse O2 haswell

# the same code as objdump -d output (AT&T without the bytes; Intel with them)
"$CLANG" --target=x86_64-linux-gnu -c clang-saxpy.O3.haswell.s -o saxpy.o
"$OBJDUMP" -d --no-show-raw-insn saxpy.o > clang-saxpy.O3.haswell.objdump.txt
"$CLANG" --target=x86_64-linux-gnu -c gcc-scale_add.O2.haswell.s -o scale_add.o
"$OBJDUMP" -d -M intel scale_add.o > gcc-scale_add.O2.haswell.objdump-intel.txt
"$CLANG" --target=x86_64-linux-gnu -c clang-fnv2.O2.haswell.s -o fnv2.o
"$OBJDUMP" -d --no-show-raw-insn fnv2.o > clang-fnv2.O2.haswell.objdump.txt
rm -f saxpy.o scale_add.o fnv2.o
