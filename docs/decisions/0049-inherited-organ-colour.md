# 0049: The organs' second tone follows the inherited hue

- Status: accepted (amends 0043's rule that the second tone is always the main colour turned toward amber)
- Date: 2026-11-02

## Context

On Playtest v0.7.2 (2026-11-02) the owner liked the two-tone organs and asked (#263):

> "It would be nice if the children inherit the color of both parents (e.g. one dominant one and another recessive one with a clean gradient color / hue) - all while still limiting it at max two colors at once. I do like how it is already, try to keep it 90% like it already is and just make the inherited traits more visible."

ADR 0043 fixed the organs' second tone as the main colour turned 0.04–0.06 turns toward amber. It never showed that a child carries one hue from each parent.

## Decision

The genome already holds two haplotype hues, one from each parent. `hueSpread(genome)` (render data only, in `Creature.hueSpread`, outside `Traits` so no golden moves) is how far apart they lie, in turns. The main organ colour stays the expressed hue (the mean of the two). When half the spread reaches 0.04 turns (a spread of 0.08), the second tone is the other haplotype's hue instead of the amber turn: half the spread further round the wheel, capped at 0.16 turns. Below that the amber second tone stays, so a body whose parents agree looks exactly as before. Albinos keep their pinks. Still two tones, never a third, and never complementary.

## Consequences

- `materialParams(traits, tier, hueSpread)` takes the spread; `CreatureSource.hueSpread` carries it to the material cache (the mesh is keyed by genome hash, so one genome always draws one way).
- Siblings from differently coloured parents now show the second tone at visibly different hues.
- DESIGN §6 and the render rule describe the second tone.
