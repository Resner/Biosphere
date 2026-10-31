# 0039: Thin legs that keep off the body, and bristles common

- Status: accepted (amends 0028, 0031 and 0038)
- Date: 2026-10-31

## Context

Playtest #183 asked for shrimps with "many thin, bristled legs". Under ADR 0028 a part's width came from its gene alone (0.04–0.4 core radii), so a slim trunk 0.4 wide carried legs as thick as itself: the median trunk leg of a random body of 3 or more segments was 0.22 wide, and gallery 26, 27, 37 and 38 had medians of 0.21–0.31. Parts that ADR 0028 swept toward the core to fit the bounds lay over the trunk, and parts rooted where neighbouring segments overlap began inside the body: 19% of parts had more than a quarter of their drawn centre line inside the body outline (pass 1's gap 8, the worm tangles). Only a third of genesis slots other than the whip carried bristles.

## Decision

- **Width follows the root.** Under karyotype v2 a part's width gene range is scaled so its top (0.4) is 0.5 of its root segment's drawn half-width (`RULES.develop.legs.width`), but no part is thinned below 0.08 (`legs.floor`, or its gene, or that top): thinning is for thick legs, and a hair-thin antenna broke into specks in the Lab (`m3-lab`'s one connected body). The legs are drawn, so a slimmed chain's legs follow the drawn width, not the girth that stats read (ADR 0031); the spec's "girth" could not meet its own gallery check (27's girth is 0.82). Ring parts scale with the core. A coil's parts scale with its straight twin's segments, because its chambers are only as wide as its whorls leave room for; a coil and its twin then carry the same legs, which M6 T7's curl comparisons need. The ciliary band keeps its 0.12, so the propulsion floor holds. Bristle length follows the gene's width, so a thin leg stays plumose.
- **Paddles stay paddles.** A thinned part with a paddle tip widens over its outer length back toward its gene width, by its paddle share, at most to twice its root's half-width (`Appendage.blade`). Stats read the mean width (`bladeWidth`) for its area, thrust and drag.
- **Off the body.** A bilateral part rooted inside a neighbouring segment slides round its own segment to the nearest free angle. A radial ring spreads its even angles over the core's free arc in front of a trailing chain, never closer than the 0.3 rad gap (`ringArc`, checked by `bodyViolations`). A fitted part with more than 0.2 of its centre line inside the segments' outline turns outward, the nearest direction in 0.2 rad steps, shortening as little as the bounds need; with none it keeps its own. The body outline is the union of the segment ellipses, which the loft fills; a carapace is a clear shell over it, and the legs of its fused segments show through.
- **Bristles common.** Rules 7 genesis bristles each present slot but the whip's with 70% chance (density at least 0.3–0.8, length 0.2–0.6), from its own `genesis-setae` stream. Rarity does not price setae.
- **Re-tuned balance** (`RULES.stats.v2`): a radial ring thrusts forward at 0.4 of its rearward share (0.7) and steers ×2.2 (×1.6), because a ring on the round core keeps its parts' width while its bilateral twin's thin; setae add up to 1.15 to the detection ring (1), because thin antennae are more slender and sense more.

## Consequences

- The median trunk leg of random bodies of 3+ segments is 0.080 core radii (0.219). Gallery 26, 27, 30, 37 and 38 have medians of 0.08, 0.11, 0.08, 0.08 and 0.10.
- Over 10,000 random v2 bodies 95.3% of parts keep at least three quarters of their drawn centre line off the body (81%). 80% of genesis slots other than the whip have a setae density of at least 0.3 (34%), and 90% of bred parts other than the whip carry 6 or more bristles (50%).
- Thinner legs weigh, thrust and drag less. The balance checks hold: each archetype is best and worst at something, the tournament, pacing (biomass doubling median 1.5 min), the Lab's wild diversity, the speed band, zero invalid bodies over 10,000 random and 10,000 mutated genomes, and the mesh budgets. Most coils still outweigh their straight twin (77% of random coils; 88% before), since their longer legs carry the difference.
- Development costs more: 0.13 ms against 0.10 at the median for development and stats on the same machine, within ADR 0030's 0.15. The off-body checks sample each part's centre line at 16 points without trigonometry of their own.
- Rejected:
  - capping the gene width at the segment's half-width without scaling the range: gallery 27 kept a median of 0.17;
  - no floor, or a floor of 0.04 to 0.07: the Lab's carapaced archetype drew its antennae as specks below 0.06, and below 0.08 the thinned legs left fewer than 70% of coils heavier than their straight twins (M6b T6's check);
  - scaling ring parts by the trailing chain segment their gene names: a bell's chain is folded tiny inside its core, so its tentacles became hairs and the ciliary band out-swam them;
  - treating a coil's narrowed chambers as laterally compressed in stats: it held the coils' weight but made them turn slower than their straight twins (M6 T7).
