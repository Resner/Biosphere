# Storage report

Reproduce with `npm run report:storage`. Bytes are column sizes of the rows a hub test writes
(`worker/storage.test.ts`), rounded to 100 bytes; SQLite pages and indexes add some on top.
ADR 0056 sets the retention these numbers check: the history for good, fight logs for
14 days, a free-tier limit of 1.0 GB.

## What a player writes

| Event | Stored |
|---|---|
| A hatch | 2.5 KB |
| An hour of ordinary play (progress every 30 s, then a close) | 2.7 KB |
| A beacon (shared by everyone) | 100 B |
| A commitment | 700 B |

The guard in `worker/storage.test.ts` keeps a hatch and an hour under 10 KB per player.

## Per record kind

From one hub history (two hatches, a mating, two promotions, a fight, a restore).

| Kind | Records | Average |
|---|---|---|
| birth | 2 | 1000 B |
| checkpoint | 8 | 700 B |
| death | 3 | 800 B |
| encounter | 1 | 800 B |
| genesis | 4 | 700 B |
| mate-commit | 2 | 1200 B |
| promote | 2 | 800 B |
| restore | 1 | 900 B |

## Per fight

| | Stored |
|---|---|
| The settlement (kept for good) | 1.1 KB |
| A kept row, a 30 s duel | 6.4 KB |
| The log alone, a 30 s duel (guard: under 8 KB) | 5.4 KB |
| The row after pruning (guard: under 2 KB) | 1.2 KB |
| A witness commitment, a pool of 16 (kept 14 days) | 1.2 KB |
| An attestation (kept for good) | 0.6 KB |

## Steady state and growth

Players around the clock, each in 3 fights an hour, every fight a 30 s duel with a witness commitment and an attestation.
Hours of play are charged at the measured ordinary hour; the history never shrinks.

| Concurrent players | Logs and witness commitments kept (steady state) | History growth a year | Days to the limit |
|---|---|---|---|
| 5 | 17 MB | 0.2 GB | 1490 |
| 50 | 168 MB | 2.4 GB | 130 |
| 200 | 672 MB | 9.6 GB | 10 |

The steady state of logs and witness commitments at 200 players (672 MB) is under 1.0 GB, so the 14-day window stands.

At 200 players around the clock the history alone reaches the free plan's limit in about 10 days. The free plan does not serve 200 around the clock, though:
`docs/CAPACITY.md` gives how long each plan's store lasts at its full daily allowance, and weighs checkpoint compaction (ADR 0056) against the paid plan.
