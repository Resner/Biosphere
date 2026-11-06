# 0059: Farming and movement in M10: young identities by play, a movement check at lock-in, and a bot-farm simulation

- Status: accepted (amends 0054: an identity is young until it has played 20 minutes, not for its first 30 minutes; amends 0050: an engage is checked against the attacker's own signed snapshots that the target holds)
- Date: 2026-11-06

## Context

The brief asks that many bot accounts must not translate directly into effortless superior creatures, though extra attempts may remain an advantage. Random witness selection does not stop one person from creating many identities: eligibility and admission limits add friction, not proof. Supply control comes from survival costs, reproduction limits, tradeoffs and resistance to repeated farming.

What already holds:
- **Time gates** on the authority's clock: maturity takes at least 7 minutes of active time and 60% of the adult size, a cooldown follows each mating, and the lifespan is finite (ADRs 0019, 0029, 0055).
- **Mating limits**: one pending child, and a cooldown that doubles for the same pair (ADRs 0021, 0022).
- **Genesis limits**: one living creature per identity and a hatch bucket (ADR 0019).
- **Growth clamped per record interval**, so a client's report can't grow a creature faster than its genes allow (ADR 0055).
- **A victim's worth** halves for each of its player's creatures killed in 24 h, and once more while its identity is under 30 minutes old (ADR 0054).

What is open:
- A bot identity is "old" after 30 minutes of wall time, whether it played or not. A farm can create identities and wait.
- ADR 0050 left the attacker's own position at lock-in unchecked: "Movement audits are M10." A cheating attacker can claim to be in range of a target it never approached.
- Nothing measures whether a farm of bot identities gives a shortcut.

## Decision

**Young identities by play.** A fighter's worth halves while its identity has played under 20 minutes: the sum of its creatures' active time, the same measure as witness eligibility (ADR 0058). The other rules of ADR 0054 stay: the count of the player's creatures killed, the 24 h window, at most 6 halvings, and the worth carried in the fight's start. A farm must play each bot identity 20 minutes, in real time, before its creatures are full prey, and before it can witness. The worth stays the authority's input to the encounter, so no rules version changes.

**A movement check at lock-in.**
- Every client keeps the last 5 verified signed snapshots of each engage candidate (it verifies them already, ADR 0050).
- A `lock-state` answer carries those of the attacker from the last 2 s (`seen`).
- The authority verifies each one and orders them by pond tick with the attacker's own fresh snapshot from the engage. It refuses the engage (`engage:moved`, "Moved too fast to attack") when two neighbours are further apart than the attacker could swim:
  - **the bound**: (1.25 × its top speed at its claimed biomass + its dash speed + the strongest current) × the time between them, plus 8 wu;
  - **the flag**: `teleport`, once per creature.
- The target's own answer is what the check reads. A target that does not answer within 150 ms gets the attacker's copy of its state, as before, and no check. A join has no answer to wait for, so it has no check either. Both are explicit limits.

**A bot-farm simulation** (`npm run report:farm`, `tools/farm-sim.ts`, `docs/perf/farm.md`). Scripted identities drive one hub in workerd on a hand-moved clock, under the live rules and scales. They are a test aid that never joins the live world.

A **farmer** works with N bot identities (0, 1, 4 and 16). The bots:
- report the most growth the authority accepts;
- mate with the farmer's creature in turn, so that a pair repeats (and its cooldown doubles) as rarely as N allows;
- are killed by it, in fights through the authority's referee;
- are eligible as witnesses once they have played 20 minutes.

A lone **honest pair** that forages at the pacing bot's rate is the baseline.

The report states these as gates, and a heavy test fails when one doesn't hold:
1. **No time shortcut.** The farmer's lineage reaches generation 3 no sooner than the honest pair, and no sooner than 3 × the maturity minimum.
2. **No breeding shortcut.** The farmer's creatures have at most 60 ÷ 9 children per hour of their active time (one cooldown each).
3. **No biomass from nothing.** The farmer gains no more biomass from its kills and carrion than its bots' victims held. Per bot identity and 24 h, the kills are worth at most 2 full kills (`Σ 0.5^k`).
4. **Young bots pay half.** A kill of a bot identity with under 20 minutes of play rewards at most half.
5. **Sybil witnesses get their share, no more.** Over 200 events, a farm of N eligible bots among H honest witnesses takes a duty at most `N ÷ (N + H) + 0.1` of the time, and no bot is selected before 20 minutes of play.

What farming does buy is reported, not gated: the farmer reaches its genetic maximum size sooner, and finds rare genomes faster, in proportion to its identities. Those are the extra attempts the brief allows.

## Consequences

- A farm costs real time per identity: 20 minutes of play before its creatures are full prey or it can witness, then its creatures' own time gates. The simulation keeps that true as rules change.
- An attacker can no longer appear in range out of nowhere: the target saw it coming, in the attacker's own signed snapshots.
- **Explicit limits:**
  - movement in free roam stays the client's word;
  - an attacker can still lie consistently to the target it approaches, since the snapshots are its own;
  - targets that answer late, and joins, are not checked;
  - a determined farm with many real-time hours still gains extra attempts, which the brief accepts.
- Rejected:
  - limits by IP (households, schools and the owner's playtests share addresses, and an IP hash must not be stored);
  - rewards for witness duty (they would pay a farm to run witnesses);
  - a cap on matings per day (the cooldown already bounds a creature, and honest players would meet it first);
  - a movement check from every peer's snapshots, all the time (authority traffic per snapshot).
