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
- Frozen code (never edit; `checkGenesis`, `checkBirth` and `offspringPair` pick it by `record.rules`): `karyotype-v1.ts` (the 328-byte table), `genesis-v5.ts` and `inherit-v5.ts` (rules ≤ 5, with the v5 genetics numbers inlined), `develop-v5.ts` and `stats-v5.ts` (the v1 body under rules ≤ 5, numbers inlined; M6 T7), `deriveSeed`/`offspringSeed` in `inherit.ts` (every version), and the goldens `genome-hash-v1.json`, `genesis-v5.json`, `inherit-v5.json`, `offspring-v5.json`, `develop-v5.json` (tests read them, never write them). Development v2 must keep developing v1 genomes to the v5 plan and stats (`develop-v5.test.ts`).
- Karyotype v2 appends to v1: a genome keeps its own length (328 bytes is v1, anything else v2), and every new locus reads 0 as the v1 behaviour.
- Offspring randomness comes only from the committed seed (beacon, commit id, slot) through named streams. No other entropy.
