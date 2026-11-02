# Game design reference

The living description of how Biosphere plays, with **initial values** for rules version 8. The brief (`docs/BRIEF.md`) is the intent and the ADRs are the lasting decisions; this file explains mechanics in one place so every milestone builds the same game.

- **Code is the source of truth for numbers.** Values below start in `src/sim/rules.ts` (and the genome and combat tables that follow). When a spec or playtest changes a mechanic or a value, update this file in the same PR, replacing what changed.
- **Units**: world units (wu; think 1 wu ≈ 1 µm), seconds, and sim ticks at 30 Hz. "r" is a creature's size radius in wu.
- Parts of the game that later milestones build (combat, scale) are marked with the milestone that brings them.

## 1. The loop

- **Seconds**: steer toward food, dodge hazards and bigger creatures, dash to grab or escape.
- **Minutes**: eat, grow, zoom out, reach maturity. Find another player, court, mate. Fight comparable creatures or flee from them (M7).
- **Hours and days**: generations. Choose to become your offspring, keep ancestors as fallback checkpoints, watch the lineage grow and diverge, discover rare traits, show them off.

Death is common and never total: you fall back to your pending offspring or your nearest surviving ancestor. Only when nothing survives do you hatch a new genesis cell, and the old lineage stays in your history.

## 2. World

- **One body of water, seen from above** (ADR 0014). Gameplay is 2D in the x–y plane; z is presentation only.
- **Ponds, then one world**: a pond is a square world of 8,192 × 8,192 wu with soft walls, holding up to 24 players, each pond with its own seed and spawn centre. The one large continuous plane with a spatial directory comes with M11 (ADR 0013).
- **Hatching**: with a hub, the body is the genesis creature the authority records: the player waits 3 to 6 s ("Awaiting beacon") for a drand round, and the client recomputes the DNA before the cell appears; a saved creature is resumed instead. Without a hub, with an empty hatch bucket or with `?genome=` pinning a body for tests, the cell is an unrecorded practice cell ("Not recorded" badge) with a browser-local random body. A new cell appears at the world centre, or at the nearest point at least 120 wu clear of any toxic plume, now and at every second of the next 10 s of drift (`RULES.spawn.lookaheadTicks`, `lookaheadStride`).
- **Depth zones** come from a deterministic bathymetry field of the pond seed (`src/sim/bathymetry.ts`, `RULES.bathymetry`): depth 0 (surface) to 1 (abyss floor) from three octaves of smooth value noise (wavelengths 2,048, 1,024 and 512 wu) plus a slope towards one side of the pond, calibrated per seed so every pond has the same shares: shallows (depth below 0.25) 20–30%, twilight (to 0.55) 30–40%, deep (to 0.8) 20–30%, abyss 5–15%. A disc of 1,400 wu around the world centre, which holds the whole spawn ring (300 + 40 × 23 = 1,220 wu), is always twilight, and the nearest shallows and nearest deep are each within 2,200 wu of it.

| Zone | Light | Food | Hazard | Adaptation that helps |
|------|-------|------|--------|-----------------------|
| Sunlit shallows | calm caustics, faint god rays | detritus 55, globules 45 | UV (2 hp/s × (1 − UV tolerance)) | pigment, UV tolerance |
| Twilight | dimmer, blue | detritus 62, globules 38 | — | balanced builds |
| Deep | dark; bioluminescence dominates | detritus 90, crystals 10; within 300 wu of a vent detritus 60, crystals 40 | toxic plumes around vents; pressure ramps in from depth 0.7 | luminescence, senses |
| Abyss | near black | detritus 40, crystals 60; within 300 wu of a vent detritus 20, crystals 80 | pressure (3 hp/s × (1 − pressure tolerance)) | pressure tolerance, armour |

  UV ramps in over 0.02 of depth (about 64 wu) below the shallows' edge; pressure ramps linearly from depth 0.7 to 0.8, the abyss' edge. Both are measured at the creature's centre. The weights are per food kind (detritus, globule, crystal) of a slot, by the zone at its anchor. UV and pressure follow the world's `hazards` option, like plumes.

- **Zones on screen** (`src/render/zones.ts`): the water takes its colour, brightness and fog from a 256 × 256 depth map of the pond, the zones blending over ±0.01 of depth (about 30 wu): bright cyan-green shallows, blue twilight, blue-black deep, near-black abyss. In the deep and the abyss the player sees clearly within its detection ring (`sense` core radii, at least 2.5); by twice that the water, food and other bodies fade into the zone's fog (deep 50%, abyss 75%), but a body always keeps its rim. A luminescent creature lights a pool 6 core radii wide that clears the fog (8 glows at most: the player's first), and vent crystals glow by themselves. Marine snow dims to 60% in the deep and 35% in the abyss. While UV or pressure hurts the player a round icon (a sun, or two inward chevrons) sits on the minimap rim, and each hit jolts the creature and kicks the camera (§10).
- **Sunlight and marine snow** (`sunlight` in `src/render/zones.ts`, `shaders/caustics.glsl`, `shaders/godrays.glsl`): sunlight is strongest in the shallows and never grows deeper down: the twilight's top takes the shallows' strength, fades to a quarter of it by its floor, and the deep and the abyss have none. Caustics are moving filaments (18 wu across) on the water and over every body; god rays are slow shafts from a light to the upper left (0.8), drawn in the post composite, so low has none. The shallows' and the twilight's top hold caustics at 0.55 and god rays at 0.4; the shallows stay calm, drifting at 0.16 of the clock's pace (`ZONE_LOOK[zone].pace`; `SunClock` integrates it, so crossing a zone edge never moves the light). Marine snow lies in three layers (far bokeh below the plane, snow within 0.2 camera heights of it, near bokeh above; 290, 2,500 and 60 specks at 100%, a preset draws its share) and is carried by the currents at the camera.
- **Currents**: a smooth, divergence-free velocity field (max 12 wu/s, spatial period about 2,048 wu, slowly changing with a period of about 120 s) carries creatures on top of their own velocity (a passive creature drifts exactly with the water) and moves plumes. Food does not drift.
- **Food is nonliving** (ADR 0014):

| Food | Value (energy) | Radius (wu) | Where |
|------|----------------|-------------|-------|
| Detritus | 8 | 1.5 | everywhere; filter feeders also absorb it passively |
| Nutrient globule | 25 | 3 | shallows and twilight |
| Vent crystal | 60 | 2.5 | deep and abyss, richest near vents and plumes (risk for reward) |
| Carrion | share of a dead creature's biomass (M7) | scales with victim | where a creature died |

- Food sits on a grid of 256 wu cells with 10 slots each. A slot's item type is weighted by the zone at its anchor (table above). After an item is eaten the slot stays empty for 20–60 s (hash-determined), then shows the next item at a new position. A creature eats an item when it overlaps its **mouth disc** (centred `offset·r` ahead of the centre with radius `radius·r`, the item within the mouth's arc; a starter cell's mouth is its whole body) unless its energy is at the maximum. The yield is `value × efficiency(kind, mouth type) × digestion`; an item with efficiency 0 is left alone (§6). In a pond, two players reaching the same item are settled by the lower claim tick, then the lower id; the loser gives the energy back (ADR 0016). A claim outside 900 ticks (30 s) of the local pond clock, or for a cycle the slot cannot have reached (each takes at least 600 ticks), is ignored and counted. A dropped peer link is re-called by the lower id, up to 5 times with a doubling wait (3 s first).
- Each tier has food sized for it (M11). Tiny items are noise to giants, so larger tiers feed on denser drifts, vent beds and carrion, and big filter-feeding mouths sweep detritus in bulk.
- **Hazards are nonliving**:
  - toxic plumes: radius 60–160 wu, 15 hp/s × the creature's exposure (overlapping plumes don't stack). A plume rises from a vent: about one per 9 food cells in the deep and the abyss, at least 1,800 wu from the spawn centre (none in the shallows or twilight, so at least 80% of plumes, drift included, lie in deep water). Exposure is the share of the body's collider area whose centre lies inside a plume (§6), so a single cell is 0 or 1 and a long body can trail a hand into the edge. Each grid cell anchors at most one plume, which drifts at half the local current (bounded, periodic with the currents);
  - currents (above);
  - UV and pressure (the zone table above): a creature's `uvTolerance` and `pressureTolerance` (0–1, from its physiology genes) are part of its body stats and of the state hash.

## 3. Controls and camera

| Action | Mouse | Keyboard |
|--------|-------|----------|
| Steer | cursor direction; distance from the creature sets throttle (dead zone within 0.5 r, linear ramp to full throttle at 3 r) | WASD (overrides the mouse while held) |
| Dash | — | Space (cooldown 2.5 s) |
| Court or accept | click the creature, then the button | E on the nearest eligible creature |
| Become your offspring | the Offspring card button | H |
| Attack (M7) | click a creature in range | F on the nearest target |
| Stance (M7, in combat) | HUD buttons | 1 aggressive, 2 balanced, 3 evasive |
| Target (M7, 3+ participants) | click | Tab cycles |
| Brace (M7, in combat) | right button | Shift |
| Chat | — | Enter |
| Ping or emote | pick on the wheel (release over an item or click it); middle button: a quick look ping | G opens the wheel at the cursor, then 1–0 or release over an item; Esc cancels; T then 1–6 still emotes; your movement carries on while it is open |
| Pond map | — | M (M or Esc closes it; steering carries on under it) |
| Menu | the menu button in the top-left corner | Esc |

- **Core actions** (ADR 0014's six): steer, dash, court, attack, the social wheel and the menu. Every other key is a shortcut for something the screen also offers (the Offspring card, the minimap, the wheel's emotes, the combat HUD); chat is the one that needs typing.
- **Camera**: top-down, following the creature. The visible half-height is `9 · R^0.9 · (r / R)^0.6` wu (ADR 0029), where `r` is the creature's radius and `R` the radius at its genetic maximum biomass. An adult sees `9 · R^0.9` (about 134 wu for the starter, whose `R` is 20), and a smaller creature sees less, so growth shows within one life (tripling the radius makes it 3^0.4 ≈ 1.55× larger on screen).

## 4. Creature state and survival

- **Size**: biomass b; radius `r = √b` (starter b = 100, r = 10).
- **Energy**: `maxEnergy = 2·b`; a new creature starts at 60%.
- **Health**: `maxHealth = 10·r` (starter 100).
- **Movement** (each is multiplied by the body's stat multipliers from anatomy, §6: thrust, drag and turn; a dash scales with √(thrust ÷ drag)):

| Quantity | Value |
|----------|-------|
| Thrust | 140 wu/s² × (throttle/15) × (b/100)^−0.1 |
| Drag | linear, 2.2/s (top speed for a starter about 64 wu/s) |
| Turning | 5 rad/s × (b/100)^−0.15, only while the throttle is above 0 |
| Dash | +120 wu/s × (b/100)^−0.1 along the heading; costs 0.06·b energy (ignored without that much energy) |
| Soft wall | within 64 wu of an edge, an inward push up to 300 wu/s² at the edge (more than full thrust) |

- **Speed band** (ADR 0036, `bandSpeed` in `src/genome/stats.ts`, `RULES.stats.speedBand`): the anatomy's top-speed multiplier (thrust ÷ drag; the starter cell is 1) passes through a strictly increasing soft clamp into 0.6–1.6, by rescaling thrust. Between 1.0 and 1.1 it is unchanged; outside it eases toward the limit like d·w ÷ (d + w), so a faster form stays faster, only by less (a body with no thrust still moves at 0.71×). Every body's top speed therefore lies within 0.6–1.6× the starter's, a dash within √0.6–√1.6×, at every size. `npm run report:speed`: genesis bodies run 46.6–102 wu/s (median 74) against the starter's 65. Turning is not banded. A remote creature catches up at 1.2× its speed after a snapshot gap, or is drawn at once if moved over 400 wu (`RemoteBuffer`).
- **Metabolism**:

| Drain | Rate |
|-------|------|
| Basal | `0.0253 · b^0.75` energy/s (starter 0.8/s), times an anatomy complexity factor (§6) |
| Movement | `0.006 · b · (throttle/15)²` energy/s |

- **Growth**: while energy is above 75% of max, the creature converts 3 energy into 1 biomass, at up to `0.012·b` biomass/s times the growth gene, until its genetic maximum (the max-size gene, §6). Growth also raises health by 10 per unit of radius gained, so a grown creature is as healthy as its size allows; there is no regeneration. Energy never goes below 0.
- **Damage over time**:

| Cause | Drain |
|-------|-------|
| Starvation (energy at 0) | 8 hp/s |
| Toxic plume | 15 hp/s |
| UV | 2 hp/s × (1 − UV tolerance), in the shallows |
| Pressure | 3 hp/s × (1 − pressure tolerance), in the lower deep and the abyss |

  At 0 health the creature dies with a **cause** (the last damage taken that tick): starved, toxin, UV, pressure, killed by `<name>`, old age.
- **Tiers** (ADR 0013), with the biomass equivalents:

| Tier | Radius | Biomass |
|------|--------|---------|
| T0 | r < 32 | below 1,024 |
| T1 | 32 ≤ r < 128 | up to 16,384 |
| T2 | 128 ≤ r < 512 | up to 262,144 |
| T3 | 512 ≤ r < 2,048 | up to about 4.2 M |
| T4 | r ≥ 2,048 | the hard cap is r = 4,096 |

## 5. Lifecycle and lineage

- **Lifespan** (ADR 0019): 75 min of active time, scaled ×0.6–1.6 by the lifespan gene (45–120 min). Active time is accrued by the authority from your progress reports as `min(ticks played ÷ 30, real time passed + 2 s)`, so a hidden tab, an offline player and a checkpoint accrue nothing, and nobody ages faster than real time. It also counts while the creature is locked in a committed encounter (M8). A creature you hatch is yours alone: no one else's session advances it.
- **Maturity** needs active time ≥ max(7 min, 10% of lifespan) **and** biomass ≥ 60% of the creature's maximum (ADR 0029). The size bar fills toward the adult size with a tick at 60%, and the menu says "Size 62% of adult", with "Mature in 4:10" once the size is enough, and a soft ring each time the creature passes another tenth of its adult size (a wider one on entering a new size tier).
- **Old age** starts at 85% of lifespan (−20% thrust, so −20% top speed, and +20% basal metabolism; a dash is unaffected). Death comes at 100%. The client keeps the life clock between reports (the hub's last word plus the ticks played since), shows it as a thin **Life** bar with the stage word (Young, Mature, Old) and, in the last 10 minutes, "About N min left"; it turns the creature elder at 85% and, when its own clock reaches 100%, reports every 2 s until the authority ends the life. The authority has the last word.
- **Hatch limit**: the genesis bucket holds 3 hatches and refills one per 5 min. With it empty the death and title screens say "Next recorded hatch in m:ss", disable Hatch and offer the practice cell.
- **History**: the title screen lists the last 10 lives (species, how it ended, time lived, when), or "No creatures yet".
- **World renewal** (ADR 0040): rules 8 started the world again (every creature, record, commitment and mating deleted, every hatch bucket refilled; identities, keys, names, flags, beacons and ponds kept). The `world` row holds the epoch (2); protocol 6 keeps old clients out. An identity first seen before the reset hears once that the world was renewed (a glass toast on the title screen for 15 s), and History lists only the new epoch.
- **Mating** (ADR 0021; `RULES.mating`):
  - Both creatures must be in the same pond and mature (`matureAtMs`), have at least 50% of their maximum energy, have no pending offspring and no mating in flight, be out of cooldown, be within ±1 size tier and within 3 body lengths, and not be locked (M7). The authority checks everything except the distance: positions are peer-to-peer, so only the two clients check it.
  - **Consent**: A courts (E), the partner sees an invitation (name, species, rarity, size, inbreeding band) and accepts (E) within 15 s; the authority takes an accept up to 20 s after the court, which leaves 5 s for signing and transit. Esc or the timeout declines. A has one court outstanding at a time.
  - **Cost**: paid when the commitment is made, never refunded, no cancel: each parent loses 30% of current energy and 15% of biomass. `mate` is a life event that pays the cost in the sim.
  - **Cooldown**: 540 s (9 min) of active time (so a checkpoint's cooldown stays paused), doubled for each earlier mating of the same two players in the previous 24 h of wall time (`repeatWindowMs`), at most ×32.
  - Hatchling biomass is max(80, 10% of maximum) with energy 60% of its maximum energy; a checkpoint with under 120 s of life left is exhausted.
  - **Awaiting beacon**: after the commitment both players play on while the round (3–6 s) arrives; closing a tab changes nothing.
- **Pacing** (ADR 0022, ADR 0029; `npm run sim:pacing`, 12 genesis cells, a food-seeking solo bot that avoids toxin clouds and mates as soon as it may): the bot is a test aid, not a player model, and a real player will be slower (2 to 3 times as slow to grow), so read these as the fastest pace.
  Results: biomass doubles in a median 1.3 min (target within 4); 60% of adult size in 1.4 min (target within 10); hatch to first eligibility 8.6 min (target 7–10); mating to eligible again 9.0 min (the cooldown decides); 8 matings in a full life (min 7, max 10; target 4–9); 6.2 children per hour of active time; a pair's repeated matings at 1×, 2×, 4×, 8× (72 min), 16×, 32× the 9 min base.

- **Offspring**: two distinct children, one per player (seed slot 0 for the courting player's child, slot 1 for the accepter's; if slot 1 happens to equal slot 0 it takes the next slot until it differs), born when the committed drand round arrives (about 3–6 s; ADR 0010). Parent A is the courting player's creature and B the accepter's; the child's first haplotype is a gamete of A and its second a gamete of B.
  - Each player holds **one pending offspring** at most: an egg carried on a short tether behind the parent, glowing faintly by the child's rarity for its owner, with a card showing its body. Pond peers see a plain glowing egg (the snapshot's egg mark, set from the commitment on).
  - Hatchling biomass is max(80, 10% of the child's maximum), energy 60% of its maximum, full health, lifespan clock at zero.
  - Generation = max(parents' generations) + 1.
  - A pending child can only be left by promoting it: no discard (ADR 0021).
- **Promotion** (key H): becoming your pending offspring turns your current creature into an **inactive checkpoint**. It keeps its condition, cooldown and remaining lifespan, frozen. The egg cracks open beside where the parent was, the child grows out with a pop, and the parent dissolves over 1 s where it stood.
- **Death**: choose between your pending offspring (if any) and your **nearest surviving ancestor** along your checkpoint chain, which comes back with its saved condition, cooldown and remaining lifespan at the pond's spawn point. Dead and exhausted ancestors (under 2 min left) are skipped. If nothing survives, hatch a new genesis cell; the old lineage remains as history. Genesis is refused while any of your creatures is active, pending or a surviving checkpoint.
- **Kinship**: Malécot's coefficient of kinship on the birth records, six generations deep. A child's inbreeding is the kinship of its parents (full siblings 25%, first cousins about 6%). The card says none (under 3%), low (under 10%), moderate (under 20%) or high.
- **Genesis**: DNA from a committed future drand round (ADR 0010), recomputable by anyone from the commitment and the beacon (ADR 0019). At most one living creature per identity, and a bucket of 3 hatches that refills 1 per 5 minutes. An empty bucket shows a countdown, and the player may swim as an unrecorded practice cell. Genesis cells come from a narrow starter distribution (§6). Rare traits mostly arise through breeding.
- **Progress and resume**: while you play, the client reports your condition (biomass, energy, health) after the first 5 s, then every 30 s. The authority clamps and flags implausible values, keeps the latest in memory, and writes a checkpoint when you disconnect, every 15 min of active time and at death. Coming back resumes the same creature at the pond's spawn point with that condition; a reload rewinds at most 30 s and never refills lifespan or the hatch bucket.
- **Recovery code**: a 55-character code (Crockford base32, groups of 5, checksummed) shows your identity's key on request. Importing it replaces the identity of that browser.

## 6. Genetics and development (ADR 0006)

**Karyotype v2** (ADR 0025; `src/genome/karyotype.ts` is the source of truth; the only karyotype, ADR 0040). Diploid, 6 chromosomes. Each haplotype starts with 164 bytes of base loci; this table mirrors the code:

| Chr | Theme | Loci |
|-----|-------|------|
| 1 | Body plan | segmentation drive (quant ×2 → 1–8 segments), aspect, taper, flexibility, max size (quant ×3 → max biomass), load L1 (membrane integrity) |
| 2 | Integument | membrane thickness, translucency, plating (quant ×2), spines, iridescence (mendel: plain dominant, iridescent recessive), texture (mendel, incomplete: smooth ↔ grainy blend), load L2 |
| 3 | Locomotion | module slots M1–M4, gait amplitude, gait frequency, load L3 (beat strength) |
| 4 | Feeding and weapons | mouth size, mouth type (filter ↔ jaw), digestion efficiency, module slots M5–M6 |
| 5 | Senses and behaviour | module slots M7–M8, aggression, caution, curiosity, reflex, target preference (mendel: nearest, weakest, largest) |
| 6 | Pigment and physiology | hue (quant ×3), saturation, value, pattern (mendel: none < rings < spots ≡ stripes; equal ranks show both), pattern scale, albino (mendel recessive), luminescence (mendel: on dominant), luminescence hue, lifespan, metabolism, growth, UV tolerance, pressure tolerance, load L4 (metabolic) |

After the base loci each haplotype appends 59 bytes: 223 bytes per haplotype, 446 per genome (haplotype A then B). Every appended locus reads 0 as off.

| Bytes (per haplotype) | Chr | Loci (all quant, each mapped onto 0–1) |
|-----------------------|-----|----------------------------------------|
| 164–174 | 1 (after its base loci) | spine curve amount, curve mode (C ↔ S; coil at the top of the amount), head scale, trunk swell, tail length, tail taper, fusion, symmetry (bilateral ↔ radial), drape, eye size, eye stalk |
| 175–222 | the slot's own | per module slot M1–M8, 6 bytes each: webbing, setae density, setae length, bulb, chela, beads |

- **Lengths**: every genome is 446 bytes (595 base64url characters). Any byte string decodes, zero-padded or truncated, and the Lab's paste box takes only 595 characters. Genesis and birth records keep `karyotype: 2`.
- **One live rules version** (rules 8, ADR 0040): older versions are retired with their code and goldens (no frozen versions before v1.0). `checkGenesis`, `checkBirth` and `checkStored` answer `rules-retired` for a record of rules below 8; `genesisFor` and `offspringPair` always build under the live rules.
- **Encoding**: one byte per locus, in chromosome order, haplotype A then B; a module slot is 15 bytes plus its 6-byte extension in the appended block. Any byte string decodes: short input is zero-padded, extra bytes are ignored, a `mendel` byte wraps into its table (`byte mod size`), a `load` byte keeps its low bit (1 = loss of function), and a module's presence is its low bit with all parameters zeroed when absent. Every `mendel` table ends with a novel allele that genesis never produces. The genome hash is SHA-256 of `bs/genome/v1\n` and the canonical bytes.
- **Module genes** (8 slots): a presence flag plus 14 parameters — length, thickness, taper, curvature, joints (1–4), branching (0–2), tip shape, stiffness, beat, phase, attach start, attach span, angle, pairs (1–3 per side). Tip shape is a continuum: blunt → point → hook → paddle → whip. Duplication copies a module into an empty slot; the copies then diverge.
- **Genesis distribution**:
  - Segmentation alleles are low (exactly 1 segment: a single cell). Slot M1 holds a whip-like flagellum, and slot M2 is present half the time (a ciliary band).
  - Maximum size gives 300–900 biomass.
  - Rare alleles: iridescent (allele frequency 5%), albino (4%), stripes (10%), each load allele (3%).
  - The base cell (`baseCell` in `src/genome/genesis.ts`, `GENESIS_FREQ`) draws every trait from its own `genesis` PRNG stream. Hue is uniform, other colour traits and the membrane are wide, armour and spines stay low, and sizes lean small. Alleles are drawn per haplotype: luminescent 30%, pattern none/rings/spots/stripes 40/20/30/10%, grainy 50%, plus the rare ones above, so a recessive shows in about 1 cell in 400 (iridescent) or 600 (albino). A ciliary band is added to half of the cells. The median top speed is about 1.1× the starter cell's.
  - Larval forms (`src/genome/genesis.ts`; ADR 0025): the base cell is given one of six forms from its own `genesis-form` PRNG stream: plain cell 35%, ciliate 15% (three pairs of cilia), spiny larva 17% (symmetry 0.6–1, stiff spines ring the core; a spoke keeps no bristles), bell 10% (radial, rearward drape), tadpole 15% (a thick, long tail) and fan tail 8% (the tadpole with webbing). Eyes (a pair, 12%) are drawn independently, and each slot other than the whip is bristled with a 70% chance (`GENESIS_BRISTLES`). Every form is one body unit with at most three module slots and no coil, carapace or chela. Multi-segment forms arise through breeding and mutation.
- **Expression** (`RULES.genes`, `src/genome/express.ts`): a quantitative trait is the mean of both alleles over its loci, mapped linearly onto its range. Plating and hue are sums of two and three loci; segments are the two drive loci mapped onto 1–8. Ranges: aspect 0.8–2.4, taper 0–0.8, mouth size 0.2–1, digestion 0.7–1.2, gait frequency 0.5–2, saturation 0.3–1, value 0.35–1, lifespan 0.6–1.6, metabolism and growth 0.7–1.4, everything else 0–1. Complete dominance shows the higher-ranked allele (equal ranks show both); incomplete dominance blends the ranks. A module is expressed when present in either haplotype, and parameters present in both average, rounding half up (extensions likewise, onto 0–1; `RULES.genes.range.part`, `.shape`). A load locus matters only when homozygous: membrane integrity ×0.6 (L1), the malformed-part scale ×0.6 (L2), beat strength ×0.7 (L3), metabolism cost ×1.3 (L4).
- **Max size**: `maxBiomass = 300 · 2^(13·t)`, with `t` the mean of three quant loci scaled to 0–1 (genesis 300–900; the top is about tier 3). Growth stops there.
- **Mouth and feeding**: the mouth type runs from 0 (filter) to 1 (jaw). Efficiency by food kind, linear between anchors:

| Mouth type | Detritus | Globule | Crystal |
|------------|----------|---------|---------|
| 0 (filter) | 1.0 | 0.6 | 0 |
| 0.5 | 0.8 | 1.0 | 0.6 |
| 1 (jaw) | 0.4 | 0.8 | 1.0 |

  Filter mouths are wide and sit on the body (large `radius`, small `offset`); jaws are small and reach ahead (small `radius`, large `offset`, narrow arc). Digestion multiplies every yield.
- **Colliders**: up to 12 circles in the body frame, in units of the core radius `r = √b`, the first always the core at the origin with radius 1. They give toxin exposure and creature hit shapes. Creatures pass through each other until M7.
- **Body limits** (`RULES.body`, enforced on every body entering the sim): thrust, drag, turn, basal and growth multipliers 0.1–4; max biomass 100–2,457,600; 1–12 collision circles of radius 0.05–1.5 whose far edge stays within 2.5 core radii; mouth radius 0.05–3, half-arc 0.05–π, digestion 0.1–1.5.
- **Development caps**: 8 segments, 24 appendages, 4 joints, 1 branch level (≤2 branches), 12 collision circles, bounds ≤2.5× core radius (vertices are the renderer's, §12). Repair guarantees a propulsion source and a mouth.
- **Development** (`RULES.develop`, `src/genome/develop.ts` and its stage modules): `develop(traits)` builds the plan in core radii and repairs it, in this order:
  - Segments are ellipses along the spine (core first, the rest behind it), each with a centre `y` and a heading `angle`; half-length = radius × aspect ÷ 1.6 within 0.6–1.2; taper shrinks the rear radius by up to 60%. The chain's layout and reach follow **Proportions** below. Symmetry rounds every segment toward an aspect of 1, all along its range.
  - Each present module becomes `pairs` (1–3) left parts, mirrored right. A part leaves the segment at attach start/span (front to rear, mapped to segment indices) at an angle of 0.2–2.94 rad from the heading. Length 0.1–1.5 (up to 2.4, see **Long parts**), base width 0.04–0.4 (drawn thinner on a slim segment, see **Thin legs**), joints 1–4, branches 0–2 (each 0.5× its parent; see **Shapes that read as tissue** for which parts keep one), taper 0.6–0.9 (the tip is at most 40% of the root), curvature 0.15–1 (always backward). The first present module is the malformed part under L2: its length and width are ×0.6, below those ranges.
  - Parts on one segment and side keep 0.3 rad apart: later ones are pushed round the outline, and one that no longer fits merges into its neighbour (the survivor thickens and keeps the stronger beat). Lengths shrink so the root plus the reach (branches ×1.6) stays within 2.45 core radii.
  - Parts beyond 12 per side (24 instances) are dropped from the end of the list (fringe first, then module order, then pair). If motile area (length × girth × beat × (1 + 0.25·branches), parts with beat ≥ 0.1; a mirrored pair counts as 1.95 of its left instance, since its right one may be 5% shorter) is below 0.06, a default ciliary band (two pairs, whip tips) is added on the rearmost segment with room; only when no segment has room are the last parts dropped until it fits.
  - The mouth: radius = size × (1.5 − type); a type above 0.5 moves it forward (offset up to 0.6) and narrows its arc to 0.2π. Plating gives every segment plates of coverage = plating, thickness 0.03–0.2. Colliders: the core, one per further segment, then the biggest left-right pairs (length × width) while two circles still fit under 12; parts too thin for a circle of the minimum radius 0.05 (width below 0.1: cilia, whips) get none.
  - **Tagmata**, along the chain behind the head (t = i ÷ (segments − 1)): trunk swell widens it by up to 60% at t = 0.4 (falling to 0 at ±0.6); the rear half is the tail, where tail length stretches the half-length by up to 80% and tail taper narrows the radius by up to 70% at the tip. Head scale shrinks the chain behind the head by 1 ÷ (1 + 0.8·head scale). A long chain uses the trunk profile of **One body** instead.
  - **Spine curve** (ADR 0038; `RULES.develop.curve`): the links turn with the spine's tangent, from 0 at the core to the total turn at the tail. C mode (curve mode < 0.5): total turn = curve × π. S mode: two opposite arcs, each 1.25 × curve × π (at most 0.8π) on a chain of 5 or more segments, curve × π ÷ 2 on a shorter one. Above curve 0.8 a chain **coils** when its genes give 5 or more segments and it shows at most 2 leg pairs (ADR 0041; any other chain takes the C-curl): a chambered logarithmic spiral of 8 segments turning 2.5π just past 0.8 and 2.7π at curve 1, each link 0.38^(its turn ÷ 2π) of the one before, reaching 2.2 core radii. A leg shows on the coil's outer side only (its inner twin is fringe). A curled chain's segments grow by up to 1.6 until it reaches as far as the straight chain did; non-neighbours stay at least 0.1 of their summed radii apart, and a single cell never curls.
  - **Fusion**: the front round(fusion × segments) segments get one carapace, an ellipse along the axis from the rearmost fused centre to the core that holds 16 outline points of every fused segment and overhangs them by 0.25 of the widest fused half-width (kept within 2.45 core radii). Their colliders move onto the shell's axis; their plates are replaced by the shell, thickness 0.08 + (0.2 − 0.08) × plating. The body loses 80% × fused share of its flexibility.
  - **Symmetry**: at 0.5 and above the parts ring the core: at most 8 pairs, left angles π(2k + 1) ÷ (2 × pairs). The first 4 module parts are spokes (repeated to at least 3 pairs, 5–9 spokes, each 1 ± 0.3 as long by a hash); the rest are fringe set between them; a ring that cannot swim gets the ciliary band among its fringe. A radial mouth is central. **Drape** bends growth rearward: bilateral parts sweep 0.3 + 0.6 × drape of the way to the tail, radial ones 0.45 × drape, each growing no further forward than the one before.
  - **Eyes**: eye size above 0.15 gives a pair on the head at ±0.6 rad, radius 0.08–0.3, on a stalk of 0–0.6, kept inside the bounds. A short stalk sets the eye into the head (`eyes.set`, ADR 0037): 1 × (1 − stalk ÷ 0.6) of its diameter lies inside the head's outline. The pair never overlaps.
  - **Parts by region** (ADR 0041; `RULES.develop.organism`, `src/genome/organism.ts`): a bilateral part is read by where its root lies along the spine (front 0, tail end 1) and its angle: **head** (front 0.2, within 70° of the heading), **rear** (last 0.2) or **trunk**. On the head the longest pair is the long antennae (at most 2.2 body lengths) and the next the short (0.6); on the trunk the front 6 pairs are legs (at most 0.9 body widths, swept back 25–70°); on the rear the longest pair is the tail structure (1.5 body lengths). The body shows at most 14 instances (tail, long antennae, short antennae, then legs from the front); every other part becomes **fringe**: cilia at most 0.3 body widths long, 0.04 wide, beating as the band does (0.8), no branches or detail, counted by the stats like any part.
  - **Fine parts** (`RULES.develop.detail`; detail on parts, never parts):
    - **Shapes that read as tissue** (ADR 0041; `asTissue`, `oneBulb` and `jittered` in `src/genome/develop-organize.ts`, `RULES.develop.organism.{branches,jitter}`): every part tapers (taper 0.6–0.9; the band and fringe 0.6) and bends backward (curvature at least 0.15): legs and tails curve toward the tail and antennae outward and back, and the right mirrors it. Only antennae (biramous) and tails keep a branch, one at most, half as long as the part and fanned 0.5 rad back; every other part, spokes included, takes the area of the branches it gives up as girth (at most 0.4). One pair at most keeps a bulb, and only where the bulb gene exceeds 0.6. Mirrored pairs differ by a hash of the pair's place and genes: the right instance grows up to 6° either way and 5% longer or shorter (kept to a leg's sweep and its role's length; a jitter the bounds cannot hold is halved, then dropped, and its bristles shorten to the bounds), and beats 0.04–0.12 of a cycle after the left.
    - **Webbing** (0–1) is how far along its rays a part's sheet reaches: a membrane from its fork (0.7 of its length, its branch fanned 0.5 rad back) to its branch, and a quad to the next part rearward on the same side when their roots lie within 1.6 core radii (`webSpan`); the rearmost left part spans to its own mirror: a tail fan. Membranes are convex counter-clockwise polygons inside the bounds.
    - **Setae** (legs, antennae and tails only): density gives round(density × 12) bristles per part, each setae length × girth × 3 long, shortened so every bristle stays in the bounds. The body keeps 120; the excess comes off the shortest parts first, in mirror pairs.
    - **Bulb** above 0.6 tips the part (one pair at most: the largest bead) with a bead of radius bulb × girth × 2. **Beads** (0–1) swell each joint to (1 + beads) × the part's radius. **Chela** above 0.5 on a pointed or hooked tip makes the last joint opposable.
  - **Proportions** (ADR 0028; `RULES.develop.{chain,fit,part}`): the trunk carries the body, and parts keep their gene length where they can.
    - A two-segment chain has a head of 0.65 of the single cell's head (the half-length never below 0.6), round and whole as symmetry rises; a single cell keeps its own head. A longer bilateral chain sizes its head by its trunk (**One body**). The core collider stays the unit circle of radius 1.
    - The segments behind the head are 0.8 core radii wide along the tagma profile and fit a reach of 2.1 (a radial body's is the head's half-length, so a bell keeps its chain inside its core) by shortening to as little as 0.25 of their width, and only then narrowing. Neighbours sit 0.8 of their summed half-lengths apart.
    - Parts fit by their drawn reach: the centre line is an arc that turns 1.2 × curvature, then a straight tip cap of (0.3 + 2.2 × tip) end half-widths, at most 0.3 of its length. A part that would leave the bounds sweeps toward the core along the body, by at most 1.6 rad, the least sweep that fits; a rear-segment part growing rearward turns no further forward than sideways. A part that still does not fit is cut so that root plus reach stays inside.
    - **Thin legs** (ADR 0039): a part's drawn width is its gene's × min(1, 0.5 × its root segment's drawn half-width ÷ 0.4), but no thinner than 0.07; its `girth` stays the gene's width and is what the stats read. **Off the body** (`RULES.develop.keep`): a part more than 0.2 inside the body outline turns away from it (0.15 rad steps, up to 1.5 rad).
    - **Long bodies** (ADR 0031): a bilateral chain of 3 or more segments is at least 2.5 times as long as wide along its spine; a wider one narrows by one factor (`form.slim`), laterally compressed (1 ÷ slim as deep), and mass, plates and the frontal width read its girth. The length gene keeps 0.1–1.5 up to 0.8 of its span, then reaches 2.4 (`RULES.develop.long`).
    - **One body** (ADR 0037; `RULES.develop.chain.trunk`): a bilateral chain of 3 or more segments is widest at the trunk.
      - Behind the head the width rises by 0.25 to its peak at t = 0.35 (trunk swell adds up to 60%, falling to 0 at ±0.6), then drops by 0.15 plus 0.6 × taper to the tail (tail taper: up to 70% at the tip); the trunk is 0.88 core radii wide and fits a reach of 2.2. The head is 0.6 to 0.86 of the widest trunk segment's half-width. Behind a carapace of 2 or more segments the free tail narrows to at most 0.45 of the widest fused segment. A **worm** (5 or more segments, no carapace, curve ≥ 0.35 short of a coil) is slimmed to 4.2 times as long as wide.
- **Stats** (`RULES.stats`, `src/genome/stats.ts`): `computeStats(plan, traits)` gives the adult numbers (at the maximum biomass; `statsAt` takes any size). Multipliers are relative to the reference cell (`starterGenome`: one round cell, one whip, all-round mouth), which reproduces `STARTER_PHYS`. The sim sees the adult value for the whole life.
  - Thrust: Σ over motile instances of length × girth × beat × (1 + branches·0.25) × efficiency × beat load × (0.7 + 0.3·gait amplitude), divided by mass. A tip's efficiency is 0.25 plus its whip share × (size ÷ 16,384)^−0.25 plus its paddle share × (size ÷ 16,384)^0.25 (the paddle share peaks at tip 0.75, the whip share rises to tip 1). The top speed (thrust ÷ drag) then passes through the speed band of §4.
  - Drag: 2 × widest radius (at least the core's 1) × (1 + 0.6 ÷ fineness) × (1 − 0.2·rear taper), plus 0.25 × Σ girth × (1 + length) × (1 + 0.5·branches), 0.3 × plate area and 0.1 × spines × width. Mass: body area × (1 + 0.1·spines) + appendage area + 4 × plate area.
  - Turning: (1 + 0.5·flexibility + Σ part thrust × distance from the centre) ÷ moment of inertia.
  - Weapons: pointed to hooked tips (peak at tip 0.375) × stiffness × length, plus the bite of a jaw mouth (0.5 × jaw share × mouth size); reach is the farthest tip, arc the widest weapon angle. Armour is plate coverage × thickness against the thickest plate, area-weighted. Detection ring: 1 + 0.5 × Σ length × forwardness × slenderness (1 − girth ÷ 0.4) × (1 − beat). Glow is 1 for luminescent, 0.5 for pulse.
  - Basal: the formula under Costs × the metabolism trait × the metabolic load, relative to the reference.
  - A curl shortens and widens the outline (more drag, lower inertia); the carapace weighs like a plate and covers its fused segments for armour. A radial ring drives forward only with its rearward share ((1 − cos dir) ÷ 2) × 0.7, and all its steering is ×1.6. Each eye adds 1.5 × radius × (1 + stalk) to the detection ring and 0.3 × radius to the basal sum.
  - Fine parts (`RULES.stats.v2.{web,setae,bulb,chela,beads}`): a membrane on a beating part adds area × beat × (size ÷ 16,384)^0.5 to the thrust (weak when small, strongest when big) and 0.5 × area to drag and mass. Setae add 0.016 × fringe drag, and a share min(1, fringe ÷ 7.5) adds up to 1 to the detection ring. A bulb adds 1.5 × radius to the spine share (capped at 1, contact damage); a chela adds 1.5 × chela × stiffness × its last joint's length to weapon power.
- **Inheritance** (`RULES.genetics`, `src/genome/inherit.ts`): the child is a gamete of parent A (first haplotype) plus a gamete of parent B (second), from `offspringSeed` = SHA-256 of `bs/offspring/v1`, the beacon randomness, the commit id and the slot byte, read as four big-endian words.
  - Meiosis, per chromosome: a random starting haplotype, then 0, 1 or 2 crossovers (40 / 40 / 20%), each at a uniformly chosen boundary between loci, so neighbours rarely separate and chromosomes assort independently. A module slot moves as one locus, with its extension. The shape loci are loci of chromosome 1 after its base loci, so they are linked to it.
  - Mutation, per gamete: three trials, each firing with 15% × the mutation factor (the Lab's ×4 gives 60%), each picking a kind by weight: quant step 30 (moves a byte by 1–24), allele change 14 (within the genesis alleles), load flip 10, parameter drift 20, module duplication 8 (into an empty slot, extension included), module deletion 8, novel allele 10. A kind with no target does nothing.
  - Streams `meiosis-a`, `meiosis-b`, `mutation-a`, `mutation-b`;
- **Costs**: the basal multiplier is `1 + 0.1·(segments − 1) + 0.04·appendages + 0.2·plating + 0.1·luminescence + 0.3·Σ eye radius + 0.2·membrane area + 0.004·bristles + 0.02·bulbs + 0.03·Σ chela + 0.01·Σ beads`. Mass slows acceleration and turning, and appendages add drag. No build is best at everything; archetype tests enforce that over speed, acceleration, turning, efficiency, both foods, armour, weapons and the detection ring.
- **Rarity**:
  - Score = Σ −log2(genesis frequency) over expressed rare features.
  - Tiers: common < 4, uncommon 4–8, rare 8–14, exotic ≥ 14.
  - Features: iridescent, albino, stripes, spots, rings, luminescent, radial symmetry, webbing and eyes (priced from their exact genesis frequency; the form table makes radial 27%, webbing 8% and eyes 12%), and 12 bits each for extra segments, extra modules (beyond the whip and cilia), a novel allele, a max size of tier 1 and up (1,024 biomass), a coil, a carapace or a chela. About 70% of genesis cells stay common.
  - Each creature gets a deterministic species-like name: a genus from its genome hash (three syllables and a suffix) and an epithet from its strongest trait (for example "Dabelothrix natans"); shape traits name bodies too: *alata* (webbing), *spiralis* (a curve, a coil above all), *radiatus* (radial), *oculatus* (eyes), *setosus* (bristles).

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

- **Ponds**: up to 24 players, all connected to each other. A joiner goes to the fullest pond that isn't full. A pond's spawn centre is the world centre; a joiner takes the first free slot i of the pond and spawns on a ring around it at angle i × 2.399963 rad, 300 + 40 × i wu away (slot 0 is the centre), moved clear of plumes.
  - **Pond clock**: the hub's clock gives every pond tick (30 Hz from the pond's epoch), so food and plumes agree between players. Each browser simulates only its own creature; others are drawn from 10 Hz snapshots, 120 ms behind. A snapshot (25 bytes, version 3) carries flag bits for alive, dashing, ready to mate and carrying an egg; any other bit drops it. A silent player fades after 2 s and disappears after 6 s. A hidden tab freezes your cell (ADR 0016).
  - **Bodies**: a browser sends its genome (about 446 bytes) once to each peer when a link opens and again when it hatches a new body; snapshots carry a 2-byte reference to it (ADR 0018). Until a peer's genome arrives, it is drawn as a plain tinted cell.
  - **Offline**: if the hub can't be reached you play alone in a local pond and the status says so.
- **AoI and tiers (M11)**: connect only to creatures within ±1 tier inside the AoI (1.3 × the visible half-diagonal), plus boundary neighbours and duties. The default cap is 24, the hard cap 32 (ADR 0013).
- **Spawning and regrouping (M12)**:
  - Newcomers spawn on a ring around a compatible group, at least 3× the attack reach of larger creatures away and away from recent spawn points. The ring expands as the area fills.
  - After 120 s alone you may "ride the current" to a group.
  - Crowded spots split into bounded instances that never separate interacting creatures.
- **Admission**: past 200 concurrent sessions (`MAX_SESSIONS`) or 90% of the daily request budget (`DAILY_REQUEST_BUDGET`, 100,000), new players are queued with a position and an estimated wait (30 s per place until M13 measures it); a queued player can swim as a practice cell. The meter counts an upgrade as 1 request and an incoming message as 1/20, per UTC day, flushed to the `usage` table at most once a minute. A queued session is in no pond and may only ping or leave; seats go in arrival order the moment one frees, and every 15 s while anyone waits. Players who hold a seat are never dropped or re-queued; a second tab takes over its place in line.

## 9. Social

- **Chat**: up to 140 characters, 3 messages per 5 s per sender (receivers drop extras). Profanity is filtered with English and German lists after leetspeak normalisation. Messages show in a panel over the stat bars (bottom left) and as short bubbles above the creature. Display names are 3–16 characters from `A–Z a–z 0–9 _ -`, also filtered.
- **Players**: the menu lists the pond's other players; click a name to mute or unmute them (muting is local).
- **Emotes** (6, at most 1 per second): wave, happy, love, angry, scared, question.
- **Pings** (4, lasting 4 s, at most 1 per second): look, danger, food, mate.
- **Icons** (`src/game/icons.ts`): each ping and emote has its own original SVG icon, glowing line art titled for screen readers (look an eye, danger a warning triangle, food three globules, mate a twisted double strand; wave a raised hand, happy a smiling face, love a heart, angry a spiked face, scared a shivering face, question a speech bubble). Love and mate are pink, angry and danger amber, food green. While `T` waits for its number, a strip over the chat log shows the six emotes on 1–6.
- **The social wheel** (`src/game/wheel.ts`): `G` opens a ring of 10 items around the cursor, clockwise from the top: the pings on 1–4 and the emotes on 5–0. Holding `G` and releasing over an item sends it, as does a click or a number. Esc, a second `G`, a click in the centre or far outside, or releasing in the centre after holding `G` for 250 ms cancels. A ping lands on the world point the cursor showed when the wheel opened; an emote shows over your creature. While the wheel is open your creature keeps its steering and throttle, WASD still steers and Space still dashes. The middle button sends a quick look ping, and `T` then 1–6 within 3 s sends an emote.
- **Finding players** (`src/game/indicators.ts`, `src/game/pond-map.ts`): every pond player with no part on screen gets an arrow on the screen's edge (44 px in), with their name and the distance in your body lengths; the nearest 6 are shown. The arrow's shape gives their size by tier (an open chevron smaller, a solid head comparable, a doubled head bigger), and a heart and "ready" mark a player who could mate. A ping off screen within 2 view radii shows as a ring on the edge. The pond map (`M`, or a click on the minimap) shows the pond's bounds and depth zones, you, other players with names, and live pings.
- **The minimap** (`src/game/minimap.ts`): a round glass map in the top-right corner, 48 px from the top and 12 px from the side, 12% of the screen's short side and at least 120 px, north-up and centred on the player, 6 view half-heights in radius, showing the zones and the pond's edge when near. An arc down its right rim runs from the surface to the abyss floor in the four zones' colours, with a dot and an inward notch for the player's depth, and the zone's name sits under it. Players are marked by size class (an open ring smaller, a solid dot comparable, a dot inside a ring bigger) and a pink heart if they could mate. A live ping is a 6 px ring in its kind's colour and line pattern (look solid, danger dashed, food dotted, mate dash-dot) for 4 s. It draws on a 2D canvas at most 10 times a second.

## 10. Feedback (readability)

| Event | Visual | Audio |
|-------|--------|-------|
| Eat | pop and sparkle; energy bar pulse | soft bubble pop (0.16 s) |
| Damage | distinct hits (§ below): each flashes the body red and the health bar, jolts the body and kicks the camera; no edge vignette | dull hit: a falling thud with each hit |
| Low energy (<20%) | the energy bar turns amber and pulses | two soft heartbeats near 60 Hz, on dropping below 20% and every 3 s |
| Hazard near | hazard outline brightens | rumble (44 Hz tone under dark noise), once as a plume's edge comes within 2 body radii (again after 3), placed at the plume |
| UV or pressure | the damage hits, and a minimap icon | with a hit, UV a thin high sizzle, pressure a low falling squeeze, at most once a second |
| Dash | ripple | whoosh: noise sweeping up from 500 Hz to 2.4 kHz |
| Windup aimed at you (M7) | glow on the attacker's weapon | rising tick |
| Death | dissolve; death screen naming the cause | descending tone, 440 to 140 Hz (1.5 s), for every cause |
| Old age | a dashed life bar, the stage word, "Feeling old" toast at 85% of the lifespan | slow low swell (2 s) |
| Court, mate, hatch | bioluminescent dance; at the commitment the body shrinks with a pulse and the bars drain; egg crack | court a chime of two soft bells; mate a bright rising triad; hatch two dry cracks and a soft pop |
| Beacon reveal | the egg (below) | a rising stir (1.2 s); three high bells at the burst |
| Growth into a new tier | zoom-out swell | each tenth of the adult size a soft swell; a new tier a longer rising fifth |
| Ping, emote, chat | a ping mark, an emote over the creature, a chat bubble | ping a sonar blip and echo; emote a short rising chirp; a peer's chat line two small bubbles |

Never a silent death: every source of damage and every death cause has a cue.

Presentation timings (`FX` in `src/render/effects.ts`): eat pop 0.55 s, dash ripple 0.85 s, death dissolve 1.2 s before the death screen, mating cost shrink 0.7 s; each damage hit flashes the body red for 0.15 s, from at least 40% (plus 5% per hit point the hit carries).

Damage hits (`SHAKE` in `src/render/shake.ts`): while damage of any cause arrives it lands as distinct hits, at most one every 0.5 s of sim time (15 ticks), the first at once. Each hit kicks the camera 5 px, up to 8 px for 6 hp or more taken since the last hit, and knocks the body 0.15 of its radius the other way, the direction turning by the golden angle from hit to hit; both ease back to rest over 0.25 s, and between hits everything is still. Each hit also flashes the body and the health bar and plays the thud. Only the scene moves: the sim, the HUD and the DOM stay put. Reduce motion drops the kicks; the flash and the sound remain.

Size outlines (`OUTLINE` in `src/render/outlines.ts`): another creature at least one size tier bigger than you wears a broken amber ring of 8 dashes that pulses every 0.9 s; one a tier smaller a faint, still ring of 16 dots; a comparable one none. The mouth's disc is body glass; a small feature at the body's front (at most 35% of its widest width, sized by the mouth size gene) shows its kind: a filter mouth is a narrow funnel ringed by 5–9 fine cilia, a jaw a pair of short mandibles curving toward each other. Plates are denser, brighter glass.

Crispness: the canvas's backing store is its CSS size times the pixel ratio and is never scaled by CSS (adaptive resolution aside, §12); DOM text sits on whole pixels, and the HUD's icons are SVG, with no raster images.

The play screen: one round menu button in the top-left corner (or Esc) opens a panel with the numbers (species and rarity, biomass, energy, health, size toward adult and "Mature in", life stage and time left, mating readiness), Lineage, Settings, Controls and Players. Four thin bars sit in the bottom-left corner: health, energy, size toward adult (with a tick at the 60% maturity size) and life left. A round minimap sits in the top-right corner (§9). Chips for a carried egg, mate readiness, a practice cell or being offline appear beside the bars only while they apply. No other text stays on screen.

- **The shell** (`src/game/hud.ts`, `src/game/hud-menu.ts`): the menu button is a 44 px circle 12 px from the corner; the panel opens under it (18.5 rem wide), steering carries on under it. The bars are 132 px wide and 4 px thick, each a `meter` whose tooltip is its value. The HUD covers at most 6% of the screen. Chips are 22 px pills (an egg with `H`, a heart, a dashed "Not recorded", a slashed ring for offline).
- **Hints** (`src/game/hints.ts`): on a browser's first life, "Mouse or WASD to swim · Space to dash" shows for the first 8 s of play and "G wheel · M map · Enter chat" for 8 s after 30 s (`localStorage['bs.hints']` remembers it); the menu's Controls section lists every key.

The egg (`EGG` in `src/render/egg.ts`, `src/game/eggs.ts`, `src/game/reveal-card.ts`):
- **Waiting**: a genesis egg sits alone at the screen's centre (its half-height 0.26 of the view's), the title or death screen hidden; a mating egg hangs beside the parent. It drops into place over 0.4 s and rests, its light breathing at 0.2 Hz. A click (or Space during a genesis) gives one damped wobble (0.22 rad at 2.2 Hz).
- **Stirring**: only when the beacon has come, for 1.2 s (common), 1.4 s, 1.6 s or 1.8 s (exotic): three twitch bursts at 12 Hz swinging 0.06, 0.11 and 0.17 rad, each flashing the light harder; from the second burst the rarity's colour leaks into the tint. Play waits for the stir and the crack: a genesis's creature begins with the burst.
- **Crack and burst** by rarity (crack, burst, rings, burst light, shell shards, light rays): common 0.9 s, 0.6 s, 1, 0.35, 5, none; uncommon 1.2 s, 0.8 s, 2, 0.6, 6, none; rare 1.6 s, 1.0 s, 3, 0.9, 8, 6; exotic 2.1 s, 1.5 s, 5, 1.6, 10, 10, with the effects at 30% speed for the burst's first 0.9 s. A click or Enter while it stirs or cracks skips to the burst.
- **The result card**: once a genesis's burst has played out, a glass card slides in at the top centre with the preview, the species, the rarity in words with one to four stars in a frame of the rarity's colour, and the silhouette class. It goes after 3 s or on any click or key. After a mating, the offspring card has the same frame and stars.
- **Reduced motion**: no drop, wobble, lean or twitch; the light pulses and the shell breathes; the burst fades, with no shards flying.

Event sounds (`CUE_SOUNDS` in `src/audio/cues.ts`, `CUE_WATCH` in `src/game/sound-cues.ts`): each cue is a few enveloped sine or triangle tones and filtered seeded noise with a pinned length. A placed cue pans by its side of the screen, up to 0.85 at the edge, and falls off with distance d in half-screen widths as 1 / (1 + d²).

Sound (`src/audio/`, ADR 0014: procedural Web Audio, no files): one audio context, started on the first click or key press and suspended while the tab is hidden, through a master gain and a limiter (−6 dB, 20:1), with event voices capped at 4 per cue and 16 in all. The ambience (`AMBIENCE` in `src/audio/ambience.ts`) follows depth and cross-fades over 2 s: shallows an airy hiss (3.2 kHz), twilight a softer wash, the deep a dark wash (260 Hz) under a 73 Hz drone, the abyss a 130 Hz rumble, a 49 Hz drone and a 41 Hz throb at 0.4 Hz; about −35 dBFS at the default volume. Settings hold the volume (default 60), mute and Reduce motion (following `prefers-reduced-motion` until the player picks).

## 11. Supply control and anti-farming

- Survival costs (metabolism, hazards), finite lifespan, and maturity and cooldown gates on the authority clock.
- A genesis limit per identity (the hatch bucket); rarity mostly comes from breeding and survival.
- Mating costs, a same-partner cooldown that doubles, and inbreeding that expresses load alleles.
- The authority's progress clamps: a client's reload can undo at most 30 s of play, so a death is not an escape (audits come in M10).
- Kill-reward decay for repeated victims and new identities (M8); witness eligibility needs play history (M10). Many bot identities still mean more attempts, but none skips the time gates or upkeep.

## 12. Quality presets

| Preset | Pixel ratio | Post-processing | Particles | Budget (draw calls / triangles) |
|--------|-------------|-----------------|-----------|---------------------------------|
| Low | 1 | none (fake bokeh sprites only) | 30% | 80 / 150k |
| Medium (what Auto uses until it has benchmarked) | up to 1.5 | half-strength DOF, bloom, grade | 100% | 150 / 300k |
| High | up to 2 | full DOF, bloom, chromatic aberration, grain | 150% | 250 / 600k |

The post chain's render targets have a memory budget too, for a 1920×1080 drawing buffer: none on low, 48 MB on medium and 96 MB on high (`PRESETS[…].budget.targetBytes`). `npm run report:budget` writes each preset's draw calls, triangles and target memory in three scenes to `docs/perf/budget.md`; `m6-budget.spec.ts` asserts the same scenes and that 1,200 crowded frames leave the JS heap and the GPU resources level.

The default setting is Auto. Players pick Auto, Low, Medium or High in Settings; the choice is stored in the browser and `?quality=` overrides it for one visit. Auto picks a preset from a benchmark: 2 s of frames at medium (after 0.5 s of warm-up) behind the title screen, never during play. A 75th-percentile frame time up to 11 ms picks high, up to 20 ms medium, otherwise low; the result is stored per GPU (`bs.bench`). Adaptive resolution steps the render scale between 0.6 and 1 by 0.1: down when the 90th-percentile frame time over the last 2 s exceeds 1.25 × 16.7 ms, up when it has stayed below 0.8 × 16.7 ms for 5 s, each step followed by a fresh 2 s window. The HUD and the DOM are never scaled. Under test automation and with `?quality=` there is no benchmark and the scale stays at 1.

The post chain (`src/render/post/`) renders the scene into a half-float target (8-bit where half float cannot be rendered), then composites onto the canvas: a half-resolution dual-filter bloom (4 levels on medium, 5 on high), a grade (a teal lift in the shadows, a filmic shoulder above 0.78 rolling highlights off to a cool near-white, 237/249/255; `src/render/post/grade.ts`) and a vignette, plus film grain and radial chromatic aberration on high. Low renders straight to the canvas. On medium and high the backdrop also draws into a half-resolution copy, which the creatures' glass refracts.

Depth of field (ADR 0027): the camera focuses on the gameplay plane; only the particle layers lie off it (far bokeh at −0.82 camera heights, near bokeh at +0.375, marine snow within 0.2). Each speck draws its own circle of confusion, 24 px per camera height off focus (at a pixel ratio of 1), up to 6 px on medium and 12 px on high; on high bright discs get a chromatic fringe.

Creature meshes (ADR 0025; `src/render/creature-mesh.ts` and its modules): one merged geometry and one draw call per creature, cached by genome hash and level of detail. The level is the preset's (high 12,000 vertices, medium 6,000, low 1,500), or low for a body under 12 px in radius (back above 16 px). A body crossing a threshold builds its new level that frame and draws it from the next, so no frame is drawn without it. The body is a loft along a Catmull-Rom line through the segment centres with a thin glass shell over a carapace; parts are tapered tubes with joint beads, bulb tips and chela fingers; setae are ribbons, membranes double-sided sheets, eyes lens spheres. Each level steps down its own ladder of detail until the body fits: no part is ever dropped.

Inner anatomy (`src/render/anatomy.ts`, render data only): inside the hull a gut line runs along the spine (10% to 90%, 0.055 body scales wide, a stomach swelling to 2.4×); 3–14 glass chambers and oil droplets (3 + round(11 × (0.65 × size + 0.35 × metabolism))) sit at places seeded by the genome hash; one heart or ganglion spot; and eye pigment. Each level keeps at most 20% of its budget for organs. The organs keep to two related tones (`materialParams`, ADR 0043): the main colour, the hue gene at its saturation and at least 0.9 bright (an albino's the pink of blood), and a second tone turned toward amber by 0.04 turns at no saturation up to 0.06 at full, at another value (full brightness over a main colour at the floor, 0.1 darker than a brighter one). The heart, ganglion and eye pigment take the main colour, the oil droplets the second, and the chambers alternate in hash order (`Organ.second`). The heart, or the largest chamber or droplet without one, glows faintly toward its centre (`Organ.glow`), and a rare, exotic or luminous body's next largest one too: +6% luminance on a common body, 8% uncommon, 10% rare and 12% exotic, ×1.3 with the luminescence gene, pulsing with the pulse allele. Rarity raises the organs' saturation toward full (`ORGAN_RARITY.vivid`: 0, 0.2, 0.45, 0.8), never the spread of hues. An eye is a dark pupil with an iris in the main colour at full saturation over 0.45–0.82 of its radius, deeper toward the pupil, and one highlight. The luminescence gene's own hue lights only the water round the body.

Materials (`src/render/surface.ts`, the creature shader): the shell is glass, silvery pale blue (hue 0.58 at 4% saturation, plus the gene's tint capped at 15%; an albino's stays clear), with a fresnel rim, a backlight and a wet highlight from a key light to the upper left. On medium and high it bends the backdrop copy by its normal (up to 0.2 core radii); on low it is plain translucency. Pores, a cell texture, membrane veins and small flaws fade in from 6 to 10 px a feature on screen, and thin walls cross the body where two segments meet. No line or tube narrower than 1.5 px is drawn: the cell texture's and the vein network's walls, the gut, the setules and the limbs fade out from 1.5 to 0.75 px wide rather than breaking into dots. Every shader runs at high precision, and every vertex of a body has a unit normal, so no pixel turns NaN. The glass is pass 1's (ADR 0043): a faint core (0.15 + 0.3 × facing) and a soft fresnel rim (1 − facing to the power 2, 1.4 on a membranous body, at 1.8 × the rim colour, full strength over about the outermost 1.5 pixels), with no haze layer. Markings tint it at 0.2. Glints are star points over organs and joints, at least 0.18 core radii apart; `glintsFor(tier, iridescence)` gives their count: common 0–1, uncommon 1–3, rare 4–8, exotic 12–16. Their hot points are white, and on a rarer body most rays take one of the organs' two tones, as far as `vivid`.


Bristles and thin parts (ADR 0032, ADR 0034): bristles carry three pairs of setules (at 0.3, 0.55 and 0.8 along, angled 0.7 rad toward the tip); the stats count the bristles only. Limbs, membranes and setae are the body's glass, with pass 1's light along a limb's axis (0.3 × facing): a part under about 2 to 3 px wide on screen is all rim, a stroke as bright as the body's edge, and a wider one is glass whose outer 1.5 px carry the full rim, as the body's do. Setae draw at 60% of the rim's peak at 0.7 density, setules at 30%, and fringe is fine cilia at 35% density, no brighter than 55% of the rim. The gallery is in `docs/art/gallery/`.

No white clipping (ADR 0034, 0043): each fine part's light is capped after everything that lights it at the body rim's peak luminance (setae at 60% of it, setules 30%, fringe 55%), and the grade rolls off to a cool near-white below 245 except at a glint's hot point. Every body has at most 12 solid-white pixels (`m6b-clip.spec.ts`).

## Glossary

- **Active creature**: the one creature a player currently plays. **Checkpoint**: an inactive former creature, paused with its condition and remaining lifespan; a fallback after death. **Pending offspring**: a born child not yet promoted (at most one per player).
- **Genesis**: a creature hatched from fresh DNA, the root of a lineage. **Lineage**: the ancestry graph (both parents) and the player's checkpoint chain through it. **Head**: the one accepted current record of a creature (ADR 0009).
- **Encounter**: a locked, refereed fight between 2–4 creatures (ADR 0011). **Witness**: a drand-selected peer that referees or audits an event (ADR 0012).
- **Pond**: a bounded group of up to 24 players. **Habitat**: the authority's grouping of players into connected P2P neighbourhoods (M11). **Tier**: a size band, ×4 in radius per step.
