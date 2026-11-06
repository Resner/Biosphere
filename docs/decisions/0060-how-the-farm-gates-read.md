# 0060: How the bot-farm gates read: genes aside, one cooldown after maturity, the floor aside

- Status: accepted (refines 0059's gates 1, 2 and 3)
- Date: 2026-11-06

## Context

ADR 0059 states five gates for the bot-farm simulation in a sentence each. Building the simulation (`worker/farm.test.ts`, `tools/farm-sim.ts`) showed that three of them, read literally, either can't be measured against a baseline or can't hold for any rules:

1. "The farmer reaches generation 3 no sooner than the honest pair." The two runs draw different genomes, and the maturity time is `max(7 min, 10% of the lifespan)` of each genome, so two honest runs differ by minutes (8.8 to 10 min) with no farm in sight. A single comparison of two times measures genes.
2. "At most 60 ÷ 9 children per hour of a creature's active time." A creature that mates once at 8 min of active time has 7.5 children an hour, over the bound, and a promoted child starts a new creature with a new cooldown.
3. "A bot identity's kills are worth at most 2 full kills in 24 h." Worth halves up to 6 times and then stays at 2^-6, so the sum of any number of kills is 2 − 2^-6 for the first 7 and 2^-6 more for each after.

## Decision

1. **Time shortcut, measured against the creature's own gate.**
   - A farmer's lineage reaches generation 3 no sooner than the sum of its first three creatures' own time gates (`matureAtMs`, from the ack) and no sooner than 3 × 7 minutes.
   - A creature of the lineage's first three waits, beyond its own gate, to grow and to be ready. A farmer's creature waits at most one report (30 s) less, on average, than the honest pair's. Genes cancel, because the wait is taken from each creature's own gate.
2. **Breeding shortcut, one cooldown after maturity.** A creature has at most `1 + ⌊(active time at its mating − its maturity time) ÷ cooldown⌋` children: the first child once mature, then one per cooldown (9 min). A creature that mates and is then promoted past counts one child.
3. **Biomass from nothing, the floor aside.**
   - Every kill pays at most its victim's biomass × worth (reward plus carrion), and the farmer's kills in all pay at most what the victims held.
   - A bot identity's kills sum to at most 2 full kills, not counting the 2^-6 each kill past the 7th pays at the floor of the halvings. That floor is ADR 0059's explicit limit, and each such kill still needs a victim of comparable size, so a farm pays for it in regrowth.

Gates 4 and 5 stand as written. The simulation also runs one more identity than the bots, a fresh one killed at 10 minutes of play, so that gate 4 measures a young victim and not a rule's table.

## Consequences

- `tools/farm-sim.ts` states the gates as these three readings, and `tools/farm-sim.test.ts` fails each one on a farm that breaks it.
- A future change that lets a farm lead the honest pair by more than a report, pays a child inside its cooldown or pays more than a victim held fails `worker/farm.test.ts`, and the PR names the shortcut and fixes the rule (ADR 0059).
