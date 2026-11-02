# 0050: Encounters in M7: the authority referees and simulates every frame, lock-in by signed snapshots

- Status: accepted (amends 0011: the authority steps each frame itself, lock-in details, no fight persistence until M8; amends 0010: an encounter's seed uses the newest beacon the authority already holds)
- Date: 2026-11-02

## Context

ADR 0011 set the contract for combat: a locked, deterministic sub-simulation of up to 4 participants, 10 Hz frames with a referee deadline, autopilot for missing input, prediction and rollback, and bundles committed for later verification. M7 builds the first playable version with the authority as referee (M7–M9). ADR 0011 leaves these open:

- how the one Durable Object runs a 10 Hz clock with a single alarm slot (`.claude/rules/worker.md`) and no game loop;
- who knows a fight's outcome, and when;
- what a snapshot "signed for lock-in" covers, and how often peers sign, within the per-peer bandwidth budget (`.claude/rules/net.md`);
- the encounter seed when the authority holds no fresh beacon, since a lock must not wait for one;
- what happens to a fight before M8 makes it survive restarts and disconnects;
- whether combat needs a rules version bump, a world reset or a freeze (ADRs 0035, 0040).

Measured on 1,000 genesis bodies: half have no weapon power at all, and armour is under 0.03. So combat can't depend on weapons alone (ADR 0051 sets the numbers).

## Decision

**The referee core is a pure module** (`src/net/referee.ts`): frame windows, deadlines, first-input-wins, fallback markers, all driven by a clock passed in. The worker (`worker/fights.ts`) wraps it with timers and sockets. M10's witness referees reuse it.

**The authority simulates each frame as it finalizes it.** Stepping 2–4 fighters for 3 ticks costs microseconds, and the authority already runs the sim's code (shared `src/sim`). ADR 0011 had the authority re-simulate only on dispute. Instead it always knows the state, so deaths, escapes and the timeout end the fight on the referee's own frame, and the result is the authority's.

**Timers only during a fight.** A running fight holds one `setTimeout` for its next deadline. When the timer fires late, every frame that is due is finalized in order. A frame is also finalized early once every living participant's input for it is in. The object stays awake while a fight runs, which is billed as duration, not as requests. A per-frame alarm would cost one request per frame, and the object has only one alarm slot. Outside fights nothing changes: no timer, no loop.

**Lock-in:**

- **Signed snapshots.** Each client signs a snapshot every 200 ms (every second snapshot) for its engage candidates only: pond peers within ±1 tier and within 8 × the larger radius.
  - The signature is Ed25519 by the owner's key over `bs/snap/v1 ‖ 0x0A ‖ pond id ‖ 0x0A ‖ the 25 snapshot bytes`.
  - It travels on the state channel as an 89-byte frame (the snapshot, then the signature). Everyone else gets the plain 25 bytes.
  - The signer is the player, and the creature is that player's one active creature. The snapshot's `genomeRef` must match that creature's genome.
- **Engage.** The attacker sends `engage` with its own fresh signed snapshot and the target's newest one.
  - The authority checks:
    - both signatures;
    - freshness: the snapshot's pond tick is at most 9 ticks old, with 3 ticks of clock slack either way;
    - the same pond, and both creatures active;
    - ±1 tier, on biomass clamped to the authority's view;
    - neither creature spawn-protected, and neither already locked;
    - the engage range, with slack for snapshot age.
  - It sends the target `lock-ask` and uses the target's own signed answer if that arrives within 150 ms; otherwise it uses the attacker's copy.
  - Frame 0 starts 150 ms after that decision.
- **Start states.** Each snapshot is advanced in a straight line (velocity plus the current) to frame 0's pond tick. Biomass, energy and health are clamped to what the authority's last progress allows (the same growth curve as `applyReport`), and a clamp is flagged once.
  - `enc-start` carries every fighter's genome text, so no client depends on peer genome sync to simulate the fight.
  - Positions are the clients' own claims. An attacker can lie about its own position, as in free roam. Movement audits are M10.
- **Spawn protection.** A creature is protected for 15 s after a genesis hatch, a promoted child's hatch or a restore. A reload's resume grants none, so a reload is never an escape. Protection ends at the creature's first engage.
- **Ids and seed.**
  - Encounter id: `SHA-256('bs/enc/v1/id\n' ‖ JCS({ heads, t }))`, with the participants' head hashes sorted and the lock time in ms.
  - Seed: `SHA-256('bs/enc/v1' ‖ randomness ‖ id bytes)`, where `randomness` is that of the newest verified beacon the authority already holds (memory or table). Nothing is fetched at lock. With none, the randomness is empty and the round is 0. `enc-start` names the round.

**Frames:**

- 10 Hz, 3 ticks per frame. An input is a u32 code: steer, throttle, dash, stance, target, brace.
- Frame f's input is accepted from 2 frames ahead until `start(f) + 120 ms`. The first input for a frame wins. Later ones, early ones and those for finalized frames are dropped.
- A missing input is a `null` marker, and every engine computes the same autopilot input for it.
- Bundles go to the participants over their session sockets. Inputs have their own rate cap (130 per 10 s, only while locked), outside the 20-message budget for everything else.

**Locks and life while fighting:**

- Locks are in memory. A locked creature can't court, accept, promote, restore or hatch (`locked`). Its `progress` credits ticks but not its condition. Its own `death` reports are ignored: the fight decides.
- When the fight ends, the authority sets each connected participant's life state from the result. A participant who reconnects mid-fight gets its `life` only after the end.
- Old age that falls due during a fight is applied right after the fight.
- A pending child born during a fight doesn't enter it.

**No persistence in M7.** A fight lives only in the object's memory. If the object restarts mid-fight, the fight is void: no records, no result, and the locks are gone. Nothing is lost that was settled, and nobody escapes a settled consequence. M8 persists frames, recovers fights, fast-forwards reconnects and settles when everyone leaves. A participant who closes the tab still fights on by autopilot while the object runs.

**Versions.**

- Rules 9 adds encounters and carrion, with no world reset: genesis, development and inheritance are unchanged, so rules 8 records keep their meaning and `FIRST_LIVE_RULES` stays 8.
- Protocol 7 and snapshot v4 add the protected and fighting flags. No pond mixes v0.7.x clients with M7 clients.
- ADR 0040 still holds: no freeze before v1.0. Every client and the authority build bodies with the same code, which the protocol version guarantees. An encounter record names its rules version.

**Costs** (budgets of ADR 0008):

- About 10 incoming messages per participant-second during a fight (0.5 request equivalents).
- No SQLite writes until the end. Then at most 2 rows per participant (ADR 0052 adds the eaten egg's).
- Outgoing bundles are free.

## Consequences

- One code path decides every fight, so the results are identical everywhere: the referee's and every client's match, and goldens pin them in Node, Chromium and workerd.
- Combat responds quickly: lock-in is 150–300 ms on the authority, and the own creature responds in the frame it steers.
- **Explicit limits:**
  - a restart mid-fight voids it until M8;
  - the attacker's own position is unverified;
  - the seed's beacon may be minutes old, so the timing of an engage can be chosen, but randomness only varies damage by ±10% (ADR 0010's bounded effect);
  - a participant over 200 ms one-way latency often plays on autopilot.
- Rejected:
  - an alarm per frame (a request each, and one alarm slot);
  - clients reporting the outcome (a loser could deny it);
  - the authority fetching a beacon at lock (latency);
  - signing every snapshot for every peer (89 bytes at 10 Hz to 23 peers);
  - persisting bundles in M7 (M8's whole subject);
  - a world reset for rules 9 (nothing recorded changes meaning).
