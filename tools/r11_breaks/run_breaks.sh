#!/bin/bash
# builds each break and compares it on the reviewer's reference outputs of its mechanisms (7b8f800 data)
set -e
W=/data/projects/wuica-r11/breaks; P=~/uica-zen/venv/bin/python; RV=/data/projects/wuica-r11-review/targ
cd $W
for b in $(python3 -c "import breaks; print(' '.join(breaks.BREAKS))"); do
  rm -rf src-b && cp -r src src-b
  python3 breaks.py $b src-b
  (cd src-b && CARGO_TARGET_DIR=$W/target cargo build --release -q -p wuica-cli 2>&1 | grep -E '^error' || true)
  cp $W/target/release/wuica bin/wuica-$b
  mechs=$(python3 -c "import breaks; print(breaks.BREAKS['$b'][3])")
  $P -c "
import json
ms=set('$mechs'.split())
with open('ref-$b.jsonl','w') as f:
    for src in ['$RV/ref.jsonl', '$RV/lsdend_ref.jsonl']:
        for l in open(src):
            i=l.find('\"mech\": \"')
            if json.loads(l)['mech'] in ms: f.write(l)
"
  echo "== $b ($mechs)"
  $P r11targ.py cmp ref-$b.jsonl bin/wuica-$b /data/projects/wuica-r11/r11/data work-$b | tail -1
  rm -f ref-$b.jsonl
done
