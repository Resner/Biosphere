---
name: milestone
description: Close the current Biosphere milestone - verify, review against the spec and rubric, prune, update the roadmap, and bump VERSION to release it. Use only when /next routes here (every task ticked) or when asked directly.
model: opus
effort: high
---

# Milestone close

Nothing ships unless it meets the spec. Be strict about requirements, not about taste.

1. On an up-to-date `main`, run `npm run verify`. If it's red, fixing it is this run's work.
2. Review everything since the last release (`git describe --tags --abbrev=0`; on the first release, the whole tree) against the spec's exit criteria, end-to-end check and rubric. Gather evidence for rubric items (screenshots, timings), and run `/code-review` on that range for correctness.
3. A gap that breaks a requirement becomes a new task in this spec. Ship that as the PR and stop; the release waits.
4. Prune while it's cheap: dead code, unused dependencies, and stale or duplicated lines in CLAUDE.md and `.claude/rules/`.
5. Update the roadmap: mark this row `done` and record its release. If what you learned changes later milestones, adjust their outcomes and exit criteria; keep the order, and record scope changes in an ADR.
6. Bump `VERSION` to this milestone's release: a minor bump, or 1.0.0 for the final milestone.
7. Ship as `chore(release): v<version> <milestone title>`, with player-facing release notes in the PR body. The merge runs the full tests, deploys to Pages and tags the release.
8. Once the Release workflow is green, open an issue `Playtest: v<version>` with the Pages link, what changed, what to try, and the spec's `(owner)` checks. For a `gate` milestone, say that the factory waits for the owner's reply.
