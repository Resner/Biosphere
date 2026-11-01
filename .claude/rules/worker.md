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
- Handlers are idempotent (keyed by transaction hash) and do every state change in a single SQLite transaction. Schema changes are numbered migrations (`worker/schema.ts`), applied in one transaction at start-up; one that needs the time it runs is a function of `(sql, now)`. Migration 6 is the world renewal (ADR 0040): `world` holds the epoch and reset time, `players.epoch_seen` the epoch each identity was told about.
- Use hibernatable WebSockets (`ctx.acceptWebSocket`) and keep per-socket state in attachments. Protocol pings use auto-response so they don't wake the object.
- Accept requests only from the Pages origin and localhost. Validate every message with the shared codecs. Rate-limit each session.
- Secrets (TURN key, the Cloudflare token for deploys) come only from Worker secrets or GitHub secrets. Never put them in code, logs, responses or tests.
- Tests run offline in workerd (`@cloudflare/vitest-plugin`) and through local `wrangler dev`, with drand and Cloudflare APIs faked or replayed from fixtures.
- `Authority` (`worker/authority.ts`) keeps the object's state, the alarm and the message dispatch; the handlers live by area as functions of `Hub` (`worker/socket.ts`, with `Session` and the send helpers): `sessions.ts` (sign-in, admission, ponds, signaling), `lives.ts` (genesis and life) and `offspring.ts` (mating and offspring).
- The object has one alarm slot. Only `Authority.rearm` sets or clears it, as the earliest of the hello timeout, `Beacons.nextDue()` and the 15 s admission-queue tick (held only while someone is queued); new alarm users extend it instead of calling `setAlarm`.
- The Worker has two entries: `index.ts` (production, live drand) and `e2e-entry.ts` (recorded rounds, `node tools/worker.mjs dev --e2e`). Fixture code and E2E hooks (`POST /v1/e2e/pre-reset`, M6c T2) live only in the latter; `tools/worker-bundle.test.ts` guards that.
- Hub tests that need beacons swap the live object's `source` field (`worker/test-hub.ts`: `login`, `hatch`, `useFakeBeacons`, `publish(round)` moves a fake clock and runs the alarm), so no test waits for real rounds. Tests that need the wall clock (progress, lifespan) mock `Date.now` (`worker/progress.test.ts`).
- A creature's per-connection state (`LifeState`, `worker/life.ts`) lives in the socket attachment and is written to SQLite only as checkpoint records; keep it small (2 KB limit).
- Admission (`worker/usage.ts`, `canAdmit` in `worker/sessions.ts`): `MAX_SESSIONS` and `DAILY_REQUEST_BUDGET` are `vars`; a hub test sets them on the live object's `env` (`worker/queue.test.ts`). A queued socket has phase `queued` in its attachment and costs no SQLite writes.
- `MATING_SCALE` (fixture mode only, with `DRAND_SOURCE=fixture`) shortens maturity, cooldown and the repeat window; hub tests set it on the live object's `env` (`worker/mating.test.ts`). A courtship's invitation lives in the courting socket's attachment (`court`), never in SQLite; `worker/mating.ts` must export nothing that edits a stored round.
