#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Exercise infra/publish-gate.sh with a fake `gh` on PATH. Nothing here
# calls GitHub.
#
#   bash infra/publish-gate.test.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
gate="$root/infra/publish-gate.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin"
# FAKE_TIP is the tip of main. FAKE_CI and FAKE_SEC are what the runs
# query returns after --jq: "completed success", "in_progress null",
# "completed failure", or "missing".
cat > "$work/bin/gh" <<'GH'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in repos/*) url="$a" ;; esac; done
case "$url" in
  */commits/main) echo "$FAKE_TIP" ;;
  */workflows/ci.yml/runs*)
    # FAKE_CI_AFTER: answer FAKE_CI for this many calls, then
    # "completed success" (a run that finishes while the gate waits).
    n=0; [ -f "$HOME/ci-calls" ] && n="$(cat "$HOME/ci-calls")"
    echo $((n + 1)) > "$HOME/ci-calls"
    if [ -n "${FAKE_CI_AFTER:-}" ] && [ "$n" -ge "$FAKE_CI_AFTER" ]; then
      echo "completed success"
    else
      echo "$FAKE_CI"
    fi
    ;;
  */workflows/security.yml/runs*) echo "$FAKE_SEC" ;;
  */workflows/publish-images.yml/runs*)
    # FAKE_OLDER: how many older publish runs are still going; with
    # FAKE_OLDER_AFTER, they finish after that many checks.
    m=0; [ -f "$HOME/older-calls" ] && m="$(cat "$HOME/older-calls")"
    echo $((m + 1)) > "$HOME/older-calls"
    if [ -n "${FAKE_OLDER_AFTER:-}" ] && [ "$m" -ge "$FAKE_OLDER_AFTER" ]; then
      echo 0
    else
      echo "${FAKE_OLDER:-0}"
    fi
    ;;
  */actions/runs/*/rerun)
    # A re-run that succeeds: with FAKE_CI_AFTER set, the next runs
    # query answers "completed success".
    echo "$url" >> "$HOME/reruns"
    [ -z "${FAKE_RERUN_FAILS:-}" ] || exit 1
    echo "${FAKE_CI_AFTER:-0}" > "$HOME/ci-calls"
    ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
GH
chmod +x "$work/bin/gh"

SHA=1111111111111111111111111111111111111111
OLD=2222222222222222222222222222222222222222
fails=0

# run NAME WANT_EXIT WANT_PUBLISH [VAR=value ...]
run() {
  local name="$1" want_exit="$2" want_publish="$3"
  shift 3
  local out="$work/out" code=0
  : > "$out"
  rm -f "$work/ci-calls" "$work/reruns" "$work/older-calls"
  env -i PATH="$work/bin:/usr/bin:/bin" HOME="$work" \
    GITHUB_REPOSITORY=palavido-dev/gratis-gis GITHUB_OUTPUT="$out" \
    FAKE_TIP="$SHA" FAKE_CI="completed success" FAKE_SEC="completed success" \
    RUN_EVENT=push RUN_REPO=palavido-dev/gratis-gis RUN_CONCLUSION=success RUN_SHA="$SHA" \
    GATE_WAIT_SECONDS=0 GATE_POLL_SECONDS=0 \
    "$@" bash "$gate" > "$work/log" 2>&1 || code=$?
  local publish
  publish="$(sed -n 's/^publish=//p' "$out" | tail -1)"
  if [ "$code" != "$want_exit" ] || [ "$publish" != "$want_publish" ]; then
    echo "FAIL $name: exit $code publish=$publish (want $want_exit $want_publish)"
    sed 's/^/  /' "$work/log"
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

run "main tip with both green publishes" 0 true EVENT=workflow_run
grep -q "^sha=$SHA$" "$work/out" && grep -q '^ref_type=branch$' "$work/out" \
  || { echo "FAIL main tip outputs"; fails=$((fails + 1)); }
run "red CI does not publish edge" 0 false EVENT=workflow_run FAKE_CI="completed failure"
run "Security still running waits" 0 false EVENT=workflow_run FAKE_SEC="in_progress null"
run "no Security run does not publish" 0 false EVENT=workflow_run FAKE_SEC=missing
run "superseded commit leaves edge alone" 0 false EVENT=workflow_run RUN_SHA="$OLD"
run "failed trigger does not publish" 0 false EVENT=workflow_run RUN_CONCLUSION=failure
run "pull request run does not publish" 0 false EVENT=workflow_run RUN_EVENT=pull_request
run "fork run does not publish" 0 false EVENT=workflow_run RUN_REPO=someone/fork
run "manual run on a branch is refused" 1 false EVENT=workflow_dispatch \
  GITHUB_REF=refs/heads/feature GITHUB_REF_NAME=feature GITHUB_SHA="$SHA"
run "manual run on main with green CI publishes" 0 true EVENT=workflow_dispatch \
  GITHUB_REF=refs/heads/main GITHUB_REF_NAME=main GITHUB_SHA="$SHA"
run "manual run on main with red Security is refused" 1 false EVENT=workflow_dispatch \
  GITHUB_REF=refs/heads/main GITHUB_REF_NAME=main GITHUB_SHA="$SHA" FAKE_SEC="completed failure"
run "release tag with green CI publishes" 0 true EVENT=push \
  GITHUB_REF=refs/tags/v1.2.3 GITHUB_REF_NAME=v1.2.3 GITHUB_REF_TYPE=tag GITHUB_SHA="$SHA"
grep -q '^ref_type=tag$' "$work/out" && grep -q '^ref_name=v1.2.3$' "$work/out" \
  || { echo "FAIL tag outputs"; fails=$((fails + 1)); }
run "release tag with red CI is refused" 1 false EVENT=push \
  GITHUB_REF=refs/tags/v1.2.3 GITHUB_REF_NAME=v1.2.3 GITHUB_REF_TYPE=tag GITHUB_SHA="$SHA" \
  FAKE_CI="completed failure"
run "release tag waits for CI that is still running" 0 true EVENT=push \
  GITHUB_REF=refs/tags/v1.2.3 GITHUB_REF_NAME=v1.2.3 GITHUB_REF_TYPE=tag GITHUB_SHA="$SHA" \
  FAKE_CI="in_progress null" FAKE_CI_AFTER=2 GATE_WAIT_SECONDS=60 GATE_POLL_SECONDS=0
run "release tag gives up when CI is still running after the wait" 1 false EVENT=push \
  GITHUB_REF=refs/tags/v1.2.3 GITHUB_REF_NAME=v1.2.3 GITHUB_REF_TYPE=tag GITHUB_SHA="$SHA" \
  FAKE_CI="in_progress null"
run "release tag that waits and then sees red CI is refused" 1 false EVENT=push \
  GITHUB_REF=refs/tags/v1.2.3 GITHUB_REF_NAME=v1.2.3 GITHUB_REF_TYPE=tag GITHUB_SHA="$SHA" \
  FAKE_CI="completed failure" GATE_WAIT_SECONDS=60 GATE_POLL_SECONDS=0
run "release tag re-runs a CI run that a later merge cancelled" 0 true EVENT=push \
  GITHUB_REF=refs/tags/v1.2.3 GITHUB_REF_NAME=v1.2.3 GITHUB_REF_TYPE=tag GITHUB_SHA="$SHA" \
  FAKE_CI="completed cancelled 4242" FAKE_CI_AFTER=1 GATE_WAIT_SECONDS=60 GATE_POLL_SECONDS=0
grep -q 'actions/runs/4242/rerun' "$work/reruns" 2>/dev/null \
  || { echo "FAIL cancelled run was not re-run"; fails=$((fails + 1)); }
run "release tag re-runs a cancelled run only once" 1 false EVENT=push \
  GITHUB_REF=refs/tags/v1.2.3 GITHUB_REF_NAME=v1.2.3 GITHUB_REF_TYPE=tag GITHUB_SHA="$SHA" \
  FAKE_CI="completed cancelled 4242" GATE_WAIT_SECONDS=60 GATE_POLL_SECONDS=0
[ "$(wc -l < "$work/reruns")" -eq 1 ] \
  || { echo "FAIL cancelled run was re-run more than once"; fails=$((fails + 1)); }
run "release tag is refused when the re-run request fails" 1 false EVENT=push \
  GITHUB_REF=refs/tags/v1.2.3 GITHUB_REF_NAME=v1.2.3 GITHUB_REF_TYPE=tag GITHUB_SHA="$SHA" \
  FAKE_CI="completed cancelled 4242" FAKE_RERUN_FAILS=1 GATE_WAIT_SECONDS=60 GATE_POLL_SECONDS=0
run "cancelled CI on main tip does not publish edge" 0 false EVENT=workflow_run \
  FAKE_CI="completed cancelled 4242"
[ ! -e "$work/reruns" ] || { echo "FAIL workflow_run re-ran a run"; fails=$((fails + 1)); }
run "tag waits for an older publish run on the same commit" 0 true EVENT=push \
  GITHUB_REF=refs/tags/v1.2.3 GITHUB_REF_NAME=v1.2.3 GITHUB_REF_TYPE=tag GITHUB_SHA="$SHA" \
  GITHUB_RUN_ID=50 FAKE_OLDER=1 FAKE_OLDER_AFTER=2 PUBLISH_WAIT_SECONDS=60 GATE_POLL_SECONDS=0
run "tag is refused while an older publish run never finishes" 1 false EVENT=push \
  GITHUB_REF=refs/tags/v1.2.3 GITHUB_REF_NAME=v1.2.3 GITHUB_REF_TYPE=tag GITHUB_SHA="$SHA" \
  GITHUB_RUN_ID=50 FAKE_OLDER=1 PUBLISH_WAIT_SECONDS=0
run "edge skips while an older publish run never finishes" 0 false EVENT=workflow_run \
  GITHUB_RUN_ID=50 FAKE_OLDER=1 PUBLISH_WAIT_SECONDS=0
run "branch push is refused" 1 false EVENT=push \
  GITHUB_REF=refs/heads/main GITHUB_REF_NAME=main GITHUB_REF_TYPE=branch GITHUB_SHA="$SHA"

# The workflow must route every publish through the gate.
wf="$root/.github/workflows/publish-images.yml"
if sed -n '/^on:/,/^permissions:/p' "$wf" \
  | awk '/^  push:/ {p=1; next} /^  [a-z_]+:/ {p=0} p' | grep -q 'branches'; then
  echo "FAIL publish-images.yml still publishes on a branch push"
  fails=$((fails + 1))
fi
for job in build script-runner ensure-public; do
  if ! awk -v job="  $job:" '$0 == job {inside=1; next} inside && /^  [a-z]/ {inside=0} inside' "$wf" \
    | grep -q 'needs:.*gate'; then
    echo "FAIL job $job does not need the gate"
    fails=$((fails + 1))
  fi
done

if [ "$fails" -ne 0 ]; then
  echo "publish-gate: $fails failure(s)"
  exit 1
fi
echo "publish-gate: ok"
