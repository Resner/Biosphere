#!/usr/bin/env bash
# Claim one factory step without racing other runs (ADRs 0047, 0048, 0057).
#
#   tools/claim.sh probe "<task>"            is the step free? prints why not, or "free"; changes nothing
#   tools/claim.sh claim "<task>" "<title>"  push this branch, open the draft PR, check twice
#   tools/claim.sh check <pr number>         re-check an open claim (before marking the PR ready)
#
# A step is blocked when an open `claude/` PR already carries the same `Task:` line, or, for any task
# but `health`, when two other steps are in progress (open `claude/` PRs other than `Task: health`
# with a live claim: changed in the last 90 minutes, or a workflow run on their branch queued, running
# or finished in the last 30 minutes). Only older PRs count once a run has its own PR, so runs that
# claim at the same moment resolve by PR number.
#
# Exit 0: free / claimed / still yours. Exit 3: blocked; a run that lost has its PR closed and its
# branch deleted, so nothing of it is left behind. Any other exit: an error (the claim is not made).
set -euo pipefail

repo=${CLAIM_REPO:-Resner/Biosphere}
settle=${CLAIM_SETTLE:-20}

open_prs() {
  if [ -n "${CLAIM_PRS_FILE:-}" ]; then cat "$CLAIM_PRS_FILE"; else gh api "repos/$repo/pulls?state=open&per_page=100"; fi
}

now() { echo "${CLAIM_NOW:-$(date -u +%s)}"; }

# A workflow run on the branch is queued, running, or finished in the last 30 minutes.
branch_busy() {
  [ -n "${CLAIM_PRS_FILE:-}" ] && return 1
  gh api "repos/$repo/actions/runs?branch=$1&per_page=5" |
    jq -e --argjson now "$(now)" \
      '[.workflow_runs[] | select(.status != "completed" or ($now - (.updated_at | fromdateiso8601)) < 1800)] | length > 0' \
      >/dev/null
}

# blocker <task> <own PR number, or 0 before the run has one>: prints the reason, or nothing.
blocker() {
  local task=$1 mine=$2 prs same num ref updated live=0
  prs=$(open_prs)
  same=$(jq -r --arg repo "$repo" --arg task "$task" --argjson mine "$mine" '
    def task: ((.body // "") | capture("(^|\n)Task: *(?<t>[^\r\n]*[^\r\n \t])") | .t) // "";
    [.[] | select(.head.repo.full_name == $repo and (.head.ref | startswith("claude/"))
                  and task == $task and ($mine == 0 or .number < $mine)) | "#\(.number)"]
    | join(" ")' <<<"$prs")
  if [ -n "$same" ]; then
    echo "$task already claimed by $same"
    return
  fi
  [ "$task" = health ] && return
  while read -r num ref updated; do
    [ -n "$num" ] || continue
    if [ $(($(now) - $(date -u -d "$updated" +%s))) -lt 5400 ] || branch_busy "$ref"; then
      live=$((live + 1))
    fi
  done < <(jq -r --arg repo "$repo" --argjson mine "$mine" '
    def task: ((.body // "") | capture("(^|\n)Task: *(?<t>[^\r\n]*[^\r\n \t])") | .t) // "";
    .[] | select(.head.repo.full_name == $repo and (.head.ref | startswith("claude/"))
                 and task != "health" and ($mine == 0 or .number < $mine))
    | "\(.number) \(.head.ref) \(.updated_at)"' <<<"$prs")
  if [ "$live" -ge 2 ]; then echo "two steps in progress"; fi
}

# lose <PR number> <branch> <reason>: close the PR, delete its branch, report, exit 3.
lose() {
  gh api -X PATCH "repos/$repo/pulls/$1" -f state=closed >/dev/null
  # branch-cleanup.yml deletes it on close too, should both of these fail.
  git push -q origin --delete "$2" 2>/dev/null || gh api -X DELETE "repos/$repo/git/refs/heads/$2" >/dev/null 2>&1 || true
  echo "IDLE: $3 (closed #$1 and deleted $2)"
  exit 3
}

case "${1:-}" in
probe)
  reason=$(blocker "$2" 0)
  if [ -n "$reason" ]; then echo "IDLE: $reason"; exit 3; fi
  echo free
  ;;
claim)
  task=$2 title=$3
  branch=$(git rev-parse --abbrev-ref HEAD)
  case "$branch" in claude/*) ;; *) echo "claim.sh: run it on your claude/ branch, not $branch" >&2; exit 1 ;; esac
  reason=$(blocker "$task" 0)
  if [ -n "$reason" ]; then echo "IDLE: $reason"; exit 3; fi
  git push -q -u origin "$branch"
  number=$(gh api -X POST "repos/$repo/pulls" -f title="$title" -f head="$branch" -f base=main \
    -f body=$'Task: '"$task"$'\n\nClaimed; work in progress.' -F draft=true --jq .number)
  # Right away, then once more after the runs started by the same trigger have opened theirs.
  reason=$(blocker "$task" "$number")
  [ -z "$reason" ] || lose "$number" "$branch" "$reason"
  sleep "$settle"
  reason=$(blocker "$task" "$number")
  [ -z "$reason" ] || lose "$number" "$branch" "$reason"
  echo "CLAIMED #$number"
  ;;
check)
  number=$2
  pr=$(gh api "repos/$repo/pulls/$number")
  task=$(jq -r '((.body // "") | capture("(^|\n)Task: *(?<t>[^\r\n]*[^\r\n \t])") | .t) // ""' <<<"$pr")
  branch=$(jq -r .head.ref <<<"$pr")
  [ -n "$task" ] || { echo "claim.sh: #$number has no Task: line" >&2; exit 1; }
  reason=$(blocker "$task" "$number")
  [ -z "$reason" ] || lose "$number" "$branch" "$reason"
  echo "CLAIMED #$number"
  ;;
*)
  echo "usage: tools/claim.sh probe <task> | claim <task> <title> | check <pr number>" >&2
  exit 2
  ;;
esac
