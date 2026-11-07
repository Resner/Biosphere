# 0062: Area of interest: the directory, link classes, discovery, relayed signaling and seat tickets

- Status: accepted (amends 0013: the classes' distances, the AoI from a 16:9 view, the fill to 8,192 wu, a crowded area flagged until M12's instances; amends 0007: either side calls, relayed signals are signed by their sender, peers prove their seat with a ticket; amends 0058: a witness's free slots are counted as links of P0 and P1, and duty links reach across the world; amends 0059: an in-time lock answer must hold one of the attacker's snapshots)
- Date: 2026-11-07

## Context

ADR 0013 decided the shape:
- a quadtree directory in the authority (split above 16, merge below 6) that is advisory;
- clients that report a cell change and a coarse position at most every 30 s, and connect peer to peer;
- five connection priorities under a cap of 24, raised to 32 for the two that are never evicted;
- two invariants, checked by property tests and simulation: no hidden interactable creature, and the cap respected.

ADR 0007 added that from M11, signaling for new connections relays through connected peers, with the hub as the fallback.

What M11 has to decide:
- the distances behind each class, since the view grows with the creature (ADR 0029) and two creatures of different sizes see different areas;
- how a client learns of creatures the directory's 30 s positions miss;
- who may call whom, and how a relayed signal is authenticated when the hub no longer stamps it;
- where names come from without a pond roster;
- what "no hidden threat" means when more creatures can interact than the cap allows (instances are M12);
- the budgets.

Facts that shape this:
- **Sizes**:
  - a hatchling starter (radius 10, adult radius 20) sees a half-height of 88 wu, and as an adult 134 wu;
  - a T1 adult of radius 100 sees 568 wu, a T3 adult of radius 1,568 about 6,700 wu;
  - every body swims 40–105 wu/s at any size, plus a dash.
- **An engage needs a link** (ADR 0050):
  - the attacker needs the target's own signed snapshot, at most 9 ticks old, which only a peer link delivers;
  - the target's answer carries the attacker's signed snapshots it received in the last 2 s (ADR 0059).
- **Links are symmetric**: if one side receives the other's snapshots, it draws them.
- Setting up a WebRTC link takes one offer, one answer and ICE gathering (up to 2 s, ADR 0007): about 1–3 s.
- **The authority pays for incoming messages** (ADR 0008): at most 20 per player-minute outside fights, and outgoing messages are free.

## Decision

**The directory** (`worker/directory.ts`) is a quadtree over the world, held in memory only.
- **Leaves**: a leaf splits above 16 members and four sibling leaves merge below 6 together. No leaf is smaller than 1,024 wu; a leaf at that size may hold more (a crowded area, below).
- **Members** are seated sessions with a creature in the water. Each holds its last report: centre, radius, AoI radius, name and time.
- **Rebuilt on wake**: a member's report also lives in its socket's attachment, so an evicted object rebuilds the tree from the attachments.
- **Reports** are a client's `where { x, y, r, aoi }`, sent:
  - when its creature enters the water;
  - when its centre leaves its leaf by more than 64 wu;
  - when its tier changes, or its AoI by more than a quarter;
  - otherwise every 30 s;
  - never more often than one per 2 s.

  `gone` takes the member out: death, the title screen, a hidden tab. A report further from the last one than 300 wu/s since then plus 2,000 wu is dropped and counted, unless a new life was bound since (genesis, promote, restore, sign-in). Fixture mode accepts such jumps, for debug teleports.
- **Each report is answered** with `near`:
  - the reporter's leaf square;
  - the 48 nearest members within the query radius `Q = max(8,192, 4 × aoi)` whose tiers are linkable (below), with names and report ages;
  - the 64 nearest members two or more tiers smaller within its AoI, as bare positions: the **swarm**.

  A split or merge sends each moved member its new `leaf`.
- **The directory is advisory.** Positions are the clients' word, ≤ 30 s old.

**Area of interest.** A creature's AoI radius is 2.65 × its visible half-height: 1.3 × the half-diagonal of a 16:9 view, whatever the player's window. A starter sees an AoI of 233 to 354 wu, a T3 adult about 17,900 wu.

**Which tiers link.** Two creatures may link only when their tiers differ by at most one, read with a 10% margin: the larger radius ÷ 1.1 against the smaller × 1.1 (`linkTiers` in `src/sim/size.ts`). The margin makes the set slightly larger than the interaction rule's (exact tiers ±1), so a creature growing past a tier edge is already linked to everyone it can now meet.

**Link classes**, from a client's own estimate of each known creature (`src/net/aoi.ts`):

| Class | Who | Enters | Leaves | Evictable |
|-------|-----|--------|--------|-----------|
| P0 | the fighters of its fight, its witness duties' peers | while the fight or duty runs, and 3 s after | | never |
| P1 | interactable: linkable tiers, within 8 × the larger radius + 600 wu | at that distance | 900 wu past the interaction distance | never |
| P2 | linkable, within its AoI | AoI | 1.1 × AoI | yes |
| P3 | boundary neighbours: linkable, within 2 × AoI | 2 × AoI | 2.2 × AoI | yes |
| P4 | handoffs: linkable, within `Q`, nearest to where the player will be in 3 s | `Q` | 1.1 × `Q` | yes |

- 8 × the larger radius is the engage-candidate distance (ADR 0050). Engage range always lies inside it.
- The 600 wu lead is about 3 s of two creatures closing at 100 wu/s each, enough to set up a link.

**The cap** (`ConnectionPolicy`):
- P0 and P1 are always held and may take the links to 32 (`MAX_CAP`).
- P2–P4 fill only the room under 24 (`DEFAULT_CAP`) that P0 and P1 leave, nearest first within each class.
- So a browser holds at most max(24, P0 + P1) links, never more than 32. A link whose class is gone closes after 3 s.
- When P0 + P1 would pass 32, the client keeps P0 and the nearest P1, and says `crowded`. M12 splits such an area into instances (ADR 0013).
- When the world is sparse, P4 links everyone linkable within 8,192 wu, about the old pond's reach. Friends who spawn together see each other as in a pond.

**Discovery has three sources**, each with an age:
- the directory's `near` (coarse);
- **gossip**: every 4 s, each link carries the sender's up to 16 linked peers nearest the receiver and linkable with it, from snapshots under 2 s old, as id, position and radius. Gossip entries expire after 10 s;
- a linked peer's own snapshots (exact).

Gossip is a hint that schedules connections, never a position the game uses. Either side may call a creature it wants; perfect negotiation settles glare. An inbound offer is admitted by the receiver's own policy, from the caller's position:
- the hub stamps its directory position on a hub-relayed signal;
- a peer-relayed offer carries the caller's own position, inside its signature.

**Relayed signaling.** To reach C, A sends its offer through a linked peer B whose gossip listed C within 10 s: a `relay` event `{ from, to, kind, sdp, at, pos, sig }`.
- The signature is A's Ed25519 key over `'bs/signal/v1' ‖ from ‖ to ‖ kind ‖ at ‖ pos ‖ SHA-256(sdp)`. The SDP carries the DTLS fingerprint, so B can neither pose as A nor sit in the middle.
- B forwards a relay only to a linked `to`, unchanged, at most 4 a second per link.
- C checks the signature, that `to` is itself, that `at` lies within 30 s of its hub clock, and that it has not seen the pair (from, at) in the last 2 minutes.
- The answer returns the same way.
- With no such peer, or no answer within 4 s, the signal goes through the hub. The hub relays between two seated sessions only when the directory places them within max(their `Q`s) + 4,096 wu, or when they are a duty pair (ADR 0058).

**Seat tickets.** The welcome carries a ticket that the authority countersigns, renewed every 10 minutes after a `pong`:
- `{ v: 1, kind: 'seat', player, name, world, t, until }`, where `until` is 15 minutes after `t`;
- countersigned with the ledger's key under `bs/seat/v1`; signing it writes no row.

A link's first event on each side is `hello { ticket }`. A peer whose ticket doesn't verify (the key, the world, its player the link's peer, not expired) within 5 s is closed and counted. Names on screen come from tickets, which are the hub-vouched, filtered names. Only seated players link, and a queued identity can't join the world through a friend's relay.

**Snapshot rates are asked by the receiver**, since the two sides see different areas:
- 10 Hz for a peer of P0 or P1, or within 1.15 × its view's half-diagonal;
- 5 Hz for the rest of its AoI;
- 2 Hz for P3;
- 1 Hz for P4.

A `rate` event goes out on a change, at most once a second per link. Engage candidates still get every second snapshot signed. Everything on screen arrives at 10 Hz.

**No hidden threats.**
- **Interaction needs a link.** No engage without the target's own signed snapshot, and a court is consented to on screen.
- **Every interactable pair is held.** P1 is symmetric (the same formula from both sides) and never evicted, so every interactable pair is linked while P0 + P1 ≤ 32. The headless harness checks this, with the cap and the handoffs, as a property test.
- **The authority closes the rest.** An in-time lock answer that holds none of the attacker's own snapshots is refused `engage:unseen` ("Not in its sight yet"), so even past the cap or with a lying client, nobody is attacked by a creature its own screen has not shown in the last 2 s.
- **Joins stay open.** A join has no answer to wait for (ADR 0059), so for joins only the AoI's P1 holds this: an explicit limit.

**Swarms.** A creature two or more tiers smaller is never linked. A giant draws each one in its AoI that the directory reports as a faint drifting cloud of motes at its reported position, at most 64 of them. Every cloud stands for a real player, with no fakes (ADR 0014), and none can be interacted with. A small creature does not see a giant two tiers up.

**Fights, witnesses and carrion in the world.**
- A fight's links are P0 across leaves and tiers until 3 s after its end.
- A witness may sit anywhere in the world. Its duty links are P0.
- A page is available to witness only while it holds at most 28 links of P0 and P1, so a referee's 4 duty links always fit under 32. This replaces ADR 0058's count of pond links.
- Every connected fighter relays an away fighter's proxy to its own linked peers outside the fight. A receiver keeps one sender per away player.
- A kill's carrion notice goes to every session the directory places within 10,000 wu: 60 s of swimming plus a stale report.
- A court needs the directory to place both within 12,288 wu (`not-near` otherwise).

**Budgets.** About 2 reports a minute plus one per leaf crossed, hub signals only where no peer can relay, and 1 KB of gossip per link every 4 s. The harness gates directory and hub signaling at a median of 6 incoming messages per player-minute, within ADR 0008's 20. A link stays under 4 KB/s.

## Consequences

- Connections stay within 32 at any population. The authority's share of the work grows with reports, not with links.
- A sparse world plays like a pond, and a crowded one keeps the nearest and every creature that can act.
- **Explicit limits:**
  - positions in reports and gossip are the clients' word, as free-roam movement is (ADR 0007), so a client can see coarse positions and names around any point it claims, within the jump bound;
  - a peer link shows each side the other's IP address, as in ponds, now to neighbours across the world;
  - a crowd of more than 32 interactable creatures is flagged, not split, until M12, though `engage:unseen` still holds;
  - joins are protected only by the AoI;
  - carrion claims reach linked peers only, so a creature two tiers away may eat a piece another already ate.
- Rejected:
  - pure P2P gossip discovery without the directory (slow convergence, Sybil-prone: ADR 0013);
  - connecting by leaf membership (a boundary splits neighbours);
  - the hub pushing every move to every neighbour (incoming reports would be the same, outgoing CPU much more, and gossip does it for free);
  - an AoI from each player's window (asymmetric, and a wide screen would see further);
  - trusting the relaying peer's word for the sender (it could pose as anyone);
  - unsigned peer-relayed offers (a relay could sit in the middle of the DTLS handshake).
