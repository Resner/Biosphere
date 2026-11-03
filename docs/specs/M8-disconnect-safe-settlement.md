# M8: Disconnect-safe settlement

Release: v0.9.0 · Gate: no

## Goal

Fights finish whatever the network does, and anyone can recheck how they ended.

- **Closing a tab escapes nothing.** A fighter whose player leaves fights on by its autopilot.
  - Its opponents still see it, faded.
  - Pond peers outside the fight see it through proxy snapshots that a connected fighter relays.
  - The fight ends by the rules and is settled by the authority.
  - The player hears what happened at its next sign-in, even when the fight ended in a death.
- **Reconnecting resumes.** A player who reloads, loses its connection or signs in from a second tab returns to its pond and its fight ("Back to the fight"). Its client catches up on the frames it missed, and it plays on from the referee's next frame. An input for a frame already final is rejected, so nothing is backdated.
- **A restart loses no fight.** The authority saves each fight's log as it runs. After a restart or an eviction it rebuilds every open fight and its locks, resyncs the connected fighters and finishes the rest.
- **Nobody left still ends.** Once no fighter still in a fight has a connected player for 10 s, the authority plays the rest at once with the autopilot and settles it.
- **Verifiable.** Every fight ends in a settlement document, countersigned by the authority, over a Merkle root of its frames. `verifyEncounter` rechecks it from the log by replaying the fight, and rejects any tampering. The participants' clients check it at the end.
- **Farming pays less.** A victim's worth as prey halves for each time its player was killed in the last 24 h, and again while the identity is under 30 minutes old.

The decisions behind this milestone:
- ADR 0011 is the contract.
- ADR 0053 covers the saved log, recovery, reconnects, the proxy snapshots, the 10 s wait before the authority finishes an abandoned fight, the life clock in fights and the away reports.
- ADR 0054 covers the settlement document, `verifyEncounter` and the victim's worth (rules 10, protocol 8).

`docs/DESIGN.md` §5, §7, §8 and §11 have the values, and the code tables stay the source of truth.

This milestone has **no gate**. v0.9.0 opens its `Playtest:` issue, and M9 starts without waiting.

## Carried over

The owner opened the gate on Playtest v0.8.0 (#311: "Keep going") with no new points. M7's close review (T17) handed these gaps to M8:

| Gap | Task |
|---|---|
| A failed settlement still marks the victim's life over without a `died` | T8 |
| A join isn't tier-checked against the other fighters, nor against fighters who already escaped | T7 |
| `progress` during a fight leaves the life `unsaved` | T6 |
| Carrion piece ids hash only 8 bits of the death position | T1 |

## Out of scope

- **M9:**
  - the endpoint that serves logs and settlements as proof bundles;
  - the lineage verifier and the CLI;
  - `docs/VERIFY.md`.

  M8 stores the documents and checks them in tests and on the clients.
- **M10:**
  - witness referees, signed inputs and movement audits;
  - the `authority-only` flag. The settlement names its referee as `authority`, so M10 can add witnesses beside it.
- **M11 and M12:** area of interest, handoffs and regrouping. A pond stays a full mesh of up to 24.
- **M14:** the interrupted-transaction journal for transactions other than fights.
- New combat mechanics, new genes and look passes.
- Touch controls.

## Touches

- **New:**
  - ledger: `src/ledger/settlement.ts` (documents, leaves, the Merkle tree, hashes, `checkSettledRecords`);
  - net: `src/net/encounter-verify.ts` (`verifyEncounter`, which replays from the messages; `src/ledger` must not import `src/net` at run time), `src/net/proxy-snaps.ts`;
  - worker:
    - `worker/fight-store.ts` (the `encounters` row);
    - `worker/recover.ts` (rebuilding open fights);
    - `worker/farming.ts` (worth);
    - `worker/away.ts` (the 10 s wait, the fast-forward, the away reports);
  - game: `src/game/fight-resume.ts`, `src/game/away-report.ts`, `src/game/fight-verify.ts`;
  - tools: `tests/net-harness.ts`, `tools/net.mjs` with `tools/net-report.ts` (`npm run report:net` writes `docs/perf/netcode.md`);
  - E2E: `tests/e2e/m8-*.spec.ts` on hubs 8813–8817.
- **Changed:**
  - sim: `src/sim/encounter/{types,combat,egg,encounter}.ts`, `src/sim/{rules,carrion}.ts`, the goldens;
  - net: `src/net/{protocol-defs,protocol-parse,protocol-encounter,encounter-start,encounter-sync,referee}.ts`;
  - ledger: `src/ledger/{record,snapshot-sig}.ts`;
  - worker: `worker/{schema,authority,fights,engage,settle,ledger,ledger-encounter,sessions,lives,life,e2e-entry,fight-test-kit}.ts`;
  - game: `src/game/{app,app-online,app-encounter,app-fight,life,screens,fight-end,labels,debug,app-hook}.ts`, `src/render/remotes.ts`;
  - tests: `tests/{scripted-referee,combat-tournament}.ts`, `playwright.config.ts`;
  - docs: DESIGN §2, §5, §7, §8, §10 and §11, `docs/TESTING.md`, `.claude/rules/{worker,net,sim}.md`.

**Shared shapes.** Tasks that run in parallel build to these. A later task maps between them rather than redefining them.

```ts
// src/sim/encounter/types.ts (T1), rules 10
export interface FighterStart { /* M7's fields */ worth: number }   // its worth as prey: 2^-k, k 0..7
// RULES.encounter.farming = { windowMs: 86_400_000, maxHalvings: 6, youngMs: 1_800_000 }
// A kill's reward and an eaten egg's reward are × the victim's (the carrier's) worth;
// the settlement scales the carrion by it (T8).

// src/net/protocol-defs.ts (T3), protocol 8; snapshots stay v4
export interface FighterInfo { /* M7's fields */ worth: number }     // 1, 0.5, ..., 2^-7; nothing else parses
export interface FightReport {
  enc: string;
  outcome: 'killed' | 'died' | 'escaped' | 'stood';
  cause: DeathCause | null;
  by: string | null;        // the killer's player name
  egg: 'none' | 'kept' | 'eaten';
  eggBy: string | null;     // the eater's player name
  frames: number;
}
// HubMsg 'life' gains   fight?: string        (the running encounter its creature is locked in; enc-start and the history follow)
//                       report?: FightReport  (a fight settled while the player was away; sent once)
// HubMsg 'enc-end' gains settlement?: SignedSettlement   (always sent from T8); ENC_END_MAX_BYTES 8192
// An 'enc-start' for the fight a client is already in is the authority's resync: every 'enc-frame' and 'enc-join' so far follows.
// State channel: a 57-byte proxy frame = the away player's 32-byte key, then its 25-byte snapshot.
//   encodeProxyFrame(playerId, snapshotBytes): Uint8Array
//   decodeStateFrame(bytes) → { snapshot, signed, proxyFor: string | null } | null   (25, 57 or 89 bytes)

// src/ledger/settlement.ts (T4)
export interface SettledFighter {
  player: string; creature: string; outcome: string; cause?: string; by?: number; frame: number;
  egg: 'none' | 'kept' | 'eaten'; eggBy?: number;
  biomass: number; energy: number; health: number; reward: number;   // hundredths
}
export interface Settlement {
  v: 1; kind: 'settlement'; rules: number; enc: string; pondSeed: string;
  start: string; joins: string[]; frames: number; root: string; hash: string;
  referee: 'authority'; results: SettledFighter[]; t: number;
}
export interface SignedSettlement { settlement: Settlement; hash: string; authSig: string; keyId: string }
export interface FightLog { pondSeed: string; start: EncStart; joins: EncJoin[]; frames: (number | null)[][] }
export function frameLeaf(f: number, inputs: readonly (number | null)[]): Uint8Array;
export function merkleRoot(leaves: readonly Uint8Array[]): string;
export function merkleProof(leaves: readonly Uint8Array[], index: number): string[];
export function verifyProof(root: string, leaf: Uint8Array, index: number, count: number, proof: readonly string[]): boolean;
export function startHash(pondSeed: string, start: EncStart): string;
export function joinHash(join: EncJoin): string;
export function settlementHash(s: Settlement): string;
export function checkSettledRecords(s: Settlement, records: readonly StoredRecord[]): string[];
// src/net/encounter-verify.ts (T4)
export function settlementOf(log: FightLog, enc: Encounter, t: number): Settlement;
export function verifyEncounter(s: SignedSettlement, log: FightLog, keys: readonly PubKey[]): string[];   // [] when it holds

// worker/fight-store.ts (T2), migration 7
// encounters (id TEXT PRIMARY KEY, pond TEXT, start TEXT, joins TEXT, frames TEXT, persisted INTEGER,
//             fighters TEXT /* per slot: name, activeMs and lifespanMs at its start */, open INTEGER,
//             t INTEGER, settlement TEXT) WITHOUT ROWID; CREATE INDEX encounters_open ON encounters (open) WHERE open = 1;
// players gains fight_report TEXT NOT NULL DEFAULT '' (used from T9)
```

## Tasks

T1 and T2 need nothing and can start together. Then T3 follows T1 and T5 follows T2. After that, T4, T6 and T7 can run beside each other, and the client chain (T10 → T11 → T12) runs beside the authority's last tasks.

### Rules, the log, the protocol and proofs

- [x] T1 Rules 10: a fighter's worth as prey, and carrion ids (after none)
  - Steps:
    1. `RULES_VERSION` 10, with no world reset (`FIRST_LIVE_RULES` stays 8, ADR 0054).
       - Regenerate every golden the version touches, and list them in the PR.
       - DESIGN's opening line says rules version 10.
       - Re-run `npm run report:combat`. Its hash changes with the version, and its lines must still hold.
    2. Add `FighterStart.worth` and `RULES.encounter.farming` (the shapes above).
       - `hashEncounter` covers worth.
       - `reward` in `combat.ts` multiplies the kill reward and the eaten egg's reward by the victim's (the carrier's) worth.
       - `fighterStartOf` sets `worth: 1` until T3 carries it in `FighterInfo`.
       - The tournament, the scripted referee and the kits use 1.
    3. Carrion ids: the place in a piece id becomes 8 hex digits, a 32-bit hash of the kill's full position, so a mutual kill's two drops can't collide. Check that the claim parser takes the longer id.
    4. `speedTest`: 900 frames of `null` inputs for a 4-fighter encounter take under 250 ms in Node. This is the fast-forward of T9 and the client catch-up of T10.
  - Acceptance (tests first):
    - At worth 0.5, a kill gives exactly half the M7 reward (biomass, then the overflow as energy at 3 per unit), and an eaten egg half its reward. At worth 2⁻⁷ the reward is that share. Worth 1 leaves every M7 combat test's numbers unchanged.
    - Two fighters with different worths hash differently, and `structuredClone` hashes equal.
    - Two drops of one encounter at positions 1 wu apart give disjoint ids, and a 10k seeded sample of drops gives no collision.
    - The encounter goldens are regenerated and pinned, and a second run gives the same hashes. The free-roam goldens change only by the rules version.
    - The tournament's gate lines all hold at rules 10.
  - Notes: no new genes. The worker sets worth from T7, and until then it is 1 everywhere.
  - Done: `Fighter.worth` is validated as 2^-k (k 0..7) and hashed; `reward` scales by it; carrion ids carry a 32-bit position hash; goldens and the combat report regenerated for rules 10 (combat gate lines hold).
  - Gotcha: `fighterStartOf` sets `worth: 1` until T3 carries it in `FighterInfo`; `UPDATE_GOLDENS=1` writes unformatted JSON, so run `npx biome format --write src` after, and leave `math.json` alone.

- [x] T2 The saved fight log [opus] (after none)
  - Steps:
    1. Migration 7 (`worker/schema.ts`): the `encounters` table and its open index, and `players.fight_report` for T9 (the shapes above).
    2. `worker/fight-store.ts`, driven from `worker/fights.ts`:
       - `open` inserts the row with the pond, `enc-start` and each slot's name and life clock, before `enc-start` is sent;
       - `append` writes the frames finalized since the last write, every 10 frames (`BATCH_FRAMES`, a worker constant);
       - `join` writes before `enc-join` is sent;
       - `flush` runs when a participant's socket closes (from `drop` in `worker/sessions.ts`);
       - `close` writes the tail and `open = 0` at the end, just before `settle`. T8 moves it into the settlement's transaction.
    3. `Lock.fight` gains `persisted`, the frames the row holds.
    4. Update `.claude/rules/worker.md`: fights now persist their log.
  - Acceptance (tests first). Workerd hub tests with the injected clock:
    - After a valid engage, the row holds the same `enc-start` the clients got, and no `enc-start` is sent when the insert throws (test seam).
    - After 35 frames the row holds 30, and after 40 it holds 40. Its frames replay (`replayEncounter`) to the authority's encounter hash at that frame.
    - A join is in the row before the joiner gets `enc-start`.
    - A participant's close makes the row hold every frame finalized so far.
    - At the end the row is closed (`open = 0`) and holds the whole log.
    - A 30 s duel with no close writes at most 34 rows from the lock to its end, settlement records excluded (`ledger.rowsWritten`).
    - No row is written during the lock-answer window.
  - Notes: no recovery yet (T5). M7's behaviour is otherwise unchanged. If the insert fails, the lock is released and the attacker is refused `engage:stale`, as when a genome does not build.
  - Done: `worker/fight-store.ts` (`hub.fightStore`) writes the row from `runFight`, `admit`, `tick` and `drop`; `Fight.names` became `slots` (name and clock), and `runFight`/`admit` take the fighters' lives. A 300-frame duel costs 32 log rows.
  - Gotcha: setting the indexed `open` column on every batch doubled the rows, so only the close sets it; hub tests bound other writes with `rowsBesideLog`. A failed write is logged and not retried until the next batch, so a `close` that fails leaves `open = 1` on a settled fight: T5 must treat a fight with settlement records as closed, and T8's transaction removes the case.

- [ ] T3 Protocol 8: worth, the fight in `life`, reports, settlements in `enc-end`, proxy frames [opus] (after T1)
  - Steps:
    1. `PROTOCOL_VERSION` 8. `SNAPSHOT_VERSION` stays 4.
    2. The shapes above, with parsers in `protocol-encounter.ts` and `protocol-parse.ts`:
       - `FighterInfo.worth` is one of 1, 0.5, …, 2⁻⁷;
       - `life.fight` is an encounter id;
       - `life.report` is a `FightReport`, with names checked like display names;
       - `enc-end.settlement` is a `SignedSettlement`: hex hashes, integers in range, at most 4 results, a referee of `authority`.

       `ENC_END_MAX_BYTES` becomes 8192.
    3. The proxy frame codec in `src/ledger/snapshot-sig.ts`: `encodeProxyFrame` and `decodeStateFrame`, which now takes 25, 57 or 89 bytes. A 57-byte frame whose key is not a valid player id is dropped.
    4. `fighterStartOf` reads `info.worth`. The worker's `fighterInfo` (`worker/engage.ts`), the scripted referee and `worker/fight-test-kit.ts` send 1 until T7.
    5. Document the resync rule (a repeated `enc-start`) in `protocol-defs.ts`. Update DESIGN §8 (the proxy frame) and `docs/TESTING.md` if a hook changes.
  - Acceptance (tests first):
    - Every new and changed message round-trips through its parser.
    - 10k fuzzed JSON values and 10k random byte strings never throw, and nothing malformed parses, including a worth of 0.3, 0, 2 or NaN, a report with a 200-character name, and a settlement with 5 results.
    - A proxy frame round-trips. Frames of 56 or 58 bytes give null, and a 57-byte frame with a bad key gives null.
    - A protocol-7 hello gets `error: version`.
  - Notes: no worker behaviour changes beyond the worth of 1. New parsers go in `protocol-encounter.ts`, so that `protocol-parse.ts` (761 lines) stays under 800.

- [ ] T4 Settlement documents, the Merkle root and `verifyEncounter` [opus] (after T1, T3)
  - Steps:
    1. `src/ledger/settlement.ts` (ADR 0054):
       - `frameLeaf` and the RFC 6962 tree (`merkleRoot`, `merkleProof`, `verifyProof`);
       - `startHash` and `joinHash`, with doubles as the hex of their IEEE-754 bits and `t0`, `at` and `round` as integers;
       - `settlementHash` (`bs/settle/v1`);
       - signing through the existing `authoritySign` and checking like `checkStored`;
       - `checkSettledRecords`.
    2. `src/net/encounter-verify.ts`:
       - `settlementOf(log, enc, t)`, the authority's document from its own encounter, in hundredths rounded down;
       - `verifyEncounter`, which checks the signature and key, `start`, `joins`, `frames`, `root`, each frame's width and the live rules (`rules-retired` otherwise), then replays the log (`encounterStartOf`, `applyJoins`, `stepFrame`) and compares `hash` and every result field. Its problems are named `signature`, `key`, `start`, `joins`, `frames`, `root`, `width:<f>`, `rules-retired`, `replay`, `hash` and `result:<slot>:<field>`.
    3. `src/ledger/record.ts`: from rules 10, an `encounter` body also requires `activeMs` (uint). Rules-9 records keep their shape and still pass `checkStored`.
    4. A golden settlement (`src/ledger/__golden__/settlement.json`), built from the `encounter-duel` and `encounter-join` golden logs with a fixed test key, pinned.
  - Acceptance (tests first):
    - `verifyEncounter` gives no problems for the golden, in Node.
    - Each tamper gives its named problem:
      - one ulp on a fighter's start `x`;
      - one input changed, a frame dropped, two frames swapped;
      - a join's frame changed;
      - a result's biomass + 1, its outcome changed;
      - `hash`, `rules`, a signature byte;
      - an unknown key id.
    - `merkleProof` and `verifyProof` round-trip for every index of every count from 1 to 33, and fail for a wrong index or leaf. Reference roots for counts 1, 2, 3 and 7 are pinned.
    - `checkSettledRecords` passes the golden's records and names a record whose condition, outcome, frames, reward or cause disagrees.
    - A rules-10 `encounter` body without `activeMs` fails `bodyProblems`, and a rules-9 one without it passes.
    - `speedTest`: `verifyEncounter` of a 900-frame 4-fighter log under 300 ms in Node.
  - Notes: workerd checks the same root and verdict in T8, and Chromium in T12.

### The authority

- [x] T5 Recovery after an authority restart [opus] (after T2)
  - Steps:
    1. `worker/recover.ts`: `recoverFights(hub, now)`, called inside the constructor's `blockConcurrencyWhile` after the migrations. For each open row:
       - rebuild the lock (players and creatures, joiners included);
       - rebuild the authority's encounter by replaying the log;
       - restore the `Referee` with `next` = the row's frames and its joins, which needs a restore option on `Referee`.
    2. Then `tick(now)`. Every frame whose deadline has passed is finalized with `null` inputs and appended to the log, and a fight that ends this way settles at once.
    3. Each connected participant (hibernated sockets survive an eviction) gets `enc-start` and every `enc-frame` and `enc-join` so far, through `resend(hub, lock, player)` in `worker/fights.ts`. T6 uses the same helper.
    4. The watchdog: `Fights.watchDue()` is the earliest open fight's `at + timeoutFrames × 100 ms + 1 s`, and `Authority.rearm` includes it. The alarm handler ticks every due fight, so an object nothing else wakes still settles.
    5. The E2E entry's hook `POST /v1/e2e/restart` (`worker/e2e-entry.ts` only) closes every socket with 1012, discards the in-memory fights and locks, and runs `recoverFights` as a new object would.
  - Acceptance (tests first). Hub tests simulate a restart by discarding `hub.fights` and calling `recoverFights`, the code the constructor runs:
    - The locks are back: court, accept, mate-check, promote, restore and genesis are refused `locked`, and an engage of a fighter joins or is refused as before.
    - The encounter is rebuilt and its hash at the row's frame equals the one before the restart.
    - A restart 2 s after the last write finalizes those frames as `null`. The connected participants then get `enc-start` and the whole history, and replaying what they received gives `enc-end.hash` at the end.
    - An input for a frame finalized before or during the outage is `late`, and the referee's bundle keeps `null`.
    - A fight whose timeout passed while the object was down settles at recovery, with `null` frames to its end.
    - With no socket and no message, the alarm (on the hand-moved clock) wakes recovery, and the fight settles. No timer is left (`fights.timers() === 0`), and the alarm no longer holds it.
    - A settled fight is never recovered again. A lock that was still waiting for its answer leaves nothing.
    - The restart hook exists only in the E2E entry (`tools/worker-bundle.test.ts`).
  - Notes: the client's handling of the resync is T10.
  - Done: `worker/recover.ts` (`recoverFights`, also run by the alarm, skipping fights in memory), `Referee` `next`/`joins` restore, `resend`, `Fights.{adopt,clear,running,watchDue}`, the E2E restart hook; a row whose fighters hold its records is just closed.
  - Gotcha: recovery resends before its catch-up `tick` (not after, as step 3 reads), so no client sees a replaced frame before its resync; the M7 `owed` set is not rebuilt (T6 replaces it).

- [ ] T6 Reconnect resumes the fight, and locks that hold across sign-ins [opus] (after T3, T5)
  - Steps:
    1. `enter` in `worker/sessions.ts`, for a player locked in a running fight:
       - its pond is the fight's, not `place()`'s pick;
       - `welcome` is followed by `life` with the creature and `fight: <enc>`, then `resend`. This replaces M7's `owed`, which withheld `life` until the end.
       - its inputs count from the referee's next frame.
    2. An away fighter keeps its seats while its fight runs: `place()` counts it in its pond's 24, and `canAdmit` counts it in `MAX_SESSIONS`.
    3. `progress` while locked: acknowledged, with no credit, no condition and no unsaved state (it fixes the M7 gap). A close while locked writes no checkpoint, since the settlement writes the records.
    4. A second tab's hello, which replaces the first, resumes the same way.
    5. DESIGN §7 ("Disconnects") and §8 (admission) as specced. Update `docs/TESTING.md` if hooks change.
  - Acceptance (tests first). Workerd hub tests:
    - B's socket closes mid-fight, and B signs in again. B gets `welcome` for the fight's pond (even when another pond is fuller), `life` with `fight`, then `enc-start`, then every `enc-frame` and `enc-join` in order.
    - B's input for the referee's next frame is `ok` and appears in its bundle, and an input for a final frame is `late`. B's frames while it was away are `null`.
    - The fight's pond holds B's seat: a 24th player who signs in while B is away goes to another pond. With `MAX_SESSIONS` reached, B is seated at once and a newcomer is queued.
    - `progress` during the fight leaves `rowsWritten` unchanged through a close and a sign-in, and the life's condition and `activeMs` are as at the lock.
    - Every locked action is still refused `locked` after the sign-in, and is allowed after the end.
    - A replacing second tab gets the same sequence, and the first socket is closed `4001`.
  - Notes: the locked time is credited in T8. The client's resume is T10.

- [ ] T7 A victim's worth at lock-in, and join checks [opus] (after T3)
  - Steps:
    1. `worker/farming.ts`: `worthOf(hub, player, now)` = `0.5^k` (ADR 0054). `k` counts the player's creatures that died with cause `killed` in the 24 h before `now`, at most 6, plus 1 while `first_seen` is under 30 min before `now`. It uses reads only, through the `creatures_dead` index.
    2. `fighterInfo` in `worker/engage.ts` sets `worth` for both sides at lock-in and for a joiner.
    3. Join checks (the M7 gap):
       - the joiner must be within ±1 tier of every fighter still in, else `engage:tier`;
       - an engage aimed at a fighter already out of its running fight (escaped, stood or dead, but still locked) is refused `engage:locked`.
    4. DESIGN §7 ("Kill farming") and §11 as specced.
  - Acceptance (tests first). Hub tests with a mocked `Date.now`:
    - A victim identity with no kills has worth 1, with one kill in 24 h 0.5, with two 0.25, and with ten 2⁻⁶. One first seen 10 min ago adds a halving. A kill 24 h + 1 ms ago no longer counts.
    - Deaths of other causes (toxin, old age, an eaten egg's child) don't count.
    - `enc-start` and `enc-join` carry the worths, and the killer's `encounter` record after a second kill of the same identity has half the first's reward, for the same bodies and layout.
    - A joiner two tiers from a fighter still in gets `engage:tier`, while one within ±1 of all joins. An engage at an escaped fighter of a running fight gets `engage:locked`.
    - `worthOf` writes no row.

- [ ] T8 The settlement: signed document, locked time, carrion worth, failed settlements [opus] (after T2, T4)
  - Steps:
    1. `Ledger.settle` (`worker/ledger-encounter.ts`, `worker/ledger.ts`) writes, in one transaction:
       - the records, as M7;
       - the log's tail and `open = 0` (moved from T2's `close`);
       - the settlement from `settlementOf`, countersigned, into the row's `settlement`.

       Settling twice writes nothing new and returns the stored document.
    2. Locked time: each participant's `activeMs` at the end is its `activeMs` at its start (from the row) plus the frames from its frame 0 (or its join) to the end × 100 ms, within its lifespan.
       - The rules-10 `encounter` record carries it.
       - A death record names it.
       - A connected life takes it.
       - A survivor whose lifespan ran out dies of old age right after the settlement, as before.
    3. `enc-end` carries the signed settlement. The carrion `settle` sends is the victim's biomass × its worth.
    4. A settlement that throws (the M7 gap):
       - nothing is written, and `settle-failed` is flagged once;
       - no life is marked over;
       - each connected fighter gets `enc-end` without a settlement, then `life` with its creature as the ledger holds it;
       - the lock is released.
    5. DESIGN §5 (the life clock) and §7 (the settlement) as specced.
  - Acceptance (tests first). Workerd hub tests:
    - At the end of a kill, `verifyEncounter(stored settlement, stored log, pubkeys)` returns no problems, `enc-end.settlement` equals the stored one, and `checkSettledRecords` passes the fighters' stored records. The same golden log gives the same root as in Node.
    - Locked time: after a 30 s fight with B away for its last 20 s, both fighters' records hold `activeMs` = their start plus 30 s, and A's next `progress` 10 s later credits about 10 s, not 40.
    - A fighter that reaches its lifespan inside the fight gets its `encounter` record, then its old-age `death`.
    - A kill of a victim at worth 0.5 broadcasts carrion with half its biomass.
    - The forced failure writes no row, flags once, and sends both connected fighters `enc-end` and then `life` with the creature alive in the ledger.
    - Row writes per duel stay at M7's per participant, plus the one row update for the tail and the settlement.
  - Notes: `worker/ledger.ts` is at 997 lines. Its change is a few lines handing the settlement's writes to `ledger-encounter.ts` and `fight-store.ts` (extend `ChainOps`).

- [ ] T9 Everyone left: the 10 s wait, the fast-forward and the away reports [opus] (after T6, T8)
  - Steps:
    1. `worker/away.ts`. When no fighter still in a running fight has a connected player:
       - note the time;
       - when `awayGraceMs` (10 s) has passed with nobody back, checked at each tick and by the watchdog, finalize every remaining frame with `null` at once, appending them to the log, then settle;
       - a sign-in within the window cancels it.

       `AWAY_GRACE_MS`, honoured only with `DRAND_SOURCE=fixture`, shortens it for E2E.
    2. A fast-forwarded kill drops its carrion at `min(the kill's tick, the current pond tick)`, at the victim's final position.
    3. Away reports:
       - in the settlement's transaction, each participant not connected at the end gets `players.fight_report`: a `FightReport` with the killer's and eater's names from the row;
       - `sendLife` adds `report` and clears it, which costs one row;
       - a dead player's `life` carries it beside its fallback.
    4. The E2E entry's `GET /v1/e2e/encounter/<id>` returns `{ open, frames, settled }`, so a scenario waits on state.
    5. DESIGN §7 as specced, and `docs/TESTING.md`.
  - Acceptance (tests first). Workerd hub tests with the injected clock:
    - Both fighters close. For 10 s the fight runs on `null` frames, then the rest is finalized at once and settled: records, the settlement and a closed row, with no timer left. Its hash equals playing the same `null` frames out in real time.
    - A sign-in at 9 s resumes the fight (T6), and no fast-forward happens.
    - A fighter that escaped (out) but stays connected doesn't hold the fight in real time once the fighters still in are all away.
    - A participant away at the end gets `report` in its next `life`, with the outcome, the killer's name and the egg, and a second sign-in has none. A connected participant gets none. Telling costs 1 row.
    - A player killed while away gets `life: null`, its fallback (which never offers an eaten child), and the report naming the killer.
    - A fast-forwarded kill's carrion reaches the pond with the current tick.

### The client

- [ ] T10 The client resumes a fight [opus] (after T6)
  - Steps:
    1. `EncounterSync`:
       - a `start` for the fight it is running restarts from that message (the authority's resync), so the history that follows replaces its own;
       - `step` then catches up to the present in one call, sampling the own input only for the newest frame, as a hidden tab's return does;
       - `state().encounter` gains `rejoins`.
    2. `src/game/fight-resume.ts`:
       - when a `life` names `fight`, the title screen's main button reads "Back to the fight", with the line "Your creature fights on by itself";
       - Enter, Space or a click resumes straight into the fight, with no egg reveal and no free-roam frame first;
       - fight messages that arrived before play are held and applied in order;
       - a `life` naming the fight the client already plays (a network-only reconnect) leaves the fighter's state to the encounter.
    3. A hidden tab that returns catches up as before.
    4. `docs/TESTING.md` (`encounter.rejoins`, the title's `resume-fight` button), and DESIGN §7 if the wording differs.
    5. E2E:
       - `m8-resume.spec.ts` (hub 8813). A engages B, B reloads right after `enc-start` and presses "Back to the fight". B's `encounter.id` equals the one before, a stance B picks after the resume shows on A's client, and both hashes equal `enc-end`'s.
       - `m8-restart.spec.ts` (hub 8814). Mid-fight the test posts `/v1/e2e/restart`. Both clients reconnect by themselves and keep the same `encounter.id`, each counts a rejoin, and both end with hashes equal to `enc-end`'s.
  - Acceptance (tests first):
    - Unit tests against the scripted referee:
      - a resync mid-fight converges on the referee's final hash;
      - an own input sent for a frame that went `null` during a disconnect converges on the autopilot's;
      - the catch-up of 900 frames for a 4-fighter fight runs in one `step`.
    - A game-level test with the fake online session: `life` with `fight` on the title shows the button, the held `enc-start` and frames apply on resume, and no free-roam tick runs in between.
    - Both scenarios pass 3 times in a row (`--repeat-each=3`). A fight can end before B is back, so `m8-resume` engages again until a resume happens, at most 3 times.
  - Notes: `m8-*` scenarios open pages through `open` in `tests/e2e/m7-fight.ts` (`debug.skipDraw`) and share steps in `tests/e2e/m8-fight.ts`.

- [ ] T11 Away fighters stay visible: drawn from the encounter, and proxy snapshots [opus] (after T10)
  - Steps:
    1. In the player's own fight, an opponent whose player left the pond (`member leave`) is not dropped. It stays drawn from the encounter until `enc-end`, then fades as a player who left.
       - It is drawn faded (60% opacity) with "away" after its name.
       - `state().encounter.fighters[].away` reports it.
    2. `src/net/proxy-snaps.ts`, the relay:
       - in each running fight, the connected fighter with the lowest slot (by the pond's member list) sends a proxy frame of each away fighter to every pond peer not in the fight;
       - 5 Hz, from its last confirmed encounter state;
       - a last frame at `enc-end` carries the result's alive flag.
    3. The receiver:
       - takes a proxy for X only from a peer whose newest snapshot is fighting, and only while X has sent nothing itself for 1 s; else it drops the frame and counts it (`state().net.proxyDropped`);
       - draws X faded, with `away: true` in `state().remotes`;
       - never offers X for an engage: no "F" glyph and no Attack button.
    4. DESIGN §7, §8 and §10, and `docs/TESTING.md`.
    5. E2E: `m8-proxy.spec.ts` (`@slow`, hub 8815, three contexts). A engages B while C watches from nearby, and B's page closes. A still draws B (`away`), and C's `remotes` shows B moving (its position changes between frames) with `away: true` until the fight ends. A's hash equals `enc-end`'s.
  - Acceptance (tests first). Unit tests with fake peers:
    - only one connected fighter relays, at 5 Hz, and stops after the end;
    - a proxy from a non-fighting peer, or for a player still sending its own snapshots, is dropped and counted;
    - the traffic per away fighter per peer averages ≤ 300 B/s over 10 s;
    - a forged proxy never yields an engage candidate.

- [ ] T12 Consequences at the next sign-in, and the settlement checked on the client [opus] (after T4, T9, T10)
  - Steps:
    1. `src/game/away-report.ts`. A `life` with `report` tells it once, in plain words:
       - on the title or death screen: "While you were away, <species> was killed by <name>", "… died of <cause>", "… escaped a fight", or "… held its own in a fight";
       - "Your egg was eaten while you were away" for an eaten egg;
       - a killed player's death screen offers its fallback, as after any death;
       - `state().report` holds what was told.
    2. `src/game/fight-verify.ts`. At `enc-end` with a settlement, off the frame loop, check three things:
       - the countersignature, with the keys from `GET /v1/pubkeys` on the hub, fetched once and cached;
       - the root over the frames this client holds;
       - `hash` against its own.

       `state().encounter.verified` is `true`, `false` or `null`.
    3. DESIGN §7 and `docs/TESTING.md`.
    4. E2E: `m8-away.spec.ts` (hub 8816, with `AWAY_GRACE_MS=500`):
       - A engages B, and B's page closes right after `enc-start`. When A's fight ends, B opens again: `state().report` agrees with A's `enc-end` for B, the line is on screen, and A's `encounter.verified` is true.
       - A second test (`@slow`): both pages close after `enc-start`. Once `/v1/e2e/encounter/<id>` reports it settled, both open again, and their reports agree with each other (a kill on one side names the other).
  - Acceptance (tests first):
    - Unit tests: each report kind gives its line, once. A settlement with one flipped bit, or a root that differs from the held frames, gives `verified: false`, and the correct one gives `true`.
    - The verification runs off the frame loop: no frame waits on it.

### Harness and closing

- [ ] T13 Deadlines, backdating and clock skew: the jitter and loss harness (after T10)
  - Steps:
    1. `tests/net-harness.ts` builds on `tests/scripted-referee.ts`: one in-process referee and 2–4 `EncounterSync` clients over a seeded link model.
       - Each client has its own one-way latency, jitter and hub-clock error (its offset estimate off by ±e ms).
       - Loss shows as a delay spike: with probability p, a message waits 200–600 ms and those behind it queue (WebSocket head-of-line).
       - A disconnect window drops messages both ways, then resyncs with `enc-start` and the history, as the authority does.
       - Every fighter's input is scripted from a seeded stream.
    2. `tools/net.mjs` and `tools/net-report.ts`. `npm run report:net` writes `docs/perf/netcode.md`, with one row per grid cell:
       - the grid: one-way 20, 80, 150 and 250 ms; jitter 0, 30 and 60 ms; loss 0, 2 and 5%; clock error 0, 20 and 60 ms;
       - the columns: the share of own inputs on time, rollbacks a second, the deepest rollback, resyncs, and whether every client's final hash equals the referee's.
    3. If the on-time line below fails, tune the lead's constants in `src/net/encounter-sync.ts` (they are not rules), and record the change in DESIGN §7.
  - Acceptance (`heavyTest`):
    - Every cell's clients end on the referee's hash, with no desync.
    - With one-way ≤ 150 ms, jitter ≤ 30 ms, no loss and a clock error ≤ 20 ms, at least 95% of own inputs are on time.
    - An input sent for a frame the referee has finalized is `late` and never changes a bundle: no backdating, under every clock error. One sent more than 2 frames ahead is `early`.
    - A 5 s disconnect converges with one resync, and the frames in between are the autopilot's.
    - Rollbacks never replay more than 10 frames: deeper corrections are counted resyncs.
    - The report's hash is pinned, and `npm run report:net` reproduces `docs/perf/netcode.md`.

- [ ] T14 End-to-end scenario, documentation sync (after T7, T11, T12, T13)
  - Steps:
    1. `m8-lifecycle.spec.ts` (`@slow`, hub 8817, `?quality=medium`, three contexts A, B and C, `AWAY_GRACE_MS=500`), in order:
       - A and B hatch, and A engages B while C watches;
       - B reloads and goes back to the fight;
       - the test posts `/v1/e2e/restart`, and everyone reconnects into the same fight;
       - B's page closes. A draws B away, and C sees it by proxy;
       - the fight ends, whatever the outcome. A's hash equals `enc-end`'s, and `verified` is true;
       - B opens again and reads the report that matches A's `enc-end`;
       - the medium budgets hold at each step.

       It follows `.claude/rules/tests.md` (state waits, sim ticks) and engages again when a fight ends before a step can run.
    2. Sync:
       - DESIGN §2, §5, §7, §8, §10 and §11 (drop the M8 marks for what shipped);
       - `docs/TESTING.md` (hooks and the hubs 8813–8817; the next file takes 8818);
       - `.claude/rules/{worker,net,sim}.md`: the log, recovery, the watchdog in `rearm`, proxy frames.
    3. List the owner checks for the Playtest issue (the rubric's `(owner)` lines).
  - Acceptance:
    - Every exit criterion maps to a named test or report (the table below).
    - Each PR E2E part stays under 5 minutes, and the long scenarios are `@slow`.

## Exit criteria → evidence

| Exit criterion (ROADMAP) | Tasks | Evidence |
|---|---|---|
| Closing a tab never cancels or escapes a fight | T2, T6, T9, T11 | the log flushed at a close (T2); locks and seats across sign-ins (T6); everyone-left hub tests (T9); `m8-proxy`, `m8-away` |
| Reconnect resumes | T5, T6, T10 | recovery and sign-in hub tests; `m8-resume`, `m8-restart` |
| The authority settles when everyone leaves | T9 | the fast-forward hub tests; `m8-away` (`@slow`) |
| Backdated inputs rejected | T5, T6, T13 | `late` after a restart and after a sign-in; the harness under clock error |
| Settlement records verifiable | T4, T8, T12 | `verifyEncounter` tamper tests and golden; workerd verifies what it stored; `encounter.verified` in `m8-away` |
| Persistence and recovery, proxy snapshots, deadline tests under skew, a Merkle root, transition locks, offline consequences, kill-farming decay, the jitter and loss harness (outline) | T2, T5, T11, T13, T4, T6, T9, T12, T1, T7, T13 | as listed in each task |

## End-to-end check

`m8-lifecycle.spec.ts` (T14, `@slow`, hub 8817, three players) runs one fight through every disconnect:
- a reload back into the fight;
- an authority restart;
- a tab closed, with the away fighter seen by its opponent and, by proxy, by a spectator;
- the end and its settlement checked on the client;
- the returning player's report.

The final hashes equal the referee's throughout, and the medium budgets hold.

Each path is also checked alone:
- `m8-resume` and `m8-restart` (fast, T10);
- `m8-away`, its fast test (T12);
- `m8-proxy` and the both-leave test of `m8-away` (`@slow`, three contexts or a wait for the settlement).

## Rubric

- [ ] A reload mid-fight is back in the same fight with one key or click, and its catch-up runs in one step (evidence: `m8-resume`, the T10 unit test, T1's `speedTest`).
- [ ] An opponent whose player left keeps fighting and stays on screen, faded, for both its opponents and spectators (evidence: `m8-proxy`, a screenshot attached to T11's PR).
- [ ] A returning player reads in one plain line what happened while it was away (evidence: `m8-away`, a screenshot attached to T12's PR).
- [ ] No client's result differs from the authority's anywhere in the harness's grid, and at most 150 ms one-way with 30 ms jitter at least 95% of inputs land in time (evidence: `docs/perf/netcode.md`).
- [ ] Every settled fight verifies, and any tampering is named (evidence: T4 tests, T8 workerd test, `encounter.verified`).
- [ ] (owner) Reloading or losing the connection mid-fight on a real network brings you back into the fight without confusion.
- [ ] (owner) Leaving a fight never feels like an exploit: the fight goes on, and its result waits for you.
- [ ] (owner) Repeated kills of the same player feel worth less, and ordinary fights still feel rewarding.

## Risks

- **Write cost**, about 1 row a second of fighting (ADR 0053).
  - `BATCH_FRAMES` is a worker constant; M13 measures it and may raise it.
  - The usage meter counts every row, and admission holds the daily budget.
- **The output gate delays a frame** by a few ms each time a batch is written. Clients absorb it as a late bundle, and the referee's deadline doesn't move. A hub test checks that bundles keep their order.
- **An authority restart replaces up to 9 sent frames** with the autopilot, a stated limit. Clients resync, and the fight may jump once.
- **An eviction while timers run.** The watchdog alarm wakes recovery, and every input wakes the object too.
- **The catch-up cost on a slow machine.** 900 frames fit in 250 ms in Node (T1's `speedTest`). If a browser needs longer, spread the catch-up over frames.
- **Forged proxy snapshots** move a faded body on other screens, nothing more. A proxy never feeds an engage, a claim or a result.
- **Flaky fight scenarios** (M7's lesson): a fight ends in many ways.
  - Scenarios assert the end "whatever the outcome", and engage again when a fight ends before a step.
  - They wait on `state()` and on `/v1/e2e/encounter/<id>`, never on wall time.
  - `AWAY_GRACE_MS` shortens the wait for E2E only.
- **Merge conflicts between parallel tasks.** The shapes above are fixed here.
  - T3 adds every protocol change at once.
  - The worker tasks are chained where they share files (`fights.ts`: T2 → T5 → T6 → T9; `settle.ts`: T8 → T9).
  - T7 touches only `engage.ts` and `farming.ts`.
  - The client tasks (T10 → T11 → T12) touch the game, not the worker.
- **Large tasks** (T5, T6, T10) may overrun one session. Every run pushes its work in progress (ADR 0042), and a task that fails across three runs is split (the `next` skill).
