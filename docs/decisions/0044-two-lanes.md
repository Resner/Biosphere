# 0044: Two lanes: build and care, each with its own lock

- Status: accepted (refines 0015's one-run-at-a-time and 0020's lowest-number rule to one PR per lane; refines 0042's "a red E2E main comes first")
- Date: 2026-11-01

## Context

ADR 0042 made a red `E2E main` the factory's first job, so that flakes are fixed between merges instead of at release. On 2026-11-01 the first runs of the new full suite were red with timing-dependent scenarios. The one factory lane then stopped all roadmap work for over two hours (#216):
- it made 8 fix commits;
- it dispatched the 15–20 minute full suite after each of them;
- each run surfaced a different flaky scenario.

The same day every CI job began running Playwright with one worker instead of two. Probes found four cores on every runner image, so the cause is not the hardware, and the suite's time doubled.

The owner wants the factory to use more of the plan's capacity, possibly with two scheduled tasks at the same time.

## Decision

- **Two lanes.** The **build** lane (`/next`, the `Factory` task) works the roadmap. The **care** lane (`/next care`, a second scheduled task, `Care`) keeps `main` healthy: a failed Release, a red `E2E main`, flaky scenarios, Dependabot, CI and workflow fixes. The care lane never takes roadmap work and goes idle when `main` is healthy.
- **One lock per lane.** Every factory PR carries `Lane: build` or `Lane: care` in its body from the first draft on (a PR without the line is build). The lowest-number rule and the live-claim rule apply within a lane. CI's guard compares only PRs of the same lane, so the two lanes never block each other.
- **A red `E2E main` no longer stops the build lane.** Only the milestone close waits for green, because a release must not be the first full run of its commit (0042).
- **Short fix loops.** The care lane fixes every failure of the latest `E2E main` run in one PR, proves each fix by repeating that spec locally (`--repeat-each=5`), and does not dispatch the full suite on its branch. CI repeats every new or changed spec 3 times, and `E2E main` re-checks after the merge.
- **Both lanes merge `main` before their last push**, since the other lane moves it.
- **CI pins Playwright to 2 workers** and logs the CPU count Node reports, so a runner change shows up in the log rather than as a doubled suite.

## Consequences

- Roadmap work continues while flakes are fixed. About twice the Claude usage when both lanes have work; the care lane costs little when `main` is healthy (one idle check an hour).
- Two lanes merging into `main` can conflict, mostly in tests. Each run merges `main` before shipping, and CI checks the merged result.
- The owner creates and pauses the `Care` task; pausing it returns the factory to one lane, and then the build lane's milestone close waits for green.
- Rejected:
  - several build runs on independent tasks (a claim per task; more merge conflicts; worth trying once two lanes run smoothly);
  - Playwright retries (they hide flakes);
  - leaving a red `E2E main` as everyone's first job (one flake hunt stalls the roadmap).
