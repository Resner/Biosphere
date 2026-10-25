# Biosphere

A browser game, built milestone by milestone by Claude Code running as an unattended "factory".
Each finished milestone is released from `main` and deployed to GitHub Pages.

Biosphere is a top-down, peer-to-peer creature-evolution game set in one continuous body of water, with no NPCs: the world lives with its players. A player hatches a single cell from unique DNA, then swims, feeds, avoids hazards, fights comparable creatures and mates with other players. Each mating gives both players a distinct offspring whose procedural body inherits Mendelian genes from both parents. Lineages persist as verifiable chains of records; death falls back to the pending offspring or the nearest surviving ancestor. Priorities when requirements conflict: a fun, readable core loop, then morphology and inheritance, looks, robust multiplayer, disconnect-safe combat, verifiable lineage, and finally scale (`docs/BRIEF.md`).

## Architecture

Each directory appears with the milestone that first needs it (ADRs 0003–0014).

- `src/sim/`: deterministic, versioned rules (30 Hz tick, own math, seeded PRNG streams); shared by clients, Node and the Worker; no DOM, three.js or network.
- `src/genome/`: diploid DNA, expression, bounded development into body plans and stats, mutation and inheritance; deterministic and shared.
- `src/render/`: Three.js (WebGL2) scene, procedural creature meshes, materials, post-processing, presets; reads sim snapshots only.
- `src/net/`: WebRTC `PeerMesh` (≤32 peers), hub signaling, ponds and AoI, codecs; `protocol.ts` is shared with the Worker.
- `src/ledger/`: browser identity, canonical signed records, drand verification, lineage verification; shared.
- `src/game/` and `src/lab/`: app shell, loop, input, HUD, screens, chat, audio, `window.__bs` test hook; the Creature Lab page.
- `worker/`: Cloudflare Worker with one SQLite Durable Object: sessions, signaling, TURN credentials, ledger, clock, commitments, referee, admission.
- `tests/e2e/` (Playwright against `dist/`), `tests/fixtures/` (recorded drand beacons), `tools/` (load simulation, reports, fixture recorders).

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
- `docs/ROADMAP.md`: the ordered milestones from M0 to v1.0.0, their status and an outline of each. It decides what's next.
- `docs/DESIGN.md`: how the game plays, with initial values. Code tables are the source of truth; update DESIGN.md when a mechanic or value changes.
- `docs/specs/<milestone>.md`: tasks with acceptance tests and per-task notes.
- `docs/decisions/`: ADRs. Don't re-decide an accepted one; supersede it with a new ADR.
- `.claude/rules/`: quality bars for each code area, loaded when you touch matching files.
- `docs/art/`: art-direction references (never shipped).

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
- Cloud sessions have Chromium pre-installed at `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH`); don't download browsers there. `@playwright/test` is pinned to that build, and `playwright.config.ts` falls back to `/opt/pw-browsers/chromium` when they differ.
- Add or upgrade packages with `npx -y npm@11 install …`: npm 10 (Node 22's default) crashes on Vite 8's peer graph (`edgesOut`). `npm ci` works with both.
- Biome lints and formats code files only, so Markdown stays untouched. `npm run format` applies its fixes; `check` fails on unformatted code.
- In cloud sessions the proxy blocks `gh pr` and `gh issue` (GraphQL); use the GitHub MCP tools for PRs, issues and merges.
- GitHub offers auto-merge only while checks are pending. If a PR is already green, squash-merge it directly.
- Actions minutes are budgeted (3,000 a month, private repo). Keep CI to one job, and keep slow E2E scenarios in `test:e2e:full`.

## Compaction

Keep the current step and task id, the files changed, and the last test commands with their results.
