# M6c: Living creatures and play polish

Release: v0.7.2 · Gate: yes

## Goal

M6c answers the owner's Playtest v0.7.1 feedback (#212). The owner gave it in a Claude session on 2026-11-01, with screenshots of the Creature Lab, the minimap and a creature in Firefox. Every point below quotes it.

- **Creatures look like real, organic plankton**, not spaceships.
  - Each body has one pair of long antennae, a few short swept-back legs and one tail structure.
  - Parts curve and taper.
  - Bodies are glass with pass 1's soft 3D sheen rather than fully see-through shells.
  - Limbs are the same glass as the body, and the mouth reads as a mouth.
  - Organs and eyes keep to two related tones.
- **The play screen feels better**:
  - damage lands as distinct hits, not a rumble;
  - the sunlight is strongest in the shallows;
  - the egg reveal holds a still scene and rewards clicking;
  - the minimap turns smoothly, and its depth marker can't be mistaken for a player;
  - Firefox draws creatures cleanly.
- **The world is renewed once** (ADR 0040). Rules 8 resets the ledger and drops every frozen version, so the body work above needs no freeze.

The decisions behind this milestone:
- ADR 0040 sets the reset;
- ADR 0041 sets how bodies read as organisms;
- ADR 0043 sets the glass, the two-tone organs and the gallery under the new rules.

ADR 0034's method still holds where 0043 does not amend it: pass 1 is the realism baseline, and the look is judged in one sheet, not a pass series. The render rules still hold: nothing clips to white, and nothing allocates per frame. ADR 0042 sets how scenarios stay deterministic.

This milestone is a **gate**. After v0.7.2 the factory waits for the owner's reply on the `Playtest: v0.7.2` issue before M7 starts.

## Owner feedback → tasks

| Owner point (2026-11-01) | Task |
|---|---|
| "Is the genesis freeze really necessary … complete wipe is fine" | T1, T2 |
| "Most of the creatures in the creature lab don't look like real, organic creatures (… 20 antennas or limbs … spaceship) … be very honest about the pitfalls" | T3, T4, T5 (ADR 0041 lists the pitfalls) |
| "Some creatures in pass-6 seem to be curled up – intended?" | T3 (yes: the coil silhouette of #90, now gated so it reads as a spiral) |
| "Very visible white silhouettes/bodies, but their limbs are gray and look like a foreign body (… while still preventing clipping)" | T6 |
| "Weird dark unfilled half-circle part in front of every creature – is that the mouth?" | T6 (yes: redrawn as a mouth) |
| "You made the creatures fully see-through instead of opaque like in pass-1" | T6 |
| "Organs not looking like in pass 1 (maximum two-color organs …) – you can make some of them glow ever so slightly" | T7 |
| "Align Eye colors to the main organ color" | T7 |
| "Weird aliasing … on firefox in the center of the creature … sometimes they bug out / flash" | T8 |
| "Make the creature shake when damaged more visible … shakes in intervals – kinda how you take damage in Minecraft" | T9 |
| "Make the Caustics and Godrays slightly more prominent in shallow water" | T10 |
| "The background should be static and not move during the egg hatch" | T11 |
| "Make the Egg Reveal even more interactive and exciting … Maximize the Gatcha" | T11 |
| "Refresh rate of the mini-map should be higher – arrow looks choppy" | T12 |
| "Mini-map shows a white dot on the border … I thought this was a player / ping indicator … rework this" | T12 |

## Out of scope

- **Combat**, predators eating eggs, kills as growth (M7).
- **New karyotype loci.** Rules 8 reshapes development from the existing v2 loci. Max biomass, growth and lifespan stay the same per genome.
- **Look pass series.** One sheet in T13 (ADRs 0034, 0043); the owner judges at the gate.
- **New sounds**, beyond the hit cadence (T9) and the egg's charge ticks (T11), which reuse existing voices.
- **Touch controls.**
- **Playwright retries.** Flaky scenarios are fixed at their cause (ADR 0042).

## Touches

- **Changed**:
  - genome: `src/genome/{develop,stats,genesis,silhouette,rarity,names,describe,karyotype,codec,inherit,offspring}.ts`;
  - ledger and worker: `src/ledger/{genesis,mating,record}.ts`, `worker/{schema,authority,ledger}.ts`;
  - net: `src/net/protocol.ts` (version 6);
  - render: `src/render/{creature-mesh,creature-view,material-params,anatomy,shake,zones,egg}.ts` and `src/render/shaders/{creature,water,godrays,caustics,egg}.*`;
  - game: `src/game/{app,eggs,minimap,history,lineage-view,screens,debug}.ts`;
  - lab and tools: `src/lab/{specimens,gallery}.ts`, `tools/specimen.ts`;
  - tests: `tests/e2e/{look-metrics.ts,m6b-water.spec.ts,m3-lab-tools.spec.ts,m6-lifecycle.spec.ts}`;
  - config: `playwright.config.ts`, `.github/workflows/e2e-full.yml` (a Firefox part);
  - docs: DESIGN §2, §4–§6, §9 and §10.
- **Removed** (T1): `src/genome/{karyotype-v1,develop-v5,stats-v5,inherit-v5,genesis-v5,genesis-v6,genesis-v7}.ts`, their tests and every `-vN` golden. They are entangled, so T1 rewires each importer, not only deletes:
  - `karyotype.ts` and `codec.ts` build v2 from `LOCI_V1` and `MODULE_*`, so the v1 table moves inline into the v2 layout;
  - `genesis.ts` draws its base cell with `genesisGenomeV5` and re-exports `GENESIS_FREQ`, so those move into `genesis.ts`;
  - `rarity.ts` reads `genesis-v7`'s tables;
  - `develop.ts` has `karyotype === 1` paths;
  - `tools/specimen.ts`, `m3-lab-tools.spec.ts` and `m6-lifecycle.spec.ts` import frozen files.
- **New**:
  - `src/genome/organism.ts` (the region rules of ADR 0041);
  - `tests/e2e/m6c-*.spec.ts`: hub ports from 8804 on, each hub file its own;
  - the `firefox` Playwright project.

## Tasks

### The reset (ADR 0040)

- [x] T1 Retire the frozen versions: rules 8, one live version [opus]
  - Done: frozen files, tests and nine `-vN` goldens gone; the v1 table and base cell inline in `karyotype.ts`/`genesis.ts`; checks answer `rules-retired` below `FIRST_LIVE_RULES` (`record.ts`). Genesis hashes and develop vectors are unchanged under rules 8.
  - Gotcha: gallery files 01–20 are now stored as their v2 padding (new pinned hashes); `shownGenome`, `upgrade`, `genomeKaryotype` and `traits.karyotype` are gone.
  - Why: the owner allowed a wipe. The freezes cost about 1,700 lines, eleven goldens and a step in every body task, and nothing verifies an old version before M9.
  - Steps:
    1. `RULES_VERSION` = 8.
    2. Rewire the importers listed under Touches, then delete the frozen files, their tests and every `-vN` golden. The v1 locus table becomes the first part of the v2 layout in `karyotype.ts`. Any input decodes as v2, padded or truncated, so decoding stays total. Drop `develop.ts`'s karyotype-1 paths.
    3. Version handling:
       - `genesisFor` and `offspringPair` lose their `rules` parameter, since they always build for the live rules;
       - `checkGenesis`, `checkBirth` and `checkStored` answer `rules-retired` for any record with `rules < 8`;
       - `record.ts` keeps the `rules` field.
    4. Regenerate every remaining golden under rules 8 and list them in the PR. Update `.claude/rules/genome.md` (no frozen versions before v1.0, ADR 0040) and DESIGN §6.
  - Acceptance (tests first):
    - `npm run check` is green, and `git diff --stat` shows the frozen files gone.
    - A rules-7 genesis record and a rules-7 birth record get `rules-retired` from their checks.
    - Decoding stays total: the 10k random-bytes property, including 328-byte inputs, passes.
  - Notes: bodies don't change yet; T3 and T4 change them under rules 8 with no freeze. This task touches no worker table (T2 does).

- [x] T2 The world renewal: migration, protocol 6, the notice [opus] (in progress)
  - Done: migration 6 (a `(sql, now)` step, all migrations now in one transaction) empties the world and adds `world` and `players.epoch_seen`; `Ledger.takeRenewal` puts `renewed` on `life` once; the notice sits in the tagline's place (`state().renewed`).
  - Gotcha: the E2E entry's `POST /v1/e2e/pre-reset` stages a returning player; migration 5's own test now stops at `migrate(sql, 5)`, since 6 empties its rows.
  - Steps:
    1. A worker migration (the next number in `worker/schema.ts`), in one transaction:
       - `DELETE FROM creatures, records, commitments, matings, genesis_log` (there is no `creatures_v5` any more: migration 5 renamed it);
       - `UPDATE players SET pending = '', hatches = 3, hatch_t = 0`;
       - create the one-row table `world (epoch INTEGER, reset_at INTEGER)` with epoch 2 and the migration's time;
       - add `players.epoch_seen INTEGER NOT NULL DEFAULT 0`.
       Keep `players`, `keys`, `usage`, `flags`, `beacons` and `ponds`.
    2. `PROTOCOL_VERSION` 6. The `life` message carries `renewed: true` for an identity whose `first_seen` is earlier than `reset_at` and whose `epoch_seen` is below the epoch; the hub then sets `epoch_seen`. A new identity never gets it.
    3. The client shows the notice once, as a glass toast on the title screen: "The world was renewed in v0.7.2. Your identity is kept; your creatures start again." History lists only the new epoch.
  - Acceptance (tests first):
    - Workerd tests on a database populated with every table:
      - after the migration, identities, keys, usage and beacons survive;
      - creatures, records, commitments, matings and the genesis log are empty;
      - `pending` is empty and the bucket is full;
      - a second run is a no-op;
      - a returning identity gets `renewed` exactly once, and a new one never.
    - E2E (`m6c-reset.spec.ts`, hub 8804, using a debug hook that marks the seeded identity as pre-reset: `wrangler dev` always starts migrated):
      - the notice appears once and not after a reload;
      - a fresh genesis hatches under rules 8;
      - the identity's recovery code still imports.
  - Notes: the release notes and the Playtest issue say the world was renewed (the milestone step).

### Creatures that read as organisms (ADR 0041)

- [ ] T3 Parts by region, a visible-part budget, gated coils [opus]
  - Why: the Lab screenshot shows 10–20 equally weighted spokes, antennae mid-body and legs at the front. Development gives every module slot the same freedom, and the 24-instance cap is a collider budget, not a look budget.
  - Steps:
    1. Add `src/genome/organism.ts`:
       - `regionOf(part, plan)` → `head | trunk | rear`, from the attach start and angle;
       - the per-region rules of ADR 0041: long antennae ≤ 2.2 body lengths, short antennae ≤ 0.6, legs ≤ 0.9 body widths and swept back 25–70°, the tail structure ≤ 1.5 body lengths;
       - radial bodies: 5–9 spokes, lengths ±30% by a hash.
    2. In `develop.ts`, after placement and before repair:
       - clamp each part to its region;
       - apply the budget as ADR 0041 orders it: tail structure, long antenna pair, legs from the front, then the short antenna pair while room remains, with extras turned to fringe from the rearmost leg forward;
       - stop at 14 visible instances (a branch is part of its parent; the default ciliary band is fringe already).
       A part turned to fringe gets `fringe: true`; its stats count as cilia.
    3. Legs on a carapace root under the shell, so only their outer half shows.
    4. Coils (ADR 0041, amending 0038): curve mode coil needs a segmentation trait that gives at least 5 segments without the coil, and at most 2 leg pairs. Legs sit on the outer side of the curve. Otherwise the body takes the C-curl.
    5. Draw a fringe part as short, faint cilia: a seta-like stroke at most 0.3 body widths long. This lets the Lab be judged now; T6 refines it.
    6. Stats follow the geometry. Rerun the archetype tests and the tournament, keep the speed band (ADR 0036) and regenerate goldens.
  - Acceptance (unit tests first, extending the existing shared 10k random and 10k mutated plan cache rather than adding new 10k loops, so `npm run check` does not grow by more than about 5 s):
    - visible instances ≤ 14;
    - at most 2 head pairs, 6 trunk pairs and 1 rear structure;
    - each length and sweep within its region's range;
    - legs on a carapace start inside its outline;
    - radial spokes 5–9;
    - a coil only on genes that pass the gate, with legs outside the curve.
    - Hand-built plans:
      - a copepod with long antennae, 5 leg pairs and a furca keeps all 14 instances;
      - the same with a short antenna pair turns its rearmost leg pair into fringe;
      - a duplicate-heavy genome with 8 slots and 3 pairs each turns everything past 14 into fringe.
    - The archetype tests and the speed band hold.

- [ ] T4 Parts that curve, taper and vary [opus]
  - Why: parts are straight, evenly thin and exactly mirrored; branches fork like twigs; most tips end in a bright bead; setae are long straight fans. The result reads as rigging and lamps.
  - Steps:
    1. Every part tapers (tip width ≤ 40% of root) and carries a backward curvature bias: curvature ≥ 0.15 toward the tail for legs and tails, outward and back for antennae.
    2. Mirrored pairs get a hashed jitter (angle ±6°, length ±5%), and the beat phase is offset per side.
    3. Branches only on antennae (biramous) and tails, at most 0.5× the parent, fanning backward ≤ 35°. Elsewhere branching becomes a thicker part.
    4. Bulb tips only where the bulb gene exceeds 0.6, on at most one pair; everywhere else the tip tapers to a point.
    5. Setae at most 3× part width long, curved along the part's sweep, only on legs, antennae and tails, with at most 12 per part.
  - Acceptance (unit tests first, on the same shared plan cache):
    - each rule above holds as a property (tip-to-root width, curvature sign by region, branch rules, bulb instances ≤ 2, setae length and count);
    - T3's budget still holds.
  - Notes: geometry rules only; the mesh builder already draws curvature, taper and branches. Check the Lab by eye against references 02 and 03, and record in the PR what still reads as artificial.

- [ ] T5 The Lab shows evolved creatures; the gallery under rules 8 [opus]
  - Why: wild mode is uniform random bytes ("random genome bytes that show the extremes", `src/lab/specimens.ts`). No lineage reaches those without selection, yet the owner judges the creatures by it.
  - Steps:
    1. Replace `wildGenome` with `evolvedGrid(seed)`. It breeds 4 lineages of 6 deterministically:
       - each lineage starts from 6 genesis cells;
       - it runs 15 generations of random pairings at the Lab's ×4 mutation rate, with a cull of bodies with violations;
       - the grid shows each lineage's last generation (24 cells).
       Budget: ≤ 600 ms per grid on the CI runner (a test takes the best of 3).
    2. The mode button reads "Evolved"; "Genesis" stays.
    3. Gallery (ADR 0043):
       - rebuild the 12 silhouette specimens and 4 rarity specimens for rules 8 with `tools/specimen.ts`, each in its class's old cell;
       - baseline cells 01–06 keep their genesis genomes;
       - replace cells 07–20 with evolved picks.
    4. Replace the test "at least 8 silhouette classes in 9 of 10 seeds" with "at least 7 classes in 9 of 10 seeds" for Evolved mode (at most 3 seeds in `check`, the rest in `report:diversity`).
  - Acceptance:
    - The diversity test above holds, no cell has more than 14 visible instances, and every specimen is its class by `silhouetteOf`.
    - E2E: the mode button reads "Evolved", and the grid renders 24 valid bodies.
  - Notes: the owner's screenshot is the before. Say in the PR, in words, what reads as a creature now for the same seed and what still does not.

### The glass, the mouth, the organs (ADR 0043)

- [ ] T6 Pass 1's glass again; limbs of the same glass; a real mouth [opus]
  - Why, from `creature.frag.glsl` measured against the pass-1 shader (commit 11cf98c):
    - **"Fully see-through"**: M6b T3 cut the body's face to `uCore × (0.05 + 0.13z)` from `0.15 + 0.3z`, and swapped pass 1's soft fresnel rim (power 2 to 1.4 at ×1.8, which lit the glass inside its edge: the "hazy refraction" the owner liked) for a steep power-5 rim at ×5. The face is about 2.5× darker and the edge a hairline.
    - **"Gray limbs"**: a thin leg is painted `uRim × (0.25 + 0.4z)`, then capped at luminance 0.5 (`PART_LUMA`, M6b T4's overlap cap), while the body rim is ×5. A limb ends up at about a third of the rim's brightness.
    - **"Dark half-circle"**: the mouth (`kind == 3`) is painted near-black (`0.03`) inside a bright lip, over the whole mouth disc, which can cover half the front.
  - Steps:
    1. Body and plates: pass 1's face and soft fresnel rim (ADR 0043). Keep `RIM_MIN_PX` so slim bodies keep an edge. Add no haze layer.
    2. Limbs (`kind 1`), membranes and setae use the same face and rim model as the body. Set `PART_LUMA` to the body rim's peak luminance under that model rather than 0.5, so a single limb matches the body. Overlaps stay capped by it, and the solid-white test guards clipping.
    3. Mouth: paint the mouth disc as body glass (no dark fill). Add a small mouth feature at the front, spanning at most 35% of the body's width and sized by the mouth genes:
       - a filter mouth: a fringe of fine cilia round a narrow funnel;
       - a jaw: a pair of short mandibles.
    4. Fringe parts (T3) get their final look: fine, low-alpha cilia.
    5. `__gallery.state()` exports per-cell masks for face, limbs and mouth, so the metrics can read regions.
  - Acceptance (`look-metrics.ts` on the gallery):
    - cells 01–06 (the same genomes and round shapes as pass 1): the mean face-mask luminance is within ±15% of the same cells in `pass-1.png`;
    - per cell, the median limb-mask luminance over the body-rim luminance is 0.85–1.15;
    - per cell, the mouth-mask mean luminance is at least 0.8× the face-mask mean (no dark hole);
    - `m6b-clip.spec.ts` still passes (at most 12 solid-white pixels per cell).
  - Notes: compare with `pass-1.png` side by side, never from memory.

- [ ] T7 Organs in two related tones; eyes in the organ colour; a faint inner glow [opus]
  - Why: pass 6 shows several hues per body. The organ hue, the complementary accent, the amber oil droplets (`uOil`) and glint rays of either colour all add colours. The eyes are near-black cups with a faint organ-hue ring (0.15).
  - Steps (ADR 0043):
    1. `materialParams` gives the palette: the main colour plus one analogous second tone (0.04–0.10 turns away, another value).
       - The complementary accent goes.
       - Chambers alternate tones by a hash, droplets take the second tone, and glint rays use only the two.
       - Rarity raises saturation, glints and glow, never the spread.
    2. Faint glow: the heart, or the largest chamber, and at most one more organ glow inside their own outline. At most +15% luminance, or +35% with the luminescence gene.
    3. Eyes: the iris (0.45–0.82 of the eye's radius) takes the main colour at full saturation; the pupil stays dark and the highlight stays.
    4. Update `.claude/rules/render.md`'s pass-1 rule to match ADR 0043.
  - Acceptance:
    - `materialParams` property over 10,000 genomes: organ, droplet and glint colours fall within two hue clusters at most 0.10 turns apart.
    - Gallery:
      - per cell, organ-mask pixels fall into at most 2 hue clusters (k-means on hue, spread ≤ 0.1);
      - the eye-iris hue is within 0.05 of the main organ hue;
      - no organ-glow pixel lies more than 2 px outside its organ.

### Firefox

- [ ] T8 Firefox: no aliasing in the body, no flashing [opus]
  - Why: the owner's Firefox screenshot shows dotted white lines and a coarse cell pattern in the middle of a body, and bodies that "bug out / flash for a second when there are a lot of vertices". CI and the sessions only ever ran Chromium.
  - Likely causes, to confirm in this order:
    - **Sub-pixel lines drawn by derivatives**: the segment walls (`vWall` with `fwidth`, where the `floor` makes the derivative jump), the gut line and the setules are under a pixel wide, and Firefox's coarser derivatives turn them into dots.
    - **The cell texture** (`cells()`) fading in too early: `detailFade` measures pixels per core radius from `dFdx(vRest)`.
    - **Precision**: the hash noise needs `highp` in the fragment shader.
    - **The flash**:
      - the LOD swap in `creature-view.ts` calls `release()` before `acquire()`, so a 12,000-vertex rebuild can leave a frame without a body;
      - or the transparency order of the merged mesh's parts flips.
  - Steps:
    1. Add a `firefox` Playwright project (Firefox, `m6c-firefox.spec.ts` only) and a `firefox` part to `e2e-full.yml`, which installs Firefox in that job only (`npx playwright install --with-deps firefox`). PR CI stays Chromium.
    2. Reproduce:
       - after the first push, dispatch `E2E full` on the branch (`gh api -X POST repos/Resner/Biosphere/actions/workflows/e2e-full.yml/dispatches -f ref=<branch>`) for screenshots and traces;
       - in the session, install Firefox to a scratch path if the network allows (`PLAYWRIGHT_BROWSERS_PATH=<scratch> npx playwright install firefox`; never `/opt/pw-browsers`);
       - toggle each detail (walls, cells, pores, gut, setules) via a debug uniform to find the source.
    3. Fix: fade any feature narrower than 1.5 px instead of drawing it; derive wall lines from a continuous varying (no `floor` before `fwidth`); start the cell texture at ≥ 6 px per cell; use `precision highp float`.
    4. Flash: acquire the new LOD's geometry before releasing the old one, swap on the next frame, and keep part order stable in the merged mesh.
  - Acceptance:
    - `m6c-firefox.spec.ts` on Firefox (in `E2E full`):
      - no WebGL warnings beyond an allowlist of three.js's known texture-upload notices (listed in the spec);
      - the high-frequency energy inside a body (a Laplacian over the face mask) is within 1.3× Chromium's for the same cell.
    - `m6c-flash.spec.ts` (`@slow`, Chromium and Firefox): over 240 frames while zooming across the LOD threshold with 24 remotes, no frame loses more than 20% of a body's pixels against its neighbours.
    - (owner) The artefacts are gone on the owner's own Firefox and GPU; CI renders through Mesa and may not show every driver artefact.

### Play polish

- [ ] T9 Damage lands as hits, in intervals [opus]
  - Why: `src/render/shake.ts` gives UV a constant 23–31 Hz tremble and pressure a continuous squeeze, at most 0.06 body radii and 1.5 camera pixels, so damage reads as a faint rumble. The owner wants distinct hits at intervals, "kinda how you take damage in Minecraft".
  - Steps:
    1. `Shake.hit(cause, amount)`: the damage event's amount is passed along. Replace the continuous UV and pressure shakes with a hit pulse:
       - while damage arrives, at most one hit every 0.5 s, the first at once;
       - each hit kicks the camera 5–8 px (scaled by the damage since the last hit), decaying over 0.25 s;
       - the body jolts 0.15 radii;
       - the hurt tint flashes 0.15 s;
       - the `hurt` cue plays.
       Between hits everything is still.
    2. Every cause shares the cadence. The kick direction turns by the golden angle per hit.
    3. Reduce motion keeps the flash and the sound, and drops the kicks.
    4. `state().shake` gains `hits` (the count since hatching).
  - Acceptance (unit tests on `Shake` with synthetic damage):
    - 3.0 s of steady UV damage (hits at 0, 0.5, …, 2.5; one at exactly 3.0 does not count) gives 6 hits, with zero offset 0.45 s after each;
    - the kick scales with damage and is capped at 8 px;
    - reduce motion gives zero offset.
    - E2E: in the shallows with UV tolerance 0, `state().shake.hits` rises by 2 ± 1 per second of sim time, and the camera offset peaks at ≥ 5 px.

- [ ] T10 Sunlight strongest in the shallows [opus]
  - Why: in `src/render/zones.ts` the shallows' caustics are 0.4 and rays 0.25 (M6b T8, after v0.7.0's "a little too many effects"), but the twilight's top is 1.0 and 0.8. `sunlight(depth, key)` therefore jumps up just below the shallows, and the light peaks in the upper twilight. The owner wants it "slightly more prominent" in the shallows.
  - Steps:
    1. Sunlight falls monotonically with depth:
       - shallows: caustics 0.55, rays 0.4;
       - the twilight's top takes the same values, then fades as now (`TWILIGHT_SUN` share at its floor);
       - none in the deep.
    2. Keep M6b T8's slower pace in the shallows, so they are brighter but calm.
    3. A requirement change from the owner, not a loosening: retarget `m6b-water.spec.ts`'s bounds:
       - shallows caustic `≤ 0.4` → 0.5–0.65;
       - shallows rays `≤ 0.5` → 0.35–0.5;
       - the twilight's caustic and rays, compared to main's 0.2877 and 0.2302, → below the shallows' and at least 0.1;
       - the shallows' change and spread bounds stay.
    4. Update DESIGN §2 (sunlight).
  - Acceptance:
    - `sunlight(depth, key)` is non-increasing in depth (a property over 1,000 samples per key), and the shallows equal the twilight's top;
    - the retargeted `m6b-water.spec.ts` passes.

- [ ] T11 The egg reveal: a still scene, and clicks that matter [opus]
  - Why:
    - After a death the camera keeps following the dissolving body's drift and zoom, and the water animates, so the background moves behind the egg. The owner wants it static.
    - A poke (`EggReveal.poke(now)`) only gives a damped wobble, so the owner asks for clicks that "feel meaningful … increasing the luck. Maximize the gacha".
  - Honesty rule: the child is fixed by the committed drand round (ADR 0010). Nothing on screen may claim that clicking changes the outcome. Clicking charges the show and uncovers the result sooner: meaningful, and true.
  - Steps:
    1. **Still scene**: from the reveal's start until the card closes:
       - the camera is locked on the egg (no pan, no zoom);
       - the water, snow, caustics and god rays hold their frame (their clock pauses; the sim does not);
       - the background dims 35% with the DOF blur;
       - other creatures are drawn dimmed;
       - the HUD hides.
    2. **Charge**: each click (or Space on the title or death screen; in play Space dashes) adds charge, diminishing, full after about 12 pokes. Each poke gives:
       - a sharper wobble;
       - a crack that grows;
       - sparks;
       - a rising tick (the egg voice, pitch by charge);
       - a charge ring.
       Charge builds from the reveal's start until the crack, before and after the beacon.
    3. **The rarity hint**:
       - before the beacon, the hint colour cycles through the tier colours;
       - once the beacon is in, it settles on the true tier, and more charge shows it stronger.
    4. **A player-paced crack**: after the beacon, the egg waits up to 6 s for the player to crack it (3 quick pokes, or holding the button for 0.6 s), then auto-cracks.
       - The burst scales with rarity and charge (full charge adds a shockwave and a slow-motion beat).
       - The result card rolls its stars.
       - Hatching a carried child gets the same paced crack, so it has time to charge too.
    5. Reduced motion: no shake or slow motion; fades and the colour reveal only.
  - Acceptance:
    - Unit tests: charge is monotone and capped; the auto-crack fires 6 s after the beacon; the hint settles on the true tier after the beacon; reduced motion has no shake.
    - E2E (`m6c-egg.spec.ts`, hub 8805):
      - after a death while moving, a background patch away from creatures is unchanged (mean difference < 1 level) over 2 s of the reveal;
      - 12 pokes during the paced crack raise `state().egg.charge` to 1;
      - with no input, the egg auto-cracks within 6.5 s of the beacon;
      - the result card's tier equals the recorded child's.

- [ ] T12 Minimap: smooth, and a depth gauge that reads as depth [opus]
  - Why:
    - The minimap redraws at most 10 times a second (`MINIMAP.hz`), so the player arrow steps when turning fast.
    - The depth marker is a white dot on the arc inside the rim (`arcR = half − 5`), which the owner read as a player or ping (minimap screenshot).
  - Steps:
    1. Draw the player arrow on its own small layer every frame (a CSS-transformed element over the canvas), and the map at 30 Hz. Allocate nothing.
    2. Depth:
       - remove the arc and its dot;
       - add a separate slim vertical depth gauge, a DOM element left of the map, with zone bands from top to bottom, a chevron "◂" marker and the depth as "12 m" (depth × a fixed scale, documented in DESIGN §9);
       - the zone name stays under the map, and the gauge has `title="Depth"`;
       - move the UV and pressure icons next to the gauge.
    3. `minimap.info()` reports what each draw painted (`marks: { players, pings }`) and confirms the canvas draws no other round mark.
  - Acceptance:
    - Unit test: the arrow's angle equals the heading within 1° on every frame of a 1 s fast turn (synthetic frames).
    - E2E (`m6c-minimap.spec.ts`):
      - the arrow element's rotation follows a scripted turn frame by frame;
      - the canvas draws at most 31 times a second;
      - the gauge's marker moves down as the player dives;
      - with no other players and no pings, `minimap.info().marks` is empty.
    - Keep `m6b-minimap.spec.ts`'s one-frame reads (#213 fixed two flakes there: the radius against the half-height, and the ping's bearing against A's drifted position). The new arrow layer must not reintroduce a read across frames.

### Closing

- [ ] T13 One look sheet under rules 8 [opus]
  - Steps:
    1. Render `npm run gallery -- --pass 7` once.
    2. Write `pass-7.md`: an honest comparison with `pass-1.png` and references 02–05, covering each owner point in the table above in a sentence, including what is still not right. Do not fix in a series; fix only what clearly breaks a T3–T7 acceptance.
    3. Update the render rules' "pass-6 is the only one" line to name pass 7.
  - Acceptance: the sheet and note are committed, and the T6 and T7 metrics pass on it.

- [ ] T14 End-to-end scenario, owner checks, documentation sync
  - Steps:
    1. `m6c-lifecycle.spec.ts` (`@slow`, hub 8806):
       - the renewed-world notice;
       - a genesis with a charged, paced reveal;
       - a dive from the shallows with UV hits at the T9 cadence;
       - the minimap gauge;
       - a mating and a hatch.
       It follows `.claude/rules/tests.md`'s determinism rules, and CI repeats it 3 times before merge (ADR 0042).
    2. Sync DESIGN §2, §4–§6, §9 and §10, the rules files and `docs/art/README.md`.
  - Acceptance: every owner point in the table maps to a named test or the T13 note. The PR E2E suite stays near `tests.md`'s 3 minutes; new long scenarios are `@slow`.

## Rubric

- [ ] Bodies read as plankton: no Evolved-mode cell has more than 14 visible parts; antennae, legs and tail are distinguishable (evidence: T3–T5 tests and the T13 sheet).
- [ ] Glass like pass 1: cells 01–06 face luminance within ±15% of pass 1, limbs matching the body rim (evidence: T6 metrics).
- [ ] At most two related organ tones per body, eyes in the main colour (evidence: T7 metrics).
- [ ] Nothing clips to white, and nothing allocates per frame (evidence: `m6b-clip`, the budget spec).
- [ ] Firefox draws bodies cleanly and without flashes in CI (evidence: `m6c-firefox`, `m6c-flash`).
- [ ] (owner) The creatures look like real, organic micro-organisms in the Lab and in play.
- [ ] (owner) Firefox shows no aliasing or flashing on the owner's machine.
- [ ] (owner) Damage feels like distinct hits; the shallows' sunlight looks right.
- [ ] (owner) The egg reveal is exciting, and clicking feels meaningful.
- [ ] (owner) The minimap is smooth, and the depth gauge is obvious.

## Risks

- **The reset loses the owner's and friends' creatures.** The owner accepted it. The notice is explicit, and identities and recovery codes survive (T2).
- **Retiring the freezes breaks an importer.** T1 lists every entangled file, and `npm run check` must stay green before anything is deleted.
- **Region rules make bodies samey.** Diversity is checked: at least 7 classes in Evolved mode (T5), with the silhouette histogram in `report:diversity`.
- **Pass 1's face brings back the milky look the owner disliked in passes 2–5.** The metric pins pass 1's values on cells 01–06 (±15%), and the no-haze rule stays (T6, ADR 0043).
- **Firefox cannot be installed in a cloud session.** `E2E full` installs it on its own runner, and the task dispatches it on its branch (T8).
- **Gacha pressure.** Clicking never claims to change the result: it charges the show and reveals the true tier sooner (T11).
- **New scenarios flake at release.** They follow the determinism rules and are repeated in PR CI (ADR 0042).
