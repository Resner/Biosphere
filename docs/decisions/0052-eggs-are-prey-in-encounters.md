# 0052: A carried egg is prey, eaten only in a settled encounter

- Status: accepted (amends 0021: a `pending` creature can die, with cause `eaten`)
- Date: 2026-11-02

## Context

The owner asked on Playtest v0.6.0 that a predator can eat a pending egg. The egg should be a high-value target, much richer than plankton, so that carrying one is a risk worth protecting. M6 draws the carried egg on a tether behind its parent, and pond peers see it from the snapshot's egg mark.

The roadmap asks for this ADR first, because the pending child is a ledger record (ADR 0021):
- losing it must settle through the authority;
- it must stay consistent with the death fallback;
- it must stay with its owner when it is not eaten.

Under ADR 0021 a pending child leaves only by promotion: no discard, no death. The free-roam world is not refereed (ADR 0016): food is settled by peer claims that nobody verifies, which is fine for plankton but not for a ledger record.

## Decision

- **Only a born child is prey.** An egg is eatable while its owner's active creature carries a `pending` child. An egg drawn between the mating commitment and the birth has no child yet, and nothing can be eaten.
- **Only inside an encounter.** Engaging a carrier brings its egg into the fight as a target (`src/sim/encounter/egg.ts`):
  - it trails behind the carrier at the tether's rest distance;
  - its health is 0.25 × the carrier's maximum health, and it has no armour;
  - any opponent can target it (Tab, a click, or an autopilot whose preference finds it nearest or weakest), and its strikes land on it as on a body;
  - the carrier's brace shields it (80% blocked, the striker staggered).
- **Eaten when** its health reaches 0 (by that striker), or when its carrier is killed by a fighter (by the killer, on the same tick). An eaten egg feeds the eater `0.2 × the carrier's biomass × the tier factor` (ADR 0051) as biomass, the overflow as energy.
- **Kept otherwise.** It stays the owner's when:
  - the carrier escapes, stands at the timeout or wins;
  - the carrier dies of a hazard or of starvation during the fight;
  - the fight is voided by an authority restart (ADR 0050).
- **Settled by the authority.** At the end of the encounter, in the same SQLite transaction as the other results, the authority writes an attested `death` record on the pending creature:
  - its body is `{ cause: 'eaten', enc, by }`, where `by` is the eater's creature;
  - the player's `pending` pointer is cleared.

  The transition matrix allows `death` from `pending` only with cause `eaten`, only attested, and only as part of an encounter settlement. No client can report an egg eaten, its own or anyone's. A `death` request naming `eaten` or `killed` is refused, as `old-age` is.
- **The fallback follows.** The fallback in `died` is computed after the transaction: a killed carrier whose egg was eaten falls back to its nearest surviving ancestor, or a new genesis. A carrier killed with its egg intact is impossible, since the killer eats it. A carrier that dies of a hazard keeps the pending child as a choice, as ADR 0021 says.
- **Shown honestly.** The owner sees the egg crack and shatter, and a toast says "Your egg was eaten". The lineage view lists the child as dead, with cause eaten. History lists only lives, so a child that never hatched isn't in it. The eater's growth is visible like a kill's.
- **Cooldowns don't change.** The owner may mate again when the cooldown allows, since nothing is pending any more. Nothing is refunded.

## Consequences

- An egg can't vanish through a lying peer, a lost packet or a crash. Only a settled encounter, recorded and countersigned, removes it.
- Carrying an egg is a real risk: an attacker can go for the egg alone (cheaper than the kill, half the reward), or kill the carrier for both. The carrier protects it by positioning, bracing and fleeing.
- A pending child that dies this way is the one exception to "a pending child leaves only by promotion". It isn't a discard: the owner can't choose it, and it costs the owner the child.
- Rejected:
  - free-roam egg eating by peer claims (a ledger record can't settle on an unverified claim);
  - an egg that survives its carrier's kill (carrying would cost nothing);
  - letting the carrier drop the egg to escape (a discard, which ADR 0021 forbids as a free reroll);
  - eating an unborn egg (there is no child to lose).
