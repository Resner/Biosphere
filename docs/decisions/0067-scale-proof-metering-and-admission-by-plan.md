# 0067: Scale proof, metering and admission by plan

- Status: accepted (amends 0008: the budgets are measured, the plan sets the limits, rows read are metered, admission queues by reason with a measured wait, and the ceiling is $9.50 a month; amends 0056: the storage limit is the plan's per object, and a store at 90% of it stops new sessions)
- Date: 2026-11-08

## Context

The brief asks for 5 to 10,000 concurrent players on minimal infrastructure, for measured authority work, storage and relay traffic, for published cost assumptions and operating limits, and for a hard ceiling of €10 a month that admission holds instead of spending more. Its definition of done shows 10,000 players by load simulation and a measured cost model, not with live players.

ADR 0008 set targets (at most 20 incoming messages per player-minute outside fights, at most 10 rows written per player-hour) and a basic queue: 200 sessions, 90% of 100,000 requests a day, 30 s a place. ADR 0056 took 5 GB as the storage limit. What M13 starts from:

- **Cloudflare's limits and prices**, checked 2026-11-08:
  - **Free plan**:
    - 100,000 Durable Object requests a day: an upgrade is 1, an incoming WebSocket message 1/20, and outgoing messages and protocol pings are free;
    - 13,000 GB-s of duration a day;
    - 100,000 rows written and 5 M rows read a day;
    - 5 GB of storage per account. The limits page gives 10 GB per object in its table, and "1 GB on the Free plan" in its FAQ.

    Free limits fail hard; they never bill.
  - **Paid plan** ($5 a month):
    - included: 1 M requests, 400,000 GB-s, 50 M rows written, 25 B rows read and 5 GB-month;
    - then: $0.15 per M requests, $12.50 per M GB-s, $1 per M rows written, $0.001 per M rows read and $0.20 per GB-month;
    - 10 GB per object.
  - **One object**: a soft limit of 1,000 requests a second, one thread, 128 MB.
  - **TURN**: 1,000 GB a month free, then $0.05 per GB, billed on the traffic from Cloudflare to the TURN client.
- **The authority sees every message it receives, and none of the relay traffic.** TURN bytes flow between the browsers and Cloudflare's relay.
- **The authority can't time itself in production**: its clocks stand still while code runs. The local runtime's clocks advance, to the millisecond.
- **Some work grows with the population.** The hub still does work per message that grows with its sockets:
  - a hub-relayed signal, a crowded report, an admission check and a witness pool each read every socket's attachment;
  - the pool reads every candidate's play from SQLite.

  `place()` tests every candidate point against every member. Rows read are a free-plan limit that nothing meters yet.

## Decision

**Evidence in three layers.** A capacity model multiplies them: `npm run report:capacity` writes `docs/CAPACITY.md`, which is generated and never edited by hand.

1. **In process, at 10,000 players.** The headless harness's clients run the page's own rules against the hub's pure parts: the directory, the crowds, placement and the witness pool. They give the per-player rates by message type, the overlay and the bandwidth, and they time the pure parts at 10,000 members.
2. **In the local runtime.** The real object, with 50 to 500 seated sessions, gives each message type's CPU and each session's attachment size.
3. **Against `wrangler dev`.** 500 headless clients on the real protocol give:
   - rows written and read, and stored bytes;
   - the runtime's CPU per message and the round trip under load;
   - a check that the meter counts what they sent.

The model has two units:
- concurrent players around the clock, for one object's limits and the paid month;
- player-hours a day, for the free plan's daily limits.

**Metering.** Per UTC day the meter counts:
- request-equivalents, and incoming messages by type;
- rows written and rows read. Every statement goes through one metered wrapper.
- upgrades and public reads;
- seated player-minutes, and the peaks of seated and waiting sessions;
- the waits of those who queued;
- what pages report of their relays.

`GET /v1/metrics` publishes these with:
- the live counts;
- the plan's limits;
- the admission state;
- the last 31 days.

It holds no identities, is cached for 60 s, and is metered as a public read.

**Relay reports.**
- **What a page reports.** Its `progress` says how many links it holds, how many of them run through its own TURN allocation, and how many KB it received over those since its last report (`getStats`).
- **The clamp.** The authority caps each report at 4 KB/s per link since the session's last report.
- **Trust.** Reports are untrusted. They feed the metrics and the TURN guard only, so the worst a false one can do is cost newcomers their relay.

**Plans.** `worker/plan.ts` holds the dated tables above.
- **Which plan.** `PLAN` is `free` unless the owner sets `paid`, through a GitHub Actions variable passed at deploy.
- **The ceiling** is **$9.50 a month**: €10 at an exchange rate of 0.95 dollars per euro, the lowest of the last decade.
- **The paid month is spent in equal daily allowances.** Each meter's allowance is its included amount plus a share of the $4.50 above the base. The capacity model sets each share from the measured mix.
- **Free storage.** The free plan's storage per object is read as 1 GB, the stricter of Cloudflare's two figures, until its documentation agrees on more.

**Admission** keeps every limit and never drops or re-queues a seated player. A new session waits in line when one of these holds:
- `full`: seated sessions and away fighters reach the session cap. The cap is the smaller of the plan's cap and 80% of one object's capacity (below).
- `budget`: the day's request-equivalents, rows written or rows read reach 90% of the plan's daily allowance.
- `storage`: the database reaches 90% of the plan's storage per object.

The estimated wait is measured:
- for `full`, the session's place times the mean interval between the last 20 seats freed (30 s until two have freed);
- for `budget`, the time to the next 00:00 UTC, plus that;
- for `storage`, none: the owner must act.

**The TURN guard.** Once the clamped reports pass 90% of the month's TURN allowance, new welcomes carry STUN only. TURN credentials then last an hour instead of a day, so the guard holds within an hour.

**One authority, with headroom.**
- **No work that grows with the population.** No message's or alarm's work may grow with the number of sockets or members. In-memory indexes, rebuilt after a wake, replace the scans, and the pure parts stay within their budgets at 10,000 members.
- **One object's capacity.** One object serves a population while the model keeps all three of these:
  - its CPU, the local runtime's measurement doubled, at most half of one core;
  - its incoming messages at most 1,000 a second;
  - its memory at most 64 MB.

  The largest such population is its capacity.
- **What 10,000 players need.** The milestone's last measuring task records that capacity in a new ADR, with what 10,000 players need.
- **Sharding** is built only if one object can't serve 200 players, M14's playtest. Otherwise admission's cap keeps the live world within one object, and the ADR records the design and the cost of the shards that 10,000 players would take.

**What M13 leaves alone** unless the numbers demand it:
- checkpoint compaction (ADR 0056's lever);
- the newcomer's dial and the lone creature's report (ADR 0066's levers).

The capacity model weighs each of them. The one storage lever M13 may pull is ADR 0056's window: fight logs kept for 7 days instead of 14, if the free plan at its full daily allowance would fill its store within 90 days.

## Consequences

- **The ceiling holds by construction** for everything the authority meters. TURN, which it can't meter, is bounded by the session cap, and the guard stops it for newcomers. A month can still pass its TURN allowance by up to an hour of relay at the moment the guard trips.
- **The free plan can stop admitting new players** for the rest of a UTC day after a busy morning. The queue says when it reopens.
- **A full store stops new sessions** until the owner acts: the paid plan, a shorter log window or compaction. `docs/CAPACITY.md` says how many days each plan's store lasts.
- **10,000 concurrent players are shown by simulation and priced.** The €10 ceiling doesn't buy them, and admission keeps the live world to what it does buy.
- **Rejected:**
  - metering TURN through Cloudflare's analytics API (an owner token the Worker shouldn't hold);
  - queueing every newcomer when the TURN allowance runs low (most players never need a relay);
  - hourly allowances (the free plan enforces daily limits, as ADR 0008 meters them);
  - building shards ahead of a measured need;
  - taking a fixed per-message CPU from the documentation's 1,000 requests a second instead of measuring it.
