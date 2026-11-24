#!/usr/bin/env bash
# The object files of the object-input tests, from kernels.c (clang 17 or later; the committed files were made on a Mac
# with Apple clang): ELF x86-64, ELF with -ffunction-sections, Mach-O x86-64, a Mach-O x86-64 executable (with a main
# that does nothing; ld64), and arm64 Mach-O (what a Mac compiles by default).
set -euo pipefail
cd "$(dirname "$0")"
F="-O3 -march=haswell -fno-asynchronous-unwind-tables"
clang --target=x86_64-linux-gnu $F -c kernels.c -o kernels.elf.o
clang --target=x86_64-linux-gnu $F -ffunction-sections -c kernels.c -o kernels.fs.o
clang -arch x86_64 $F -c kernels.c -o kernels.macho.o
clang -O3 -arch arm64 -c kernels.c -o kernels.arm64.o
printf 'int main(void) { return 0; }\nlong step(long x) { return x * 3; }\n' > main.c
clang -arch x86_64 $F kernels.c main.c -o kernels.macho.exe
rm main.c
for f in kernels.elf.o kernels.macho.o kernels.macho.exe; do objdump -d "$f" > "${f%.o}.objdump.txt"; done
ls -l kernels.*.o kernels.macho.exe
