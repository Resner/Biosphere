# 0042: Flake-resistant gates and live claims

- Status: accepted (refines 0001's single CI job for the release gate, and the 90-minute rule of 0015 and 0020)
- Date: 2026-11-01

## Context

**Flaky end-to-end scenarios cost hours at release time.**
- The release of v0.7.1 failed four times in a row: 24, 20, 28 and 28 minutes. Each time a long `@slow` scenario (`m6b-lifecycle`, once `m6-lifecycle` and `m6-wheel`) failed 18 to 25 minutes into the run, on "slow-runner timing".
- Each failure meant a diagnosis, a fix PR and a full re-run.
- The whole suite (173 tests) ran on one runner with 2 workers beside 17 local authorities and a preview server, so the scenarios that measure time starved.
- The release was also the first time the full suite ran on that commit: nothing ran the `@slow` scenarios between merges.

**Runs took over claims that were still being worked on.**
- A run that hands a task to the forked Opus subagent (ADR 0026) is blocked until it returns, which can take two hours, and the subagent did not push.
- The hourly run then saw a draft PR untouched for 90 minutes, closed it as stale and started the same task again (#190/#191, #193/#194, #196/#197). The first run later finished, reopened its PR and closed the duplicate.

## Decision

- **PR CI runs in parallel too**: `scope` (guard and docs-only skip), `unit`, `e2e` in five parts, and `slow` (repeats). `verify` stays the one required check: it always runs and passes only when every part it needed passed. The PR suite took 9 to 15 minutes on one runner with 2 workers, and 25 when a runner offered only one (the failed first run of #213).
- **The full suite runs on parallel runners** (`e2e-full.yml`): `fast` in 3 shards (the chromium project without `@slow`), `slow` in 3 shards (the `@slow` chromium scenarios, one worker each), and `social`, `pond` and `post` (the projects that must not share a runner), each on its own. Every part runs to the end, so one run reports every failure. Release calls it before building. A run takes about a third of the time, and the long scenarios no longer compete for CPU.
- **The full suite runs early**: `E2E main` runs it on main after every merge that touches code or tests, and every 6 hours. A red `E2E main` is the factory's first job (`next` skill). The milestone step bumps `VERSION` only on a head where it is green, so the release is never the first full run of a commit.
- **New or changed scenarios prove themselves**: PR CI runs every added or changed `@slow` spec 3 times on one worker before it can merge. (This supersedes `.claude/rules/ci.md`'s "one job" rule, which dated from the private repository's minute budget.)
- **Determinism rules** for scenarios are in `.claude/rules/tests.md`: wait on state, drive time through the sim, and assert nothing in wall time. A flaky scenario is fixed at its cause; there are no retries.
- **A claim is live** while its PR or branch changed in the last 90 minutes, or a workflow run on its branch is queued, running, or finished in the last 30 minutes. Long steps keep it live with a heartbeat: the `opus-task` and `spec` subagents push their work in progress at least every 40 minutes, and the main loop pushes or edits a `Heartbeat:` line at least every 45.
- **A stale claim is taken over in place**: on its own branch and PR number, never by closing it and opening a duplicate.

## Consequences

- A release takes about 12 minutes instead of about 25, and fails far less often; flakes show up within hours of the merge that brought them, while the run that wrote them can still fix them cheaply.
- More Actions minutes (free on this public repository) and a little more PR CI time when a scenario changes.
- WIP pushes run PR CI on drafts; that is cheap and also counts as the claim's heartbeat.
- Rejected:
  - Playwright retries (they hide flakes; the rules forbid loosening tests to get green);
  - only raising the 90-minute limit (a crashed run would block the factory for hours);
  - running the full suite on every PR (each PR would wait 10 minutes or more).
