# M13: Scale proof and admission

Release: v0.14.0 · Gate: no

## Goal

Anyone can see what the authority costs, `docs/CAPACITY.md` says from measurements what the game can serve, and admission keeps the spending within the free plan or the €10 ceiling.

- **The authority shows what it spends.** `GET /v1/metrics` counts, per UTC day:
  - requests, and incoming messages by type;
  - SQLite rows written and read;
  - seated player-minutes, the peaks, and the waits in the line;
  - the relay traffic that pages report.

  It also shows the live counts, the plan's limits and the admission state, and names no player.
- **10,000 players are simulated, and the costs are measured three ways.**
  1. **In process, at 10,000.** The headless harness runs 10,000 clients with the page's own rules against the hub's pure parts. It gives the messages per player-minute by type, the overlay and the bandwidth, and it times the pure parts at that size.
  2. **In the real object.** With 50 to 500 seated sessions, each message type's CPU is measured, and it stays flat as the sockets grow.
  3. **Against `wrangler dev`.** 500 headless clients on the real protocol measure rows, stored bytes, the runtime's CPU per message and the round trip under load.
- **`docs/CAPACITY.md`** is generated from those numbers by `npm run report:capacity`. Its first screen answers four questions:
  - how many player-hours a day, and how many concurrent players, the free plan serves;
  - what the paid plan buys within $9.50 a month;
  - how many players one authority object serves;
  - what 10,000 concurrent players cost and need.

  Its tables give 5, 50, 200, 1,000 and 10,000 players, on the free plan and the paid one.
- **Admission keeps every limit.** A newcomer past a limit waits in line and sees:
  - why: the water is full, the day's room is used up, or the store is nearly full;
  - its place, and a wait measured from how often seats free.

  It can swim as a practice cell meanwhile. A seated player is never dropped, and a reload within 2 minutes gets its seat back. The TURN relay stops for newcomers before the month's allowance runs out.
- **A small load test in the release gate** guards what a real page costs the authority per minute.

The decisions behind this milestone:
- ADR 0067 decides the three layers of evidence, the metering, the relay reports, the plans and the $9.50 ceiling, admission by reason with a measured wait, the TURN guard, and the rule for one object's capacity. It amends ADR 0008 (the budgets and the queue) and ADR 0056 (the storage limit per plan).
- T8 writes **the capacity ADR** from the measurements: one object's capacity, and what 10,000 players need. It takes the next free number when it is written, since T3 or T5 may write an ADR first.

`docs/DESIGN.md` §8 describes the target, marked M13.

This milestone has **no gate**. v0.14.0 opens its `Playtest:` issue, and M14 starts without waiting. **No world renewal**: rules stay 12, and only the protocol moves to 13.

## Carried over

No owner input came. Playtests v0.10.0 (#379) and v0.11.0 (#418) have no replies, and v0.13.0's issue opens with its release. The ADRs left these to M13:

| From | Task |
|---|---|
| ADR 0008: M13 measures whether 10,000 concurrent players fit, and splits hubs only if the numbers demand it, with a new ADR | T5–T8 (the capacity ADR) |
| ADR 0008: admission "full in M13"; ADR 0056: the 5 GB limit and the `usage` row | T1, T9 |
| ADR 0056: checkpoint compaction waits for M13's measurements | T8 weighs it in `docs/CAPACITY.md`; built only if a limit demands it (ADR 0067) |
| ADR 0066: a faster dial for newcomers and a quicker report for lone creatures belong to M13's tuning | T5 measures them, and T8 weighs them; changed only if a per-player budget demands it (ADR 0067) |
| DESIGN §8: the wait, 30 s a place "until M13 measures it" | T9 |

## Out of scope

- **Building shards.** ADR 0067 builds them only if one object can't serve 200 players. The capacity ADR (T8) records what 10,000 players would need.
- **Moving history elsewhere.** Checkpoint compaction, and archiving history to other storage (R2, D1), are levers that `docs/CAPACITY.md` weighs. The only lever M13 may pull is the log window (ADR 0067).
- **Tuning links.** The newcomer's dial, the lone creature's report, and restricting TURN to P0 and P1 links are measured and weighed, not changed.
- **Cloudflare's own meters.** TURN usage through Cloudflare's analytics API needs an owner token, and CPU can't be timed in production.
- **A dashboard page.** `/v1/metrics` is JSON.
- **Real NATs and a real TURN relay in tests.** The relay share is an assumption until playtests report it.
- **M14's work**: browser engines, onboarding, balance, the soak test.
- **Rules changes**: no new genes, rules or world renewal.

## Touches

- **New:**
  - worker:
    - `worker/plan.ts`: the plans' limits, prices and ceiling (T1), and the derivation of allowances and caps (T8);
    - `worker/metered-sql.ts` (T1);
    - `worker/hub-cost.test.ts` (T6);
  - net: `src/net/relay-stats.ts` (T4);
  - game: `src/game/queue-card.ts` (T10);
  - tests and tools:
    - `tests/load.ts`, `tools/load.mjs`, `tools/load-report.ts`, `npm run sim:load`, `docs/perf/load.md` and `load.json` (T5);
    - `tools/hub.mjs`, `tools/hub-report.ts`, `npm run report:hub`, `docs/perf/hub.md` and `hub.json` (T6);
    - `tests/load-client.ts`, `tools/load-hub.mjs`, `tools/load-hub-run.ts`, `npm run load:hub`, `docs/perf/hub-load.md` and `hub-load.json` (T7);
    - `tools/capacity.mjs`, `tools/capacity-report.ts`, `npm run report:capacity`, `docs/CAPACITY.md`, `docs/perf/storage.json` and `witness.json` (T8);
  - E2E: `m13-load` 8837 (T11), `m13-queue` 8838 (T10) and `m13-lifecycle` 8839 (T12), all `@slow` except `m13-queue`.
- **Changed:**
  - worker:
    - `usage.ts` and `schema.ts` (migration 13), `index.ts` (`/v1/metrics`), `authority.ts`, and every module's SQL through the wrapper (T1);
    - `socket.ts`, `sessions.ts`, `where.ts`, `lives.ts`, `offspring.ts`, `spawn.ts`, `settle.ts` and `witness-pool.ts`: indexes in place of socket scans (T2);
    - `placement.ts`, `directory.ts` and `crowds.ts`: scale (T3);
    - `lives.ts` (relay reports) and `sessions.ts` (`why`) (T4);
    - `sessions.ts`: admission (T9);
    - `e2e-entry.ts`: `GET /v1/e2e/metrics` (T1), `GET /v1/e2e/sessions` (T7) and `POST /v1/e2e/usage` (T12);
    - `wrangler.jsonc` (T9);
  - net: `protocol-defs.ts` (protocol 13), `protocol-parse.ts` or `protocol-world.ts`, `peer-mesh.ts` and `hub-client.ts` (T4);
  - ledger: `src/ledger/witness.ts`, `poolOf`'s speed (T3);
  - game:
    - `life.ts`, `debug.ts`, `app-hook.ts` (T4);
    - `screens.ts`, `online-config.ts` and `hud.ts` (T10);
  - harness: `tests/aoi-harness.ts`, already 1,484 lines; T5 puts the load scenario and its counters in `tests/load.ts`, and splits the harness if it grows;
  - tools and CI: `tools/storage.mjs`, `tools/witness.mjs` (T8), `.github/workflows/release.yml`, `tools/release-workflow.test.ts` (T9), `playwright.config.ts`;
  - docs: DESIGN §8 (and §5 if the log window changes), `docs/TESTING.md`, `docs/SETUP.md` step 8, `.claude/rules/{worker,net,game}.md`.

**Shared shapes.** Tasks that run in parallel build to these. A later task maps between them rather than redefining them.

```ts
// worker/plan.ts (T1): Cloudflare's limits and prices as checked on 2026-11-08 (ADR 0067)
export const CHECKED = '2026-11-08';
export type PlanName = 'free' | 'paid';
export interface PlanLimits {
  requestsPerDay: number;      // Durable Object request-equivalents (an upgrade 1, a message 1/20)
  rowsWrittenPerDay: number;
  rowsReadPerDay: number;
  storageBytes: number;        // per object
  turnGbPerMonth: number;
  sessions: number;            // the plan's session cap (T8 sets it from one object's capacity)
}
export const FREE: PlanLimits;  // 100,000; 100,000; 5,000,000; 1 GB; 1,000; 200 until T8
export const PAID: PlanLimits;  // until T8: the included amounts ÷ 30, 10 GB, 1,000, 200
export const PRICES: { base: 5; requestsPerM: 0.15; gbSecondsPerM: 12.5; rowsWrittenPerM: 1;
  rowsReadPerM: 0.001; storageGbMonth: 0.2; turnGb: 0.05; workerRequestsPerM: 0.3 };
export const INCLUDED: { requests: 1e6; gbSeconds: 4e5; rowsWritten: 5e7; rowsRead: 2.5e10;
  storageGbMonth: 5; turnGb: 1000; workerRequests: 1e7 };          // per month, paid
export const CEILING_USD = 9.5;
export function planOf(env: Env): PlanName;                          // `PLAN`: 'paid', else 'free'
export function limitsOf(env: Env): PlanLimits;                      // the plan's, then the overrides
//   (`MAX_SESSIONS` → sessions, `DAILY_REQUEST_BUDGET` → requestsPerDay)

// worker/usage.ts (T1): one UTC day, as the row and `/v1/metrics` hold it
export interface UsageDay {
  day: string;                 // YYYY-MM-DD
  requests: number;            // request-equivalents, rounded up
  messages: number;
  byType: Record<string, number>;   // incoming messages by `ClientMsg['t']`, plus 'bad' for unparsed
  upgrades: number;
  reads: number;               // public reads that reached the object (proofs, fights, audit, metrics)
  rowsWritten: number;
  rowsRead: number;
  dbBytes: number;             // at the day's first flush
  playerMs: number;            // seated session-ms
  peakSeated: number;
  peakQueued: number;
  waits: number;               // sessions seated from the line
  waitMs: number;              // their summed waits
  relay: { reports: number; links: number; relayed: number; kb: number };   // T4 fills
}

// GET /v1/metrics (T1; T4 and T9 fill their parts)
export interface Metrics {
  now: number;
  plan: PlanName;
  checked: string;             // CHECKED
  limits: PlanLimits;          // in force, overrides applied
  live: { seated: number; queued: number; away: number; fights: number; witnessed: number;
          members: number; crowds: number; instances: number };
  today: UsageDay & {
    perPlayerMinute: { messages: number; requests: number } | null;   // null with no seated time
    perPlayerHour: { rowsWritten: number; rowsRead: number } | null;
  };
  month: { requests: number; rowsWritten: number; rowsRead: number; relayKb: number };  // UTC month so far
  days: UsageDay[];            // the 31 days before today that have rows, newest first
  storage: { bytes: number; limit: number };
  admission: { open: boolean; why: QueueWhy | null; turn: boolean;
               seatEveryS: number; waits: { n: number; p50: number; p95: number } | null };
}

// src/net/protocol-defs.ts (T4): PROTOCOL_VERSION 13
export type QueueWhy = 'full' | 'budget' | 'storage';
export const RELAY_KB_MAX = 16_384;
export interface RelayReport { links: number; relayed: number; kb: number }
//   links 0–32, relayed 0–links, kb 0–RELAY_KB_MAX: whole numbers
// ClientMsg: progress gains `relay?: RelayReport`
// HubMsg:    queued gains `why: QueueWhy`

// docs/perf/load.json (T5), hub.json (T6), hub-load.json (T7): what T8 reads
export interface LoadMeasure {
  players: number; seconds: number; seed: string;
  perPlayerMinute: {
    hold: { median: number; p95: number; mean: number };    // after a player's first minute; mean with churn
    firstMinute: { median: number; p95: number };
    byType: Record<'where' | 'crowd' | 'spawn' | 'ride' | 'gone' | 'offer' | 'answer' | 'refuse' | 'resend', number>;
  };
  links: { mean: number; p95: number; setupsPerPlayerMinute: number; viaPeerShare: number };
  bandwidth: { uploadKBs: { mean: number; p95: number }; downloadKBs: { mean: number; p95: number };
               gossipKBsPerLink: number };
  hubOps: Record<'where' | 'place' | 'relay' | 'split' | 'pool', { perSecond: number; p50Ms: number; p99Ms: number }>;
  heapBytes: { hub: number; perMember: number };
  churn: { joinsPerSecond: number; meanSessionMin: number };
}
export interface HubCost {
  sessions: number[];                          // 50, 200, 500
  msPerMessage: Record<string, number[]>;      // by type, one per size
  frameMs: number[];                           // one authority-refereed duel frame, by size
  attachmentBytes: { median: number; p95: number; max: number };
  clockStepMs: number;                         // the runtime's clock resolution
}
export interface HubLoad {
  clients: number; seconds: number;
  perPlayerMinute: { total: number; requests: number; byType: Record<string, number> };
  perPlayerHour: { rowsWritten: number; rowsRead: number; bytes: number };
  cpuMsPerMessage: number; rssPeakMb: number;
  nearRttMs: { p50: number; p95: number; p99: number };
  closed: Record<string, number>; dropped: Record<string, number>; flags: number;
}
```

**Migration 13** (T1): `usage` gains:
- `by_type TEXT NOT NULL DEFAULT '{}'`;
- these, each `INTEGER NOT NULL DEFAULT 0`: `upgrades`, `reads`, `rows_read`, `player_ms`, `peak_seated`, `peak_queued`, `waits`, `wait_ms`, `relay_reports`, `relay_links`, `relay_relayed` and `relay_kb`.

The row is still written at most once a minute.

**Variables:**
- `PLAN` (any mode; production reads `vars.CLOUDFLARE_PLAN` at deploy, T9).
- `MAX_SESSIONS` and `DAILY_REQUEST_BUDGET` stay as overrides. T9 removes them from the production `vars`.

**E2E entry hooks:**
- `GET /v1/e2e/metrics` (T1): `/v1/metrics`'s answer, uncached.
- `GET /v1/e2e/sessions` (T7): each seated session's `{ id, name, seatedAt, received }`, where `received` counts its incoming messages by type.
- `POST /v1/e2e/usage { requests }` (T12): sets today's request-equivalents, for the budget line. `tools/worker-bundle.test.ts` guards all three.

**Page hooks:**
- `debug.progressNow()` (T4) sends a progress report at once;
- `state().net.relay` (T4) is the last relay report sent;
- `state().queue` (T10) is `{ position, etaS, why }`, or null.

**Hubs**: `m13-load` 8837, `m13-queue` 8838 and `m13-lifecycle` 8839. The next hub file takes 8840. `npm run load:hub` uses 8850, outside the E2E range.

## Tasks

T1 and T3 need nothing and can start at once. T2 and T4 follow T1, and T5 follows T3. T6 and T7 follow T2. T8 needs T5, T6 and T7. T9 follows T4 and T8, T10 follows T4, and T11 follows T7 and T8. T12 closes.

### Metering

- [x] T1 Metering: the day in depth, and `GET /v1/metrics` (after none)
  - Steps:
    1. **`worker/plan.ts`**, in the shapes above. `STORAGE_LIMIT_BYTES` leaves `usage.ts`: the audit's `storage.limit` is the plan's `storageBytes`, which is 1 GB on the free plan.
    2. **`worker/metered-sql.ts`**: one wrapper over `ctx.storage.sql`, which every module uses instead of the raw handle: the ledger, beacons, the fight store, proofs, away reports, duties, the witness pool, spawn, seat, world, farming and recovery. It adds each statement's `rowsRead` and `rowsWritten` to the meter. The existing counters (`Ledger.rowsWritten`, `FightStore.rowsWritten`, `rowsBesideLog`) keep their meaning. No answer changes.
    3. **Migration 13** (above).
    4. **`UsageMeter`** counts what `UsageDay` holds:
       - `message(now, type)` counts the type, and `bad` for an unparsed message;
       - `request` counts each public read, and `upgrade` each upgrade;
       - seated time is integrated from the count of seated sessions: on every change of it, and at each flush;
       - the peaks of seated and waiting sessions;
       - `waited(ms)` for a session seated from the line (`promoteWaiting`).

       It flushes at most once a minute, as now.
    5. **`GET /v1/metrics`** (`index.ts` → the RPC `Authority.metrics()`) answers `Metrics`, with today's counts as the meter holds them now, not as last flushed. It is checked for its origin and given CORS as the audit is, cached at the edge for 60 s (`edgeCached`), and counted as a public read. Unlike the proofs, it still answers past 80% of the day's requests: the owner needs it most then, and the edge cache lets at most one read a minute per edge location reach the object. The E2E entry serves the same answer uncached at `GET /v1/e2e/metrics`, which E2E specs read.
       - `admission` comes from today's `canAdmit`: `why` is `full` or `budget` by the guard that held, `turn` is true, `seatEveryS` 30 and `waits` null. T9 fills them in for real.
       - `month` sums the month's rows.
    6. DESIGN §8 (the meter's lines become current, not M13), `.claude/rules/worker.md` and `docs/TESTING.md`.
  - Acceptance (tests first). Hub tests with a mocked `Date.now`:
    - **Migration**: migration 13 on a database at 12 adds the columns, and an older row reads as zeros and `{}`.
    - **Counting messages**: after its sign-in, a seated session sends 10 `where`, 3 `progress`, 1 `ping` and 1 unparsable message. They add:
      - 10, 3, 1 and 1 to `byType`'s `where`, `progress`, `ping` and `bad`;
      - 15 to `messages`, and 15/20 to the request-equivalents.

      An upgrade adds 1 to the request-equivalents and to `upgrades`. A flush writes them, and a second flush within a minute writes nothing.
    - **Counting rows**:
      - a genesis hatch's rows written and read, by the meter, equal the sum of every statement's cursor counts (an instrumented test);
      - a proof read's rows read are counted;
      - every existing hub test passes unchanged.
    - **Seated time**: two sessions seated for 60 s and a third for 30 s give `playerMs` 150,000 (± 1,000) after a flush, and `peakSeated` 3. One queued session gives `peakQueued` 1.
    - **`/v1/metrics`**:
      - the shape above;
      - no player id and no 64-hex id anywhere in the body (a regular expression over it);
      - a foreign origin gets 403;
      - a second GET within 60 s doesn't reach the object (`proofReads` unchanged);
      - past 80% of the day's requests it still answers;
      - on a mocked new day, `days` holds yesterday's row;
      - `perPlayerMinute` is null with no seated time.
    - `GET /v1/audit`'s `storage.limit` is 1,000,000,000 under the free plan.
  - Notes: no admission change (T9) and no protocol change (T4). The wrapper touches many files; T2 follows this task for that reason.
  - Done: `hub.sql` (metered) replaces `ctx.storage.sql` in every module; `UsageMeter` counts the day in depth (migration 13), `GET /v1/metrics` and `/v1/e2e/metrics` answer `Metrics`. Gotcha: a cursor is counted as it is consumed, so an unconsumed read isn't; seated time isn't counted while the object is evicted.

### Scale in the hub

- [x] T2 The hub's work per message doesn't grow with its sockets [opus] (after T1)
  - Steps:
    1. **In-memory indexes** on the hub replace the socket scans. They are rebuilt in the constructor from the attachments, as the directory is, and kept up by `hello`, `enter`, `drop`, `promote` and the handlers that change them:
       - **each seated player's socket**, used by `seated`, the relay's target, `tellMoved`, `tellInstances`, court and mate targets, `seatedCrowd` and duties;
       - **the line** in ticket order: `queued`, `announceQueue` and `canAdmit`'s counts;
       - **the challenged sockets** and their deadlines: `helloDue` and the alarm's timeout pass;
       - **live courts both ways**: `courtPairs`;
       - **the away seats**: `awaySeats`, from the fights' players and the seated set;
       - **the witness candidates**: each seated player's `avail`, IP hash, duties in the hour, saved play and strike.
         - Saved play is read once at sign-in, then kept current with the life's credit and with every record that adds active time.
         - A strike is read at sign-in and set by `strike`.

         So `eligible` reads no SQLite row, and no attachment beyond its candidates'.
    2. **A kill's carrion notice** reaches its sessions through the directory's `around`, not a scan.
    3. **Counters** of attachment reads (`sessionOf`) and of `ctx.getWebSockets()` calls, exported for tests.
    4. `.claude/rules/worker.md`.
  - Acceptance (tests first). Hub tests with 20 and with 200 seated sessions.
    - **The same attachment reads at both sizes, with no `getWebSockets()` call**, for each of these:
      - a `where` with a crowd list, and a split's `leaf` and `instance` notices;
      - a hub-relayed `signal`;
      - `progress` and `ping`;
      - `spawn` and `ride`;
      - `mate-check` and `court`;
      - an `engage` with its `lock-ask` and answer;
      - a sign-in seated, and a sign-in queued;
      - an encounter's witness pool;
      - a kill's carrion notice;
      - an alarm with nobody challenged.
    - **No SQL for eligibility**: drawing a witness pool reads no row of `creatures` or `players` (T1's meter).
    - **The same answers**:
      - every existing hub test passes unchanged: queue order, relay reach, courts, duties, carrion recipients and `awaySeats`;
      - 500 seated sessions relay 100 signals, and every one reaches its target.
    - **A wake**: indexes rebuilt from a set of attachments give the same seated set, line order, courts and witness candidates as the live ones, tested as `rebuildDirectory` is.
  - Notes: the answers don't change; only how the hub finds things does. T9 builds admission on the line's index.
  - Done: `worker/seats.ts` (`hub.seats`) indexes seats, the line, hellos, courts and witness candidates; every attachment write goes through `keep`, and `hubReads` counts reads (`worker/hub-scale.test.ts`, heavy). Gotcha: a test writing a seated player's `creatures`/`players` rows directly calls `seats.reload`; eligibility still reads each candidate's attachment for its duties and credit.

- [x] T3 Placement and the hub's pure parts at 10,000 (after none)
  - Steps:
    1. **`place()` at 10,000 members** (`worker/placement.ts`):
       - **The avoid test** goes through a grid whose cells are at least the widest avoid distance, so a candidate checks only the discs near it.
       - **A group's members** are a set, not `ids.includes`.
       - **`groupsFor`** stays grid single-linkage, within its budget.
       - **A group wider than the rings reach** still places at its edge. 8,192 candidates around the centroid reach about 6,300 wu for starters, so a populated area grown past that falls back to the spawn centre today. No placement may fall back while the world has room near the group.

       ADR 0064 places on rings from the group's centroid outward. If the fix needs another start (for example, rings from 2 clearances inside the group's radius), an ADR amending 0064 and DESIGN §8 record it.
    2. **The pure parts' budgets at 10,000 members**: `Directory`, `Crowds` and `poolOf` (`src/ledger/witness.ts`).
       - If SHA-256 over every eligible player can't meet `poolOf`'s budget, the pool is drawn from a window: the 1,024 eligible ids that follow SHA-256(`bs/pool-window/v1` ‖ event) in id order, wrapping, and from them the 16 lowest SHA-256 as now.
       - That change is an ADR amending 0058, written in this task.
  - Acceptance (tests first), in Node:
    - **Growth past the rings**: 3,000 starters are placed one after another into one world, each placed point then a member standing still.
      - Every placement keeps the clearance from every earlier member, and from every spawn of the last 60 s.
      - None falls back to the spawn centre.
      - Each lies within its group's reach plus 3 clearances of the centroid (wave gate 3, ADR 0066).
    - **Nothing else moves**: the placement property tests (2,000 seeded worlds of 0 to 300 members) and the 300-starter growth test pass as they are, or with the ADR where the rule changed.
    - **Speed** (`speedTest`), in a world of 10,000 members (9,000 starters in one populated area, the rest T1s scattered):
      - `place()` within 20 ms on average over 50 placements;
      - `groupsFor` within 10 ms;
      - `Directory`: 10,000 reports and 10,000 `near` queries within 1.5 s in all;
      - `Crowds`: 10,000 open-water reports within 0.5 s, and a report into a crowd of 300 within 1 ms (as now);
      - `poolOf` over 10,000 eligible ids within 10 ms.
  - Notes: pure. T5 runs these parts at 10,000 in the harness.
  - Done (ADR 0069): rings restart at a wide group's edge, grids for the discs, `groupsFor` and `near` pruned, `poolOf` keyed over a 1,024 window. `scale-parts.test.ts` runs in the node project (workerd times 5× slower); the timing tests need an idle machine.

### Relay and the line on the wire

- [x] T4 Protocol 13: relay reports and the line's reason [opus] (after T1)
  - Steps:
    1. `PROTOCOL_VERSION` 13. A protocol-12 hello gets `error: version`.
    2. **The wire**: `progress` gains `relay?`, and `queued` gains `why` (shapes above). The parsers refuse a missing, extra or out-of-range field.
    3. **The page**:
       - `src/net/relay-stats.ts` reads each open link's `getStats()`. It finds the selected candidate pair (the transport's `selectedCandidatePairId`, else the nominated pair that succeeded) and that pair's local `candidateType`. It reports:
         - the links held;
         - the links on a local `relay` candidate;
         - the KB received over those pairs since the last read. A counter that restarts, or a link closed between reads, counts what it had.
       - `PeerMesh` exposes each link's stats.
       - The page reads the stats every 10 s while it holds links, and `LifeClient.report` carries the totals of the reads since its last report.
       - `state().net.relay` is the last report sent, and `debug.progressNow()` sends one at once.
    4. **The worker**:
       - a `progress` report's `relay` goes to the meter: `relay_reports`, `relay_links`, `relay_relayed` and `relay_kb`;
       - `kb` is clamped to 4 KB/s per reported link times the seconds since the session's last counted report, at most 60 s;
       - `/v1/metrics` shows the day's relay, and `month.relayKb`.
    5. **The line's reason**: the hub's `queued` carries `why`, `full` (the session cap) or `budget` (the day's requests), by the guard that held. `HubClient.queue` keeps it. The status text is unchanged until T10.
    6. `.claude/rules/net.md`, and DESIGN §8 (relay reports become current).
  - Acceptance (tests first):
    - **Parsers**:
      - every new field round-trips;
      - each of these parses to null: `relay` with 33 links, with `relayed` above `links`, with `kb` of −1, 1.5 or 16,385, or with an extra field, and `queued` with `why: 'later'` or without `why`;
      - 10,000 fuzzed values never throw.
    - **Hub tests**:
      - a protocol-12 hello is refused;
      - a report of 16,384 KB over 2 links, 10 s after the last, counts 80 KB;
      - reports sum into the day's row and `/v1/metrics`;
      - a `progress` without `relay` is taken as before;
      - a queued session hears `why: 'full'` past `MAX_SESSIONS`, and `why: 'budget'` past 90% of `DAILY_REQUEST_BUDGET`.
    - **Page unit tests with fake stats**:
      - a host pair counts as a link, not relayed;
      - a pair on a local relay candidate counts with the delta of its bytes;
      - a pair that switches from host to relay counts from the switch;
      - a link closed between two reads counts what it had.
    - **E2E**: in `m12-spawn.spec.ts`'s four linked pages (host candidates only), after `debug.progressNow()`:
      - each page's `state().net.relay` holds its open links, none relayed;
      - the hub's `/v1/e2e/metrics` counts the reports, with 0 KB.
    - Every E2E passes on protocol 13.
  - Done: `relay-stats.ts` (pure) and `PeerMesh.linkStats` feed `LifeFlow.report` every 10 s of links; the hub clamps and meters them (`meterRelay`), and `queued` carries `admissionWhy`. Gotcha: a report's `links` and `relayed` are the most of any read since the last report (summing would pass 32), only its KB is summed.

### Evidence

- [ ] T5 The load simulation at 10,000, in process (after T3)
  - Steps:
    1. **The harness at 10,000 clients.** Profile it, and remove what grows faster than the clients. The pairwise gate checks may be judged once a second, and on a seeded sample of clients at 10,000; the report says which.
    2. **The `load` scenario** (`tests/load.ts`, on the harness):
       - **the fill**: 10 players in the first minute, then the rest evenly over 9 minutes, each placed by `place()`. 90% are starters, 9% T1 and 1% T2, the larger ones restored with an ancestor's size (as the wave's T1s are).
       - **the hold**: from minute 10 to minute 16. Each player leaves after a session drawn from an exponential distribution with a mean of 30 minutes, and a newcomer replaces each leaver at once (placed), so the world holds 10,000 with about 5.6 joins a second.
       - **life**: players wander as in the wave, and a player alone for 120 s rides. Every minute of the hold, 1 pair in 100 players, comparable and sharing water, fights for 30 s.
    3. **Hub operations, timed in Node**:
       - each `where`: the directory's report, `near` and the crowds' report;
       - each `place()`;
       - a hub-relayed signal's reach check;
       - each crowd split;
       - `poolOf` over the players present, at each fight's start.

       For each: its count per second, and its p50 and p99 in ms. Also the heap held by the hub's parts at the peak (`process.memoryUsage`, after a GC when `--expose-gc` is given).
    4. **Messages by type**: `where`, `where` with a crowd list, `spawn`, `ride`, `gone`, and hub `signal`s by kind (offer, answer, refuse) and resend.
    5. **The report**: `npm run sim:load` (`tools/load.mjs`, `tools/load-report.ts`) writes `docs/perf/load.md` and `docs/perf/load.json` (`LoadMeasure`). It exits non-zero when a gate fails, and prints its wall time. A `heavyTest` runs a scaled load (500 players, filled over 1 minute, held for 2) against the same gates.
  - Gates (`docs/perf/load.md`), each a failing test in the scaled run:
    1. **Budget**, in the hold:
       - world messages per player-minute, after a player's first minute: median at most 6, p95 at most 12;
       - in a player's first minute: p95 at most 100;
       - the hold's mean, churn included: at most 12.
    2. **Placement**:
       - 0 clearance violations;
       - 0 fallbacks to the spawn centre;
       - every spawn with a group within the group's reach plus 3 clearances.
    3. **Together**: a T0 newcomer with a group is linked to one of its members within 3 s at the median and 5 s at the p95.
    4. **Bounded**: never more than 32 links, and at most 1% of client-seconds crowded after a client's first 10 s.
    5. **No hidden creature**: harness gate 2 among pairs that share water, as the wave reads it (ADR 0066).
    6. **Integrity**: fighters share water and keep their instance through their fights.

    Reported but not gated:
    - the fill, minute by minute;
    - the upload and download per client;
    - links, link setups per player-minute and the share set up through a peer;
    - gossip;
    - hub operations and heap;
    - wall time.
  - Acceptance:
    - The scaled `heavyTest` passes every gate within 120 s.
    - `npm run sim:load` at 10,000 players passes every gate. Its wall time is in the report (target: under 45 minutes on a cloud session).
    - The same seed gives the same report, apart from the timings and the wall time, which sit in their own section.
    - `docs/perf/load.md` and `load.json` are committed.
  - Notes:
    - The fill's first minutes cost far more per player than a live world would: 18 joins a second into a few thousand players. They are reported, not gated.
    - If a gate's number is beyond the link model at 10,000, an ADR records what it measures and why, as ADRs 0063 and 0066 did.

- [ ] T6 What a message costs in the real object (after T2) (in progress)
  - Steps:
    1. **`worker/hub-cost.test.ts`** seats 50, 200 and 500 sessions: real sockets, each with a recorded creature placed in one populated area of the world.
       - For each message type, it sends batches of 200 through the object's own dispatch inside the object (`runInDurableObject` → `webSocketMessage`), and times each batch on the local runtime's clock, which steps by 1 ms. The median of 5 batches gives ms per message.
       - The types, at least:
         - `where`, plain and with a crowd list of 16;
         - a hub `signal`: a 1.5 KB offer to a session within reach;
         - `progress`, `ping`, `avail`;
         - `spawn` (a first ask per session, so all a size has, not batches of 200), and `ride` (refused `company`);
         - `input` in a running fight (the fight kit), and a witness's `batch` (the witness kit);
         - `lock-state`;
         - one frame step of an authority-refereed duel.
    2. **Attachment sizes**: each seated session's attachment as JSON, at the median, p95 and max.
    3. **The report**: the test prints `HUB_COST {…}` (`HubCost`), and `npm run report:hub` (`tools/hub.mjs`, `tools/hub-report.ts`) writes `docs/perf/hub.md` and `docs/perf/hub.json`. The report states the clock's resolution, and that production can't measure this (ADR 0067).
  - Acceptance:
    - A `speedTest`: each type's ms per message at 500 seated is at most 1.5 times its ms at 50, plus 0.02 ms.
    - The report and its JSON are committed. `tools/hub-report.test.ts` checks the report against a recorded `HubCost`.

- [ ] T7 500 headless clients against `wrangler dev` (after T2)
  - Steps:
    1. **`tests/load-client.ts`**: a headless client on the page's own `HubClient` (with Node's `WebSocket`) and a seeded identity. It does what a page does:
       - a recorded genesis, from the fixture rounds;
       - `spawn`;
       - scripted wandering, reported by the page's `WhereReporter`;
       - `progress` every 30 s, within the authority's bounds, so no flag is raised;
       - the hub client's pings;
       - offers to its `near` peers at the in-process rate (`load.json`'s offers per player-minute in the hold, or 2 per player-minute until T5 lands it), each answered by the target client through the hub;
       - `gone` and a close when it leaves.

       It records each `near`'s round trip.
    2. **`GET /v1/e2e/sessions`** (E2E entry only): each seated session's `{ id, name, seatedAt, received }`, counted by the E2E entry's subclass.
    3. **`npm run load:hub`** (`tools/load-hub.mjs`, `tools/load-hub-run.ts`):
       - it starts `node tools/worker.mjs dev --e2e --port 8850 --persist-to <temporary> --var MAX_SESSIONS:1000 --var DAILY_REQUEST_BUDGET:100000000`;
       - it joins 500 clients over 2 minutes, holds for 6, and lets them leave over 2;
       - it samples the workerd process's CPU time and resident memory from `/proc` every 5 s (Linux only);
       - it reads `/v1/e2e/metrics` and `/v1/audit` at the start, at the hold's start and end, and at the end.

       `--clients` and `--minutes` give a quick mode.
    4. **`docs/perf/hub-load.md` and `hub-load.json`** (`HubLoad`):
       - messages per player-minute by type, by the clients' own counts and by the meter's;
       - request-equivalents per player-minute;
       - rows written and read, and stored bytes, per player-hour (the database's size at the start and the end);
       - CPU ms per incoming message, and the resident memory's peak above the start;
       - the round trip's p50, p95 and p99;
       - closes by code, dropped messages by type, and audit flags.
  - Acceptance:
    - A run of 500 completes with every client seated, no socket closed for its rate, no `where` dropped and no audit flag.
    - The meter's messages by type equal the clients' sent counts within 1% (messages in flight at the reads).
    - The quick mode (`npm run load:hub -- --clients 50 --minutes 3`) passes the same checks.
    - A unit test builds the report from a recorded run's numbers.
    - The report and its JSON are committed.
  - Notes: the clients open no WebRTC link, so their hub signals follow the measured rate, and T11 checks a real page's cadence. A recorded genesis per client makes progress, checkpoints and the close's rows real.

### The model

- [ ] T8 The capacity model, `docs/CAPACITY.md` and the capacity ADR (after T5, T6, T7)
  - Steps:
    1. **The inputs.** `tools/storage.mjs` and `tools/witness.mjs` also write `docs/perf/storage.json` and `witness.json`, their measures. The storage report's limit comes from `worker/plan.ts`.
    2. **The report.** `tools/capacity-report.ts` (pure) and `tools/capacity.mjs` (`npm run report:capacity`) write `docs/CAPACITY.md` from:
       - `load.json`, `hub.json`, `hub-load.json`, `storage.json` and `witness.json`;
       - `worker/plan.ts`;
       - optionally `--metrics <file>`, a saved `/v1/metrics` answer, whose per-player numbers then replace the assumptions they measure.

       Its sections:
       - **Summary**, on the first screen:
         - the free plan in player-hours a day, and in concurrent players around the clock;
         - the paid plan within $9.50;
         - one object's capacity;
         - what 10,000 cost and need.
       - **Assumptions**, each with its source and the `/v1/metrics` field that measures it live:
         - fights per player-hour: 3 (ADR 0056);
         - the share of fights a witness referees: 50%;
         - the relay share of links: 15%;
         - the mean session: 30 minutes;
         - public reads per player-day: 2;
         - the exchange rate: €1 = $0.95 at the worst (ADR 0067).
       - **Per player**:
         - messages per player-minute by type: the world's from `load.json`, the page's own cadence (progress, ping, avail) from `hub-load.json` and the page's constants, and fights from the witness model;
         - request-equivalents;
         - rows written and read, and stored bytes, per player-hour and per fight;
         - CPU ms per player-minute, and memory per seated session;
         - bandwidth per client, and TURN per player-hour.
       - **The table**, at 5, 50, 200, 1,000 and 10,000 concurrent around the clock:
         - incoming messages a second;
         - request-equivalents, rows written and rows read a day;
         - duration in GB-s a day;
         - storage growth a day, and the logs' steady state;
         - TURN GB a month, and Worker requests a day;
         - the share of one core, and memory.

         For each row:
         - the free plan: within its limits, or the first limit passed and how many hours of a day it serves before the line;
         - the paid plan: dollars a month by item, within the ceiling or not;
         - one object: within ADR 0067's capacity rule or not.
       - **Operating limits**:
         - one object's capacity;
         - each plan's session cap and daily allowances;
         - how many days each plan's store lasts at its full allowance.
       - **The admission policy**, as built.
       - **Beyond one object**: what 10,000 players need.
       - **Levers**, in order, each with its effect on the numbers:
         - more fights refereed by witnesses;
         - relay only for P0 and P1 links;
         - the newcomer's dial and the lone creature's report (ADR 0066);
         - the log window;
         - checkpoint every 30 minutes;
         - checkpoint compaction, or archiving history;
         - the paid plan.
    3. **`worker/plan.ts`** gains `MEASURED` (the per-player numbers the model used), `allowances(plan)` and `sessionCap(plan)`. Both come from one pure derivation that the report calls too.
       - `MEASURED.page` is a page's own incoming messages per player-minute in the hold, by type (`where`, `progress`, `ping`, `signal`, `avail`) and in total, which T11 guards.
       - The paid plan's daily allowances spend at most $4.50 a month above the base at the measured mix.
       - The session cap is the smaller of the plan's money cap and 80% of one object's capacity (ADR 0067).

       `FREE.sessions` and `PAID.sessions` take the derived caps.
    4. **The capacity ADR** (the next free number) records:
       - one object's capacity and the session caps;
       - what 10,000 players need: the shard count, the design and the cost per month;
       - the storage lever, if it is pulled. If the free plan at its full daily allowance would fill its 1 GB within 90 days with the 14-day log window, `LOG_KEEP_DAYS` becomes 7 (ADR 0056 allows 7). The storage report and DESIGN §5 then follow.

       The README index and the status lines of the ADRs it amends are updated with it.
    5. DESIGN §8: the values the model sets.
  - Acceptance (tests first):
    - **The arithmetic**, in unit tests:
      - 10,000 players at 10 messages a player-minute give 1,667 messages a second and 7.2 M request-equivalents a day;
      - 216 M request-equivalents a month on the paid plan cost 5 + (216 − 1) × 0.15 = $37.25 for requests;
      - 200 players receiving 1 KB/s each over a relay for 30 days give 518 GB of TURN (decimal units: 1 KB is 1,000 bytes, as Cloudflare bills);
      - each row of the table finds its binding limit;
      - the derived allowances spend at most $4.50 above the base at the mix;
      - `sessionCap` is the smaller of its two caps.
    - **No drift**: `worker/plan.ts`'s constants equal what the derivation gives from the committed JSONs, and a test fails when one drifts.
    - **Regeneration**: `docs/CAPACITY.md` regenerates byte for byte from the committed inputs (a test).
    - The capacity ADR is written.
  - Notes:
    - **If one object's capacity falls below 200** (M14's playtest), the task stops after the ADR and the report. The spec then gains a task for the hottest path, before T9.
    - **The relay share is an assumption**: `docs/CAPACITY.md` says how to replace it with the playtest's `/v1/metrics` (`--metrics`).

### Admission

- [ ] T9 Admission by plan: three reasons, a measured wait, the TURN guard [opus] (after T4, T8)
  - Steps:
    1. **`canAdmit` becomes `admission(hub, now)`**: null while the line is open, else the reason, checked in this order:
       - `storage`: the database at 90% of the plan's `storageBytes`;
       - `budget`: the day's request-equivalents, rows written or rows read at 90% of their allowances;
       - `full`: seated sessions and away fighters at the session cap.

       The cap is `MAX_SESSIONS` when set, else `sessionCap(plan)`. The request allowance is `DAILY_REQUEST_BUDGET` when set, else the plan's.
    2. **The measured wait**:
       - `full`: the session's place times the mean interval between the last 20 seats freed, kept in memory (30 s before two have freed);
       - `budget`: the seconds to the next 00:00 UTC, plus the place less one times that interval;
       - `storage`: 0.

       The line is told again when a place changes, or when an ETA moves by more than 20% (at the queue tick).
    3. **A seat comes back**: a player whose seat closed within the last 2 minutes (a reload, a dropped connection) is seated again past any guard. The hub keeps this in memory, so a wake forgets it.
    4. **The TURN guard**: once the month's clamped relay KB, plus yesterday's, reach 90% of the plan's `turnGbPerMonth`, new welcomes carry STUN only (`turn: false`). Credentials keep their day-long TTL, and the day of margin covers those already handed out.
    5. **`/v1/metrics`'s `admission`**:
       - `open`, `why`, `turn` and `seatEveryS`;
       - `waits` (n, p50 and p95 of the waits measured today, the last 200 kept in memory).

       Each session seated from the line counts its wait in the usage row.
    6. **Configuration**:
       - `worker/wrangler.jsonc`'s vars become `PLAN: "free"` only;
       - the release workflow passes `--var PLAN:${{ vars.CLOUDFLARE_PLAN || 'free' }}` at deploy;
       - `tools/release-workflow.test.ts` follows;
       - `docs/SETUP.md` step 8 says how to switch to the paid plan;
       - the E2E config keeps its own vars.
    7. DESIGN §8 (the M13 admission becomes current, and the old paragraph goes), `.claude/rules/worker.md`.
  - Acceptance (tests first). Hub tests with a mocked `Date.now`, each limit set on the live object's `env` or pushed through the meter, as `worker/queue.test.ts` does:
    - **`full`**:
      - with a cap of 3, the 4th session waits with `why: 'full'` and `etaS: 30`;
      - after seats free at 20 s intervals, the next waiting session hears `etaS` = place × 20 (± 1);
      - seats go in order;
      - an away fighter's seat counts.
    - **`budget`**:
      - requests at 90% give `why: 'budget'`, with `etaS` = seconds to the next 00:00 UTC (± 1) for the first in line;
      - rows written and rows read at 90% of their allowances do the same;
      - at a mocked 00:00 UTC the queue tick seats the line in order.
    - **`storage`**: the database at 90% of the plan's storage gives `why: 'storage'`, `etaS: 0`.
    - **Seats are kept**:
      - when any guard trips, no seated session is dropped or re-queued;
      - a reload within 2 minutes is seated past each guard, and one after 2 minutes waits.
    - **The wait is honest**: with departures every 20 s for 5 minutes, each waiter that joins the line after the first two departures is seated within 30% of the first ETA it heard.
    - **TURN**:
      - the month's reports plus yesterday's at 90% give the next welcome `turn: false` and STUN only;
      - just below, the welcome carries TURN as before.
    - **Plans**: `PLAN=paid` reads the paid allowances, and an unknown value reads the free ones.
    - `/v1/metrics`'s `admission` matches each case.
    - Every E2E passes (`m4-lifecycle`'s queue).

- [ ] T10 The line in the page [opus] (after T4)
  - Steps:
    1. **The card** (`src/game/queue-card.ts`, from `screens.ts`). While the hub keeps the session waiting, the title and death screens show a glass card in the HUD's style. It gives:
       - the reason:
         - `full`: "The water is full";
         - `budget`: "Today's room is used up";
         - `storage`: "No room for new players right now";
       - the place: "2nd in line";
       - the wait:
         - "under a minute", "about 3 min" or "about 2 h";
         - for `budget`, "opens at 01:00", the next 00:00 UTC in local time;
         - for `storage`, no estimate.

       It offers "Swim while you wait" (the practice cell), and the Hatch button reads as waiting.
    2. **While practising**, the status chip reads "2nd in line · about 1 min".
    3. **When the hub seats the session**, a toast says "A place is free: your next hatch is recorded", the chip turns online, and the title's Hatch is recorded. A practice life goes on until it ends or the player returns to the title.
    4. **Hooks**: `state().queue` (`{ position, etaS, why }`, or null), and `state().net.text`, the chip.
    5. `docs/TESTING.md`, DESIGN §8 (the line's words), `.claude/rules/game.md`.
  - Acceptance (tests first):
    - **Unit tests**:
      - the card's words for each reason and place;
      - the wait's rounding at 0, 59, 60, 3,599 and 7,200 s;
      - the budget's local reopening time across a time zone offset;
      - the chip's text.
    - **`m13-queue.spec.ts`** (hub 8838, `MAX_SESSIONS=1`):
      - A is seated;
      - B's title shows the card: 1st in line, `why` full, a wait in words;
      - B swims as a practice cell from the card;
      - A's page closes, and B's toast shows within 20 s;
      - B returns to the title and hatches a recorded creature;
      - screenshots of the card at 960 × 540 and 390 × 844 are attached.
    - `m4-lifecycle` reads `state().queue` instead of the old chip text.

### The release gate

- [ ] T11 A load test in the release gate (after T7, T8)
  - Steps:
    1. **`m13-load.spec.ts`** (`@slow`, hub 8837):
       - 40 headless clients (T7's) join around the world's centre over 30 s;
       - pages A and B hatch among them (low preset) and swim with `debug.steerTo` for 3 minutes of their own play.
    2. **The checks**, upper bounds only, since a slow runner sends fewer messages, never more:
       - **Per page**, after its first seated minute (`GET /v1/e2e/sessions`):
         - incoming messages per seated minute at most 1.5 times `MEASURED`'s page total;
         - `where`, `progress`, `ping`, `signal` and `avail` each at most 1.5 times the model's rate, plus 1.
       - **Hub-wide** (`/v1/e2e/metrics`):
         - request-equivalents per seated player-minute at most 1 (ADR 0008's 20 messages);
         - the meter's messages equal the sum of the sessions' `received` within 2%.
       - **Clean**: no socket closed for its rate, no `where` dropped, and no audit flag today.
    3. `docs/TESTING.md`: the hub and what it guards.
  - Acceptance:
    - It passes 3 times in a row locally (`--repeat-each=3 --workers=1`).
    - It fails when a page's `where` cadence is broken on purpose: a temporary local change that reports every tick, not committed.
  - Notes: this guards the page's real cadence against the model, which the headless clients can't. The storage per player-hour is guarded by `worker/storage.test.ts`, as now.

### Closing

- [ ] T12 End-to-end scenario, documentation sync
  - Steps:
    1. **`POST /v1/e2e/usage { requests }`** (E2E entry only) sets today's request-equivalents. `tools/worker-bundle.test.ts` guards it.
    2. **`m13-lifecycle.spec.ts`** (`@slow`, hub 8839, `MAX_SESSIONS=2`, `MATING_SCALE` 0.01), in order:
       - **Full**: A and B hatch and are seated. C opens and waits with `why: 'full'`, 1st in line with a wait in words, and swims as a practice cell.
       - **A seat frees**: B's page closes. C hears its seat, and C's next hatch is recorded.
       - **A reload**: A reloads and is seated again at once.
       - **Budget**: the test sets today's requests past 90% of the budget. D opens and waits with `why: 'budget'`, and its card names the reopening hour. A reloads again, inside the 2 minutes, and is seated past the budget. A and C play on, and neither is dropped.
       - **Metrics** (`/v1/e2e/metrics`):
         - seated 2, queued 1, admission `budget`;
         - `today.waits` 1, `byType` holding `where`, `progress` and `ping`;
         - `perPlayerMinute` set;
         - the relay reports counted with 0 KB.
       - **Reopening**: C's page closes, which frees a seat but not the budget, so D still waits with `why: 'budget'`. The test then sets today's requests to 0, and D is seated within the next queue tick (15 s) and hatches.
       - **The end**: every page closes, `GET /v1/audit` shows no flag today, and the metrics' `today.waits` is 2.
    3. **Sync**:
       - DESIGN §8: drop the M13 marks for what shipped, and remove the replaced paragraph;
       - `docs/TESTING.md`: the hooks, and hubs 8837–8839 (the next file takes 8840);
       - `.claude/rules/{worker,net,game}.md`;
       - `docs/SETUP.md`;
       - `docs/ROADMAP.md`'s brief coverage stays as it is.
    4. **The Playtest issue and the release**: list the owner checks (the rubric's `(owner)` lines), and the release notes: protocol 13, no world renewal, the plan variable.
  - Acceptance:
    - Every exit criterion maps to a named test or report (the table below).
    - Each PR E2E part stays under 5 minutes, and the long scenarios are `@slow`.

## Exit criteria → evidence

| Exit criterion (ROADMAP) | Tasks | Evidence |
|---|---|---|
| Load simulation to 10k concurrent players | T3, T5, T7, T11 | `npm run sim:load` at 10,000 with its six gates (`docs/perf/load.md`) and the scaled `heavyTest`; T3's `speedTest`s at 10,000 members; `npm run load:hub` with 500 real clients (`docs/perf/hub-load.md`); `m13-load` in the release gate |
| Measured authority, storage and relay costs | T1, T4, T6, T7, T8 | `/v1/metrics` (the meter's hub tests); per-message CPU flat from 50 to 500 (`docs/perf/hub.md`, its `speedTest`); rows, bytes and CPU per player in `hub-load.md`; relay reports from pages (T4's tests, `m12-spawn`); bandwidth and overlay in `load.md`; storage in `storage.md` |
| `docs/CAPACITY.md` | T8 | generated by `npm run report:capacity`, regenerated byte for byte in a test, with tables at 5, 50, 200, 1,000 and 10,000, free and paid; the capacity ADR |
| Admission queue within the free tier or the €10 ceiling | T9, T10, T12 | T9's hub tests (three reasons, the measured wait, seats kept, the TURN guard, the plans); `m13-queue`; `m13-lifecycle`; the allowances' $4.50 test (T8) |
| Outline: metering, `/v1/metrics` (T1, T4); load simulator in process at 10k (T5) and a real-workerd run of about 500 clients (T7); overlay, bandwidth and storage models (T5, T7, T8); `docs/CAPACITY.md` at 5, 50, 200, 1k and 10k, free versus paid (T8); admission queue with position and ETA (T9, T10); sharding only if the measurements demand it, with a new ADR (T8, the capacity ADR); a small `@slow` load test in the release gate guarding per-player costs (T11) | T1–T11 | as listed in each task |

## End-to-end check

`m13-lifecycle.spec.ts` (T12, `@slow`, hub 8839) plays the line from every side:
- a full world queues a newcomer with its place and a wait, and lets it swim meanwhile;
- a freed seat seats it, and its next hatch is recorded;
- a reload keeps its seat, even past the budget;
- a spent budget queues the next newcomer with the reopening hour, and drops no seated player;
- `/v1/metrics` shows all of it, by type and per player;
- the budget's reset reopens the line.

Each part is also checked alone:
- `m13-queue` (T10): the card, the practice swim and the seat;
- `m13-load` (T11): a real page's cost per minute among 40 clients, against the model;
- T9's hub tests: each reason, the wait's accuracy and the TURN guard.

The reports (T5–T8) carry the evidence at populations no E2E can reach.

## Rubric

- [ ] A waiting player knows at a glance why it waits, where it stands in line and roughly how long, at 960 px and at 390 px wide (evidence: `m13-queue`'s screenshots).
- [ ] The wait is honest: with steady departures, once two seats have freed, each waiter's wait comes within 30% of its first estimate, and a spent budget names the hour it reopens (evidence: T9's hub tests, `m13-lifecycle`).
- [ ] `docs/CAPACITY.md` answers on its first screen how many the free plan serves, what $9.50 buys and what 10,000 players cost (evidence: its summary).
- [ ] A player's cost doesn't grow with the population (evidence):
  - world messages per player-minute in the hold at 10,000 are within 1.25 times the wave's at 300 (`load.md` against `wave.md`);
  - the CPU per message at 500 seated is within 1.5 times that at 50 (`hub.md`).
- [ ] (owner) During a playtest, `/v1/metrics` shows per-player costs and a relay share within a factor of two of `docs/CAPACITY.md`'s assumptions. Paste its JSON into the Playtest issue, or run `npm run report:capacity -- --metrics <file>`.
- [ ] (owner) The capacity summary is enough to decide between staying on the free plan and paying.

## Risks

- **The harness at 10,000 may run for hours.**
  - T5 profiles it first, and the pairwise gates may be judged on a seeded sample.
  - The scaled `heavyTest` gates every change.
  - If the full run can't make 45 minutes, its hold shortens to 3 minutes, and the report says so.
- **Local CPU isn't production CPU.** The model doubles the local measurement and keeps one object at half a core (ADR 0067). `hub-load.md`'s whole-runtime CPU per message cross-checks T6's per-type figures.
- **The free plan's storage per object is unclear** (1 GB or 5 GB). The model takes 1 GB, and the storage line stops new sessions before the limit. The capacity ADR may pull the log window.
- **The relay share is unknown until playtests**, and pages' reports are untrusted. The model assumes 15%, and reports are clamped and can only cost newcomers their relay. The owner check compares the live share.
- **The headless clients open no WebRTC link.** Their hub signals follow the in-process rate, and T11 checks a real page's own cadence.
- **A busy morning can spend the free plan's day.** The line names the reopening hour, and seated players and quick reloads keep their seats.
- **Merge conflicts between parallel tasks.**
  - T1's SQL wrapper touches every module's SQL, so T2 follows it.
  - T2 and T4 both touch `sessions.ts` (T4 adds `why`, T2 indexes the line) and `lives.ts` (T4 adds relay reports, T2 removes scans). Each change is small, and T9 builds on both.
  - `protocol-defs.ts` is T4's alone.
  - `worker/plan.ts` is created by T1, and T8 adds to it.
- **One object might serve fewer than 200 players.** T8 stops and the spec gains a task for the hottest path. T2 and T3 remove the known growth first.
- **Large tasks** (T1, T2, T5, T7) may overrun one session. Every run pushes its work in progress (ADR 0042), and a task that fails across three runs is split (the `next` skill).
