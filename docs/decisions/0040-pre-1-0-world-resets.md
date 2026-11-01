# 0040: Before v1.0, a rules change may reset the world; no frozen versions

- Status: accepted (supersedes, until v1.0, the freezes of 0005, 0006, 0018, 0025 and 0035: released versions are never edited, old code stays to verify history, and development and stats freeze from M7)
- Date: 2026-11-01

## Context

Every rules version since M5 kept its predecessors callable, so that every recorded genesis and birth stays verifiable:
- `karyotype-v1.ts`, `develop-v5.ts`, `stats-v5.ts`, `inherit-v5.ts`, `genesis-v5.ts`, `genesis-v6.ts` and `genesis-v7.ts`: about 1,700 lines;
- eleven `-vN` golden files;
- version dispatch in `src/ledger`, `src/genome`, the worker, the lineage view and the protocol.

Each look or body change since then has paid this again: a freeze step, regenerated goldens beside frozen ones, and "v1 equivalence" properties. M6b T13 froze genesis 7 although nothing verifies it yet. The independent verifier is M9, and the first outcome that depends on a body is M7's combat.

The owner said on 2026-11-01 (in a Claude session, alongside the Playtest v0.7.1 feedback) that a complete wipe is fine if it reduces the overhead. Only the owner and a few friends play; nothing is promised to last before v1.0.

## Decision

- **Until v1.0, a rules version change may reset the world.** The authority deletes every creature (checkpoints are creature rows), record, commitment, mating and genesis-log entry, and records the reset time. It keeps:
  - identities: players, keys, names, recovery codes;
  - the usage meter and admission state;
  - recorded drand beacons, which are public data.
  Clients that come back see one short notice: "The world was renewed in v<version>. Your identity is kept; your creatures start again." History shows the new epoch only.
- **No frozen versions before v1.0.** A reset retires every older rules version.
  - Its code and goldens are deleted. The ledger checks (`checkGenesis`, `checkBirth`, `checkStored`) answer `rules-retired` for any version before the reset. Versions bumped later without a reset keep their code, as below.
  - Karyotype v1 support goes too: after a reset every genome is v2, decoding stays total for any bytes, and v1-length input simply decodes as v2 padded.
- **A reset is a deliberate step**: its own task, a worker migration that runs once, a `PROTOCOL_VERSION` bump so no pond mixes epochs, and a line in the release notes and the Playtest issue. The migration also clears what points at deleted rows (a player's pending commitment) and refills the hatch bucket. The hub tells each returning identity once that the world was renewed: it compares the player's `first_seen` with the reset time, so new players never see the notice. A rules bump without a reset is still allowed when nothing recorded changes meaning. In that case the old code is kept, as before.
- **From v1.0, or earlier if M9's verifier ships lineages that players are told to keep**, lineages are permanent and versions are frozen again (0005, 0018). The M14 spec writes that ADR.

## Consequences

- Look and body work no longer pays a freeze tax. M6c removes about 1,700 lines and eleven golden files and reshapes development freely.
- Players lose their creatures and lineages at a reset; their identities stay. Each reset is announced, never silent.
- M9's verifier is built against one live rules version and grows multi-version support only when 1.0 needs it.
- Rejected:
  - keeping the freezes (the owner's overhead concern; nothing verifies old versions yet);
  - a wipe without an epoch (stale clients would recompute bodies under different rules and fail);
  - wiping identities too (recovery codes and names would break for no gain).
