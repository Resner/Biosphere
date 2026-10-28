# Look pass 1

The first look pass after the creature overhaul (M6 T14, ADR 0024): body plan v2 (T6–T9), mesh v2 (T10), motion (T11), inner anatomy (T12) and glass materials (T13), judged against `docs/art/reference-02.jpg` to `reference-05.jpg`, then tuned.

- Sheet: `pass-1.png`, from `npm run gallery -- --pass 1` (1600×1000, pixel ratio 1, high preset, gait time 0.6 s, dark water), rendered after this pass's fixes and again after the body proportions of M6 T14b (below). Two captures from one build are byte-identical.
- Specimens: the 20 baseline files plus the 16 of T9 (21–32 one per silhouette class, 33–36 one per rarity tier).
- Method: each reference sheet and the sheet were opened side by side, and twelve cells (01, 05, 08, 13, 24, 26–31, 36) were also checked enlarged two-fold, before and after every change.

## What this pass changed

Before the fixes, the sheet already had glass, organs, glints and fine parts, but three things hid them:

- Every shell was a milky, half-opaque bubble. The face was filled with the silver core colour, and the body loft was nearly a sphere (depth 0.85), so the fresnel rim was wide and soft.
- Every filter or wide mouth drew an opaque pale crescent over the front third of the body.
- The organs were spread evenly over the whole disc like polka dots, and thin legs and bead tips were dark glass with only their edges lit, so they read as hollow bubbles.

The fixes are tuning only (shader, mesh and anatomy constants; no rule, plan or stat changed):

- **Shell**: the body loft is flatter (depth 0.65), the face is darker and clearer (core `0.15 + 0.3 z`, alpha 0.2–0.5), and the fresnel is steeper, so the rim is a crisp bright line around clear glass. The rim is a little brighter (1.8×) and stays the brightest ring of every body (T13's check). Shell markings are fainter (0.2), so they read as structure, not paint.
- **Mouth**: a warm, denser lip that is brightest at its edge (alpha 0.7–1), not an opaque cap.
- **Organs**: chambers and droplets cluster along the midline (within 55% of each segment's half-width), so the outer band of the shell stays clear, as in 02 and 03. Their sizes vary more (±45%). Chambers are glassier, with a brighter wall and a clearer centre.
- **Appendages**: legs, antennae and bead tips are lit through their whole width, so they read as bright glass strokes against the water rather than dark rings.

## Body proportions (M6 T14b)

Gaps 1 to 3 below were development, so M6 T14b changed it (ADR 0028) and the sheet was rendered again. Karyotype v2 bodies (21–36) changed; the v1 baseline (01–20) did not.

- **Trunk**: in front of a chain the head is drawn at 0.65 of the core, and the trunk is 0.8 core radii wide and fits its reach by shortening its segments first. The median trunk segment of the 12 silhouette specimens went from 0.1–0.2 to 0.53 core radii. The shrimp (27), the crab (30) and the fan tail (32) now read as a head with a segmented trunk behind it, and the coil (29) shows its coiled chain.
- **Parts**: a part that would leave the bounds sweeps along the body instead of being cut, so antennae, ring parts and wings keep their gene length (on random v2 bodies: antennae 97%, ring parts 95%, wings 76%, against 61%, 94% and 51% before). The genes still allow at most 1.5 core radii, so no antenna reaches the length of 02's.
- **Rings**: a radial body drapes half as far, so its front parts turn sideways and its rear ones back: the bell's (24) tentacles now spread round it instead of bunching behind it.

## Gap table

Scores: 0 holds up next to the reference, 3 is far off. Pass 0's scores are in `pass-0.md`.

| Aspect | 02 | 03 | 04 | 05 |
| --- | --- | --- | --- | --- |
| Silhouette variety | 2: The shrimp (27), crab (30) and fan tail (32) now have a trunk as wide as the head, so they read as segmented bodies, and the coil (29) shows its coil (T14b). They are still stubby next to 02's long copepods, the worm (28) is lost in its parts, and most other bodies are round cells. | 3: The bell (24) now spreads its tentacles round it, but 03's flowers, spirals and long-bodied crab have no counterpart, and most neighbours still differ in their fringe rather than their outline. | 3: 04's moths, wide crabs and plume-tailed tadpoles need bodies several times longer than wide; ours are at most about twice as long, inside the 2.5 bound. | 3: 05's nautilus coil, winged plankton and big-eyed larvae are absent. The tadpole (25) and the winged specimen (31) still read as a ball with a tuft. |
| Translucency | 1: The shells are now clear glass, with the dark water and the organs showing through and a crisp bright edge, close to 02. They are darker inside than 02's backlit bodies. | 1: 03's shells are nearly invisible apart from their outline, and ours now are too. The carapace over 30 still doubles the outline. | 2: 04's bodies are glassy but glow from within; ours are clear but dark inside. | 2: 05's light passes through the whole body; ours shows the water, not light. |
| Inner detail | 2: A gut line, coloured chambers, oil droplets, a heart spot and eye pigment now show, clustered along the midline. 02's organs are large, overlapping masses with segment boundaries; ours are small separate dots. | 2: 03's droplet clusters fill the body in colour. Ours are fewer and smaller, and there are no segment walls. | 2: 04 is packed with lit chambers. Ours are sparse, and the organs of larger bodies (07, 08) look like a dotted line. | 2: 05 has organ clusters, segment boundaries and big dark eyes. Ours has the clusters only, and the eyes sit on stalks outside the body. |
| Fine appendages | 2: Setae fans (27), jointed legs with beads (08, 13) and bead-tipped spines (23, 35) are bright, and since T14b long parts keep their length by sweeping along the body. 02's antennae are as long as the body and sweep round it; ours are at most 1.5 core radii. | 2: 03's bead-tipped tentacles are thin with small pearls. Our bulb tips are large glass balls that clump into bubble clusters (26, 36). | 3: 04's legs carry dense, evenly spaced bristles along their whole length. Ours have few, and most parts are bare. | 3: 05's long sweeping antennae and pincers are missing. Our chelae (29, 32) are too small to see at this size. |
| Palette | 1: The shells are silvery and clear, and the colour lives in the organs, as in 02. Some common bodies (01, 02, 03) still have one strong organ hue throughout. | 1: 03 keeps crystal bodies with faint colour inside, as ours do now. 03 mixes several organ hues per body; ours mostly have one hue plus amber droplets. | 2: 04's saturated colour sits in organs and glints over a clear body, which matches our structure, but our exotic bodies are not more colourful than the common ones. | 2: 05's colour level is higher than any of our bodies, including the exotic tier specimen (36). |
| Rare glints | 1: Common bodies are plain and the exotic ones carry a few star points. 02 also has small specular points along legs and joints on plain bodies, which we lack. | 1: 03's tiny bright points on beads and tips are close to our glints, though ours sit on rare bodies only. | 2: 04 glitters all over; our exotic specimen (36) has a dozen glints, well short of 04's intensity. | 2: 05's jewel-like sparkle is the ceiling; ours is in the right direction, but no specimen comes near it. |
| Lighting | 1: The rims are now thin and bright, with a wet highlight and refraction, close to 02's white rims. There is no soft glow from inside. | 1: 03's thin bright outlines over clear bodies match ours now. 03's bodies also catch light on every joint. | 2: 04's bodies are lit from within with many hot points; ours have a rim and organ glow only. | 2: 05's backlit glow and edge highlights are stronger and more varied than our single rim. |

## In-game check

A 960×540 screenshot at default zoom (medium preset) with the shrimp (27) as the player and six gallery bodies around it as remotes (`debug.setRemotes` with 08, 24, 26, 28, 30 and 31):

- The bodies stay readable at this size. Each one reads as a clear glass body with a bright rim, a coloured midline of organs and a white fringe of parts. Neighbours can be told apart by their fringe (legs, setae fans, sheets), not by their outline, which is gap 1.
- Detail does not fight the silhouette. The surface detail has faded out at this size, the organs stay inside the outline, and the rim stays the strongest edge.
- At the medium level of detail, organs are 6-sided and read as small hexagons when enlarged. This is invisible at 1×.
- The mouth is quieter than before: a lip at the front, not a pale cap. T21 checks mouths, claws and plates at default zoom, and may want it stronger.

## Largest gaps

In order of visual impact. Gaps 1–3 were development; M6 T14b (ADR 0028) addressed them as far as the 2.5 bound allows, and what is left is noted with each.

1. Proportions (T14b: partly). Trunks now carry the body (median 0.53 core radii), but a body fits in 2.5 core radii around a core of radius 1, so it is at most about twice as long as wide, and the head is still a large dome. The long copepods and shrimp of 02 need either a smaller core inside a longer body or a larger bound; both are rule changes for a later milestone.
2. Parts are short next to the references (T14b: partly). Parts keep their gene length by sweeping along the body, but the gene range stops at 1.5 core radii, and a long part far back on the body is still cut. Antennae as long as the body need a longer range.
3. Radial bodies (T14b: done for the ring). The bell's tentacles spread round it; spiny larvae keep their even spines. A bell's tentacles are still few and thick next to 03's.
4. Bulb tips and joint beads are drawn as large glass balls and clump into bubble clusters (26, 36). They should be small solid pearls (mesh: bulb radius on screen, and shading).
5. Organs are small, evenly sized dots. The references show large, overlapping organ masses that fill the trunk and glow, with segment walls between them (anatomy: organ size share and overlap; shader: an inner glow and segment lines). The wider trunks of T14b leave room for them.
6. There are no specular points along edges and joints on plain bodies (02, 03). Glints are rare-only by design, so these must be wet highlights, not glints (shader).
7. Exotic bodies are not more colourful than common ones. Above the glints, the rarest tier could carry more organ hues and stronger glow (palette, toward 04 and 05).
8. Long parts swept along the body can crowd it (the worm, 28): a part that sweeps could also curl or thin, so the body stays readable.
