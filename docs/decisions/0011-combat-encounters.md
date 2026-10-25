# 0011: Combat as refereed deterministic encounters

- Status: accepted
- Date: 2026-10-25

## Context

The brief asks for automatic, deterministic baseline combat with real-time steering and a few active decisions (stance, targeting, a timed defence):

- Engagement locks the encounter and its starting states, but not the outcome.
- Actions are accepted in canonical order with deadlines; missing or late input falls back to a predefined autopilot.
- Closing a tab never cancels, erases or escapes a fight, and players cannot submit backdated actions.
- Enough is committed that a fight can finish and be verified when everyone disconnects.
- Lock-in is fast, with no beacon wait.

Unrefereed P2P lockstep can't decide "late" fairly, because a receiver could claim it never got an opponent's input.

## Decision

**Encounter** (`src/sim/encounter/`): a deterministic sub-simulation of its participants (up to 4), using the same physics plus combat rules. Hazards and currents are functions of seed and time, so they are included.

**Lock-in:**

1. The attacker engages a target within engage range: same tier ±1, not spawn-protected, neither creature already locked unless it is joining.
2. The client sends the authority its own signed snapshot and the target's latest signed snapshot (at most 300 ms old).
3. The authority checks the heads and plausibility. It uses the target's own fresh snapshot if that arrives within 150 ms, otherwise the attacker's copy.
4. Frame 0 starts 150 ms later. The start states, the seed (ADR 0010) and the participant order (by creature id) are broadcast.
5. The participants are **locked**: no mating, promotion, restore, genesis or habitat move until settlement.

**Frames:**

- 10 Hz (3 ticks per frame). An input carries steering, throttle, stance, target and brace. Clients send inputs one frame ahead.
- The **referee** finalizes frame `f` at `start(f) + 120 ms`, with inputs ordered by participant id. A missing input becomes a fallback marker, and the participant's autopilot computes it deterministically from the state and its behaviour genes.
- Inputs arriving after the deadline, or for a frame already finalized, are rejected.
- The referee broadcasts each frame bundle. Clients predict and roll back up to 10 frames when a bundle differs.

**Referee:**

- The authority in M7–M9 (inputs travel over the session WebSocket).
- From M10, a drand-selected witness peer takes over at the first frame boundary after the selection round (ADR 0012). The authority referees until then and takes over again on failure.

**Commitment:**

- Bundles are persisted by the authority, which writes a row every 10 frames.
- When a witness referees, it commits batches every second.
- The settlement record (M8) holds the start-state hashes, a Merkle root of the bundle hashes and the results.
- The authority re-simulates on dispute, when the referee fails, or when every participant has disconnected (it fast-forwards to the end with fallback inputs).

**End**: death, escape (outside 2× engage range for 3 s), or timeout (90 s). Kills move biomass to the winner and leave carrion food (`docs/DESIGN.md`).

## Consequences

- Fair "late" decisions come from a single clock, so the same accepted inputs give the same result in every engine. Disconnecting changes nothing about the outcome.
- **Explicit limits**: a participant gets at most 120 ms of lookahead within the deadline window. Snapshots used for lock-in can be up to 300 ms old. A colluding witness referee could bias deadlines, which authority audits limit but cannot rule out. Deterministic replay proves that outcomes follow from accepted inputs, not that those inputs came from a person.
- **Cost**: refereeing by the authority costs about 5–10 incoming messages per participant-second during fights. That is fine at playtest scale and cut at least 4× by witness referees (M10). The model is in M13.
- Rejected:
  - unrefereed P2P lockstep (a receiver can deny an opponent's inputs);
  - fixing the outcome at engagement (no player decisions);
  - authority refereeing forever (cost at 200 concurrent players);
  - a new beacon per action (too slow).
