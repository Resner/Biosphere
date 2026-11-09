# 0074: From v1.0, lineages are permanent: one last renewal, rules 13, and frozen versions

- Status: accepted (closes ADR 0040's "until v1.0" and ADR 0055's open freeze: v1.0.0 renews the world a last time, then versions freeze again as ADRs 0005 and 0018 first had them)
- Date: 2026-11-09

## Context

ADR 0040 let a rules change reset the world before v1.0 and said the M14 spec writes the ADR that makes lineages permanent. ADR 0055 built the rules registry for that day and told players, on cards and in `docs/VERIFY.md`, that lineages last only from v1.0. The world was renewed four times (epochs 1 to 4); the live one runs rules 12.

M14 changes things that recorded history depends on before v1.0 ships: the balance pass may move values in `RULES` and the stats, and the plausibility fix (honest pages flagged) may move the rulebook's bounds. Every pre-1.0 world also holds the factory's test-era creatures and flags raised by bugs since fixed.

## Decision

- **One last renewal at v1.0.0.** The world starts again as epoch 5 under rules 13, as ADR 0061's renewal did: a migration that runs once deletes every creature, record, commitment, mating, fight and the world row's clock, refills every hatch bucket, and keeps identities, keys, names, flags, beacons, attestations and the usage meter. Returning identities hear "The world was renewed in v1.0.0" once.
- **Rules 13 holds every rules change M14 makes.** The version moves to 13 even where no value changes, so the permanent world starts at a version no earlier record shares. Until v1.0.0 is tagged, M14's tasks may change rules-13 values and goldens without another bump (nothing recorded under rules 13 has shipped).
- **M14 has one protocol bump, to 14.** Whichever task changes the wire first bumps it; later M14 tasks keep 14. Clients of v0.14.0 and before are refused.
- **From the v1.0.0 release, lineages are permanent.**
  - The factory never renews the world again. A renewal after v1.0 needs the owner's explicit decision in an issue and a new ADR.
  - A rules bump that changes a part (genesis, inherit, body, life, mating, encounter) keeps the older part's code and goldens callable under its version, adds a registry entry in the same epoch, and the verifier answers every registered version. `retired` stays only for versions before 13.
  - The goldens of a released rules version never change. `src/ledger/__golden__/frozen.json` lists, per rules version, the SHA-256 of every golden file that pins it, and a unit test fails when a file differs. `src/ledger/registry.ts` pins the manifest entry of each released version by its own hash (`RELEASED`), so changing a released entry takes a deliberate edit in two places, which `.claude/rules/tests.md` forbids.
- **Cards, `docs/VERIFY.md` and the notice** say that lineages are permanent from v1.0.0, where they said the world may be renewed before v1.0.

## Consequences

- Look and body work after v1.0 pays the freeze tax again: a changed part keeps its old implementation beside the new one. That is the cost of permanence, and the reason M14 renews first.
- Players lose their pre-1.0 creatures a fifth time, announced in the release notes, the Playtest issue and the notice. Identities, names and recovery codes stay.
- The 200-player playtest runs on the permanent world it judges. What it finds is fixed forward with rules bumps that keep rules 13 checkable.
- Rejected:
  - freezing rules 12 without a renewal (M14's changes would need rules-12 code kept forever, and test-era records and bug flags would be permanent);
  - renewing after the playtest instead (the playtest would judge a world that is then thrown away, and a second v1.x renewal would break the promise the release makes);
  - pinning goldens by git history in CI (a shallow checkout has none; a hash in code is checkable everywhere).
