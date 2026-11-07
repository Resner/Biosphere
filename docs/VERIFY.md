# Verifying a lineage

Every creature's history can be checked by anyone, with the creatures and their owners offline. A check is `verifyLineage` (`src/ledger/verify.ts`) run over a **proof bundle**: the creature's records, its ancestors' records up to the matings that tie them in, the randomness commitments and drand rounds they rest on, the settlements of the fights they name, and the authority's signing keys. ADR 0055 is the contract.

## How to verify

- **The card.** Open `card.html?c=<creature id>` from the game's page. It fetches the bundle, verifies it in your browser and says the verdict in one line.
- **The command line.** `npm run verify:lineage -- <creature id | bundle.json>`:
  - `--hub <url>`: the authority to fetch from (default `$AUTHORITY_URL`); it reads `GET /v1/proof/<id>`.
  - `--replay`: fetch each settled fight's log (`GET /v1/fight/<enc>`) and replay it. Beside a bundle file, logs are read from `fights/<enc>.json`.
  - `--keys <file>`: pin the authority's keys (a JSON list, or `GET /v1/pubkeys`'s reply) instead of taking the bundle's.
  - `--save <dir>`: write `bundle.json`, `keys.json` and `fights/` so that a later check needs no network.
  - `--json`: print the `LineageReport` instead of words.

  Exit codes: 0 verified, 1 a problem found, 2 nothing to verify (unreachable, 404, busy, malformed, bad arguments).
- **What witnesses saw.** The card ends the hatch or birth and each fight in its story with what a witness did ("refereed by a witness", "audited by a witness" or "checked by the authority alone", and "a witness disagreed; the authority's result stands" when one was overruled), and its details, like the CLI's second line, count them: "Witnesses: 4 of 6 events seen by a witness; 2 checked by the authority alone". `--json` holds the counts (`witnessed`) and each event (`events`).
- **Your own code.** Parse untrusted JSON with `parseProofBundle`, then call `verifyLineage(bundle, { keys, logs, replay })`. It is pure, never throws, and has no DOM or network. `replay` is `verifyEncounter` from `src/net/encounter-verify.ts`, passed in so that the ledger code stays off the network code.

## What each family proves

- **Chains**: every record's hash is its contents, `seq` runs from 0 without a gap or a fork, each `prev` is the record before, the creature's id is its first record's hash, one owner holds it throughout, and every step is allowed after the one before.
- **Signatures**: steps only the owner may take carry the owner's signature, and steps only the authority writes carry none; every record, commitment and settlement is countersigned by an authority key that was in force by then.
- **Origins**: a genesis creature's DNA is what its committed drand round produces, and a newborn's DNA is what both parents' genomes and its committed round produce. The round was not yet published when it was committed, and carries drand's signature.
- **Time gates, costs and growth**: the life clock never ran backwards, faster than real time allows or past the lifespan, nobody mated before they were old enough or inside a cooldown, a mating cost what the rules say, nobody grew faster than their genes allow, and a creature put aside stayed exactly as it was until its restore.
- **Fights**: each fight has one countersigned settlement, and each fight record agrees with it and with the clock around it. With `--replay`, the fight's log plays through to the settlement's end state and results.
- **Witnesses** (ADR 0058): for each fight, mating and genesis the bundle holds, the authority committed to a pool of up to 16 eligible players and to a drand round before that round existed, and the round's randomness ordered the pool. The check recomputes that order and confirms:
  - the witness commitment is countersigned (by a key in force by the first record that names the event, as for any commitment), its pool sorted, unique and at most 16 long, and its round was unpublished when committed (a mating's or a genesis's is the event's own round) and carries drand's signature;
  - each witness who refereed frames of a fight (the settlement's referee spans, which start with the authority at frame 0) holds the place in the order the span names;
  - each attestation is signed by its witness, comes from that witness's place, names the event's commitment and the event itself (the settlement's hash, the genesis record's hash, or both births' hashes), and no place serves twice.

  The report counts each event as refereed by a witness, audited by a witness, overruled (a witness disagreed; the authority's result stands, and that is no problem) or checked by the authority alone (neither refereed nor audited). A version 1 settlement or bundle, from before witnesses, counts as checked by the authority alone.

## What verification does not prove

- That the authority served everything it holds: a withheld fork, or an earlier mating that would have lengthened a cooldown, cannot be seen.
- That claims within the bounds came from honest play. Movement, eating, hazards and a self-reported death are the client's word, clamped but unproven until the authority simulates them.
- That fight inputs came from people, or that two players did not collude.
- That the restored ancestor was the nearest survivor.
- That identities are distinct people.
- That witnesses are independent of the authority or of each other. The draw makes the authority unable to pick them after the fact, not unable to create them. Who was eligible is the authority's word, and so are its reasons for skipping a place in the order.
- That a witness-refereed frame was signed by its fighter. The authority checks each input's signature when the witness's batch arrives, and the log keeps only the codes.
- That every attestation was served: an authority that withholds one makes an event look checked by the authority alone, never better.
- That a witness who marked an input late had not received it in time.

The facts the authority is trusted for: **time** (every `t` is its clock), **sessions** (who was connected, and when), and **serving everything** it holds. Its signing keys are the one thing a check takes on trust; pin them with `--keys` once you have them from a source you trust.

## Reading the report

- **Verified back to genesis**: no problem, and every ancestor path ends at a checked genesis.
- **Not traced back to genesis**: no problem in what was held, but ancestors were left out of the bundle (each has a bundle of its own) or a birth could not be recomputed.
- **Not checked** lists fights without a replay, fights whose logs were pruned (ADR 0056: logs go after 14 days; the signed settlement stays), ancestors left out, and whose keys were used.
- **Witnesses** gives each event's selection: `checked` when its witness commitment was held and drew the order, `unchecked` when the commitment was pruned (it is kept 14 days; attestations are kept for good) or not served, and `none` when there was no pool. A genesis or a mating whose commitment is gone and whose auditors never answered cannot be told from one with no pool; both are checked by the authority alone. A mating's attestation names both births, so its subject is checked only when the bundle holds both.
- **Test worlds**: a world with shortened lives or matings (a scale below 1) is marked as one, and its clocks are not the live game's.
- **World renewals**: until v1.0 the world may be renewed (ADR 0040). Records from before a renewal are retired rather than checked, and lineages are not permanent. The latest renewal (rules 12, epoch 4, ADR 0061) started the one world; a bundle of rules 11 or older answers `rules-retired`.
