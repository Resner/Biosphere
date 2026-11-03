# Combat report

Written by `npm run report:combat` (`tools/combat-report.ts`); rules v9. Every fighter flies the autopilot through the real encounter simulation, from fixed start layouts.

**Scoring.** A kill is the only win (1); an escape or the timeout leaves both standing and is a draw (½), because a fighter that gets away loses nothing.

## Archetypes

The 11 archetypes of `tests/archetypes.ts` at 400 biomass, every pair from 8 start layouts and on both ends of the line (16 duels a pair). Each cell is the row's share against the column. The hand-built archetypes carry no behaviour genes: the armed or armoured ones fly the middling behaviour, the others a skittish one (aggression 0.2, caution and reflex 0.9).

| | flagellate | ciliate | swimmer | armoured | filter | hunter | radial | coiled | carapaced | winged | setose | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **flagellate** | · | 50% | 50% | 50% | 50% | 50% | 50% | 50% | 50% | 50% | 50% | **50%** |
| **ciliate** | 50% | · | 50% | 50% | 50% | 50% | 50% | 50% | 50% | 50% | 50% | **50%** |
| **swimmer** | 50% | 50% | · | 50% | 50% | 50% | 75% | 69% | 50% | 50% | 50% | **54%** |
| **armoured** | 50% | 50% | 50% | · | 50% | 50% | 94% | 100% | 50% | 50% | 50% | **59%** |
| **filter** | 50% | 50% | 50% | 50% | · | 0% | 50% | 50% | 0% | 50% | 50% | **40%** |
| **hunter** | 50% | 50% | 50% | 50% | 100% | · | 100% | 100% | 50% | 50% | 50% | **65%** |
| **radial** | 50% | 50% | 25% | 6% | 50% | 0% | · | 50% | 0% | 50% | 19% | **30%** |
| **coiled** | 50% | 50% | 31% | 0% | 50% | 0% | 50% | · | 0% | 47% | 38% | **32%** |
| **carapaced** | 50% | 50% | 50% | 50% | 100% | 50% | 100% | 100% | · | 50% | 50% | **65%** |
| **winged** | 50% | 50% | 50% | 50% | 50% | 50% | 50% | 53% | 50% | · | 50% | **50%** |
| **setose** | 50% | 50% | 50% | 50% | 50% | 50% | 81% | 63% | 50% | 50% | · | **54%** |

## Size

Mirror duels: 8 genesis bodies fight a copy of themselves of 300 biomass, on 16 layouts each. Both sides are stubborn (caution 0, no dashing in), so strikes alone show the size. Share of the bigger body:

| Biomass ratio | Bigger body wins |
|---|---|
| 1 × | 42% |
| 1.5 × | 100% |
| 2 × | 100% |

## Fights between genesis pairs

64 duels between genesis bodies of 300 biomass, each flying its own behaviour genes.

| Measure | Value |
|---|---|
| Fight length (median, p10, p90) | 10.4 s, 6.0 s, 17.2 s |
| Fights that end in a kill | 23 of 64 |

## Growth by kills

The winners of those kills gained 370 biomass per minute of fighting (the kill reward over the fight's length). A forager (the pacing bot, `tools/pacing-report.ts`, no mating, no carrion, median of 12 genesis bots) gains 69.5 biomass per minute between 250 and 350 biomass: killing grows 5.3 × as fast.

## Gate

| Line | Measured | Result |
|---|---|---|
| No archetype wins more than 70% overall | 65% | met |
| One pairing is won 65% or more by one side | 100% | met |
| Mirror duels at 1 × go 40%-60% | 42% | met |
| Equal genesis duels last a median of 8-25 s | 10.4 s | met |
| At 2 × the biomass a body wins 85% or more of mirror duels | 100% | met |
| At 1.5 × the biomass a body wins 70% or more of mirror duels | 100% | met |
| Winners grow 1.5 × as fast per minute as a forager | 5.3 × | met |

Report hash: `49b2cacd16ab16fb` (rules v9).
