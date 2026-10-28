# 0030: Development speed budget is 0.15 ms

- Status: accepted (amends the M3 T5 speed criterion)
- Date: 2026-10-28

## Context

M3 T5 set `develop` plus `computeStats` to a median under 0.1 ms over 1,000 genomes, enforced by `src/genome/stats.test.ts` in `npm run check`. The body plan v2 work (ADR 0025: webbing, setae, membranes, carapace; ADR 0028: proportions) made development richer on purpose. Standalone it takes 0.06–0.08 ms, but under CI and with test files running in parallel the median reads 0.11–0.13 ms, so the gate failed every PR (#162). The profile is flat (membranes about 28%, stats about 27%, garbage collection about 12%), with no single hotspot.

## Decision

- The budget is a median under 0.15 ms. The owner chose this on #162 and said that budgets are guidance, not tight limits.
- The test keeps its warm-up and best-of-nine timing.

## Consequences

- Development runs once per creature spawn or remote join, so 0.15 ms is far below any frame or network budget.
- A future regression is still caught, since the standalone cost is about half the limit.
