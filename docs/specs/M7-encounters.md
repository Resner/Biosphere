# M7: Encounters

Release: v0.8.0 · Gate: yes

## Goal

Players fight. A creature presses F beside a comparable creature, and within a third of a second both are locked in a refereed encounter.

- **The fight is automatic but steered.**
  - Anatomy decides who can hit whom (reach, arc, power, armour, spines, mass, speed).
  - Each player steers, picks a stance, picks a target and braces against the strikes they see winding up.
  - A missing or late input is the autopilot's, from the creature's behaviour genes.
- **Every client agrees.** The authority referees a 10 Hz frame clock and steps the same deterministic encounter simulation as every client. The results match in Node, Chromium, workerd and every participant's browser.
- **Fights matter.**
  - Size is a real advantage: damage grows with the attacker's radius, and health with the victim's.
  - A kill grows the killer at once, faster than plankton. The victim leaves carrion that anyone can eat.
  - A creature carrying a pending child brings its egg into the fight, where a predator can eat it.
- **Fights are readable.** Windups glow and tick, hits flash, blocks spark, the death screen names the killer, and an eaten egg says so.

The decisions behind this milestone:
- ADR 0011 is the contract.
- ADR 0050 sets how the authority referees and simulates every frame, the lock-in by signed snapshots, spawn protection, rules 9 and protocol 7, and why fights don't survive a restart until M8.
- ADR 0051 sets the combat numbers, size as an advantage and kills as the fast way to grow.
- ADR 0052 makes a carried egg prey, eaten only in a settled encounter.

`docs/DESIGN.md` §7 has the initial values. T5's tournament tunes them, and code tables stay the source of truth.

This milestone is a **gate** (gate 3: combat feel). After v0.8.0 the factory waits for the owner's reply on the `Playtest: v0.8.0` issue before M8 starts.

## Owner points → tasks

The owner's Playtest v0.6.0 feedback (#134), as the roadmap records it:

| Owner point | Task |
|---|---|
| Killing a comparable creature must grow you faster than eating plankton | T2 (rewards as biomass), T5 (measured against the pacing bot), T14 (carrion) |
| Size must be a meaningful advantage in a fight | T2 (damage and health by radius), T5 (size targets) |
| Predators eat eggs: a pending egg is a high-value target, so carrying one is a risk worth protecting | ADR 0052, T3 (the egg in the fight), T13 (settlement), T12 (shown) |

The Playtest v0.7.2 points (#263) are handled by PR #264 (ADR 0049), not here.

## Out of scope

- **M8:**
  - fight persistence and recovery after an authority restart;
  - reconnecting into a running fight (M7 makes the player wait for the result);
  - the authority settling once every participant has left and the object sleeps;
  - the clock-skew and backdating harness;
  - the settlement record with a Merkle root, and `verifyEncounter`;
  - kill-farming decay;
  - the jitter and loss harness.
- **M10:** witness referees, signed inputs and movement audits (an attacker's own position stays unverified, ADR 0050).
- **M11 and M12:** area of interest, spawn rings and anti-camping. A pond stays a full mesh of up to 24.
- **Free-roam collisions.** Creatures still pass through each other outside fights.
- **Eating eggs outside an encounter** (ADR 0052).
- **New genes and body changes.** Combat reads existing anatomy (ADR 0051), and no look pass is planned beyond telegraphs.
- **Touch controls.**

## Touches

- **New:**
  - sim: `src/sim/encounter/` (`types`, `codec`, `encounter`, `reach`, `combat`, `egg`, `autopilot`, `join`, `replay`, goldens in `src/sim/__golden__/encounter-*.json`), `src/sim/carrion.ts`;
  - genome: `src/genome/fighter.ts`;
  - ledger: `src/ledger/snapshot-sig.ts`, `src/ledger/encounter.ts`;
  - net: `src/net/referee.ts`, `src/net/encounter-sync.ts`, `src/net/signed-snaps.ts`;
  - worker: `worker/engage.ts`, `worker/fights.ts`, `worker/settle.ts`, `worker/ledger-encounter.ts` (`worker/ledger.ts` is near 1,000 lines);
  - game: `src/game/app-encounter.ts`, `src/game/engage.ts`, `src/game/combat-hud.ts`;
  - render: `src/render/telegraph.ts`;
  - tools: `tests/combat-tournament.ts`, `tools/combat.mjs` with `tools/combat-report.ts` (`npm run report:combat` writes `docs/perf/combat.md`);
  - E2E: `tests/e2e/m7-*.spec.ts`, with hubs from 8807 on, each hub file its own.
- **Changed:**
  - sim: `src/sim/{rules,body,physics,types,food,state-hash}.ts`;
  - net: `src/net/{protocol-defs,protocol-parse,pond-sync}.ts`;
  - ledger: `src/ledger/record.ts`;
  - worker: `worker/{authority,socket,sessions,lives,offspring,ledger}.ts` (no migration: record kinds have no `CHECK`, and `pending → dead` uses existing statuses);
  - game: `src/game/{app,app-tick,app-online,app-keys,input,mate-card,eggs,screens,hud,sound-cues,debug,app-hook}.ts`;
  - audio and render: `src/audio/cues.ts`, `src/render/{effects,egg,remotes,food}.ts`;
  - docs: `docs/TESTING.md`, DESIGN §2–§3, §5–§8 and §10, `.claude/rules/{sim,net,worker}.md`.

**Shared shapes.** Tasks that run in parallel build to these, so a later task maps between them rather than redefining them.

```ts
// src/sim/body.ts (T1): the combat half of the body seam, sanitized like PhysStats.
export interface CombatStats { reach: number; arc: number; power: number; armour: number; spines: number; mass: number }
// reach 1–2.5 core radii, arc 0–π, power 0–20, armour 0–1, spines 0–1, mass 0.1–20; non-finite values take the starter's

// src/sim/encounter/types.ts (T1)
export type Stance = 'balanced' | 'aggressive' | 'evasive';
export type TargetPref = 'nearest' | 'weakest' | 'largest' | 'strongest';
export interface Behaviour { aggression: number; caution: number; curiosity: number; reflex: number; targetPref: TargetPref }
export interface FrameInput { steer: number; throttle: number; dash: boolean; stance: Stance; target: number; brace: boolean }
export interface FighterStart {
  player: string; creature: string;
  x: number; y: number; vx: number; vy: number; heading: number;
  biomass: number; energy: number; health: number; elder: boolean; egg: boolean;
  phys: PhysStats; combat: CombatStats; behaviour: Behaviour;
}
export interface EncounterStart { id: string; pondSeed: string; size: number; seed: Seed; t0: number; fighters: FighterStart[] }
export type Outcome = 'killed' | 'died' | 'escaped' | 'stood';
export interface FighterResult {
  outcome: Outcome; cause: DeathCause | null; by: number | null; frame: number;
  egg: 'none' | 'kept' | 'eaten'; eggBy: number | null;
}

// src/sim/encounter/codec.ts (T1). u32 code, bits: steer 0–7, throttle 8–11, dash 12,
// stance 13–14 (0 balanced, 1 aggressive, 2 evasive; 3 decodes as balanced),
// target 15–17 (0–3 a fighter's slot, 4–7 that slot's egg), brace 18; higher bits ignored.
export function encodeFrameInput(input: FrameInput): number;   // RangeError on a field out of range
export function decodeFrameInput(code: number): FrameInput;    // total

// src/sim/encounter/encounter.ts (T1)
export function createEncounter(start: EncounterStart): Encounter;
export function stepFrame(enc: Encounter, inputs: readonly (number | null)[]): EncounterEvent[];  // null = fallback marker
export function results(enc: Encounter): FighterResult[];
export function hashEncounter(enc: Encounter): string;

// src/genome/fighter.ts (T1)
export function fighterOf(c: Creature): { phys: PhysStats; combat: CombatStats; behaviour: Behaviour };

// src/net/protocol-defs.ts (T6), protocol 7. Numbers are JSON doubles (they round-trip exactly).
export interface SignedSnap { snap: string; sig: string }  // base64url: the 25 snapshot bytes, the 64-byte signature
export interface FighterInfo {
  player: string; creature: string; genome: string;
  x: number; y: number; vx: number; vy: number; heading: number;
  biomass: number; energy: number; health: number; elder: boolean; egg: boolean;
}
export interface FighterOutcome extends Omit<FighterInfo, 'genome' | 'elder' | 'egg'> {
  outcome: 'killed' | 'died' | 'escaped' | 'stood'; cause: DeathCause | null; by: number | null;
  egg: 'none' | 'kept' | 'eaten'; eggBy: number | null;
}
// ClientMsg += { t: 'engage'; target: string /* playerId */; mine: SignedSnap; theirs: SignedSnap }
//            | { t: 'lock-state'; lock: string; mine: SignedSnap }
//            | { t: 'input'; enc: string; f: number; i: number }
// HubMsg    += { t: 'lock-ask'; lock: string }
//            | { t: 'enc-start'; enc: string; seed: string /* 64 hex */; round: number; t0: number; at: number /* hub ms of frame 0 */; fighters: FighterInfo[] }
//            | { t: 'enc-frame'; enc: string; f: number; i: (number | null)[] }
//            | { t: 'enc-join'; enc: string; f: number; fighter: FighterInfo }
//            | { t: 'enc-end'; enc: string; f: number; hash: string; fighters: FighterOutcome[] }
//            | { t: 'carrion'; enc: string; x: number; y: number; biomass: number; radius: number; tick: number }
//            | `died` gains `by?: string` (the killer's or eater's name)
// refused reasons: 'engage:signature|stale|pond|target|self|tier|protected|locked|range|full'
```

## Tasks

### The encounter simulation (`src/sim/encounter/`)

- [x] T1 Encounter state, frames and the input codec (after none)
  - Why: everything else (the referee, prediction, the tournament) steps this one function.
  - Steps:
    1. Add `RULES.encounter`, with DESIGN §7's values (frames, deadlines, engage, escape, strike, damage, stance, brace, ram, spines, reward, egg), and `RULES_VERSION` 9 (ADR 0050: no reset, `FIRST_LIVE_RULES` stays 8). Regenerate every golden the version touches. The state hash includes `world.rules`, so replay hashes change, and genome goldens change their `rulesVersion` only. List them in the PR, and make DESIGN's opening line say rules version 9.
    2. Add `CombatStats` and `sanitizeCombat` in `src/sim/body.ts`, the types above, and the codec.
    3. Add `fighterOf` in `src/genome/fighter.ts`: `Stats.combat` plus `Stats.mass`, sanitized, and the behaviour traits. `targetPref` maps every allele to the four kinds.
    4. Add `createEncounter`:
       - fighters take slots in creature-id order, and a joiner later takes the next slot (T15);
       - each fighter keeps a full `CreatureState`, so `applyMovement`, `applyMetabolism` and `applyHazards` run unchanged, inside a `World` built from the pond seed and size at tick `t0`;
       - the world holds no food, and nobody eats in a fight.
    5. Add `stepFrame`: 3 ticks, each with, per fighter in slot order:
       - movement, with the frame's input on all 3 ticks;
       - metabolism and hazards;
       - collisions: the fighters' collider circles in world space are pushed apart along the line of centres, split by mass, and the closing velocity is removed;
       - death checks.
       A `null` input is `IDLE` in balanced stance until T4 replaces it with the autopilot. `applyMovement` gains an optional `mods: { thrust?: number; turn?: number }` (default 1), so stance and stagger need no copied physics; free-roam goldens must not move.
    6. Add `reach.ts`:
       - `strikeReach` is the farther of `combat.reach` and the mouth's `offset + radius`, times the radius;
       - `strikeDistance` is the distance from the attacker's centre to the nearest edge of the target's colliders;
       - `engageRange` is the strike reach plus 0.3 × the target's radius.
    7. Add the end rules (once `over` is set, the state never changes again):
       - a death names its cause: the last damage of the tick;
       - escape: outside 2 × every living opponent's engage range for 90 ticks;
       - timeout: 900 frames, after which everyone left `stood`;
       - fewer than 2 fighters left ends the fight.
    8. Add `replay.ts` (`EncounterLog { rules, start, frames }`, `replayEncounter(log) → { hash, results }`) and three goldens: an approach, an escape and a plume crossing.
  - Acceptance (tests first):
    - The codec round-trips every field combination over a seeded 10k sample.
    - `decodeFrameInput` never throws for any number, including NaN, negatives and values over 2³²; `encodeFrameInput` throws `RangeError` for each field out of range.
    - One fighter at full throttle east for 30 frames ends at exactly the position of 90 free-roam ticks with the same input (`step` with the same world seed and tick).
    - Two fighters driven into each other for 60 frames never overlap by more than 10% of the smaller core radius at a tick's end.
    - A fighter in a plume loses health at the plume's rate; one at 1 hp dies with cause `toxin` and outcome `died`.
    - Escape: one fighter flees past 2 × engage range. After exactly 90 ticks outside it is `escaped`, the other `stood`, `over` is true, and later `stepFrame` calls change nothing (same hash).
    - Timeout: two idle fighters placed 1.5 × strike reach apart (outside reach, inside 2 × engage range; a fixture seed whose current keeps them so) end at frame 900, both `stood`.
    - `structuredClone(enc)` hashes equal to `enc`. The banned-API scan (`determinism.test.ts`) covers `src/sim/encounter/`.
    - `fighterOf` gives in-range, finite combat stats for 10k random and 10k mutated genomes.
    - The three encounter goldens are pinned, and a second run gives the same hashes.
    - `speedTest`: one 4-fighter frame under 0.2 ms in Node.
  - Notes: no strikes yet (T2). The goldens regenerate in T2–T5 as the rules grow, since rules 9 is unreleased. Keep `src/sim/encounter/*.ts` under about 400 lines each.
  - Done: rules 9 regenerated the six sim goldens, the ledger `records` and `kinds` goldens, and every genome golden's `rulesVersion`. Fighters keep their `CreatureState` in `Fighter.body`; the encounter's `World` holds none. Two fighters leaving range together: the faster escapes, the other stands. The timeout test uses seed `timeout` at (5200, 3000), where the current shears little over 90 s.

- [x] T2 Combat from anatomy: strikes, bites, rams, spines, armour, stance, brace, kills (after T1)
  - Steps:
    1. Add `combat.ts`, the strike profile of ADR 0051:
       - reach and arc from `reach.ts`, with an arc of at least 0.6 rad;
       - power `0.3 + 1.2 × w ÷ (w + 0.6)`.
    2. Each tick, a fighter that is not winding up, cooling down or staggered starts a windup (8 ticks) when its target lies within its strike reach and arc. The target is the frame input's, if that names a living opponent, else the nearest living opponent.
    3. At the windup's end the strike lands if the target is still within 1.1 × the reach and inside the arc; then a 24-tick cooldown starts, hit or miss.
    4. Damage per DESIGN §7. The ±10% variation is `hashU32(enc seed, tick, slot)`, never a stream (rollback needs no stream state). The tick's damage event names the striker.
    5. Stance: aggressive ×1.25 dealt, with its own armour counting ×0.85; evasive ×0.7 dealt, with ×1.2 thrust and turn through `mods`.
    6. Brace, on the brace bit, if ready and the energy is there:
       - an 8-tick window, a 60-tick cooldown, and an energy cost of 0.05 × biomass;
       - a strike or ram landing inside the window deals 20%;
       - the attacker is staggered for 9 ticks: no windup starts, a running windup is cancelled, and thrust is ×0.3.
    7. Rams: on a collision with a closing speed over 60 wu/s, the faster-closing fighter rams the other:
       - damage `2 × r × min(1, (v − 60) ÷ 60) × 2 × its mass share × (1 − 0.6 × armour)`;
       - once per pair per 24 ticks.
    8. Spines: a strike or ram on a body with spines `s` returns `0.4 × s` of the damage dealt to its attacker, as damage with cause `killed` by the target.
    9. Kills: a fighter at 0 health whose last damage came from a fighter is `killed` by that slot. The killer gains the reward of ADR 0051 at once: biomass up to its maximum, then energy at 3 per unit, and health +10 per unit of radius gained. `results` carries the victim's biomass, so T13 and T14 need no recomputation.
  - Acceptance (tests first). Each test reads `RULES.encounter`, never literals, so T5's tuning keeps them green.
    - A hunter archetype facing a still starter within reach starts a windup and hits on its 8th tick, for exactly the formula's damage at the pinned hash value. The next windup starts no sooner than 24 ticks after the hit.
    - A target that steers out of 1.1 × the reach during the windup takes nothing, and the cooldown still runs.
    - Two starters in contact hurt each other by the nip alone, `0.3 × scale × r × (1 ± 0.1)`.
    - The same body at 4 × the biomass deals 2 × the damage per hit.
    - Armour 0.5 cuts damage by 30%; aggressive stance on that target cuts it by 25.5%.
    - Evasive: a fighter reaches 1.2 × its balanced top speed within 2% over 120 ticks, and deals 0.7 × the damage.
    - Brace:
      - a strike landing 1–8 ticks after a brace deals 20%, and the striker starts no windup for 9 ticks;
      - a second brace within 60 ticks, or one without the energy, does nothing and costs nothing.
    - Rams: a dash into a still equal body closing at 100 wu/s deals the formula's damage; 50 wu/s deals none; the same pair can't ram again within 24 ticks.
    - Spines: a strike on a spines-1 body returns 40% of its damage to the striker.
    - Kills: a strike that drops the victim to 0 gives outcome `killed` with `by` the striker's slot, and the killer's biomass rises by 0.4 × the victim's (×0.5 a tier smaller, ×1.5 a tier bigger), capped, the overflow as energy.
    - The goldens gain a duel log, pinned.
  - Notes: no new genes and no named-part bonuses (`.claude/rules/genome.md`). Combat stats are the adult values, and the current radius scales everything.
  - Done: `combat.ts` (one tick: brace, landings, rams, spines, kills, windups), `strike.ts` (profile, targets, damage), `outcome.ts`; fighters carry `fx` timers as absolute ticks. All of a tick's hits are gathered and applied together, so mutual blows both land; `hit` events carry the tick. Arcs are half-angles (as `mouth.arc` is); the duel golden is `encounter-duel`; the other three goldens changed hash only.

- [ ] T3 Eggs as prey in the encounter (after T2)
  - Steps:
    1. Add `egg.ts`. A fighter whose start has `egg: true` carries an egg:
       - it trails behind the carrier at `r × (1 + 0.45) + egg radius` (egg radius 0.5 × r), following at 0.25 of the gap per tick;
       - its health is 0.25 × the carrier's maximum health, and it has no armour.
    2. Targets 4–7 aim at slot `target − 4`'s egg. A strike on an egg measures distance to its circle and lands as on a body; spines and rams never involve an egg.
    3. The carrier's brace window also shields its egg (80% blocked, the striker staggered).
    4. Eaten: at 0 egg health, by the striker; or at once, by the killer, when the carrier is `killed`. The eater gains `0.2 × the carrier's biomass × the tier factor` as biomass, the overflow as energy.
    5. `results` gives `egg: 'none' | 'kept' | 'eaten'` and `eggBy`.
  - Acceptance (tests first):
    - The egg sits at its rest distance straight behind a still carrier, and stays within 1.5 × that distance of a carrier swimming at full speed.
    - An equal starter's nips break it after `ceil(egg health ÷ nip damage)` hits at the pinned variation, and the eater's biomass rises by the formula.
    - A brace by the carrier blocks 80% of a strike on the egg.
    - A carrier killed with its egg intact: `egg: 'eaten'`, with `eggBy` the killer, and the killer gets both rewards.
    - A carrier that escapes, stands at the timeout, or dies of a plume: `egg: 'kept'`.
    - A target code naming an absent or eaten egg aims at the nearest opponent instead.
    - A golden log with an eaten egg, pinned.

- [ ] T4 Autopilot from behaviour genes (after T3)
  - Steps:
    1. Add `autopilot(enc, slot): FrameInput`, pure and total, reading only the state at the frame's start and the fighter's `behaviour`.
    2. The rules, by gene:
       - flee when health is below `caution × 0.6` of its maximum, or when an opponent has over 1.5 × the biomass and caution > 0.5;
       - fleeing means full throttle straight away from the nearest opponent, evasive stance, and a dash when ready and reflex ≥ 0.4;
       - otherwise fight: aggressive stance at aggression ≥ 0.6, evasive at caution ≥ 0.7, else balanced;
       - steer at the target's nearest collider edge, offset by `(curiosity − 0.5) × 0.8` rad so it circles;
       - full throttle beyond 0.8 × the strike reach, else 6;
       - dash when the target is between 1 and 2 × the reach, the dash is ready and aggression ≥ 0.5;
       - brace when an opponent's windup aimed at it or its egg has ≤ 6 ticks left, the brace is ready, the energy is there and reflex ≥ 0.3.
    3. Choose the target among living opponents and uneaten eggs by `targetPref`:
       - nearest: by strike distance;
       - weakest: by health;
       - largest: by biomass, eggs excluded;
       - strongest: by damage per strike against it, eggs excluded.
       Ties go to the lower slot, then body before egg.
    4. `stepFrame` uses `autopilot` for every `null` input.
  - Acceptance (tests first):
    - Never throws, and stays deterministic, over 1,000 random encounter states (random fighters, positions and timers).
    - A frame of `null`s equals a frame of the autopilot's own encoded inputs (same hash).
    - Aggression 1 against an idle target in reach range strikes within 40 frames.
    - Caution 1 at 30% health moves away, so the distance grows over 10 frames, in evasive stance, and dashes with reflex 1.
    - Reflex 1 braces against a windup aimed at it; reflex 0 never does.
    - With 3 fighters and an egg, each preference picks the expected target.
    - An all-autopilot duel golden is pinned.

- [ ] T5 Combat tournament: balance, size and growth by kills (after T4)
  - Steps:
    1. Add `tests/combat-tournament.ts`:
       - round-robin duels between the 11 archetypes of `tests/archetypes.ts` at 400 biomass, each pair from 8 seeded start layouts and both sides;
       - 64 duels between genesis pairs of equal size (300 biomass);
       - mirror duels at 1 ×, 1.5 × and 2 × biomass;
       - every fighter on the autopilot.
    2. Add `tools/combat.mjs` and `tools/combat-report.ts`. `npm run report:combat` writes `docs/perf/combat.md`: the win matrix, overall win rates, the median and spread of fight lengths, the size table and the growth comparison.
    3. Measure growth: biomass per minute of fighting, from the kill reward over the fight's length, for winners of the equal genesis duels. Compare it with the pacing bot's foraging gain per minute between 250 and 350 biomass (`tools/pacing-report.ts`), carrion excluded.
    4. Tune `RULES.encounter` until the gate holds. Regenerate the encounter goldens, and update DESIGN §7 to the tuned values. ADR 0051's text keeps its initial values, since ADRs are append-only.
  - Acceptance (`heavyTest`):
    - No archetype wins more than 70% overall, counting draws as half.
    - At least one pairing is won 65% or more by one side.
    - Mirror duels go 40–60%.
    - Equal genesis duels last a median of 8–25 s.
    - At 1.5 × the biomass a body wins ≥ 70% of mirror duels; at 2 ×, ≥ 85%.
    - The winners' growth per minute of fighting is ≥ 1.5 × the forager's.
    - The report's hash is pinned per rules version, and `npm run report:combat` reproduces `docs/perf/combat.md`.
  - Notes: if no tuning meets every line, change the formula within ADR 0051 (its fallback is damage by `r^0.75`). Record a lasting change as an ADR. Never loosen a line.

### Lock-in and the referee

- [ ] T6 Protocol 7: encounter messages, signed snapshots, snapshot v4 [opus] (after none)
  - Steps:
    1. `PROTOCOL_VERSION` 7 and `SNAPSHOT_VERSION` 4: flag bits 16 (spawn-protected) and 32 (fighting), still 25 bytes; version 3 snapshots are dropped.
    2. `src/ledger/snapshot-sig.ts`, under the domain `bs/snap/v1` over `pond id ‖ 0x0A ‖ the 25 bytes` (ADR 0050):
       - `signSnap(identity, pondId, bytes): SignedSnap`;
       - `verifySnap(playerId, pondId, s): Snapshot | null`, which never throws;
       - the 89-byte state-channel frame codec: `encodeSignedFrame`, and `decodeStateFrame(bytes) → { snapshot, signed } | null`, which takes 25 or 89 bytes.
    3. The messages and shapes under Touches, with parsers in `protocol-parse.ts`:
       - every number finite and in range: frames 0–1,000, an input a u32, 2–4 fighters, slots 0–3;
       - ids hex, player ids valid, genome text within `GENOME_DATA_MAX_CHARS`;
       - new caps: `ENC_START_MAX_BYTES` 8192 and `ENC_END_MAX_BYTES` 4096.
    4. `DeathCause` gains `eaten`. `CAUSES` lists it, and it is never client-reportable: the worker refuses `killed` and `eaten` from clients in T13. Until then, `eaten` is refused like `old-age`.
    5. DESIGN §8: snapshot v4. `docs/TESTING.md` if any hook changes.
  - Acceptance (tests first):
    - Every message round-trips through its parser.
    - 10k fuzzed JSON values and 10k random byte strings never throw, and nothing malformed parses.
    - A signed snapshot verifies; a flipped bit in the snapshot or the signature, another pond id or another player's key gives null.
    - A v3 snapshot is dropped.
    - A protocol-6 hello gets `error: version`.
  - Notes: the messages of T14 (`carrion`) and T15 (`enc-join`) land here too, so later tasks don't reopen the protocol files.

- [ ] T7 Signed snapshots between peers, and the lock answer [opus] (after T6)
  - Steps:
    1. Engage candidates: pond peers within ±1 tier and within 8 × the larger radius (`src/game/engage.ts`, `candidates(self, remotes)`).
    2. `SnapshotSender` signs every second snapshot (200 ms) and sends the 89-byte frame to candidates only; everyone else gets 25 bytes. This needs a per-peer state send in `OnlineSession`.
    3. `src/net/signed-snaps.ts` keeps each peer's newest signed frame:
       - it verifies on receipt, at most 10 a second per peer, dropping and counting failures;
       - it ignores older ticks;
       - `latest(id)` returns the forwardable `SignedSnap`.
    4. The client answers `lock-ask` at once with a freshly signed snapshot of its current state (`lock-state`).
    5. The client sets the protected bit for 15 s after a genesis hatch, a promoted hatch or a restore (not a resume), cleared at its first engage. The fighting bit is T10's, which owns the lock state.
  - Acceptance (tests first):
    - Unit tests with fake peers:
      - only candidates receive 89-byte frames, at 5 Hz;
      - a candidate's stored frame is at most 7 ticks older than the newest snapshot;
      - over a simulated 10 s, the state traffic per candidate averages ≤ 600 B/s;
      - a forged frame is dropped and counted in `state().net.badSignatures`.
    - The `lock-ask` answer leaves within the same tick, through a fake hub.
    - `speedTest`: signing one snapshot takes under 1 ms in Node.

- [ ] T8 Lock-in on the authority: engage, checks, start states, locks, spawn protection [opus] (after T1, T6)
  - Steps:
    1. `worker/engage.ts`, with `engage` in the dispatch. Check, in order:
       - both players active in the same pond, and the target not the attacker;
       - both signatures (`verifySnap`);
       - freshness against the pond tick from its epoch (≤ 9 ticks old, ±3 ticks of slack);
       - each `genomeRef` against its active creature;
       - ±1 tier on clamped biomass;
       - neither protected;
       - neither locked;
       - the engage range (`engageRange` from both snapshots and `fighterOf` of both genomes, with slack of 2 × max speed × snapshot age).
       Each failure gives `refused { reason: 'engage:<why>' }`.
    2. Send `lock-ask { lock }` to the target, take its `lock-state` if it arrives within 150 ms, else use the attacker's copy. Frame 0 starts 150 ms after the decision.
    3. Build the start states:
       - advance each snapshot to `t0` in a straight line (velocity plus `currentAt`);
       - clamp the condition by the growth curve of `applyReport` against the session's `LifeState`, flagging a clamp once;
       - `elder` from the life clock;
       - `egg` when the owner has a pending child.
    4. Compute `encounterId` and `encounterSeed` (`src/ledger/encounter.ts`, ADR 0050). The seed uses `Beacons.newestKnown()`, a new method that never fetches. Send `enc-start` to both participants, with genome texts.
    5. Locks: an in-memory registry (`hub.fights`, the shell of `worker/fights.ts`):
       - while locked, `MateView.locked` is true, so court, accept and mate-check say `locked`, and promote, restore and genesis are refused `locked`;
       - until T9 lands, a lock ends at its 90 s timeout with no result.
    6. Spawn protection: `session.protectedUntil`, set at the delivery of a genesis, `promoted` or `restored`, never at a resume's `life`; ended by the creature's first engage.
  - Acceptance (tests first). Workerd hub tests drive the 150 ms window and the frame-0 time through an injected clock (`now()`), and none waits on real milliseconds.
    - A valid engage gives both players an identical `enc-start`:
      - fighters in creature-id order;
      - the target's own lock state when it answers within 150 ms, else the attacker's copy;
      - `at` 150 ms after the decision, so 300 ms at most after the engage arrived.
    - Each refusal fires on its own case: signature, stale, pond, target, self, tier (a gap of 2), protected (a genesis 10 s ago), locked, range.
    - The attacker's own protection ends when it engages.
    - A resume after a reload is never protected.
    - A snapshot claiming biomass past the growth curve is clamped, and `growth-too-fast` is flagged once.
    - The seed equals `SHA-256('bs/enc/v1' ‖ randomness ‖ id)` for the newest stored beacon, with `round` named. With none it uses round 0 and empty randomness. The fake source's fetch count doesn't change during an engage.
    - While locked, court, accept, mate-check, promote, restore and genesis are refused `locked`.
    - No SQLite row is written by an engage (`ledger.rowsWritten` unchanged).

- [ ] T9 The referee's frame clock: deadlines, fallback, bundles, the end [opus] (after T8)
  - Steps:
    1. `src/net/referee.ts` (pure; no DOM, Node or workerd APIs):
       - `new Referee({ startAt, slots })`;
       - `input(slot, f, code, now)` returns `'ok' | 'late' | 'early' | 'dup' | 'bad'`;
       - `due(now)` returns the finalized bundles in order;
       - `nextDeadline()`.
       The window runs from 2 frames ahead to `start(f) + 120 ms`, and the first input wins. A frame is finalized early once every living participant's input is in.
    2. `worker/fights.ts`. One running fight:
       - holds the `Referee`, the authority's `Encounter`, and one `setTimeout` for the next deadline, which calls `tick(Date.now())`;
       - `tick(now)` finalizes every due frame, steps the sim, sends `enc-frame` to the connected participants, and on `over` sends `enc-end` with the results, the final states and `hashEncounter`;
       - then it releases the locks and clears the timer.
    3. Rate cap: a locked session's `input` messages count in their own window (130 per 10 s). An input for another fight, or from a non-participant, is dropped and counted.
    4. Life while locked:
       - `progress` credits ticks and leaves the condition alone;
       - a `death` report is ignored;
       - at the end each connected participant's `LifeState` takes the result's condition;
       - a participant who reconnects mid-fight gets its `life` only after `enc-end`;
       - old age that fell due is applied after the end.
    5. Workerd determinism: a hub test replays T1's encounter goldens inside workerd and gets the pinned hashes.
  - Acceptance (tests first):
    - `Referee` unit tests:
      - inputs inside the window are taken; at `start + 121 ms` one is late; 3 frames ahead one is early; a second for the same frame is a dup;
      - a timer firing 350 ms late finalizes the 3 due frames in order;
      - a slot with no input gets `null`;
      - early finalization once all are in.
    - Hub tests with an injected clock:
      - two fighters exchange inputs, and both receive identical bundles from frame 0 on;
      - one stops sending and its slot turns `null`;
      - a fighter at 1 hp with no energy starves (so the test needs T1 only), and both get `enc-end` with `hash` equal to `replayEncounter` of the bundles; once T2 has merged, a kill by a strike is checked the same way;
      - the locks are released (court works again), and no timer is left (`fights.timers() === 0`).
    - A disconnected participant's fight runs to its end. Its reconnect gets `life` only after `enc-end`, with the result's condition.
    - No SQLite row is written during the fight.
    - A 30 s duel costs each participant ≤ 11 incoming messages a second.
  - Notes: records for kills and eggs are T13. Until T13, the victim's client reports its own death after `enc-end` with cause `killed`, as today.

- [ ] T10 Client prediction and rollback [opus] (after T1, T6)
  - Steps:
    1. `src/net/encounter-sync.ts`, `EncounterSync` (pure, clock passed in):
       - `start(msg, bodies)` builds `EncounterStart` from `FighterInfo` through `fighterOf(buildCreature(genome))`;
       - `step(hubNow)` simulates every due local frame. The local clock leads the hub's by `clamp(oneWay − 80 ms, 0, 100 ms)`;
       - the own input is sampled when its frame begins, sent as `input`, and used for that frame;
       - other fighters repeat their last confirmed input, with brace and dash cleared;
       - `receive(bundle)`: if it differs from the prediction, roll back to that frame's stored state and re-simulate, keeping 10 frames of states; a bundle more than 10 frames behind triggers a full resync from frame 0 using every bundle;
       - `end(msg)`: the own fighter takes the authority's final state exactly, and a difference counts as a desync.
    2. `src/game/app-encounter.ts`:
       - on `enc-start` the `Ticker` steps the encounter instead of the free-roam step for the player, and the world tick keeps `t0 + 3f`;
       - the player's state mirrors its fighter, so the HUD, the bars, snapshots and the camera keep working; snapshots carry the fighting bit (T6) while locked;
       - remote fighters are drawn from the encounter, not their snapshots, easing a rollback's correction over 0.1 s;
       - on `enc-end`, free roam continues from the result.
    3. A hidden tab keeps receiving bundles and catches up on return. Its own frames were the autopilot's.
    4. Hooks: `state().encounter` (`id`, `slot`, `frame`, `confirmed`, `over`, `hash`, `rollbacks`, `resyncs`, `desyncs`, and `fighters` with `player`, `creature`, `x`, `y`, `heading`, `health`, `maxHealth`, `stance`, `windup` (ticks left or null), `target`, `braced`, `egg`, `outcome`) and `__bs.replayEncounter(log)`. Update `docs/TESTING.md`.
  - Acceptance (tests first):
    - Unit tests against a scripted referee (in-process, 80 ms one-way latency, 30 ms jitter, seeded):
      - the own input sampled for frame f moves the own fighter in frame f;
      - the final hash equals the referee's;
      - a rollback happens only when a remote input differs from its prediction, and never spans more than 10 frames;
      - a bundle 15 frames behind causes one resync and still converges;
      - an own input the referee turned `null` converges on the fallback's (`stepFrame` with `null`: the autopilot once T4 has merged);
      - `end` with a different final state snaps the creature to it and counts a desync.
    - A game-level unit test with the fake online session: `enc-start`, frames, `enc-end`, and the player swims on in free roam from the result.
    - `m7-determinism.spec.ts` (no hub): `__bs.replayEncounter` gives every golden's pinned hash in Chromium.
  - Notes: this is the largest client task. If it runs long, ship the pure `EncounterSync` with its tests first and note the wiring as remaining in the PR, keeping the claim live.

### Play

- [ ] T11 Engage and fight controls, with the first hub duel [opus] (after T2, T7, T9, T10)
  - Steps:
    1. Attack (a core action, `src/game/engage.ts`):
       - F engages the creature under the cursor if it is engageable and in range, else the nearest engageable in range;
       - the creature's card (a click) gets an Attack button, disabled with the reason when out of range;
       - the visible hint is a small "F" glyph beside the nearest engageable creature in range;
       - a protected creature shows a faint shimmer and no glyph, and a fighting one (snapshot bit) no court prompt;
       - feedback (an engage ring) shows in the key press's frame.
    2. Fight keys, only while locked:
       - 1, 2, 3 set the stance;
       - Shift or the right button braces (the canvas suppresses its context menu);
       - the wheel keeps its numbers while it is open.
    3. Refusals show as short toasts: "Protected for 12 s", "Too big to fight", "Too far", "Already fighting".
    4. `debug.setHealth(hp)` (client only, never above the maximum), and `debug.steerTo` works in a fight.
    5. Add `m7-duel.spec.ts` (hub 8807, two contexts):
       - A teleports beside B, B lowers its health, and A presses F;
       - both see `enc-start`;
       - A steers onto B and kills it;
       - both clients' `state().encounter.hash` at `over` equal the `enc-end` hash;
       - a stance A picked shows on B's client;
       - B's death screen names the cause "killed".
  - Acceptance:
    - Unit tests for the target choice (cursor, nearest, none), the hint's shown and hidden cases, and the key routing (combat keys only while locked, numbers to the wheel while it is open).
    - `m7-duel` passes 3 times in a row (`--repeat-each=3`), waiting only on state (`.claude/rules/tests.md`).
    - DESIGN §3 and `docs/TESTING.md` match.

- [ ] T12 Combat HUD, telegraphs and sound [opus] (after T11, T3)
  - Steps:
    1. `src/game/combat-hud.ts`, only while locked, inside the 6% HUD budget:
       - three stance buttons with their keys, and the current one lit;
       - a brace button with its cooldown ring;
       - each opponent's health as a thin arc around it;
       - an escape ring that fills while the player is out of every opponent's 2 × engage range.
    2. `src/render/telegraph.ts`:
       - a windup glows the attacker's front and weapon tips for its 8 ticks, brighter as it nears the strike;
       - a landed strike flashes the target;
       - a remote that is not in the player's fight also flashes when its snapshot health drops;
       - a block throws a spark, a stagger wobbles the attacker, and spectators see a faint ring round fighting creatures (snapshot bit).
    3. The egg in a fight is drawn at the encounter's egg position, with cracks by its lost health, and shatters when eaten (`src/render/egg.ts` and `src/game/eggs.ts`).
    4. Sound (`CUE_SOUNDS`, pinned lengths, the existing voices): a windup aimed at the player (a rising tick), a block (a glassy clink), a kill (a low gulp), an egg eaten (a dry crack). Strikes reuse the hit thud through the damage-hit cadence.
    5. Reduce motion drops the wobble and the kicks, and keeps the flashes, glows and sounds. Update DESIGN §10 and `docs/TESTING.md` (`render.info().telegraphs`, `state().encounter.hud`, the cues).
    6. `debug.autoBrace(on)` (a test aid; client inputs only): the player braces when a windup aimed at it or its egg has 4 ticks left, so a scenario can count a block without timing a key press.
  - Acceptance:
    - Unit tests:
      - the glow's timing (rising over 8 ticks, gone after the strike);
      - the HUD's visibility rules and the cue triggers;
      - a fight's egg is drawn at the encounter's egg position, within 1 CSS px at the test's camera.
    - `m7-hud.spec.ts` (hub 8808), in a duel with no egg (a mating would make it `@slow`; T16 covers the egg in play):
      - the HUD shows only in the fight, and the m6b-hud measure keeps it within 6% at 960 × 540;
      - a decoded screenshot during a windup is brighter at the attacker's front than one just before it;
      - `audio.cues` counts the windup tick, and a block with `debug.autoBrace(true)`.

- [ ] T13 Results as records: kills, eaten eggs, the death fallback [opus] (after T9, T3)
  - Steps:
    1. `src/ledger/record.ts`:
       - kind `encounter` (attested) with body `{ enc, outcome, frames, biomass, energy, health, reward }`, the condition and reward in hundredths;
       - a `killed` death body adds `{ enc, by }` (the killer's creature);
       - a `death` on a `pending` creature is allowed only attested, with `{ cause: 'eaten', enc, by }` (ADR 0052);
       - the matrix adds `encounter: { active: 'active' }` and `death: { pending: 'dead' }`, with the cause rule in `checkStored`.
    2. `worker/settle.ts` and `worker/ledger-encounter.ts`, at the end, in one SQLite transaction:
       - an `encounter` record per surviving fighter;
       - per killed or dead fighter, a checkpoint first if unsaved, then its `death` (the cause from the result);
       - per eaten egg, the pending child's `death`, clearing `players.pending`.
       After the transaction, `died` (with `by`, the name, and the fallback computed after it) to each dead fighter, then `enc-end`. Settling twice writes nothing new.
    3. Client `death` reports naming `killed` or `eaten` are refused (`cause`), and `killed` is decided only by the authority.
    4. The client:
       - the death screen says "Killed by <name>";
       - the carrier sees "Your egg was eaten";
       - its egg and the H card go because the pending child does, so this task leaves `src/game/eggs.ts` to T12, which may run beside it;
       - the lineage view lists the child as dead (eaten);
       - History lists only lives.
    5. `m7-duel` (T11) then sees the victim's death written by the authority, not reported by the client; adjust its step, not its assertions.
  - Acceptance (tests first):
    - Record tests for each new body and matrix cell; a client-signed `eaten` death fails `checkStored`.
    - Workerd hub tests:
      - a kill writes the victim's `death` (by the killer) and the killer's `encounter` record, and the head's condition equals the result's;
      - an eaten egg writes the pending child's `death`, and the carrier's fallback no longer offers it;
      - a carrier killed with its egg falls back to its ancestor;
      - a hazard death in a fight keeps the pending child in the fallback;
      - row writes per duel stay ≤ 2 per participant, plus 2 for a checkpoint and 2 for an eaten egg;
      - a reconnect after the end gets the settled `life` or `died`.
    - A client unit test: a living carrier whose egg is eaten (`enc-end` with `egg: 'eaten'`) shows "Your egg was eaten" and no longer carries it.
    - `m7-kill.spec.ts` (`@slow`, hub 8809, the M5 hooks with `MATING_SCALE`):
      - A and B mate, so both carry eggs;
      - B, lowered to 1 hp, is killed by A, which eats B's egg with it (targeting an egg alone needs T15's Tab);
      - B's death screen says "Killed by A", and its fallback lists no pending child;
      - A still carries its own egg.

- [ ] T14 Carrion and growth by kills in play (after T13, T5)
  - Steps:
    1. `src/sim/carrion.ts`: `World.carrion` (sorted by id) and `dropCarrion(world, { enc, x, y, biomass, radius, tick })`:
       - `0.4 × biomass × 3` energy in `clamp(round(radius ÷ 3), 3, 12)` pieces;
       - placed by `hashU32` within 2 victim radii, with ids `x<first 8 of enc>_<i>`;
       - each piece's radius is `1.5 + 0.08 × radius`;
       - they last 1,800 ticks.
       `applyFeeding` eats carrion like food, with efficiency 0.3 (filter), 0.8 (middle), 1 (jaw), and the energy cap still applies. The state hash covers it.
    2. Claims: carrion pieces settle through the existing claims as slot `x…_i` with cycle 0 (lower tick, then lower id), and never respawn.
    3. `worker/settle.ts` broadcasts `carrion` to the whole pond after a kill's records. Every client drops the same pieces.
    4. The render draws carrion through the food layer in its own pale amber tint, larger with its value.
    5. Update DESIGN §2's carrion row. Leave the plankton tables alone.
  - Acceptance (tests first):
    - Sim tests:
      - the same drop gives identical pieces on two worlds;
      - a jaw eating a piece gains its value, and a filter mouth 0.3 of it;
      - pieces vanish at 1,800 ticks;
      - a golden replay with carrion is pinned, and the free-roam goldens are unchanged by an empty `carrion`.
    - A claim test: two eaters of one piece settle by tick, and the loser gives the energy back.
    - A workerd test: a kill broadcasts `carrion` to a spectator in the pond.
    - `m7-carrion.spec.ts` (hub 8810, three contexts): after A kills B, the spectator C sees the carrion and eats a piece, and the piece is gone on A's client too.

- [ ] T15 Multi-party joins and targeting [opus] (after T12, T13, T4)
  - Steps:
    1. `src/sim/encounter/join.ts`: `joinFighter(enc, start, f)` adds the next slot at frame f. The referee's bundles then carry one more input.
    2. `worker/engage.ts`: an engage where one side is already locked joins that fight, if it has fewer than 4 fighters. The checks are as at lock-in, plus `engage:full`. It joins at the current frame + 2, with `enc-join` to everyone and `enc-start` to the joiner. A pair already in different fights is refused `locked`.
    3. Targeting:
       - Tab cycles living opponents and uneaten eggs, nearest first;
       - a click on a fighter or an egg targets it;
       - a ring marks the target;
       - the input's target field carries it, and the default stays the nearest.
       This works whenever there are 3 or more fighters or an egg.
    4. DESIGN §3 and §7, and `docs/TESTING.md`.
  - Acceptance (tests first):
    - Sim: a join at frame f gives the same hash on two replays, and a golden 3-fighter log is pinned.
    - Hub: a third player joins, a fifth is refused `engage:full`, and the joiner's start comes from its signed snapshot.
    - Client unit tests: Tab order, a click on an egg, the target bits.
    - `m7-melee.spec.ts` (hub 8811, three contexts): C joins A and B's fight, and all three clients' hashes equal `enc-end`'s.

### Closing

- [ ] T16 End-to-end scenario, owner checks, documentation sync
  - Steps:
    1. `m7-lifecycle.spec.ts` (`@slow`, hub 8812, the M5 hooks, `?quality=medium`, three contexts A, B and C), in order:
       - A and B hatch; the protected shimmer shows on each for the other, then goes;
       - A and B mate, so both carry eggs;
       - A engages B with F, and the HUD and a telegraph show;
       - B, with `debug.autoBrace(true)`, blocks a strike, and the block counts;
       - A targets B's egg with Tab and eats it, and B sees "Your egg was eaten";
       - B escapes (steers away for 3 s), so B is `escaped` and A `stood`;
       - A engages B again and C engages A, so C joins as the third fighter;
       - B, lowered to 1 hp, is killed (by A or C, whoever lands first): B's death screen names that killer, and its fallback offers no pending child;
       - the carrion drops, C eats a piece, and C then escapes;
       - the medium budgets hold at each step;
       - every participant's hash equals `enc-end`'s at each end.
       It follows `.claude/rules/tests.md`'s determinism rules (state waits, sim ticks), and CI repeats it 3 times before merge (ADR 0042).
    2. Sync DESIGN §2–§3, §5–§8 and §10, `docs/TESTING.md`, and `.claude/rules/{sim,net,worker}.md`: the encounter module, the referee timers, and the input rate cap.
    3. List the owner checks for the Playtest issue (the rubric's `(owner)` lines).
  - Acceptance:
    - Every exit criterion maps to a named test or report (the table below).
    - Each PR E2E part stays under 5 minutes, and the long scenarios are `@slow`.

## Exit criteria → evidence

| Exit criterion (ROADMAP) | Tasks | Evidence |
|---|---|---|
| Refereed deterministic combat for comparable sizes | T1, T2, T8, T9 | encounter goldens; `engage:tier` refusal; referee hub tests |
| Instant lock-in | T6–T8, T11 | `enc-start` ≤ 300 ms after the engage (T8, injected clock); feedback in the key press's frame (T11) |
| Steering, stance, target, brace | T1, T2, T11, T12, T15 | sim tests; `m7-duel`, `m7-hud`, `m7-melee` |
| Deadlines and autopilot | T4, T9 | `Referee` tests; `null` = autopilot test |
| Anatomy-driven outcomes | T2, T5 | combat tests; the win matrix in `docs/perf/combat.md` |
| Identical results on all clients | T1, T9, T10, T11, T15 | goldens in Node, workerd and Chromium; final hashes equal in `m7-duel` and `m7-melee` |
| Killing grows faster than plankton; size is a real advantage | T2, T5, T14 | tournament growth and size lines; `m7-carrion` |
| A pending egg can be eaten by a predator | T3, T13 | egg sim tests; settlement hub tests; `m7-kill` |
| Multi-party joins, rewards and carrion, spawn protection and tiers, HUD and telegraphs, the tournament (outline) | T15, T14, T8, T11, T12, T5 | as listed in each task |

## End-to-end check

`m7-lifecycle.spec.ts` (T16, `@slow`, hub 8812, three players) runs in order:
- hatch and spawn protection;
- a mating;
- an engage with the HUD and telegraphs, and a block;
- an eaten egg, then an escape;
- a three-way join;
- a kill named on the death screen, with the fallback;
- carrion eaten.

It checks the medium budgets throughout, and identical final hashes on every participant at each fight's end. The fast PR suite carries `m7-determinism`, `m7-duel`, `m7-hud`, `m7-carrion` and `m7-melee`.

## Rubric

- [ ] Lock-in feels instant: the engage ring shows in the frame of the key press, and the fight starts ≤ 300 ms after the engage reaches the authority (evidence: T11 unit test, T8 hub test).
- [ ] The own creature responds in the frame its input is sampled, and a remote's rollback correction eases over 0.1 s rather than jumping (evidence: T10 unit tests).
- [ ] Every strike aimed at the player is telegraphed (glow and tick) for 8 ticks, every hit flashes, every block sparks, and every death names its cause and killer (evidence: T12 and T13 E2E, `audio.cues`).
- [ ] No archetype wins more than 70%, genesis duels last a median of 8–25 s, and a body 1.5 × bigger wins ≥ 70% (evidence: `docs/perf/combat.md`).
- [ ] A kill grows the winner ≥ 1.5 × as fast per minute as foraging (evidence: `docs/perf/combat.md`).
- [ ] The combat HUD stays within the 6% budget and shows only in a fight (evidence: `m7-hud`).
- [ ] (owner) Fights with friends over real networks feel fair and responsive, and stance and brace feel like real choices.
- [ ] (owner) Killing feels like the fast way to grow, and size feels like an advantage.
- [ ] (owner) Carrying an egg feels risky and worth protecting.
- [ ] (owner) A fight reads clearly: who hits whom, what is coming, why someone died.

## Risks

- **The authority restarts mid-fight** (no persistence until M8). The fight is void: no records, the locks are gone and nothing settled is lost (ADR 0050). A log line counts it, and M8 persists fights.
- **A timer in the Durable Object fires late.** `tick(now)` finalizes every due frame in order, and clients absorb it by rollback. Tests drive the clock, never real timers.
- **Real latency over 200 ms one-way** makes inputs late, so the autopilot plays. The client's lead goes up to 100 ms. This is a stated limit and an owner check on real networks.
- **Signing cost on slow machines.** The client signs at 5 Hz, for candidates only. The `speedTest` bounds it.
- **Size makes bigger bodies too strong** (kill time grows with the radius ratio squared). T5's size lines bound it, with the fallback of ADR 0051.
- **Kill farming with alternate identities** until M8's decay. Spawn protection, ±1 tier, the 0.5 factor for small victims and the hatch bucket limit it.
- **Desyncs between engines.** Goldens run in Node (check), workerd (T9) and Chromium (T10). Fights only use `src/sim/math.ts`, and the banned-API scan covers the module.
- **Large tasks** (T9, T10, T11) may overrun one session. T10 says what can ship first, and every run pushes its work in progress (ADR 0042). A task that fails across three runs is split (the `next` skill).
- **Merge conflicts between parallel tasks.** The shared shapes above are fixed by this spec. T6 adds every protocol message at once. The sim chain (T1–T5) and the net chain (T6–T10) touch different files. The carrion broadcast sits in `worker/settle.ts` (T13, T14), not in `worker/fights.ts` (T9, T15).
