# 0038: Curled chains fit the bounds along their curve, and a coil is a chambered spiral

- Status: accepted, amended by 0039 (amends 0031 and 0037)
- Date: 2026-10-31

## Context

Playtest #183 and #177 (option 2a) asked for real spirals and S-worms. ADR 0031 made a curl only a pose: a chain was laid out straight within the 2.2 reach, then bent. A bent chain therefore stayed as short as the straight one, and a coil was a few fat segments folded into a blob. The gallery coil (29, five segments) turned 1.4π and the spiral (39, four) 1.15π, and neither read as a spiral. An S of half the curve per arc never turned more than 0.4π per arc.

An ellipse cannot bend. With four or five segments, a turn of 2.5π leaves 110° to 150° between neighbours. Neighbours that turn that far cannot both overlap each other (`bodyViolations`) and keep clear of the next whorl. Eight segments over 2.5π turn about 64° per link, and then both rules hold.

## Decision

- **A C or an S fits the bounds along its curve.** After the bend, its segments and links grow by up to `curve.longer` (1.6), until the curled pose reaches as far as the straight chain did. It is slimmed by its length along the curve (ADR 0031's 2.5 aspect, or 4.2 for a worm). If a tight bend brings two segments that are not neighbours together, it is laterally compressed further until they clear. Its girth stays its straight twin's, so stats read a longer body of the same girth.
- **An S of 5 or more segments bends two opposite arcs** of `sArc` (1.25) × curve × π each, at most `sMax` (0.8) × π, so from curve 0.5 each arc turns at least 0.6π. The heading peaks on the middle segment, so the segments show both arcs whole. A shorter chain's S keeps half the curve per arc: it has too few links to draw two arcs.
- **A coil (curve above 0.8) of 3 or more segments is a chambered spiral** of `caps.segments` (8) segments, whatever its segment genes say.
  - It turns 2.5π just past 0.8 and 2.7π at 1. Every link turns alike and is `whorl` ^ (turn ÷ 2π) as long as the one in front (`whorl` is 0.38), so the chambers lie on a logarithmic spiral.
  - A chamber is `chamber` (0.85) of its links long, and as wide as keeps it clear of the whorl inside it (the trunk profile keeps half its swing). The head is a share of the widest chamber.
  - The coil reaches at most as far as a trunk (2.2). It is also at most `coiled` (1.4) times as long as the straight trunk the same genes lay out.
  - Parts spread over the chambers.
  - A chain of two segments only curls, by curve × π.
- **No self-overlap.** `bodyViolations` reports any two segments of a curled bilateral chain that are not neighbours and come within `gap` (0.1) of their summed radii, measured along the line between their centres. A radial body's chain is folded inside its round core, and a straight chain never folds, so neither is checked. The karyotype v1 layout nests its segments behind the big head.

## Consequences

- Every coil of 3 or more segments turns at least 2.5π, with links shrinking toward the inner end. Gallery 29 and 39 turn 2.57π and 2.54π. Every S of 5 or more segments past curve 0.5 bends two arcs of at least 0.6π. Over 10,000 random and 10,000 mutated genomes, no plan is invalid.
- The gallery's worm (28) has a curve mode below 0.5, so its genes bend it into a C. Specimen 40 is the S-worm feature specimen (`npm run specimens -- --features --feature s-worm`, ADR 0032).
- Curled chains are longer. A C bent by half a turn gains about 9% at the median, and an S whose arcs add up to a full turn about 7%. A coil is 1.4 times as long as its straight twin. At the median it is 12% heavier, 48% draggier and turns 1.27 times as fast. Plan and stats goldens are regenerated: rules 7 is unreleased.
- **The coil's length is capped (the spec's fallback).** At full reach a coil is about twice its straight twin and heavier, and it turns at about 0.85 of its straight twin's rate at the median (0.34 at the worst). That breaks M6 T7's property that a curl turns faster. At 1.4 times, every coil in the property test still out-turns its straight twin, as do 85% of random coils. The coiled archetype stays best at acceleration (at size 100) and at nothing else; it was best at acceleration and efficiency before. Coils are therefore smaller than trunks on screen (they reach about 1.5 core radii, against 2.2), which the look pass may revisit.
- The balance checks hold: the archetypes, the tournament, pacing (biomass doubling median 1.4 to 1.5 min), the Lab's wild diversity, the speed band and the mesh budgets.
- Coils of 1.25 turns read as a shell with an inner whorl on the sheet. Reference 05's nautilus has about two turns, which eight chambers cannot show without touching.
- Rejected:
  - lofting a smooth tube through four or five segments in the mesh: the plan's segments would no longer overlap their neighbours, and parts, colliders and stats would read ellipses the body no longer draws;
  - a turning bonus for a curl in `RULES.stats.v2`: full-size coils turn at half their straight twin's rate in the worst case, so the term would have to double steering;
  - a wider gap between whorls: with eight chambers no width cleared it.
