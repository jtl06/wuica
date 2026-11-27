#!/bin/sh
# Builds the benchmark with clang 22 and gcc 15 (run on one machine, Ubuntu; the static binaries are then
# copied to the other machines so that every machine runs the same bytes).
# Kernels are compiled in their own files so that they are not inlined into the driver.
set -e
cd "$(dirname "$0")"
CFLAGS="-O2"
for cc in clang-22 gcc-15; do
  o=build/$cc
  mkdir -p $o
  $cc $CFLAGS -c xoshiro.c -o $o/xoshiro.o
  $cc $CFLAGS -c sum.c -o $o/sum.o
  $cc $CFLAGS -c probe.c -o $o/probe.o
  $cc $CFLAGS -S probe.c -o $o/probe.s
  $cc $CFLAGS -S xoshiro.c -o $o/xoshiro.s
  $cc $CFLAGS -S sum.c -o $o/sum.s
  $cc -O2 -c bench.c -o $o/bench.o
  $cc -static $o/bench.o $o/xoshiro.o $o/sum.o $o/probe.o -o $o/bench
  objdump -d --no-show-raw-insn -M intel $o/bench > $o/bench.dis
done
clang-22 --version | head -1
gcc-15 --version | head -1
