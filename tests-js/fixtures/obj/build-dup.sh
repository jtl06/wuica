#!/usr/bin/env bash
# The files of the repeated-names tests (objfile.test.mjs), from dup_a.c, dup_b.c and dup_main.c: two static functions
# named step, each with a cold part (step.cold), in one file.
#   on Linux (the committed ELF files: Ubuntu, gcc 15.2.0, GNU ld 2.46):
#     dup.elf.exe       a static executable without a C library (-nostdlib)
#     dup.elf.stripped  the same, stripped (no symbols at all)
#     dup.elf.so        a shared object
#     dup.elf.o         a relocatable object made by ld -r from the two objects (repeated local names in a .o)
#   on macOS (the committed Mach-O file: Apple clang 17):
#     dup.macho.exe     an x86-64 executable (two local symbols _step; clang makes no cold parts)
set -euo pipefail
cd "$(dirname "$0")"
F="-O2 -fno-asynchronous-unwind-tables -fno-stack-protector -fcf-protection=none"
if [ "$(uname)" = Darwin ]; then
  clang -arch x86_64 -O2 -fno-asynchronous-unwind-tables dup_a.c dup_b.c dup_main.c -o dup.macho.exe
  ls -l dup.macho.exe
  exit
fi
CC=${CC:-gcc-15}
T=$(mktemp -d)
for f in dup_a dup_b dup_main; do $CC $F -c $f.c -o $T/$f.o; done
$CC -static -nostdlib -Wl,--build-id=none $T/dup_a.o $T/dup_b.o $T/dup_main.o -o dup.elf.exe
strip -o dup.elf.stripped dup.elf.exe
$CC $F -fPIC -shared -nostdlib -Wl,--build-id=none dup_a.c dup_b.c -o dup.elf.so
ld -r $T/dup_a.o $T/dup_b.o -o dup.elf.o
rm -r $T
ls -l dup.elf.*
