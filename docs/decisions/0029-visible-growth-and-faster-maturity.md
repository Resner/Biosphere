# 0029: Visible growth and faster maturity

- Status: accepted (supersedes the maturity minimum in 0019: max(12 min, 20% of the lifespan); amends 0022's pacing targets)
- Date: 2026-10-28

## Context

The owner's v0.6.0 playtest (#134) found that progression feels slow: "you don't really see yourself getting much bigger, and it takes a long time to even reach maturity".

- **The camera hides growth.** The half-height was `9 · r^0.9`, which grows almost as fast as the creature, so tripling the radius made it look only 12% bigger.
- **Maturity is gated by time, not size.** `npm run sim:pacing` (12 genesis cells, a food-seeking bot) shows biomass doubling in a median 1.4 min and reaching 60% of the adult biomass in 1.5 min, but the median first eligibility is 17.4 min, because maturity needs max(12 min, 20% of the lifespan) of active time. The wait is the time rule alone.

The spec asked for bot medians of 2–4 min to double and 6–10 min to 60% of adult size. Measured, the bot is already faster than that, and slowing it down would make a real player, who is 2 to 3 times as slow as the bot, slower still: the opposite of the feedback. The bands read as player pace, so they become upper bounds on the bot.

## Decision

- **Camera.** The half-height is `9 · R^0.9 · (r / R)^0.6`, with `R` the radius at the genetic maximum biomass (`RULES.camera.growExp` 0.6). An adult sees what it saw before, at every `R`; anything smaller sees less, so tripling the radius shows 3^0.4 ≈ 1.55× larger, and a hatchling never sees fewer body lengths than before (`(R / r)^0.3 ≥ 1` times the old view). A creature past its stated maximum counts as an adult.
- **Maturity** needs active time of at least max(7 min, 10% of the lifespan) and 60% of the maximum biomass (`matureMinMs` 420,000, `matureMinShare` 0.1). The bot's median first eligibility falls from 17.4 to 8.7 min. The mating cooldown (9 min) is unchanged; a full life now fits a median 9 matings (8–10), still inside ADR 0022's 4–9 median target.
- **Growth rate** (`RULES.growth.maxRate`) stays. It is not the limit: food is.
- **Pacing targets** (`npm run sim:pacing`): median doubling within 4 min, median 60% of adult size within 10 min, median first eligibility 7–10 min, median matings per life 4–9.
- **Presentation.** The HUD shows "Size 62% of adult" (biomass share, the quantity maturity needs 60% of) with a thin bar and, once the size is enough, "Mature in 4:10" from the authority's `matureAtMs` and the local life clock. A soft ring marks each new tenth of the adult size, and a wider, slower one a new size tier; size lost to a mating or a bite does not cue again when it is regained. The sound arrives with the audio engine (T23).

## Consequences

- Maturity is not part of the sim state, so no golden changes and `RULES_VERSION` stays 6 (rules 6 has not been released yet). The Worker reads the same table, so the authority's `matureAtMs` follows.
- The mating loop opens about twice as early, so M7's combat and growth economy get tuned against a creature that can breed at 8–9 minutes.
- Camera tests pin the three growth properties; the pacing report prints the new measures and verdicts.
