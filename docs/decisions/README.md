# Decisions

Architecture decision records, append-only. An accepted ADR's text is never rewritten. A later decision gets a new ADR, and the older ADR's `Status:` line (the only line that changes) names what replaced which part. Read an ADR together with its status line and the ADRs it names: the text keeps the reasoning of its date, and the details may have moved on.

## Writing one

- Copy `0000-template.md` to the next free number.
- When the new ADR amends or supersedes an older one, say so in its own status line, update the older one's status line, and update the tables below, all in the same PR.
- Status words: `accepted`; `accepted, amended by NNNN` (a part changed); `accepted, partly superseded by NNNN` (a main part no longer holds); `superseded by NNNN` (nothing is left to follow).

## Where the current rule lives

Some topics have long chains of ADRs. Start at the newest one listed for a topic, then follow the ADRs it names.

| Topic | Current rule | History |
|-------|--------------|---------|
| Factory runs, lanes and claims | 0045 (the care backlog), 0044, 0042 | 0001, 0015, 0020 |
| Models for specs and tasks | 0026 | 0001, 0023 |
| CI and the release gate | 0045 (`check` and `check:full`), 0042, 0044 | 0001, 0015 |
| Rules versions and freezing | 0040 (no frozen versions before v1.0) | 0005, 0006, 0018, 0025, 0035 |
| Genome and body plan | 0041, then 0039, 0038, 0037, 0031, 0028, 0025 | 0006, 0018 |
| Look and the gallery | 0043, 0034 | 0024, 0032, 0033 |
| Speed, growth and pacing | 0036, 0029, 0022 | 0019, 0021 |

## Index

| ADR | Title | State | Later changes in |
|-----|-------|-------|------------------|
| [0001](0001-dark-factory-workflow.md) | Dark-factory workflow, branching and releases | accepted, partly replaced | 0015, 0023, 0026, 0042, 0044 |
| [0002](0002-owner-checks-and-credentials.md) | Owner checks, playtest gates and credentials | accepted | |
| [0003](0003-toolchain.md) | Toolchain and repository layout | accepted | 0017, 0045 |
| [0004](0004-rendering.md) | Rendering with Three.js and WebGL2 over a 2D gameplay plane | accepted | 0027 |
| [0005](0005-deterministic-simulation.md) | Deterministic simulation and versioned rules | accepted | 0035, 0040 |
| [0006](0006-genome-and-development.md) | Genome, inheritance and bounded development | accepted | 0025, 0036, 0040, 0041 |
| [0007](0007-networking.md) | Peer-to-peer networking: our own WebRTC mesh, hub signaling, TURN | accepted | |
| [0008](0008-minimal-authority.md) | Minimal authority on Cloudflare, budgets and admission | accepted | 0017 |
| [0009](0009-identity-and-records.md) | Identity and UTXO-like lineage records | accepted | |
| [0010](0010-randomness.md) | Randomness from drand quicknet: commitments and outage policy | accepted | |
| [0011](0011-combat-encounters.md) | Combat as refereed deterministic encounters | accepted | |
| [0012](0012-witnesses.md) | Witnesses: drand-selected, budgeted, never final | accepted | |
| [0013](0013-world-partition.md) | World partition: size tiers, area of interest, habitats | accepted | 0029 |
| [0014](0014-game-pillars.md) | Game pillars: water world, controls, economy and supply control | accepted | DESIGN §3 (keys, the six core actions) |
| [0015](0015-chained-runs-public-repo.md) | Chained factory runs in a public repository | accepted | 0020, 0042, 0044 |
| [0016](0016-shared-pond-model.md) | Shared pond model: local sim, hub clock, food claims | accepted | |
| [0017](0017-workers-vitest-plugin.md) | Worker tests use `@cloudflare/vitest-plugin` | accepted | |
| [0018](0018-body-seam-and-genome-sharing.md) | Body seam, genome encoding and sharing, shader gait (M3) | accepted | 0025, 0035, 0040 |
| [0019](0019-ledger-mechanics-and-life-clock.md) | Ledger mechanics, genesis commitments and the life clock (M4) | accepted | 0025, 0029 |
| [0020](0020-single-factory-pr-guard.md) | Lowest PR number wins, enforced by CI | accepted | 0042, 0044 |
| [0021](0021-mating-offspring-and-the-checkpoint-chain.md) | Mating, offspring and the checkpoint chain (M5) | accepted | 0022 |
| [0022](0022-mating-cooldown-nine-minutes.md) | The mating cooldown is 9 minutes | accepted | 0029 |
| [0023](0023-opus-for-ui-netcode-and-security-tasks.md) | Opus for UI, netcode and security tasks | accepted | 0026 |
| [0024](0024-look-passes-on-a-committed-gallery.md) | Look passes are judged on a committed gallery | accepted, amended | 0032, 0033, 0034, 0043 |
| [0025](0025-body-plan-v2.md) | Body plan v2: silhouettes from development, karyotype v2 | accepted | 0028, 0040, 0041 |
| [0026](0026-opus-tasks-in-a-forked-subagent.md) | Opus tasks and specs run in a forked subagent | accepted | |
| [0027](0027-depth-of-field-as-sprite-scatter.md) | Depth of field as a per-sprite scatter | accepted | |
| [0028](0028-body-proportions-by-karyotype.md) | Body proportions follow the karyotype | accepted, amended | 0031, 0037, 0039, 0040 |
| [0029](0029-visible-growth-and-faster-maturity.md) | Visible growth and faster maturity | accepted | |
| [0030](0030-development-speed-budget.md) | Development speed budget is 0.15 ms | accepted | |
| [0031](0031-long-bodies-laterally-compressed.md) | Long bodies are laterally compressed, and long parts reach past the v1 range | accepted, amended | 0037, 0038, 0039, 0040, 0041 |
| [0032](0032-gallery-shows-rules-6-bodies.md) | The gallery shows rules 6 bodies, and look features get specimens | accepted | 0040, 0043 |
| [0033](0033-ship-m6-with-the-look-gaps-open.md) | M6 ships with the remaining look gaps, and the owner's gate judges them | superseded | 0034 |
| [0034](0034-one-look-pass-against-pass-1.md) | M6b judges the look in one pass, against pass 1 | accepted, amended | 0043 |
| [0035](0035-rules-7-bodies-follow-the-current-rules.md) | Rules 7, and bodies follow the current rules until encounters settle on them | accepted, partly superseded | 0040 |
| [0036](0036-top-speed-in-a-band.md) | Top speed lives in a band | accepted | |
| [0037](0037-one-body-widest-at-the-trunk.md) | One body, widest at the trunk | accepted, amended | 0038, 0040, 0041 |
| [0038](0038-curled-chains-fit-along-their-curve.md) | Curled chains fit the bounds along their curve, and a coil is a chambered spiral | accepted, amended | 0039, 0041 |
| [0039](0039-thin-legs-off-the-body.md) | Thin legs that keep off the body | accepted | 0040, 0041 |
| [0040](0040-pre-1-0-world-resets.md) | Before v1.0, a rules change may reset the world; no frozen versions | accepted | |
| [0041](0041-bodies-read-as-organisms.md) | A body plan reads as an organism: parts by region, a visible-part budget | accepted | |
| [0042](0042-flake-resistant-gates-and-live-claims.md) | Flake-resistant gates and live claims | accepted | 0044 |
| [0043](0043-glass-sheen-and-two-tone-organs.md) | Glass with pass 1's sheen, organs in two related tones, gallery specimens per rules | accepted | |
| [0044](0044-two-lanes.md) | Two lanes: build and care, each with its own lock | accepted | 0045 |
| [0045](0045-rules-that-fit-the-size.md) | Rules that fit the project's size: a quick check, lean rule files, a care backlog | accepted | |
