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
- **Your own code.** Parse untrusted JSON with `parseProofBundle`, then call `verifyLineage(bundle, { keys, logs, replay })`. It is pure, never throws, and has no DOM or network. `replay` is `verifyEncounter` from `src/net/encounter-verify.ts`, passed in so that the ledger code stays off the network code.

## What each family proves

- **Chains**: every record's hash is its contents, `seq` runs from 0 without a gap or a fork, each `prev` is the record before, the creature's id is its first record's hash, one owner holds it throughout, and every step is allowed after the one before.
- **Signatures**: steps only the owner may take carry the owner's signature, and steps only the authority writes carry none; every record, commitment and settlement is countersigned by an authority key that was in force by then.
- **Origins**: a genesis creature's DNA is what its committed drand round produces, and a newborn's DNA is what both parents' genomes and its committed round produce. The round was not yet published when it was committed, and carries drand's signature.
- **Time gates, costs and growth**: the life clock never ran backwards or faster than real time allows, nobody mated before they were old enough or inside a cooldown, a mating cost what the rules say, and nobody grew faster than their genes allow.
- **Fights**: each fight record agrees with its countersigned settlement and with the clock around it. With `--replay`, the fight's log plays through to the settlement's end state and results.

## What verification does not prove

- That the authority served everything it holds: a withheld fork, or an earlier mating that would have lengthened a cooldown, cannot be seen.
- That claims within the bounds came from honest play. Movement, eating, hazards and a self-reported death are the client's word, clamped but unproven until the authority simulates them.
- That fight inputs came from people, or that two players did not collude.
- That the restored ancestor was the nearest survivor.
- That identities are distinct people.

The facts the authority is trusted for: **time** (every `t` is its clock), **sessions** (who was connected, and when), and **serving everything** it holds. Its signing keys are the one thing a check takes on trust; pin them with `--keys` once you have them from a source you trust.

## Reading the report

- **Verified back to genesis**: no problem, and every ancestor path ends at a checked genesis.
- **Not traced back to genesis**: no problem in what was held, but ancestors were left out of the bundle (each has a bundle of its own) or a birth could not be recomputed.
- **Not checked** lists fights without a replay, fights whose logs were pruned (ADR 0056: logs go after 14 days; the signed settlement stays), ancestors left out, and whose keys were used.
- **Test worlds**: a world with shortened lives or matings (a scale below 1) is marked as one, and its clocks are not the live game's.
- **World renewals**: until v1.0 the world may be renewed (ADR 0040). Records from before a renewal are retired rather than checked, and lineages are not permanent.
