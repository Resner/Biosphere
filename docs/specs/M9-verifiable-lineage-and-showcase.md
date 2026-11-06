# M9: Verifiable lineage and showcase

Release: v0.10.0 · Gate: no

## Goal

Anyone can check a creature's whole history without trusting a player's word, and players can show their creatures off.

- **A creature card for every creature.** `card.html?c=<creature id>` on the Pages site shows:
  - the creature, drawn as in the game, with its name, rarity, generation and life story;
  - a verdict in plain words: "Verified back to genesis", or the first thing that doesn't hold;
  - a lineage graph whose nodes open each ancestor's card.

  The page fetches the proof and checks it in the browser. It works while the owner and every peer are offline, and it names no player.
- **Anyone can verify independently.** The proof bundle is canonical JSON, and `verifyLineage` is a pure function shared by the card, the CLI (`npm run verify:lineage`) and the tests. It checks five families:
  - chains;
  - signatures and key history;
  - genesis and births, recomputed from the committed drand beacons and both parents;
  - time gates, costs and growth;
  - fight settlements, replayed from their logs on request.

  Any tampering is named. `docs/VERIFY.md` says what this proves and what it doesn't.
- **The authority serves what verification needs.**
  - `GET /v1/proof/<creature>` is minimal: the subject's chain, and each ancestor's chain only up to the record that ties it to its descendant.
  - It is bounded at 64 creatures and 512 KB, and `more` names the rest.
  - `GET /v1/fight/<enc>` serves a fight's log and settlement.
  - Both are edge-cached and metered.
- **The authority audits itself.**
  - The clock and growth bounds the authority enforces are exactly the ones the verifier checks, per record interval.
  - Conflicts, replays and implausible progress are flagged, travel in the bundle, and are counted at `GET /v1/audit`.
- **Bounded storage.** The history is kept for good. Fight logs are packed and kept for 14 days, and `docs/perf/storage.md` measures the bytes per player-hour.

The decisions behind this milestone:
- ADR 0009 is the contract.
- ADR 0055 covers the proof bundles, the verifier, the shared rulebook and the per-record bounds, the rules registry, the audit, the cards, and the third world renewal: rules 11, epoch 3, protocol 9.
- ADR 0056 covers retention and the storage budget.

`docs/DESIGN.md` §5 and §11 hold the values, marked (M9) until T15 drops the marks.

This milestone has **no gate**. v0.10.0 opens its `Playtest:` issue, and M10 starts without waiting. **The world is renewed** at this release: players keep their identities and lose their creatures. The release notes and the Playtest issue say so.

## Carried over

The owner gave no new points: Playtest v0.8.0 (#311) says "Keep going", and no v0.9.0 reply has come. M8's close review handed these edge cases to M9, and none breaks an exit criterion:

| Gap | Task |
|---|---|
| `sendLife` takes the stored away report before it knows the socket is open, so a socket that closed first loses the one-shot report | T9 |
| `progress` and `saveOnClose` treat a lock still asking (no fight yet) as a fight, which drops that stretch's credit and checkpoint | T9 |
| A fight whose saved log no longer rebuilds is only closed in `recover`, and its connected players are told nothing | T9 |
| Settlement and life timestamps use `Date.now()` where the rest of the fight code uses `hub.clock.now()` | T9 |

## Out of scope

- **M10:**
  - witnesses and witness attestations;
  - signed fight inputs and movement audits: until then a fight's inputs and a client's free-roam claims are the authority's and the client's word, which `docs/VERIFY.md` states;
  - the `authority-only` flag on settlements;
  - the bot-farm simulation.
- **M13:** the capacity model, admission by storage, and checkpoint compaction (ADR 0056).
- **M14:** the freeze of rules versions and permanent lineages (ADR 0040; the M14 spec writes that ADR). The registry is built here with one live version.
- **A global transparency log** over every record (ADR 0055 rejects it for now).
- Player names or profiles on cards, comments, likes or any social feed.
- New genes, combat changes and look passes. The card draws creatures with the existing meshes and materials.
- Touch controls. The card page must still work at phone width (no horizontal scroll), because links get opened on phones.

## Touches

- **New:**
  - ledger:
    - `src/ledger/registry.ts`, `src/ledger/gates.ts`, `src/ledger/proof.ts`;
    - `src/ledger/verify.ts` with one file per family: `verify-chain.ts`, `verify-origin.ts`, `verify-gates.ts` and `verify-fights.ts`;
    - `src/ledger/__golden__/lineage.json`;
  - tests: `tests/lineage-fixture.ts`, the honest history every verifier test tampers with;
  - worker: `worker/proof.ts` (bundles and fight proofs, reads only), `worker/audit.ts` (the flag catalogue and counts), `worker/storage.ts` (packing, pruning, the size);
  - the card page:
    - `card.html` and `src/card/`: `main.ts`, `card.ts`, `card-view.ts`, `verify-worker.ts`, `lineage-graph.ts` (T13), `card-image.ts` (T14), `hook.ts`;
    - the build's third input in `vite.config.ts`;
  - tools: `tools/lineage.mjs` with `tools/verify-lineage.ts` (`npm run verify:lineage`), and `tools/storage.mjs` with `tools/storage-report.ts` (`npm run report:storage`, which writes `docs/perf/storage.md`);
  - docs: `docs/VERIFY.md`;
  - E2E: `tests/e2e/m9-*.spec.ts` on hubs 8818–8821.
- **Changed:**
  - ledger: `src/ledger/{record,genesis,mating,settlement}.ts`, `src/net/encounter-verify.ts` (the registry's `rules-retired`);
  - worker:
    - `worker/{schema,authority,index,ledger,ledger-encounter,ledger-types,mating,offspring,lives,life,sessions,recover,settle,fight-store,usage,e2e-entry}.ts`;
    - `tools/worker-bundle.test.ts`;
  - net: `src/net/protocol-defs.ts` (protocol 9);
  - game: `src/game/{lineage-panel,lineage-view,screens}.ts`, `index.html` (the renewal line);
  - sim: `src/sim/rules.ts` (`RULES_VERSION` 11);
  - docs: DESIGN §5 and §11, `docs/TESTING.md`, `.claude/rules/{ledger,worker}.md`, `CLAUDE.md` (the `src/card/` line in Architecture).

`worker/ledger.ts` is at 1,003 lines. No task grows it: new reads live in `worker/proof.ts` and `worker/audit.ts`, which query SQLite themselves (reads only, counted like `Ledger.run`). A task that must change `ledger.ts` moves code out first.

**Shared shapes.** Tasks that run in parallel build to these. A later task maps between them rather than redefining them.

```ts
// src/ledger/registry.ts (T1), ADR 0055
export const FIRST_LIVE_RULES = 11;                 // the renewal of v0.10.0; record.ts's `retired()` goes
export type RulesPart = 'genesis' | 'inherit' | 'body' | 'life' | 'mating' | 'encounter';
export interface RulesEntry { rules: number; epoch: number; since: Readonly<Record<RulesPart, number>> }
export const REGISTRY: readonly RulesEntry[];       // [{ rules: 11, epoch: 3, since: every part 11 }]
export function rulesStatus(rules: number): 'live' | 'retired' | 'unknown';
// checkStored, checkGenesis, checkBirth and verifyEncounter answer 'rules-retired' or 'rules-unknown' through it.

// src/ledger/gates.ts (T1): the one rulebook of the authority and the verifier. Hundredths and ms.
export interface Scales { lifespan: number; mating: number }      // each in (0, 1]; 1 in production
export const LIVE_SCALES: Scales;
export interface Condition { biomass: number; energy: number; health: number }
export function lifespanOf(genome: Genome, s: Scales): number;
export function matureAtOf(genome: Genome, s: Scales): number;    // active ms
export function matureBiomassOf(genome: Genome, s: Scales): number; // hundredths, as the hub applies the share today
export function cooldownOf(prior: number, s: Scales): number;     // prior: the pair's earlier matings in the window
export function restoreMinOf(s: Scales): number;
export function startOf(kind: 'genesis' | 'birth', genome: Genome): Condition;  // the starter cell, or the hatchling
export function paidFor(before: Condition): Condition;            // moved from worker/life.ts
export function growthReach(from: number, genome: Genome, activeMs: number): number;
//   hundredths, floored: max(from, starter) × exp(maxRate × growth × 1.1 × activeMs ÷ 1000) + 1 wu,
//   with `exp` from src/sim/math.ts; `from` is in hundredths and the slack is once per call
export const CLOCK_SLACK_MS: number;                               // RULES.life.accrueSlackMs (2 s)

// src/ledger/record.ts (T1), rules 11: every body typed, unknown fields refused
// genesis     { commit, round, genome, generation, karyotype }
// birth       { commit, round, slot, parents, mates, genome, generation, karyotype }
// checkpoint  { activeMs, biomass, energy, health }
// mate-commit { commit, round, role, partner, partnerCreature, genome, partnerGenome, generation,
//               activeMs, biomass, energy, health, cooldownUntilMs, biomassBefore, energyBefore, healthBefore }
// promote     child { role, parent } | parent { role, child, activeMs, biomass, energy, health, cooldownUntilMs }
// restore     { from, activeMs, biomass, energy, health, cooldownUntilMs }
// encounter   { enc, outcome, frames, biomass, energy, health, reward, activeMs }
// death       { cause, activeMs, biomass }, plus { enc, by } for 'killed' and 'eaten', and { enc } alone
//             for any other cause a fight's settlement wrote (a hazard during the fight), so T6 can tie it

// src/ledger/proof.ts (T3)
export const PROOF_MAX_CREATURES = 64;
export const PROOF_MAX_BYTES = 524_288;
export interface AuthorityKey { id: string; publicKey: string; from: number }   // as /v1/pubkeys lists it
export interface AuditFlag { creature: string; kind: string; t: number }
export interface ProofBundle {
  v: 1; kind: 'proof'; subject: string;
  world: { epoch: number; rules: number; scales: Scales };
  keys: AuthorityKey[];
  creatures: { id: string; genome: string }[];   // the subject first, then ancestors nearest first
  records: StoredRecord[];                       // per creature from seq 0, no gap: the subject's whole chain,
                                                 // an ancestor's up to the record that ties it to its descendant
  commits: SignedCommit[];                       // every genesis and mating commitment a record names
  beacons: Beacon[];                             // every committed round
  settlements: SignedSettlement[];               // every encounter a record names
  flags: AuditFlag[];                            // the authority's notes on the held creatures (T8 fills the kinds)
  more: string[];                                // parents of held creatures that are not held
  t: number;                                     // when the authority served it
}
export interface FightProof { settlement: SignedSettlement; log: FightLog | null }   // null once pruned (T10)
export function parseProofBundle(json: unknown): ProofBundle | null;   // untrusted: never throws, caps every list
export function parseFightProof(json: unknown): FightProof | null;

// src/ledger/verify.ts (T3)
export type Family = 'chain' | 'signature' | 'origin' | 'gates' | 'fights';
export interface Problem { creature: string; seq: number | null; family: Family; code: string }
export interface LineageReport {
  subject: string;
  problems: Problem[];                 // empty when everything checked holds
  held: number;                        // creatures checked
  missing: string[];                   // bundle.more: not checked
  toGenesis: boolean;                  // every ancestor path of the subject ends at a held, checked genesis (T4)
  generations: number;                 // generations back from the subject the checked graph reaches (T4)
  unchecked: string[];                 // held creatures whose birth names a parent not held (T4)
  fights: { settled: number; replayed: number; pruned: number; unreplayed: number };   // T6
  scaled: boolean;                     // a scale below 1: a test world
  keys: 'bundle' | 'pinned';
}
export interface VerifyOptions {
  keys?: readonly AuthorityKey[];                          // pinned keys in place of the bundle's
  logs?: ReadonlyMap<string, FightLog | null>;             // enc → log; null when pruned
  replay?: (s: SignedSettlement, log: FightLog, keys: readonly PubKey[]) => string[];  // verifyEncounter
}
export function verifyLineage(bundle: ProofBundle, opts?: VerifyOptions): LineageReport;   // never throws
export function problemText(p: Problem): string;          // one plain sentence, no raw code
// One file per family, each `(index: BundleIndex, opts: VerifyOptions) => Problem[]` (T3 lands T4–T6's as
// stubs returning []): verify-chain.ts (T3), verify-origin.ts (T4), verify-gates.ts (T5), verify-fights.ts (T6).
// `BundleIndex` (T3, verify.ts): creatures, records by creature, commits by id, beacons by round,
// settlements by enc, the keys in force, and each held creature's parents and chain parent.

// worker/proof.ts (T7): reads only
export function proofBundle(hub: Hub, creature: string, now: number): ProofBundle | null;
export function fightProof(hub: Hub, enc: string): FightProof | null;
// GET /v1/proof/<64 hex> and GET /v1/fight/<64 hex>: 200 | 400 { error: 'id' } | 404 { error: 'not-found' }
//   | 503 { error: 'busy' } with Retry-After, past 80% of the daily request budget
// GET /v1/audit (T8): { since, day: Record<kind, number>, total: Record<kind, number>, storage?: { bytes, limit } (T10) }

// The card page (T12): card.html?c=<creature id>, with ?hub= honoured for localhost only, as the game does
// window.__card.state(): { phase: 'loading' | 'verifying' | 'done' | 'error', error, subject, species, tier,
//   generation, status, verdict: 'verified' | 'failed' | null, scaled, toGenesis, problems: string[],
//   missing: number, fights, drawn, graph (T13), image (T14) }
```

## Tasks

T1, T2 and T9 need nothing and can start at once. T3 follows T1. Then the verifier families T4, T5 and T6 and the endpoints T7 can run beside each other. The card (T12) follows T7. The CLI (T11) and the audit (T8) follow the families and T7, and retention (T10) follows the audit. T13 and T14 follow the card and can run beside each other.

### The rules and the world

- [x] T1 Rules 11: the registry, typed bodies, a mating's condition before its cost, and one rulebook [opus] (after none)
  - Done: `registry.ts`, `gates.ts` (with `reachAt`, `repeatWindowOf`, `vitalsCap`), every body typed, `scalesOf(env)` in `worker/mating.ts`; goldens regenerated by the version alone. A hazard death inside a fight keeps `enc` (the settlement writes it), so the death shape allows `enc` without `by`.
  - Gotcha for T5/T8: the hub never checked the maturity size (`ownRefusal` checks time, cooldown and energy only), so `biomassBefore ≥ matureBiomassOf` is new to the authority too.
  - Steps:
    1. `RULES_VERSION` 11, with the registry above in `src/ledger/registry.ts`.
       - `FIRST_LIVE_RULES` moves there as 11.
       - `retired()` and `ENCOUNTER_CLOCK_RULES` go. Every check answers through `rulesStatus`.
       - A test fails when `RULES_VERSION` has no entry, or when an entry's `since` names a later version than the entry's own.
       - Regenerate every golden the version touches (the record goldens, `settlement.json`, and the free-roam and encounter goldens by the version alone), and list them in the PR. DESIGN's opening line says rules version 11.
    2. Type every record body (the shapes above).
       - `bodyProblems` refuses an unknown field for every kind (`unknown:<field>`).
       - The writers produce exactly these shapes: an old-age death of an exhausted checkpoint (`markExhausted`) writes `{ cause, activeMs, biomass }`, and an eaten child's death adds its `activeMs` (0) and `biomass`.
    3. `mateRequests` (`worker/mating.ts`) writes `biomassBefore`, `energyBefore` and `healthBefore`: the condition the cost was paid from.
    4. `src/ledger/gates.ts` (the shapes above): move `lifespanOf`, `matureAtMsOf`, `cooldownFor`, `repeatWindowMs` and the restore minimum out of `worker/{lives,mating}.ts`, `paidFor` out of `worker/life.ts`, and the clamp's reach out of `clampCondition`.
       - The worker calls them with the scales it runs under (`scalesOf(env)`, from `fixtureScale`).
       - `growthReach` uses `exp` from `src/sim/math.ts`, not `Math.exp`.
       - Behaviour stays as it is: T8 moves the bounds to the record interval.
    5. `.claude/rules/ledger.md`: typed bodies, the registry and the rulebook.
  - Acceptance (tests first):
    - `rulesStatus` gives `retired` for 10, `live` for 11 and `unknown` for 12. `checkStored`, `checkGenesis`, `checkBirth` and `verifyEncounter` answer `rules-retired` and `rules-unknown` for records and settlements of rules 10 and 12.
    - For every kind, the golden records pass `bodyProblems`. An extra field gives `unknown:<field>`. A `mate-commit` without `biomassBefore` gives `missing:biomassBefore`. A `killed` death without `enc` gives `missing:enc`. A `checkpoint` with `cooldownUntilMs` gives `unknown:cooldownUntilMs`.
    - A hub mating writes both `mate-commit` records with the condition before the cost, and `paidFor(before)` equals each record's condition.
    - The hub's numbers don't move: every existing hub and unit test of lifespan, maturity, cooldown, restore and progress passes unchanged.
    - `growthReach`:
      - it agrees with the old `Math.exp` reach within one hundredth over 10k seeded samples;
      - a pinned table of 64 values is equal in Node and in workerd (a test in each pool).
    - `tools/worker-bundle.test.ts` still finds no scale honoured outside fixture mode.
  - Notes: no world renewal here (T2), and no new bound (T8). T1 must not grow `worker/ledger.ts`.

- [x] T2 The world renewal: migration 8, protocol 9, the notice (after none)
  - Steps:
    1. Migration 8 in `worker/schema.ts`, a `(sql, now)` step like migration 6:
       - delete every creature, record, commitment, mating, genesis-log entry and encounter (its log and settlement);
       - clear `players.pending` and `players.fight_report`, and refill every hatch bucket;
       - set `world` to epoch 3 with the migration's time.

       Keep players, keys, names, usage, flags, beacons and ponds.
    2. `PROTOCOL_VERSION` 9: a protocol-8 hello gets `error: version`, so no pond mixes epochs.
    3. The notice reads "The world was renewed in v0.10.0. Your identity is kept; your creatures start again." It is told once per identity first seen before the reset (`epoch_seen` below 3), and never to a new one.
    4. DESIGN §5 ("World renewal"): epoch 3. Update `.claude/rules/worker.md` (migration 8).
  - Acceptance (tests first):
    - On a database at migration 7 with a row in every table:
      - after migration 8, identities, keys, usage, flags, beacons and ponds survive;
      - creatures, records, commitments, matings, the genesis log and encounters are empty;
      - every bucket is full, `pending` and `fight_report` are empty, and `world` holds epoch 3.
    - A returning identity gets `renewed: true` in its first `life` and never again. A new identity never gets it.
    - A protocol-8 hello is refused.
    - `m6c-reset.spec.ts` (hub 8804, the pre-reset hook) passes with the new line.
  - Notes: the record shapes are T1's. The two tasks touch different files and may land in either order.
  - Done: migration 8 deletes the fights' logs and away reports too and keeps `epoch_seen`, so every identity is told once for epoch 3; `renewal.test.ts` covers migrations 6 (`migrate(sql, 6)`) and 8 separately.
  - Gotcha: the client's notice text lives in `index.html` and in `m6c-reset` and `m6c-lifecycle`.

### The verifier

- [x] T3 Proof bundles and the chain verifier [opus] (after T1)
  - Done: `proof.ts`, `verify.ts` (index, report, `PROBLEM_TEXT`), `verify-chain.ts`, the family stubs (with `reachOf` and `fightsOf` for T4 and T6), `tests/lineage-fixture.ts` (`lineageHistory`, `bundleOf`, `resign`) and `lineage.json`. Honest hub egg flags mean A1's kill also eats B1's egg (T6's eaten-egg case is in the one fight).
  - Gotcha: Ed25519 via noble took 1.5 ms a signature, so countersignatures go through `key-verify.ts` (the key tabled once, held equal to `verify` by its test); T4–T6 add their codes to `PROBLEM_TEXT`.
  - Steps:
    1. `src/ledger/proof.ts`: the bundle and fight-proof shapes, with `parseProofBundle` and `parseFightProof` for untrusted JSON.
       - Each list and string is capped: at most 64 creatures, 4,096 records, 512 keys and so on; a genome text of 595 characters; hex ids.
       - Records are checked with `recordProblems`.
       - A bundle over `PROOF_MAX_BYTES` (its JSON length) is refused.
    2. `src/ledger/verify.ts`: `BundleIndex`, `verifyLineage`, `problemText` and the family stubs (the shapes above).
       - The keys in force are `opts.keys`, else the bundle's.
       - `scaled` is true when a scale is below 1.
    3. `src/ledger/verify-chain.ts`, the chain and signature families:
       - each record's hash;
       - `seq` from 0 without a gap or a repeat (two records for one `seq` are `fork`);
       - `prev` = the previous record's hash;
       - the creature id = the first record's hash, and one owner throughout;
       - the ADR 0021 matrix from no status (`transitionOutcome`);
       - owner signatures: required on `promote` (child) and `restore`, refused on every other kind (`authorityOnly` and the attested kinds);
       - the countersignature of every record, commitment and settlement, under a key in force whose id derives from its public key;
       - key history: a key's `from` is no later than the record's `t`. A commitment's key must be in force by the `t` of the first record that names it, because in fixture mode commitments run on the recorded rounds' clock.
    4. `tests/lineage-fixture.ts`: an honest authority in Node, with a fixed authority key, two owner keys and the recorded beacons of `tests/fixtures/drand/`. It writes one history that holds every kind:
       - two genesis creatures, A0 (player A) and B0 (player B), with checkpoints;
       - their mating, two births A1 and B1, and A promoting to A1 (A0 frozen);
       - a fight between A1 and B0, built like M8 T4's golden settlement (an `EncStart` of their genomes and conditions, `null` inputs, `settlementOf`), with a pond seed picked and pinned so that A1 kills B0. B0 carries B1 as an egg (B1 is pending), so the kill eats it and B1 dies `eaten` in the same settlement;
       - A1 dying of a toxin, and A restoring A0.

       Every value comes from the gates' functions, under scales it is given. `src/ledger/__golden__/lineage.json` pins the bundle with A1 as its subject.
    5. Update `.claude/rules/ledger.md` with the bundle and the verifier.
  - Acceptance (tests first):
    - `verifyLineage(golden)` gives no problems.
    - `parseProofBundle` round-trips the golden. 10k fuzzed JSON values never throw, and a bundle with 65 creatures, a 600 KB string or a non-hex id parses to null.
    - Each tamper gives its named problem on the right creature and record:
      - a body field changed (`hash`);
      - `prev` changed, a `seq` gap, a second record for one `seq` (`fork`);
      - the creature id not the first record's hash;
      - another owner mid-chain;
      - a restore on an active creature (`status:active`);
      - an owner signature on a `checkpoint`, and none on a child `promote`;
      - a countersignature byte flipped, on a record, a commitment and a settlement;
      - an unknown key id;
      - a key whose `from` is after the record's `t`;
      - pinned keys that lack the bundle's key.
    - `problemText` gives a plain sentence for every code the five families can produce, with no raw code in it (a test lists them).
    - `speedTest`: the chain and signature families on a 64-creature, 400-record bundle take under 1 s in Node.
  - Notes: the other families are stubs here. T4–T6 add their tamper tests to the same golden and never change its honest history, so they can run in parallel.

- [x] T4 Origins: genesis and births recomputed [opus] (after T3)
  - Done: `verify-origin.ts` (with `unchecked` on the report, the origin codes in `PROBLEM_TEXT`, and `firstNamers`/`whereNamed` shared from `verify-chain.ts`); tests in `verify-origin.test.ts`. A birth's parent genomes are taken in its `mates` order, and each `mate-commit`'s generation must be its creature's.
  - Gotcha: a forged commitment changes the genesis draw (the seed hashes the commit id), so a timing tamper must redraw the genome to isolate `round-not-future`.
  - Steps: `src/ledger/verify-origin.ts`, for each held creature's first record:
    - **genesis**: `checkGenesis` with its commitment and beacon, and the genome text against the record's genome hash;
    - **birth**: `checkBirth` with its commitment, beacon, both parents' genome texts and both `mate-commit` records. Each parent's genome text must hash to the genome its own first record names. Each `mate-commit` must be the last record of its parent's held prefix, or within it.
    - **commitment timing**: the committed round was not yet published at the commitment's `t` (`roundTime(round) > t`, `round-not-future` otherwise). The commitment's countersignature (the chain family's) and its asks' signatures are checked.
    - **the graph**: `toGenesis` and `generations`. A creature whose parent is in `more` is reported unchecked, which is not a problem.
  - Acceptance (tests first):
    - The golden has no origin problems, `toGenesis` is true and `generations` is 1.
    - Each tamper gives its named problem:
      - a genesis genome hash;
      - a beacon's signature;
      - the record's round;
      - a commitment whose round was published before its `t` (`round-not-future`);
      - a genesis ask signature;
      - a birth's slot;
      - its parents swapped;
      - a parent genome text that doesn't hash to its first record;
      - a `mate-commit` from another mating;
      - a birth's generation;
      - a parent prefix that stops before the `mate-commit` the birth names.
    - Without A0 in the bundle (moved to `more`), there is no problem, but `toGenesis` is false and A1's origin is reported unchecked.
    - `speedTest`: origins for 64 creatures (64 BLS verifications and 64 developments) take under 5 s in Node.

- [x] T5 Time gates, costs and growth [opus] (after T3)
  - Done: `verify-gates.ts` walks each chain with its clock, condition and cooldown (`hasMatingEnergy` and `cooldownsOf` join `gates.ts`); fight records and a settlement's checkpoint before a death only keep the clock from going back (T6 bounds them). The spec's parent `promote` was wrong: the hub freezes the live condition, so only its cooldown is kept.
  - Gotcha for T8: `ownRefusal` (hub and client) never checks the maturity size, so a hub mating under 60% of adult size (E2E courts wait on time alone) fails `mature-size` until the authority refuses it.
  - Steps: `src/ledger/verify-gates.ts`. Per held creature, record by record, under the bundle's scales and the T1 rulebook:
    1. **The clock**:
       - `activeMs` never decreases;
       - from one record carrying it to the next, outside fights, it rises by at most the records' `t` difference plus `CLOCK_SLACK_MS`. A fight record's limit is T6's;
       - no record but a `death` follows the lifespan;
       - an `old-age` death is at the lifespan, or on a checkpoint with less than the restore minimum left.
    2. **Matings**, at each `mate-commit`:
       - `activeMs` ≥ `matureAtOf`, `biomassBefore` ≥ `matureBiomassOf`, and `energyBefore` ≥ 50% of the maximum energy of `biomassBefore`;
       - `activeMs` ≥ the previous `mate-commit`'s `cooldownUntilMs`;
       - `cooldownUntilMs − activeMs` equals `cooldownOf(k)` for some k from 0 to 5. Which k the authority counted can't be checked (VERIFY.md);
       - the condition equals `paidFor(before)`.
    3. **Growth**:
       - the first condition is within `growthReach(startOf(kind, genome), genome, activeMs)`;
       - each later condition is within the reach from the previous record's condition over the `activeMs` between them, a mating's `before` included;
       - energy and health are at most what that biomass allows.

       A fight's records are T6's.
    4. **Freezes and returns**:
       - a `restore` keeps the condition, `activeMs` and `cooldownUntilMs` of the record before it, and needs at least the restore minimum left;
       - a parent's `promote` keeps the cooldown of the record before it. Its clock and condition are the session's last report (`promoteChild` freezes the live life), so they are bound like a checkpoint's;
       - a pending child's clock stays 0 until its child `promote`.
  - Acceptance (tests first):
    - The golden has no gate problems. The same history built under scales `{ lifespan: 0.05, mating: 0.01 }` verifies with `scaled: true`, and that bundle with its scales changed to 1 fails `mature-time`.
    - Each tamper gives its named problem:
      - the clock going back;
      - a rise of `t` difference + 2,001 ms;
      - a checkpoint after the lifespan;
      - an old-age death 1 ms early;
      - a mating 1 ms before maturity, 1 hundredth under the maturity size, and 1 hundredth under half energy;
      - a mating 1 ms inside the cooldown;
      - a cooldown of 1 ms less than the base;
      - a cost 1 hundredth off;
      - a `biomassBefore` 1 hundredth beyond the reach;
      - a checkpoint's biomass 1 hundredth beyond the reach;
      - energy above the maximum;
      - a restore that changes its health or clock;
      - a restore with 1 ms less than the minimum left;
      - a first checkpoint beyond the start's reach.
    - Each limit exactly met passes: the gates are inclusive, as the authority's are.
  - Notes: honest play never leans on a slack, so a hub history (T7) that fails a gate before T8 has landed points at a bug in the hub or in the gate. Find which, and fix that side. The per-report slack that T8 removes matters only to adversarial clients.

- [x] T6 Settlements in a lineage [opus] (after T3)
  - Done: `verify-fights.ts` (codes `settlement-missing`, `settled:<field>`, `fight-clock`, `fight-growth`, `start-growth`, `locked-time`, `replay:<code>`; `problemText` falls back to a code's listed prefix); the tamper helpers moved to `tests/lineage-fixture.ts`, and the gates no longer bound a settlement's checkpoint's growth (only its vitals).
  - Gotcha for T7/T8: `start-growth` bounds a lock-in claim from the last record, but the hub clamps it from the last report until T8, so a replayed hub fight can fail it before T8 lands.
  - Steps: `src/ledger/verify-fights.ts`:
    1. Each `encounter` record and each fight death (`killed`, `eaten`) names a settlement in the bundle (`settlement-missing` otherwise). Its countersignature holds, and `checkSettledRecords` passes the creature's records of that fight, with a result for the creature.
    2. **Locked time and growth around a fight**:
       - the record's `activeMs` is at most the previous record's plus the `t` difference, `CLOCK_SLACK_MS` and the fight's frames × 100 ms;
       - its biomass less its `reward` is within `growthReach` of the previous record over the records' `t` difference plus the fight's frames × 100 ms and `CLOCK_SLACK_MS` (the lock-in claim's bound, and any growth inside the fight);
       - a settlement may write a checkpoint (the last report's condition, with the clock at the end) just before a fight death in the same transaction, and both carry the settlement's `t`.
    3. **With `opts.logs` and `opts.replay`**:
       - each held log is replayed through `opts.replay` (`verifyEncounter`) against its settlement, and its problems come back as `replay:<code>`;
       - each fighter's start condition in `enc-start` (or its join) is checked against its previous record: the biomass within `growthReach` over the wall time since that record, as a lock-in claim is clamped (ADR 0055);
       - the locked time equals the frames from its frame 0 (or its join) to the end × 100 ms, within its lifespan.

       A log given as `null` counts as pruned. A settlement with no log given counts as unreplayed.
    4. `fights` in the report: `settled`, `replayed`, `pruned`, `unreplayed`.
  - Acceptance (tests first):
    - The golden has no fight problems, with `fights` `{ settled: 1, replayed: 0, pruned: 0, unreplayed: 1 }`. With its log and `verifyEncounter` it is replayed, with no problems.
    - Each tamper gives its named problem:
      - the survivor's record biomass or reward;
      - a settlement signature byte;
      - a fight death whose settlement is missing;
      - a survivor's `activeMs` 1 ms past the locked-time bound;
      - a fighter's start biomass beyond the reach (re-signed by the fixture's key, so only the bound catches it);
      - one input changed in the log (`replay:root`).
    - A log passed as `null` counts as pruned, with no problem.
    - The eaten-egg case verifies, and its tampers are named: the fixture's fight already eats B1's egg with B0's death, so `bundleOf(history, B1)` holds it.
  - Notes: `src/ledger` must not import `src/net` at run time. The replay comes in through `opts.replay`, and the tests pass `verifyEncounter`.

### The authority

- [x] T7 Proof endpoints: bundles and fights served while everyone is offline [opus] (after T3)
  - Done: `worker/proof.ts` (`proofBundle`, `fightProof`, `serveProof`/`serveFight`), the RPCs and routes with `caches.default`, `usage.request` and `requestBudget`; tests in `worker/proof.test.ts`.
  - Gotcha: the hub's own history failed `clock-fast`: a death wrote its checkpoint (dated now) with the last report's clock, so `death` now credits the ticks first and both records carry the clock at the death.
  - Steps:
    1. `worker/proof.ts` builds the bundle from the ledger, with reads only:
       - **the subject**: its whole chain;
       - **the ancestors**, breadth-first, nearest first, ties by id: each birth's two parents, and each child `promote`'s chain parent;
       - **the prefixes**: a biological parent up to its `mate-commit` of that mating, and a chain parent up to its parent `promote` naming the child, or its death if it was already dead. An ancestor reached twice keeps the longer prefix;
       - **the rest**: the commitments, beacons and settlements those records name, the keys, the world's epoch, rules and scales, and the held creatures' flags;
       - **the caps**: at 64 creatures or 512 KB it stops, and `more` lists the parents of held creatures that it left out.

       `fightProof` returns the settlement and the log as the row holds it.
    2. `Authority` RPC methods `proof(id)` and `fight(enc)` (like `pubkeys`), and their routes in `worker/index.ts`. Each answers:
       - the allowlisted origins and requests without an Origin, as `publicJson` does;
       - 400 for an id that is not 64 lowercase hex, and 404 for an unknown one;
       - `503 busy` with `Retry-After: 600` past 80% of `DAILY_REQUEST_BUDGET` (the usage meter counts each request).
    3. Edge cache, through `caches.default` in the Worker:
       - a dead creature's bundle and a settled fight: `max-age=86400`;
       - anything else: 60 s;
       - a cache hit never reaches the object.
    4. DESIGN §5 (proofs and cards), `.claude/rules/worker.md` (the endpoints and their reads), `docs/TESTING.md`.
  - Acceptance (tests first). Workerd hub tests:
    - A history made through the hub: genesis for two players, a mating and both births, a promotion, a fight that ends in a kill, a death and a restore.
      - With every socket closed, `GET /v1/proof/<A's child>` answers 200.
      - `parseProofBundle` takes it, and `verifyLineage` in workerd gives no problems for every family that has landed.
      - The ancestors' prefixes end exactly at their ties.
    - A pedigree of 70 ancestors (inserted through the ledger's own methods) gives 64 creatures, a `more` that names the parents left out, and at most 512 KB.
    - `GET /v1/fight/<enc>` returns the log, and `verifyEncounter` of it against the settlement gives no problems.
    - `GET /v1/proof/xyz` gives 400, an unknown id 404, and the budget past 80% gives 503 with `Retry-After`.
    - A proof request writes no row besides the usage meter's.
    - The cache headers are as above, and a second request for a dead creature's bundle doesn't reach the object (an RPC counter).
  - Notes: the bundle must reach only creatures that the subject's records name, never another player's other creatures. T12 builds the card on these endpoints.

- [x] T8 The audit: one curve for the authority and the verifier, and flags for conflicts, replays and implausible progress [opus] (after T4, T5, T6, T7, T9)
  - Done: `LifeState` binds to the last record (`recorded()`; `startT` for `clock-too-fast`), `worker/audit.ts` (catalogue, `Audit` moved out of `ledger.ts`, `GET /v1/audit`), `replay` and `claim-over`; tests in `audit.test.ts` and `audit-property.test.ts` (40 seeded scripts, the harness in `lineage-test-kit.ts`).
  - Gotcha: the hub now refuses matings under the maturity size, which `MATING_SCALE` shortens like maturity's time (`matureBiomassOf(genome, s)`), so E2E courts still mate in seconds. The client reports just before a court or an accept (a stale record cut honest growth after matings, `m7-kill`), and counts ticks from its `life` message.
  - Steps:
    1. **The bounds per record interval** (ADR 0055), in `worker/life.ts` and `worker/lives.ts`, through `src/ledger/gates.ts`:
       - writing any record of a creature rebinds its connection's clock cap to that record's `t` and `activeMs`;
       - the growth clamp reaches from the last record's condition over the active time since it, with one 1 wu slack per interval;
       - a lock-in claim is clamped over the wall time since the last record.
    2. `worker/audit.ts`: one catalogue of flag kinds (`conflict`, `wrong-owner`, `replay`, `stray-death`, `settle-failed`, `recover-failed`, `biomass-over-max`, `growth-too-fast`, `energy-over`, `health-over`, `clock-too-fast`, `claim-over`), each named where it is raised, and one row per kind and creature (or request) however often it repeats. New detections:
       - `clock-too-fast`: a report claiming more ticks than the bound allows;
       - `replay`: a signed genesis or mate ask used again for a new commitment, or a signed request resent against a head that has moved on, where today the second is a bare `conflict`;
       - `claim-over`: a lock-in claim clamped past its tolerance.

       A resubmitted request that was already accepted keeps its idempotent answer and no flag.
    3. The bundle's `flags` hold each held creature's flags (kind and `t`).
    4. `GET /v1/audit`: counts by kind for the last UTC day and since the renewal, with no ids. Public, cached 5 min.
    5. DESIGN §5 (the bounds) and §11 (the audit), and `.claude/rules/worker.md`.
  - Acceptance (tests first). Workerd hub tests:
    - 20 reports in 10 s grow a creature no more than one report would. Ticks claimed for 10 min after 1 min of wall time credit 1 min + 2 s, and `clock-too-fast` is flagged once.
    - After a mating, the next report credits only the time since the `mate-commit`.
    - Each attack leaves its flag once, however often it is repeated:
      - a stale promote;
      - a replayed mate ask;
      - a replayed genesis ask;
      - a report beyond the maximum biomass;
      - an over-claimed lock-in.
    - An accepted request sent again gets the same acknowledgement and no flag.
    - **The property test** (`heavyTest`): 40 seeded client scripts against one hub, honest and adversarial.
      - The adversarial ones flood reports, over-claim ticks and biomass, replay requests and asks, mate exactly at maturity and at the cooldown's end, and fight.
      - Every creature's bundle verifies with no problems, its fights replayed. Every adversarial script leaves its flag, and the flag is in its creature's bundle.
    - `/v1/audit` counts match the flags table and hold no player or creature id.
  - Notes: the property test is the guard against false positives: an honest authority must never write a history the verifier rejects. A mismatch is fixed in whichever side is wrong, with the reason in the PR, and never by loosening a check for no reason.

- [x] T9 M8 carry-overs: the away report, a lock still asking, a fight that no longer rebuilds, one clock [opus] (after none)
  - Steps:
    1. `sendLife` takes (clears) the stored away report only once `life` was sent on an open socket.
    2. `progress` and `saveOnClose` treat only a running fight as locked. A lock still waiting for its answer credits and checkpoints as free play.
    3. `recover`, for a fight whose saved log no longer rebuilds:
       - flags `recover-failed` once, closes the row and releases the locks;
       - sends each connected participant `enc-end` without a settlement, then `life` with its creature as the ledger holds it, as a failed settlement does.
    4. The fight's paths take their time from `hub.clock.now()`: the settlement's `t`, its records' `t`, each fighter's locked time and the life clock's binding after the end. The ledger's clock may become `hub.clock` if that is the simplest.
  - Acceptance (tests first). Workerd hub tests:
    - A socket that closes before its `life` is sent keeps `fight_report`, and the next sign-in hears it once.
    - Progress during the lock-answer window credits as free play, and a close in that window writes the checkpoint.
    - A row whose start no longer decodes:
      - recovery flags it once and frees both players to engage again;
      - each connected participant gets `enc-end` without a settlement, then `life`.
    - With the hand-moved clock 1 h ahead of `Date.now()`, the settlement's `t`, its records' `t` and the next report's credit all follow the hand-moved clock.
  - Notes: these are worker changes only. T8 edits the same files (`life.ts`, `lives.ts`) later, so it waits for this task.
  - Done: `sendIfOpen` reports whether it sent, and the report is cleared only then; `Fights.playerFighting` gates progress and close, and `start` takes each side's latest clock; `giveUp` in `recover.ts` shares `backToLedger` with a failed settlement.
  - Gotcha: the ledger and the life clock now run on `hub.clock` (`Date.now` in production); a test genome that "no longer decodes" needs a non-base64url character, since any base64url string decodes.

- [x] T10 Retention and the storage budget (after T6, T8)
  - Steps (ADR 0056):
    1. `worker/storage.ts`: the packed frames.
       - Each frame's inputs are 4-byte codes, `0xFFFFFFFF` for the fallback, with the whole log base64 in the row's `frames`.
       - The `FightStore` reads and writes them, `logOf` is unchanged, and the Merkle leaves and `verifyEncounter` see the same frames.
    2. Pruning:
       - a log is kept `LOG_KEEP_DAYS` (14, a worker constant) after its settlement;
       - each later settlement's transaction blanks the start, joins and frames of up to 4 of the oldest expired rows, keeping id, pond, `t` and the settlement;
       - `GET /v1/fight/<enc>` then answers `log: null`.
    3. The size:
       - the usage row records `ctx.storage.sql.databaseSize` once a UTC day (with the flush that crosses midnight);
       - `GET /v1/audit` adds `storage: { bytes, limit }`, where the limit is the free tier's 5 GB.
    4. `npm run report:storage` (`tools/storage.mjs`, `tools/storage-report.ts`) writes `docs/perf/storage.md`. From rows written by hub-test sessions, it measures:
       - the bytes per player-hour of ordinary play;
       - per record kind;
       - per fight, kept and after pruning;
       - the steady state of logs and the yearly growth of the history at 5, 50 and 200 concurrent players.

       If the 200-player log steady state exceeds 1 GB, shorten `LOG_KEEP_DAYS` (never below 7) and record the value in ADR 0056.
    5. `docs/TESTING.md` and `.claude/rules/worker.md`.
  - Acceptance (tests first):
    - The packed log round-trips: every recovery and settlement test passes on it, and a 30 s duel's packed log is under 8 KB.
    - With the clock moved 15 days on, the next settlement prunes at most 4 expired logs and none younger. Their `/v1/fight` gives `log: null`, and the creature's bundle still verifies with `fights.pruned` counted.
    - A pruned fight's row stays under 2 KB.
    - A hub test of an hour of ordinary play stores under 10 KB per player (the guard).
    - The usage row holds the database size after a day boundary. `/v1/audit` shows it.
    - `npm run report:storage` reproduces `docs/perf/storage.md`.
  - Notes: pruning never touches a record, a commitment, a beacon or a settlement.
  - Done: `worker/fight-pack.ts` packs the frames (the referee now refuses code `0xFFFFFFFF`, the fallback marker), `FightStore.seal` prunes by the settlement's `t` through the partial index `encounters_kept` (migration 9, which also adds `usage.db_bytes`), `GET /v1/audit` shows `storage`, and `npm run report:storage` writes `docs/perf/storage.md` (200 players: logs 547 MB, so 14 days stands).
  - Gotcha: a row is kept `LOG_KEEP_DAYS` from the fight's start (`t`), within the 90 s limit of its settlement; `history()` moved to `worker/history-kit.ts`.

### Showing it

- [x] T11 The CLI verifier and `docs/VERIFY.md` (after T4, T5, T6, T7)
  - Done: `tools/verify-lineage.ts` (`runVerify` with injected files and `fetch`), `tools/lineage.mjs`, `docs/VERIFY.md`. `--replay` beside a bundle file reads `fights/<enc>.json`, the layout `--save` writes.
  - Gotcha: `bundleOf` shares record objects with its history, so a tamper test `structuredClone`s first.
  - Steps:
    1. `npm run verify:lineage -- <creature id | bundle.json>` (`tools/lineage.mjs` loads `tools/verify-lineage.ts` through Vite, as `tools/net.mjs` does). Its options:
       - `--hub <url>`: default `$AUTHORITY_URL`; it fetches `/v1/proof/<id>`;
       - `--replay`: fetches each settled fight's log and replays it;
       - `--keys <file>`: pinned keys;
       - `--save <dir>`: writes the bundle, logs and keys for offline checks;
       - `--json`.

       It prints the verdict first ("Verified back to genesis: Dabelothrix natans, generation 3, 7 creatures, 4 fights replayed"), then any problems in plain words, then what was not checked. Exit codes: 0 verified, 1 a problem, 2 nothing to verify (unreachable, 404, busy, malformed).
    2. `docs/VERIFY.md`:
       - how to verify: the card, the CLI, or your own code with `verifyLineage`;
       - what each family proves;
       - what verification does not prove (ADR 0055's list), and the facts the authority is trusted for (time, sessions, serving everything);
       - pinned keys, test worlds (scales), pruned fights (ADR 0056), and world renewals before v1.0.
    3. `docs/TESTING.md`.
  - Acceptance (tests first). The CLI runs against files from `tests/lineage-fixture.ts`, never a live hub:
    - the golden exits 0 with the verdict line;
    - a tampered copy exits 1 and names the problem in plain words;
    - `--json` prints a `LineageReport`;
    - `--replay` with saved logs replays them;
    - pinned keys that lack the bundle's key exit 1;
    - an unreachable `--hub` (a closed local port) exits 2.
  - Notes: the output of a verified lineage fits on one screen (paste it in the PR). T15 runs the CLI against a local hub.

- [x] T12 The creature card page [opus] (after T7)
  - Done: `card.html` and `src/card/` (`card.ts` the words, `load.ts` the reads, `check.ts` the check the worker runs, `card-view.ts` the stage, `main.ts`); every settled fight in the bundle is replayed, the subject's first, each through the fights family alone on the bundle indexed once. `__card.state()` adds `verdictText`, `story`, `renderer`, `timings` and the error `unchecked`.
  - Gotcha: `m9-card` holds the `verify-worker-*.js` request until `drawn`, which proves no frame waits on the check; a genesis needs one acked report before its page closes, or the close writes no checkpoint to tamper with.
  - Steps:
    1. `card.html` and `src/card/` (the build's third input; `CLAUDE.md`'s Architecture gains `src/card/`):
       - read `?c=`, and `?hub=` for localhost only (`hubSocketUrl`'s rule);
       - fetch `/v1/proof/<id>`;
       - run `verifyLineage` in a module worker (`verify-worker.ts`), then replay the subject's settled fights one by one (fetching `/v1/fight/<enc>`) while the card shows progress.
    2. **The card**, a glass panel in the game's style:
       - the creature drawn with the game's creature mesh and glass, at rest, its gait moving gently (still under Reduce motion), with `drawPreview` as the fallback without WebGL2;
       - the species name, rarity stars (`starsText`), silhouette and generation;
       - its story from its records: hatched or born (from which round), matings and children, fights and kills, time lived, and how it ended or where it is now (swimming, frozen, an egg, gone);
       - the verdict line: "Verified back to genesis", or "Verified 3 generations back" (with `more`), followed by "· a test world with shortened clocks" when scaled; or "Not verified: <the first problem>". A details list gives each family's result in plain words and every problem;
       - "Copy link", and a short note that the world may be renewed before v1.0.

       No player name appears. A short fingerprint of the owner key is shown in the details only.
    3. Errors in plain words: "No such creature" (404), "The authority is busy, try again soon" (503), "Can't reach the authority" (offline), "This proof doesn't parse" (malformed).
    4. `window.__card` (`hook.ts`): the state above. `docs/TESTING.md`.
    5. E2E `m9-card.spec.ts` (hub 8818):
       - A hatches, then A's page closes. A fresh context opens the card with `?hub=`. The card reaches `done` with `verdict: 'verified'`, the species A saw, and a drawn creature (`drawn`, non-empty pixels).
       - A second load with the bundle tampered in flight (`route.fulfill`, one record's biomass + 1) reaches `failed` with a plain problem line.
       - An unknown id shows "No such creature".
       - It attaches a screenshot at desktop size and one at 390 px wide.
  - Acceptance (tests first):
    - Unit tests: the story lines and the verdict line from the golden report, from a tampered one, a scaled one and one with `more`.
    - The page draws the creature before verification ends: no frame waits on the worker.
    - At 390 px wide nothing scrolls sideways.
    - `m9-card` passes 3 times in a row (`--repeat-each=3`).
  - Notes: the card reuses `src/render` and `src/game`'s DOM-free helpers (rarity, names, `starsText`), never the game loop. Its look is judged on the screenshots (rubric).

- [ ] T13 The lineage viewer [opus] (after T12)
  - Steps:
    1. `src/card/lineage-graph.ts`, a graph of the held creatures on the card:
       - the subject at the bottom and generations above it;
       - edges from each birth to both parents;
       - the subject's checkpoint branch (its chain parents) drawn bold;
       - genesis roots marked;
       - each node with the species, generation, rarity colour and its own verified mark (a tick or a cross, never colour alone);
       - creatures in `more` as faint "not loaded" nodes. Their "Load" fetches their bundles, verifies them, and joins them to the graph.
    2. Extract the layout of `src/game/lineage-view.ts` into a DOM-free function shared with the in-game panel, so both draw the same graph.
    3. A node opens that creature's card. The graph is reachable by keyboard (Tab, Enter), and it scrolls inside its own box when it is wider than the screen.
    4. `docs/TESTING.md` (`__card.state().graph`: nodes with id, generation, `branch`, `root`, `verified` and `loaded`).
    5. E2E `m9-lineage.spec.ts` (hub 8819, `LIFESPAN_SCALE=0.05`, `MATING_SCALE=0.01`):
       - A and B hatch, mate and both promote, then close their pages;
       - the card of A's child shows both parents as roots and the branch to A's genesis bold, verified back to genesis (`scaled` true);
       - a click on B's genesis node opens its card, which verifies too.
  - Acceptance (tests first):
    - Unit tests of the layout: no two nodes overlap, the branch is a connected path, and a 64-creature pedigree lays out within the box's scroll.
    - The in-game Lineage panel's tests pass unchanged.
    - `m9-lineage` passes 3 times in a row.

- [x] T14 Cards from the game, and the card image [opus] (after T12)
  - Done: `cardHref` (`src/game/card-link.ts`) links the Lineage rows ("Card"), every graph node (it now opens the card, the Lab only without an id) and the death screen ("See its card", `death.creature`); `card-image.ts` lays the PNG out with a measure handed in, the URL across the foot.
  - Gotcha: `CreatureStage.snapshot` renders and reads the WebGL canvas back in one task (no preserved buffer), then redraws the stage at its own size.
  - Steps:
    1. In the game:
       - each of the player's creatures in the menu's Lineage section gets a "Card" link, and so does each pedigree node with a known id;
       - the death screen links the dead creature's card ("See its card").

       Each opens `card.html?c=<id>` in a new tab, with `?hub=` carried over for E2E.
    2. "Save image" on the card (`src/card/card-image.ts`): a 1200 × 630 PNG with the creature's render, the species, the stars, the generation, the verdict line and the card's URL, drawn on a 2D canvas from the WebGL frame. There is no image without a verdict: before the verdict the button waits, and a failed verdict is printed on the image.
    3. `docs/TESTING.md`.
    4. E2E `m9-share.spec.ts` (hub 8820): A hatches and opens the menu's Lineage. Its "Card" link opens a page whose `__card.state().subject` is A's creature. "Save image" downloads a PNG of 1200 × 630.
  - Acceptance (tests first):
    - Unit tests: the links' URLs for each place, with and without `?hub=`.
    - The image's text layout fits a long species name.
    - `m9-share` passes 3 times in a row.

### Closing

- [ ] T15 End-to-end scenario, documentation sync
  - Steps:
    1. `m9-lifecycle.spec.ts` (`@slow`, hub 8821, `LIFESPAN_SCALE=0.05`, `MATING_SCALE=0.01`, `?quality=medium`), in order:
       - A and B hatch, mate and promote;
       - A's child engages B's child and the fight ends, whatever the outcome (engage again if it ends before the step needs it);
       - one creature dies (the fight's victim, or else one swims into a toxic plume), and its player restores its ancestor as the fallback offers;
       - every page closes;
       - the card of each player's current creature verifies, its fights replayed (`fights.replayed` equals `settled`);
       - `npm run verify:lineage -- <id> --hub <local> --replay` exits 0;
       - with a tampered bundle served through `route.fulfill`, the card fails and names the problem.
    2. Sync:
       - DESIGN §5 and §11 (drop the M9 marks for what shipped);
       - `docs/TESTING.md` (the hooks and the hubs 8818–8821; the next file takes 8822);
       - `.claude/rules/{ledger,worker}.md`;
       - `docs/VERIFY.md` against what shipped.
    3. List the owner checks for the Playtest issue (the rubric's `(owner)` lines), and the world renewal for the release notes.
  - Acceptance:
    - Every exit criterion maps to a named test or report (the table below).
    - Each PR E2E part stays under 5 minutes, and the long scenarios are `@slow`.

## Exit criteria → evidence

| Exit criterion (ROADMAP) | Tasks | Evidence |
|---|---|---|
| An independent verifier for the ancestry graph that rejects tampering | T3, T4, T5, T6, T11 | the tamper tests of each family on the golden; T8's property test (no false positives); the CLI's exit 1 on a tampered file; `m9-card` and `m9-lifecycle` with a tampered bundle |
| Proof bundles served while peers are offline | T7, T10 | hub tests with every socket closed; `m9-card`, `m9-lineage` and `m9-lifecycle` open cards after every page closed; pruned fights still verify |
| Lineage viewer | T13 | `m9-lineage` |
| Shareable verified creature cards | T12, T14 | `m9-card`, `m9-share`, the screenshots |
| Outline: the registry (T1), bundles and the endpoint (T7), the verifier for chains, signatures and key history (T3), births and genesis (T4), time gates, costs and settlements (T5, T6), the authority audit (T8), the CLI and `docs/VERIFY.md` (T11), the viewer and cards (T12–T14), retention and the storage budget (T10), the M8 carry-overs (T9) | T1–T14 | as listed in each task |

## End-to-end check

`m9-lifecycle.spec.ts` (T15, `@slow`, hub 8821, two players) takes one lineage from genesis through a mating, a promotion, a fight, a death and a return. Then every page closes, and anyone can check it:
- the card of each player's creature is verified back to genesis (`verdict: 'verified'`, `toGenesis`, and `scaled` in this test world), with its fights replayed;
- the CLI, run against the same hub, agrees (exit 0);
- a bundle tampered in flight fails, and the card names the problem.

Each path is also checked alone:
- `m9-card` (T12): a genesis card with its owner offline, a tampered bundle, and an unknown id;
- `m9-lineage` (T13): a two-parent graph and an ancestor's card;
- `m9-share` (T14): from the game to the card and its image;
- `m6c-reset` (T2): the renewal notice.

## Rubric

- [ ] A card shows the creature within 1 s of the bundle's arrival, and its verdict within 3 s for a 10-creature lineage and within 15 s for a 64-creature one, on a CI runner (evidence: `m9-card` timings; T4's and T3's `speedTest`s).
- [ ] The card reads as a creature worth showing off: the creature large and lit as in the game, its name, stars and generation, and one verdict line before any detail (evidence: the desktop and 390 px screenshots attached to T12's PR, and the PNG attached to T14's).
- [ ] Every problem reads as one plain sentence a player can follow: no hash, code or field name in the line itself (evidence: T3's `problemText` test over every code).
- [ ] The lineage graph reads at a glance: the checkpoint branch stands out from the other ancestors, genesis roots are marked, verified marks are a shape and not only a colour, and a click opens an ancestor's card (evidence: `m9-lineage`, a screenshot attached to T13's PR).
- [ ] The CLI's report on a verified lineage fits on one screen and leads with the verdict (evidence: the output pasted in T11's PR).
- [ ] An honest authority never writes a history the verifier rejects (evidence: T8's property test, T7's hub history).
- [ ] (owner) A card link sent to a friend opens and verifies on their machine, with your creatures offline.
- [ ] (owner) The card makes a creature feel worth showing off.
- [ ] (owner) Losing the creatures to this renewal is acceptable for a world whose lineages can now be checked.

## Risks

- **False positives**: the verifier rejecting an honest history.
  - The authority's bounds move to the record interval (T8) so that both sides check the same thing.
  - T7's hub history and T8's property test run every family on the hub's real output.
  - The gates are inclusive and their boundaries tested.
  - A mismatch is fixed with a stated reason, never by loosening a check quietly.
- **Two clocks in fixture mode**: commitments and beacons run on the recorded rounds' clock, and records on the wall clock. Checks compare times only within one clock: a commitment's round against its own `t`, a record's `t` against a key's `from` or another record's `t`. A commitment's key is checked against the first record that names it (T3).
- **Slow checks in a browser**: BLS verification is the cost, about one beacon per creature.
  - The checks run in a module worker, and the card shows the creature and its own origin first.
  - T4's `speedTest` holds the Node budget.
  - If a browser is far slower, the card verifies the subject and its parents first and the rest as they come.
- **The request budget**: public endpoints are edge-cached, metered, and refused past 80% of the day's budget, so the game is never queued for reads. M13 measures them.
- **Bundle size**: prefixes keep ancestors small, and the 64-creature, 512 KB cap with `more` bounds the rest. A lineage deeper than that verifies in steps ("Verified 6 generations back", then "Load").
- **Storage**: logs are packed and pruned, the history grows about linearly, and the report and the daily size watch it (ADR 0056). Checkpoint compaction is M13's lever.
- **The renewal** costs players their creatures a third time. It is announced in the game, the release notes and the Playtest issue, and the cards say lineages last only from v1.0.
- **Merge conflicts between parallel tasks.**
  - The shapes above are fixed here.
  - Each verifier family has its own file.
  - The worker tasks are chained where they share files: `index.ts` T7 → T8 → T10; `life.ts` and `lives.ts` T9 → T8.
  - T13 and T14 touch `src/card/` in separate files (`lineage-graph.ts`, `card-image.ts`), and T14 also touches `src/game/`.
- **Large tasks** (T3, T8, T12) may overrun one session. Every run pushes its work in progress (ADR 0042), and a task that fails across three runs is split (the `next` skill).
