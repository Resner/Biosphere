# Look pass 6

The one look pass of M6b (T12, ADR 0034). It comes after every look, body, water, HUD and egg task of the milestone. It is judged against `pass-1.png`, the realism baseline, and against `docs/art/reference-02.jpg` to `reference-05.jpg`, then tuned. M6b has no pass 7.

- Sheet: `pass-6.png`, from `npm run gallery -- --pass 6` (1600×1000, pixel ratio 1, high preset, gait time 0.6 s, dark water), rendered after this pass's changes.
- Specimens: the 39 of pass 5, plus 40, an S-worm (M6b T6). All are drawn as rules 7 develops them (ADR 0035). The sheet is 8 by 5.
- Method: each reference sheet and `pass-1.png` were opened side by side with the sheet. Cells were enlarged two to three times, pass 1, pass 5 and this pass side by side (01–03, 07, 08, 12, 16, 24, 27–31, 33, 38–40), before and after every change. Nothing was scored from memory.
- Measures on the final sheet: every cell has 0 solid-white pixels, and so does every body in the in-game check (`m6b-clip.spec.ts`, bar 12). The shell stands 28.7 levels above the water at the median, against 63.1 on pass 5 (T3's bar is 31.6). At least 90% of every body's coloured pixels lie within 1.3 radii of an organ (`m6b-look.spec.ts`, bar 85%).

## What this pass changed

M6b's tasks had already restored pass 1's glass (T3), ended white clipping (T4) and reshaped long bodies (T5–T7). Side by side with pass 1, three render gaps were left. They were fixed with render tuning only: the creature shader's constants, no rule, plan or stat.

1. **Grey, smoky legs.** T4 capped each fine part's light, and that dimmed a leg's two bright edges. Its face between them stayed dark glass. So a thin leg read as a dark tube with grey edges, and a crowd of legs read as grey smoke (07, 08, 11, 13, 30). Pass 1's legs were bright glass strokes. A thin leg is now a glass rod lit through, brightest along its axis and denser, still under the 0.5 cap. The legs read as clear glass strokes again, and no cell gained a white pixel.
2. **A grey haze between bristles.** Where plumose combs overlap (08, 24, 38, 39), their setules filled the space between the bristles. Setules are now fainter (opacity 0.3, from 0.45), so a comb reads as bristles. The setose specimen still shows at least 20 separate strokes (M6 T10's check).
3. **A pale crescent on round cells.** T3 cleared the shells, and against them a round cell's mouth showed a wide pale crescent over the front of the body (01–05, 14–16, 21, 33, 34). Pass 1's mouth is a thin lip. The lip is now narrower and a little dimmer (over 0.06–0.5 of the fresnel at 1.15, from 0.06–0.4 at 1.3; the lower edge stays at 0.06, since a higher one cut the mouth off the body in the Lab's connected-shape check). It reads as a mouth at the front again, not a cap.

## Against pass 1

| Aspect | Against pass 1 |
| --- | --- |
| Silhouette variety | better: Pass 1 had one stubby head-and-trunk shape. Now the long chains (07, 09–12, 17–19, 26, 27, 30, 38) are segmented bodies, widest at the trunk and narrowing to the tail, 40 is an S-worm, 29 and 39 are coiled, and 37 sweeps long antennae. |
| Translucency | same: The shells are clearer than pass 1's, with no milky face and a crisper rim (shell excess 29 against pass 1's roughly 63). Pass 1's soft glassy sheen is gone with the haze, so a body reads as darker glass. |
| Inner detail | better: The organs keep pass 1's size, midline band and glassy chambers. Faint segment walls, lens eyes set into the head (26, 38) and a fainter gut, which no longer joins the organs into one streak, add to them. |
| Fine appendages | better: Legs are hair-thin glass strokes off the body, with bristles on most of them and pearl tips. 37 and 12 carry long antennae, and setose fans (24, 27, 38) read as feathered combs, where pass 1 had short, broad, bare parts. |
| Palette | same: As in pass 1, each body's organs share one hue near the gene's, with droplets turned toward amber. An uncommon or rarer body may add one complementary accent. |
| Rare glints | same: As in pass 1, common bodies are plain and exotic ones carry star points, now on pearls and joints too. Wet joint points stay at half of the rim's luminance, so plain bodies do not glitter. |
| Lighting | same: As in pass 1, a thin, bright rim is every body's brightest ring, with a wet highlight. Parts are capped below white, so the overlaps that clipped on passes 2 to 5 no longer clip, though a part is a little less bright than pass 1's. |

## Gap table

Scores: 0 holds up next to the reference, 3 is far off. The 04 and 05 columns judge the rare and exotic specimens only (ADR 0034). Pass 5's scores are in `pass-5.md`.

| Aspect | 02 | 03 | 04 | 05 |
| --- | --- | --- | --- | --- |
| Silhouette variety | 2: Closer. The long bodies now read as copepods and shrimps (07, 10, 12, 27, 37), widest at the trunk, and 40 is an S-worm. Still, 17 of 40 cells are round cells, and the bodies are small in their cells next to 02's leggy, antenna-framed creatures. | 2: Was 3. 03's spirals and S-worm now have counterparts (29, 39, 40), though at this size the coils read as a tight knot under their bristles. Its flowers, bells and wide crabs are still missing. | 2: Unchanged. The long larvae and shrimps (27, 37, 38) match 04's; its plume tails, moths and wide crabs do not. | 2: Unchanged. The S-worm (40), the coil (29, 39), the big-eyed larvae (26, 38) and the winged body (31) have counterparts, but the coils are small and fuzzy beside 05's nautilus. |
| Translucency | 2: Was 1. The shells are clear with a crisp rim, as the owner asked, but they are dark inside, where 02's bodies glow pale from within. | 1: Unchanged. 03's nearly invisible shells with bright outlines match ours. | 2: Unchanged. 04's bodies are lit from within; ours show the dark water. | 2: Unchanged. 05's light passes through the whole body. |
| Inner detail | 2: Was 1. The organs are back at pass 1's size (ADR 0034): separate glassy chambers along the midline, where 02's organs are large, overlapping coloured masses. | 2: Was 1. 03's droplet clusters fill the body; ours are a few chambers along the midline. | 2: Unchanged. 04 is packed with lit chambers end to end. | 2: Unchanged. 05's eyes now have counterparts (26, 38), but its packed, glowing organs do not. |
| Fine appendages | 2: Unchanged. The legs are now hair-thin and mostly bristled, and 12 and 37 carry long antennae. But the round cells keep short, sparse cilia, and 02 frames every body in long beaded legs and antennae. | 1: Unchanged. 03's thin, bead-tipped tentacles match our pearl tips and thin parts. | 2: Unchanged. Bristled legs (27, 38) read as combs, though fainter and sparser than 04's dense, glittering bristles. | 2: Unchanged. Long antennae (37) exist, but 05's big pincers and its bristles on every leg do not. |
| Palette | 1: Unchanged. The shells are silvery and clear, and the colour sits in the organs in one hue, as in 02. | 1: Unchanged. 03's faint colour inside crystal bodies matches ours. | 2: Unchanged. 04's saturation is the ceiling, and our exotic bodies sit well below it. | 2: Unchanged. 05's colour level is above any of our bodies. |
| Rare glints | 1: Unchanged. Common bodies are plain, and exotic bodies carry star points on pearls and joints. | 1: Unchanged. 03's small bright points on beads and tips match ours. | 2: Unchanged. 04 glitters all over; our exotic bodies carry a dozen or so stars. | 2: Unchanged. 05's jewel-like sparkle is the ceiling. |
| Lighting | 1: Unchanged. A thin, bright rim and wet joint points, close to 02's white rims. | 1: Unchanged. 03's thin bright outlines match ours. | 2: Unchanged. 04's bodies have many hot points inside; ours have the rim and the glints. | 2: Unchanged. 05's backlit glow and edge highlights are stronger and more varied. |

**The bar (ADR 0034) fails on six cells, all against 02 and 03:**
- silhouette variety × 02 and × 03;
- translucency × 02;
- inner detail × 02 and × 03;
- fine appendages × 02.

The rest holds:
- no aspect is worse than pass 1;
- silhouette variety and fine appendages are better than pass 1;
- no 04 or 05 cell is above 2.

Translucency and inner detail scored worse against 02 and 03 than on pass 5 by design. ADR 0034 trades 02's pale, glowing interiors and organ masses for pass 1's clear glass and smaller organs, which the owner preferred, and T3's measures pin that choice (shell excess at most 31.6, colour within 1.3 organ radii). The silhouette and appendage cells need more than render tuning: more long bodies on the sheet, legs and antennae on round cells, and larger coils (see the gaps below). The owner judges these gaps at the gate.

## In-game check

Three 960×540 screenshots, at default zoom and the medium preset, with the world frozen (`debug.timeScale(0)`) and the new HUD on screen. They show the menu button, the stat bars with the "Not recorded" chip, the minimap and the first-life hint. The shrimp (27) is the player, and nine gallery bodies (08, 24, 26, 28, 30, 31, 37, 38, 40) are drawn as remotes at biomass 200 around it, in the shallows, the twilight and the deep (`debug.setZone`):

- **Shallows**: every body keeps a bright rim and readable organs over the calmer caustics. The legs read as thin glass strokes, not grey smoke. The crab (30) and the long-antennae copepod (37) read as creatures at a glance. The worm (28) is a curled chain of bright segments.
- **Twilight**: the same, against darker water. The minimap and the bars stay clear of the bodies. No body has a solid-white pixel.
- **Deep**: the glow pools light the bodies around them. The setose fans of 24 and 38 brighten into near-white tufts there, though no pixel reaches solid white. The C-curled worm (28) and the small player (27) are the hardest bodies to read at this size.

## Largest gaps

In order of visual impact. ADR 0034 allows no pass 7, so these go to the owner at the gate.

1. Translucency against 02: the clear shells read as dark glass. 02's bodies glow pale from within, which ADR 0034's clear glass and T3's shell measure rule out. The owner decides whether a soft inner light belongs in the glass.
2. Round cells (17 of 40) carry short, sparse cilia. 02–05 frame nearly every body in long legs or antennae, so the sheet's silhouettes still look less varied than the references'. This needs development work on single-cell parts, not render tuning.
3. Organs are separate small chambers (pass 1's size, ADR 0034). The references' bodies are packed with large, overlapping organ masses.
4. Coils (29, 39) are small and read as a knot under their bristles at gallery size. 03's and 05's spirals are the body's whole outline.
5. Setose fans brighten into near-white tufts in the deep's glow pools (24 and 38 in game), and at gallery size 39's fan reads as a white puff, though none clips to solid white.
6. The 04/05 ceiling for the rarest bodies: glowing interiors, saturation and glitter.
