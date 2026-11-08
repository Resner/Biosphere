# 0058: Witnesses: a committed pool per event, a witness referee from the round on, auditors, and authority-only flags

- Status: accepted (amends 0010: a witness commitment names the next round due at least 0.5 s ahead, or its event's own round; amends 0011: the cost cut is per witnessed participant-second and per 30 s duel, not for every fight; amends 0012: the pool is capped at 16, eligibility is measured as below, and one duty at a time stands for the free connection slots; amends 0054: the settlement document gains its referees and its witness commitment, as version 2; amends 0055: proof bundles gain witness commitments and attestations, and the verifier a witness family; amends 0056: a witness commitment is kept 14 days, an attestation for good; amended by 0062: the free slots are counted as at most 28 links of P0 and P1, and duty links reach across the one world; amended by 0069: among more than 1,024 eligible only a window is keyed)
- Date: 2026-11-06

## Context

ADR 0012 is the contract: a pool of eligible witnesses, a commitment to the event and a future drand round before the selection is known, an ordered selection with no re-draws, a referee and an auditor per encounter and an auditor per mating and genesis, the authority final, and settlements without witnesses flagged `authority-only`. ADR 0011 says a witness takes over refereeing at the first frame boundary after the round, and that this cuts the authority's cost at least 4×.

What M10 has to decide:
- which round: ADR 0010 names `latest + 2` (3–6 s ahead) for every commitment, ADR 0012 `latest + 1`;
- what the pool holds, and what that costs to store, since a pool of 200 player ids is 8.6 KB per event;
- how eligibility is measured: play time, IP independence, free connection slots, a duty limit, failures;
- how a browser referees: transport, clocks, batches to the authority, handover in both directions;
- what "signed inputs" covers, and what it costs;
- what happens when a witness fails, lies or disagrees;
- what an attestation is, where "authority-only" shows, and what verifiers see.

Facts that shape this:
- Nobody can know the witness before the round, so the authority referees a fight's opening: the round's wait (0.5–3.5 s), the beacon fetch, and a WebRTC link when the witness sits in another pond. The tournament's genesis duels last a median 10.4 s (`docs/perf/combat.md`).
- Incoming WebSocket messages are what the authority pays for; outgoing ones are free (ADR 0008).
- A peer link is set up through the hub's signal relay, which stamps the verified sender, so its data channel is authenticated to the receiver.
- Ed25519 signatures are 64 bytes. A 30 s duel has 600 inputs. Storing a signature per input would multiply the fight logs (5.4 KB) by about 8, past the storage budget of ADR 0056.

## Decision

**Eligibility.** A player is eligible for an event when:
- it holds a seat (not queued), and its client says it is available (`avail`): the tab visible, the setting "Help referee fights" on (the default), not locked in a fight, and its frame time's 90th percentile over the last 5 s at most 50 ms;
- its identity has played at least 20 minutes: the sum of its creatures' active time, as their head rows hold it, plus the time credited since;
- it is not a participant, and its IP hash differs from every participant's. The hash is SHA-256 of a salt and the `CF-Connecting-IP`; it lives in the session's attachment and never in SQLite;
- it holds no duty, and accepted fewer than 20 duties in the last hour;
- it is not struck: a failed or overruled duty strikes the player for 24 hours (`players.struck_until`).

One duty at a time stands for ADR 0012's free slots: a pond has at most 24 players, so a witness holds at most 23 pond links and 4 duty links, and a fighter 23 and 1, all within the 32-connection cap. Duty links are priority 0 and may take a browser past its default cap of 24.

**The pool and its commitment.**
- The pool is every eligible identity, cut to the 16 (`POOL_MAX`) with the lowest `SHA-256('bs/pool/v1' ‖ event ‖ player id)`, then sorted by id.
- The event is `enc:<encounter id>`, `mating:<commit id>` or `genesis:<commit id>`.
- The commitment is an ordinary countersigned commitment of kind `witness`, with data `{ event, pool }`. One event has one commitment: asking again returns the same.
- **The round.** An encounter's is the first round due at least 0.5 s after the commitment's time (`witnessRound`), so the wait is 0.5–3.5 s instead of ADR 0010's 3–6 s. A mating's or a genesis's is the event's own round, committed in the same request, so its auditor is known with the DNA. Either round is still unpublished when committed, which the verifier checks as for any commitment.
- An encounter's commitment is written right after `enc-start` goes out: lock-in never waits for it.
- An empty pool writes no commitment. The event is `authority-only` from the start.

**Selection and duties.**
- The order is a Fisher–Yates shuffle of the pool, seeded by `SHA-256('bs/witness/v1' ‖ the round's randomness ‖ the commit id)` (`witnessOrder`).
- An encounter's referee is position 0 and its auditor position 1. A mating's or a genesis's auditor is position 0.
- A duty whose witness is no longer eligible, declines, or stays silent for 5 s goes to the next unused position. Each position serves once, and at most 3 offers are made per duty. The authority's reasons for skipping a position are its word.
- The referee duty is offered once the round resolves, while the fight runs. The auditor duty is offered once the event is settled: the settlement, both births, or the genesis record.

**A witness referees.**
- The referee (W) gets `duty` with the fight's start, its history and the pond's seed, and the fighters get `duty-peer` naming W. They connect through the relay, which then passes signals between W and the fighters, across ponds too. W answers `duty-ok` once its links are open.
- On `duty-ok` the authority picks `h = next + 3`, its referee's next frame plus 3, and sends `enc-referee { from: h, by: W }` to the fighters and W. The authority finalizes every frame before `h` and W every frame from `h` on, with the same pure `Referee` (`src/net/referee.ts`) on its own estimate of the hub's clock.
- Fighters send their inputs for frames from `h` on to W over the peer link, each signed (below). Inputs that reach the authority for those frames are dropped and counted, never taken late. At a handover a client sends again, to the new referee, the inputs it already sent for frames from `h` on.
- W simulates the encounter, as every fighter does, so it knows who is out and when the fight ends. It sends each final frame to the fighters, signed by its own key.
- Every 10 frames, and at once at the end or at a stop, W sends the authority a `batch`: the frames and each input's signature.
- The authority:
  - checks that the batch continues its log, the widths, and every input's signature against its fighter's key;
  - steps its own encounter with the frames and appends them to the log, one row per batch as before;
  - sends the frames to the fighters as `enc-frame`s;
  - settles when its own encounter ends.

  The authority's frames are the fight's frames. A client that holds a different frame from W takes the authority's.
- A witness referee can't engage. Its own lock, as a target, takes its duty back.

**Take-backs.**
- A **failure** gives the frames back to the authority from `h' = max(next, the frame due now) + 2`. Every frame from the authority's last committed one to `h' − 1` is the autopilot's, as after an authority restart (ADR 0053). W is struck and flagged once, and the next position may be offered: at most 3 referees per fight. A failure is any of these:
  - no batch by `start(next + 10) + 1 s` (`witness-silent`);
  - a batch with a gap, a wrong width or an input whose signature fails (`witness-forged`);
  - W's socket closing;
  - a fighter's dispute (below) that proves W sent a frame differing from the one it committed (`witness-equivocated`).
- A **planned** take-back has no strike. It happens for:
  - a join: the authority takes the fight back first, so it can seat the joiner;
  - everyone away (ADR 0053);
  - W's own lock.

  The authority sends `enc-referee { from: due + 3, by: 'authority' }`, and W's final batch closes the gap. Without it, the gap is the autopilot's.
- A restart ends every duty. Rebuilt fights are refereed by the authority from the log's end.

**Signed inputs.**
- An input sent to a witness is signed by its fighter's player key: Ed25519 over `'bs/input/v1' ‖ encounter id (32 bytes) ‖ u16 frame ‖ u32 code`.
- W can't add or change an input without the authority seeing it. The authority checks every signature in every batch: at most 40 a second per fight, against keys tabled once per fight (`key-verify.ts`), and M13 measures the cost.
- Inputs sent to the authority ride the player's authenticated session and carry no signature.
- The log keeps the codes and no signatures. The settlement's referee spans say who refereed which frames. `docs/VERIFY.md` says that the authority checked the signatures of witness-refereed frames on arrival.

**Disputes.**
- Each frame W sends is signed by W: `'bs/wframe/v1' ‖ encounter id ‖` the frame's Merkle leaf (ADR 0054).
- A fighter keeps the last 50. When the authority's frame differs from W's, the fighter takes the authority's and sends `dispute` with W's signed frame. A dispute that holds is a failure. One whose frame equals the committed one changes nothing.
- What no one can prove: a witness that marks an input late which reached it in time. That is ADR 0011's explicit limit, now for witnesses too.

**Auditors and attestations.**
- The auditor gets the event's case:
  - a fight's log and settlement, which it replays (`verifyEncounter`);
  - a genesis's commitment, beacon and record (`checkGenesis`);
  - a mating's commitment, beacon, both parents' genomes, both `mate-commit` records and both births (`checkBirth`).

  It answers within 60 s with an **attestation** signed by its player key (`bs/attest/v1`): `{ v: 1, kind: 'attest', event, duty, position, witness, subject, agree, code? }`. The `subject` is the settlement's hash, the genesis record's hash, or `SHA-256` of both birth hashes in slot order.
- The authority checks the signature, that the witness holds that position in the order, and that the subject is its own. It stores the attestation, one row, kept for good.
- An attestation that disagrees is stored too, as overruled: the authority's result stands, the auditor is struck, and `audit-overruled` is flagged. Either the auditor lied, or two engines disagree on a deterministic replay. Both are worth seeing.
- A forged or misplaced attestation is dropped, and its sender struck.
- An auditor that doesn't answer is replaced, at most 3 times.

**Authority-only.**
- An event is authority-only when no witness refereed any of its frames and no attestation agrees with it. Nothing is written to say so: the absence shows in the documents.
- The settlement says who refereed (its spans), and the bundle carries every attestation the authority holds. So an authority that withholds an attestation makes an event look worse, never better.
- The authority flags `authority-only` once per event, when its duties end with neither, for `GET /v1/audit`'s counts.
- The card marks each fight, birth and genesis as witnessed or "checked by the authority alone", and the CLI counts them. During a fight, the combat HUD marks a witness referee.

**Documents.**
- The settlement becomes version 2: `{ v: 2, …, referees: [{ by, from, position? }], duty, … }`, in place of `referee: 'authority'`.
  - The spans start at frame 0 with the authority, in order of `from`. `by` is `'authority'` or a witness's player id, and `position` is that witness's place in the order.
  - `duty` is the witness commitment's id, or `''` with an empty pool.
  - Version 1 still parses and verifies, as authority-only.
- Proof bundles become version 2, with `witnessCommits` and `attestations`. A version 1 bundle parses as one with neither.
- The verifier gains a fifth family, `witness` (`verify-witness.ts`):
  - each witness commitment's countersignature, pool and round;
  - the order recomputed from the beacon;
  - each referee span's and each attestation's witness at its position;
  - each attestation's signature and subject.

  It counts refereed, audited, authority-only and overruled events in the report. A commitment that is pruned or not served leaves its selection unchecked, which is not a problem.

**Retention.** A witness commitment holds the pool, about 1 KB, and is kept 14 days, like a fight's log. The settlement that prunes logs also deletes up to 4 expired witness commitments. An attestation, about 300 B, is kept for good.

**Cost check.** In a hub test, a 30 s duel whose witness answers 3 s after the lock costs the authority at least 4× fewer incoming messages than the same duel refereed by the authority alone. Once the witness referees, the authority receives at least 10× fewer per participant-second. Short fights save less, since the opening is the authority's: at the median genesis duel, about 2.5–3.5×. `docs/perf/witness.md` reports every length, and M13's capacity model uses those numbers.

**Versions.** Protocol 10 carries the new messages, and old clients are refused. The rules stay 11: nothing a fight computes changes.

## Consequences

- Refereeing moves off the authority for most of every long fight, and every fight, mating and genesis gets independent eyes when anyone eligible is online. With nobody eligible, the game plays as before, and says so.
- A witness can't change an input, and a lie about a frame is provable. Its timing remains its word, within the 120 ms window.
- **Explicit limits:**
  - one person with many eligible identities is selected more often;
  - two of them can be one fight's referee and auditor;
  - the authority decides eligibility and skips, so witnesses add observation, not independence from the operator;
  - an encounter's id includes the lock time, which the authority sets;
  - a restart turns pending duties into authority-only events;
  - short fights are refereed by the authority alone.
- Costs per witnessed fight: one commitment row, a batch a second instead of 10 inputs a second per fighter, two signal relays per duty link, one attestation row, and the signature checks.
- Rejected:
  - knowing the witness at lock-in from an earlier round or a standing rota (the attacker could choose when to fight; that is shopping);
  - waiting for a beacon before frame 0 (lock-in must stay fast);
  - storing a signature per input (eight times the logs), or signing windows of inputs (a fighter that drops leaves an unsigned window the fight already used);
  - a witness from the fighters' own pond only (friends share ponds);
  - witness bundles relayed through the authority (10 incoming messages a second again);
  - majority votes, and re-drawing after a failure (ADR 0012).
