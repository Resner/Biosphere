# Balance

Rules version 13. 176 bodies (each archetype and 15 variants of it), 16 lives each, on the real rules (`tests/balance.ts`, ADR 0078). A life's score is its matings; a body's score is the mean over its lives.

## Gates

| Gate | Measured | |
|---|---|---|
| The top 10% (18 bodies) holds at least 3 archetypes | 5 archetypes | met |
| No archetype holds more than 50% of the top | hunter holds 7 of 18 | met |

42 bodies share the top score 5.00; ties go to kills, then to a hash of the id.

## Archetypes

| Archetype | Median score | Best score | Best ÷ top score | In the top |
|---|---|---|---|---|
| ciliate | 5.00 | 5.00 | 1.00 | 4 |
| flagellate | 5.00 | 5.00 | 1.00 | 2 |
| swimmer | 4.91 | 5.00 | 1.00 | 4 |
| setose | 4.88 | 5.00 | 1.00 | 1 |
| winged | 4.81 | 5.00 | 1.00 | 0 |
| hunter | 4.75 | 5.00 | 1.00 | 7 |
| carapaced | 4.44 | 4.88 | 0.97 | 0 |
| radial | 2.72 | 3.25 | 0.65 | 0 |
| coiled | 2.66 | 3.81 | 0.76 | 0 |
| armoured | 1.91 | 2.56 | 0.51 | 0 |
| filter | 0.31 | 0.50 | 0.10 | 0 |

## The top

| Body | Archetype | Score | Zone |
|---|---|---|---|
| hunter-3 | hunter | 5.00 | twilight |
| hunter-0 | hunter | 5.00 | twilight |
| hunter-4 | hunter | 5.00 | twilight |
| hunter-base | hunter | 5.00 | twilight |
| hunter-5 | hunter | 5.00 | twilight |
| hunter-9 | hunter | 5.00 | twilight |
| hunter-1 | hunter | 5.00 | twilight |
| ciliate-base | ciliate | 5.00 | twilight |
| swimmer-9 | swimmer | 5.00 | twilight |
| ciliate-11 | ciliate | 5.00 | twilight |
| swimmer-14 | swimmer | 5.00 | twilight |
| ciliate-9 | ciliate | 5.00 | twilight |
| setose-2 | setose | 5.00 | twilight |
| flagellate-10 | flagellate | 5.00 | twilight |
| swimmer-5 | swimmer | 5.00 | twilight |
| ciliate-7 | ciliate | 5.00 | twilight |
| flagellate-9 | flagellate | 5.00 | twilight |
| swimmer-6 | swimmer | 5.00 | twilight |

## Zones chosen

All bodies: twilight 173, deep 3.

## Lives ended by

old-age 1859, killed 601, starved 240, uv 70, pressure 46.

## Genesis reference

32 genesis bodies (not gated): median score 5.06, best 10.00. Zones: twilight 29, shallows 3. Lives ended by killed 267, old-age 183, uv 39, starved 20, pressure 3.
