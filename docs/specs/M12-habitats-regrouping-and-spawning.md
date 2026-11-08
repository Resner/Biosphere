# M12: Habitats, regrouping and spawning

Release: v0.13.0 · Gate: no

## Goal

The world fills well at any population: players start near each other, lone players can rejoin the others, crowds split into bounded instances, and no transition moves a creature out of a fight or anywhere its own client chooses.

- **Spawning around groups.** The authority places every creature that enters the water from elsewhere (a genesis, a restored ancestor, a resume after 10 minutes away):
  - on rings around the group of players best matched to its size;
  - out of view and out of reach of anything that could attack it;
  - away from the spawns of the last minute, in water that doesn't hurt it;
  - close enough to a friend to link at once.

  The first player in an empty world spawns on the spawn centre, the world's centre. The populated area grows outward as it fills, and a drawn point keeps spawns unpredictable, so nobody can camp "the spawn". Spawn protection stays 15 s.
- **Riding the current.** A player alone for 120 s is offered "Ride the current" (R). The authority sends it, protected, to the best group, unless it is fighting, courting, fresh from a fight, or someone is near.
- **Crowd instances.**
  - **When**: a page that wants 24 links to creatures that can act on it is crowded. It tells the authority which creatures are close to it.
  - **How**: the authority splits the crowd into instances of at most 16. Creatures of different instances can't see or affect each other, and the open water around a crowd sees every instance.
  - **Membership** is sticky. The fighters of one fight, a courting pair and creatures that are close to each other are never separated, and a fighter's instance never changes during its fight.
  - **Merging**: a crowd merges back into the open water once it has been quiet for 30 s.
- **Anchored transitions.**
  - A reload within 10 minutes comes back where the creature left the water.
  - A promoted child hatches where its parent was.
  - After a fight a creature starts from where the fight left it.
  - The first report after any of these must lie near that place, or it is dropped and flagged.

  No spawn, ride or instance change writes a record or changes a creature's state.
- **A population-wave simulation** grows the world from 5 to 300 players and shrinks it to 20. It checks that spawns keep their distance, crowds stay bounded and lone players regroup, all within the authority's message budget.

The decisions behind this milestone:
- ADR 0013 is the contract.
- ADR 0064 decides groups, placement and the spawn centre, riding, crowd instances and anchors. It amends 0013 (instances of a crowded area rather than a leaf; open water shares water with every instance) and 0062 (`near`, gossip and the hello carry the instance).

`docs/DESIGN.md` §3 and §8 hold the values, marked M12.

This milestone has **no gate**. v0.13.0 opens its `Playtest:` issue, and M13 starts without waiting. **No world renewal**: no sim rule changes (rules stay 12), and only the protocol moves to 12.

## Carried over

No owner input came: Playtests v0.10.0 (#379) and v0.11.0 (#418) have no replies, and v0.12.0's issue opens with its release. M11's close review handed nothing on: its findings were fixed or left as designed (ADRs 0062, 0063). M11 left these to M12:

| From M11 | Task |
|---|---|
| A crowd of more than 32 interactable creatures is flagged, not split (ADR 0062) | T3, T5, T6 |
| Harness gate 3 is not asserted in the dense scenarios (`crowd`, `witnesses`): a pair that drifts past the P1 hold and back can come into view before its link is up, about 3 entries in 1,000 (ADR 0063) | T8 |
| Spawning stays a ring around the world's centre; positions are not kept across reloads | T2, T4, T10 |

## Out of scope

- **M13**: the load simulation at 10,000 players, metering (`/v1/metrics`), `docs/CAPACITY.md`, the admission queue's measured wait, and any sharding of the authority. The wave simulation here judges grouping, not cost.
- Automatic regrouping: nobody is moved without pressing for it (ADR 0064).
- Moving the spawn centre: it stays the world's centre.
- Food shared across instances: each instance's claims reach its own linked peers only, as all claims do.
- Small creatures seeing giants two or more tiers up; chat beyond the linked peers.
- New genes, combat rule changes, look passes beyond the ride's transition and the instance fade.
- Positions kept for good: a creature that left the water more than 10 minutes ago is placed again.

## Touches

- **New:**
  - net: `src/net/instance.ts`: `sameWater` and the constants (T1);
  - worker:
    - `worker/placement.ts`: groups, the clearance and placement, pure (T2);
    - `worker/crowds.ts`: the crowd instances, pure (T3);
    - `worker/spawn.ts`: `spawn` and the anchors (T4);
    - `worker/ride.ts` (T7);
  - game:
    - `src/game/crowd-view.ts`: the page's instances, the fade and the toast (T6);
    - `src/game/ride.ts`: the offer, the request and the transition (T7);
  - render: the ride's streaks, in `src/render/ride-fx.ts` (T7);
  - tests and tools:
    - `tests/wave.ts`, `tools/wave-report.ts` and `tools/wave.mjs` (`npm run sim:wave`, writing `docs/perf/wave.md`) (T9);
    - `worker/transitions.test.ts` (`heavyTest`, T10);
  - E2E: `tests/e2e/m12-steps.ts`; `m12-spawn` 8833, `m12-crowd` 8834, `m12-ride` 8835 and `m12-lifecycle` 8836, all `@slow`.
- **Changed:**
  - net: `protocol-defs.ts` (protocol 12), `protocol-world.ts`, `protocol-parse.ts`, `aoi.ts`, `where.ts`, `gossip.ts`, `peer-mesh.ts` (the hello's instance), `proxy-snaps.ts`;
  - sim: `spawn.ts` exports its plume predicate (`clearOfPlumes`), with no behaviour change (T2);
  - worker:
    - `sessions.ts` (no ring slots, no spawn hint, the relay by water), `where.ts`, `authority.ts` (dispatch, `hub.crowds`), `socket.ts` (the session's anchor, crowd, `aloneSince`);
    - `engage.ts` (`engage:instance`), `offspring.ts` (courts by water), `settle.ts` (carrion by water), `fights.ts` (each player's last fight end kept 120 s; the fighters' final positions);
    - `lives.ts` (protection from the spawn), `schema.ts` (migration 12), `e2e-entry.ts`, `tools/worker-bundle.test.ts`;
  - game: `online.ts`, `online-links.ts`, `neighbours.ts`, `app-online.ts`, `app-life.ts`, `app-session.ts`, `online-config.ts` (`ringSpawn` goes), `alone-hint.ts`, `hud-menu.ts`, `debug.ts`, `app-hook.ts`;
  - harness: `tests/aoi-harness.ts`, `aoi-scenarios.ts`, `aoi-types.ts`, `tools/aoi-report.ts`, `docs/perf/aoi.md`;
  - docs: DESIGN §2, §3, §7, §8, §9 and the glossary; `docs/TESTING.md`; `.claude/rules/{net,worker,game}.md`.

`src/game/online.ts` is at 673 lines: T6 and T7 put their work in their own files (`crowd-view.ts`, `ride.ts`) and only wire it there. `worker/ledger.ts` (989) gains nothing. Each new file stays under about 600 lines.

**Shared shapes.** Tasks that run in parallel build to these. A later task maps between them rather than redefining them.

```ts
// src/net/protocol-defs.ts (T1): PROTOCOL_VERSION 12
export const CROWD_LIST_MAX = 32;          // ids in a `where`'s `crowd`
export const INSTANCE_WIRE_MAX = 65_535;   // an instance on the wire: 0 (the open water) to this, whole numbers
export type SpawnWhy = 'placed' | 'back' | 'ride';
export type RideNo = 'locked' | 'busy' | 'company' | 'soon' | 'none';
// ClientMsg changes and gains:
//   where gains `crowd?: string[]`       // 1 to CROWD_LIST_MAX distinct player ids: the sender's engage candidates,
//                                        //   or the sender alone when it is crowded with none (T3)
//   { t: 'spawn'; r: number; aoi: number }   // the creature is entering the water; r and aoi count only for an unrecorded cell
//   { t: 'ride' }                        // ride the current to a group
// HubMsg changes and gains:
//   welcome: `you` becomes optional (T4 stops sending it)
//   { t: 'spawn'; x: number; y: number; why: SpawnWhy; protect: boolean }   // where the creature enters, also a granted ride
//   { t: 'ride-no'; why: RideNo }
//   { t: 'instance'; n: number }         // this session's instance, on every change (0: the open water)
//   near: each peer gains `n`, its instance
//   `refused` reasons gain 'engage:instance' and 'spawn' (a creature locked in a fight asks for a place),
//   as 'engage:moved' travels: an `error` code can't hold the colon
// PeerEvent changes and gains:
//   hello gains `n: number`              // the sender's instance
//   peers: each entry gains a fifth element, [id, x, y, r, n]
//   { t: 'instance'; n: number }         // the sender's instance changed

// src/net/instance.ts (T1): shared by the page, the hub and the harness
export const CROWD_AT = 24;                // a page wanting this many links of P0 and P1 that share its water is crowded
export const CROWD_EVERY_MS = 10_000;      // its `where` carries its crowd at once, then this often while crowded
export const INSTANCE_MAX = 16;            // members an instance is filled to (fixture `INSTANCE_MAX` 1–16)
export function sameWater(a: number, b: number): boolean;   // a === b || a === 0 || b === 0

// worker/placement.ts (T2): pure, no Hub (the harness and the wave run it in Node)
export const CLEAR_RADII = 12;             // the clearance is never less than this × the larger radius
export const SPAWN_RECENT_MS = 60_000;
export const SPAWN_EDGE_WU = 1024;
export const SPAWN_RINGS = 128;
export const SPAWN_CANDIDATES = 8192;
export interface Placed { id: string; x: number; y: number; r: number; aoi: number; n: number }   // a directory member
export interface Spawner { r: number; adultR: number; aoi: number }
export interface Group { ids: string[]; x: number; y: number; radius: number; sameTier: number; linkable: number }
export function clearance(a: { r: number; aoi: number }, b: { r: number; aoi: number }): number;
//   max(a.aoi, b.aoi, CLEAR_RADII × max(a.r, b.r))
export function groupsFor(members: readonly Placed[], s: Spawner): Group[];   // best first (ADR 0064)
export function place(p: {
  members: readonly Placed[];              // everyone else in the water, by their last reports
  recent: readonly { x: number; y: number; r: number; aoi: number; t: number }[];
  spawner: Spawner;
  centre: Vec2;                            // the spawn centre
  world: { seed: string; size: number; tick: number };
  now: number;
  rng: Rng;
}): { x: number; y: number; group: Group | null; fallback: 'none' | 'centre-rings' | 'centre' };

// worker/crowds.ts (T3): pure, no Hub. T3 shapes the class; these calls are what T5 and the harness use.
export const SPLIT_WAIT_MS = 3000;
export const RESPLIT_GAP_MS = 10_000;
export const QUIET_MS = 30_000;            // fixture `QUIET_MS` (at least 500)
export const CROWD_LIST_TTL_MS = 10_000;
export interface CrowdMember { id: string; x: number; y: number; r: number }
export interface Moved { id: string; n: number }
export class Crowds {
  constructor(opts?: { instanceMax?: number; quietMs?: number });
  instanceOf(id: string): number;
  crowdOf(id: string): number;             // the id of its crowd, 0 for none: what the attachment keeps (T3)
  report(m: CrowdMember, crowd: readonly string[] | null, now: number, ctx: CrowdContext): Moved[];
  due(): number | null;                    // when the next split or re-split falls due
  settle(now: number, ctx: CrowdContext): Moved[];
  remove(id: string, now: number, ctx: CrowdContext): Moved[];
  restore(members: readonly { m: CrowdMember; crowd: number; n: number }[], now: number): void;
  view(): { id: number; instances: { n: number; members: number }[] }[];
}
export interface CrowdContext {
  locked(id: string): boolean;             // in a fight, or a lock waiting for its answer
  partners(id: string): readonly string[]; // its fight's other fighters, its court partner
  around(x: number, y: number, radius: number): CrowdMember[];   // the directory's members there
}
```

**Migration 12** (T10): `players` gains `left_x`, `left_y`, `left_at` and `left_creature`, all nullable. A seated session whose creature is in the water writes them when it closes, once, in the transaction that writes its checkpoint.

**Fixture-mode variables** (honoured only with `DRAND_SOURCE=fixture`, guarded by `tools/worker-bundle.test.ts`):
- `INSTANCE_MAX` (1–16) and `QUIET_MS` (at least 500), from T5;
- `RIDE_ALONE_MS` (at least 1,000), from T7.

A `where` jump is still taken in fixture mode, for debug teleports, and so is a report past an anchor.

**Page hooks** (`?debug=1`):
- `debug.crowdAt(n)` (2–24, T6) sets the page's `CROWD_AT`;
- `debug.aloneMs(ms)` (T7) sets how long the page waits before offering a ride.

**Hubs**: `m12-spawn` 8833, `m12-crowd` 8834, `m12-ride` 8835 and `m12-lifecycle` 8836, all `@slow`; the next hub file takes 8837.

## Tasks

T1 and T2 need nothing and can start at once. T3 follows T1, and T4 follows T1 and T2. T5 follows T3, T6 follows T5, and T7 follows T4. T8 follows T2 and T3, and T9 follows T8. T10 needs T5 and T7. T11 closes.

### The wire and the pure parts

- [x] T1 Protocol 12: spawning, riding and crowd instances on the wire [opus] (after none)
  - Steps:
    1. `PROTOCOL_VERSION` 12. A protocol-11 hello gets `error: version`.
    2. The messages and events in the shapes above. Their parsers go in `protocol-world.ts`, dispatched from `protocol-parse.ts`, and refuse unknown fields at every level they define:
       - an instance is a whole number from 0 to `INSTANCE_WIRE_MAX`;
       - a `crowd` holds 1 to 32 distinct, well-formed player ids;
       - `spawn` (hub) has `x` and `y` within the wire's positions, a `why` and a boolean `protect`;
       - `spawn` (client) has `r` within the wire's radii and `aoi` within its AoIs;
       - `ride-no` has one of the five reasons;
       - `hello` needs its `n`, and a gossip entry needs its fifth element.
    3. `src/net/instance.ts`: `sameWater` and the constants.
    4. Every sender follows, with no change in behaviour:
       - the page's `hello` and gossip entries carry instance 0;
       - the hub's `near` gives every peer `n: 0`.
    5. The worker meters `spawn` and `ride` in the 20-message budget. Until T4 and T7 handle them, it drops and counts them (`Authority.dropped`). A `where`'s `crowd` is parsed and ignored until T5.
    6. `.claude/rules/net.md`: the new messages and their caps.
  - Acceptance (tests first):
    - Every new message and event round-trips through its parser. Each field out of range, missing or extra parses to null, for example:
      - a `crowd` of 33 ids, or one id twice;
      - an instance of 65,536, −1 or 1.5;
      - a gossip entry of four elements;
      - a `ride-no` of `far`.
    - `sameWater`: (0, n) and (n, 0) are true for every n; (3, 3) is true and (3, 4) false; it is symmetric over 10,000 random pairs.
    - 10,000 fuzzed values per parser never throw.
    - Hub tests:
      - a protocol-11 hello is refused;
      - a `spawn` and a `ride` are dropped and counted;
      - a `where` with a `crowd` is answered with `near` as before;
      - 21 messages in 10 s still close the socket.
    - Every unit test and E2E passes otherwise unchanged.
  - Notes: the shapes are fixed here, and T2 to T7 build to them. This task parses and meters, and changes no behaviour.
  - Done: parsers in `protocol-world.ts`, `SPAWN_WHYS` and `RIDE_NOS` in `protocol-defs.ts`, `instance.ts`; every sender says 0 and the hub drops `spawn` and `ride`. The welcome's hint falls back to the centre.
    Gotcha: the new refusals are `refused` reasons, not `error` codes (`CODE_RE` has no colon); the spec's shapes now say so.

- [x] T2 Groups and placement, pure (after none)
  - Steps:
    1. `worker/placement.ts` (shapes above), as ADR 0064 decides:
       - **`groupsFor`**: single-linkage clusters of the members that pass `linkTiers` with the spawner, chained within half its `queryRadius`. The best first: the most members of the spawner's own tier, then the most linkable, then the nearest to the spawn centre, then the lowest member id.
       - **`place`**, rings around the best group's centroid (or the spawn centre with no group), from the centre itself outward: rings a quarter of the clearance apart, candidates half a clearance apart along each ring (at least 8 a ring), at most `SPAWN_RINGS` rings and `SPAWN_CANDIDATES` candidates. A candidate is valid when all of these hold:
         - it lies at least `SPAWN_EDGE_WU` inside the world's edges;
         - its depth lies from `RULES.bathymetry.zones.shallows + RULES.hazards.uvBand` to `RULES.hazards.pressureStart` (0.27 to 0.7: no UV and no pressure);
         - it is clear of plumes now and for 10 s, by `clearOfPlumes` with a reach of 2.5 × the spawner's radius;
         - it keeps the clearance from every member that could engage the spawner (exact tiers within `RULES.encounter.maxTierGap`, any instance) and from every recent spawn;
         - it is not within P1 reach (8 × the larger radius + 600 wu) of a member whose instance is not 0.

         The first ring with a valid candidate wins. Its candidates within P1 reach of a member of the group that shares water come first, and `rng` draws one.
       - **Fallbacks**: past the rings, the same search around the spawn centre (`fallback: 'centre-rings'`); past that, the spawn centre itself (`'centre'`).
    2. `src/sim/spawn.ts` exports the predicate `findClearSpot` uses as `clearOfPlumes(world, x, y, reach)`, with no change in behaviour (the replay goldens stay).
    3. DESIGN §8 holds the values; the task corrects them if its tests change one.
  - Acceptance (tests first), in Node:
    - **`clearance`**:
      - two starter adults (r 20, AoI 354): 354;
      - a hatchling (r 10, AoI 233) and a T1 adult (r 63, AoI 992): 992;
      - a T2 member (r 400) that reports an AoI of 1,000 and a starter: 4,800, the floor of 12 radii.
    - **`groupsFor`**:
      - starters at 0, 3,000 and 6,000 wu along a line chain into one group, and one at 12,000 wu is its own;
      - a T2 member is in no starter's group;
      - of a group of 5 starters and one of 8 T1s, a starter's best is the starters'.
    - **`place`**, property tests over 2,000 seeded worlds of 0 to 300 members (mostly starters, some T1 and T2, some in instances, random recent spawns):
      - the point is valid by every rule above, unless `fallback` is `'centre'`;
      - in an empty world it is the spawn centre;
      - when any valid candidate of the winning ring lies within P1 reach of a group member, the point does;
      - the same input and seed give the same point;
      - across 100 seeds in one world, at least 10 distinct points come out.
    - **The area grows outward**: 300 starters placed one after another into one world (each placed point then a member, standing still) keep every clearance. The median distance from the spawn centre of placements 281 to 300 is at least three times that of placements 2 to 20.
    - A group in the abyss gets a point in the safe band on a ring, or the centre's rings.
    - `speedTest`: one placement among 300 members takes under 20 ms in Node.
  - Notes: no Hub and no wire. T4 and T7 call it, and T8 and T9 run it in Node.
    - Done: `worker/placement.ts` (`groupsFor` takes an optional third argument, the spawn centre, for its tie-break), `clearOfPlumes` and `plumeFutures` in `src/sim/spawn.ts`.
    - Gotcha: the depth pin leaves the spawn centre at 0.26 to 0.54, so the exact centre is exempt from the 0.27 floor in an empty world; otherwise an empty world would not give it on some seeds.

- [x] T3 Crowd instances, pure: the authority's crowds and the page's filter [opus] (after T1)
  - Steps:
    1. `worker/crowds.ts`: `Crowds` (shapes above), as ADR 0064 decides:
       - **forming**: a crowded report from open water with no crowd member within the reporter's P1 reach schedules a crowd, due `SPLIT_WAIT_MS` later. At `settle` it takes the reporter and the open-water members `around` places within that reach, and splits them into max(2, ⌈n ÷ `INSTANCE_MAX`⌉) instances;
       - **units**: a member with its `partners`, and every pair in a crowd list received within `CROWD_LIST_TTL_MS` from either side. Each unit goes whole into the least-full instance, the largest unit first. A unit larger than `INSTANCE_MAX` keeps an instance to itself;
       - **joining**: an open-water member whose report places it within P1 reach of a crowd's member joins. It takes, in order, its partner's instance there; else the instance holding most of its own crowd list, when that instance has room; else the least-full;
       - **leaving**: a member further than 2 × (8 × the larger radius + 900 wu) from every other member of its crowd goes back to 0;
       - **more room**: a crowded report from inside a crowd adds an instance and re-bins at `settle`, at most once per `RESPLIT_GAP_MS` per crowd. A unit stays in its instance while that instance holds at most `INSTANCE_MAX`; overflow units move to the least-full;
       - **merging**: a crowd that has had at most `INSTANCE_MAX` members, no crowd list from its members and no locked member for `QUIET_MS` merges (all to 0). An empty crowd ends at once;
       - **locked members never change instance**: joins, leaves, re-splits and merges pass over them;
       - instance numbers are unique across crowds, from 1 to 65,535, and a number is reused only after its crowd ends.
    2. `src/net/aoi.ts`:
       - `Known` gains `n` (the instance its source gave) and `AoiSelf` gains `n`;
       - `classify` gives no class to a creature that doesn't share water with the player, except P0.
    3. `src/net/where.ts`:
       - `WhereReporter.update` takes the page's crowd list, or null while it isn't crowded;
       - a `where` goes at once (within the 2 s gap) when the page turns crowded, and every `CROWD_EVERY_MS` while it stays crowded, carrying the list;
       - a helper builds the list: the creatures within 8 × the larger radius by snapshots that pass `linkTiers` and share water, nearest first, at most 32.
    4. `src/net/gossip.ts`: entries carry their instance, and a receiver drops an entry that doesn't share water with it.
    5. `.claude/rules/{net,worker}.md`.
  - Acceptance (tests first), in Node:
    - **Forming**: 40 starters within 350 wu of a reporter, all in its P1 reach, and its crowded report with its list:
      - nothing moves before 3 s;
      - at `settle`, 3 instances, each of at most 16.
    - **Units** (property, over 10,000 random crowds): a fight of 2, a court pair and a chain of listed pairs each end up whole in one instance. A unit of 20 keeps an instance to itself, and the others fill the rest.
    - **Joining**:
      - an open-water member reporting within P1 reach of a member joins;
      - with a court partner inside, it takes the partner's instance (a fighter is locked, so it never joins: it stays in the open water, which shares water with its partner's);
      - else the instance holding most of its list, when it has room; else the least-full.
    - **Leaving**: a member reported beyond 2 × (8 × r + 900) wu of every other member goes to 0.
    - **Locked** (property, over 10,000 random sequences of reports, lists, locks, unlocks and removes):
      - a locked member's instance never changes;
      - every member has exactly one instance.
    - **More room**:
      - a crowded report from inside adds an instance and moves only overflow units;
      - a second within 10 s changes nothing.
    - **Merging**:
      - a crowd of 16 with no lists for 30 s merges, and every member is told 0;
      - one with a locked member waits for the lock to go.
    - **Restore**: a crowd rebuilt from its members' (crowd, instance) pairs gives every member the same instance.
    - **The page's side**:
      - `classify`: a creature in instance 2 has no class at 100 wu from a player in instance 1, and is P1 from a player in 0; a fight's opponent in another instance stays P0;
      - the reporter sends a `where` with `crowd` when the page turns crowded (at once, or 2 s after the last report), then every 10 s while crowded;
      - the list holds only creatures within 8 × the larger radius that share water, nearest first, at most 32;
      - gossip entries carry instances, and an entry from water the receiver doesn't share is dropped.
    - `speedTest`: a report into a crowd of 300 takes under 1 ms, and forming a crowd of 300 under 20 ms, in Node.
  - Notes: pure. T5 wires `Crowds` into the hub and T6 the filter into the page; T8 runs both.
    - Done: `worker/crowds.ts` (tests in the Node project), `Known.n`/`AoiSelf.n` (optional: none is the open water), `crowdList` and the crowd in `WhereReporter`, instances in gossip.
    - Gotcha: binning opens a new instance rather than overfill one, and joining counts list pairs from both sides; a page crowded with no engage candidate sends its own id alone as its list.

### Spawning

- [ ] T4 Spawning by the authority [opus] (after T1, T2)
  - Steps:
    1. `worker/spawn.ts` answers a `spawn` from a seated session:
       - **a locked creature** (in a fight, or a lock waiting for its answer) is refused `spawn`: its page goes back into the fight;
       - **the spawner**: the life's radius and adult radius (`LifeState`) when it has one, else the message's `r` and `aoi` (an unrecorded practice cell);
       - **the place**: `place()` over the directory's other members, the hub's recent spawns (in memory: the last 256, `SPAWN_RECENT_MS`), the world row's centre, and the world's seed, size and tick. The `rng` is seeded from `crypto.getRandomValues`;
       - **protection**: a genesis or a restore is `placed`, `protect: true`. A resume and a practice cell are `placed`, unprotected (T10 brings a resume `back`);
       - a repeat under the same binding answers the same place;
       - the answer puts the member in the directory at the given place at once, as a report would, so the next placement or ride already sees it there.
    2. **Protection starts at the answer** for a protected spawn, not at the binding. A long egg reveal no longer eats it. A promoted child's starts at the promote, as now.
    3. **Anchors** (`Session.anchor`: `{ x, y, t, bind }`): the answer sets the binding's anchor. A promote anchors at the parent's last report, which the session already holds. `where` checks the first report under a binding against its anchor, with the jump bound (300 wu/s since the anchor, plus 2,000 wu):
       - a report past it is dropped, counted and flagged `teleport` once per creature;
       - a report under a binding with no anchor yet is dropped and counted;
       - fixture mode still takes both.
    4. `place`, the ring slots (`Session.slot`) and the welcome's `you` go from `worker/sessions.ts`.
    5. **The page** (`app-life.ts`, `app-session.ts`): a life in the hub's world asks `spawn` as its creature enters the water, and begins at the answer (`findClearSpot` as now).
       - The egg or the title stays up while it waits, at most 4 s; after that the life begins in a local world, as an unreachable hub's does.
       - A promoted child begins where its parent was, and asks nothing.
       - `ringSpawn` and the welcome's hint go.
       - `state().spawn` is the last answer (`{ x, y, why, protect }`), null before one.
    6. DESIGN §2 (Hatching) and §8 (Seats), `docs/TESTING.md`, `.claude/rules/worker.md`.
  - Acceptance (tests first). Hub tests with a 262,144 wu directory, as M11's hub tests swap it in:
    - **Where lives go**:
      - the first player's genesis spawns on the world's centre;
      - a second starter's spawns at least the clearance from the first's report and within its P1 reach;
      - with a T1 member 600 wu from the centre and a group of three starters 6,000 wu away, a starter's genesis spawns by the starters;
      - two genesis spawns within 60 s, with no other member near, keep the clearance from each other;
      - 30 sessions hatching one after another each spawn outside every earlier one's clearance (by its report).
    - **Answers**:
      - a `spawn` asked twice under one binding gets the same place;
      - one asked while locked is refused `spawn`;
      - an unrecorded cell is placed by its `r` and `aoi`;
      - a restore's answer is protected and a resume's is not. An engage on the restored creature 10 s after its answer is refused `engage:protected`, even when its binding came 10 s earlier still.
    - **Anchors**:
      - a first `where` 2,500 wu from the given place, 1 s after the answer, is dropped, counted and flags `teleport` once;
      - one 500 wu away is taken;
      - after a promote, a `where` 5,000 wu from the parent's last report is dropped.
    - The welcome holds no `you`.
    - Unit tests: the page asks `spawn` once per life and begins at the answer; a promoted child begins where its parent was; with no answer in 4 s the life begins in a local world.
    - **`m12-spawn.spec.ts`** (`@slow`, hub 8833): A hatches on the world's centre. B, C and D then hatch one after another:
      - each `state().spawn.why` is `placed`;
      - each lies at least the clearance from every earlier player's directory position (`GET /v1/e2e/directory`) and from every earlier spawn, and within P1 reach of one of them;
      - every pair links within 3 s of the later hatch;
      - D reloads and is placed again, unprotected (no shimmer on A's screen).
    - Every E2E, fast and full, passes. A spec that relied on a ring slot reads `state().spawn` or teleports instead.
  - Notes: no instances (T5), rides (T7) or resumes in place (T10). `worker/where.ts` is shared with T5: the anchor check stays in its own function, so the merge is small.

### Crowd instances in the world

- [x] T5 Crowd instances on the authority [opus] (after T3)
  - Steps:
    1. `worker/where.ts` runs `hub.crowds` (`Crowds`) beside the directory:
       - every `where` reports to it with its `crowd` list (ids that aren't seated are dropped). The context comes from the hub: `locked` from `hub.fights` (a fight, or a lock waiting for its answer), `partners` from the fight's other fighters and the session's court, and `around` from the directory;
       - one split timer on `hub.clock`, set to `crowds.due()` (a one-shot, as a lock's deadline is: no loop);
       - each member whose instance changed hears `instance { n }`, and its attachment keeps `crowd: { id, n }`;
       - `gone` and a close remove the member, except a fighter: its instance is kept while its fight runs, and signing in again during the fight it takes it back (after a wake, from its fight's other fighters);
       - a wake rebuilds the crowds from the attachments (`restore`).
    2. **Sharing water**, wherever the hub decides:
       - `near` lists only peers and swarm points that share water with the reporter, each peer with its `n`;
       - the relay answers `no-peer` between sessions that don't share water, except a duty pair;
       - a court that doesn't share water gets `not-near` (`mate-check` and `court`);
       - an engage that doesn't share water with its target, and a join that doesn't share water with every fighter still in, are refused `engage:instance`; the page's toast is "Can't reach it from here";
       - a kill's carrion notice goes only to sessions that share water with the victim, besides the fight's own players.
    3. Fixture mode: `INSTANCE_MAX` and `QUIET_MS`. `GET /v1/e2e/directory` adds the crowds (`view()`) and each member's instance.
    4. `.claude/rules/worker.md`, `docs/TESTING.md`; DESIGN §7 (the toast).
  - Acceptance (tests first). Hub tests in workerd:
    - **Forming**: 20 sessions within 700 wu of the first reporter and at least 170 wu apart (so no list pairs them), three of them sending crowded reports. 3 s later:
      - there are two instances of 10;
      - each member has heard its `instance`;
      - each `near` lists only its own instance's members and the open water, with their `n`.
    - **Units**: A and B in a fight end up in one instance, and so does a courting pair. B's page closing and signing in again during the fight finds B in A's instance.
    - **Refusals**:
      - an engage from instance 1 on instance 2 is refused `engage:instance`, and one from 0 on 2 goes on;
      - a join from instance 2 into a fight of a 1 and a 0 is refused;
      - a court between instances gets `not-near`;
      - a signal between instances gets `no-peer`, while a duty pair's passes.
    - **Carrion**: a kill in instance 1 reaches open-water and instance-1 sessions within 10,000 wu, and no instance-2 session.
    - **A wake** (the crowds rebuilt from the attachments): every member keeps its instance, and the next `near` answers the same.
    - **Merging**:
      - a crowd quiet for `QUIET_MS` merges, and every member hears `instance { n: 0 }`;
      - a crowd with a locked member waits until its fight ends.
    - `rowsWritten` is unchanged by reports, splits and merges, and 21 messages in 10 s still close a session.
  - Notes: no page change (T6). Pages still send instance 0 and no crowd, so outside tests no crowd forms until T6.
    - Done: `where.ts` runs `hub.crowds` (`armCrowds`, `rebuildCrowds`, `reseatCrowd`, `sharesWater`; `Directory.near` takes `instanceOf`); the page's toast for `engage:instance`; hub tests in `worker/instances.test.ts`.
    - Gotcha: a fighter whose page leaves keeps its instance in `hub.crowdsKept` until its fight ends; a crowd of more members than `INSTANCE_MAX` never merges, so merge tests keep under it.

- [ ] T6 Crowd instances in the page [opus] (after T5) (in progress)
  - Steps:
    1. **`src/game/crowd-view.ts`** keeps the page's own instance (the hub's `instance`) and each known creature's: from `near`, gossip, a link's `hello` and `instance` events. `AoiManager` takes them:
       - a link that no longer shares water closes at once, with no 3 s grace, unless it is P0;
       - a gossip entry from water the page doesn't share is never dialled.
    2. **Reports**: the page's `where` carries its crowd while its wanted P0 + P1 (sharing water) reach `CROWD_AT`. `debug.crowdAt(n)` sets that number.
    3. **Links**:
       - `hello`, `instance` events and gossip entries carry the page's instance;
       - a duty link that doesn't share water carries the duty only, and neither side draws the other;
       - proxies of an away fighter go only to spectators that share water with it.
    4. **The look**:
       - a creature that no longer shares water fades out over 1 s from the change;
       - when the page's own instance leaves 0, a toast says "Busy waters: you see part of the crowd here", at most once a minute.
    5. `state().net.instance` (`{ n, changes, crowded, crowdSent }`) and `state().remotes[].instance`. `docs/TESTING.md`, DESIGN §8 and §9, `.claude/rules/{net,game}.md`.
  - Acceptance (tests first):
    - Unit tests with the fake hub and mesh:
      - `instance { n: 2 }` closes the links to instance-1 peers at once and keeps those in 0 and 2;
      - a hello naming another instance closes the link;
      - a gossip entry from another instance is never dialled;
      - a fight's opponent in another instance stays linked;
      - a page past `CROWD_AT` sends its crowd in its next `where`.
    - **`m12-crowd.spec.ts`** (`@slow`, hub 8834, `INSTANCE_MAX=2`, `QUIET_MS=3000`): four pages on `debug.crowdAt(3)`. A and B are 100 wu apart, C and D 100 wu apart, and the pairs 300 wu apart, so all four link:
      - within 6 s of their links the hub splits them into {A, B} and {C, D};
      - A then holds a link to B alone;
      - in A's view, sampled every 100 ms, C's and D's alpha fall to 0 over at least 0.8 s, never from 1 to 0 between two samples;
      - D swims 6,000 wu out and is back in instance 0, and then C does the same;
      - A and B's crowd, now two, merges within 6 s, and both are in 0;
      - a screenshot during the fade is attached.
    - Every M11 E2E passes: no crowd forms at the default `CROWD_AT`.

### Regrouping

- [ ] T7 Ride the current [opus] (after T4)
  - Steps:
    1. **`worker/ride.ts`** answers a `ride`. The refusals, in this order:
       - `locked`: in a fight or a lock;
       - `busy`: a court outstanding;
       - `soon`: alone under `RIDE_ALONE_MS` (120 s), or its last fight ended under 120 s ago (`Fights` keeps each player's last end for 120 s);
       - `company`: the directory places a member it can link with and shares water with within its `Q` now;
       - `none`: no group to ride to.

       Otherwise the answer is `spawn { why: 'ride', protect: true }` at `place()` around the best group of the others. The anchor is set, the ride is protected for 15 s, and the member is in the directory at its arrival at once (as T4's answers are), so two lone players asking together don't swap places.
       - **Alone**: `aloneSince` lives in the attachment. A `near` with no peers sets it, and one with any clears it.
       - Fixture `RIDE_ALONE_MS`.
    2. **The page**, `src/game/ride.ts`:
       - **the offer**: once the alone hint's condition has held for `RIDE_ALONE_MS`, the hint shows "Alone here." with a "Ride the current" button (R) for 12 s, and again every 2 minutes while the page stays alone. The menu offers it whenever the page thinks it is alone;
       - **the request**: R or the button sends `ride`;
       - **the transition**, on the answer:
         - 1.2 s of the creature swept along the current with streaks of marine snow (`src/render/ride-fx.ts`), the screen easing toward the water's colour;
         - then the creature drifts in at the arrival, and a carried egg comes along;
         - input is held while it plays;
         - under Reduce motion it is a 0.4 s cross-fade;
       - **`ride-no`** gives a toast: "Not while fighting", "Not while courting", "Not yet", "Someone is near" or "No one to ride to yet";
       - `debug.aloneMs(ms)`; `state().ride`: `{ offered, phase: 'idle' | 'asking' | 'riding' | 'arrived', last }`.
    3. DESIGN §3 (the controls' row) and §8, `docs/TESTING.md`, `.claude/rules/{game,worker}.md`.
  - Acceptance (tests first):
    - **Hub tests**:
      - each refusal, in its order;
      - a granted ride lands at least the clearance from every group member and within P1 reach of one, protected. A `where` there is taken, and an engage on the rider 10 s later is refused `engage:protected`;
      - a ride writes no row.
    - **Unit tests**:
      - the hint offers the ride after the wait, for 12 s, and again 2 minutes later while still alone;
      - R sends one `ride`;
      - the transition takes 1.2 s (0.4 s under Reduce motion), and the creature is at the arrival after it.
    - **`m12-ride.spec.ts`** (`@slow`, hub 8835, `RIDE_ALONE_MS=3000`):
      - A and B hatch, and B is teleported 40,000 wu out into the twilight;
      - after 3 s alone (`debug.aloneMs(3000)`) B's hint offers the ride, and B presses R;
      - `state().ride.phase` goes `riding`, then `arrived`;
      - B lies at least the clearance from A's directory position and within its P1 reach;
      - A sees B's protection shimmer, and the two link within 3 s;
      - B presses R again and reads "Someone is near";
      - screenshots mid-ride and at the arrival are attached;
      - on medium, the transition keeps the medium budget.

### Evidence at scale

- [ ] T8 The harness learns placement, crowd instances and rides (after T2, T3)
  - Steps:
    1. `tests/aoi-harness.ts`:
       - a scenario may place its spawns with `place()`;
       - the directory's members feed `Crowds`, whose changes reach the clients after the hub's latency;
       - clients send their crowd lists, `near` and gossip follow the water, and links that stop sharing water close;
       - a ride model: a client alone for `RIDE_ALONE_MS` rides at once, by `place()`.
    2. **Scenarios**:
       - **throng** (new): 80 comparable starters within 1,500 wu for 90 s;
       - **friends** spawns through `place()`.

       A switch runs any scenario without instances, for comparison.
    3. **Gates**:
       - **gate 2** counts the pairs that share water, a pair being excused for 10 s after its water changes, as a new pair is;
       - **gate 3** excuses the pairs that stop sharing water and is asserted in the dense scenarios too, at most 5 late entries in 1,000;
       - **gate 10, crowds**:
         - after a client's first 10 s, at most 1% of client-seconds crowded (P0 + P1 past 32);
         - at most 1 instance change per client-minute (p95);
         - a fight's fighters always share water and never change instance during it;
       - **gate 11, spawns**: every placed spawn keeps the clearance from every engage-capable member by the directory's positions, and a placed friend is linked within 3 s at the median and 5 s at the p95.
    4. `npm run report:aoi` regenerates `docs/perf/aoi.md` with `throng` and the new gates. The `heavyTest` gates a scaled `throng` too.
  - Acceptance:
    - The report's gates, each a failing test when it breaks.
    - `throng` without instances is crowded at least 50% of the time, which shows the scenario crowds; with them, at most 1%.
    - Gate 9's bandwidth row is reported for `throng`. Its links are all P1, so it is not asserted.
  - Notes: if a gate's number is out of the link model's reach, the task records what it measures and why in an ADR, as ADR 0063 did, and the gate reads that.

- [ ] T9 The population wave: 5 → 300 → 20 (after T8)
  - Steps:
    1. `tests/wave.ts`, on the harness:
       - **the wave**: 5 players join in the first 2 minutes; 295 more join over the next 10, 1 every 2 s, each placed by `place()`. 10% are T1, restored with a T1 ancestor's size;
       - **the fall**: from minute 14 players leave at random until 20 remain, by minute 18;
       - **the end**: the sim runs to minute 24;
       - players wander, and a player alone for `RIDE_ALONE_MS` rides;
       - every minute of the peak, 3 pairs of comparable players fight for 30 s.
    2. `npm run sim:wave` (`tools/wave-report.ts`, `tools/wave.mjs`) writes `docs/perf/wave.md`: the gates, then population, groups, crowds, instances, rides and messages per player-minute, minute by minute.
    3. A `heavyTest` runs a scaled wave (5 → 60 → 10 over 8 simulated minutes) against the same gates.
  - Acceptance. The report's gates, each a failing test when it breaks:
    1. **Clearance**: every spawn and ride arrival keeps the clearance from every engage-capable member and every spawn of the last 60 s, by the directory's positions, lies in the safe depth band, and never within P1 reach of a member in an instance. 0 violations.
    2. **Together**:
       - a T0 newcomer whose placement found a group is linked to one of its members within 3 s at the median and 5 s at the p95;
       - every newcomer within 15 s at the p95.
    3. **At the group's edge**: every spawn that found a group lies within the group's radius plus twice the clearance of its centroid: in a gap or at the edge, never far out.
    4. **Regrouped**: from 4 minutes after the fall, at least 90% of the players hold a link to a creature they can link with.
    5. **Bounded**:
       - at the peak at most 1% of client-seconds are crowded, and no client ever holds more than 32 links;
       - no crowd is left 2 minutes after the fall.
    6. **No hidden creature**: gate 2 among pairs that share water. 0 violations.
    7. **Integrity**:
       - no fighter changes instance during its fight;
       - no ride goes to a fighter, or within 120 s of its fight;
       - no fight's fighters are ever in instances that don't share water.
    8. **Budget**: incoming authority messages per player-minute (reports, crowd lists, `spawn`, `ride`, hub signals) are at most 6 at the median and 12 at the p95 after a player's first minute.
    - `npm run sim:wave` finishes within 10 minutes, and its `heavyTest` within 120 s.
  - Notes: the wave judges grouping, not cost (M13). It never touches sockets or WebRTC. Static growth outward is `place`'s own test (T2); in the wave, players wander, so the gate judges where each spawn lands against its group.

### Transitions

- [ ] T10 Transitions keep one place and one state [opus] (after T5, T7)
  - Steps:
    1. **A resume comes back.** Migration 12 (above): a close writes where the creature left the water from the session's last report, once, in its checkpoint's transaction. A `spawn` for a resume answers:
       - `back`, unprotected, at that place, when the same creature left under 10 minutes ago;
       - `placed` otherwise.
       
       A `gone` (the title screen) keeps the place in the session for the same socket.
    2. **After a fight**: `fights.ts` keeps each fighter's final position from the authority's own encounter, and the fighter's binding is anchored there at the end, so the first report after a fight lies near where it ended.
    3. **`worker/transitions.test.ts`** (`heavyTest`): 30 seeded runs of 80 random steps over 6 sessions, through the real hub. The steps:
       - reports that cross leaves and tiers;
       - crowd lists, gone and back;
       - `spawn`, `ride`, engages and fights to the end (on the fight kit's clock);
       - courts and matings, promotes, restores, genesis, deaths;
       - closes and sign-ins.

       After every step:
       - every seated session with a creature in the water is one directory member with one instance;
       - every running fight's fighters share water, and a connected fighter's instance never changes during its fight;
       - no `spawn` or `ride` is granted to a locked creature, and no ride within 120 s of its fight;
       - a head moves only through a life record (genesis, birth, promote, restore, death, encounter). Reports, crowds, spawns and rides write no record, and the close's place is its one extra row;
       - every report taken under a binding lies within the bound of its anchor.
    4. `m12-spawn.spec.ts`'s reload now expects `back`: D comes back within 300 wu of where it left, unprotected. A hub test covers the 10 minutes (the session's clock).
    5. Whatever the property test finds is fixed here, each with its own test first.
    6. DESIGN §5 (Progress and resume) and §8, `.claude/rules/worker.md` (migration 12).
  - Acceptance (tests first):
    - **Hub tests**:
      - a reload 1 s after a report comes `back` at that report's place, unprotected;
      - after 11 minutes it is `placed`;
      - a resume of another creature (a restore in between) is `placed`;
      - after a fight, a first report 2,500 wu from the fighter's final position is dropped and flags `teleport`;
      - migration 12 adds the columns, and a close writes one row more than before.
    - The property test passes with 0 violations.
    - `m12-spawn`'s reload passes with `back`, and every M8 resume and restart E2E passes.

### Closing

- [ ] T11 End-to-end scenario, documentation sync
  - Steps:
    1. **`m12-lifecycle.spec.ts`**: `@slow`, hub 8836, `INSTANCE_MAX=2`, `QUIET_MS=3000`, `RIDE_ALONE_MS=3000`, `MATING_SCALE` 0.01 and `?quality=medium`. Four players A, B, C and D, all on `debug.crowdAt(3)`, in order:
       - **spawning**: A hatches on the world's centre, and B, C and D are placed around it, outside each other's clearance, and all link within 3 s;
       - **mating**: A and B mate and take over their children;
       - **a crowd**: the four are brought within 300 wu, A's child beside B's child, C beside D. A's child engages B's child, and the crowd splits with the fighters in one instance, so C and D never see the fight;
       - **during the fight**: B reloads and comes back into the fight, in the same instance;
       - **after the fight**: D is teleported 40,000 wu out (leaving the crowd), rides the current back after 3 s alone, and arrives protected, outside every clearance and outside P1 reach of every member still in the crowd;
       - **quiet**: C swims out of the crowd too. Once the fight is over, the crowd (now A's and B's children) merges, and the four come together in open water and link;
       - **checks**:
         - every page closes;
         - the cards verify;
         - `npm run verify:lineage -- <id> --hub <local> --replay` exits 0;
         - `GET /v1/audit` shows no `teleport` flag;
       - throughout, no page holds more links than its cap allows, sampled every second.

       A fight can end before a step needs it, so the scenario engages again, at most 3 times.
    2. **Sync**:
       - DESIGN §2, §3, §5, §7, §8, §9 and the glossary (drop the M12 marks for what shipped);
       - `docs/TESTING.md` (the hooks, and hubs 8833–8836; the next file takes 8837);
       - `.claude/rules/{net,worker,game}.md`.
    3. List the owner checks for the Playtest issue (the rubric's `(owner)` lines). The release notes: protocol 12, no world renewal.
  - Acceptance:
    - Every exit criterion maps to a named test or report (the table below).
    - Each PR E2E part stays under 5 minutes, and the long scenarios are `@slow`.

## Exit criteria → evidence

| Exit criterion (ROADMAP) | Tasks | Evidence |
|---|---|---|
| Sparse consolidation | T2, T4, T7, T9 | `groupsFor` and `place` tests; hub tests placing a starter by the starters' group; `m12-ride`; wave gate 4 (regrouped), gate 2 (together); `m12-lifecycle`'s ride |
| Spawn ring outside attack range with anti-camping | T2, T4, T9 | `place`'s property tests (clearance, recent spawns, distinct draws, outward growth); hub tests with 30 spawns; `m12-spawn`; wave gates 1 and 3; harness gate 11 |
| Crowded instances | T3, T5, T6, T8 | `Crowds`' property tests (units, locks, merges); hub tests of forming, refusals and wakes; `m12-crowd`; `throng` and harness gate 10; wave gate 5 |
| Transitions keep one state and can't escape combat | T3, T4, T5, T7, T10 | locked members frozen (T3); anchors and `teleport` flags (T4, T10); `engage:instance` and rides refused while locked (T5, T7); the transitions property test; `m12-lifecycle`'s reload during the fight and the audit with no flag |
| Outline: group clustering and a persisted spawn centre (T2, T4); ring placement with scoring and expansion, spawn protection and anti-camping (T2, T4); "ride the current" (T7); crowded instances: sticky, never separating interacting creatures, merging when quiet (T3, T5, T6); transition integrity across tier, cell, instance and regroup changes (T10); the population wave 5 → 300 → 20 (T9) | T1–T10 | as listed in each task |

## End-to-end check

`m12-lifecycle.spec.ts` (T11, `@slow`, hub 8836) plays four players through every transition this milestone adds:
- they spawn around the first player, outside each other's reach, and link at once;
- a crowd splits with the fighters together, and the others never see the fight;
- a fighter reloads back into its fight in its instance;
- a lone player rides the current back, protected;
- the crowd merges when quiet;
- every page closes, and the cards and the CLI verify, with no `teleport` flag.

No page ever holds more links than its cap.

Each path is also checked alone:
- `m12-spawn` (T4, T10): placement, links at once, a resume back in place;
- `m12-crowd` (T6): a split, the fade, leaving and merging;
- `m12-ride` (T7): the offer, the transition and the arrival.

The harness (T8) and the wave (T9) check the invariants at populations no E2E can reach.

## Rubric

- [ ] A newcomer appears near players of its size, out of view and out of reach of anything that could attack it, and is linked to a friend within 3 s (evidence: wave gates 1 and 2; harness gate 11; `m12-spawn`).
- [ ] The populated area grows outward as it fills, and no two newcomers of the same minute arrive on top of each other (evidence: `place`'s growth test; wave gates 1 and 3).
- [ ] A lone player is one key from company, and the ride reads as a journey through the water, not a cut (evidence: `m12-ride`'s screenshots mid-ride and at the arrival; the Reduce motion cross-fade).
- [ ] A crowd thins smoothly: creatures in another instance fade over 1 s, never vanish in one frame, and a toast says why (evidence: `m12-crowd`'s alpha samples and screenshot).
- [ ] No crowd shows a page more than about 16 creatures of its instance plus the open water, and a page is crowded at most 1% of the time (evidence: `throng`, harness gate 10; wave gate 5).
- [ ] The authority stays within budget through the wave: a median of at most 6 incoming messages per player-minute (evidence: `docs/perf/wave.md`).
- [ ] (owner) Joining friends feels natural: you hatch near players of your size, quickly see them, and nobody pounces on you as you arrive.
- [ ] (owner) Riding the current to other players is clear and feels like part of the world.
- [ ] (owner) In a busy spot, creatures thinning out reads as calmer water, not a glitch.

## Risks

- **Positions are up to 30 s old.** Placement keeps the clearance from reported positions, so a member that swam since can be nearer.
  - Spawn protection (15 s) covers it.
  - Friends are kept within P1 reach so they link at once.
  - Wave gate 1 counts by the directory's positions, and ADR 0064 states the limit.
- **Every E2E hatches through `spawn`.** T4 moves every life onto the authority's placement, and the specs that relied on ring slots read `state().spawn` or teleport. T4 keeps every spec green, and T1 changes no behaviour first.
- **Crowds on stale data.** The split waits 3 s for the crowded pages' own lists, and units come from the pages' exact positions. A unit too tight to split stays together, over-full, with `crowded` and `engage:unseen` as its guard.
- **Churn at a crowd's edge.** Joins need P1 reach of a member, leaves twice the P1 hold, and re-splits at most every 10 s. Harness gate 10 bounds instance changes per client-minute.
- **A locked member frozen in a crowd** keeps a merge waiting for its fight, which lasts at most 90 s.
- **Hibernation** loses memory. Crowds and anchors live in the attachments, and the place a creature left in SQLite. Recent spawns and quiet timers start again on a wake: an explicit limit.
- **The ride as an escape.** It is refused while locked, courting, within 120 s of a fight, or with anyone near, and the hub judges each of those, not the page.
- **Merge conflicts between parallel tasks.**
  - `worker/where.ts`: T4's anchors, T5's crowds, then T10's fight anchors.
  - `src/game/online.ts` and `app-online.ts`: T6 and T7 put their logic in their own files and only wire it in.
  - `app-life.ts`: T4, then T10.
  - `protocol-defs.ts` is T1's alone.
- **Large tasks** (T4, T5, T6, T10) may overrun one session. Every run pushes its work in progress (ADR 0042), and a task that fails across three runs is split (the `next` skill).
