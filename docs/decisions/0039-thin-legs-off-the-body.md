# 0039: Thin legs that keep off the body

- Status: accepted (amends 0028, 0031 and 0038)
- Date: 2026-10-31

## Context

Playtest #183 and look pass 1's gap 8 found long bodies tangled in their own legs. Three causes:

- A part's base width came from its gene alone (0.04 to 0.4 core radii), so a slim trunk carried legs as thick as its own half-width. Over random v2 bodies of 3 or more segments the median trunk leg was 0.22 core radii wide.
- ADR 0028 fits a part that would leave the bounds by sweeping it toward the core, along the body. Segments overlap their neighbours, so roots near the front or rear of a segment start under the next one. Over 10,000 random v2 bodies, 35% of parts had more than a quarter of their centre line inside the body outline.
- Rarity does not price setae, yet only the ciliate, spiny-larva and bell forms of genesis carried them, so bred legs were mostly bare.

The spec asked for legs at most 0.5 of their segment's girth half-width. A slimmed chain keeps its girth (ADR 0031), so on gallery shrimp 27 the girth allowed legs of 0.215 and the legs stayed as thick as before. Thinning by the drawn width also moved the stats a long way. The coiled archetype's paddles on its inner chambers lost 11 times their thrust, the radial archetype lost its turning niche, and the curl and ring twin comparisons compared different parts.

## Decision

Under karyotype v2, and so from rules 7 (ADR 0035):

- **Thin legs.**
  - A part's drawn width scales with its root segment's drawn half-width: the gene's range scales down by min(1, `part.root` (0.5) × half-width ÷ 0.4). Where the segment has room, it is no thinner than `part.floor` (0.07) or its gene. Thinner legs broke into separate dots in the Lab's small cells. A part is never wider than half its segment's half-width, and a cell or a ring on the core keeps its gene's width.
  - The default ciliary band is at most that wide.
  - A part keeps its gene's width as `girth`. Like a slimmed chain, it is drawn edge-on: the water meets its girth. Thrust, drag, mass, inertia, slenderness, a chela's mass, bristle length and the bulb's radius all read the girth. Thinning is a look, and the balance does not move with it.
  - The mesh draws a bulb thinned with its part.
  - A paddle tip widens toward its blade, up to 2.5 times its base radius at the tip and untapered (`partRadius`), so a thin leg still ends in a broad paddle.
- **Off the body.** The body outline is the segment loft. A carapace is a thin glass shell over its segments, and parts leave the body from under it, as the gallery hook's `outline` already measures.
  - **Uncover.** Before parts are spread round a segment, a root that another segment covers slides round its own segment, 0.1 rad at a time, to the nearest attach angle where the body shows on both sides and no other part of the segment sits.
  - **Keep off.** After the bounds fit, a part with more than 0.2 of its centre line inside the outline turns, 0.15 rad at a time either way, up to 1.5 rad. It turns away from the body first. It never turns ahead of the ring's previous part, never past the tail, and a tail part growing rearward turns no further forward than sideways. The centre line is the arc without webbing, at 12 samples. The least turn that clears it whole wins, then the least that clears it shortened to fit the bounds. If none clears, the part takes the whole turn that buries least.
  - **Coils.** A coil's parts root along its outer 5 chambers (`curve.outer`), clear of the whorls inside. Before, a part from the coil's eye crossed every whorl.
  - **Radial bodies.** A radial body keeps its whole chain inside its round core at every symmetry from 0.5. Before, the chain hung out behind the core from 0.5 to nearly 1 and covered the rear ring's roots.
- **Bristles common.** Rules 7 genesis bristles each module slot other than the whip (M1) with a 70% chance: setae density 0.3 to 0.45 and setae length 0.25 to 0.6, unless the form already drew more. These draws come from the form's stream after its other draws, so the v5 and form draws never shift.

## Consequences

- Over 10,000 random v2 bodies, the median trunk leg is 0.07 core radii wide (0.22 before). On gallery specimens 26, 27, 30, 37 and 38 it is 0.07 to 0.11.
- About 4.6% of parts have more than a quarter of their centre line inside the outline (35% before). Most of the rest lie in a coil's whorls or on a curled chain's concave side, where no turn clears them.
- Of genesis's non-whip slots, 80% are bristled (34% before). In `report:diversity`'s bred sample, 79% of the legs carry 6 or more bristles (50% before). The bred sample is still 99.9% single cells after 6 generations, so it has no trunk legs yet.
- A leg the bounds would sweep over the trunk now turns out and shortens instead. Over random v2 genomes, 53% of legs keep their gene length (the v1 rule: 46%; 60% before).
- The setose shrimp (gallery 27) keeps 20 separate bristle strokes on the sheet (21 before), the M6 T10 bar. Its legs now point out from the body, so a coarser turn step of 0.25 rad left 17.
- The archetype balance holds with no stats constant changed. Every archetype is best at one metric at some size. The curl and ring twin properties compare parts by girth.
- A radial body is lighter and less draggy than before (its chain is inside the core), and its rear ring parts root on the core.
- Plan, stats, tournament, genesis, inheritance and offspring goldens are regenerated, since rules 7 is unreleased. `genesis-v6.json`, `inherit-v6.json` and `offspring-v6.json` do not change. The v6 child-hash test now breeds the frozen rules 6 genesis cells.
- Rejected:
  - thinning by the girth half-width, as the spec first asked: a slimmed chain keeps its girth, so gallery shrimp 27's legs stayed 0.215 wide;
  - stats on the drawn width: the coiled and radial archetypes lost their niches, and the twin properties broke;
  - widening fused segments to fill the carapace: segments only fill an ellipse's middle, so most roots stayed under the shell;
  - mapping parts with no clear root onto other segments: this changes morphology beyond the task.
