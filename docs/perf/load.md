# Load report

Written by `npm run sim:load` (`tools/load-report.ts`) from the headless harness (`tests/aoi-harness.ts`, ADR 0062) with the hub's `Directory`, `Crowds` and `place()` in the loop, the page's dial rules, and the pure parts' timings taken in Node. There are no sockets and no WebRTC: what a message costs inside the object is measured by M13 T6 and T7.

## The scenario

- **The fill**: 10 players in the first minute, then the rest evenly until minute 10, each placed by `place()`. 90% are starters, 9% T1 and 1% T2, the larger ones restored with an ancestor's size.
- **The hold**: from minute 10 to minute 16. Each player leaves after an exponential session with a mean of 30 minutes and a newcomer replaces each leaver at once, so the world holds 10,000 with about 5.6 joins a second.
- **Life**: players wander at 40–105 wu/s with dashes, and a player alone for 120 s rides. In each minute of the hold, 1 pair in 100 players, comparable and sharing water, fights for 30 s; a fighter that is due to leave leaves when its fight ends.
- **The pair checks** (discovery, hidden threats, views, tier links) run every 1 s on every client.

## Gates

1. **Budget**, in the hold (ADR 0070): world messages per player-minute after a player's first minute, median at most 8 and p95 at most 20 (the Worker's own budget); in a joiner's first minute p95 at most 100; the hold's mean, churn included, at most 12.
2. **Placement**: no clearance violation, no fall back to the spawn centre, every spawn with a group within the group's reach plus 3 clearances.
3. **Together**: a T0 newcomer with a group is linked to one of its members within 3 s at the median and 5 s at the p95.
4. **Bounded**: never more than 32 links, and at most 1% of client-seconds crowded after a client's first 10 s.
5. **No hidden creature**: gate 2 of the area-of-interest report among pairs that share water, as the wave reads it (ADR 0066), at most 1 violation-second in a million client-seconds (ADR 0070).
6. **Integrity**: fighters share water and keep their instance through their fights.

## Result

| Gate | Result | Detail |
|---|---|---|
| 1. Budget: in the hold, after a player's first minute, at most 8 world messages per player-minute (median) and 20 (p95); in a joiner's first minute at most 100 (p95); the hold's mean, churn included, at most 12 | pass | 10877 players: median 6.8, p95 15.7; 1593 joiners: first minute p95 92; mean 9.1 over 60004 player-minutes |
| 2. Placement: no clearance violation, no fall back to the spawn centre, every spawn with a group within the group's reach plus 3 clearances | pass | 11952 spawns and rides: 0 clearance violations, 0 fell back, 0 of 11951 with a group too far |
| 3. Together: a T0 newcomer with a group is linked to one of its members within 3 s (median) and 5 s (p95) | pass | 10755 newcomers: median 1.70 s, p95 2.00 s |
| 4. Bounded: never more than 32 links, and at most 1% of client-seconds crowded after a client's first 10 s | pass | 24 links at most, 0.00% crowded |
| 5. No hidden creature: a pair that shares water and can interact is left unlinked for at most 1 second in a million client-seconds | pass | 5 violations in 9.6 million client-seconds (at most 9): t=554.0s p2245 and p949 are 129 wu apart (reach 162) and not linked; t=555.0s p2245 and p949 are 83 wu apart (reach 162) and not linked; t=556.0s p2245 and p949 are 105 wu apart (reach 162) and not linked |
| 6. Integrity: fighters share water and keep their instance through their fights | pass | 600 fights, 0 violations |

| Metric | Value |
|---|---|
| Players, simulated seconds | 10,000, 960 |
| Upload per client (mean, most) | 4.4 KB/s, 29.1 KB/s |
| Download per client (mean, most) | 4.4 KB/s, 29.7 KB/s |
| Link setups per player-minute | 15.26 |
| Share of setups through a peer | 85.7% |
| Gossip per link | 0.121 KB/s |
| Most links held at once | 24 |

## Messages by type

| Message | Count | Per player-minute |
|---|---|---|
| where | 347,830 | 3.31 |
| where with a crowd list | 4 | 0.00 |
| spawn | 11,952 | 0.11 |
| ride | 0 | 0.00 |
| gone | 1,952 | 0.02 |
| offer | 506,439 | 4.82 |
| answer | 338,188 | 3.22 |
| refuse | 191,793 | 1.83 |
| signal resend | 237,632 | 2.26 |

## The fill, minute by minute

Groups are the groups `place()` finds for a T0 newcomer; crowded players and instances are counted at the minute mark; spawns, rides and messages are the minute's. The fill's first minutes cost far more per player than a live world would (18 joins a second into a few thousand players): they are reported, not gated.

| Minute | Players | Groups | Crowded players | Instances | Spawns | Rides | Messages per player |
|---|---|---|---|---|---|---|---|
| 1 | 11 | 1 | 0 | 0 | 11 | 0 | 11.9 |
| 2 | 1121 | 1 | 0 | 2 | 1110 | 0 | 65.6 |
| 3 | 2231 | 1 | 0 | 4 | 1110 | 0 | 46.8 |
| 4 | 3341 | 1 | 0 | 6 | 1110 | 0 | 35.5 |
| 5 | 4451 | 1 | 0 | 6 | 1110 | 0 | 26.7 |
| 6 | 5561 | 2 | 0 | 6 | 1110 | 0 | 22.5 |
| 7 | 6671 | 1 | 0 | 6 | 1110 | 0 | 19.3 |
| 8 | 7781 | 1 | 0 | 6 | 1110 | 0 | 17.4 |
| 9 | 8891 | 1 | 0 | 6 | 1110 | 0 | 15.7 |
| 10 | 10000 | 1 | 0 | 6 | 1109 | 0 | 14.3 |
| 11 | 10000 | 1 | 0 | 6 | 339 | 0 | 10.1 |
| 12 | 10000 | 4 | 0 | 6 | 333 | 0 | 9.6 |
| 13 | 10000 | 19 | 0 | 6 | 337 | 0 | 9.2 |
| 14 | 10000 | 22 | 0 | 6 | 302 | 0 | 8.8 |
| 15 | 10000 | 45 | 0 | 6 | 331 | 0 | 8.6 |
| 16 | 10000 | 46 | 0 | 6 | 310 | 0 | 8.4 |

## The hold, minute by minute

Messages per player-minute of the players past their first minute and in the water through the minute. The world relaxes from the fill through the hold, so the first minutes cost more.

| Minute | Players | Median | p95 | Mean |
|---|---|---|---|---|
| 11 | 8588 | 7.0 | 17.0 | 8.5 |
| 12 | 9343 | 7.0 | 17.0 | 8.3 |
| 13 | 9354 | 7.0 | 17.0 | 8.0 |
| 14 | 9389 | 6.0 | 17.0 | 7.6 |
| 15 | 9391 | 6.0 | 16.0 | 7.4 |
| 16 | 9379 | 6.0 | 17.0 | 7.3 |

## Timings (machine-dependent)

The rest of this report is the same for a seed; this section is not. The numbers above are those of one run (seed `report0`, 2026-11-08); its gates 1 and 5 were then read under ADR 0070 from the same numbers (the run judged them against a median of 6, a p95 of 12 and no hidden creature at all).

| Operation | Count | Per second | p50 | p99 |
|---|---|---|---|---|
| where (directory report, near, crowds report) | 347,750 | 362.2 | 1.883 ms | 26.3 ms |
| place() | 11,952 | 12.4 | 27.0 ms | 72.2 ms |
| hub-relayed signal (reach check) | 1,037,905 | 1081.2 | 0.005 ms | 0.026 ms |
| crowd split (settle) | 30 | 0.0 | 0.025 ms | 6.362 ms |
| poolOf at a fight start | 600 | 0.6 | 6.431 ms | 26.8 ms |

- **Heap**: 2.9 MB for a directory of 10,000 members at the start of the hold.
- **Wall time**: 352.5 minutes.
