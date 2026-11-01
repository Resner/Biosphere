# 0022: The mating cooldown is 9 minutes

- Status: accepted (its pacing targets are restated by 0029)
- Date: 2026-10-27
- Supersedes: the 6-minute base cooldown in ADR 0021

## Context

M5 T14 measures the pacing with a food-seeking bot on real genesis genomes (`npm run sim:pacing`). The targets were stated before the run: hatch to first eligibility 14 to 25 min (median), 4 to 9 matings in a life, and a pair's fourth mating within 24 h waiting at least 8× the base. With a 6-minute cooldown the bot reached first eligibility after a median 17.3 min but mated 11 times per life (10 to 13): a refeed takes seconds, so the cooldown alone sets the pace and a life became a mating treadmill.

## Decision

The base cooldown is 9 minutes of active time (`RULES.mating.cooldownMs` 540,000). The doubling per earlier mating of the same pair (up to ×32) is unchanged. The authority reads the value and the sim's `step` does not, so no outcome of the simulation changes and the rules version stays 5.

## Consequences

The bot mates 7 to 9 times in a full life (median 8, down from 11), the fourth mating of one pair within 24 h waits 72 min, and the player's wait after a mating is 9 min of swimming and feeding. The owner judges whether it feels like a wall in the M5 playtest; the number is one constant to move.
