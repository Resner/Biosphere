# 0072: The slow E2E scenarios run in four shards

- Status: accepted (refines 0042's three slow shards)
- Date: 2026-11-08

## Context

`E2E main` run 215 lost its second slow shard to the job's 30-minute limit: after the M13 load and lifecycle scenarios (about 5 and 2 minutes) joined the `@slow` set, that shard needed more than the 26 minutes it had left once its hubs had started, and 3 of its 16 scenarios never ran. The other two slow shards took 20 and 19 minutes.

## Decision

`e2e-full.yml` splits the `@slow` scenarios over four shards (`--shard=n/4`), so each takes about 15 to 20 minutes. The limit stays at 30 minutes: a shard that needs more is split again, not given more time. Actions minutes on standard runners are free (ADR 0015).

## Consequences

A run uses one more runner. Reproduce a part with `npx playwright test --project=chromium --grep=@slow --shard=1/4 --workers=1`.
