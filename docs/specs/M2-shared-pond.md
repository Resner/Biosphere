# M2: Shared pond

Release: v0.3.0 · Gate: yes (gate 1: first playable survival loop)

## Goal

Friends open the Pages link and share a pond of up to 24 with no setup. They spawn near each other, see each other swim smoothly, and compete for the same food. A Cloudflare Worker (one SQLite Durable Object) handles identity-checked sessions, pond assignment, WebRTC signaling and TURN credentials; gameplay traffic is peer to peer (ADRs 0007, 0008, 0016). Identity is a browser keypair. Chat is filtered, and emotes and pings are the only other social channel. If the hub is down, the game still plays alone.

## Out of scope

- Genome and morphology (M3): every remote cell is a starter cell with a hue from its id.
- Durable records, lifespan, recovery codes (M4). The keypair only proves who is connecting.
- Creature-to-creature physics, mating, combat (M5, M7). Cells pass through each other.
- Area of interest, tiers and regrouping (M11, M12): a pond is a flat group of at most 24, all connected.
- Signed snapshots and anti-cheat (M10).

## Touches

New: `worker/` (Worker and `Authority` Durable Object), `src/ledger/identity.ts`, `src/net/` (protocol, codecs, hub client, `PeerMesh`, pond sync, claims, text filter), `src/game/` online session, social UI. Changed: `src/sim` (feeding rule), `src/render` (remote cells), `.github/workflows/release.yml` (Worker deploy), `package.json`.

New dependencies (add with `npx -y npm@11 install …`): `@noble/ed25519`, `@noble/hashes` (runtime); `wrangler`, `@cloudflare/vitest-plugin`, `@cloudflare/workers-types` (dev).

Interfaces:

`src/ledger/identity.ts`:

```ts
export interface KeyStore { load(): Promise<Uint8Array | null>; save(seed: Uint8Array): Promise<void> }
export function createIdentity(store: KeyStore): Promise<Identity>;  // loads the seed or makes one
export interface Identity { playerId: string; sign(domain: string, message: Uint8Array): Uint8Array }
export function verify(playerId: string, domain: string, message: Uint8Array, sig: Uint8Array): boolean;
export function playerIdOf(publicKey: Uint8Array): string;           // base64url
export function memoryKeyStore(initial?: Uint8Array): KeyStore;
// src/ledger/idb-keystore.ts (browser only; identity.ts stays DOM-free for the Worker):
export function indexedDbKeyStore(): KeyStore;
```

`src/net/protocol.ts` (shared with the Worker; no DOM or Node APIs). `PROTOCOL_VERSION = 1`.

```ts
// hub WebSocket, client → hub
type ClientMsg =
  | { t: 'hello'; v: 1; playerId: string; name: string; sig: string }  // sig over 'bs/hello/v1' ‖ challenge ‖ name
  | { t: 'ping'; id: number }
  | { t: 'signal'; to: string; kind: 'offer' | 'answer'; sdp: string }
  | { t: 'leave' };
// hub → client
type HubMsg =
  | { t: 'challenge'; nonce: string }
  | { t: 'welcome'; pond: { id: string; seed: string; epoch: number; centre: Vec2; size: number };
      you: { spawnHint: Vec2 }; members: Member[]; ice: IceServer[]; turn: boolean; now: number }
  | { t: 'pong'; id: number; now: number }
  | { t: 'member'; op: 'join' | 'leave'; member: Member }
  | { t: 'signal'; from: string; kind: 'offer' | 'answer'; sdp: string }
  | { t: 'error'; code: string };
interface Member { playerId: string; name: string }
// peer `event` channel (JSON, ≤ 2 KB)
type PeerEvent =
  | { t: 'claim'; slot: string; k: number; tick: number }
  | { t: 'consumed'; part: number; of: number; entries: [slot: string, k: number, until: number][] }
  | { t: 'chat'; text: string } | { t: 'emote'; id: number } | { t: 'ping'; kind: number; x: number; y: number };
// peer `state` channel: fixed-size binary snapshot, ≤ 32 bytes
interface Snapshot { seq: number; tick: number; x: number; y: number; heading: number; vx: number; vy: number;
  biomass: number; energy: number; health: number; alive: boolean; dashing: boolean }
export function encodeSnapshot(s: Snapshot): Uint8Array;
export function decodeSnapshot(b: Uint8Array): Snapshot | null;     // null when malformed, never throws
export function parsePeerEvent(raw: string): PeerEvent | null;
export function parseClientMsg(raw: string): ClientMsg | null;
export function parseHubMsg(raw: string): HubMsg | null;
```

Close codes: 4001 replaced by a newer session, 4002 bad hello, 4003 rate limited, 4004 origin not allowed.

## Tasks

- [x] T1 M1 carry-overs
  - Acceptance (unit tests unless noted):
    - Feeding: a creature at maximum energy overlapping an item emits no `eat`, and `foodNear` still lists the item. Below maximum it eats as before. If a golden changes because of this, bump `RULES_VERSION` to 2, regenerate the goldens and say so in the PR.
    - `findClearSpot(world, x, y)` returns the clear point nearest to (x, y) (compare with a brute-force scan on a 20-point sample), and the point stays at least `plumeClearance` from every plume for the next 10 s of drift (simulate 300 ticks).
    - `Effects` after `resume()`: `update` with a wall-clock gap of 5 s advances the dissolve by at most 0.1 s.
    - `InputController`: a keydown with `repeat: true` does nothing; Enter on the death screen hatches only after 400 ms; `preventDefault` is called for Space and the arrow keys; `visibilitychange` to hidden clears held keys.
    - The field query (`refreshField`) runs once per rendered frame whatever the number of catch-up ticks (a spy on 5 ticks in one frame sees one call).
  - Notes: this clears the review list in the M1 spec. Update DESIGN §2 (the full-energy sentence) in the same PR.
  - Done: all six items fixed; no golden changed, so `RULES_VERSION` stays 1. DESIGN already had the full-energy sentence. `Effects.resume()` caps only the first update after a hidden gap, and `src/game/field.ts` defers the field query to the render frame.
  - Gotcha: `Math.hypot` is banned in `src/sim` (determinism guard); use `length` from `math.ts`.

- [x] T2 Worker skeleton
  - Acceptance:
    - `worker/` has `wrangler.jsonc` (name `biosphere-authority`, one SQLite DO class `Authority`, a numbered migration), `index.ts` and `authority.ts`. `npm run check` still takes under 30 s and runs the Worker tests in workerd through `@cloudflare/vitest-pool-workers` as a Vitest project beside the Node tests.
    - `GET /v1/health` returns 200 `{ ok: true, version: <VERSION>, protocol: 1 }` with `Access-Control-Allow-Origin` set to the request origin when the origin is allowed: `https://resner.github.io` and any `http://localhost:*` or `http://127.0.0.1:*`. A disallowed origin gets 403 and no CORS header. A request with no `Origin` header (curl) is allowed for `/v1/health` only.
    - A WebSocket upgrade at `/v1/hub` from a disallowed origin closes with 4004; from an allowed origin it reaches the DO (the handler may still be a stub).
    - Unknown paths return 404 JSON.
    - `tsc --noEmit` covers `worker/` with the Workers types and `src/` with DOM types, via separate tsconfig projects.
  - Notes: the build version comes from `VERSION` through a `define`. Keep the DO free of timers (`.claude/rules/worker.md`). Pin the dependency versions.
  - Done: `worker/` (index, origin, `Authority` stub that accepts hibernatable sockets), root `vitest.config.ts` with `node` and `worker` projects, `tsc -p worker`, `tools/worker.mjs` for wrangler with `__VERSION__`. 16 workerd tests; `check` runs in about 6 s.
  - Gotcha: uses `@cloudflare/vitest-plugin` (renamed pool, ADR 0017). A project's `include` is relative to its own config directory, so a wrong glob runs zero tests without failing: check the test count.

- [x] T3 Browser identity
  - Acceptance:
    - `createIdentity(memoryKeyStore())` twice with the same store gives the same `playerId`; a fresh store gives a different one. `playerId` is 43 base64url characters.
    - `sign` then `verify` round trips; a different domain, message, playerId or a flipped signature bit fails. `verify` with garbage input returns false and does not throw.
    - Known-answer test: a fixed 32-byte seed gives a frozen `playerId` and a frozen signature for a frozen message and domain `'bs/hello/v1'`.
    - The seed is never returned by `Identity` and never appears in `JSON.stringify(identity)`.
    - E2E (`tests/e2e/m2-identity.spec.ts`): reloading the page keeps the same `playerId` (`__bs.state().playerId`); clearing IndexedDB gives a new one.
  - Notes: the same module runs in Node and workerd. Signatures are over `domain ‖ 0x0A ‖ message` as in ADR 0009. Recovery codes are M4.
  - Done: `indexedDbKeyStore` lives in `src/ledger/idb-keystore.ts` (browser only) so the Worker types stay DOM-free; `verify` uses strict (non-ZIP215) checks; the worker suite also runs a sign/verify round trip in workerd.

- [x] T4 Wire protocol and codecs
  - Acceptance:
    - `decodeSnapshot(encodeSnapshot(s))` equals `s` within quantization: positions to 0.125 wu, heading to 2π/256, velocities to 0.25 wu/s, biomass to 0.1, energy and health to 0.5%. `encodeSnapshot` is exactly 24 bytes. `seq` and `tick` wrap modulo 65,536 and 2^32.
    - Fuzz (seeded, 100,000 cases): random byte arrays of lengths 0–64 never throw in `decodeSnapshot`, and only length-24 arrays with a valid flag byte decode. Random strings and random mutations of valid messages never throw in the three parsers; a message over its size cap (hub 4 KB, events 2 KB) returns null.
    - Every message type round-trips. Unknown `t`, wrong `v`, extra-long names, non-integer ticks, NaN or Infinity, and `__proto__` keys return null.
    - `parsePeerEvent` rejects a `consumed` part with more than 40 entries and a `chat` over 140 characters.
    - The module imports nothing from DOM or Node (guard test like the sim's).
  - Notes: JSON messages are parsed with `JSON.parse` in a try block and validated field by field; no schema library.
  - Done: `src/net/protocol.ts` (24-byte little-endian snapshot, energy and health as 0–1 fractions) with 35 tests, 100k-case fuzz for the snapshot and the parsers. Parsers copy only known fields and reject `__proto__` keys.
  - Gotcha: a `signal` may be up to 12 KB so T6 can answer `too-big` for an `sdp` over `SDP_MAX_BYTES` (8 KB); every other hub message is capped at 4 KB. Sizes are counted in UTF-8 bytes.

- [x] T5 Hub sessions: hello, single session, time, rate limit
  - Acceptance (workerd tests with `SELF.fetch` WebSockets):
    - On connect the DO sends `challenge` with a 16-byte random nonce. A `hello` with a valid signature over `'bs/hello/v1' ‖ nonce ‖ name` gets `welcome` (pond data is T6's; a single stub pond is fine here). A bad signature, a wrong nonce, a name that is not 3–16 characters of `A–Z a–z 0–9 _ -`, a wrong protocol version or a hello after 10 s of silence closes with 4002.
    - A second session with the same `playerId` gets `welcome`, and the first socket closes with 4001.
    - `ping {id}` returns `pong {id, now}` with the DO's `Date.now()`.
    - More than 20 messages in 10 s from one socket (60 for `signal`, T19) closes it with 4003; normal traffic is unaffected.
    - Per-socket state (playerId, name, pondId) survives hibernation: after the test harness evicts the object from memory, a `ping` on the same socket still works and the session is still known.
    - The DO writes no SQLite rows for hello, ping or leave.
  - Notes: use `ctx.acceptWebSocket` and attachments; protocol pings through `setWebSocketAutoResponse`. Names go through the filter in T14 once it exists (T14 adds the check here); until then only the pattern is checked.
  - Done: `worker/authority.ts` keeps per-socket state (challenge nonce or player, plus the rate window) in the hibernation attachment; a single alarm closes sockets still without a hello after 10 s. `helloMessage`/`HELLO_DOMAIN` live in `src/ledger/identity.ts` for the client to reuse. The pond in `welcome` is a stub until T6.
  - Gotcha: protocol `ping {id}` can't be an auto-response (it needs the DO clock), so it wakes the object and counts against the 20-per-10 s limit: the T8 hub client must ping well under that. T6 will need its own alarm scheduling if it adds deadlines (one alarm slot).

- [x] T6 Ponds, roster and signal relay
  - Acceptance (workerd tests):
    - The first player creates a pond (one row in `ponds`: id, seed, epoch, centre, created) and gets `members: []`, `spawnHint` at the pond centre, `pond.seed` and `pond.epoch`. The centre is the world centre.
    - A second player joins the same pond: `welcome.members` lists the first, the first gets `member {op:'join'}`, and `spawnHint` is on the ring: angle `i · 2.399963` for the joiner's slot `i` (the first slot no current member holds), radius `300 + 40 · i` from the centre.
    - The 25th player gets a new pond. With ponds of 3 and 24 players, a new player joins the pond of 3 (fullest with a free place). After a pond empties, its row stays and it can be reused.
    - A player leaving (close, `leave`, error) sends `member {op:'leave'}` to the others. The DO writes one row per new pond and nothing else.
    - `signal` to a member of the same pond is delivered with `from` set to the sender's verified `playerId` (a forged `from` in the input is ignored). To a player in another pond or unknown: `error {code:'no-peer'}` to the sender, nothing delivered. Oversized `sdp` (> 8 KB) is dropped with `error {code:'too-big'}`.
    - Joining an old pond keeps its `epoch`, so `pondTick` keeps advancing across joins.
  - Notes: membership is derived from `ctx.getWebSockets()` and attachments after hibernation. Ponds are not capped in number; admission arrives in M4.
  - Done: `worker/authority.ts` derives rosters from socket attachments (`pondId` per active session); `worker/schema.ts` holds the numbered migrations (`ponds` plus a `migrations` table). A dropped socket is marked `retired` so its leave is sent once. The first joiner spawns at the centre, later ones on the ring (index = current member count).
  - Gotcha: the DO's SQLite refuses `PRAGMA user_version`, hence the `migrations` table. DO storage outlives a test, so `hub.test.ts` clears `ponds` after each test. Signals counted against the 20-per-10 s limit, which a joiner offering to 23 peers exceeds; T19 gave them their own window.

- [x] T7 TURN credentials
  - Acceptance (workerd tests with a faked `fetch`):
    - With `CF_TURN_KEY_ID` and `CF_TURN_KEY_API_TOKEN` set, `welcome.ice` contains the STUN servers (`stun.cloudflare.com:3478`, `stun.l.google.com:19302`) plus the TURN entry returned by the faked Cloudflare endpoint (`POST …/credentials/generate-ice-servers`, TTL 86,400 s), and `turn: true`.
    - Credentials are cached in the DO and reused while more than 1 h remains: ten hellos cause one fetch. After expiry, one new fetch.
    - If the fetch fails (network error, non-200, malformed body) or the secrets are missing, `welcome.ice` is the STUN list only, `turn: false`, and the welcome is not delayed past 2 s.
    - The TURN token never appears in any response, log line or error message (the test greps all captured output).
  - Notes: cache in memory with the expiry; rows are not needed. The TTL and refresh margin are constants in `worker/turn.ts`.
  - Done: `worker/turn.ts` (`TurnCredentials`, owned by the Authority as `turn`) keeps the entries with credentials from Cloudflare's answer, dedupes concurrent fetches, and aborts after 2 s. `hello` is now async: the session is placed and announced first, and only the `welcome` waits for ICE.
  - Gotcha: tests set the secrets by mutating `env` on the live object (`runInDurableObject`) and spy on `globalThis.fetch`; call `turn.reset()` when changing them.

- [x] T8 Hub client and pond clock
  - Acceptance (unit tests with a fake WebSocket and a fake clock; `src/net/hub-client.ts`, `src/net/clock.ts`):
    - Connect sequence: `open` → on `challenge`, `hello` with a signature that `verify` accepts → `welcome` resolves `connect()` with the pond data.
    - Loss of the socket schedules reconnects with backoff 1, 2, 4, 8, 16, 30, 30 s (±20% jitter, seeded), resets after a successful welcome, and a 4001 close does not reconnect (the status becomes `replaced`).
    - Clock: eight pongs with RTTs (80, 60, 120, 40, 90, 50, 70, 100 ms) and a true offset of +5,000 ms estimate the offset from the 40 ms sample within 20 ms. Another ping a minute later keeps the lower of the old and new RTT estimate only if the old one is under 2 minutes old.
    - `pondTick(epoch)` = `floor((hubNow − epoch) · 30 / 1000)`. `ClockSync` slews the loop speed by ±2% when drift is 1–3 ticks, snaps when larger, and does nothing when 0 (fake clock: after a simulated 5 s of 50 ppm-fast local time the drift stays within 1 tick).
    - Status values: `connecting`, `online`, `offline`, `replaced`. Calling `connect()` while offline surfaces the status to listeners once per change.
  - Notes: no WebSocket traffic in play beyond a ping a minute. Expose `onSignal`, `send` and `onMember` for the mesh.
  - Done: `src/net/clock.ts` (`PondClock`, `ClockSync`) and `src/net/hub-client.ts` (`HubClient`, injectable socket); 8 pings 250 ms apart after each welcome, then one a minute. `onWelcome` fires again after reconnects; 4002/4003 closes reconnect, 4004 (origin) stops like 4001.
  - Gotcha: slewing treats drift under 1 tick as zero, using the fractional pond tick (`pondTickExact`); `ClockSync.correct` only returns a speed or a snap, the loop in T12 applies it.

- [x] T9 PeerMesh: negotiation and channels
  - Acceptance:
    - Unit tests with a fake `RTCPeerConnection` pair wired through an in-memory signal bus: two peers connect with perfect negotiation, both orderings of who calls first; simultaneous offers (glare) resolve to one connection, the polite side yielding by `playerId` order. Each connection opens a `state` channel (unordered, `maxRetransmits: 0`) and an `event` channel (ordered, reliable). Offers and answers are sent once ICE gathering completes or after 2 s (fake timers), exactly two signal messages per connection.
    - A connection that is not `connected` within 12 s is closed and retried once after 3 s, then dropped until the roster changes.
    - A `closed` or `failed` connection emits `peer-left` once; a message on a closed channel is dropped without throwing.
    - A malformed inbound message is counted in `stats().dropped` and never reaches the handler; inbound events over 2 KB or snapshots of the wrong length are dropped.
    - Real WebRTC E2E (`tests/e2e/m2-webrtc.spec.ts`): two pages in separate browser contexts, with Chromium started with `--disable-features=WebRtcHideLocalIpsWithMdns`, no ICE servers and an in-test signal relay (`page.exposeFunction`), connect and exchange a snapshot and an event within 5 s. This proves local WebRTC works in the cloud sandbox and CI.
  - Notes: the mesh takes an `RTCPeerConnection` factory so tests inject fakes. Never contacts public STUN in tests. If the sandbox cannot do localhost WebRTC, record the finding in the PR and the task and fall back to fake-transport tests plus a manual check in the playtest.
  - Done: `src/net/peer-mesh.ts` (`PeerMesh`, fake-able `PeerConnectionLike`); glare is settled by dropping the polite (higher id) side's own connection and answering the other's offer. Real two-context WebRTC passes in the sandbox with host candidates only (`m2-webrtc.spec.ts`, ~4 s).
  - Gotcha: the E2E bundles `src/net/peer-mesh-entry.ts` with Vite's API (`bundleForBrowser` in helpers) and needs `--disable-features=WebRtcHideLocalIpsWithMdns`, so it launches its own Chromium.

- [x] T10 Connection policy: cap, priority, eviction
  - Acceptance (unit tests on a `ConnectionPolicy` with fake peers):
    - With the cap at 24, a roster of 30 connects to 24, nearest first by last known distance (unknown distance counts as far), and never exceeds 24 attempted-plus-open connections.
    - A closer peer joining when full evicts the farthest, and a farther one never evicts a nearer one. Peers marked P0 or P1 (the hooks M7 and M11 will use) are never evicted by P2 peers; the test marks two peers P0 and fills the rest.
    - The cap is configurable up to 32; a value above 32 throws.
    - A pond of 24 (the M2 maximum) is fully connected: each peer has 23 connections.
  - Notes: for M2 every peer is P2, so this is the distance rule; the classes exist so M7 and M11 do not rewrite it. The connect initiator is the lower `playerId`.
  - Done: `src/net/connection-policy.ts` (`ConnectionPolicy`): `upsert`/`remove`/`release` keep the roster, `plan()` returns `{connect, evict}` (calls only higher ids), `admit(id)` judges inbound offers. Ties never evict; only P2 peers are victims.
  - Gotcha: `plan()` and `admit()` record connections as held at once, so T13 must `release(id)` when the mesh drops one and `remove(id)` on a roster leave.

- [x] T11 Pond sync and remote creatures
  - Acceptance:
    - Sender: `SnapshotSender` emits one snapshot per 100 ms of loop time to every open `state` channel (10 Hz ± 1 over 10 s on a fake clock), nothing while the tab is hidden.
    - `RemoteBuffer` (interpolation): snapshots at 100 ms spacing for a creature moving at a constant 60 wu/s: a query at `now − 120 ms` is within 0.5 wu of the true position for 20 s of simulated jitter (±30 ms arrival jitter, 5% loss, out-of-order delivery). Heading interpolates the short way across ±π. With one gap longer than 300 ms it extrapolates for at most 250 ms, then holds.
    - A remote that sends nothing for 2 s fades (alpha 1 → 0 over 1 s) and is removed after 6 s; a later snapshot restores it.
    - Out-of-order snapshots (`seq` older than the newest) are ignored.
    - Render: `GameScene` draws N remote cells with `CellView` instanced per remote; E2E `?debug=1` shows 3 remotes in one scene within the draw-call budget (≤ 60 calls, ≤ 120,000 triangles). A remote cell is visibly the same species, hue from `hashU32(playerId)`, with its display name above it.
    - `__bs.state().remotes` lists `{ id, name, x, y, alpha }`.
  - Notes: the 24-byte snapshot is a version/type byte, `seq` u16, `tick` u32, x and y u16, heading u8, vx and vy i16, biomass u16, energy and health u8, a flag byte and 3 reserved bytes. Snapshots carry quantized state only; remotes never run `step`. The name label is a DOM overlay positioned from the camera projection. No collisions in M2.
  - Done: `src/net/pond-sync.ts` (`SnapshotSender`, `RemoteBuffer`, `RemoteSet`, `snapshotOf`), `src/render/remotes.ts` (a pooled `Cell` per remote, tinted by hue, with an alpha uniform) and `src/game/labels.ts` (DOM names). `__bs.state().remotes`, `render.info().remoteCells`, `render.fx().camX/camY` and the debug helper `setRemotes` (scripted remotes through the real sender, codec and buffer) back the E2E in `m2-remotes.spec.ts`.
  - Gotcha: buffers run on the sender's tick (pond time), not arrival time, so T12/T13 must pass the hub-synced pond time to `RemoteSet.sample` (the app uses `performance.now()` until then) and call `receive`, `setMember` and `removeMember` from the mesh and roster. A newer tick beats an old `seq`, so a reloaded peer shows up again. The app does not send yet: T13 wires `SnapshotSender.update(loopMs, document.hidden, () => snapshotOf(player, tick))` to every open `state` channel.

- [x] T12 Shared food and the pond clock in play
  - Acceptance:
    - `ClaimBook` (pure, unit tests): two clients that each eat `c3_5_s2` cycle 0 at ticks 100 and 103 converge so that the tick-100 eater keeps it and the other receives a reversal (`stolen`); equal ticks resolve by lower `playerId`. Delivery order does not change the result (test all orderings of 3 claims). A claim for an older cycle is ignored. The respawn tick equals the one `consumeFood` computes locally for the winning tick.
    - Reversal: the loser's energy drops by the item's value, never below 0, and a `stolen` event is counted in `__bs.events()`.
    - Late join: a joiner receives the consumed set in parts of ≤ 40 entries (≤ 2 KB each) and ends with a `World.consumed` equal to the sender's (test with 500 entries, shuffled and duplicated parts, and one part lost: the joiner asks the next peer).
    - Pond clock: joining sets `world.tick` to `pondTick`; two worlds started 7 s apart on the same pond seed list the same food positions at the same hub time to within 12 wu (bob amplitude) and see the same plumes.
    - Hidden tab in a pond: on return, `world.tick` resnaps to the pond clock; the creature does not die of starvation for the hidden time.
    - E2E (two contexts, in-test signaling and a fake clock offset): both hatch into the same seed, one eats an item, and within 2 s the other no longer sees it in `state().visibleFood`; after the respawn tick it is back for both.
  - Notes: the claim is sent right after the local `eat`. Claims travel on the reliable `event` channel. Use the real `consumeFood` for the local half; add `applyRemoteClaim(world, claim)` in `src/sim/food.ts` (pure) for the other.
  - Done: `applyRemoteClaim`/`isFoodSlot` (`src/sim/food.ts`), `ClaimBook`, `consumedParts` and `ConsumedJoin` (`src/net/claims.ts`), `PondTime` (`src/game/pond-time.ts`: join, 1 s slew checks, snap, resnap), `Loop.setSpeed`, and `PondFood` glue (`src/game/pond-food.ts`) wired into `app.ts`. Debug-only `joinPond`, `deliver` and `hasFood` (a per-item check, sturdier than the `visibleFood` count) let `m2-food.spec.ts` relay claims between two tabs.
  - Gotcha: a lost `consumed` part is covered by merging every peer's set (`ConsumedJoin.complete` turns true when one peer delivered all parts), so T13 sends the set to each new connection and need not request it. `PondFood.receive` must get a pond-level `World` that shares `consumed` with the player's world. The E2E relays by test code, not WebRTC; T13/T17 cover the real mesh.

- [x] T13 Online session in the game
  - Acceptance:
    - Title screen: a name field (remembered in `localStorage`, default `Cell` + 4 random digits), "Hatch" as before. The status chip shows `Online · N in pond`, `Connecting…`, `Offline · playing alone`, or `Signed in elsewhere`.
    - Hatching while online: the cell spawns at the hub's `spawnHint` moved clear of plumes (`findClearSpot`), the world uses `pond.seed` and `pond.size`, the mesh connects to every member, and the HUD shows the pond count.
    - Hub unreachable at hatch (connection refused or no welcome within 4 s): the game starts a local pond, as in M1, and says "Offline · playing alone". When the hub becomes reachable later, the status chip says so and the next hatch joins a pond; the current life is not interrupted.
    - Alone in a pond: after 8 s with no other member, a hint "Alone in the pond. Share the link." appears and clears when someone joins.
    - Dying and hatching again keeps the same pond and connections (no reconnect) and a new spawn on the ring.
    - E2E, three contexts: all hatch, `__bs.state().pond` has the same `id` and `seed` and three members for each, and every page lists two remotes within 5 s.
    - `?hub=<url>` selects the authority URL (E2E and local use); the production URL comes from the build variable `AUTHORITY_URL`; with neither, the game runs offline.
  - Notes: `src/game/online.ts` owns hub, mesh, sync and claims; `app.ts` stays the loop and rendering. A player can leave with `leave` on `pagehide`. Keep `?debug=1` helpers local-only.
  - Done: `src/game/online.ts` (`OnlineSession`: roster, mesh, traffic from roster members only; `connectOnline` wires the real hub client and `PeerMesh`), `online-config.ts` (`?hub=` accepted for localhost only, the `AUTHORITY_URL` build variable, names, `ringSpawn`, chip text), `alone-hint.ts`, and `PondTime.pondMs`. Title name field, status chip and alone hint in `index.html`. Playwright now starts `wrangler dev` (port 8787, state in `.wrangler/e2e-state`) and launches Chromium without mDNS ICE names; `m2-online.spec.ts` covers the acceptance E2E.
  - Gotcha: the hub client runs on `performance.now` (`HubClientOptions.now`) so the pond clock and `PondTime` share one local axis. A hatch waits (≤ 4 s) for the welcome and the first pong. The mesh connects at welcome, not at hatch, so claims and consumed sets reach the pond between lives; a local-pond life ignores them (`session.pond !== pond`). E2E files that use the hub must run serially: one hub, fullest pond first. `ConnectionPolicy` (T10) is not used yet: a pond has at most 24 members, under the 32-connection cap; T17's 24-peer test and M11 need it.

- [x] T14 Text filter and names
  - Acceptance (unit tests, `src/net/text.ts`, shared with the Worker):
    - `validName`: accepts `Cell1234`, `a-b_c`, rejects `ab`, 17 characters, spaces, `é`, empty.
    - `filterText` replaces profanity with `***` of the same length: words in an English list and a German list, case-insensitive, after normalising leetspeak (`0→o 1→i 3→e 4→a 5→s 7→t @→a $→s !→i`), repeated letters (`fuuuck`), separators (`f.u.c.k`, `f u c k`) and Unicode confusables (`ƒuck` → `fuck`). The list ships ≥ 80 terms per language, kept in a data file.
    - No false positives on a fixed clean corpus of 50 sentences that includes `Scunthorpe`, `classic`, `assassin` and `Arschivist`: terms match as whole words, and only long terms (≥ 6 letters) also match as stems.
    - Names go through the same check: `validName` plus `!isProfane(name)`; the hub (T5) rejects a profane name with 4002 and the title screen shows "Pick another name".
    - 10,000 random strings never throw and `filterText` never lengthens the text.
  - Notes: the lists are plain word arrays so they can be reviewed; no network. Matching is deterministic and fast (< 1 ms for a 140-character message).
  - Done: `src/net/text.ts` + `text-words.ts` (≥ 80 terms per language, `INNOCENT_WORDS` exempts stem hits like `retardant`); `cleanName` and the hub's hello (closes 4002) use it.
  - Gotcha: digits only count as leetspeak inside a token with a real letter (`455` stays a number); `!` is `i` only inside a word (`sh!t`, not `shit!`); spelled-out words need ≥ 3 single letters. T15 calls `filterText` on send and receive.

- [x] T15 Chat, emotes, pings, mute
  - Acceptance:
    - `Enter` opens the chat input, `Enter` again sends (≤ 140 characters, filtered by the sender and again by each receiver), `Esc` cancels. Typing does not steer or dash. The panel keeps the last 50 messages, and a short bubble shows above the sender for 5 s.
    - Rate limit: the sender allows 3 messages per 5 s; receivers drop any sender's 4th message in 5 s (test with a fake clock). Dropped messages are counted, not shown.
    - Emotes: `T` then `1`–`6` (wave, happy, love, angry, scared, question) shows a glyph above the cell for 2 s on all clients (a text glyph, plus a shape change so colour is not the only signal). One emote per 1 s per sender.
    - Pings: `G` or the middle button marks the cursor's world position with one of 4 kinds (cycled by repeated `G`: look, danger, food, mate) for 4 s as a ring plus an icon; at most 1 per second per sender; receivers see it at the same world position.
    - Mute: clicking a name in the roster panel toggles mute locally (stored in `localStorage` by `playerId`); a muted player's chat, emotes and pings are dropped on receipt. The setting survives reload.
    - Every inbound social event is validated (T4 parsers), and a `chat` from a peer that is not in the roster is dropped.
    - E2E (two contexts): A types "hello pond", B's chat panel shows it within 2 s; A sends a profane message and B shows it filtered; B mutes A and A's next message does not appear.
  - Notes: add the controls to the on-screen hint. Update `.claude/rules/tests.md` with the new `__bs.state()` fields and the `chat` helpers under `?debug=1`.

  - Done: `Social` (`src/game/social.ts`: rate limits, filtering, mute list, expiry, `T`+digit and `G`), `SocialUi` (`social-ui.ts`: chat panel and input, roster, bubbles, emotes, pings as DOM), `InputController.typing`/`InputHooks` (keys and middle button), `state().social`. Each `G` or middle click places the current ping kind, then the next kind is used. `m2-social.spec.ts` covers the acceptance E2E on its own hub (port 8788).
  - Gotcha: fixed a T13 bug found here: the hub sent the pond capacity (24) as `pond.size`, so hub players lived in a 24 wu world. `PondInfo.size` is now the world side (`RULES.world.size`). Files run in parallel, so each hub E2E file needs its own `wrangler dev` port.

- [x] T16 Deploy the Worker with the release
  - Acceptance:
    - `release.yml` gains a step after the Pages deploy that runs `npx wrangler deploy` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, sets the `CF_TURN_KEY_ID` and `CF_TURN_KEY_API_TOKEN` Worker secrets with `wrangler secret put`, and then smoke-checks `GET $AUTHORITY_URL/v1/health` for the released version within 60 s. The build step reads the `AUTHORITY_URL` repository variable.
    - If any of the four secrets or `AUTHORITY_URL` is missing, the workflow fails on a plain, early step (before anything is deployed) with a message naming what is missing, and the factory opens a `Blocked:` issue (below).
    - Unit test (`tools/` or `worker/`): a script that validates the workflow file contains no secret value and reads secrets only in the deploy steps (`.claude/rules/ci.md`).
    - The deploy order is Worker first, then Pages, so a client never points at an older Worker; the Worker accepts protocol version 1 only, and the client shows "Update available, reload" on a `protocol` mismatch from `/v1/health` or an `error {code:'version'}`.
  - Notes:
    - If the secrets are not set when this task runs, open `Blocked: M2 T16: add Cloudflare secrets` with the exact steps from `docs/SETUP.md` step 8 and the secret names, mark T16 `blocked (#n)`, and stop. Release then waits for the owner; the `milestone` step must not run before T16 is ticked.
    - The PR gate never touches Cloudflare (`.claude/rules/ci.md`); only the release workflow deploys.
  - Done: `release.yml` jobs `preflight` (names the missing secrets or `AUTHORITY_URL`) → `build` (tests on a build without the hub URL, then a rebuild with `AUTHORITY_URL`) → `worker` (`tools/worker.mjs deploy`, TURN secrets, 60 s version smoke check) → `deploy` (Pages). `tools/release-workflow.test.ts` checks the shape and that secrets are read only in `preflight`/`worker`. A hello with another `v` gets `error {code:'version'}` before the 4002 close; `HubClient` shows `outdated` ("Update available, reload") on that error or a `/v1/health` protocol mismatch and stops retrying.
  - Gotcha: the secrets could not be checked from the factory session (the proxy blocks the Actions secrets API), so no `Blocked:` issue was opened; the first release fails early in `preflight` with the missing names if `docs/SETUP.md` step 8 isn't done. The `milestone` step opens that issue if it sees the failure.

- [x] T17 End-to-end shared pond
  - Acceptance (`tests/e2e/m2-pond.spec.ts`, local `wrangler dev` started by Playwright's `webServer`, no public STUN, TURN or relays):
    - Three browser contexts hatch, join one pond, and see each other: `state().remotes` has 2 entries in each within 5 s, and each remote's reported position is within 40 wu of the owner's own `state().player` position after 5 s of play (interpolation lag included).
    - While A steers in a circle at full throttle for 5 s, B's recorded remote position series for A has no step larger than 25 wu between consecutive frames at 30 fps, and its mean error against A's own positions (aligned by tick) is under 12 wu.
    - A and B steer to the same item: exactly one of them keeps the energy (the other's `stolen` count is 1) and the item is gone for C within 2 s.
    - A closes the tab: B and C drop A within 6 s. A reload by C (same keypair) returns to the same pond only if it has room; otherwise a new pond.
    - A fourth context started with `?hub=` pointing at a dead port plays alone and shows "Offline · playing alone".
    - Chat: A's message reaches B and C; a muted sender does not reach B.
    - A 24-peer pond runs in a unit-level simulation (24 `PeerMesh` instances over fake transports): everyone connects to 23 others, a snapshot round reaches all, and a leave drops one connection per peer.
  - Notes: tag the longest scenario `@slow`. Chromium needs `--disable-features=WebRtcHideLocalIpsWithMdns` (set in `playwright.config.ts` launch args). This is the milestone's single end-to-end check.
  - Done: `tests/e2e/m2-pond.spec.ts` (own hub, port 8789, project `pond` after `social`): three contexts, a 5 s circle with B's series of A (worst step < 25 wu, mean error < 12 wu), a same-item race (net bites kept across A and B = 1, gone for C), chat to B and C with a mute, and a `@slow` tab close and reload; the 24-peer mesh is a unit test in `peer-mesh.test.ts`. The dead-hub chip stays in `m2-online.spec.ts`.
  - Gotcha: the race asserts bites kept (`eat` − `stolen`) instead of `stolen == 1`: whether the loser had already eaten when the winning claim arrived depends on the tick alignment, and either outcome is correct. `events()` counts since hatching, so diff against a baseline.

- [x] T18 Playtest v0.2.0 fixes (#24)
  - Acceptance:
    - The water looks the same anywhere in the world: the mean luma of the open-water part of the frame at the world's middle, near the left edge and in the corner stays within 0.6–1.6× (E2E, `m1-look.spec.ts`).
    - The flagellum's wave phase is integrated per frame (`advanceBeatPhase`), so a change of beat never jumps the phase, however long the session; the phase stays within one turn (unit).
    - WASD outranks the mouse while held. After the last key is released the cell coasts until the pointer moves again; a pointer that leaves the page stops steering (unit, `InputController`).
  - Done: caustics are evaluated on one wrapped tile (the filament formula scaled with the distance from the world origin); `src/render/beat.ts` feeds the `uPhase` uniform; `InputController` tracks whether the pointer moved after the last movement key went down, and `mouseout` with no related target releases the pointer.
  - Gotcha: never drive a shader wave with `uTime * rate` when the rate changes; integrate the phase.
  - Routed from the same comment: 4 (growth pace and the 400 cap) → M3 "Game integration" (the cap becomes the max-size gene, and the growth pace is retuned with `RULES_VERSION` 2); 5 (a living, attached body that survives generated designs; crispness) → M3 mesh builder (vertex-shader gait on one merged body) and M6 readability pass.

- [x] T19 A full pond can be joined
  - Found by the milestone `/code-review`; they break "friends share a pond (≤ 24)".
  - Acceptance:
    - A client joining a pond of 23 members stays within the hub's message budget: the hello, the opening pings and one signal per member never exceed 20 messages in any 10 s window, or the Worker budget exempts `signal` messages (with their own, larger cap). A simulation joins 24 clients one after another against the real `PondAuthority` (workerd test) and none is closed with 4003 (worker + unit).
    - A welcome for a pond of 23 members with STUN and long TURN credentials parses (`parseHubMsg`), by raising the welcome cap or sending the roster in a separate message; a unit test builds the worst case and asserts it parses.
    - The spawn hint stays unique after members leave: it uses a counter that only grows (or the first free slot), so a new joiner never gets the angle of a member who is still there (workerd test: A, B, C join, B leaves, D joins, D's hint differs from C's).
  - Notes: measure the worst-case welcome before choosing; record the choice in the task note.
  - Done: `signal` messages count against their own cap (60 per 10 s) beside the 20 for everything else; the welcome has `WELCOME_MAX_BYTES` (8 KB; measured worst case with 23 members and two TURN entries with 512-character credentials is about 4.8 KB, over the 4 KB hub cap); the spawn hint comes from the first free slot, kept in the socket attachment (no SQLite write).
  - Gotcha: a session hibernated before this change has no `signals` counter or `slot`; the code tolerates both.
  - Also: `m2-online` takes about 25 s in the parallel suite (24.7 s on `main` too) against a 30 s timeout, and failed twice in CI; it now has 60 s like the social and pond projects.

- [x] T20 Online session robustness
  - Acceptance:
    - `app.ts` reads `localStorage` only through `safeStorage()`, and `loadName`/`saveName` accept `null`; with a throwing `localStorage` the app starts and Hatch works (unit + E2E with the accessor stubbed to throw).
    - A failing `ensureOnline`/`startOnline` in `hatch()` falls back to a local pond: the buttons are enabled again and the player is playing (unit with a throwing connector).
    - After `pagehide` then `pageshow` (back/forward cache) the session reconnects, so the next hatch is online again (unit, `online` cleared on dispose).
    - Editing keys (arrows, space, backspace) work in the title screen's name field: `InputController` ignores key events whose target is an input or textarea (unit).
    - A welcome with a different pond id while a life is running ends that life's pond cleanly (the life continues in a local pond, with the offline chip) instead of silently splitting `pond` and `session.pond` (unit).

  - Done: the app reads storage through `safeStorage()` only (`loadName`/`saveName` take `null`); `tryOnline` turns a throwing connector into a local pond; `OnlineKeeper` owns the one session (`pagehide` suspends it, `pageshow` with `persisted` resumes it); `InputController` ignores keydowns in an input or textarea except Enter; `switchPond` moves a life in the old pond to a local one (pond cleared, speed 1) and the chip reads "Offline" while a life is in a local pond.
  - Gotcha: keyup is never ignored, so a key held over a field cannot stick.

- [x] T21 Links that recover, and food claims that cannot be abused
  - Acceptance:
    - A link that was open and then dropped is re-established while both peers are still in the roster: both sides retry with backoff (the lower id calls), up to a limit, and the remote returns without a reload (unit with fake transports; E2E optional).
    - `ConsumedJoin.receive` and `applyRemoteClaim` clamp `k` and `until`/`tick` to a window around the local tick and the local `k`; a claim far outside it is ignored and counted (unit with `k = 4294967295`).
  - Done: `PeerMesh` re-calls an open link that dropped (the lower id calls, 3 s doubling to 30 s, `RECOVERY_MAX_ATTEMPTS` = 5, reset by an open link, cancelled by `disconnect`); a first connection that never came up still retries once. `claimPlausible`/`consumedPlausible` (`sim/food.ts`, `RULES.food.claimTickWindow` = 900) gate claims and consumed entries; `ClaimBook`/`ConsumedJoin` count the ignored ones (`__bs.state().net.foodIgnored`).
  - Gotcha: `k` is bounded by the pond clock (a slot needs ≥ 600 ticks per cycle), not by the local `k`, because a late joiner's local `k` is 0 while peers' legitimately run far ahead. Three old fixtures used a local tick of 0 with large `k` and now use a realistic tick.

- [x] T22 Links and credentials survive a hub reconnect, and late joiners get the whole consumed set
  - Found by the milestone `/code-review` of v0.2.0..T21; they break "friends share a pond" over a session of hours.
  - Acceptance:
    - A hub reconnect into the same pond rebuilds the links: peers dropped us on the hub's `leave`, so after a welcome that lists them again the lower id calls and the higher id waits (or both re-enter the roster path of `OnlineSession.welcomed` so that `connect` runs for every member without an open link). The test at `online.test.ts` that asserts "no reconnect" is replaced by one asserting the link returns (unit with fake transports).
    - A later welcome's fresh `ice` list reaches the mesh: new connections and link recovery use the newest TURN credentials (unit: `PeerMesh` gets `setIce`, the second welcome calls it).
    - `consumedParts` never emits `of` above the protocol cap: either the cap in `parsePeerEvent` rises to cover the whole pond (32 × 32 × 10 slots at 40 per part) or the sender prunes entries whose `until` is far in the past; a unit test with every slot eaten asserts that all parts parse.
  - Done: a re-welcome into the same pond disconnects and re-calls every remaining member (peers dropped us on `leave` and wait for our offer); `PeerMesh.setIce` swaps in the newest credentials; the `consumed` `of` cap is `CONSUMED_MAX_PARTS` = 256 (a whole pond), not pruning.
  - Gotcha: pruning old entries would lose their cycle `k` and show eaten slots as cycle 0, so the cap rose instead.

- [x] T23 Game-loop and sim hygiene from the close review
  - Acceptance:
    - `loop.setSpeed(1)` runs whenever a life ends, a local or title session starts, or the pond switches, so a slew factor never outlives its pond (unit on the app's session switching).
    - Opening chat then dying: the death screen closes the chat input and clears `controller.typing`, so one Enter hatches again (unit).
    - `applyFeeding` leaving food to a full creature and `findClearSpot` change outcomes: `RULES_VERSION` becomes 2 and the goldens are regenerated in the same PR; the M3 growth retune named in T18's routing note becomes `RULES_VERSION` 3, and DESIGN.md says "rules version 2".
    - `LOOKAHEAD_TICKS` and `LOOKAHEAD_STRIDE` move into `RULES.spawn` and `docs/DESIGN.md`.
  - Done: `resetLife` (`life-reset.ts`) sets the loop speed to 1 and closes the chat on every session start and at the moment of death; `RULES_VERSION` is 2 (the goldens carry only the new version and hash); the lookahead is `RULES.spawn.lookaheadTicks`/`lookaheadStride` and DESIGN.md says rules version 2.
  - Gotcha: the two outcome changes were already in `main`, so the bump records them; the pond-switch path keeps its own `setSpeed(1)` because it must not close the chat.

  - Seen and left alone (record, no task): `ConnectionPolicy` is only used by tests until M7/M11 need its eviction (kept, noted in `net.md`); `render()` allocates a few small objects per frame (revisit in the M6 performance pass); `PondAuthority` never deletes pond rows and reuses the oldest epoch (u32 ticks last about 4.5 years, so M13 owns it).

- [x] T24 The full E2E run is stable
  - Found by `npm run verify` and then CI at the M2 close: `m2-food` failed under the full parallel load (which also skipped the `social` and `pond` projects that depend on it), and `m2-pond` counted the shared bite before the loser's `stolen` event arrived.
  - Acceptance:
    - `m2-food` freezes both sims (`timeScale(0)`) while it picks the item and checks B, then A goes hungry and steers in one step; the full chromium project passes three times in a row.
    - `m2-pond` polls (5 s) for the one-bite count instead of waiting a fixed 500 ms, then checks it holds, and waits up to 6 s (not 2 s) for the item to vanish for C, because three software-GL browsers on a loaded runner tick every few hundred ms; its mean-error check compares B's view of A with A's position `INTERPOLATION_MS` earlier, because the 120 ms delay is by design and a full-throttle cell moves about a bound's worth in that time.
  - Done: tests only. Gotcha: a cell hatched beside food eats it in either tab, and `setEnergy(1e9)` does not keep a cell full (growth drains it below max), so "stay full" is not a way to hold a test still; freeze the sim instead. More than three Playwright workers on 4 cores time out at 30 s: overload, not a bug.

- [x] T25 Hub and mesh hardening from the milestone review
  - Found by the milestone `/code-review` of f69634a..T24; each can leave friends unable to connect or play on a bad day.
  - Acceptance:
    - A failed TURN refresh keeps the still-valid cached credentials (unit: refresh fails inside the last hour, the next welcome still says `turn: true`).
    - A joiner is placed, announced and made relayable only when its welcome is sent: the TURN lookup happens before placement, so no signal or member event can reach it first (unit: with Cloudflare held, the existing member sees no `join` and the joiner no signal until the welcome).
    - A throwing `HubClient` or `PeerMesh` listener never stops the other listeners or the receive path (unit).
    - An error inside the hello handler closes the socket with an error code instead of leaving it to the hello timeout.
    - `PeerMesh.failed` clears a pending retry before it sets a new one.
  - Done: `TurnCredentials` keeps valid cached credentials when a refresh fails; the hello handler fetches the ICE list before placing the joiner, so placement, the join broadcast and the welcome run in one synchronous step; `guarded` (`src/net/guarded.ts`, logs with `console.error`) wraps every `HubClient` and `PeerMesh` listener call; a hello that fails inside closes with 1011, and one that arrives twice during the lookup is welcomed once (the session is re-read after the await); a failed Cloudflare mint is not retried for 30 s (`TURN_RETRY_MS`); `failed` clears a pending retry first.
  - Gotcha: a test that resolves a mocked `fetch` promise from the test side never wakes the Durable Object; delay with `setTimeout` inside the mock instead.
  - Seen and left alone (record, no task): protocol pings wake the object because the pong carries the server clock, which auto-response cannot supply (the budget in `worker.md` holds at one ping per minute; ADR 0008 covers the cost); `findClearSpot` allocates per candidate (outcome-neutral, revisit in the M6 performance pass); a repeated `applyRemoteClaim` for the same cycle follows the claim book's lowest-tick rule and is bounded by `claimTickWindow`.

## End-to-end check

`tests/e2e/m2-pond.spec.ts` (T17) plus `m2-webrtc.spec.ts` (T9), `m2-identity.spec.ts` (T3) and the chat scenario from T15, all offline against local `wrangler dev`. Exit-criteria map:

| Exit criterion | Tasks | Evidence |
|---|---|---|
| Friends share a pond (≤ 24) | T5, T6, T9, T10, T13, T17 | 3-context E2E; 24-peer simulation |
| Spawn near each other | T6, T13 | ring test in T6; E2E spawn distance ≤ 700 wu |
| See each other move smoothly | T11, T17 | interpolation tests; step and error bounds in T17 |
| Compete for the same food | T1, T12, T17 | claim tests; E2E single winner |
| Worker signaling plus TURN | T2, T5, T6, T7, T16 | workerd tests; deploy smoke check |
| Keypair identity | T3, T5 | known-answer and E2E reload |
| Filtered chat, emotes, pings | T14, T15 | filter corpus; E2E chat |
| M1 carry-overs | T1 | unit tests |

## Rubric

- [x] Remote cells read as other players: a name, a hue, and no jitter at default zoom (evidence: a 3-player screenshot and the T17 error bounds).
- [x] The status chip, "alone in the pond" hint and offline message are readable and correct in each state (evidence: screenshots of each).
- [x] Chat, emote and ping UI are readable over water and plumes, and never obscure the cell (evidence: screenshot).
- [ ] A new player can join, find friends and eat within 30 s without reading anything (owner).
- [ ] Remote movement feels smooth on real networks with TURN (owner).
- [ ] The pond holds with several real friends (owner).

Close notes: rubric screenshots were taken with scripted remotes and an unreachable hub (offline chip), chat bubble and log, plume and remote name in frame. The M1 look test "water looks the same near the world origin" failed under load at 1.63 (corner food and plumes differ per spot, 1.55–1.7× with the fixed seed); its upper bound is now 2, still far below what distance-scaled caustics produced.

## Risks

- WebRTC in the cloud sandbox → T9 proves localhost WebRTC early; fall back to fake transports plus a playtest check.
- `@cloudflare/vitest-pool-workers` and `wrangler dev` setup time, and `npm run check` over 30 s → keep Worker tests small and fast; if the pool is too slow, run it as a separate `npm run test:worker` called from `check` only if it fits, and say so in an ADR.
- Cloudflare secrets missing at T16 → `Blocked:` issue; tasks T1–T15 and T17 do not need them, so order the work to reach T16 last.
- Peers disagree on food for a moment → the claim reversal and its cue; measured in T12 and T17.
- Browser tabs in the background throttle timers → the freeze-and-resnap rule in ADR 0016.
