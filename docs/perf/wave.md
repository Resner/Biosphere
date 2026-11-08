# Population wave report

Written by `npm run sim:wave` (`tools/wave-report.ts`) from the headless harness (`tests/aoi-harness.ts`, ADR 0062) with the hub's `Crowds` and `place()` in the loop and the page's dial rules. There are no sockets and no WebRTC, and the wave judges grouping, not cost (M13).

## The wave

- **The wave**: 5 players join in the first 2 minutes; 295 more join over the next 10 minutes, one every 2 s, each placed by `place()`. 10% are T1, restored with a T1 ancestor's size.
- **The fall**: from minute 14 players leave at random until 20 remain, by minute 18.
- **The end**: the run lasts 24 minutes.
- Players wander at 40–105 wu/s with dashes; a player alone for 120 s rides the current.
- Every minute from minute 8 to 14 (the peak), 3 attackers each engage the nearest comparable player that shares their water, for 30 s.

## Gates

1. **Clearance**: every spawn and ride arrival keeps the clearance from every engage-capable member and every spawn of the last 60 s, lies in the safe depth band, and is never within P1 reach of a member in an instance, by the directory's positions. An arrival that falls back to the spawn centre owes none (the first player of an empty world is placed there).
2. **Together**: a T0 newcomer whose placement found a group is linked to one of its members within 3 s at the median and 5 s at the p95; every newcomer within 15 s at the p95. A newcomer never linked counts as never.
3. **At the group's edge**: every spawn or ride that found a group lies within the group's reach plus 3 clearances of its centroid (ADR 0066). The group's reach is its radius, counting the spawns of the last minute around it, which are about to be members. A spawn that fell back to the spawn centre fails it.
4. **Regrouped**: from 4 minutes after the fall, at least 90% of the player-seconds of players that have a creature they can link with hold a link to one. The worst single second is reported: with 20 players left, a pair that wanders apart is two lone players for as long as a ride waits, 120 s (ADR 0066).
5. **Bounded**: at the peak at most 1% of client-seconds (after a client's first 10 s) are crowded and no client holds more than 32 links; no crowd stands from 2 minutes after the fall.
6. **No hidden creature**: gate 2 of the area-of-interest report among pairs that share water. A pair that knows each other only from the directory (no snapshot, gossip or signal fix) is excused for 40 s instead of 10 s: the directory's word is up to one `where` interval (30 s) old, and nothing else tells two lone creatures that they have closed (ADR 0066).
7. **Integrity**: no fighter changes instance during its fight; fighters share water; no rider is a fighter or within 120 s of the end of its fight.
8. **Budget**: incoming authority messages (`where` reports with crowd lists, `spawn`, `ride` and hub signals): in the hold (a minute after the last join until the fall begins) at most 6 per player-minute at the median and 12 at the p95, for the players in the water through it; over the whole wave a mean of at most 20, the Worker's budget of one request-equivalent per player-minute (ADR 0066).

## Result

| Gate | Result | Detail |
|---|---|---|
| 1. Clearance: every spawn and ride arrival keeps its distance, in the depth band | pass | 608 arrivals (0 fell back to the spawn centre), 0 violations |
| 2. Together: a T0 newcomer with a group linked to it within 3 s (median), 5 s (p95); every newcomer within 15 s (p95) | pass | 544 T0 newcomers with a group: median 1.60 s, p95 1.90 s; 600 newcomers: p95 1.90 s |
| 3. At the group's edge: every spawn that found a group lies within its reach plus 3 clearances of its centroid | pass | 606 spawns and rides with a group, 0 too far or at the centre (the farthest 2.72 clearances past its reach) |
| 4. Regrouped: from the wait after the fall, at least 90% of player-seconds hold a link to a creature they can link with | pass | 92.7% of player-seconds over 242 s (the worst second 70%) |
| 5. Bounded: at the peak at most 1% of client-seconds crowded, never more than 32 links; no crowd left after the fall | pass | 0.00% crowded at the peak, 24 links at most, 0 crowds left |
| 6. No hidden creature: no pair that shares water and can interact is left unlinked | pass | 0 violations |
| 7. Integrity: no fighter changes instance, fighters share water, no ride by a fighter or within 120 s of its fight | pass | 36 fights, 8 rides, 0 water violations, 0 rides by fighters |
| 8. Budget: in the hold at most 6 incoming authority messages per player-minute (median) and 12 (p95); over the whole wave a mean of at most 20 | pass | hold: median 4.3, p95 9.4 over 600 players; whole wave: mean 14.8 over 5808 player-minutes |

| Metric | Value |
|---|---|
| Runs, players, simulated seconds | 2, 300, 1440 |
| Spawns and rides (spawns at the spawn centre) | 600 and 8 (0) |
| Ride to first link (p50, p95) | 3.70 s, 4.60 s |
| Authority messages per player-minute (median, p95; first minute p95) | 7, 24; 86 |
| Most links held at once | 24 |

## Minute by minute (seed report0)

Groups are the groups `place()` finds for a T0 newcomer; crowded players and instances are counted at the minute mark; spawns, rides and messages are the minute's.

| Minute | Players | Groups | Crowded players | Instances | Spawns | Rides | Messages per player |
|---|---|---|---|---|---|---|---|
| 1 | 3 | 1 | 0 | 0 | 3 | 0 | 5.0 |
| 2 | 6 | 2 | 0 | 0 | 3 | 0 | 4.8 |
| 3 | 36 | 1 | 0 | 0 | 30 | 0 | 38.4 |
| 4 | 66 | 2 | 0 | 0 | 30 | 0 | 39.6 |
| 5 | 96 | 6 | 0 | 0 | 30 | 0 | 31.0 |
| 6 | 126 | 6 | 0 | 0 | 30 | 0 | 24.6 |
| 7 | 156 | 5 | 0 | 0 | 30 | 0 | 20.8 |
| 8 | 186 | 9 | 0 | 0 | 30 | 0 | 18.5 |
| 9 | 216 | 12 | 0 | 0 | 30 | 0 | 17.3 |
| 10 | 246 | 7 | 0 | 0 | 30 | 0 | 15.9 |
| 11 | 276 | 7 | 0 | 0 | 30 | 0 | 15.6 |
| 12 | 300 | 15 | 0 | 0 | 24 | 0 | 13.5 |
| 13 | 300 | 10 | 0 | 0 | 0 | 1 | 6.8 |
| 14 | 300 | 14 | 0 | 0 | 0 | 0 | 4.8 |
| 15 | 225 | 13 | 0 | 0 | 0 | 0 | 10.5 |
| 16 | 155 | 16 | 0 | 0 | 0 | 0 | 12.1 |
| 17 | 84 | 22 | 0 | 0 | 0 | 0 | 15.9 |
| 18 | 20 | 14 | 0 | 0 | 0 | 0 | 28.8 |
| 19 | 20 | 11 | 0 | 0 | 0 | 0 | 3.1 |
| 20 | 20 | 12 | 0 | 0 | 0 | 1 | 2.8 |
| 21 | 20 | 8 | 0 | 0 | 0 | 1 | 3.4 |
| 22 | 20 | 7 | 0 | 0 | 0 | 2 | 3.1 |
| 23 | 20 | 11 | 0 | 0 | 0 | 0 | 3.5 |
| 24 | 20 | 13 | 0 | 0 | 0 | 0 | 2.0 |
