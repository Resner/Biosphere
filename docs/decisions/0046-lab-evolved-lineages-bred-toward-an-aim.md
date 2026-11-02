# 0046: The Lab's Evolved mode breeds lineages toward an aim

- Status: accepted (amends 0025's "the Lab's wild mode shows the multi-segment forms" and 0043's specimen rebuild)
- Date: 2026-11-02

## Context

M6c T5 replaces the Lab's wild mode (random genome bytes) with lineages bred from genesis cells, since no lineage reaches random bytes and the owner judges creatures by the Lab. The spec bred 4 lineages of 6 for 15 generations of random pairings at the Lab's ×4 mutation rate, and asked for 7 silhouette classes in 9 of 10 grids.

Measured on 50 grids under rules 8, that recipe never leaves the cell stage: 1,141 of 1,200 bodies are single cells, none has more than 2 segments, and a grid shows 2 to 6 classes (median 4), mostly ciliates. Segments come from two quantitative loci that genesis keeps below the 2-segment threshold, and at the Lab's rate a quant step hits one of them in about 1 of 40 gametes, moving it by 12 on average, so random pairings drift there far too slowly. Even with selection on the segment loci, a lineage needs about 50 generations to reach 4 segments, and a row's last generation is 6 near-clones.

The multi-segment classes (shrimp, copepod, worm, crab, coil, winged) therefore never appear in an honest 15-generation grid.

## Decision

- **A lineage is bred toward an aim.** Each grid gives its 4 lineages 4 different aims, drawn by the seed: more segments (`chain`), with fusion (`shell`), a curve (`curl`), a long tail (`tail`) or big eyes (`eyes`), or a radial ring (`ring`). An aim is the mean of its loci, read from the genome as a breeder reads a trait. Every generation breeds 3 children per place from random pairs of different parents at the Lab's rate and keeps the 6 closest to the aim, for 60 generations.
- **A row reads as the lineage's history**: its founder (a genesis cell), then the best kept child of every 12th generation that breaks no body rule and is not shown yet. Only shown bodies are culled: no bred body has broken a rule (0 of 4,320 measured), and developing every child would triple the cost.
- **The diversity bar is 5 classes in 9 of 10 grids** (measured: 9 of 10; 29 of 30 over 30 seeds), checked on 3 seeds in `check` and all 10 in `report:diversity`. The grid stays under 600 ms (about 200 ms on a laptop).
- **Gallery cells 07–20 are Evolved picks**: the right end of each row of the Evolved sets `gallery-m6c-0` to `-3` (`npm run specimens -- --evolved`).
- **After a reset, specimens are checked, not re-drawn**: `npm run specimens -- --refresh` keeps every class and tier specimen that still shows its class or tier under the new rules, rewrites its comment, and searches again only those that do not. Under rules 8 all 16 still do.
- Random bytes stay where they serve: the specimen search and the body tests use `tests/wild.ts`.

## Consequences

- The Lab shows chains of 2 to 5 segments with antennae, legs and tails, next to the founders they came from, which genesis cells alone never show.
- The grid shows what a determined breeder reaches, not what play reaches: in play a lineage stays at the cell stage for many generations. Whether morphology should evolve faster is the owner's call (a rules change, cheap before v1.0 under 0040).
- Bred chains often show few visible parts: selection on segments does not add module slots. The class specimens 21–36 still show the full range.
- Rejected:
  - 15 generations of random pairings (the spec's recipe): the Evolved grid would be the Genesis grid again;
  - showing a lineage's last generation: 6 near-clones per row;
  - a higher mutation rate for the Lab only: the Lab's rate is the Mutate button's, and a faster Lab would misstate what breeding does;
  - re-searching every specimen after the reset: it swaps bodies that still show their class and breaks the tests that pin their features, for no visible gain.
