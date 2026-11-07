# 0061: One world: its size and fields, food by tier, and a fourth world renewal

- Status: accepted (amends 0013: the world's size and the ponds' end; amends 0016: one world clock, and claims and the consumed set among linked peers; applies 0040 again: rules 12 renews the world as epoch 4)
- Date: 2026-11-07

## Context

ADR 0013 promised one continuous water world, split into ponds of 24 only until M11. The world today is an 8,192 wu square per pond, and its fields assume that size:

- **Bathymetry** (`src/sim/bathymetry.ts`) is calibrated on a 48 × 48 lattice of the whole pond, with a slope of 0.0001 depth per wu towards one side. Across a much larger square that slope alone would put half the world in the abyss.
- **The food grid** keeps a dense memo of every slot's kind (`kindOf` in `src/sim/food.ts`): 10,240 slots in a pond, 10 million in a world 32 times as wide.
- **The spawn search** (`findClearSpot`) may walk rings out to the world's edge.
- **Snapshots** carry positions as u16 in 0.125 wu steps: 8,192 wu at most.
- **The renderer** colours the water from one 256 × 256 depth map of the whole pond. GPU positions are float32, which at 131,072 wu resolve 0.016 wu, about a fifth of a pixel for a starter.
- **Encounters** replay in a world of the rules' size with the pond's seed.

Bodies already span four tiers: genesis bodies are 300–900 biomass (T0), and the body limit of 2,457,600 is a radius of 1,568 (T3). Tiny items are noise to a giant, as `docs/DESIGN.md` §2 says. A creature's top speed is the same at every size (ADR 0036), so its mouth sweeps area in proportion to its radius. Its movement cost grows with its biomass (radius squared), and its basal cost with biomass^0.75. Food sized and spaced for a starter cannot feed a giant.

The owner allowed world renewals before v1.0 (ADR 0040), and the creature card says that lineages last only from v1.0. Playtests v0.10.0 (#379) and v0.11.0 (#418) have no replies.

## Decision

**One world of 262,144 × 262,144 wu** (2^18, `RULES.world.size`), with one seed, one tick epoch and its centre at (131,072, 131,072). The size is a property of the world: the hub's welcome names it, and encounters replay at it.
- A T3 adult sees about 13,500 × 24,000 wu, so even the largest body sees less than a tenth of the world's side.
- The world has the area of 1,024 of today's ponds.
- The soft walls stay at its edges.

**Its fields stay pure functions of the seed and a position.** Nothing about them is stored or networked.
- **Bathymetry**: the three octaves stay, and a fourth, broad octave (wavelength 16,384 wu, weight 1) replaces the global slope. It slopes a pond-sized area the way the tilt did, and it alternates shallow and deep regions across the world.
  - The field is calibrated on a 128 × 128 lattice of the whole world (once per seed and size, cached), so the zone shares stay those of `docs/DESIGN.md` §2.
  - The disc of 1,400 wu around the world centre stays twilight, with the nearest shallows and deep within 2,200 wu of it.
  - `depthAt` takes the world's size, so tests can still build an 8,192 wu world with the same rules.
- **Caches are chunked.** A memo that grew with the world's area is kept per chunk of 16 × 16 food cells, at most 256 chunks, the least recently used dropped first. Memory stays bounded however far a creature swims, and a dropped chunk is recomputed bit for bit.
- **Searches are bounded.** The clear-spot search looks within 4,096 wu and keeps the original point beyond that, as it does when no spot is clear.

**Food by tier.** Each tier k has its own food layer: the same three kinds on a grid of 256 × 4^k wu cells with 10 slots each, every item 4^k times as wide and 64^k times as rich.
- Layer 0 is today's food.
- A creature of tier t eats from layers t and t − 1, so growing past a tier edge never empties the water around it.
- An item of layer k ≥ 1 has the id `t<k>c<x>_<y>_s<slot>_k<cycle>`. Layer 0 keeps `c<x>_<y>_s<slot>_k<cycle>`, so claims, the consumed set and the claim rules of ADR 0016 work per layer unchanged.
- Carrion stays one kind for every tier.
- 64^k matches intake to the movement cost: a mouth sweeps radius × speed, the items per area fall 16× per tier, so intake rises 4^k × 64^k ÷ 16^k = 16^k, as the biomass does.
- The pacing tool (`npm run sim:pacing -- --tiers`) gates it: a bot at the bottom of tiers 1 to 3 grows by half within 0.5–2× the time a T0 bot takes. The task that builds it may change the multiplier or the slots per cell, and records the values in `docs/DESIGN.md`.

**Spawning stays simple** until M12: the hub's ring around the world centre, slot i at angle i × 2.399963 and radius 300 + 40 × i, over every seated session instead of one pond's 24. M12 brings rings around groups, scoring and anti-camping.

**Positions on the wire** are u32 in 0.125 wu steps (snapshot version 5, 29 bytes), which covers 2^29 wu. **The renderer** draws relative to an origin snapped near the camera, so GPU positions stay small. Each depth map covers a window around the camera that refills as it moves.

**A fourth world renewal** (ADR 0040), at v0.12.0:
- rules 12 (the registry's only live version, epoch 4), protocol 11;
- a migration in the manner of migrations 6 and 8: every creature, record, commitment, mating, fight log and away report deleted, every hatch bucket refilled, every pond row deleted;
- kept: identities, keys, names, flags, beacons and attestations;
- the `world` row gains the world's seed and tick epoch;
- each returning identity told once: "The world was renewed in v0.12.0. Your identity is kept; your creatures start again."

Encounters depend on the world's size and bathymetry, so a fight under rules 11 would no longer replay under rules 12. Keeping the rules 11 field code alive for a week of history is not worth it before v1.0.

## Consequences

- The world is one continuous place at every population. Ponds remain only as the hub's interim roster groups, until M11's area of interest replaces them.
- A giant has food at its own scale, and the scale shows on screen: a T3 view holds about as many items of its layer as a starter's view holds of its own.
- Players lose their creatures a fourth time. The release notes and the Playtest issue say so.
- The fields cost a little more: a calibration of 16,384 samples per seed (about 20 ms, once), and a chunk recomputed when a creature comes back to it.
- Rejected:
  - an unbounded or wrapping world (wrapping breaks the quadtree's root, distances and the walls);
  - tiling copies of the pond field (seams, and the same layout every 8 km);
  - a separate world per tier (the brief keeps tiers apart from space, and comparable creatures across adjacent tiers must meet);
  - keeping rules 11 alive for its fights (ADR 0040: no frozen versions before v1.0);
  - one food layer with denser items for everybody (a starter's water would fill with items it cannot use, and a giant's view with dots).
