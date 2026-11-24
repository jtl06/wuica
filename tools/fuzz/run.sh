#!/usr/bin/env bash
# The differential fuzzer against the Python reference (docs/PORTING.md, "Differential fuzzer"). Runs on the machine that has the
# reference; builds wuica's native binary, the instruction pool (once), then the cases in chunks. Resumable: a rerun with the same
# arguments skips the chunks already done.
#
#   tools/fuzz/run.sh --cases N --seed S [--arch X] [--jobs J] [--out DIR]
#
# Environment: UICA_DIR (a uiCA tree with instrData/ and the xed module; default /data/projects/wuica-fuzz/uica), PYTHON (its
# interpreter; default ~/uica-zen/venv/bin/python), WUICA_DATA (default: data/ of this tree), CARGO_TARGET_DIR.
# Output: DIR/log.txt, DIR/summary.json (verdicts per CPU), DIR/findings/*.json (minimized and classified differences).
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd)
R=$(cd "$T/../.." && pwd)
UICA_DIR=${UICA_DIR:-/data/projects/wuica-fuzz/uica}
PYTHON=${PYTHON:-$HOME/uica-zen/venv/bin/python}
DATA=${WUICA_DATA:-$R/data}
CASES=1000 SEED=1 ARCH= JOBS= OUT=
while [ $# -gt 0 ]; do
  case $1 in
    --cases) CASES=$2; shift 2 ;;
    --seed) SEED=$2; shift 2 ;;
    --arch) ARCH=$2; shift 2 ;;
    --jobs) JOBS=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
OUT=${OUT:-$R/target/fuzz/seed$SEED${ARCH:+-$ARCH}}
mkdir -p "$OUT"
export PYTHONDONTWRITEBYTECODE=1 TMPDIR=$OUT
(cd "$R" && cargo build --release -q -p wuica-cli)
WUICA=${CARGO_TARGET_DIR:-$R/target}/release/wuica
POOL=$OUT/../pool.jsonl.gz
[ -f "$POOL" ] || "$PYTHON" "$T/fuzz.py" pool "$UICA_DIR" "$POOL" > "$OUT/../pool.log" 2>&1
"$PYTHON" "$T/fuzz.py" run --uica "$UICA_DIR" --wuica "$WUICA" --data "$DATA" --pool "$POOL" --out "$OUT" --cases "$CASES" \
  --seed "$SEED" ${ARCH:+--arch "$ARCH"} ${JOBS:+--jobs "$JOBS"}
