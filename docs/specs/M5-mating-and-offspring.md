# M5: Mating and offspring

Release: v0.6.0 · Gate: yes

## Goal

Two players who meet in a pond can breed. One courts, the other accepts, both pay, and a few seconds after a drand round that nobody could predict each player has their own distinct child: same two parents, different genes, inherited by Mendel's rules plus a little mutation. The child waits as an egg. The player can promote it (the parent freezes as a checkpoint and the child hatches beside it) or keep playing the parent. When a creature dies, of anything including old age, the player chooses between the pending child and the nearest surviving ancestor, who comes back with its saved condition and remaining life; if nothing survives, a new genesis starts and the old lineage stays as history. Choosing a mate is readable: a card shows species, rarity, size, kinship and plain-words Punnett hints that match exact enumeration. The player has a lineage view (their chain and the family graph). ADR 0021 is the contract for the mechanics; ADRs 0008 to 0010, 0019 and 0006 for the model.

This milestone is a **gate**: after v0.6.0 the factory waits for the owner's reply on the `Playtest: v0.6.0` issue (breeding and morphology, brief gate 2).

## Out of scope

- Combat, carrion, kill rewards and `locked` creatures (M7, M8). Eligibility has a `locked` input that is always false until then.
- Witnesses, signed inputs, audits and any proof that two creatures were really near each other (M10; ADR 0021 says why that is acceptable).
- The independent verifier, proof bundles and shareable cards (M9). M5 writes the pure checks (`checkBirth`, `checkMatePair`, `kinship`) that M9 reuses.
- Sound, the creature look overhaul (#90), and the emote and ping rework (#89): all M6. The courtship and egg effects use the existing effect system, with no new art pass.
- Discarding a pending child, a second pending slot, choosing a deeper ancestor than the nearest, trading, mating with offline players (ADR 0021).
- Mobile and touch controls.

## Touches

New: `src/sim/mating.ts`, `src/ledger/mating.ts` (asks, `checkMatePair`, `birthRequest`, `checkBirth`), `src/ledger/pedigree.ts`, `src/genome/offspring.ts`, `src/genome/punnett.ts`, `src/game/mate.ts` (courtship state machine), `src/game/offspring.ts` (egg, pending card, promote, fallback), `src/game/mate-card.ts` (inspect card), `src/game/lineage.ts` (lineage view), `worker/mating.ts` (courtship, commitment and birth on the authority), `tools/pacing.ts`, `tests/e2e/m5-*.spec.ts`.

Changed: `src/sim/rules.ts` (`RULES.mating`, rules version 5), `src/sim/life.ts` (`mate` event, `lifeStage` takes `matureAtMs`), `src/sim/replay.ts`, `src/ledger/record.ts` (kinds, per-kind bodies, the matrix), `src/net/protocol.ts` (version 2), `src/net/hub-client.ts`, `worker/ledger.ts`, `worker/schema.ts` (migration 5), `worker/authority.ts`, `worker/life.ts`, `worker/beacons.ts` (mate commitments resolve), `worker/env.d.ts` and the fixture entry (`MATING_SCALE`), `src/game/app.ts`, `online.ts`, `life.ts`, `hud.ts`, `screens.ts`, `history.ts`, `debug.ts`, `index.html`, `playwright.config.ts`, `docs/DESIGN.md`.

Rules numbers (`RULES.mating`, rules version 5; DESIGN §5 mirrors them):

```ts
mating: {
  costEnergy: 0.3, costBiomass: 0.15,      // shares of current energy and biomass, paid at commitment
  minEnergyShare: 0.5,                      // energy needed, as a share of the maximum
  cooldownMs: 360_000,                      // active time; doubles per earlier mating of the pair in repeatWindowMs
  repeatWindowMs: 86_400_000, repeatMaxDoublings: 5,
  acceptShownMs: 15_000, signWindowMs: 20_000,
  tierSpread: 1, reachBodies: 3,            // size tiers apart; body lengths apart (clients only)
  hatchlingMinBiomass: 80, hatchlingShare: 0.1, hatchlingEnergyShare: 0.6,
  restoreMinMs: 120_000,                    // a checkpoint with less life left than this is exhausted
}
```

Interfaces (shapes may be refined in a task note, with the reason):

```ts
// src/sim/mating.ts (pure, shared)
export interface MateView { creature: string; owner: string; active: boolean; activeMs: number; matureAtMs: number; cooldownUntilMs: number;
  biomass: number; energy: number; hasPending: boolean; inFlight: boolean; locked: boolean }
export type MateRefusal = 'not-active' | 'locked' | 'in-flight' | 'pending' | 'not-mature' | 'cooldown' | 'low-energy' | 'tier' | 'self';
export function ownRefusal(v: MateView): MateRefusal | null;                  // first failing check, in this order
export function pairRefusal(a: MateView, b: MateView): MateRefusal | null;    // 'self' or 'tier'
export function mateCost(biomass: number, energy: number): { biomass: number; energy: number };   // what remains after the cost
export function cooldownMs(priorMatings: number): number;                     // 360 s × 2^min(n, 5)
export function hatchling(maxBiomass: number): { biomass: number; energy: number };

// src/ledger/record.ts: RecordKind adds 'birth' | 'mate-commit' | 'promote' | 'restore'
export type Status = 'pending' | 'active' | 'checkpoint' | 'dead';
export function transitionOutcome(kind: RecordKind, role: string | null, status: Status | null): { ok: true; next: Status } | { ok: false; reason: string };

// src/ledger/mating.ts
export interface MateAsk { v: 1; kind: 'mate'; creature: string; partner: string; partnerCreature: string; nonce: string; sig: string }
export function signMateAsk(identity: Identity, a: Omit<MateAsk, 'v' | 'kind' | 'sig'>): MateAsk;
export function checkMatePair(a: MateAsk, aOwner: string, b: MateAsk, bOwner: string): string[];   // [] when each names the other and the signatures verify
export function birthRequest(rules: number, commit: Commitment, mates: [string, string], slot: number, parents: [string, string], child: Genome, generation: number, owner: string): RecordRequest;
export function checkBirth(record: LedgerRecord, commit: Commitment, beacon: Beacon, parents: [Genome, Genome], mates: [StoredRecord, StoredRecord]): string[];

// src/genome/offspring.ts
export function offspringPair(randomness: Uint8Array, commitId: string, a: Genome, b: Genome): { children: [Genome, Genome]; slots: [number, number] };

// src/ledger/pedigree.ts
export type Pedigree = ReadonlyMap<string, readonly [string, string] | null>;   // creature id -> its two parents, null for a genesis creature
export function kinship(p: Pedigree, a: string, b: string): number;            // Malécot's coefficient, six generations deep
export function inbreeding(p: Pedigree, id: string): number;                   // F of a creature = kinship of its parents

// src/genome/punnett.ts
export function punnett(a: Genome, b: Genome): PunnettHints;                   // exact probabilities per Mendelian trait, load risk, mutation chance
```

Wire additions (`PROTOCOL_VERSION` 2; every message has a size cap and goes through the shared codec; unknown or malformed input never throws):

```
client → hub:  { t:'mate-check', with }   { t:'court', with, ask }   { t:'accept', from, ask }   { t:'decline', from }
               { t:'promote', request, sig }   { t:'restore', request, sig }   { t:'lineage' }
hub → client:  { t:'mate-info', with, ok, reason?, kinship, generation, tier, cooldownMs }   { t:'invite', from, name, ask, card }   { t:'declined', from, reason }
               { t:'mating', commit, role, partner, record, matureAtMs, cooldownUntilMs }
               { t:'born', record, commit, beacon, genome, parents, mates }   { t:'promoted', life, parent }   { t:'restored', life }
               { t:'lineage', creatures, pedigree }
changed:       life   { life, genesisIn, pending, fallback }     ack { n, activeMs, lifespanMs, matureAtMs, cooldownUntilMs }     died { cause, record, fallback }
```

Test hooks (fixture entry only, ignored in production; `tools/worker-bundle.test.ts` guards that): `MATING_SCALE` in (0, 1] multiplies the maturity time requirement, `cooldownMs`, `restoreMinMs` and `repeatWindowMs`, and drops the maturity biomass share when below 1. The E2E hub for M5 runs with `LIFESPAN_SCALE=0.05` (a life of about 225 s) and `MATING_SCALE=0.01`. The authority sends `matureAtMs` and `cooldownUntilMs`, so clients never need the scale.

## Tasks

- [x] T1 M4 carry-overs
  - Acceptance (workerd and unit tests, written first):
    - Hatch refund: when `accept` refuses a genesis after its commitment was taken (the bucket went 3 → 2), the bucket is back at 3, the pending commitment is cleared, the owner gets `refused`, and a redelivery refunds nothing a second time. The bucket never exceeds 3.
    - A client `death` report whose ticks bring `activeMs` to the lifespan is recorded with cause `old-age` and answered `died { cause: 'old-age' }`; one that falls short keeps the client's cause (`starved`).
    - A `LifeFlow` waiting for its genesis ignores a stray `refused` about something else (`dead`, `cause`, `queued`) and keeps waiting; a `refused` that answers the ask (`limit`, `bad-signature`, `used`, `active`) ends the wait with its message. A table-driven unit test lists every reason string the hub can send and which group it is in.
  - Done: `Ledger.refundHatch` replaces `clearPending` (refunds only a still-pending commitment, capped at 3); a client `death` that reaches the lifespan is recorded as `old-age`; `LifeFlow` skips `STRAY_REFUSALS` (`dead`, `cause`, `queued`) while waiting for a genesis. Gotcha: a stray `queued` refusal no longer fails the hatch at once; it waits out `GENESIS_WAIT_MS`.
  - Notes: from the M4 close notes. The duplicate BLS check in `worker/beacons.ts` and the unscaled lifespan fallback were judged not worth code; the beacon service's uncounted writes are M13's.

- [x] T2 Rules version 5: mating rules in the sim
  - Acceptance (unit tests first):
    - `RULES_VERSION` is 5, `RULES.mating` has the numbers above, every sim golden is regenerated under version 5 (hashes and version only) and the PR says so; a new golden with a `mate` life event replays equally in Node and Chromium (the existing determinism E2E).
    - `mateCost(500, 800)` → biomass 425, energy 560. `applyLife(world, id, 'mate')` does the same to the creature, recomputes the radius (√biomass), clamps health to the new maximum and emits no event; the input log's `life` list accepts `'mate'` (ascending ticks, validated) and a replay with it reproduces.
    - `cooldownMs(n)`: n = 0 → 360,000; 1 → 720,000; 2 → 1,440,000; 5 → 11,520,000; 6 and 40 → 11,520,000.
    - `ownRefusal` returns the first failing reason in the order `not-active`, `locked`, `in-flight`, `pending`, `not-mature` (activeMs below `matureAtMs`), `cooldown` (activeMs below `cooldownUntilMs`), `low-energy` (below 50% of the maximum); boundaries at exactly each limit are pinned, and one case per reason has only that check failing. `pairRefusal` returns `self` for equal owners and `tier` when the size tiers (`sizeTier` on biomass) differ by more than 1: 1,000 vs 1,100 biomass is allowed (T0 and T1), T0 vs T2 is refused; the boundaries at 1,024 and 16,384 are pinned.
    - `hatchling(300)` → biomass 80; `hatchling(800)` → 80; `hatchling(1000)` → 100; `hatchling(2_457_600)` → 245,760; energy is 60% of `2·biomass`.
    - `lifeStage` takes an optional `matureAtMs`; without it the M4 behaviour is unchanged (every M4 test passes untouched).
  - Notes: update the DESIGN.md header ("rules version 5") and §5 in the same PR. The sim imports no genome code, so `sizeTier` stays where it is and callers pass biomass.
  - Done: rules version 5, `RULES.mating`, `src/sim/mating.ts`, the `mate` life event and `lifeStage`'s `matureAtMs`; all goldens regenerated (version and hashes only; the genome goldens change one line, the new `mate` replay is added). Gotcha: `sizeTier` moved to `src/sim/size.ts` (importers repointed), because `pairRefusal` needs it and the sim may not import genome code; `**` is banned in the sim, so `cooldownMs` shifts. `MateView.maxEnergy` is dropped: `ownRefusal` derives it from `biomass`.

- [x] T3 Record kinds, per-kind bodies, the transition matrix, mate asks
  - Acceptance (unit tests first):
    - `RecordKind` gains `birth`, `mate-commit`, `promote`, `restore`. `recordProblems` treats `birth` like `genesis` (`creature: ''`, `seq: 0`, `prev: ''`) and every other new kind like a chain record. `bodyProblems(kind, body)` names the failure for each kind: `mate-commit` needs `{ commit, round, role: 'a'|'b', partner, partnerCreature, genome, partnerGenome, generation, activeMs, biomass, energy, health, cooldownUntilMs }`; `birth` needs `{ commit, round, slot, parents: [id, id], mates: [hash, hash], genome, generation, karyotype }`; `promote` is `{ role: 'child', parent }` or `{ role: 'parent', child, activeMs, biomass, energy, health, cooldownUntilMs }`; `restore` is `{ from, activeMs, biomass, energy, health, cooldownUntilMs }`. Missing, extra, wrong-typed, negative and non-hex-id fields each produce a named failure. (M4 kinds keep their bodies.)
    - Golden records for each new kind (and both promote roles) with committed hashes under `src/ledger/__golden__/`; changing any body field changes the hash.
    - `transitionOutcome(kind, role, status)` equals the ADR 0021 matrix: a table-driven test over every kind and role against all four statuses and "no creature" (about 40 cells) accepts exactly the allowed cells with the right next status and returns `status:<status>` for the rest.
    - `signMateAsk` / `checkMatePair`: A's ask names B and B's names A with the same nonce → `[]`; a changed nonce, creature, partner, partner creature, a swapped pair, the same owner twice, and a flipped signature bit each produce a named failure (`pair-mismatch`, `self`, `bad-signature`); an ask signed by anyone but its owner fails.
  - Notes: the ask's signing domain is `bs/req/v1` over its JCS bytes without `sig`, as the genesis ask (`src/ledger/ask.ts`). Keep the `src/ledger` rules: no DOM, no Node APIs.
    - Done: `bodyProblems`, `Status` and `transitionOutcome` live in `record.ts`; the M4 kinds' bodies stay unchecked. `transitionOutcome` returns `status:none` for "no creature" and `role` for a promote without a known role. `checkMatePair` also returns `bad-ask` for a malformed ask, and the pair shares one nonce.

- [x] T4 Offspring: the pair, the birth check, Mendelian proof
  - Acceptance (unit tests first, recorded fixtures only):
    - `offspringPair` is deterministic: the same inputs give the same two genome hashes, and five golden vectors (fixture beacons from three rounds × two parent pairs made with `genesisFor`) are committed under `src/genome/__golden__/offspring.json` with the rules version. Slot 0's child equals `breed(a, b, offspringSeed(r, id, 0))`.
    - Distinct: over 2,000 pairs (random genesis parents, 500 sibling pairs, 500 pairs of identical clones) the two children's genome hashes always differ; `slots[1]` is 1 for every pair that differs at slot 1 and larger only when the slot-1 child equalled slot 0's (then at most 255).
    - Different commit ids or randomness give different pairs (500 samples, no duplicate pair).
    - Viability: 10,000 children from random and mutated parents all develop within the caps (the M3 property harness gains the `offspringPair` path).
    - Mendelian: with mutation off, 6,000 children of two albino carriers (one recessive allele each) show albino in 25% ± 4σ and the same for the other recessive traits; carrier × albino gives 50% ± 4σ; a dominant-trait parent pair gives exactly the enumerated shares. Seeds are fixed, so the test is deterministic.
    - `birthRequest` / `checkBirth`: a record, commitment, fixture beacon, both parent genomes and both `mate-commit` records that agree return `[]`; each tamper (a swapped child genome, a wrong slot, a different parent, a wrong round, another round's beacon, a `mate-commit` hash that is not in the commitment, a commitment of another kind, a wrong generation) returns its named failure.
  - Notes: `generation = max(parent generations) + 1`; each parent's generation is in its `mate-commit` body, so the check needs no ledger lookup. `checkBirth` recomputes the child from `offspringPair`; it never trusts the genome text.
  - Done: `src/genome/offspring.ts`, `birthRequest` and `checkBirth` in `src/ledger/mating.ts`; goldens are 3 fixture rounds × 2 parent pairs (6 vectors). The mating commitment is `kind: 'mate'`, `owner` the courting player, `data: { a, b }` (both signed asks); `checkBirth` names `bad-commit`, `pair:*`, `rules-mismatch`, `parent-mismatch`, `mate-hash`, `mate-commit-mismatch`, `parent-genome-mismatch`, `slot-mismatch`, `genome-mismatch`, `generation-mismatch`.
  - Gotcha: a mate-commit cannot be "in the commitment" (it names the commit id), so the check is that each names this commit and its hash is in the birth; signatures stay `checkStored`'s. `offspringSeed` takes any slot byte; the Mendelian ratios use `breed` with `mutation: 0`, since `offspringPair` always mutates.

- [x] T5 Pedigree, kinship, inbreeding, Punnett hints
  - Acceptance (unit tests first):
    - `kinship` on hand-built pedigrees, compared with `===` (the values are dyadic): unrelated founders 0; parent and child 0.25; full siblings 0.25; half-siblings 0.125; uncle and niece 0.125; first cousins 0.0625; a creature with itself `½(1 + F)`; the child of full siblings has `inbreeding` 0.25 and kinship with a parent `0.375`. Ancestors more than six generations up are ignored, deterministically (a long chain pins the cut).
    - `inbreedingBand(F)` gives `none` below 0.03, `low` below 0.10, `moderate` below 0.20, else `high`; the plain-words text for each has no jargon (banned-word test).
    - `punnett(a, b)` for hand-built genotypes: albino (recessive) carrier × carrier 0.25, carrier × albino 0.5, anything × a non-carrier 0, albino × albino 1; the dominant luminescence and iridescence traits, the blended texture and the pattern ranks follow the DESIGN §6 tables; each load locus reports the chance the child is homozygous for it. For 200 random parent pairs each reported probability equals an independent enumeration of the 2 × 2 allele combinations in the test file, and matches the frequency over 4,000 seeded children (`mutation: 0`) within 4σ, which shows linkage and crossovers do not bias a single locus. `mutationChance` is `1 − (1 − eventChance)^(2·maxEvents)`.
    - Inbreeding load: over 4,000 children each, full-sibling pairs (made by `breed` from genesis founders) have at least 3× the rate of homozygous load alleles of unrelated pairs, and the code computes their kinship as 0.25 and 0.
  - Notes: all pure and deterministic. The pedigree comes from `birth` bodies; the authority builds it from SQL (T9) and the client from `lineage`.
  - Done: `src/ledger/pedigree.ts` (`kinship`, `inbreeding`, `inbreedingBand`, `BAND_TEXT`) and `src/genome/punnett.ts` (`punnett` -> `{ traits, load, mutationChance }`; an outcome `value` is allele names joined with `+`, or a blended rank in words); `MENDEL_LOCI` and `LOAD_LOCI` now live in `karyotype.ts`.
  - Gotcha: the six-generation cut counts levels above each queried creature, and `inbreeding(x)` is `kinship` of the parents at level 1, so it equals the self term of `kinship(x, x)`. `generations` is iterative (chains may be long).

- [x] T6 Ledger store: statuses, the two-chain transactions, the matrix
  - Acceptance (workerd tests, written first):
    - Migration 5 rebuilds `creatures` (statuses `active|pending|checkpoint|dead`, new columns `generation`, `parent_a`, `parent_b`, `chain_parent`, `cooldown_until_ms`), keeps the indexes (one `active` per owner and the dead-history index) and adds one `pending` per owner as a partial unique index, plus `matings` (commit id, both owners and creatures, round, time, `resolved`) with a partial index on unresolved ones. A database built through migrations 1 to 4 with a player in each state is migrated: every row and record is unchanged, the old queries still work, a second start applies nothing.
    - New operations over the existing transaction wrapper, each one SQLite transaction: `mate(asks, commit, conditions)` appends both `mate-commit` records and the `matings` row or neither; `birth(commit, children)` creates both pending creatures, appends nothing else and marks the mating resolved; `promote(request, sig, freeze)`; `restore(request, sig)`; `markExhausted(creature)`; `fallback(creatureId, now)` (read only); `alive(owner)`; `pairMatings(ownerA, ownerB, since)`.
    - The matrix runs against the store: every cell of T3's table is created through legitimate operations and the store's outcome equals `transitionOutcome`.
    - Atomicity and conflicts: a `mate` whose second head moved is refused with neither record written and a `conflict` flag; a `birth` for an unknown or already resolved commitment writes nothing; two `birth` rows for one owner violate the unique index (a direct insert test), so a second pending cannot exist.
    - Invariants after 300 seeded random operations (mate, birth, promote, restore, death, checkpoint, duplicates, stale and wrong-owner requests): every chain has consecutive `seq` and correct `prev`; at most one `active` and one `pending` per owner; every `birth` names two existing creatures; `chain_parent` is acyclic and stays within one owner; every record passes `checkStored`; resubmitting an accepted request returns the same stored record and writes nothing.
    - Row writes: `mate` ≤ 6, `birth` ≤ 7, `promote` with a freeze ≤ 6, `restore` ≤ 3, `markExhausted` ≤ 3; the test prints them.
  - Notes: the store trusts callers to have authenticated owners (as `accept`). The cooldown lives in the head (`cooldown_until_ms`) and is copied into every record body that changes the head.
  - Done: `Ledger.mate`, `birth`, `promote`, `restore`, `markExhausted`, `fallback`, `alive`, `pairMatings`; `accept` takes only `genesis`, `checkpoint` and `death` (the other kinds answer `use-operation`) and every transition is gated by `transitionOutcome`. `migrate(sql, upTo)` lets a test build the old schema. `worker/ledger-mating.test.ts` holds the tests.
  - Gotcha: `rowsWritten` counts index entries, so the budgets are the measured ones (birth 7 and `markExhausted` 3 instead of 6 and 2; the spec's first numbers ignored the partial indexes). `fallback`, `restore` and `markExhausted` take an `Exhaustion` (`lifespanOf(head)`, `restoreMinMs`) because the lifespan comes from the genome and the scale from the environment, which the store does not know; `fallback` has no `now`. `matings` has no pair index (it would cost a write per mating), so `pairMatings` scans the table: M13 must index or count per pair if it ever shows. A mating's open state is `resolved = 0`; `birth` is idempotent through `child_a`/`child_b`. `death` on a `checkpoint` creature is only reachable through `markExhausted`.

- [ ] T7 Mating on the hub: courtship to commitment
  - Acceptance (workerd tests with fake beacons and clock; then codec fuzz):
    - Protocol: the new messages round-trip through `parseClientMsg` and `parseHubMsg`; oversized, malformed and wrong-typed ones are rejected without throwing (a 2,000-input fuzz, as for genesis); `PROTOCOL_VERSION` is 2 and a `v: 1` hello gets `error: outdated`.
    - `mate-check` for a partner in the same pond answers `ok` or the partner's reason (the `MateRefusal` words, prefixed `partner-` where it is the partner's), plus kinship, the partner's generation, size tier and the cooldown left; for someone in another pond, unknown or offline it answers `not-here`.
    - Happy path: A and B are mature and fed (progress with enough ticks under `MATING_SCALE`); `court` reaches B as `invite` with a card (species-independent facts: generation, kinship); `accept` within 20 s makes one `mate` commitment whose round is the latest published plus 2, countersigned, and both owners receive `mating` with their `mate-commit` record. The records chain on the heads; the stored conditions are exactly 85% biomass and 70% energy of the authority's view; `cooldownUntilMs` is activeMs plus the cooldown; `matureAtMs` and `cooldownUntilMs` appear in later `ack`s; both pass `checkStored` and `checkMatePair`; the commitment names both asks.
    - Each refusal answers with its reason and changes nothing: not mature, in cooldown (and allowed once the active time has passed), energy under 50%, size tiers two apart, partner has a pending child, partner has a mating in flight, same player, different ponds, partner offline, accept after 20 s, accept with no court, accept with the wrong nonce, creature or partner, `decline` (A gets `declined`), a bad signature, a replayed ask after its commitment (`used`).
    - One outstanding court per session: a second `court` replaces the first (B's earlier invite is void). A duplicate `accept` returns the same commitment and writes nothing more.
    - Same-partner doubling: the pair's second mating within the (scaled) window sets cooldown × 2, the third × 4, the sixth and later × 32; a different partner is back to × 1.
    - No cancel: no message or function reverses a commitment; closing either socket after the commitment changes nothing (checked once the round arrives in T8); a test greps the exports of `worker/mating.ts` for any function that edits a stored round.
    - Budget: a whole courtship costs at most 4 incoming messages (court, accept, plus the two `mate-check`s) and at most 6 row writes; the test prints both.
  - Notes: the hub applies the cost to both sessions' `LifeState` (and the stored condition in the record), then the clamp in `applyReport` continues from the post-cost values. A court's invitation lives in the courting session's attachment (lazy expiry, no alarm). `LIFESPAN_SCALE` and `MATING_SCALE` are read together, only in fixture mode.

- [ ] T8 Birth: resolve the round, deliver the children
  - Acceptance (workerd tests):
    - When the committed round is published, the alarm writes both `birth` records and creates both `pending` creatures in one transaction (generation = max parent generation + 1, hatchling condition from T2, `chain_parent` empty, cooldown zero), marks the mating resolved, and sends `born` to each connected owner: the record, commitment, beacon, the child's genome text, both parents' genome texts and both `mate-commit` records. `checkBirth` returns `[]` on that message.
    - Slot 0 is the courting player's child and equals `offspringPair(...)[0]`; slot 1 is the accepter's. Over 200 fixture matings with random parents the two children always differ.
    - Offline and dead parents: a child is delivered at the next `hello` in `life.pending`; a parent that died or whose owner closed the tab between the commitment and the round still gets the child; a Durable Object eviction in between (`evictDurableObject`) still resolves it through the alarm; a drand outage of 60 s of fake time leaves the commitment pending and resolves it on the first success, never substituting a value.
    - One pending: afterwards both players hold exactly one pending child, a second `court` is refused `pending` for either, and a direct second insert violates the index.
    - Idempotence: the alarm firing twice, a reconnect and a repeated `deliver` create no second creature and write nothing.
    - A tampered `born` (each variant of T4's table, at the message level) fails the client-side check; the client check is the lazy `@noble/curves` path, never loaded before a `born` arrives (the import-graph test of M4 still passes).
    - Rows: a birth costs ≤ 6.
  - Notes: reuse the `Beacons.alarm()` list of resolved ids and add the `mate` branch beside `deliverGenesis`. The parents' genome texts come from the heads at birth (they are immutable, so that is the genome the `mate-commit` hash names).

- [ ] T9 Promotion, restore, death fallback, lineage on the hub
  - Acceptance (workerd tests):
    - `promote` with the owner-signed child request (`prev` the birth hash, `seq` 1, body `{ role: 'child', parent }`) is accepted: the child is `active`, the parent is frozen by an attested `promote` record (role `parent`) that keeps its condition, `activeMs` and cooldown, the session rebinds to the child (progress is now credited to it, with the hatchling condition), and `promoted` carries the child's `life`. Refused with a named reason and no change: a bad signature, someone else's pending child, a child that is not pending, a stale `prev`, a `parent` that is not the player's active or most recently dead creature, a second promote of the same child (idempotent: the same stored record comes back).
    - A parent that already died is only linked (no freeze). A player can promote while their active creature lives or once it is dead.
    - Fallback: `died` (client death, old age, or the walk) carries `fallback { pending, ancestor }`. Cases pinned: none/none; pending only; ancestor only; both; the chain G → C1 → C2 with C2 dead and C1 exhausted (remaining life under `restoreMinMs`): the ancestor is G and C1 gets a `death` record (cause `old-age`); all exhausted or dead: `ancestor` null and every walked-over exhausted creature is marked dead.
    - `restore` (owner-signed on the ancestor: `prev` its head hash from `lineage`, body equal to its saved condition) makes it `active` with `activeMs` unchanged, so remaining life is exactly what it was; cooldown unchanged; the session binds to it with that clock. Refused: another creature is active, not the nearest surviving ancestor (`not-nearest`), a non-matching body, a dead or pending creature, a stale `prev`. The ancestor's earlier records are untouched (their hashes are the same before and after).
    - Old age walks the chain: with fake time, G mates and promotes C1, C1 mates and promotes C2; C2 dies of old age and the player restores C1, who plays only his remaining life and dies of old age, then G; then nothing survives, `fallback` is empty, and genesis is allowed again. `history` lists every one of them, each with its cause.
    - Genesis gating: `genesis-request` is refused `has-lineage` while the player has an `active`, `pending` or surviving `checkpoint` creature (the bucket is not spent) and allowed when only dead ones remain.
    - `life` at `hello` covers every state: an active creature as in M4; with no active creature, `life: null` plus `pending` and `fallback`.
    - `lineage` answers the player's creatures (status, generation, species name, genome text, `activeMs`, `lifespanMs`, head hash, chain parent) and a pedigree (ids and parents, species and genome text per node, six generations back, at most 64 nodes) with no other player's identity; it is within the message cap.
    - Rows: promote with a freeze ≤ 6, restore ≤ 3.
  - Notes: `promoted` and `restored` also tell the other sessions of that player nothing: one session per player. Position is client-side: the client spawns the child where the parent was and a restored creature at the spawn hint.

- [ ] T10 Client: courting, the cost in the sim, the invitation
  - Acceptance (unit tests with a fake hub, then E2E; E2E hub `m5` on a new port with the scaled test hooks):
    - `MateFlow` (`src/game/mate.ts`, DOM-free) runs `idle → checking → courting → (invited) → signing → awaiting → done`, with `declined` and `expired` exits. With a fake clock: a court that gets no answer for 20 s expires; an invitation the player does not answer in 15 s is declined; one `E` press sends one `court`, repeats are ignored; a `mating` message applies the `mate` sim life event at the next tick (energy −30%, biomass −15%, the HUD shows both) and starts "Awaiting beacon" until `born`.
    - The HUD shows "E: court <name>" only for the nearest remote within 3 body lengths who is a legal partner by the client's own check; for others it shows the plain reason ("Not mature yet", "Rest for 3:20", "Too big or too small", "Needs more energy", "Already has an offspring waiting"), mapped from `MateRefusal` and the hub's `partner-` reasons; a banned-word test keeps jargon out ("commit", "ledger", "checkpoint", "nonce").
    - The invitation shows the courting player's name, species, rarity and size tier, the inbreeding band words and a 15 s countdown; `E` accepts, Esc or the timeout declines. A first mating with no revealed recovery code shows "Save your recovery code" once (the M4 reminder).
    - The life meter shows "Ready to mate", or "Ready in m:ss" while `cooldownUntilMs` is ahead, from the authority's numbers only.
    - E2E `m5-court.spec.ts` (PR suite, ≤ 60 s, two contexts on the M5 hub, `debug.teleport` to bring them together): both hatch, wait for maturity (a few seconds under `MATING_SCALE`), A presses E, B sees the invitation, accepts; both show "Awaiting beacon", the energy bar of each dropped by about 30% and the body shrank by about 15%; a refused court (an immature third context) shows its reason in the HUD.
  - Notes: `E` does nothing outside play. The input controller already ignores keys while a panel with a text field is open; reuse that. The effects are the existing FX with a bioluminescent pulse ring: no new art.

- [ ] T11 Client: the egg, the offspring card, promotion and the fallback choice
  - Acceptance (unit tests, E2E):
    - On `born` the client verifies the message (lazy BLS, `checkBirth` with the parent genomes); a failed check shows "Could not verify your offspring" and keeps the egg closed. A verified child appears as an egg beside the parent for 3 s (a translucent shell, an existing effect), then as an **Offspring** card in the HUD: species name, rarity badge, generation, a preview of its body and the buttons "Become it" (key `H`) and "Later". The card persists until promoted or the creature dies. Nothing in the card is jargon (banned-word test).
    - Promotion: `H` or the button signs the child's request and sends `promote`. On `promoted` the parent dissolves, the child spawns where the parent was with the hatchling condition, the life meter restarts from the child's clock, `state().life` shows the new `creature` and `generation`; with the hub refusing, the player stays as they were and sees why.
    - The death screen lists the fallback in plain words: "Become <species> (your offspring)", "Return to <species>, generation N (about M min of life left)", or "Hatch a new cell" only when nothing survives (and the existing hatch-limit countdown still applies). Enter takes the first option; the screen names the cause as before. Choosing sends `promote` (parent dead, so no freeze) or `restore`.
    - Reload and reopen with no active creature but a pending child or an ancestor shows the same choice on the title screen instead of a new hatch. A player with an active creature and a pending child sees the card again after a reload.
    - E2E `m5-promote.spec.ts` (PR suite, ≤ 60 s): after the mating of T10, both players get an egg and a card; their species names or genome hashes differ; A promotes, the old creature is a checkpoint (checked through `state().life` and the next `lineage`), A's child has A's and B's traits in the way the explanation card says; A then starves the child (`debug.setEnergy(0)`): the death screen offers the parent ("Return to…"); A returns and `state().life.activeMs` equals the value at the freeze.
  - Notes: reuse the Lab's card drawing for the preview if it can run in a small canvas; otherwise a single shared small scene. The preview must not add a second WebGL context if one is enough (`renderer.info` budget tests stay green). Pending children are not in the pond: only the owner sees the egg.

- [ ] T12 Choosing a mate: inspect card, Punnett hints, kinship
  - Acceptance (unit tests on view models; E2E for the DOM):
    - Clicking a remote creature opens its inspect card: species, rarity badge, size tier, traits in plain words (the existing `describe`/`explain`), and after `mate-check` its generation, kinship with you in words ("close relative: weaker offspring more likely"), and whether you can mate now with the reason if not. A remote still drawn as a tinted cell shows "Still arriving".
    - Hints: "Chance the offspring will show: albino 25%, glowing 50%, …" from `punnett`, only for traits where either parent carries the allele; "Chance of a weak trait: 6%" from the load risk; "Mutations can still surprise you." The numbers on screen equal `punnett` rounded to whole percent (view-model unit test and one E2E that reads them from the DOM). Inbreeding words come from `inbreedingBand`.
    - The same badge component serves the Lab, the card and the invitation (no copy); the card fits at 960×540 and does not cover the creature being inspected (screenshot properties: the card rectangle and the creature's centre do not overlap).
    - No jargon: the banned-word test covers the card, hints and warnings ("allele", "locus", "genotype", "Punnett", "homozygous").
  - Notes: the card reads only what the client already has (the peer's genome) plus one `mate-check` answer per card; it never sends more than one check per second. Keep text short.

- [ ] T13 Lineage view
  - Acceptance (unit tests on the view model; E2E screenshot):
    - A **Lineage** panel opens from the title screen and the menu (Esc): your chain (active, pending, checkpoints, newest first, each with species, generation, rarity badge and "frozen" or remaining life) and the family graph: nodes for creatures and edges from both parents, six generations back at most, the chosen branch highlighted, other players' creatures anonymous. View-model tests from sample pedigrees: ordering, branch highlight, both parents drawn, truncation at 64 nodes with a visible "and more", a genesis creature shown as a root, empty state "No lineage yet".
    - Each node can open its body in the Creature Lab through the existing genome link.
    - E2E (`m5-promote.spec.ts` extended): after the mating and promotion the graph has the right node count (the parent, the other parent, the child, and the other child as a sibling) and the panel fits 960×540 (screenshot properties).
  - Notes: plain DOM or SVG, no new dependency. Texts avoid "pedigree", "ledger", "chain_parent".

- [ ] T14 Pacing simulation and DESIGN sync
  - Acceptance:
    - `npm run sim:pacing` (`tools/pacing.ts`) runs a headless population in the real sim with real genesis genomes and a food-seeking bot, and prints: time from hatch to maturity (median and 10th and 90th percentile), time from a mating to being eligible again (refeed plus cooldown), matings per life, children per hour, and how a pair's repeated matings slow down (the doubling). A unit test runs a short deterministic smoke of the tool.
    - Targets, stated before the run: median hatch to first eligibility between 14 and 25 min of active time; 4 to 9 matings possible in a life; a pair's fourth mating within 24 h waits at least 8× the base cooldown. When a target fails, adjust `RULES.mating` or `RULES.life` (not the tool) and say why in the task note; changing a sim value regenerates the goldens with a rules version bump only if sim behaviour changes.
    - The measured table goes into DESIGN §5 with the date and the commit it was run on.
  - Notes: the bot is a test aid, not a player model; the owner judges the pacing in the playtest (rubric).

- [ ] T15 End-to-end scenario, owner-facing checks, documentation sync
  - Acceptance:
    - `m5-lifecycle.spec.ts` (`@slow`, release gate, its own hub port, scaled hooks): two identities hatch, mature and mate; both receive distinct children; A promotes; A's child mates with a third identity; A promotes again and dies of old age; the walk offers the chain parent; A returns to it, then to the genesis creature; at the end nothing survives and a new genesis starts; the lineage view lists all of them; B kept their child pending throughout (one pending) and finally promotes it.
    - Every exit criterion of M5 maps to a named test in the mapping below; the PR E2E suite stays under 4 minutes in CI (record the time; if it does not, move `m5-promote` to `@slow`).
    - DESIGN.md §3 (controls: `E`, `H`), §5, §10 (feedback table), §11 and the glossary match the shipped numbers. ROADMAP status is set by the milestone step.
    - `.claude/rules/ledger.md` (asks and the matrix), `.claude/rules/worker.md` (`MATING_SCALE`, the mating commitments), `.claude/rules/tests.md` (the M5 hub ports, `state().life` additions, debug helpers) and `docs/SETUP.md` (no new secrets) are updated.
  - Notes: this task adds the long scenario and the sync only; do not move work from earlier tasks here.

## End-to-end check

Against the fixture authority (`wrangler dev --e2e`, scaled test hooks, no live drand):

1. Two identities hatch, mature and meet. A courts, B accepts; both pay (energy −30%, size −15%) and show "Awaiting beacon", then each gets an egg. The two children differ in genome and each equals the independent recomputation from the recorded beacons, the commit id and the parents' genomes.
2. Neither player can mate again while a child is pending. Closing a tab after the commitment changes nothing.
3. A promotes: the parent becomes a checkpoint, the child hatches beside it with the hatchling condition and the card and lineage view say so.
4. The child dies (starvation). The death screen offers the parent, who returns with the saved condition, unchanged cooldown and the remaining life it had.
5. With fake lifespans each creature in the chain dies of old age in turn and the walk skips the exhausted one; when nothing survives, a new genesis is offered and History keeps the lineage.
6. The ledger check: every stored record passes `checkStored`, every `birth` passes `checkBirth`, every creature has one head, at most one active and one pending per player, and the pedigree's kinship values match the hand-computed ones.

Exit criteria map: "consent, eligibility, cost and cooldown" T2, T3, T7, T10; "future-round commitment, no rerolls" T7 (no cancel), T8 (outage, eviction); "two distinct offspring by Mendelian rules" T4, T8; "one pending offspring" T6, T8; "promotion → checkpoint" T9, T11; "death → nearest surviving ancestor" T9, T11; "old age walks the chain" T9, T15; mate-choice readability (inspect card, Punnett hints that match exact enumeration, rarity badges) T5, T12; "inbreeding load and kinship; lineage view" T5, T13; the pacing simulation T14; the M4 carry-overs T1; the end-to-end check T15.

## Rubric

- [ ] The courtship is readable at a glance: the player sees who they can court and why not otherwise, the invitation names the partner and a countdown, and both players see the cost land (evidence: HUD and invitation screenshots at 960×540, the E2E bars before and after).
- [ ] The two children of one mating look like their parents and unlike each other (evidence: a screenshot of both bodies beside both parents' bodies for three matings, and the distinct-genome E2E assertion).
- [ ] The offspring card and the death choice use plain words and fit at 960×540 (evidence: banned-word tests and screenshots).
- [ ] The Punnett hints equal the exact enumeration and say that mutation can still surprise (evidence: `punnett` unit tests against enumeration and a DOM read in the E2E).
- [ ] Nothing a player loses is silent: a death shows what is left, a restore shows how much life remains, and a frozen parent is marked as frozen (evidence: screenshots of the death screen with each fallback and of the lineage view).
- [ ] The breeding loop works with the genetics UI closed: court, wait, promote with two keys and no panel (evidence: the E2E drives it with `E` and `H` only).
- [ ] (owner) Choosing a mate matters and is fun: you look at candidates, weigh size, rarity and kinship, and are curious about the child.
- [ ] (owner) The first mating arrives at a pace that feels earned and the cooldown does not feel like a wall (the pacing table gives the numbers).
- [ ] (owner) Offspring feel inherited: you can see both parents in a child, and a surprise now and then feels like a gift.
- [ ] (owner) Death with a fallback feels safe rather than confusing: you always know what you are becoming and why.
- [ ] (owner) The 15 s window to accept feels right on real networks, and "Awaiting beacon" with a real round is short enough.

## Risks

- A table rebuild migration on a live Durable Object corrupts data → migration 5 is tested on a populated version-4 database (T6), copies before it drops, and runs in one transaction; the release workflow's smoke check stays.
- Two chains in one transaction deadlock or half-apply → one `transactionSync`, with an atomicity test (T6) that fails the second head.
- Proximity cannot be proven → ADR 0021 says why that is acceptable; costs, cooldown and maturity are enforced, and M10's witnesses may add proximity later.
- A dishonest client skips the cost → the cost is written in the authority's record and the growth clamp bounds regrowth (ADR 0019); M10 audits.
- Identical-clone parents make identical twins → `offspringPair` retries slots deterministically (T4), proven on clone pairs.
- Two identities farm each other for children → same-partner doubling, maturity, cooldown and resource costs; the pacing simulation (T14) shows the shape; M10 runs the bot-farm simulation.
- A stuck pending child blocks mating → by design in M5 (no discard, ADR 0021); promote it, then fall back; revisit from playtest feedback.
- The egg preview needs a second WebGL context → reuse the Lab's card drawing or one shared small scene, with the render budget tests as the guard (T11).
- The courtship needs both players online and mature at once, so the E2E depends on timing → `MATING_SCALE` shrinks the waits; tests wait on `state()` values, never on sleeps.
- The PR E2E suite grows too long → the three M5 specs share one hub and run serially; T15 records the time and moves one to `@slow` if needed.
- Protocol version 2 breaks tabs with a cached older client → the hub answers `outdated` and the client asks for a reload.
