# 0054: A settled encounter is a signed document over a Merkle root of its frames, and a victim's worth decays

- Status: accepted (amends 0011: the settlement record's shape; amends 0051: kill rewards, egg rewards and carrion scale with the victim's worth)
- Date: 2026-11-03

## Context

ADR 0011 says the settlement holds the start-state hashes, a Merkle root of the bundle hashes and the results, and the brief asks that a fight can be verified after everyone has left. M7 writes one `encounter` or `death` record per fighter (ADR 0052), each naming the encounter id. No single signed document says what the fight was, and nothing lets anyone recheck it.

The brief also asks for resistance to repeated farming. ADR 0051 leaves decay for repeated victims and young identities to M8, and the roadmap's M7 risks name alternate identities farming each other.

Facts that shape this:
- Records are canonical JSON of integers and strings (ADR 0009), but an encounter's start positions are doubles.
- A fight's reward is computed inside the deterministic encounter, so every client and the authority must agree on it.
- ADR 0040: no frozen rules before v1.0; old records keep their meaning.

## Decision

**The settlement** is a document the authority countersigns, like a record (domain `bs/settle/v1` for its hash, the authority key's `bs/auth/v1` signature):

`{ v: 1, kind: 'settlement', rules, enc, pondSeed, start, joins, frames, root, hash, referee: 'authority', results, t }`

- `start` hashes the `enc-start` (`bs/enc/start/v1`), and `joins` lists each `enc-join`'s hash in order (`bs/enc/join/v1`). Doubles enter these hashes as the 16 hex digits of their IEEE-754 bits, so canonical JSON stays integers and strings.
- `root` is the RFC 6962 Merkle tree hash (leaves prefixed `0x00`, nodes `0x01`, split at the largest power of two below the count) over one leaf per finalized frame: `'bs/enc/frame/v1' ‖ u16 frame ‖ u8 width ‖` per slot `0xFF` for the fallback marker, or `0x00` and the u32 input. A frame's inclusion can be proven by its audit path, which M10's witnesses and disputes use.
- `hash` is `hashEncounter` at the end. `results` gives per slot the player, creature, outcome, cause, killer slot, outcome frame, egg, eater slot, and the final biomass, energy, health and reward in hundredths. An absent cause or slot is an absent key.
- `referee` names the authority. M10 adds witnesses, and flags a settlement that the authority alone signed.

The authority writes it in the same transaction as the fighters' records and the log's tail, and sends it in `enc-end`. The `encounter` record (rules 10 on) also carries `activeMs`, so a survivor's record holds its whole state, the locked time included (ADR 0053).

**Verification** recomputes everything from the log:
- `verifyEncounter(settlement, log, keys)` checks:
  - the countersignature against a listed authority key;
  - the start and join hashes;
  - the frame count and the root over the log's frames;
  - each frame's width;
  - the live rules version;
  - a replay of the log (`replayEncounter`) that gives the same `hash` and the same results.
  It returns the problems, with none when the settlement holds.
- `checkSettledRecords(settlement, records)` checks that each record naming the encounter agrees with its fighter's result.

What this proves: the results follow from the committed start and the accepted inputs under the rules, as the authority recorded them. What it doesn't prove:
- that the inputs came from people;
- that the start positions, which the clients claimed at lock-in, were honest;
- that the authority, the only referee until M10, timed deadlines fairly.

`docs/VERIFY.md` (M9) says so.

**A victim's worth.**
- At lock-in and at each join, the authority sets every fighter's worth as prey: `0.5^k`. `k` is the number of times the fighter's player had a creature killed in the previous 24 h, at most 6, plus 1 while that identity is under 30 minutes old. The count comes from the ledger: deaths with cause `killed`, by any killer.
- The worth travels in `FighterInfo` and in the fighter's start state, so every engine computes the same rewards. A kill's reward and an eaten egg's reward are multiplied by the victim's (the carrier's) worth, and so is the carrion that the settlement drops.
- The tournament runs at worth 1, so ADR 0051's gate is unchanged.
- This changes outcomes, so it is rules 10 with no world reset. Genesis, development and inheritance are unchanged, and `FIRST_LIVE_RULES` stays 8. Protocol 8 carries it.

## Consequences

- Anyone holding a fight's log and settlement can recheck it offline, and a single frame can be proven against the root. M9 serves the documents, and M10 builds witness audits on the same leaves.
- Farming one alternate identity gives half, then a quarter and so on, within a day. A fresh identity is worth half for its first half hour. Killing a player who dies often is worth less to everyone, which bounds farming by several killers too. Fights between strangers are unchanged.
- Costs: one more SQLite value per fight (the settlement, about 1 KB, in the log's row), no extra row, and a few ledger reads at each lock.
- Rejected:
  - a per-pair decay (a farmer with several killers resets it);
  - decay applied after the encounter (the authority's result would differ from what every client simulated);
  - per-creature records as the only proof (no one document of the fight to check);
  - JSON doubles in hashes (number formatting between engines);
  - a flat hash of all frames (no inclusion proof for one frame);
  - decay by the victim creature's age (a fresh hatch is already small prey; identities are what a farmer multiplies).
