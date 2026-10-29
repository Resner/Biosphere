# Look pass 2

The second look pass (M6 T27, ADR 0024), after the world in depth (T15–T17), the owner's v0.6.0 feedback (T18–T20), readability (T21), sound (T22, T23), the social wheel and icons (T24, T25) and the budgets (T26), judged against `docs/art/reference-02.jpg` to `reference-05.jpg`, then tuned.

- Sheet: `pass-2.png`, from `npm run gallery -- --pass 2` (1600×1000, pixel ratio 1, high preset, gait time 0.6 s, dark water), rendered after this pass's fixes.
- Specimens: the 36 of pass 1 (20 baseline, 21–32 one per silhouette class, 33–36 one per rarity tier); none was added or replaced.
- Method: each reference sheet and the sheet were opened side by side; cells 01, 05, 07, 08, 10, 13, 16, 24–27 and 29–36 were also checked enlarged two to four times, before and after every change.

## Before the fixes

Rendered first from the build before this pass, the sheet was pass 1 with two changes from T21, which made readability fixes after pass 1:

- Plated bodies (07, 08, 10, 11, 25, 31, 32, 36) had turned milky. T21's plate sheen filled almost half of each plate with the rim colour, so these shells read as frosted glass, not clear glass.
- The mouth is now a dark opening with a bright lip. It reads as a mouth and does not fight the organs.

T15–T17 (zones, caustics, god rays, snow) and T18–T26 do not touch the gallery's fixed dark backdrop or its bodies, so their effect shows only in the in-game check below.

## What this pass changed

All of it is render tuning: anatomy, mesh, material and shader constants. No rule, plan, stat or genome changed.

- **Organ masses** (gap 5 of pass 1): chambers are larger (0.36 of the body scale, from 0.23) and packed closer (gap 1.05, from 1.2) in a wider midline band (0.7 of each segment's half-width, from 0.55). Every organ except eye pigment now has a soft glow of tissue round it, up to 2.4 times its radius and always inside the hull. The glows overlap where the organs cannot, so neighbouring lobes merge into one coloured mass, as in 02 and 03. They are flat discs drawn under the organs, inside the organs' vertex reserve.
- **Several hues inside** (pass 1: "03 mixes several organ hues per body; ours mostly have one"): each organ takes one of two hues by its number. The second hue sits 0.08 turns round the wheel on a common body, rising to 0.32 on an exotic one.
- **The rarest bodies are more colourful** (gap 7): the second hue is more saturated with rarity (`ORGAN_HUES.vivid`), and the organs glow a little brighter. The shell never changes: colour still lives inside.
- **Bright yellow and green organs are dimmed toward one luminance**, so a mass of them does not outshine the rim. The rim stays the brightest ring of every body (T13's check), now with more margin on the coil (29).
- **Pearls, not bubbles** (gap 4): a bulb tip is drawn at 0.55 of its plan radius as a small solid pearl with one hot point, so bead-tipped spines and tentacles (23, 26, 35, 36) read as in 03, not as bubble clusters.
- **Wet points on joints** (gap 6): legs and antennae catch the key light in small points where their joint beads swell, on plain bodies too. These are highlights, not rare glints.
- **Clearer glass**: the plate fill is cut from 0.45 to 0.18 of the rim colour (its sheen stays, so plates still read in play), and membrane sheets between their veins are clearer, so plated and winged bodies are clear glass again.
- **Claws** (T21's open gap): a chela's palm swells more and its finger is longer and wider (palm 1.3, finger 1.1 long and 0.8 wide).

## Gap table

Scores: 0 holds up next to the reference, 3 is far off. Pass 1's scores are in `pass-1.md`; the cells that improved say "Up from 2 in pass 1".

| Aspect | 02 | 03 | 04 | 05 |
| --- | --- | --- | --- | --- |
| Silhouette variety | 2: Unchanged since pass 1. The shrimp (27), crab (30) and fan tail (32) read as segmented bodies, but they are stubby next to 02's long copepods, and most of the baseline are round cells. | 3: Unchanged. 03's flowers, spirals and long-bodied crab have no counterpart, and neighbours still differ mostly in their fringe. | 3: Unchanged. 04's moths, wide crabs and plume-tailed larvae need bodies several times longer than wide; ours are at most about twice as long. | 3: Unchanged. 05's nautilus coil, winged plankton and big-eyed larvae are absent; the tadpole (25) and the winged specimen (31) read as a ball with a tuft. |
| Translucency | 1: Clear glass with the organs showing through and a crisp edge; the plated bodies are clear again. It is darker between the organs than 02's backlit bodies. | 1: 03's shells are nearly invisible apart from their outline, and ours are too. The carapace over 30 still doubles the outline. | 1: Up from 2 in pass 1. The organs now glow from within through a clear shell, as in 04, though the glass between them stays dark. | 2: 05's light passes through the whole body; ours lights the organs, not the body. |
| Inner detail | 1: Up from 2 in pass 1. Large coloured lobes with soft glows now merge into organ masses along the midline, with a gut line, droplets and a heart. 02 also shows segment walls, which ours lack. | 1: Up from 2 in pass 1. The bodies are filled with clusters of coloured lobes and droplets, close to 03's. They are fewer and rounder than 03's tightly packed droplets. | 2: 04 is packed with lit chambers from end to end. Ours fill the middle; the head and the tail are empty. | 2: 05 has organ clusters, segment boundaries and big dark eyes. Ours has the clusters only, and the eyes sit on stalks outside the body. |
| Fine appendages | 2: Jointed legs with beads and wet points, setae fans and pearl-tipped spines are bright and crisp. 02's antennae are as long as the body; ours are at most 1.5 core radii. | 1: Up from 2 in pass 1. Bulb tips are now small solid pearls, so the bead-tipped spines of 23 and 35 and the tentacles of 26 and 36 read like 03's. The pearls are larger than 03's and there are fewer of them. | 3: 04's legs carry dense, evenly spaced bristles along their whole length. Ours have few, and most parts are bare. | 3: 05's long sweeping antennae are missing. The claws are larger but still small next to 05's pincers. |
| Palette | 1: The shells are silvery and clear, and the colour lives in the organs. Several common bodies (01–03) are vivid inside, more than 02's soft amber and violet. | 1: Bodies now mix two organ hues plus amber droplets, as 03 does. 03's colours are paler than our most saturated genes. | 1: Up from 2 in pass 1. The colour sits in organs over a clear body, and the rarest bodies now carry the widest, most vivid mix of hues, which is 04's structure. 04 is still more intense. | 2: 05's colour level is higher than any of our bodies, including the exotic tier specimen (36). |
| Rare glints | 1: Common bodies are plain and the exotic ones carry star points; the joints now catch small wet points on every body. | 1: 03's tiny bright points on beads and tips are close to our glints and the new pearl highlights. | 2: 04 glitters all over; our exotic specimen (36) has a dozen glints, well short of 04's intensity. | 2: 05's jewel-like sparkle is the ceiling; ours is in the right direction, but no specimen comes near it. |
| Lighting | 1: Thin bright rims, a wet highlight, refraction and now a soft glow from inside, close to 02. | 1: Thin bright outlines over clear bodies, and joints that catch the light, as in 03. The joint points are fainter than 03's. | 2: 04's bodies are lit from within with many hot points; ours glow round the organs only. | 2: 05's backlit glow and edge highlights are stronger and more varied than our single rim. |

Cells improved since pass 1: Translucency × 04, Inner detail × 02 and × 03, Fine appendages × 03, Palette × 04 (five cells, each from 2 to 1). No cell got worse.

## In-game check

Two 960×540 screenshots at default zoom (medium preset), the world frozen (`debug.timeScale(0)`), with the shrimp (27) as the player and six gallery bodies around it as remotes (`debug.setRemotes` with 08, 24, 26, 28, 30 and 31), once in the shallows and once in the deep (`debug.setZone`):

- **Shallows**: the bodies stay readable over the bright caustic water and god rays. Each shows a bright rim, a coloured core of organs and a white fringe of parts. The caustics play over the glass without hiding the rim. The organs' glows are faint at this size (the medium level draws them with 10 vertices), so the inside reads as coloured points rather than masses; the masses show on high and when enlarged.
- **Deep**: the water is near black, and the luminous bodies light green and blue pools round themselves (T16). Every body keeps its rim and stays readable; the organ colours read better here than in the shallows.
- Detail never fights the silhouette: the surface detail has faded out, the pearls and joint points are single bright pixels, and the rim stays the strongest edge. Neighbours are still told apart by their fringe more than by their outline, which is gap 1.

## Largest gaps

In order of visual impact.

1. Proportions and silhouettes (development, not look). Every silhouette cell is still 2 or 3. A body fits in 2.5 core radii round a core of radius 1, so it is at most about twice as long as wide, and the baseline is mostly round cells. 02's long copepods, 03's flowers and spirals, and 04's and 05's moths and plume-tailed larvae need a longer, thinner body plan, a rules change in development. The M6 bar (no cell above 1) cannot be met by look tuning alone, so pass 3 needs a body-plan task first, or the owner's call on deferring silhouettes.
2. Parts are short (development). The gene range stops at 1.5 core radii, so no antenna sweeps round the body as in 02 and 05.
3. Light through the whole body (04, 05). The glass between the organs stays dark. T13's rule that the rim stays the brightest ring caps how much the inside may glow, so a backlit body needs either a brighter rim or that rule reconsidered against 04 and 05.
4. Segment walls (02, 05). The trunk shows waists between segments but no thin walls across it.
5. Dense bristles along legs (04). Setae density is genetic and mostly low; legs read bare next to 04's.
6. Big dark eyes inside the head (05). Eyes are stalked lenses outside the body.
7. Stacked setae fans and wings can still read as a white cloud (31, 32) rather than separate strokes.
8. In play at medium, the organ glows are too faint to read as masses (10-vertex discs); a stronger glow at small sizes would carry the colour.
