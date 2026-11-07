# M11: Area of interest and size tiers

Release: v0.12.0 · Gate: no

## Goal

The ponds are gone. Everyone swims in one continuous world, and each browser connects only to the creatures that matter to it, never more than 32.

- **One world.** It is 262,144 wu square (2^18), with one seed, one clock and its centre at (131,072, 131,072).
  - Depth, food, plumes and currents stay pure functions of the seed and a position, with bounded caches.
  - The renderer draws the far corner as crisply as the centre.
  - The world is renewed at this release (epoch 4, rules 12, protocol 11): identities stay, creatures start again.
- **A directory, not a roster.** The authority keeps a quadtree of who is where: a leaf splits above 16 members and merges below 6. A client reports its position:
  - when it leaves its leaf or changes tier;
  - otherwise every 30 s.

  Each report is answered with the creatures near it whose size tier it can meet.
- **Links by area of interest.** A client holds five classes of link:
  - P0: its fight and its witness duties;
  - P1: every creature that can interact with it (±1 tier, within 8 × the larger radius plus a 600 wu lead);
  - P2: the rest of its area of interest (AoI);
  - P3: boundary neighbours just outside it;
  - P4: handoffs ahead.

  P0 and P1 are never dropped and may reach 32. The rest fill the room under 24, nearest first. In a sparse world everyone linkable within 8,192 wu is linked, so friends play together as they did in a pond.
- **Discovery and signaling mostly peer to peer.**
  - Linked peers gossip their neighbours.
  - A new link's offer travels through a peer both sides already hold, signed by its sender so the relay can't pose as it.
  - The hub relays only when no peer can.
  - A seat ticket signed by the authority proves each peer's seat and name.
- **No hidden threats.**
  - Every creature that can interact with you is linked, so it is on your screen, while the cap allows. A headless harness checks this, the cap and the handoffs as property tests.
  - Past the cap, the authority still refuses a lock-in by an attacker the target's screen has not shown (`engage:unseen`).
- **Tiers.**
  - Creatures two or more tiers apart never link. A giant sees the small players around it as faint swarms drawn from the directory.
  - Each tier has its own food, 4× wider and 64× richer per tier.
  - The look scales with the view, so a giant's screen reads like a starter's.
  - Snapshot rates fall with distance.
- **Seamless handoffs.** Crossing leaves, growing into a tier, or swimming across the world never makes a creature on screen pop. Newcomers are linked before they come into view.

The decisions behind this milestone:
- ADR 0013 is the contract.
- ADR 0061 covers the world's size and fields, food by tier and the renewal.
- ADR 0062 covers the directory, the link classes and the cap, discovery, relayed signaling, seat tickets, snapshot rates, `engage:unseen`, swarms and the budgets.

`docs/DESIGN.md` §2, §5, §7, §8 and §9 hold the values, marked M11.

This milestone has **no gate**. v0.12.0 opens its `Playtest:` issue, and M12 starts without waiting. **The world is renewed** at this release. The release notes and the Playtest issue say so.

## Carried over

No owner input came: Playtests v0.10.0 (#379) and v0.11.0 (#418) have no replies. M10's close review handed these edge cases to M11. None breaks an exit criterion:

| Gap | Task |
|---|---|
| `engage` takes a witness's fight back (`witnessLocked`) when the lock-ask is sent, so a refused or timed-out lock still costs the fight its witness (`worker/engage.ts`) | T3 |
| A `dispute` that arrives after the fight settled is dropped, so an equivocating witness isn't struck (`witnessDispute`) | T3 |
| `commitWitnesses` doesn't flag `authority-only` when `commitPool` throws (a round already due) | T3 |
| `Duties.offer` calls `eligible()` once per order position, and `playedOf` scans every session for one player | T3 |
| `OnlineSession.dutyPeer` has its own cap check while `ConnectionPolicy.duty` has no runtime caller | T13 |

## Out of scope

- **M12:**
  - bounded instances for a crowded leaf (M11 flags `crowded` and keeps the nearest);
  - spawn rings around groups, scoring and anti-camping (M11 keeps the hub's ring around the world centre);
  - "ride the current", regrouping, and transition integrity across instances and regroups.
- **M13:** the load simulation at 10,000 players, metering, `docs/CAPACITY.md`, the admission queue's measured wait, and any sharding of the authority.
- Small creatures seeing giants two or more tiers up: no shadows or silhouettes.
- Chat beyond the linked peers, a world-wide player list, and a world map of everyone.
- Positions kept across reloads: a resume spawns on the ring, as today.
- ICE restricted to TURN to hide IP addresses from neighbours.
- New genes, combat rule changes, and look passes beyond scaling the look with the view.

## Touches

- **New:**
  - sim: `src/sim/size.ts` gains `linkTiers` and `viewHalfHeight` (T1);
  - ledger: `src/ledger/seat-doc.ts` (the shapes and the parser, T2) and `src/ledger/seat.ts` (signing and the checks, T7);
  - net:
    - `src/net/protocol-world.ts`: the new messages' parsers (T2);
    - `src/net/aoi.ts`: the link classes (T8);
    - `src/net/where.ts`: when to report (T8);
    - `src/net/gossip.ts` and `src/net/signal-route.ts` (T9);
  - worker:
    - `worker/directory.ts`: the quadtree, pure (T6);
    - `worker/where.ts`: its handlers (T6);
    - `worker/seat.ts`: tickets (T7);
  - render: `src/render/depth-window.ts` (T11), and swarms in `src/render/swarms.ts` (T17);
  - game: `src/game/online-links.ts` and `src/game/neighbours.ts`, split from `online.ts` (T13);
  - tests and tools:
    - `tests/aoi-harness.ts` and `tests/aoi-harness.test.ts` (`heavyTest`);
    - `tools/aoi-report.ts` and `tools/aoi.mjs` (`npm run report:aoi`, which writes `docs/perf/aoi.md`) (T10);
  - E2E: `tests/e2e/m11-*.spec.ts`: `m11-world` with no hub, the others on hubs 8828–8832.
- **Changed:**
  - sim: `rules.ts` (rules 12, the world, bathymetry, food layers), `bathymetry.ts`, `food.ts`, `hazards.ts`, `spawn.ts`, `world.ts` and the goldens;
  - ledger: `registry.ts`, `snapshot-sig.ts`;
  - net: `protocol-defs.ts` (protocol 11, snapshot version 5), `protocol-parse.ts`, `peer-mesh.ts`, `connection-policy.ts`, `pond-sync.ts`, `proxy-snaps.ts`, `claims.ts`, `hub-client.ts`;
  - worker:
    - `schema.ts` (migration 11), `authority.ts`, `sessions.ts`;
    - `engage.ts`, `witness-fight.ts`, `witness-pool.ts`, `duty.ts`, `settle.ts`, `offspring.ts`, `lives.ts`;
    - `e2e-entry.ts`, `fight-test-kit.ts`, `tools/worker-bundle.test.ts`;
  - render: `zones.ts`, `scene.ts`, `water.ts`, `camera.ts`, `food.ts` and the shaders' world uniforms;
  - game: `online.ts`, `app-online.ts`, `app-session.ts`, `app-render.ts`, `app-duty.ts`, `minimap.ts`, `pond-map.ts`, `map-relief.ts`, `alone-hint.ts`, `social-ui.ts`, `debug.ts`, `app-hook.ts`, `index.html` (the renewal line);
  - tools: `tools/pacing-report.ts` (tier rows);
  - docs: DESIGN §2, §3, §5, §7, §8, §9, §10, §12; `docs/TESTING.md`, `docs/VERIFY.md`; `.claude/rules/{sim,net,worker,ledger}.md`.

`worker/ledger.ts` is at 989 lines, and no task grows it. `src/game/online.ts` (393) is T13's, which splits it. Each new file stays under about 600 lines.

**Shared shapes.** Tasks that run in parallel build to these. A later task maps between them rather than redefining them.

```ts
// src/sim/size.ts (T1)
export const TIER_LINK_MARGIN = 1.1;
export function linkTiers(ra: number, rb: number): boolean;
//   sizeTier((larger ÷ 1.1)²) − sizeTier((smaller × 1.1)²) ≤ 1: a superset of "tiers within ±1"
export function viewHalfHeight(r: number, adultR: number): number;   // 9 · R^0.9 · (min(r, R) ÷ R)^0.6 (ADR 0029)

// src/net/protocol-defs.ts (T2): PROTOCOL_VERSION 11
export const SNAPSHOT_BYTES = 29;          // version 5: x and y as u32 in 0.125 wu steps (0 to 2^29 wu); the rest as version 4
export const SNAPSHOT_VERSION = 5;
export const SIGNED_FRAME_BYTES = 93;      // the snapshot, then its signature
export const PROXY_FRAME_BYTES = 61;       // the away player's key, then its snapshot
export const NEAR_MAX = 48;                // peers in one `near`
export const SWARM_MAX = 64;               // swarm points in one `near`
export const NEAR_MAX_BYTES = 8192;
export const GOSSIP_MAX = 16;              // entries in one `peers` event
export const RELAY_MAX_BYTES = 10_240;     // a `relay` peer event; every other peer event stays within EVENT_MAX_BYTES
export interface WorldInfo { id: string; seed: string; epoch: number; centre: Vec2; size: number }   // replaces PondInfo
export interface Leaf { x: number; y: number; size: number }              // the square's lower corner and side, wu
export interface NearPeer { id: string; name: string; x: number; y: number; r: number; age: number }  // age: ms since its report
export type Pos = [x: number, y: number, r: number];
// ClientMsg gains:
//   { t: 'where'; x: number; y: number; r: number; aoi: number }   // centre and radius (wu), the sender's AoI radius (wu)
//      0 ≤ x, y < 2^29; 1 ≤ r ≤ 4096; 1 ≤ aoi ≤ 40_000
//   { t: 'gone' }                                                   // no creature in the water (title, death screen, hidden tab)
// HubMsg changes and gains:
//   welcome: `pond: PondInfo` becomes `world: WorldInfo`, and gains `ticket?: SignedSeat` (T7 always sends one);
//            `members`, and the `member` message, stay until T14 removes them
//   signal (hub to client) gains `at?: Pos`: the sender's directory position, stamped by the hub (T6)
//   { t: 'near'; leaf: Leaf; peers: NearPeer[]; swarm: [x: number, y: number][] }   // the answer to every `where`
//   { t: 'leaf'; leaf: Leaf }                                       // a split or merge moved the session's leaf
//   { t: 'seat'; ticket: SignedSeat }                               // a fresh ticket
// PeerEvent gains:
//   { t: 'hello'; ticket: SignedSeat }                              // the first event on every link, each way
//   { t: 'peers'; list: [id: string, x: number, y: number, r: number][] }    // gossip, ≤ GOSSIP_MAX, distinct ids
//   { t: 'relay'; from: string; to: string; kind: 'offer' | 'answer'; sdp: string; at: number; pos: Pos; sig: string }
//   { t: 'rate'; hz: 1 | 2 | 5 | 10 }                               // the snapshot rate this side wants from the other
//   claim and consumed slot ids may carry a food layer: `t<1–4>c<x>_<y>_s<slot>` (T5 builds the layers)

// src/ledger/seat-doc.ts (T2: the shapes and the parser); src/ledger/seat.ts (T7: re-exports it, signing and checking)
export interface Seat { v: 1; kind: 'seat'; player: string; name: string; world: string; t: number; until: number }
export interface SignedSeat { seat: Seat; authSig: string; keyId: string }
export const SEAT_TTL_MS = 900_000;        // until = t + 15 min
export const SEAT_RENEW_MS = 600_000;      // a fresh ticket after the first pong 10 min past the last
export function parseSignedSeat(v: unknown): SignedSeat | null;     // untrusted: never throws, refuses unknown fields
// T7:
export function seatValid(s: SignedSeat, keys: readonly PubKey[], want: { world: string; player: string; now: number }): boolean;
export function signalBytes(from: string, to: string, kind: 'offer' | 'answer', at: number, pos: Pos, sdp: string): Uint8Array;
//   'bs/signal/v1' ‖ from (32 bytes) ‖ to (32) ‖ kind (1) ‖ u64 at ‖ 3 × f64 pos ‖ SHA-256(sdp)
export function signSignal(identity: Identity, to: string, kind: 'offer' | 'answer', at: number, pos: Pos, sdp: string): string;
export function signalSigned(m: Extract<PeerEvent, { t: 'relay' }>): boolean;

// worker/directory.ts (T6): pure, no Hub, so the harness runs it in Node
export const LEAF_MAX = 16;            // a leaf splits above this many; fixture mode: env LEAF_MAX (1–16)
export const LEAF_MIN = 6;             // four sibling leaves merge below this many together
export const LEAF_MIN_SIZE = 1024;
export const NEAR_FLOOR_WU = 8192;     // a report's query radius Q = max(NEAR_FLOOR_WU, 4 × aoi)
export const RELAY_SLACK_WU = 4096;    // the hub relays within max(Q_a, Q_b) + this
export const COURT_NEAR_WU = 12_288;
export const CARRION_NOTICE_WU = 10_000;
export const WHERE_SPEED_WU = 300;     // a report further than this × the seconds since the last, plus WHERE_JUMP_WU, is a jump
export const WHERE_JUMP_WU = 2000;
export interface DirMember { id: string; name: string; x: number; y: number; r: number; aoi: number; t: number }
export class Directory {
  constructor(size: number, opts?: { leafMax?: number });
  report(m: DirMember): { leaf: Leaf; moved: { id: string; leaf: Leaf }[] };   // moved: others a split or merge re-leafed
  remove(id: string): { id: string; leaf: Leaf }[];
  near(id: string, now: number, keep?: (other: string) => boolean):       // keep: the hub's pond filter until T14
    { leaf: Leaf; peers: NearPeer[]; swarm: [number, number][] } | null;
  member(id: string): DirMember | null;
  distance(a: string, b: string): number | null;
  around(x: number, y: number, radius: number): string[];
  leaves(): { leaf: Leaf; members: number }[];
}

// src/net/aoi.ts (T8): pure
export type LinkClass = 0 | 1 | 2 | 3 | 4;   // P0 fight and duty, P1 interactable, P2 AoI, P3 boundary, P4 handoff
export const AOI_PER_HALF_HEIGHT = 2.65;     // 1.3 × the half-diagonal of a 16:9 view
export const INTERACT_RADII = 8;             // the engage candidates' `CANDIDATE_RADII`
export const INTERACT_LEAD_WU = 600;
export const INTERACT_HOLD_WU = 900;
export const UNWANTED_GRACE_MS = 3000;
export const AHEAD_S = 3;
export function aoiRadius(r: number, adultR: number): number;      // AOI_PER_HALF_HEIGHT × viewHalfHeight
export function queryRadius(aoi: number): number;                  // max(8192, 4 × aoi)
export interface Known { id: string; x: number; y: number; r: number; at: number;
  source: 'snapshot' | 'gossip' | 'directory' | 'signal' }
export interface AoiSelf { x: number; y: number; vx: number; vy: number; r: number; adultR: number }
export class AoiManager {
  constructor(opts: { selfId: string; cap?: number });
  classify(self: AoiSelf, known: Iterable<Known>, p0: ReadonlySet<string>,
    prev: ReadonlyMap<string, LinkClass>): Map<string, LinkClass>;
  plan(classes: ReadonlyMap<string, LinkClass>, held: ReadonlySet<string>, now: number):
    { connect: string[]; evict: string[]; crowded: boolean };
}
// src/net/connection-policy.ts (T8): `Priority` becomes `LinkClass`; P0 and P1 up to MAX_CAP, P2–P4 only below DEFAULT_CAP.
// src/net/where.ts (T8)
export const WHERE_EVERY_MS = 30_000;
export const WHERE_MIN_GAP_MS = 2000;
export const LEAF_SLACK_WU = 64;
export class WhereReporter {
  update(s: { inWater: boolean; x: number; y: number; r: number; aoi: number; now: number }, leaf: Leaf | null): ClientMsg | null;
}

// src/net/gossip.ts and src/net/signal-route.ts (T9)
export const GOSSIP_EVERY_MS = 4000;
export const GOSSIP_TTL_MS = 10_000;
export const RELAY_PER_S = 4;
export const RELAY_SKEW_MS = 30_000;
export const RELAY_REPLAY_MS = 120_000;
export const RELAY_ANSWER_MS = 4000;
export const HELLO_MS = 5000;
```

**Migration 11** (T1, all of M11's schema at once): the renewal in the manner of migrations 6 and 8, and `world` gains `seed` and `clock` (the world's tick epoch, ms).

**Fixture-mode variables** (honoured only with `DRAND_SOURCE=fixture`, guarded by `tools/worker-bundle.test.ts`):
- `LEAF_MAX` (1–16, T6), so three E2E pages make leaves;
- a `where` jump is taken in fixture mode (T6), for debug teleports;
- `POND_MAX` keeps working until T14 removes it.

**Hubs**: `m11-handoff` 8828, `m11-cap` 8829, `m11-relay` 8830, `m11-tiers` 8831, `m11-lifecycle` 8832, all `@slow`; the next hub file takes 8833. `m11-world` needs no hub.

## Tasks

T1, T2 and T3 need nothing and can start at once. T4 follows T1, and T5 and T11 follow T4. T6 and T8 follow T1 and T2; T7 follows T2. T9 follows T7 and T8, and T10 follows T6, T8 and T9. T12 needs T5 and T11. T13 needs T6, T9 and T12. T14, T15 and T16 follow T13, and T17 and T18 follow T14. T19 closes.

### Versions

- [x] T1 The world renewal: rules 12, epoch 4, one world's seed and clock (after none)
  - Done: rules 12, migration 11 (world `seed`/`clock`, ponds deleted), `linkTiers`/`viewHalfHeight` in `src/sim/size.ts`. Gotchas: `**` is banned in `src/sim` (so `viewHalfHeight` uses the sim's `pow`); the lineage fixture's `TUNE` was retuned (A nonce `A8`) because the fight's outcome moves with the rules version; hub tests that move the clock set `world.clock` themselves.
  - Steps:
    1. `RULES_VERSION` 12. `src/ledger/registry.ts`: `FIRST_LIVE_RULES` 12 and one entry `{ rules: 12, epoch: 4, since: every part 12 }`. Regenerate the goldens that record the version; never edit one by hand.
    2. Migration 11 (`worker/schema.ts`), a function of `(sql, now)` as migration 8 is:
       - delete every creature, record, commitment, mating, genesis-log entry, fight log, away report and pond row;
       - refill every hatch bucket;
       - set `world` to epoch 4 with `reset_at` now, and fill its new columns `seed` (a fresh 12-character token) and `clock` (now);
       - keep players, keys, names, flags, beacons, attestations and the usage meter.
    3. `place()` (`worker/sessions.ts`): a new pond row takes the world's seed, clock and centre (`RULES.world.size / 2` on both axes). Until T14 the ponds are roster groups of one world.
    4. The notice: an identity whose `epoch_seen` is below 4 is told once, "The world was renewed in v0.12.0. Your identity is kept; your creatures start again." (`index.html`, and the line in `m6c-reset` and `m6c-lifecycle`).
    5. `src/sim/size.ts`: `linkTiers` and `viewHalfHeight` (shapes above); `src/render/camera.ts` uses `viewHalfHeight`.
    6. DESIGN §5 ("World renewal"); `.claude/rules/worker.md` (migration 11).
  - Acceptance (tests first):
    - `renewal.test.ts` covers migration 11 (`migrate(sql, 10)` first):
      - after it, no creature, record, commitment, mating, fight row, away report or pond is left, and every bucket is full;
      - `world` holds epoch 4, a seed and a clock;
      - players, keys, flags, beacons and attestations are kept.
    - Hub test: three sessions in two ponds (fixture `POND_MAX=2`) get welcomes with the same seed and epoch.
    - A returning identity gets `renewed: true` in its first `life` and never again. A new identity never gets it.
    - `checkGenesis` answers `rules-retired` for a rules 11 record, takes rules 12, and answers `rules-unknown` for 13.
    - `linkTiers`:
      - (20, 100) and (100, 20) are true; (20, 200) is false;
      - (30, 135) is true, tiers 0 and 2 read through the margin;
      - over 10,000 random pairs, exact tiers within ±1 always give true, and the answer is symmetric.
    - `viewHalfHeight(10, 20)` is 88.0 and `viewHalfHeight(20, 20)` 133.4 (±0.1); a radius past the adult's counts as the adult's. The camera tests pass unchanged.
  - Notes: no change to the world's size (T12) or the protocol (T2). `m6c-reset` keeps its pre-reset hook.

- [x] T2 Protocol 11: snapshot version 5, the directory, seat and peer messages on the wire [opus] (after none)
  - Steps:
    1. `PROTOCOL_VERSION` 11. A protocol-10 hello gets `error: version`.
    2. Snapshot version 5 (29 bytes): x and y as u32 in 0.125 wu steps, everything else as version 4. A 25-byte snapshot fails the length check.
       - Signed frames are 93 bytes, signed over the pond id and the 29 bytes (`src/ledger/snapshot-sig.ts`).
       - Proxy frames are 61 bytes.
       - Every test and fixture that builds snapshot bytes follows, and so do `worker/engage.ts`'s decodes.
    3. The messages and events above. Parsers go in `src/net/protocol-world.ts`, dispatched from `protocol-parse.ts`, and refuse unknown fields at every level they define. `src/ledger/seat.ts` holds the seat shapes and `parseSignedSeat`.
       - Ranges: as in the shapes. `near` holds at most 48 peers and 64 swarm points within `NEAR_MAX_BYTES`; `peers` at most 16 distinct, well-formed ids; `relay` stays within `RELAY_MAX_BYTES`, its `sdp` within `SDP_MAX_BYTES`, its `at` a whole ms; `rate` is 1, 2, 5 or 10.
       - `claim` and `consumed` accept layer ids `t1`–`t4` before the cell, as well as today's.
       - The welcome's `pond` becomes `world`, with the same fields, and gains `ticket?`. The client reads `world`.
    4. `PeerMesh` takes a `relay` event up to `RELAY_MAX_BYTES`. Every other event stays within `EVENT_MAX_BYTES`.
    5. The worker meters `where` and `gone` in the 20-message budget and, until T6 handles them, drops and counts them (`Authority.dropped`).
    6. `.claude/rules/net.md`: the new messages and their caps.
  - Acceptance (tests first):
    - Snapshot version 5:
      - it round-trips at (0, 0), (262,143.875, 1) and the largest position, within 1/16 wu;
      - 25 bytes, or a version byte of 4, give null; the flag rules are version 4's;
      - 10,000 fuzzed byte arrays never throw.
    - A 93-byte signed frame verifies; one whose signature covers other bytes fails.
    - Every new message and event round-trips through its parser. Each field out of range, missing or extra parses to null. A `near` with 49 peers, a `peers` with 17 entries, a `relay` of 10,241 bytes and a `rate` of 3 parse to null.
    - `parseSignedSeat` refuses unknown fields and malformed ids, and never throws.
    - `claim { slot: 't2c4_7_s3' }` parses; `t0c…` and `t5c…` don't.
    - 10,000 fuzzed values per parser never throw.
    - Hub test: a protocol-10 hello is refused; a `where` is dropped and counted; 21 messages in 10 s still close the socket.
  - Notes: the shapes are fixed here, and T6 to T9 build to them. This task parses and meters, and changes no behaviour.
  - Done: parsers in `protocol-world.ts` and `src/ledger/seat.ts`, the welcome's `world`, `where`/`gone` dropped in `Authority.dropped`; a `near` within 8 KB needs positions at about 1/8 wu, so T6 rounds them and drops the farthest to fit.
    The 4 bytes more per snapshot raise M7's candidate budget to 620 B/s and M8's proxy budget to 310 B/s (5 Hz of 93- and 61-byte frames).

### Lock-in and the M10 carry-overs

- [x] T3 Lock-in sees its attacker, and the M10 carry-overs in the worker [opus] (after none)
  - Done: `engage:unseen` in `lockAnswer` (`ownSeen` shared with the movement check), `witnessLocked` in `start`, `Fights.settledFight` keeps batched frames 30 s for late disputes, `noWitness` on a throwing commit, one `eligible` pass per offer. Gotcha: an in-time hub-test answer must carry the attacker's snapshot in `seen` (`answer` in `fight-test-kit.ts`), or it is refused.
  - Steps:
    1. `engage:unseen` (`lockState` in `worker/engage.ts`, ADR 0062). An in-time answer whose `seen` holds no snapshot verified as the attacker's own (its key, the pond, a living body of its genome) releases the lock and refuses the attacker `engage:unseen`. Nothing is flagged: an honest client meets it only on a fresh or lossy link. A late answer and a join are unchanged.
    2. The client's toast for `engage:unseen` is "Not in its sight yet", beside the other `engage:*` toasts. DESIGN §3 and §7.
    3. The carry-overs, each with its test first:
       - `witnessLocked` moves from the lock-ask to the lock-in (`start`): a refused, timed-out or unseen lock leaves the witness's own fight as it was;
       - `witnessDispute`: for 30 s after a fight settles, a dispute is checked against its settled frames and spans, and a witness that equivocated is struck;
       - `commitWitnesses`: when `commitPool` throws (a round already due), the event is flagged `authority-only` once;
       - `Duties.offer` calls `eligible()` once per offer, and `playedOf` reads the seated player's own session.
    4. `worker/fight-test-kit.ts`: the scripted target answers with the attacker's snapshots in `seen` by default, and a test can send none.
    5. `.claude/rules/worker.md`.
  - Acceptance (tests first). Workerd hub tests:
    - **`engage:unseen`**:
      - an in-time answer with an empty `seen` refuses `engage:unseen`, releases both sides, and writes and flags nothing;
      - one verified snapshot of the attacker starts the fight;
      - a `seen` holding only another player's snapshots refuses `engage:unseen`;
      - a late answer with none starts the fight, as before.
    - **The witness's fight**: a lock against a witness W refereeing fight F, refused `engage:moved` or `engage:unseen`, leaves F's spans unchanged and W refereeing. An accepted one takes F back at `due + 3`, as before.
    - **A late dispute**:
      - 2 s after F's `enc-end`, a dispute with W's validly signed frame that differs from the committed one strikes W and flags `witness-equivocated` once;
      - an equal frame changes nothing;
      - one 31 s after is dropped and counted.
    - A `commitPool` that throws flags `authority-only` once for the event.
    - An offer over a 16-place order calls `eligible()` once (a spy), and the duty tests pass unchanged.
    - Every M7–M10 hub test passes.

### Fields and food

- [x] T4 Fields for a large world: bathymetry, chunked caches, bounded searches (after T1)
  - Steps:
    1. `RULES.bathymetry`:
       - `broad: { wavelength: 16384, weight: 0.4 }` in place of `tilt`;
       - `calibrationSamples` 128;
       - the centre cap at the world's own centre.

       `depthAt` takes the world's size (or a field handle built from seed and size), so every world calibrates its own field, cached by seed and size.
    2. `src/sim/food.ts`: the kind memo lives in chunks of 16 × 16 cells, at most 256 chunks, the least recently used dropped first.
    3. `findClearSpot` searches within `RULES.spawn.searchRadius` (4,096 wu) and keeps the original point beyond.
    4. `createWorld` still defaults to `RULES.world.size` (8,192 until T12). Regenerate the goldens: the bathymetry changes outcomes.
    5. DESIGN §2 (depth zones).
  - Acceptance (tests first):
    - **Both sizes**, for 20 seeds at 8,192 and at 262,144 wu:
      - the zone shares on a 256 × 256 sample are within DESIGN §2's bands;
      - the 1,400 wu disc around the centre is all twilight;
      - the nearest shallows and the nearest deep lie within 2,200 wu of it.
    - **The large world**, for 20 seeds at 262,144 wu: every point of a 32 × 32 lattice lies within 16,384 wu of the shallows and of the deep, and within 32,768 wu of the abyss.
    - Depth is smooth: points 1 wu apart differ by at most 0.003.
    - **`speedTest`**:
      - calibrating a 262,144 wu world takes under 30 ms in Node;
      - one tick of 24 creatures with their visible food near (250,000, 250,000) takes under 2 ms.
    - **Bounded memory**: a creature swept 200,000 wu leaves at most 256 chunks in the memo, and a cell whose chunk was dropped shows the same items as before.
    - With every point within 4,096 wu poisoned (`extraPlumes`), `findClearSpot` returns the original point within 50 ms.
    - The replay goldens are equal in Node and Chromium (`m3-determinism`).
  - Notes: no food layers (T5) and no render (T11). T12 makes the world 262,144 wu.
  - Done: `depthAt` and `zoneAt` take the world's size last (default `RULES.world.size`; the render callers keep it until T11); each size calibrates its own field from R2 points outside the centre disc, shifted so the centre's 2,200 wu surroundings sit mid-twilight (`localHalf`). The spec's broad weight 1 clustered the shallows beyond 16,384 wu, so it is 0.4 and the shares are 27/33/27/13 (the disc eats 9% of a pond).
  - Gotcha: the golden-autopilot encounter now scans its start north in steps of 25 wu for a fight that ends in a kill; `foodMemoChunks` and `RULES.spawn.searchRadius` are the new hooks.

- [x] T5 Food by tier (after T4)
  - Steps:
    1. `RULES.food.layers` (ADR 0061): layer k from 0 to 4 has cells of 256 × 4^k wu with 10 slots, items 4^k times as wide and 64^k times as rich (tuned below).
    2. `src/sim/food.ts` works per layer:
       - ids are `t<k>c…` for k ≥ 1;
       - `foodInCell`, `foodNear`, `slotAnchor`, `consumeFood`, `applyRemoteClaim`, `isFoodSlot` and `parseFoodId` take or read the layer;
       - `applyFeeding` eats layers t and t − 1 for a creature of tier t, in layer, cell and slot order;
       - carrion stays as it is.
    3. The game queries and draws the player's two layers (`app-render.ts`), and `render.info().foodInstances` counts them.
    4. `npm run sim:pacing -- --tiers` (`tools/pacing-report.ts`):
       - bots start at the bottom of tiers 1 to 3 (biomass 1,024, 16,384 and 262,144, with an adult size of 1.5 × that) and forage their layers;
       - the report gives their median minutes to grow by half against the T0 bot's;
       - tune the multiplier or the slots per cell until each lies within 0.5–2×, and record the values in DESIGN §2.
  - Acceptance (tests first):
    - The T0 replay goldens are unchanged: a T0 creature eats only layer 0.
    - **Who eats what**:
      - a T1 creature over a layer-1 detritus eats it for 8 × 128 (`richnessStep`) × efficiency × digestion;
      - a T0 creature passes through it;
      - a T1 creature eats layer-0 items too, and a T2 creature never does.
    - **Claims**: a claim for `t1c2_3_s4` applies, and its respawn follows the same rule as layer 0's. `isFoodSlot` takes a layer-1 slot only within that layer's grid.
    - The pacing report's tier rows lie within 0.5–2× the T0 bot's, and `pacing-report.test.ts` pins the table's shape.
    - `speedTest`: one tick of a T3 creature with its visible food takes under 2 ms.
  - Notes: the rules stay 12, the first bump since the release being T1's.
  - Done: layers are `RULES.food.layers`, ids `t<k>c…`, and every food function takes a layer (default 0); `foodForTier` and `eatenLayers` give a tier's two layers. The pacing report tuned the layers to 40 slots and 128^k richness (ADR 0061's 10 slots and 64^k left a T3 bot at 2.6× to 5× the T0 time).
  - Gotcha: the tier bots ignore the depth bands (a giant's health shrugs them off, and the bot dithered at the band edge in the big world).

### The directory and seat tickets

- [x] T6 The authority's directory: the quadtree, reports and their answers [opus] (after T1, T2)
  - Done: `worker/directory.ts` (pure, tested in Node) and `worker/where.ts` on `hub.directory`, rebuilt from `Session.where` on a wake; the relay, courts and carrion read it, and `GET /v1/e2e/directory` shows it. Gotchas: `LEAF_MIN` scales with `leafMax` (a merged leaf must not split at once, so with `LEAF_MAX=2` leaves merge only when empty); a court is `not-near` only once the directory knows one of the two, so before T13 the pond still decides.
  - Steps:
    1. `worker/directory.ts`, pure (shapes above):
       - **the root** is the world square;
       - **splits and merges**: a leaf splits into four above `LEAF_MAX` members unless it is `LEAF_MIN_SIZE` wide, and four sibling leaves merge below `LEAF_MIN` together;
       - **`near(id)`**:
         - `peers`: the 48 nearest members within `Q = max(8,192, 4 × aoi)` that pass `linkTiers` with the reporter, nearest first;
         - `swarm`: the 64 nearest members two or more tiers smaller within its AoI, as positions;
       - **until T14**, the hub's `near` lists only members of the reporter's pond (a filter the hub passes in), so links stay within ponds while they exist.
    2. `worker/where.ts`, called from `Authority`:
       - **a `where`** updates the session's attachment and the directory, and is answered with `near`. Members whose leaf a split or merge changed each get `leaf`;
       - **jumps**: a report further from the last than `WHERE_SPEED_WU` × the seconds since it, plus `WHERE_JUMP_WU`, is dropped and counted. It is taken after a new binding of the session's life (genesis, promote, restore, sign-in), and always in fixture mode;
       - **leaving**: `gone` and a closed socket take the member out;
       - **a wake**: the constructor rebuilds the directory from the sockets' attachments.
    3. The hub's other uses of the directory:
       - **the relay** (`relay` in `sessions.ts`): a signal passes within the pond as today, or between sessions the directory places within max(their `Q`s) + 4,096 wu, or between a duty pair. A passing signal carries the sender's directory position as `at`;
       - **courts**: `mate-check` answers `not-near`, and `court` is refused `not-near`, when the directory places the two more than 12,288 wu apart or doesn't know one of them;
       - **carrion** (`settle.ts`): the notice also goes to every session the directory places within 10,000 wu of the kill.
    4. Fixture mode: `LEAF_MAX`, and jumps taken.
    5. `GET /v1/e2e/directory` (E2E entry only): the leaves with their counts, each member's leaf and report, and the hub's relay count by pair.
    6. `.claude/rules/worker.md`, `docs/TESTING.md`.
  - Acceptance (tests first). Unit tests of `Directory` in Node, and hub tests in workerd. Hub tests that need distances past the world's current size swap the live object's directory for one of 262,144 wu, as they swap its beacon source:
    - **Splits and merges**:
      - 17 reports in one leaf split it in four;
      - no leaf holds more than 16 unless it is 1,024 wu wide;
      - removing members until four siblings hold 5 merges them;
      - over 10,000 random report and remove sequences, every member is in exactly one leaf, which holds its centre.
    - **`near`**:
      - the 48 nearest within `Q` (8,192 wu for a starter's AoI, 4 × the AoI for a larger one), linkable and nearest first, with the right ages, never the reporter;
      - a creature two tiers smaller within the AoI is in `swarm` (at most 64) and never in `peers`.
    - A split sends one `leaf` to each member whose leaf changed.
    - **Jumps**: a report 5,000 wu from one 2 s earlier is dropped and counted. After a genesis it is taken, and in fixture mode it is taken.
    - After a wake (the directory rebuilt from the sockets' attachments), the next `where` is answered with the same peers. `POST /v1/e2e/restart` closes every socket, so it empties the directory.
    - **The relay**: a signal between sessions 3,000 wu apart in different ponds passes and carries `at`. One between sessions 30,000 wu apart gets `no-peer`, and a duty pair passes at any distance.
    - **Courts**: partners 15,000 wu apart get `not-near` in `mate-info` and from `court`; 2,000 wu apart, the court goes on as before.
    - **Carrion**: a kill's `carrion` reaches a session 9,000 wu away in another pond, and not one 12,000 wu away in another pond.
    - A `where` writes no SQLite row. 21 messages in 10 s close a session, as before.
  - Notes: no client sends `where` until T13, and the ponds stay until T14. Before T14, a `near` that crosses ponds is a bug.

- [x] T7 Seat tickets and signed signals [opus] (after T2)
  - Done: `seat.ts` checks (the parser moved to `seat-doc.ts`, so the wire loads no `@noble/curves`), `worker/seat.ts` on the welcome and after a `pong`, `HubClient.ticket`, one `App.authorityKeys` fetch. Gotchas: a ticket's `world` is the world's seed, shared by every pond; it is a `bs/auth/v1` countersignature over a `bs/seat/v1` hash, as a record's, so the ledger signs it and writes no row.
  - Steps:
    1. `src/ledger/seat.ts`: `seatValid`, `signalBytes`, `signSignal` and `signalSigned` (shapes above).
       - A ticket is countersigned with the ledger's authority key over `'bs/seat/v1'` and its canonical JSON.
       - `seatValid` checks:
         - the key, from the authority's `/v1/pubkeys`;
         - the world and the player asked for;
         - `t` no later than 30 s after now, and `until` after now.
    2. `worker/seat.ts`:
       - the welcome carries a ticket (`t` now, `until` 15 minutes on);
       - a `pong` sent at least 10 minutes after the session's last ticket is followed by a fresh `seat`;
       - signing writes no row.
    3. The client keeps its ticket and fetches the authority's keys once per page, sharing the fetch the settlement checks make.
    4. `.claude/rules/ledger.md`: the seat and signal domains.
  - Acceptance (tests first):
    - **Tickets**:
      - a hub ticket verifies under `/v1/pubkeys`;
      - a changed field, another world, another player, an expired ticket or a flipped signature byte fails.
    - **The hub**:
      - the welcome's ticket names the session's player and name;
      - a session that pings 10 minutes after its welcome gets a `seat`, and one that pings after 9 does not;
      - `rowsWritten` stays unchanged.
    - **Signals**:
      - a signature verifies;
      - another `to`, `kind`, `at`, `pos`, a changed SDP byte or another key fails;
      - `signalBytes` is pinned at 32 + 32 + 1 + 8 + 24 + 32 bytes after its domain.
    - `speedTest`: 20 ticket checks and 20 signal checks take under 60 ms in Node, warm. (40 ms was below the floor: a signal's check under a key nobody tables is a plain Ed25519 check, about 1.3 ms, so the 40 took about 35 ms.)
    - 10,000 fuzzed values never make a check throw.

### Links

- [x] T8 The area-of-interest manager: link classes, the cap, and when to report [opus] (after T1, T2)
  - Done: `src/net/aoi.ts` and `src/net/where.ts`, pure; `AoiManager.plan` and `ConnectionPolicy` share `selectLinks`, and the directory uses `queryRadius`. Gotchas: a hold covers a creature whose class was that one or better; past 32, P0 goes before P1, so a 33rd duty peer takes a P1's place; a leaf that doesn't hold the last report is stale and never re-triggers a `where`.
  - Steps:
    1. `src/net/aoi.ts` (shapes above). `classify` takes the classes in order, the first that holds:
       - **P0**: the ids in `p0`;
       - **P1**: within `8 × the larger radius + 600` wu, and held until 900 wu past `8 × the larger radius`;
       - **P2**: within the AoI, held to 1.1 ×;
       - **P3**: within 2 × the AoI, held to 2.2 ×;
       - **P4**: within `Q`, held to 1.1 × `Q`, ordered by the distance from where the player will be in 3 s.

       Every class but P0 needs `linkTiers`. The AoI is `aoiRadius(r, adultR)`.
    2. `plan`:
       - P0 and P1 are always held, up to 32;
       - P2–P4 fill only the room under 24 that P0 and P1 leave, nearest first within each class;
       - when P0 + P1 pass 32, it keeps P0 and the nearest P1 and says `crowded`;
       - an unwanted held peer is evicted only after 3 s unwanted;
       - the worst P2–P4 goes first when a P0 or P1 needs its place.
    3. `ConnectionPolicy`:
       - five classes;
       - either side may call: `plan` connects any wanted peer it doesn't hold, and `admit` decides an inbound offer by the caller's class;
       - `duty(id, on)` makes a peer P0.
    4. `src/net/where.ts`, `WhereReporter`, sends:
       - `where` when the creature enters the water, when its centre leaves its leaf by more than 64 wu, when its tier changes, when its AoI changes by more than a quarter, and otherwise every 30 s;
       - `gone` once when it leaves the water;
       - never two messages within 2 s (a trigger waits).
    5. `.claude/rules/net.md`.
  - Acceptance (tests first):
    - **`classify`**, for a starter (radius 10, adult radius 20) at the origin, against comparable creatures:
      - one at 650 wu is P1, at 700 wu P4, and once P1 it stays P1 to 980 wu;
      - one of radius 200 at 100 wu has no class;
      - its fight's opponent 9,000 wu away is P0.
    - **The plan** (property tests over 10,000 random worlds of 1 to 80 known creatures):
      - never more than 32 held;
      - P2–P4 held only while the total is at most 24;
      - every P0 and P1 held while P0 + P1 ≤ 32, and `crowded` exactly when they pass 32;
      - a P1 is never evicted, and each class fills nearest first.
    - **Symmetry**: over 10,000 random pairs at the same positions, A puts B in P1 exactly when B puts A in P1.
    - **Hysteresis**: a creature moving back and forth across 1.05 × the AoI keeps its class, and an unwanted peer is evicted after 3 s, not before.
    - **Inbound**:
      - with 24 held, all nearer than the caller, a P4's offer is refused;
      - a P1's is admitted, evicting the worst P2–P4;
      - a duty peer is admitted up to 32.
    - **The reporter**:
      - entering the water sends `where`;
      - inside the leaf nothing goes for 30 s, then a `where`;
      - leaving it by 65 wu sends one, and by 63 wu none;
      - two triggers 1 s apart send one message, and the second 2 s after the first;
      - a death sends `gone` once.
  - Notes: pure. T13 wires it into the game, and the harness (T10) runs it.

- [x] T9 Gossip, relayed signaling and the hello gate [opus] (after T7, T8)
  - Done: `Gossip`, `SignalRoute` (pure, signer and check injected) and `PeerMesh`'s `hello` gate (joined only once the peer's ticket passes; no retry after a failure); the fake RTC moved to `rtc-test-kit.ts`. Gotchas: a peer forwards only its link's own signals (one hop), and a forged relay counts against the link's 4 a second but never burns a genuine (from, at).
  - Steps:
    1. `src/net/gossip.ts`:
       - **sending**: every 4 s, each link carries the sender's up to 16 linked peers nearest the receiver (by its newest snapshot) that pass `linkTiers` with it, from snapshots under 2 s old;
       - **merging**: the receiver merges them into its known set as `gossip`, and they expire after 10 s unless refreshed.
    2. `src/net/signal-route.ts`:
       - **the route**: to reach C, a linked peer whose gossip listed C in the last 10 s, the nearest to C, else the hub;
       - **forwarding**: a peer forwards a `relay` only to a linked `to`, unchanged, at most 4 a second per link, and drops and counts the rest;
       - **an inbound relay** must be signed by `from` (`signalSigned`), name this page as `to`, carry an `at` within 30 s of its hub clock, and be new: a pair (from, at) seen in the last 2 minutes is dropped;
       - **the answer** goes back the way the offer came, and an offer unanswered after 4 s goes once more through the hub.
    3. `PeerMesh`:
       - **the hello gate**: each link's first event, each way, is `hello`, and the peer's ticket must pass `seatValid` for that peer within 5 s. Until then nothing else from it is delivered, and a failure closes the link and counts `helloFailed`;
       - relayed signals feed `handleSignal`, and outgoing signals go out through a route callback.
    4. `.claude/rules/net.md`.
  - Acceptance (tests first). Unit tests with fake transports:
    - **A chain**: with A–B and B–C linked, A's offer to C goes through B and C answers through B. A–C opens with no hub signal for the pair.
    - **Tampering**: B changing the SDP or the `pos` makes C drop the relay as `forged`, and A goes through the hub after 4 s.
    - **Replays and skew**: a relay seen before is dropped, and one whose `at` is 31 s off is dropped.
    - **Forwarding limits**: B forwards at most 4 relays a second per link, and drops and counts a relay to a peer it doesn't hold.
    - **Gossip**:
      - B's `peers` to A lists B's linked peers nearest A, linkable with A, from snapshots under 2 s old;
      - A keeps them as `gossip` and drops them after 10 s;
      - gossip about 16 peers stays within 1,100 bytes per message (about 1 KB: at the world's six-digit coordinates sixteen 43-character ids with positions need about 1,050 bytes in the T2 wire format, still under gate 6's 0.3 KB/s per link).
    - **The hello gate**:
      - a link with no valid hello within 5 s closes and counts;
      - a snapshot before the hello is not delivered;
      - a ticket naming another player fails.
  - Notes: no game wiring (T13).

- [x] T10 The headless area-of-interest harness: property tests and the report (after T6, T8, T9)
  - Done: `tests/aoi-harness.ts` (with `aoi-types.ts`, `aoi-scenarios.ts`), `tools/aoi-report.ts` and `docs/perf/aoi.md`; ADR 0063 holds the link model's rules and why four gates read differently (below). It found three faults, fixed here: P2 to P4 reach by whichever of two creatures sees further (`AoiManager.classify`), an offer carries its caller's class (T13 adds it to the wire), and P0 and P1 calls go through the hub. Gotchas: the two dense scenarios assert only the cap, tiers, swarms and duties; a full `npm run report:aoi` takes about 100 s.
  - Steps:
    1. `tests/aoi-harness.ts`, pure and seeded. Simulated clients each run their own:
       - `AoiManager`, `ConnectionPolicy` and `WhereReporter`;
       - `Gossip` and `SignalRoute`;
       - against one `Directory` (T6).

       Creatures move by script within the real speed limits: 40–105 wu/s plus dashes, and turning.
    2. **The link model** (every number seeded):
       - an offer and answer through the route `SignalRoute` picks: a peer hop takes 30–80 ms, the hub 50–150 ms;
       - ICE takes 0.5–2 s;
       - 5% of attempts fail and are retried;
       - the hello takes a round trip.
    3. **Scenarios**:
       - **friends**: 6 spawn on the ring and wander;
       - **sparse**: 200 walkers over 40,000 × 40,000 wu;
       - **crowd**: 40 comparable creatures within 1,500 wu;
       - **tiers**: 30 T0, 10 T1, 5 T2 and 2 T3, mixed;
       - **streams**: two groups of 12 cross each other at full speed, dashing;
       - **traveller**: one swims 60,000 wu through a populated world;
       - **witnesses**: 3 fights in the crowd, refereed by witnesses 20,000 wu away.
    4. `npm run report:aoi` (`tools/aoi-report.ts`, `tools/aoi.mjs`) writes `docs/perf/aoi.md`: each scenario's gates, then:
       - links per client;
       - discovery latency (p50, p95);
       - authority messages per player-minute (reports and hub signals);
       - the share of links set up by peer relays;
       - gossip bytes per link;
       - `crowded` time.
    5. `tests/aoi-harness.test.ts` (`heavyTest`): the gates over 50 seeded runs of sparse, streams and traveller at twice the speed.
  - Acceptance. The report's gates, each a failing test when it breaks:
    1. **The cap**: no client ever holds more than 32 links, or more than 24 while its P0 + P1 ≤ 24.
    2. **No hidden interactable creature**: every pair within 8 × the larger radius and tiers ±1 is linked with its hello done, whenever neither side is `crowded`. There are 0 violations.
    3. **Seamless handoffs**:
       - 0 pops: no remote within a player's view loses its link while the two stay within each other's AoI;
       - every remote that comes into view at a closing speed of at most 100 wu/s has been linked for at least 0.5 s (at 200 wu/s the 600 wu lead is 3 s, less than a call can take once an attempt fails; not asserted in the dense scenarios).
    4. **Friends**: everyone is linked to everyone within 3 s of their spawn at the median and 5 s at the p95 (a failed attempt adds about 2.3 s, so no p95 of 3 s is reachable with ICE at 0.5–2 s).
    5. **Budget**:
       - reports plus hub signals are at most 6 incoming messages per player-minute (median) and 12 (p95) after a creature's first minute, and at most 48 (p95) in it, when it dials everyone around it;
       - in sparse and streams, at least 70% of the links made after the first minute go through a peer relay.
    6. **Gossip** costs at most 0.3 KB/s per link.
    7. **Tiers**:
       - no link between creatures two tiers apart outside P0;
       - every giant's swarm holds each smaller creature in its AoI that reported in the last 30 s.
    8. **Witnesses**: every duty is taken with P0 + P1 ≤ 28, and the cap holds with the duty links.
  - Notes: the harness never touches sockets or WebRTC. Gate 2's exception is the M12 case: a crowd of more than 32 that can act on one player.

### The world at full size

- [x] T11 Render at world scale: depth windows and a floating origin [opus] (after T4)
  - Steps:
    1. `src/render/depth-window.ts`:
       - a 256 × 256 depth texture over a square window near a point, re-centred when the point has moved a quarter of the side;
       - it refills only the texels that scroll in, at most 4,096 samples a frame, and shows the old texels until the new ones are in.
    2. The windows that use it:
       - the zones (water colour and fog): a window of 8 view half-heights;
       - the minimap's chart (`map-relief.ts`): a window of 12;
       - the map's chart: its own window, sized by T18.
    3. **A floating origin**: the scene draws relative to an origin snapped to multiples of 4,096 wu near the camera. Every world-space uniform (caustics, zones, water, the snow's drift) takes the offset, and the patterns stay continuous when the origin moves.
    4. `?world=<size>` (8,192 to 262,144 wu) sizes the offline local world, which spawns at its centre.
    5. DESIGN §2 (zones on screen) and §12; `docs/TESTING.md`.
  - Acceptance (tests first):
    - **The window**, over a 262,144 wu world:
      - moved 1,000 wu, it samples only the texels that scrolled in, never more than 4,096 a frame;
      - each texel equals `depthAt` at its centre once filled;
      - after a teleport the whole window refills within 16 frames, with the stale texels shown meanwhile.
    - At any camera position in the world, every position and uniform sent to the GPU lies within 16,384 wu of zero.
    - `speedTest`: a frame's refill takes at most 1.5 ms in Node.
    - **`m11-world.spec.ts`** (no hub, `?world=262144&debug=1`), at the centre and at (250,000, 250,000):
      - the water under the player has its zone's colour, as `m6-zones` checks;
      - at the far corner, a still creature's drawn centre (`render.info()`) moves at most 0.05 px over 30 frames;
      - the medium preset keeps its m6 budgets (draw calls, triangles, target memory);
      - screenshots of both places are attached.
    - Every `m6*` look test passes unchanged at 8,192 wu.
  - Done: `DepthWindow` is a torus of bytes refilled through `depthSpan` (bathymetry's row sampler, bit-equal to `depthAt`, about 0.65 ms a frame); the scene subtracts `ORIGIN` in `writeInstance` and every mesh, and the minimap charts its own 128-texel window of 24 half-heights (12 would leave its disc off the window between re-centres). The map stays whole-world until T18.
  - Gotcha: debug teleports fill the zone window at once (`settleZones`), or the m6 look shots would catch its 16-frame refill; `?gpu=watch` and `render.gpu()` check the 16,384 wu bound, in `m11-world`'s fast test (its look test is `@slow`).

- [x] T12 The world grows to 262,144 wu (after T5, T11)
  - Steps:
    1. `RULES.world.size` 262,144. The world's centre (131,072, 131,072) is the spawn centre everywhere: the hub's ring and every new pond, the offline world, the bathymetry's twilight disc and the encounters' world. Regenerate the goldens.
    2. `state().pond` gains `size` and `centre`. Every E2E helper and spec that uses absolute pond coordinates moves to coordinates relative to the centre.
    3. DESIGN §2: the world's size. The ponds stay roster groups of it until T14.
    4. `POS_MAX` in `src/net/protocol-encounter.ts` (8,192, the fight wire's position bound) becomes `WIRE_POS_MAX`, so a fight far from the origin still parses.
  - Acceptance (tests first):
    - Hub test: a welcome names a world of 262,144 wu centred at (131,072, 131,072), and slot 0 spawns at the centre.
    - Every E2E, fast and full, passes. `m11-world` passes at the default size, without `?world=`.
    - The medium budgets hold at the spawn (`m6-budget`), and the replay goldens are equal in Node and Chromium.
    - `speedTest`: one tick of 24 creatures at the spawn stays under 2 ms.
  - Notes: no change to links or ponds: players in a pond still all link to each other.
  - Done: `RULES.world.size` is 262,144; the hub, offline cell and fights already centred on `size / 2`. `state().pond` has `size` and `centre`, and the encounter wire and proof parsers take `WIRE_POS_MAX`. Goldens, the combat and net reports regenerated.
  - Gotcha: tests that swept a whole world (food, hazards, claims, the tournament, `m3-anatomy`) or measured a calibrated look (`m6b-water`, `m11-world`'s reference) pass `size: 8192` / `?world=8192`; hub fight tests stage at `CENTRE`/`STAGE` in `fight-test-kit.ts`, with `CALM_SEED` `calm-1`.

### The world in the game

- [x] T13 The session in the world: links by area of interest [opus] (after T6, T9, T12)
  - Done: `OnlineSession` with `neighbours.ts` (the known set) and `online-links.ts` (`Links`, the plan and dial loop, whose constants the harness now imports); signals carry `cls` and a `refuse` kind (inside `signalBytes`, now 130 bytes), and the mesh runs with `retry: false` and re-answers a repeated offer. Gotchas: the seat checks load lazily (no `@noble/curves` in the shell), away fighters are judged by the roster (`present`), not by a name; a local hub run needs a config that starts only its hub.
  - Steps:
    1. `src/game/online.ts`, split into `online-links.ts` and `neighbours.ts`:
       - **the known set** comes from the directory's `near`, gossip, snapshots, the hub's `at` and a relay's `pos`;
       - **the plan** runs every 500 ms (and at once when `near` answers or an offer comes in) through `AoiManager` and `ConnectionPolicy`: connect, evict after the grace, and admit an inbound offer by the class it carries. **How it dials is ADR 0063's** (the harness's model, `docs/perf/aoi.md`): P0 and P1 at once through the hub; the rest through a gossip-placed peer, else one hub call at a time once 4 links are held; the lower id calls; a P4 only on a fix under 5 s old; a refusal is answered and backs off a P3 or P4. `signal` and `relay` gain the caller's class (`cls`, 0–4, inside the relay's signature);
       - `where` and `gone` go out by `WhereReporter`;
       - gossip goes out every 4 s, and signals through `SignalRoute`;
       - the hello gate holds, and names come from tickets;
       - **duty links** go through `ConnectionPolicy.duty`, and `OnlineSession.dutyPeer`'s own cap check goes (the carry-over).
    2. `src/game/app-online.ts`:
       - snapshots, events, chat, emotes and pings go to linked peers;
       - when a link's hello passes, each side sends the consumed entries within 4,096 wu of its creature (layer ids, in 40-entry parts);
       - the genome goes as today;
       - the menu's Players list holds the linked peers;
       - the alone hint, shown when nothing is linked and nothing known within `Q`, reads "No one nearby yet".
    3. The hub's `members` and `member` no longer decide any link (T14 removes them).
    4. `debug.netCap(n)` (1–24, debug only) sets the default cap. `state().net` gains:
       - `links`: `[{ id, class, open, hello, since }]`;
       - `known`, by source;
       - `crowded`;
       - `where`: `{ sent, leaf }`;
       - `signals`: `{ hub, relayed, forwarded, forged }`;
       - `helloFailed`.
    5. `docs/TESTING.md`, `.claude/rules/net.md`.
  - Acceptance (tests first):
    - **Unit tests** with a fake hub and mesh:
      - a `near` with 3 peers links all 3;
      - a peer that moves beyond `Q` is closed after 3 s;
      - with a cap of 2 and three peers (one P1, two P4), the P1 and the nearer P4 are held;
      - a duty link with 24 links held evicts a P4, and the total never passes 32.
    - **`m11-handoff.spec.ts`** (`@slow`, hub 8828, `LEAF_MAX=2`): A, B and C hatch, and C is teleported 10,000 wu ahead on A's line. A steers 3,000 wu diagonally through the world's centre, across both quadrant edges of the split root (`GET /v1/e2e/directory`), with B following, while C swims toward A:
      - A's `where` count rises at each leaf exit;
      - A–B is never closed;
      - A and C link while still more than twice A's AoI apart, before C comes into A's view;
      - every remote in A's view keeps an alpha of 1, sampled every 100 ms.
    - **`m11-cap.spec.ts`** (`@slow`, hub 8829): A has `netCap(2)`, B is next to A (P1), and C and D are 3,000 wu off:
      - A holds B and the nearer of C and D;
      - D swimming next to A takes C's place;
      - B is never evicted.
    - **`m11-relay.spec.ts`** (`@slow`, hub 8830): A at −5,000 wu, B at 0 and C at +5,000 wu, so A–B and B–C link and A–C doesn't. A swims toward C:
      - A learns of C from B's gossip;
      - A and C link through B's relay: `signals.relayed` rises on both, neither page's `signals.hub` rises, and the hub's relay count for the pair does not rise (they hatched side by side, so their first link went through the hub; the count lives in memory, so a hibernating hub may drop it).
    - Every existing hub E2E (M2 to M10) passes.
  - Notes: the hub still groups ponds and its `near` stays within the pond (T6), so links form within ponds and `m10-cross` keeps its two ponds until T14. `online.ts` and `app-online.ts` are this task's.

- [x] T14 The ponds go: one world with no rosters [opus] (after T13)
  - Done: one world row (`worker/world.ts`), no roster (no `members`, no `member`), `near`, the relay, courts and carrion by the directory alone, `POND_MAX` and `engage:pond` gone; the page shows `state().world`, `debug.joinWorld` and "Online · N nearby", and judges a fighter away by its open link (`present`).
  - Gotcha: a court needs the directory to place both partners, so mating hub tests report first (`placed` in `worker/test-hub.ts`); `m10-cross`'s C teleports into the nearest twilight 20,000 wu off.
  - Steps:
    1. The worker:
       - **seats**: every seat is in the one world, and the welcome holds no `members` and there is no `member` message;
       - **spawns**: `place` gives slots over every seated session, and away seats count world-wide;
       - **the directory**: `near` lists members across the whole world (T6's pond filter goes);
       - **the relay**: a signal passes only by the directory or a duty;
       - **courts** are checked by the directory only, and carrion notices go by area only;
       - `engage:pond` goes, and so does `POND_MAX`.
    2. The protocol drops `members` and `member` (still protocol 11).
    3. The client:
       - `state().pond` becomes `state().world` (`{ id, seed, size, centre }`), and `debug.joinPond` becomes `debug.joinWorld`;
       - every E2E helper and spec that read the pond follows;
       - `m10-cross` teleports C 20,000 wu away instead of seating it in another pond, so only its duty links reach the fighters.
    4. DESIGN §2 and §8 drop the ponds. `docs/TESTING.md`, `.claude/rules/{worker,net}.md`.
  - Acceptance (tests first):
    - **Hub tests**:
      - three sessions get welcomes with the same world and no members;
      - 30 sessions spawn at slots 0 to 29 on one ring around (131,072, 131,072);
      - a signal between sessions 30,000 wu apart gets `no-peer`, and one between sessions 3,000 wu apart passes;
      - partners 15,000 wu apart get `not-near`, and a kill's `carrion` reaches a session 9,000 wu away and not one 12,000 wu away;
      - an engage between any two sessions in the world is refused only by its own checks.
    - `m10-cross` passes with C 20,000 wu away: the fighters reach it over their duty links alone.
    - Every E2E, fast and full, passes. In `m2-pond`, the friends link within 3 s of their hatch.
    - `tools/worker-bundle.test.ts`: `POND_MAX` appears nowhere, and `LEAF_MAX` only in fixture mode.

- [x] T15 Snapshot rates by distance [opus] (after T13)
  - Done: `src/net/snapshot-rates.ts` (`wantedRate`, `RateAsker`, `SendRates`) wired in `OnlineSession`; `RemoteBuffer.sampleLate` draws a remote its snapshots' spacing + 20 ms behind and eases the lag (`pace` ≤ 1.2); harness gate 9 counts frames on the wire with 93 bytes of headers.
  - Gotcha: the dense scenarios (`crowd`, `witnesses`) upload 20–32 KB/s at 24 links (all P1 at 10 Hz), so gate 9's 12 KB/s is reported there, not asserted (M12); `m11-cap` flakes locally before this task too (a stale `near` position re-dials an evicted peer as P1).
  - Steps:
    1. **The receiver** decides the rate it wants from each link:
       - 10 Hz for a peer of P0 or P1, or within 1.15 × its view's half-diagonal;
       - 5 Hz within its AoI;
       - 2 Hz for P3, and 1 Hz for P4.

       It sends a `rate` event on a change, at most once a second per link.
    2. **The sender** (`SnapshotSender` in `pond-sync.ts`) sends each link at the rate it asked for, 10 Hz until asked. Engage candidates still get a signed frame every 200 ms.
    3. **Drawing**: a remote whose rate rises eases in, and nothing jumps.
    4. `state().net.links[]` gains `hz` (the rate this page sends) and `wanted` (the rate it asked for).
  - Acceptance (tests first):
    - Unit tests:
      - each class asks its rate;
      - a peer crossing into the view asks 10 Hz within a second;
      - an asked rate of 2 Hz sends 2 snapshots a second;
      - a candidate's signed frames stay at 5 Hz.
    - T10's report gains a bandwidth row: upload at 24 links is at most 12 KB/s (outside the dense scenarios, whose links are all P1 and so 10 Hz by rule), and each link at most 4 KB/s.
    - In `m11-handoff`, C sends to A at 2 Hz or less while far and at 10 Hz once in A's view, and the C that A draws never moves faster than 1.2 × its snapshots' speed.

- [x] T16 Fights, witnesses and away fighters in the world [opus] (after T13)
  - Done: `Links.fight` makes a fight's other fighters P0 from `enc-start`/`enc-join` to `FIGHT_HOLD_MS` past `enc-end`, then closes them unless classed; `avail` needs `protectedLinks()` ≤ 28; every connected fighter relays proxies and `ProxyReceiver` keeps one sender per away player (`net.proxyFrom`).
  - Gotcha: a welcome starts every fight's 3 s hold (the hub's resync cancels it), so a fight settled while away never pins a link; the session fakes moved to `src/game/online-test-kit.ts`.
  - Steps:
    1. A fight's links are P0 for every fighter until 3 s after `enc-end`, across leaf and tier changes (a kill's growth included).
    2. `avail` (`app-duty.ts`) also needs at most 28 links of P0 and P1.
    3. **Proxies** (`proxy-snaps.ts`, `pond-sync.ts`): every connected fighter relays each away fighter to its own linked peers outside the fight. A receiver keeps one sender per away player, the first heard while it keeps sending, and drops and counts the rest. The other proxy rules stay.
    4. DESIGN §7 (away fighters) and §8 (witness duty); `docs/TESTING.md`.
  - Acceptance (tests first):
    - Unit tests:
      - a fighter that crosses a leaf boundary or grows into a tier keeps its fight's links, which close 3 s after the end unless another class holds them;
      - with 29 links of P0 and P1 `avail` turns off, and with 28 it may turn on;
      - with two fighters relaying the same away fighter to one spectator, the spectator draws it from one and counts the other's frames as dropped, and when that sender stops, the other's frames are taken after 1 s.
    - `m8-proxy` passes in the world, with a spectator linked only to the second fighter seeing the away fighter.
    - `m10-witness` and `m10-cross` pass.

- [x] T17 The look across tiers, and ambient swarms [opus] (after T14)
  - Done: `src/render/look.ts` (`lookScale`, never below 1, and `LookAnchor`: patterns drawn around a virtual camera moving by Δcamera ÷ scale) scales the caustics, god rays, snow, food halos and plume rims; `src/render/swarms.ts` draws `near.swarm` (`render.info().swarms`, `look`); `m11-tiers` on hub 8831.
  - Gotcha: a pattern scaled about a fixed point sweeps far from it as the view grows, hence the anchor; step 3 holds by construction (no link, and a swarm lists only smaller players), so nothing filters drawn remotes (`m3-wire` draws a T2 scripted remote beside a hatchling).
  - Steps:
    1. **The look scales with the view.** The world-space look features take the scale (view half-height ÷ 133.4, a starter adult's), so a giant's screen reads like a starter's:
       - the caustic filaments and the god-ray shafts;
       - the food's halo and the bokeh sizes;
       - the plumes' edge detail.
    2. **Swarms** (`src/render/swarms.ts`):
       - each `near.swarm` point is a faint cloud of 5 to 9 motes, seeded by its position, drifting with the current from where it was reported;
       - at most 64 clouds, each fading in and out over 1 s;
       - `render.info().swarms` counts them.
    3. A creature two tiers bigger is never drawn. The edge arrows and the minimap show linked players only.
    4. DESIGN §2 and §10; `docs/TESTING.md`.
  - Acceptance (tests first):
    - Unit tests:
      - the scale is 1 for a T0 adult and about 14.8 for a T2 adult of radius 400;
      - the caustics' filament width in pixels is the same for both, within 10%;
      - three swarm points draw three clouds, and a point gone from the next `near` fades out over 1 s.
    - **`m11-tiers.spec.ts`** (`@slow`, hub 8831): A at T0, B at T1 (`debug.setBiomass(4000)`) and C at T2 (`setBiomass(70000)`) within 2,000 wu of each other:
      - A–B and B–C are linked, and A–C never;
      - C draws A as a swarm (`render.info().swarms` at least 1), and A draws no C;
      - the medium budget holds in C's view;
      - a screenshot of each view is attached.

- [x] T18 The map, the minimap and finding players in the world [opus] (after T14)
  - Done: `map-view.ts` (the square, marks, sightings) and `depth-chart.ts` (`DepthChart`: the map's 256-texel window charted by `ChartJob` over frames, the minimap's at once); `OnlineSession.sightings` feeds hollow marks, `debug.setKnown` stages them, `m11-map` takes the shots.
  - Gotcha: `Math.hypot` made the relief ten times slower than `sqrt`; a row of relief and colour costs about 16 blur rows (`COLOUR_WEIGHT`).
  - Steps:
    1. **The map** (M, titled "Map") shows a square of max(8,192, 8 × the AoI) wu centred on the player:
       - a relief chart from its own depth window (T11);
       - linked players as dots with names, and players known from the directory or gossip but not linked as hollow marks with names, fading with their age;
       - the world's spawn centre and edge when within the square;
       - live pings.
    2. **The minimap** takes its chart from its depth window and shows the world's edge when near. Nothing else changes.
    3. **The edge arrows** point to linked players off screen, the nearest 6, as now.
    4. DESIGN §3 (M) and §9; `docs/TESTING.md` (the `map` hook gains `known`).
  - Acceptance (tests first):
    - Unit tests:
      - the map's square is 8,192 wu for a starter and 8 × the AoI for a T2 adult;
      - a known player who isn't linked shows as a hollow mark, and a linked one as a dot.
    - `m6-find`, `m6b-minimap` and `m6c-minimap` pass in the world.
    - Screenshots of the map at the spawn and 100,000 wu away are attached.
    - `speedTest`: a frame of the open map's chart refill takes at most 4 ms.

### Closing

- [ ] T19 End-to-end scenario, documentation sync
  - Steps:
    1. `m11-lifecycle.spec.ts`: `@slow`, hub 8832, `LEAF_MAX=2`, `MATING_SCALE=0.01`, the witness variables and `?quality=medium`. Four players A, B, C and D, in order:
       - all four hatch by the spawn and link within 3 s;
       - A and B mate, and C or D audits;
       - **far away**: A's child and C teleport 30,000 wu off, swim across two leaves and find each other there through the directory, with no link in common;
       - **the fight**: A's child engages C, and D, still by the spawn, referees over its duty links. The fight settles on the same hash on every page;
       - **tiers**: B grows to T2 (`setBiomass`) beside D, sees D as a swarm and never links to it;
       - **checks**:
         - every page closes;
         - the cards verify;
         - `npm run verify:lineage -- <id> --hub <local> --replay` exits 0;
         - `GET /v1/audit` shows no `teleport` flag;
       - throughout, no page holds more links than its cap allows, sampled every second.

       A fight can end before a step needs it, so the scenario engages again, at most 3 times.
    2. Sync:
       - DESIGN §2, §3, §5, §7, §8, §9, §10 and the glossary (drop the M11 marks for what shipped);
       - `docs/VERIFY.md` (rules 12, epoch 4);
       - `docs/TESTING.md` (the hooks, and hubs 8828–8832; the next file takes 8833);
       - `.claude/rules/{sim,net,worker,ledger}.md`.
    3. List the owner checks for the Playtest issue (the rubric's `(owner)` lines), and the renewal for the release notes.
  - Acceptance:
    - Every exit criterion maps to a named test or report (the table below).
    - Each PR E2E part stays under 5 minutes, and the long scenarios are `@slow`.

## Exit criteria → evidence

| Exit criterion (ROADMAP) | Tasks | Evidence |
|---|---|---|
| One continuous world | T1, T4, T11, T12, T14 | migration 11's one seed and clock (T1); a 262,144 wu world in every welcome (T12) with no rosters (T14); the fields' tests at 262,144 wu (T4); `m11-world`; `m11-lifecycle`'s fight 30,000 wu from the spawn |
| Quadtree directory plus tiers decide connections | T1, T6, T8, T13 | `Directory`'s split, merge and `near` tests; `linkTiers`; the classes; `m11-tiers` (A–C never linked); harness gate 7 |
| The cap holds, including boundary neighbours, witnesses and handoffs | T8, T10, T13, T16 | the plan's property tests; harness gates 1 and 8; `m11-cap`; `m11-lifecycle`'s sampled link counts |
| No hidden threats (property test) | T3, T8, T10 | harness gate 2 and its `heavyTest`; P1 symmetry and the plan's properties; `engage:unseen` hub tests |
| Seamless handoffs | T10, T13, T15 | harness gate 3 (no pops, linked before in view); `m11-handoff`'s alphas, links and rates |
| Outline: tiers and interaction rules (T1, T5, T8); large-world fields, chunked and cached (T4, T11); the directory's split above 16 and merge below 6 (T6); the AoI manager with priorities, the cap and property tests (T8, T10); mesh-relayed signaling, handoffs and boundary neighbours (T7, T9, T13); the tiered viewport and ambient swarms (T17), snapshot rate by distance (T15), tier-sized food (T5); the headless harness (T10); migration from ponds to the world (T1, T12, T14); the M10 carry-overs (T3, T13) | T1–T18 | as listed in each task |

## End-to-end check

`m11-lifecycle.spec.ts` (T19, `@slow`, hub 8832) plays four players in one world:
- they find each other by the spawn as friends did in a pond;
- two of them meet 30,000 wu away through the directory alone and fight, refereed by a witness back at the spawn;
- a giant sees a small player only as a swarm;
- every page closes, and the cards and the CLI verify.

No page ever holds more links than its cap.

Each path is also checked alone:
- `m11-handoff` (T13, T15): leaf crossings, links before view, rates;
- `m11-cap` (T13): eviction by class;
- `m11-relay` (T13): a link made through a peer's relay;
- `m11-tiers` (T17): who links across tiers, swarms and the look per tier;
- `m11-world` (T11): the far corner of the world.

The harness (T10) checks the invariants at populations no E2E can reach.

## Rubric

- [ ] A friend who hatches nearby is linked and on screen within 3 s, as in a pond (evidence: harness gate 4; `m11-lifecycle`'s first step).
- [ ] Nothing pops: no creature on screen vanishes or reappears while both live within each other's AoI, and newcomers are linked before they come into view (evidence: harness gate 3; `m11-handoff`'s sampled alphas).
- [ ] The cap holds everywhere: never more than 32 links, and never more than 24 unless P0 and P1 need them (evidence: harness gate 1; `m11-cap`; `m11-lifecycle`'s link counts).
- [ ] A giant's view reads like a starter's: caustics, food and snow at the same screen scale, and the small players around it as faint swarms (evidence: `m11-tiers`' screenshots at T0, T1 and T2).
- [ ] The far corner of the world looks and moves like the centre: the right zone colours, crisp bodies, no jitter (evidence: `m11-world`'s screenshots and its drift of at most 0.05 px).
- [ ] The map reads as a chart of the region around you and who is near (evidence: T18's screenshots).
- [ ] The directory and signaling stay within budget: a median of at most 6 incoming messages per player-minute (evidence: `docs/perf/aoi.md`).
- [ ] (owner) Playing with friends in the world feels like the pond did: you find each other and see each other move smoothly.
- [ ] (owner) Swimming far, other players appear and fade smoothly over real networks, and nothing pops.
- [ ] (owner) Growing into a bigger tier feels like the world opens up.

## Risks

- **The client's move from rosters to links** touches every hub E2E. T13 changes how links form while the hub still groups ponds, and T14 removes the ponds once links work. Both keep every existing spec green.
- **Discovery latency.** A directory position can be 30 s old.
  - Gossip refreshes neighbours every 4 s.
  - P1 starts 600 wu early, and P3 and P4 pre-connect.
  - Harness gates 3 and 4 measure it. If they fail, the lead or the gossip interval changes, with an ADR.
- **Peer relays that fail** behind NATs: an offer unanswered after 4 s goes through the hub, and the harness counts the hub's share against the budget.
- **A crowd past 32** that can all act on one player: `crowded` keeps the nearest, and `engage:unseen` keeps an unseen attacker out. Instances are M12, and the harness reports how often it happens.
- **Asymmetric views**: a giant's AoI covers a small creature that doesn't cover the giant. P1 is symmetric by construction, the receiver asks its own rate, and an inbound offer is admitted by the receiver's own class.
- **Lying clients**: positions in reports and gossip are a client's word.
  - Jumps are dropped, and links verify by snapshots.
  - A signed relay can't be forged.
  - A seat ticket keeps unseated identities out.
  - ADR 0062 states what remains.
- **The look at world scale**:
  - float32 precision far from the origin, met by the floating origin;
  - depth windows that lag on slow machines, met by refills capped per frame;
  - zone texels too coarse for giants, which T17 checks in screenshots.
- **The renewal** costs players their creatures a fourth time. It is announced in the game, the release notes and the Playtest issue.
- **The tier economy**: food 64× richer per tier is derived, not measured. The pacing tool's tier rows gate it, and the T5 worker tunes it.
- **Merge conflicts between parallel tasks.**
  - The shapes above are fixed here, and migration 11 is all T1's.
  - `protocol-defs.ts` is T2's, then T14's; `worker/engage.ts` is T3's, then T14's; `worker/sessions.ts` is T6's, then T14's.
  - `src/game/online.ts` and `app-online.ts` are T13's. T15 and T16 both touch `pond-sync.ts`: a small merge, by the task that lands second.
- **Large tasks** (T6, T9, T13, T14) may overrun one session. Every run pushes its work in progress (ADR 0042), and a task that fails across three runs is split (the `next` skill).
