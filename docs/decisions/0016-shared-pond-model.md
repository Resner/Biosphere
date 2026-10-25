# 0016: Shared pond model: local sim, hub clock, food claims

- Status: accepted
- Date: 2026-10-25

## Context

ADR 0007 makes each client authoritative for its own creature's free-roam movement and says shared food uses claims, with remotes rendered from a 120 ms interpolation buffer. ADR 0008 keeps the authority off the hot path. M2 has to turn that into a concrete pond: what each browser simulates, how they agree on time, how two players competing for one item settle it, and what a late joiner learns. The M1 sim (`src/sim`) is deterministic but single-creature in practice, and food and plumes are pure functions of the world seed and tick.

## Decision

- **Each browser simulates only its own creature** in a local `World` built from the pond's seed. Remote creatures are never stepped: they are display state rebuilt from 10 Hz snapshots (`RemoteCreature`), interpolated 120 ms behind the newest snapshot. M2 has no creature-to-creature physics, so nothing else is needed.
- **The pond clock** is the hub's wall clock. A pond has an `epoch` (hub ms) fixed when it is created, and `pondTick = floor((hubNow − epoch) · 30 / 1000)`. A client estimates `hubNow` from time pings (minimum-RTT sample of 8, then one ping a minute). On join the client sets `world.tick = pondTick`. While playing it compares the two every 10 s: a drift of 1–3 ticks is slewed by running the loop at ±2%, anything larger snaps `world.tick`. Food positions and plumes are functions of the tick, so peers see the same items to within a tick or two.
- **Food claims.** Eating applies immediately on the eater's client (prediction) and is broadcast on the `event` channel as `claim { slot, k, tick }`. `slot` is the slot id (`c3_5_s2`), `k` the cycle that was eaten. Every client keeps `World.consumed` per slot; for one `(slot, k)` the claim with the lower `tick` wins, then the lower `playerId`. A client that learns it lost reverses the energy it gained (never below 0) and shows a "stolen" cue. A claim for a cycle below the slot's current `k` is ignored. The respawn tick of a claimed slot is a function of `(slot, k, tick)`, so all clients agree on `until` once they agree on the winning tick.
- **Late joiners** receive the consumed set from the peer they connect to first, in `event` messages of at most 2 KB. Entries are never dropped (an entry is the only record of a slot's cycle `k`), so memory grows with the number of distinct slots eaten; M2 accepts that for ponds of 24 and ties it to the pond's lifetime.
- **Item at full energy**: a creature whose energy is at its maximum does not eat; the item stays. This stops waste and stolen slots (M1 let the surplus vanish).
- **Hub state is small.** The `Authority` object keeps a `ponds` table in SQLite (id, seed, epoch, spawn centre, created time; written once per pond). Membership lives in the sockets' hibernation attachments, never in rows. Players are assigned to the fullest pond with a free place, else a new one. Spawn hints are a ring around the pond's spawn centre: place `i` is at angle `i · 2.399963` rad (the golden angle) and radius `300 + 40 · members` wu, and the client then moves the point clear of plumes.
- **Peer identity is hub-vouched.** Signals are routed by the hub, which stamps each with the sender's verified `playerId`; a data channel belongs to whoever the hub routed the offer to. M2 does not sign snapshots (nothing is at stake: no lineage, no combat). Signed inputs arrive in M10.
- **Hidden tab in a pond**: the creature freezes and snapshots stop, so peers fade it out (2 s) and drop it (6 s). On return the client resnaps `world.tick` to the pond clock without catching up. Active time and lifespan (M4) make this safe.
- **Hub down**: a client that cannot reach the hub plays alone in a local pond (seed from the build, as in M1) and keeps retrying with backoff. Ponds are never merged afterwards; a retry that succeeds ends the local session at the next death or hatch.
- **Budgets**: per player, the hub sees 1 hello and 1 answer to its challenge, about 8 time pings at join then 1 a minute, 2 messages per connection set up (so ≤ 46 at the join of a full pond, once), and nothing during play except chat, which is peer-to-peer.

## Consequences

- No cheat resistance in M2 (a client may lie in snapshots and claims), accepted because nothing durable is at stake until M4. The `event` channel validation still has to be fuzz-safe.
- Peers disagree about a food item for at most one round trip, resolved by the reversal; that is visible only as a brief "stolen" cue.
- The pond clock gives M4's authority clock and M7's referee a time base to extend, but the sim does not depend on it beyond food and plumes.
- Rejected:
  - one shared simulation stepped by a host (a host leaving breaks the pond; host cheating);
  - food ownership by the hub (a hub round trip per bite, against ADR 0008's budget);
  - lockstep (latency decides everyone's frame rate);
  - first-claim-received-wins (order differs between peers, so they would diverge).
