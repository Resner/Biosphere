---
paths:
  - "src/genome/**"
---

# Genome and development (`src/genome`)

ADR 0006 is the contract. This code is shared and deterministic, so `.claude/rules/sim.md` applies too.

- Decoding and development are total functions: any byte string decodes, and any genome develops into a valid body. Clamp and repair; never throw and never reject.
- Hard caps from ADR 0006 (segments, appendages, joints, collision circles, bounds, vertices) are enforced in development, not in rendering.
- Property tests over at least 10,000 random genomes plus 10,000 mutated or recombined descendants run on every change: no throw, caps hold, there is always a propulsion source and a mouth.
- Function follows form: abilities come from geometry and material parameters through formulas. Never hard-code a stat on a named part ("spike = +10 attack").
- Every benefit has a cost (mass, metabolism, drag, cooldown). Archetype tests must show that no genome is best at everything.
- Development, expression and inheritance are frozen per `RULES_VERSION`, with golden vectors. A new behaviour is a new version; the old code stays for verifying history.
- Offspring randomness comes only from the committed seed (beacon, commit id, slot) through named streams. No other entropy.
