# 0069: The pure parts at 10,000 members

- Status: accepted (amends 0064: where placement's rings start for a group wider than they reach; amends 0058: how a pool is drawn from many eligible ids)
- Date: 2026-11-08

## Context

M13 T3 holds the hub's pure parts to a world of 10,000 members (9,000 starters in one populated area): `place()` within 20 ms, `groupsFor` within 10 ms, 10,000 directory reports and `near` queries within 1.5 s, and `poolOf` within 10 ms. Three things broke that.

- ADR 0064 places on rings from the group's centroid. Its 8,192 candidates reach about 6,300 wu for starters, so a populated area grown past that (about 1,100 starters) fell back to the spawn centre.
- Every check of a candidate walked every member, and `groupsFor` scanned cells as wide as the chain.
- `poolOf` (ADR 0058) hashed every eligible id. SHA-256 costs about 4 µs here, so 10,000 ids took about 40 ms.

## Decision

**Placement.** The search stays as ADR 0064 has it: rings from the centroid. When it finds nothing and the group is wider than the rings reach (its radius plus 2 clearances beyond the reach), the rings start again 2 clearances inside the group's radius, at its edge, with the same candidate budget. A long ring there is tried at an even sample of about 48 of its candidates first, and whole only when the sample holds no valid point, so no valid point is missed. Past that the rings around the spawn centre and then the centre itself are used, as before. A placement that the centroid search found is unchanged. The avoid discs and the group's members are looked up through a hash grid (cells at least the widest avoid distance, or the widest P1 reach), the cheap rules (edges, discs) run before depth and plumes, and `groupsFor` links cells so small that one cell is one piece, joining cells within two cells of each other at the first pair within the chain.

**The directory.** `near` visits leaves nearest first and stops descending into a leaf farther than the farthest peer or swarm entry still wanted, keeping the 48 and the 64 nearest as it goes. Its answers are the same.

**The witness pool.** Among more than 1,024 eligible ids, `poolOf` keys only a window: the 1,024 ids that follow a point of the id order, wrapping round. The point is the first four bytes of SHA-256(`bs/pool-window/v1` ‖ event) as a fraction of the sorted, de-duplicated ids. The 16 lowest SHA-256(`bs/pool/v1` ‖ event ‖ id) of the window, sorted by id, are the pool. With 1,024 or fewer eligible ids the pool is as ADR 0058 drew it. The commitment, its checks and the verifier are untouched: a pool is still at most 16 ids, and no one holds the eligible list.

## Consequences

- A committed pool from before this change verifies as it did; the verifier never recomputes a pool.
- A player can't choose its window, and the event (the commitment's) decides it. Grinding an id to be in one event's window costs what grinding one for the 16 lowest did, per event.
- `docs/DESIGN.md` (§8, placement and witness duty) states both rules.
