# Storage report

Reproduce with `npm run report:storage`. Bytes are column sizes of the rows a hub test writes
(`worker/storage.test.ts`), rounded to 100 bytes; SQLite pages and indexes add some on top.
ADR 0056 sets the retention these numbers check: the history for good, fight logs for
14 days, a free-tier limit of 5.0 GB.

## What a player writes

| Event | Stored |
|---|---|
| A hatch | 2.1 KB |
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

## Steady state and growth

Players around the clock, each in 3 fights an hour, every fight a 30 s duel.
Hours of play are charged at the measured ordinary hour; the history never shrinks.

| Concurrent players | Logs kept (steady state) | History growth a year | Days to the limit |
|---|---|---|---|
| 5 | 14 MB | 0.2 GB | 9030 |
| 50 | 138 MB | 2.0 GB | 880 |
| 200 | 551 MB | 8.1 GB | 200 |

The logs' steady state at 200 players (551 MB) is under 1.0 GB, so the 14-day window stands.

At 200 players around the clock the history alone reaches the limit in about 200 days: the lever is
checkpoint compaction (ADR 0056), which M13's capacity model weighs against admission and the paid plan.
