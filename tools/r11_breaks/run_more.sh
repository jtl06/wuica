#!/bin/bash
# the breaks added later (same as run_breaks.sh, for the names given)
set -e
W=/data/projects/wuica-r11/breaks; P=~/uica-zen/venv/bin/python; RV=/data/projects/wuica-r11-review/targ
cd $W
for b in "$@"; do
  rm -rf src-c && cp -r src src-c
  python3 breaks.py $b src-c
  (cd src-c && CARGO_TARGET_DIR=$W/target-c cargo build --release -q -p wuica-cli 2>&1 | grep -E '^error' || true)
  cp $W/target-c/release/wuica bin/wuica-$b
  mechs=$(python3 -c "import breaks; print(breaks.BREAKS['$b'][3])")
  $P -c "
import json
ms=set('$mechs'.split())
with open('ref-$b.jsonl','w') as f:
    for src in ['$RV/ref.jsonl', '$RV/lsdend_ref.jsonl']:
        for l in open(src):
            if json.loads(l)['mech'] in ms: f.write(l)
"
  echo "== $b ($mechs)"
  $P r11targ.py cmp ref-$b.jsonl bin/wuica-$b /data/projects/wuica-r11/r11/data work-$b | tail -1
  rm -f ref-$b.jsonl
done
