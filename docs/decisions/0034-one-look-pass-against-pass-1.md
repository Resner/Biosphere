# 0034: M6b judges the look in one pass, against pass 1

- Status: accepted (amends 0024; supersedes 0033's plan; its palette (the complementary accent, amber droplets), its face and "specimens are never replaced" are amended by 0043)
- Date: 2026-10-30

## Context

The owner judged the v0.7.0 look on Playtest #183. Pass 1 (`docs/art/gallery/pass-1.png`, rendered at commit e90b4af) looked the most realistic. Passes 2 to 5 added a milky haze and an artificial glow, made the organs larger and spread their colours apart, and let overlapping parts clip to white (cells 07, 08, 31, 37, 38 and 39 of pass 5). Long bodies still do not read as worms, shrimps or copepods. The owner asked for one milestone without a series of passes.

ADR 0024's bar (no gap-table cell above 1 against references 02 to 05) pulled passes 2 to 5 toward the intensity of references 04 and 05. `docs/art/README.md` already calls that intensity the ceiling for the rarest creatures, and five passes never met the bar.

Measured at spec time on the committed sheets, the white areas are countable. A "solid white" pixel has min(R, G, B) ≥ 245 and all eight neighbours do too, so thin rims and glint points do not count. On pass 5, cells 31, 37 and 39 have 330 to 430 such pixels, cells 07, 08, 29 and 38 have 22 to 72, and most cells have 0 to 5.

## Decision

- **Pass 1 is the realism baseline** for the shell, the organs, the palette and the light. `pass-1.png` and `pass-1.md` stay in the repository for good, and milestone pruning keeps them.
- **The haze and the glow come out.** These additions of passes 2 to 5 are removed:
  - the organ halos;
  - the scattered-light band inside the rim;
  - the denser organ glows at play zoom;
  - chambers that glow from their centre.

  Organs go back to pass 1's size and midline band. Detail work the owner did not object to stays: pearl bulb tips, wet joint points, faint segment walls, lens eyes set into the head, plumose setae, clear broad parts, the fainter gut and long antennae.
- **Palette.** All of a body's organs share one hue, within 0.06 turns of the hue gene, with droplets turned toward amber as in pass 1. A body may add one complementary accent (0.5 ± 0.05 turns from the gene hue). Rarity raises saturation, luminescent photophores and glints, never the spread of hues.
- **Clipping is a test.** Every gallery cell has at most 12 solid-white pixels, as defined above, and so does every body in the in-game check.
- **One pass.** M6b commits exactly one sheet, `pass-6.png` with `pass-6.md`, after every look, body and HUD task. The note keeps ADR 0024's gap table and adds an "Against pass 1" table, in which each aspect is `better`, `same` or `worse` than pass 1, with a sentence.
- **The bar for pass 6:**
  - no aspect is worse than pass 1, and silhouette variety and fine appendages are better;
  - against 02 and 03, no cell is above 1;
  - against 04 and 05, judged on the rare and exotic specimens only, no cell is above 2.

  If the bar fails, the pass names the remaining gaps and the owner judges them at the gate. M6b has no pass 7.
- **Specimens are still never replaced** (0024, 0032). When rules 7 moves a body class or a look feature, a new specimen joins the sheet.

## Consequences

- The look is judged against the image the owner preferred, not only against the references, so the intensity of 04 and 05 no longer pulls common bodies toward glow.
- The detail that passes 2 to 5 added survives, while their haze and glow do not.
- A later change cannot bring white clipping back unnoticed, because the gallery and in-game tests guard it.
- Rejected:
  - reverting the render code to the pass 1 commit, which would drop the pearls, set-in eyes, plumose setae, clear broad parts and long antennae;
  - keeping ADR 0024's bar with more passes: the owner asked for one pass, and five passes drifted;
  - judging against pass 1 alone, when the references still set the bar for silhouettes and fine detail.
