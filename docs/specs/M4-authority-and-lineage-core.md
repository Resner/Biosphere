# M4: Authority and lineage core

Release: v0.5.0 · Gate: no

## Goal

A player's creature now exists on the record. The first time someone hatches, the authority registers their browser identity and commits their genesis creature to a future drand round, so the DNA cannot be chosen, rerolled or predicted, and the browser recomputes it before accepting. From then on the creature has exactly one accepted head, a life measured on the authority's clock (75 minutes of active time, paused whenever the player is away), a condition that survives closing the tab, and an old-age death that comes on schedule. Reload the page and the same creature resumes where it was, with the same remaining life. Move to another browser with the recovery code and the same player continues, and the old browser is closed. When a creature dies with nothing to fall back on, the player hatches a new genesis creature and the old lineage stays as history. A basic admission queue keeps the Worker inside its free-tier budget. ADR 0019 is the contract for records, traffic and the genesis policy; ADRs 0008 to 0010 set the model.

Mating, offspring, promotion and the checkpoint chain are M5. M4 builds everything they stand on, and tests the fallback logic on synthetic chains.

## Out of scope

- Mating, mate commitments, `birth`, `promote` and `restore` records, cooldowns, maturity as a game rule (M5). The fallback resolver is built and unit tested here on synthetic chains; no player can have an ancestor yet.
- Encounters and their records (M7 and M8), witnesses and attestations (M10), proof bundles, the verifier and the lineage viewer (M9). M4 stores everything they need.
- A public records API. `/v1/pubkeys` is the only new HTTP route.
- Depth zones, UV and pressure deaths (M6).
- Region sharding and the full capacity model (M13). Admission here is a meter and a queue.

## Touches

New: `src/ledger/canonical.ts`, `record.ts`, `drand.ts`, `genesis.ts`, `lifespan.ts` (shared), `src/ledger/recovery.ts`, `worker/ledger.ts`, `worker/beacons.ts`, `worker/keys.ts`, `worker/admission.ts`, `src/game/ledger-session.ts`, `src/game/recovery-ui.ts`, `tools/record-drand.ts`, `tests/fixtures/drand/`, `tests/e2e/m4-*.spec.ts`, `docs/decisions/0019-…`. Changed: `src/ledger/identity.ts`, `src/net/protocol.ts` (version 2), `src/net/hub-client.ts`, `worker/authority.ts`, `worker/schema.ts`, `worker/index.ts`, `worker/env.d.ts`, `worker/wrangler.jsonc`, `src/sim` (old-age modifiers, rules version 4), `src/game/app.ts`, `online.ts`, `hud.ts`, `screens.ts`, `debug.ts`, `index.html`, `playwright.config.ts`, `docs/DESIGN.md`, `docs/decisions/0009-…` (status line).

New dependency: `@noble/curves` (BLS12-381; add it with `npx -y npm@11 install`).

Interfaces:

```ts
// src/ledger/canonical.ts
export type Canonical = string | number | Canonical[] | { [key: string]: Canonical };   // numbers are safe integers
export function canonicalize(value: Canonical): string;           // RFC 8785 for integers and strings; throws on float, NaN, undefined, unsafe integer
// src/ledger/record.ts
export interface LedgerRecord { v: 1; rules: number; kind: 'genesis' | 'checkpoint' | 'death';
  creature: string; seq: number; prev: string | null; owner: string; body: Canonical }
export interface Acceptance { hash: string; t: number; age: number; key: string; sig: string }
export function recordHash(r: LedgerRecord): string;               // hex SHA-256('bs/rec/v1\n' ‖ JCS(r))
export function signRecord(identity: Identity, r: LedgerRecord): string;     // owner signature, base64url
export function verifyRecord(r: LedgerRecord, ownerSig: string): boolean;
export function acceptanceBytes(a: Omit<Acceptance, 'sig'>): Uint8Array;     // what the authority signs: 'bs/acc/v1\n' …
export function verifyAcceptance(a: Acceptance, publicKeys: Record<string, string>): boolean;
export interface Condition { biomass: number; energy: number; health: number }   // hundredths, integers
// src/ledger/drand.ts
export const QUICKNET: { chain: string; genesis: number; period: number; publicKey: string };
export interface Beacon { round: number; signature: string; randomness: string }
export function roundAt(unixMs: number): number;
export function verifyBeacon(b: Beacon): boolean;                  // BLS verify and randomness = SHA-256(signature); never throws
export function fetchBeacon(round: number | 'latest', fetchFn: typeof fetch): Promise<Beacon>;   // hosts in order, verified, throws when none verifies
// src/ledger/genesis.ts
export function genesisSeed(randomness: string, commitId: string): Seed;
export function genesisRecord(args: { owner: string; commitId: string; round: number; genome: Genome }): LedgerRecord;
export function checkGenesis(record: LedgerRecord, beacon: Beacon, commitId: string): boolean;   // beacon verifies and genome equals genesisGenome(seed)
// src/ledger/lifespan.ts
export function lifespanMs(genome: Genome): number;                // 75 min × lifespan trait, integer ms
// src/ledger/recovery.ts (re-exported by identity.ts)
export function exportRecoveryCode(store: KeyStore): Promise<string>;
export function importRecoveryCode(store: KeyStore, code: string): Promise<'ok' | 'bad-code'>;
// worker/ledger.ts
export function applyTransition(sql: SqlStorage, record: LedgerRecord, ownerSig: string, ctx: { now: number; age: number; sign(bytes: Uint8Array): { key: string; sig: string } }):
  { ok: true; acceptance: Acceptance; duplicate: boolean } | { ok: false; reason: 'conflict' | 'bad-sig' | 'bad-record' | 'status' | 'unknown-creature' };
export function fallbackFor(chain: ChainEntry[]): ChainEntry | null;   // the nearest surviving ancestor (M5 fills the chain)
```

Hub messages (all JSON, within `HUB_MAX_BYTES`; the shared codecs validate them):

```ts
type ClientMsg += { t: 'genesis' } | { t: 'tx'; record: LedgerRecord; sig: string } | { t: 'pulse'; record: LedgerRecord; sig: string };
type HubMsg += { t: 'genesis-wait'; commit: string; round: number } | { t: 'genesis-ready'; commit: string; beacon: Beacon }
  | { t: 'ack'; acceptance: Acceptance; creature: string; head: string } | { t: 'reject'; hash: string; reason: string }
  | { t: 'expired'; creature: string } | { t: 'queued'; position: number; etaSeconds: number }
  | { t: 'error'; code: 'genesis-limit' | 'beacon-unavailable' | 'has-creature' | … };
// welcome.you gains: creature: { id, head, seq, genome, condition, age, lifespan, rules } | null, genesis: { commit, round } | null, bucket: { tokens, nextInSeconds }
```

SQLite tables (migration 2, append-only): `players(id, name, created, last_seen, tokens, tokens_at)`, `creatures(id, owner, status, head, seq, generation, genome_hash, born, age, lifespan, cond_json, eff_json, lineage)`, `records(hash, creature, seq, prev, kind, record_json, owner_sig, t, age, key, acc_sig)`, `commitments(id, owner, round, state, created, resolved)`, `beacons(round, signature, randomness)`, `keys(id, public, created)`, `usage(day, messages, writes, peak)`, `flags(id, creature, kind, detail, t)`, `conflicts(id, creature, hash, head, t)`. Status values: `active`, `dead` (M5 adds `pending` and `checkpoint`).

## Tasks

- [ ] T1 Canonical JSON
  - Acceptance:
    - `canonicalize` matches RFC 8785 for the supported subset: object keys sorted by UTF-16 code units (a vector with `"€"`, `"\r"`, `"😀"` and a key that sorts differently by code point), no whitespace, strings escaped exactly as the RFC says (control characters as `\u00XX` except `\b \t \n \f \r`, `"` and `\`, no other escapes, lone surrogates rejected), integers without exponent or leading zeros, `-0` rejected.
    - Throws on `1.5`, `NaN`, `Infinity`, `undefined`, `2**53`, a function or a symbol; a property test over 2,000 random JSON-like values round-trips through `JSON.parse` to the same canonical text.
    - Identical output in Node and in workerd (the same test file runs in both the unit and Worker projects with the same expected strings).
  - Notes: No dependency; about 60 lines. Never use `JSON.stringify` for hashed text.

- [ ] T2 Records, hashes, signatures and the acceptance envelope
  - Acceptance:
    - `recordHash` of a fixed sample record equals a golden hex string (the golden is written once, with the domain tag `bs/rec/v1\n`); changing any one field changes the hash; the domain tag is part of the preimage (a hash computed without it differs).
    - `signRecord` then `verifyRecord` is true; a tampered body, `seq`, `prev` or `owner`, a signature from another identity and a signature over the hash with another domain tag all fail. `verifyRecord` returns false (never throws) for a malformed signature or owner.
    - `acceptanceBytes`/`verifyAcceptance`: a signature by key id `k1` verifies against `{ k1: <public key> }`; altering `t`, `age`, `hash` or `key`, or an unknown key id, fails.
    - Records reject floats at construction (`recordHash` throws via T1); `Condition` values are integers (a helper `toHundredths(x)` rounds half up and clamps at 0, tested at 0, 0.004, 0.005 and 12.345).
    - Write ADR 0009's status line as `accepted (amended by 0019)`; the spec already carries 0019.
  - Notes: lives in `src/ledger/` and runs in browsers, Node and workerd. Uses the existing `Identity.sign(domain, message)`.

- [ ] T3 drand quicknet client and recorded fixtures
  - Acceptance:
    - `roundAt(genesis·1000)` is 1, `roundAt(genesis·1000 + 2999)` is 1 and `roundAt(genesis·1000 + 3000)` is 2; the round number is encoded as 8 bytes big-endian for the signed message.
    - `tools/record-drand.ts` fetches the chain info and 600 consecutive real beacons from the public hosts and writes `tests/fixtures/drand/info.json` and `beacons.json` (run once in this task; the files are committed, the live network is never used by a test). The pinned `QUICKNET.publicKey` equals the recorded info's key, asserted in a test.
    - `verifyBeacon` is true for every recorded beacon (all 600); false when one hex digit of the signature changes, when the round changes, when `randomness` is not `SHA-256(signature)`, and for malformed hex or wrong lengths. It never throws on random bytes (fuzz, 500 cases).
    - `fetchBeacon` with a fake `fetch`: falls back to the next host when one returns 500, times out, returns malformed JSON or returns a beacon that fails verification; returns the first verified beacon; throws when no host verifies (the error lists each host's reason); `'latest'` and a numbered round hit the right v1 paths `/{chain}/public/…`.
    - A recorded 600-beacon table covers about 30 minutes; `fixtureBeacons()` helper returns it (used by T7 and the tests).
  - Notes: add `@noble/curves` with npm 11. Quicknet signatures are on G1 (48 bytes) and the public key on G2 (96 bytes); hash the message to G1 with the RFC 9380 suite and DST `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_` (ADR 0010). Importing only the BLS pieces keeps the browser chunk small; check the built size and record it in the task note (target under 100 KB gzipped, loaded lazily when the first hatch needs it). The network is reachable through the cloud proxy; if recording fails, retry hosts in order before declaring a blocker.

- [ ] T4 Ledger schema and the UTXO transition rule
  - Acceptance (workerd project, a fresh `SqlStorage` per test):
    - Migration 2 creates the tables listed under Touches; migrating twice is a no-op; migration 1's `ponds` table and data survive.
    - A valid genesis record (creature id = its hash, `seq` 0, `prev` null) is accepted: the creature row is `active` with `head` = the record hash; the acceptance carries `t`, `age` and a signature that verifies (T2).
    - A checkpoint with `prev` = head and `seq` = head + 1 is accepted and becomes the head. Resubmitting the identical record returns `duplicate: true` with the identical acceptance and writes nothing new (row counts unchanged).
    - A second, different record naming the old head (a stale `prev`) is rejected with `conflict` and one row is added to `conflicts`; the head is unchanged. A record with the right `prev` but a wrong `seq`, an unknown creature, a bad owner signature, an `owner` that is not the creature's owner, or a kind not allowed for the status (a checkpoint after a death) is rejected with the right reason and changes nothing.
    - Atomicity: when the insert of the record succeeds and the head update is forced to fail (a fault injected through a wrapper), neither is stored.
    - One active creature per player: a genesis for a player who already has an `active` creature is rejected (`status`).
    - A property test with 200 random sequences of valid, stale, duplicate and tampered submissions never leaves two heads for one creature and never leaves a head that is not the latest accepted record.
  - Notes: `applyTransition` is pure over `SqlStorage` plus `ctx`. Keep indexes minimal (row writes count, ADR 0008): `records` by primary key hash plus one index on `(creature, seq)`. The statuses `pending` and `checkpoint` arrive in M5.

- [ ] T5 Authority signing key and `/v1/pubkeys`
  - Acceptance:
    - On first use the Durable Object generates an Ed25519 key inside itself and stores it (`keys` row `k1`); the private key is never returned, logged or placed in a response.
    - `GET /v1/pubkeys` returns `{ keys: { "<id>": "<base64url public key>" }, current: "<id>" }` with the allowed-origin CORS rules of `/v1/health` (a disallowed `Origin` gets 403).
    - An acceptance signed by the authority verifies against `/v1/pubkeys` (Worker test through `SELF.fetch`).
    - The key survives a Durable Object restart (a second instance over the same storage returns the same public key).
  - Notes: key rotation is not built; the `key` id in each acceptance leaves room for it.

- [ ] T6 Protocol version 2 and ledger codecs
  - Acceptance:
    - `PROTOCOL_VERSION` is 2. A version 1 hello gets `{ t: 'error', code: 'version' }` and a close, and the client shows its existing "Update available" text for it (unit test with the fake hub).
    - `parseClientMsg` and `parseHubMsg` accept every message under the interface block above and reject (return `null`) anything malformed: a record with a float, a missing field, a `kind` outside the three, a negative `seq`, a `prev` that is neither 64-hex nor null, a signature that is not 86 base64url characters, and any message over `HUB_MAX_BYTES`. Fuzz: 2,000 random byte strings and 2,000 mutated valid messages never throw.
    - The welcome codec carries `you.creature`, `you.genesis` and `you.bucket` (or nulls) and stays under `WELCOME_MAX_BYTES` with a maximum-size genome (440 characters) in it.
    - Round trips: for each message kind, `parse(JSON.stringify(m))` equals `m`.
  - Notes: keep the hub's existing rate limits (20 messages per 10 s window); `pulse` every 15 s is far below it. Update `docs/DESIGN.md` §8 only if the wire text there changes.

- [ ] T7 Genesis commitments on the authority
  - Acceptance (workerd, `DRAND_SOURCE=fixture`):
    - Fixture mode: `worker/beacons.ts` serves the recorded beacons, maps the clock onto them (the first recorded round is "now" when the Durable Object starts, wrapping after the last, documented in the code), and never calls `fetch`. In production mode it fetches through `fetchBeacon` with the four hosts, verifies, and caches every beacon it uses in `beacons`. `DRAND_SOURCE` and `ACTIVE_TIME_SCALE` are read only from `env`; `wrangler.jsonc` does not set them (the E2E config does, T16).
    - A `genesis` request from an identity with no creature and a full bucket returns `genesis-wait` with a commitment id and `round` = latest verified round + 2, before that round exists; it writes one `commitments` row and spends one token.
    - The same request again (same player, commitment still open) returns the same commitment id and round and spends nothing (no reroll). After the commitment resolved and the creature was accepted, another request is answered `has-creature`.
    - At the committed round's time the authority fetches and verifies that exact round, stores it, marks the commitment `ready` and sends `genesis-ready` with the beacon; if the socket is gone the commitment stays `ready` and the welcome of the next session carries `you.genesis` and a fresh `genesis-ready` (a reload mid-wait still gets its creature).
    - Token bucket (`RULES.ledger.genesis = { burst: 5, refillSeconds: 300 }`): six requests in a row (each after its creature died) succeed five times and the sixth gets `genesis-limit` with `nextInSeconds`; after 300 s (fake clock) one more succeeds; the bucket never exceeds the burst.
    - Outage: when the beacon source throws, the commitment stays `waiting`, the client gets `beacon-unavailable` once per attempt (not a retry storm: the next attempt is at most every 5 s), and the commitment becomes `ready` when the source recovers; the authority never creates DNA from its own randomness (a test asserts the genome comes only from `genesisSeed`).
    - Restart: a Durable Object evicted while a commitment waits resumes it from the alarm; no commitment is resolved twice.
  - Notes: round = the latest verified round, not `roundAt(now)`, so a stale clock cannot name a round that already exists (ADR 0010). One alarm per Durable Object serves hello timeouts, commitments and later the lifespan timers: keep them in one scheduler (`nextAlarm` = the minimum of due times).

- [ ] T8 Genesis record accepted: the client recomputes the DNA
  - Acceptance:
    - `genesisSeed(randomness, commitId)` and `genesisRecord(...)` are deterministic: a golden test fixes the genome hash for one recorded beacon and a fixed commitment id; two commitment ids with the same beacon give different genomes; the same genome results in Node and workerd.
    - `checkGenesis` is true for the honest record and false when: the beacon is for another round than the record's, the beacon signature is invalid, the genome differs by one byte from the recomputation, the commitment id differs, or the body is not an object with exactly `commit`, `round` and `genome`.
    - Headless flow (Worker test with a scripted client using a real `Identity`): `genesis` → `genesis-wait` → `genesis-ready` → the client builds and signs the genesis record → `tx` → `ack`; the welcome of a second session then carries `you.creature` with the same genome, `age` 0 and the lifespan from `lifespanMs`.
    - A `tx` genesis whose genome the authority cannot reproduce is rejected (`reject`, reason `genome`) and flagged in `flags`; the player's commitment is spent, not reopened (no reroll through bad submissions).
    - A genesis `tx` for a commitment owned by another player, or for a round other than the committed one, is rejected.
    - Two different genesis commitments for two players land on different genomes (a 200-commitment property test: no duplicate genome hash).
  - Notes: the genesis body holds the genome as base64url (about 440 characters), so a verifier needs only the record, the beacon and the rules version (M9). `lifespanMs` lands here with its own tests (see T9).

- [ ] T9 Active time, lifespan and old age
  - Acceptance:
    - `lifespanMs(genome)` = round(75 min × the lifespan trait (`express(genome).lifespan`)), an integer, in `RULES.ledger.lifespanMs`-based units; golden values for the starter genome and for the 0.6 and 1.6 extremes; the DESIGN §5 text matches the code (the trait range in `RULES.genes` is the source of truth).
    - Sim, rules version 4: `RULES.age = { onset: 0.85 }` plus the thrust and basal modifiers; `CreatureState.age` (permille, 0–1000) is changed only by an input `{ type: 'age', creature, permille }`; at permille ≥ 850 thrust is ×0.8 and basal metabolism ×1.2 (unit tests per quantity, exact expectations); below 850 outcomes equal version 3's (a replay golden with no age input is bit-identical in its hash apart from the version field and the new field's presence, regenerated in the same PR with a note); at 1000 the creature takes a lethal `old-age` damage event on the next tick (cause `old-age`, death screen text exists already). Goldens regenerate with `RULES_VERSION` 4; Node and Chromium agree.
    - Authority clock (workerd, fake time): active time starts at `welcome` of a session whose player has an active creature and ends at socket close or replacement; a session of 10 min adds 10 min to the creature's `age` (written once, on close, with the final record); a second session after 8 hours adds only its own length (offline time never counts); two simultaneous sockets for one player never double count (the replaced one stops at replacement).
    - Expiry: when `age` reaches `lifespan` during a session the authority sends `expired`; a client death record `{ kind: 'death', body: { cause: 'old-age', … } }` within 15 s is accepted and ends the creature (`dead`); with none, the authority writes a death record itself (flag `forced`, `ownerSig` null recorded as the empty string, acceptance still signed) at 15 s. A creature at 99% on welcome expires within the remaining time, not at once.
    - `ACTIVE_TIME_SCALE` (fixture mode only): a scale of 600 makes a 75-minute life last 7.5 s of wall time in tests; in production mode the variable is ignored (a test sets it and asserts it has no effect).
    - The client turns the authority's `age` and `lifespan` into `age` inputs (permille) at most once per second, and the HUD shows a thin lifespan bar that turns amber at 85% (T13).
  - Notes: the alarm scheduler of T7 also holds expiry timers. Keep the sim ignorant of wall time: the host owns the mapping from authority age to permille.

- [ ] T10 Pulses, checkpoints and plausibility
  - Acceptance:
    - A `pulse` (a signed `checkpoint` proposal with `prev` = head, `seq` = head + 1) is verified and kept as the session's newest pending pulse (in the socket attachment); no SQLite row is written (a row-write counter in the test stays flat across 100 pulses); a newer pulse replaces the older.
    - The pending pulse is committed as the creature's next record when the session closes (normal close, drop and replacement), on a `death` or `genesis` for the player, and after 20 minutes of active time since the head; each commit is one `applyTransition`. A pulse with a stale `prev` or a `seq` that is not head + 1 is ignored with a `reject`.
    - Closing a tab by killing the socket after a pulse restores that pulse's condition on the next welcome (`you.creature.condition`), not the older checkpoint's; `age` includes the time up to the close.
    - Plausibility (`RULES.ledger.limits`): energy and health above the genome's maxima, biomass above the genome's `maxBiomass` or above `previous × exp(0.012 × growth gene × seconds)` (+1% slack), negative or non-integer values: the record is accepted as signed, a `flags` row is added (`kind: 'implausible'`, with the clamped values), and `eff_json` holds the clamped condition that resumes use; the head record is not rewritten. Honest play never flags: a 600-tick scripted replay of a starter cell that eats and grows produces pulses with no flags.
    - Write budget: a simulated hour of one player (4 pulses a minute, 3 commits) writes at most 10 rows in total outside the genesis (counted with the SQL write counter), and a simulated 24 hours of 200 such players stays under 100,000 row writes (arithmetic from the measured per-commit cost, asserted).
    - The client signs a pulse with exactly the condition its sim has (hundredths, integers); a unit test builds one from a sim state and verifies it with T2.
  - Notes: ADR 0019 explains why the pending pulse lives in the attachment. The attachment limit is 2 KB, so a pulse is compacted to `{ seq, prev, condition, sig }` and the record is rebuilt on commit from the head and the session's creature id.

- [ ] T11 Death, the fallback resolver and extinct lineages
  - Acceptance:
    - A `death` record (client-signed, body `{ cause, condition }`, cause one of the `DeathCause` values) is accepted as the creature's next record: status `dead`, no further record is accepted for it (`status`), and the player has no active creature afterwards.
    - `fallbackFor(chain)` with synthetic chains (entries `{ creature, status, ageLeft }`, nearest ancestor first): returns the nearest entry whose status is `checkpoint` and whose life is not exhausted; skips dead and exhausted ones; returns `null` for an empty chain, an all-dead chain and a chain whose only living entry has zero life left. 100 random chains agree with a brute-force oracle.
    - After a death with no fallback the welcome of the next session has `you.creature` null and the dead creature is kept: its `creatures` row stays with status `dead` and the `lineage` marker is `extinct`; its records stay retrievable by creature id (a test reads the whole chain, hashes and signatures verify end to end).
    - A new genesis after a death starts a new lineage (`lineage` = the new genesis hash) and does not touch the old rows (an assertion on row hashes before and after).
    - A death record for a creature that is not the player's active one, or after the creature already died, is rejected without a state change.
  - Notes: M5 adds the chain and the promote/restore records; this task ships the pure resolver and the status handling it needs. Keep `death` the only way a creature ends.

- [ ] T12 Recovery code
  - Acceptance:
    - `exportRecoveryCode(store)` returns the 32-byte seed plus a 2-byte checksum as Crockford base32 in groups of 5 separated by `-`; `importRecoveryCode` accepts it with spaces, lowercase and the Crockford confusions (`O`→`0`, `I` and `L`→`1`), stores the seed and then `createIdentity(store)` has the same `playerId` as before the export (round trip over 200 random seeds).
    - A code with one wrong character, a missing group, an extra group or the checksum of another seed returns `'bad-code'` and leaves the stored seed unchanged. Fuzz: 1,000 random strings never throw and never change the store.
    - Exporting twice gives the same code; the code never appears in any `console` call, error message or `window.__bs` state (a test spies on the console while exporting and importing).
    - `idb-keystore` replaces the seed atomically (one transaction), so a failure leaves the old seed.
  - Notes: the seed still never leaves `identity.ts` except through this code; implement the functions in `recovery.ts` over the `KeyStore` interface and re-export from `identity.ts` so the rule in `.claude/rules/ledger.md` holds. The UI is in T13.

- [ ] T13 The client hatches through the authority
  - Acceptance (unit with a fake hub; the E2E is T16):
    - `LedgerSession` (`src/game/ledger-session.ts`) is the state machine `idle → asking → waiting-beacon → verifying → signing → active`, plus `unregistered`. A scripted hub reaches `active` after `genesis-ready`, and the player's genome equals `checkGenesis`'s recomputation; a `genesis-ready` whose beacon fails verification, or whose recomputed genome differs from what the hub claims, ends in `unregistered` with the reason shown, and the game still starts.
    - Hatching with a session whose welcome has `you.creature` resumes that creature: same genome, condition (`you.creature.condition` scaled to the sim's units), and age, with no genesis request; the creature's `permille` age input is sent at the first tick.
    - `unregistered` happens (and the player swims a local random genesis body, labelled "Unregistered" in the HUD) when: the hub is unreachable, the hub answers `genesis-limit` (the hatch screen shows when the next token arrives), `queued`, `beacon-unavailable` twice in a row, or the genesis wait exceeds 20 s. Nothing is sent to the ledger from an unregistered life (no `pulse`, no `tx`).
    - While waiting for the beacon the hatch screen shows an animated egg and the text "Hatching… waiting for the world's randomness" (and a count of seconds); Space and Enter do nothing meanwhile; reload during the wait still ends in the same creature (the welcome carries `you.genesis`).
    - A pulse goes out every 15 s of play, and immediately on `visibilitychange`→hidden and `pagehide`; a death sends `tx` with the death record before the death screen offers a new hatch; "Hatch again" while the death record is unacknowledged waits for the `ack` (bounded to 5 s, then continues unregistered).
    - On `expired` the client sends its death record (cause `old-age`) and the death screen reads "Old age".
    - Recovery UI (`recovery-ui.ts`): a "Recovery code" link on the title screen opens a panel with "Show my code" (hidden until clicked), a Copy button, an "Import a code" field and the warning "Importing replaces this browser's player. Save your current code first."; a wrong code shows "That code doesn't look right" without changing anything; a good import reloads the page into the imported identity. Keyboard reachable, no colour-only state.
    - `window.__bs.state()` gains `ledger: { phase, creature, head, seq, age, lifespan, unregistered, flags }` (read-only); `?debug=1` adds `debug.{forcePulse, ledgerPhase}`.
  - Notes: `?genome=` still pins a body for tests and makes the life unregistered. The existing `openGame` helper keeps `genome=starter` for the M1–M3 specs. Load the BLS chunk lazily on the first hatch.

- [ ] T14 Admission: usage meter and queue
  - Acceptance:
    - The meter counts incoming messages and estimated row writes per UTC day (`usage` row, flushed every 5 minutes from the alarm, at most 288 writes a day plus one at rollover) and the peak concurrent players.
    - `MAX_PLAYERS` (default 400, `env` override) and a daily budget (`RULES.admission`: 80,000 request-equivalents and 80,000 row writes, i.e. 80% of the free tier, with the 90% queue threshold applied to these) decide admission. At the cap, `hello` is answered with `queued { position, etaSeconds }` instead of `welcome`; the socket stays open; the player is admitted in order as a slot frees (a test fills the cap with 3 sockets, then queues 2 and closes one by one: positions count down 2, 1, then both are admitted in order with the welcome); the estimate is `position × 20 s`, bounded to 1 hour.
    - Past 90% of a day's budget the queue applies even below the cap, until the UTC day rolls over; below it no player is ever queued (a test with the meter pre-set to 89% and 91%).
    - A queued socket that closes frees its place; a reconnecting player keeps their order by player id for 60 s; the single-session rule still holds (a second hello from a queued player replaces the first).
    - A queued player's rate limit counts as before; queue position updates are outgoing messages only, at most one per 10 s per socket (free of charge, ADR 0008).
    - The client shows "The pond is full: you're number N. Estimated wait about M minutes." with a button "Swim alone meanwhile" (unregistered life) and joins the pond automatically on admission without losing a running unregistered life: the unregistered creature ends when the real one hatches (the hatch screen warns "Your unregistered cell will end").
  - Notes: full capacity modelling is M13; the thresholds live in `RULES.admission` and `docs/DESIGN.md` §8.

- [ ] T15 Documentation of the new rules
  - Acceptance:
    - `docs/DESIGN.md` §5 describes what M4 builds: lifespan from the lifespan trait, the old-age modifiers at 85%, the genesis token bucket (burst 5, one per 5 minutes) replacing "1 per 10 minutes", pulses and what a closed tab keeps, unregistered life, and §8 describes admission; each number appears in `RULES` (a test asserts the doc's numbers against `RULES.ledger`, `RULES.age` and `RULES.admission`, read from the Markdown by regex so drift fails the build).
    - `.claude/rules/ledger.md` and `worker.md` gain the lessons of T4–T10 that are lasting (the attachment-held pulse, the single scheduler alarm, fixture-only environment variables), and `tests.md` documents the new `window.__bs` fields and the new `wrangler dev` ports.
  - Notes: this task ships with the milestone close if the spec runs long; the doc test, however, belongs here.

- [ ] T16 End-to-end authority and lineage core
  - Acceptance: see "End-to-end check". Playwright starts `wrangler dev` with `DRAND_SOURCE=fixture` and `ACTIVE_TIME_SCALE` on a new port (8790), and a second instance with the cap at 1 for the queue test (8791). Fast scenarios run in `test:e2e`; the old-age and hour-scale ones are `@slow`.
  - Notes: no test uses the live drand network or production authority.

## End-to-end check

Against `dist/` with a local `wrangler dev` in fixture mode (no live drand):

1. Fresh context, click Hatch: the egg screen shows within 1 s, the creature appears within 10 s, `__bs.state().ledger` is `active` with a creature id equal to the genesis record's hash and a 64-hex head; a direct hub query in the test (a headless client with the same identity) sees `you.creature` with the same genome the page shows (`genomeHash`).
2. Reload the page, click Hatch: the same creature resumes (same creature id and genome hash, no genesis request counted by `debug` counters), with the age at least what it was.
3. Eat for a few seconds, close the page (a real close), reopen: the resumed biomass is within the last pulse's value, not the older checkpoint's.
4. A second context with the recovery code from the first (typed into the import field) becomes the same player: its `playerId` equals the first's, the first context's socket is closed with 4001, and it resumes the same creature.
5. Two contexts with different identities hatch at the same moment: their genome hashes differ and both creatures have distinct ids.
6. With `ACTIVE_TIME_SCALE` 600 (`@slow`), a creature reaches 85% (the lifespan bar turns amber, thrust is lower in `state().player.stats`) and dies of "Old age" at 100% with the cause shown; its death record verifies end to end; a new Hatch gives a different lineage and the old lineage's rows are intact (read through a headless client).
7. Time away does not count: close the page at 10% age in a scaled run, wait 5 s wall (3,000 s at scale), reopen: the age is still about 10%.
8. Six deaths in a row (using `debug.setEnergy` to starve quickly): the sixth hatch shows the rate-limit message with a countdown, and "Swim unregistered" starts a life labelled Unregistered that writes nothing (the ledger counters stay flat).
9. With the cap at 1, the second context sees the queue message with position 1 and is admitted when the first closes.
10. A tampered flow: a headless client submits a stale-`prev` checkpoint and a genesis with an altered genome; both are rejected and appear in `conflicts` and `flags` (checked through a debug-only Worker endpoint that exists only in fixture mode).

Also in the unit and Worker suites: the 10,000-genome property tests of M3 still pass unchanged; the `RULES_VERSION` 4 goldens agree in Node and Chromium.

## Rubric

- [ ] The hatch wait (egg, text, seconds counter) reads as a deliberate short ritual, not a freeze: the page shows motion within 1 s and never a blank screen (evidence: screenshot at 1 s and 4 s, non-blank, element present).
- [ ] The lifespan bar is readable at a glance, turns amber (and gets a dashed outline) at 85%, and never hides the cell (evidence: screenshots at 20%, 85%, 99%).
- [ ] The death screen names the cause for old age and the next-step button says what happens ("Hatch a new cell"; evidence: screenshot).
- [ ] The recovery panel uses plain words, hides the code until asked, and the import warning is visible before the field (evidence: screenshot and the T13 test).
- [ ] The queue and rate-limit screens explain what is happening and offer to swim unregistered; the unregistered label is visible without being alarming (evidence: screenshots).
- [ ] A new player who never opens the recovery panel or the lineage can still hatch, play and die with no extra steps beyond the 3–6 s wait (evidence: the E2E scenario 1 timing).
- [ ] Waiting 3–6 s for a hatch, and the burst of 5 hatches with one back per 5 minutes, feel fair (owner, with the Playtest v0.5.0 issue).
- [ ] Resuming after a reload or a day away feels safe, not punishing: the same creature, the same remaining life (owner).
- [ ] The Worker holds on the free tier with several real friends over a weekend; the usage numbers shown in the next Playtest issue stay far under 80% (owner).

## Risks

- Browser BLS verification costs bundle size and time → import only the pairing pieces and load lazily on the first hatch; measure in T3; if a verify takes over 150 ms in Chromium, verify in a worker or accept one frame hitch behind the egg screen.
- `@noble/curves` quicknet verification details (G1 signatures, DST) → settled by the 600 recorded real beacons (all must verify, tampered ones must fail); no mock-only tests.
- The fixture clock wraps after about 30 minutes → documented; E2E sessions are shorter, and round reuse only repeats seeds across different commitment ids.
- Durable Object eviction loses in-memory state → pulses live in the socket attachment, timers in the alarm scheduler, commitments in SQLite; T7 and T10 restart tests.
- Row-write budget drift as tasks add rows → T10 asserts the budget with counters; every later milestone reruns it.
- Closing a tab at a bad moment → the pulse window is 15 s and is committed on close; the exploit that remains (a hard crash right after a good pulse) loses growth, not age, and is flagged on repetition in M10.
- Rate limit too harsh for early deaths → burst 5 and the unregistered life keep play going; the numbers are in `RULES.ledger` for a quick retune after the playtest.
- Rules version 4 changes goldens → regenerate once in T9 with a note; older rules versions stay verifiable because the old code path is kept by version.
