# 0019: Ledger mechanics, genesis commitments and the life clock (M4)

- Status: accepted
- Date: 2026-10-26

## Context

ADRs 0008 to 0010 set the contract: one Durable Object holds canonical heads, countersigns records, commits to future drand rounds and keeps the clock. M4 has to turn that into a working ledger for genesis creatures only (mating is M5). Open questions: who signs what when the authority sets `t` and observes most progress itself, how genesis fits the "creature id = hash of its genesis record" rule, how the client reports progress without breaking the write budget (≤10 rows per player-hour) or the message budget (≤20 messages per player-minute), how lifespan is measured when movement is peer-to-peer and unverified, and what the usual play loop (die, hatch again) costs under a genesis limit.

## Decision

**Who signs.** A record is `{ v, rules, kind, creature, seq, prev, owner, t, body }` (ADR 0009). Two refinements:

- `t` is set by the authority, so the owner cannot sign the finished record. For a transition the owner starts (M5: promote, restore, mate), the owner signs the **request**, which is the record without `t`, hashed as `SHA-256("bs/req/v1\n" ‖ JCS(record without t))`. The stored record keeps that signature as `ownerSig`.
- Records the authority itself observes carry no owner signature: `checkpoint`, `death` (any cause) and the genesis resolution. They are **attested**: the authority countersigns, and the claims inside (condition) are clamped by plausibility rules and flagged when clamped. For genesis the owner's consent is the signed genesis request, which the commitment names. Trust in the authority for facts it witnessed itself (time, session state) is already accepted in ADR 0009; `docs/VERIFY.md` (M9) says so.
- The authority's countersignature is `Ed25519(domain "bs/auth/v1", record hash bytes)` with a key generated inside the Durable Object on first use and stored in a `keys` table. Its key id is the first 6 bytes of `SHA-256(public key)` as base64url. `/v1/pubkeys` lists `{ id, publicKey, from }` for every key ever used (rotation is not built, the list format allows it).

**Genesis.**

1. The client sends `genesis-request { nonce, sig }`; `sig` signs `JCS({ v: 1, kind: "genesis", owner, nonce })` under the domain `bs/req/v1`. The nonce is 16 random bytes (base64url).
2. The authority picks `round = latest published round + 2` (ADR 0010) and stores a commitment `{ v: 1, kind: "genesis-commit", owner, nonce, round, req: <request hash> }`, countersigned. The **commit id** is `SHA-256("bs/commit/v1\n" ‖ JCS(commitment))` in hex. The same request resubmitted returns the same commitment. There is no cancel and no second round.
3. When the round's beacon is published and verified, the authority derives the seed `SHA-256("bs/genesis/v1" ‖ randomness ‖ commit id ‖ 0x00)` and `genesisGenome(seed)` (read as four big-endian words through `seedFromBytes`). It writes the `genesis` record: `creature` is `""`, `seq` 0, `prev` `""`, `body { commit, round, genome: <genome hash>, generation: 0, karyotype: 1 }`. **The creature id is the record hash.** The genome itself is never in the record: anyone recomputes it from the beacon and the commit id. The authority also stores the genome text in the creature row so it can serve it without redoing the BLS check.
4. The client recomputes the DNA from the beacon it receives with the record, verifies the beacon (BLS), and shows "awaiting beacon" until then. It never accepts DNA the authority only asserts.

**Genesis limits.** At most one non-dead creature per identity (so no second genesis while one lives), and a token bucket of 3 hatches that refills one per 5 minutes. DESIGN.md said 1 per 10 minutes; with starvation and toxins ending lives in minutes that would break the core loop (the brief's first priority), so the bucket keeps a burst while still limiting farming. When the bucket is empty the player may swim as an unrecorded **practice cell** (the existing local fallback) and is told when the next recorded hatch is available.

**Checkpoints and the write budget.**

- The client sends a `progress` message every 30 s of simulated play: `{ n, ticks, biomass, energy, health }`, the first three integers in hundredths. The authority keeps the latest valid progress in the socket's hibernation attachment (no SQLite write) and answers with `ack { n, activeMs }`.
- A `checkpoint` record is written from the latest progress when the socket closes, on the first progress after 15 minutes of active time since the last checkpoint, and at a death. One checkpoint is 2 row writes (the record and the creature's head), so an hour of play writes about 8 rows. Position is not part of the condition (ponds differ between sessions); biomass, energy and health are.
- Resume: on `hello` the authority sends `life`: the active creature (id, seq, genome text, condition, `activeMs`, `lifespanMs`) or `none`. The client spawns it at the pond's spawn hint with that condition. A reload therefore loses at most the last 30 s of progress. A death the client never reports is not an escape worth closing: resume rewinds at most 30 s and never refills lifespan or the genesis bucket; M10 audits implausible progression.

**Active time (the life clock).** The authority accrues `activeMs` for a creature only from accepted progress messages:

`accrued = min(claimedMs, wallMs + 2000)`, with `claimedMs = (ticks − previous ticks) · 1000 / 30` and `wallMs` the time on the authority's clock since the previous progress (or since the session's `life` message for the first one).

So a hidden tab (no ticks), an offline player and a checkpointed creature accrue nothing, a client cannot age faster than real time, and `activeMs` is never decided by a client alone. The time between the last progress and a socket close is not counted (it favours neither side meaningfully: at most 30 s). There is no expiry alarm: the authority evaluates old age on each progress and at close, and issues `death { cause: "old-age" }` when `activeMs ≥ lifespanMs`. The client counts the remainder down itself from the last `ack` and ends its creature at zero, so a player sees old age on time, and a client that ignores it gets its later progress rejected.

**Lifespan.** `lifespanMs = 75 min × the lifespan trait` (0.6 to 1.6 in the expression table; DESIGN said 0.6 to 1.4, the code table wins). Old age begins at 85% of `lifespanMs` (−20% thrust, +20% basal metabolism), death at 100%. Maturity (≥ max(12 min, 20% of the lifespan) of active time and ≥ 60% of the maximum biomass) is computed in M4 and shown in the HUD; it gates mating from M5.

**Beacons.** The authority fetches rounds from the drand hosts (ADR 0010), verifies each, and caches it in a `beacons` table. A commitment whose round has not been published yet waits on an alarm set for the round's time (alarms only while a commitment is pending, so no timer when idle). `DRAND_SOURCE=fixture` replays `tests/fixtures/drand/`; its clock starts at the first recorded round when the object is created. The fixture entry is a separate module used only by tests and `wrangler dev` for E2E, never by the production `main`. `LIFESPAN_SCALE` (a number, default 1) shortens lifespans for E2E and is honoured only together with `DRAND_SOURCE=fixture`.

**Admission.** The object meters requests (upgrades and incoming messages ÷ 20 for the request equivalent), messages and row writes per UTC day in memory and flushes them to a `usage` row at most once a minute while busy. Past 90% of `DAILY_REQUEST_BUDGET` (default 100,000) or at `MAX_SESSIONS` concurrent sessions (default 200), a new signed-in session is **queued**: it gets `queued { position, etaS }` instead of `welcome`, and is promoted in order when room appears (checked on close and by an alarm every 15 s while the queue is not empty). ETA is `position × 30 s`, to be replaced by measurements in M13.

## Consequences

- Genesis is verifiable from public data: the commitment, the beacon, the seed derivation and the genome hash. M9 builds the verifier from the same pure functions.
- A browser that is away from its tab, offline or hidden never loses lifespan, and one that is active never gains it.
- A reload rewinds at most 30 s; this is accepted until M10's audits, and recorded in DESIGN §11.
- Chat, snapshots and food claims stay peer-to-peer; the object adds one signed request per hatch, one `progress` per 30 s and nothing else while a player swims.
- Rejected:
  - owner-signed checkpoints (a signature per progress message, and nothing a tab closing can finish);
  - an expiry alarm per creature (timers for every player, and the authority cannot know when a tab is hidden);
  - client-reported active time with no cap (a client could stretch or shrink its lifespan);
  - one genesis per 10 minutes (kills the loop; the bucket keeps the limit);
  - the authority choosing genesis DNA (the operator could hand out good starts).
