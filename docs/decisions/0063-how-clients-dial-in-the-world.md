# 0063: How clients dial in the world: the headless harness's link model

- Status: accepted (amends 0062: P2 to P4 reach by whichever of two creatures sees further, an offer carries the caller's class and is admitted by it, calls are paced, and the harness's gates)
- Date: 2026-11-07

## Context

M11 T10 built the headless area-of-interest harness (`tests/aoi-harness.ts`): simulated clients running the real `AoiManager`, `WhereReporter`, `Gossip` and `SignalRoute` against the real `Directory`, over a seeded link model. ADR 0062 fixed what each piece decides; it did not say how a page turns the plan into calls. The harness has to, and what it needed is what the page (T13) must do. Running it found three faults in 0062's rules and set four gates differently from the spec's first words.

## Decision

**What the harness found, and the rules that fix it.**
- **A giant's AoI is wider than a neighbour's query radius** (a tier-3 creature sees about 20,000 wu, a tier-2 one queries about 11,000). The giant called creatures that had no class for it, and they refused. A creature is now in the AoI of whichever of the two sees further (`AoiManager.classify` takes the larger of its own AoI and the other's at that creature's radius, for P2, P3 and P4). Both ends want the link, and refusals in the `tiers` scenario fell from 227 to 24.
- **A hub-relayed signal carries a directory position that is up to 30 s old.** A callee that judged the caller from it refused calls that were in range. An offer carries the class its caller holds the callee in (0 to 4), inside the relay's signature, and `admit` takes the better of that and the callee's own class. This is a deliberate trust decision: a caller can over-claim a class, and the cost is bounded by the cap and by the callee dropping the link once its own snapshots put the caller out of every class for 3 s. (Having the relay stamp a fresh position instead would need the hub to know one; it knows only the last report.)
- **A relayed offer that a peer cannot pass on is lost silently**, and the hub's resend comes 4 s later: longer than a P1's 3 s lead. P0 and P1 calls go through the hub.

**How a client dials** (the page's plan loop, every 500 ms and at once when the directory answers or an offer comes in):
- P0 and P1: at once, through the hub, whatever the cap's room (the cap rule of 0062 decides which are kept).
- P2 to P4: a call goes through a peer when a linked peer's gossip placed the target in the last 10 s; otherwise through the hub, but a client holding 4 links or more makes one such call at a time, so the first link's gossip can carry the rest. A creature younger than 8 s dials freely (it has no links to carry its offers). At most 8 calls a plan.
- Beyond P1 the lower id calls; the higher waits 1.5 s for it.
- A P4 is called only on a fix of the target under 5 s old (a directory entry may be 30 s old).
- A refused call is answered, not left to time out; the callee's answer is a message like any other, and cancels the caller's hub resend. A refused P3 or P4 is not asked again for 5 s, then 10 s, doubling to 60 s; P0 to P2 are asked again at once. An offer unanswered after 8 s is dropped.
- Two offers that cross: the lower id keeps its own and ignores the other; a repeated offer from a caller already admitted is answered again.

**The gates, as the harness judges them** (`docs/perf/aoi.md`):
- The first minute of a creature's life, when it dials everyone around it, is measured apart from the later minutes: at most 6 incoming authority messages per player-minute (median) and 12 (p95) afterwards, at most 48 (p95, two messages for each of 24 links) in the first.
- Friends are linked within 3 s at the median and 5 s at the p95. One attempt in 20 fails and is retried, and each retry adds about 2.3 s, so no p95 of 3 s is reachable with the spec's own link model (ICE 0.5 to 2 s).
- A remote that comes into view is linked for 0.5 s when it closes at 100 wu/s or less (the lead's basis). At 200 wu/s the 600 wu lead is 3 s, less than an offer, ICE and a hello can take once an attempt fails.
- A pair within 8 × the larger radius is linked once it has been within P1 reach for 10 s, so a creature survives three failed attempts; a side that is crowded, or has 24 or more P1 within reach, is excused.
- The two dense scenarios (`crowd`, `witnesses`) assert the cap, the tier rule, the swarm and the duties; the budget and the late-entry gate are reported only. In them a pair that drifts past the P1 hold and back within a few seconds can come into view before its link is up (about 3 in 1,000 entries); M12's crowded instances own it.

## Consequences

- Known limits of the pair rule: the other creature's AoI is taken at its radius, not its adult radius (not known to the other end), so a growing creature's two ends can still differ a little; a giant's wide AoI puts a smaller creature's far P2 to P4 candidates ahead of its nearer ones in class order, within the cap.
- The dial rules and their constants live in the harness until T13 builds the page's loop; they are provisional until then, and T13 re-runs the harness against that loop (`docs/perf/aoi.md`) rather than copying the numbers.
- The spec's first numbers stay the targets (friends linked within 3 s at the p95, remotes closing at 200 wu/s linked ahead of view); the gates above are what the link model reaches, and they move with it (ICE at 0.5 to 2 s, 5% of attempts failing).
- `AoiManager.classify` changes (P2 to P4 reach); `docs/DESIGN.md` and `.claude/rules/net.md` say so.
- T13 builds the dial loop above and adds the class to `signal` and `relay` (a protocol change in `protocol-world.ts`, covered by the relay's signature).
- `docs/perf/aoi.md` is the evidence for the milestone's budget and handoff rows; M13's capacity model reads its message rates.
- The harness's numbers are a model of the page, not of real networks: the owner's playtests judge the real thing.
