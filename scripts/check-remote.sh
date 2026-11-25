#!/usr/bin/env bash
# Runs the check of a commit on the check runner (a 64-core Linux host; see docs/PORTING.md, "Check runner"), from here:
#
#   scripts/check-remote.sh [COMMIT] [check arguments...]      (default: HEAD; full unless quick is given)
#   e.g. CI=true WUICA_TEST_SCROLLBARS=15 scripts/check-remote.sh HEAD full --no-skip
#
# - Sends exactly that commit (it may be unpushed: it goes over ssh to a bare repository on the runner, never through
#   GitHub), checks it out in the runner's tree with nothing else in it (only the build caches in target/ and the npm
#   installations stay), links the generated files from the commit's CI data asset, and runs the commit's own
#   scripts/check.sh with the given arguments under a perfq lease (shared) taken here. Uncommitted changes are not sent.
# - The output streams here; the summary lines are the check's own. The logs of the failed suites, the whole output and
#   results.json are copied back to target/check-remote/<run>/. The exit status is the check's; a run that did not finish
#   (interrupted, the lease ended, the connection lost) exits non-zero too.
# - One check at a time in the runner's tree: a second one waits on the runner until the first is done.
# - The environment variables CI, WUICA_TEST_* and WUICA_CHROME_JOBS are passed on. On the runner WUICA_CHROME_JOBS
#   defaults to auto (browser suites at a time from its core count).
#
# WUICA_RUNNER (ssh host alias, default diomedea), WUICA_RUNNER_DIR (default /data/projects/wuica-check),
# WUICA_RUNNER_EST (the lease's estimate, default 15m). Set the runner up with scripts/runner-setup.sh.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
host="${WUICA_RUNNER:-diomedea}"
dir="${WUICA_RUNNER_DIR:-/data/projects/wuica-check}"
perfq="$HOME/perfq/perfq"
say() { echo "check-remote: $*" >&2; }

commit=HEAD
if [ $# -gt 0 ] && [ "$1" != quick ] && [ "$1" != full ] && [ "${1#-}" = "$1" ]; then commit="$1"; shift; fi
case " $* " in *" quick "*|*" full "*) ;; *) set -- full "$@" ;; esac # (full unless the arguments name a mode)
sha="$(git -C "$root" rev-parse --verify --quiet "$commit^{commit}")" || { say "not a commit: $commit"; exit 2; }
if [ "$commit" = HEAD ] && [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
  say "note: uncommitted changes are not checked (only the commit $(git -C "$root" rev-parse --short HEAD))"
fi
[ -x "$perfq" ] || { say "perfq not found at $perfq"; exit 2; }

# the commit to the runner's bare repository (over ssh)
git -C "$root" push --quiet --no-verify "$host:$dir/repo.git" "+$sha:refs/check/$sha" || { say "cannot push to $host:$dir/repo.git (scripts/runner-setup.sh sets it up)"; exit 2; }

id="$(date -u +%Y%m%d-%H%M%S)-${sha:0:10}-$$"
envs=""
for v in CI WUICA_CHROME_JOBS $(compgen -e | grep -E '^WUICA_TEST_[A-Z_]+$' || true); do
  if [ -n "${!v+x}" ]; then envs+=" $v=$(printf %q "${!v}")"; fi
done
args=""
for a in "$@"; do args+=" $(printf %q "$a")"; done
remote="env$envs bash -s -- check $(printf %q "$dir") $id $sha$args"
say "$(git -C "$root" log -1 --format='%h %s' "$sha") on $host (run $id; waits for a shared lease while the host is busy)"

interrupted=0
trap 'interrupted=1' INT TERM
# (no pipe: the status is perfq's, which is the remote command's, or perfq's own 75/76, or ssh's 255)
"$perfq" ssh "$host" --est "${WUICA_RUNNER_EST:-15m}" --mode shared --owner wuica-check -- "$remote" < "$root/scripts/runner-remote.sh"
status=$?
trap - INT TERM

# the status the runner wrote at the end of the check: none means it did not finish
remote_status="$(ssh "$host" "cat $(printf %q "$dir/runs/$id/status") 2>/dev/null")" || remote_status=""
if [ -z "$remote_status" ]; then
  say "the check did not finish on the runner (exit $status)"
  [ "$status" != 0 ] || status=1
elif [ "$remote_status" != "$status" ]; then
  say "the runner's check exited $remote_status, the lease $status"
  [ "$remote_status" = 0 ] || status="$remote_status"
  [ "$status" != 0 ] || status=1
fi
[ "$interrupted" = 0 ] || [ "$status" != 0 ] || status=130

# the output, results.json and the logs of the failed suites (those check.mjs prints the tail of)
local_dir="$root/target/check-remote/$id"
mkdir -p "$local_dir"
list="$(ssh "$host" "cd $(printf %q "$dir/runs/$id") 2>/dev/null && { ls output.txt status results.json 2>/dev/null; sed -n 's|^---- .*: last [0-9]* lines of target/check/\(.*\.log\)\$|\1|p' output.txt 2>/dev/null | sort -u; }")" || list=""
failed=0
if [ -n "$list" ]; then
  printf '%s\n' "$list" | rsync -a --files-from=- "$host:$dir/runs/$id/" "$local_dir/" || say "copying the logs back failed"
  failed="$(printf '%s\n' "$list" | grep -c '\.log$')"
fi
say "exit $status; output$([ "$failed" = 0 ] || echo " and the logs of $failed failed suites") in ${local_dir#"$root"/}/"
exit "$status"
