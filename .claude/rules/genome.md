---
paths:
  - "src/genome/**"
---

# Genome and development (`src/genome`)

ADR 0006 is the contract. This code is shared and deterministic, so `.claude/rules/sim.md` applies too.

- Decoding and development are total functions: any byte string decodes, and any genome develops into a valid body. Clamp and repair; never throw and never reject.
- Hard caps from ADR 0006 (segments, appendages, joints, collision circles, bounds) are enforced in development, not in rendering. Parts are capped by count only: mesh vertex budgets belong to `src/render/creature-mesh.ts`, which lowers detail and never drops a part (ADR 0025).
- Property tests over at least 10,000 random genomes plus 10,000 mutated or recombined descendants run on every change: no throw, caps hold, there is always a propulsion source and a mouth.
- Function follows form: abilities come from geometry and material parameters through formulas. Never hard-code a stat on a named part ("spike = +10 attack").
- Every benefit has a cost (mass, metabolism, drag, cooldown). Archetype tests must show that no genome is best at everything.
- One live rules version, no frozen versions before v1.0 (ADR 0040): a change to development, expression, inheritance or genesis regenerates the goldens, the first such change after a release bumps `RULES_VERSION` (ADR 0018), and the old code is deleted, not kept. A version change that changes what records mean resets the world (its own task: a worker migration, a protocol bump, the notice); `checkGenesis`, `checkBirth` and `checkStored` answer `rules-retired` below `FIRST_LIVE_RULES` (`src/ledger/record.ts`). From v1.0 (or M9's verifier, if earlier) versions are frozen again. `deriveSeed`/`offspringSeed` in `inherit.ts` stay as they are within a version.
- `genesis.ts` holds the whole genesis draw (the base cell, then the larval form and bristles from their own stream); `rarity.ts` prices features from its tables. Bodies follow `develop.ts` and `stats.ts`, and `statsAt` passes the top speed through the band of ADR 0036.
- Karyotype v2 is the only karyotype: 164 bytes of base loci, then the shape loci and the slot extensions, each reading 0 as off. Any byte string decodes as v2, zero-padded or truncated. The body rules are ADRs 0028, 0031 and 0037–0039, refined by 0041; DESIGN §6 has the values.
- Stats read a body's girth, not its drawn width (`form.slim` for a slimmed chain, `girth` for a thinned part), so tuning how an outline or a part is drawn never moves the balance. Changes that move the body itself do: the trunk profile and the head, curls and coils, `keepOff` and `uncover`. Re-run the archetype, tournament and pacing checks after changing them.
- No two segments of a curled chain that are not neighbours overlap (`bodyViolations`). `tests/body-outline.ts` holds the outline, class-shape and curl measures (`trunkCheck`, `classCheck`, `spineTurn`, `sArcs`, `insideShare`, `trunkLegs`).
- Offspring randomness comes only from the committed seed (beacon, commit id, slot) through named streams. No other entropy.
