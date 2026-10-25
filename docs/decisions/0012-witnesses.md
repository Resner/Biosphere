# 0012: Witnesses: drand-selected, budgeted, never final

- Status: accepted
- Date: 2026-10-25

## Context

The brief lets drand select random witnesses for verification and audits:

- The eligible pool, event id and future round are committed before selection, with no committee shopping or free retries.
- Witnesses are independent of the involved players and may come from outside their AoI, while connection and bandwidth budgets hold.
- Many identities defeat random selection, so eligibility only adds friction.
- Minimal authoritative finality is preferred over peer votes.
- Settlement must work with too few witnesses or none, without faking them or silently lowering security.

## Decision

**Eligibility**:

- Online, with at least 20 minutes of active play on the identity.
- Not a participant, and not the same IP hash as one (hashed and transient, never stored).
- Has spare connection budget (at least 2 free slots) and is under a per-hour duty limit.
- No recent failed or overruled attestations.

**Commitment**: when an event starts (an encounter lock, a mating commit, a genesis commit), the authority records `{ eventId, poolHash, pool, round = latest + 1 }` before that round exists. A second commitment for the same event is rejected.

**Selection**: an ordered sample of the pool drawn with the round's randomness. The first entries are the duty witnesses (1 referee and 1 auditor for encounters; 1 auditor for matings and genesis). The rest form a pre-committed replacement order. Replacements follow that order and are never re-drawn.

**Duties:**

- An encounter referee takes over sequencing from the authority at the first frame boundary after the round (ADR 0011) and commits bundle batches every second.
- An auditor re-simulates and signs an attestation over the result (or the derived offspring and genesis DNA).
- Witness connections count against the 32-connection cap and use about 1 KB/s.

**Finality**:

- The authority is final. It compares attestations with its own re-simulation of committed records.
- A mismatch is resolved by the authority's result, and the faulty witness loses eligibility.
- When too few witnesses are eligible or all of them fail, the authority settles alone, and the record is flagged `authority-only` and visible in the UI and in proofs. The flag is never hidden.

## Consequences

- Refereeing and audits move off the authority at scale (cost, ADR 0008), while correctness rests on committed records plus the authority.
- **Explicit limits**: witnesses add independent observation, not proof of honesty. One person with many eligible identities is selected more often. Eligibility and duty limits raise the cost of that, but don't prevent it.
- Rejected:
  - majority votes among peers (Sybil-prone, and the brief prefers authority finality);
  - witnesses chosen by participants or by AoI proximity (shopping, correlated with the involved players);
  - re-drawing a committee after a failure (free retries).
