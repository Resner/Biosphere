# Game design reference

The living description of how Biosphere plays, with **initial values** for rules version 5. The brief (`docs/BRIEF.md`) is the intent and the ADRs are the lasting decisions; this file explains mechanics in one place so every milestone builds the same game.

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
- **Hatching (M1)**: from M4 with a hub, the body is the genesis creature the authority records: the player waits 3 to 6 s ("Awaiting beacon") for a drand round, and the client recomputes the DNA before the cell appears; a saved creature is resumed instead. Without a hub, with an empty hatch bucket or with `?genome=` pinning a body for tests, the cell is an unrecorded practice cell ("Not recorded" badge) with a browser-local random body. A new cell appears at the world centre, or at the nearest point at least 120 wu clear of any toxic plume, now and at every second of the next 10 s of drift (`RULES.spawn.lookaheadTicks`, `lookaheadStride`), so nobody is born poisoned.
- **Depth zones (M6)** come from a deterministic bathymetry field of the pond seed (`src/sim/bathymetry.ts`, `RULES.bathymetry`): depth 0 (surface) to 1 (abyss floor) from three octaves of smooth value noise (wavelengths 2,048, 1,024 and 512 wu) plus a slope towards one side of the pond. The field is calibrated once per seed so every pond has the same shares of the world: shallows (depth below 0.25) about 25%, twilight (to 0.55) about 35%, deep (to 0.8) about 25%, abyss about 10%. A disc of 1,400 wu around the world centre, which holds the whole spawn ring (300 + 40 × 23 = 1,220 wu), is always twilight, and the nearest shallows and nearest deep are each within 2,200 wu of it.

| Zone | Light | Food | Hazard | Adaptation that helps |
|------|-------|------|--------|-----------------------|
| Sunlit shallows | bright caustics, god rays | detritus 55, globules 45 | UV (2 hp/s × (1 − UV tolerance)) | pigment, UV tolerance |
| Twilight | dimmer, blue | detritus 62, globules 38 | — | balanced builds |
| Deep | dark; bioluminescence dominates | detritus 90, crystals 10; within 300 wu of a vent detritus 60, crystals 40 | toxic plumes around vents; pressure ramps in from depth 0.7 | luminescence, senses |
| Abyss | near black | detritus 40, crystals 60; within 300 wu of a vent detritus 20, crystals 80 | pressure (3 hp/s × (1 − pressure tolerance)) | pressure tolerance, armour |

  UV ramps in over 0.02 of depth (about 64 wu) below the shallows' edge; pressure ramps linearly from depth 0.7 to 0.8, the abyss' edge. Both are measured at the creature's centre. The weights are per food kind (detritus, globule, crystal) of a slot, by the zone at its anchor. UV and pressure follow the world's `hazards` option, like plumes.

- **Zones on screen (M6 T16, `src/render/zones.ts`)**: the water takes its colour, brightness and fog from a 256 × 256 depth map of the pond (32 wu a texel, linearly filtered), the zones blending over ±0.03 of depth at each edge: bright cyan-green shallows, blue twilight (the dark teal-blue of reference-01 around the spawn), blue-black deep and a near-black abyss. In the deep and the abyss the player sees clearly within its detection ring (`sense` core radii, at least 2.5); by twice that the water, food and other bodies fade into the zone's fog (deep 50%, abyss 75%), but a body always keeps its rim, so nobody who can still affect you is hidden. A luminescent creature lights a pool 6 core radii wide in its glow colour that also clears the fog (8 glows at most are drawn: the player's first), and vent crystals glow by themselves in dark water. Marine snow dims to 60% in the deep and 35% in the abyss. The HUD shows a depth gauge (zone name, a depth bar, and "UV burns" or "Pressure crushes" while that hazard hurts the player), and a violet UV shimmer or a dark, squeezing pressure vignette covers the view at the same time.

- **Sunlight and marine snow (M6 T17; `sunlight` in `src/render/zones.ts`, `shaders/caustics.glsl`, `shaders/godrays.glsl`)**: sunlight is full in the shallows and fades through the twilight to a quarter by its floor; the deep and the abyss have none. Caustics are bright, moving filaments (a folded-sine pattern 18 wu across, in world space) on the water, projected straight down over every body as well (strength 1.4 in the shallows, 1 at the top of the twilight). God rays are slow shafts slanting from a fixed light to the upper left (strength 1 in the shallows, 0.8 at the top of the twilight), drawn in the post composite, so low has none. Marine snow lies in three layers: far bokeh below the plane, snow within 0.2 camera heights of it and near bokeh above it (290, 2,500 and 60 specks at 100%; a preset draws its share). It drifts slowly by itself and is carried by the currents at the camera; on high 3% of the snow are bright specks, 1.6× larger and 5× brighter, which bloom and take the depth of field's fringe.

- **Currents**: a smooth, divergence-free velocity field (max 12 wu/s, spatial period about 2,048 wu, slowly changing with a period of about 120 s; M1: three shear waves) carries creatures on top of their own velocity (a passive creature drifts exactly with the water) and moves plumes. Food only bobs in M1: it does not drift.
- **Food is nonliving** (ADR 0014):

| Food | Value (energy) | Radius (wu) | Where |
|------|----------------|-------------|-------|
| Detritus | 8 | 1.5 | everywhere; filter feeders also absorb it passively (M3) |
| Nutrient globule | 25 | 3 | shallows and twilight |
| Vent crystal | 60 | 2.5 | deep and abyss, richest near vents and plumes (risk for reward) |
| Carrion | share of a dead creature's biomass (M7) | scales with victim | where a creature died |

- Food sits on a grid of 256 wu cells with 10 slots each. A slot's item type is weighted by the zone at its anchor (table above). After an item is eaten the slot stays empty for 20–60 s (hash-determined), then shows the slot's next item at a new position. Items bob within 12 wu of their anchor (a sine per axis, period 4–8 s) (M1: they do not drift with currents). A creature eats an item when it overlaps the creature's **mouth disc** (distance below the mouth radius plus the item's) unless its energy is at the maximum; then the item stays (M2). The mouth disc is centred `offset·r` ahead of the centre with radius `radius·r`, and the item must lie within the mouth's arc; a starter cell's mouth is its whole body (offset 0, radius 1, full arc), as in M1. The yield is `value × efficiency(kind, mouth type) × digestion`, and an item with efficiency 0 is left alone (M3, §6). In a pond, two players reaching the same item are settled by the lower claim tick, then the lower id; the loser gives the energy back (ADR 0016). A claim or consumed entry outside 900 ticks (30 s) of the local pond clock, or for a cycle the slot cannot have reached (each cycle takes at least 600 ticks), is ignored and counted. A peer link that was up and dropped is re-called by the lower id, up to 5 times with a doubling wait (3 s first).
- Each tier has food sized for it (M11). Tiny items are noise to giants, so larger tiers feed on denser drifts, vent beds and carrion, and big filter-feeding mouths sweep detritus in bulk.
- **Hazards are nonliving**:
  - toxic plumes: radius 60–160 wu, 15 hp/s × the creature's exposure (overlapping plumes don't stack). A plume rises from a vent: about one per 9 food cells in the deep and the abyss, at least 1,800 wu from the spawn centre (M6; none in the shallows or twilight, so at least 80% of plumes, drift included, lie in deep water). Exposure (M3) is the share of the body's collider area whose centre lies inside a plume (§6), so a single cell is 0 or 1 as in M1 and a long body can trail a hand into the edge. Each grid cell anchors at most one plume, which drifts at half the local current (bounded, periodic with the currents);
  - currents (above);
  - UV and pressure (M6, the zone table above): a creature's `uvTolerance` and `pressureTolerance` (0–1, from its physiology genes) are part of its body stats and of the state hash.

## 3. Controls and camera

| Action | Mouse | Keyboard |
|--------|-------|----------|
| Steer | cursor direction; distance from the creature sets throttle (dead zone within 0.5 r, linear ramp to full throttle at 3 r) | WASD (overrides the mouse while held) |
| Dash | — | Space (cooldown 2.5 s) |
| Court or accept (M5) | click the creature, then the button | E on the nearest eligible creature |
| Become your offspring (M5) | the Offspring card button | H |
| Attack (M7) | click a creature in range | F on the nearest target |
| Stance (M7, in combat) | HUD buttons | 1 aggressive, 2 balanced, 3 evasive |
| Target (M7, 3+ participants) | click | Tab cycles |
| Brace (M7, in combat) | right button | Shift |
| Chat, emote, ping (M2) | ping: middle button | Enter, T then 1–6, G |
| Pond map (M6) | — | M (M or Esc closes it; steering carries on under it) |
| Menu | — | Esc |

- **Camera**: top-down perspective, following the creature. The visible half-height is `9 · R^0.9 · (r / R)^0.6` wu (M6 T18, ADR 0029), where `r` is the creature's radius and `R` the radius at its genetic maximum biomass. An adult sees `9 · R^0.9` (about 134 wu for the starter, whose `R` is 20), and a smaller creature sees less, so tripling the radius makes it 3^0.4 ≈ 1.55× larger on screen and growth shows within one life. A hatchling never sees fewer body lengths than the old `9 · r^0.9` curve gave. Zoom changes are smoothed over about 1 s.

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

## 5. Lifecycle and lineage (M4–M5)

- **Lifespan** (M4, ADR 0019): 75 min of active time, scaled ×0.6–1.6 by the lifespan gene (45–120 min). Active time is accrued by the authority from your progress reports as `min(ticks played ÷ 30, real time passed + 2 s)`, so a hidden tab, an offline player and a checkpoint accrue nothing, and nobody ages faster than real time. It also counts while the creature is locked in a committed encounter (M8). A creature you hatch is yours alone: no one else's session advances it.
- **Maturity** needs active time ≥ max(7 min, 10% of lifespan) **and** biomass ≥ 60% of the creature's maximum (M6 T18, ADR 0029; before, 12 min and 20%). The HUD shows "Size 62% of adult" under the biomass, with "Mature in 4:10" once the size is enough, and a soft ring each time the creature passes another tenth of its adult size (a wider one on entering a new size tier).
- **Old age** starts at 85% of lifespan (−20% thrust, so −20% top speed, and +20% basal metabolism; a dash is unaffected). Death comes at 100%. The client keeps the life clock between reports (the hub's last word plus the ticks played since), shows it as a thin **Life** bar with the stage word (Young, Mature, Old) and, in the last 10 minutes, "About N min left"; it turns the creature elder at 85% and, when its own clock reaches 100%, reports every 2 s until the authority ends the life. The authority has the last word.
- **Hatch limit** (M4): the genesis bucket holds 3 hatches and refills one per 5 min. With it empty the death and title screens say "Next recorded hatch in m:ss", disable Hatch and offer the practice cell.
- **History** (M4): the title screen lists the last 10 lives (species, how it ended, time lived, when), or "No creatures yet".
- **Mating** (M5, ADR 0021; `RULES.mating`):
  - Both creatures must be in the same pond and mature (`matureAtMs`), have at least 50% of their maximum energy, have no pending offspring and no mating in flight, be out of cooldown, be within ±1 size tier and within 3 body lengths, and not be locked (M7). The authority checks everything except the distance: positions are peer-to-peer, so only the two clients check it.
  - **Consent**: A courts (E), the partner sees an invitation (name, species, rarity, size, inbreeding band) and accepts (E) within 15 s; the authority takes an accept up to 20 s after the court, which leaves 5 s for signing and transit. Esc or the timeout declines. A has one court outstanding at a time.
  - **Cost**: paid when the commitment is made, never refunded, no cancel: each parent loses 30% of current energy and 15% of biomass.
  - **Cooldown**: 9 min of active time (so a checkpoint's cooldown stays paused), doubled for each earlier mating of the same two players in the previous 24 h of wall time, at most ×32.
  - **Numbers** (`RULES.mating`, rules version 5): cost 30% energy and 15% biomass; 50% of maximum energy to mate; cooldown 540 s of active time doubling up to ×32 (`repeatWindowMs` 24 h); accept shown 15 s, taken up to 20 s; ±1 tier; reach 3 body lengths; hatchling biomass max(80, 10% of maximum) with energy 60% of its maximum energy; a checkpoint with under 120 s of life left is exhausted. `mate` is a life event that pays the cost in the sim.
  - **Awaiting beacon**: after the commitment both players play on while the round (3–6 s) arrives; closing a tab changes nothing.
- **Pacing** (M5 T14, ADR 0022; retuned in M6 T18, ADR 0029; `npm run sim:pacing`, 12 genesis cells, a food-seeking solo bot that avoids toxin clouds and mates as soon as it may, run on 2026-10-28 on top of main commit 6f41a05): the bot is a test aid, not a player model, and a real player will be slower (2 to 3 times as slow to grow), so read these as the fastest pace.

  | Measure | Result | Target |
  |---|---|---|
  | Biomass doubles (median, p10, p90) | 1.4, 0.7, 3.7 min | median within 4 min |
  | 60% of adult size (median, p10, p90) | 1.5, 1.0, 3.3 min | median within 10 min |
  | Hatch to first eligibility (median, p10, p90) | 8.7, 7.0, 9.4 min | median 7–10 min |
  | Mating to eligible again | 9.0 min (a refeed takes seconds, so the cooldown decides) | — |
  | Matings in a full life (median, min, max) | 9, 8, 10 (4 of 12 bots reached old age; 8 died first) | 4–9 |
  | Children per hour of active time | 6.1 | — |
  | A pair's repeated matings | 1×, 2×, 4×, 8× (72 min), 16×, 32× the 9 min base | 4th ≥ 8× |

- **Offspring**: two distinct children, one per player (seed slot 0 for the courting player's child, slot 1 for the accepter's; if slot 1 happens to equal slot 0 it takes the next slot until it differs), born when the committed drand round arrives (about 3–6 s; ADR 0010). Parent A is the courting player's creature and B the accepter's; the child's first haplotype is a gamete of A and its second a gamete of B.
  - Each player holds **one pending offspring** at most: an egg carried on a short tether behind the parent (M6), glowing faintly by the child's rarity for its owner, with a card showing its body. Pond peers see a plain glowing egg (the snapshot's egg mark, set from the commitment on).
  - Hatchling biomass is max(80, 10% of the child's maximum), energy 60% of its maximum, full health, lifespan clock at zero.
  - Generation = max(parents' generations) + 1.
  - A pending child can only be left by promoting it: no discard (ADR 0021).
- **Promotion** (key H): becoming your pending offspring turns your current creature into an **inactive checkpoint**. It keeps its condition, cooldown and remaining lifespan, frozen. The child hatches out of the carried egg, beside where the parent was (M6: the egg cracks open, the child grows out with a pop, and the parent dissolves over 1 s where it stood).
- **Death**: choose between your pending offspring (if any) and your **nearest surviving ancestor** along your checkpoint chain, which comes back with its saved condition, cooldown and remaining lifespan at the pond's spawn point. Dead ancestors and exhausted ones (under 2 min of life left) are skipped, and an exhausted one is marked dead. If nothing survives, hatch a new genesis cell; the old lineage remains as history. Genesis is refused while any of your creatures is active, pending or a surviving checkpoint.
- **Kinship**: Malécot's coefficient of kinship on the birth records, six generations deep. A child's inbreeding is the kinship of its parents (full siblings 25%, first cousins about 6%). The card says none (under 3%), low (under 10%), moderate (under 20%) or high.
- **Genesis**: DNA from a committed future drand round (ADR 0010), recomputable by anyone from the commitment and the beacon (ADR 0019). At most one living creature per identity, and a bucket of 3 hatches that refills 1 per 5 minutes (M4; 1 per 10 minutes would have broken the loop). An empty bucket shows a countdown, and the player may swim as an unrecorded practice cell. Genesis cells come from a narrow starter distribution (§6). Rare traits mostly arise through breeding.
- **Progress and resume** (M4): while you play, the client reports your condition (biomass, energy, health) after the first 5 s, then every 30 s. The authority clamps and flags implausible values, keeps the latest in memory, and writes a checkpoint when you disconnect, every 15 min of active time and at death. Coming back resumes the same creature at the pond's spawn point with that condition; a reload rewinds at most 30 s and never refills lifespan or the hatch bucket.
- **Recovery code** (M4): a 55-character code (Crockford base32, groups of 5, checksummed) shows your identity's key on request. Importing it replaces the identity of that browser.

## 6. Genetics and development (M3; ADR 0006)

**Karyotype v1** (rules 3–5, frozen in `src/genome/karyotype-v1.ts`). Diploid, 6 chromosomes, 164 bytes per haplotype and 328 per genome; this table mirrors the code:

| Chr | Theme | Loci |
|-----|-------|------|
| 1 | Body plan | segmentation drive (quant ×2 → 1–8 segments), aspect, taper, flexibility, max size (quant ×3 → max biomass), load L1 (membrane integrity) |
| 2 | Integument | membrane thickness, translucency, plating (quant ×2), spines, iridescence (mendel: plain dominant, iridescent recessive), texture (mendel, incomplete: smooth ↔ grainy blend), load L2 |
| 3 | Locomotion | module slots M1–M4, gait amplitude, gait frequency, load L3 (beat strength) |
| 4 | Feeding and weapons | mouth size, mouth type (filter ↔ jaw), digestion efficiency, module slots M5–M6 |
| 5 | Senses and behaviour | module slots M7–M8, aggression, caution, curiosity, reflex, target preference (mendel: nearest, weakest, largest) |
| 6 | Pigment and physiology | hue (quant ×3), saturation, value, pattern (mendel: none < rings < spots ≡ stripes; equal ranks show both), pattern scale, albino (mendel recessive), luminescence (mendel: on dominant), luminescence hue, lifespan, metabolism, growth, UV tolerance, pressure tolerance, load L4 (metabolic) |

**Karyotype v2** (rules 6 on, ADR 0025; `src/genome/karyotype.ts` is the source of truth). Each haplotype keeps its 164 v1 bytes where they are and appends 59: 223 bytes per haplotype, 446 per genome (haplotype A then B). Every new locus reads 0 as off, the v1 body, so a zero-padded v1 genome expresses the v1 traits exactly; development uses the new loci from M6 T7 and T8.

| Bytes (per haplotype) | Chr | Loci (all quant, each mapped onto 0–1) |
|-----------------------|-----|----------------------------------------|
| 164–174 | 1 (after its v1 loci) | spine curve amount, curve mode (C ↔ S; coil at the top of the amount), head scale, trunk swell, tail length, tail taper, fusion, symmetry (bilateral ↔ radial), drape, eye size, eye stalk |
| 175–222 | the slot's own | per module slot M1–M8, 6 bytes each: webbing, setae density, setae length, bulb, chela, beads |

- **Lengths and karyotypes**: exactly 328 bytes (438 base64url characters) decodes as v1 and stays v1, so a living v1 creature keeps its genome hash; any other length decodes as v2 (595 characters), zero-padded or truncated. A genome is encoded and hashed at its own length. `upgrade` pads a v1 genome to v2 (a different, stable hash). Genesis and births write v1 under rules ≤ 5 and v2 from rules 6; the record's `karyotype` says which, and `checkGenesis` and `checkBirth` recompute with the code of the record's `rules` (the frozen `genesis-v5.ts` and `inherit-v5.ts` up to 5). A rules 6 birth pads v1 parents before meiosis.
- **Encoding**: one byte per locus, in chromosome order, haplotype A then B; a module slot is 15 bytes, and in v2 its 6-byte extension (cleared with it when absent) sits in the appended block. Any byte string decodes: short input is zero-padded, extra bytes are ignored, a `mendel` byte wraps into its table (`byte mod size`), a `load` byte keeps its low bit (1 = loss of function), and a module's presence is its low bit with all parameters zeroed when absent. Every `mendel` table ends with at least one novel allele (oil iridescence, ridged texture, pulse luminescence, strongest target, bands pattern, pale albino) that genesis never produces. The genome hash is SHA-256 of `bs/genome/v1\n` and the canonical bytes.
- **Module genes** (8 slots): a presence flag plus 14 parameters — length, thickness, taper, curvature, joints (1–4), branching (0–2), tip shape, stiffness, beat, phase, attach start, attach span, angle, pairs (1–3 per side). Tip shape is a continuum: blunt → point → hook → paddle → whip. Duplication copies a module into an empty slot; the copies then diverge.
- **Genesis distribution**:
  - Segmentation alleles are low (exactly 1 segment: a single cell). Slot M1 holds a whip-like flagellum, and slot M2 is present half the time (a ciliary band).
  - Maximum size gives 300–900 biomass.
  - Colours, patterns and membrane vary widely, so every starter looks distinct.
  - Rare alleles: iridescent (allele frequency 5%), albino (4%), stripes (10%), each load allele (3%).
  - Larval forms (rules 6, `src/genome/genesis.ts`, ADR 0025): the v5 cell below, written as a v2 genome, then given one of six forms from its own `genesis-form` PRNG stream (so the v5 draws never shift): plain cell 35% (a whip, a band in half of them), ciliate 15% (three pairs of cilia, bristled in some), spiny larva 17% (symmetry 0.6–1, so the parts ring the core: short stiff spines with bristles and bead tips), bell 10% (radial with a rearward drape: thin tentacles trailing), tadpole 15% (a thick, long tail) and fan tail 8% (the tadpole with webbing across the tail). Eyes (a pair, 12%) are drawn independently. Every form is one body unit with at most three module slots, none has a coil, carapace or chela, and the rare alleles keep their frequencies. Over 1,000 seeds six classes appear and none takes more than 40% (about 34% ciliates, 22% cells, 16% spiny larvae). The median top speed stays within 15% of the v5 cell's. The multi-segment forms arise through breeding and mutation; the Lab's wild mode (random bytes with each v2 byte kept at 0 with 60% chance) shows at least eight classes in 24 cells for 9 seeds in 10.
  - Implementation of the cell (`src/genome/genesis-v5.ts`, frozen, `GENESIS_FREQ`): `genesisGenomeV5(seed)` draws every trait from its own `genesis` PRNG stream. Hue is uniform, other colour traits and the membrane are wide, armour and spines stay low, and sizes lean small. Alleles are drawn per haplotype: luminescent 30%, pattern none/rings/spots/stripes 40/20/30/10%, grainy 50%, and the rare ones above, so a recessive shows in about 1 cell in 400 (iridescent) or 600 (albino). The M1 whip is varied around the starter's, and a ciliary band (M2) is added to half of the cells. The median top speed is about 1.1× the M1 cell's.
- **Expression** (M3; `RULES.genes`, `src/genome/express.ts`): a quantitative trait is the mean of both alleles over its loci (equal weights), mapped linearly onto its range, so a locus moving 0 → 255 on both alleles moves the trait by (high − low) ÷ the number of loci. Plating and hue are sums of two and three loci; segments are the two drive loci mapped onto 1–8 in equal steps. Ranges: aspect 0.8–2.4, taper 0–0.8, mouth size 0.2–1, digestion 0.7–1.2, gait frequency 0.5–2, saturation 0.3–1, value 0.35–1, lifespan 0.6–1.6, metabolism and growth 0.7–1.4, everything else 0–1. Complete dominance shows the higher-ranked allele (equal ranks show both, as spots with stripes do); incomplete dominance blends the ranks. A module is expressed when present in either haplotype, and parameters present in both average, rounding half up; a v2 slot's extension follows the same rule and maps onto 0–1 (`RULES.genes.range.part`). The v2 shape loci are `traits.shape` (`RULES.genes.range.shape`, all 0–1). A load locus matters only when homozygous: membrane integrity ×0.6 (L1), the malformed-part scale ×0.6 (L2), beat strength ×0.7 (L3), metabolism cost ×1.3 (L4).
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
- **Development caps**: 8 segments, 24 appendages, 4 joints, 1 branch level (≤2 branches), 12 collision circles, bounds ≤2.5× core radius (rules 5 also capped the mesh at 6,000 vertices, 1,500 at low detail; rules 6 leaves vertices to the renderer, §12). Repair guarantees a propulsion source and a mouth.
- **Development** (M3; `RULES.develop`, `src/genome/develop.ts`): `develop(traits)` builds the plan in core radii and repairs it, in this order:
  - Segments are ellipses along the spine (core first, the rest behind it), half-length = radius × aspect ÷ 1.6 within 0.6–1.2; taper shrinks the rear radius by up to 60%. Segments behind the core scale together so the rear stays within 1.8 of the core, which keeps 8 segments inside the bounds.
  - Each present module becomes `pairs` (1–3) left parts, mirrored right. A part leaves the segment at attach start/span (front to rear, mapped to segment indices) at an angle of 0.2–2.94 rad from the heading. Length 0.1–1.5, base width 0.04–0.4, joints 1–4, branches 0–2 (each 0.6× its parent). The first present module is the malformed part under L2: its length and width are ×0.6, below those ranges.
  - Parts on one segment and side keep 0.3 rad apart: later ones are pushed round the outline, and one that no longer fits merges into its neighbour (the survivor thickens and keeps the stronger beat). Lengths shrink so the root plus the reach (branches ×1.6) stays within 2.45 core radii.
  - Parts beyond 12 per side (24 instances), or under rules 5 beyond the vertex budget, are dropped from the end of the list (module order, then pair). If motile area (length × width × beat × (1 + 0.36·branches), parts with beat ≥ 0.1) is below 0.06, a default ciliary band (two pairs, whip tips) is added on the rearmost segment with room; only when no segment has room are the last parts dropped until it fits.
  - The mouth: radius = size × (1.5 − type); a type above 0.5 moves it forward (offset up to 0.6) and narrows its arc to 0.2π. Plating gives every segment plates of coverage = plating, thickness 0.03–0.2. Colliders: the core, one per further segment, then the biggest left-right pairs (length × width) while two circles still fit under 12; parts too thin for a circle of the minimum radius 0.05 (width below 0.1: cilia, whips) get none.
  - Vertex estimate (rules 5 only): per segment 108 (low 30), per part piece (joints × 3 + 1) × 8 + 1 (low (joints + 1) × 4 + 1), each part counting itself and its branches.
- **Development v2** (rules 6, M6 T7; ADR 0025; `RULES.develop.{curve,tagmata,fusion,radial,eyes}`): the same steps, with the shape loci. A v1 genome (karyotype 1, so every shape locus 0) develops exactly as under rules 5 (`develop-v5.ts` and `stats-v5.ts` are the frozen v1 code; a property test over 10,000 v1 genomes pins the plan and the stats). The one exception: under rules 6 parts are capped by count only (M6 T10), so a v1 body whose parts the vertex rule dropped gets them back. A v2 genome lays its chain out and fits its parts by the proportions below (M6 T14b, ADR 0028), shape loci or not.
  - Segments gain a centre `y` and a heading `angle`. **Tagmata**, along the chain behind the head (t = i ÷ (segments − 1)): trunk swell widens it by up to 60% at t = 0.4 (falling to 0 at ±0.6); the rear half is the tail, where tail length stretches the half-length by up to 80% and tail taper narrows the radius by up to 70% at the tip. After the reach scale, head scale shrinks the whole chain behind the head by 1 ÷ (1 + 0.8·head scale) (the head is the unit, so it reads larger; a v2 chain is narrowed by it after its fit). Symmetry rounds every segment toward an aspect of 1, all along its range.
  - **Spine curve**: the links keep their lengths and turn with the spine's tangent, which runs from 0 at the core to the total turn at the tail. C mode (curve mode < 0.5): total turn = curve × π, one arc. S mode: two opposite arcs of half the turn each. Above curve 0.8 the spine coils in either mode: the turn grows to 2.4π at curve 1, bunches toward the tail (tangent ∝ t^(1 + 1.5k), k = (curve − 0.8) ÷ 0.2) and its links shrink by up to 40%. Neighbours stay within 0.9 of their summed radii along each link, so they always overlap; a single cell never curls. The segment colliders sit on the curve.
  - **Fusion**: the front round(fusion × segments) segments get one carapace, an ellipse along the axis from the rearmost fused centre to the core that holds 16 outline points of every fused segment (kept within 2.45 core radii). The segments stay in the plan. Their colliders move onto the shell's axis and take its half-width there; their plates are replaced by the shell, thickness 0.08 + (0.2 − 0.08) × plating. The body loses 80% × fused share of its flexibility.
  - **Symmetry**: at 0.5 and above the parts ring the core: in module order, at most 8 pairs, left angles π(2k + 1) ÷ (2 × pairs), so every instance sits evenly round the circle; a ring that cannot swim gets the ciliary band in its last two places. A radial mouth is central (offset 0). **Drape** bends growth rearward: bilateral parts sweep 0.3 + 0.6 × drape of the way to the tail, radial ones 0.45 × drape (`ringDrape` 0.5 of 0.9), so a ring trails as a ring: its front parts turn sideways and its rear ones back, each growing no further forward than the one before it (M6 T14b).
  - **Eyes**: eye size above 0.15 gives a pair on the head at ±0.6 rad, radius 0.08–0.3 over 0.15–1, on a stalk of 0–0.6 (eye stalk), kept inside the bounds.
  - **Fine parts** (M6 T8, `RULES.develop.detail`; detail on parts, never parts, so they never change a part's count, place or length except where noted):
    - **Webbing** (0–1) is how far along its rays a part's sheet reaches. A webbed part spans a membrane from its fork (0.7 of its length, branches fanned ±0.5 rad) to each branch, and a quad to the next part rearward on the same side (by segment, then angle) when their roots lie within 1.6 core radii (`webSpan`; 1.2 before M6 T14b widened the trunk). The rearmost left part spans to its own mirror instead: a tail fan. Membranes are convex counter-clockwise polygons in core radii (a crossing or reflex quad is split in two; pieces under 1e-4 are dropped), inside the bounds.
    - **Setae**: density gives round(density × 24) bristles per part, at (k + 0.5) ÷ count of its length, each setae length × width × 6 long, shortened so every bristle stays in the bounds (setae length 0: none). The body keeps 240; the excess comes off the shortest parts first (ties: the later part), in mirror pairs.
    - **Bulb** above 0.3 tips the part with a bead of radius bulb × width × 2, at most half the free reach past its root; the part shortens to make room. **Beads** (0–1) swell each joint to (1 + beads) × the part's radius. **Chela** above 0.5 on a pointed or hooked tip (weapon share above 0) makes the last joint opposable (0 otherwise).
  - **Proportions** (karyotype v2 only, M6 T14b, ADR 0028; `RULES.develop.{chain,fit,part}`): the trunk carries the body, and parts keep their gene length where they can.
    - In front of a chain the head is 0.65 of the v1 head (radius and half-length; the half-length never below 0.6), the v1 head at head scale 1, and round and whole as symmetry rises; a single cell keeps the v1 head. The core collider stays the unit circle of radius 1, and drag takes at least its width.
    - The segments behind it are 0.8 core radii wide along the tagma profile. The chain fits a reach of 2.1 (a radial body's falls from 2.1 at symmetry 0.5 to the head's half-length at 1, so a bell keeps its chain inside) by shortening its segments to as little as 0.25 of their width, and only then narrowing. Neighbours sit 0.8 of their summed half-lengths apart; head scale then narrows the chain by 1 ÷ (1 + 0.8·head scale).
    - Parts fit by their drawn reach, not root plus length: the centre line is an arc that turns 1.2 × curvature (less with webbing, never tighter than 0.8 of its half-width), then a straight tip cap of (0.3 + 2.2 × tip) end half-widths, at most 0.3 of its length; branches leave it at 0.7, bulbs sit on the ends. The fit holds the part at its full bend, half of it and straight, with its straight rays at full length, so webbing never changes it. A part that would leave the bounds sweeps toward the core along the body, by at most 1.6 rad, the least sweep that fits (two halvings); a rear-segment part growing rearward turns no further forward than sideways, so a tail stays a tail. A part that still does not fit is cut by the v1 rule. Each part's collider sits on its drawn centre line, pulled inside the 2.5 reach.
    - Over the 12 silhouette specimens the median trunk segment is 0.53 core radii (pass 1: 0.1–0.2). Over random v2 genomes 97% of antennae, 95% of ring parts and 76% of wings keep their gene length (the v1 rule: 61%, 94%, 51%).
  - `bodyViolations` also checks that neighbours overlap, the carapace's count and size, no plate under it, eyes 0 or 2 within their radius range, an even radial ring, a central radial mouth, fine-part ranges, setae ≤ 24 per part and ≤ 240 per body, chelae only on weapon tips, and membranes owned by webbed parts, convex, non-degenerate and inside the bounds.
  - **Silhouette** (`src/genome/silhouette.ts`; tests, the Lab, the gallery and reports, never stats or the sim): radial → bell when its parts point rearward on average (dir.x ≤ −0.3), else spiny larva; a coil; a fan tail when a sheet behind the rear segment covers ≥ 10% of the body area and is most of the webbing, winged when the webbing covers ≥ 25%; a crab when ≥ 75% of 2+ segments are fused, a copepod with 2+ fused and 2+ free; from 4 segments a worm (turn ≥ 0.35π), a shrimp (≥ 3 pairs) or a tadpole (core ≥ 60% of the body area), else a worm; 2–3 segments a tadpole (big head) or other; one cell a ciliate (≥ 3 pairs or ≥ 24 bristles), a tadpole (a thick, long rearward tail) or a cell.
- **Stats** (M3; `RULES.stats`, `src/genome/stats.ts`): `computeStats(plan, traits)` gives the adult numbers (at the maximum biomass; `statsAt` takes any size). Multipliers are relative to the reference cell (`starterGenome`: one round cell, one whip, all-round mouth), which therefore reproduces `STARTER_PHYS`.
  - Thrust: Σ over motile instances of length × width × beat × (1 + branches·0.36) × efficiency × beat load × (0.7 + 0.3·gait amplitude), divided by mass. A tip's efficiency is 0.25 plus its whip share × (size ÷ 16,384)^−0.25 plus its paddle share × (size ÷ 16,384)^0.25; the paddle share peaks at tip 0.75 and the whip share rises to tip 1. The sim sees the adult value for the whole life.
  - Drag: 2 × widest radius (at least the core's 1, M6 T14b) × (1 + 0.6 ÷ fineness) × (1 − 0.2·rear taper), plus 0.25 × Σ width × (1 + length) × (1 + 0.6·branches), 0.3 × plate area and 0.1 × spines × width.
  - Mass: body area × (1 + 0.1·spines) + appendage area + 4 × plate area. Turning: (1 + 0.5·flexibility + Σ part thrust × distance from the centre) ÷ moment of inertia.
  - Weapons: pointed to hooked tips (peak at tip 0.375) × stiffness × length, plus the bite of a jaw mouth (0.5 × jaw share × mouth size); reach is the farthest tip, arc the widest weapon angle. Armour is plate coverage × thickness against the thickest plate, area-weighted. Detection ring: 1 + 0.5 × Σ length × forwardness × slenderness × (1 − beat). Glow is 1 for luminescent, 0.5 for pulse.
  - Basal: the formula under Costs × the metabolism trait × the metabolic load, relative to the reference.
  - Development v2 (rules 6, `RULES.stats.v2`): every term works in the body frame, so a curl brings segments in (lower moment of inertia) and shortens and widens the outline (lower fineness, more drag). The carapace weighs like a plate of its thickness over its outline (mass, inertia, plate drag), widens the outline, and covers its fused segments whole for armour. A radial ring drives forward only with its rearward share ((1 − cos dir) ÷ 2) × 0.7, and all its steering is ×1.6. Each eye adds 1.5 × radius × (1 + stalk) to the detection ring, 0.3 × radius to the basal sum, and its area to the mass.
  - Fine parts (M6 T8, `RULES.stats.v2.{web,setae,bulb,chela,beads}`): a flapping sheet only pushes at high Reynolds numbers, so a membrane on a beating part adds area × beat × (size ÷ 16,384)^0.5 × the beat load and gait factor to the thrust (steeper than a paddle: weak when small, the strongest when big), and 0.5 × area to drag and to mass. Setae, by fringe (Σ bristles × length): 0.004 × fringe drag; a share min(1, fringe ÷ 30) adds up to 1 to the detection ring and widens a filter mouth's radius by up to 25% × its filter share (1 − type ÷ 0.5; a filter mouth's arc is already π). A bulb weighs its disc and adds 1.5 × radius to the spine share (capped at 1, contact damage); a chela adds 1.5 × chela × stiffness × its last joint's length to weapon power and its finger to the mass.
- **Inheritance** (M3; `RULES.genetics`, `src/genome/inherit.ts`): the child is a gamete of parent A (first haplotype) plus a gamete of parent B (second), from `offspringSeed` = SHA-256 of `bs/offspring/v1`, the beacon randomness, the commit id and the slot byte, read as four big-endian words. Under rules 6 the parents are padded to karyotype v2 first and the child is v2; rules ≤ 5 births are recomputed with the frozen v1 code.
  - Meiosis, per chromosome: a random starting haplotype, then 0, 1 or 2 crossovers (40 / 40 / 20%), each at a uniformly chosen boundary between loci, so neighbours rarely separate and chromosomes assort independently. A module slot moves as one locus, with its v2 extension. The v2 shape loci are loci of chromosome 1 after its v1 loci, so they are linked to it.
  - Mutation, per gamete: three trials, each firing with 15% × the mutation factor (the Lab's ×4 gives 60%). A fired trial picks a kind by weight: quant step 30, allele change 14, load flip 10, parameter drift 20, module duplication 8, module deletion 8, novel allele 10. Steps move a byte by 1–24 (a quant step can land on a v2 shape locus); allele change stays within the genesis alleles; a novel allele comes from the table's tail; drift and deletion act on present modules (drift picks one of a slot's 14 parameters or, in v2, 6 extension bytes), duplication copies one, extension included, into an empty slot (the copies then drift apart). A kind with no target does nothing.
  - Streams `meiosis-a`, `meiosis-b`, `mutation-a`, `mutation-b`; `mutateGenome` (Lab) runs only the mutation streams on both haplotypes of one genome.
- **Function from form**:
  - Thrust is the sum over motile parts of length × thickness × beat × efficiency. Whip efficiency falls with size and paddle efficiency rises with it, crossing around T1–T2.
  - Weapon reach and damage come from pointed or hooked tips × stiffness × length.
  - Armour is plating × coverage, and spines deal contact damage.
  - Mouth size limits the largest food item and the bite. A filter mouth (low mouth type) gives passive intake of detritus in its front arc. A jaw mouth (high mouth type) bites big items, carrion and opponents (M7).
  - Sensor modules extend the detection ring, and luminescence matters in dark zones.
- **Costs**: the basal multiplier is `1 + 0.1·(segments − 1) + 0.04·appendages + 0.2·plating + 0.1·luminescence + 0.3·Σ eye radius + 0.2·membrane area + 0.002·bristles + 0.02·bulbs + 0.03·Σ chela + 0.01·Σ beads`. Mass slows acceleration and turning, and appendages add drag. A curl costs streamlining, a carapace mass and flexibility, radial symmetry forward thrust, eyes metabolism, webbing drag and mass, setae drag. No build is best at everything; archetype tests enforce that over speed, acceleration, turning, efficiency, both foods, armour, weapons and the detection ring (M3, M7; the radial, coiled and carapaced archetypes since M6 T7, winged and setose since M6 T8).
- **Rarity (M3)**:
  - Score = Σ −log2(genesis frequency) over expressed rare features.
  - Tiers: common < 4, uncommon 4–8, rare 8–14, exotic ≥ 14.
  - Features: iridescent, albino, stripes, spots, rings, luminescent, radial symmetry, webbing and eyes (priced from their exact genesis frequency: the allele frequencies, or for the last three the form table, which makes radial 27%, webbing 8% and eyes 12%), and 12 bits each for extra segments, extra modules (beyond the whip and cilia), a novel allele, a max size of tier 1 and up (1,024 biomass), a coil, a carapace or a chela. About 70% of genesis cells stay common.
  - Each creature gets a deterministic species-like name: a genus from its genome hash (three syllables and a suffix) and an epithet from its strongest trait (for example "Dabelothrix natans"). The v2 traits name bodies too: *alata* (webbing), *spiralis* (a curve, a coil above all), *radiatus* (radial symmetry), *oculatus* (eyes) and *setosus* (bristles); a v1 body never takes them.
  - `npm run report:diversity` adds the silhouette histograms, of the whole sample and of genesis alone. `npm run specimens` searches a v2 body for each silhouette class and rarity tier (deterministically, from a seed) for the gallery.
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
  - **Pond clock**: the hub's clock gives every pond tick (30 Hz from the pond's epoch), so food and plumes agree between players. Each browser simulates only its own creature; others are drawn from 10 Hz snapshots, 120 ms behind. A snapshot (25 bytes, version 3 from M6) also carries flag bits for alive, dashing, ready to mate and carrying an egg; any other bit drops it. A silent player fades after 2 s and disappears after 6 s. A hidden tab freezes your cell and fades you out for the others (ADR 0016).
  - **Bodies (M3)**: a browser sends its genome (about 330 bytes) once to each peer when a link opens and again when it hatches a new body; snapshots carry a 2-byte reference to it (ADR 0018). Until a peer's genome arrives, it is drawn as a plain tinted cell.
  - **Offline**: if the hub can't be reached you play alone in a local pond and the status says so.
- **AoI and tiers (M11)**: connect only to creatures within ±1 tier inside the AoI (1.3 × the visible half-diagonal), plus boundary neighbours and duties. The default cap is 24, the hard cap 32 (ADR 0013). Giants see smaller life as ambient swarms.
- **Spawning and regrouping (M12)**:
  - Newcomers spawn on a ring around a compatible group, at least 3× the attack reach of larger creatures away and away from recent spawn points. The ring expands as the area fills.
  - After 120 s alone you may "ride the current" to a group.
  - Crowded spots split into bounded instances that never separate interacting creatures.
- **Admission (M4, M13)**: past 200 concurrent sessions (`MAX_SESSIONS`) or 90% of the daily request budget (`DAILY_REQUEST_BUDGET`, 100,000), new players are queued with a position and an estimated wait (30 s per place until M13 measures it). A queued player can swim as a practice cell meanwhile.
  - **Meter**: an upgrade counts as 1 request, an incoming message as 1/20, per UTC day; counts are flushed to the `usage` table at most once a minute and only when something changed.
  - **Queue**: a queued session is in no pond and may only ping or leave. Seats go to the queue in arrival order the moment one frees, and every 15 s while anyone waits (the budget resets at midnight UTC). Players who already hold a seat are never dropped or re-queued; a second tab takes over its place in line.

## 9. Social (M2)

- **Chat**: up to 140 characters, 3 messages per 5 s per sender (receivers drop extras). Profanity is filtered with English and German lists after leetspeak normalisation. Messages show in a panel and as short bubbles above the creature.
- **Display names**: 3–16 characters from `A–Z a–z 0–9 _ -`, also filtered.
- **Emotes** (6): wave, happy, love, angry, scared, question.
- **Pings** (4, lasting 4 s, at most 1 per second): look, danger, food, mate.
- **Finding players (M6 T19, `src/game/indicators.ts`, `src/game/pond-map.ts`)**: every pond player with no part on screen gets an arrow on the screen's edge (44 px in), pointing at them, with their name and the distance in your body lengths; the nearest 6 are shown, and indicators that would overlap slide apart along the edge. The arrow's shape gives their size by tier (an open chevron smaller, a solid head comparable, a doubled head bigger, also written out; on screen, the size outline of §10 does the same), and a heart and the word "ready" mark a player whose snapshot says it could mate (mature, rested, no pending child: a hint only, the authority checks everything at `court`). A ping off screen within 2 view radii (the view's centre-to-corner distance) shows as a ring with its kind on the edge for its lifetime. The pond map (`M`) shows the pond's bounds and depth zones (darker with depth, outlined and named in a legend), you as a ring, other players as dots or hearts with their names, and live pings. Positions come from the pond snapshots, so finding costs no hub traffic.
- **Mute** a player locally.

## 10. Feedback (readability)

| Event | Visual | Audio (M6) |
|-------|--------|------------|
| Eat | pop and sparkle; energy bar pulse | soft bubble pop |
| Damage | red pulse on the body; edge vignette | dull hit |
| Low energy (<20%) | HUD pulse | slow low pulse |
| Hazard near | hazard outline brightens | rumble |
| UV or pressure (M6) | violet shimmer (UV) or a dark squeezing vignette (pressure); the depth gauge says "UV burns" or "Pressure crushes" | (T23) |
| Dash | ripple | whoosh |
| Windup aimed at you (M7) | glow on the attacker's weapon | rising tick |
| Death | dissolve; death screen naming the cause | descending tone |
| Old age (M4) | stage word and dashed bar on the life meter, "Feeling old" toast (no tint on the body yet) at 85% of the lifespan | slow low swell (M6) |
| Court, mate, hatch (M5) | bioluminescent dance; at the commitment the body shrinks with a pulse and the energy and size bars drain with a highlight (M6); egg crack | chime; bright chime |
| Beacon reveal (M6) | an egg over the title cell (genesis; the menu fades back) or beside the parent (mating) wiggles with rising frequency and glow, settling into a calm idle after 10 s; on the beacon it cracks and bursts by the child's rarity (common a soft pop, exotic a bright burst with slow motion), and the card slides in. Reduced motion fades instead of shaking | (T23) |
| Growth into a new tier | zoom-out swell | soft swell |

Never a silent death: every source of damage and every death cause has a cue.

Presentation timings (v1, `FX` in `src/render/effects.ts`): eat pop 0.55 s, dash ripple 0.85 s, damage vignette at least 40% on any hit and fading with a 0.25 s time constant, death dissolve 1.2 s before the death screen, low-energy pulse below 20%, mating cost shrink 0.7 s.

Size outlines (M6 T21, `OUTLINE` in `src/render/outlines.ts`): another creature at least one size tier bigger than you wears a broken amber ring of 8 dashes that pulses every 0.9 s; one a tier smaller a faint, still ring of 16 dots; a comparable one none. Shape and pulse tell them apart, not only colour. The ring circles the body's hull (not its parts), 30% of the hull's radius and at least 6 px outside it, and stays visible in dark water. Gameplay parts at default zoom: the mouth is a dark opening ringed by a bright, near-white lip at the front of the body (at least 0.2 core radii deep, so a small jaw shows), and plates are denser, brighter glass with a sheen.

Crispness (M6 T21): the canvas's backing store is its CSS size times the pixel ratio and is never scaled by CSS (adaptive resolution aside, T4); DOM text sits on whole pixels (labels, cues and indicators are placed by whole-pixel transforms that measure their box, never by a percentage offset), and the HUD's icons (edge arrows, map marks) are SVG, with no raster images; the ping and emote glyphs become SVG icons with M6 T25.

The egg (M6, `EGG` in `src/render/egg.ts`): the wait's wiggle rises from 0.6 to 3.2 Hz and 0.1 to 0.3 rad over 10 s, then eases to 0.35 Hz and 0.05 rad. Crack, burst, rings and burst light by rarity: common 0.9 s, 0.6 s, 1 ring, 0.35; uncommon 1.2 s, 0.8 s, 2, 0.6; rare 1.6 s, 1.0 s, 3, 0.9; exotic 2.1 s, 1.5 s, 5, 1.6, with the effects at 30% speed for the burst's first 0.9 s. A hatchling pops out over 0.45 s.

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
| Medium (default) | up to 1.5 | half-strength DOF, bloom, grade | 100% | 150 / 300k |
| High | up to 2 | full DOF, bloom, chromatic aberration, grain | 150% | 250 / 600k |

Players pick Auto, Low, Medium or High in Settings (title screen, or Esc then Settings); the choice is stored in the browser and `?quality=` overrides it for one visit. Auto picks a preset from a benchmark: 2 s of frames at medium (after 0.5 s of warm-up) behind the title screen, never during play. A 75th-percentile frame time up to 11 ms picks high, up to 20 ms medium, otherwise low; the result is stored per GPU (`bs.bench`, by the unmasked renderer name), so another machine benchmarks again, and Settings shows it as "Auto (Medium)". Adaptive resolution then steps the render scale between 0.6 and 1 by 0.1: down when the 90th-percentile frame time over the last 2 s exceeds 1.25 × 16.7 ms, up when it has stayed below 0.8 × 16.7 ms for 5 s, each step followed by a fresh 2 s window. The post chain shrinks its scene target; low shrinks the canvas's backing store. The HUD and the DOM are never scaled. Under test automation and with `?quality=` there is no benchmark (a stored result still counts) and the scale stays at 1.

The post chain (`src/render/post/`) renders the scene into a half-float target (8-bit where half float cannot be rendered), then composites onto the canvas: a half-resolution dual-filter bloom (4 levels on medium, 5 on high), a grade (a teal lift in the shadows, a filmic shoulder that rolls highlights off to white) and a vignette, plus film grain and radial chromatic aberration on high. Low renders straight to the canvas. The Creature Lab uses high without the vignette and the aberration, which depend on a cell's place in the frame. On medium and high the backdrop (water, far particles, plumes, food) also draws into a half-resolution copy first, which the creatures' glass refracts (M6 T13).

Depth of field (ADR 0027): the camera focuses on the gameplay plane, where creatures, food and plumes stay sharp. Only the particle layers lie off it: far bokeh below (depth −0.82 camera heights), near bokeh above (+0.375) and marine snow up to 0.2 either side of the plane. Each speck draws its own circle of confusion, 24 px per camera height off focus (at a pixel ratio of 1), up to 6 px on medium and 12 px on high, and spreads its light over the larger disc; on high bright discs get a chromatic fringe (red out, blue in, 20% of the CoC). Low keeps the plain sprites. The pass adds no render target.

Creature meshes (M6 T10, ADR 0025; `src/render/creature-mesh.ts`): one merged geometry and one draw call per creature, cached by genome hash and level of detail. The level is the preset's (high 12,000 vertices, medium 6,000, low 1,500), or low for a body under 12 px in radius (back above 16 px). The body is a loft along a centripetal Catmull-Rom line through the segment centres, as wide as the plan outline, with a thin glass shell over a carapace; parts are tapered, curved tubes with joint beads, bulb tips and chela fingers; setae are tapered ribbons, membranes double-sided sheets with a vein UV, eyes lens spheres on stalks. Each level steps down its own ladder of detail (body rings, part rings, bristles drawn, membrane rows), then the lower levels', until the body fits: no part is ever dropped.

Inner anatomy (M6 T12; `src/render/anatomy.ts`, render data only, which nothing in the sim or the stats reads): inside the hull (the segment ellipses shrunk to 85%) a gut line runs along the spine from 10% to 90% of its length, 0.055 body scales wide (the body scale is √(Σ rx × ry)) with a stomach swelling to 2.4× somewhere in its first half; 3–14 fluid chambers and oil droplets (3 + round(11 × (0.65 × size + 0.35 × metabolism)), size the genetic maximum on its 2^13 scale and metabolism on its 0.7–1.4 range; a quarter to a half are droplets) sit at places seeded by the genome hash, never overlapping; one heart (behind the head) or ganglion (in the head) spot; and eye pigment, a pair behind the eyes or one median eye spot. Organs are drawn in the creature's geometry over the body and under the carapace and eyes, with their own part kinds, and each level keeps at most 20% of its budget for them (the body fits the rest). The pigment lives inside: the shell takes 15% of the gene's saturation, and the organs carry the hue gene at its full saturation (an albino's organs the pink of blood), the droplets turned 40% of the way toward amber; luminescence lights the organs (photophores), not the shell. Plates are denser glass, not opaque lids.

Materials v2 (M6 T13; `src/render/surface.ts`, the creature shader): the shell is glass, silvery pale blue (hue 0.58 at 4% saturation, with the gene's 15% tint added as a chroma vector and the sum capped at 15%; an albino's stays clear). It has a fresnel rim (at least 0.5 luminance), a backlight and a wet highlight from a fixed key light to the upper left. On medium and high it bends the backdrop copy by its normal (up to 0.2 core radii at a grazing angle); on low it is plain translucency. Procedural pores (0.07 core radii), a cell texture (0.2), a vein network on membranes (0.14) and small flaws (0.35) fade in from 2 to 5 px on screen, and away toward the rim. Rare glints are star points over organs and the joints of parts, placed by the genome hash at least 0.18 core radii apart; `glintsFor(tier, iridescence)` gives their count, size and brightness: common 0–1 dim, uncommon 1–3, rare 4–8, exotic 12–16 at the bloom's full intensity. A rarer tier never has fewer or dimmer glints.

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
