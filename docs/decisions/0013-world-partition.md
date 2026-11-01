# 0013: World partition: size tiers, area of interest, habitats

- Status: accepted (the viewport's half-height follows 0029, not `9·r^0.9`)
- Date: 2026-10-25

## Context

Creatures start small and grow over lifetimes and generations, and the viewport grows with them, as in Agar.io. Giants mainly interact with other large organisms. The brief asks for:

- a quadtree-like hierarchy with area of interest (AoI), capping connections at 16–32 per browser including boundary neighbours, witnesses and handoffs;
- biological size tiers separate from spatial subdivision;
- crowded areas subdivided, with bounded local instances;
- sparse players consolidated without breaking encounters;
- spawning in a ring around groups, outside attack range, with the first player setting the spawn centre;
- transitions that preserve one active state and can't escape combat;
- never hiding an opponent who can still affect the player.

## Decision

**One continuous water world** (`docs/DESIGN.md`). The depth field and the food and hazard fields are deterministic functions of the world seed. Before M11 the world is split into separate **ponds** of up to 24 players; from M11 it is one large plane.

**Size tiers** from radius `r` in world units: T0 below 32, T1 below 128, T2 below 512, T3 below 2,048, T4 from 2,048. Two creatures can interact (collide, court, engage) only if their tiers differ by at most 1. Viewport and AoI radius grow with `r` (`9·r^0.9` half-height). Creatures two or more tiers smaller are not networked individually; giants see them as ambient swarm particles.

**Spatial directory**:

- A quadtree in the authority, independent of tiers. A leaf splits above 16 members and merges below 6, with hysteresis and a minimum cell size.
- Clients report a cell change and, at most every 30 s, a coarse position. They query for candidate peers in their AoI within ±1 tier.
- The directory is advisory. Clients connect P2P, and signaling relays through peers.

**Connection priorities**:

| Class | Who | Can be evicted |
|-------|-----|----------------|
| P0 | encounter participants, referee and witness duties | never |
| P1 | creatures that can interact, nearest first | never |
| P2 | the rest of the AoI | yes |
| P3 | boundary neighbours just outside the AoI | yes |
| P4 | handoff pre-connects | yes |

The cap is 24, raised to at most 32 to keep P0 and P1. If P0 and P1 together would exceed 32, the area is crowded → instances.

**Instances**: a crowded leaf at minimum size gets bounded instances. Membership is sticky. Creatures that are interacting (in an encounter, courting, or within interaction range of each other) always share an instance. Players in different instances can't see or affect each other, so nothing that can affect a player is hidden.

**Regrouping and spawning**:

- The first player's spawn point becomes the spawn centre.
- Newcomers spawn on a ring around the most compatible group: same tier or ±1, outside the attack range of larger creatures, away from recent spawn points. The ring grows as the area fills.
- A player alone for more than 120 s may "ride the current" to a group. That never applies to a locked creature or one within interaction range of another.

**Transitions** (tier, cell, instance, regroup) never create or copy a creature state. The head stays the same (ADR 0009), and locked creatures can't move between habitats or instances.

## Consequences

- Connection count stays bounded, whatever the population or size spread. Correctness rests on two invariants checked by property tests and simulation (M11–M12): no hidden interactable creature, and the cap respected.
- The authority directory costs a little traffic per player-minute (budgeted in ADR 0008 and measured in M13).
- Rejected:
  - pure P2P gossip for discovery (slow convergence, Sybil-prone);
  - one global full mesh;
  - size tiers as the spatial index itself (the brief separates them);
  - static shards with no regrouping (empty worlds at low population).
