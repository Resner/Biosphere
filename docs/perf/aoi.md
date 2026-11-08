# Area-of-interest report

Written by `npm run report:aoi` (`tools/aoi-report.ts`). Simulated clients each run their own `AoiManager`, `WhereReporter`, `Gossip` and `SignalRoute` against one `Directory` (`tests/aoi-harness.ts`), over a seeded link model: a hop between peers takes 30–80 ms, the hub 50–150 ms each way, ICE 0.5–2 s with 5% of attempts failing and being retried, and the hello a round trip. There are no sockets and no WebRTC. Creatures move by script at 40–105 wu/s with dashes.

How the clients dial is part of the model, and is what the page (M11 T13) must do (ADR 0063): the plan runs every 500 ms and at once when the directory answers or an offer comes in; P0 and P1 are dialled at once through the hub; the rest wait for the lower id to call (1.5 s), go through a peer when its gossip placed the target, else through the hub one at a time; a P4 is dialled only on a fix under 5 s old; an offer carries the caller's class, and `admit` judges by it; a refusal is an answer, and backs off a P3 or P4 (5 s, doubling, to 60 s).

## Gates

1. **The cap**: never more than 32 links, nor more than 24 while P0 + P1 ≤ 24.
2. **No hidden interactable creature**: every pair that shares water, within 8 × the larger radius, that can link is linked with its hello done, unless a side is crowded (or has 24 or more P1 within reach), changed instance in the last 10 s, or the pair has been within P1 reach (sharing water) under 10 s.
3. **Seamless handoffs**: no link closes to a creature in view while the two stay within each other's AoI; every remote that comes into view at a closing speed of at most 100 wu/s has been linked for 0.5 s. Pairs that stop sharing water are excused, and in the three dense scenarios (`crowd`, `witnesses`, `throng`) at most 15 late entries in 1,000 are allowed.
4. **Friends** (spawn ring): linked within 3 s at the median and 5 s at the p95.
5. **Budget**: at most 6 incoming authority messages per player-minute (median) and 12 (p95) after a creature's first minute, at most 48 (p95) in it; in `sparse` and `streams`, at least 70% of the links made after the first minute through a peer relay. Not asserted in the dense scenarios.
6. **Gossip** costs at most 0.3 KB/s per link.
7. **Tiers**: no link between creatures two tiers apart outside P0 (for more than 4 s); every giant's swarm holds each smaller creature in its AoI that reported in the last 30 s, up to 64.
8. **Witnesses**: every duty link is taken within 10 s and held to the fight's end, with P0 + P1 ≤ 28, and the cap holds.
9. **Bandwidth** (M11 T15): snapshots go at the rate each receiver asks (10 Hz for P0, P1 or within 1.15 × its view's half-diagonal, 5 Hz in its AoI, 2 Hz for P3, 1 Hz for P4), an engage candidate's signed frame every 200 ms, plus gossip, each frame counted on the wire with 93 bytes of IPv4, UDP, DTLS and SCTP. A client's upload at 24 links is at most 12 KB/s, and one link's at most 4 KB/s. The upload is not asserted in the dense scenarios, where every link is P1 and at 10 Hz by rule.
10. **Crowds** (M12 T8, ADR 0064): clients run the page's crowd rules against the hub's `Crowds` (`worker/crowds.ts`): a client whose wanted P0 + P1 that share its water reach 24 sends its crowd list in its `where`; the hub tells each member whose instance changed (after the hub's latency); a link that no longer shares water closes at once unless it is a duty link; each client keeps the freshest word of every creature's instance; a page asks the directory again when its own instance changes. After a client's first 10 s at most 1% of client-seconds are crowded (P0 + P1 past 32), at most 1 instance change per client-minute at the 95th percentile (the first instance a client joins is its entry, not a change), and a fight's fighters, picked as an engage picks them (the nearest comparable creature that shares water), share water and keep their instance for the whole fight. Judged only when instances are on.
11. **Spawns** (M12 T8): clients that enter the water by `place()` over the directory's positions keep the clearance from every engage-capable member (tier gap within the rules' limit) by those positions, except a placement that falls back to the spawn centre; and the friends of the `friends` scenario, placed so, are linked within 3 s (median) and 5 s (p95). A ride (a client alone 120 s that the directory names no one for, the hub places around the best group) is a placement too; it is switched on per scenario, and no scenario here rides.

## Scenarios

### friends

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature that shares water | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 violations |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | median 2.30 s, p95 3.80 s over 150 pairs |
| 5. Budget: authority messages and relayed links | pass | median 0, p95 0 per player-minute after the first, 0 (p95) in the first; relay share n/a |
| 6. Gossip within 0.3 KB/s per link | pass | 0.032 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |
| 9. Bandwidth: upload at 24 links within 12 KB/s, each link within 4 KB/s | pass | never 24 links; one link 1.6 KB/s at most |
| 10. Crowds: at most 1% of client-seconds crowded after a client's first 10 s, 1 instance change a client-minute (p95), fights keep their water | pass | 0.00% crowded, 0.00 changes a client-minute (p95), 0 fight-water violations |
| 11. Spawns: every placed spawn keeps its clearance; a placed friend is linked within 3 s (median), 5 s (p95) | pass | 60 placed (0 at the centre), 0 clearance violations; friends median 2.30 s, p95 3.80 s |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 10, 6, 40 |
| Links per client (mean, p95, most held at once) | 4.6, 5, 5 |
| Discovery latency (p50, p95) | 0.40 s, 0.70 s |
| Authority messages per player-minute (median, p95; first minute p95) | n/a (under 2 minutes), 0 |
| Links made after the first minute set up through a peer relay | n/a |
| Gossip per link | 0.032 KB/s |
| Upload on the wire at 24 links (most, mean); on one link at most | n/a; 1.57 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |
| Time crowded after a client's first 10 s; instance changes per client-minute (p95) | 0.00%; 0.00 |
| Placed spawns and rides (at the centre) | 60 and 0 (0) |

### sparse

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature that shares water | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 violations |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 2, p95 4 per player-minute after the first, 39 (p95) in the first; 99% of 4173 later links relayed |
| 6. Gossip within 0.3 KB/s per link | pass | 0.114 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |
| 9. Bandwidth: upload at 24 links within 12 KB/s, each link within 4 KB/s | pass | at 24 links 10.7 KB/s at most, 6.2 KB/s on average; one link 1.7 KB/s at most |
| 10. Crowds: at most 1% of client-seconds crowded after a client's first 10 s, 1 instance change a client-minute (p95), fights keep their water | pass | 0.00% crowded, 0.00 changes a client-minute (p95), 0 fight-water violations |
| 11. Spawns: every placed spawn keeps its clearance; a placed friend is linked within 3 s (median), 5 s (p95) | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 3, 200, 150 |
| Links per client (mean, p95, most held at once) | 18.2, 24, 24 |
| Discovery latency (p50, p95) | 0.20 s, 0.70 s |
| Authority messages per player-minute (median, p95; first minute p95) | 2, 4; 39 |
| Links made after the first minute set up through a peer relay | 99% of 4173 |
| Gossip per link | 0.114 KB/s |
| Upload on the wire at 24 links (most, mean); on one link at most | 10.7 KB/s, 6.2 KB/s; 1.65 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |
| Time crowded after a client's first 10 s; instance changes per client-minute (p95) | 0.00%; 0.00 |

### crowd

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature that shares water | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 pops, 8 late entries in 718 (at most 15 in 1,000): report0: t=30.1s c37 came into c17's view unlinked (closing 44 wu/s, instances 0 and 0, P0+P1 20); report0: t=44.2s c18 came into c15's view unlinked (closing 53 wu/s, instances 0 and 0, P0+P1 11); report1: t=31.0s c22 came into c27's view unlinked (closing 84 wu/s, instances 0 and 0, P0+P1 12) |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 0, p95 0 per player-minute after the first, 0 (p95) in the first; relay share n/a |
| 6. Gossip within 0.3 KB/s per link | pass | 0.115 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |
| 9. Bandwidth: upload at 24 links within 12 KB/s, each link within 4 KB/s | pass | at 24 links 27.8 KB/s at most, 20.9 KB/s on average (not asserted); one link 1.7 KB/s at most |
| 10. Crowds: at most 1% of client-seconds crowded after a client's first 10 s, 1 instance change a client-minute (p95), fights keep their water | pass | 0.00% crowded, 0.00 changes a client-minute (p95), 0 fight-water violations |
| 11. Spawns: every placed spawn keeps its clearance; a placed friend is linked within 3 s (median), 5 s (p95) | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 3, 40, 60 |
| Links per client (mean, p95, most held at once) | 15.1, 21, 24 |
| Discovery latency (p50, p95) | 0.40 s, 2.50 s |
| Authority messages per player-minute (median, p95; first minute p95) | n/a (under 2 minutes), 0 |
| Links made after the first minute set up through a peer relay | n/a |
| Gossip per link | 0.115 KB/s |
| Upload on the wire at 24 links (most, mean); on one link at most | 27.8 KB/s, 20.9 KB/s; 1.65 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |
| Time crowded after a client's first 10 s; instance changes per client-minute (p95) | 0.00%; 0.00 |

### tiers

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature that shares water | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 violations |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 0, p95 0 per player-minute after the first, 22 (p95) in the first; relay share n/a |
| 6. Gossip within 0.3 KB/s per link | pass | 0.089 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |
| 9. Bandwidth: upload at 24 links within 12 KB/s, each link within 4 KB/s | pass | at 24 links 9.1 KB/s at most, 6.0 KB/s on average; one link 1.6 KB/s at most |
| 10. Crowds: at most 1% of client-seconds crowded after a client's first 10 s, 1 instance change a client-minute (p95), fights keep their water | pass | 0.00% crowded, 0.00 changes a client-minute (p95), 0 fight-water violations |
| 11. Spawns: every placed spawn keeps its clearance; a placed friend is linked within 3 s (median), 5 s (p95) | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 3, 47, 90 |
| Links per client (mean, p95, most held at once) | 12.1, 20, 24 |
| Discovery latency (p50, p95) | 0.30 s, 0.80 s |
| Authority messages per player-minute (median, p95; first minute p95) | n/a (under 2 minutes), 22 |
| Links made after the first minute set up through a peer relay | 100% of 95 |
| Gossip per link | 0.089 KB/s |
| Upload on the wire at 24 links (most, mean); on one link at most | 9.1 KB/s, 6.0 KB/s; 1.63 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |
| Time crowded after a client's first 10 s; instance changes per client-minute (p95) | 0.00%; 0.00 |

### streams

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature that shares water | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 violations |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 2, p95 2 per player-minute after the first, 30 (p95) in the first; 100% of 0 later links relayed |
| 6. Gossip within 0.3 KB/s per link | pass | 0.099 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |
| 9. Bandwidth: upload at 24 links within 12 KB/s, each link within 4 KB/s | pass | never 24 links; one link 1.6 KB/s at most |
| 10. Crowds: at most 1% of client-seconds crowded after a client's first 10 s, 1 instance change a client-minute (p95), fights keep their water | pass | 0.00% crowded, 0.00 changes a client-minute (p95), 0 fight-water violations |
| 11. Spawns: every placed spawn keeps its clearance; a placed friend is linked within 3 s (median), 5 s (p95) | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 3, 24, 211 |
| Links per client (mean, p95, most held at once) | 14.9, 23, 23 |
| Discovery latency (p50, p95) | 0.40 s, 0.70 s |
| Authority messages per player-minute (median, p95; first minute p95) | 2, 2; 30 |
| Links made after the first minute set up through a peer relay | n/a |
| Gossip per link | 0.099 KB/s |
| Upload on the wire at 24 links (most, mean); on one link at most | n/a; 1.64 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |
| Time crowded after a client's first 10 s; instance changes per client-minute (p95) | 0.00%; 0.00 |

### traveller

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature that shares water | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 violations |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 2, p95 4 per player-minute after the first, 27 (p95) in the first; relay share n/a |
| 6. Gossip within 0.3 KB/s per link | pass | 0.108 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |
| 9. Bandwidth: upload at 24 links within 12 KB/s, each link within 4 KB/s | pass | at 24 links 10.2 KB/s at most, 6.1 KB/s on average; one link 1.6 KB/s at most |
| 10. Crowds: at most 1% of client-seconds crowded after a client's first 10 s, 1 instance change a client-minute (p95), fights keep their water | pass | 0.00% crowded, 0.00 changes a client-minute (p95), 0 fight-water violations |
| 11. Spawns: every placed spawn keeps its clearance; a placed friend is linked within 3 s (median), 5 s (p95) | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 1, 101, 605 |
| Links per client (mean, p95, most held at once) | 17.6, 24, 24 |
| Discovery latency (p50, p95) | 0.00 s, 0.70 s |
| Authority messages per player-minute (median, p95; first minute p95) | 2, 4; 27 |
| Links made after the first minute set up through a peer relay | 99% of 2787 |
| Gossip per link | 0.108 KB/s |
| Upload on the wire at 24 links (most, mean); on one link at most | 10.2 KB/s, 6.1 KB/s; 1.65 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |
| Time crowded after a client's first 10 s; instance changes per client-minute (p95) | 0.00%; 0.00 |

### witnesses

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature that shares water | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 pops, 11 late entries in 827 (at most 15 in 1,000): report0: t=27.6s c6 came into c9's view unlinked (closing 72 wu/s, instances 0 and 0, P0+P1 18); report0: t=53.8s c24 came into c13's view unlinked (closing 90 wu/s, instances 0 and 0, P0+P1 14); report1: t=28.9s c26 came into c11's view unlinked (closing 97 wu/s, instances 0 and 0, P0+P1 10) |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 0, p95 0 per player-minute after the first, 0 (p95) in the first; relay share n/a |
| 6. Gossip within 0.3 KB/s per link | pass | 0.113 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | 18 of 18 duty links taken in 10 s; 0 violations |
| 9. Bandwidth: upload at 24 links within 12 KB/s, each link within 4 KB/s | pass | at 24 links 29.8 KB/s at most, 24.4 KB/s on average (not asserted); one link 1.7 KB/s at most |
| 10. Crowds: at most 1% of client-seconds crowded after a client's first 10 s, 1 instance change a client-minute (p95), fights keep their water | pass | 0.00% crowded, 0.00 changes a client-minute (p95), 0 fight-water violations |
| 11. Spawns: every placed spawn keeps its clearance; a placed friend is linked within 3 s (median), 5 s (p95) | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 3, 43, 60 |
| Links per client (mean, p95, most held at once) | 13.9, 21, 24 |
| Discovery latency (p50, p95) | 0.40 s, 2.40 s |
| Authority messages per player-minute (median, p95; first minute p95) | n/a (under 2 minutes), 0 |
| Links made after the first minute set up through a peer relay | n/a |
| Gossip per link | 0.113 KB/s |
| Upload on the wire at 24 links (most, mean); on one link at most | 29.8 KB/s, 24.4 KB/s; 1.65 KB/s |
| Time crowded (P0 + P1 past 32) | 0.0% |
| Time crowded after a client's first 10 s; instance changes per client-minute (p95) | 0.00%; 0.00 |

### throng

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature that shares water | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 pops, 0 late entries in 15 (at most 15 in 1,000) |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 0, p95 0 per player-minute after the first, 691 (p95) in the first; relay share n/a |
| 6. Gossip within 0.3 KB/s per link | pass | 0.100 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |
| 9. Bandwidth: upload at 24 links within 12 KB/s, each link within 4 KB/s | pass | at 24 links 33.9 KB/s at most, 32.7 KB/s on average (not asserted); one link 1.6 KB/s at most |
| 10. Crowds: at most 1% of client-seconds crowded after a client's first 10 s, 1 instance change a client-minute (p95), fights keep their water | pass | 0.42% crowded, 0.70 changes a client-minute (p95), 0 fight-water violations |
| 11. Spawns: every placed spawn keeps its clearance; a placed friend is linked within 3 s (median), 5 s (p95) | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 3, 80, 90 |
| Links per client (mean, p95, most held at once) | 13.7, 15, 32 |
| Discovery latency (p50, p95) | 0.40 s, 2.80 s |
| Authority messages per player-minute (median, p95; first minute p95) | n/a (under 2 minutes), 691 |
| Links made after the first minute set up through a peer relay | n/a |
| Gossip per link | 0.100 KB/s |
| Upload on the wire at 24 links (most, mean); on one link at most | 33.9 KB/s, 32.7 KB/s; 1.64 KB/s |
| Time crowded (P0 + P1 past 32) | 3.6% |
| Time crowded after a client's first 10 s; instance changes per client-minute (p95) | 0.42%; 0.70 |

### throng without instances (comparison)

| Gate | Result | Detail |
|---|---|---|
| 1. The cap holds | pass | 0 violations |
| 2. No hidden interactable creature that shares water | pass | 0 violations |
| 3. Seamless handoffs: no pops, newcomers linked 0.5 s ahead | pass | 0 pops, 0 late entries in 0 (at most 15 in 1,000) |
| 4. Friends linked within 3 s (median), 5 s (p95) | pass | n/a |
| 5. Budget: authority messages and relayed links | pass | median 0, p95 0 per player-minute after the first, 2870 (p95) in the first; relay share n/a |
| 6. Gossip within 0.3 KB/s per link | pass | 0.122 KB/s |
| 7. Tiers: no link two tiers apart, every swarm complete | pass | 0 violations |
| 8. Witness duties taken within the cap | pass | n/a |
| 9. Bandwidth: upload at 24 links within 12 KB/s, each link within 4 KB/s | pass | at 24 links 34.8 KB/s at most, 33.4 KB/s on average (not asserted); one link 1.7 KB/s at most |
| 10. Crowds: at most 1% of client-seconds crowded after a client's first 10 s, 1 instance change a client-minute (p95), fights keep their water | pass | n/a: instances off (100.0% crowded) |
| 11. Spawns: every placed spawn keeps its clearance; a placed friend is linked within 3 s (median), 5 s (p95) | pass | n/a |

| Metric | Value |
|---|---|
| Runs, clients, simulated seconds | 1, 80, 90 |
| Links per client (mean, p95, most held at once) | 11.2, 19, 32 |
| Discovery latency (p50, p95) | 0.50 s, 24.00 s |
| Authority messages per player-minute (median, p95; first minute p95) | n/a (under 2 minutes), 2870 |
| Links made after the first minute set up through a peer relay | 0% of 2618 |
| Gossip per link | 0.122 KB/s |
| Upload on the wire at 24 links (most, mean); on one link at most | 34.8 KB/s, 33.4 KB/s; 1.66 KB/s |
| Time crowded (P0 + P1 past 32) | 96.7% |

## Findings

- Crowd instances (M12 T8): `throng` (80 comparable starters hatching within 5 s in a room 1,500 wu wide) is crowded all of the time after the first 10 s without instances and 0.4% of it with them. The first split forms 3 instances of about 27 from the members within the first reporter's P1 reach; the rest join the least-full, and the next crowded report (10 s later at the earliest) re-bins them into 5 of 16, so half the members change instance once more. Until the instances settle, a page still counts the creatures it knew in the open water as sharing its water: the directory's answer holds only the 48 nearest that share it, so a creature absent from it keeps its old word (instance 0, shared with everyone). A page asks the directory again after its own instance changes (`WhereReporter.refresh`), which brought the crowded share from about 4% to under 1%.

- A hub-relayed signal carries the sender's directory position, up to 30 s old. A callee that judged the caller's class from it refused calls that were in range; `admit` judges by the class the offer carries.
- A giant's AoI (up to about 20,000 wu) is wider than a smaller neighbour's query radius, so the giant called creatures that had no class for it. A creature is now in the AoI of whichever of two creatures sees further (`AoiManager.classify`); refusals in `tiers` fell from 227 to 24.
- Directory positions are up to 30 s old, so a P4 dialled from one may be out of the callee's range: a P4 needs a fix under 5 s old.
- In dense water (14 to 18 P1 each, under the crowd threshold) a P1 pair that drifts past the hold and back within a few seconds can come into view before its link is up: 7 to 10 in 1,000 entries, with or without instances. Gate 3 reads at most 15 in 1,000 there (ADR 0065).
- A relayed offer lost on a peer's closed link costs 4 s before the hub resend, more than a P1's 3 s lead, so P0 and P1 calls go through the hub.
- Most of a snapshot's cost on the wire is its carriage: 93 bytes of headers for 29 bytes of snapshot. At 10 Hz to all 24 links a client would upload about 29 KB/s; at the asked rates the open-world scenarios average about 6 KB/s at 24 links and peak near 10.5. In a dense crowd every link is P1 and asks 10 Hz, and most are engage candidates with signed frames, so 24 links cost 20 to 32 KB/s: M12's instances bound it.
