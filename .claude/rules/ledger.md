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
