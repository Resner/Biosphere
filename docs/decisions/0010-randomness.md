# 0010: Randomness from drand quicknet: commitments and outage policy

- Status: accepted
- Date: 2026-10-25

## Context

Mating must commit both parent states, the transaction and a specific future drand round before its randomness exists: no choosing favourable rounds, changing seeds or cancelling for a reroll. Witness selection uses the same pattern (ADR 0012). Combat lock-in must stay fast, without waiting for a beacon. The brief asks for verified drand with caching and a defined outage policy. Tests may not depend on live services.

## Decision

**Network: drand quicknet.**

- Chain hash `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`, 3 s period, genesis `1692803367` (UNIX seconds), scheme `bls-unchained-g1-rfc9380`.
- The public key is pinned in code, copied from the chain's `/info` when fixtures are recorded.
- `round(t) = floor((t − genesis) / 3) + 1`.

**Verification:**

- Clients and the authority verify every beacon with `@noble/curves` BLS12-381: a G1 signature over `SHA-256(round as 8-byte big-endian)` with the RFC 9380 hash-to-curve DST of the scheme.
- `randomness = SHA-256(signature)`.
- Unverified beacons are never used.

**Fetching and caching**: from `api.drand.sh`, `api2.drand.sh`, `api3.drand.sh` and `drand.cloudflare.com` (v1 paths `/{chain}/public/{round}` and `/latest`), with fallback across hosts. The authority caches verified beacons in SQLite and serves them with records, so verifiers work offline from bundles.

**Commitment rule:**

- Every commitment (genesis DNA, mating, witness pools) names `round = latest published + 2`, which is 3–6 s in the future, before that round exists.
- The round is fixed at commit time. There is no retry, cancel or alternate round, and resubmitting returns the same commitment.
- Seeds derive from `SHA-256(domain tag ‖ randomness ‖ commitment id ‖ slot)`.

**Outage policy:**

- A commitment waits for its round. drand catches up on missed rounds when it recovers, so the committed round eventually exists.
- The UI shows "awaiting beacon" and the game continues. Only that commitment's result waits.
- If the beacon network is gone for good, a new rules version (by ADR) names a replacement source for pending commitments. The authority never substitutes its own randomness.

**Encounters never wait.** The encounter seed is `SHA-256("bs/enc/v1" ‖ latest published randomness at lock ‖ encounter id)`, where the encounter id covers the participants' heads and the lock time. Randomness plays only a small part in combat (variance, tie-breaks), so choosing when to engage gains little. This is documented as a known, bounded effect.

**Tests**: real beacons recorded once by `tools/record-drand.ts` into `tests/fixtures/drand/`. The worker has a fixture mode (`DRAND_SOURCE=fixture`) whose clock starts at the first recorded round.

## Consequences

- Offspring and genesis DNA can't be predicted before commitment, and committed transactions can't be rerolled.
- A drand outage delays births and genesis but never blocks play or combat.
- Rejected:
  - authority-chosen randomness (the operator could bias it);
  - client commit-reveal alone (the last revealer can abort and retry);
  - waiting for a new beacon on every combat action (too slow);
  - local proof-of-work puzzles (the brief calls them insufficient).
