# The check runner's side of scripts/runner-setup.sh and scripts/check-remote.sh (see docs/PORTING.md, "Check runner").
# Not run from the runner's own tree: the development machine sends this file over ssh (`bash -s -- COMMAND ...` with
# the file on stdin), so a commit that predates it can be checked too, and the runner keeps no scripts of its own.
#
#   setup DIR CHROME(0|1) CHROME_UPDATE(0|1)   tools, the bare repository, Chrome for Testing (light work)
#   asset DIR TAG FILE SHA256                  the CI data asset of TAG in DIR/assets/TAG (if not there yet)
#   check DIR ID SHA [check arguments...]      the check of commit SHA in DIR/tree, the run's files in DIR/runs/ID
#                                              (check-remote.sh runs this under a perfq lease)
set -euo pipefail
cmd="${1:?usage: runner-remote.sh setup|asset|check DIR ...}"
dir="${2:?runner-remote.sh: DIR missing}"
shift 2
ASSET_REPO="${WUICA_ASSET_REPO:-jtl06/wuica}" # (as ci/fetch-data-asset.sh)
say() { echo "check-remote: $*"; }

# the CI data asset (ci/data-asset.txt: tag, file, sha256) unpacked and checked in DIR/assets/TAG (.ok when complete)
asset() {
  local tag="$1" file="$2" sum="$3" a="$dir/assets/$1"
  [ -f "$a/.ok" ] && return 0
  mkdir -p "$dir/assets"
  exec 8>"$dir/assets/.lock"
  flock 8
  if [ ! -f "$a/.ok" ]; then
    say "fetching the CI data asset $tag"
    rm -rf "$a.part" "$a" && mkdir -p "$a.part"
    curl -fsSL -o "$a.part/$file" "https://github.com/$ASSET_REPO/releases/download/$tag/$file"
    echo "$sum  $a.part/$file" | sha256sum -c --quiet -
    tar -C "$a.part" -xJf "$a.part/$file"
    (cd "$a.part" && sha256sum -c --quiet MANIFEST.txt)
    rm "$a.part/$file"
    touch "$a.part/.ok"
    mv "$a.part" "$a"
  fi
  flock -u 8
  exec 8>&-
}

case "$cmd" in
setup)
  chrome="$1" chrome_update="$2"
  fail=0
  need() { if ! command -v "$1" >/dev/null 2>&1; then echo "  missing: $1 ($2)"; fail=1; fi; }
  echo "tools:"
  for t in git curl python3 flock xz sha256sum tar ldd; do need "$t" "a system tool"; done
  need node "Node 22 or later (CI uses 22)"
  need npm "npm (comes with Node)"
  need clang "a clang with the wasm32 target (build-wasm.sh)"
  need rustup "rustup"
  [ "$fail" = 0 ] || exit 1
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "  Node $(node -v) is too old: the check needs 22 or later"; exit 1; }
  clang --print-targets | grep -q wasm32 || { echo "  clang has no wasm32 target"; exit 1; }
  llvm="$(dirname "$(readlink -f "$(command -v clang)")")"
  for t in llvm-ar llvm-objcopy; do [ -x "$llvm/$t" ] || command -v "$t" >/dev/null || { echo "  missing: $t (next to clang or on the PATH)"; exit 1; }; done
  rustup target list --installed | grep -qx wasm32-unknown-unknown || rustup target add wasm32-unknown-unknown
  echo "  node $(node -v), npm $(npm -v), $(clang --version | head -1), $(rustc -V), $(git --version)"

  mkdir -p "$dir"/{assets,extra,runs}
  [ -d "$dir/repo.git" ] || git init --quiet --bare "$dir/repo.git"
  echo "repository: $dir/repo.git"

  if [ "$chrome" = 1 ]; then
    base="$dir/chrome"
    mkdir -p "$base/dl"
    if [ "$chrome_update" = 1 ] || [ ! -x "$base/current/chrome-linux64/chrome" ]; then
      # the stable build of Chrome for Testing for linux64, from Google's endpoints only
      json="$base/dl/last-known-good-versions-with-downloads.json"
      curl -fsSL -o "$json" https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json
      read -r version url < <(python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1]))["channels"]["Stable"]
u = [x["url"] for x in d["downloads"]["chrome"] if x["platform"] == "linux64"][0]
assert u.startswith("https://storage.googleapis.com/chrome-for-testing-public/"), u
print(d["version"], u)' "$json")
      if [ ! -x "$base/$version/chrome-linux64/chrome" ]; then
        mkdir -p "$base/dl/$version"
        zip="$base/dl/$version/chrome-linux64.zip"
        echo "chrome: downloading $url"
        curl -fsSL -o "$zip.part" "$url"
        mv "$zip.part" "$zip"
        rm -rf "$base/$version.part" && mkdir -p "$base/$version.part"
        # (no unzip on every host: Python's zipfile, which drops the files' modes, so they are set from the archive; and
        # nothing is written outside the target)
        python3 -I -c '
import os, sys, zipfile
src, dest = sys.argv[1], os.path.realpath(sys.argv[2])
with zipfile.ZipFile(src) as z:
    for i in z.infolist():
        p = os.path.realpath(os.path.join(dest, i.filename))
        if not p.startswith(dest + os.sep): sys.exit("unsafe path in the archive: " + i.filename)
        z.extract(i, dest)
        mode = (i.external_attr >> 16) & 0o777
        if mode and not i.is_dir(): os.chmod(p, mode)' "$zip" "$base/$version.part"
        { echo "version=$version"; echo "url=$url"; echo "sha256=$(sha256sum "$zip" | cut -d' ' -f1)"; echo "bytes=$(stat -c %s "$zip")"
          echo "downloaded=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; } > "$base/$version.part/SOURCE.txt"
        mv "$base/$version.part" "$base/$version"
      fi
      ln -sfn "$version" "$base/current"
    fi
    # The Chrome the check runs (CHROME): the sandbox needs unprivileged user namespaces, which AppArmor restricts for a
    # binary outside the system's packages (kernel.apparmor_restrict_unprivileged_userns=1); the suites open only pages
    # served from 127.0.0.1. exec keeps the PID: the suites stop Chrome as usual.
    printf '#!/bin/sh\nexec "$(dirname "$0")/current/chrome-linux64/chrome" --no-sandbox "$@"\n' > "$base/chrome"
    chmod +x "$base/chrome"
    sed 's/^/  /' "$base/current/SOURCE.txt"
    missing="$(ldd "$base/current/chrome-linux64/chrome" | awk '/not found/ {print $1}' | sort -u | tr '\n' ' ')"
    if [ -n "$missing" ]; then
      echo "chrome: does not start here, shared libraries missing: $missing"
      echo "  (on Ubuntu: sudo apt-get install libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libasound2t64 libxdamage1;"
      echo "  until then the browser suites are skipped on the runner, which --no-skip counts as failures)"
    else
      echo "chrome: $("$base/chrome" --version)"
    fi
  fi
  ;;

asset)
  asset "$@"
  ;;

check)
  id="$1" sha="$2"
  shift 2
  run="$dir/runs/$id"
  mkdir -p "$run"
  # one check at a time in the tree: a second one waits here (the lock goes with the process, so it cannot go stale)
  exec 9>"$dir/tree.lock"
  if ! flock -n 9; then
    say "another check is running in $dir/tree; waiting for it"
    flock 9
  fi
  git -C "$dir/repo.git" cat-file -e "$sha^{commit}" 2>/dev/null || { say "$sha is not in $dir/repo.git"; exit 2; }
  if [ ! -e "$dir/tree/.git" ]; then
    git -C "$dir/repo.git" worktree prune
    git -C "$dir/repo.git" worktree add --quiet --detach "$dir/tree" "$sha"
  fi
  cd "$dir/tree"
  # exactly the commit: everything else removed, except the build caches (target/) and the npm installations, which are
  # dropped when their lock file changed (scripts/check.mjs installs them again)
  git checkout --quiet --force --detach "$sha"
  git clean -ffdxq -e /target -e '/target-*' -e node_modules
  for d in packages/wuica server; do
    if [ -d "$d/node_modules" ] && [ "$(cat "$d/node_modules/.check-lock-sha256" 2>/dev/null)" != "$(sha256sum "$d/package-lock.json" | cut -d' ' -f1)" ]; then
      rm -rf "$d/node_modules"
    fi
  done
  # the generated files from the commit's CI data asset (plus DIR/extra/, files beside it: runner-setup.sh --more-sim)
  [ -f ci/data-asset.txt ] || { say "this commit has no ci/data-asset.txt"; exit 2; }
  get() { sed -n "s/^$1=//p" ci/data-asset.txt; }
  tag="$(get tag)"
  asset "$tag" "$(get file)" "$(get sha256)"
  a="$dir/assets/$tag"
  ln -sfn "$a/data" data
  mkdir -p fixtures/generated assembler/dist mca/dist
  for f in "$a"/fixtures/generated/* "$dir"/extra/fixtures/generated/*; do [ -e "$f" ] && ln -sfn "$f" fixtures/generated/; done
  cp "$a/assembler/dist/wuica_asm.wasm" assembler/dist/
  if [ -f "$a/mca/dist/wuica_mca.wasm" ]; then cp "$a/mca/dist/wuica_mca.wasm" mca/dist/; fi
  # Chrome for Testing (runner-setup.sh), if it starts here
  if [ -z "${CHROME:-}" ] && [ -x "$dir/chrome/chrome" ]; then
    if "$dir/chrome/chrome" --version >/dev/null 2>&1; then
      export CHROME="$dir/chrome/chrome"
    else
      say "Chrome for Testing does not start on this host; shared libraries missing: $(ldd "$dir/chrome/current/chrome-linux64/chrome" | awk '/not found/ {print $1}' | sort -u | tr '\n' ' ')"
    fi
  fi
  # temporary files (Chrome profiles, copies of web/dist) on this disk; those of earlier runs are gone with them
  rm -rf "$dir"/runs/*/tmp
  export TMPDIR="$run/tmp"
  mkdir -p "$TMPDIR"
  export WUICA_CHROME_JOBS="${WUICA_CHROME_JOBS:-auto}" WUICA_SCCACHE="${WUICA_SCCACHE:-0}" CARGO_TERM_COLOR=never
  chrome_version=none
  [ -z "${CHROME:-}" ] || chrome_version="$("$CHROME" --version 2>/dev/null | awk '{print $NF}')"
  say "$(git log -1 --format='%h %s' "$sha") in $dir/tree; $(nproc) CPUs, Node $(node -v), rustc $(rustc -V | cut -d' ' -f2), Chrome $chrome_version"
  say "environment: $( (env | grep -E '^(CI|WUICA_TEST_[A-Z_]+|WUICA_CHROME_JOBS)=' || true) | sort | tr '\n' ' ')"

  set +e
  bash scripts/check.sh "$@" 2>&1 | tee "$run/output.txt"
  status="${PIPESTATUS[0]}"
  set -e
  cp target/check/*.log "$run/" 2>/dev/null || true
  cp target/check/results.json "$run/" 2>/dev/null || true
  # the npm installations are good for the lock files they came from (unless their build step failed)
  if ! grep -qE '^ *(FAIL|NOT RUN) +build:(npm|server) ' "$run/output.txt"; then
    for d in packages/wuica server; do
      [ -d "$d/node_modules" ] && sha256sum "$d/package-lock.json" | cut -d' ' -f1 > "$d/node_modules/.check-lock-sha256"
    done
  fi
  rm -rf "$TMPDIR"
  echo "$status" > "$run/status"
  # keep the last 30 runs, and the refs of the last 50 commits checked
  ls -1dt "$dir"/runs/*/ 2>/dev/null | tail -n +31 | xargs -r rm -rf
  git -C "$dir/repo.git" for-each-ref --sort=-creatordate --format='%(refname)' refs/check/ | tail -n +51 | xargs -r -n1 git -C "$dir/repo.git" update-ref -d
  exit "$status"
  ;;

*)
  echo "runner-remote.sh: unknown command $cmd" >&2
  exit 2
  ;;
esac
