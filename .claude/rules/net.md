---
paths:
  - "src/net/**"
---

# Networking (`src/net`)

ADRs 0007 and 0013 are the contract.

- At most 32 `RTCPeerConnection`s per browser (24 by default), counting boundary neighbours, witnesses and handoffs. Never evict priority classes P0 (encounter and witness duty) or P1 (creatures that can interact).
- Never hide an opponent who can still affect the player: every creature within interaction range and ±1 tier is connected, or shares no instance with the player.
- Every inbound message is untrusted: check its version, cap its size (snapshots are fixed-size; events ≤ 2 KB) and validate it before use. Malformed input is dropped and counted, never thrown into the game loop.
- A peer is authoritative only over its own creature's free-roam movement. Changes to other creatures or to lineages go through claims, the authority or a referee.
- Bandwidth: about 10 Hz snapshots of ≤ 32 bytes per peer, reduced by distance and tier (M11). Keep it under about 4 KB/s per connection.
- No per-frame or per-snapshot authority traffic. The authority sees joins, signaling, critical transitions and batched commitments (budget in ADR 0008).
- Tests use fake transports, or real WebRTC between local browser contexts through the local Worker. Never public STUN, TURN, relays or the production authority.
- `src/net/protocol.ts` re-exports `protocol-defs.ts` (types, constants, snapshot codec) and `protocol-parse.ts` (untrusted-JSON parsers); all are shared with `worker/`, so keep them free of DOM and Node APIs.
- Proxy frames (`peer-mesh.ts` `onProxy`, `pond-sync.ts`): a 57-byte frame carries an away fighter's pose, relayed by a peer who fights it. It is never the sender's own pose, and the receiver drops it (`net.proxyDropped`) when the sender's own snapshot isn't fighting, when that player sent its own snapshot in the last second, or past 3 away players per peer. A proxied fighter is drawn faded and never offered for an attack.
- A fight's wire (`encounter-sync.ts`): the referee's `enc-start` repeats for a resync (after a reconnect or an authority restart) with the history, which replaces the client's own; an input for a finalized frame is `late` and never changes a bundle. Tune the lead's constants against `docs/perf/netcode.md` (`npm run report:net`), not by feel.
