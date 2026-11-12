#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Decide whether publish-images.yml may publish, and for which commit.
#
# NAS installs pull `edge` on every restart, so images publish only
# for a commit whose CI and Security push runs on main both passed.
# A workflow_run trigger also needs that commit to still be the tip
# of main, so a slow run on an older commit cannot move edge back.
# A manual run is refused on any ref but main or a release tag.
#
# Inputs (env): EVENT, GITHUB_REPOSITORY, GITHUB_OUTPUT, GITHUB_SHA,
# GITHUB_REF, GITHUB_REF_NAME, GITHUB_REF_TYPE, and for workflow_run
# RUN_SHA, RUN_EVENT, RUN_REPO, RUN_CONCLUSION. Needs `gh` with a
# token that can read Actions runs.
#
# Writes publish, sha, ref_type and ref_name to GITHUB_OUTPUT. A
# workflow_run that should not publish exits 0 with publish=false;
# a tag push or manual run that should not publish exits 1. A tag
# push or manual run waits up to GATE_WAIT_SECONDS (default 3600) for
# CI and Security on its commit to finish, polling every
# GATE_POLL_SECONDS (default 30). With GITHUB_RUN_ID set, it then
# waits up to PUBLISH_WAIT_SECONDS (default 10800) for older publish
# runs on the same commit to finish. If the newest run on the commit was
# cancelled, a tag push or manual run asks GitHub to re-run it once
# and keeps waiting (see the note above the loop).
#
#   bash infra/publish-gate.test.sh
set -euo pipefail
repo="$GITHUB_REPOSITORY"
skip() { echo "::notice::$1"; echo "publish=false" >> "$GITHUB_OUTPUT"; exit 0; }
refuse() { echo "::error::$1"; echo "publish=false" >> "$GITHUB_OUTPUT"; exit 1; }
case "$EVENT" in
  workflow_run)
    [ "$RUN_EVENT" = "push" ] || skip "Triggered by a $RUN_EVENT run, not a push to main."
    [ "$RUN_REPO" = "$repo" ] || skip "Triggered by a run from $RUN_REPO."
    [ "$RUN_CONCLUSION" = "success" ] || skip "The triggering run concluded $RUN_CONCLUSION."
    sha="$RUN_SHA"; ref_type=branch; ref_name=main
    tip="$(gh api "repos/$repo/commits/main" --jq .sha)"
    [ "$sha" = "$tip" ] || skip "$sha is no longer the tip of main ($tip); edge stays on the newer commit."
    ;;
  push)
    [ "$GITHUB_REF_TYPE" = "tag" ] || refuse "Branch pushes publish through workflow_run."
    sha="$GITHUB_SHA"; ref_type=tag; ref_name="$GITHUB_REF_NAME"
    ;;
  workflow_dispatch)
    case "$GITHUB_REF" in
      refs/heads/main) ref_type=branch; ref_name=main ;;
      refs/tags/v[0-9]*.[0-9]*.[0-9]*) ref_type=tag; ref_name="$GITHUB_REF_NAME" ;;
      *) refuse "Run this from main or a release tag, not $GITHUB_REF. Any other ref would overwrite edge." ;;
    esac
    sha="$GITHUB_SHA"
    ;;
  *) refuse "Unexpected event $EVENT." ;;
esac
# A tag goes on the release commit minutes after it merges, while CI
# and Security on that commit are still running, so a tag push (or a
# manual run) waits for them instead of refusing at once. Before this
# every release tag failed here and needed a manual re-run. A
# workflow_run never waits: the run that is still going starts this
# workflow again when it finishes.
#
# A cancelled run used to fail the release. CI and Security now keep
# main pushes in a group per commit, so a later merge no longer
# cancels them, but a run can still be cancelled by hand or by an
# older workflow file. A tag push or manual run then re-runs that run
# once and waits for the result, so the tag does not need a manual
# retry. A workflow_run never re-runs anything: it only publishes the
# tip of main, and the next push publishes it again.
wait_left="${GATE_WAIT_SECONDS:-3600}"
poll="${GATE_POLL_SECONDS:-30}"
# Prints "<status> <conclusion> <run id>", or "missing".
status_of() {
  gh api "repos/$repo/actions/workflows/$1/runs?head_sha=$sha&event=push&branch=main&per_page=20" \
    --jq '[.workflow_runs[]] | sort_by(.created_at) | last | if . == null then "missing" else "\(.status) \(.conclusion) \(.id)" end'
}
for wf in ci.yml security.yml; do
  row="$(status_of "$wf")"
  if [ "$EVENT" != workflow_run ]; then
    rerun_done=0
    while [ "$wait_left" -gt 0 ]; do
      case "$row" in
        missing) break ;;
        "completed cancelled "*)
          [ "$rerun_done" = 0 ] || break
          id="${row##* }"
          echo "$wf run $id on $sha was cancelled; asking GitHub to re-run it."
          gh api -X POST "repos/$repo/actions/runs/$id/rerun" > /dev/null \
            || refuse "$wf run $id on $sha was cancelled and could not be re-run."
          rerun_done=1
          ;;
        completed*) break ;;
        *) echo "$wf is ${row%% *} on $sha; checking again in ${poll}s (${wait_left}s left)." ;;
      esac
      sleep "$poll"
      wait_left=$((wait_left - poll))
      row="$(status_of "$wf")"
    done
  fi
  # Drop the run id; keep "<status> <conclusion>".
  [ "$row" = missing ] || { set -- $row; row="$1 $2"; }
  case "$row" in
    "completed success") echo "$wf passed on $sha" ;;
    missing) [ "$EVENT" = workflow_run ] && skip "$wf has no push run for $sha." || refuse "$wf has no push run on main for $sha." ;;
    completed*) [ "$EVENT" = workflow_run ] && skip "$wf concluded ${row#completed } on $sha." || refuse "$wf concluded ${row#completed } on $sha." ;;
    *) [ "$EVENT" = workflow_run ] && skip "$wf is still running on $sha; its completion starts this workflow again." || refuse "$wf is still running on $sha after waiting. Try again when it finishes." ;;
  esac
done
# A release tag and the edge publish of the same commit are in
# separate concurrency groups (publish-images.yml says why). They
# must still not push at once: side by side on v1.3.0 GitHub never
# created script-runner. So the newer run waits here until every
# older publish run on this commit has finished. Ordering by run id
# means two runs never wait on each other.
busy_wait="${PUBLISH_WAIT_SECONDS:-10800}"
older_busy() {
  gh api "repos/$repo/actions/workflows/publish-images.yml/runs?head_sha=$sha&per_page=50" \
    --jq "[.workflow_runs[] | select(.id < $GITHUB_RUN_ID and .status != \"completed\")] | length"
}
if [ -n "${GITHUB_RUN_ID:-}" ]; then
  busy="$(older_busy)"
  while [ "$busy" != 0 ] && [ "$busy_wait" -gt 0 ]; do
    echo "An older publish run on $sha is still going; checking again in ${poll}s (${busy_wait}s left)."
    sleep "$poll"
    busy_wait=$((busy_wait - poll))
    busy="$(older_busy)"
  done
  if [ "$busy" != 0 ]; then
    [ "$EVENT" = workflow_run ] && skip "An older publish run on $sha is still going." \
      || refuse "An older publish run on $sha is still going after waiting. Re-run this one when it finishes."
  fi
fi
{
  echo "publish=true"
  echo "sha=$sha"
  echo "ref_type=$ref_type"
  echo "ref_name=$ref_name"
} >> "$GITHUB_OUTPUT"
