# 0068: The spawn band's floor near the centre

- Status: accepted (adjusts one number of ADR 0064's placement rules)
- Date: 2026-11-08

## Context

`place()` takes points at depth 0.27 to 0.7. The depth pin holds the spawn centre between 0.26 and 0.54, and the centre cap flattens the ground within 1,400 wu of it at `base − centreCap` = 0.26 wherever the noise runs shallow. About one world seed in ten (64 of 600 sampled seeds and ticks) has that flat 0.26 ground all around the centre, so nothing within P1 reach of the first player was valid: the second player landed 880 wu away and did not link at once. The `m12-lifecycle` scenario found it on a fresh hub (its release run, then three repeats in a row on one hub).

## Decision

Within `centreRadius` (1,400 wu) of the spawn centre the band's floor is 0.26, the cap's own floor; elsewhere it stays 0.27. `place()` and `inSpawnBand` (the wave's gate) read the same floor. UV starts at 0.27, so the 0.01 strip is a spawn the centre itself already gives.

## Consequences

Every world seed places a second player within P1 reach of the first (0 of 600 sampled placements beyond it). DESIGN.md's placement rule says so.
