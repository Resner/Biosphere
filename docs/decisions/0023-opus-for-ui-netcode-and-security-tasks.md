# 0023: Opus for UI, netcode and security tasks

- Status: accepted (refines the task model in "Model by phase" of 0001; its routing mechanism, "Still one loop", is superseded by 0026: `[opus]` tasks and specs run in a forked subagent)
- Date: 2026-10-27

## Context

ADR 0001 runs every task on Sonnet 5.5 at high effort. M6 brings the creature look overhaul (#90), which the owner judges against reference images, and later milestones bring netcode (M7, M8, M11) and security-heavy work (M9, M10). The owner asked for that work to run on Opus 5.5, a more capable model for UI, netcode and security, at high effort, chosen automatically with no one in the loop.

## Decision

- **The spec marks the task.** The `spec` skill appends `[opus]` to a task's title when its main work is UI or look (`src/render/`, `src/lab/`, HUD, screens and other UI in `src/game/`), netcode (`src/net/`, signaling, relay and referee in `worker/`) or security (signatures, records and verification in `src/ledger/`, admission, validation of untrusted input).
- **/next routes on the mark.** A marked task runs through the `opus-task` skill (`model: opus`, `effort: high`), which follows /next's task and ship steps unchanged. For a spec written before this ADR, /next applies the same rule to an unmarked task itself.
- **Still one loop.** The model switches inside the run's main loop, as it already does for the `spec` and `milestone` skills. There is no implementing subagent, so 0001's reasons against handoffs still hold.
- Other tasks stay on Sonnet 5.5 at high effort.

## Consequences

- Look, netcode and security tasks cost more Claude usage per run; the factory's throughput drops a little in those milestones.
- A look task also compares its screenshots with the references before it is called done.
- Rejected:
  - an implementing subagent on Opus (lossy handoff of the claim, the PR and the spec context; 0001 and CLAUDE.md keep implementation in the main loop);
  - Opus for every task (most tasks are well specced and Sonnet handles them);
  - routing on changed files at run time (the files aren't known until the work is done; the spec author knows the task's nature up front).
