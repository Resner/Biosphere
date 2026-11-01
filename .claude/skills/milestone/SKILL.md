---
name: milestone
description: Close the current Biosphere milestone - verify, review against the spec and rubric, prune, update the roadmap, and bump VERSION to release it. Use only when /next routes here (every task ticked) or when asked directly.
model: opus
effort: high
---

# Milestone close

Nothing ships unless it meets the spec. Be strict about requirements, not about taste. A bar the owner set in an issue (a look matched against references, a feel) is a requirement: judge it critically against the owner's references, and never pass it because the tests are green.

1. On an up-to-date `main`, run `npm run check`, and make sure the latest `E2E main` run (`e2e-main.yml`, the full suite on parallel runners) is green on `main`'s current head. If that head has none, dispatch it (`gh workflow run e2e-main.yml -R Resner/Biosphere`) and wait for it in the foreground, about 10 minutes. If either is red, fixing it is this run's work: the release must not be the first full run of this commit (ADR 0042).
2. Review everything since the last release (`git describe --tags --abbrev=0`; on the first release, the whole tree) against the spec's exit criteria, end-to-end check and rubric. Gather evidence for rubric items (screenshots, timings), and run `/code-review` on that range for correctness.
3. A gap that breaks a requirement becomes a new task in this spec. Ship that as the PR and stop; the release waits.
4. Prune while it's cheap: dead code, unused dependencies, and stale or duplicated lines in CLAUDE.md and `.claude/rules/`.
5. Update the roadmap: mark this row `done` and record its release. If what you learned changes later milestones, adjust their outcomes and exit criteria; keep the order, and record scope changes in an ADR.
6. Bump `VERSION` to this milestone's release: a minor bump, or 1.0.0 for the final milestone.
7. Ship as `chore(release): v<version> <milestone title>`, with player-facing release notes in the PR body. The merge runs the full tests, deploys to Pages and tags the release.
8. Once the Release workflow is green, open an issue `Playtest: v<version>` with the Pages link, what changed, what to try, and the spec's `(owner)` checks. For a `gate` milestone, say that the factory waits for the owner's reply. Close the owner issues this milestone fully delivered, each with a comment linking the release; leave open those that wait for the owner's acceptance, and say so in the Playtest issue.
