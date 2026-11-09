# 0055: Proof bundles, an independent verifier, one rulebook for the authority and the verifier, and a third world renewal

- Status: accepted, amended by 0058 (bundles of version 2 carry witness commitments and attestations, and the verifier gains a witness family) (amends 0019: the life clock's credit and the growth clamp are bounded per record interval, from the creature's last record; applies 0040 again: rules 11 renews the world as epoch 3; its open freeze is settled by 0074: lineages are permanent from v1.0.0)
- Date: 2026-11-04

## Context

The brief asks that a creature's whole ancestry can be checked by anyone, from genesis records, hashes, signatures, rules versions, inheritance seeds and transition records, and that the data stays available when the original peers are offline. A hash proves integrity, not legitimacy. ADR 0009 promised proof bundles and a verifier in M9, and ADRs 0019, 0021 and 0052–0054 made each record kind checkable in principle: genesis and births recompute from committed future beacons, and settlements replay from their logs.

What stands in the way:
- **The live world holds rules 8, 9 and 10 records.** M7's `encounter` records (rules 9) have no settlement and no log, so nothing can recheck them. A `mate-commit` keeps only the condition after the cost, so the cost and the eligibility can be bounded but not recomputed.
- **The authority's guarantees are per progress report, and reports are not records.** Each report may credit its own wall time plus 2 s and grow its biomass 1 wu past the growth curve. A verifier sees only records. Between two records a client can stack the slack by flooding reports, and a record written after a hidden stretch can be followed by a credit for that stretch. The authority's clamp also uses `Math.exp`, which may differ between engines in the last bit.
- **The rules that gate a mating live in worker code**: maturity, cooldown, the restore minimum and the fixture scales.
- **Nothing serves records** to anyone but their owner.
- ADR 0040: no frozen rules versions before v1.0. Lineages become permanent from v1.0, "or earlier if M9's verifier ships lineages that players are told to keep".

## Decision

**A third world renewal.** Rules 11 resets the world as ADR 0040 describes: epoch 3, protocol 9 and a migration that runs once, with identities, keys, names, usage, flags, beacons and ponds kept. From then on, every record in the world is checked by one live rules version, with no legacy branches in the verifier. Lineages are still not permanent: cards and `docs/VERIFY.md` say that the world may be renewed before v1.0. The M14 spec's ADR freezes them.

**A rules registry** (`src/ledger/registry.ts`):
- One entry per live rules version: its world epoch, and for each part (genesis, inheritance, body, life, mating, encounter) the version where that part last changed.
- A record's version is `live`, `retired` (below `FIRST_LIVE_RULES`, 11) or `unknown` (newer than this build, so the verifier asks to be updated).
- A rules bump without a renewal must add an entry. If the bump changes a part that recorded history depends on, it must register the older generation's frozen code under that part. None exists now. A test fails the build when `RULES_VERSION` has no entry.

**Typed record bodies.** From rules 11 every kind's body is typed, and unknown fields are refused. A `mate-commit` also names the condition before the cost (`biomassBefore`, `energyBefore`, `healthBefore`). A `death` is `{ cause, activeMs, biomass }`, plus `enc` and `by` for the fight causes.

**One rulebook** (`src/ledger/gates.ts`), shared by the authority and the verifier:
- the lifespan, the maturity time and size, the cooldown and the restore minimum, under scales (`{ lifespan, mating }`, 1 in production; the fixture entry's `LIFESPAN_SCALE` and `MATING_SCALE` otherwise);
- a creature's starting condition (the starter cell for a genesis, the hatchling for a birth);
- the mating cost (`paidFor`);
- the growth reach, computed with `exp` from `src/sim/math.ts` and floored to hundredths, so every engine draws the same line.

The authority enforces them per **record interval**, which is what a verifier can see:
- **The clock**: the credit since a creature's last record never exceeds the wall time since that record plus `accrueSlackMs` (2 s). Writing a record rebinds the connection's cap. A fight's locked time (ADR 0053) adds at most its frames × 100 ms on top.
- **Growth**: a reported condition is clamped to the growth reach from the last record's condition over the active time since it, plus one 1 wu slack per interval. Energy and health are clamped to what that biomass allows.
- **A lock-in claim** (ADR 0050) is clamped over the wall time since the last record.

A client that floods reports gains nothing, and a client that claims more than allowed is clamped and flagged as before.

**Proof bundles** (`src/ledger/proof.ts`):
- A flat, canonical-JSON document: the world (epoch, rules, scales), the authority's keys with their `from` times, the creatures (id and genome text), their records, the genesis and mating commitments, the beacons, the settlements of every fight a record names, the authority's flags on those creatures, and `more`.
- It holds the subject's whole chain. For each ancestor it holds only the prefix of its chain up to the record that ties it to its descendant: a biological parent up to its `mate-commit` of that mating, a checkpoint-chain parent up to its `promote` (parent) or its death.
- Ancestors are added nearest first, up to 64 creatures and 512 KB. `more` names the parents of held creatures that did not fit, and each of them has a bundle of its own.
- `GET /v1/proof/<creature>` serves it, and `GET /v1/fight/<enc>` serves a fight's log and settlement.
- Both are metered, and edge-cached through the Worker's Cache API: a dead creature's bundle for a day, a living one's for 60 s (M10 T15: a dead creature's bundle keeps 10 minutes, since its flags and attestations can still arrive; a settled fight's proof keeps the day). Past 80% of the daily request budget they answer `503 busy`, so reads never push players into the admission queue.
- Fight logs are not in the bundle, because one fight can outweigh a whole lineage. A verifier fetches the logs it wants to replay.

**The verifier** (`verifyLineage` in `src/ledger/verify.ts`, pure, never throws) checks five families and names every problem by creature, record and code:
- **chains**: hashes, `seq` and `prev` links, creature ids, one owner, the ADR 0021 transition matrix, and no two records for one `seq`;
- **signatures and key history**: owner signatures where the owner starts the transition, none where only the authority may, and countersignatures under a listed key whose `from` precedes the record;
- **origins**: genesis and births recomputed from the commitment, the signed asks, the verified beacon and both parents' genomes; a commitment's round not yet published at its time; parents' genomes tied to their own first records;
- **time gates and costs**: the clock bound, lifespan and old age, maturity and cooldown at each mating, the exact cost from the condition before it, the growth reach between records, the starting condition, and restores and freezes that keep condition, clock and cooldown;
- **settlements**: each fight record against its countersigned settlement (`checkSettledRecords`), the locked time, and, when the caller passes logs, a replay (`verifyEncounter`, injected so `src/ledger` keeps off `src/net`) with each fighter's start checked against its previous record.

What it can't cover is reported apart from problems: ancestors in `more`, fights replayed or not, logs pruned (ADR 0056), and scaled clocks (a test world). A caller may pin the authority's keys instead of taking the bundle's.

**What verification proves, and what it doesn't** (`docs/VERIFY.md` expands this):
- **It proves** that:
  - every record is one the authority countersigned, in an unbroken chain;
  - every creature's DNA follows from beacons committed before they existed, and from its parents' genomes, under the rules;
  - the time gates, costs and growth bounds held at every record;
  - each checked fight's results follow from its committed start and accepted inputs.
- **It doesn't prove**:
  - that the authority served everything it holds: a withheld fork, or an earlier mating of the pair that would have doubled a cooldown;
  - that claims within the bounds came from honest play: movement, eating, hazards and self-reported deaths are the client's word, clamped but unproven until M10;
  - that fight inputs came from people;
  - that the restored ancestor was the nearest survivor;
  - that identities are distinct people.

**The authority's audit**: one catalogue of flag kinds (conflicts, replays, implausible clocks and growth, failed settlements and recoveries). A creature's flags travel in its bundle. `GET /v1/audit` gives counts by kind for the last day and since the renewal, with no identities in it.

**Creature cards**: `card.html?c=<creature id>` is a static page of the Pages build.
- It fetches the bundle and verifies it in the browser, in a module worker.
- It shows the creature, its verdict in plain words, and its lineage graph, which links to each ancestor's card.
- It names no player: records carry public keys, and the card shows none of them beyond a short fingerprint in the details.

## Consequences

- Anyone can check a creature with nothing but the bundle, the beacons' public key and the authority's keys, while its owner and every peer are offline. The CLI does it from a terminal, and the card does it in a browser.
- Players lose their creatures a third time. The renewal is announced as before, and the cards say that lineages last only from v1.0.
- The authority's bounds get slightly tighter: slack once per record interval instead of once per report. Honest play never meets them, and the hub's property test runs adversarial clients against the verifier.
- Each record kind's body is now a fixed shape, so a later field is a rules bump.
- Rejected:
  - keeping the rules 8–10 records (M7's fights could never be checked, and the verifier would carry legacy branches);
  - verifying per report (the authority would have to keep and sign every report, a write each);
  - fight logs inside the bundle (size);
  - a public transparency log over every record, which would expose withholding and equivocation (a write and a tree per record; revisit after v1.0);
  - verifying only in the Worker (not independent);
  - showing player names on cards (privacy; the brief asks for no more than a keypair identity).
