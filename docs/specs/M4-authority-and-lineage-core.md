# M4: Authority and lineage core

Release: v0.5.0 · Gate: no

## Goal

A player's life is recorded. Hatching asks the authority for a genesis creature whose DNA comes from a future drand round nobody could predict, so "Hatch" shows "awaiting beacon" for 3 to 6 seconds and then the creature appears. The creature has one accepted head in a ledger the authority countersigns. Closing the tab and coming back resumes the same creature with its condition; time away never counts against its lifespan. Its lifespan runs on the authority's clock, old age slows and then ends it, and death shows the cause and the next hatch. Losing the browser no longer loses the player: an exportable recovery code restores the identity. Extinct lineages stay in a history list. A basic admission queue stops the free tier from failing hard. ADR 0019 is the contract for the mechanics; ADRs 0008 to 0010 for the model.

## Out of scope

- Mating, offspring, promotion, restore and the nearest-surviving-ancestor chain (M5). With genesis creatures only, "death with no surviving ancestor" is every death: the lineage ends and the next genesis starts a new one. The ledger already stores `seq`, `prev` and status in the shape M5 needs.
- Verifiers, proof bundles and the CLI (M9). M4 writes the pure functions (canonical JSON, hashes, seed derivation, record checks) that M9 reuses.
- Witnesses, signed inputs and audits (M10). Progress is clamped and flagged, not proven.
- The full capacity model (M13). M4 meters and queues; `docs/CAPACITY.md` comes later.
- A second authority key or key rotation. The key list format allows it.
- Creature position persistence: ponds differ between sessions, so only condition is saved.

## Touches

New: `src/ledger/canonical.ts`, `record.ts`, `drand.ts`, `genesis.ts`, `recovery.ts`; `src/sim/life.ts`; `worker/ledger.ts`, `worker/beacons.ts`, `worker/usage.ts`, `worker/e2e-entry.ts` with `worker/wrangler.e2e.jsonc`; `tools/record-drand.ts`; `tests/fixtures/drand/`; `src/game/life.ts` (client life flow), `src/game/history.ts`; `tests/e2e/m4-*.spec.ts`.

Changed: `src/sim` (`rules.ts`, `types.ts`, `step.ts`, `replay.ts`, state hash: rules version 4), `src/ledger/identity.ts`, `src/net/protocol.ts`, `src/net/hub-client.ts`, `worker/authority.ts`, `worker/schema.ts`, `worker/index.ts`, `worker/wrangler.jsonc`, `tools/worker.mjs`, `playwright.config.ts`, `src/game/app.ts`, `online.ts`, `hud.ts`, `screens.ts`, `debug.ts`, `index.html`, `docs/DESIGN.md`.

New dependency: `@noble/curves` (BLS12-381; install with `npx -y npm@11 install @noble/curves`). The browser loads it lazily, only when a genesis arrives.

Interfaces:

```ts
// src/ledger/canonical.ts (no DOM, no Node APIs)
export function canonicalize(value: Canonical): string;   // RFC 8785: integers (safe) and strings only; throws RangeError on floats, NaN, booleans, null, undefined, unsafe integers, lone surrogates
export type Canonical = string | number | readonly Canonical[] | { readonly [key: string]: Canonical };
export function hashWithDomain(domain: string, text: string): string;   // hex SHA-256(domain + "\n" ‖ UTF-8 text)

// src/ledger/record.ts
export type RecordKind = 'genesis' | 'checkpoint' | 'death';   // M5 adds 'mate-commit' | 'birth' | 'promote' | 'restore'
export interface LedgerRecord { v: 1; rules: number; kind: RecordKind; creature: string; seq: number; prev: string; owner: string; t: number; body: { [key: string]: Canonical } }
export interface StoredRecord { record: LedgerRecord; hash: string; ownerSig: string | null; authSig: string; keyId: string }
export function recordHash(r: LedgerRecord): string;                 // 'bs/rec/v1'
export function requestHash(r: Omit<LedgerRecord, 't'>): string;      // 'bs/req/v1'
export function creatureId(genesis: LedgerRecord): string;            // its record hash
export function authoritySign(secret: Uint8Array, hash: string): string;
export function checkStored(s: StoredRecord, keys: readonly PubKey[]): string[];   // [] when the hash, the authority signature and (when present) the owner signature verify

// src/ledger/drand.ts
export const QUICKNET: { chain: string; publicKey: string; genesis: number; period: 3 };
export function roundAt(ms: number): number;                          // floor((ms/1000 − genesis) / 3) + 1
export interface Beacon { round: number; signature: string }          // hex
export function verifyBeacon(b: Beacon): boolean;                     // BLS12-381 G1 signature, DST of bls-unchained-g1-rfc9380
export function randomnessOf(b: Beacon): Uint8Array;                  // SHA-256(signature)
export function fetchBeacon(round: number | 'latest', f: typeof fetch, hosts?: string[]): Promise<Beacon>;   // verified, with host fallback; throws when none verifies

// src/ledger/genesis.ts
export function genesisSeed(randomness: Uint8Array, commitId: string): Seed;
export function genesisFor(randomness: Uint8Array, commitId: string): Genome;
export function commitmentId(c: GenesisCommit): string;               // 'bs/commit/v1'
export function checkGenesis(record: LedgerRecord, commit: GenesisCommit, beacon: Beacon): string[];   // [] when the record's genome hash, commit and round all recompute

// src/sim/life.ts (pure, shared)
export function lifespanMs(lifespanTrait: number): number;            // 75 min × trait
export type LifeStage = 'young' | 'mature' | 'old';
export function lifeStage(activeMs: number, lifespanMs: number, biomass: number, maxBiomass: number): LifeStage;
export function accrue(prevTicks: number, ticks: number, wallMs: number): number;   // min(claimed, wall + 2000), never negative

// src/ledger/recovery.ts
export function encodeRecoveryCode(seed: Uint8Array): string;         // Crockford base32 + 2-byte checksum, groups of 5 ("ABCDE-FGHJK-…")
export function decodeRecoveryCode(text: string): Uint8Array | null;  // null on a wrong length, a bad character or a checksum mismatch; accepts lower case, I/L as 1, O as 0, any dashes or spaces
```

Wire additions (`src/net/protocol.ts`, `PROTOCOL_VERSION` stays 1 only if the old messages are untouched; any change to an existing message bumps it):

```
client → hub:  { t:'genesis-request', nonce, sig }   { t:'progress', n, ticks, biomass, energy, health }   { t:'death', cause, ticks }   { t:'history' }
hub → client:  { t:'life', life: Life | null, genesisIn: ms }   { t:'commit', commit, authSig, keyId, hatchesLeft }   { t:'genesis', record, ownerRequest, commit, beacon, genome }
               { t:'ack', n, activeMs }   { t:'died', cause, record }   { t:'history', lives: PastLife[] }   { t:'queued', position, etaS }   { t:'refused', reason }
```

`Life = { creature, seq, genome, biomass, energy, health, activeMs, lifespanMs }`; `PastLife = { creature, species, cause, activeMs, bornT, diedT }`. Every message has a size cap and is parsed by the shared codec; unknown or malformed input never throws.

## Tasks

- [x] T1 Life rules (rules version 4): lifespan, old age, maturity in the sim
  - Acceptance (unit tests, written first):
    - `lifespanMs(1) = 4,500,000` (75 min); `lifespanMs(0.6) = 2,700,000`; `lifespanMs(1.6) = 7,200,000`. `lifeStage` is `young` before max(12 min, 20% of the lifespan) of active time or below 60% of max biomass, `mature` when both hold, `old` from 85% of the lifespan (old beats mature). Boundary cases at exactly each limit are pinned.
    - `accrue(prev, ticks, wallMs)`: 900 ticks claimed (30 s) in 30,000 ms wall → 30,000; claimed 900 ticks but wall 10 s → 12,000 (wall + 2 s); `ticks < prev` or `wallMs < 0` → 0; zero ticks → 0.
    - Sim: an elder creature (`CreatureState.elder`) has 0.8× the steady-state top speed of the same creature not elder (within 1%) and drains 1.2× the basal energy of an idle one. Elder never changes `phys`.
    - Sim: the input log gains `life: [tick, 'elder' | 'expire'][]` (optional, ascending, validated). `expire` sets the creature's health to 0 with cause `old-age` on that tick (a `death` event is emitted once, with `cause: 'old-age'`); `elder` sets the flag. A replay with both events is identical in Node and Chromium (a new golden, run in the existing determinism E2E).
    - `RULES_VERSION` is 4; `hashWorld` covers `elder`; every sim golden is regenerated under version 4 and the PR says so. The hash still rejects NaN and Infinity.
    - Numbers live in `RULES.life` (`lifespanBaseMs` 4,500,000; `elderAt` 0.85; `elderThrust` 0.8; `elderBasal` 1.2; `matureMinMs` 720,000; `matureMinShare` 0.2; `matureBiomassShare` 0.6; `accrueSlackMs` 2000).
  - Done: `src/sim/life.ts` (`lifespanMs`, `lifeStage`, `accrue`, `applyLife`), `CreatureState.elder`, `InputLog.life`, `RULES.life`, rules v4 with every golden regenerated (hashes and `rulesVersion` only) plus a new `old-age` golden replayed in Chromium.
  - Gotcha: `lifeStage` takes the lifespan, so 20% of a 75 min life (15 min) beats the 12 min floor; only lifespans under 60 min use the floor.
  - Notes: no genome import in `src/sim`: `lifespanMs` takes the trait value. Update DESIGN §5 (the trait range is 0.6 to 1.6) and the header ("rules version 4") in the same PR.

- [x] T2 Canonical JSON, record hashing, authority signatures
  - Acceptance (unit tests, written first):
    - `canonicalize` follows RFC 8785 for integer and string data: the RFC's key-ordering example (keys `"\r"`, `"1"`, `"\u0080"`, `"ö"`, `"€"`, `"😀"` (U+1F600), `"דּ"` (U+FB33)) sorts by UTF-16 code units in that order; string escapes are exactly `\"` `\\` `\b` `\f` `\n` `\r` `\t` and `\u00xx` (lower case hex) for other control characters, with no escaping of `/` or non-ASCII; no whitespace; nested arrays and objects; `-0` is rejected; `2**53` and `1.5` and `NaN` and `true` and `null` and `undefined` throw `RangeError`; a lone surrogate throws.
    - `canonicalize` is deterministic under key insertion order (100 shuffled copies of one object give one string).
    - `recordHash` uses the domain `bs/rec/v1` and `requestHash` the domain `bs/req/v1` over the record without `t`; three golden records (genesis, checkpoint, death) have committed hashes under `src/ledger/__golden__/` with the rules version. Changing `t` changes `recordHash` and not `requestHash`; changing any other field changes both.
    - `creatureId(genesis)` is the genesis record hash; a record with `creature: ""` is only valid for kind `genesis` with `seq: 0` and `prev: ""`; every other kind needs a 64-hex `creature` and `prev`.
    - `authoritySign` and `checkStored`: a record signed by a generated key verifies; a flipped bit in the record, the hash, the signature or the key id, a key id not in the list, and a wrong key each produce a named failure; an owner signature, when present, must verify under `bs/req/v1` for the owner.
    - Integers only: `body` values built by the game from floats are converted by one helper (`hundredths(x) = Math.round(x * 100)`) and a test shows the helper is the only path (the record codec rejects any non-integer number).
  - Notes: reuse the signing helpers in `identity.ts` (`verify`, domain prefix); the `src/ledger` rules apply: no DOM, no Node-only APIs. Lone surrogates must be rejected explicitly (`TextEncoder` would replace them).
  - Done: `canonical.ts`, `record.ts` (also `recordProblems`, `requestMessage`, `authorityPublicKey`, `authorityKeyId`, `PubKey`), `signWithSecret` in `identity.ts`, goldens in `src/ledger/__golden__/records.json`. An owner signs `requestMessage` (the JCS bytes) under `bs/req/v1`; the authority signs the hash bytes under `bs/auth/v1`.
  - Gotcha: `JSON.parse` reorders integer-like keys, so key-order tests compare the canonical text, not parsed keys.

- [ ] T3 drand client and recorded fixtures
  - Acceptance:
    - `npx -y npm@11 install @noble/curves`; `QUICKNET` carries the pinned chain hash `52db9ba7…e971`, the public key from the chain's `/info`, genesis 1692803367 and period 3. `roundAt(1692803367000) = 1`, `roundAt(1692803369999) = 1`, `roundAt(1692803370000) = 2`, and rounds strictly increase every 3 s.
    - `tools/record-drand.ts` fetches `/info` and 600 consecutive rounds (about 30 min of beacons) from `api.drand.sh` with fallbacks, verifies each, and writes `tests/fixtures/drand/info.json` and `rounds.json` (`{ first, last, beacons: [{ round, signature }] }`). The recorded files are committed. The tool is run once in this task (cloud sessions can reach the hosts); a test fails if the fixtures are missing or stale in shape.
    - `verifyBeacon`: all 600 recorded beacons verify. A beacon with one flipped hex digit, the signature of a neighbouring round, a wrong-length signature, a non-hex string and an off-curve point all return `false` and never throw. `randomnessOf` equals SHA-256 of the signature bytes (checked against three values computed independently in the test file with `@noble/hashes`).
    - `fetchBeacon` with a fake `fetch`: tries hosts in order, skips a host that errors, returns a bad signature, answers with the wrong round or times out, and returns the first verified beacon; with every host failing it throws, and never returns an unverified beacon. `'latest'` and a numeric round use the v1 paths `/{chain}/public/latest` and `/{chain}/public/{round}`.
    - Cost: verifying one beacon takes under 250 ms in Node (record the measured value in the task note) and the module is loaded lazily by the client (an import-graph test shows `src/game/app.ts` has no static path to `@noble/curves`).
  - Notes: no test touches the network; only the recording tool does. If a host later changes its response format, the tool is the only thing to update. The DST for `bls-unchained-g1-rfc9380` is `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_`; the message is SHA-256 of the 8-byte big-endian round.

- [ ] T4 Ledger store: the UTXO rule, heads and the authority key
  - Acceptance (workerd tests, written first):
    - Migration 2 creates `players`, `creatures` (head: `id`, `owner`, `status`, `seq`, `hash`, `genome`, `activeMs`, condition, `bornT`, `diedT`), `records`, `commitments`, `beacons`, `keys`, `usage`, `flags`, `genesis_log`. Migrations are append-only (the existing ones are untouched) and a second start applies nothing.
    - `Ledger.accept(request)` is one SQLite transaction: a transition with `prev` equal to the creature's head hash and `seq` equal to head `seq + 1` is accepted, countersigned and returned; the head moves; an identical resubmission (same request hash) returns the same stored record and writes nothing; a request with a stale `prev` or a wrong `seq` is rejected as `conflict` and logged in `flags` (kind, owner, creature, hash, time); an unknown creature, a record for another owner's creature, a transition on a `dead` creature, and a non-genesis record without a creature are rejected with named reasons.
    - Exactly one head per creature: after 200 random accept calls (valid, stale, duplicate, wrong-owner, shuffled, seeded), each creature's chain of accepted records has strictly consecutive `seq`, every record's `prev` is the previous record's hash, and the head equals the last. A creature has at most one status; a player has at most one `active` creature.
    - The authority key is generated on first use (`crypto.getRandomValues`, 32 bytes), stored in `keys`, reused after an eviction (`evictDurableObject`), and never appears in any response, log line or error. `GET /v1/pubkeys` (origin-checked like health) returns `{ keys: [{ id, publicKey, from }] }` and every stored record passes `checkStored` with it.
    - Writes: accepting one checkpoint costs at most 3 row writes (record, head, and nothing else); the test counts rows written through the SQL cursor's `rowsWritten`.
  - Notes: `worker/ledger.ts` is plain functions over `SqlStorage` so tests don't need sockets. The ledger imports `src/ledger` for hashing and signatures; it never trusts a client-supplied hash. Keep all SQL in one place. `players` stores `playerId`, first seen and last seen only (no names; names stay in the hub).

- [ ] T5 Beacon service: cache, commitments, alarms and the fixture entry
  - Acceptance (workerd tests; time is faked):
    - `Beacons.latest()` returns the highest verified round the object knows by wall time (`roundAt(now)` minus a one-round margin when the newest is not yet published); `Beacons.get(round)` serves from the `beacons` table without a fetch when cached, otherwise fetches, verifies, stores (one write) and returns; an unverifiable response is never stored.
    - `commit(kind, ownerData)` names `round = latestPublished + 2` (never earlier), stores the commitment, countersigns it, and returns it; the same request returns the same commitment and the same round; there is no function that changes a stored round (a test greps the module's exports).
    - A commitment whose round is not published yet sets one alarm for `roundTime(round) + 500 ms`; `alarm()` resolves every pending commitment whose round is available, reschedules for the earliest still pending, and sets no alarm when none is pending (so an idle object has no timer). A beacon outage (fetch fails for 60 s of fake time) leaves the commitment pending, never substitutes a value, and resolves on the first success; `pending` shows in the health of the commitment (`awaiting`).
    - `DRAND_SOURCE=fixture`: the source serves `rounds.json`, with the fake clock starting at `first` when the object is created and then advancing in real time; past `last` it keeps serving the last round for `latest()` but reports later rounds as unavailable (a test pins this). Without the variable the source is the live fetcher with the four hosts of ADR 0010, and the fixture module is not in the production bundle (a test builds `wrangler deploy --dry-run` output, or imports the production entry, and finds no fixture data in it).
    - `worker/e2e-entry.ts` re-exports the Worker and the `Authority` class with the fixture source; `worker/wrangler.e2e.jsonc` points at it with `DRAND_SOURCE=fixture`; `tools/worker.mjs dev --e2e` selects that config.
  - Notes: verification uses `verifyBeacon` (BLS) inside the object: measure its CPU time in workerd and record it. Cloudflare's per-request CPU allowance is generous for Durable Objects (ADR 0008); if a verification ever exceeds 1 s, split it across invocations rather than skipping it.

- [ ] T6 Genesis over the hub
  - Acceptance (workerd tests with the fixture source, then the shared codec tests):
    - Protocol: `parseClientMsg` and `parseHubMsg` accept the new messages and reject oversized, malformed and wrong-typed ones without throwing (a fuzz test of 2,000 random strings and mutated valid messages). Genome text in `genesis` is base64url within `GENOME_DATA_MAX_CHARS`.
    - A player with no creature sends `genesis-request` with a valid owner signature: the hub answers `commit` at once (round, commit id, hatches left), then, once the round's beacon exists, sends `genesis` with the record, the owner request, the commitment, the beacon and the genome text. The record's creature id is its hash, the head exists with `seq` 0, and `checkGenesis` returns `[]`. The client-side recomputation `genesisFor(randomness, commitId)` equals the genome text and its hash equals `body.genome`.
    - Idempotence: sending the same request again (same nonce) before and after resolution returns the same commit and the same genesis and creates no second creature. A bad owner signature, a request signed for another player and a request while a creature is `active` are answered `refused` with a reason and change nothing.
    - Bucket: 3 requests with different nonces (after each creature is marked dead through a test hook) succeed, the fourth is `refused { reason: 'limit', genesisIn }` with `genesisIn` about 300,000 ms; after 5 minutes of fake time a request succeeds again, and the bucket never exceeds 3. The limit is per identity.
    - A genesis creature's DNA is different for different nonces and different rounds (200 requests with a fake source: no duplicate genome hashes), and equal for the same `(randomness, commitId)` in Node and workerd.
    - `life` is sent after `welcome` for every session: `null` for a new player (with `genesisIn` 0), the active creature otherwise.
    - A tampered `genesis` (a changed genome text, a record whose `body.round` differs from the commitment's, a beacon of another round) fails `checkGenesis` with a named reason, and the client-side check refuses it.
  - Notes: the genome is looked up by `genomeHash` check on the client, so the authority cannot swap DNA. `hatchesLeft` is the bucket's current content. Update DESIGN §5 and §11 (bucket instead of 1 per 10 min).

- [ ] T7 Progress, checkpoints and plausibility
  - Acceptance (workerd tests, fake clock):
    - `progress { n, ticks, biomass, energy, health }` from an active player's session is acknowledged with `{ n, activeMs }`; `n` must increase (a repeat or lower `n` is ignored without an answer); `activeMs` grows by `accrue(prevTicks, ticks, wallMs)`. A client that sends 900 ticks after 5 s of wall time gains 7,000 ms; one that sends 900 ticks after 40 s gains 30,000 ms; one that sends no ticks gains 0 whatever the wall clock says.
    - Plausibility (each case clamps the stored condition and writes a `flags` row with the reason, and never rejects the session): biomass above `maxBiomass` (from the genome's `physOf`) is clamped to it; growth faster than `RULES.growth.maxRate × the growth stat × elapsed active seconds × 1.1 + 1` per second of accrual is clamped; energy above `2 × biomass` and health above `10 × √biomass` (all in hundredths) are clamped; negative, non-integer or non-finite values are rejected by the codec before they reach the ledger.
    - Checkpoint policy: no row is written for a progress message by itself; a checkpoint is written (a) when the socket closes after progress, (b) on the first progress after 900,000 ms of accrued active time since the last checkpoint, and (c) at a death. Each checkpoint is a `checkpoint` record with `body { biomass, energy, health, activeMs }`, `seq + 1` and the right `prev`.
    - Write budget: one simulated player for one hour of play (progress every 30 s, no reconnect) causes at most 10 SQLite row writes; the same player disconnecting and reconnecting 4 times in the hour causes at most 18. The message budget: 120 progress messages per hour plus pings stay under 1 request-equivalent per player-minute (20 incoming messages) with a large margin; the test prints both numbers.
    - Resume: after a close, the next `hello` receives `life` with the last checkpointed condition and `activeMs`. After a Durable Object eviction in the middle of a session (`evictDurableObject`), the next progress still lands (the latest progress comes back from the socket attachment) and no accrued time is lost or doubled.
    - Offline time: a player who closes at active time `a`, and returns 10 hours later (fake clock), has `activeMs = a` plus nothing for the gap, and the same remaining lifespan.
    - Rate: `progress` counts in the per-session rate limit as an ordinary message, and 1,000 progress messages in 10 s close the session with `CLOSE_RATE_LIMITED` as before.
  - Notes: keep the latest progress in the hibernation attachment (2 KB limit: store only the five numbers and `n`). Compute `physOf` from the stored genome via `src/genome`; it is shared code and already imported by the Worker's tests.

- [ ] T8 Old age and death on the authority
  - Acceptance (workerd tests, fake clock):
    - When a progress message brings `activeMs` to the creature's `lifespanMs` (the genome's lifespan trait via `lifespanMs`), the authority writes a `death` record `{ cause: 'old-age', activeMs, biomass }` (after a checkpoint of the last condition), marks the creature `dead`, sends `died { cause, record }` and does not accept more progress for it (answered `refused { reason: 'dead' }`). Progress that would overshoot the lifespan is clamped to it.
    - A `death` request from the client (`{ t: 'death', cause, ticks }` with cause `starved`, `toxin`, `uv`, `pressure` or `killed`; `old-age` is refused from clients) writes a checkpoint (from the last progress) and a `death` record, marks the creature `dead`, and answers `died`. A second `death` for the same creature returns the same record (idempotent). A `death` for a creature that is not the session's active creature is ignored and counted.
    - A dead creature accepts no later transition (T4's rule) and its owner can request a new genesis (bucket permitting). The extinct lineage stays: `history` returns up to 20 past lives (newest first) with species name (`speciesName` from the genome), cause, `activeMs`, birth and death times, and nothing from other players.
    - Elder state: `life` and `ack` carry `lifespanMs`; the client can compute `lifeStage` and the elder time from `activeMs` alone. Genomes with lifespan traits 0.6, 1.0 and 1.6 give lifespans of 45, 75 and 120 minutes (tested on fixture genomes).
    - `LIFESPAN_SCALE=0.01` (fixture mode only) shortens the lifespan to 1% for E2E; without fixture mode the variable is ignored (a test sets it alone and sees no effect).
    - A creature never gains lifespan: a checkpoint after a disconnect never reduces `activeMs` (property test over 500 random progress and disconnect sequences with a seeded generator: `activeMs` is non-decreasing and bounded by elapsed wall time plus slack per session).
  - Notes: causes are validated against the sim's `DeathCause`. Keep the species name out of records (it is derived).

- [ ] T9 Client life flow: hatch through genesis, resume, report progress
  - Acceptance (unit tests with a fake hub client, then E2E against the fixture authority, `?hub=http://localhost:8790`, tests serial in their file):
    - The hub client sends `genesis-request` (a fresh 16-byte nonce, signed through the identity) when the player clicks Hatch and the hub says `life: null`; it shows the "Awaiting beacon" state while the commit is pending, verifies the genesis (lazy `@noble/curves` import, `checkGenesis`, genome hash) and only then spawns. A failed check shows the death-screen style error "Could not verify your creature" with a retry, and spawns nothing.
    - With `life` present the same click resumes: the creature spawns at the pond's spawn hint with the checkpoint's biomass, energy and health and the same genome (`state().player.genomeHash` equals the ledger's).
    - Progress goes out every 30 s of simulated play, never while the tab is hidden or the creature is dead, with `n` increasing and `ticks` the creature's sim ticks since hatch; the `ack` updates the local life clock.
    - Death (any cause but old age) sends `death` once, shows the death screen at once (it does not wait for the answer), and the next Hatch asks for a new genesis. A reload after a death shows the title screen with the history entry and a fresh hatch, not a resumed corpse.
    - The hub unreachable, or `queued`: the player swims as an unrecorded practice cell (local random genome as in M3) with a small "Not recorded" badge, and no ledger message is sent; an online recovery ends the practice cell only at the next death or hatch (ADR 0016).
    - Single session: a second tab with the same identity replaces the first, which shows "Playing in another tab" and does not reconnect (existing `CLOSE_REPLACED` handling; add the check for the ledger).
    - E2E (`m4-genesis.spec.ts`, PR suite): hatch → "Awaiting beacon" visible → creature appears within 15 s; `state().life` has `status: 'active'`, `creature`, `genome` hash and `awaitingBeacon: false`; two different identities get different genomes; the same genome as an independent recomputation from the fixtures via `window.__bs.life.recompute()` (a debug helper).
    - E2E (`m4-resume.spec.ts`, PR suite): hatch, eat until biomass grows, wait for a progress ack (`state().life.lastAckN`), close the page, reopen with the same identity: same creature id and genome hash, biomass within the last progress's value, `activeMs` not reset and not increased by the time away.
  - Notes: `src/game/life.ts` owns the state machine (`idle → requesting → awaiting → verifying → playing → dead | practice`) so it is testable without the DOM. Playwright gets a fourth hub port and its own file-level hub for the M4 specs (`m4`: 8790, started with `--e2e`); the existing hub E2E ports are unchanged, except that every hub started for E2E uses `--e2e` so their hatch has a fixture beacon (the older specs pin `?genome=starter`, which skips the ledger: pinned and debug-spawned creatures are unrecorded practice cells). `window.__bs.state().life` gains `status`, `creature`, `seq`, `activeMs`, `lifespanMs`, `stage`, `awaitingBeacon`, `lastAckN`, `genesisIn`, `practice`.

- [ ] T10 Lifespan in play: HUD, old age, rehatch and history
  - Acceptance (unit tests, E2E with `LIFESPAN_SCALE=0.01` through the M4 hub):
    - HUD shows life as a thin bar with the stage word (`Young`, `Mature`, `Old`) and, in plain words, the remaining time when below 10 minutes ("About 8 min left"). `Mature` appears only when `lifeStage` says so. Text uses the player's language: no "activeMs", "checkpoint" or "ledger" in the UI (a banned-word test as in M3's inspector).
    - At 85% the game sends `{ kind: 'elder' }` through the sim input log once (the creature slows and burns faster, a soft grey tint on the cell, a "Feeling old" toast); a replay of the recorded log reproduces the run. At 100% the sim `expire` event kills the creature with cause `old-age`, the death screen reads "Died of old age" and the report line shows how long it lived.
    - The death screen shows "Hatch again" with a countdown when the bucket is empty ("Next recorded hatch in 3:42"; Enter is disabled, the practice cell button remains). With hatches left, the first Enter starts the genesis flow at once.
    - The title screen has a **History** panel (last 10 lives: species name, cause, time lived, when) fed by `{ t: 'history' }` once per session start and after each death. Empty state: "No creatures yet".
    - E2E (`m4-oldage.spec.ts`, PR suite, ≤ 60 s): hatch with `LIFESPAN_SCALE=0.01` (lifespan about 45 s, elder at about 38 s); `state().life.stage` goes `young → old` and the creature's top speed measured through `state()` drops about 20% after the elder event; at expiry the screen is `dead` with cause `old-age`; History lists the creature; the next Hatch gets a different genome than the first and the ledger holds two creatures for the identity, one dead and one active.
    - E2E (`m4-limit.spec.ts`, PR suite): with the fixture authority, die three times fast (starve through `debug.setEnergy(0)` and a short wait); the fourth Hatch shows the countdown and offers the practice cell, which plays like M3 with the badge.
  - Notes: HUD and screens use the existing `hud.ts`/`screens.ts` patterns. The tint reuses an existing material parameter if one fits (membrane colour shift), otherwise the CSS badge only. Update DESIGN §5 and §10 (feedback table gains "old age").

- [ ] T11 Recovery code: export, import, replace the session
  - Acceptance (unit tests, E2E):
    - `encodeRecoveryCode(seed)` encodes the 34 bytes (the seed and its 2-byte checksum) as 55 Crockford base32 characters (272 bits, 3 spare bits that must be zero) in 11 groups of 5; the test pins the exact length and a golden code for the all-zero seed, a counter seed and a random seed. `decodeRecoveryCode` returns the same bytes for the code in lower case, with extra spaces and dashes, and with `I`/`L` for `1` and `O` for `0`; it returns `null` for each of the 55 × 31 single-character changes of the three golden codes (a change that happened to pass the 16-bit checksum would mean a bad golden seed: pick another), non-zero spare bits, a missing group, an extra group, a code of another length and non-Crockford characters. The checksum is the first 2 bytes of SHA-256('bs/recovery/v1\n' ‖ seed).
    - `identity.ts` gains `exportRecoveryCode(): string` (explicit only: the seed never appears in `state()`, a log line, a record or any message; a test greps the built app's debug hook output for the seed bytes) and `importRecoveryCode(store, code): Promise<Identity>` which replaces the stored seed after a successful decode. Importing the code exported by identity A into an empty store gives the same `playerId`; importing into a store holding identity B makes B unreachable (replaced, not merged).
    - UI: a **Recovery code** button on the title screen opens a panel with the code (blurred until clicked, with a Copy button) and an Import field with a confirm step ("This replaces the creature you are playing with. Continue?"). After a confirmed import the page reloads with the new identity, and the old tab's session (same identity) is replaced through the single-session rule. A reminder line "Save your recovery code" shows on the title screen until the code has been revealed once (`localStorage` flag; the page works without it).
    - E2E (`m4-recovery.spec.ts`, PR suite): context A hatches and resumes; reveal and copy the code from A; a fresh context B imports it: B's `playerId` equals A's and its resumed creature id and genome hash equal A's; A's page then shows "Playing in another tab" and does not reconnect.
  - Notes: groups of 5 are display only. Keep the private seed in the `createIdentity` closure: export goes through a closure method, not a field. Worker code never sees the code. Record the "export a code after the first mating" reminder as M5's (ADR 0009).

- [ ] T12 Usage meter and the admission queue
  - Acceptance (workerd tests, fake clock; client unit tests):
    - Meter: upgrades count 1 request each, incoming messages 1/20 of a request, and every SQLite write counts as a write; counters are per UTC day, kept in memory and flushed to `usage` at most once a minute (and not at all while nothing changed); crossing midnight UTC starts a new row. After 3,000 messages and 40 upgrades in one day the `usage` row shows 190 requests (±1) and 3,000 messages. Flushing costs at most 1 row write a minute (test: 1 hour of constant traffic writes at most 60 usage rows).
    - Queue: with `MAX_SESSIONS=3`, the 4th and 5th signed-in sessions receive `queued { position: 1 | 2, etaS }` instead of `welcome`, appear in no pond and cannot send other messages (answered `refused { reason: 'queued' }`); when one of the three leaves, the first queued session is promoted (gets `welcome` and `life`) within one alarm tick (15 s of fake time at most) and the second becomes position 1 (`queued` again). The queue order is by arrival. A queued session that leaves is removed and the positions update.
    - Budget: with `DAILY_REQUEST_BUDGET=1000`, the next new session after 900 counted requests is queued even with few players, and is promoted after midnight UTC resets the counter. Existing sessions are never dropped by admission, and requests are never failed by a limit the meter could have predicted.
    - The alarm runs only while the queue is not empty (no pending alarm when it is); hello timeouts keep working alongside.
    - Client: a `queued` message shows "Waiting for a place (3rd in line)" on the title screen with live position updates and does not block the practice cell (T9); a later `welcome` ends the wait without a reload.
    - Defaults: `MAX_SESSIONS` 200, `DAILY_REQUEST_BUDGET` 100,000, both `vars` in `wrangler.jsonc`; the test config overrides them.
  - Notes: the queue state lives in socket attachments (a queued socket is a socket in phase `queued`); no SQLite writes for queueing. DESIGN §8 gains the exact numbers.

- [ ] T13 End-to-end scenario, owner-facing checks, documentation sync
  - Acceptance:
    - `m4-lifecycle.spec.ts` (`@slow`, release gate): hatch → play with scripted steering to eat and grow → reload (resume, same creature) → export the recovery code → import it in a second context → die of starvation → History shows both lives in order → the bucket empties after three quick deaths → the practice cell works → a queued fourth tab (`MAX_SESSIONS` reduced through the e2e config of its own hub port) sees its position and is promoted when a tab closes.
    - Every exit criterion of M4 has a test named in the mapping below and the whole PR suite for M4 runs in under 3 minutes in CI (record the time).
    - DESIGN.md §5, §8, §10 and §11 match the shipped numbers (bucket, lifespan range, progress cadence, queue defaults, the 30 s reload rewind). ROADMAP M4 status is set by the milestone step, not here.
    - `window.__bs` and the testing notes in `.claude/rules/tests.md` list the new `life` state, the debug helper and the M4 hub port.
    - A `docs/SETUP.md` note says the Worker needs no new secrets for M4 and that the authority generates its own key; if live drand cannot be reached from the Worker, the game shows "awaiting beacon" and retries (verified by a unit test of the pending path).
  - Notes: this task only adds the long scenario and the sync; do not move work from earlier tasks here.

## End-to-end check

Against the fixture authority (`wrangler dev --e2e`, no live drand):

1. Hatch twice with two identities: each shows "Awaiting beacon", then a creature; the genomes differ, and each equals the independent recomputation from the recorded beacons and the commit id.
2. Eat, grow, let one progress ack arrive, close the tab, reopen: same creature, same genome, biomass at the last progress, lifespan not refilled and not spent by the time away.
3. With a scaled lifespan the creature turns old (slower, hungrier, tinted), dies of old age, shows it, and History lists it; the next hatch is a new creature.
4. Three quick deaths empty the hatch bucket; the fourth Hatch shows the countdown and a practice cell.
5. Export the recovery code, import it in another browser context: same player, same creature; the first tab is replaced.
6. With the session cap lowered, a further tab sees its place in the queue and is promoted when a place frees.
7. The ledger check: every record the authority stored passes `checkStored` against `/v1/pubkeys`, each creature has exactly one head, and every genesis passes `checkGenesis`.

Exit criteria map: "identities and genesis creatures registered (drand-seeded)" T2–T6, T9; "one accepted head per creature" T4, T7, T8; "single session" T9 (and the M2 hub test it extends); "lifespan on the authority clock (paused offline)" T1, T7, T8, T10; "durable resume" T7, T9; "recovery code" T11; "extinct lineages kept as history" T8, T10; usage meter and admission T12; the end-to-end check T13.

## Rubric

- [ ] Hatching feels like an event, not a wait: "awaiting beacon" shows a lively state for 3 to 6 seconds, then the creature appears without a visible jump (evidence: a screenshot pair and the measured wait in the E2E, under 15 s with the fixture clock).
- [ ] Old age is readable before it kills: the stage word, the remaining-time hint, the tint and the slower swim each show before death (evidence: HUD screenshots at young, old and dead, and the E2E speed ratio).
- [ ] The death screen names the cause in plain words and tells the player what happens next (evidence: screenshots for starved, toxin and old age; the countdown text test).
- [ ] The Recovery code and History panels use no technical jargon and fit at 960×540 (evidence: banned-word tests and screenshots).
- [ ] Genesis creatures resolve within 10 s on the live Pages build against live drand (owner).
- [ ] A reload mid-game feels safe: you are back where you were, not rewound in a way that feels unfair (owner).
- [ ] Rehatching is quick enough for the loop: three fast deaths followed by a countdown does not feel punishing (owner; the practice cell is the escape).

## Risks

- BLS verification is slow or large in a browser or workerd → measured in T3 and T5; it loads lazily on the client; the authority verifies once per round and caches; if a platform is too slow, the verification moves into a worker thread or is split across invocations, never skipped (ADR 0010).
- The recorded drand fixtures go stale if a host changes its format → only `tools/record-drand.ts` touches hosts; fixtures are small and re-recorded by one command; verification never depends on a host.
- Live drand unreachable from the Worker (a Cloudflare egress issue) → commitments wait and the UI shows "awaiting beacon" with a retry state; the owner checks live behaviour in the playtest (rubric); no fallback randomness is ever used (ADR 0010).
- The progress cadence misses the write or message budget → T7 measures both with a one-hour simulated player; the checkpoint interval is a constant (`RULES.life`-adjacent in `worker/ledger.ts`) so it is cheap to retune.
- A client claims impossible condition → clamped and flagged, never trusted for anything beyond its own creature in M4; the real checks come with M5's costs and M10's audits.
- A reload rewinds up to 30 s, which a player could use to undo a death → bounded and documented; lifespan and the hatch bucket cannot be reset that way; revisit if playtests show abuse.
- Adding `elder` and rules version 4 breaks older goldens → regenerated once in T1 with the PR saying so; tests pin `?genome=starter` and never hatch through the ledger unless they mean to.
- The Playwright suite grows past its time budget with another hub port and `wrangler dev` start → the M4 specs share one authority on one port and run serially in one project; the time is recorded in T13 and `@slow` takes over before the PR gate passes 3 minutes.
- A second tab fighting for the same identity → single session (existing rule) plus the final "Playing in another tab" state, so the tabs never ping-pong.
