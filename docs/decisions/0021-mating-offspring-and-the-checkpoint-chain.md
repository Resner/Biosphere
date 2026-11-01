# 0021: Mating, offspring and the checkpoint chain (M5)

- Status: accepted (the base cooldown is 9 minutes: 0022)
- Date: 2026-10-27

## Context

ADRs 0009, 0010 and 0019 set the contract for records, future-round commitments and the authority's clock, and M4 built them for genesis creatures. M5 adds the rest of the lifecycle in the brief: two players consent to a mating, both pay, a committed future drand round decides two distinct children, each player holds at most one pending child, promoting turns the parent into a frozen checkpoint, and death falls back to the pending child or the nearest surviving ancestor. Open questions: which statuses and records exist and what is allowed in each; who signs what when one transaction touches two players' creatures; what the authority can and cannot check about a mating; how the pair of children is made distinct without a reroll; when costs are paid; and how the "nearest surviving ancestor" is found and its exhausted ancestors handled.

## Decision

**Statuses and the transition matrix.** A creature is `pending` (born, not yet promoted), `active` (at most one per player), `checkpoint` (frozen), or `dead`. A player also has at most one `pending`. A record is accepted only when the creature's status allows its kind (a new row is created by `genesis` and `birth`):

| kind | signed by | needs | leaves |
|------|-----------|-------|--------|
| `genesis` | attested (the asked genesis, ADR 0019) | none (new creature) | `active` |
| `birth` | attested (names the mating commitment) | none (new creature) | `pending` |
| `checkpoint` | attested | `active` | `active` |
| `mate-commit` | attested (names both signed asks) | `active` | `active` |
| `promote`, role `child` | owner | `pending`, and the player has no `active`, or the active one is frozen in the same transaction | `active` |
| `promote`, role `parent` | attested, same transaction as the child's | `active` | `checkpoint` |
| `restore` | owner | `checkpoint`, and the player has no `active` | `active` |
| `death` | attested | `active`, or `checkpoint` that is exhausted | `dead` |

Anything else is refused with a named reason and, when it would fork a chain (stale `prev` or `seq`), flagged as in M4. `pending` and `checkpoint` creatures take no `checkpoint` records: they are paused. The brief's "UTXO" rule holds: every status change consumes the head and writes a successor.

**Asks, not shared records.** One transaction that touches two players' creatures cannot be a record both sign (neither knows the other's head). As with genesis, each player signs an **ask** (a small canonical document, `bs/req/v1` domain, not a ledger record): `{ v:1, kind:'mate', creature, partner, partnerCreature, nonce }`. The commitment `{ kind:'mate', data:{ a: askA, b: askB } }` names both asks and a future round. The authority then writes two attested `mate-commit` records (one per parent), each naming the commit id. Verifiers check the asks inside the commitment, the commitment's countersignature and the record bodies. `promote` (child) and `restore` are the records a player starts, so they are owner-signed requests as ADR 0019 says; the child knows its own `prev` (the birth hash, `seq` 1) and an ancestor's head hash is listed in `lineage`.

**Consent windows on the authority's clock.** The courting player's ask arrives at time `t0`; the hub forwards it to the partner. The accept must arrive within 20 s of `t0` (15 s shown to the player, 5 s for signing and transit). The invitation lives in the courting session's attachment and is checked lazily on arrival: no timer, no alarm, no SQLite write until a commitment exists.

**What the authority checks.** On its own view (the last accepted progress, clamped): both players connected in the same pond; both creatures `active`, mature (`matureAtMs`), not in cooldown, at least 50% of their maximum energy, within ±1 size tier, with no pending child and no mating in flight; not the same player. **Not checked: distance.** Positions are peer-to-peer and unverified until M10's witnesses. Both clients require the creatures to be within 3 body lengths, but a pair that lies about it gains nothing a pair standing next to each other would not have, because proximity is not scarce and every real cost (maturity, resources, cooldown, the commitment) is enforced.

**Costs and cooldown.** Paid when the commitment is made, never refunded, no cancel (a commitment always resolves). Each parent pays 30% of its current energy and 15% of its biomass: the authority applies it to its view and writes it into the `mate-commit` record's condition, and the client applies the same shares to its creature through a sim life event (`mate`, rules version 5). Cooldown is 6 min of **active** time, doubled for each earlier mating of the same two players in the previous 24 h of wall time (exponent capped at 5), stored on both creatures as `cooldownUntilMs` (an active-time value), so a checkpointed creature's cooldown stays paused. A growth clamp already limits how fast a dishonest client can earn the cost back (ADR 0019); M10 audits it.

**Offspring.** `offspringPair(randomness, commitId, parentA, parentB)` returns the two children. Parent A is the courting player's creature, B the accepter's; slot 0 is the courting player's child, slot 1 the accepter's. Seeds are `SHA-256('bs/offspring/v1' ‖ randomness ‖ commit id ‖ slot)` as already coded; the child is `breed(A, B, seed)`. If slot 1's genome equals slot 0's (identical-clone parents can do this), slot 1 tries the next slot byte (2, 3, …, up to 255) until it differs. The slot actually used is in the birth record. Everything derives from the one committed round, so there is nothing to reroll. A child's generation is the larger parent generation plus 1. Hatchling biomass is `max(80, 10% of the child's maximum)`, energy 60% of its maximum, full health; lifespan counters start at zero. The `birth` record is shaped like `genesis` (`creature: ''`, `seq: 0`, `prev: ''`, the creature id is its hash) and its body names the commit, the round, the slot, both parents' ids and the hashes of both `mate-commit` records, the child's genome hash and generation.

**Birth always resolves.** When the round arrives (an alarm, as for genesis) the authority writes both `birth` records in one transaction and sends `born` to whichever of the owners are connected. A parent that has since died, or a player who is offline, still receives the child: the next `life` carries the pending child. A drand outage delays births and nothing else (ADR 0010).

**Promotion and the chain.** The player's checkpoint chain is `creatures.chain_parent`: the creature that was `active` when a creature was promoted (or none, for a genesis creature). It differs from the biological parents, which are the graph recorded in `birth`. Promoting the pending child writes, in one transaction, the owner-signed child `promote` (body `{ role:'child', parent: <the player's active, or the one that just died> }`) and, if the parent is still `active`, an attested parent `promote` that freezes it with its current condition, `activeMs` and cooldown. A parent that already died is just linked. The child spawns beside where the parent was; a restored creature spawns at the pond's spawn hint.

**Death fallback.** When the active creature dies (any cause, including old age), the authority sends `died` with a `fallback`: the pending child (if any) and the **nearest surviving ancestor**, found by walking `chain_parent` from the dead creature: skip `dead` ones; skip and **mark dead** (a `death` record with cause `old-age`) any `checkpoint` whose remaining lifespan is under 2 min (`restoreMinMs`), since restoring it would only kill it again; the first one left is the answer. The player picks one (or neither when a genesis is allowed); there is no deeper choice. `restore` writes a new record on the ancestor (`seq + 1`) with its saved condition and unchanged `activeMs`, so it never gains lifespan or loses cooldown, and nothing spent is refunded. If a player has neither a pending child nor a surviving ancestor, nothing survives: the old lineage stays as history and the genesis rules of ADR 0019 apply again. A genesis request is refused (`has-lineage`) while the player has an `active`, `pending` or surviving `checkpoint` creature.

**No discard.** A pending child leaves only by promotion. A discard button would turn every mating into a look-ahead reroll for the price of one cost and one cooldown, and the brief forbids free rerolls. It also means a poor child can be promoted and abandoned; that costs the player the active creature, which is a real price. Revisit if playtests show stuck players.

**Kinship.** Coefficient of kinship φ on the pedigree of birth records, by the standard recursion (founders are genesis creatures and are unrelated; φ(x, x) = ½(1 + F(x)); a child's inbreeding F is φ(A, B)), bounded to six generations. The authority computes it for `mate-check` and for the family graph; the client shows it as an inbreeding warning and never uses it as a rule. Related parents get weaker children only through genetics (recessive load alleles meet more often, DESIGN §6); no extra penalty exists.

**Testing under a clock.** Production values are minutes. The fixture entry (`DRAND_SOURCE=fixture`) accepts `MATING_SCALE` in (0, 1], which multiplies the maturity time requirement, the cooldown, `restoreMinMs` and the repeat window, and drops the maturity biomass share when below 1; like `LIFESPAN_SCALE` it is ignored in production (a bundle test checks). The authority tells clients its numbers (`matureAtMs`, `cooldownUntilMs` in `life` and `ack`), so the client never needs to know the scale.

**Protocol.** `PROTOCOL_VERSION` becomes 2 because `life`, `ack` and `died` change. A hub receiving a `v: 1` hello answers `error: outdated` and the client asks for a reload.

## Consequences

- Every mating is verifiable from public data: two signed asks, a countersigned commitment, a beacon, the seed derivation, the parents' genomes (by hash) and the two birth records. M9 builds the verifier from the same pure functions.
- A player can always play: death falls back to something or starts a new lineage, and an offline birth waits.
- The hub sees about 4 extra messages per mating and nothing else: well inside the budgets of ADR 0008.
- The creatures table gets two more statuses, which needs a table rebuild migration (SQLite cannot alter a `CHECK`).
- Distance and collusion stay unproven until M10. Costs, cooldown and time gates are the supply control, and the same-partner doubling limits two identities farming each other.
- Rejected:
  - one record signed by both players (neither knows the other's head);
  - paying the cost at birth (it would give a free cancel while the round is pending);
  - an authority-side proximity check (positions are unverified peer data);
  - discarding a pending child (a free look-ahead);
  - choosing any ancestor on death (the brief says the nearest survivor);
  - a timer per courtship (lazy expiry needs none);
  - a second pending slot (the brief says one initially).
