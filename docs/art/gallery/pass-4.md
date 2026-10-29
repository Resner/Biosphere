# Look pass 4

The fourth look pass (M6 T28b, ADR 0024), judged against `docs/art/reference-02.jpg` to `reference-05.jpg`, then tuned. The bar for M6 is no cell above 1.

- Sheet: `pass-4.png`, from `npm run gallery -- --pass 4` (1600×1000, pixel ratio 1, high preset, gait time 0.6 s, dark water), rendered after this pass's changes.
- Specimens: the 36 of passes 1 to 3; none was added or replaced. Specimens 01–20 are karyotype v1 genomes and keep the v1 body, so only 21–36 can show this pass's development changes.
- Method: as in pass 3, each reference sheet and the sheet side by side, with cells 21–32 also rendered at a pixel ratio of 2 and 3 (a scratch pixel-ratio switch, not committed).

## What this pass changed

This pass is development, not shading: pass 3's first two gaps.

- **Long bodies** (gap 1, ADR 0031): a bilateral v2 chain of 3 or more segments is now at least 2.5 times as long as wide, measured laid straight. A wider chain narrows, every segment by one factor, so the head and trunk keep their profile (a copepod's wide front and thin tail, a shrimp's even trunk). Over random v2 genomes nearly every long chain narrows, by 0.63 at the median. The 12 silhouette specimens are still 12 classes.
- **The balance holds by construction**: the narrowing is lateral compression, as in real copepods and shrimps seen from above. The body is as deep as it was wide, so mass, inertia, plates and the frontal width read its girth and the stats are those of the unslimmed body. Pass 3's narrower chain, which made slim bodies lighter, broke three balance tests; this one leaves the archetype tests and the tournament rankings as they were, and the pacing report meets every target (its 60%-size median moved from 1.5 to 1.4 min).
- **Long parts** (gap 2): the length gene now reaches 2.4 core radii at its top (unchanged below 0.8 of its span), and a long part keeps what of that reach fits, sweeping round the body. 7% of antennae and 5% of ring parts reach past 1.5 core radii.
- Review leftovers from pass 3: the first segment wall now draws at full width (the shader's mask started at 1, so it cut the wall's front half); `wallsAlong` checks the two segments that meet when the owner skips a buried segment; the walls are cached per plan instead of being found again on every rung of the detail ladder.

## Gap table

Scores: 0 holds up next to the reference, 3 is far off. Pass 3's scores are in `pass-3.md`.

| Aspect | 02 | 03 | 04 | 05 |
| --- | --- | --- | --- | --- |
| Silhouette variety | 2: Closer. The copepod (26), shrimp (27), crab (30), winged (31) and fan tail (32) now read as long bodies, the crab a long shell with walls, as 02's copepods do. Most of the baseline (01–20, v1 bodies) are still round cells, and the worm (28) and coil (29) read as a tangle of parts. | 3: Unchanged. 03's flowers, spirals and long-bodied crab have no counterpart; the coil (29) does not read as a spiral at the sheet's size. | 2: Was 3. 04's long-bodied larvae and moths now have counterparts in 26, 27, 31 and 32; its plume tails and wide crabs still do not. | 3: Unchanged. 05's nautilus coil, winged plankton and big-eyed larvae are absent; the tadpole (25) is still a ball with a tuft. |
| Translucency | 1: Unchanged: clear glass, lit inside the rim, organs showing through. | 1: Unchanged: 03's shells are nearly invisible apart from their outline, and ours are too. | 1: Unchanged. | 2: Unchanged. 05's light passes through the whole body, ours leaves the middle to the organs. |
| Inner detail | 1: The organs now line up along the long trunks, closer to 02's midline masses. | 1: Unchanged. | 2: Unchanged. 04 is packed with lit chambers end to end; a long trunk leaves more empty glass behind the organs. | 2: Unchanged. 05's big eyes sit inside the head; ours are small and on stalks outside it. |
| Fine appendages | 2: Long parts exist now (the bell's tentacles, the winged and fan-tailed bodies' rays), but no specimen carries 02's body-long sweeping antennae. | 1: Unchanged. | 3: Unchanged. 04's legs carry dense, evenly spaced bristles; ours have few. | 3: Unchanged. 05's long sweeping antennae and big pincers are missing. |
| Palette | 1: Unchanged. | 1: Unchanged. | 1: Unchanged. | 2: Unchanged. 05's colour level is above any of our bodies. |
| Rare glints | 1: Unchanged. | 1: Unchanged. | 2: Unchanged. 04 glitters all over; our exotic body (36) has 14 stars. | 2: Unchanged. 05's jewel-like sparkle is the ceiling. |
| Lighting | 1: Unchanged. | 1: Unchanged. | 2: Unchanged. 04's bodies are lit from within with many hot points. | 2: Unchanged. 05's backlit glow and edge highlights are stronger and more varied. |

One cell improved (silhouette against 04, 3 to 2) and none got worse. Fifteen cells are still above 1: four silhouette cells, three fine-appendage cells and eight 04/05-ceiling cells. Look pass 5 (T28c) follows.

## In-game check

Two 960×540 screenshots at default zoom (medium preset), the world frozen (`debug.timeScale(0)`), with the shrimp (27) as the player and six gallery bodies around it as remotes (08, 24, 26, 28, 30 and 31), once in the shallows and once in the deep (`debug.setZone`), as in pass 3:

- **Shallows**: the crab (30) is now a long segmented shell with its legs along it, the copepod (26) a long oval with a thin tail under its fringe and the winged body (31) a long body between its fans; each keeps its bright rim over the caustics and the god rays. Neighbours are now told apart by outline as well as fringe.
- **Deep**: the same bodies light their pools; the long outlines read better against the dark than over the caustics.
- The player shrimp at 1% of adult size is still mostly its legs and setae at this zoom, and the worm (28) still reads as a tangle of parts: a long body bent tight curls back over itself.

## Largest gaps

In order of visual impact.

1. The baseline is round (development): specimens 01–20 are karyotype v1 genomes with the v1 body, and genesis cells are single round cells, so most of the sheet is round however long the v2 chains are. The gallery needs v2 descendants of the baseline, or the sheet's verdict should weigh the v2 specimens (ADR 0024 fixes the set).
2. Worms and coils read as tangles (development and render): a tightly bent long body curls back under its own parts; 03's and 05's spirals are a body with few, short parts round it.
3. Dense bristles along legs (04): setae density is genetic and mostly low; legs read bare next to 04's.
4. Big dark eyes inside the head (05): eyes are small lenses on stalks outside the body.
5. Long sweeping antennae on the sheet (02, 05): the long range exists, but no specimen's antenna gene is high enough to show it.
6. The 04/05 ceiling for the rarest bodies: light through the whole body, colour level and glitter.
7. Stacked setae fans and wings can still read as a white cloud (31, 32), and a near speck's bokeh can wash out a body it crosses in play.
