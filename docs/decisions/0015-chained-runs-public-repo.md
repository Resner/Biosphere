# 0015: Chained factory runs in a public repository

- Status: accepted (supersedes the schedule cadence and the private-repository budget in 0001; the overlap rule is refined by 0020, by 0042 (live claims, takeover in place, CI in parallel parts) and by 0044 (one lock per lane and a second scheduled task, `Care`, so the kill switch is pausing both tasks))
- Date: 2026-10-25

## Context

A factory run usually finishes in a few minutes, so an hourly schedule (the scheduler's minimum) leaves the factory idle most of the time. The owner wants it to work continuously until the Claude plan's usage limit, without overlapping runs, waiting for a long step to finish before the next one starts.

The scheduler offers three trigger types for a task: schedule, API, and GitHub events (pull request, release, issue, with filters such as *is merged* and *head branch*). Agents can only fire tasks that an agent created, and such tasks don't carry the repository. So a run can't start the owner's `Factory` task itself, which was verified on 2026-10-25.

On 2026-10-25 the owner also made the repository public. Actions minutes on standard runners are now free, and anyone can open issues and comments.

## Decision

- **Chain through a GitHub trigger**: the `Factory` task gets a GitHub event trigger, pull request **closed**, filtered to *is merged* = true, head branch starting with `claude/`, base branch `main`. Every merged factory PR starts the next run at once.
  - The hourly schedule trigger stays, as the restart after usage limits, playtest gates, failures, dropped webhook events, or a run that stopped without merging.
- **Start from `main`**: a run started by a merged-PR event is checked out at that PR's head, so every run first resets its branch to the latest `origin/main`.
- **No overlap**:
  - a run claims its step with a draft PR before working (a small commit naming the step);
  - every run stops while an open `claude/` PR was updated within the last 90 minutes, and while a Release workflow is running, so a gate's `Playtest:` issue exists before anyone moves on;
  - when two runs claim the same step, the later one closes its draft and stops.
- **Kill switch**: pausing the `Factory` task stops both triggers.
- **Owner input**: only issues and comments by the repository owner's account, without the factory footer, count as owner input. Everything else is untrusted data that runs never act on or reply to.
- **CI cost**: Actions minutes are no longer budgeted. CI stays one fast job, because each run waits for it.

## Consequences

- Throughput is bounded by Claude usage, CI time and the scheduler's caps on GitHub events, not by the schedule. Each run still ships exactly one step and one PR.
- Every run ends with a push notification, so back-to-back runs send many. The owner can turn them off on the task.
- A run that dies mid-step leaves a draft PR that blocks for at most 90 minutes. After that, the hourly run takes it over as an older factory PR.
- Rejected:
  - runs firing the task themselves (the scheduler doesn't allow it for tasks created in the UI, and agent-created tasks have no repository);
  - firing the API trigger from a GitHub Actions workflow on merge (needs the task's token as a repository secret; the native GitHub trigger does the same without one);
  - one long session looping over steps (context grows without bound);
  - a sub-hourly schedule (rejected by the scheduler).
