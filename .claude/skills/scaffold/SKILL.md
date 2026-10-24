---
name: scaffold
description: One-time Biosphere scaffold from the product brief - roadmap timeline to v1.0, architecture decisions, a toolchain implementing the npm script contract, and domain rules. Run once, interactively, before the factory starts.
disable-model-invocation: true
model: opus
effort: xhigh
---

# Scaffold (once, with the owner present)

The product brief is in $ARGUMENTS. If that's empty, ask the owner to paste it.

1. Save the brief verbatim as `docs/BRIEF.md`. It stays the source of intent.
2. Interview the owner (AskUserQuestion) only about choices the brief leaves open that are expensive to reverse, plus the factory cadence (runs per day) for the timeline.
3. Architecture: one short ADR per lasting decision (`docs/decisions/`, from `0000-template.md`). Prefer the simplest design that meets the brief, and name rejected options in one line each.
4. `docs/ROADMAP.md` is a linear timeline from M0 to v1.0.0:
   - Each milestone is a shippable, testable increment with observable exit criteria, a size in factory runs, and a window in weeks from the start (no dates).
   - Prove the riskiest assumptions with the smallest builds first. The last milestone is v1.0.0: everything in the brief, done.
   - Fill in "Brief coverage" so every brief requirement maps to a milestone.
5. M0, in this session: a toolchain that implements the npm script contract in CLAUDE.md.
   - Set `engines.node`, and add the npm ecosystem to `.github/dependabot.yml`.
   - E2E must also run in cloud sessions (see the CLAUDE.md gotcha).
   - `npm run check` stays under ~30 s, and the page shows `BUILD_LABEL`.
6. Add `.claude/rules/<area>.md` (with `paths:`) for each code area. Include only the non-obvious quality bar (invariants, budgets, patterns to follow) that can't be read from the code.
7. Update CLAUDE.md with a one-paragraph product summary and an architecture map (≤10 lines). Keep the file under ~100 lines.
8. Mark M0 `done`, set `VERSION` to `0.1.0`, delete this skill, run `npm run verify`, then open the PR and see it merged (auto-merge). The merge deploys v0.1.0.
9. Tell the owner the factory is ready to start: the scheduled task in `docs/SETUP.md`, step 7.
