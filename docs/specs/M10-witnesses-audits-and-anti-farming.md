# M10: Witnesses, audits and anti-farming

Release: v0.11.0 · Gate: no

## Goal

Fights, births and hatches get independent eyes, the authority no longer referees every frame of every fight, and a farm of bot identities buys no shortcut.

- **Witnesses are drawn by drand, never chosen.** For each fight, mating and genesis the authority commits:
  - the pool of eligible witnesses (at most 16);
  - the event;
  - a future drand round.

  When the round arrives, its randomness orders the pool. Nobody re-draws and nobody picks. A fight's referee and auditor, and a mating's or genesis's auditor, come from that order, and replacements follow it.
- **A witness referees most of a fight.** Once the round is in, a witness peer takes over refereeing at a frame boundary:
  - fighters send it their inputs, each signed;
  - it sends them its frames, signed;
  - it sends the authority one batch a second, instead of 10 inputs a second from each fighter.

  The authority checks every batch and steps its own copy of the fight. It takes the fight back at once when the witness goes silent, forges or lies, and at a join. Players feel no difference.
- **Auditors re-check what the authority decided.** After a fight, a mating or a genesis, a second witness:
  - replays the fight, or recomputes the DNA;
  - signs an attestation.

  A disagreement is overruled (the authority is final) and kept, and the witness loses eligibility.
- **"Checked by the authority alone" is never hidden.** A fight's settlement names who refereed which frames. Proof bundles carry every witness commitment and attestation, and the verifier counts what a witness saw and what only the authority did. The creature card says it for each fight, birth and hatch.
- **No farm shortcut.**
  - A bot-farm simulation (`npm run report:farm`) drives up to 16 bot identities against the real authority. It shows no faster generations, no extra children per creature, no biomass from nothing, and no more than a fair share of witness duties.
  - Young identities are judged by their play, not their age.
  - An attacker can't appear in range out of nowhere: the target's own copies of its signed snapshots must show it swimming there.
- **Cheaper fights.** A 30 s duel costs the authority at least 4× fewer incoming messages, and a witnessed second of fighting at least 10× fewer (`docs/perf/witness.md`).

The decisions behind this milestone:
- ADR 0012 is the contract.
- ADR 0058 covers the pool, the commitment and the round, selection and duties, how a witness referees and hands back, signed inputs and frames, disputes, attestations, authority-only, settlement and bundle version 2, the verifier's witness family, retention and the cost check.
- ADR 0059 covers young identities by play, the movement check at lock-in, and the bot-farm simulation and its gates.

`docs/DESIGN.md` §5, §7, §8 and §11 hold the values, marked M10.

This milestone has **no gate**. v0.11.0 opens its `Playtest:` issue, and M11 starts without waiting. There is no world renewal: the rules stay 11, and protocol 10 only keeps old clients out.

## Carried over

No owner input came: Playtest v0.10.0 (#379) has no reply, and Playtest v0.8.0 (#311) says "Keep going". M9's close review handed these edge cases to M10. None breaks an exit criterion:

| Gap | Task |
|---|---|
| `buildBundle` (`worker/proof.ts`) never checks a subject-only bundle against the 512 KB and 4,096-record caps, so a very long-lived creature could be served a bundle that `parseProofBundle` refuses. It also re-runs `assemble` for every candidate ancestor (about cubic in the lineage size on uncached reads) | T15 |
| A dead creature's bundle is edge-cached for a day as final, but its `flags` can still change after death | T15 |
| `sendLife` consumes `takeRenewal` before it knows the socket is open, so a socket that closed first loses the one-shot renewal notice | T15 |
| The card's verifier worker `error` handler calls `fail('unchecked')` but leaves the pending reply promise unsettled, so `start()` never finishes | T16 |
| `verify-gates.ts` skips `death` in `after-lifespan` and checks only `death` for `frozen-changed`; `verify.ts` indexes settlements by `enc`, so a duplicate id's earlier copy is neither signature-checked nor replayed | T16 |

## Out of scope

- **M11:**
  - witnesses chosen across the continuous world and its AoI, and a pool larger than one Durable Object sees;
  - handoffs of duty links between cells.
- **M13:**
  - the capacity model, with the measured witness costs;
  - sampling input signatures if their checks cost too much CPU at scale;
  - admission limits.
- **M14:** cross-engine goldens. Auditors in other engines are an early warning, not that test.
- Rewards for witness duty (ADR 0059 rejects them), and limits by IP.
- Storing input signatures for third parties (ADR 0058: the authority checks them on arrival).
- Movement checks in free roam beyond lock-in, and checks on joins.
- A public transparency log (ADR 0055 rejects it for now).
- New genes, combat rule changes, look passes and a world renewal.

## Touches

- **New:**
  - ledger:
    - `src/ledger/witness.ts`: pools, rounds, the order, attestations, and signed inputs and frames;
    - `src/ledger/verify-witness.ts`: the fifth family;
  - net:
    - `src/net/protocol-witness.ts`: the new messages' parsers;
    - `src/net/handover.ts`: referee spans and handover frames;
    - `src/net/witness-referee.ts`: a witness's referee, pure;
    - `src/net/referee-route.ts`: the fighter's side, pure;
    - `src/net/audit.ts`: an auditor's verdict, pure;
  - game:
    - `src/game/app-duty.ts`: the duty dispatch;
    - `src/game/app-witness.ts`: the referee duty in the page;
    - `src/game/app-audit.ts` with `src/game/audit-worker.ts`: audits off the frame loop;
  - worker:
    - `worker/witness-pool.ts`: eligibility and play time;
    - `worker/duty.ts`: duties, offers and strikes;
    - `worker/witness-fight.ts`: the authority's side of a witness-refereed fight;
    - `worker/attest.ts`: audits and attestations;
    - `worker/witness-test-kit.ts`: scripted witnesses for hub tests;
    - `worker/witness-cost.test.ts`;
    - `worker/farm.test.ts` (`heavyTest`);
  - tools:
    - `tools/farm-sim.ts` and `tools/farm.mjs` (`npm run report:farm`, which writes `docs/perf/farm.md`);
    - `tools/witness-report.ts` and `tools/witness.mjs` (`npm run report:witness`, which writes `docs/perf/witness.md`);
  - E2E: `tests/e2e/m10-*.spec.ts` on hubs 8822–8827, with shared steps in `tests/e2e/m10-steps.ts`.
- **Changed:**
  - ledger: `settlement.ts` (version 2), `proof.ts` (bundle version 2), `verify.ts`, `verify-gates.ts`;
  - net:
    - `protocol-defs.ts` (protocol 10), `protocol-parse.ts`, `protocol-encounter.ts` (`lock-state.seen`, settlement version 2);
    - `peer-mesh.ts`, `connection-policy.ts` (duty links), `signed-snaps.ts` (the last 5), `encounter-sync.ts`, `encounter-verify.ts`;
  - worker:
    - `schema.ts` (migration 10), `beacons.ts` (an explicit round), `authority.ts` (dispatch, the alarm);
    - `sessions.ts` (the relay, `POND_MAX`), `engage.ts`, `offspring.ts`, `lives.ts`;
    - `fights.ts`, `fight-store.ts`, `settle.ts`, `recover.ts`, `away.ts`, `farming.ts`, `audit.ts`, `proof.ts`, `index.ts`, `e2e-entry.ts`;
    - `fight-test-kit.ts` (T12), `tools/worker-bundle.test.ts`;
  - game: `app-online.ts`, `app-encounter.ts`, `app-fight.ts`, `combat-hud.ts`, `hud.ts`, `settings.ts`, `settings-panel.ts`, `debug.ts`;
  - card and tools: `src/card/{card,main,load}.ts`, `tools/verify-lineage.ts`, `tools/net-report.ts`, `tests/net-harness.ts`, `tests/lineage-fixture.ts`, `tools/storage-report.ts`;
  - docs: DESIGN §5, §7, §8, §11; `docs/VERIFY.md`, `docs/TESTING.md`; `.claude/rules/{ledger,net,worker}.md`.

`worker/ledger.ts` is at 984 lines, and no task grows it. `worker/fights.ts` (408) keeps its referee loop, and the witness phase lives in `worker/witness-fight.ts`. Each new file stays under about 600 lines.

**Shared shapes.** Tasks that run in parallel build to these. A later task maps between them rather than redefining them.

```ts
// src/ledger/witness.ts (T1), ADR 0058
export const POOL_MAX = 16;
export const WITNESS_MARGIN_MS = 500;
export type DutyKind = 'enc' | 'mating' | 'genesis';
export type DutyRole = 'referee' | 'auditor';
export function dutyEvent(kind: DutyKind, id: string): string;            // 'enc:<64 hex>', 'mating:…', 'genesis:…'
export function parseDutyEvent(s: unknown): { kind: DutyKind; id: string } | null;
/** A `witness` commitment's data (`Beacons.commit('witness', '', data, { round })`). */
export interface WitnessData { event: string; pool: string[] }            // pool: player ids, sorted, unique, ≤ POOL_MAX
export function witnessDataProblems(v: unknown): string[];
export function poolOf(eligible: readonly string[], event: string): string[];
//   the POOL_MAX ids with the lowest SHA-256('bs/pool/v1' ‖ event ‖ id), then sorted by id
export function witnessRound(t: number): number;                          // the first round due at or after t + WITNESS_MARGIN_MS
export function witnessOrder(pool: readonly string[], randomness: Uint8Array, commitId: string): string[];
//   every entry, Fisher–Yates from SHA-256('bs/witness/v1' ‖ randomness ‖ commit id bytes) through the sim's PRNG
export function firstPosition(kind: DutyKind, role: DutyRole): number | null;
//   enc: referee 0, auditor 1; mating and genesis: auditor 0, referee null

export interface Attestation {
  v: 1; kind: 'attest';
  event: string;          // dutyEvent(…)
  duty: string;           // the witness commitment's id
  position: number;       // the witness's place in witnessOrder
  witness: string;        // its player id
  subject: string;        // the settlement's hash | the genesis record's hash | birthSubject(slot 0, slot 1)
  agree: boolean;
  code?: string;          // the auditor's first problem; only when agree is false
}
export interface SignedAttestation { attestation: Attestation; sig: string }   // Ed25519 by the witness, domain 'bs/attest/v1'
export function signAttestation(identity: Identity, a: Attestation): SignedAttestation;
export function parseSignedAttestation(v: unknown): SignedAttestation | null;  // untrusted: never throws, refuses unknown fields
export function attestationSigned(s: SignedAttestation): boolean;
export function birthSubject(slot0: string, slot1: string): string;

// Signed inputs and a witness's frames (ADR 0058)
export function inputBytes(enc: string, f: number, code: number): Uint8Array;  // 'bs/input/v1' ‖ enc (32 bytes) ‖ u16 f ‖ u32 code
export function signInput(identity: Identity, enc: string, f: number, code: number): string;   // base64url
export function inputSigned(verify: KeyVerify, enc: string, f: number, code: number, sig: string): boolean;
export function witnessFrameBytes(enc: string, f: number, inputs: readonly (number | null)[]): Uint8Array;
//   'bs/wframe/v1' ‖ enc ‖ frameLeaf(f, inputs)
export function signWitnessFrame(identity: Identity, enc: string, f: number, inputs: readonly (number | null)[]): string;
export function witnessFrameSigned(witness: string, enc: string, f: number, inputs: readonly (number | null)[], sig: string): boolean;

// src/net/protocol-defs.ts (T2): PROTOCOL_VERSION 10. Parsers in src/net/protocol-witness.ts.
export const BATCH_MAX_BYTES = 12_288;   // the largest batch (20 frames of 4 signed inputs) is about 8.2 KB
export const DUTY_MAX_BYTES = 131_072;
// ClientMsg gains:
//   { t: 'avail'; on: boolean }
//   { t: 'duty-ok'; event: string } | { t: 'duty-no'; event: string }
//   { t: 'batch'; enc: string; f: number; i: (number | null)[][]; s: (string | null)[][]; end: boolean }
//      f: the first frame; 1–20 frames of width 1–4; a signature for each non-null input, null for null
//   { t: 'dispute'; enc: string; f: number; i: (number | null)[]; sig: string }   // the witness's signed frame
//   { t: 'attest'; signed: SignedAttestation }
//   lock-state gains seen?: SignedSnap[] (at most 5; T11 fills it)
// HubMsg gains:
//   { t: 'duty'; event; role: 'referee'; position; commit: SignedCommit; beacon: Beacon; pondSeed: string;
//     fighters: string[]; start: EncStart; history: DutyHistory[] }
//   DutyHistory = { t: 'enc-frame'; f; i } | { t: 'enc-join'; f; fighter }: the messages without `enc`, which the duty
//     names (900 full frames with it would pass DUTY_MAX_BYTES); frames from 0 in order, a join due no earlier than them
//   { t: 'duty'; event; role: 'auditor'; position; commit: SignedCommit; beacon: Beacon; audit: AuditCase }
//   { t: 'duty-end'; event; why: 'done' | 'taken-back' | 'replaced' | 'struck' }
//   { t: 'duty-peer'; enc: string; peer: string; on: boolean }       // open (or close) a duty link to `peer`
//   { t: 'enc-referee'; enc: string; from: number; by: string }       // by: 'authority' or the witness's player id
export type AuditCase =
  | { kind: 'enc'; log: FightLog; settlement: SignedSettlement }
  | { kind: 'genesis'; commitment: SignedCommit; record: StoredRecord; genome: string }
  | { kind: 'mating'; commitment: SignedCommit; births: [StoredRecord, StoredRecord];
      mates: [StoredRecord, StoredRecord]; parents: [string, string] };   // genome texts, slot order
// PeerEvent gains (event channel, ≤ EVENT_MAX_BYTES):
//   { t: 'finput'; enc; f; i: number; sig: string }                 // a fighter's input to its witness
//   { t: 'wframe'; enc; f; i: (number | null)[]; sig: string }      // the witness's frame
//   { t: 'probe'; n: number; back: boolean }                        // round trip on a duty link

// src/net/handover.ts (T3)
export interface RefereeSpan { by: string; from: number; position?: number }   // also the settlement's (T9 re-exports)
export class RefereeSpans {
  constructor(spans?: readonly RefereeSpan[]);           // default [{ by: 'authority', from: 0 }]
  refereeOf(f: number): string;
  hand(by: string, from: number, position?: number): void;  // RangeError unless from > the last span's from
  list(): RefereeSpan[];
}
export const HANDOVER_AHEAD = 3;   // h = next + 3 (to a witness, and a planned take-back from the frame due now)
export const TAKEBACK_AHEAD = 2;   // h' = max(next, due now) + 2 after a failure
export const BATCH_FRAMES = 10;
export const BATCH_GRACE_MS = 1000;

// src/ledger/settlement.ts (T9): the writer writes version 2; version 1 still parses and verifies
export interface SettlementV2 { v: 2; kind: 'settlement'; rules: number; enc: string; pondSeed: string; start: string;
  joins: string[]; frames: number; root: string; hash: string; referees: RefereeSpan[]; duty: string;
  results: SettledFighter[]; t: number }
export type Settlement = SettlementV1 | SettlementV2;   // SettlementV1 is today's, with referee: 'authority'
export function refereesOf(s: Settlement): RefereeSpan[];   // v1: [{ by: 'authority', from: 0 }]

// src/ledger/proof.ts (T9): version 2; a version 1 bundle parses with both lists empty
// ProofBundle gains witnessCommits: SignedCommit[] (≤ 1,024) and attestations: SignedAttestation[] (≤ 2,048)

// src/ledger/verify.ts (T9): Family gains 'witness'; LineageReport gains
//   witnessed: { events; refereed; audited; authorityOnly; overruled; unchecked }   (counts)
//   events: { event: string; creatures: string[]; refereed: boolean; audited: boolean; overruled: boolean;
//             authorityOnly: boolean; selection: 'checked' | 'unchecked' | 'none' }[]
//   one per held fight, mating and genesis; 'none' when the pool was empty, 'unchecked' when its commitment isn't held

// worker/witness-pool.ts (T4)
export const WITNESS_PLAY_MS = 1_200_000;   // fixture mode: env WITNESS_PLAY_MS (whole ms)
export const DUTIES_PER_HOUR = 20;
export const STRIKE_MS = 86_400_000;
export function playedMs(hub: Hub, player: string): number;   // Σ creatures.active_ms by owner, plus the session's credit since
export function eligible(hub: Hub, exclude: readonly string[], now: number): string[];
// worker/duty.ts (T4): hub.duties
//   committed(event, commit) · resolved(commitId) · offerAudit(event, audit: AuditCase) · answer(session, msg)
//   onReferee(event, witness, position)   (T5 fills: the handover)
//   onAuditor(event, witness, position)   (T8 fills)
//   end(event, role, why) · strike(player, kind, key) · holding(player) · linksOf(player)
```

**Migration 10** (T4, all of M10's schema at once): `players.struck_until`, an index on `creatures (owner)`, `encounters.referees` (JSON spans, '' until a handover), an `attestations` table (`event`, `position`, `witness`, `json`, `t`; primary key `(event, position)`), and indexes that find a witness commitment by its event and the oldest ones to prune.

**Flag kinds** (`FLAG_KINDS`, each added where it is raised):
- `authority-only` (T4, per event);
- `witness-silent`, `witness-forged`, `witness-equivocated` (T5, per event);
- `audit-overruled`, `attest-forged` (T8, per event);
- `teleport` (T11, per creature).

**Fixture-mode variables** (honoured only with `DRAND_SOURCE=fixture`, guarded by `tools/worker-bundle.test.ts`):
- `WITNESS_PLAY_MS` (the play needed to witness, whole ms);
- `WITNESS_IP_CHECK=off` (every E2E context shares localhost);
- `POND_MAX` (2–24, so a test can put a witness in another pond).

## Tasks

T1, T15 and T16 need nothing and can start at once. T2 follows T1, and T9 follows T1 and T16. Then T3 and T4 can run beside each other. T5 needs T3, T4 and T9; T6, T11 and T12 need only T4. T7 follows T5 and T6. T8 and T14 follow T5, and T13 follows T12. T10 follows T5, T8, T9 and T15. T17 closes.

### Documents and wire

- [x] T1 Witness documents: pools, rounds, the order, attestations, signed inputs and frames [opus] (after none)
  - Done: `src/ledger/witness.ts`; the drand clock moved to `drand-time.ts` so the shell can name rounds without BLS. Canonical JSON has no booleans, so an attestation signs `agree` as 1 or 0.
  - `birthSubject` hashes under `bs/attest/birth/v1`; the pinned order is `tests/witness-order-table.ts`, checked in `src/ledger/witness.test.ts` and `worker/witness.test.ts`.
  - Steps:
    1. `src/ledger/witness.ts` with the shapes above.
       - `poolOf`, `witnessRound` and `witnessOrder` are pure and deterministic. The order seeds the sim's PRNG (`seedFromBytes`, as genesis does).
       - `witnessDataProblems` checks a commitment's data: the event parses, and the pool is sorted, unique, at most 16 player ids.
    2. Attestations, signed inputs and witness frames:
       - `parseSignedAttestation` takes untrusted JSON: it refuses unknown fields, a `code` beside `agree: true`, non-hex ids and a position above 15, and never throws;
       - signatures go through `Identity` (the seed never leaves `identity.ts`);
       - checks of player keys go through `keyVerifier`, tabled once per key.
    3. `.claude/rules/ledger.md`: the witness documents and their domains.
  - Acceptance (tests first):
    - `poolOf`:
      - 40 eligible ids give 16, sorted, the same for the same event and different for another;
      - 5 give all 5 sorted;
      - duplicates count once.
    - `witnessRound(t)`:
      - its round's time is at least `t + 500` and the round before it is due earlier;
      - a `t` exactly 500 ms before a round gives that round, and 499 ms before gives the next one.
    - `witnessOrder`:
      - it is a permutation of the pool, the same for the same inputs, and different for another beacon or commit id;
      - over 10,000 seeded randomness values each of 16 entries comes first 6.25% ± 0.8% of the time;
      - a pinned order for the first recorded beacon (`tests/fixtures/drand/`) is equal in Node and workerd (a test in each pool).
    - `firstPosition`: enc gives referee 0 and auditor 1; mating and genesis give auditor 0 and no referee.
    - Attestations:
      - one signs and verifies;
      - a changed field or a flipped signature byte fails;
      - an unknown field, or `code` with `agree: true`, parses to null;
      - 10,000 fuzzed values never throw.
    - Signed inputs:
      - `inputBytes` is 49 bytes (`bs/input/v1`, 32, 2, 4), pinned;
      - a signature verifies, and another frame, code, encounter or key fails.
    - Witness frames: a `null` and a code 0 in the same slot give different bytes, and a signature verifies and fails as inputs do.
    - `speedTest`: 40 input signatures checked through one tabled key take under 40 ms in Node.
  - Notes: no worker or protocol changes here (T2, T4).

- [x] T2 Protocol 10: duties, batches, disputes, attestations, signed inputs on the peer link [opus] (after T1)
  - Done: `protocol-witness.ts`, with the shared record and commitment parsers moved to `protocol-docs.ts` (a witness commitment has owner `''`); `Authority.dropped` counts batches and disputes past their window, which `refereeWire` opens to fighters (T4 adds the referee duty).
  - Gotcha: the shapes changed: a duty's history drops `enc` (900 frames with it pass 128 KB), and `BATCH_MAX_BYTES` is 12,288 (20 frames of 4 signed inputs pass 8 KB). New messages refuse unknown fields.
  - Steps:
    1. `PROTOCOL_VERSION` 10. A protocol-9 hello gets `error: version`.
    2. The messages and peer events above. Parsers go in `src/net/protocol-witness.ts`, and `protocol-parse.ts` dispatches to them.
       - Every number is in range, every id hex or a well-formed player id, and every list capped (a batch's 20 frames and 4 slots, a duty's history of 900 frames).
       - A `batch` has a signature exactly where an input is not null.
       - `duty` is capped at `DUTY_MAX_BYTES` and `batch` at `BATCH_MAX_BYTES`. Peer events stay within `EVENT_MAX_BYTES`.
    3. `lock-state` takes an optional `seen` of at most 5 signed snapshots (T11 sends and reads it).
    4. The worker's per-session rate windows:
       - `batch` and `dispute` get their own (30 per 10 s, only while on a referee duty or fighting);
       - `avail`, `duty-ok`, `duty-no` and `attest` count in the 20-message budget.
    5. `.claude/rules/net.md`: the new messages and their caps.
  - Acceptance (tests first):
    - Every new message and event round-trips through its parser. Each field out of range, missing or extra parses to null.
    - A batch with a signature beside a null input, a missing signature, 21 frames or width 5 parses to null.
    - A `duty` of 131,073 bytes, and a `finput` past 2 KB, are refused.
    - 10,000 fuzzed values per parser never throw.
    - Hub test: a protocol-9 hello is refused. A session that sends 31 batches in 10 s has the extras dropped and counted.
  - Notes: protocol 10 ships with the release, so no pond mixes v0.10.x and v0.11.0 clients. The handlers are T4, T5 and T8; this task only parses and meters.

### The referee, shared

- [x] T3 One referee for the authority and a witness: spans, the witness's referee, the fighter's route [opus] (after T2)
  - Done: `handover.ts`, `witness-referee.ts` (drops `stray`, `forged` and `moved` inputs too, so it never batches one the authority refuses), `referee-route.ts` and `EncounterSync.overrule`; the harness's witness phase runs calm scripts (`witness-19`), since its usual duels end in about 4 s.
  - Gotcha: `tests/*.test.ts` never ran (the node project's include missed `tests/`); it does now. A final batch with nothing left is not sent.
  - Steps:
    1. `src/net/handover.ts`: `RefereeSpans` and the constants above.
    2. `src/net/witness-referee.ts`, pure, its clock, signer and sends injected:
       - `WitnessReferee` is built from a referee duty (start, history, pond seed, fighters) and `enc-referee { from: h }`;
       - it runs a `Referee` restored at `next = h` with the fight's joins, and steps its own encounter with every final frame;
       - each frame goes out as a signed `wframe` to every fighter;
       - every `BATCH_FRAMES` frames, and at once at the end or at a stop, it emits a `batch` with each input's signature;
       - `stopAt(h')` finalizes up to `h' − 1` and emits the final batch;
       - an `finput` from a non-fighter, for another encounter, or before `h` is dropped and counted.
    3. `src/net/referee-route.ts`, the fighter's side, pure:
       - which referee frame f's input goes to (the hub before `h`, the witness from `h`), and the lead from that referee's one-way latency;
       - at a handover, its own inputs already sent for frames from `h` on are sent once more, to the new referee;
       - it keeps the last 50 witness frames;
       - an authority frame that differs from a held witness frame means a resync from the authority's and one `dispute` carrying the witness's signed frame. An equal one means nothing.
    4. `tests/net-harness.ts` plays a fight with a witness phase: the witness has its own link latency and its own error on the hub clock.
    5. `npm run report:net` gains witness rows to `docs/perf/netcode.md`:
       - fighter-to-witness one-way 20, 80 and 150 ms;
       - jitter 0 and 30 ms;
       - the witness's clock error ±20 ms.
  - Acceptance (tests first):
    - `RefereeSpans`:
      - `[authority@0]`, then W from 33, then the authority from 120: `refereeOf` is right at 0, 32, 33, 119, 120 and 400;
      - a hand at or before the last span's start throws a `RangeError`.
    - A harness fight with the same delivered inputs gives the same frames, Merkle root and `hashEncounter` in two runs:
      - refereed by the authority alone;
      - refereed by the authority to frame 32, the witness from 33 to 119, and the authority again.
    - `WitnessReferee`:
      - it emits a batch every 10 frames and a final one at the end, and at `stopAt`;
      - every `wframe` passes `witnessFrameSigned`, and every non-null batch input passes `inputSigned`;
      - an input before `h` is `late`.
    - The route:
      - inputs for frames before `h` go to the hub and from `h` to the witness;
      - at a handover each input already sent for a frame from `h` on is sent once more;
      - a differing authority frame gives one resync and one dispute, and an equal one gives neither.
    - The witness rows of `report:net`: at one-way ≤ 150 ms, jitter ≤ 30 ms, no loss and both clock errors ≤ 20 ms, at least 95% of inputs are on time, and every client ends on the referee's hash.
  - Notes: no sockets, no WebRTC and no worker code here. T5 (the authority) and T7 (the page) wire these modules up. `FRAME_MS` and the input window stay the referee's.

### The authority

- [x] T4 Eligibility, pools, commitments and duty offers [opus] (after T2)
  - Done: `witness-pool.ts` (`eligible`, `commitWitnesses`, `avail`), `duty.ts` (`hub.duties`, `witnessView` for the E2E hook), migration 10 with the IP salt in `world`; a witness commitment's request key is its event's, so the req index finds it, and `Beacons.commit` takes `{ round, key }`.
  - Gotcha: an empty pool's `authority-only` flag adds a row to every lock, mating and genesis with nobody online, and `creatures_owner` one per creature insert; the M7–M9 row bounds grew by exactly that. An `avail` off counts at once (only an on waits 5 s).
  - Steps:
    1. Migration 10 (above).
       - `Beacons.commit` takes an explicit round (`{ round }`).
       - A witness commitment is kind `witness` with owner `''`, found by its event through the new index.
    2. `worker/witness-pool.ts` (ADR 0058's eligibility):
       - **the seat and `avail`**: seated, and `avail` on (the session's attachment);
       - **play**: `playedMs ≥ WITNESS_PLAY_MS`;
       - **independence**: not a participant, and no participant's IP hash. The hash is SHA-256 of a salt the object keeps and the `CF-Connecting-IP`, held in the session's attachment only, never in SQLite;
       - **duties**: none in progress, and fewer than 20 accepted in the last hour (timestamps in the attachment);
       - **strikes**: `struck_until` in the past.
    3. Commitments (`poolOf` of the eligible):
       - an encounter's right after `enc-start` goes out (`engage.ts`), with round `witnessRound(t)`;
       - a mating's and a genesis's inside their requests (`offspring.ts`, `lives.ts`), with the event's round. Their players are excluded.

       An empty pool writes nothing and flags `authority-only` once for the event.
    4. `worker/duty.ts` (`hub.duties`):
       - when a witness commitment's round resolves (the alarm through `Beacons.alarm`), the order is computed;
       - a running fight's referee is offered at once: `duty` (role referee, its position, the commitment, the beacon, the pond's seed, the fighters, the start and the history), with `duty-peer` to each fighter;
       - auditors wait for `offerAudit`, which T8 calls;
       - an offer goes to the first unused position whose player is still eligible;
       - `duty-no`, 5 s of silence, or the player leaving moves it to the next. Each position serves once, with at most 3 offers per duty, and then the duty ends;
       - `duty-ok` calls `onReferee` or `onAuditor`. Until T5 and T8 fill them, each just ends the duty.
    5. `avail`: at most one counts every 5 s. A session's `avail` is off until it says on.
    6. `strike(player, kind, key)`: sets `struck_until = now + STRIKE_MS`, flags once per kind and key, and sends `duty-end { why: 'struck' }`.
    7. `POND_MAX` in fixture mode: the pond's capacity for new seats.
    8. A restart ends every duty: the memory is gone, and fights rebuild refereed by the authority.
    9. `GET /v1/e2e/witness/<event>` (E2E entry only): `{ commit, order, offers: { position, player, role, outcome }[], struck: string[], attestations }`, where `outcome` is `pending`, `ok`, `no`, `silent` or `failed`, and `struck` lists the order's players struck now.
    10. `worker/witness-test-kit.ts`: eligible sessions with play, avail and IPs, for hub tests.
    11. `.claude/rules/worker.md`, `docs/TESTING.md`.
  - Acceptance (tests first). Workerd hub tests:
    - A seated session with `avail` on, 20 minutes of play, no strike, no duty and under the hourly limit is in the pool. Each of these taken away removes it:
      - `avail` off, or 19 min 59 s of play;
      - a strike, or a duty in progress, or 20 duties in the hour;
      - being a fighter, or sharing a fighter's IP hash.

      A queued session is never in it.
    - 40 eligible sessions give the pool `poolOf` says.
    - A lock with a pool writes one witness commitment (round `witnessRound(t)`, data `{ event: 'enc:<id>', pool }`) after `enc-start` was sent, and nothing else. An empty pool writes none and flags `authority-only` once.
    - A mating and a genesis each write one witness commitment with their own round, without their players.
    - When the round resolves during the fight:
      - position 0 gets the referee `duty`, and both fighters get `duty-peer`;
      - `duty-no` moves it to position 2 (1 is the auditor's), and so does silence for 5 s;
      - after 3 offers the duty ends.
    - A player holds one duty at a time. A struck player never enters a pool, and a `duty-ok` from someone not offered is dropped.
    - Row writes: a lock with a pool adds 1 row, and a mating or a genesis 1 each.
    - `tools/worker-bundle.test.ts`: `WITNESS_PLAY_MS`, `WITNESS_IP_CHECK` and `POND_MAX` are read only in fixture mode.
  - Notes:
    - A witness commitment rides the existing `commitments` table and alarm, so its beacon is stored like any committed round.
    - `worthOf` (T12) shares `playedMs`.
    - `engage.ts` is T11's after this task.

- [ ] T5 The authority hands fights to witnesses and takes them back [opus] (after T3, T4, T9)
  - Steps:
    1. `worker/witness-fight.ts` (called from `fights.ts` and `duty.onReferee`):
       - **the handover**: on the referee's `duty-ok`, `h = referee.next + HANDOVER_AHEAD`. `enc-referee { from: h, by: W }` goes to the fighters and W, the span is written to the row's `referees`, and W hears `enc-frame`s up to `h − 1`.
       - **before `h`**: the authority's referee finalizes every frame before `h`. A fighter's input for a frame from `h` on is dropped as `moved` (counted, never late).
       - **each batch** must:
         - continue the log (`f` = the authority's next; a repeat is ignored);
         - have each frame's width;
         - carry a valid signature on every non-null input (`inputSigned`, keys tabled once per fight).

         The authority steps its encounter, appends the frames to the log (one row per batch, as before), echoes them to the fighters as `enc-frame`, and settles when its own encounter ends.
       - **the watchdog**: the fight's one timer waits for the next batch until `start(next + 10) + BATCH_GRACE_MS`.
       - **failures**: a missed batch (`witness-silent`), a gap, wrong width or bad signature (`witness-forged`), W's socket closing (`witness-silent`), and a dispute whose witness frame is validly signed by W and differs from the committed one (`witness-equivocated`). Each one:
         - takes the fight back from `h' = max(next, due now) + TAKEBACK_AHEAD`;
         - finalizes the frames from `next` to `h' − 1` with the fallback marker, and echoes them;
         - sends `enc-referee { by: 'authority' }`;
         - strikes W (flag once), and sends W `duty-end`;
         - offers the next position, at most 3 referees per fight.
       - **planned take-backs**: a join (in `admit`, before it seats the joiner), everyone away (`away.ts`), and W's own lock. Each sends `enc-referee { from: due + 3, by: 'authority' }`, takes W's final batch, fills a missing tail with the fallback marker, and strikes no one.
       - **disputes**: an equal frame is dropped and counted.
    2. `settle.ts` writes the settlement version 2 (T9's `settlementOf`) with the spans and the duty.
    3. `recover.ts`: a rebuilt fight continues refereed by the authority from the log's end, and its spans gain that take-back.
    4. `worker/witness-test-kit.ts` gains a scripted witness: a test socket that answers duties, signs and batches, and can go silent, forge or equivocate on cue.
    5. `.claude/rules/worker.md`, `docs/TESTING.md`.
  - Acceptance (tests first). Workerd hub tests, on the hand clock:
    - **The handover**:
      - after `duty-ok` both fighters and W get `enc-referee { from: next + 3, by: W }`;
      - the authority finalizes frames to `h − 1` and drops a fighter's input for `h` as `moved`.
    - **A witnessed duel**: W's signed batches drive it to its end, and the settlement (version 2) has spans `[authority@0, W@h position 0]` and the duty. Its hash, root and results equal those of an authority-only run with the same inputs.
    - **Each failure** gives `enc-referee { by: 'authority' }` at `max(next, due) + 2`, the fallback frames between, one flag, `struck_until` a day ahead and `duty-end` to W, and the fight still ends in a settlement whose spans show the take-back:
      - no batch for 1 s past its due frame;
      - one flipped input signature;
      - a gap;
      - width 3 in a duel;
      - W's socket closing;
      - a dispute with W's differing signed frame.
    - A dispute with an equal frame changes nothing.
    - After a failure, position 2 is offered and can referee again. After 3 referees, the authority keeps the fight.
    - **A join** while W referees: the authority takes the fight back at `due + 3`, W's final batch closes the gap, the joiner sits at `h' + 2`, and no one is struck.
    - **Everyone away**: the authority takes back, and plays the rest out as ADR 0053 says.
    - **A restart** while W referees: the fight rebuilds from the log refereed by the authority, and its settlement's spans hold `[authority, W, authority]`.
    - **The cost**: while W referees, the fight's incoming messages at the authority are its batches alone, at most one per 10 frames plus the final one.
    - Every M8 and M9 hub test of fights, recovery, settlement and proofs passes on version 2.
  - Notes:
    - Keep `fights.ts`'s referee loop as it is. The witness phase lives in its own file.
    - A fighter whose player is away sends nothing to W either: its slot is the autopilot's, as before.

- [x] T6 Duty links: across ponds, priority 0, and availability [opus] (after T4) (in progress)
  - Done: `ConnectionPolicy.duty`, `OnlineSession.dutyPeer` (hub `duty-peer`, `duty-end`, `enc-end`; `HubClient.onDuty`), the relay through `linksOf`, `Availability` in `app-duty.ts` and the setting; `m10-avail` (no hub).
  - The game's links don't go through `ConnectionPolicy` yet, so the session itself refuses a duty link past 32. An `on` waits for 5 s of all-right, so a flapping tab sends one `off` and nothing more.
  - Steps:
    1. `PeerMesh` and `ConnectionPolicy`:
       - `duty-peer { on }` opens a link to a peer outside the pond roster (perfect negotiation, the lower id calls). `{ on: false }`, the duty's end or the fight's end closes it, unless the peer is in the pond;
       - duty links are priority 0, never evicted, and may take the policy past its default cap of 24, never past 32;
       - the mesh accepts an offer from outside the pond only from an announced duty peer.
    2. `worker/sessions.ts` `relay`: a signal between W and a fighter passes, across ponds too, only while W holds a referee duty for that fighter's fight (`hub.duties.linksOf`). Otherwise it is `no-peer`, as today.
    3. The client's `avail` (`src/game/app-duty.ts`):
       - on only while all of these hold: the tab visible, the setting on, the player neither locked nor fighting, and the 90th percentile of its frame times over the last 5 s at most 50 ms;
       - off at once when one fails;
       - at most one message every 5 s.
    4. Settings: "Help referee fights" (on by default, stored), with a one-line note: "Lets the game use a little of your connection to referee other players' fights."
    5. `state().witness.avail` and `state().net.dutyLinks` (`docs/TESTING.md`). `.claude/rules/net.md`: duty links.
  - Acceptance (tests first):
    - Unit tests, fake transports:
      - a duty peer outside the roster connects only after its `duty-peer`, holds through a roster eviction pass, and closes on `{ on: false }`;
      - a pond member that was also a duty peer stays open;
      - with 24 pond links and a duty link the policy holds 25, and never more than 32;
      - an unannounced offer from outside the pond is dropped and counted.
    - Hub test: W's signal to a fighter in another pond is relayed while W's referee duty runs, and gets `no-peer` before and after.
    - Unit tests of `avail` on a fake clock:
      - hidden, the setting off, fighting, or a frame-time p90 of 60 ms each turn it off;
      - all of them right turn it on;
      - flapping visibility sends at most one message per 5 s.
  - Notes: TURN credentials are already per session, so a duty link uses the same ICE servers as pond links.

- [ ] T7 The referee duty in the browser, and the fighters' route [opus] (after T5, T6)
  - Steps:
    1. `src/game/app-duty.ts` dispatches `duty`: a referee duty to `app-witness.ts`; an auditor duty to T8's module, answered `duty-no` until T8 lands.
    2. `src/game/app-witness.ts`:
       - **accepting**: check its own selection (`witnessOrder` of the commitment's pool and the beacon gives its id at `position`), else `duty-no`. Open the duty links, and send `duty-ok` once every connected fighter's channels are open;
       - **refereeing**: from `enc-referee` run a `WitnessReferee` on the hub clock (one timer per deadline), sending `wframe`s to the fighters and `batch`es to the hub;
       - **stopping**: at a planned take-back, `stopAt(h')`; on `duty-end` or a failed take-back, at once;
       - **the HUD**: a "Witnessing a fight" chip while on duty (`hud.ts`);
       - **the hook**: `state().witness` (`duty`, `duties`, `batches`, `dutyMs`: each handler's time).
    3. The fighter (`app-encounter.ts`, `app-fight.ts`, `encounter-sync.ts`, through `referee-route.ts`):
       - inputs from `h` on go to W as `finput`, signed;
       - the lead uses the one-way latency to W from `probe`s (every second on the duty link);
       - `wframe`s and the hub's `enc-frame`s both feed `EncounterSync`, and the hub's wins on a difference (a resync, a `dispute`);
       - a planned or failed take-back sends inputs to the hub again;
       - the combat HUD shows a small witness mark while W referees ("Refereed by a witness" on hover, `combat-hud.ts`).

       `state().encounter.referee` (`{ by, from }`), `handovers` and `disputes` (`docs/TESTING.md`).
    4. E2E, every page with `debug.skipDraw(true)`, each hub with `WITNESS_PLAY_MS=0` and `WITNESS_IP_CHECK=off`:
       - `m10-witness.spec.ts` (hub 8822): A, B and C in one pond. A engages B, C gets the referee duty and takes over (`encounter.referee.by` is C from frame `h`), and the fight ends.
         - A's, B's and C's hashes equal `enc-end`'s, and the settlement's spans name C.
         - Around the handover A and B have no resync and roll back at most 2 frames.
         - C's chip showed, and `witness.dutyMs` has a p95 of at most 2 ms.
       - `m10-cross.spec.ts` (hub 8823, `POND_MAX=2`): C is in another pond and referees A and B over a cross-pond link.
       - `m10-takeback.spec.ts` (hub 8824): C's page closes during its duty.
         - The authority takes back within 1.5 s (`enc-referee` by the authority, at most 15 fallback frames).
         - The fight ends on the authority's hash.
         - `GET /v1/e2e/witness/<event>` shows C's offer `failed` and C in `struck`.
  - Acceptance:
    - Unit tests (fakes):
      - the runner sends `duty-ok` only after the channels open, and `duty-no` when its selection doesn't check;
      - it stops on `duty-end`;
      - the fighter's inputs to W carry valid signatures, and a planned take-back moves them back to the hub.
    - `m10-witness`, `m10-cross` and `m10-takeback` each pass 3 times in a row (`--repeat-each=3`).
  - Notes: a page drawing frames over 100 ms in software rendering misses deadlines as referee, as it does as fighter. Every page in these specs skips its draw (`docs/TESTING.md`, M7).

- [ ] T8 Audits and attestations for fights, matings and genesis [opus] (after T5, T9)
  - Steps:
    1. `src/net/audit.ts`, pure, `auditVerdict(case, keys) → { subject, agree, code? }`:
       - a fight: `verifyEncounter` of the log against the settlement (its subject is the settlement's hash);
       - a genesis: `checkGenesis`, the genome text against the record;
       - a mating: `checkBirth` for both births (`birthSubject`).
    2. The page (`src/game/app-audit.ts`, `audit-worker.ts`):
       - an auditor duty checks its own selection, answers `duty-ok`, and runs the verdict in a module worker, never on the frame loop;
       - it signs and sends `attest` within 60 s;
       - `state().witness.audits`.
    3. `worker/attest.ts` (`duty.onAuditor`, `offerAudit`):
       - **when**: a fight's auditor is offered after its settlement; a mating's after both births; a genesis's after its record. An event whose round resolves later is offered then;
       - **intake**: an `attest` must parse, carry the witness's valid signature, name the duty's commitment and the witness's position in its order, and name the authority's own subject. Then it is stored (one row);
       - **disagreement**: an attestation that disagrees is stored as overruled, and its auditor struck (`audit-overruled`);
       - **forgery**: an attestation forged, misplaced or naming another subject is dropped, and its sender struck (`attest-forged`);
       - **silence**: 60 s without one goes to the next position (at most 3);
       - **authority-only**: when the event's duties end with no witness span and no agreeing attestation, `authority-only` is flagged once.
    4. `GET /v1/e2e/witness/<event>` lists the attestations. `.claude/rules/worker.md`, `docs/TESTING.md`.
    5. E2E `m10-audit.spec.ts` (hub 8825, `MATING_SCALE=0.01`, `LIFESPAN_SCALE=0.05`, the witness variables):
       - A and B mate while C is online. C audits the births, and an agreeing attestation is stored.
       - A engages B, and after the end C (or the next position) audits the fight.
  - Acceptance (tests first):
    - Unit tests on `tests/lineage-fixture.ts`:
      - the fight, A0's genesis and the mating give `agree: true`;
      - one frame changed in the log gives `agree: false` with `code` `root`;
      - a beacon byte flipped gives a genesis disagreement, and parents swapped a mating disagreement.
    - Hub tests:
      - an honest attestation is stored, and no flag is raised;
      - a disagreeing one is stored as overruled, its auditor struck and `audit-overruled` flagged;
      - a forged signature, a wrong position or another fight's subject is dropped, and its sender struck;
      - silence for 60 s offers position 2;
      - three silent auditors flag `authority-only` once;
      - the mating's and the genesis's audits arrive after their records.
    - The page: during the audit of a 90 s, 4-fighter log, no frame of the page takes over 100 ms longer than before (`m10-audit`).
    - `m10-audit` passes 3 times in a row.

### Verification and showing it

- [ ] T9 Settlement and bundle version 2, and the witness family [opus] (after T1, T16)
  - Steps:
    1. `src/ledger/settlement.ts`:
       - `SettlementV2` with `referees` and `duty`, and `settlementOf` writing it;
       - `refereesOf`, and span checks: from frame 0 with the authority, strictly increasing, below the frame count, each witness span with a position.

       `checkSettlementSig`, `checkSettledRecords` and `verifyEncounter` (`src/net/encounter-verify.ts`) take both versions, and the enc-end parser (`protocol-encounter.ts`) does too.
    2. `src/ledger/proof.ts`: bundle version 2 with `witnessCommits` and `attestations`, capped. A version 1 bundle parses with both lists empty.
    3. `src/ledger/verify-witness.ts`, the `witness` family. For each held event (every settlement, every genesis and every mating of held creatures), it checks:
       - its witness commitment, if held:
         - the countersignature (the signature family's rules for keys);
         - `witnessDataProblems`;
         - the round not yet published at its `t`, and for a mating or a genesis equal to the event's own round;
         - its beacon in the bundle;
       - the order from the beacon;
       - each referee span's `by` at its position;
       - each attestation's signature, its witness at its position, and its subject equal to the event's;
       - positions used at most once.

       The report adds `witnessed` and `events`.
       - An attestation that disagrees counts as overruled, not as a problem.
       - A commitment not held leaves the selection unchecked.
       - An event with neither a witness span nor an agreeing attestation is authority-only.

       Its codes go in `PROBLEM_TEXT`.
    4. `tests/lineage-fixture.ts` gains the witness documents of an honest authority:
       - A1's fight refereed by witness W from frame 40 and audited by V;
       - the mating audited;
       - A0's genesis audited;
       - B0's genesis authority-only (an empty pool).

       Regenerate `lineage.json`. The records and their history don't change.
    5. `.claude/rules/ledger.md` and `docs/VERIFY.md` (witnesses: what they add and what they don't).
  - Acceptance (tests first):
    - Version 2 settlements round-trip and verify, and version 1 ones still do (the M8 golden settlement).
    - A version 1 bundle parses as version 2 with empty witness lists. Caps hold: 1,025 witness commitments parse to null.
    - The new golden verifies with no problems, with `witnessed` `{ events: 4, refereed: 1, audited: 3, authorityOnly: 1, overruled: 0, unchecked: 0 }`.
    - Each tamper gives its named problem on the right event:
      - a span's `by` replaced by another pool member (re-signed);
      - spans out of order, or not from 0;
      - a witness commitment's countersignature byte;
      - its pool unsorted or 17 long;
      - its round published before its `t`;
      - a mating's witness round not the mating's;
      - an attestation's signature byte, its position, its subject from another fight;
      - one position used twice.
    - A disagreeing attestation (re-signed by its witness) is counted overruled with no problem.
    - Without the witness commitments, there is no problem and every selection is unchecked.
    - `problemText` covers every new code.
    - `speedTest`: the witness family on a 64-creature bundle with 64 fights takes under 1 s in Node.
  - Notes: the honest history stays as M9 built it. This task adds documents beside it, never changes it to make a family pass.

- [ ] T10 Witnesses in bundles, on the card and in the CLI [opus] (after T5, T8, T9, T15)
  - Steps:
    1. `worker/proof.ts`: a bundle (version 2) holds:
       - the witness commitments of its held events that are still kept;
       - every attestation for them.

       Both count toward the caps. Retention: the settlement's prune also deletes up to 4 witness commitments older than 14 days (ADR 0058).
    2. The card (`src/card/card.ts`, `main.ts`):
       - each fight, birth and hatch in the story ends in "· refereed by a witness", "· audited by a witness" or "· checked by the authority alone", and "a witness disagreed; the authority's result stands" when overruled;
       - the details give "Witnesses: 4 of 6 events seen by a witness; 2 checked by the authority alone";
       - `__card.state().witnessed`.
    3. The CLI prints the same counts after the verdict, and `--json` includes them.
    4. `docs/VERIFY.md`, DESIGN §5, `docs/TESTING.md`.
    5. E2E `m10-card.spec.ts` (hub 8826): after a witnessed and audited fight (`m10-steps.ts`), every page closes. A's card verifies, says "refereed by a witness" on that fight, and attaches desktop and 390 px screenshots.
  - Acceptance (tests first):
    - Hub tests:
      - a creature whose fight a witness refereed and audited gets a bundle with its commitment and attestation, which verifies with `refereed: 1, audited: 1`;
      - after 15 days and another settlement, the commitment is pruned and the report says `unchecked`, with no problem.
    - Unit tests: the story suffixes and the details line for witnessed, authority-only and overruled events.
    - The CLI on the golden prints the witnessed line.
    - `m10-card` passes 3 times in a row.

### Anti-farming

- [ ] T11 The movement check at lock-in [opus] (after T4)
  - Steps (ADR 0059):
    1. `src/net/signed-snaps.ts` keeps each peer's last 5 verified signed snapshots. The newest stays what an engage forwards.
    2. The target's `lock-state` carries `seen`: the attacker's held snapshots from the last 2 s.
    3. `worker/engage.ts` `lockAnswer`:
       - verifies each `seen` snapshot as it verifies the target's (signature, pond, the attacker's creature and genome reference);
       - orders them by tick with the attacker's engage snapshot;
       - refuses `engage:moved` and flags `teleport` once per creature when two neighbours are further apart than the bound. The bound is (1.25 × the attacker's top speed at its claimed biomass (`topSpeed`) + its dash speed + the strongest current) × their time apart, plus 8 wu.

       The target is released, and an answer without `seen` keeps today's path.
    4. The client's toast for `engage:moved`: "Moved too fast to attack". DESIGN §7.
  - Acceptance (tests first):
    - **No false alarms**: 1,000 seeded honest paths never trip the bound, through the sim's own physics: full throttle, a dash at every cooldown, the strongest currents, soft walls, at 100 and 5,000 biomass.
    - **Jumps trip it**:
      - a 200 wu jump between two seen snapshots 200 ms apart is refused `engage:moved`, and `teleport` is flagged once however often it repeats;
      - an engage snapshot 150 wu from the newest seen one 100 ms before it is refused too.
    - A forged `seen` snapshot (bad signature) is ignored, not believed. A `seen` of another creature is ignored.
    - Without `seen`, every M7 engage test passes unchanged.

- [ ] T12 Young identities by play (after T4)
  - Steps:
    1. `worthOf` (`worker/farming.ts`) halves the worth while `playedMs` is under `RULES.encounter.farming.youngPlayMs` (20 min). This replaces `youngMs`.
    2. `fight-test-kit.ts` `hatched()` credits each test identity 20 minutes of play, so fights run at worth 1 unless a test says otherwise.
    3. DESIGN §7 (kill farming) and §11.
  - Acceptance (tests first). Hub tests:
    - An identity with 19 min 59 s of play is worth half, and one with 20 minutes is worth 1.
    - An identity first seen two hours ago that never played is worth half.
    - The killed-count halvings stack as before (`farming.test.ts`).
  - Notes: the worth is the authority's input in `enc-start`, so no rules version changes and the tournament still runs at worth 1.

- [ ] T13 The bot-farm simulation (after T12)
  - Steps (ADR 0059):
    1. `tools/farm-sim.ts`: the strategies and the report.
       - **The honest pair** forages at the pacing bot's measured growth (`tools/pacing-report.ts`), mates as soon as it may and promotes each child.
       - **The farmer** with N bots (1, 4, 16):
         - the bots report the most growth the authority accepts, hatch as the bucket allows, and mate with the farmer's creature in turn, so that a pair repeats as rarely as N allows;
         - they are killed by it in fights through the authority's referee;
         - they set `avail` once they have played 20 minutes.
    2. `worker/farm.test.ts` (`heavyTest`) runs each scenario on one hub on the hand clock, for 3 hours of play under the live scales, with the fixture beacons. It prints `FARM_MEASURE` lines.
    3. `tools/farm.mjs` (`npm run report:farm`) runs it and writes `docs/perf/farm.md`, rounded so that a rerun gives the same file.
    4. `docs/TESTING.md`.
  - Acceptance (the gates of ADR 0059, asserted by the test):
    1. For every N, the farmer reaches generation 3 no more than 30 s (one report) before the honest pair, and no sooner than 3 × 7 minutes after its first hatch.
    2. Every farmer creature has at most 60 ÷ 9 children per hour of its active time.
    3. The farmer's biomass from kills and carrion is at most what its victims held. Per bot identity and 24 h the kills are worth at most 2 full kills.
    4. A kill of a bot identity with under 20 minutes of play rewards at most half.
    5. Over 200 events (the fixture's rounds, the real `witnessOrder`), a farm of N eligible bots among H = 8 honest witnesses takes a duty at most `N ÷ (N + H) + 0.1` of the time, and no bot is offered one before 20 minutes of play.

    The report also gives, without a gate, the time to the farmer's maximum size and the rare finds per hour against N. `npm run report:farm` reproduces `docs/perf/farm.md`.
  - Notes:
    - Bots are test clients on a test hub and never join the live world (the brief's testing rule).
    - Drand time moves only when a commitment needs its round (`publish` in `worker/test-hub.ts`), and commitments made together share one, so the 600 recorded rounds suffice for 3 hours of hub time.
    - If a gate fails, the PR names the shortcut and fixes the rule that let it through, with an ADR. It never relaxes the gate.

- [ ] T14 The cost check: messages, CPU and storage of witnessed fights (after T5)
  - Steps (ADR 0058):
    1. `worker/witness-cost.test.ts`, on the hand clock with the scripted witness:
       - a 30 s duel refereed by the authority alone;
       - the same duel with the witness's `duty-ok` 3 s after the lock, counting its 4 signal relays and the auditor's 2 messages.

       It counts the authority's incoming messages per encounter and per participant-second of the witness's span. It prints `WITNESS_MEASURE` lines, including the CPU of the signature checks per batch.
    2. `tools/witness-report.ts` and `tools/witness.mjs` (`npm run report:witness`) write `docs/perf/witness.md`: the cut at duel lengths 6, 10.4, 17.2, 30 and 90 s and a 30 s melee of 4, for handover delays of 2, 3 and 4 s.
    3. `tools/storage-report.ts` adds a witness commitment and an attestation to the per-fight table of `docs/perf/storage.md`, and to the 200-player steady state.
  - Acceptance (tests first):
    - The 30 s duel costs the authority at least 4× fewer incoming messages with the witness than without.
    - Once the witness referees, the fight costs at least 10× fewer per participant-second.
    - A batch's signature checks (20 in a duel) take under 10 ms in workerd.
    - At 200 players, the steady state of logs and witness commitments stays under 1 GB.
    - Both reports reproduce.

### Carry-overs

- [x] T15 M9 carry-overs in the worker: bundle caps, the cache of a dead creature, the renewal notice (after none)
  - Done: `Growth` in `worker/proof.ts` keeps sizes per added creature (one `assemble`), a subject past the caps is `413 too-big` (card text, CLI exit 2), a dead creature's bundle keeps `max-age=600`, and `sendLife` marks the renewal told only after `life` went out (`renewalDue`, `markRenewalTold`).
  - Gotcha: the real-cap 413 test writes 4,096 checkpoints (about 2.5 s), so it is tagged `heavy`.
  - Steps:
    1. `worker/proof.ts`:
       - `buildBundle` grows its bundle incrementally, keeping its byte and record counts as it adds each ancestor, instead of calling `assemble` per candidate;
       - a subject whose own bundle already passes `PROOF_MAX_BYTES` or 4,096 records answers `413 { error: 'too-big' }`, counted;
       - the card's error line reads "This creature's history is too long to check here", and the CLI exits 2.
    2. `worker/index.ts`: a dead creature's bundle is cached `max-age=600`, since its flags and, from M10, its attestations can still arrive. A settled fight's proof keeps a day.
    3. `sendLife` (`worker/lives.ts`) takes the renewal notice only once `life` was sent on an open socket, as M9 T9 did for the away report.
  - Acceptance (tests first). Workerd hub tests:
    - A subject with a chain past the caps (inserted through the ledger's methods) gets `413 too-big`, never a bundle that `parseProofBundle` refuses.
    - Every M9 bundle test passes, and on a 64-creature pedigree `assemble` runs once (a counter).
    - A dead creature's bundle carries `max-age=600`.
    - A socket that closed before its `life` keeps the renewal notice, and the next sign-in hears it once.

- [x] T16 M9 carry-overs in the verifier and the card [opus] (after none)
  - Done: the card talks to its worker through `VerifierLink` and `checkInWorker` (`src/card/verifier.ts`), which reject on `error` even before a question, so `start()` ends `unchecked`; the gates hold every frozen record to the frozen state (kept until the restore) and a death to the lifespan; `BundleIndex.settlements` lists every copy.
  - Gotcha: the M9 `after-lifespan` checkpoint test moves A1's death with it, so it now names both records.
  - Steps:
    1. The card's verifier worker: on `error`, settle the pending reply (reject it), so `start()` finishes with `unchecked` (`src/card/main.ts`).
    2. `verify-gates.ts`:
       - a `death` whose `activeMs` passes the lifespan is `after-lifespan` too;
       - every record of a frozen creature until its restore keeps its condition, clock and cooldown (`frozen-changed`), not only a death.
    3. `verify.ts`: the index keeps every settlement. Two with the same `enc` are a problem (`settlement-duplicate`), and each copy is checked.
  - Acceptance (tests first):
    - On the M9 golden (re-signed tampers):
      - a death 1 ms past the lifespan gives `after-lifespan`;
      - a checkpoint of A0 while frozen with a changed biomass gives `frozen-changed`;
      - a second settlement for the fight (results changed, re-signed) gives `settlement-duplicate`, and a corrupted earlier copy is caught.
    - The honest golden and M9's property test (`worker/audit-property.test.ts`) still give no problems.
    - The card's worker failing to load ends in the `unchecked` error with `start()` resolved (a unit test with a fake worker).

### Closing

- [ ] T17 End-to-end scenario, documentation sync
  - Steps:
    1. `m10-lifecycle.spec.ts` (`@slow`, hub 8827, `MATING_SCALE=0.01`, `LIFESPAN_SCALE=0.05`, the witness variables, `?quality=medium`), with four players A, B, C and D, in order:
       - A and B hatch and mate, and C or D audits the births;
       - A's child engages B's child, a witness among C and D referees from its handover, the other audits, and the fight ends with every hash equal to `enc-end`'s;
       - a second fight, whose witness's page closes mid-duty: the authority takes back, and the fight still settles;
       - every page closes;
       - each player's creature card verifies, with its fights marked "refereed by a witness" and its births "audited by a witness";
       - `npm run verify:lineage -- <id> --hub <local> --replay` exits 0 and prints the witnessed line;
       - `GET /v1/audit` shows no `teleport` flag: honest play never meets the movement check.

       A fight can end before a step needs it, so the scenario engages again, at most 3 times.
    2. Sync:
       - DESIGN §5, §7, §8, §11 and the glossary (drop the M10 marks for what shipped);
       - `docs/VERIFY.md`;
       - `docs/TESTING.md` (the hooks, and hubs 8822–8827; the next file takes 8828);
       - `.claude/rules/{ledger,net,worker}.md`.
    3. List the owner checks for the Playtest issue (the rubric's `(owner)` lines).
  - Acceptance:
    - Every exit criterion maps to a named test or report (the table below).
    - Each PR E2E part stays under 5 minutes, and the long scenarios are `@slow`.

## Exit criteria → evidence

| Exit criterion (ROADMAP) | Tasks | Evidence |
|---|---|---|
| drand-selected witnesses with no rerolls | T1, T4 | `witnessOrder` tests (one order per commitment, uniform); one commitment per event, resubmitted unchanged; offers in order, each position once, at most 3 (hub tests); T9's `witness-order` tamper; T13 gate 5 |
| Witness referees with authority fallback | T3, T5, T6, T7 | the harness's handover runs; T5's failure and planned take-back hub tests; `m10-witness`, `m10-cross`, `m10-takeback`, `m10-lifecycle` |
| Authority-only settlements flagged | T4, T5, T8, T9, T10 | settlement spans; the `authority-only` flag; the verifier's `witnessed`; the card's lines (`m10-card`, unit tests) |
| Signed inputs | T1, T2, T3, T5, T7 | `inputSigned` tests; a flipped input signature takes the fight back (T5); `m10-witness` inputs to C verify |
| Bot-farm simulation shows no shortcut | T11, T12, T13 | `docs/perf/farm.md` and its five gates; T11's honest-path property test and jump refusals; T12's worth by play |
| Outline: pool, commitment and selection from a future round (T1, T4); a shared referee with handover both ways (T3, T5); duty within the connection budget, attestations and disagreements (T6, T5, T8); authority-only fallback (T5, T8, T9, T10); mating and genesis audits (T8); signed inputs (T1, T5, T7); remaining anti-farming and `tools/farm-sim.ts` (T11, T12, T13); the cost check (T14); the M9 carry-overs (T15, T16) | T1–T16 | as listed in each task |

## End-to-end check

`m10-lifecycle.spec.ts` (T17, `@slow`, hub 8827) plays four players through a mating, a witnessed fight and a fight whose witness fails. Then every page closes, and anyone can check it:
- every fight ends on the authority's hash on every page that played it;
- the settlement of the witnessed fight names its witness from the handover, and the other names the take-back;
- the cards verify and say which events a witness saw;
- the CLI agrees.

Each path is also checked alone:
- `m10-witness` (T7): the handover in one pond;
- `m10-cross` (T7): a witness in another pond;
- `m10-takeback` (T7): a witness that vanishes;
- `m10-audit` (T8): audits of births and a fight;
- `m10-card` (T10): the card's witness lines.

## Rubric

- [ ] A witnessed fight plays like one the authority referees: with one-way ≤ 150 ms to the witness and clock errors ≤ 20 ms, at least 95% of inputs are on time, and every client ends on the referee's hash (evidence: the witness rows of `docs/perf/netcode.md`, T3).
- [ ] The handover can't be seen: no resync, and rollbacks of at most 2 frames around it (evidence: `m10-witness`'s recorded `rollbacks` and `resyncs`).
- [ ] A witness that vanishes costs at most 1.5 s of autopilot (evidence: `m10-takeback`, at most 15 fallback frames).
- [ ] Witness duty doesn't touch the witness's own game: a duty handler's p95 is at most 2 ms, and an audit never blocks a frame (evidence: `witness.dutyMs` in `m10-witness`, `m10-audit`'s frame times).
- [ ] "Checked by the authority alone" is never hidden: every fight, birth and hatch on a card says witnessed or authority alone (evidence: `m10-card`'s screenshots, T10's unit tests).
- [ ] A 30 s duel costs the authority at least 4× fewer incoming messages, and a witnessed fight-second at least 10× fewer (evidence: `docs/perf/witness.md`, `worker/witness-cost.test.ts`).
- [ ] A farm of 16 bots gets no faster generations, no extra children per creature, no biomass from nothing and no more than its share of duties (evidence: `docs/perf/farm.md`).
- [ ] An honest player never meets the movement check (evidence: T11's 1,000 honest paths; no `teleport` flag in any E2E run's `GET /v1/audit`).
- [ ] (owner) A fight with a witness, played with friends over real networks, feels the same as one without.
- [ ] (owner) Witness duty goes unnoticed on your machine: no stutter, and nothing in your connection.

## Risks

- **A witness on a slow machine** misses deadlines and makes the fighters' inputs late.
  - `avail` needs a healthy frame time.
  - A missed batch takes the fight back within about 1 s.
  - The net report's witness rows hold the timing.
  - If players still feel it, a later ADR raises the frame-time bar or the batch grace.
- **Handover desyncs**: inputs on the move between referees, and frames from two sources.
  - Inputs from `h` on are sent again to the new referee.
  - The authority's frames always win.
  - The harness proves the same hash across handovers, and the E2E specs measure rollbacks.
- **Cross-pond links fail** behind NATs. A duty link that doesn't open leaves the duty unanswered, and the next position is offered after 5 s. The fight is the authority's meanwhile. `m10-cross` covers the local path, and the owner's playtest the real one.
- **The authority's CPU for signature checks.** At most 40 checks a second per witnessed fight, against tabled keys. T14 measures it, and M13 may sample checks (with a new ADR) if the numbers demand it.
- **Storage**: about 1 KB of pool per event for 14 days, and 300 B per attestation for good. T14 extends the storage report, and the 1 GB steady-state bound holds.
- **Sybil witnesses**: selection is proportional to identities.
  - 20 minutes of play per identity, the IP check, one duty at a time, 20 an hour and strikes add friction.
  - T13 measures the share.
  - ADR 0058 and `docs/VERIFY.md` state the limit.
- **Determinism across engines**: an auditor in another browser that disagrees is struck, though it may be honest.
  - `audit-overruled` counts at `GET /v1/audit` show it.
  - A rising count is a determinism bug to fix before M14's cross-engine goldens.
- **Fixture rounds**: the recorded rounds cover 30 minutes from each E2E hub's start, and witness commitments use the next rounds. Each hub file stays well within that, as today.
- **Merge conflicts between parallel tasks.**
  - The shapes above are fixed here, and migration 10 is all T4's.
  - `engage.ts` is T4's, then T11's.
  - The witness phase has its own worker file (T5).
  - The scripted witness lives in `witness-test-kit.ts` (T4, T5), so `fight-test-kit.ts` is T12's alone.
  - The client's `duty` dispatch (`app-duty.ts`, T6) is touched by T7 and T8: a small merge, by the task that lands second.
- **Large tasks** (T4, T5, T7, T9) may overrun one session. Every run pushes its work in progress (ADR 0042), and a task that fails across three runs is split (the `next` skill).
