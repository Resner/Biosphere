# 0078: The balance simulation: the score, the population and how the gates read

- Status: accepted
- Date: 2026-11-09

## Context

v1.0 promises that different builds succeed (BRIEF: viable, bounded organisms; tradeoffs; diverse successful adaptations). The combat tournament (ADR 0051) shows who wins a duel, the pacing bot (M5) how fast a forager grows. Neither says whether a body's whole life, foraging, fighting and mating together, pays off for many kinds of body. M14 T10 measures that; T11 tunes rules 13 against it.

## Decision

**The score is the matings of a life.** A body's score is the mean over its lives. Mating is what lineage needs, and a life that dies young, starves or never reaches maturity scores less. Matings are capped by the cooldown (a life of 45 minutes, mature at 7, mates at most 5 times), so many bodies tie at the ceiling. Ties at the top are broken by kills, then by a fixed hash of the body's id, never by its name.

**The population** (`tests/balance.ts`): the 11 archetypes of `tests/archetypes.ts`, each as itself and with 15 variants, so 176 bodies, plus 32 genesis bodies as a reference, reported but outside the gate. The gate reads the top 10% of the 176: 18 bodies. A variant is one to three trials of the real mutation (`mutateGenome`, at twice the default rate) applied to the archetype's genome, kept only when the archetype's defining feature holds (`ARCHETYPE_KEEPS`: a predicate per archetype on the built creature) and the body is new.

**A life** runs on the real `step` from a hatchling:

- A 2-minute probe in each of the four depth zones, from the zone's anchor (the point nearest the centre well inside it), picks the zone where the body gains most biomass (energy counts at the carrion exchange rate). A zone that leaves it under 90% health is no place to forage; with none, twilight.
- The bot is the pacing bot's policy kept inside the zone: nearest food, away from toxic clouds, back to the anchor when the depth leaves the zone. It looks for food every 12 ticks, not 6, to halve the lookups.
- Fights come as a Poisson process at 3 an hour (the capacity model's assumption) against a random member of the population at 0.67 to 1.5 of the bot's biomass (never more than a tier apart), through the real encounter on autopilot (`duel`; the hand-built bodies fly the tournament's behaviour). A kill applies the reward (the fight's end state is carried back: biomass, energy, health); a death ends the life. A fight takes no time in the pond's clock.
- It matures by the rulebook, mates at every eligibility while fed (the cost and the cooldown applied, a partner always found, never the same twice), and dies at its lifespan.

**The gates** read the top 10% of the archetype bodies: it holds at least 3 archetypes, and no archetype holds more than half of it. Reported, not gated: each archetype's best against the top score, the lives' causes of death, the chosen zones, the genesis reference.

**The run** (`npm run sim:balance`) splits the bodies over the machine's cores (child processes, one shard each) and writes `docs/perf/balance.md` and `balance.json`, whether or not the gates pass. T11 asserts them on the committed report.

## Consequences

- The measurement is deterministic for a seed and a rules version; the report changes only with the rules or the model.
- A full run is long (see the report's wall time); the tests run a scaled one.
- The probe, the zone anchors and the fights are simplifications: nobody travels to a zone, a fight costs no time, and every opponent is a population member. They are the same for every body, so they bias none.
