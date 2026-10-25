# 0007: Peer-to-peer networking: our own WebRTC mesh, hub signaling, TURN

- Status: accepted
- Date: 2026-10-25

## Context

The brief asks for WebRTC P2P with "Trystero or an equivalent discovery layer". Public Nostr or WebTorrent relays *can* bootstrap discovery, but signaling must be dependable, with NAT/TURN fallback, and must not assume that public relays or direct P2P always work. Area of interest (ADR 0013) caps each browser at 16–32 active connections, including boundary neighbours, witnesses and handoffs, so a browser must choose which peers it connects to. Trystero connects every member of a room to every other (a full mesh per room) and gives no per-peer control. Friends must be able to play from the Pages link without any setup.

## Decision

- **`PeerMesh` (`src/net/peer-mesh.ts`)**: our own manager of native `RTCPeerConnection`s, using the "perfect negotiation" pattern (polite or impolite by id order). Each connection has two DataChannels: `state` (unordered, `maxRetransmits: 0`) for snapshots, and `event` (reliable, ordered) for claims, chat, courtship and encounter traffic.
- **Hard cap**: 24 connections by default, never more than 32. Priority classes decide eviction: encounter and witness duty, then creatures that can interact (by distance), then the rest of the AoI, boundary neighbours and handoff pre-connects (ADR 0013).
- **Signaling**: through the authority's hub WebSocket (ADR 0008). Offers and answers are non-trickle, sent once ICE gathering completes or after 2 s, which keeps it to two messages per connection. From M11, signaling for new connections relays through already-connected peers, with the hub as fallback, so authority traffic stays flat as the mesh grows.
- **ICE**: STUN from `stun.cloudflare.com` and Google. TURN from Cloudflare Realtime: the Worker mints short-lived credentials and delivers them in the session welcome; the TURN key never reaches the browser. If minting fails, the client degrades to STUN-only and the UI says so.
- **Authority over state**: a client is authoritative only for its own creature's free-roam movement. It sends 10 Hz snapshots, and remote creatures render from a 120 ms interpolation buffer. Anything that changes another creature or a lineage goes through an explicit protocol: deterministic food claims, courtship and mating through the authority, refereed encounters.
- **Messages** are versioned, size-capped and validated before use. Binary codecs carry snapshots; small validated JSON carries events. Malformed input is dropped and counted, never thrown into the game loop.
- **Tests** never touch public STUN, TURN or relays. Unit tests use fake transports. E2E connects real WebRTC between browser contexts on localhost (host candidates only, mDNS obfuscation disabled) through a local Worker.

## Consequences

- Connection choice and the cap are ours, so AoI, witnesses and handoffs fit one budget.
- We own connection-management edge cases (glare, ICE restarts, timeouts), handled with the standard pattern and covered by E2E.
- Dependable signaling and TURN need the owner's Cloudflare account from M2 (`docs/SETUP.md`, step 8). The cost model is in ADR 0008 and M13.
- Rejected:
  - Trystero (a full mesh per room, no per-peer selection);
  - public Nostr or WebTorrent relays (unreliable and rate-limited; the brief makes them optional);
  - relaying gameplay traffic through the server (cost, latency);
  - WebTransport (a server in the data path).
