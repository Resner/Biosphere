# Biosphere

A browser game, built milestone by milestone by Claude Code running as an unattended "factory".
Each finished milestone is released from `main` and deployed to GitHub Pages.
<!-- /scaffold adds a one-paragraph product summary and an architecture map (≤10 lines) here. -->

## Commands

The npm script contract: CI, hooks and skills call these names; the tools behind them may change.

- `npm run check`: lint, typecheck, unit tests. Keep it under ~30 s; it also runs when you stop after code changes.
- `npm run build`: static site into `dist/`; shows `BUILD_LABEL` (the release tag) when set.
- `npm run test:e2e`: fast E2E against `dist/` (PR gate). `npm run test:e2e:full`: all of it, including slow scenarios (release gate).
- `npm run e2e:setup`: optional CI-only setup, such as a browser install.
- `npm run verify`: check + build + test:e2e:full.
- Tests never depend on live external services (relays, NAT, randomness beacons, hosted backends): fake them or replay recorded fixtures. Live behaviour is checked in playtests.

## Where things live

- `docs/BRIEF.md`: the original product brief. Read the parts you need; don't rewrite it.
- `docs/ROADMAP.md`: the linear timeline from M0 to v1.0.0 and each milestone's status. It decides what's next.
- `docs/specs/<milestone>.md`: tasks with acceptance tests and per-task notes.
- `docs/decisions/`: ADRs. Don't re-decide an accepted one; supersede it with a new ADR.
- `.claude/rules/`: quality bars for each code area, loaded when you touch matching files.

## Factory rules

- `/next` advances exactly one step and ships exactly one PR. Only one factory PR is open at a time.
- Nobody reviews PRs. The gates are tests written first, `npm run check`, `/simplify`, `/code-review` and the required CI check `verify`, then auto-merge. Never leave a PR red.
- Never push to `main`, create tags or releases, or weaken a test or CI check to get green. Releases happen only through a `VERSION` change merged to `main`.
- Unattended runs don't ask questions or use plan mode: decide, record lasting decisions as ADRs, and continue. If truly stuck, open a `Blocked: …` issue and stop.
- Work in the main loop; use subagents only for disposable review passes.
- Fun, feel on real hardware and real-world networking are the owner's call. Specs mark those checks `(owner)`, each release opens a `Playtest: v<version>` issue, and a `gate` milestone waits for the owner's reply.
- Credentials (hosting, TURN, domains) come from the owner. Never commit secrets or ask for their values in a session; open a `Blocked:` issue with exact setup steps and the secret name the workflow reads.
- Commits and PRs belong to the repository owner: no `Co-Authored-By` trailers and no "Generated with Claude Code" lines. The session hook sets the git identity.

## Gotchas

- A `VERSION` change on `main` triggers the release workflow (full tests → Pages → tag). Only the `milestone` step bumps it.
- Cloud sessions and CI have no GPU: WebGL renders in software. Judge visuals from screenshots, not frame rates.
- Cloud sessions have Chromium pre-installed at `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH`); don't download browsers there. If the pinned Playwright expects another build, launch `/opt/pw-browsers/chromium` via `executablePath`.
- In cloud sessions the proxy blocks `gh pr` and `gh issue` (GraphQL); use the GitHub MCP tools for PRs, issues and merges.
- GitHub offers auto-merge only while checks are pending. If a PR is already green, squash-merge it directly.
- Actions minutes are budgeted (3,000 a month, private repo). Keep CI to one job, and keep slow E2E scenarios in `test:e2e:full`.

## Compaction

Keep the current step and task id, the files changed, and the last test commands with their results.
