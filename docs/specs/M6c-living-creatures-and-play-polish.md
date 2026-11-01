# M6c: Living creatures and play polish

Release: v0.7.2 · Gate: yes

## Goal

M6c answers the owner's Playtest v0.7.1 feedback (#212). The owner gave it in a Claude session on 2026-11-01, with screenshots of the Creature Lab, the minimap and a creature in Firefox. Every point below quotes it.

- **Creatures look like real, organic plankton**, not spaceships. Each body has one pair of long antennae, a few short swept-back legs and one tail structure. Parts curve and taper. Bodies are glass with pass 1's soft, 3D sheen rather than fully see-through shells. Limbs are the same glass as the body, the mouth reads as a mouth, and the organs and eyes keep to one or two related colours.
- **The play screen feels better**:
  - damage lands as distinct hits, not a rumble;
  - the sunlight is strongest in the shallows;
  - the egg reveal holds a still scene and rewards clicking;
  - the minimap turns smoothly, and its depth marker can't be mistaken for a player;
  - Firefox draws creatures cleanly.
- **The world is renewed once** (ADR 0040). Rules 8 resets the ledger and drops every frozen version, so the body work above needs no freeze.

ADR 0041 sets how bodies read as organisms, and ADR 0040 the reset. ADR 0034's method still holds: pass 1 is the realism baseline, and the look is judged in one sheet, not a pass series. The render rules (`.claude/rules/render.md`) still hold: nothing clips to white, and nothing allocates per frame.

This milestone is a **gate**. After v0.7.2 the factory waits for the owner's reply on the `Playtest: v0.7.2` issue before M7 starts.

## Owner feedback → tasks

| Owner point (2026-11-01) | Task |
|---|---|
| "Is the genesis freeze really necessary … complete wipe is fine" | T1 |
| "Most of the creatures in the creature lab don't look like real, organic creatures (… 20 antennas or limbs … spaceship) … be very honest about the pitfalls" | T2, T3, T4 |
| "Some creatures in pass-6 seem to be curled up – intended?" | T2 (yes: the coil silhouette of #90, now gated so it reads as a spiral) |
| "Very visible white silhouettes/bodies, but their limbs are gray and look like a foreign body (… while still preventing clipping)" | T5 |
| "Weird dark unfilled half-circle part in front of every creature – is that the mouth?" | T5 (yes: redrawn as a mouth) |
| "You made the creatures fully see-through instead of opaque like in pass-1" | T5 |
| "Organs not looking like in pass 1 (maximum two-color organs …) – you can make some of them glow ever so slightly" | T6 |
| "Align eye colors to the main organ color" | T6 |
| "Weird aliasing … on firefox in the center of the creature … sometimes they bug out / flash" | T7 |
| "Make the creature shake when damaged more visible … shakes in intervals – kinda how you take damage in Minecraft" | T8 |
| "Make the Caustics and Godrays slightly more prominent in shallow water" | T9 |
| "The background should be static and not move during the egg hatch" | T10 |
| "Make the Egg Reveal even more interactive and exciting … Maximize the Gacha" | T10 |
| "Refresh rate of the mini-map should be higher – arrow looks choppy" | T11 |
| "Mini-map shows a white dot on the border … I thought this was a player / ping indicator … rework this" | T11 |

## Out of scope

- **Combat**, predators eating eggs, kills as growth (M7).
- **New karyotype loci.** Rules 8 reshapes development from the existing v2 loci. Max biomass, growth and lifespan stay the same per genome.
- **Look pass series.** One sheet in T12 (ADR 0034); the owner judges at the gate.
- **New sounds**, beyond the hit cue cadence (T8) and the egg's charge ticks (T10), which reuse existing voices.
- **Touch controls.**

## Touches

- **Changed**:
  - genome: `src/genome/{develop,stats,genesis,silhouette,rarity,names,describe,karyotype,codec,inherit,offspring}.ts`;
  - ledger and worker: `src/ledger/{genesis,mating}.ts`, `worker/{schema,authority,ledger}.ts`;
  - net: `src/net/protocol.ts` (version 6);
  - render: `src/render/{creature-mesh,material-params,anatomy,shake,zones,egg,creature-cache}.ts` and `src/render/shaders/{creature,water,godrays,caustics,egg}.*`;
  - game: `src/game/{app,eggs,minimap,history,lineage-view,screens,debug}.ts`;
  - lab and tests: `src/lab/specimens.ts`, `tests/e2e/look-metrics.ts`, `playwright.config.ts`, `package.json` (`e2e:setup` installs Firefox in CI);
  - docs: DESIGN §4–§6, §9, §10.
- **Removed** (T1): `src/genome/{karyotype-v1,develop-v5,stats-v5,inherit-v5,genesis-v5,genesis-v6,genesis-v7}.ts`, their tests and the `-vN` goldens.
- **New**: `tests/e2e/m6c-*.spec.ts`, `src/genome/organism.ts` (region rules, ADR 0041), and the `look:firefox` Playwright project.

## Tasks

### The reset

- [ ] T1 World reset and rules 8: retire every frozen version (ADR 0040) [opus]
  - Why: the owner allowed a wipe. Freezes cost about 1,700 lines, eleven goldens and a step in every body task, and nothing verifies old versions before M9.
  - Steps:
    1. `RULES_VERSION` = 8. Delete the frozen files listed under Touches, their tests and every `-vN` golden. Remove version dispatch:
       - `genesisFor(randomness, id, rules)` and `checkGenesis`/`checkBirth`/`offspringPair` accept only rules 8 and return `rules-retired` otherwise;
       - karyotype v1 handling goes (any input decodes as v2, padded or truncated; decoding stays total).
    2. Worker migration (next number in `worker/schema.ts`), in one transaction:
       - delete all rows of `creatures`, `creatures_v5`, `records`, `commitments`, `matings` and `genesis_log`, plus cached checkpoints;
       - keep `players`, `keys`, `usage`, `flags`, `beacons` and `ponds`;
       - set `world_epoch` (a new one-row table) to 2.
       A test runs it on a populated database: identities and the usage meter survive, everything else is empty, and a second run is a no-op.
    3. `PROTOCOL_VERSION` 6, with `world` in the `life` message. A client whose stored epoch differs shows once: "The world was renewed in v0.7.2. Your identity is kept; your creatures start again." It stores the new epoch, and History lists only the new epoch.
    4. Regenerate every remaining golden under rules 8, listing them in the PR. Update `.claude/rules/genome.md` (no frozen versions before v1.0, ADR 0040) and DESIGN §5 and §6.
  - Acceptance:
    - `npm run check` is green with the frozen files gone (`git diff --stat` shows the deletions).
    - A rules-7 genesis record is answered `rules-retired`.
    - E2E (`m6c-reset.spec.ts`, its own hub): an identity with a pre-reset creature in local storage reconnects, sees the notice once, hatches a fresh rules-8 genesis, and its recovery code still imports.
  - Notes: no development change yet. T2 and T3 change bodies under rules 8 with no freeze.

### Creatures that read as organisms (ADR 0041)

- [ ] T2 Parts by region and a visible-part budget [opus]
  - Why: the Lab screenshot shows 10–20 equally weighted spokes, antennae mid-body and legs at the front. Development gives every module slot the same freedom, and the 24-instance cap is a collider budget, not a look budget.
  - Steps:
    1. Add `src/genome/organism.ts`: `regionOf(part, plan)` → `head | trunk | rear` from the attach start and angle (ADR 0041), and the per-region rules: counts, length ranges in body lengths or widths, sweep angles.
    2. In `develop.ts`, after placement and before repair:
       - clamp each part to its region's length and sweep;
       - keep at most one long antenna pair and one short pair at the head, 6 leg pairs in the trunk, and one tail structure at the rear.
       Parts beyond a region's count, or beyond 14 visible instances, become a ciliary fringe on their segment (`fringe: true`, drawn as fine cilia by T5, counted in stats as cilia).
    3. Radial bodies: 5–9 spokes, lengths ±30% by a hash, and drape bends them rearward.
    4. Coils (the owner asked whether "curled up" is intended: it is, as the nautilus and curled worm of #90): curve mode coil needs at least 5 segments and at most 2 leg pairs, with legs on the outer side. Otherwise the body takes the C-curl.
    5. Stats follow the new geometry (a fringe is cilia). Rerun the archetype tests and the tournament, keep the speed band (ADR 0036) and regenerate goldens.
  - Acceptance (unit tests first):
    - Over 10,000 random and 10,000 mutated genomes:
      - visible instances ≤ 14;
      - at most 2 head pairs, 6 trunk pairs and 1 rear structure;
      - antennae ≤ 2.2 body lengths, legs ≤ 0.9 body widths, every leg swept back 25–70°;
      - radial spokes 5–9;
      - every coil has ≥ 5 segments and ≤ 2 leg pairs.
      Caps, bounds and repair hold as before.
    - Hand-built plans: a copepod keeps its antennae, 5 leg pairs and furca; a 4-module duplicate-heavy genome turns its extras into fringe.
    - The archetype tests and the speed band hold.

- [ ] T3 Parts that curve, taper and vary [opus]
  - Why: parts are straight, evenly thin and exactly mirrored; branches fork like twigs; most tips end in a bright bead; setae are long straight fans. The result reads as rigging and lamps.
  - Steps:
    1. Every part tapers (tip width ≤ 40% of root) and carries a backward curvature bias (curvature ≥ 0.15 toward the tail for legs and tails, outward-and-back for antennae).
    2. Mirrored pairs get a hashed jitter (angle ±6°, length ±5%), and the beat phase is offset per side.
    3. Branches only on antennae (biramous) and tails, at most 0.5× the parent, fanning backward ≤ 35°. Elsewhere branching becomes a thicker part.
    4. Bulb tips only where the bulb gene exceeds 0.6, on at most one pair; everywhere else the tip tapers to a point.
    5. Setae at most 3× part width long, curved along the part's sweep, and only on legs, antennae and tails, with at most 12 per part.
  - Acceptance (unit tests first): property tests over 10,000 genomes for each rule above (tip-to-root width, curvature sign by region, branch rules, bulb count ≤ 2 instances, setae length and count), and the visible-part budget of T2 still holds.
  - Notes: geometry rules only; the mesh builder already draws curvature, taper and branches. Check the Lab by eye against references 02 and 03 and record what still reads as artificial in the PR.

- [ ] T4 The Lab shows evolved creatures; the gallery under rules 8 [opus]
  - Why: wild mode is uniform random bytes ("random genome bytes that show the extremes", `src/lab/specimens.ts`). No lineage reaches those without selection, yet the owner judges the creatures by it.
  - Steps:
    1. Replace `wildGenome` with `evolvedGenome(seed)`. It breeds a lineage deterministically: 12 genesis cells, then 10–30 generations (from the seed) of random pairings, mutation at the Lab's ×4 rate, and a culling step that drops bodies with violations. It returns one descendant. Keep it under 30 ms per creature (a test).
    2. Rename the mode in the UI to "Evolved". Keep "Genesis".
    3. Regenerate the gallery specimens under rules 8 with `tools/specimen.ts` (the same 12 silhouette classes plus 4 rarity tiers), and the baseline cells as genesis and evolved picks.
  - Acceptance:
    - Over 10 Lab seeds, evolved mode shows at least 7 silhouette classes in 24 cells, and no cell has more than 14 visible parts.
    - E2E: the Lab's mode button reads "Evolved", and the grid renders 24 valid bodies.
  - Notes: the owner's screenshot is the before. Attach an Evolved-mode screenshot of the same seed to the PR description in words: what reads as a creature now, and what still does not.

### The glass, the mouth, the organs

- [ ] T5 Pass 1's glass again; limbs of the same glass; a real mouth [opus]
  - Why, from `creature.frag.glsl`, measured against M6 T14's pass-1 shader (commit 11cf98c):
    - **"Fully see-through"**: M6b T3 cut the body's face to `uCore × (0.05 + 0.13z)` from pass 1's `0.15 + 0.3z`, and swapped pass 1's soft fresnel rim (`fres^2 × 1.8`, which lit the glass inside its edge: the "hazy refraction" the owner liked) for a steep `^5` rim at ×5. The face is about 2.5× darker and the edge a hairline, so bodies read as hollow outlines.
    - **"Gray limbs"**: a thin leg is painted `uRim × (0.25 + 0.4z)` and then capped at luminance 0.5 (`PART_LUMA`), while the body rim is ×5. Limbs end up at about a third of the body's brightness, in a flat grey.
    - **"Dark half-circle"**: the mouth (`kind == 3`) is painted near-black (`0.03`) inside a bright lip over the whole mouth disc, which can cover half the front.
  - Steps:
    1. Body and plates: restore pass 1's face (`0.15 + 0.3z` core) and its soft fresnel rim (power 2–1.4 by membrane, ×1.8). Keep M6b's no-haze rule: no added milky layer, no organ halos. Keep `RIM_MIN_PX` so slim bodies keep an edge.
    2. Limbs (`kind 1`), membranes and setae: the same glass model as the body (face, soft fresnel edge, the same `uRim`), so a leg's edge and the body's edge sit within ±15% luminance. Replace the fixed `PART_LUMA` cap with the overlap cap of M6b T4, applied after blending: keep the solid-white test as the guard.
    3. Mouth:
       - draw the mouth disc as body glass (pass 1's milky warm lip, no dark fill);
       - add a small mouth feature at the front: a filter mouth gets a fringe of fine cilia round a narrow funnel, a jaw a pair of short mandibles;
       - the feature spans at most 35% of the body's width, and its size still follows the mouth genes (gameplay stays readable).
    4. The T2 fringe parts draw as fine cilia: thin, short, low alpha.
  - Acceptance:
    - Gallery measurements (`look-metrics.ts`): the mean body-face luminance and alpha of the 20 baseline cells are within ±15% of pass 1's (sampled from `pass-1.png` at the same cell positions).
    - The median limb-edge luminance over body-rim luminance is 0.85–1.15 per specimen.
    - No mouth region has more than 10% of its pixels below luminance 0.05.
    - `m6b-clip.spec.ts` still passes (at most 12 solid-white pixels per cell).
  - Notes: compare with `pass-1.png` side by side, never from memory (render rules).

- [ ] T6 Organs in one or two related colours; eyes in the organ colour; a faint inner glow [opus]
  - Why: pass 6 shows several hues per body (red, yellow, cyan and violet in cell 14). The organ hue, the complementary accent, the amber oil droplets (`uOil`), and glints coloured from either all add colours. The owner wants "maximum two-color organs … similar colors with different hues/tones". The eyes are near-black cups with a faint organ-hue ring at 0.15.
  - Steps:
    1. `materialParams` gives a palette of two colours:
       - the main organ colour (gene hue);
       - a second tone, either analogous (hue ±0.04–0.10 turns, different value) or, for rare and above, complementary.
       Chambers alternate tones by a hash; droplets take the second tone instead of fixed amber; glint rays use only these two colours.
    2. Slight glow: 1–2 organs per body (the heart, or the largest chamber) gain a soft inner emission at most +15% luminance, with no halo outside the organ. Luminescent genes raise it to +35%.
    3. Eyes: the iris takes the main organ colour at full saturation (a ring 0.45–0.82 of the eye radius), the pupil stays dark, and the highlight stays.
  - Acceptance:
    - `materialParams` property: every genome's organ, droplet and glint colours fall within 2 hue clusters (≤ 0.10 turns apart within a cluster).
    - Gallery: the organ pixels of each cell fall into at most 2 hue clusters (k-means on hue, cluster spread ≤ 0.1). Eye iris hue is within 0.05 of the main organ hue. No organ glow pixel lies outside its organ by more than 2 px.

### Firefox

- [ ] T7 Firefox: no aliasing in the body, no flashing [opus]
  - Why: the owner's Firefox screenshot shows dotted white lines and a coarse cell pattern in the middle of a body, and bodies that "bug out / flash for a second when there are a lot of vertices". CI and the sessions run Chromium only, so nothing has ever checked Firefox.
  - Likely causes, to confirm in this order:
    - **Sub-pixel lines drawn by derivatives**: the segment walls (`vWall` with `fwidth`, where `vWall`'s floor makes the derivative jump), the gut line and the setules are under a pixel wide, and Firefox's coarser derivatives turn them into dots.
    - **The cell texture (`cells()`)** fading in too early: `detailFade` measures pixels per core radius from `dFdx(vRest)`.
    - **Precision**: the hash noise needs `highp` in the fragment shader.
    - **The flash**: an LOD switch builds a new 12,000-vertex geometry while the old one is released (one frame without a body), or a transparency-order flip of the merged mesh's parts.
  - Steps:
    1. Add a `look:firefox` Playwright project (Firefox, only `m6c-firefox.spec.ts`) to `test:e2e:full`. `e2e:setup` installs Firefox in CI. In a cloud session, install it to a scratch path (`PLAYWRIGHT_BROWSERS_PATH=<scratch> npx playwright install firefox`, never `/opt/pw-browsers`). If that download is blocked, work from CI artefacts (screenshots and traces uploaded on failure).
    2. Reproduce:
       - render the gallery's crab and copepod cells in Firefox at 2× zoom;
       - log WebGL warnings from the console;
       - toggle each detail (walls, cells, pores, gut, setules) via a debug uniform to find the source.
    3. Fix: fade any feature narrower than 1.5 px instead of drawing it; derive wall lines from a continuous varying (no `floor` before `fwidth`); start the cell texture at ≥ 6 px per cell; `precision highp float`.
    4. Flash: keep the old LOD's geometry until the new one is uploaded (swap on the next frame), and keep part order stable in the merged mesh. Test by sampling 240 frames while zooming across the LOD threshold.
  - Acceptance:
    - `m6c-firefox.spec.ts` on Firefox:
      - no WebGL warnings;
      - the high-frequency energy inside a body (a Laplacian filter over the body face) is within 1.3× Chromium's for the same cell;
      - over 240 frames while zooming across the LOD threshold with 24 remotes, no frame loses more than 20% of a body's pixel count against its neighbours.
    - The same spec passes on Chromium.

### Play polish

- [ ] T8 Damage lands as hits, in intervals [opus]
  - Why: `src/render/shake.ts` gives UV a constant 23–31 Hz tremble and pressure a continuous squeeze, at most 0.06 body radii and 1.5 camera pixels, so damage reads as a faint rumble. The owner wants distinct hits at intervals, "kinda how you take damage in Minecraft".
  - Steps:
    1. Replace the continuous UV and pressure shakes with a hit pulse:
       - while any damage is taken, at most one hit every 0.5 s, the first at once;
       - each hit kicks the camera 5–8 px (by the damage taken since the last hit), decaying over 0.25 s;
       - the body jolts 0.15 radii;
       - the existing hurt tint flashes 0.15 s;
       - the `hurt` cue plays.
       Between hits everything is still.
    2. Toxin, starvation, UV and pressure share the cadence, and the kick direction turns by the golden angle per hit.
    3. Reduce motion keeps the flash and the sound, and drops the kicks.
  - Acceptance (unit tests on `Shake` with synthetic damage):
    - 3 s of steady UV damage gives 6 hits 0.5 s apart, with zero offset at 0.45 s after each hit;
    - the kick scales with damage and is capped at 8 px;
    - reduce motion gives zero offset.
    - E2E: in the shallows with UV tolerance 0, `state()` shows the hit count rising about twice a second and the camera offset peaking at ≥ 5 px.

- [ ] T9 Sunlight strongest in the shallows [opus]
  - Why: M6b T8 calmed the shallows by setting their caustics to 0.4 and god rays to 0.25, below the twilight's top (1.0 and 0.8) in `src/render/zones.ts`, so the light now peaks in the twilight. The owner wants it slightly more prominent near the surface, without undoing the calm (v0.7.0: "a little too many effects").
  - Steps:
    1. Make sunlight fall monotonically with depth:
       - shallows: caustics 0.75, rays 0.55;
       - twilight top: caustics 0.55, rays 0.4, fading to 0.15 at its floor;
       - none in the deep.
    2. Keep T8's slower pace in the shallows, so the shallows are brighter but calm.
  - Acceptance:
    - `sunlight(depth)` is non-increasing in depth (a property over 1,000 samples), and the shallows exceed the twilight top by ≥ 25%.
    - Screenshots: the open-water caustic contrast in the shallows is ≥ 1.25× the twilight's.
    - `m6b-water.spec.ts`'s calm checks still pass.

- [ ] T10 The egg reveal: a still scene, and clicks that matter [opus]
  - Why:
    - After a death the camera keeps following the dissolving body's drift and zoom, so the water slides behind the egg. The owner wants it static.
    - Clicking only gives a damped wobble (`EggReveal.click`), so the owner asks for clicks that "feel meaningful … increasing the luck. Maximize the gacha".
  - Honesty rule: the child is fixed by the committed drand round (ADR 0010). Clicking must not claim to change the outcome. It charges the show and uncovers the result sooner, which is meaningful without being a lie.
  - Steps:
    1. **Still scene**: from the reveal's start until the card closes:
       - the camera is locked (no pan or zoom) on the egg;
       - the background dims 35% and takes the DOF blur;
       - ambient motion (snow, caustics) slows to 20%;
       - other creatures are drawn dimmed;
       - nothing in the sim pauses.
    2. **Charge**: each click or Space while waiting adds charge (diminishing, full after about 12 taps).
       - Each tap gives a sharper wobble, a crack that grows, sparks, a rising tick (the existing egg voice, pitch by charge) and a charge ring.
       - The shell clears with charge, so the rarity's colour shows through earlier and stronger: a true hint, since the tier is known once the beacon arrives. Before the beacon, the hint cycles through tier colours and settles on the true one when the beacon lands.
    3. **Player-paced crack**: once the beacon is in, the egg waits up to 6 s for the player to "crack" it (3 quick taps, or hold Space for 0.6 s), then auto-cracks.
       - The burst scales with rarity and with charge (a fully charged egg adds a shockwave and a slow-motion beat).
       - The result card shows the tier with a star roll.
    4. Reduced motion: no shake or slow-motion; fades and the colour reveal only.
  - Acceptance:
    - Unit tests: charge is monotone and capped; the auto-crack fires at 6 s; the hint settles on the true tier after the beacon; reduced motion has no shake.
    - E2E (`m6c-egg.spec.ts`):
      - after a death while moving, the water texture under the egg is unchanged (mean difference < 1 level) over 2 s of the reveal;
      - 12 taps raise `state().egg.charge` to 1;
      - pressing nothing auto-cracks within 6.5 s of the beacon;
      - the result card's tier equals the recorded child's.

- [ ] T11 Minimap: smooth, and a depth marker that reads as depth [opus]
  - Why:
    - The minimap redraws at most 10 times a second (`MINIMAP.hz`), so the player arrow steps when turning fast.
    - The depth marker is a white dot on the rim's arc, outside the map, where the owner read it as a player or ping (minimap screenshot).
  - Steps:
    1. Draw the player arrow on its own small layer every frame (a CSS-transformed element, or a second canvas), and the map at 30 Hz. Allocate nothing.
    2. Depth:
       - replace the dot on the arc with a separate slim vertical depth gauge beside the map (left of it): zone bands from top to bottom and a chevron "◂" marker with the depth in metres-like units ("12 m");
       - the zone name stays under the map;
       - no round marker appears anywhere except players and pings;
       - the gauge has a `title` ("Depth").
    3. The UV and pressure icons move next to the gauge.
  - Acceptance:
    - Unit test: the arrow's drawn angle equals the heading within 1° on every frame of a 1 s fast turn (synthetic frames).
    - E2E (`m6c-minimap.spec.ts`): the arrow element's rotation follows a scripted turn frame by frame, the minimap canvas draws ≤ 31 times a second, the gauge marker moves down as the player dives, and no circular mark is drawn outside the map's circle.
    - The minimap still costs nothing per frame in the allocation check.

### Closing

- [ ] T12 One look sheet under rules 8 [opus]
  - Steps:
    1. Render `npm run gallery -- --pass 7` once.
    2. Write `pass-7.md`: an honest comparison with `pass-1.png` and references 02–05, covering every owner point in the table above with a sentence each, including what is still not right. Do not fix in a series: fix only what clearly breaks a T2–T6 acceptance.
    3. Update the render rules' "pass-6 is the only one" line to name pass 7.
  - Acceptance: the sheet and note are committed, and the look metrics of T5 and T6 pass on it.

- [ ] T13 End-to-end scenario, owner checks, documentation sync
  - Steps:
    1. `m6c-lifecycle.spec.ts` (`@slow`, release gate):
       - a renewed-world notice;
       - a genesis with a charged reveal;
       - a dive from the shallows (sunlight check) with UV hits at the right cadence;
       - the minimap gauge;
       - a mating and a hatch;
       - Firefox's spec in the full suite.
    2. Sync DESIGN §4–§6, §9 and §10, the rules files and `docs/art/README.md`.
  - Acceptance: every owner point in the table maps to a named test or the T12 note. The PR E2E suite time stays within 30 s of v0.7.1's.

## Rubric

- [ ] Bodies read as plankton: no Evolved-mode cell has more than 14 visible parts; antennae, legs and tail are distinguishable (evidence: T2–T4 tests and the T12 sheet).
- [ ] Glass like pass 1: face luminance and alpha within ±15% of pass 1, limbs matching the body (evidence: T5 metrics).
- [ ] At most two related organ colours per body, with eyes in the organ colour (evidence: T6 metrics).
- [ ] Nothing clips to white, and nothing allocates per frame (evidence: `m6b-clip`, the budget spec).
- [ ] Firefox draws bodies cleanly and without flashes (evidence: `m6c-firefox.spec.ts`).
- [ ] (owner) The creatures look like real, organic micro-organisms in the Lab and in play.
- [ ] (owner) Damage feels like distinct hits; the shallows' sunlight looks right.
- [ ] (owner) The egg reveal is exciting, and clicking feels meaningful.
- [ ] (owner) The minimap is smooth and the depth gauge is obvious.

## Risks

- **The reset loses the owner's and friends' creatures.** The owner accepted it. The notice is explicit, and identities and recovery codes survive (T1).
- **Region rules make bodies samey.** Diversity is checked: at least 7 classes in Evolved mode (T4), and the silhouette histogram is kept in `report:diversity`.
- **Restoring pass 1's face brings back the milky look the owner disliked in passes 2–5.** The metric pins pass 1's values (±15%) and the no-haze rule stays (T5).
- **Firefox cannot be installed in a cloud session.** CI installs it, the release gate runs it, and failures upload screenshots (T7).
- **Gacha pressure.** Clicking never claims to change the result: it charges the show and reveals the true tier sooner (T10).
