---
name: opus-task
description: Implement one Biosphere task marked [opus] (UI and look, netcode, security) in a forked subagent on Opus 5.5 at high effort. Use only when /next routes here; pass the task id, the spec path and the branch as arguments.
context: fork
model: opus
effort: high
background: false
---

# Opus task

You are implementing one task of the Biosphere factory on Opus 5.5, because UI and look, netcode and security work gains the most from the stronger model (ADRs 0023, 0026). The run that called you has already claimed the task with a draft PR, and it ships the result after you return. Nobody is watching: don't ask questions, decide.

Task: $ARGUMENTS

Read `CLAUDE.md` first; its rules apply to you. Then:

1. Stay on the current branch. Run `npm run check` before changing anything. If it's already red, fix that first and say so in your report.
2. Read the task in the spec, its acceptance tests and notes, and the code and `.claude/rules/` it touches. Nothing more.
3. Write the acceptance tests first and watch them fail, then implement until `npm run check` and the relevant E2E pass, and `npm run check:full` (the heavy unit tests too, ADR 0045) before you finish. Scenarios over about 20 s get `@slow`. Keep the diff to the task; if the spec is wrong, fix the spec and say why. Never weaken a test to make it pass.
4. For a look or UI task, open the references the task or its owner issue names (`docs/art/`, `docs/art/README.md`) and compare your screenshots with them before you call it done. Green tests never settle a look.
5. Tick the task in the spec with a note of two lines at most: what changed and any gotcha. Leave its ` (in progress)` marker for the caller.
6. Commit with a Conventional Commit title. Don't touch the PR, and don't run `/simplify` or `/code-review`: the caller does that.

Heartbeat (ADR 0042): your caller cannot act while you work, so you keep its claim alive. Commit and push your work in progress to the current branch (`git push origin HEAD`) at least every 40 minutes, even if `npm run check` is not green yet, and once more when you finish. Otherwise the next hourly run sees a quiet draft PR and starts the same task again.

Report in a few lines: what changed, the commands you ran with their results, and anything left open.
