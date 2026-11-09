#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Exercise the Dependabot auto-merge gate without merging.
#
# The workflow inlines the gate because pull_request_target must not
# check the pull request out. These functions are the ones between
# the gate-fn markers. Fixture JSON covers the author check. --live
# reads a real pull request and still does not call the merge API.
#
#   bash scripts/dependabot-automerge-gate.test.sh
#   bash scripts/dependabot-automerge-gate.test.sh --live 586

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
workflow="$root/.github/workflows/dependabot-automerge.yml"
export GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-palavido-dev/gratis-gis}"

# Head SHA observed on palavido-dev/gratis-gis#586 when the gate bug
# was traced. The fixture echoes it back; it is not fetched.
PR586_SHA="5b84d23b8074cb3bb77024cb58e6241fe2d3046e"

if [ ! -f "$workflow" ]; then
  echo "missing $workflow" >&2
  exit 1
fi

fnfile="$(mktemp)"
fullfile="$(mktemp)"
trap 'rm -f "$fnfile" "$fullfile"' EXIT

awk '
  /^[[:space:]]*# gate-fn-start$/ {capture=1; next}
  /^[[:space:]]*# gate-fn-end$/ {capture=0; next}
  capture {
    sub(/^          /, "")
    print
  }
' "$workflow" >"$fnfile"

awk '
  /^        run: \|$/ {capture=1; next}
  capture && /^        [^ ]/ {capture=0}
  capture {
    sub(/^          /, "")
    print
  }
' "$workflow" >"$fullfile"

if [ ! -s "$fnfile" ] || [ ! -s "$fullfile" ]; then
  echo "failed to extract the gate from $workflow" >&2
  exit 1
fi

bash -n "$fnfile"
bash -n "$fullfile"

if grep -q 'gh pr view' "$fnfile" || grep -q 'gh pr merge' "$fnfile"; then
  echo "gate functions must not call gh pr view or gh pr merge" >&2
  exit 1
fi
if grep -q 'gh pr view' "$fullfile"; then
  echo "auto-merge script still calls gh pr view" >&2
  exit 1
fi
if [ "$(grep -c 'gh pr merge' "$fullfile")" -ne 1 ]; then
  echo "auto-merge script should squash-merge in exactly one place" >&2
  exit 1
fi
if ! grep -q 'user.login' "$fnfile" || ! grep -q 'user.type' "$fnfile"; then
  echo "pull request gate must read the REST user login and type" >&2
  exit 1
fi
if ! grep -q 'author.login' "$fnfile" || ! grep -q 'author.type' "$fnfile"; then
  echo "commit gate must read the REST commit author login and type" >&2
  exit 1
fi
if grep -q -F 'app/dependabot' "$fnfile"; then
  echo "gate functions must not treat app/dependabot as an identity" >&2
  exit 1
fi
if ! grep -q -F 'app/dependabot' "$workflow"; then
  echo "workflow comments should record gh's rewritten author login" >&2
  exit 1
fi
if ! grep -q -F "github.actor == 'dependabot[bot]'" "$workflow"; then
  echo "job condition must keep the webhook login dependabot[bot]" >&2
  exit 1
fi

# The Python classifier decides eligibility before any merge call.
pyfile="$(mktemp)"
awk '
  /<<.END_PYTHON.$/ {capture=1; next}
  /^[[:space:]]*END_PYTHON$/ {capture=0}
  capture {
    sub(/^          /, "")
    print
  }
' "$workflow" >"$pyfile"
classify() {
  local rc=0
  DEPS_JSON="$1" UPDATE_TYPE="$2" PACKAGE_ECOSYSTEM="$3" python3 "$pyfile" classify >/dev/null 2>&1 || rc=$?
  echo "$rc"
}
npm_minor='[{"dependencyName":"zod","updateType":"version-update:semver-minor","packageEcosystem":"npm_and_yarn"}]'
actions_minor='[{"dependencyName":"actions/checkout","updateType":"version-update:semver-minor","packageEcosystem":"github_actions"}]'
echo "classifier: npm minor is eligible"
[ "$(classify "$npm_minor" version-update:semver-minor npm_and_yarn)" = 0 ] || { echo "FAIL npm minor" >&2; exit 1; }
echo "classifier: GitHub Actions minor needs a review"
[ "$(classify "$actions_minor" version-update:semver-minor github_actions)" = 10 ] || { echo "FAIL actions by ecosystem" >&2; exit 1; }
[ "$(classify "$actions_minor" version-update:semver-minor "")" = 10 ] || { echo "FAIL actions by dependency" >&2; exit 1; }
echo "classifier: major stays open"
[ "$(classify "$npm_minor" version-update:semver-major npm_and_yarn)" = 10 ] || { echo "FAIL major" >&2; exit 1; }
rm -f "$pyfile"

# shellcheck disable=SC1090
source "$fnfile"

fail() {
  printf 'FAIL %s\n' "$1" >&2
  printf '  rc:  %s\n' "${LAST_RC:-}" >&2
  printf '  out: [%s]\n' "${LAST_OUT:-}" >&2
  printf '  err: [%s]\n' "${LAST_ERR:-}" >&2
  exit 1
}

run_gate() {
  local json="$1" want_rc="$2"
  local err
  err="$(mktemp)"
  set +e
  LAST_OUT="$(pr_gate_json "$json" 2>"$err")"
  LAST_RC=$?
  set -e
  LAST_ERR="$(cat "$err")"
  rm -f "$err"
  if [ "$LAST_RC" -ne "$want_rc" ]; then
    fail "pr_gate_json rc want $want_rc"
  fi
}

run_commits() {
  local rows="$1" want_rc="$2"
  local err
  err="$(mktemp)"
  set +e
  LAST_OUT="$(commits_ok_rows "$rows" 2>"$err")"
  LAST_RC=$?
  set -e
  LAST_ERR="$(cat "$err")"
  rm -f "$err"
  if [ "$LAST_RC" -ne "$want_rc" ]; then
    fail "commits_ok_rows rc want $want_rc"
  fi
}

assert_out() {
  if [ "$LAST_OUT" != "$1" ]; then
    fail "stdout want [$1]"
  fi
}

assert_err_eq() {
  if [ "$LAST_ERR" != "$1" ]; then
    fail "stderr want [$1]"
  fi
}

base_pr() {
  jq -n --arg sha "$PR586_SHA" --arg repo "$GITHUB_REPOSITORY" '{
    state: "open",
    draft: false,
    base: {ref: "main"},
    head: {sha: $sha, repo: {full_name: $repo}},
    user: {login: "dependabot[bot]", type: "Bot", id: 49699333}
  }'
}

echo "accept REST dependabot[bot] type Bot"
run_gate "$(base_pr)" 0
assert_out "$PR586_SHA"
assert_err_eq ""

echo "reject gh rewritten login app/dependabot"
run_gate "$(base_pr | jq '.user.login = "app/dependabot"')" 1
assert_err_eq "author is app/dependabot (type Bot); expected dependabot[bot] (type Bot)"

echo "reject GraphQL login dependabot without [bot]"
run_gate "$(base_pr | jq '.user.login = "dependabot"')" 1
assert_err_eq "author is dependabot (type Bot); expected dependabot[bot] (type Bot)"

echo "reject dependabot[bot] when type is User"
run_gate "$(base_pr | jq '.user.type = "User"')" 1
assert_err_eq "author is dependabot[bot] (type User); expected dependabot[bot] (type Bot)"

echo "reject a human author"
run_gate "$(base_pr | jq '.user = {login: "palavido-dev", type: "User"}')" 1
assert_err_eq "author is palavido-dev (type User); expected dependabot[bot] (type Bot)"

echo "missing author is an operational failure"
run_gate "$(base_pr | jq 'del(.user)')" 2
assert_err_eq "missing pull request author"

echo "reject a closed pull request"
run_gate "$(base_pr | jq '.state = "closed"')" 1
assert_err_eq "pull request is closed"

echo "reject a non-main base"
run_gate "$(base_pr | jq '.base.ref = "develop"')" 1
assert_err_eq "base is develop"

echo "reject a draft"
run_gate "$(base_pr | jq '.draft = true')" 1
assert_err_eq "pull request is a draft"

echo "reject a fork"
run_gate "$(base_pr | jq '.head.repo.full_name = "someone/gratis-gis"')" 1
assert_err_eq "head repository is someone/gratis-gis"

echo "reject a missing head repository"
run_gate "$(base_pr | jq '.head.repo = null')" 1
assert_err_eq "head repository is unknown"

echo "missing head sha is an operational failure"
run_gate "$(base_pr | jq '.head.sha = null')" 2
assert_err_eq "missing head sha"

notice="$(log_not_merging notice "author is app/dependabot (type Bot); expected dependabot[bot] (type Bot)")"
want_notice="::notice title=Dependabot auto-merge::not merging: author is app/dependabot (type Bot); expected dependabot[bot] (type Bot)"
if [ "$notice" != "$want_notice" ]; then
  printf 'FAIL notice\n got:  [%s]\n want: [%s]\n' "$notice" "$want_notice" >&2
  exit 1
fi

echo "capture a rejection so the notice can name the author"
(
  # Called by capture_pr_gate; shellcheck cannot see that call.
  # shellcheck disable=SC2317
  pr_gate() {
    echo "author is app/dependabot (type Bot); expected dependabot[bot] (type Bot)" >&2
    return 1
  }
  capture_pr_gate
  [ "$GATE_RC" -eq 1 ]
  [ "$GATE_SHA" = "" ]
  [ "$GATE_REASON" = "author is app/dependabot (type Bot); expected dependabot[bot] (type Bot)" ]
  captured="$(log_not_merging notice "$GATE_REASON")"
  [ "$captured" = "$want_notice" ]
)

echo "capture an accepted head sha"
(
  # Called by capture_pr_gate; shellcheck cannot see that call.
  # shellcheck disable=SC2317
  pr_gate() {
    printf '%s\n' "$PR586_SHA"
  }
  capture_pr_gate
  [ "$GATE_RC" -eq 0 ]
  [ "$GATE_SHA" = "$PR586_SHA" ]
  [ "$GATE_REASON" = "" ]
)

percent="$(log_not_merging notice $'line one\n100%')"
want_percent="::notice title=Dependabot auto-merge::not merging: line one 100%25"
if [ "$percent" != "$want_percent" ]; then
  printf 'FAIL notice escaping\n got:  [%s]\n want: [%s]\n' "$percent" "$want_percent" >&2
  exit 1
fi

good_row="${PR586_SHA}"$'\t'"dependabot[bot]"$'\t'"Bot"$'\t'"true"
echo "accept a verified REST Dependabot commit"
run_commits "$good_row" 0
assert_err_eq ""

echo "reject an unverified Dependabot commit"
run_commits "${PR586_SHA}"$'\t'"dependabot[bot]"$'\t'"Bot"$'\t'"false" 1
assert_err_eq "$(printf '%s\n%s' \
  "a commit is not from dependabot[bot] (type Bot) with a verified signature" \
  "${PR586_SHA}"$'\t'"dependabot[bot]"$'\t'"Bot"$'\t'"false")"

echo "reject a commit whose author login is the gh rewritten form"
run_commits "${PR586_SHA}"$'\t'"app/dependabot"$'\t'"Bot"$'\t'"true" 1

echo "reject a commit author type that is not Bot"
run_commits "${PR586_SHA}"$'\t'"dependabot[bot]"$'\t'"User"$'\t'"true" 1

echo "reject when one of two commits is not the bot"
run_commits "$(printf '%s\n%s' \
  "$good_row" \
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"$'\t'"palavido-dev"$'\t'"User"$'\t'"true")" 1

echo "reject a pull request with no commits"
run_commits "" 1
assert_err_eq "pull request has no commits"

echo "fixture gate passed"

if [ "${1:-}" != "--live" ]; then
  exit 0
fi

live_pr="${2:-586}"
case "$live_pr" in
  ''|*[!0-9]*)
    echo "live pull request number must be digits" >&2
    exit 1
    ;;
esac
export PR_NUMBER="$live_pr"

# GH_TOKEN, when set, overrides the logged-in gh user. An invalid
# token would hide credentials that can read this repository. Probe
# the pull request itself: an app token may not be allowed to call
# /user and still be allowed to read the repo.
if ! command gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}" >/dev/null 2>&1; then
  unset GH_TOKEN
fi
if ! command gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}" >/dev/null 2>&1; then
  echo "gh cannot read pull request $PR_NUMBER; cannot live-check" >&2
  exit 1
fi

# The sourced pr_gate and commits_ok call gh. Refuse a merge if a
# future edit wires one into those functions.
gh() {
  if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
    echo "refusing to merge pull request $PR_NUMBER" >&2
    exit 99
  fi
  command gh "$@"
}

echo "=== gh pr view author (old gate input) ==="
command gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" \
  --json state,isDraft,baseRefName,headRefOid,author,headRepository
view_login="$(command gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json author --jq '.author.login')"
if [ "$view_login" = "dependabot[bot]" ]; then
  echo "gh pr view author.login is dependabot[bot]; the old bug is not present" >&2
  exit 1
fi
echo "old comparison rejects: author is $view_login"

echo "=== GraphQL author ==="
command gh api graphql -f query="
query {
  repository(owner: \"${GITHUB_REPOSITORY%%/*}\", name: \"${GITHUB_REPOSITORY#*/}\") {
    pullRequest(number: $PR_NUMBER) {
      author { __typename login }
    }
  }
}"
echo

echo "=== REST pull user ==="
rest="$(command gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}")"
printf '%s\n' "$rest" | jq '{login: .user.login, type: .user.type, id: .user.id, state: .state, draft: .draft, base: .base.ref, head: .head.repo.full_name, sha: .head.sha}'

echo "=== pr_gate_json on the REST body ==="
run_gate "$rest" 0
echo "pr_gate_json sha=$LAST_OUT"

echo "=== pr_gate via gh api ==="
set +e
live_sha="$(pr_gate)"
live_rc=$?
set -e
echo "pr_gate rc=$live_rc sha=$live_sha"
if [ "$live_rc" -ne 0 ] || [ "$live_sha" != "$LAST_OUT" ]; then
  echo "pr_gate did not accept the live pull request" >&2
  exit 1
fi

echo "=== REST commits ==="
command gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/commits" \
  --jq '.[] | {sha: .sha, author_login: .author.login, author_type: .author.type, committer_login: .committer.login, committer_type: .committer.type, verified: .commit.verification.verified}'
echo "=== commits_ok ==="
commits_ok
echo "commits_ok accepted the live commits"

echo "=== same REST body, author rewritten the way gh pr view does ==="
run_gate "$(printf '%s\n' "$rest" | jq '.user.login = "app/dependabot"')" 1
echo "rejected: $LAST_ERR"

echo "=== same REST body, marked draft ==="
run_gate "$(printf '%s\n' "$rest" | jq '.draft = true')" 1
echo "rejected: $LAST_ERR"

echo "=== same REST body, base moved off main ==="
run_gate "$(printf '%s\n' "$rest" | jq '.base.ref = "develop"')" 1
echo "rejected: $LAST_ERR"

echo "=== same REST body, head repository is a fork ==="
run_gate "$(printf '%s\n' "$rest" | jq '.head.repo.full_name = "someone/gratis-gis"')" 1
echo "rejected: $LAST_ERR"

echo "merge was not called"
