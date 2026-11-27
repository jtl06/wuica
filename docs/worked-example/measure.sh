#!/bin/sh
# usage: measure.sh CPU [RUNS]
# Runs every kernel of both builds pinned to CPU, user-mode counters, N=1024 elements (8 KB) per call.
# Each run counts REPS calls; the per-run lines are cycles and instructions per element.
# Then one perf stat per kernel over the whole process as a cross-check of the in-process counters.
set -e
cd "$(dirname "$0")"
CPU=${1:-2}
RUNS=${2:-9}
N=1024
REPS=40000
echo "host $(hostname) cpu $CPU $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2) kernel $(uname -r)"
echo "date $(date -u +%Y-%m-%dT%H:%M:%SZ) load $(cut -d' ' -f1-3 /proc/loadavg)"
for cc in gcc-15 clang-22; do
  for k in fill_before fill_after sum1 sum4 roundtrip; do
    echo "## $cc $k"
    taskset -c $CPU build/$cc/bench $k $N $REPS $RUNS
  done
done
EV=cycles:u,instructions:u
[ -d /sys/bus/event_source/devices/cpu_core ] && EV=cpu_core/cycles/u,cpu_core/instructions/u
for cc in gcc-15 clang-22; do
  for k in fill_before fill_after sum1 sum4; do
    echo "## perf stat $cc $k (whole process: $N x $REPS x (1 + 1 warm-up) elements)"
    perf stat -x, -e $EV taskset -c $CPU build/$cc/bench $k $N $REPS 1 2>&1 >/dev/null | cut -d, -f1,3
  done
done
