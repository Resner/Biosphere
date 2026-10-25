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
- `src/net/protocol.ts` is shared with `worker/`, so keep it free of DOM and Node APIs.
