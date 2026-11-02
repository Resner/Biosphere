# 0047: Two identical workers with one claim per task, instead of two lanes

- Status: accepted (supersedes 0044's lanes and its one PR per lane, and 0045's care backlog; refines 0020's guard to one PR per task; amended by 0048: at most two steps in progress at once)
- Date: 2026-11-02

## Context

ADR 0044 split the factory into a build lane (the roadmap) and a care lane (a red `main`, flakes, Dependabot), and ADR 0045 gave the care lane a maintenance backlog. The owner wanted concurrent work that speeds up development. Measured over the first 23 hours (2026-11-01 18:00 to 11-02 17:00 UTC):

- **The roadmap stayed serial.** The build lane shipped M6c T3 to T12, one at a time. Each run took 0.5 to 4.3 hours: 1 to 3 hours of Opus implementing, then 40 minutes to 2.5 hours of review, waiting on CI (about 20 minutes a round) and fixing the PR's own failures. While one run did that, no other roadmap task moved.
- **The care lane didn't speed up the roadmap.** It fixed four problems on `main` within about an hour each, which was useful. But most of its usage went to the refactor backlog (ten splits, three of them on Opus), and it shares the plan's 5-hour usage limit with the build lane. Both lanes stood still for three hours overnight when that limit was hit.
- **Common practice** for parallel agents is identical workers pulling independent tasks from one queue, each on its own branch with its own claim, and routing failures to one place instead of a dedicated fixer.

## Decision

- **Workers, not lanes.** Both scheduled tasks (`Factory`, `Care`) run the same `/next`; arguments are ignored. Every run takes the first step that applies:
  1. take over a stale claim in place (ADR 0042);
  2. gates and the release in progress;
  3. health, unless a PR already claims it: a failed Release, a red `E2E main`, Dependabot, owner issues about CI;
  4. owner input;
  5. the spec, the next **free** task, or the milestone close.
- **One claim per task.** A PR's body carries `Task: <step>` (`Task: M7 T3`, `Task: health`, `Task: spec M7`, `Task: close M7`, `Task: owner #123`). CI's guard fails a PR while an older open `claude/` PR carries the same line. Different tasks run side by side.
- **Free tasks.** A task waits for the tasks its title lists in `(after T2, T5)`; `(after none)` waits for nothing. A task without the mark waits for every task above it, so specs written before this ADR stay serial. The spec skill marks real dependencies only, and prefers tasks that touch different files.
- **Less per-run overhead.**
  - Runs no longer run `npm run check:full` before pushing; CI runs it.
  - A failure in a scenario the diff doesn't touch is re-run once before anyone investigates it.
  - CI failures caused by an `[opus]` task go back to `opus-task`.
  - Timing tests (`speedTest`) run alone at the end of `check:full`. They failed CI and local runs three times in a day because they timed the code while other tests loaded the machine.
  - The care backlog and the rule that big files are split through it are gone. Files under about 1,000 lines remain a preference.

## Consequences

- Once a spec marks independent tasks, two workers build two tasks at once. While one waits on CI, the other implements. M6c's last tasks (T13, T14) stay serial because its spec has no marks, so the gain starts with M7's spec.
- Usage goes to roadmap work instead of refactors. Two Opus workers reach the 5-hour limit sooner; that limit then sets the pace.
- Parallel tasks that touch the same files cost a merge. Every run merges `origin/main` before its last push.
- Rejected:
  - keeping the care lane and adding a backlog of flakes (more process, and it still leaves the roadmap serial);
  - a merge queue (one PR per task already serialises merges, and the volume is two PRs at a time);
  - more than two workers (the 5-hour limit is already reached at times).
