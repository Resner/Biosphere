# 0056: Retention: the history for good, fight logs for 14 days, and a storage budget

- Status: accepted, amended by 0058 (a witness commitment is kept 14 days, an attestation for good) (amends 0009: the checkpoint compaction it planned for M9 waits for M13's measurements)
- Date: 2026-11-04

## Context

The brief asks to retain the data or the verifiable proofs needed to check a history when its peers are offline, and to measure storage and expose the operating limits. The free plan gives the Durable Object 5 GB of SQLite storage and fails hard past it (ADR 0008). Every row write is also metered.

What fills the store, roughly:
- **Records**: about 0.7 KB a row, about 5 an hour of play (ADR 0019).
- **Commitments**: about 1 KB each.
- **Beacons**: 0.2 KB per committed round.
- **Fight logs** (ADR 0053): the start with every genome, every join, and one entry per frame per fighter. A 30 s duel stores a few KB, and a 90 s melee of four tens of KB.
- **Settlements** (ADR 0054): about 1 KB each.

At 200 players fighting a few times an hour, the logs alone would fill the free tier within weeks. The records grow by about 25 MB a day at 200 players around the clock.

A settlement is a countersigned document over the Merkle root of its frames. Without the log, it still binds the authority to the fight's results, but nobody can replay the fight.

## Decision

- **Kept for good** (the verifiable history): identities and keys, records, commitments, beacons, settlements and flags. A proof bundle (ADR 0055) never lacks one of these.
- **Fight logs**:
  - The frames are packed: each frame's inputs as 4-byte codes, `0xFFFFFFFF` for the fallback, the whole log base64 in the row.
  - A log is kept for `LOG_KEEP_DAYS` (14) after its settlement.
  - Then each later settlement's transaction prunes up to 4 of the oldest expired logs, so pruning needs no timer and costs a bounded number of writes.
  - A pruned row keeps its id, pond, time and settlement. `GET /v1/fight/<enc>` answers `log: null`, and the verifier reports the fight as checked by its signature and its records, not by replay. `docs/VERIFY.md` says so.
- **The storage budget**:
  - `npm run report:storage` writes `docs/perf/storage.md`. It measures, from hub tests' real rows:
    - the bytes stored per player-hour of ordinary play;
    - the bytes per fight, kept and after pruning;
    - the steady state at 5, 50 and 200 concurrent players.
  - Guards from that report:
    - a hub test keeps ordinary play under 10 KB per player-hour;
    - a 30 s duel's packed log stays under 8 KB, and a settled fight under 2 KB once pruned.
  - The 200-player steady state of the logs must stay under 1 GB, or the task shortens the window (never below 7 days) and records the value here.
  - The usage row records the database size (`ctx.storage.sql.databaseSize`) once a UTC day, and `GET /v1/audit` shows it with the free tier's limit.
- **Checkpoint compaction waits for M13.** It would keep only the hash of a dead creature's middle checkpoints and is the next lever if the records' growth needs one. M13's capacity model (`docs/CAPACITY.md`) turns these numbers into admission or the paid plan, within the €10 ceiling.

## Consequences

- A fight younger than 14 days can be replayed by anyone. An older one stays bound by its signed settlement and its records.
- Storage grows with the history alone, which a year of playtests fits easily. Its rate per player-hour is measured and guarded like the row writes.
- Pruning adds at most 4 row writes to a settlement, and only once logs start expiring.
- Rejected:
  - keeping every log for good (it fills the free tier first);
  - compressing logs with `CompressionStream` (asynchronous inside the settlement's transaction, for a gain the packing mostly gets);
  - pruning on an alarm (a timer for housekeeping, against ADR 0008);
  - dropping the logs of fights that changed no lineage (every fight changes a condition).
