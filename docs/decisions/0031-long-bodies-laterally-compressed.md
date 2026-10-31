# 0031: Long bodies are laterally compressed, and long parts reach past the v1 range

- Status: accepted, amended by 0037 and 0038 (amends 0028: the trunk is no longer at least half a core radius wide, and a v2 part's length gene reaches past 1.5)
- Date: 2026-10-29

## Context

Look passes 1 to 3 (`docs/art/gallery/pass-3.md`) left every silhouette cell at 2 or 3: a v2 chain was at most about twice as long as wide, so copepods, shrimps and worms read as a ball with a tail next to references 02–05. Pass 3 tried a narrower chain (width 0.5–0.65, head 0.55–0.65) and reverted it: slimmer bodies are lighter, so they were faster and nimbler than every cell archetype, out-turned their radial twins, and the Lab's wild mode lost silhouette classes. The body bound (2.5 core radii) cannot grow (ADR 0028), so a long outline has to come from a narrower one. Pass 3 also found parts short: the length gene stops at 1.5 core radii, so no antenna sweeps round the body as in 02 and 05.

## Decision

- A bilateral karyotype v2 chain of 3 or more segments is at least `RULES.develop.chain.aspect` (2.5) times as long as wide, measured laid straight from the head's front to the tail's end against twice its widest half-width. A wider chain narrows, every segment by one factor, before it bends; the factor is the plan's `form.slim` (1 for every other body, and for every v1 genome). A curl is a pose: it never changes the width.
- The narrowing is lateral compression, not thinning: the body is 1 ÷ `slim` as deep as it is drawn wide. Stats read a slimmed segment's girth (half-width ÷ `slim`) for mass, inertia, plates, the frontal width and the rear taper, and take the outline's length as drawn. The silhouette classifier weighs webs and the head against the girth's area. So the balance of rules 6 holds without re-tuning `RULES.stats`: the archetype metrics, the tournament rankings and the pacing report are those of the unslimmed bodies, up to the long parts below.
- Under karyotype v2 a part's length gene keeps the v1 range up to `RULES.develop.long.knee` (0.8) of its span and then reaches `long.max` (2.4) core radii at its top. A long part keeps as much of its reach past the v1 length as fits the bounds whole, sweeping round the body as ADR 0028 lets any part; a part that cannot keep even its v1 length is cut as before.

## Consequences

- Segmented specimens read long on the sheet and in play (look pass 4); the median trunk segment of the silhouette specimens is 0.38 core radii as drawn (ADR 0028's test asked for 0.5, which no 2.5-to-1 trunk inside the bounds can be) and 0.53 in girth.
- Rules 6 is unreleased, so its plan, stats and tournament goldens are regenerated. Living v1 creatures are untouched.
- Only the stats model the depth. Segment colliders and the mesh's depth follow the drawn half-width, so they narrow (the mesh draws the body flat, as before); colliders today only weigh toxin exposure, and M7's hit shapes must decide whether the girth counts.
- Rejected: re-tuning `RULES.stats` around lighter bodies (pass 3 found every archetype test moving at once, and a raised segment cost alone left the coiled body best at seven metrics); narrowing only the widest segments (it flattens the head and trunk profile that the tagma loci set); stretching parts for every gene (it moved every archetype, not only the long-antenna ones).
