# 0036: Top speed lives in a band

- Status: accepted (amends 0006: function follows form within a speed band)
- Date: 2026-10-30

## Context

On Playtest #183 the owner asked whether creatures that are "sometimes way too fast" are a bug or the design. Top speed is `140 × thrust × (b/100)^−0.1 ÷ (2.2 × drag)` wu/s. The thrust and drag multipliers each come from form, clamped to 0.1–4 (`RULES.body`), so their ratio can range from 0.025 to 40 times the M1 starter's.

A probe of rules 6 at spec time (2026-10-30; `statsAt` at biomass 80 over 1,000 genesis seeds) found:

| Measure | p10 | Median | p90 | Max |
|---|---|---|---|---|
| Top speed (wu/s; M1 starter 64) | 5.8 | 105 | 217 | 250 |
| Screen heights per second at default zoom (M1 starter about 0.45) | 0.04 | 0.64 | 1.32 | 1.55 |

Bodies bred for six generations spread the same way. Hatchlings are faster than adults, because a whip's efficiency rises as size falls. M6 T9 checked only the adults' median (within 15% of v5's).

So it is the design, not a code bug, but the design lets some bodies cross the screen in under a second while others barely move.

## Decision

- **The band.** Under rules 7, `statsAt` passes the top-speed multiplier through a strictly increasing soft clamp into 0.6 to 1.6 (`RULES.stats.speedBand`), by rescaling thrust. The multiplier is thrust ÷ drag, relative to the reference cell at the same biomass. The clamp leaves a middle range unchanged.
- **Only thrust changes.** Drag, turning, mass and every other stat are untouched. A dash scales with √(thrust ÷ drag), so it follows, within √0.6 to √1.6.
- **Function still follows form.** A faster form stays faster, only by less.
- **Targets:**
  - every body is within the band at every size (a property over random and mutated genomes);
  - genesis hatchlings have a median of 1.0 to 1.3 times the starter.
- **The bug candidates are checked too:** remote interpolation, the loop's catch-up after a stall, and the camera (M6b T1). A real bug found there is fixed as well.

## Consequences

- The spread of top speeds falls from 40× to about 2.7×. Anatomy still matters, and no creature crosses the screen in a blink or crawls.
- The fastest bodies also accelerate less, because thrust carries both. The archetype tests, the tournament and the pacing report are rerun.
- Rejected:
  - narrowing the `RULES.body` multiplier range, which would still let the ratio span 16×;
  - a speed cap in the sim, which would hide the real `phys` behind a second rule;
  - a camera change: the outliers are real speeds, not an effect of the zoom.
