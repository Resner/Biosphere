# 0043: Glass with pass 1's sheen, organs in two related tones, gallery specimens per rules

- Status: accepted (amends 0034's palette and haze rules, and 0024 and 0032's "specimens are never replaced")
- Date: 2026-11-01

## Context

On Playtest v0.7.1 (2026-11-01, in a Claude session), the owner found M6b overshot ADR 0034:

> "You made the creatures fully see-through instead of opaque like in pass-1 (before, the creature was looking 3D-ish due to some slight hazy defractions on top)."

> "Organs not looking like in pass 1 (maximum two-color organs and similar colors with different hues/tones) - you can make some of them glow ever so slightly."

> "Align Eye colors to the main organ color."

M6b T3 cut the body's face from pass 1's `uCore × (0.15 + 0.3z)` to `0.05 + 0.13z`, and replaced pass 1's soft fresnel rim (`fres^2 × 1.8`) with a hairline. 0034's palette allows a complementary accent, and its oil droplets are always amber. Glint rays take either colour. Together these read as several unrelated hues per body.

ADR 0040's reset and ADR 0041's region rules change most bodies, so the gallery's specimens no longer stand for their silhouette classes.

## Decision

- **The glass face and rim are pass 1's**: core `0.15 + 0.3z` and a fresnel rim of power 2 to 1.4 (by membrane) at ×1.8. Limbs, membranes and setae share that model, so a limb's edge sits within ±15% of the body rim's luminance. The milky additions of passes 2 to 5 stay out: no haze layer over the face, no scattered-light band, no organ halos.
- **Two related tones**: an organ palette has the main colour (the hue gene) and one second tone, analogous to it (0.04 to 0.10 turns away, at another value), never complementary. Chambers alternate tones by a hash, oil droplets take the second tone instead of fixed amber, and glint rays use only these two. Rarity raises saturation, glints and glow, never the hue spread.
- **A faint inner glow**: at most 2 organs per body (the heart, or the largest chamber) glow inside their own outline, at most +15% luminance, or +35% with the luminescence gene. Nothing glows outside an organ.
- **Eyes take the main organ colour** in the iris; the pupil stays dark.
- **Specimens follow the rules after a reset.** After a world reset (0040), the gallery's silhouette and rarity specimens are rebuilt for the new rules by `tools/specimen.ts`, each in its class's old cell. Genesis baseline cells 01–06 keep their genomes, since their round cells are comparable with pass 1. The pass-1 sheet stays the realism reference.

## Consequences

- Bodies read as volumes again, and colour stays calm: two related tones per body.
- The pass-1 comparison is made on cells 01–06 (the same genomes and shapes). Later cells are judged by eye against pass 1 and the references.
- Rejected:
  - restoring passes 2 to 5's haze (the owner disliked it on v0.7.0);
  - a complementary accent for rare bodies (the owner asked for similar colours);
  - keeping old specimens that no longer show their class (the sheet would mislabel them).
