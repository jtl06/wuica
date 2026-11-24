#!/bin/sh
# The real profile fixtures of hot.c, as made on Linux x86-64 (gcc 15.2, GNU objdump 2.46, perf 7.0) in a directory
# holding hot.c: relative paths only (-fdebug-prefix-map), so no local path lands in a fixture. perf needs a CPU with
# the cycles event (user space only: cycles:u).
set -e
gcc -O2 -g -fdebug-prefix-map="$PWD"=. -o hot hot.c
gcc -O2 -g -fdebug-prefix-map="$PWD"=. -S hot.c -o gcc-hot-att.s
gcc -O2 -g -fdebug-prefix-map="$PWD"=. -masm=intel -S hot.c -o gcc-hot-intel.s
objdump -dS hot > objdump-dS-hot.txt
objdump -dSl hot > objdump-dSl-hot.txt
perf record -q -o perf.data -e cycles:u ./hot 300 > /dev/null
perf annotate -i perf.data --stdio > perf-annotate-hot.txt
# --stdio2 names the binary by its full path
perf annotate -i perf.data --stdio2 | sed "s|$PWD/|./|" > perf-annotate-hot-stdio2.txt
