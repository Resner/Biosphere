# Area-of-interest report

Written by `npm run report:aoi` (`tools/aoi-report.ts`). Simulated clients each run their own `AoiManager`, `WhereReporter`, `Gossip` and `SignalRoute` against one `Directory` (`tests/aoi-harness.ts`), over a seeded link model: a hop between peers takes 30–80 ms, the hub 50–150 ms each way, ICE 0.5–2 s with 5% of attempts failing and being retried, and the hello a round trip. There are no sockets and no WebRTC. Creatures move by script at 40–105 wu/s with dashes.

How the clients dial is part of the model, and is what the page (M11 T13) must do (ADR 0063): the plan runs every 500 ms and at once when the directory answers or an offer comes in; P0 and P1 are dialled at once through the hub; the rest wait for the lower id to call (1.5 s), go through a peer when its gossip placed the target, else through the hub one at a time; a P4 is dialled only on a fix under 5 s old; an offer carries the caller's class, and `admit` judges by it; a refusal is an answer, and backs off a P3 or P4 (5 s, doubling, to 60 s).

## Gates

1. **The cap**: never more than 32 links, nor more than 24 while P0 + P1 ≤ 24.
2. **No hidden interactable creature**: every pair within 8 × the larger radius that can link is linked with its hello done, unless a side is crowded (or has 24 or more P1 within reach) or the pair has been within P1 reach under 10 s.
3. **Seamless handoffs**: no link closes to a creature in view while the two stay within each other's AoI; every remote that comes into view at a closing speed of at most 100 wu/s has been linked for 0.5 s (not asserted in the two dense scenarios, `crowd` and `witnesses`: M12).
4. **Friends** (spawn ring): linked within 3 s at the median and 5 s at the p95.
5. **Budget**: at most 6 incoming authority messages per player-minute (median) and 12 (p95) after a creature's first minute, at most 48 (p95) in it; in `sparse` and `streams`, at least 70% of the links made after the first minute through a peer relay. Not asserted in the dense scenarios.
6. **Gossip** costs at most 0.3 KB/s per link.
7. **Tiers**: no link between creatures two tiers apart outside P0 (for more than 4 s); every giant's swarm holds each smaller creature in its AoI that reported in the last 30 s, up to 64.
8. **Witnesses**: every duty link is taken within 10 s and held to the fight's end, with P0 + P1 ≤ 28, and the cap holds.

## Scenarios

### friends

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 violations |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | median 2.30 s, p95 4.00 s over 150 pairs |
| 5. Budget: authority messages and relayed links | pass | median 0, p95 0 per player-minute after the first, 0 (p95) in the first; relay share n/a |
| 6. Gossip within 0.3 KB/s per link | pass | 0.030 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 10, 6, 40 |
| Links per client (mean, p95, most held at once) | 4.6, 5, 5 |
| Discovery latency (p50, p95) | 0.40 s, 0.70 s |
| Authority messages per player-minute (median, p95; first minute p95) | n/a (under 2 minutes), 0 |
| Links made after the first minute set up through a peer relay | n/a |
| Gossip per link | 0.030 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |

### sparse

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 violations |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 2, p95 4 per player-minute after the first, 39 (p95) in the first; 99% of 4173 later links relayed |
| 6. Gossip within 0.3 KB/s per link | pass | 0.106 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 3, 200, 150 |
| Links per client (mean, p95, most held at once) | 18.2, 24, 24 |
| Discovery latency (p50, p95) | 0.20 s, 0.70 s |
| Authority messages per player-minute (median, p95; first minute p95) | 2, 4; 39 |
| Links made after the first minute set up through a peer relay | 99% of 4173 |
| Gossip per link | 0.106 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |

### crowd

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 violations |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 0, p95 0 per player-minute after the first, 0 (p95) in the first; relay share n/a |
| 6. Gossip within 0.3 KB/s per link | pass | 0.107 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 3, 40, 60 |
| Links per client (mean, p95, most held at once) | 15.1, 21, 24 |
| Discovery latency (p50, p95) | 0.40 s, 2.50 s |
| Authority messages per player-minute (median, p95; first minute p95) | n/a (under 2 minutes), 0 |
| Links made after the first minute set up through a peer relay | n/a |
| Gossip per link | 0.107 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |

### tiers

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 violations |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 0, p95 0 per player-minute after the first, 22 (p95) in the first; relay share n/a |
| 6. Gossip within 0.3 KB/s per link | pass | 0.084 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 3, 47, 90 |
| Links per client (mean, p95, most held at once) | 12.1, 20, 24 |
| Discovery latency (p50, p95) | 0.30 s, 0.80 s |
| Authority messages per player-minute (median, p95; first minute p95) | n/a (under 2 minutes), 22 |
| Links made after the first minute set up through a peer relay | 100% of 95 |
| Gossip per link | 0.084 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |

### streams

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 violations |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 2, p95 2 per player-minute after the first, 30 (p95) in the first; 100% of 0 later links relayed |
| 6. Gossip within 0.3 KB/s per link | pass | 0.092 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 3, 24, 211 |
| Links per client (mean, p95, most held at once) | 14.9, 23, 23 |
| Discovery latency (p50, p95) | 0.40 s, 0.70 s |
| Authority messages per player-minute (median, p95; first minute p95) | 2, 2; 30 |
| Links made after the first minute set up through a peer relay | n/a |
| Gossip per link | 0.092 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |

### traveller

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 violations |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 2, p95 4 per player-minute after the first, 27 (p95) in the first; relay share n/a |
| 6. Gossip within 0.3 KB/s per link | pass | 0.100 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 1, 101, 605 |
| Links per client (mean, p95, most held at once) | 17.6, 24, 24 |
| Discovery latency (p50, p95) | 0.00 s, 0.70 s |
| Authority messages per player-minute (median, p95; first minute p95) | 2, 4; 27 |
| Links made after the first minute set up through a peer relay | 99% of 2787 |
| Gossip per link | 0.100 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |

### witnesses

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 violations |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 0, p95 0 per player-minute after the first, 0 (p95) in the first; relay share n/a |
| 6. Gossip within 0.3 KB/s per link | pass | 0.106 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | 18 of 18 duty links taken in 10 s; 0 violations |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 3, 43, 60 |
| Links per client (mean, p95, most held at once) | 14.0, 21, 24 |
| Discovery latency (p50, p95) | 0.40 s, 2.40 s |
| Authority messages per player-minute (median, p95; first minute p95) | n/a (under 2 minutes), 0 |
| Links made after the first minute set up through a peer relay | n/a |
| Gossip per link | 0.106 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |

## Findings

- A hub-relayed signal carries the sender's directory position, up to 30 s old. A callee that judged the caller's class from it refused calls that were in range; `admit` judges by the class the offer carries.
- A giant's AoI (up to about 20,000 wu) is wider than a smaller neighbour's query radius, so the giant called creatures that had no class for it. A creature is now in the AoI of whichever of two creatures sees further (`AoiManager.classify`); refusals in `tiers` fell from 227 to 24.
- Directory positions are up to 30 s old, so a P4 dialled from one may be out of the callee's range: a P4 needs a fix under 5 s old.
- In a dense crowd (about 20 P1 each) a P1 pair that drifts past the hold and back within a few seconds can come into view before its link is up: about 3 in 1,000 entries. M12 (crowded instances) owns it.
- A relayed offer lost on a peer's closed link costs 4 s before the hub resend, more than a P1's 3 s lead, so P0 and P1 calls go through the hub.
