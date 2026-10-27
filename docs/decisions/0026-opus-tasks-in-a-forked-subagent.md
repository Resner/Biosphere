# 0026: Opus tasks and specs run in a forked subagent

- Status: accepted (supersedes "Still one loop" in 0023 and the project `model` setting from 0001)
- Date: 2026-10-27

## Context

ADR 0023 sent `[opus]` tasks through the `opus-task` skill with `model: opus` in its frontmatter, expecting the run's main loop to switch to Opus 5.5. On 2026-10-27 the M6 T2 run called `opus-task`, and every turn after it still ran on Sonnet 5.5, according to the run's transcript. The same mechanism carries the `spec` and `milestone` skills' `model: opus`, so it can't be relied on for them either.

The project settings also set `"model": "opusplan"`: Opus in plan mode, Sonnet otherwise. Factory runs never use plan mode, so every run executed on Sonnet whatever the owner picked for the `Factory` task.

A skill with `context: fork` runs in a subagent, and its `model` field sets that subagent's model. A probe in a cloud session showed the forked subagent on the model the skill named, not the session's.

## Decision

- **`opus-task` forks.** It runs with `context: fork`, `model: opus`, `effort: high` and `background: false`. The subagent gets the task id, the spec path and the branch as arguments, implements the task test-first, ticks it and commits. It doesn't push or touch the PR.
- **The `spec` skill forks too** (`model: opus`, `effort: xhigh`): it writes and commits the spec, and /next ships it.
- **The main loop keeps the rest.** /next claims the task, runs `/simplify` and `/code-review` on the result, hands correctness findings back to `opus-task`, and ships, as for any other task.
- **No project model.** `.claude/settings.json` no longer sets `model`; the `Factory` task's model decides the main loop.

## Consequences

- `[opus]` tasks really run on Opus, at the cost of one handoff: the subagent starts from the skill text and the repository, not the run's conversation. The claim, the PR and the reviews stay in the main loop, so the handoff carries only the task.
- The `milestone` skill still runs on the `Factory` task's model: closing a milestone bumps `VERSION` and works the release and its issues, which belong to the main loop.
- Rejected:
  - the in-loop switch through skill frontmatter (it didn't take effect in factory runs);
  - Opus for every run (most tasks don't need it, and it costs more);
  - an Agent call with a model override from /next (the same effect, with the instructions spread across two skills).
