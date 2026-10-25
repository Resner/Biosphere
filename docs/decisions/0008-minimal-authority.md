# 0008: Minimal authority on Cloudflare, budgets and admission

- Status: accepted
- Date: 2026-10-25

## Context

The brief allows a minimal Cloudflare Worker and Durable Object setup for authority and coordination, rules out an always-running global simulation and per-frame backend writes, and sets a budget of €0 for as long as possible and never more than €10 a month, queueing players past capacity. The authority keeps only canonical state heads, single active sessions, time gates, durable commitments and recovery, and detects conflicting successors, fabricated progression and replays.

Cloudflare limits (checked 2026-10-25):

- **Free plan**: 100,000 Durable Object requests a day (incoming WebSocket messages count 20:1; outgoing messages and protocol pings are free); 100,000 SQLite row writes and 5 M row reads a day; 13,000 GB-s of duration a day; 5 GB of storage; 30 s CPU per request. Free daily limits fail hard once exceeded.
- **Paid plan**: $5 a month for 1 M requests, then $0.15 per million.
- **TURN**: the first 1,000 GB a month free, then $0.05/GB.

## Decision

- **One Worker** (`worker/`), **one SQLite Durable Object class `Authority`**, one global instance in v1. Its responsibilities:
  - sessions and presence over hibernatable WebSockets, with one active session per player;
  - the signaling hub and TURN credential minting;
  - the habitat directory (ponds in M2, quadtree from M11);
  - the ledger: identities, creature heads and records (ADR 0009);
  - the clock and time gates: active time, lifespan, maturity, cooldowns;
  - commitments: genesis, mating, witness pools (ADRs 0010 and 0012);
  - the encounter referee (ADR 0011);
  - admission, metering and the authority signing key.
- **No game loop.** The DO acts on messages and alarms only: joins, critical transitions, batched commitments, refereed encounter frames. Movement and most simulation stay P2P.
- **Budgets** (targets, measured in M13):
  - outside fights, ≤1 request-equivalent (20 incoming messages) per player-minute on average;
  - ≤10 SQLite row writes per player-hour (checkpoints are coalesced);
  - per-encounter costs as ADR 0011 describes.
- **Admission control** (basic in M4, full in M13): the DO meters requests, messages and row writes per UTC day and counts concurrent players. Past 90% of the configured daily budget or the concurrency cap, new sessions are queued with a position, so no request ever fails because a limit was hit.
- **Cost policy**: the free plan by default. If the owner chooses, the $5 paid plan raises capacity while admission thresholds keep the total under €10. `docs/CAPACITY.md` (M13) publishes the measured model.
- **Deployment**:
  - The release workflow runs `wrangler deploy` after the full tests, using the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
  - The Cloudflare TURN key (`CF_TURN_KEY_ID`, `CF_TURN_KEY_API_TOKEN`) is passed on as Worker secrets.
  - The client build reads `AUTHORITY_URL`.
  - Requests are accepted only from the Pages origin and localhost.
- **Testing**:
  - Worker code runs offline in workerd (`@cloudflare/vitest-pool-workers`, ADR 0003) and in E2E through `wrangler dev`, with drand and Cloudflare APIs faked or replayed from recorded fixtures.
  - E2E sets the authority URL at runtime and never talks to production.

## Consequences

- Infrastructure is one Worker and one Durable Object to maintain, at no cost at playtest scale.
- One DO instance is a single point of throughput (about 1,000 requests/s) and of location. M13 measures whether 10,000 concurrent players fit, and splits hubs by region only if the numbers demand it, with a new ADR.
- The owner provides the Cloudflare account and secrets (`docs/SETUP.md`, step 8). The factory never sees their values.
- Rejected:
  - an always-on game server (cost, maintenance);
  - Supabase or Firebase (more moving parts, weaker transactional guarantees for this model);
  - several DO shards before measurements show a need;
  - Workers KV for ledger state (eventually consistent).
