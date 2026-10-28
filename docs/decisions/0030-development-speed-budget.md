# 0030: The development speed budget is 0.15 ms

- Status: accepted (amends 0025: its "develops in well under 0.1 ms" budget)
- Date: 2026-10-28

## Context

The tests in `src/genome/stats.test.ts` and `src/genome/develop.test.ts` required the median `develop` + `computeStats` time to stay under 0.1 ms. The look work of M6 (development v2: webbing, setae, membranes, carapace, body proportions in ADR 0028) made development richer on purpose (ADR 0025). On CI the median is now 0.11–0.13 ms, standalone in Node 0.06–0.08 ms, so the test failed on every PR (Blocked issue #162). The profile is flat (`buildMembranes` about 28%, `computeStats` about 27%, garbage collection about 12%), with no single hotspot.

Development runs once per creature spawn or remote join, never per frame or per tick, so 0.1 ms was a guideline, not a requirement.

## Decision

- The budget is 0.15 ms at the median, in both tests. The owner approved this on #162 and asked that such budgets be treated as guidance, not strict gates.
- The tests stay as regression guards against an order-of-magnitude slowdown; they are not tuned further.

## Consequences

- CI no longer fails on runner noise around 0.1 ms.
- A body that costs more than 0.15 ms to develop needs a new ADR, or an optimisation, before it ships.
