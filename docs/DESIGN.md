# Game design reference

The living description of how Biosphere plays, with **initial values** for rules version 4. The brief (`docs/BRIEF.md`) is the intent and the ADRs are the lasting decisions; this file explains mechanics in one place so every milestone builds the same game.

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
- **Hatching (M1)**: from M3 the body is fresh genesis DNA each life (browser-local random seed; `?genome=` pins it for tests). A new cell appears at the world centre, or at the nearest point at least 120 wu clear of any toxic plume, now and at every second of the next 10 s of drift (`RULES.spawn.lookaheadTicks`, `lookaheadStride`), so nobody is born poisoned.
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

- Food sits on a grid of 256 wu cells with 10 slots each. A slot's item type is weighted by zone. After an item is eaten the slot stays empty for 20–60 s (hash-determined), then shows the slot's next item at a new position. Items bob within 12 wu of their anchor (a sine per axis, period 4–8 s) (M1: they do not drift with currents). A creature eats an item when it overlaps the creature's **mouth disc** (distance below the mouth radius plus the item's) unless its energy is at the maximum; then the item stays (M2). The mouth disc is centred `offset·r` ahead of the centre with radius `radius·r`, and the item must lie within the mouth's arc; a starter cell's mouth is its whole body (offset 0, radius 1, full arc), as in M1. The yield is `value × efficiency(kind, mouth type) × digestion`, and an item with efficiency 0 is left alone (M3, §6). In a pond, two players reaching the same item are settled by the lower claim tick, then the lower id; the loser gives the energy back (ADR 0016). A claim or consumed entry outside 900 ticks (30 s) of the local pond clock, or for a cycle the slot cannot have reached (each cycle takes at least 600 ticks), is ignored and counted. A peer link that was up and dropped is re-called by the lower id, up to 5 times with a doubling wait (3 s first).
- Each tier has food sized for it (M11). Tiny items are noise to giants, so larger tiers feed on denser drifts, vent beds and carrion, and big filter-feeding mouths sweep detritus in bulk.
- **Hazards are nonliving**:
  - toxic plumes: radius 60–160 wu, 15 hp/s × the creature's exposure (overlapping plumes don't stack), about one per 9 food cells. Exposure (M3) is the share of the body's collider area whose centre lies inside a plume (§6), so a single cell is 0 or 1 as in M1 and a long body can trail a hand into the edge. Each grid cell anchors at most one plume, which drifts at half the local current (bounded, periodic with the currents);
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
- **Movement** (M1 values; from M3 each is multiplied by the body's stat multipliers from anatomy, §6: thrust, drag and turn; a dash scales with √(thrust ÷ drag)):

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
- **Growth**: while energy is above 75% of max, the creature converts 3 energy into 1 biomass, at up to `0.012·b` biomass/s (rules version 3; M1's `0.005·b` was too slow, owner, Playtest v0.2.0), times the growth gene, until its genetic maximum (M1: 400; M3: the max-size gene, §6).
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

- **Lifespan** (M4, ADR 0019): 75 min of active time, scaled ×0.6–1.6 by the lifespan gene (45–120 min). Active time is accrued by the authority from your progress reports as `min(ticks played ÷ 30, real time passed + 2 s)`, so a hidden tab, an offline player and a checkpoint accrue nothing, and nobody ages faster than real time. It also counts while the creature is locked in a committed encounter (M8). A creature you hatch is yours alone: no one else's session advances it.
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
- **Genesis**: DNA from a committed future drand round (ADR 0010), recomputable by anyone from the commitment and the beacon (ADR 0019). At most one living creature per identity, and a bucket of 3 hatches that refills 1 per 5 minutes (M4; 1 per 10 minutes would have broken the loop). An empty bucket shows a countdown, and the player may swim as an unrecorded practice cell. Genesis cells come from a narrow starter distribution (§6). Rare traits mostly arise through breeding.
- **Progress and resume** (M4): while you play, the client reports your condition (biomass, energy, health) every 30 s. The authority clamps and flags implausible values, keeps the latest in memory, and writes a checkpoint when you disconnect, every 15 min of active time and at death. Coming back resumes the same creature at the pond's spawn point with that condition; a reload rewinds at most 30 s and never refills lifespan or the hatch bucket.
- **Recovery code** (M4): a 55-character code (Crockford base32, groups of 5, checksummed) shows your identity's key on request. Importing it replaces the identity of that browser.

## 6. Genetics and development (M3; ADR 0006)

**Karyotype v1.** Diploid, 6 chromosomes, 164 bytes per haplotype and 328 per genome (`src/genome/karyotype.ts` is the source of truth; this table mirrors it):

| Chr | Theme | Loci |
|-----|-------|------|
| 1 | Body plan | segmentation drive (quant ×2 → 1–8 segments), aspect, taper, flexibility, max size (quant ×3 → max biomass), load L1 (membrane integrity) |
| 2 | Integument | membrane thickness, translucency, plating (quant ×2), spines, iridescence (mendel: plain dominant, iridescent recessive), texture (mendel, incomplete: smooth ↔ grainy blend), load L2 |
| 3 | Locomotion | module slots M1–M4, gait amplitude, gait frequency, load L3 (beat strength) |
| 4 | Feeding and weapons | mouth size, mouth type (filter ↔ jaw), digestion efficiency, module slots M5–M6 |
| 5 | Senses and behaviour | module slots M7–M8, aggression, caution, curiosity, reflex, target preference (mendel: nearest, weakest, largest) |
| 6 | Pigment and physiology | hue (quant ×3), saturation, value, pattern (mendel: none < rings < spots ≡ stripes; equal ranks show both), pattern scale, albino (mendel recessive), luminescence (mendel: on dominant), luminescence hue, lifespan, metabolism, growth, UV tolerance, pressure tolerance, load L4 (metabolic) |

- **Encoding**: one byte per locus, in chromosome order, haplotype A then B; a module slot is 15 bytes. Any byte string decodes: short input is zero-padded, extra bytes are ignored, a `mendel` byte wraps into its table (`byte mod size`), a `load` byte keeps its low bit (1 = loss of function), and a module's presence is its low bit with all parameters zeroed when absent. Every `mendel` table ends with at least one novel allele (oil iridescence, ridged texture, pulse luminescence, strongest target, bands pattern, pale albino) that genesis never produces. The genome hash is SHA-256 of `bs/genome/v1\n` and the canonical bytes.
- **Module genes** (8 slots): a presence flag plus 14 parameters — length, thickness, taper, curvature, joints (1–4), branching (0–2), tip shape, stiffness, beat, phase, attach start, attach span, angle, pairs (1–3 per side). Tip shape is a continuum: blunt → point → hook → paddle → whip. Duplication copies a module into an empty slot; the copies then diverge.
- **Genesis distribution**:
  - Segmentation alleles are low (exactly 1 segment: a single cell). Slot M1 holds a whip-like flagellum, and slot M2 is present half the time (a ciliary band).
  - Maximum size gives 300–900 biomass.
  - Colours, patterns and membrane vary widely, so every starter looks distinct.
  - Rare alleles: iridescent (allele frequency 5%), albino (4%), stripes (10%), each load allele (3%).
  - Implementation (`src/genome/genesis.ts`, `GENESIS_FREQ`): `genesisGenome(seed)` draws every trait from its own `genesis` PRNG stream. Hue is uniform, other colour traits and the membrane are wide, armour and spines stay low, and sizes lean small. Alleles are drawn per haplotype: luminescent 30%, pattern none/rings/spots/stripes 40/20/30/10%, grainy 50%, and the rare ones above, so a recessive shows in about 1 cell in 400 (iridescent) or 600 (albino). The M1 whip is varied around the starter's, and a ciliary band (M2) is added to half of the cells. The median top speed is about 1.1× the M1 cell's.
- **Expression** (M3; `RULES.genes`, `src/genome/express.ts`): a quantitative trait is the mean of both alleles over its loci (equal weights), mapped linearly onto its range, so a locus moving 0 → 255 on both alleles moves the trait by (high − low) ÷ the number of loci. Plating and hue are sums of two and three loci; segments are the two drive loci mapped onto 1–8 in equal steps. Ranges: aspect 0.8–2.4, taper 0–0.8, mouth size 0.2–1, digestion 0.7–1.2, gait frequency 0.5–2, saturation 0.3–1, value 0.35–1, lifespan 0.6–1.6, metabolism and growth 0.7–1.4, everything else 0–1. Complete dominance shows the higher-ranked allele (equal ranks show both, as spots with stripes do); incomplete dominance blends the ranks. A module is expressed when present in either haplotype, and parameters present in both average, rounding half up. A load locus matters only when homozygous: membrane integrity ×0.6 (L1), the malformed-part scale ×0.6 (L2), beat strength ×0.7 (L3), metabolism cost ×1.3 (L4).
- **Max size** (M3): `maxBiomass = 300 · 2^(13·t)`, with `t` the mean of three quant loci scaled to 0–1 (genesis 300–900; the top is about tier 3). Growth stops there.
- **Mouth and feeding** (M3): the mouth type runs from 0 (filter) to 1 (jaw). Efficiency by food kind, linear between anchors:

| Mouth type | Detritus | Globule | Crystal |
|------------|----------|---------|---------|
| 0 (filter) | 1.0 | 0.6 | 0 |
| 0.5 | 0.8 | 1.0 | 0.6 |
| 1 (jaw) | 0.4 | 0.8 | 1.0 |

  Filter mouths are wide and sit on the body (large `radius`, small `offset`); jaws are small and reach ahead (small `radius`, large `offset`, narrow arc). Digestion multiplies every yield.
- **Colliders** (M3): up to 12 circles in the body frame, in units of the core radius `r = √b`, the first always the core at the origin with radius 1. They give toxin exposure now and creature hit shapes later (M5, M7). Creatures still pass through each other until M5.
- **Body limits** (`RULES.body`, enforced on every body entering the sim): thrust, drag, turn, basal and growth multipliers 0.1–4; max biomass 100–2,457,600; 1–12 collision circles of radius 0.05–1.5 whose far edge stays within 2.5 core radii; mouth radius 0.05–3, half-arc 0.05–π, digestion 0.1–1.5.
- **Development caps**: 8 segments, 24 appendages, 4 joints, 1 branch level (≤2 branches), 12 collision circles, bounds ≤2.5× core radius, mesh ≤6,000 vertices (≤1,500 at low detail). Repair guarantees a propulsion source and a mouth.
- **Development** (M3; `RULES.develop`, `src/genome/develop.ts`): `develop(traits)` builds the plan in core radii and repairs it, in this order:
  - Segments are ellipses along the spine (core first, the rest behind it), half-length = radius × aspect ÷ 1.6 within 0.6–1.2; taper shrinks the rear radius by up to 60%. Segments behind the core scale together so the rear stays within 1.8 of the core, which keeps 8 segments inside the bounds.
  - Each present module becomes `pairs` (1–3) left parts, mirrored right. A part leaves the segment at attach start/span (front to rear, mapped to segment indices) at an angle of 0.2–2.94 rad from the heading. Length 0.1–1.5, base width 0.04–0.4, joints 1–4, branches 0–2 (each 0.6× its parent). The first present module is the malformed part under L2: its length and width are ×0.6, below those ranges.
  - Parts on one segment and side keep 0.3 rad apart: later ones are pushed round the outline, and one that no longer fits merges into its neighbour (the survivor thickens and keeps the stronger beat). Lengths shrink so the root plus the reach (branches ×1.6) stays within 2.45 core radii.
  - Parts beyond 12 per side (24 instances) or beyond the vertex budget are dropped from the end of the list (module order, then pair). If motile area (length × width × beat × (1 + 0.36·branches), parts with beat ≥ 0.1) is below 0.06, a default ciliary band (two pairs, whip tips) is added on the rearmost segment with room; only when no segment has room are the last parts dropped until it fits.
  - The mouth: radius = size × (1.5 − type); a type above 0.5 moves it forward (offset up to 0.6) and narrows its arc to 0.2π. Plating gives every segment plates of coverage = plating, thickness 0.03–0.2. Colliders: the core, one per further segment, then the biggest left-right pairs (length × width) while two circles still fit under 12; parts too thin for a circle of the minimum radius 0.05 (width below 0.1: cilia, whips) get none.
  - Vertex estimate: per segment 108 (low 30), per part piece (joints × 3 + 1) × 8 + 1 (low (joints + 1) × 4 + 1), each part counting itself and its branches.
- **Stats** (M3; `RULES.stats`, `src/genome/stats.ts`): `computeStats(plan, traits)` gives the adult numbers (at the maximum biomass; `statsAt` takes any size). Multipliers are relative to the reference cell (`starterGenome`: one round cell, one whip, all-round mouth), which therefore reproduces `STARTER_PHYS`.
  - Thrust: Σ over motile instances of length × width × beat × (1 + branches·0.36) × efficiency × beat load × (0.7 + 0.3·gait amplitude), divided by mass. A tip's efficiency is 0.25 plus its whip share × (size ÷ 16,384)^−0.25 plus its paddle share × (size ÷ 16,384)^0.25; the paddle share peaks at tip 0.75 and the whip share rises to tip 1. The sim sees the adult value for the whole life.
  - Drag: 2 × widest radius × (1 + 0.6 ÷ fineness) × (1 − 0.2·rear taper), plus 0.25 × Σ width × (1 + length) × (1 + 0.6·branches), 0.3 × plate area and 0.1 × spines × width.
  - Mass: body area × (1 + 0.1·spines) + appendage area + 4 × plate area. Turning: (1 + 0.5·flexibility + Σ part thrust × distance from the centre) ÷ moment of inertia.
  - Weapons: pointed to hooked tips (peak at tip 0.375) × stiffness × length, plus the bite of a jaw mouth (0.5 × jaw share × mouth size); reach is the farthest tip, arc the widest weapon angle. Armour is plate coverage × thickness against the thickest plate, area-weighted. Detection ring: 1 + 0.5 × Σ length × forwardness × slenderness × (1 − beat). Glow is 1 for luminescent, 0.5 for pulse.
  - Basal: the formula under Costs × the metabolism trait × the metabolic load, relative to the reference.
- **Inheritance** (M3; `RULES.genetics`, `src/genome/inherit.ts`): the child is a gamete of parent A (first haplotype) plus a gamete of parent B (second), from `offspringSeed` = SHA-256 of `bs/offspring/v1`, the beacon randomness, the commit id and the slot byte, read as four big-endian words.
  - Meiosis, per chromosome: a random starting haplotype, then 0, 1 or 2 crossovers (40 / 40 / 20%), each at a uniformly chosen boundary between loci, so neighbours rarely separate and chromosomes assort independently. A module slot moves as one locus.
  - Mutation, per gamete: three trials, each firing with 15% × the mutation factor (the Lab's ×4 gives 60%). A fired trial picks a kind by weight: quant step 30, allele change 14, load flip 10, parameter drift 20, module duplication 8, module deletion 8, novel allele 10. Steps move a byte by 1–24; allele change stays within the genesis alleles; a novel allele comes from the table's tail; drift and deletion act on present modules, duplication copies one into an empty slot (the copies then drift apart). A kind with no target does nothing.
  - Streams `meiosis-a`, `meiosis-b`, `mutation-a`, `mutation-b`; `mutateGenome` (Lab) runs only the mutation streams on both haplotypes of one genome.
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
  - Features: iridescent, albino, stripes, spots, rings, luminescent (priced from their exact genesis frequency), and 12 bits each for extra segments, extra modules (beyond the whip and cilia), a novel allele, or a max size of tier 1 and up (1,024 biomass).
  - Each creature gets a deterministic species-like name: a genus from its genome hash (three syllables and a suffix) and an epithet from its strongest trait (for example "Dabelothrix natans").
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

- **Ponds (M2)**: up to 24 players, all connected to each other. A joiner goes to the fullest pond that isn't full. A pond's spawn centre is the world centre; a joiner takes the first free slot i of the pond and spawns on a ring around it at angle i × 2.399963 rad, 300 + 40 × i wu away (slot 0 is the centre), moved clear of plumes.
  - **Pond clock**: the hub's clock gives every pond tick (30 Hz from the pond's epoch), so food and plumes agree between players. Each browser simulates only its own creature; others are drawn from 10 Hz snapshots, 120 ms behind. A silent player fades after 2 s and disappears after 6 s. A hidden tab freezes your cell and fades you out for the others (ADR 0016).
  - **Bodies (M3)**: a browser sends its genome (about 330 bytes) once to each peer when a link opens and again when it hatches a new body; snapshots carry a 2-byte reference to it (ADR 0018). Until a peer's genome arrives, it is drawn as a plain tinted cell.
  - **Offline**: if the hub can't be reached you play alone in a local pond and the status says so.
- **AoI and tiers (M11)**: connect only to creatures within ±1 tier inside the AoI (1.3 × the visible half-diagonal), plus boundary neighbours and duties. The default cap is 24, the hard cap 32 (ADR 0013). Giants see smaller life as ambient swarms.
- **Spawning and regrouping (M12)**:
  - Newcomers spawn on a ring around a compatible group, at least 3× the attack reach of larger creatures away and away from recent spawn points. The ring expands as the area fills.
  - After 120 s alone you may "ride the current" to a group.
  - Crowded spots split into bounded instances that never separate interacting creatures.
- **Admission (M4, M13)**: past 200 concurrent sessions or 90% of the daily request budget (100,000), new players are queued with a position and an estimated wait (30 s per place until M13 measures it). A queued player can swim as a practice cell meanwhile.

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
| Old age (M4) | stage word on the life bar, grey tint, "Feeling old" toast at 85% of the lifespan | slow low swell (M6) |
| Court, mate, hatch (M5) | bioluminescent dance; egg crack | chime; bright chime |
| Growth into a new tier | zoom-out swell | soft swell |

Never a silent death: every source of damage and every death cause has a cue.

Presentation timings (v1, `FX` in `src/render/effects.ts`): eat pop 0.55 s, dash ripple 0.85 s, damage vignette at least 40% on any hit and fading with a 0.25 s time constant, death dissolve 1.2 s before the death screen, low-energy pulse below 20%.

## 11. Supply control and anti-farming

- Survival costs (metabolism, hazards), finite lifespan, and maturity and cooldown gates on the authority clock.
- A genesis limit per identity. Genesis cells are simple; rarity mostly comes from breeding and survival.
- Mating costs, a same-partner cooldown that doubles, and inbreeding that expresses load alleles.
- The hatch bucket and the authority's progress clamps (M4); a client's reload can undo at most 30 s of play, so a death is not an escape (audits come in M10).
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
