#!/bin/sh
# usage: mca.sh [EXTRA_LLVM_MCA_FLAGS]   (after build.sh; e.g. mca.sh -noalias=false)
# Cuts each hot loop out of the compiler's -S output (from its label to the branch back to it) and
# runs llvm-mca 22 on it for the three CPUs. Prints total cycles / iterations.
cd "$(dirname "$0")"
MCA=/usr/lib/llvm-22/bin/llvm-mca
$MCA --version | grep -i version
cut_loop() {  # file label
  awk -v L="$2" '$0 == L":" || index($0, L":") == 1 {on=1} on && !/^\s*(\.cfi|#|\.p2align)/ {print} on && $0 ~ ("j[a-z]+\t" L "$") {exit}' "$1"
}
mkdir -p mca
FLAGS="$*"  # (set -- below replaces the arguments)
echo "flags: -mcpu=CPU -iterations=1000 $FLAGS"
for spec in "gcc-15 xoshiro fill_before .L3" "gcc-15 xoshiro fill_after .L8" \
            "clang-22 xoshiro fill_before .LBB0_2" "clang-22 xoshiro fill_after .LBB1_8" \
            "gcc-15 sum sum1 .L3" "gcc-15 sum sum4 .L15" "clang-22 sum sum1 .LBB0_9" "clang-22 sum sum4 .LBB1_9"; do
  set -- $spec
  f=mca/$1-$3.s
  cut_loop build/$1/$2.s $4 > $f
  for cpu in znver3 alderlake icelake-server; do
    printf '%s %s %s ' $1 $3 $cpu
    $MCA -mcpu=$cpu -iterations=1000 $FLAGS $f 2>&1 | awk '/^Iterations:/{it=$2} /^Total Cycles:/{c=$3} /^Block RThroughput:/{rt=$3} END{printf "cycles/iter %.3f  (total %d, block rthroughput %s)\n", c/it, c, rt}'
  done
done
