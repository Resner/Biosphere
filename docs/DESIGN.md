# Game design reference

The living description of how Biosphere plays, with **initial values** for rules version 1. The brief (`docs/BRIEF.md`) is the intent and the ADRs are the lasting decisions; this file explains mechanics in one place so every milestone builds the same game.

- **Code is the source of truth for numbers.** Values below start in `src/sim/rules.ts` (and the genome and combat tables that follow). When a spec or playtest changes a mechanic or a value, update this file in the same PR.
- **Units**: world units (wu; think 1 wu ≈ 1 µm), seconds, and sim ticks at 30 Hz. "r" is a creature's size radius in wu.
- Milestone tags such as (M3) say where a mechanic first appears.

## 1. The loop

- **Seconds**: steer toward food, dodge hazards and bigger creatures, dash to grab or escape.
- **Minutes**: eat, grow, zoom out, reach maturity. Find another player, court, mate. Fight comparable creatures or flee from them (M7).
- **Hours and days**: generations. Choose to become your offspring, keep ancestors as fallback checkpoints, watch the lineage grow and diverge, discover rare traits, show them off.

Death is common and never total: you fall back to your pending offspring or your nearest surviving ancestor. Only when nothing survives do you hatch a new genesis cell, and the old lineage stays in your history.

## 2. World

- **One body of water, seen from above** (ADR 0014). Gameplay is 2D in the x–y plane; z is presentation only.
- **Ponds, then one world**: M1 is a single-player square world (8,192 × 8,192 wu with soft walls). M2 groups players into separate ponds of up to 24, each with its own seed and spawn centre. From M11 the world is one large continuous plane with a spatial directory (ADR 0013).
- **Depth zones (M6)** come from a deterministic bathymetry field (smooth noise of the world seed):

| Zone | Light | Food | Hazard | Adaptation that helps |
|------|-------|------|--------|-----------------------|
| Sunlit shallows | bright caustics, god rays | detritus, globules | UV (2 hp/s × (1 − UV tolerance)) | pigment, UV tolerance |
| Twilight | dimmer, blue | globules, detritus | — | balanced builds |
| Deep | dark; bioluminescence dominates | vent crystals near vents | toxic plumes around vents | luminescence, senses |
| Abyss | near black | rich vent beds | pressure (3 hp/s × (1 − pressure tolerance)) | pressure tolerance, armour |

- **Currents**: a smooth, divergence-free velocity field (max 12 wu/s, spatial period about 2,048 wu, slowly changing with a period of about 120 s; M1: three shear waves) carries creatures on top of their own velocity (a passive creature drifts exactly with the water) and moves plumes. Food only bobs in M1: it does not drift.
- **Food is nonliving** (ADR 0014):

| Food | Value (energy) | Radius (wu) | Where |
|------|----------------|-------------|-------|
| Detritus | 8 | 1.5 | everywhere; filter feeders also absorb it passively (M3) |
| Nutrient globule | 25 | 3 | shallows and twilight |
| Vent crystal | 60 | 2.5 | near vents and plumes (risk for reward) |
| Carrion | share of a dead creature's biomass (M7) | scales with victim | where a creature died |

- Food sits on a grid of 256 wu cells with 10 slots each. A slot's item type is weighted by zone. After an item is eaten the slot stays empty for 20–60 s (hash-determined), then shows the slot's next item at a new position. Items bob within 12 wu of their anchor (a sine per axis, period 4–8 s) (M1: they do not drift with currents). A creature eats every item it overlaps (distance below its radius plus the item's), even at full energy, where the surplus is lost.
- Each tier has food sized for it (M11). Tiny items are noise to giants, so larger tiers feed on denser drifts, vent beds and carrion, and big filter-feeding mouths sweep detritus in bulk.
- **Hazards are nonliving**:
  - toxic plumes: radius 60–160 wu, 15 hp/s while the creature's centre is inside (overlapping plumes don't stack), about one per 9 food cells. Each grid cell anchors at most one plume, which drifts at half the local current (bounded, periodic with the currents);
  - currents (above);
  - UV and pressure (M6).

## 3. Controls and camera

| Action | Mouse | Keyboard |
|--------|-------|----------|
| Steer | cursor direction; distance from the creature sets throttle (dead zone within 0.5 r, linear ramp to full throttle at 3 r) | WASD (overrides the mouse while held) |
| Dash | — | Space (cooldown 2.5 s) |
| Court or accept (M5) | click the creature, then the button | E on the nearest eligible creature |
| Attack (M7) | click a creature in range | F on the nearest target |
| Stance (M7, in combat) | HUD buttons | 1 aggressive, 2 balanced, 3 evasive |
| Target (M7, 3+ participants) | click | Tab cycles |
| Brace (M7, in combat) | right button | Shift |
| Chat, emote, ping (M2) | ping: middle button | Enter, T then 1–6, G |
| Menu | — | Esc |

- **Camera**: top-down perspective, following the creature. The visible half-height is `9 · r^0.9` wu (about 71 wu for a starter), so the on-screen size grows slowly as the creature grows, like Agar.io. Zoom changes are smoothed over about 1 s.

## 4. Creature state and survival (M1, extended by M3)

- **Size**: biomass b; radius `r = √b` (starter b = 100, r = 10).
- **Energy**: `maxEnergy = 2·b`; a new creature starts at 60%.
- **Health**: `maxHealth = 10·r` (starter 100).
- **Movement** (M1 values; from M3 they come from anatomy):

| Quantity | Value |
|----------|-------|
| Thrust | 140 wu/s² × (throttle/15) × (b/100)^−0.1 |
| Drag | linear, 2.2/s (top speed for a starter about 64 wu/s) |
| Turning | 5 rad/s × (b/100)^−0.15, only while the throttle is above 0 |
| Dash | +120 wu/s × (b/100)^−0.1 along the heading; costs 0.06·b energy (ignored without that much energy) |
| Soft wall | within 64 wu of an edge, an inward push up to 300 wu/s² at the edge (more than full thrust) |

- **Metabolism**:

| Drain | Rate |
|-------|------|
| Basal | `0.0253 · b^0.75` energy/s (starter 0.8/s) |
| Movement | `0.006 · b · (throttle/15)²` energy/s |

  From M3 the basal rate is multiplied by an anatomy complexity factor (§6).
- **Growth**: while energy is above 75% of max, the creature converts 3 energy into 1 biomass, at up to `0.005·b` biomass/s, until its genetic maximum (M1: 400).
  Growth also raises health by 10 per unit of radius gained, so a grown creature is as healthy as its size allows; there is no regeneration in M1. Energy never goes below 0.
- **Damage over time**:

| Cause | Drain |
|-------|-------|
| Starvation (energy at 0) | 8 hp/s |
| Toxic plume | 15 hp/s |
| UV, pressure (M6) | per zone |

  At 0 health the creature dies with a **cause** (the last damage taken that tick): starved, toxin, UV, pressure, killed by `<name>`, old age.
- **Tiers** (ADR 0013), with the biomass equivalents:

| Tier | Radius | Biomass |
|------|--------|---------|
| T0 | r < 32 | below 1,024 |
| T1 | 32 ≤ r < 128 | up to 16,384 |
| T2 | 128 ≤ r < 512 | up to 262,144 |
| T3 | 512 ≤ r < 2,048 | up to about 4.2 M |
| T4 | r ≥ 2,048 | the hard cap is r = 4,096 |

## 5. Lifecycle and lineage (M4–M5)

- **Lifespan**: 75 min of active time, scaled ×0.6–1.4 by genes. Active time counts only while the creature is your active creature and you're online, or while it's locked in a committed encounter. Checkpoints and offline creatures are paused.
- **Maturity** needs active time ≥ max(12 min, 20% of lifespan) **and** biomass ≥ 60% of the creature's maximum.
- **Old age** starts at 85% of lifespan (−20% thrust, +20% basal metabolism). Death comes at 100%.
- **Mating**:
  - Both creatures must be mature, have no pending offspring, be within ±1 tier and within 3 body lengths, and not be locked.
  - **Consent**: A courts (E), B accepts within 15 s, and both sign within 20 s.
  - **Cost**: each parent pays 30% of current energy and 15% of biomass.
  - **Cooldown**: 6 min of active time, doubled for each repeat with the same partner within 24 h.
- **Offspring**: two distinct children, one per player (seed slot 0 for A, slot 1 for B), born when the committed drand round arrives (about 3–6 s; ADR 0010).
  - Each player holds **one pending offspring** at most.
  - Hatchling biomass is max(80, 10% of the child's maximum).
  - Generation = max(parents' generations) + 1.
- **Promotion**: becoming your pending offspring turns your current creature into an **inactive checkpoint**. It keeps its condition and remaining lifespan, frozen. The child hatches beside it.
- **Death**: choose between your pending offspring (if any) and your **nearest surviving ancestor** in your checkpoint chain, which comes back with its saved condition and remaining lifespan. Dead or exhausted ancestors are skipped. If nothing survives, hatch a new genesis cell; the old lineage remains as history.
- **Genesis**: DNA from a committed future drand round (ADR 0010). At most one genesis per identity at a time, and at most 1 per 10 min. Genesis cells come from a narrow starter distribution (§6). Rare traits mostly arise through breeding.

## 6. Genetics and development (M3; ADR 0006)

**Karyotype v1.** Diploid, 6 chromosomes (initial layout; M3 may refine it and must update this table):

| Chr | Theme | Loci |
|-----|-------|------|
| 1 | Body plan | segmentation drive (quant ×2 → 1–8 segments), aspect, taper, flexibility, max size (quant ×3 → max biomass), load L1 (membrane integrity) |
| 2 | Integument | membrane thickness, translucency, plating (quant ×2), spines, iridescence (mendel: plain dominant, iridescent recessive), load L2 |
| 3 | Locomotion | module slots M1–M4, gait amplitude, gait frequency, load L3 (beat strength) |
| 4 | Feeding and weapons | mouth size, mouth type (filter ↔ jaw), digestion efficiency, module slots M5–M6 |
| 5 | Senses and behaviour | module slots M7–M8, aggression, caution, curiosity, reflex, target preference (mendel: nearest, weakest, largest) |
| 6 | Pigment and physiology | hue (quant ×3), saturation, value, pattern (mendel: none < rings < spots ≡ stripes, codominant), pattern scale, albino (mendel recessive), luminescence (mendel: on dominant), luminescence hue, lifespan, metabolism, growth, UV tolerance, pressure tolerance, load L4 (metabolic) |

- **Module genes** (8 slots): a presence flag plus 14 parameters — length, thickness, taper, curvature, joints (1–4), branching (0–2), tip shape, stiffness, beat, phase, attach start, attach span, angle, pairs (1–3 per side). Tip shape is a continuum: blunt → point → hook → paddle → whip. Duplication copies a module into an empty slot; the copies then diverge.
- **Genesis distribution**:
  - Segmentation alleles are low (exactly 1 segment: a single cell). Slot M1 holds a whip-like flagellum, and slot M2 is present half the time (a ciliary band).
  - Maximum size gives 300–900 biomass.
  - Colours, patterns and membrane vary widely, so every starter looks distinct.
  - Rare alleles: iridescent (allele frequency 5%), albino (4%), stripes (10%), each load allele (3%).
- **Development caps**: 8 segments, 24 appendages, 4 joints, 1 branch level (≤2 branches), 12 collision circles, bounds ≤2.5× core radius, mesh ≤6,000 vertices (≤1,500 at low detail). Repair guarantees a propulsion source and a mouth.
- **Function from form**:
  - Thrust is the sum over motile parts of length × thickness × beat × efficiency. Whip efficiency falls with size and paddle efficiency rises with it, crossing around T1–T2.
  - Weapon reach and damage come from pointed or hooked tips × stiffness × length.
  - Armour is plating × coverage, and spines deal contact damage.
  - Mouth size limits the largest food item and the bite. A filter mouth (low mouth type) gives passive intake of detritus in its front arc. A jaw mouth (high mouth type) bites big items, carrion and opponents (M7).
  - Sensor modules extend the detection ring, and luminescence matters in dark zones.
- **Costs**: the basal multiplier is `1 + 0.1·(segments − 1) + 0.04·appendages + 0.2·plating + 0.1·luminescence`. Mass slows acceleration and turning, and appendages add drag. No build is best at everything; archetype tests enforce that (M3, M7).
- **Rarity (M3)**:
  - Score = Σ −log2(genesis frequency) over expressed rare features.
  - Tiers: common < 4, uncommon 4–8, rare 8–14, exotic ≥ 14.
  - Each creature gets a deterministic species-like name from its genome hash (for example "Velothrix ambulans").
- **Inbreeding**: recessive load alleles show only when homozygous, so related parents produce weaker children more often (M5).

## 7. Combat (M7–M8; ADR 0011)

- **Who**: creatures within ±1 tier, neither spawn-protected (15 s after spawning, or until the creature attacks). Up to 4 participants; others can join a running fight.
- **Engage**: attack a creature within engage range, which is your reach plus 30% of the target's radius. Lock-in takes about 150 ms with no beacon wait. Participants are locked until settlement (no mating, promotion, restore or habitat moves).
- **Frames**:
  - 100 ms, with a referee deadline of +120 ms. A late or missing input becomes the autopilot from the creature's behaviour genes.
  - Your own creature responds instantly (prediction); others are corrected by rollback of up to 10 frames.
- **Automatic attacks** come from anatomy. A weapon tip in reach and arc strikes after a 250 ms **windup** (a telegraph glow), then waits an 800 ms cooldown. Jaws bite, fast blunt bodies ram, and spines hurt attackers.
- **Damage** = weapon power × stance multiplier × (1 − target armour) × brace multiplier.
- **Player decisions**:
  - **Stance**: aggressive (×1.25 damage dealt, ×0.85 armour), balanced, or evasive (×0.7 damage, +20% speed and turning).
  - **Target**: chosen when there are three or more participants.
  - **Brace**: a 250 ms window with a 2 s cooldown, costing 5 energy. A hit that lands in the window is blocked 80%, and the attacker is staggered for 300 ms.
  - **Positioning**: steering decides whose weapons are in reach.
- **End**:
  - Death.
  - Escape: outside 2× engage range of every opponent for 3 s.
  - Timeout: 90 s.
- **Rewards**: the killer gains 40% of the victim's biomass (as energy first, then biomass). Another 40% scatters as carrion that anyone can eat.
- **Kill farming** (M8): repeated kills of the same victim within 24 h give ×0.5 each time. Victims under 30 minutes old give half.
- **Disconnects** (M8): fights continue on autopilot, reconnecting resumes them, and if everyone leaves the authority finishes and settles the fight.

## 8. Multiplayer and scale

- **Ponds (M2)**: up to 24 players, all connected to each other. A joiner goes to the fullest pond that isn't full. The first player's spawn point becomes the pond's spawn centre; later joiners spawn on a ring around it, 300 + 40 × members wu away.
- **AoI and tiers (M11)**: connect only to creatures within ±1 tier inside the AoI (1.3 × the visible half-diagonal), plus boundary neighbours and duties. The default cap is 24, the hard cap 32 (ADR 0013). Giants see smaller life as ambient swarms.
- **Spawning and regrouping (M12)**:
  - Newcomers spawn on a ring around a compatible group, at least 3× the attack reach of larger creatures away and away from recent spawn points. The ring expands as the area fills.
  - After 120 s alone you may "ride the current" to a group.
  - Crowded spots split into bounded instances that never separate interacting creatures.
- **Admission (M4, M13)**: past capacity or 90% of the daily budget, new players are queued with a position and an estimated wait.

## 9. Social (M2)

- **Chat**: up to 140 characters, 3 messages per 5 s per sender (receivers drop extras). Profanity is filtered with English and German lists after leetspeak normalisation. Messages show in a panel and as short bubbles above the creature.
- **Display names**: 3–16 characters from `A–Z a–z 0–9 _ -`, also filtered.
- **Emotes** (6): wave, happy, love, angry, scared, question.
- **Pings** (4, lasting 4 s, at most 1 per second): look, danger, food, mate.
- **Mute** a player locally.

## 10. Feedback (readability)

| Event | Visual | Audio (M6) |
|-------|--------|------------|
| Eat | pop and sparkle; energy bar pulse | soft bubble pop |
| Damage | red pulse on the body; edge vignette | dull hit |
| Low energy (<20%) | HUD pulse | slow low pulse |
| Hazard near | hazard outline brightens | rumble |
| Dash | ripple | whoosh |
| Windup aimed at you (M7) | glow on the attacker's weapon | rising tick |
| Death | dissolve; death screen naming the cause | descending tone |
| Court, mate, hatch (M5) | bioluminescent dance; egg crack | chime; bright chime |
| Growth into a new tier | zoom-out swell | soft swell |

Never a silent death: every source of damage and every death cause has a cue.

## 11. Supply control and anti-farming

- Survival costs (metabolism, hazards), finite lifespan, and maturity and cooldown gates on the authority clock.
- A genesis limit per identity. Genesis cells are simple; rarity mostly comes from breeding and survival.
- Mating costs, a same-partner cooldown that doubles, and inbreeding that expresses load alleles.
- Kill-reward decay for repeated victims and new identities (M8). Witness eligibility needs play history (M10).
- Many bot identities still mean more attempts, but none of them skips the time gates or upkeep (M10 runs a bot-farm simulation to check this).

## 12. Quality presets (M6)

| Preset | Pixel ratio | Post-processing | Particles | Budget (draw calls / triangles) |
|--------|-------------|-----------------|-----------|---------------------------------|
| Low | 1 | none (fake bokeh sprites only) | 30% | 80 / 150k |
| Medium (default) | up to 1.5 | half-res DOF, bloom, grade | 100% | 150 / 300k |
| High | up to 2 | full DOF, bloom, chromatic aberration, grain | 150% | 250 / 600k |

The automatic default picks a preset from a short benchmark; adaptive resolution steps down when frames run over budget.

## Glossary

- **Active creature**: the one creature a player currently plays (one per player).
- **Checkpoint**: an inactive former creature, paused with its condition and remaining lifespan; a fallback after death.
- **Pending offspring**: a born child not yet promoted (at most one per player).
- **Genesis**: a creature hatched from fresh DNA, the root of a lineage.
- **Lineage**: the ancestry graph (both parents) and the player's checkpoint chain through it.
- **Head**: the one accepted current record of a creature (ADR 0009).
- **Encounter**: a locked, refereed fight between 2–4 creatures (ADR 0011).
- **Pond**: a bounded group of up to 24 players before M11. **Habitat**: the authority's grouping of players into connected P2P neighbourhoods.
- **Tier**: a size band, ×4 in radius per step.
- **Witness**: a drand-selected peer that referees or audits an event (ADR 0012).
