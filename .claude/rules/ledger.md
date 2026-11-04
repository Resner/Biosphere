---
paths:
  - "src/ledger/**"
---

# Identity, records and randomness (`src/ledger`)

ADRs 0009 and 0010 are the contract. This code runs in browsers, Node and workerd: no DOM, no Node-only APIs.

- The private seed never leaves `identity.ts`, except through the explicit recovery-code export the player triggers. Never log it, send it, put it in records or keep it in another store.
- Records are canonical JSON (RFC 8785) of integers and strings only. Use fixed-point integers (biomass, energy and health in hundredths), never floats. Hashes and signatures always carry a domain tag (`bs/rec/v1`, `bs/hello/v1`, ...).
- UTXO rule: a transition names the creature's current head as `prev` with `seq + 1`. Restoring an ancestor is a new transition; never re-accept an old record.
- Randomness commitments name a future drand round (`latest + 2`) before it exists. No retries, no alternate rounds, no cancel-to-reroll. Never use an unverified beacon.
- Integrity is not legitimacy: verification recomputes seeds, inheritance, time gates and costs, not just hash links.
- Tests use the recorded beacon fixtures in `tests/fixtures/drand/`, never the live drand network.
- Mating (M5): a record kind's allowed successors live in the transition matrix; mate asks are signed by both players and name the commitment round. A stored `birth` must pass `checkBirth` (recomputed from the beacon, the commit id and both parents' genomes), and every record `checkStored`. A player has at most one active and one pending creature.
- Rules versions (ADR 0055): `registry.ts` lists each live version with its world epoch and, per part, the version where that part last changed. Every check answers a version through `rulesStatus` (`rules-retired` below `FIRST_LIVE_RULES`, `rules-unknown` for one this build doesn't list). A rules bump without a world renewal adds an entry; one that changes a part recorded history depends on also keeps that part's older code.
- Typed bodies (rules 11): `bodyProblems` lists every kind's fields and refuses any other (`unknown:<field>`), so a new field is a rules bump. A `mate-commit` keeps the condition after its cost and the one it paid from (`…Before`); a `death` is `{ cause, activeMs, biomass }`, plus `enc` and `by` for `killed` and `eaten`, and `enc` alone for a hazard death a fight's settlement wrote.
- One rulebook (`gates.ts`): lifespan, maturity time and size, cooldown, repeat window, restore minimum, a creature's start, a mating's cost (`paidFor`) and the growth reach, under `Scales` (`LIVE_SCALES` in production). The authority and the verifier call these and nothing else; the reach uses `exp` from `src/sim/math.ts` and is floored to hundredths, so every engine draws the same line (a pinned table is checked in Node and workerd).
