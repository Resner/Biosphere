---
name: spec
description: Write the just-in-time spec for the current Biosphere milestone. Use only when /next routes here (the milestone has no spec yet) or when asked directly.
model: opus
effort: xhigh
---

# Spec: one milestone, just in time

Fresh sessions will build from this spec one task at a time, with nobody to ask. Make it self-contained and testable.

1. Read this milestone's row and outline in `docs/ROADMAP.md` (outcome, exit criteria, gate, task outline), the parts of `docs/BRIEF.md` it covers, `docs/DESIGN.md`, the ADRs, the previous spec's notes, owner issues folded into this milestone, and only the code this milestone touches.
2. Decide open questions yourself. Record lasting decisions as ADRs (`docs/decisions/`, from `0000-template.md`). If the spec changes a mechanic or an initial value, update `docs/DESIGN.md` in the same PR.
3. Write `docs/specs/<id>-<slug>.md` from `template.md` in this folder:
   - Tasks in build order. Each one fits one session and one PR, and can be finished and verified in a single run.
   - Every task lists concrete acceptance tests (input → expected result) that can be written before the code.
   - Every exit criterion from the roadmap maps to tasks and to the end-to-end check.
   - Subjective quality (look, feel, responsiveness) goes in the rubric as checkable statements, each with the evidence that settles it.
4. Set the milestone's status to `specced` in `docs/ROADMAP.md`. Leave the other rows alone.
5. Ship it as a docs-only PR titled `docs(spec): <id> <title>`.
