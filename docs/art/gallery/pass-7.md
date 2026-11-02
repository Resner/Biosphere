# Look pass 7

M6c's one sheet (T13, ADRs 0034 and 0043), rendered once under rules 8 after every body, glass and organ task of the milestone (T3–T7). It is judged against `pass-1.png`, the realism baseline, and against `docs/art/reference-02.jpg` to `reference-05.jpg`. It is a record, not a tuning pass: nothing was changed for it, since no T3–T7 acceptance fails on it.

- Sheet: `pass-7.png`, from `npm run gallery -- --pass 7` (1600×1000, pixel ratio 1, high preset, gait time 0.6 s, dark water). The sheet the look specs capture from the same build is byte-identical to it.
- Specimens: 01–06 are the genesis baselines of pass 1 (the same genomes and round shapes), 07–20 are Evolved picks (ADR 0046), 21–36 are the silhouette and rarity specimens and 37–40 the M6b additions, all drawn as rules 8 develops them. The sheet is 8 by 5.
- Method: each reference sheet, `pass-1.png` and `pass-6.png` were opened side by side with the sheet. Every cell was enlarged three-fold, pass 1, pass 6 and this pass side by side for 01–06, pass 6 and this pass for 07–40, and 22, 31, 35, 37 and 40 four-fold. Nothing was scored from memory.
- Measures on this sheet (`m6c-glass`, `m6c-organs`, `m6b-look`, `m6b-clip`: 13 passed):
  - Face, clear of organ light, on 01–06 against pass 1: 65/72, 94/88, 49/50, 85/74, 68/68 and 78/70 (all within ±15%). The shell's median excess over the water is 48.7 against pass 1's 68.2, so it is less milky than pass 1, not more.
  - Limbs over the body rim: 0.90–1.04 on every judged cell (bar 0.85–1.15). The mouth's darkest tenth over the face's: 0.91–1.53 where both are judged (bar 0.8).
  - Organs: two hue clusters at most 0.076 turns apart per cell (bar 0.1), with at most 1.3% of a cell's organ pixels outside both (23). Every iris is within 0.003 of the main hue (bar 0.05), and no glow pixel lies more than 2 px outside its organ.
  - Solid white: 0 pixels in every cell, and 0 in the in-game check at medium and high (bar 12). Colour within 1.3 organ radii: at least 90% in every cell (bar 85%).

## The owner's points

One sentence for each row of the spec's table (#212), as the sheet shows it:

1. **The wipe** (T1, T2): every cell is drawn by the one live version, rules 8; 01–06 keep their genesis genomes, now stored as v2.
2. **"Not real, organic creatures … 20 antennas or limbs … spaceship"** (T3–T5): the spoke forests and rigging of pass 6 (07, 08, 11–13, 38) are gone, and no cell shows more than 14 parts. Parts now curve and taper, and the rare bodies with a leg ring (23, 35) read as larvae close to 02's Crystalis. But the honest pitfall is the opposite one now: the Evolved picks (07–20) are mostly bare chains of three to five pills with a few short legs. Only 35 and 37 carry long antennae, so the sheet reads more as larvae and caterpillars than as the references' leggy, antenna-framed copepods.
3. **"Curled up, intended?"** (T3): yes. The coil now reads as a spiral: 39 is a clear coiled chain inside its outline, and 29 a tight spiral without the bristle knot of pass 6. 28 is a C-curled worm.
4. **"White silhouettes, gray limbs like a foreign body"** (T6): the grey is gone. Limbs are the body's glass at the rim's brightness (ratio 0.9–1.04), and no cell clips. But on leggy bodies (27, 38, 40) the bright limbs and setae now add up to white feathery masses. The rim and limbs together read as a white outline drawing more than pass 1's soft silver, which is close to the owner's "very visible white silhouettes".
5. **"Dark unfilled half-circle … the mouth?"** (T6): the dark disc is gone, and the front of the body is glass (the darkest tenth is at least 0.91 of the face's). The new mouth is a narrow funnel with a fringe of cilia. At gallery size it reads as a small bright tuft at the nose, not yet clearly as a mouth.
6. **"Fully see-through instead of opaque like pass 1"** (T6): the face matches pass 1 on 01–06 (within ±15%), and pass 1's soft sheen inside the edge is back (01, 05, 22, 34). Bodies are still dark inside next to pass 1's, because pass 1's luminous midline band, which lit the glass around it, stays out (ADR 0043).
7. **"Organs like pass 1, maximum two colours, some glow ever so slightly"** (T7): every body keeps to two related tones (01 yellow and amber, 06 red and orange, 23 orange and red), and the complementary accents of pass 6 are gone. The glow holds inside its organs but is barely visible at gallery size.
8. **"Align eye colours to the main organ colour"** (T7): every iris is in the main hue (21, 26, 28, 32, 35). At this size the dark pupil dominates, though, so stalked eyes (08, 11, 25, 28, 31, 32) read as coloured rings, like goggles.
9. **Firefox aliasing and flashing** (T8): not on this sheet, which is Chromium. `m6c-firefox` and `m6c-flash` run in `E2E full`, and the owner's own Firefox decides.
10. **Damage as distinct hits** (T9): not on the sheet. `m6c-hits` and `Shake`'s unit tests cover it, and feel is the owner's call.
11. **Caustics and god rays stronger in the shallows** (T10): not on the sheet, which uses dark water. `m6b-water`, retargeted, covers it.
12. **A static background during the hatch** (T11): not on the sheet. `m6c-egg` checks that the background holds still.
13. **A more interactive egg, "maximise the gacha"** (T11): not on the sheet. `m6c-egg` checks the charge, the paced crack and the true tier.
14. **A smoother minimap arrow** (T12): not on the sheet. `m6c-minimap` checks the arrow frame by frame.
15. **The white dot on the minimap's border** (T12): not on the sheet. The dot is gone for a depth gauge (`m6c-minimap`).

## Against pass 1

| Aspect | Against pass 1 |
| --- | --- |
| Silhouette variety | better: Pass 1 had one stubby head-and-trunk shape. Now there are segmented chains (07–14, 17, 18), a clear spiral (39), a tight coil (29), a copepod with long antennae (37) and leg-ringed larvae (23, 35). |
| Translucency | same: The face is pass 1's on cells 01–06, within ±15%, with its soft sheen inside the edge, and the shell is less milky (excess 48.7 against 68.2). |
| Inner detail | same: The organs keep pass 1's size and midline place. Pass 1's bright midline band is fainter, and the faint glow is barely visible at this size. |
| Fine appendages | better: Pass 1's short, broad, bare parts are now tapered, curved strokes of the body's glass, with bulb tips only where a gene earns them (35). But the Evolved bodies carry few of them. |
| Palette | same: As in pass 1, each body's organs keep to one hue and a related second tone. The third hues and complementary accents that crept in after pass 1 are gone. |
| Rare glints | same: As in pass 1, common bodies are plain and exotic ones carry star points on pearls and joints. |
| Lighting | same: As in pass 1, a bright rim is the brightest ring of every body. The limbs now match it, so leggy bodies (27, 38, 40) read whiter than pass 1's, without clipping. |

## Gap table

Scores: 0 holds up next to the reference, 3 is far off. The 04 and 05 columns judge the rare and exotic specimens only (ADR 0034). Pass 6's scores are in `pass-6.md`.

| Aspect | 02 | 03 | 04 | 05 |
| --- | --- | --- | --- | --- |
| Silhouette variety | 2: Unchanged. No spaceships are left, and 35 and 37 frame their bodies like 02's Crystalis and Luminico. But the Evolved chains (07–20) are bare and small in their cells, where 02 frames every body in long legs and antennae. | 2: Unchanged. 39 is now a real spiral, as in 03's Thalenus and Spiridra, and 24 a fringed bell. 03's flowers, medusae and wide crabs are still missing. | 2: Unchanged. 37's long antennae and 27's feathered trunk match 04's copepods. Its moths, wide crabs and plume tails do not. | 2: Unchanged. The spiral (39) and the S-worm (40) have counterparts, but both are small, and 40's S is lost under its bright plates. |
| Translucency | 2: Unchanged. The face is pass 1's soft glass again, not a hairline, but dark inside, where 02's bodies glow pale from within. | 1: Unchanged. 03's nearly invisible shells with bright outlines match ours. | 2: Unchanged. 04's bodies are lit from within; ours show the dark water. | 2: Unchanged. 05's light passes through the whole body. |
| Inner detail | 2: Unchanged. The organs are two-tone chambers of pass 1's size along the midline, where 02's are large, overlapping coloured masses. Many Evolved chains show only a few small dots. | 2: Unchanged. 03's droplet clusters fill the body; ours are a few chambers along the midline. | 2: Unchanged. 04 is packed with lit chambers end to end. | 2: Unchanged. The irises now take the organ colour, as 05's eyes suggest, but they read as rings, and the packed, glowing organs are missing. |
| Fine appendages | 2: Was 2. Legs and antennae now curve, taper and match the glass (35 reads close to 02's Crystalis). But at most 14 parts, often 0–4 on Evolved bodies, can't give 02's dense frame of beaded legs. | 1: Unchanged. 03's thin, bead-tipped tentacles match 35's curved legs with bulb tips. | 2: Unchanged. The feathered trunks (27, 38) read as combs, but brighter and whiter than 04's fine bristles. | 2: Unchanged. 37 has 05's long antennae, but its big pincers and its bristles on every leg are missing. |
| Palette | 1: Unchanged. The organs keep to two related tones in a clear shell, as 02's do. | 1: Unchanged. 03's faint colour inside crystal bodies matches ours. | 2: Unchanged. 04's many saturated hues per body lie outside the two-tone rule (ADR 0043) by choice. | 2: Unchanged. 05's colour level is above any of our bodies. |
| Rare glints | 1: Unchanged. Common bodies are plain, and exotic bodies carry star points on pearls and joints. | 1: Unchanged. 03's small bright points on beads and tips match ours. | 2: Unchanged. 04 glitters all over; our exotic bodies carry a dozen or so stars. | 2: Unchanged. 05's jewel-like sparkle is the ceiling. |
| Lighting | 1: Unchanged. A bright rim with limbs of the same light, close to 02's white rims and legs. | 1: Unchanged. 03's thin bright outlines match ours. | 2: Unchanged. 04's bodies have many hot points inside; ours have the rim and the glints. | 2: Unchanged. 05's backlit glow and edge highlights are stronger and more varied. |

**The bar (ADR 0034) still fails on the same six cells as pass 6, all against 02 and 03:**
- silhouette variety × 02 and × 03;
- translucency × 02;
- inner detail × 02 and × 03;
- fine appendages × 02.

The rest holds:
- no aspect is worse than pass 1;
- silhouette variety and fine appendages are better than pass 1;
- no 04 or 05 cell is above 2.

M6c changed the kind of gap more than its score. The spaceships and grey limbs are gone, and so are the dark mouth and the many organ hues. What is left is sparseness: bodies that read as organisms, but plainer and smaller than the references'. The owner judges this at the gate.

## Largest gaps

In order of visual impact. M6c allows no further pass, so these go to the owner at the gate.

1. Evolved bodies are sparse. 60 bred generations give pill chains with 0–4 short legs, and only the hand-picked 35 and 37 carry long antennae. The references frame nearly every body in long legs and antennae. Development or the Evolved aims would need to favour a long antenna pair, without breaking the 14-part budget (ADR 0041).
2. Whiteness on leggy bodies. With limbs at the rim's brightness, dense setae (27, 38) and flat plates (40) read as white feathery masses at gallery size, with no clipping. This is near the owner's "very visible white silhouettes". The fix would be fainter setae, not darker limbs.
3. Translucency against 02: the glass is pass 1's again but dark inside. 02's bodies glow pale from within, which ADR 0043's no-haze rule rules out. The owner decides whether a soft inner light belongs in the glass.
4. The mouth reads as a bright tuft at the nose, not a mouth, at gallery size. Stalked eyes read as coloured rings.
5. Organs are separate small chambers, and their faint glow is barely visible at this size. The references are packed with large, glowing organ masses.
6. The 04/05 ceiling for the rarest bodies: glowing interiors, saturation and glitter.
