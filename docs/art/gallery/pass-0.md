# Look pass 0: the baseline

The v1 creatures before the M6 overhaul (T5, ADR 0024), judged against `docs/art/reference-02.jpg` to `reference-05.jpg`.

- Sheet: `pass-0.png`, from `npm run gallery -- --pass 0` (1600×1000, pixel ratio 1, high preset, gait time 0.6 s, dark water). Two captures from one build are byte-identical.
- Specimens: the 20 baseline files in `tests/fixtures/gallery/` (01–06 genesis cells, 07–13 the Lab's wild mode, 14–20 bred children), each with a one-line comment on its origin. Later passes add specimens after them and never replace one.
- Method: each reference sheet and `pass-0.png` were opened side by side, and the bodies were also checked enlarged two-fold.

## Gap table

Scores: 0 holds up next to the reference, 3 is far off.

| Aspect | 02 | 03 | 04 | 05 |
| --- | --- | --- | --- | --- |
| Silhouette variety | 3: All 20 are one round or oval core with short legs trailing behind it; 02 has copepods, an S-worm, a curled shrimp, a winged manta and a jellyfish, and no two neighbours match. | 3: 03 is bells with bead tentacles, flower petals, spiral coils, a crab and a fish larva; nothing on our sheet curves, coils, spreads petals or forms a bell. | 3: 04's winged moths, crabs, a tadpole with a tail plume and spined spheres have no counterpart; ours differ only in leg count and core size. | 3: 05 adds a nautilus coil, wide-winged plankton and big-eyed larvae; our sheet reads as one species in many colours. |
| Translucency | 3: Our bodies are opaque, evenly filled discs with a frosted edge; 02's shells are clear glass that shows the dark water and the organs through them. | 3: 03 is almost pure clear glass with a bright outline; even our whitish wild bodies (07, 10, 12) look milky and solid. | 3: 04's bodies are glassy under the glitter; ours have no see-through areas at all. | 3: 05's shells are clear with light passing through; ours block the water completely. |
| Inner detail | 3: There are no organs: no gut line, droplets, chambers or eyes, only painted stripes and spots on the shell. | 3: 03 shows clusters of coloured droplets and a gut in every body; ours show surface pattern only. | 3: 04's bodies are packed with lit chambers and glints; ours are empty inside. | 3: 05 has organ clusters, segment boundaries and dark eyes; we have none of them. |
| Fine appendages | 3: Our legs are thick, blocky, few and jointless; 02 has hair-thin antennae longer than the body, dense setae and jointed claws. | 3: 03 has bead-tipped tentacles, feathery fans and fine jointed legs; ours have no beads, setae, fans or claws. | 3: 04's legs carry evenly spaced bristles and its wings veined membranes; the most branched of ours (08, 10, 11) read as twigs, not setae. | 3: 05's long sweeping antennae and pincers are absent; nothing on our sheet is hair-thin. |
| Palette | 3: Common bodies (01–05, 16) are flat saturated yellow, violet or green all over; 02 keeps shells silvery and puts amber, violet and cyan inside only. | 3: 03 is crystal-clear and silvery with faint colour inside; ours is the opposite, strong colour on the shell. | 2: 04's saturation is as strong as ours, but it lives in glints and organs over a clear body, while ours is a uniform tint. | 2: 05's level of colour matches our brightest bodies, but it sits inside glass instead of painting the whole body. |
| Rare glints | 3: There are no glints at all; 02 has small specular points along legs and joints even on plain bodies. | 3: 03 shows tiny bright points on beads and tips; we have nothing that sparkles. | 3: 04 glitters all over; our exotic specimens (07–13, 18–20) look exactly as plain as the common ones. | 3: 05's jewel-like sparkle is the ceiling for the rarest creatures; we have no glint of any intensity, so rarity is invisible. |
| Lighting | 2: The fresnel rim and bloom give every body a luminous outline, close to 02's white rims, but there are no specular points or inner glow. | 2: 03's rims are thin bright lines over clear bodies; ours are wide and soft, and the body under them is lit evenly instead of glowing from inside. | 3: 04's bodies are lit from within with many hot points; ours have a rim only. | 3: 05's backlit glow and edge highlights are much stronger and more varied than our single soft rim. |

The empty room around each body is by design: the sheet gives every specimen the same core radius, sized for the longest body development allows (2.5 core radii), so passes compare. v1 bodies are compact and use little of it.

## Largest gaps

In order of visual impact; the tasks that address each are in brackets.

1. Silhouette: every body is a round core with short legs behind it. No curved or coiled spines, bells, radial bodies, carapaces, wings, fan tails, tagmata or eyes (T6–T9, T10).
2. Colour sits on the shell: common bodies are opaque and saturated all over, where the references keep a clear, silvery shell and put the colour inside (T12, T13).
3. No inner anatomy: no gut line, fluid chambers, oil droplets, heart spot or eye pigment show through (T12).
4. Fine appendages are thick and bare: no hair-thin antennae, setae, joint beads, bulb tips, claws or veined membranes (T8, T10).
5. Light is one soft rim: no wet specular points along edges and joints, no glow from inside, no refraction (T13).
6. Rarity is invisible: no glints on any body, so an exotic looks as plain as a common one (T13).
