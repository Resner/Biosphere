# 0057: Claims are made by a script, and closed factory branches are deleted

- Status: accepted (amends 0047 and 0048: how a claim is made and checked)
- Date: 2026-11-05

## Context

From 2026-11-03 to 11-05 the two scheduled tasks shipped M7, M8 and most of M9, but:

- **Every merge started two runs at the same moment** (both tasks have a GitHub trigger). When only one step was free, both claimed it. About 25 duplicate claim PRs were opened, almost always within the same minute as the winning one.
- **The check after claiming was up to the agent.** Most losers closed their PR at once, but some skipped or delayed the check and worked on: #349 for 22 minutes and #305 for 81. Others started an Opus subagent first.
- **Every closed duplicate left its branch behind.** GitHub deletes a branch only when its PR merges, so 44 `claude/` branches accumulated.

## Decision

- **`tools/claim.sh` makes every claim.**
  - It refuses before pushing anything if an open PR carries the same `Task:` line, or, unless the task is `health`, if two steps are in progress (ADR 0048).
  - Otherwise it pushes the run's branch, opens the draft PR with the `Task:` line, and checks again right away and after 20 seconds, when the runs started by the same trigger have opened theirs. Only older PRs count, so lower numbers win.
  - A run that loses has its PR closed and its branch deleted in the same command, and stops with the `IDLE:` line the script prints. It never reaches the work or a subagent.
  - `tools/claim.sh check <n>` runs the same check right before a PR is marked ready; `probe` asks without claiming.
- **`branch-cleanup.yml` deletes leftover branches.** On every factory PR closed without merging, it deletes the PR's branch (`pull_request_target`, no checkout). A daily sweep, also run on dispatch, deletes `claude/` branches with no open PR and no commit for 6 hours.

## Consequences

- A lost race costs one PR number and about half a minute, never work, and leaves no branch.
- The rules for who wins live in a tested script (`tools/claim.test.ts`), not in instructions an agent can skip.
- Simultaneous starts are harmless but still produce closed PRs and notifications. Giving only one scheduled task the GitHub trigger removes most of them: the other task fills the second slot from its hourly schedule. That is a setting in the scheduler, not in the repository.
- Rejected:
  - a fixed branch name per task as an atomic lock (sessions may push only to the branch they were given);
  - a longer wait before claiming (slows every run, and the check after opening the PR already settles the race).
