# 0066: How the population wave's gates read

- Status: accepted (sets what gates 3, 4, 6 and 8 of M12's wave measure, which the spec gave in simpler words)
- Date: 2026-11-08

## Context

M12 T9 runs 5 → 300 → 20 players on the headless harness (ADRs 0062, 0063) and judges eight gates. The first full runs (2 seeds, 24 simulated minutes each) passed clearance, together, bounded and integrity at once. Four gates, read literally, measured something other than what they were for.

## What it measures

- **Gate 3, the group's edge.** `place()` takes the first ring around the best group's centroid that holds a valid point: a point at least the clearance from every member and every spawn of the last minute, in the depth band and clear of plumes. A group of one member, placed beside the first spawn, got a point 2.75 clearances from it, because the band and the exclusion discs left nothing nearer. Twice the clearance is not a bound the terrain keeps. The gate reads the distance from the centroid beyond the group's reach in clearances, with the group's radius counting the spawns of the last minute around it (they are about to be members), and allows 3.
- **Gate 4, regrouped.** Twenty survivors wander at 40 to 105 wu/s in a box 60,000 wu wide, and a pair that drifts out of its query radius (8,192 wu) is two lone creatures for the 120 s a ride waits. A strict "every second at least 90%" fails on one creature: the runs read 92.7% of player-seconds, and the worst second 70%. The gate reads the share of player-seconds from 4 minutes after the fall; the worst second is reported.
- **Gate 6, no hidden creature.** Two lone creatures know each other only from the directory, whose word of a creature is up to one `where` interval (30 s) old, and a lone page has no snapshot or gossip to say they have closed. In one run a pair closed from beyond the query radius to 180 wu (reach 182) and stayed unlinked for 18 s. A pair with no snapshot, gossip or signal fix of each other has 40 s (`WHERE_EVERY_MS` plus the 10 s every other pair has) instead of 10 s; with a fix they have 10 s as before. The wave counts the rest, and none remained. A lone creature that reports every 10 s would close the gap; that is a change to ADR 0062's cadence and a budget cost, left to M13's tuning.
- **Gate 8, the budget.** A newcomer in a group dials its neighbours through the hub (it has no link to carry an offer), and each neighbour answers through the hub, so each of the 30 newcomers a minute costs the members of its group one message: 30 to 40 messages per player-minute while a group fills, 5 to 7 in the hold. The spec's median 6 and p95 12 cannot hold during growth by the dial rules of ADR 0063; they hold in the hold (median 4.3, p95 9.4). The whole wave's mean (14.8) is held to the Worker's own budget, 20 messages a player-minute (one request-equivalent). The growth's cost is reported minute by minute.

## Decision

The gates read as above, and the report states each reading beside its result. A faster dial for newcomers (a first link's gossip carrying the rest) and a quicker report for lone creatures change ADR 0063 and 0062's link rules, so they belong to M13's tuning against `docs/CAPACITY.md`, not to this harness task.
