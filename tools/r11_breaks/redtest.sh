#!/bin/bash
# applies each break to the worktree, runs wuica:model_r11, restores the file; one line per break
B=$(cd "$(dirname "$0")" && pwd)
cd "$B/../.."
export PATH=/opt/homebrew/opt/rustup/bin:$PATH CARGO_TARGET_DIR=$PWD/target-breaks
for b in $(cd $B && python3 -c "import breaks; print(' '.join(breaks.BREAKS))"); do
  f=$(cd $B && python3 -c "import breaks; print(breaks.BREAKS['$b'][0])")
  git diff --quiet -- "$f" || { echo "$f has changes: stop"; exit 1; }
  (cd $B && python3 breaks.py $b "$B/../..")
  out=$(cargo test --release -q -p wuica --test model_r11 -- --nocapture 2>&1)
  git checkout -q -- "$f"
  echo "$b: $(echo "$out" | grep -E '^(one parameter|boundaries)' | tr '\n' ' ')"
done
out=$(cargo test --release -q -p wuica --test model_r11 -- --nocapture 2>&1); echo "unchanged: $(echo "$out" | grep -E '^(one parameter|boundaries)' | tr '\n' ' ')"
