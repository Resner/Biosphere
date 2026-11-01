---
name: spec
description: Write the just-in-time spec for the current Biosphere milestone. Use only when /next routes here (the milestone has no spec yet) or when asked directly.
context: fork
model: opus
effort: xhigh
background: false
---

# Spec: one milestone, just in time

Fresh sessions will build from this spec one task at a time, with nobody to ask. Make it self-contained and testable.

You run in a subagent on Opus 5.5 (ADR 0026). The run that called you has claimed the step on the current branch and ships your result. Nobody is watching: don't ask questions, decide. Read `CLAUDE.md` first; its rules apply to you.

1. Read this milestone's row and outline in `docs/ROADMAP.md` (outcome, exit criteria, gate, task outline), the parts of `docs/BRIEF.md` it covers, `docs/DESIGN.md`, the ADRs, the previous spec's notes, owner issues folded into this milestone, and only the code this milestone touches.
2. Decide open questions yourself. Record lasting decisions as ADRs (`docs/decisions/`, from `0000-template.md`). If the spec changes a mechanic or an initial value, update `docs/DESIGN.md` in the same PR.
3. Write `docs/specs/<id>-<slug>.md` from `.claude/skills/spec/template.md`:
   - Tasks in build order. Each one fits one session and one PR, and can be finished and verified in a single run.
   - Every task lists concrete acceptance tests (input → expected result) that can be written before the code.
   - Append `[opus]` to a task's title when its main work is UI or look (`src/render/`, `src/lab/`, HUD, screens and other UI in `src/game/`), netcode (`src/net/`, signaling, relay and referee in `worker/`) or security (signatures, records and verification in `src/ledger/`, admission, validation of untrusted input). /next runs those on Opus at high effort, the rest on Sonnet (ADR 0023).
   - Every exit criterion from the roadmap maps to tasks and to the end-to-end check.
   - Subjective quality (look, feel, responsiveness) goes in the rubric as checkable statements, each with the evidence that settles it.
4. Set the milestone's status to `specced` in `docs/ROADMAP.md`. Leave the other rows alone.
5. Commit on the current branch as `docs(spec): <id> <title>`. Don't touch the PR: the caller ships it as a docs-only PR with that title. Push your work in progress to the current branch (`git push origin HEAD`) at least every 40 minutes, and when you finish, so the claim stays live (ADR 0042).

Report in a few lines: the spec path, the number of tasks and how many are `[opus]`, the ADRs you wrote, and anything left open.
