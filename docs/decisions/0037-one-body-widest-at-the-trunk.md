# 0037: One body, widest at the trunk

- Status: accepted (amends 0028 and 0031)
- Date: 2026-10-30

## Context

Playtest #183 (v0.7.0) and look pass 5 found long bodies reading as a big head with a short chain hung behind it. ADR 0028 drew the head in front of a chain at 0.65 to 1 of the v1 head, while the trunk was 0.8 core radii wide along the tagma profile and narrowed by head scale, so the head was usually the widest segment. ADR 0031 then slimmed the whole chain by that widest segment. References 02 and 05 show the opposite: a small head set into an oval trunk that is widest in its front half and narrows to the tail, copepods with an oval shell and a slim free tail, and worms that are long, slim and even.

The body bound (2.5 core radii) and the core collider (the unit circle) stay, so the sim, sizes and hazards do not move. Rules 7 (ADR 0035) lets development change.

## Decision

Under karyotype v2, a bilateral chain of 3 or more segments is one long body (`RULES.develop.chain.trunk`):

- **The trunk profile.** Along the chain behind the head (t from 0 to 1), the width rises by `rise` (0.25) to its peak at `at` (0.35), where trunk swell adds to it. It then drops by `drop` (0.15) plus the taper gene's share to the tail, and the tail loci narrow its rear. Each factor is concave or a triangle, so the profile has one peak and narrows behind it. The trunk is `width` (0.88) core radii wide along it and fits a reach of 2.2 (`reach`; 2.1 before), and head scale still narrows it by 1 ÷ (1 + 0.8·head scale).
- **Segment lengths.** Segments shorten only by the square root of their narrowing, so a tapering tail stays long instead of shrinking to a nub.
- **The head.** Its half-width is 0.6 to 0.86 (`head`) of the widest trunk segment. Head scale and symmetry raise it within that range. Its half-length is 0.7 (`headLength`) of its width times its stretch.
- **A fused chain.** Behind a carapace of 2 or more segments, the free segments narrow by one factor to at most 0.45 (`freeTail`) of the widest fused segment, so a copepod has an oval front and a slim tail.
- **A worm.** A chain of 5 or more segments with no carapace, curled by 0.35π or more but not coiled (`worm`), keeps only 0.3 (`even`) of the profile's swing and the head's range. It is slimmed to 4.2 times as long as wide. This is the one way a curl changes a body's width, amending ADR 0031's "a curl is only a pose". A coil keeps a trunk's width, so it reads as a spiral shell.
- **The silhouette classifier follows the geometry it reads.**
  - A tadpole is a chain whose front, up to its widest segment (the head of a two-segment chain), holds at least 65% of the drawn area (it was the head's 60%).
  - A worm needs 5 or more segments, and a curled chain of 4 is a short body (tadpole or other).
  - A fan tail is measured from half-way along the rear segment of a 3+ chain.
  - Winged needs webbing of 30% of the girth's area (it was 25%), since smaller heads made the girth smaller.

Two-segment chains, cells, radial bodies and karyotype v1 genomes keep their layout.

**Eyes and rims on the smaller head.** The eye range (0.08–0.3) was sized for heads near the core's width. On a trunk head a third as wide, the two eyes of the gallery copepod (26) overlapped and covered the head's front, and its rim, with dark lenses. With the slimmer tails and the coil's inner parts, the ring check of `m6-creature-mesh` (the rim is the brightest ring of every body) failed for specimens 26 and 39. So, for every v2 body:

- The pair never overlaps: an eye is no larger than keeps its centre its own radius from the midline, down to the range's floor (0.08).
- A stalkless eye lies wholly inside the head (`eyes.set` 1, from look pass 5's 0.75), so the head's rim runs round it, as in reference 05.
- In the mesh, a bristle that would reach into the body from either side of its part is not drawn. In the eye of a coil such bristles piled into a white cloud under the clear shell.
- The shader keeps the rim of the body and its plates at full strength over at least the outermost pixel. Before, the rim of a slim segment fell under a pixel and faded into the water.

## Consequences

- Over 10,000 random v2 genomes, 98% of long chains meet every outline rule: a head at most 0.9 of the trunk, an unfused chain widest 25–55% from the front, no segment behind the widest more than 1.05 times its front neighbour, and an aspect of at least 2.5. Over 99% of copepods, shrimps and worms (random, Lab wild and mutated) meet their class rules.
- Stats read the new outline through the girth (ADR 0031). Over random and Lab bodies with long chains, the median mass falls about 9%, and the median form speed before the band rises about 5%. The speed band (ADR 0036) absorbs most of the speed change. The archetype tests, the tournament rankings, the pacing report and the Lab's wild diversity (8+ classes in 9 of 10 seeds) all hold. Plan, stats and tournament goldens are regenerated: rules 7 is unreleased.
- A curled worm is slimmer than its straight twin. T6 (spirals and S-worms) builds on this.
- Small trunk heads with big-eye genes now carry smaller eyes, so they sense a little less and pay less eye metabolism. The balance checks hold, and the plan and stats goldens are regenerated again. On the gallery sheet, specimen 26's rings (rim first) go from 85, 78, 80, 105 to 113, 79, 81, 103, and specimen 39's from 105, 103, 105, 119 to 100, 89, 82, 94. The shell between the organs still stands about 30 levels above the water, against a limit of 31.5.
- Rejected:
  - keeping the head as the unit and only widening the trunk, because the head stays as wide as the trunk;
  - one aspect of 4 for every chain of 5 or more, because shrimps and copepods then read as threads;
  - keying the worm to few legs, because polychaete-like worms have parapodia, and legless chains are rare;
  - shortening the chain's reach to keep tail parts, because it moved the stats balance (the longer reach of 2.2 keeps the setose shrimp's bristles apart on the gallery sheet).
