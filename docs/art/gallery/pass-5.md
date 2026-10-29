# Look pass 5

The fifth and last look pass of M6 (T28c, ADR 0024), judged against `docs/art/reference-02.jpg` to `reference-05.jpg`, then tuned. The bar for M6 is no cell above 1.

- Sheet: `pass-5.png`, from `npm run gallery -- --pass 5` (1600×1000, pixel ratio 1, high preset, gait time 0.6 s, dark water), rendered after this pass's changes.
- Specimens: the 36 of passes 1 to 4, now drawn as rules 6 develops them (ADR 0032): the karyotype v1 files 01–20 are shown as their v2 upgrade, the body their children start from. Three look-feature specimens are added: 37 long antennae, 38 big eyes set into the head, 39 a coiled chain with short parts. The sheet is 8 by 5, each body about 3% smaller than on pass 4's.
- Method: as in passes 3 and 4, each reference sheet and the sheet side by side, with the worm, coil, setose and new specimens also drawn alone at four to a sheet (a scratch filter, not committed).

## What this pass changed

The pass worked pass 4's largest gaps in order.

1. **The round baseline** (gap 1, ADR 0032): the gallery draws v1 specimens as their v2 upgrade. The baseline's chains of three or more segments (07, 09–12, 18, 19) now read as long, segmented bodies; the genesis cells and single-cell picks (01–06, 14–16) stay round cells, as references 02's 07 and 19 are.
2. **Worms and coils as tangles** (gap 2): broad parts are now clear glass with bright edges once they are more than a few pixels wide (a part's half-width on screen of 2.5 to 6 px turns it from a bright stroke to glass), so the worm's (28) paddles no longer pile into a white knot over its trunk. The gut line is fainter, so on a slim trunk it no longer joins the organs along it into one streak (12's organs read as separate masses again). Development was not changed for curls: see the gaps below.
3. **Bristles along legs** (gap 3, reference 04): bristles are plumose on the high level: three pairs of fainter setules leave each one, so a setose leg (24, 27, 35, 38) reads as a feathered comb. The stats count the bristles only, as before.
4. **Big eyes set into the head** (gap 4, reference 05): a short stalk now sinks the eye into the head, a stalkless eye three quarters inside it (`RULES.develop.eyes.set`), and no stalk is drawn where the eye hides it. The copepod (26) and the new 38 carry big dark eyes in the front of the head, as 05's larvae do. Eyes only move the inertia a little; the archetype tests, the tournament and the pacing report's targets hold (its full-life matings moved from 9 to 8 at the median), and rules 6's plan and stats goldens are regenerated.
5. **Long antennae on the sheet** (gap 5): specimen 37 carries a pair of hair-thin antennae over two core radii long, sweeping out and round from the head as 02's copepods' do.

## Gap table

Scores: 0 holds up next to the reference, 3 is far off. Pass 4's scores are in `pass-4.md`.

| Aspect | 02 | 03 | 04 | 05 |
| --- | --- | --- | --- | --- |
| Silhouette variety | 2: Closer. With the baseline drawn as rules 6 bodies, seven more cells are long segmented bodies, and 37 has 02's sweeping antennae. Most long bodies are still a big round head on a narrow trunk where 02's copepods are one oval, and the worm (28) still curls under its own parts. | 3: Unchanged. 03's flowers and spirals have no counterpart: the coil (29) and the new spiral (39) are a short hook of ring-like segments under the head, not a spiral. | 2: Unchanged. 04's long larvae and moths have counterparts; its plume tails and wide crabs do not. | 2: Was 3. 05's big-eyed larvae now have counterparts (26, 38), as do its long-antennae copepod (37) and winged plankton (31); its nautilus coil and S-worm are still missing. |
| Translucency | 1: Unchanged: clear glass, lit inside the rim, organs showing through; broad parts are now glass too. | 1: Unchanged. | 1: Unchanged. | 2: Unchanged. 05's light passes through the whole body, ours leaves the middle to the organs. |
| Inner detail | 1: Unchanged. | 1: Unchanged. | 2: Unchanged. 04 is packed with lit chambers end to end; a long trunk leaves more empty glass behind the organs. | 2: Closer: big dark eyes now sit inside the head (26, 38), but 05's bodies glow with packed organs from end to end. |
| Fine appendages | 2: Closer. 37 carries body-long antennae and setose parts read as feathered fans, but most legs are broad, bare and short next to 02's hair-thin, beaded legs. | 1: Unchanged. | 2: Was 3. Setose legs (27, 35, 38) now read as dense feathered combs; legs without the setae gene stay bare, and 04 has none bare. | 2: Was 3. Long sweeping antennae now exist (37); 05's big pincers are still missing, and its legs are bristled all over. |
| Palette | 1: Unchanged. | 1: Unchanged. | 1: Unchanged. | 2: Unchanged. 05's colour level is above any of our bodies. |
| Rare glints | 1: Unchanged. | 1: Unchanged. | 2: Unchanged. 04 glitters all over; our exotic body (36) has 14 stars. | 2: Unchanged. 05's jewel-like sparkle is the ceiling. |
| Lighting | 1: Unchanged. | 1: Unchanged. | 2: Unchanged. 04's bodies are lit from within with many hot points. | 2: Unchanged. 05's backlit glow and edge highlights are stronger and more varied. |

Three cells improved (silhouette against 05, fine appendages against 04 and 05, each 3 to 2) and none got worse. Fifteen cells are still above 1: four silhouette cells, three fine-appendage cells and eight 04/05-ceiling cells. This was the last pass M6 allows (T28), so the gaps go to the owner (#177).

## In-game check

Two 960×540 screenshots at default zoom (medium preset), the world frozen (`debug.timeScale(0)`), with the shrimp (27) as the player and eight gallery bodies around it as remotes (08, 24, 26, 28, 30, 31 and the new 37 and 38), once in the shallows and once in the deep (`debug.setZone`):

- **Shallows**: 37's long antennae read at play zoom as two thin arcs from its head; the long bodies (26, 30, 31) keep their bright rims over the caustics. The setose bodies (31, 38) still read as white tufts: setules are drawn on the high level only, and at this size a bristle fan is a few pixels.
- **Deep**: the same bodies light their pools; outlines read better against the dark than over the caustics. 38's eyes are dark spots in its head front, barely readable at 1% adult size.
- In play the remotes keep their own karyotype, so the v1 body of 08 is still round there: only the gallery draws v1 genomes as their upgrade.

## Largest gaps

In order of visual impact.

1. Head-heavy long bodies (development): a v2 chain is a big oval head on a narrow trunk of short, wide rings, so copepods and shrimps read as a bulb with a tail, where 02's and 05's are one long oval with the trunk the widest part.
2. Spirals and S-worms (development): a curl is a pose of a chain that fits the reach laid straight (ADR 0031), so a coil is a hook of three or four rings under the head (29, 39); 03's and 05's spirals need a chain longer than the reach that only fits curled, which changes the stats of curled bodies.
3. Bare, broad legs (genetics and look): legs without the setae gene are bare and parts are as wide as their thickness gene (up to 0.4 core radii); 02–05 draw nearly every leg hair-thin and bristled.
4. The 04/05 ceiling for the rarest bodies: light through the whole body, colour level, packed glowing organs and glitter.
5. Setose fans still read as white tufts at play zoom (31, 38), and a near speck's bokeh can wash out a body it crosses.
