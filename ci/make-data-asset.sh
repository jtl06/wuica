#!/usr/bin/env bash
# Builds the data asset of the CI workflow (.github/workflows/ci.yml): the generated files that `scripts/check.sh full` needs
# and that are not in git, as one reproducible archive, and writes its hashes to ci/data-asset.txt.
#
#   ci/make-data-asset.sh TAG [SRC]
#
#   TAG  the release tag it will be uploaded to (ci-data-v1, ci-data-v2, ...)
#   SRC  a checkout that has data/, fixtures/generated/, assembler/dist/wuica_asm.wasm and mca/dist/wuica_mca.wasm (default: this repository)
#   UICA_COMMIT (environment): the fork's model commit the data come from, for ci/data-asset.txt (default: read from docs/DESIGN.md)
#
# Contents: data/ (instruction tables, uarch.json), the four fixture files the suites read
# (fixtures/generated/{,extra_}{instr,sim}_fixtures.jsonl.gz), the accuracy table of the accuracy gate
# (fixtures/generated/accuracy.jsonl.gz, made by microbench/accuracy_export.py of the fork; see docs/PORTING.md),
# assembler/dist/wuica_asm.wasm, mca/dist/wuica_mca.wasm, and MANIFEST.txt (sha256 of every
# file, for `sha256sum -c`). The tar is written by Python (sorted names, fixed mtime, owner 0, mode 0644, no extended
# attributes) and compressed with xz (preset 6, one thread), so the same inputs give the same bytes.
# Output: target/ci-data/wuica-ci-data.tar.xz. Then upload it (see docs/PORTING.md, "CI"):
#   gh release create TAG target/ci-data/wuica-ci-data.tar.xz --prerelease --title "..." --notes "..."
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="${1:?usage: ci/make-data-asset.sh TAG [SRC]}"
src="$(cd "${2:-$root}" && pwd)"
out="$root/target/ci-data"
name="wuica-ci-data.tar.xz"
mkdir -p "$out"

files=(
  fixtures/generated/instr_fixtures.jsonl.gz
  fixtures/generated/sim_fixtures.jsonl.gz
  fixtures/generated/extra_instr_fixtures.jsonl.gz
  fixtures/generated/extra_sim_fixtures.jsonl.gz
  fixtures/generated/accuracy.jsonl.gz
  assembler/dist/wuica_asm.wasm
  mca/dist/wuica_mca.wasm
  data/uarch.json
)
for f in "$src"/data/arch/*.json; do files+=("data/arch/$(basename "$f")"); done
for f in "${files[@]}"; do [ -f "$src/$f" ] || { echo "missing: $src/$f" >&2; exit 1; }; done

meta="$(python3 -I - "$src" "$out/$name" "${files[@]}" <<'EOF'
import hashlib, io, lzma, os, sys, tarfile
src, dest, *files = sys.argv[1:]
MTIME = 1704067200  # 2024-01-01T00:00:00Z

def info(name, size):
    ti = tarfile.TarInfo(name)
    ti.size, ti.mtime, ti.mode, ti.uid, ti.gid, ti.uname, ti.gname = size, MTIME, 0o644, 0, 0, '', ''
    return ti

files = sorted(files)
manifest = ''.join(f'{hashlib.sha256(open(os.path.join(src, f), "rb").read()).hexdigest()}  {f}\n' for f in files).encode()
entries = sorted([('MANIFEST.txt', None)] + [(f, os.path.join(src, f)) for f in files])
raw = io.BytesIO()
with tarfile.open(fileobj=raw, mode='w', format=tarfile.GNU_FORMAT) as tar:
    for name, path in entries:
        if path is None:
            tar.addfile(info(name, len(manifest)), io.BytesIO(manifest))
        else:
            with open(path, 'rb') as fh:
                tar.addfile(info(name, os.path.getsize(path)), fh)
data = raw.getvalue()
xz = lzma.compress(data, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64, preset=6)
open(dest, 'wb').write(xz)
print(f'tar_sha256={hashlib.sha256(data).hexdigest()}')
print(f'tar_bytes={len(data)}')
EOF
)"

if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum "$1" | cut -d' ' -f1; }; else sha() { shasum -a 256 "$1" | cut -d' ' -f1; }; fi
# the commit of this repository the asset was made (and checked) with, and the uiCA commit the fixtures come from (docs/DESIGN.md)
commit="$(git -C "$root" rev-parse HEAD)"
uica="${UICA_COMMIT:-$(tr '\n' ' ' < "$root/docs/DESIGN.md" | sed -n 's/.*branch `perf`, commit *`\([0-9a-f]*\)`.*/\1/p')}"
cat > "$root/ci/data-asset.txt" <<EOT
# The data asset of the CI workflow (.github/workflows/ci.yml), written by ci/make-data-asset.sh. The workflow downloads
# \`file\` from the release \`tag\`, checks \`sha256\` (of the .tar.xz), unpacks it and checks MANIFEST.txt inside.
# tar_sha256 (of the uncompressed tar) is for checking a rebuild: xz versions may compress differently.
tag=$tag
file=$name
sha256=$(sha "$out/$name")
bytes=$(wc -c < "$out/$name" | tr -d ' ')
$meta
files=${#files[@]}
wuica_commit=$commit
uica_commit=${uica:-unknown}
EOT
cat "$root/ci/data-asset.txt"
