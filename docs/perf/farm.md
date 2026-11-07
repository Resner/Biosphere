# Bot-farm report

Reproduce with `npm run report:farm`. Scripted identities drive one hub on a hand-moved clock under the
live rules and scales for 3 hours of play (`worker/farm.test.ts`, ADR 0059); they never join the live world.
The honest pair forages at the pacing bot's pace and mates as soon as it may; a farmer reports the most
growth the authority accepts, mates with its bots in turn, kills them through the authority's referee and
sets its bots available as witnesses. Times are minutes after the first hatch, at one report (30 s) of resolution.

## Gates

| Farm | Gate | Result | Measured |
|---|---|---|---|
| 1 bot | 1. No time shortcut | met | generation 3 at 28.5 min (least the gates allow 27.3); a creature of the honest pair waits 0.2 min beyond its own gate, the farmer's 0.4 |
| 1 bot | 2. No breeding shortcut | met | 5 creatures, none with more than one child per 9.0 min cooldown after maturity (6 children in 3 h) |
| 1 bot | 3. No biomass from nothing | met | 32 kills paid 740 wu from 12335 wu of victims; one bot identity's kills were worth 1.98 full kills at most, the floor aside |
| 1 bot | 4. Young bots pay half | met | 1 kill of identities under 20 min of play, each worth at most 0.5 |
| 1 bot | 5. Sybil witnesses get their share | met | 1 bots among 8 honest witnesses took 11% of 200 events' duties (at most 21%); eligible bots at 19 min: 0, at 21 min: 1 |
| 4 bots | 1. No time shortcut | met | generation 3 at 26.0 min (least the gates allow 25.1); a creature of the honest pair waits 0.2 min beyond its own gate, the farmer's 0.3 |
| 4 bots | 2. No breeding shortcut | met | 20 creatures, none with more than one child per 9.0 min cooldown after maturity (38 children in 3 h) |
| 4 bots | 3. No biomass from nothing | met | 32 kills paid 2430 wu from 12596 wu of victims; one bot identity's kills were worth 1.98 full kills at most, the floor aside |
| 4 bots | 4. Young bots pay half | met | 1 kill of identities under 20 min of play, each worth at most 0.5 |
| 4 bots | 5. Sybil witnesses get their share | met | 4 bots among 8 honest witnesses took 37% of 200 events' duties (at most 43%); eligible bots at 19 min: 0, at 21 min: 4 |
| 16 bots | 1. No time shortcut | met | generation 3 at 25.0 min (least the gates allow 24.6); a creature of the honest pair waits 0.2 min beyond its own gate, the farmer's 0.1 |
| 16 bots | 2. No breeding shortcut | met | 22 creatures, none with more than one child per 9.0 min cooldown after maturity (42 children in 3 h) |
| 16 bots | 3. No biomass from nothing | met | 32 kills paid 7789 wu from 13667 wu of victims; one bot identity's kills were worth 1.50 full kills at most, the floor aside |
| 16 bots | 4. Young bots pay half | met | 1 kill of identities under 20 min of play, each worth at most 0.5 |
| 16 bots | 5. Sybil witnesses get their share | met | 16 bots among 8 honest witnesses took 69% of 200 events' duties (at most 77%); eligible bots at 19 min: 0, at 21 min: 16 |

## What farming buys (no gate)

The extra attempts the brief allows: a farmer reaches its genetic maximum size sooner, and its identities
draw more genomes in the same time.

| Scenario | Generation 3 (min) | Maximum size (min) | Children | Rare or better | Mean rarity (bits) | Children per hour |
|---|---|---|---|---|---|---|
| honest | 28.0 | 4.0 | 12 | 3 | 9.4 | 12 |
| farm-1 | 28.5 | 1.5 | 6 | 3 | 8.6 | 2 |
| farm-4 | 26.0 | 1.0 | 38 | 4 | 4.1 | 12.7 |
| farm-16 | 25.0 | 1.5 | 42 | 1 | 3.4 | 14 |
