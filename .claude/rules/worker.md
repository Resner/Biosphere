---
paths:
  - "worker/**"
---

# Authority Worker (`worker/`)

ADR 0008 is the contract: one Worker and one SQLite Durable Object, minimal by design.

- No game loop and no simulation ticking on a timer. Handle messages and alarms only. Encounter refereeing (M7) runs timers only while a fight is active.
- Budgets:
  - ≤ 1 request-equivalent (20 incoming WebSocket messages) per player-minute outside fights;
  - ≤ 10 SQLite row writes per player-hour.
  Meter usage per UTC day and queue new sessions before any free-tier limit is reached, never after.
- Handlers are idempotent (keyed by transaction hash) and do every state change in a single SQLite transaction. Schema changes are numbered migrations.
- Use hibernatable WebSockets (`ctx.acceptWebSocket`) and keep per-socket state in attachments. Protocol pings use auto-response so they don't wake the object.
- Accept requests only from the Pages origin and localhost. Validate every message with the shared codecs. Rate-limit each session.
- Secrets (TURN key, the Cloudflare token for deploys) come only from Worker secrets or GitHub secrets. Never put them in code, logs, responses or tests.
- Tests run offline in workerd (`@cloudflare/vitest-pool-workers`) and through local `wrangler dev`, with drand and Cloudflare APIs faked or replayed from fixtures.
