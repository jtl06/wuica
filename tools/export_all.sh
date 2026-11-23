#!/usr/bin/env bash
# Exports the instruction tables and the fixture sets that the tests read (data/, fixtures/generated/) from a uiCA tree.
#
#   tools/export_all.sh UICA_DIR OUT_DIR CORPUS_LIST EXTRA_OBJ_DIR
#
#   UICA_DIR       a uiCA installation (instrData/ generated with its convertXML.py, XED module built), e.g. a checkout of jtl06/uiCA
#   OUT_DIR        gets OUT_DIR/data (-> data/) and OUT_DIR/fix (-> fixtures/generated/)
#   CORPUS_LIST    file with the paths of the object files of the main set, one per line (329 files)
#   EXTRA_OBJ_DIR  the object files of the extra set (fixtures/extra-src/x_*.s, assembled with `as`)
#
# Runs with the Python of the uiCA installation ($PYTHON, default python3). Writes data/arch/*.json, data/uarch.json,
# instr_fixtures, sim_fixtures (main set) and extra_instr_fixtures, extra_sim_fixtures (one process per case, FRESH=1).
# About 3 minutes with 15 processes (aethia). The decoder fixtures (fixtures/decode_fixtures*.jsonl.gz, in git) depend only on
# XED and are not exported here.
set -euo pipefail
U=$1; OUT=$2; CORPUS=$3; EXTRA=$4
P=${PYTHON:-python3}
T=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT/data" "$OUT/fix"
"$P" "$T/export_data.py" "$U" "$OUT/data"
"$P" "$T/export_fixtures.py" "$U" "$OUT/fix" $(cat "$CORPUS")
FRESH=1 PREFIX=extra_ "$P" "$T/export_fixtures.py" "$U" "$OUT/fix" "$EXTRA"/*.o
