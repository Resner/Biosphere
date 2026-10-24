# 0002: Owner checks, playtest gates and credentials

- Status: accepted
- Date: 2026-10-24

## Context

The factory runs in cloud sessions and CI with no GPU, no real-world networks, and no accounts of its own. It can't judge fun, measure frame rates on real hardware, test NAT traversal between real players, or create hosting accounts. Its runs also post to GitHub as the owner, so GitHub doesn't notify the owner about them.

## Decision

- Tests are offline and deterministic. External services are faked or replayed from recorded fixtures.
- Checks only a person can make are marked `(owner)` in specs. Each release opens a `Playtest: v<version>` issue. Roadmap milestones marked `gate` make the factory wait for the owner's reply before the next milestone.
- Credentials stay with the owner. The factory asks for them through a `Blocked:` issue with exact steps and a secret name, and workflows read the secret.
- Every run ends with one status line (`SHIPPED`, `BLOCKED`, `WAITING`, `IDLE`), which the scheduled task's push notification carries to the owner.

## Consequences

- Progress stops at gates and blockers until the owner replies; everything else runs unattended.
- Rejected: live-service tests in the PR gate (flaky, and they need network and credentials); letting the factory handle secret values.
