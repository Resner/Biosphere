# 0053: Fights outlast disconnects and restarts: a saved log, recovery, reconnects, and the authority finishing an abandoned fight

- Status: accepted (amends 0011: the authority waits 10 s with nobody left before it fast-forwards, and a restart may replace up to 9 sent frames with the autopilot; amends 0050: a restart no longer voids a fight, and a player who signs in again returns into its fight instead of waiting for the result; amends 0019: a committed encounter's locked time counts as active time, with the player connected or not)
- Date: 2026-11-03

## Context

The brief asks for fights that finish whatever the network does:
- closing a tab never cancels a fight, erases accepted actions or avoids the consequences;
- the committed state and inputs suffice to finish the fight and verify it when everyone disconnects;
- reconnecting resumes the accepted state, and nobody can submit backdated actions;
- inactive and offline creatures pause, except inside committed encounters.

ADR 0011 set the contract: the authority persists bundles, writing a row every 10 frames, and fast-forwards with fallback inputs when every participant has disconnected. ADR 0050 kept fights in memory for M7: a restart voids a fight, and a player who signs in during its fight waits for the result.

M8 has to decide:
- what is written, when, and at what cost (ADR 0008: ≤ 10 row writes per player-hour outside fights);
- what a restart does to frames already sent;
- how a returning player re-enters, and where its seat goes while it is away;
- how a fight looks to others once a fighter's tab is gone;
- when "everyone left" is final;
- how the life clock counts a fight with a player away.

Cloudflare facts that shape this:
- A Durable Object's output gate holds outgoing messages until the storage writes before them are durable.
- A deploy restarts the object and closes every WebSocket.
- An eviction keeps hibernated WebSockets open, and the next message builds a new object.
- An alarm wakes an object that holds no socket.

## Decision

**The fight log** is one `encounters` row per fight (`WITHOUT ROWID`, with a partial index on open fights). It holds:
- the pond, the `enc-start` message (genome texts included) and every `enc-join`;
- the finalized bundles;
- each slot's player name and life clock at its start;
- once settled, the settlement (ADR 0054).

It is written:
- when the fight starts, before `enc-start` is sent, so the output gate never lets a client see a fight the authority could lose;
- every 10 frames (ADR 0011);
- at each join, before `enc-join` is sent;
- whenever a participant's socket closes, so a tab closing never loses an accepted input;
- at the end, inside the settlement's transaction.

A 20 s duel costs about 25 row writes (2 to open, one a second, 2 to close) on top of its records. That is about 1 row per second of fighting, which ADR 0011's per-encounter budget covers and M13 measures. The batch size is a worker constant, not a rule.

**Recovery.**
- The object rebuilds every open fight inside `blockConcurrencyWhile`, after the migrations: the locks, the authority's encounter replayed from the log, and the referee resumed at the first frame the log doesn't hold.
- Those frames are finalized afresh with the fallback marker: the up to 9 frames that were sent but not yet written, and every frame whose deadline passed while the object was down. This is the same rule as a late input. A participant's own inputs are never replaced this way, since its close flushes the log.
- Each connected participant then gets `enc-start` again and every frame and join so far. A client treats a repeated `enc-start` for its running fight as the authority's resync and replaces its own history.
- While a fight is open, the object's one alarm is held no later than the fight's latest possible end (frame 0 plus the 90 s timeout and a second). So an object nothing else wakes still finishes and settles the fight.
- A restart inside the 150 ms lock-answer window, before `enc-start`, leaves nothing: no row and no lock.

**Reconnecting.** A participant whose player signs in again during the fight:
- goes back to the fight's pond. While its fight runs, an away fighter keeps its seat in the pond's 24 and in `MAX_SESSIONS`, so neither another pond nor the queue can take it out of reach;
- gets `life` naming the fight (`fight: <enc>`), then `enc-start` and the history;
- plays on from the referee's next frame. An input for a frame already final is `late`, so nothing is backdated.

The title screen offers one button, "Back to the fight". A second tab's sign-in, which replaces the first, does the same.

**Away fighters stay visible.**
- Its opponents draw it from the encounter, which they simulate anyway, faded, until the end.
- Pond peers outside the fight get **proxy snapshots**. While a fighter's player is away, the connected fighter with the lowest slot relays that fighter's pose from its confirmed encounter state to the pond, at 5 Hz. The frame is 57 bytes: the away player's 32-byte key, then a 25-byte snapshot.
- A receiver takes a proxy for X only from a peer whose own newest snapshot carries the fighting mark, and only while X sends nothing itself for a second. It draws X faded.
- A proxy is unsigned: it shows a position and nothing else. No engage, claim or result ever reads one.

**Everyone left.** Once no fighter still in the fight has a connected player:
- the fight runs on in real time for 10 s, so a reload can still come back;
- then the authority finalizes every remaining frame at once with the fallback marker and settles. That gives the same result as playing those frames out in real time, since nobody could have sent an input, and no outsider can join: a join needs the away fighters' fresh signed snapshots.
- A fast-forwarded kill drops its carrion at the current pond tick, where the victim ended.

**Life during a fight.**
- While locked, `progress` is acknowledged and changes nothing: no condition, no credit, no unsaved state. A close during the fight writes no checkpoint, because the settlement writes every fighter's record.
- At the end, each participant is credited its locked time: the frames from its frame 0 (or its join) to the end, 100 ms each, within its lifespan, whether its player was connected or not. Old age that fell due ends a survivor right after the fight, as before.

**The consequence waits.** For a participant whose player is away at the end, the settlement's transaction stores a short report on the player row: the outcome, the killer's or eater's name and the egg. The next `life` carries it once and clears it. The title screen tells it in a line ("While you were away, Dabelothrix natans was killed by Nimbus").

## Consequences

- Closing a tab, reloading, losing the connection or a deploy never cancels or escapes a fight. Every one ends in a settlement that the authority writes once.
- **Explicit limits:**
  - An authority restart can replace up to 9 frames (0.9 s) that clients already saw, plus the frames of the outage, with the autopilot. Clients resync, and the fight may visibly jump.
  - A returning player finds that its autopilot fought for it in between.
  - A pond peer can forge a proxy snapshot of an away player, but that only moves a faded body on other screens.
  - A fight everyone abandoned ends sooner in wall time than it would have played.
- Costs:
  - about 1 row write per second of fighting, plus the open and close;
  - 2 more for each away report;
  - an alarm write at the start and the end of each fight;
  - catch-up messages to a returning player, which are outgoing and free.
- Rejected:
  - a row per frame (10 writes a second per fight);
  - keeping the log in memory only (a deploy voids every running fight);
  - logs held by the clients and signed by the authority (a participant can withhold the newest one, and with nobody connected nothing is left);
  - fast-forwarding the instant nobody is connected (a reload would end its own fight);
  - withholding `life` until the end, as in M7 (the player watches nothing while its creature fights);
  - the authority sending poses to spectators (per-frame authority traffic);
  - freeing an away fighter's seat (a reconnect could land in another pond, out of its fight).
