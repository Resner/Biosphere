# Look pass 3

The third look pass (M6 T28, ADR 0024), judged against `docs/art/reference-02.jpg` to `reference-05.jpg`, then tuned. The bar for M6 is no cell above 1.

- Sheet: `pass-3.png`, from `npm run gallery -- --pass 3` (1600×1000, pixel ratio 1, high preset, gait time 0.6 s, dark water), rendered after this pass's fixes.
- Specimens: the 36 of passes 1 and 2; none was added or replaced.
- Method: each reference sheet and the sheet were opened side by side. Cells 05, 07, 08, 13, 21 and 24–36 were also rendered at a pixel ratio of 3 and 4 (the same page with a scratch pixel-ratio switch, not committed) before and after every change, so detail that the 1× sheet only hints at could be judged.

## Before the fixes

Nothing that draws a creature changed between T27 and this pass, so the sheet before the fixes was `pass-2.png`. Looked at enlarged, four things stood out that pass 2's table does not name:

- Parts looked like crumpled foil: the shell's cell texture ran over every leg and spine, and on a thin tube it reads as wrinkles, not glass.
- Webbed fans and wings (26, 28, 31, 32) were crumpled sheets: the fine vein network was drawn at a third of a vein's strength over the whole sheet.
- Eyes were black octagons: a big dark eye drawn with a bulb's eight sides shows its corners.
- Fluid chambers were hard glass marbles: each had a bright wall and a highlight, so lobes side by side read as beads, not as one organ mass.

## What this pass tried first, and why it was undone

Gap 1 of pass 2 (silhouettes) is a development gap: bodies are at most about twice as long as wide. Rules 6 is unreleased, so a slimmer v2 chain is allowed. It was tried with the chain's width at 0.5, 0.6 and 0.65 core radii (from 0.8) and the head at 0.55 to 0.65 (from 0.65). Every variant broke game balance, not just look tests:

- `stats.test.ts` "makes each archetype best at one metric at some size": the flagellate is never best, because slimmer chains are lighter and so faster and nimbler.
- `stats.test.ts` "makes a radial body turn better and thrust worse forward": a slim bilateral body now turns better than its radial twin.
- `specimens.test.ts`: the Lab's wild mode shows eight silhouette classes for only 7 of 10 seeds (the bar is 9).

Re-balancing the stats belongs in a task of its own, with the pacing and the archetype tournament rerun, so the change was reverted. Pass 4 (T28b) starts there.

## What this pass changed

All of it is render: mesh and shader. No rule, plan, stat or genome changed.

- **Segment walls** (gap 4): thin bright walls cross the body where two segments meet, as in 02 and 05. The mesh gives the body's vertices a wall coordinate (`aWall`, `wallsAlong`): a whole number on each wall, found where the segment an ellipse's own measure claims steps rearward along the centre line, and only where both neighbours overlap. They fade in as segments reach 3 to 7 px on screen, so a small body stays clean. A lone cell and a radial bell have none.
- **Light through the body** (gap 3): a pale band of scattered light inside the rim, faintly tinted by the organs and stronger on rarer bodies, so the glass between the organs is lit instead of dark. It fades toward the middle, where the organs glow, so the rim stays the brightest ring (T13's check passes with a margin of 15 levels or more on every specimen).
- **Clear glass parts**: legs, antennae and spines no longer carry the shell's cell texture. Their wet highlight and refraction stay (without them the joint glints sank below the bloom).
- **Clearer webs** (gap 7): the fine network on membrane sheets is at 0.15 of a vein (from 0.35), and the sheet between the veins is clearer (0.07 + 0.55 × vein, from 0.12 + 0.65), so stacked fans read as veined glass more than as a white cloud.
- **Eyes** (gap 6): rounder (four sides more than a bulb at each level) and drawn as a dark pigment cup in a clear lens, with a faint ring of the organ hue round the pupil, a thin glassy rim and one bright highlight.
- **Softer organs**: a chamber glows from its centre with a soft edge, with no bright wall and a faint highlight, so lobes merge into masses with their glows.
- **Organ glows at play zoom** (gap 8): on a body under about 14 px per core radius the glows are up to 1.8 times as dense, easing to normal at 28 px (the sheet draws 32), so the colour reads as masses at 960×540.
- **Varied glints** (04 and 05): each star has its own size (0.75 to 1 of its quad) and, on rarer bodies, about two in three throw an organ hue into their rays while the hot point stays white. The exotic specimen shows 14 separate maxima (12 before); the common one still shows at most one.

## Gap table

Scores: 0 holds up next to the reference, 3 is far off. Pass 2's scores are in `pass-2.md`.

| Aspect | 02 | 03 | 04 | 05 |
| --- | --- | --- | --- | --- |
| Silhouette variety | 2: Unchanged since pass 2. The shrimp (27), crab (30) and fan tail (32) read as segmented bodies, now with walls between their segments, but they are stubby next to 02's long copepods, and most of the baseline are round cells. | 3: Unchanged. 03's flowers, spirals and long-bodied crab have no counterpart, and neighbours still differ mostly in their fringe. | 3: Unchanged. 04's moths, wide crabs and plume-tailed larvae need bodies several times longer than wide; ours are at most about twice as long. | 3: Unchanged. 05's nautilus coil, winged plankton and big-eyed larvae are absent; the tadpole (25) and the winged specimen (31) read as a ball with a tuft. |
| Translucency | 1: Clear glass with the organs showing through and a crisp edge, now lit inside the rim. 02's backlit bodies are still brighter between the organs. | 1: 03's shells are nearly invisible apart from their outline, and ours are too; the carapace over 30 still doubles the outline. | 1: The organs glow from within through a clear shell, and the rarest bodies now glow in a band inside the rim, as in 04. | 2: Closer: light now fills a band inside the rim. 05's light passes through the whole body, ours leaves the middle to the organs. |
| Inner detail | 1: Organ masses along the midline with a gut line, droplets and a heart, and now thin segment walls across the trunk, as in 02. The lobes are fewer and larger than 02's. | 1: Bodies filled with soft lobes and droplets that merge into masses, close to 03's. They are fewer and rounder than 03's tightly packed droplets. | 2: 04 is packed with lit chambers from end to end. Ours fill the middle; the head and the tail are empty. | 2: Closer: segment walls and dark lens eyes now show. 05's big eyes sit inside the head; ours are small and on stalks outside the body. |
| Fine appendages | 2: Jointed legs with beads and wet points, setae fans and pearl-tipped spines are crisp, and now clean glass. 02's antennae are as long as the body; ours are at most 1.5 core radii. | 1: Pearl-tipped spines and tentacles read like 03's; the webs are clearer. The pearls are larger than 03's and there are fewer of them. | 3: 04's legs carry dense, evenly spaced bristles along their whole length. Ours have few, and most parts are bare. | 3: 05's long sweeping antennae are missing, and the claws are small next to 05's pincers. |
| Palette | 1: The shells are silvery and clear, and the colour lives in the organs. Several common bodies (01–03) are vivid inside, more than 02's soft amber and violet. | 1: Bodies mix two organ hues plus amber droplets, as 03 does. 03's colours are paler than our most saturated genes. | 1: The colour sits in organs over a clear body, and the rarest bodies carry the widest, most vivid mix of hues, which is 04's structure. 04 is still more intense. | 2: 05's colour level is higher than any of our bodies, including the exotic tier specimen (36). |
| Rare glints | 1: Common bodies are plain and the exotic ones carry star points; the joints catch small wet points on every body. | 1: 03's tiny bright points on beads and tips are close to our glints and pearl highlights. | 2: 04 glitters all over. Our exotic specimen (36) has 14 stars, now of varied size and some coloured, well short of 04's intensity. | 2: 05's jewel-like sparkle is the ceiling. Ours now has coloured jewels on rare bodies, but no specimen comes near it. |
| Lighting | 1: Thin bright rims, a wet highlight, refraction and a soft glow from inside, close to 02. | 1: Thin bright outlines over clear bodies, and joints that catch the light, as in 03. | 2: Closer: a lit band inside the rim. 04's bodies are lit from within with many hot points; ours glow round the organs and the rim. | 2: 05's backlit glow and edge highlights are stronger and more varied than our single rim. |

No cell changed its score: every change of this pass is real at two to four times the sheet's size, and several (walls, lit glass, softer organs) show on the sheet, but none closes a cell's gap at the sheet's scale. No cell got worse. Fifteen cells are still above 1: the four silhouette cells and three fine-appendage cells need development work (gaps 1 to 3 below), and the other eight are the 04/05 ceiling (gaps 4 and 5).

## In-game check

Two 960×540 screenshots at default zoom (medium preset), the world frozen (`debug.timeScale(0)`), with the shrimp (27) as the player and six gallery bodies around it as remotes (`debug.setRemotes` with 08, 24, 26, 28, 30 and 31), once in the shallows and once in the deep (`debug.setZone`):

- **Shallows**: every body keeps its bright rim over the caustic water and the god rays. The denser glows now make each body's inside a coloured mass rather than a few points. The crab's walls show as faint lines; on the smaller bodies they have faded out, as intended. A near speck's bokeh can still wash out a body it passes in front of.
- **Deep**: the luminous bodies light their pools; rims, organ colour and the white fringes all read, the colour better than in the shallows.
- Detail never fights the silhouette: walls and surface texture fade out at small sizes, the eyes are dark spots with a highlight, and the rim stays the strongest edge. Neighbours are still told apart by their fringe more than by their outline, which is gap 1.

## Largest gaps

In order of visual impact.

1. Proportions and silhouettes (development). Every silhouette cell is 2 or 3: a body fits 2.5 core radii round a unit core and is at most about twice as long as wide. A slimmer, longer v2 chain is the fix, but this pass showed it moves the balance (archetypes, radial turning, wild silhouette diversity), so it needs a stats re-balance in the same change.
2. Parts are short (development). The gene range stops at 1.5 core radii, so no antenna sweeps round the body as in 02 and 05.
3. Dense bristles along legs (04). Setae density is genetic and mostly low; legs read bare next to 04's.
4. Big dark eyes inside the head (05). Eyes are small lenses on stalks outside the body; 05's larvae have eyes a third of the head wide, set into it.
5. The 04/05 ceiling for the rarest bodies: light through the whole body, colour level and glitter all stop short of 04 and 05. The rim-brightest rule (T13) limits how bright the middle may glow.
6. Stacked setae fans and wings can still read as a white cloud (31, 32) rather than separate strokes.
7. A near speck's bokeh can wash out a body it crosses in play.
