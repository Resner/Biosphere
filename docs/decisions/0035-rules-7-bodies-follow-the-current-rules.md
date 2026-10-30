# 0035: Rules 7, and bodies follow the current rules until encounters settle on them

- Status: accepted (amends 0005 and 0018 for development and stats)
- Date: 2026-10-30

## Context

v0.7.0 released rules version 6. M6b changes three kinds of code:
- development: long bodies, spirals and legs;
- stats: a speed band (ADR 0036);
- genesis: more bristled parts.

ADR 0005 freezes genesis, development, inheritance and encounters per rules version, and ADR 0018 says released versions are never edited.

Today nothing that is recorded or settled depends on a body plan:
- records hold genomes, rules versions, commitments and shares of biomass;
- replays carry `phys`;
- the authority reads only expressed values: maximum biomass and the growth multiplier (`buildCreature(genome).phys` in `worker/life.ts` and `worker/authority.ts`, both straight from genes) and the lifespan (`express(genome)`).

Encounters (M7) are the first place where a body's plan will settle an outcome. Freezing development and stats v6 now would copy about 2,000 lines of `develop.ts` and `stats.ts` that verify nothing. The owner said on #183 that the generation code may still change ("we are early in the development phase").

## Decision

- **Rules version 7.** The first M6b task that changes an outcome raises `RULES_VERSION` to 7.
- **The protocol version rises with it**, so no pond mixes v0.7.0 and later clients. An old client would recompute a rules 7 genesis with its own genesis code and fail, and it would draw other players' bodies differently.
- **Genesis stays frozen per version.** `genesis-v6.ts` verifies rules 6 genesis records. `genesis.ts` is rules 7's working copy until M6b's last task freezes it as `genesis-v7.ts`.
- **Inheritance and mutation do not change in M6b.** Rules 6 and rules 7 births share `inherit.ts`. Before any golden is regenerated, `inherit.json` and `offspring.json` are kept as `inherit-v6.json` and `offspring-v6.json` (tests read them and never write them). A task that needs to change inheritance freezes `inherit-v6.ts` first.
- **Expression does not change in M6b.** `express.json` is not regenerated, so maximum biomass, growth and lifespan stay the same for every genome. These are the values the authority's clamps and life clock read.
- **Development and stats are not frozen per version before M7.** Every karyotype v2 genome develops by the current rules. A creature born under rules 6 swims in its rules 7 body after the update, with the same genome, hash, records and lineage. Karyotype v1 genomes keep the v5 body (ADRs 0025 and 0028).
- **From M7, development and stats freeze per version.** Encounters settle on bodies there, and M7's spec decides how the freeze works, ahead of M9's registry.

## Consequences

- Living creatures change their look and handling once, with the update. Their records stay valid.
- The authority's growth and size clamps are unchanged for every genome, because they come from expression alone.
- The `-v6` goldens keep rules 6 genesis and births verifiable forever, as the `-v5` goldens do for rules 5.
- Rejected:
  - freezing `develop-v6.ts` and `stats-v6.ts` (about 2,000 lines that verify nothing until M7);
  - changing development under rules 6 (released versions are never edited, and old clients must be told to reload);
  - a karyotype v3 (M6b needs no new loci).
