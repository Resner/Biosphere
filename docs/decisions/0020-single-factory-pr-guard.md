# 0020: Lowest PR number wins, enforced by CI

- Status: accepted (refines the "No overlap" rule of 0015; its takeover rule is superseded by 0042, which takes a stale claim over in place and never closes it; the guard runs in CI's `scope` job and compares PRs of one lane: 0044)
- Date: 2026-10-26

## Context

ADR 0015 keeps runs from overlapping with a draft-PR claim and a rule that the later of two claims closes itself. On 2026-10-26 two runs claimed the M4 spec ten seconds apart (#81 and #82). A merged release PR started one run and the hourly schedule started the other, and both were waiting for the same Release workflow, so they woke up and claimed together. Neither run did the post-claim check. #82 merged, and #81 was a full duplicate. Had both merged, the second would have hit conflicts, and the next run's takeover of an "older factory PR" would have mixed two specs.

The rule depended on agents remembering it. It also compared creation times, so a single check could miss a rival that opened a moment later.

## Decision

- **The lowest PR number wins.** GitHub assigns PR numbers atomically, so among open `claude/` PRs from this repository exactly one has the lowest number. A run compares numbers, not timestamps, right after opening its draft and again right before marking it ready.
- **CI enforces it.** The required `verify` job has a first step, "Single factory PR", which fails a `claude/` PR from this repository while an open `claude/` PR from this repository has a lower number. A duplicate claim can therefore never auto-merge, whatever the agent does. Fork PRs are ignored, so outsiders can't block the factory by naming a branch `claude/…`.
- **Takeovers close first.** A run that takes over an older factory PR closes it before its last push, because only a push re-runs CI on the newer PR. A stale factory PR whose step is already on `main` is closed with a link, not merged into the new run's branch.

## Consequences

- A race between runs now costs at most one wasted run and a red PR, never a duplicate merge.
- If the GitHub API call fails, the step fails and the PR is red until the next push or a re-run. Failing closed is the safe choice here.
- The owner's own PRs from other branches and Dependabot PRs are not affected. An owner PR from a `claude/` branch is treated as a factory PR.
- Rejected:
  - comparing creation timestamps (two checks a second apart can each miss the other);
  - a CI concurrency group across PRs (it cancels runs, so it can't block a merge);
  - random delays before claiming (needs a foreground sleep, which runs can't use, and only narrows the race);
  - dropping the release wait (costs up to an hour of idle factory after every release and still leaves the merge and schedule race).
