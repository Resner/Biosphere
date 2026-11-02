# 0048: At most two steps in progress at once

- Status: accepted (amends 0047: its "two workers" were not bounded)
- Date: 2026-11-02

## Context

ADR 0047 made both scheduled tasks identical workers and limited claims to one PR per task. But the scheduler starts a new run on every trigger, even while earlier runs of the same task are still working: both tasks fire on every merged `claude/` PR and once an hour, and a run can last hours. So the number of runs at once was not two. Duplicate work was impossible, but nothing limited how many *different* tasks were in progress. Once a spec marks several tasks as independent, four or five could be in progress, each on Opus, with more merge conflicts and the 5-hour usage limit reached early.

## Decision

- A step is in progress while its open `claude/` PR has a live claim (ADR 0042). At most two steps other than `Task: health` are in progress at once. One health fix may run beside them.
- A run checks the count before it claims or takes over a step, and again right after opening its draft. Counting only older PRs makes concurrent claims resolve by PR number, as for the same-task rule.
- Extra runs stop with `IDLE: two steps in progress` within a minute or two. They cost little, so both scheduled tasks stay: each merge starts two runs, and that refills both slots at once.

## Consequences

- At most three runs do real work at a time (two steps and a health fix), however many triggers fire.
- One scheduled task would be enough for correctness. With one, a free slot may wait up to an hour for the next trigger.
- Rejected: a CI guard on the count (CI can't tell a live claim from a stale one cheaply, and the claim step already enforces it); one scheduled task (slower to refill a free slot).
